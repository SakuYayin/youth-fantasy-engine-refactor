<script setup lang="ts">
/**
 * 创作轨迹面板（tab.id = `trajectory`，分组 = 创作管理）。
 *
 * 按天时间线：把 `props.state.getSnapshot().documents`（未删的）按 `updatedAt`
 * 的 UTC 日期（`YYYY-MM-DD`）倒序分组，组内按更新时间倒序列条目
 * （标题 + 字数 + `HH:mm`）；顶部汇总卡：活跃天数 / 最近 7 天更新数 / 累计字数。
 * 分组与汇总逻辑在 `./trajectory-model.ts` 纯函数里，本组件只做渲染与接线。
 *
 * 统计口径：本项目没有写作会话历史（逐次快照 / 每日字数），轨迹只能从文档的
 * 更新时间戳推导——页首用 `TRAJECTORY_DISCLAIMER` 显式写明，绝不假装有逐次记录。
 *
 * 数据链说明：`AppSnapshot` 当前版本不声明 `documents`（Lead 侧字段，见
 * trajectory-model.ts 的 `readSnapshotDocuments`），读不到时面板显示
 * 「暂不可用」引导；Lead 透传后无需改本文件，自动显示真实轨迹。
 *
 * 本面板没有交互动作（无切页签 / 无编辑入口），只做展示与引导。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type { PanelProps } from './types.js'
import {
  EMPTY_HINT,
  SUMMARY_LABEL_ACTIVE,
  SUMMARY_LABEL_RECENT,
  SUMMARY_LABEL_TOTAL,
  TRAJECTORY_DISCLAIMER,
  UNIT_CHARS,
  UNIT_DAYS,
  UNIT_DOCS,
  UNAVAILABLE_HINT,
  buildTrajectoryView,
  formatCharCount,
  formatGroupCount,
  formatInvalidNote,
} from './trajectory-model.js'
import type { TrajectoryView } from './trajectory-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 `_placeholder.vue` / `worlds.vue` 同一口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

/**
 * 镜像状态机快照：`getSnapshot()` 返回普通对象（非响应式），computed 会永久缓存，
 * 所以订阅状态机、每次快照更新推一拍 tick 驱动重算（与 `worlds.vue` 同一套路）。
 */
const snapshotTick = ref(0)

let unsubscribe: (() => void) | null = null

const view = computed<TrajectoryView>(() => {
  void snapshotTick.value
  return buildTrajectoryView(props.state.getSnapshot())
})

onMounted(() => {
  unsubscribe = props.state.subscribe(() => {
    snapshotTick.value += 1
  })
})

onUnmounted(() => {
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
})

const activeDayValue = computed<string>(() => `${view.value.summary.activeDayCount} ${UNIT_DAYS}`)
const recentValue = computed<string>(() => `${view.value.summary.recentCount} ${UNIT_DOCS}`)
const totalValue = computed<string>(() => `${formatCharCount(view.value.summary.totalCharCount)} ${UNIT_CHARS}`)
</script>

<template>
  <section class="trajectory" data-testid="trajectory-panel" :data-tab-id="props.tab.id">
    <header class="trajectory__header">
      <h1 class="trajectory__title">{{ title }}</h1>
      <p class="trajectory__desc">{{ props.tab.description }}</p>
      <p class="trajectory__disclaimer" data-testid="trajectory-disclaimer">
        {{ TRAJECTORY_DISCLAIMER }}
      </p>
    </header>

    <div class="trajectory__summary" data-testid="trajectory-summary">
      <div class="trajectory__stat" data-testid="trajectory-stat-active">
        <span class="trajectory__stat-label">{{ SUMMARY_LABEL_ACTIVE }}</span>
        <span class="trajectory__stat-value">{{ activeDayValue }}</span>
      </div>
      <div class="trajectory__stat" data-testid="trajectory-stat-recent">
        <span class="trajectory__stat-label">{{ SUMMARY_LABEL_RECENT }}</span>
        <span class="trajectory__stat-value">{{ recentValue }}</span>
      </div>
      <div class="trajectory__stat" data-testid="trajectory-stat-total">
        <span class="trajectory__stat-label">{{ SUMMARY_LABEL_TOTAL }}</span>
        <span class="trajectory__stat-value">{{ totalValue }}</span>
      </div>
    </div>

    <p v-if="!view.available" class="trajectory__state" data-testid="trajectory-unavailable">
      {{ UNAVAILABLE_HINT }}
    </p>
    <p v-else-if="view.groups.length === 0" class="trajectory__state" data-testid="trajectory-empty">
      {{ EMPTY_HINT }}
    </p>
    <template v-else>
      <p
        v-if="view.malformedCount > 0"
        class="trajectory__state trajectory__state--muted"
        data-testid="trajectory-invalid-note"
      >
        {{ formatInvalidNote(view.malformedCount) }}
      </p>
      <ul class="trajectory__days" data-testid="trajectory-days">
        <li
          v-for="group in view.groups"
          :key="group.dayKey"
          class="trajectory__day"
          :data-testid="`trajectory-day-${group.dayKey}`"
        >
          <div class="trajectory__day-head">
            <span class="trajectory__day-label">{{ group.label }}</span>
            <span class="trajectory__day-count">{{ formatGroupCount(group.entries.length) }}</span>
          </div>
          <ul class="trajectory__entries">
            <li
              v-for="entry in group.entries"
              :key="entry.id"
              class="trajectory__entry"
              :data-testid="`trajectory-entry-${entry.id}`"
            >
              <span class="trajectory__entry-time">{{ entry.timeLabel }}</span>
              <span class="trajectory__entry-title">{{ entry.title }}</span>
              <span class="trajectory__entry-chars">
                {{ formatCharCount(entry.charCount) }} {{ UNIT_CHARS }}
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
/* 令牌名与 `@yfe/ui` 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.trajectory {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.trajectory__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.trajectory__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.trajectory__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__disclaimer {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--yfe-space-md, 12px);
}

.trajectory__stat {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.trajectory__stat-label {
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__stat-value {
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.trajectory__state {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.trajectory__state--muted {
  border-style: dashed;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__days {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
}

.trajectory__day {
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.trajectory__day-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
  padding-bottom: var(--yfe-space-sm, 8px);
  border-bottom: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
}

.trajectory__day-label {
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.trajectory__day-count {
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__entries {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.trajectory__entry {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-sm, 8px) 0;
}

.trajectory__entry + .trajectory__entry {
  border-top: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #3a3a3e);
}

.trajectory__entry-time {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.trajectory__entry-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--yfe-color-text, #e6e8ee);
}

.trajectory__entry-chars {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}
</style>
