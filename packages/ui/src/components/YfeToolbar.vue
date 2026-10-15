<script setup lang="ts">
/**
 * 工具条容器（ADR 0006 D3）。
 *
 * 契约里没有 props、没有 emits，也没有选中态——工具条内容全部由调用方通过默认
 * 插槽塞进来（写作页只保留高频编辑动作 + 一个 AI 入口，见 `02-桌面与界面.md`）。
 * 这里刻意**不加** `role="toolbar"`：ARIA 的 toolbar 要求方向键在子项间移动焦点，
 * 而键盘路由属于「谁放按钮谁说了算」，容器不该假装自己管得着。
 */
import { designTokenVariables } from '../tokens.js'
</script>

<template>
  <div class="yfe-toolbar" :style="designTokenVariables">
    <slot />
  </div>
</template>

<style scoped>
.yfe-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm);
  padding: var(--yfe-space-xs) var(--yfe-space-sm);
  border-bottom: var(--yfe-size-border-width) solid var(--yfe-color-border);
  background: var(--yfe-color-background);
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
  position: sticky;
  top: 0;
  z-index: var(--yfe-layer-sticky);
}
</style>
