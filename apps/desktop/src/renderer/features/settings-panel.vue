<script setup lang="ts">
/**
 * 「设置」面板（W8-C · 差距报告 H 项）—— 主题 / 界面缩放 / 字体 / 侧栏宽度。
 *
 * 契约见 `docs/接口冻结-W8外壳.md` §1.3。组件只做三件事：把 `SettingsPort` 的视图
 * 渲染出来、把交互翻成补丁、把端口返回的新视图原样 `emit('change')` 出去。
 *
 * 🔴 一条贯穿全文件的规矩：**本地显示永远用端口返回值刷新，不用自己传进去的值**。
 *    `settings-store.ts` 会收敛主题 id、钳制缩放、按窗口宽度重算自动缩放，
 *    拿入参当结果就会显示一个并不生效的数字（"跟随窗口"档最容易踩：用户点「+」时
 *    按钮是禁用的，但点「自动」后显示值必须跟着窗口重算）。
 *
 * 🔴 第二条：`SettingsPort` 没有 `FeatureResult`，写失败（隐私模式 / 配额）表现为
 *    "**返回未变更的视图**"。所以每次 save 后用 `isPatchApplied` 比对，
 *    不一致就显示「未生效」并说明原因 —— 静默假装成功是契约 §0.2 明令禁止的。
 *
 * 状态一律局部 `ref`，不碰 `localStorage`（§0.5），`load()` 只在 setup 里调一次
 * （同步拿到初值，首帧就是真值，没有"先渲染默认值再跳变"的一闪）。
 */

import { YfeButton, YfePanel } from '@yfe/ui'
import { computed, shallowRef } from 'vue'

import type { AppSettingsView, SettingsPort } from './types.js'
import type { ThemeOption } from './settings-panel-model.js'
import {
  CHANGE_PREFIX_FAILED,
  CHANGE_PREFIX_OK,
  CURRENT_THEME_NOTE,
  FONT_CHOICES,
  FONT_SIZE_CHOICES,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  RESET_DONE_TEXT,
  SAVE_FAILED_HINT,
  SIDEBAR_HINT,
  SIDEBAR_WIDTH_STEP,
  THEMES_EMPTY,
  THEME_DISABLED_NOTE,
  ZOOM_AUTO_HINT,
  ZOOM_AUTO_LABEL,
  buildFontPatch,
  buildFontSizePatch,
  buildSidebarPatch,
  buildZoomAutoPatch,
  buildZoomStepPatch,
  canStepZoom,
  changeSummary,
  clampSidebarValue,
  fontChoiceLabel,
  fontChoiceValue,
  fontSizeChoice,
  isPatchApplied,
  isThemeOptionCurrent,
  isThemeOptionDisabled,
  sidebarDisplayText,
  themeOptionTitle,
  zoomDisplayText,
} from './settings-panel-model.js'

const props = defineProps<{
  settings: SettingsPort
  themes: readonly ThemeOption[]
}>()

const emit = defineEmits<{
  change: [view: AppSettingsView]
  close: []
}>()

/** 当前设置视图：初值来自端口，之后每次 save/reset 都用返回值整体替换。 */
const view = shallowRef<AppSettingsView>(props.settings.load())

/**
 * 侧栏宽度的**拖动中**显示值。
 *
 * 单独留一个 ref 是为了让滑块跟手：`input` 每帧都触发，而端口写盘是同步的
 * （`localStorage.setItem`），真写失败时返回值会把滑块拽回去 —— 那种"拽回去"
 * 配合下面的「未生效」提示是**正确**的反馈，但拖动过程中不能让显示滞后于手指。
 */
const sidebarDraft = shallowRef<number>(view.value.sidebarWidth)

/** 最近一次改动的回执（成功 / 未生效）。空串 = 还没改过，不占版面。 */
const notice = shallowRef<string>('')
/** 最近一次改动是否真的写进去了。 */
const noticeOk = shallowRef<boolean>(true)

const zoomText = computed(() => zoomDisplayText(view.value.zoomPercent))
const zoomStep = computed(() => canStepZoom(view.value))
const autoChecked = computed(() => !view.value.zoomManual)
const sidebarText = computed(() => sidebarDisplayText(sidebarDraft.value))
const fontValue = computed(() => fontChoiceValue(view.value.fontFamily))
const fontLabel = computed(() => fontChoiceLabel(view.value.fontFamily))
const sizeValue = computed(() => fontSizeChoice(view.value.fontSize))

/**
 * 应用一个补丁：调端口 → 用返回值刷新本地 → 比对判定是否生效 → 通知外壳。
 *
 * `emit('change')` 在失败路径上**也发**：外壳可能拿这个视图同步主题 / 缩放
 * （例如把 `--ui-zoom` 写进 `<html>`），而失败时返回的是"真实当前状态"，
 * 正是外壳该对齐的值。
 */
