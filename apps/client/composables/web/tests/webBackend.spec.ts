import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { idbDel, idbDelByPrefix, idbGet, idbSet } from "../idb";
import { __resetStatementOverrides, route } from "../webBackend";

/**
 * 浏览器端后端（webBackend.route）的集成测试。
 * 不依赖浏览器/真实 IndexedDB：
 *   - 内容层（content）用一个小数据集 mock 掉（真实版是 4.3MB 的 courses.json）
 *   - 状态层（idb）走 fake-indexeddb，真实 KV 逻辑
 * 目标是验证每个 API 路径返回的形状正确、读写落到 IndexedDB。
 */

const { FAKE_DATA } = vi.hoisted(() => {
  const FAKE_DATA = {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    packs: [
      {
        id: "pack-1",
        order: 1,
        title: "包一",
        description: "简介",
        isFree: true,
        cover: "",
        shareLevel: "public",
        courses: [
          {
            id: "course-1",
            title: "Sentence 01",
            description: "",
            video: "",
            order: 1,
            coursePackId: "pack-1",
            statementCount: 2,
            statements: [
              {
                id: "s1",
                order: 1,
                english: "I like cats.",
                chinese: "我喜欢猫。",
                soundmark: "",
                courseId: "course-1",
                isMastered: false,
                analysis: null,
                splitTree: null,
              },
              {
                id: "s2",
                order: 2,
                english: "Dogs are friendly.",
                chinese: "狗很友好。",
                soundmark: "",
                courseId: "course-1",
                isMastered: false,
                analysis: null,
                splitTree: null,
              },
            ],
          },
        ],
      },
    ],
  };
  return { FAKE_DATA };
});

vi.mock("../content", () => {
  const find = <T extends { id: string }>(arr: T[], id: string) => arr.find((x) => x.id === id);
  return {
    loadWebData: vi.fn(async () => FAKE_DATA),
    getPack: vi.fn(async (id: string) => find(FAKE_DATA.packs, id)),
    getCourse: vi.fn(async (pid: string, cid: string) =>
      find(find(FAKE_DATA.packs, pid)?.courses ?? [], cid),
    ),
    getStatement: vi.fn(async (sid: string) => {
      for (const p of FAKE_DATA.packs)
        for (const c of p.courses)
          for (const s of c.statements) if (s.id === sid) return { course: c, statement: s };
      return undefined;
    }),
  };
});

/** 构造一次 API 调用并解析 JSON 响应 */
async function call(
  method: string,
  path: string,
  opts?: { body?: any; query?: Record<string, string> },
) {
  const qs = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const url = new URL(`http://localhost${path}${qs}`);
  const res = await route(url, method, opts?.body ?? {});
  return { status: res.status, data: await res.json() };
}

beforeEach(async () => {
  // 每个用例清空 IndexedDB，避免互相污染
  for (const prefix of [
    "progress:",
    "last-practice:",
    "route:",
    "lp:",
    "mastered:",
    "session:",
    "learning-time:",
    "practice-state:",
    "ov:",
  ]) {
    await idbDelByPrefix(prefix);
  }
  await idbDel("review-settings");
  await idbDel("learning-path-config");
  // 本机修改表是模块级单例：逐个用例重置（route 每次都会从 IndexedDB 重新载入）
  __resetStatementOverrides();
});

