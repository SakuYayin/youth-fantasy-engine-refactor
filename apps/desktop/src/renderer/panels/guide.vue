<script setup lang="ts">
/**
 * 「使用指南」面板（tab.id = `guide`，分组 = 工作面板）。
 *
 * 静态指南页：一节页首引言 + 若干结构化小节，全部文案来自
 * `./guide-content.js` 的常量（接口冻结 §2：组件内不写死大段静态文案）。
 * 本页没有数据依赖：不发请求、不读 `props.state`（仅按契约保留），
 * 也不存在「数据为空」路径——常量在编译期就保证非空。
 */
import { YfePanel } from '@yfe/ui'

import { GUIDE_INTRO, GUIDE_SECTIONS } from './guide-content.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 `_placeholder.vue` 同一口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id
</script>

<template>
  <section class="guide" data-testid="guide-panel" :data-tab-id="props.tab.id">
    <header class="guide__header">
      <h1 class="guide__title">{{ title }}</h1>
      <p class="guide__desc">{{ props.tab.description }}</p>
      <p
        v-for="(line, index) in GUIDE_INTRO"
        :key="`intro-${index}`"
        class="guide__intro"
        data-testid="guide-intro"
      >
        {{ line }}
      </p>
    </header>
    <YfePanel
      v-for="section in GUIDE_SECTIONS"
      :key="section.id"
      :title="section.title"
      class="guide__section"
      :data-testid="`guide-section-${section.id}`"
    >
      <ol class="guide__list">
        <li
          v-for="(item, index) in section.items"
          :key="`${section.id}-${index}`"
          class="guide__item"
          :data-testid="`guide-item-${section.id}`"
        >
          {{ item }}
        </li>
      </ol>
    </YfePanel>
  </section>
</template>

<style scoped>
/* 令牌名与 `@yfe/ui` 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.guide__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.guide__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.guide__intro {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__section {
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__list {
  margin: 0;
  padding-inline-start: var(--yfe-space-lg, 16px);
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.guide__item {
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}
</style>
