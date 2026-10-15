<script setup lang="ts">
/**
 * 可折叠面板（ADR 0006 D3 + `02-桌面与界面.md` 的可折叠资料/AI 面板）。
 *
 * 折叠状态**不在组件里**：`YfePanel` 自己记 `collapsed` 会和「写作页要记住上次
 * 收起状态」的持久化打架，所以这里只负责 `dense` 与标题渲染，折叠由外层决定
 * （不需要时干脆不渲染）。
 */
import { computed } from 'vue'

import { designTokenVariables, designTokens } from '../tokens.js'

const props = defineProps<{
  title?: string
  dense?: boolean
}>()

/**
 * `dense` 只改内边距，但内侧值必须来自令牌：`--yfe-panel-padding` 是面板内部
 * 唯一的间距出口，标题/正文都读它，所以密度切换是一处生效。
 */
const panelStyle = computed<Record<string, string>>(() => ({
  ...designTokenVariables,
  '--yfe-panel-padding': props.dense === true ? designTokens.space.sm : designTokens.space.md,
}))
</script>

<template>
  <section
    class="yfe-panel"
    :class="{ 'yfe-panel--dense': dense === true }"
    :style="panelStyle"
  >
    <header v-if="title !== undefined && title !== ''" class="yfe-panel__header">
      <h2 class="yfe-panel__title">{{ title }}</h2>
    </header>
    <div class="yfe-panel__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.yfe-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-md);
  background: var(--yfe-color-surface);
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
}

.yfe-panel__header {
  flex: none;
  padding: var(--yfe-space-sm) var(--yfe-panel-padding);
  border-bottom: var(--yfe-size-border-width) solid var(--yfe-color-border);
}

.yfe-panel__title {
  margin: 0;
  font-size: var(--yfe-font-size-sm);
  font-weight: var(--yfe-font-weight-bold);
  letter-spacing: 0.04em;
  color: var(--yfe-color-text-muted);
}

.yfe-panel__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--yfe-panel-padding);
}
</style>
