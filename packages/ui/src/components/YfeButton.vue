<script setup lang="ts">
/**
 * 基础按钮（ADR 0006 D3）。
 *
 * 真 `<button>` + 原生 `disabled`：`div` 假装按钮会让键盘、屏幕阅读器、
 * 表单语义全部失真。`loading` 也置位原生 disabled，避免「保存中」被点两次。
 */
import { designTokenVariables } from '../tokens.js'

const props = defineProps<{
  label: string
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{ click: [event: MouseEvent] }>()

function onClick(event: MouseEvent): void {
  // 第二道闸：测试/脚本里 `dispatchEvent` 能绕过原生 disabled，语义不能靠 DOM 兜着。
  if (props.disabled === true || props.loading === true) return
  emit('click', event)
}
</script>

<template>
  <button
    type="button"
    class="yfe-button"
    :class="[`yfe-button--${variant ?? 'ghost'}`, { 'yfe-button--loading': loading === true }]"
    :style="designTokenVariables"
    :disabled="disabled === true || loading === true"
    :aria-busy="loading === true ? 'true' : undefined"
    @click="onClick"
  >
    <span v-if="loading === true" class="yfe-button__spinner" aria-hidden="true" />
    <span class="yfe-button__label">{{ label }}</span>
  </button>
</template>

<style scoped>
.yfe-button {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs);
  box-sizing: border-box;
  height: var(--yfe-size-control-height);
  padding: 0 var(--yfe-space-md);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-md);
  background: var(--yfe-color-surface);
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
  line-height: var(--yfe-font-line-height);
  cursor: pointer;
}

.yfe-button:focus-visible {
  outline: var(--yfe-size-focus-width) solid var(--yfe-color-focus-ring);
  outline-offset: 1px;
}

.yfe-button:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.yfe-button--primary {
  border-color: var(--yfe-color-accent);
  background: var(--yfe-color-accent);
  color: var(--yfe-color-text-on-accent);
}

.yfe-button--primary:hover:not(:disabled) {
  background: var(--yfe-color-accent-hover);
}

.yfe-button--danger {
  border-color: var(--yfe-color-danger);
  color: var(--yfe-color-danger);
}

.yfe-button--danger:hover:not(:disabled) {
  border-color: var(--yfe-color-danger-hover);
  color: var(--yfe-color-danger-hover);
}

.yfe-button--ghost:hover:not(:disabled) {
  border-color: var(--yfe-color-border-strong);
}

.yfe-button__spinner {
  width: var(--yfe-size-status-dot);
  height: var(--yfe-size-status-dot);
  border: var(--yfe-size-focus-width) solid currentColor;
  border-top-color: transparent;
  border-radius: var(--yfe-radius-pill);
  animation: yfe-button-spin 0.8s linear infinite;
}

@keyframes yfe-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