function applyPatch(patch: Partial<AppSettingsView>): void {
  const next = props.settings.save(patch)
  const summary = changeSummary(patch, props.themes)
  const applied = isPatchApplied(next, patch)

  view.value = next
  sidebarDraft.value = next.sidebarWidth
  noticeOk.value = applied
  notice.value = applied
    ? `${CHANGE_PREFIX_OK}${summary}`
    : `${CHANGE_PREFIX_FAILED}${summary}。${SAVE_FAILED_HINT}`

  emit('change', next)
}

function onThemeClick(option: ThemeOption): void {
  // 禁用项理论上点不到（原生 disabled + YfeButton 内部闸门），这里再挡一次：
  // 语义不能只靠 DOM 兜着（YfeButton 注释里的同一条理由）。
  if (isThemeOptionDisabled(option)) return
  if (isThemeOptionCurrent(option, view.value.themeId)) return
  applyPatch({ themeId: option.id })
}

function onZoomStep(direction: 1 | -1): void {
  if (!view.value.zoomManual) return
  applyPatch(buildZoomStepPatch(view.value, direction))
}

function onZoomAutoToggle(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked
  applyPatch(buildZoomAutoPatch(view.value, enabled))
}

function onFontChange(event: Event): void {
  applyPatch(buildFontPatch((event.target as HTMLSelectElement).value))
}

function onFontSizeChange(event: Event): void {
  applyPatch(buildFontSizePatch((event.target as HTMLSelectElement).value))
}

function onSidebarInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  const width = clampSidebarValue(raw)
  sidebarDraft.value = width
  applyPatch(buildSidebarPatch(width))
}

function onReset(): void {
  const next = props.settings.reset()
  view.value = next
  sidebarDraft.value = next.sidebarWidth
  noticeOk.value = true
  notice.value = RESET_DONE_TEXT
  emit('change', next)
}
</script>

<template>
  <YfePanel class="settings-panel" data-testid="settings-panel" title="设置">
    <div class="settings-panel__body">
      <!-- ==================== 主题 ==================== -->
      <section class="settings-panel__section">
        <h3 class="settings-panel__heading">主题</h3>
        <p v-if="props.themes.length === 0" class="settings-panel__empty" data-testid="themes-empty">
          {{ THEMES_EMPTY }}
        </p>
        <div v-else class="settings-panel__themes" role="group" aria-label="主题">
          <button
            v-for="option in props.themes"
            :key="option.id"
            type="button"
            class="settings-panel__theme"
            :class="{ 'settings-panel__theme--current': isThemeOptionCurrent(option, view.themeId) }"
            :data-testid="`theme-option-${option.id}`"
            :title="themeOptionTitle(option)"
            :aria-pressed="isThemeOptionCurrent(option, view.themeId)"
            :disabled="isThemeOptionDisabled(option)"
            @click="onThemeClick(option)"
          >
            <span class="settings-panel__swatch" :style="{ background: option.swatch }" aria-hidden="true" />
            <span class="settings-panel__theme-name">{{ option.name }}</span>
            <span class="settings-panel__theme-desc">{{ option.desc }}</span>
            <span
              v-if="isThemeOptionDisabled(option)"
              class="settings-panel__theme-note"
              :data-testid="`theme-disabled-${option.id}`"
            >
              {{ THEME_DISABLED_NOTE }}
            </span>
            <span
              v-else-if="isThemeOptionCurrent(option, view.themeId)"
              class="settings-panel__theme-current"
              :data-testid="`theme-current-${option.id}`"
            >
              {{ CURRENT_THEME_NOTE }}
            </span>
          </button>
        </div>
      </section>

      <!-- ==================== 界面缩放 ==================== -->
      <section class="settings-panel__section">
        <h3 class="settings-panel__heading">界面缩放</h3>
        <div class="settings-panel__row">
          <YfeButton
            data-testid="zoom-decrease"
            label="− 缩小"
            :disabled="!zoomStep.decrease"
            @click="onZoomStep(-1)"
          />
          <span class="settings-panel__zoom-value" data-testid="zoom-percent">{{ zoomText }}</span>
          <YfeButton
            data-testid="zoom-increase"
            label="+ 放大"
            :disabled="!zoomStep.increase"
            @click="onZoomStep(1)"
          />
          <label class="settings-panel__checkbox">
            <input
              type="checkbox"
              data-testid="zoom-auto"
              :checked="autoChecked"
              @change="onZoomAutoToggle"
            />
            <span>{{ ZOOM_AUTO_LABEL }}</span>
          </label>
        </div>
        <p v-if="!view.zoomManual" class="settings-panel__hint" data-testid="zoom-auto-hint">
          {{ ZOOM_AUTO_HINT }}
        </p>
      </section>

      <!-- ==================== 字体 ==================== -->
      <section class="settings-panel__section">
        <h3 class="settings-panel__heading">字体</h3>
        <div class="settings-panel__row">
          <label class="settings-panel__field">
            <span class="settings-panel__label">正文字体</span>
            <select data-testid="font-family" :value="fontValue" @change="onFontChange">
              <option v-for="choice in FONT_CHOICES" :key="choice.label" :value="choice.value">
                {{ choice.label }}
              </option>
            </select>
          </label>
          <label class="settings-panel__field">
            <span class="settings-panel__label">正文字号</span>
            <select data-testid="font-size" :value="sizeValue" @change="onFontSizeChange">
              <option v-for="size in FONT_SIZE_CHOICES" :key="size" :value="size">
                {{ size }}
              </option>
            </select>
          </label>
        </div>
        <p class="settings-panel__hint" data-testid="font-current">当前正文字体：{{ fontLabel }}</p>
      </section>

      <!-- ==================== 侧栏宽度 ==================== -->
      <section class="settings-panel__section">
        <h3 class="settings-panel__heading">侧栏宽度</h3>
        <div class="settings-panel__row">
          <input
            type="range"
            class="settings-panel__range"
            data-testid="sidebar-width"
            :min="MIN_SIDEBAR_WIDTH"
            :max="MAX_SIDEBAR_WIDTH"
            :step="SIDEBAR_WIDTH_STEP"
            :value="sidebarDraft"
            aria-label="侧栏宽度"
            @input="onSidebarInput"
          />
          <span class="settings-panel__zoom-value" data-testid="sidebar-value">{{ sidebarText }}</span>
        </div>
        <p class="settings-panel__hint">{{ SIDEBAR_HINT }}</p>
      </section>

      <!-- ==================== 回执 ==================== -->
      <p
        v-if="notice !== ''"
        class="settings-panel__notice"
        :class="{ 'settings-panel__notice--failed': !noticeOk }"
        data-testid="settings-notice"
        role="status"
      >
        {{ notice }}
      </p>

      <!-- ==================== 底部操作 ==================== -->
      <footer class="settings-panel__footer">
        <YfeButton data-testid="settings-reset" label="恢复默认" @click="onReset" />
        <YfeButton data-testid="settings-close" label="关闭" @click="emit('close')" />
      </footer>
    </div>
  </YfePanel>
