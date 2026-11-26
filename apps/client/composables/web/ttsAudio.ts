/**
 * 纯前端版的神经语音音频（见 tools/build-web-tts.mjs）。
 *
 * 纯前端版没有后端 /tts/speak，主音源只能退到有道单词拼接。构建前用离线脚本
 * 把练习中会朗读的全部文本（整句 + 拆分语块）预合成到
 * public/tts/<2>/<sha256(voice|rate|text)>.mp3（与 API 缓存键完全一致），
 * 并把 text → 相对路径 的映射写进 public/data/tts-manifest.json。
 * 运行期纯查表：浏览器不用算 sha256，命中即直接播 Pages 上的静态 mp3；
 * 未命中（或 mp3 404）时调用方照常走有道 → 浏览器语音兜底。
 *
 * 清单里只有默认音色 en-US-JennyNeural / +0%（与 API 的 TTS_VOICE/TTS_RATE
 * 默认一致）；用户切到别的音色时不走清单，直接兜底，绝不放错声音。
 */
import { ref } from "vue";

import { webAsset } from "./webAsset";

const WEB_TTS_VOICE = "en-US-JennyNeural";

let map: Map<string, string> | null = null;
let mapPromise: Promise<Map<string, string>> | null = null;

/** 清单是否已加载（reactive：播放链的 watchEffect 依赖它，加载完成后重算主音源） */
export const webTtsReady = ref(false);

function ensureLoaded(): Promise<Map<string, string>> {
  if (mapPromise) return mapPromise;
  mapPromise = (async () => {
    const configBase =
      ((globalThis as any).__NUXT__?.config?.app?.baseURL as string | undefined) || "/";
    const absoluteBase = `${window.location.origin}${configBase.replace(/\/?$/, "/")}`;
    const url = new URL("data/tts-manifest.json", absoluteBase).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`加载语音清单失败：${res.status}`);
    const raw = (await res.json()) as Record<string, string>;
    const next = new Map(Object.entries(raw));
    map = next;
    webTtsReady.value = true;
    return next;
  })().catch((error) => {
    // 失败不重试：manifest 缺失通常是构建产物问题，重试无益。
    // 记一个空表，等价于「没有清单」，整个链路退回有道 + 浏览器兜底。
    mapPromise = null;
    map = new Map();
    webTtsReady.value = true; // 空表也算「已定型」，避免 watchEffect 反复重算
    throw error;
  });
  return mapPromise;
}

/**
 * 同步查表：命中返回补上 base 前缀后的 mp3 地址；未命中（清单未加载 /
 * 无此文本 / 音色不符）返回 ""，调用方按 "" 走原有兜底。
 */
export function webTtsAudioUrl(text: string | undefined, voice: string): string {
  if (!map || voice !== WEB_TTS_VOICE) return "";
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  const rel = map.get(trimmed);
  if (!rel) return "";
  return webAsset(rel);
}

// 提前发起加载（清单 ~1MB 小文件）：让首题出声前大概率已就位。
if (typeof window !== "undefined") {
  void ensureLoaded().catch(() => {});
}

/** 供单测：清掉缓存，下一个用例重新拉（mock 掉 fetch 即可注入数据） */
export function resetWebTtsManifest() {
  map = null;
  mapPromise = null;
  webTtsReady.value = false;
}
