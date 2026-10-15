<script setup lang="ts">
/**
 * 世界引擎面板（tab.id = `worlds`，分组 = 世界构建）。
 *
 * 世界观数据总览：挂载时 `await props.state.loadSettingsEntities()`（不传参数 =
 * 默认过滤：有当前作品 → 只列当前作品；没有 → 存储层按工作区列出），把实体按
 * `schemaTemplateId` 分组统计，每组渲染一张卡（模板名 / 条数 / 最近更新时间）。
 * 分组与汇总逻辑在 `./worlds-model.ts` 纯函数里。
 *
 * 本面板没有「切页签」能力（外壳未提供 onSelectTab 回调），所以卡片只做统计与
 * 引导「请到侧栏对应页签编辑」，不做任何编辑动作。数据链说明：渲染层
 * `SettingsEntityView` 暂未透传 `updatedAt`（视图契约缺口，见 worlds-model.ts），
 * 卡片的「最近更新」在今天显示「暂无更新时间」，Lead 透传后自动显示真实时间。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton } from '@yfe/ui'

import type { PanelProps } from './types.js'
import type { WorldEntityInput, WorldTemplateGroup, WorldSortKey } from './worlds-model.js'
import {
  WORLDS_PANEL_TEXT,
  formatUpdatedAt,
  groupEntitiesByTemplate,
  overviewLine,
} from './worlds-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 `_placeholder.vue` 同一口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

/** 镜像状态机的设定实体列表（本页与其余数据页签共用同一份快照）。 */
const entities = ref<readonly WorldEntityInput[]>([...props.state.getSnapshot().settingsEntities])
const loading = ref(false)
const loadedOnce = ref(false)
const loadFailed = ref(false)
const sortBy = ref<WorldSortKey>('count')

let unsubscribe: (() => void) | null = null
let disposed = false

function syncEntities(): void {
  entities.value = props.state.getSnapshot().settingsEntities
}

/** 重新拉取设定实体；失败不覆盖已有数据，只标 `loadFailed`。 */
async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const ok = await props.state.loadSettingsEntities()
    if (!disposed) {
      syncEntities()
      loadedOnce.value = true
      loadFailed.value = !ok
    }
  } finally {
    loading.value = false
  }
}

function toggleSort(): void {
  sortBy.value = sortBy.value === 'count' ? 'recent' : 'count'
}

onMounted(() => {
  unsubscribe = props.state.subscribe(syncEntities)
  void refresh()
})

onUnmounted(() => {
  disposed = true
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
})

const groups = computed<readonly WorldTemplateGroup[]>(() =>
  groupEntitiesByTemplate(entities.value, { sortBy: sortBy.value }),
)
const totalEntries = computed<number>(() =>
  groups.value.reduce((sum, group) => sum + group.summary.count, 0),
)
const overview = computed<string>(() => overviewLine(totalEntries.value, groups.value.length))
const sortButtonLabel = computed<string>(() =>
  sortBy.value === 'count' ? WORLDS_PANEL_TEXT.sortByRecent : WORLDS_PANEL_TEXT.sortByCount,
)
const refreshButtonLabel = computed<string>(() =>
  loading.value ? WORLDS_PANEL_TEXT.refreshing : WORLDS_PANEL_TEXT.refresh,
)
</script>

<template>
  <section class="worlds" data-testid="worlds-panel" :data-tab-id="props.tab.id">
    <header class="worlds__header">
      <h1 class="worlds__title">{{ title }}</h1>
      <p class="worlds__desc">{{ props.tab.description }}</p>
      <p class="worlds__intro" data-testid="worlds-intro">{{ WORLDS_PANEL_TEXT.intro }}</p>
    </header>

    <div class="worlds__toolbar" data-testid="worlds-toolbar">
      <span class="worlds__overview" data-testid="worlds-overview">{{ overview }}</span>
      <YfeButton
        :label="sortButtonLabel"
        variant="ghost"
        :disabled="loading"
        data-testid="worlds-sort-toggle"
        @click="toggleSort"
      />
      <YfeButton
        :label="refreshButtonLabel"
        variant="ghost"
        :loading="loading"
        data-testid="worlds-refresh"
        @click="refresh"
      />
    </div>

    <p
      v-if="!loadedOnce && loading"
      class="worlds__state"
      data-testid="worlds-loading"
    >
      {{ WORLDS_PANEL_TEXT.loading }}
    </p>
    <p
      v-else-if="loadFailed && totalEntries === 0"
      class="worlds__state worlds__state--error"
      data-testid="worlds-error"
    >
      {{ WORLDS_PANEL_TEXT.loadFailed }}
    </p>
    <p
      v-else-if="totalEntries === 0"
      class="worlds__state"
      data-testid="worlds-empty"
    >
      {{ WORLDS_PANEL_TEXT.emptyGuide }}
    </p>
    <template v-else>
      <p
        v-if="loadFailed && !loading"
        class="worlds__state worlds__state--error"
        data-testid="worlds-error"
      >
        {{ WORLDS_PANEL_TEXT.loadFailed }}
      </p>
      <ul class="worlds__cards" data-testid="worlds-cards">
        <li
          v-for="group in groups"
          :key="group.templateId"
          class="worlds__card"
          :data-testid="`worlds-card-${group.templateId}`"
        >
          <div class="worlds__card-head">
            <span class="worlds__card-name">{{ group.templateName }}</span>
            <span
              v-if="!group.known"
              class="worlds__card-badge"
              data-testid="worlds-card-unknown"
            >
              {{ WORLDS_PANEL_TEXT.unknownBadge }}
            </span>
            <span class="worlds__card-group">{{ group.group }}</span>
          </div>
          <div class="worlds__card-meta">
            <span class="worlds__card-count" data-testid="worlds-card-count">
              {{ group.summary.count }} {{ WORLDS_PANEL_TEXT.entryUnit }}
            </span>
            <span class="worlds__card-time" data-testid="worlds-card-time">
              {{ WORLDS_PANEL_TEXT.latestUpdatedAtLabel }}：{{ formatUpdatedAt(group.summary.latestUpdatedAt) }}
            </span>
          </div>
          <p class="worlds__card-hint" data-testid="worlds-card-hint">
            {{ WORLDS_PANEL_TEXT.editHint }}
          </p>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
/* 令牌名与 `@yfe/ui` 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.worlds {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.worlds__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.worlds__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.worlds__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.worlds__intro {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.worlds__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.worlds__overview {
  margin-right: auto;
}

.worlds__state {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.worlds__state--error {
  border-color: var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.worlds__cards {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--yfe-space-md, 12px);
}

.worlds__card {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.worlds__card-head {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-xs, 4px);
  flex-wrap: wrap;
}

.worlds__card-name {
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.worlds__card-badge {
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.worlds__card-group {
  margin-left: auto;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.worlds__card-meta {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-md, 12px);
  flex-wrap: wrap;
  color: var(--yfe-color-text, #e6e8ee);
}

.worlds__card-count {
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.worlds__card-time {
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.worlds__card-hint {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}
</style>
