<!--
  编辑器状态栏（W9-1 / A-13）—— 上游 `NovelEditor.tsx:616-664` 的底部状态栏。

  ## 真源与对齐
  - 结构与文案：`_upstream_tmp/youth-fantasy-engine-main/src/components/editor/NovelEditor.tsx:616-664`
    （本章字数 620-622 / 今日码字 623-625 / 铺满·限宽 630-637 / 打字机 638-645 / 字号 −＋ 646-660 /
    说明气泡 661-663）。文案字面量一律取自 `./editor-status-bar-model.js`，模板里不写中文常量。
  - 本章字数口径：上游 `src/lib/editor/textStats.ts` 的 `countWords` 已由 B-13 落在
    `@yfe/domain`（`packages/domain/src/text/count.ts`），这里**只调用不重写**；
    `wordCountWithPunct` 只影响**显示**，落库口径仍是 `'cjk'`。
  - 字号范围 14–28 / 步长 1：上游 `src/components/editor/useNovelEditorModel.ts`。

  ## 纪律
  - 只吃 props（`features/types.ts` 的 `AppSettingsView` 语义）、只吐 `change(EditorStatusBarPatch)`；
    **不碰 localStorage、不 import `node:` / `@yfe/contracts`、不调 `window.yfe`**（铁律 1/5）。
    本机记忆由父层 `SettingsPort` 落盘（上游那三个 `'novel-*'` key 本仓不存在）。
  - 「保存状态」不在本组件里：六态中文文案归 `YfeStatusPill` 独占（ADR 0006 D5），
    `App.vue:501` 已在顶栏渲染它。

  ## 两处刻意偏差（另有话题见交付报告 ④）
  1. **不自己画边框/底色**：上游 `border-t bg-ink-900/70` 在本仓由承载它的
     `.app__footer` 提供（`apps/desktop/src/renderer/App.vue:795-802` 已有 `border-top`），
     本组件再画一条会在同一行里叠出双边框 ⇒ 只保留 `h-10` 的行高与内边距。
  2. **说明气泡是组件内绝对定位**，不是上游的 portal + 鼠标坐标：上游 `HelpPopover.tsx`
     把面板 fixed 到鼠标位置，本组件按 right:0 / bottom:100% 挂到「?」按钮上，
     鼠标移出 240ms 后收起（等价于上游 `autoCloseDelay ?? 250` 的「悬停展开」态）。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  EDITOR_STATUS_BAR_COPY,
  EDITOR_STATUS_BAR_HELP_LINES,
  buildFontSizePatch,
  buildPageWidePatch,
  buildTypewriterPatch,
  chapterWordsText,
  chapterWordsTitle,
  editorFontStep,
  fontSizeValueText,
  fontSizeValueTitle,
  pageWideButtonLabel,
  pageWideButtonTitle,
  stepEditorFontSize,
  todayWordsText,
  todayWordsTitle,
} from './editor-status-bar-model.js'
import type { EditorStatusBarPatch } from './editor-status-bar-model.js'

/** 鼠标移出后收起说明气泡的宽限毫秒数（上游 `HelpPopover` 悬停态 `autoCloseDelay ?? 250`）。 */
const HELP_CLOSE_DELAY_MS = 240

const props = withDefaults(
  defineProps<{
    /** 本章正文（上半区稿件正文）。 */
    text: string
    /** 字数口径：false＝只算汉字（默认）／true＝汉字＋标点（**仅用于显示**）。 */
    wordCountWithPunct?: boolean
    /** 今日净增量（汉字数）；`null` ＝ 读不到（按日统计通道未接入时**必须**传 null，不要传 0）。 */
    todayChars?: number | null
    /** 码字区铺满窗口。 */
    pageWide?: boolean
    /** 打字机模式。 */
    typewriter?: boolean
    /** 正文字号，`'16px'` 形态（与 `settings-store.ts` 的 `AppSettingsView.fontSize` 同形）。 */
    fontSize?: string
    /** 只读：禁用状态栏上的三个设置项（正文不可编辑时改它们只会静默失败）。 */
    readOnly?: boolean
  }>(),
  {
    wordCountWithPunct: false,
    todayChars: null,
    pageWide: true,
    typewriter: false,
    fontSize: '16px',
    readOnly: false,
  },
)

const emit = defineEmits<{ change: [patch: EditorStatusBarPatch] }>()