describe("webBackend.route", () => {
  it("GET /course-pack 返回课程包列表（元信息）", async () => {
    const { status, data } = await call("GET", "/course-pack");
    expect(status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: "pack-1", title: "包一", isFree: true });
  });

  it("GET /course-pack/:id 返回包 + 课程（带进度，句子不内联）", async () => {
    const { data } = await call("GET", "/course-pack/pack-1");
    expect(data.id).toBe("pack-1");
    expect(data.courses).toHaveLength(1);
    expect(data.courses[0]).toMatchObject({
      id: "course-1",
      statementCount: 2,
      learnedCount: 0,
      completionCount: 0,
    });
    expect(data.courses[0].statements).toBeUndefined();
  });

  it("GET 单课内联句子并带断点下标", async () => {
    const { data } = await call("GET", "/course-pack/pack-1/courses/course-1");
    expect(data.statements).toHaveLength(2);
    expect(data.statementIndex).toBe(0);
  });

  it("PUT 课程进度 → 读回断点，进度条 learnedCount 跟着走", async () => {
    await call("PUT", "/user-course-progress", {
      body: { coursePackId: "pack-1", courseId: "course-1", statementIndex: 1 },
    });
    const course = await call("GET", "/course-pack/pack-1/courses/course-1");
    expect(course.data.statementIndex).toBe(1);
    const pack = await call("GET", "/course-pack/pack-1");
    expect(pack.data.courses[0].learnedCount).toBe(1);
  });

  it("POST /complete 标记完成 → 最近课程包出现该包", async () => {
    await call("POST", "/course-pack/pack-1/courses/course-1/complete");
    const recent = await call("GET", "/user-course-progress/recent-course-packs");
    expect(recent.data).toHaveLength(1);
    expect(recent.data[0]).toMatchObject({
      coursePackId: "pack-1",
      courseId: "course-1",
      title: "包一",
    });
  });

  it("GET /user 返回非会员", async () => {
    const { data } = await call("GET", "/user");
    expect(data).toEqual({ membership: { isMember: false, details: null } });
  });

  it("复习 / 排行 / 学习路径 返回可优雅降级的默认值", async () => {
    expect((await call("GET", "/review/overview")).data).toEqual([]);
    expect((await call("GET", "/review/pack-1/summary")).data).toEqual({
      total: 0,
      due: 0,
      graduated: 0,
      learning: 0,
    });
    const config = (await call("GET", "/learning-path/pack-1/config")).data;
    expect(config.nodeOrder).toBe("mode_first");
    expect(config.modes).toContain("chinese_to_english");
    const rank = (await call("GET", "/rank/progress/weekly")).data;
    expect(rank.list).toEqual([]);
  });

  it("收藏本 写→读→删", async () => {
    const added = await call("POST", "/mastered-elements", {
      body: { content: { english: "cat" } },
    });
    expect(added.data.id).toMatch(/^mastered:/);
    const list = await call("GET", "/mastered-elements");
    expect(list.data).toHaveLength(1);
    const removed = await call("DELETE", `/mastered-elements/${added.data.id}`);
    expect(removed.data).toBe(true);
    expect((await call("GET", "/mastered-elements")).data).toHaveLength(0);
  });

  it("practice-state 断点 写→读", async () => {
    await call("PUT", "/practice-state", {
      body: {
        coursePackId: "pack-1",
        courseId: "course-1",
        practiceMode: "chinese_to_english",
        splitMode: "word_first",
        stagesKey: "k",
        statementIndex: 3,
      },
    });
    const read = await call("GET", "/practice-state", {
      query: {
        coursePackId: "pack-1",
        courseId: "course-1",
        practiceMode: "chinese_to_english",
        splitMode: "word_first",
        stagesKey: "k",
      },
    });
    expect(read.data.statementIndex).toBe(3);
  });

  it("学习时长 30 秒增量按天累加（不覆盖），总时长 = 各增量之和", async () => {
    const day = "2026-11-24";
    // 连续上传三段 30 秒增量，和 API 版一样累加
    await call("POST", "/user-learning-activities", {
      body: { date: day, duration: 30, activityType: "daily_total" },
    });
    await call("POST", "/user-learning-activities", {
      body: { date: day, duration: 30, activityType: "daily_total" },
    });
    await call("POST", "/user-learning-activities", {
      body: { date: day, duration: 30, activityType: "daily_total" },
    });
    const total = await call("GET", "/user-learning-activities/total");
    expect(total.data).toBe(90); // 不是 30（覆盖 bug）

    const list = await call("GET", "/user-learning-activities", {
      query: { activityType: "daily_total" },
    });
    expect(list.data).toEqual([{ date: day, duration: 90 }]);
  });

  it("每日时长增量跨天后各自累计，互不串天", async () => {
    await call("POST", "/user-learning-activities", {
      body: { date: "2026-11-22", duration: 45, activityType: "daily_total" },
    });
    await call("POST", "/user-learning-activities", {
      body: { date: "2026-11-22", duration: 15, activityType: "daily_total" },
    });
    await call("POST", "/user-learning-activities", {
      body: { date: "2026-11-23", duration: 20, activityType: "daily_total" },
    });
    const total = await call("GET", "/user-learning-activities/total");
    expect(total.data).toBe(80);
  });

  it("一次性修复：用 localStorage 真实值修回被覆盖的历史时长行（只增不回退，幂等）", async () => {
    // 旧 bug 覆盖场景：IndexedDB 里 2026-11-01 只剩最后一段 29s，localStorage 里真实是 540s
    vi.resetModules();
    localStorage.clear();
    const { route } = await import("../webBackend");
    await idbSet("learning-time:2026-11-01", { date: "2026-11-01", duration: 29 });
    // 已被正确累加、大于 localStorage 值的天：不能被回退（只增不减）
    await idbSet("learning-time:2026-11-02", { date: "2026-11-02", duration: 1000 });
    localStorage.setItem("learningTime_local-user_2026-11-01", "540");
    localStorage.setItem("learningTime_local-user_2026-11-02", "50");

    const readTotal = async () =>
      (
        await route(
          new URL("http://localhost/user-learning-activities?activityType=daily_total"),
          "GET",
          {},
        )
      ).json();
    await readTotal(); // 触发一次性修复
    expect(await idbGet("learning-time:2026-11-01")).toEqual({ date: "2026-11-01", duration: 540 });
    expect(await idbGet("learning-time:2026-11-02")).toEqual({
      date: "2026-11-02",
      duration: 1000,
    });

    // 再读一次：幂等，不变
    await readTotal();
    expect(await idbGet("learning-time:2026-11-01")).toEqual({ date: "2026-11-01", duration: 540 });
    expect(await idbGet("learning-time:2026-11-02")).toEqual({
      date: "2026-11-02",
      duration: 1000,
    });
  });

  it("analytics/daily 时长取墙钟、次数取会话（两源日期并集）", async () => {
    // 会话的 completedAt 是「现在」，墙钟日期必须同为今天才能落到同一天
    const day = new Date().toISOString().slice(0, 10);
    // 一次会话（只贡献次数）
    await call("POST", "/practice-session/record", {
      body: {
        coursePackId: "pack-1",
        courseId: "course-1",
        mode: "chinese_to_english",
        answerCount: 3,
        correctCount: 3,
        startedAt: `${day}T08:00:00.000Z`,
        durationMs: 15000,
      },
    });
    // 当天墙钟增量（贡献时长）
    await call("POST", "/user-learning-activities", {
      body: { date: day, duration: 120, activityType: "daily_total" },
    });
    const daily = await call("GET", "/practice-session/analytics/daily", {
      query: { days: 30 },
    });
    const point = daily.data.find((p: any) => p.date === day);
    expect(point).toBeDefined();
    expect(point.sessions).toBe(1);
    expect(point.durationMs).toBe(120000); // 墙钟 120s，不是会话 durationMs 15s
  });

  it("本机修改：改原文/语法/拆分树 → 持久化，读取路径套上，可清除", async () => {
    await call("PATCH", "/course-pack/statements/s1", {
      body: { english: "I like cats a lot.", chinese: "我很喜欢猫。", soundmark: "/kat/" },
    });
    await call("POST", "/grammar-analysis/s1", { body: { analysis: { segments: [] } } });
    await call("POST", "/split-tree/s1", { body: { tree: { en: "I like cats a lot.", zh: "" } } });

    // 单课读取：三处改动全部生效
    const course = await call("GET", "/course-pack/pack-1/courses/course-1");
    const s1 = course.data.statements.find((s: any) => s.id === "s1");
    expect(s1.english).toBe("I like cats a lot.");
    expect(s1.chinese).toBe("我很喜欢猫。");
    expect(s1.soundmark).toBe("/kat/");
    expect(s1.analysis).toEqual({ segments: [] });
    expect(s1.splitTree).toEqual({ en: "I like cats a lot.", zh: "" });

    // 列表/清除
    const list = await call("GET", "/manage/overrides");
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      statementId: "s1",
      courseId: "course-1",
      english: "I like cats a lot.",
      fields: ["english", "chinese", "soundmark", "analysis", "splitTree"],
    });

    await call("DELETE", "/manage/overrides/s1");
    const reread = await call("GET", "/course-pack/pack-1/courses/course-1");
    const s1b = reread.data.statements.find((s: any) => s.id === "s1");
    expect(s1b.english).toBe("I like cats."); // 恢复导出原文
    expect(s1b.analysis).toBeNull();
    expect((await call("GET", "/manage/overrides")).data).toHaveLength(0);

    // 批量清除（再改一条后整清）
    await call("PATCH", "/course-pack/statements/s2", { body: { chinese: "狗很友好！" } });
    await call("DELETE", "/manage/overrides");
    expect((await call("GET", "/manage/overrides")).data).toHaveLength(0);
    const reread2 = await call("GET", "/course-pack/pack-1/courses/course-1");
    expect(reread2.data.statements.find((s: any) => s.id === "s2").chinese).toBe("狗很友好。");
  });

  it("TTS 路径 404（前端走有道/浏览器兜底）", async () => {
    const { status } = await call("GET", "/tts/speak");
    expect(status).toBe(404);
  });

  it("translate 返回空译文（无后端）", async () => {
    const { data } = await call("POST", "/translate", { body: { texts: ["hello"] } });
    expect(data.translations).toEqual({ hello: "" });
  });
});
