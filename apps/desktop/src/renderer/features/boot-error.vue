<script setup lang="ts">
/**
 * 启动失败兜底页（A-04 · 还原旧版 `src/App.tsx:461-476` 的 `bootError` 分支）。
 *
 * 旧版在启动流程炸掉时不再停在黑屏上，而是给一页能读懂的错误 + 一个重试入口：
 * ```
 * <div className="text-base font-semibold">启动失败</div>
 * <div className="max-w-xl text-13 leading-relaxed text-ink-400">{bootError}</div>
 * <Button variant="secondary" onClick={() => location.reload()}>重新加载</Button>
 * <div className="max-w-xl text-12 text-ink-500">
 *   若反复失败，请先备份数据文件（左下角「数据坞」），再重新加载。
 * </div>
 * ```
 *
 * 🔴 铁律 1（`docs/接口冻结-W8外壳.md` §0.1）：只依赖 props 传进来的**纯数据 + 可选回调**。
 *    不 import `node:`、不 import `@yfe/contracts`、不碰 `window.yfe`、不自己 new client。
 * 🔴 铁律 2（§0.3）：空态/失败路径必须有明确文案，**不许白屏**。所以 `error` 为 `null` 时
 *    用 `toBootErrorView(null)` 现造一份兜底视图，而不是渲染空壳。
 * 🔴 铁律 4（§0.4）：样式只用 `--yfe-*` 变量（每个都带 `var()` fallback）。
 * 🔴 铁律 7（§0.7）：只写自己的文件；`App.vue` 的接线（把 `toBootErrorView(state.lastError)`
 *    与 `onReload` 传进来）由 Lead 做。
 *
 * ⚠️ 与上游的两处刻意偏差（都写在这里，免得后来人以为是漏做）：
 * 1. **不自己调 `location.reload()`**：验收要求「点按钮调传入的回调一次」。组件里直接摸
 *    `location` 就没法在 happy-dom 里断言调用次数，也把「谁来重载」这个决定焊死在视图层。
 *    回调缺省时**不渲染按钮**（没有动作的按钮比没有按钮更糟）。
 * 2. 上游 `Button variant="secondary"` 在本仓 `@yfe/ui` 里**没有对应变体**
 *    （`YfeButton` 只有 `primary` / `ghost` / `danger`，`ghost` 即默认），所以用默认样式；
 *    结构、文案、点击语义与上游一致，只差一层视觉分级。
 * 3. 上游没有「恢复步骤」与「技术详情折叠块」，这两块是本项目按验收要求新增的
 *    （依据都在 `boot-error-model.ts`；此处只负责摆位置）。
 */

import { YfeButton } from '@yfe/ui'
import { computed } from 'vue'

import {
  BOOT_RELOAD_LABEL,
  BOOT_TECHNICAL_SUMMARY,
  toBootErrorView,
} from './boot-error-model.js'
import type { BootErrorView } from './boot-error-model.js'

const props = defineProps<{
  /**
   * 外壳用 `toBootErrorView(...)` 造好的视图模型；`null` 表示「启动失败了但没拿到错误信息」。
   *
   * 允许 `null` 是刻意的：验收要求 `error === null` 时也有可读兜底文案，且不许白屏。
   */
  error: BootErrorView | null
  /**
   * 「重新加载」的落地动作（外壳传 `() => location.reload()`）。
   * 缺省 = 不渲染按钮；组件自己绝不调 `location.reload()`。
   */
  onReload?: () => void
}>()

/** 视图模型。`null` 时现造一份兜底视图 —— 兜底页自己不许再抛出/白屏。 */
const view = computed<BootErrorView>(() => props.error ?? toBootErrorView(null))

/** 有回调才渲染按钮（验收：回调缺省时不渲染）。 */
const showReload = computed<boolean>(() => view.value.canReload && props.onReload !== undefined)

/** 点击只转发一次；重载后页面会整页重建，不存在重复点击的幂等问题。 */
function onReloadClick(): void {
  props.onReload?.()
}
</script>

<template>
  <div class="boot-error" data-testid="boot-error">
    <div class="boot-error__inner">
      <h1 class="boot-error__title" data-testid="boot-error-title">{{ view.title }}</h1>

      <p class="boot-error__message" data-testid="boot-error-message">{{ view.detail }}</p>

      <YfeButton
        v-if="showReload"
        data-testid="boot-error-reload"
        :label="BOOT_RELOAD_LABEL"
        @click="onReloadClick"
      />

      <p v-if="view.canOpenBackupDir" class="boot-error__hint" data-testid="boot-error-hint">
        {{ view.hint }}
      </p>

      <ol class="boot-error__steps" data-testid="boot-error-steps">
        <li
          v-for="(step, index) in view.steps"
          :key="index"
          class="boot-error__step"
          data-testid="boot-error-step"
        >
          {{ step }}
        </li>
      </ol>

      <details
        v-if="view.hasStack"
        class="boot-error__tech"
        data-testid="boot-error-detail"
      >
        <summary class="boot-error__tech-summary">{{ BOOT_TECHNICAL_SUMMARY }}</summary>
        <pre class="boot-error__stack" data-testid="boot-error-stack">{{ view.stack }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
/* 整屏居中：上游 `flex h-screen flex-col items-center justify-center gap-3 p-8 text-center`。
   这里用 `min-height: 100vh` 而不是 `height`：错误信息很长时页面要能自己滚，不许被裁掉。 */
.boot-error {
  display: flex;
  box-sizing: border-box;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: var(--yfe-space-xxl, 32px);
  background: var(--yfe-color-background, #111318);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md, 14px);
}

.boot-error__inner {
  display: flex;
  max-width: 640px;
  flex-direction: column;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
  text-align: center;
}

.boot-error__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.boot-error__message {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  /* 超长错误消息（整段 SQL / HTML）必须能换行，不许把页面撑爆。 */
  overflow-wrap: anywhere;
  text-align: left;
  white-space: pre-wrap;
}

.boot-error__hint {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.boot-error__steps {
  margin: 0;
  padding-left: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  text-align: left;
}

.boot-error__step {
  margin: var(--yfe-space-xs, 4px) 0;
}

.boot-error__tech {
  width: 100%;
  text-align: left;
}

.boot-error__tech-summary {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  cursor: pointer;
}

.boot-error__stack {
  max-height: 240px;
  margin: var(--yfe-space-sm, 8px) 0 0;
  padding: var(--yfe-space-sm, 8px);
  overflow: auto;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-family: var(--yfe-font-family-mono);
  font-size: var(--yfe-font-size-sm, 12px);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>