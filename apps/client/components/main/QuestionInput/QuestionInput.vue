<template>
  <div class="quiz-input text-center">
    <div
      class="word-line relative flex flex-wrap justify-center gap-2 transition-all"
      :class="{
        'show-hint': showPhonetic,
        'advanced-line': isAdvancedNoHelp,
        'force-lines': !isChineseToEnglishMode(),
      }"
    >
      <template
        v-for="(w, i) in courseStore.words"
        :key="i"
      >
        <!-- 原句词首标点：按原位置显示在横线旁，不再隐藏 -->
        <span
          v-if="edgePunct(w).before"
          class="cell-punct"
        >
          {{ edgePunct(w).before }}
        </span>
        <div
          v-if="isWord(w)"
          class="word-cell h-[4rem] rounded-[2px] border-b-2 border-solid text-[3em] leading-none transition-all"
          :class="[getWordsClassNames(i), { 'show-hint': showPhonetic }]"
          :style="{ minWidth: `${inputWidth(w)}ch` }"
        >
          <template v-if="caretOffset(i) !== null">
            <span class="word-typing"
              >{{ wordInput(i).slice(0, caretOffset(i)!) }}<span class="typing-caret"></span
              >{{ wordInput(i).slice(caretOffset(i)!) }}</span
            >
          </template>
          <template v-else>{{ wordInput(i) }}</template>
          <span
            v-if="showPhonetic"
            class="cell-phonetic"
            >{{ phonetics[i] || "" }}</span
          >
        </div>
        <div
          v-else
          class="h-[4rem] rounded-[2px] text-[3em] leading-none transition-all"
        >
          {{ w }}
        </div>
        <!-- 原句词尾标点：显示在词格右侧（格外，字号按面板基准 1.2em，不跟词格 3em 叠加） -->
        <span
          v-if="isWord(w) && edgePunct(w).after"
          class="cell-punct"
        >
          {{ edgePunct(w).after }}
        </span>
      </template>
      <input
        lang="en"
        ref="inputEl"
        class="absolute h-full w-full opacity-0"
        type="text"
        v-model="inputValue"
        @keydown="handleKeydown"
        @keyup="handleKeyup"
        @focus="handleFocus"
        @blur="blurInput"
        @dblclick.prevent
        @mousedown="preventCursorMove"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        autoFocus
      />
    </div>

    <!-- 横线下面的答题辅助：音标提示 / 朗读发音（高阶不给帮助） -->
    <div
      v-if="!isAdvancedNoHelp"
      class="hint-actions"
    >
      <button
        class="hint-btn"
        :class="{ 'is-on': showPhonetic }"
        type="button"
        tabindex="-1"
        :title="showPhonetic ? '隐藏音标提示（Ctrl+\\）' : '显示音标提示（Ctrl+\\）'"
        @mousedown.prevent
        @click="handleTogglePhonetic"
      >
        <UIcon
          name="i-ph-lightbulb"
          class="hint-icon"
        />
        <span>{{ showPhonetic ? "隐藏音标" : "音标提示" }}</span>
        <kbd class="hint-kbd">Ctrl+\</kbd>
      </button>
    </div>

    <div class="mt-12 flex flex-col items-center justify-center gap-4 md:hidden">
      <button
        class="btn btn-outline btn-sm"
        @click="handleSubmitAnswer"
      >
        提交
      </button>
      <div class="flex gap-4">
        <button
          class="btn btn-outline btn-sm"
          @click="handleShowAnswerTip"
        >
          {{ isAnswerTip() ? "隐藏" : "显示" }}答案
        </button>
        <button
          class="btn btn-outline btn-sm"
          @click="handlePlaySound"
        >
          播放声音
        </button>
      </div>
      <MainMasteredBtn v-if="!courseStore.currentStatement?.isFragment"></MainMasteredBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast } from "vue-sonner";

