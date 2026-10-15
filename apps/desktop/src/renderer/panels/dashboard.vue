<script setup lang="ts">
/**
 * dashboard（写作面板）：写作统计总览 + 写作目标。
 *
 * 统计与解析逻辑全部在 dashboard-model.ts（纯函数）；本组件只渲染与调用。
 * 数据来自 `props.state.getSnapshot().documents`（订阅刷新），写作目标经
 * `createPanelStore` 持久化（panel:<tab.id>，面板卸载时 dispose）。
 * 本版本没有每日历史数据：进度口径是「当前作品总字数 vs 每日目标」，
 * 口径说明常年在界面上展示（DASHBOARD_COPY.goalNote）。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import { YfeButton, YfePanel, YfeStatusPill } from '@yfe/ui'

import type { DocumentSummary } from '@yfe/contracts'

import {
  DEFAULT_DAILY_GOAL,
  DASHBOARD_COPY,
  computeDashboardStats,
  formatChars,
  formatUpdatedAt,
  goalSaveStatus,
  parseGoalInput,
  progressLine,
  progressOf,
  readDocuments,
} from './dashboard-model.js'
import type { DashboardStats, GoalProgress, GoalSaveStatus } from './dashboard-model.js'
import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

const snapshot = shallowRef(props.state.getSnapshot())
const unsubscribe = props.state.subscribe((next) => {
  snapshot.value = next
})

const store = createPanelStore<{ dailyGoal: number }>(props.state, props.tab.id, {
  dailyGoal: DEFAULT_DAILY_GOAL,
})

const snapshotLoading = computed<boolean>(() => snapshot.value.loading)
const documents = computed<readonly DocumentSummary[]>(() => readDocuments(snapshot.value))
const stats = computed<DashboardStats>(() => computeDashboardStats(documents.value))
const hasWorks = computed<boolean>(() => documents.value.length > 0)

const goalValue = computed<number>(() => store.data.value.dailyGoal)
const progress = computed<GoalProgress>(() => progressOf(stats.value.totalChars, goalValue.value))
const goalSaving = computed<boolean>(() => store.saving.value)
const goalStatus = computed<GoalSaveStatus>(() =>
  goalSaveStatus(store.saving.value, store.dirty.value, store.error.value !== null),
)
const goalError = computed<string | null>(() => store.error.value)

const goalInput = ref<string>('')
const goalHint = ref<string | null>(null)

onMounted(() => {
  goalInput.value = String(store.data.value.dailyGoal)
  void store.load()
})

watch(
  () => store.loading.value,
  (loading, previous) => {
    // 载入结束后用库里的目标回显输入框；本地已有未保存修改时不覆盖用户输入。
    if (previous === true && loading === false && store.dirty.value !== true) {
      goalInput.value = String(store.data.value.dailyGoal)
    }
  },
)

function onGoalInput(event: Event): void {
  const raw = event.target instanceof HTMLInputElement ? event.target.value : ''
  // 先同步本地镜像：保存失败等状态变化触发重渲染时，:value 绑定不能把旧值回写进输入框。
  goalInput.value = raw
  const parsed = parseGoalInput(raw)
  if (parsed === null) {
    goalHint.value = DASHBOARD_COPY.hintInvalidGoal
    return
  }
  goalHint.value = null
  store.patch({ dailyGoal: parsed })
}

function saveGoal(): void {
  void store.save()
}

onUnmounted(() => {
  unsubscribe()
  store.dispose()
})
</script>

<template>
  <section class="dashboard-panel" data-testid="dashboard-panel">
    <header class="dashboard-panel__header">
      <h2 class="dashboard-panel__title">{{ tab.name }}</h2>
      <p class="dashboard-panel__subtitle">{{ DASHBOARD_COPY.subtitle }}</p>
    </header>

    <p
      v-if="documents.length === 0 && snapshotLoading"
      class="dashboard-panel__empty"
      data-testid="dashboard-loading"
    >
      {{ DASHBOARD_COPY.loadingWorks }}
    </p>
    <p
      v-else-if="!hasWorks"
      class="dashboard-panel__empty"
      data-testid="dashboard-empty"
    >
      {{ DASHBOARD_COPY.emptyNoWorks }}
    </p>
    <template v-else>
      <dl class="dashboard-panel__stats" data-testid="dashboard-stats">
        <div class="dashboard-panel__stat" data-testid="dashboard-stat-projects">
          <dt>{{ DASHBOARD_COPY.statProjects }}</dt>
          <dd>{{ formatChars(stats.projectCount) }}</dd>
        </div>
        <div class="dashboard-panel__stat" data-testid="dashboard-stat-chapters">
          <dt>{{ DASHBOARD_COPY.statChapters }}</dt>
          <dd>{{ formatChars(stats.chapterCount) }}</dd>
        </div>
        <div class="dashboard-panel__stat" data-testid="dashboard-stat-chars">
          <dt>{{ DASHBOARD_COPY.statChars }}</dt>
          <dd>{{ formatChars(stats.totalChars) }}</dd>
        </div>
        <div class="dashboard-panel__stat" data-testid="dashboard-stat-updated">
          <dt>{{ DASHBOARD_COPY.statUpdated }}</dt>
          <dd>{{ formatUpdatedAt(stats.lastUpdatedAt) }}</dd>
        </div>
      </dl>

      <YfePanel :title="DASHBOARD_COPY.topTitle" dense>
        <ol
          v-if="stats.topChapters.length > 0"
          class="dashboard-top"
          data-testid="dashboard-top-list"
        >
          <li
            v-for="(item, index) in stats.topChapters"
            :key="index"
            class="dashboard-top__item"
          >
            <span class="dashboard-top__rank">{{ index + 1 }}</span>
            <span class="dashboard-top__title">{{ item.title }}</span>
            <span class="dashboard-top__chars">
              {{ formatChars(item.charCount) }} {{ DASHBOARD_COPY.topUnit }}
            </span>
          </li>
        </ol>
        <p v-else class="dashboard-panel__empty" data-testid="dashboard-top-empty">
          {{ DASHBOARD_COPY.emptyNoChapters }}
        </p>
      </YfePanel>

      <YfePanel :title="DASHBOARD_COPY.goalTitle">
        <div class="dashboard-goal__row">
          <label class="dashboard-goal__label">
            <span>{{ DASHBOARD_COPY.goalLabel }}</span>
            <input
              class="dashboard-goal__input"
              data-testid="dashboard-goal-input"
              :value="goalInput"
              inputmode="numeric"
              @input="onGoalInput"
            />
          </label>
          <YfeButton
            :label="DASHBOARD_COPY.goalSave"
            :disabled="goalSaving"
            data-testid="dashboard-goal-save"
            @click="saveGoal"
          />
          <YfeStatusPill :status="goalStatus" data-testid="dashboard-goal-status" />
        </div>
        <p
          v-if="goalHint !== null"
          class="dashboard-goal__hint"
          data-testid="dashboard-goal-hint"
        >
          {{ goalHint }}
        </p>
        <p
          v-if="goalError !== null"
          class="dashboard-goal__error"
          data-testid="dashboard-goal-error"
        >
          {{ goalError }}
        </p>
        <div
          class="dashboard-goal__bar"
          role="progressbar"
          :aria-valuenow="progress.percent"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="DASHBOARD_COPY.goalTitle"
          data-testid="dashboard-goal-bar"
        >
          <div
            class="dashboard-goal__fill"
            :style="{ width: `${progress.percent}%` }"
            data-testid="dashboard-goal-fill"
          />
        </div>
        <p class="dashboard-goal__line" data-testid="dashboard-goal-progress">
          {{ progressLine(progress) }}
        </p>
        <p class="dashboard-goal__note" data-testid="dashboard-goal-note">
          {{ DASHBOARD_COPY.goalNote }}
        </p>
      </YfePanel>
    </template>
  </section>
</template>

<style scoped>
.dashboard-panel {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  color: var(--yfe-color-text, #e8e8ea);
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.6;
}

.dashboard-panel__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.dashboard-panel__title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 15px);
  font-weight: 600;
}

.dashboard-panel__subtitle {
  margin: 0;
  color: var(--yfe-color-text-muted, #9aa0a6);
}

.dashboard-panel__empty {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: 1px dashed var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-text-muted, #9aa0a6);
}

.dashboard-panel__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
}

.dashboard-panel__stat {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  background: var(--yfe-color-surface, #1e1e21);
  border: 1px solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
}

.dashboard-panel__stat dt {
  color: var(--yfe-color-text-muted, #9aa0a6);
}

.dashboard-panel__stat dd {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 18px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.dashboard-top {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.dashboard-top__item {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-sm, 8px);
}

.dashboard-top__rank {
  min-width: 1.5em;
  color: var(--yfe-color-text-muted, #9aa0a6);
  font-variant-numeric: tabular-nums;
}

.dashboard-top__title {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard-top__chars {
  color: var(--yfe-color-text-muted, #9aa0a6);
  font-variant-numeric: tabular-nums;
}

.dashboard-goal__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.dashboard-goal__label {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.dashboard-goal__input {
  width: 6em;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text, #e8e8ea);
  background: var(--yfe-color-surface, #1e1e21);
  border: 1px solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
}

.dashboard-goal__hint {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-warning, #d9a441);
}

.dashboard-goal__error {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-danger, #e06c6c);
}

.dashboard-goal__bar {
  height: 8px;
  margin-top: var(--yfe-space-sm, 8px);
  overflow: hidden;
  background: var(--yfe-color-surface, #1e1e21);
  border: 1px solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
}

.dashboard-goal__fill {
  height: 100%;
  background: var(--yfe-color-accent, #4f8cff);
}

.dashboard-goal__line {
  margin: var(--yfe-space-xs, 4px) 0 0;
}

.dashboard-goal__note {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #9aa0a6);
  font-size: var(--yfe-font-size-xs, 12px);
}
</style>
