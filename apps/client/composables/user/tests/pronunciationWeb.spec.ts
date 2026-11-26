import { beforeEach, describe, expect, it, vi } from "vitest";

import { PronunciationType, usePronunciation } from "../pronunciation";

/**
 * 纯前端版主音源选择：
 *  - apiBase 为空（web 模式）且清单就绪且命中 → 播 Pages 上预合成的 mp3
 *  - 未就绪 / 未命中 → 有道 dictvoice（audio 层再兜浏览器语音）
 *  - 有 apiBase（本地后端版）→ 原样 /tts/speak，清单不参与
 *  - 用户切了别的音色 → 不走清单（清单里只有 Jenny）
 */

const mocks = vi.hoisted(() => ({
  getApiBase: vi.fn(() => ""),
  webTtsAudioUrl: vi.fn(() => ""),
  webTtsReady: { value: false },
}));
const { getApiBase, webTtsAudioUrl, webTtsReady } = mocks;

// vi.mock 工厂被提升到文件顶部，不能引用顶层变量，只能在 hoisted 里定义
vi.mock("~/composables/web/ttsAudio", () => ({
  webTtsAudioUrl: mocks.webTtsAudioUrl,
  webTtsReady: mocks.webTtsReady,
}));
vi.mock("~/api/http", () => ({
  getApiBase: mocks.getApiBase,
}));

const MP3 = "http://example.github.io/localearthworm-web/tts/ab/abcdef.mp3";

describe("pronunciation 主音源（纯前端版优先预合成 mp3）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getApiBase).mockReturnValue("");
    webTtsReady.value = false;
    vi.mocked(webTtsAudioUrl).mockReset().mockReturnValue("");
    const { pronunciation } = usePronunciation();
    pronunciation.value = PronunciationType.American;
  });

  it("web 模式 + 清单就绪 + 命中 → 返回 mp3 地址", () => {
    webTtsReady.value = true;
    vi.mocked(webTtsAudioUrl).mockReturnValue(MP3);

    const { getPronunciationUrl } = usePronunciation();
    expect(getPronunciationUrl("I like cats.")).toBe(MP3);
    expect(webTtsAudioUrl).toHaveBeenCalledWith("I like cats.", "en-US-JennyNeural");
  });

  it("web 模式 + 清单就绪但未命中 → 退回有道 dictvoice", () => {
    webTtsReady.value = true;
    vi.mocked(webTtsAudioUrl).mockReturnValue("");

    const { getPronunciationUrl } = usePronunciation();
    const url = getPronunciationUrl("I like cats.");
    expect(url).toContain("dict.youdao.com/dictvoice");
    expect(url).toContain(encodeURIComponent("I like cats."));
  });

  it("web 模式 + 清单未就绪 → 有道（等 watchEffect 在加载完成后重算）", () => {
    webTtsReady.value = false;

    const { getPronunciationUrl } = usePronunciation();
    expect(getPronunciationUrl("I like cats.")).toContain("dict.youdao.com/dictvoice");
    expect(webTtsAudioUrl).not.toHaveBeenCalled();
  });

  it("本地后端版（有 apiBase）→ 原样 /tts/speak，不走清单", () => {
    vi.mocked(getApiBase).mockReturnValue("http://127.0.0.1:3101");
    webTtsReady.value = true;
    vi.mocked(webTtsAudioUrl).mockReturnValue(MP3);

    const { getPronunciationUrl } = usePronunciation();
    const url = getPronunciationUrl("I like cats.");
    expect(url).toContain("http://127.0.0.1:3101/tts/speak?");
    expect(url).toContain("voice=en-US-JennyNeural");
    expect(webTtsAudioUrl).not.toHaveBeenCalled();
  });

  it("用户切到别的音色 → 按该音色查清单（清单侧只会对 Jenny 命中）", () => {
    webTtsReady.value = true;
    localStorage.setItem("ttsVoice", "en-GB-SoniaNeural");
    vi.mocked(webTtsAudioUrl).mockReturnValue("");

    const { getPronunciationUrl } = usePronunciation();
    const url = getPronunciationUrl("I like cats.");
    expect(url).toContain("dict.youdao.com/dictvoice");
    expect(webTtsAudioUrl).toHaveBeenCalledWith("I like cats.", "en-GB-SoniaNeural");
  });
});