import { courseTimer } from "~/composables/courses/courseTimer";
import { useAnswerTip } from "~/composables/main/answerTip";
import { useCurrentStatementEnglishSound } from "~/composables/main/englishSound";
import { usePhoneticTip } from "~/composables/main/phoneticTip";
import { isWord } from "~/composables/main/question";
import { buildWordCards, edgePunct, useWordInfo } from "~/composables/main/wordInfo";
import { useGamePlayMode } from "~/composables/user/gamePlayMode";
import { useShowWordsWidth } from "~/composables/user/words";
import { useCourseStore } from "~/store/course";
import { useLearningPathStore } from "~/store/learningPath";
import { cancelShortcut, registerShortcut } from "~/utils/keyboardShortcuts";
import { isWindows } from "~/utils/platform";
import { getWordWidth, useQuestionInput } from "./questionInputHelper";
import { useAnswerError } from "./useAnswerError";
import { useWrapperQuestionInput } from "./useWrapperQuestionInput";

const courseStore = useCourseStore();
const { inputEl, focusing, cursorPosition, focusInput, blurInput, syncCursorPosition } =
  useQuestionInput();
const {
  initializeQuestionInput,
  findWordById,
  isFixMode,
  inputValue,
  submitAnswer,
  handleKeyboardInput,
  syncActiveWordFromCursor,
  setInputValue,
} = useWrapperQuestionInput();
const { isShowWordsWidth } = useShowWordsWidth();
const { isChineseToEnglishMode } = useGamePlayMode();
const learningPathStore = useLearningPathStore();

// 难度控制输入提示：
// 入门 = 每个词按长度显示空格；进阶 = 等宽空格；高阶 = 等宽 + 只有一条横线
const useVariableWidth = computed(() => {
  if (!isChineseToEnglishMode()) return isShowWordsWidth();
  return learningPathStore.currentDifficulty === "beginner";
});
const isAdvancedNoHelp = computed(
  () => isChineseToEnglishMode() && learningPathStore.currentDifficulty === "advanced",
);
const { toggleAnswerTip, isAnswerTip } = useAnswerTip();
const { resetCloseTip } = useAnswerError();
initializeQuestionInput();
focusInputWhenWIndowFocus();

// ---------- 音标提示（共享状态，底部快捷键栏「Ctrl+\ 音标提示」也能联动开关） ----------
const { playSound } = useCurrentStatementEnglishSound();
const { showPhonetic, toggle: togglePhonetic } = usePhoneticTip();
const { isReady: isWordInfoReady, load: loadWordInfo, lookup: lookupWord } = useWordInfo();

/** 逐词音标，顺序与输入框中的词一一对应 */
const phonetics = computed(() => {
  if (!isWordInfoReady.value) return [] as string[];
  const statement = courseStore.currentStatement;
  if (!statement) return [];
  // analysis 里的逐词音标优先于句子音标/词表：四六级「一句一课」的句子 soundmark
  // 经常为空、词表只收 3596 个高频词，漏掉 analysis 会让逐词音标大面积空白
  return buildWordCards(statement.english, statement.soundmark, lookupWord, statement.analysis).map(
    (card) => card.phonetic,
  );
});

function handleTogglePhonetic(e?: MouseEvent) {
  e?.preventDefault();
  togglePhonetic();
  focusInput();
}

onMounted(() => {
  focusInput();
  resetCloseTip();
  loadWordInfo();
  registerShortcut("Ctrl+\\", handlePhoneticShortcut);
});

onUnmounted(() => {
  cancelShortcut("Ctrl+\\", handlePhoneticShortcut);
});

function handlePhoneticShortcut(e: KeyboardEvent) {
  if (isAdvancedNoHelp.value) return;
  e.preventDefault();
  togglePhonetic();
}

watch(
  () => inputValue.value,
  (val) => {
    setInputValue(val);
    courseTimer.time(String(courseStore.statementIndex));
  },
);

watch(
  () => courseStore.statementIndex,
  () => {
    focusInput();
    resetCloseTip();
    // 换题后收起音标提示，避免直接看到下一题的读音
    showPhonetic.value = false;
  },
);

