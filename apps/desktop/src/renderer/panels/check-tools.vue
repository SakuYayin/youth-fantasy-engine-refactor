<script setup lang="ts">
/**
 * 面板：检查工具（check-tools）—— 视图层。
 *
 * 职责：正文粘贴/输入 + 「开始检查」按钮 + 问题列表展示（分严重度、带汇总）。
 * 纪律：本面板为预览版纯本地检查，不调用 AI；不订阅全局 state（检查输入不持久化、无历史记录）；
 *       所有可见文案来自 check-tools-model.ts 导出的常量或 tab 元数据。
 */
import { computed, ref } from 'vue';
import { YfeButton, YfePanel } from '@yfe/ui';
import type { PanelProps } from './types';
import {
  BUTTON_CLEAR,
  BUTTON_RUN,
  DISCLAIMER,
  EMPTY_RESULT_LABEL,
  INITIAL_HINT,
  NO_PERSIST_NOTE,
  PANEL_INPUT_TITLE,
  PANEL_RESULT_TITLE,
  TEXTAREA_PLACEHOLDER,
  buildCheckSummary,
  checkText,
  formatIssueSummary,
  formatSeverityHeader,
} from './check-tools-model';
import type { CheckIssue } from './check-tools-model';

const props = defineProps<PanelProps>();

/** 检查输入（仅保存在当前页面，不写回 state、不持久化）。 */
const input = ref('');
/** 检查结果；null 表示尚未运行过检查。 */
const result = ref<readonly CheckIssue[] | null>(null);

const panelTitle = computed(() => (props.tab.name.length > 0 ? props.tab.name : props.tab.id));
const issues = computed<readonly CheckIssue[]>(() => result.value ?? []);
const warnIssues = computed(() => issues.value.filter((issue) => issue.severity === 'warn'));
const infoIssues = computed(() => issues.value.filter((issue) => issue.severity === 'info'));
const summary = computed(() => buildCheckSummary(issues.value));
const summaryText = computed(() =>
  formatIssueSummary(summary.value.total, summary.value.warn, summary.value.info),
);
const hasRun = computed(() => result.value !== null);

function run(): void {
  result.value = checkText(input.value);
}

function clear(): void {
  input.value = '';
  result.value = null;
}
</script>

<template>
  <section class="check-tools" data-testid="check-tools-panel" :data-tab-id="props.tab.id">
    <header class="check-tools__header">
      <h1 class="check-tools__title">{{ panelTitle }}</h1>
      <p class="check-tools__description">{{ props.tab.description }}</p>
      <p class="check-tools__note">{{ DISCLAIMER }}</p>
      <p class="check-tools__note">{{ NO_PERSIST_NOTE }}</p>
    </header>

    <YfePanel class="check-tools__panel" :title="PANEL_INPUT_TITLE" dense>
      <textarea
        v-model="input"
        class="check-tools__textarea"
        :placeholder="TEXTAREA_PLACEHOLDER"
        :aria-label="PANEL_INPUT_TITLE"
        data-testid="check-tools-input"
        rows="8"
      ></textarea>
      <div class="check-tools__actions">
        <YfeButton
          class="check-tools__run"
          :label="BUTTON_RUN"
          variant="primary"
          data-testid="check-tools-run"
          @click="run"
        />
        <YfeButton
          class="check-tools__clear"
          :label="BUTTON_CLEAR"
          variant="ghost"
          data-testid="check-tools-clear"
          @click="clear"
        />
      </div>
    </YfePanel>

    <YfePanel class="check-tools__panel" :title="PANEL_RESULT_TITLE" dense>
      <p v-if="!hasRun" class="check-tools__initial" data-testid="check-tools-initial">
        {{ INITIAL_HINT }}
      </p>
      <template v-else>
        <p
          v-if="issues.length === 0"
          class="check-tools__empty"
          role="status"
          data-testid="check-tools-empty"
        >
          {{ EMPTY_RESULT_LABEL }}
        </p>
        <template v-else>
          <p class="check-tools__summary" role="status" data-testid="check-tools-summary">
            {{ summaryText }}
          </p>
          <section
            v-if="warnIssues.length > 0"
            class="check-tools__group"
            data-testid="check-tools-warn-group"
          >
            <h3 class="check-tools__group-title">
              {{ formatSeverityHeader('warn', warnIssues.length) }}
            </h3>
            <ul class="check-tools__list">
              <li
                v-for="issue in warnIssues"
                :key="issue.id"
                class="check-tools__item"
                :data-severity="issue.severity"
              >
                <span class="check-tools__dot check-tools__dot--warn" aria-hidden="true"></span>
                <span class="check-tools__item-text">
                  <span class="check-tools__item-title" data-testid="check-tools-issue-title">{{ issue.title }}</span>
                  <span class="check-tools__item-detail" data-testid="check-tools-issue-detail">{{ issue.detail }}</span>
                </span>
              </li>
            </ul>
          </section>
          <section
            v-if="infoIssues.length > 0"
            class="check-tools__group"
            data-testid="check-tools-info-group"
          >
            <h3 class="check-tools__group-title">
              {{ formatSeverityHeader('info', infoIssues.length) }}
            </h3>
            <ul class="check-tools__list">
              <li
                v-for="issue in infoIssues"
                :key="issue.id"
                class="check-tools__item"
                :data-severity="issue.severity"
              >
                <span class="check-tools__dot check-tools__dot--info" aria-hidden="true"></span>
                <span class="check-tools__item-text">
                  <span class="check-tools__item-title" data-testid="check-tools-issue-title">{{ issue.title }}</span>
                  <span class="check-tools__item-detail" data-testid="check-tools-issue-detail">{{ issue.detail }}</span>
                </span>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </YfePanel>
  </section>
</template>

<style scoped>
.check-tools {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
}

.check-tools__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.check-tools__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.check-tools__description {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.check-tools__note {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.check-tools__textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 160px;
  resize: vertical;
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.check-tools__actions {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
  margin-top: var(--yfe-space-md, 12px);
}

.check-tools__initial,
.check-tools__empty {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.check-tools__summary {
  margin: 0 0 var(--yfe-space-md, 12px);
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.check-tools__group {
  margin: 0 0 var(--yfe-space-md, 12px);
}

.check-tools__group-title {
  margin: 0 0 var(--yfe-space-sm, 8px);
  font-size: var(--yfe-font-size-sm, 12px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.check-tools__list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-tools__item {
  display: flex;
  align-items: flex-start;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
}

.check-tools__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: var(--yfe-radius-pill, 999px);
}

.check-tools__dot--warn {
  background: var(--yfe-color-warning, #e8b96b);
}

.check-tools__dot--info {
  background: var(--yfe-color-text-muted, #8b93a7);
}

.check-tools__item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.check-tools__item-title {
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.check-tools__item-detail {
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}
</style>
