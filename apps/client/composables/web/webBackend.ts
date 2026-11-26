import type { WebCourse, WebPack } from "./content";
import { getCourse, getPack, getStatement, loadWebData } from "./content";
import { idbAllByPrefix, idbDel, idbDelByPrefix, idbGet, idbSet } from "./idb";

// 课程管理「本机编辑」持久化。web 版内容是只读静态文件，改不动站里发布的内容；
// 这里把用户在本机改过的句子按 statementId 存 IndexedDB（key 前缀 ov:<id>，
// value 是 { english?, chinese?, soundmark?, analysis?, splitTree?, updatedAt }）。
// 所有课程内容读取路径统一套一遍（applyOverrides），练习页与管理页读到的都是同一份
// 本机版本。管理页「本机修改」面板可查可删（GET/DELETE manage/overrides）。
// 只影响当前这台浏览器的这个站点；要全局生效仍走母版重新导出（pnpm build:web 后 push）。

/**
 * 纯前端版的「浏览器端后端」。
 *
 * api/http.ts 在 web 模式下不走 ofetch，而是把每个 API 调用交给这里的 route()：
 *   - 读内容（课程包/课程/句子）→ 构建时打进 public/data/courses.json 的数据
 *   - 读/写学习状态（进度/断点/收藏/练习记录…）→ IndexedDB
 *   - 没有浏览器对等物的（翻译/排行/每日一句/TTS）→ 返回可优雅降级的默认值
 *
 * 不改动任何 api/*.ts 与组件——它们照常调用，只是拿到的响应在浏览器里合成。
 */

// ---------- 小工具 ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(path: string): Response {
  return json({ message: `未实现或不存在：${path}` }, 404);
}

function badRequest(message: string): Response {
  return json({ message }, 400);
}

/** 课程包的展示元信息（首页卡片 / 重置接口用） */
async function packMeta(coursePackId: string) {
  const pack = await getPack(coursePackId);
  if (!pack) return null;
  return {
    id: pack.id,
    title: pack.title,
    description: pack.description,
    cover: pack.cover,
    isFree: pack.isFree,
  };
}

/** 一节课的进度：{ statementIndex, completed }，没有就是 0/false */
async function getCourseProgress(coursePackId: string, courseId: string) {
  const raw = await idbGet<{ statementIndex?: number; completed?: boolean }>(
    `progress:${coursePackId}:${courseId}`,
  );
  return {
    statementIndex: Math.max(0, raw?.statementIndex ?? 0),
    completed: raw?.completed ?? false,
  };
}

/** 一节课「已学多少句」：进度条取 max(断点下标, 完成则满) */
function learnedCount(course: WebCourse, statementIndex: number, completed: boolean) {
  const total = course.statements.length;
  if (total <= 0) return 0;
  if (completed) return total;
  return Math.min(total, statementIndex);
}

/** 课程管理改过的句子，按 statementId 索引；value 是字段补丁（部分字段可缺省） */
type StatementOverride = {
  english?: string;
  chinese?: string;
  soundmark?: string;
  analysis?: unknown;
  splitTree?: unknown;
  updatedAt?: string;
};

const OVERRIDES_PREFIX = "ov:";

let overridesStore: Map<string, StatementOverride> | null = null;
let overridesLoad: Promise<void> | null = null;

/** 同步取当前（可能未载入）的本机修改表 —— applyOverrides 是同步的，读这里 */
function overrides(): Map<string, StatementOverride> {
  if (!overridesStore) overridesStore = new Map();
  return overridesStore;
}

/** 从 IndexedDB 载入全部本机修改（整页生命周期只跑一次，失败则保持空表） */
function ensureOverridesLoaded(): Promise<void> {
  if (!overridesLoad) {
    overridesLoad = idbAllByPrefix<StatementOverride>(OVERRIDES_PREFIX)
      .then((rows) => {
        overridesStore = new Map(
          rows.map((row) => [row.key.slice(OVERRIDES_PREFIX.length), row.value]),
        );
      })
      .catch(() => {
        overridesLoad = null; // 载入失败（如隐私模式）时下次再试，同时保留空表
      });
  }
  return overridesLoad;
}