function focusInputWhenWIndowFocus() {
  const handleFocus = () => {
    focusInput();
  };

  onMounted(() => {
    window.addEventListener("focus", handleFocus);
  });

  onUnmounted(() => {
    window.removeEventListener("focus", handleFocus);
  });
}

function handlePlaySound(e: MouseEvent) {
  e.preventDefault();
  playSound();
  focusInput();
}

function handleShowAnswerTip(e: MouseEvent) {
  e.preventDefault();
  toggleAnswerTip();
}

function handleSubmitAnswer() {
  submitAnswer();
}

function wordInput(index: number) {
  return findWordById(index)?.userInput ?? "";
}

/** 当前词内光标偏移；光标不在这个词里时返回 null */
function caretOffset(index: number): number | null {
  const word = findWordById(index);
  if (!word || !word.isActive || !focusing.value) return null;
  const position = cursorPosition.value;
  if (position < word.start || position > word.end) return null;
  return Math.min(Math.max(position - word.start, 0), word.userInput.length);
}

function handleFocus() {
  focusInput();
  syncCursorPosition();
  syncActiveWordFromCursor();
}

function handleKeyup(e: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  syncCursorPosition();
  syncActiveWordFromCursor();
}

function getWordsClassNames(index: number) {
  const word = findWordById(index)!;
  // 当前单词激活 且 聚焦
  if (word.isActive && focusing.value) {
    return "text-[#2f7d5e] border-b-[#2f7d5e]";
  }

  // 当前单词错误 且 聚焦
  if (word.incorrect && focusing.value) {
    // Fix 修复模式添加动画
    return `text-red-500 border-b-red-500 ${isFixMode() && "animate-shake"}`;
  }

  // 默认样式（学习页是浅蓝底，不跟随深色主题）
  return "text-[#6d879b] border-b-[#9cb9cd]";
}

// 输入宽度
function inputWidth(word: string) {
  if (!useVariableWidth.value) {
    // 不看单词长度：统一 4 字符宽
    return 4;
  }

  return getWordWidth(word);
}

// // 中文输入会导致先触发 handleKeydown
// // 但是这时候字符还没有上屏
// // 就会造成触发 submit answer  导致明明答案正确但是不通过的问题
// // 通过检测是否为输入法 来避免按下 enter 后直接触发 submit answer
let isComposing = ref(false);
function handleCompositionStart() {
  isComposing.value = true;
}

function handleCompositionEnd() {
  isComposing.value = false;
}

function handleKeydown(e: KeyboardEvent) {
  // 音标提示（Ctrl+\）走 window 级全局快捷键，这里不截数字键——
  // 数字照常写进答案；带 Ctrl 的组合键由下面的 e.ctrlKey 分支 preventDefault，
  // 不会把符号敲进答案，且继续冒泡到 window 触发注册的快捷键。

  // 给 windows 用户添加 ctrl + backspace 删除上一个单词的快捷键
  // 有些浏览器 input 不支持通过 ctrl + backspace 删除 所以自行扩展下
  if (e.code === "Backspace" && e.ctrlKey && isWindows()) {
    e.preventDefault();
    deletePreviousWordOnWin();
    return;
  }

  // 避免在某些中文输入法中，按下 Ctrl 键时，输入法会将当前的预输入字符上屏
  if (e.ctrlKey) {
    e.preventDefault();
    return;
  }

  if (e.code === "Enter" && !isComposing.value) {
    e.stopPropagation();
    submitAnswer();
    return;
  }

  handleKeyboardInput(e);
}

function deletePreviousWordOnWin() {
  var start = inputEl.value!.selectionStart!;
  var end = inputEl.value!.selectionEnd!;
  if (end === 0) return;

  // 删除光标前的所有连续空格
  while (start > 0 && inputValue.value[start - 1] === " ") {
    start--;
  }
  var valueToCursor = inputValue.value.substring(0, start);
  var newEnd = valueToCursor.lastIndexOf(" ") + 1 || 0;
  inputValue.value = inputValue.value.substring(0, newEnd);
  inputEl.value!.setSelectionRange(newEnd, newEnd);
}

