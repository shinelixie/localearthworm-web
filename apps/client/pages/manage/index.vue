<template>
  <div class="mx-auto flex w-full max-w-screen-2xl flex-col px-4 py-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-3xl font-bold text-gray-800 dark:text-gray-100">课程管理</h1>
        <p class="mt-1 text-sm text-gray-500">
          编辑句子原文与翻译、逐词语法分析，以及四种练法共用的拆分树。
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="isWebMode"
          class="btn btn-ghost btn-sm"
          :class="{ 'is-active': !!editsOpen }"
          @click="toggleEditsPanel"
        >
          本机修改
          <span
            v-if="edits.length"
            class="rounded-full bg-purple-500 px-1.5 text-xs text-white"
          >
            {{ edits.length }}
          </span>
        </button>
        <NuxtLink
          to="/course-pack"
          class="btn btn-ghost btn-sm"
        >
          返回课程包
        </NuxtLink>
      </div>
    </div>

    <!-- 本机修改面板（纯前端版专属）：这里改的内容存在浏览器 IndexedDB，
         只对当前这台设备生效；要分享给所有人，回本地版改母库再重新导出 -->
    <UModal
      :model-value="editsOpen"
      :ui="{ width: 'w-full sm:max-w-2xl' }"
      @update:model-value="(value: boolean) => (editsOpen = value)"
    >
      <div class="flex max-h-[82vh] flex-col rounded-xl bg-white dark:bg-gray-900">
        <CommonModalHeader
          title="本机修改"
          @close="editsOpen = false"
        />
        <p class="px-6 pt-3 text-xs text-gray-500">
          网页版的内容随站发布、不可改库。你在课程管理里改过的句子会存在这台浏览器的 IndexedDB
          里（只对你本机生效），刷新也不会丢；清除后即恢复为发布时的原文。
        </p>
        <div
          v-if="!edits.length"
          class="flex flex-1 items-center justify-center px-6 py-10 text-sm text-gray-400"
        >
          还没有本机修改
        </div>
        <ul
          v-else
          class="mt-3 flex-1 space-y-2 overflow-y-auto px-6 pb-4"
        >
          <li
            v-for="item in edits"
            :key="item.statementId"
            class="flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-gray-700 dark:text-gray-200">{{ item.english }}</p>
              <p class="mt-1 text-xs text-gray-400">
                {{ item.fields.join(" · ") }} · {{ formatEditedAt(item.updatedAt) }}
              </p>
            </div>
            <button
              class="btn btn-ghost btn-xs text-red-500 hover:text-red-600"
              @click="removeEdit(item.statementId)"
            >
              清除
            </button>
          </li>
        </ul>
        <div
          v-if="edits.length"
          class="border-t border-gray-200 p-4 dark:border-gray-700"
        >
          <button
            class="btn btn-sm w-full bg-red-500 text-white hover:bg-red-600"
            @click="clearAllEdits"
          >
            清除全部（{{ edits.length }} 条）
          </button>
        </div>
      </div>
    </UModal>

    <div class="grid min-h-[75vh] gap-4 lg:grid-cols-[220px_280px_1fr]">
      <!-- 课程包 -->
      <aside
        class="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
      >
        <h2 class="mb-2 text-sm font-semibold text-gray-600 dark:text-gray-300">课程包</h2>
        <div
          v-if="loading.packs"
          class="py-6 text-center text-sm text-gray-400"
        >
          加载中…
        </div>
        <div
          v-else
          class="max-h-[65vh] space-y-1 overflow-y-auto pr-1"
        >
          <button
            v-for="item in packs"
            :key="item.id"
            :class="[
              'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
              item.id === packId
                ? 'bg-purple-50 font-medium text-purple-700 dark:bg-purple-900/20 dark:text-purple-300'
                : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800',
            ]"
            @click="selectPack(item.id)"
          >
            {{ item.title }}
          </button>
        </div>
      </aside>

      <!-- 课程 + 句子 -->
      <aside
        class="flex min-h-0 flex-col rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
      >
        <h2 class="mb-2 text-sm font-semibold text-gray-600 dark:text-gray-300">课程</h2>
        <select
          v-model="courseId"
          class="select select-bordered select-sm w-full"
          :disabled="loading.pack || courses.length === 0"
          @change="selectCourse(courseId)"
        >
          <option
            v-for="item in courses"
            :key="item.id"
            :value="item.id"
          >
            {{ item.title }}
          </option>
        </select>

        <div class="mt-3 flex items-center gap-2">
          <input
            v-model="search"
            class="input input-sm input-bordered w-full"
            placeholder="搜索英文/中文"
          />
          <span class="whitespace-nowrap text-xs text-gray-400">
            {{ filteredStatements.length }} 句
          </span>
        </div>

        <div class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          <div
            v-if="loading.course"
            class="py-6 text-center text-sm text-gray-400"
          >
            加载中…
          </div>
          <button
            v-for="item in filteredStatements"
            :key="item.statement.id"
            :class="[
              'w-full rounded-lg border px-2 py-2 text-left text-xs transition-colors',
              item.statement.id === statementId
                ? 'border-purple-300 bg-purple-50 dark:border-purple-700 dark:bg-purple-900/20'
                : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800',
            ]"
            @click="statementId = item.statement.id"
          >
            <div class="flex items-center gap-1 text-[11px] text-gray-400">
              <span>#{{ item.index }}</span>
              <span
                :class="
                  item.statement.analysis?.segments?.length ? 'text-emerald-500' : 'text-gray-300'
                "
              >
                语法
              </span>
              <span :class="item.statement.splitTree ? 'text-emerald-500' : 'text-gray-300'">
                拆分
              </span>
            </div>
            <div class="mt-0.5 line-clamp-2 text-gray-700 dark:text-gray-200">
              {{ item.statement.english }}
            </div>
          </button>
        </div>
      </aside>

      <!-- 编辑器 -->
      <main
        class="flex min-h-0 flex-col rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
      >
        <div
          v-if="!currentStatement"
          class="flex flex-1 items-center justify-center text-sm text-gray-400"
        >
          选择左侧的课程和句子开始编辑
        </div>

        <template v-else>
          <div class="mb-3 border-b border-gray-200 pb-3 dark:border-gray-700">
            <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span>{{ pack?.title }}</span>
              <span>/</span>
              <span>{{ course?.title }}</span>
              <span>/</span>
              <span>第 {{ currentIndex }} 句</span>
              <span
                v-if="currentStatement.analysis?.segments?.length"
                class="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-600 dark:bg-emerald-900/20"
              >
                已标注语法
              </span>
              <span
                v-if="currentStatement.splitTree"
                class="rounded bg-sky-50 px-1.5 py-0.5 text-sky-600 dark:bg-sky-900/20"
              >
                已生成拆分
              </span>
            </div>
            <p class="mt-1 line-clamp-2 text-sm font-medium text-gray-700 dark:text-gray-100">
              {{ currentStatement.english }}
            </p>

            <div class="mt-3 flex gap-2">
              <button
                v-for="tab in tabs"
                :key="tab.key"
                :class="tabClass(activeTab === tab.key)"
                @click="activeTab = tab.key"
              >
                {{ tab.label }}
              </button>
            </div>
          </div>

          <!-- 原文与翻译 -->
          <div
            v-if="activeTab === 'content'"
            class="min-h-0 flex-1 overflow-y-auto"
          >
            <div class="grid gap-4">
              <label class="form-control">
                <span class="mb-1 text-sm font-medium text-gray-600 dark:text-gray-300"
                  >英文原文</span
                >
                <textarea
                  v-model="contentDraft.english"
                  class="textarea textarea-bordered min-h-24 w-full"
                ></textarea>
              </label>
              <label class="form-control">
                <span class="mb-1 text-sm font-medium text-gray-600 dark:text-gray-300"
                  >中文翻译</span
                >
                <textarea
                  v-model="contentDraft.chinese"
                  class="textarea textarea-bordered min-h-24 w-full"
                ></textarea>
              </label>
              <label class="form-control">
                <span class="mb-1 text-sm font-medium text-gray-600 dark:text-gray-300">音标</span>
                <input
                  v-model="contentDraft.soundmark"
                  class="input input-bordered w-full"
                  placeholder="/.../"
                />
              </label>

              <p
                v-if="contentChanged && (currentStatement.analysis || currentStatement.splitTree)"
                class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
              >
                修改英文后，已有的语法标注和拆分树可能不再逐词匹配，请到对应标签页检查并重新保存。
              </p>

              <div class="flex items-center gap-2">
                <button
                  class="btn border-none bg-purple-500 text-white hover:bg-purple-600"
                  :disabled="saving.content || !contentChanged"
                  @click="saveContent"
                >
                  {{ saving.content ? "保存中…" : "保存原文与翻译" }}
                </button>
                <span
                  v-if="!contentChanged"
                  class="text-xs text-gray-400"
                >
                  没有修改
                </span>
              </div>
            </div>
          </div>

          <!-- 语法分析 -->
          <GrammarEditor
            v-else-if="activeTab === 'grammar'"
            :key="`g-${currentStatement.id}`"
            :statement="currentStatement"
            :saving="saving.grammar"
            @save="saveGrammar"
          />

          <!-- 拆分 -->
          <SplitEditor
            v-else
            :key="`s-${currentStatement.id}`"
            :statement="currentStatement"
            :saving="saving.split"
            @save="saveSplit"
          />
        </template>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { toast } from "vue-sonner";