</template>

<style scoped>
.settings-panel__body {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md, 14px);
}

.settings-panel__section {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.settings-panel__heading {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  font-weight: var(--yfe-font-weight-bold, 600);
  letter-spacing: 0.04em;
}

.settings-panel__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

/* 主题色块网格：允许折行，窄侧栏下不会把色块挤扁（上游 Sidebar 同款处理）。 */
.settings-panel__themes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.settings-panel__theme {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--yfe-space-xs, 4px);
  min-width: 104px;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
  text-align: left;
  cursor: pointer;
}

.settings-panel__theme:hover:not(:disabled) {
  border-color: var(--yfe-color-border-strong, #3a4150);
}

.settings-panel__theme:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
  outline-offset: 1px;
}

.settings-panel__theme--current {
  border-color: var(--yfe-color-accent, #5aa9ff);
}

.settings-panel__theme:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.settings-panel__swatch {
  width: 100%;
  height: 18px;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
}

.settings-panel__theme-name {
  font-weight: var(--yfe-font-weight-medium, 500);
}

.settings-panel__theme-desc {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
}

.settings-panel__theme-current {
  padding: 0 var(--yfe-space-xs, 4px);
  border-radius: var(--yfe-radius-pill, 999px);
  background: var(--yfe-color-accent, #5aa9ff);
  color: var(--yfe-color-text-on-accent, #0b1016);
  font-size: var(--yfe-font-size-xs, 11px);
}

.settings-panel__theme-note {
  color: var(--yfe-color-warning, #e8b96b);
  font-size: var(--yfe-font-size-xs, 11px);
}

.settings-panel__zoom-value {
  min-width: 56px;
  font-variant-numeric: tabular-nums;
  font-weight: var(--yfe-font-weight-medium, 500);
  text-align: center;
}

.settings-panel__checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.settings-panel__field {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.settings-panel__label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.settings-panel__field select {
  height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-background, #111318);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
}

.settings-panel__field select:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
}

.settings-panel__range {
  flex: 1;
  min-width: 160px;
  accent-color: var(--yfe-color-accent, #5aa9ff);
}

.settings-panel__hint,
.settings-panel__empty {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.settings-panel__empty {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
}

.settings-panel__notice {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-success, #5ddc9a);
  font-size: var(--yfe-font-size-sm, 12px);
}

.settings-panel__notice--failed {
  color: var(--yfe-color-danger, #ff7b72);
}

.settings-panel__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--yfe-space-sm, 8px);
  padding-top: var(--yfe-space-sm, 8px);
  border-top: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
}
</style>
