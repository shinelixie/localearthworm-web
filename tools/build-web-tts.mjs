/**
 * 导出「纯前端版」的神经语音音频到 GitHub Pages 静态资源。
 *
 * 背景：纯前端版（GitHub Pages）没有后端 /tts/speak，主音源只能退到有道
 * 单词拼接，长句/人名会读不出。本脚本把本地已合成的音频「抽库 + 补齐缺失」，
 * 产出 public/tts/<2>/<hash>.mp3（hash = sha256(voice|rate|text)，与服务端缓存
 * 键完全一致），并生成 public/data/tts-manifest.json（text → /tts/.. 查表），
 * 客户端据此在纯前端版优先播 Pages 上的 mp3，未命中再走有道/浏览器兜底。
 *
 * 数据源：apps/client/public/data/courses.json（由 `pnpm web-data` 生成，
 * 拆分语块的枚举复用客户端 composables/main/splitMode.ts 的同一套逻辑，
 * 保证枚举出来的文本和练习时真正朗读的逐字一致）。
 *
 * 音频获取（两级，全部固定 voice=Jenny / rate=+0%，与 TTS_VOICE/TTS_RATE
 * 及客户端默认一致）：
 *   1. 运行中 API 的 /tts/speak：命中 DB/磁盘缓存秒回；未命中现合成（约 2 秒/条），
 *      但 API 有 ~25s 任务超时，代理慢时会批量 500 —— 所以先拿 1 条未缓存文本
 *      预检（8 秒内不回来就判定通道不可用，整轮跳过，不逐条烧超时）。
 *   2. API 没拿到的交给 tools/tts-batch-synth.py（常驻 Python，超时/并发/退避
 *      重试都更宽；代理必须可用——本机直连 Microsoft 端点不通）。
 * 已存在的 mp3 一律跳过（断点续跑）；跑一半中断重跑即可补齐。
 *
 * 用法（需 `pnpm web-data` 导出 courses.json；下载/合成需本地 API 在跑且代理可用）：
 *   node tools/build-web-tts.mjs              # 增量：跳过已存在的 mp3
 *   node tools/build-web-tts.mjs --force      # 全部重下/重合成
 *   node tools/build-web-tts.mjs --concurrency 8
 *   node tools/build-web-tts.mjs --manifest-only
 *       # 不下载，只按现有 mp3 重建清单（代理不可用/补齐中途时）
 *
 * 清单只写「磁盘上真实存在」的 mp3：跑一半中断也不会把缺失条目写进清单，
 * 客户端查不到就走有道兜底，重跑补齐后清单自动变大。
 *
 * 产出：apps/client/public/tts/  +  apps/client/public/data/tts-manifest.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.resolve(ROOT, "apps/client/public");
const MANIFEST_PATH = path.resolve(ROOT, "apps/client/public/data/tts-manifest.json");

/** url 形如 /tts/ab/xyz.mp3，落在 public 下即 public/tts/ab/xyz.mp3 */
const fileOf = (url) => path.resolve(PUBLIC_DIR, url.replace(/^\//, ""));

const VOICE = "en-US-JennyNeural";
const RATE = "+0%";
const API_BASE = process.env.TTS_API_BASE || "http://127.0.0.1:3101";
const CONCURRENCY = Number(process.argv.find((a) => a === "--concurrency") ?? 0) || 8;
const FORCE = process.argv.includes("--force");
const MANIFEST_ONLY = process.argv.includes("--manifest-only");
const TIMEOUT_MS = 60_000;

const hashOf = (text) => createHash("sha256").update(`${VOICE}|${RATE}|${text}`).digest("hex");
const urlOf = (text) => `/tts/${hashOf(text).slice(0, 2)}/${hashOf(text)}.mp3`;

// ---------- 枚举：练习时会被朗读的全部文本 ----------

function loadCorpus() {
  const dataPath = path.resolve(ROOT, "apps/client/public/data/courses.json");
  if (!existsSync(dataPath)) {
    throw new Error("缺少 courses.json，请先跑 `pnpm web-data`（node tools/build-web-data.mjs）");
  }
  return JSON.parse(readFileSync(dataPath, "utf8"));
}

function* walkStatements(data) {
  for (const pack of data.packs ?? []) {
    for (const course of pack.courses ?? []) {
      for (const statement of course.statements ?? []) {
        yield statement;
      }
    }
  }
}

function treeTexts(node, out) {
  if (node.en) out.add(node.en);
  for (const child of node.children ?? []) treeTexts(child, out);
}

/**
 * 复用客户端 splitMode.ts：对每个句子，把它在「任意拆分方式」下可能朗读的
 * 全部文本（整句 + 各层片段）都收进来，取并集保证 top_down/word_first/
 * custom 任何组合都覆盖。无拆分树时走 buildMergeTree 兜底。
 */
async function enumerateTexts(data) {
  const { splitStatements, isValidSplitTree } = await import(
    path.resolve(ROOT, "apps/client/composables/main/splitMode.ts")
  );
  const texts = new Set();
  for (const statement of walkStatements(data)) {
    const english = (statement.english ?? "").trim();
    if (!english) continue;
    texts.add(english);
    if (isValidSplitTree(statement.splitTree)) {
      treeTexts(statement.splitTree.tree, texts);
    } else {
      // 无树：把 word_first（含全部 L1~L4 层）跑一遍，覆盖所有兜底片段
      for (const item of splitStatements([statement], "word_first")) {
        const t = (item.english ?? "").trim();
        if (t) texts.add(t);
      }
    }
  }
  return [...texts].filter(Boolean);
}

// ---------- 下载/合成 ----------

async function fetchAudio(text, signal) {
  const url = `${API_BASE}/tts/speak?voice=${encodeURIComponent(
    VOICE,
  )}&rate=${encodeURIComponent(RATE)}&text=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 200) throw new Error("响应过小，疑似失败");
  return Buffer.from(buf);
}

// ---------- 第二轮：常驻 Python 批量合成（API 拿不到的部分） ----------

/**
 * 把没拿到的条目喂给 tools/tts-batch-synth.py（stdin NDJSON，stdout 逐行
 * 进度/失败/汇总）。它自己带并发、超时、退避重试，且跳过已存在的文件。
 * 返回 { ok, failed }：ok=false 通常是代理/网络不可用（探测条都失败）。
 */
async function synthBatch(items) {
  if (!items.length) return { ok: true, failed: 0 };
  const pythonExe = process.platform === "win32" ? "python" : "python3";
  const script = path.resolve(import.meta.dirname, "tts-batch-synth.py");
  const input = items.map((item) => JSON.stringify({ text: item.text, out: item.file }));
  return await new Promise((resolve) => {
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn(pythonExe, [script], {
          env: {
            ...process.env,
            TTS_VOICE: VOICE,
            TTS_RATE: RATE,
            TTS_PROXY: process.env.TTS_PROXY || "http://127.0.0.1:7890",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => process.stderr.write(`[synth-py] ${chunk}`));
        child.stdin.end(input.join("\n") + "\n");
        child.on("close", (code) => {
          const summaryLine = stdout
            .split("\n")
            .reverse()
            .find((line) => line.includes('"done"'));
          let summary = null;
          try {
            summary = summaryLine ? JSON.parse(summaryLine) : null;
          } catch {
            summary = null;
          }
          const failed = summary?.failed ?? 0;
          const processed = summary?.done ?? 0;
          console.log(
            `  Python 批量合成结束：处理 ${processed}，失败 ${failed}，成功 ${processed - failed}（exit ${code}）`,
          );
          resolve({ ok: code === 0 && failed === 0, failed });
        });
      })
      .catch((error) => resolve({ ok: false, failed: items.length, error }));
  });
}

async function main() {
  console.log("读取 courses.json 并枚举朗读文本…");
  const data = loadCorpus();
  const texts = await enumerateTexts(data);
  const unique = [...new Set(texts)];
  console.log(`  待覆盖文本：${unique.length} 条`);

  const todo = [];
  let fromDisk = 0;

  for (const text of unique) {
    const url = urlOf(text);
    const file = fileOf(url);
    if (existsSync(file) && !FORCE) {
      fromDisk += 1;
      continue; // 本地已有，跳过
    }
    todo.push({ text, file, url });
  }

  console.log(`  已在本地：${fromDisk} 条；需下载/合成：${todo.length} 条（并发 ${CONCURRENCY}）`);
  mkdirSync(fileOf("/tts"), { recursive: true });

  let done = 0;
  let failed = 0;
  const failures = [];
  const queue = [...todo];

  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const buf = await fetchAudio(item.text, controller.signal);
        mkdirSync(path.dirname(item.file), { recursive: true });
        writeFileSync(item.file, buf);
      } catch (error) {
        failed += 1;
        failures.push({ text: item.text, error: error.message });
      } finally {
        clearTimeout(timer);
        done += 1;
        if (done % 50 === 0 || done === todo.length) {
          console.log(`  进度 ${done}/${todo.length}（失败 ${failed}）`);
        }
      }
    }
  }

  if (MANIFEST_ONLY) {
    console.log("  --manifest-only：跳过下载/合成，只按现有 mp3 重建清单");
  } else if (todo.length) {
    // 预检：拿 1 条「未缓存」文本试 API（8 秒内不回来就判定 API 合成通道不可用）。
    // 代理挂着时 API 的合成会卡 25 秒超时再 500，逐条试会烧掉数小时；
    // 缓存命中的 API 毫秒级返回，所以这个探测能立刻区分两种情况。
    const probeText = todo[0].text;
    const apiCanSynth = await (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const buf = await fetchAudio(probeText, controller.signal);
        mkdirSync(path.dirname(todo[0].file), { recursive: true });
        writeFileSync(todo[0].file, buf);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    })();

    if (apiCanSynth) {
      console.log("  API 合成通道可用，批量拉取…");
      const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker());
      await Promise.all(workers);
    } else {
      console.log("  API 合成通道当前不可用（代理未起？），跳过 API 轮询");
    }

    // 第二轮：API 没拿到的（含整轮跳过的）交给常驻 Python 批量合成器——
    // 超时/并发/退避重试都更宽，代理可用时才是主力。
    const stillMissing = todo.filter((item) => !existsSync(item.file));
    if (stillMissing.length && process.env.TTS_SKIP_BATCH !== "1") {
      console.log(`  剩 ${stillMissing.length} 条，转 Python 批量合成（探测网络…）`);
      const probe = await synthBatch([stillMissing[0]]);
      if (probe.ok) {
        await synthBatch(stillMissing.slice(1));
      } else {
        console.log(
          "  探测合成失败：代理/网络当前不可用（本机必须经 TTS_PROXY 才能连 Microsoft 端点）。\n" +
            "  已把当前磁盘上的 mp3 写进清单；代理恢复后重跑 `pnpm web-tts` 即可补齐。",
        );
        process.exitCode = 1;
      }
    }
  }

  // 清单 = 磁盘上真实存在的 mp3（扫目录，而不是「打算下载」的列表）：
  // 这样跑一半中断/只补了一部分也不会把缺失条目写进清单，客户端查不到就
  // 走有道兜底；下次重跑补齐后清单自动长大。
  const manifest = {};
  for (const text of unique) {
    const url = urlOf(text);
    if (existsSync(fileOf(url))) manifest[text] = url;
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const total = Object.keys(manifest).length;
  console.log(`\n完成：清单 ${total}/${unique.length} 条 → ${path.relative(ROOT, MANIFEST_PATH)}`);
  if (failures.length) {
    console.log(
      `失败 ${failures.length} 条（可重跑本脚本补齐；重跑前先删对应 mp3 或加 --force）：`,
    );
    for (const f of failures.slice(0, 20)) console.log(`  - ${f.text}  [${f.error}]`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("build-web-tts 失败：", error);
  process.exit(1);
});
