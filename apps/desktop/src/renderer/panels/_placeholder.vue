<script setup lang="ts">
/**
 * 未实现面板的占位组件。
 *
 * 用户统一验收时必须能一眼看出「哪些还没做」，所以这里明确写出页签名与状态，
 * 而不是渲染空白区域（静默空白会被误当成"功能坏了"）。
 */

import type { TabDef } from '@yfe/schema-tabs'

import type { AppState } from '../app-state.js'

const props = defineProps<{
  readonly state: AppState
  readonly tab: TabDef
}>()

const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id
</script>

<template>
  <section class="panel-placeholder" data-testid="panel-placeholder">
    <h2 class="panel-placeholder__title">{{ title }}</h2>
    <p class="panel-placeholder__desc">{{ props.tab.description }}</p>
    <p class="panel-placeholder__state">
      该面板正在按旧版行为重构（W7 批次），当前版本尚未接入。
    </p>
    <p class="panel-placeholder__hint">页签 ID：<code>{{ props.tab.id }}</code>（类型 {{ props.tab.type }}）</p>
  </section>
</template>

<style scoped>
.panel-placeholder {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e8e8ea);
}

.panel-placeholder__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.panel-placeholder__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0a6);
  line-height: 1.6;
}

.panel-placeholder__state {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: 1px solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.panel-placeholder__hint {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0a6);
  font-size: 12px;
}
</style>