const chapterWords = computed(() => chapterWordsText(props.text, props.wordCountWithPunct))
const chapterTitle = computed(() => chapterWordsTitle(props.wordCountWithPunct))
const todayWords = computed(() => todayWordsText(props.todayChars))
const todayTitle = computed(() => todayWordsTitle(props.todayChars))
const pageWideLabel = computed(() => pageWideButtonLabel(props.pageWide))
const pageWideTitle = computed(() => pageWideButtonTitle(props.pageWide))
const fontStep = computed(() => editorFontStep(props.fontSize))
const fontReadout = computed(() => fontSizeValueText(fontStep.value.value))
const fontReadoutTitle = computed(() => fontSizeValueTitle(fontStep.value.value))

/** 「?」触发的说明气泡：悬停自动展开、点击固定、再点收起。 */
const helpPinned = ref(false)

/** 只读时不留一个能展开却改不了任何东西的说明气泡。 */
watch(
  () => props.readOnly,
  (next) => {
    if (next) helpPinned.value = false
  },
)

let closeTimer: ReturnType<typeof setTimeout> | undefined

function clearCloseTimer(): void {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
}

function onHelpEnter(): void {
  clearCloseTimer()
  helpPinned.value = true
}

function onHelpLeave(): void {
  clearCloseTimer()
  closeTimer = setTimeout(() => {
    closeTimer = undefined
    helpPinned.value = false
  }, HELP_CLOSE_DELAY_MS)
}

function onToggleHelp(): void {
  clearCloseTimer()
  helpPinned.value = !helpPinned.value
}

function onCloseHelp(): void {
  clearCloseTimer()
  helpPinned.value = false
}

function onTogglePageWide(): void {
  if (props.readOnly) return
  emit('change', buildPageWidePatch(!props.pageWide))
}

function onToggleTypewriter(): void {
  if (props.readOnly) return
  emit('change', buildTypewriterPatch(!props.typewriter))
}

/** 字号 ±：到 14/28 边界按钮已禁用，这里再挡一道（等价 `welcome-wizard.vue:17-20` 的「二道闸」）。 */
function onStepFont(delta: number): void {
  if (props.readOnly) return
  const step = editorFontStep(props.fontSize)
  if (delta < 0 && !step.canDecrease) return
  if (delta > 0 && !step.canIncrease) return
  emit('change', buildFontSizePatch(stepEditorFontSize(props.fontSize, delta)))
}
</script>

<template>
  <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -- Esc 收起说明是键盘可达性的补充，不是唯一入口 -->
  <div
    class="editor-status-bar"
    data-testid="editor-status-bar"
    role="group"
    aria-label="编辑器状态栏"
    @keydown.esc="onCloseHelp"
  >
    <span
      class="editor-status-bar__item"
      data-testid="editor-status-bar-chapter-words"
      :title="chapterTitle"
    >
      <svg
        class="editor-status-bar__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <line x1="4" x2="20" y1="9" y2="9" />
        <line x1="4" x2="20" y1="15" y2="15" />
        <line x1="10" x2="8" y1="3" y2="21" />
        <line x1="16" x2="14" y1="3" y2="21" />
      </svg>
      {{ chapterWords }}
    </span>

    <span
      class="editor-status-bar__item editor-status-bar__today"
      data-testid="editor-status-bar-today-words"
      :title="todayTitle"
    >
      <svg
        class="editor-status-bar__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"
        />
      </svg>
      {{ todayWords }}
    </span>

    <div class="editor-status-bar__tools">
      <button
        type="button"
        class="editor-status-bar__button"
        data-testid="editor-status-bar-page-wide"
        :title="pageWideTitle"
        :aria-label="pageWideLabel"
        :aria-pressed="props.pageWide"
        :disabled="props.readOnly"
        @click="onTogglePageWide"
      >
        <svg
          class="editor-status-bar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 21V9" />
        </svg>
        <span>{{ pageWideLabel }}</span>
      </button>

      <button
        type="button"
        class="editor-status-bar__button"
        data-testid="editor-status-bar-typewriter"
        :title="EDITOR_STATUS_BAR_COPY.typewriterTitle"
        :aria-label="EDITOR_STATUS_BAR_COPY.typewriterLabel"
        :aria-pressed="props.typewriter"
        :disabled="props.readOnly"
        @click="onToggleTypewriter"
      >
        <svg
          class="editor-status-bar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <line x1="21" x2="3" y1="6" y2="6" />
          <line x1="17" x2="7" y1="12" y2="12" />
          <line x1="19" x2="5" y1="18" y2="18" />
        </svg>
        <span>{{ EDITOR_STATUS_BAR_COPY.typewriterLabel }}</span>
      </button>

      <div class="editor-status-bar__group" role="group" :aria-label="EDITOR_STATUS_BAR_COPY.fontGroupLabel">
        <button
          type="button"
          class="editor-status-bar__button editor-status-bar__button--symbol"
          data-testid="editor-status-bar-font-decrease"
          :title="EDITOR_STATUS_BAR_COPY.fontDecreaseLabel"
          :aria-label="EDITOR_STATUS_BAR_COPY.fontDecreaseLabel"
          :disabled="props.readOnly || !fontStep.canDecrease"
          @click="onStepFont(-1)"
        >
          −
        </button>
        <span
          class="editor-status-bar__font-value"
          data-testid="editor-status-bar-font-size"
          :title="fontReadoutTitle"
        >
          {{ fontReadout }}
        </span>
        <button
          type="button"
          class="editor-status-bar__button editor-status-bar__button--symbol"
          data-testid="editor-status-bar-font-increase"
          :title="EDITOR_STATUS_BAR_COPY.fontIncreaseLabel"
          :aria-label="EDITOR_STATUS_BAR_COPY.fontIncreaseLabel"
          :disabled="props.readOnly || !fontStep.canIncrease"
          @click="onStepFont(1)"
        >
          ＋
        </button>
      </div>

      <div class="editor-status-bar__help" @mouseenter="onHelpEnter" @mouseleave="onHelpLeave">
        <button
          type="button"
          class="editor-status-bar__button editor-status-bar__button--symbol"
          data-testid="editor-status-bar-help-toggle"
          :title="EDITOR_STATUS_BAR_COPY.helpTriggerTitle"
          :aria-label="EDITOR_STATUS_BAR_COPY.helpTriggerTitle"
          :aria-expanded="helpPinned"
          :disabled="props.readOnly"
          @click="onToggleHelp"
        >
          ?
        </button>

        <div
          v-if="helpPinned && !props.readOnly"
          class="editor-status-bar__help-popover"
          data-testid="editor-status-bar-help"
          role="note"
          :aria-label="EDITOR_STATUS_BAR_COPY.helpPanelLabel"
        >
          <p class="editor-status-bar__help-title" data-testid="editor-status-bar-help-title">
            {{ EDITOR_STATUS_BAR_COPY.helpTitle }}
          </p>
          <p
            v-for="(line, index) in EDITOR_STATUS_BAR_HELP_LINES"
            :key="index"
            class="editor-status-bar__help-line"
            :data-testid="`editor-status-bar-help-line-${index}`"
          >
            {{ line }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行高 / 内边距对齐上游 `h-10 ... px-5 text-11`；border-t 与 bg-ink-900/70 交给承载它的
   `.app__footer`（App.vue:795-802 已有 border-top），避免在同一行里叠出双边框。 */
.editor-status-bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--yfe-space-lg, 16px);
  height: 40px;
  padding: 0 var(--yfe-space-md, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 11px);
  line-height: 1;
}