import type { LocalStatementOverride } from "~/api/course";
import type { Course, CoursePack, CoursePacksItem, Statement } from "~/types";
import type { SplitTree } from "~/types/models/split-tree";
import type { StatementAnalysis } from "~/types/models/statement-analysis";
import {
  clearLocalStatementOverrides,
  deleteLocalStatementOverride,
  fetchCourse,
  fetchLocalStatementOverrides,
  saveStatementAnalysis,
  saveStatementSplitTree,
  updateStatementContent,
} from "~/api/course";
import { fetchCoursePack, fetchCoursePacks } from "~/api/course-pack";
import { getApiBase } from "~/api/http";
import CommonModalHeader from "~/components/common/ModalHeader.vue";
import GrammarEditor from "~/components/manage/GrammarEditor.vue";
import SplitEditor from "~/components/manage/SplitEditor.vue";

const tabs = [
  { key: "content", label: "原文与翻译" },
  { key: "grammar", label: "语法分析" },
  { key: "split", label: "拆分与练法" },
] as const;

// 纯前端版（apiBase 为空 → 浏览器端后端）才有「本机修改」
const isWebMode = !getApiBase();
const editsOpen = ref(false);
const edits = ref<LocalStatementOverride[]>([]);

async function loadEdits() {
  if (!isWebMode) return;
  try {
    edits.value = await fetchLocalStatementOverrides();
  } catch {
    edits.value = [];
  }
}

