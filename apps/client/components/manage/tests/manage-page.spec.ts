import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { saveStatementSplitTree, updateStatementContent } from "~/api/course";
import ManagePage from "../../../pages/manage/index.vue";

vi.mock("~/api/course-pack", () => ({
  fetchCoursePacks: vi.fn(async () => [
    {
      id: "pack-1",
      title: "测试课程包",
      description: "",
      cover: "",
      isFree: true,
    },
  ]),
  fetchCoursePack: vi.fn(async () => ({
    id: "pack-1",
    title: "测试课程包",
    description: "",
    cover: "",
    isFree: true,
    courses: [
      { id: "course-1", title: "第一课", description: "", order: 1, coursePackId: "pack-1" },
    ],
  })),
}));

vi.mock("~/api/course", () => ({
  fetchCourse: vi.fn(async () => ({
    id: "course-1",
    title: "第一课",
    description: "",
    order: 1,
    coursePackId: "pack-1",
    statements: [
      {
        id: "s-1",
        order: 1,
        english: "The cat sleeps.",
        chinese: "猫在睡觉。",
        soundmark: "",
        isMastered: false,
        analysis: null,
        splitTree: null,
      },
    ],
  })),
  updateStatementContent: vi.fn(async (id: string, input: Record<string, unknown>) => ({
    id,
    order: 1,
    isMastered: false,
    ...input,
  })),
  saveStatementAnalysis: vi.fn(async () => ({ success: true })),
  saveStatementSplitTree: vi.fn(async () => ({ success: true })),
}));

describe("manage page", () => {
  it("loads packs, courses and statements and switches tabs", async () => {
    const wrapper = mount(ManagePage, {
      global: {
        stubs: {
          NuxtLink: { template: "<a><slot /></a>" },
        },
      },
    });

    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("测试课程包");
    expect(wrapper.text()).toContain("第一课");
    expect(wrapper.text()).toContain("The cat sleeps.");
    expect(wrapper.find("textarea").element.value).toBe("The cat sleeps.");

    await wrapper.find("textarea").setValue("The cat sleeps!");
    const saveContent = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存原文与翻译"));
    await saveContent!.trigger("click");
    await flushPromises();
    expect(updateStatementContent).toHaveBeenCalledWith("s-1", {
      english: "The cat sleeps!",
      chinese: "猫在睡觉。",
      soundmark: "",
    });

    const grammarTab = wrapper.findAll("button").find((button) => button.text() === "语法分析");
    expect(grammarTab).toBeTruthy();
    await grammarTab!.trigger("click");
    expect(wrapper.text()).toContain("可视化编辑");

    const splitTab = wrapper.findAll("button").find((button) => button.text() === "拆分与练法");
    expect(splitTab).toBeTruthy();
    await splitTab!.trigger("click");
    expect(wrapper.text()).toContain("分块编辑");
    expect(wrapper.text()).toContain("四种练法的拆分效果");

    const saveSplit = wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存拆分树"));
    expect(saveSplit).toBeTruthy();
    await saveSplit!.trigger("click");
    await flushPromises();
    expect(saveStatementSplitTree).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ rawText: "The cat sleeps!" }),
    );
  });
});