/** 写一条本机修改：落 IndexedDB + 更新内存表（读路径立即可见） */
async function persistOverride(statementId: string, patch: StatementOverride) {
  const prev = overrides().get(statementId);
  const next: StatementOverride = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  overrides().set(statementId, next);
  try {
    await idbSet(`${OVERRIDES_PREFIX}${statementId}`, next);
  } catch {
    /* 落库失败也不影响本次会话内一致 */
  }
}

/** 课程内容读取统一套一遍：管理页、练习页都读同一份本机版本 */
function applyOverrides(course: WebCourse): WebCourse {
  const map = overrides();
  const statements = course.statements.map((statement) => {
    const patch = map.get(statement.id);
    return patch ? { ...statement, ...patch } : statement;
  });
  return { ...course, statements };
}

/** 测试用：清掉模块级本机修改表（route 每次会重新从 IndexedDB 载入） */
export function __resetStatementOverrides(): void {
  overridesStore = new Map();
  overridesLoad = null;
}

const RANK_ORDER = ["S", "A", "B", "C", "D"];

function betterRank(a: string | null | undefined, b: string | null | undefined): string {
  const ia = RANK_ORDER.indexOf(a ?? "");
  const ib = RANK_ORDER.indexOf(b ?? "");
  if (ia === -1) return b ?? "";
  if (ib === -1) return a ?? "";
  return ia <= ib ? a ?? "" : b ?? "";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------- 学习时长：一次性历史数据修复 ----------
// 旧版按天「覆盖」而非「累加」上传的 30 秒增量，导致每天只剩最后一段（往往 <30s，
// 四舍五入成「0 分钟」却仍画出一根 3px 细柱——即用户看到的「有柱子但时长为 0」）。
// 每天的「真实」墙钟累计其实一直存在 localStorage（tracker 每秒累加、每 30s 落盘到
// learningTime_*_{date}，且旧日期不清理）。这里首次读取时长时，用 localStorage 的
// 真实值把 IndexedDB 里被覆盖偏小的历史行修回真实值：只增不减、幂等、只跑一次。
let timeHealing: Promise<void> | null = null;
function healLearningTime(): Promise<void> {
  if (!timeHealing) {
    timeHealing = doHealLearningTime();
    timeHealing.catch(() => {
      timeHealing = null; // 出错则下次可重试
    });
  }
  return timeHealing;
}
async function doHealLearningTime(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem("learningTime_backfilled_v1") === "1") return;
  // key 形如 learningTime_{userId}_{YYYY-MM-DD}（本地版 userId 为空，但日期恒为后缀）
  const re = /^learningTime_.*_(\d{4}-\d{2}-\d{2})$/;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    const match = re.exec(key);
    if (!match) continue;
    const date = match[1];
    const stored = Number(localStorage.getItem(key));
    if (!Number.isFinite(stored) || stored <= 0) continue;
    const row = await idbGet<{ date: string; duration: number }>(`learning-time:${date}`);
    if (!row || (row.duration ?? 0) < stored) {
      await idbSet(`learning-time:${date}`, { date, duration: stored });
    }
  }
  localStorage.setItem("learningTime_backfilled_v1", "1");
}

// ---------- 主路由 ----------

/**
 * @param fullUrl 完整请求 URL（含 query）
 * @param method  HTTP 方法
 * @param body    已解析的 JSON 请求体
 */
