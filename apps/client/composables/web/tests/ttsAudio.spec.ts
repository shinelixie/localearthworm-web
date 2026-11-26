import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ttsAudio 模块顶层会立即发起清单加载，所以每个用例都用
 * vi.resetModules() + 动态 import 拿一个「全新」实例，并先 stub 好 fetch，
 * 保证模块初始化用的就是用例里准备好的清单响应。
 */
const MANIFEST = {
  "I like cats.": "/tts/ab/abcdef.mp3",
  "over the lazy dog": "/tts/cd/123456.mp3",
};

interface ManifestModule {
  webTtsAudioUrl: (text: string | undefined, voice: string) => string;
  webTtsReady: { value: boolean };
}

async function freshManifestModule(response: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): Promise<ManifestModule> {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return (await import("../ttsAudio")) as unknown as ManifestModule;
}

async function resolvedModule(): Promise<ManifestModule> {
  const mod = await freshManifestModule({
    ok: true,
    status: 200,
    json: async () => MANIFEST,
  });
  await vi.waitFor(() => expect(mod.webTtsReady.value).toBe(true));
  return mod;
}

describe("web ttsAudio（纯前端版预合成语音查表）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("清单未加载时同步返回空串（播放链先走有道）", async () => {
    // fetch 永远不返回 → 清单一直未就绪
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const mod = (await import("../ttsAudio")) as unknown as ManifestModule;
    expect(mod.webTtsReady.value).toBe(false);
    expect(mod.webTtsAudioUrl("I like cats.", "en-US-JennyNeural")).toBe("");
  });

  it("命中清单时返回 mp3 地址（补了 base 前缀，不再是有道）", async () => {
    const mod = await resolvedModule();
    const url = mod.webTtsAudioUrl("I like cats.", "en-US-JennyNeural");
    expect(url).toMatch(/\/tts\/ab\/abcdef\.mp3$/);
    expect(url).not.toContain("dict.youdao.com");
  });

  it("未收录的文本返回空串（走兜底）", async () => {
    const mod = await resolvedModule();
    expect(mod.webTtsAudioUrl("not in manifest", "en-US-JennyNeural")).toBe("");
  });

  it("非清单音色（用户切了别的神经音色）一律返回空串", async () => {
    const mod = await resolvedModule();
    expect(mod.webTtsAudioUrl("I like cats.", "en-US-AvaNeural")).toBe("");
    expect(mod.webTtsAudioUrl("I like cats.", "en-GB-SoniaNeural")).toBe("");
  });

  it("空文本返回空串", async () => {
    const mod = await resolvedModule();
    expect(mod.webTtsAudioUrl("", "en-US-JennyNeural")).toBe("");
    expect(mod.webTtsAudioUrl("   ", "en-US-JennyNeural")).toBe("");
    expect(mod.webTtsAudioUrl(undefined, "en-US-JennyNeural")).toBe("");
  });

  it("清单 404 时不抛、记空表（整体退回兜底）", async () => {
    const mod = await freshManifestModule({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    await vi.waitFor(() => expect(mod.webTtsReady.value).toBe(true));
    expect(mod.webTtsAudioUrl("I like cats.", "en-US-JennyNeural")).toBe("");
  });
});
