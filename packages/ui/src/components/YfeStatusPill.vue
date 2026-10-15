<script setup lang="ts">
/**
 * 保存状态标签（ADR 0006 D3 / D5）。
 *
 * 六态中文文案**只在这里映射一次**：ADR 明确别处不得自造，否则同一份草稿会在
 * 状态栏说「保存失败」、在章节树说「同步异常」。调用方只传 `status` 枚举。
 *
 * 另外三件事：
 * 1. `data-status` 保留**原始传入值**，方便调用方与测试按状态选取；
 * 2. 未知状态（后端加了新枚举、旧前端先上线）不抛错，显示「未知状态」并降级样式，
 *    界面不能因为一个状态值整块白屏；
 * 3. `aria-live="polite"`：保存态是异步变化的，屏幕阅读器需要被通知。
 */
import { computed } from 'vue'

import { designTokenVariables } from '../tokens.js'
import type { YfeSaveStatus } from '../types.js'

const props = defineProps<{
  status: YfeSaveStatus
  detail?: string
}>()

/** 六态文案（ADR 0006 D5），**唯一来源**。 */
const STATUS_LABELS: Readonly<Record<YfeSaveStatus, string>> = Object.freeze({
  saved: '本地已保存',
  dirty: '有未保存修改',
  saving: '保存中',
  error: '保存失败',
  conflict: '冲突',
  offline: '离线（本地已保存）',
})

const UNKNOWN_LABEL = '未知状态'
const UNKNOWN_KEY = 'unknown'

function isKnownStatus(value: string): value is YfeSaveStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value)
}

/** 样式键：已知态即状态名，未知态统一走 `unknown`（保证 CSS 一定有兜底规则）。 */
const statusKey = computed<string>(() => (isKnownStatus(props.status) ? props.status : UNKNOWN_KEY))

const label = computed<string>(() =>
  isKnownStatus(props.status) ? STATUS_LABELS[props.status] : UNKNOWN_LABEL,
)
</script>

<template>
  <span
    class="yfe-status-pill"
    :class="`yfe-status-pill--${statusKey}`"
    :style="designTokenVariables"
    :data-status="status"
    :data-status-key="statusKey"
    role="status"
    aria-live="polite"
  >
    <span class="yfe-status-pill__dot" aria-hidden="true" />
    <span class="yfe-status-pill__label">{{ label }}</span>
    <span v-if="detail !== undefined && detail !== ''" class="yfe-status-pill__detail">{{ detail }}</span>
  </span>
</template>

<style scoped>
.yfe-status-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs);
  padding: 0 var(--yfe-space-sm);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-pill);
  background: var(--yfe-color-surface);
  color: var(--yfe-color-text-muted);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-sm);
  line-height: calc(var(--yfe-size-control-height) - var(--yfe-space-xs));
  white-space: nowrap;
}

.yfe-status-pill__dot {
  width: var(--yfe-size-status-dot);
  height: var(--yfe-size-status-dot);
  border-radius: var(--yfe-radius-pill);
  background: currentColor;
}

.yfe-status-pill__detail {
  color: var(--yfe-color-text);
}

/* 颜色只来自令牌：每个状态只声明「语义色」，不改尺寸与布局。 */
.yfe-status-pill--saved {
  color: var(--yfe-color-success);
}

.yfe-status-pill--dirty,
.yfe-status-pill--saving {
  color: var(--yfe-color-text-muted);
}

.yfe-status-pill--saving {
  border-color: var(--yfe-color-border-strong);
}

.yfe-status-pill--error {
  color: var(--yfe-color-danger);
  border-color: var(--yfe-color-danger);
}

.yfe-status-pill--conflict,
.yfe-status-pill--offline {
  color: var(--yfe-color-warning);
  border-color: var(--yfe-color-warning);
}

.yfe-status-pill--unknown {
  color: var(--yfe-color-text-muted);
  border-style: dashed;
}
</style>