function preventCursorMove(event: MouseEvent) {
  // 阻止 mousedown 事件的默认行为
  // 它会改变 input 光标的位置
  event.preventDefault();
  // 只允许 input focus
  focusInput();
}
</script>

<style scoped>
/* 与答案页保持同一套字体：英文用衬线，中文用系统黑体 */
.quiz-input {
  font-family: Georgia, "Times New Roman", "Songti SC", "Microsoft YaHei", "PingFang SC", serif;
}

/* 词行固定预留音标空间，提示开关时按钮不位移 */
.word-line {
  /* 给绝对定位的音标留出位置，音标开关时按钮不位移 */
  padding-bottom: 38px;
}

/* 换行时把行距撑开，避免上一行的音标压到下一行 */
.word-line.show-hint {
  row-gap: 42px;
}

/* 高阶：只保留一条横线，隐藏每个单词自己的下划线 */
.word-line.advanced-line {
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  border-bottom: 2px solid #9cb9cd;
  padding-bottom: 10px;
}

.word-line.advanced-line .word-cell {
  border-bottom-color: transparent !important;
}

/* 听写/听力：始终保留每个词的下划线，避免高阶规则或样式覆盖导致没地方输入 */
.word-line.force-lines .word-cell {
  border-bottom-color: #9cb9cd !important;
}

.word-cell {
  position: relative;
}

/* 原句标点：按原位置显示在词旁，字号比词小、颜色与面板下划线/音标同一灰蓝色系 */
.cell-punct {
  display: inline-block;
  font-size: 1.2em;
  line-height: 1;
  color: #6d879b;
}

/* 词块内的可见光标：方向键移动后能看出当前位置 */
.word-typing {
  white-space: pre;
}

.typing-caret {
  display: inline-block;
  width: 2px;
  height: 0.82em;
  margin: 0 -1px;
  vertical-align: -0.06em;
  background-color: #2f7d5e;
  animation: caret-blink 1s step-end infinite;
}

@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

.cell-phonetic {
  position: absolute;
  left: 50%;
  bottom: -22px;
  transform: translateX(-50%);
  font-family: Georgia, "Times New Roman", "Songti SC", serif;
  font-size: 15px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0.3px;
  color: #3d6f93;
  white-space: nowrap;
  pointer-events: none;
  animation: phonetic-in 0.18s ease both;
}

@keyframes phonetic-in {
  from {
    opacity: 0;
    transform: translate(-50%, -5px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

/* 横线下面的两个辅助按钮 */
.hint-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 4px;
}

.hint-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 18px;
  border-radius: 999px;
  border: 1px solid rgba(140, 180, 205, 0.55);
  background-color: rgba(255, 255, 255, 0.7);
  font-family:
    "Microsoft YaHei",
    "PingFang SC",
    -apple-system,
    "Segoe UI",
    sans-serif;
  font-size: 15px;
  color: #2c5d7c;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.1s ease;
}

.hint-btn:hover {
  background-color: #fff;
  border-color: rgba(96, 152, 186, 0.7);
  color: #17493b;
  box-shadow: 0 3px 10px rgba(45, 110, 150, 0.12);
  transform: translateY(-1px);
}

.hint-btn:active {
  transform: scale(0.98);
}

.hint-btn.is-on {
  background-color: #fff;
  border-color: #7fb3d0;
  color: #17493b;
  box-shadow: 0 0 0 3px rgba(127, 179, 208, 0.16);
}

.hint-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}

.hint-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 5px;
  background-color: rgba(44, 93, 124, 0.1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: #4a7593;
}

.hint-btn.is-on .hint-kbd {
  background-color: rgba(23, 73, 59, 0.12);
  color: #17493b;
}
</style>