export async function route(
  fullUrl: URL,
  method: string,
  body: Record<string, any>,
): Promise<Response> {
  const rawPath = fullUrl.pathname.replace(/^\/api\//, "");
  const path = rawPath.replace(/^\/+/, "");
  const seg = path.split("/");
  const query = fullUrl.searchParams;
  const m = method.toUpperCase();

  // 课程内容读之前保证本机修改（管理页编辑）已从 IndexedDB 载入
  await ensureOverridesLoaded();

  // ===== 内容：课程包 =====
  if (path === "course-pack") {
    if (m === "GET") {
      const data = await loadWebData();
      return json(
        data.packs.map((pack) => ({
          id: pack.id,
          title: pack.title,
          description: pack.description,
          cover: pack.cover,
          isFree: pack.isFree,
        })),
      );
    }
    if (m === "POST") {
      return badRequest("web 版暂不支持新建课程包（内容为随站发布的固定数据）");
    }
  }

  if (path === "course-pack/preview" || path === "course-pack/import") {
    return badRequest("web 版暂不支持导入课程包");
  }

  if (seg[0] === "course-pack" && seg.length >= 2) {
    const coursePackId = decodeURIComponent(seg[1] ?? "");

    // 详情：包 + 全部课程（含进度）
    if (seg.length === 2) {
      if (m === "GET") {
        const pack = await getPack(coursePackId);
        if (!pack) return notFound(path);
        const courses = [];
        for (const course of pack.courses) {
          const { statementIndex, completed } = await getCourseProgress(coursePackId, course.id);
          courses.push({
            ...course,
            statements: undefined,
            completionCount: completed ? 1 : 0,
            statementCount: course.statements.length,
            learnedCount: learnedCount(course, statementIndex, completed),
          });
        }
        return json({
          id: pack.id,
          title: pack.title,
          description: pack.description,
          cover: pack.cover,
          isFree: pack.isFree,
          courses,
        });
      }
      if (m === "DELETE") {
        // 课程数据随站发布删不掉，这里清掉本机的学习记录
        await idbDelByPrefix(`progress:${coursePackId}:`);
        await idbDelByPrefix(`last-practice:${coursePackId}`);
        await idbDelByPrefix(`route:${coursePackId}:`);
        await idbDelByPrefix(`lp:${coursePackId}:`);
        const meta = await packMeta(coursePackId);
        return json({ id: coursePackId, title: meta?.title ?? "", deletedCourses: 0 });
      }
      if (m === "PATCH") {
        const meta = await packMeta(coursePackId);
        if (!meta) return notFound(path);
        return json({
          ...meta,
          title: body.title ?? meta.title,
          description: body.description ?? meta.description,
        });
      }
    }

    // 包内课程：…/courses/:courseId[/next|/complete]
    if (seg[2] === "courses" && seg[3]) {
      const courseId = decodeURIComponent(seg[3]);
      const tail = seg.slice(4).join("/"); // "" | "next" | "complete"

      if (m === "GET" && !tail) {
        const course = await getCourse(coursePackId, courseId);
        if (!course) return notFound(path);
        const { statementIndex, completed } = await getCourseProgress(coursePackId, courseId);
        return json({
          ...applyOverrides(course),
          completionCount: completed ? 1 : 0,
          statementIndex,
        });
      }

      if (m === "GET" && tail === "next") {
        const pack = await getPack(coursePackId);
        const idx = pack?.courses.findIndex((c) => c.id === courseId) ?? -1;
        const next = pack?.courses[idx + 1];
        if (!next) return json(undefined);
        return json({ ...applyOverrides(next), statements: undefined, statementIndex: 0 });
      }

      if (m === "POST" && tail === "complete") {
        const course = await getCourse(coursePackId, courseId);
        if (course) {
          const { statementIndex } = await getCourseProgress(coursePackId, courseId);
          await idbSet(`progress:${coursePackId}:${courseId}`, {
            statementIndex: Math.max(statementIndex, course.statements.length),
            completed: true,
          });
        }
        const pack = await getPack(coursePackId);
        const idx = pack?.courses.findIndex((c) => c.id === courseId) ?? -1;
        const next = pack?.courses[idx + 1];
        const nextCourse = next ? { ...next, statements: undefined, statementIndex: 0 } : undefined;
        return json({ nextCourse });
      }

      if (m === "PATCH") {
        // 课程改名（web 版不落库，回显即可）
        return json({ title: body.title, description: body.description });
      }
    }

    // 课程管理：改句子原文/翻译/音标（course-pack/statements/:id）→ 存本机修改
    if (seg[1] === "statements" && seg[2] && m === "PATCH") {
      const statementId = decodeURIComponent(seg[2]);
      const hit = await getStatement(statementId);
      const patch: StatementOverride = {};
      if (body.english !== undefined) patch.english = body.english;
      if (body.chinese !== undefined) patch.chinese = body.chinese;
      if (body.soundmark !== undefined) patch.soundmark = body.soundmark;
      await persistOverride(statementId, patch);
      const merged = { ...(hit?.statement ?? {}), ...overrides().get(statementId) };
      return json(merged);
    }

    return notFound(path);
  }

  // ===== 内容：语法 / 拆分树（web 版存本机 IndexedDB，练习/管理页读到同一份） =====
  if ((seg[0] === "grammar-analysis" || seg[0] === "split-tree") && seg[1] && m === "POST") {
    const statementId = decodeURIComponent(seg[1]);
    if (seg[0] === "grammar-analysis" && body.analysis) {
      await persistOverride(statementId, { analysis: body.analysis });
    } else if (seg[0] === "split-tree" && body.tree) {
      await persistOverride(statementId, { splitTree: body.tree });
    }
    return json({ success: true });
  }

  // ===== 课程管理：本机修改 列表/清除（纯前端版专属 API） =====
  if (seg[0] === "manage" && seg[1] === "overrides") {
    if (m === "GET" && !seg[2]) {
      await ensureOverridesLoaded();
      const fieldNames = ["english", "chinese", "soundmark", "analysis", "splitTree"] as const;
      const data: {
        statementId: string;
        coursePackId: string;
        courseId: string;
        english: string;
        fields: string[];
        updatedAt: string;
      }[] = [];
      for (const [id, ov] of [...overrides().entries()].sort((a, b) =>
        (b[1].updatedAt ?? "").localeCompare(a[1].updatedAt ?? ""),
      )) {
        const hit = await getStatement(id);
        if (!hit) continue;
        data.push({
          statementId: id,
          coursePackId: hit.course.coursePackId,
          courseId: hit.course.id,
          english: ov.english ?? hit.statement.english,
          fields: fieldNames.filter((f) => ov[f] !== undefined),
          updatedAt: ov.updatedAt ?? "",
        });
      }
      return json(data);
    }
    if (m === "DELETE") {
      await ensureOverridesLoaded();
      if (seg[2]) {
        const statementId = decodeURIComponent(seg[2]);
        overrides().delete(statementId);
        await idbDel(`${OVERRIDES_PREFIX}${statementId}`);
      } else {
        const n = overrides().size;
        await idbDelByPrefix(OVERRIDES_PREFIX);
        overridesStore = new Map();
        return json({ ok: true, deleted: n });
      }
      return json({ ok: true });
    }
    return notFound(path);
  }

  // ===== 用户 =====
  if (path === "user" && m === "GET") {
    return json({ membership: { isMember: false, details: null } });
  }
  if (path === "user/setup" && m === "POST") {
    return json({
      username: body.username || "本地学习者",
      avatar: body.avatar || "/logo.png",
    });
  }
  // 注：/user/setup 返回的 avatar 与用户资料里的 picture 都是 public 资源，
  // 展示处统一用 webAsset() 补 base 前缀（纯前端版部署在子路径下）。

  // ===== 课程进度 / 最近课程包 =====
  if (path === "user-course-progress" && m === "PUT") {
    const { coursePackId, courseId, statementIndex } = body;
    await idbSet(`progress:${coursePackId}:${courseId}`, {
      statementIndex: statementIndex ?? 0,
      completed: false,
    });
    return json({ courseId });
  }
  if (path === "user-course-progress/recent-course-packs" && m === "GET") {
    return json(await recentCoursePacks());
  }
  if (
    seg[0] === "user-course-progress" &&
    seg[1] === "course" &&
    seg[2] &&
    seg[3] &&
    m === "DELETE"
  ) {
    await idbDel(`progress:${seg[2]}:${seg[3]}`);
    return json({ ok: true });
  }
  if (seg[0] === "user-course-progress" && seg[1] === "course-pack" && seg[2] && m === "DELETE") {
    await idbDelByPrefix(`progress:${seg[2]}:`);
    await idbDelByPrefix(`last-practice:${seg[2]}`);
    return json({ ok: true });
  }

  // ===== 练习断点 / 最近练习 / 学习路线（拆分练习续练） =====
  if (path === "practice-state") {
    if (m === "PUT") {
      const { coursePackId, courseId, practiceMode, splitMode, stagesKey, statementIndex } = body;
      await idbSet(
        `practice-state:${coursePackId}:${courseId}:${practiceMode}:${splitMode}:${stagesKey}`,
        { statementIndex: statementIndex ?? 0, updatedAt: new Date().toISOString() },
      );
      return json(body);
    }
    if (m === "GET") {
      const key = `practice-state:${query.get("coursePackId")}:${query.get("courseId")}:${query.get("practiceMode")}:${query.get("splitMode")}:${query.get("stagesKey")}`;
      const row = await idbGet<{ statementIndex?: number }>(key);
      return json(row ? { statementIndex: row.statementIndex ?? 0 } : null);
    }
  }
  if (path === "practice-state/last-practice") {
    if (m === "PUT") {
      const { coursePackId } = body;
      await idbSet(`last-practice:${coursePackId}`, {
        ...body,
        updatedAt: new Date().toISOString(),
      });
      return json(body);
    }
    if (m === "GET") {
      const row = await idbGet(`last-practice:${query.get("coursePackId")}`);
      return json(row ?? null);
    }
  }
  if (path === "practice-state/route") {
    if (m === "PUT") {
      const { coursePackId, courseId, practiceMode, splitMode, difficulty } = body;
      await idbSet(`route:${coursePackId}:${courseId}:${practiceMode}:${splitMode}`, {
        difficulty,
        updatedAt: new Date().toISOString(),
      });
      return json(body);
    }
    if (m === "GET") {
      const base = `route:${query.get("coursePackId")}:${query.get("courseId")}:${query.get("practiceMode")}:`;
      const rows = await idbAllByPrefix<{ difficulty: string }>(base);
      return json(
        rows.map((r) => ({ splitMode: lastKeyPart(r.key), difficulty: r.value.difficulty })),
      );
    }
  }
  if (path === "practice-state/route/summary") {
    const base = `route:${query.get("coursePackId")}:`;
    const rows = await idbAllByPrefix<{ difficulty: string }>(base);
    return json(
      rows.map((r) => {
        const parts = r.key.split(":");
        return {
          courseId: parts[2] ?? "",
          practiceMode: parts[3] ?? "",
          splitMode: parts[4] ?? "",
          difficulty: r.value.difficulty,
        };
      }),
    );
  }

  // ===== 收藏本 =====
  if (path === "mastered-elements") {
    if (m === "GET") {
      const rows = await idbAllByPrefix<{ content: unknown; masteredAt: string }>("mastered:");
      return json(rows.map((r) => ({ id: r.key, ...r.value })));
    }
    if (m === "POST") {
      const content = body.content ?? {};
      const id = `mastered:${Date.now()}`;
      const masteredAt = new Date().toISOString();
      await idbSet(id, { content, masteredAt });
      return json({ id, content, masteredAt });
    }
  }
  if (seg[0] === "mastered-elements" && seg[1] && m === "DELETE") {
    await idbDel(seg[1]);
    return json(true);
  }
  if (path === "mastered-elements/practice" && m === "POST") {
    const ids: string[] = body.ids ?? [];
    const items = [];
    for (const id of ids) {
      const row = await idbGet<{
        content: { english?: string; chinese?: string; soundmark?: string };
      }>(id);
      if (row?.content) {
        items.push({
          id,
          english: row.content.english,
          chinese: row.content.chinese,
          soundmark: row.content.soundmark,
        });
      }
    }
    return json(items);
  }

  // ===== 课程历史 =====
  if (seg[0] === "course-history" && seg[1] && m === "GET") {
    const packId = seg[1];
    const pack = await getPack(packId);
    const out = [];
    for (const course of pack?.courses ?? []) {
      const { completed } = await getCourseProgress(packId, course.id);
      if (completed) out.push({ courseId: course.id, completionCount: 1 });
    }
    return json(out);
  }

  // ===== 学习路径 =====
  if (seg[0] === "learning-path" && seg[1] && seg[2]) {
    const packId = seg[1];
    const which = seg[2];
    const MODES = ["chinese_to_english", "dictation", "listening"];
    const DIFFS = ["beginner", "intermediate", "advanced"];

    if (which === "config") {
      const stored = await idbGet("learning-path-config");
      return json(
        stored ?? {
          modes: MODES,
          difficulties: DIFFS,
          stars: [1, 2, 3],
          dailyLimitsByMode: {},
          nodeOrder: "mode_first",
        },
      );
    }

    if (which === "progress") {
      const rows = await idbAllByPrefix<{
        rank: string;
        oralScore: number | null;
        completionCount: number;
        stars: number;
      }>(`lp:${packId}:`);
      const courses = new Map<
        string,
        { courseId: string; modes: Record<string, Record<string, any>> }
      >();
      for (const r of rows) {
        const parts = r.key.split(":"); // lp:<pack>:<course>:<mode>:<difficulty>
        const courseId = parts[2];
        const mode = parts[3];
        const difficulty = parts[4];
        if (!courseId || !mode || !difficulty) continue;
        const course = courses.get(courseId) ?? { courseId, modes: {} };
        course.modes[mode] ??= {};
        course.modes[mode][difficulty] = r.value;
        courses.set(courseId, course);
      }
      return json({ courses: [...courses.values()] });
    }

    if (which === "daily-limits") {
      return json({
        day: todayStr(),
        dailyLimitsByMode: {},
        todayCompletedByMode: {},
        remainingByMode: {},
      });
    }

    if (which === "complete" && m === "POST") {
      const { courseId, mode, difficulty, rank, oralScore } = body;
      const key = `lp:${packId}:${courseId}:${mode}:${difficulty}`;
      const prev = await idbGet<{
        rank: string;
        oralScore: number | null;
        completionCount: number;
        stars: number;
      }>(key);
      const completionCount = (prev?.completionCount ?? 0) + 1;
      const stars = 3;
      await idbSet(key, {
        rank: betterRank(prev?.rank, rank ?? null),
        oralScore:
          oralScore != null && prev?.oralScore != null
            ? (prev.oralScore + oralScore) / 2
            : oralScore ?? prev?.oralScore ?? null,
        completionCount,
        stars,
      });
      // 剩余 = 还没打通的 模式×难度 节点
      const all = await idbAllByPrefix(`lp:${packId}:`);
      const done = new Set(all.map((r) => r.key));
      let remaining = 0;
      for (const modeName of MODES) {
        for (const diff of DIFFS) {
          if (!done.has(`lp:${packId}:${courseId}:${modeName}:${diff}`)) remaining += 1;
        }
      }
      return json({
        courseId,
        mode,
        difficulty,
        rank: rank ?? "B",
        stars,
        bestRank: betterRank(prev?.rank, rank ?? null),
        completed: true,
        remaining,
      });
    }
  }

  // ===== 复习（web 版无 FSRS 排期，统一返回空） =====
  if (path === "review/overview" && m === "GET") return json([]);
  if (seg[0] === "review" && seg[1] && seg[2] === "summary")
    return json({ total: 0, due: 0, graduated: 0, learning: 0 });
  if (seg[0] === "review" && seg[1] && seg[2] === "summary-by-course") return json([]);
  if (seg[0] === "review" && seg[1] && seg[2] === "cards" && m === "GET") return json([]);
  if (seg[0] === "review" && seg[1] && seg[2] === "enqueue" && m === "POST")
    return json({ added: 0 });
  if (seg[0] === "review" && seg[1] === "cards" && seg[2] && m === "POST") {
    const card = {
      id: seg[2],
      coursePackId: "",
      courseId: "",
      statementId: "",
      english: "",
      chinese: "",
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
      state: 1,
      dueAt: new Date().toISOString(),
      lastReviewAt: new Date().toISOString(),
      graduated: false,
    };
    if (seg[3] === "graduate") return json(card);
    if (seg[3] === "grade") return json(card);
    if (seg[3] === "submit")
      return json({
        card,
        rating: body.rating ?? "good",
        scheduledDays: 1,
        dueAt: new Date().toISOString(),
        graduated: false,
      });
  }
  if (path === "review-settings") {
    const DEFAULT = {
      enabledModes: ["chinese_to_english"],
      errorsOnly: false,
      wrongRoundsThreshold: 2,
      countShownAnswerAsError: false,
      dailyLimitsByMode: {},
      useSystemRecommended: true,
    };
    if (m === "GET") {
      const stored = await idbGet("review-settings");
      return json({ ...DEFAULT, ...(stored ?? {}), todayCounts: {} });
    }
    if (m === "PUT") {
      await idbSet("review-settings", body);
      return json({ ...DEFAULT, ...body, todayCounts: {} });
    }
  }

  // ===== 学习时长 / 练习会话（存 IndexedDB，成长分析可用） =====
  if (path === "user-learning-activities") {
    if (m === "GET") {
      await healLearningTime(); // 一次性：用 localStorage 真实值修回被覆盖的历史行
      const rows = await idbAllByPrefix<{ date: string; duration: number }>("learning-time:");
      const start = query.get("startDate");
      const end = query.get("endDate");
      return json(
        rows
          .map((r) => r.value)
          .filter((item) => !start || item.date >= start)
          .filter((item) => !end || item.date <= end)
          .sort((a, b) => a.date.localeCompare(b.date)),
      );
    }
    if (m === "POST") {
      const date = body.date ?? todayStr();
      // 与 API 版对齐：上传的是 30 秒增量，按天累加（不能覆盖，否则每天只剩最后一段）
      const existing = await idbGet<{ date: string; duration: number }>(`learning-time:${date}`);
      const total = (existing?.duration ?? 0) + Number(body.duration ?? 0);
      await idbSet(`learning-time:${date}`, { date, duration: total });
      return json(true);
    }
  }
  if (path === "user-learning-activities/total" && m === "GET") {
    await healLearningTime();
    const rows = await idbAllByPrefix<{ date: string; duration: number }>("learning-time:");
    return json(rows.reduce((sum, r) => sum + (r.value.duration ?? 0), 0));
  }

  if (path === "practice-session/record" && m === "POST") {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      ...body,
      id,
      startedAt: body.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      rank: null,
      correctRate: body.answerCount ? Math.round((body.correctCount / body.answerCount) * 100) : 0,
    };
    await idbSet(`session:${id}`, record);
    return json(record);
  }
  if (path === "practice-session/analytics/overview" && m === "GET") {
    const rows = await idbAllByPrefix<SessionLike>("session:");
    const totalAnswers = rows.reduce((s, r) => s + (r.value.answerCount ?? 0), 0);
    const totalCorrect = rows.reduce((s, r) => s + (r.value.correctCount ?? 0), 0);
    const totalDurationMs = rows.reduce((s, r) => s + (r.value.durationMs ?? 0), 0);
    const dates = new Set(
      rows.map((r) => (r.value.completedAt ?? "").slice(0, 10)).filter(Boolean),
    );
    return json({
      sessions: rows.length,
      totalDurationMs,
      totalAnswers,
      totalCorrect,
      completedCourses: 0,
      learningDays: dates.size,
      avgCorrectRate: totalAnswers ? Math.round((totalCorrect / totalAnswers) * 100) : 0,
      longestStreak: computeStreak(dates),
    });
  }
  if (path === "practice-session/analytics/daily" && m === "GET") {
    // 时长以墙钟（learning-time 每日累计）为准——和「累计时长」卡同一口径；
    // 会话表只取次数。两者日期并集，避免有练习但墙钟为 0 的天漏掉柱子。
    await healLearningTime();
    const rows = await idbAllByPrefix<SessionLike>("session:");
    const wallRows = await idbAllByPrefix<{ date: string; duration: number }>("learning-time:");
    const byDate = new Map<string, { durationMs: number; sessions: number }>();
    for (const r of rows) {
      const date = (r.value.completedAt ?? "").slice(0, 10);
      if (!date) continue;
      const cur = byDate.get(date) ?? { durationMs: 0, sessions: 0 };
      cur.sessions += 1;
      byDate.set(date, cur);
    }
    for (const r of wallRows) {
      const date = r.value?.date ?? "";
      if (!date) continue;
      const cur = byDate.get(date) ?? { durationMs: 0, sessions: 0 };
      cur.durationMs += (r.value?.duration ?? 0) * 1000;
      byDate.set(date, cur);
    }
    const days = Number(query.get("days") ?? 30);
    const items = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-days)
      .map(([date, v]) => ({ date, ...v }));
    return json(items);
  }
  if (path === "practice-session/analytics/sessions" && m === "GET") {
    const rows = await idbAllByPrefix<SessionLike>("session:");
    const limit = Number(query.get("limit") ?? 10);
    const items = rows
      .sort((a, b) => (b.value.completedAt ?? "").localeCompare(a.value.completedAt ?? ""))
      .slice(0, limit)
      .map((r) => r.value);
    return json(items);
  }

  // ===== 排行（web 版无社区，只有自己） =====
  if (seg[0] === "rank" && seg[1] === "progress" && m === "GET") {
    const rows = await idbAllByPrefix<SessionLike>("session:");
    return json({
      list: [],
      self: { username: "本地学习者", count: rows.length, rank: 1 },
      period: seg[2] ?? "weekly",
    });
  }

  // ===== 翻译 / 每日一句（无后端，给空值让 UI 隐藏） =====
  if (path === "translate" && m === "POST") {
    const texts: string[] = body.texts ?? [];
    return json({ translations: Object.fromEntries(texts.map((t) => [t, ""])) });
  }
  if (path === "tool/dailySentence" && m === "GET") return json({ zh: "", en: "" });

  // ===== TTS：web 版不合成，直接失败让前端走有道/浏览器兜底 =====
  if (seg[0] === "tts") {
    return json({ message: "web 版不支持服务端 TTS" }, 404);
  }

  return notFound(path);
}