function toggleEditsPanel() {
  editsOpen.value = !editsOpen.value;
  if (editsOpen.value) void loadEdits();
}

async function removeEdit(statementId: string) {
  try {
    await deleteLocalStatementOverride(statementId);
    edits.value = edits.value.filter((item) => item.statementId !== statementId);
    toast.success("已清除这条本机修改");
  } catch (error: any) {
    toast.error(error?.message || "清除失败");
  }
}

async function clearAllEdits() {
  try {
    await clearLocalStatementOverrides();
    edits.value = [];
    toast.success("已清除全部本机修改");
  } catch (error: any) {
    toast.error(error?.message || "清除失败");
  }
}

function formatEditedAt(iso: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const loading = reactive({ packs: true, pack: false, course: false });
const saving = reactive({ content: false, grammar: false, split: false });

const packs = ref<CoursePacksItem[]>([]);
const packId = ref("");
const pack = ref<CoursePack | null>(null);
const courseId = ref("");
const course = ref<Course | null>(null);
const statementId = ref("");
const search = ref("");
const activeTab = ref<(typeof tabs)[number]["key"]>("content");

const contentDraft = reactive({ english: "", chinese: "", soundmark: "" });

const courses = computed(() => pack.value?.courses ?? []);
const statements = computed<Statement[]>(() => course.value?.statements ?? []);
const filteredStatements = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return statements.value
    .map((statement, index) => ({ statement, index: index + 1 }))
    .filter(({ statement }) => {
      if (!keyword) return true;
      return (
        statement.english.toLowerCase().includes(keyword) ||
        statement.chinese.toLowerCase().includes(keyword)
      );
    });
});