.editor-status-bar__item {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 上游 623 行 `text-amber/80`。 */
.editor-status-bar__today {
  color: var(--yfe-color-warning, #e0a44a);
}

.editor-status-bar__tools {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-lg, 16px);
  margin-left: auto;
}

.editor-status-bar__group {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.editor-status-bar__button {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  box-sizing: border-box;
  height: var(--yfe-size-control-height-sm, 24px);
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid transparent;
  border-radius: var(--yfe-radius-sm, 4px);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  cursor: pointer;
}

.editor-status-bar__button--symbol {
  justify-content: center;
  min-width: 18px;
  padding: 0;
  font-size: var(--yfe-font-size-md, 13px);
}

.editor-status-bar__button:hover:not(:disabled) {
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
}

.editor-status-bar__button:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
  outline-offset: 1px;
}

.editor-status-bar__button[aria-pressed='true'] {
  color: var(--yfe-color-accent, #5aa9ff);
}

.editor-status-bar__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.editor-status-bar__icon {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
}

.editor-status-bar__font-value {
  min-width: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.editor-status-bar__help {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* 上游 661 行 `<HelpPopover width="23rem" size={12}>`：23rem 宽、正文 12px。 */
.editor-status-bar__help-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: var(--yfe-layer-dialog, 1000);
  box-sizing: border-box;
  width: 23rem;
  max-width: calc(100vw - var(--yfe-space-lg, 16px) * 2);
  max-height: 46vh;
  overflow-y: auto;
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4250);
  border-radius: var(--yfe-radius-lg, 8px);
  background: var(--yfe-color-surface-raised, #20242e);
  box-shadow: 0 12px 32px var(--yfe-color-overlay, rgb(0 0 0 / 50%));
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-md, 12px);
  line-height: var(--yfe-font-line-height, 1.6);
  text-align: left;
}

.editor-status-bar__help-title {
  margin: 0 0 var(--yfe-space-xs, 4px);
  color: var(--yfe-color-warning, #e0a44a);
  font-weight: var(--yfe-font-weight-bold, 700);
}

.editor-status-bar__help-line {
  margin: 0;
  white-space: pre-wrap;
}
</style>