interface SessionLike {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  answerCount: number;
  correctCount: number;
}

function lastKeyPart(key: string): string {
  const parts = key.split(":");
  return parts[parts.length - 1] ?? "";
}

function computeStreak(dates: Set<string>): number {
  if (dates.size === 0) return 0;
  const day = 24 * 60 * 60 * 1000;
  let streak = 0;
  // 从昨天开始往前数（今天的时长可能还没结算完，不算断）
  for (let offset = 1; offset < 2; offset += 1) {
    const d = new Date(Date.now() - offset * day).toISOString().slice(0, 10);
    if (dates.has(d)) {
      streak += 1;
      let prev = d;
      while (true) {
        prev = new Date(Date.parse(prev) - day).toISOString().slice(0, 10);
        if (dates.has(prev)) streak += 1;
        else break;
      }
      break;
    }
  }
  return streak;
}

async function recentCoursePacks() {
  // 以「最近练习」为准，其次「有进度的课」；按更新时间倒序取 3
  const lastPractice = await idbAllByPrefix<{
    coursePackId: string;
    courseId: string;
    updatedAt?: string;
  }>("last-practice:");
  const merged = new Map<string, { coursePackId: string; courseId: string; updatedAt: number }>();

  for (const row of lastPractice) {
    const v = row.value;
    merged.set(v.coursePackId, {
      coursePackId: v.coursePackId,
      courseId: v.courseId,
      updatedAt: v.updatedAt ? Date.parse(v.updatedAt) : 0,
    });
  }

  // 有进度但没最近练习的包补进去
  const progressRows = await idbAllByPrefix<{ statementIndex: number }>("progress:");
  for (const row of progressRows) {
    const parts = row.key.split(":"); // progress:<pack>:<course>
    const packId = parts[1];
    const course = parts.slice(2).join(":");
    if (!merged.has(packId) && (row.value.statementIndex ?? 0) > 0) {
      merged.set(packId, { coursePackId: packId, courseId: course, updatedAt: 0 });
    }
  }

  const items = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);

  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const meta = await packMeta(items[i].coursePackId);
    if (!meta) continue;
    out.push({
      id: i + 1,
      coursePackId: meta.id,
      courseId: items[i].courseId,
      title: meta.title,
      description: meta.description,
      cover: meta.cover,
      isFree: meta.isFree,
    });
  }
  return out;
}