const currentStatement = computed<Statement | null>(
  () => statements.value.find((statement) => statement.id === statementId.value) ?? null,
);
const currentIndex = computed(
  () => statements.value.findIndex((statement) => statement.id === statementId.value) + 1,
);
const contentChanged = computed(() => {
  const statement = currentStatement.value;
  if (!statement) return false;
  return (
    contentDraft.english !== statement.english ||
    contentDraft.chinese !== statement.chinese ||
    contentDraft.soundmark !== statement.soundmark
  );
});

watch(
  () => currentStatement.value?.id,
  () => {
    const statement = currentStatement.value;
    if (!statement) return;
    contentDraft.english = statement.english;
    contentDraft.chinese = statement.chinese;
    contentDraft.soundmark = statement.soundmark ?? "";
    activeTab.value = "content";
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    packs.value = await fetchCoursePacks();
    if (packs.value.length) await selectPack(packs.value[0].id);
  } catch (error: any) {
    toast.error(error?.message || "课程包加载失败");
  } finally {
    loading.packs = false;
  }
});

async function selectPack(id: string) {
  if (!id || (id === packId.value && pack.value)) return;
  packId.value = id;
  loading.pack = true;
  course.value = null;
  pack.value = null;
  try {
    pack.value = await fetchCoursePack(id);
    const first = pack.value.courses?.[0];
    if (first) await selectCourse(first.id);
  } catch (error: any) {
    toast.error(error?.message || "课程加载失败");
  } finally {
    loading.pack = false;
  }
}

async function selectCourse(id: string) {
  if (!id) return;
  courseId.value = id;
  loading.course = true;
  course.value = null;
  try {
    course.value = await fetchCourse(packId.value, id);
    statementId.value = course.value.statements?.[0]?.id ?? "";
    search.value = "";
  } catch (error: any) {
    toast.error(error?.message || "句子加载失败");
  } finally {
    loading.course = false;
  }
}

function tabClass(active: boolean) {
  return active
    ? "rounded-lg bg-purple-500 px-3 py-1.5 text-sm text-white"
    : "rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-600 hover:bg-purple-50 dark:bg-gray-800 dark:text-gray-300";
}

async function saveContent() {
  const statement = currentStatement.value;
  if (!statement) return;
  saving.content = true;
  try {
    const updated = await updateStatementContent(statement.id, {
      english: contentDraft.english,
      chinese: contentDraft.chinese,
      soundmark: contentDraft.soundmark,
    });
    Object.assign(statement, {
      english: updated.english,
      chinese: updated.chinese,
      soundmark: updated.soundmark,
    });
    toast.success("原文与翻译已保存");
    if (isWebMode) void loadEdits();
  } catch (error: any) {
    toast.error(error?.message || "保存失败");
  } finally {
    saving.content = false;
  }
}

async function saveGrammar(analysis: StatementAnalysis) {
  const statement = currentStatement.value;
  if (!statement) return;
  saving.grammar = true;
  try {
    await saveStatementAnalysis(statement.id, analysis);
    statement.analysis = analysis;
    toast.success("语法分析已保存");
    if (isWebMode) void loadEdits();
  } catch (error: any) {
    toast.error(error?.message || "语法分析保存失败");
  } finally {
    saving.grammar = false;
  }
}

async function saveSplit(tree: SplitTree) {
  const statement = currentStatement.value;
  if (!statement) return;
  saving.split = true;
  try {
    await saveStatementSplitTree(statement.id, tree);
    statement.splitTree = tree;
    toast.success("拆分树已保存");
    if (isWebMode) void loadEdits();
  } catch (error: any) {
    toast.error(error?.message || "拆分树保存失败");
  } finally {
    saving.split = false;
  }
}
</script>
