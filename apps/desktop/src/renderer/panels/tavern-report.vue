<script setup lang="ts">
/**
 * tavern-report（聊天报告）—— 把酒馆对话整理成剧情摘要报告并归档。
 *
 * 布局：左列表、右表单 + 全文预览 + AI 生成（与 tavern-card 同口径）。
 * 数据经 `createPanelStore` 持久化（模板 `panel:tavern-report`，values = `{ items }`）；
 * AI 只走 `props.state.ai.complete()`：生成报告草稿回填表单，用户确认后手动保存进列表，
 * 解析失败只显示错误、不落库（任务书约定）。
 * 复制全文优先 navigator.clipboard，失败走 execCommand 兜底（渲染层 CSP 禁网）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { TavernReportRecord } from '../tavern/types.js'

import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'
import {
  TAVERN_REPORT_PANEL_TEXT,
  briefBody,
  buildAiReportRequest,
  copyReportText,
  copyViaExecCommand,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findReportById,
  formatCreatedAt,
  makeReport,
  overviewLine,
  panelSaveStatus,
  parseAiReport,
  removeReport,
  upsertReport,
  validateAiSource,
  validateReportForm,
} from './tavern-report-model.js'
import type { PanelSaveStatus, TavernReportPanelValues } from './tavern-report-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 tavern-card 同口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const store = createPanelStore<TavernReportPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

/** 报告列表（store.data 是 ShallowRef，整体替换后的镜像；坏数据兜底为空数组）。 */
const items = computed<readonly TavernReportRecord[]>(() => {
  const raw: unknown = store.data.value.items
  return Array.isArray(raw) ? (raw as readonly TavernReportRecord[]) : []
})

/** 选中报告（列表高亮 + 全文预览 + 编辑回灌 + 复制全文）。 */
const selectedId = ref<string | null>(null)
const selectedReport = computed<TavernReportRecord | null>(() =>
  findReportById(items.value, selectedId.value ?? ''),
)

/** 表单（create = 新建；edit = 编辑选中的报告）。 */
const formMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const formTitleText = ref('')
const formBody = ref('')
const formError = ref<string | null>(null)

/** 删除确认对话框。 */
const deleteOpen = ref(false)
const deleteTargetId = ref<string | null>(null)
const deleteTarget = computed<TavernReportRecord | null>(() =>
  findReportById(items.value, deleteTargetId.value ?? ''),
)
const deleteDialogTitle = computed<string>(() =>
  fillTemplate(TAVERN_REPORT_PANEL_TEXT.deleteTitle, { title: deleteTarget.value?.title ?? '' }),
)

/** 复制状态提示（成功 / 失败都如实显示）。 */
const copyMessage = ref<string | null>(null)

/** AI 生成状态（idle / generating / done / failed）与结果提示。 */
const aiState = ref<'idle' | 'generating' | 'done' | 'failed'>('idle')
const aiMessage = ref<string | null>(null)
const notConfigured = ref(false)
/** 粘贴的对话原文（AI 的输入）。 */
const aiSource = ref('')

const loading = computed<boolean>(() => store.loading.value)
const saving = computed<boolean>(() => store.saving.value)
const storeError = computed<string | null>(() => store.error.value)
const saveStatus = computed<PanelSaveStatus>(() =>
  panelSaveStatus(saving.value, store.dirty.value, storeError.value !== null),
)
const overview = computed<string>(() => overviewLine(items.value.length))
const formTitle = computed<string>(() =>
  formMode.value === 'edit'
    ? TAVERN_REPORT_PANEL_TEXT.editTitle
    : TAVERN_REPORT_PANEL_TEXT.formTitle,
)
const aiGenerating = computed<boolean>(() => aiState.value === 'generating')
const aiButtonLabel = computed<string>(() =>
  aiGenerating.value ? TAVERN_REPORT_PANEL_TEXT.aiGenerating : TAVERN_REPORT_PANEL_TEXT.aiGenerate,
)
/** 预览区元信息：创建时间（选中时才显示）。 */
const previewMeta = computed<string>(() => {
  const report = selectedReport.value
  if (report === null) return ''
  return `${TAVERN_REPORT_PANEL_TEXT.createdLabel}：${formatCreatedAt(report.createdAt)}`
})

let disposed = false

onMounted(() => {
  notConfigured.value = !props.state.ai.configured()
  void store.load()
})

onUnmounted(() => {
  disposed = true
  store.dispose()
})

function resetForm(): void {
  formMode.value = 'create'
  editingId.value = null
  formTitleText.value = ''
  formBody.value = ''
  formError.value = null
}

/** 「新建报告」：清空表单回到新建态。 */
function onNew(): void {
  resetForm()
}

/** 编辑回灌：选中报告 → 表单填值。 */
function fillForm(report: TavernReportRecord): void {
  formMode.value = 'edit'
  editingId.value = report.id
  formTitleText.value = report.title
  formBody.value = report.body
  formError.value = null
}

/** 点击列表报告：选中高亮 + 预览全文 + 回灌表单。 */
function selectReport(report: TavernReportRecord): void {
  selectedId.value = report.id
  copyMessage.value = null
  fillForm(report)
}

/** 点删除：先弹 YfeDialog 确认（tone = danger）。 */
function askDelete(report: TavernReportRecord): void {
  deleteTargetId.value = report.id
  deleteOpen.value = true
}

function onCancelDelete(): void {
  deleteOpen.value = false
  deleteTargetId.value = null
}

/** 确认删除：改 items → 显式保存；删的是正在编辑的报告时重置表单。 */
async function onConfirmDelete(): Promise<void> {
  deleteOpen.value = false
  const id = deleteTargetId.value
  deleteTargetId.value = null
  if (id === null) return
  store.set({ items: removeReport(items.value, id) })
  if (selectedId.value === id || editingId.value === id) {
    selectedId.value = null
    resetForm()
  }
  await store.save()
}

/** 保存报告：标题必填校验 → 新建或原位更新 → 显式保存（失败靠 store.error 显示）。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const titleError = validateReportForm({ title: formTitleText.value })
  if (titleError !== null) {
    formError.value = titleError
    return
  }
  formError.value = null
  const existing =
    formMode.value === 'edit' && editingId.value !== null
      ? findReportById(items.value, editingId.value)
      : null
  const report = makeReport({ title: formTitleText.value, body: formBody.value }, existing)
  store.set({ items: upsertReport(items.value, report) })
  selectedId.value = report.id
  await store.save()
}

let aiSequence = 0

/**
 * AI 生成报告草稿：未配置显示引导（按钮不禁用）；粘贴内容为空提示先填。
 * 成功只回填表单（title + body），用户确认后手动点「保存到列表」进列表；
 * 解析失败显示错误、不落库（任务书约定）。
 * AiPort 没有 abort：取消 = 丢弃迟到结果（序号守卫）。
 */
async function onAiGenerate(): Promise<void> {
  if (aiState.value === 'generating') return
  if (!props.state.ai.configured()) {
    notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = TAVERN_REPORT_PANEL_TEXT.notConfigured
    return
  }
  const source = validateAiSource(aiSource.value)
  if (source === null) {
    aiState.value = 'failed'
    aiMessage.value = TAVERN_REPORT_PANEL_TEXT.aiEmptySource
    return
  }
  notConfigured.value = false
  aiMessage.value = null
  const sequence = ++aiSequence
  aiState.value = 'generating'
  const request = buildAiReportRequest(source)
  let result: AiResult
  try {
    result = await props.state.ai.complete(request)
  } catch (thrown) {
    // AiPort 契约不抛；这里只是防御性兜底（实现故障时不白屏）。
    if (sequence !== aiSequence || disposed) return
    aiState.value = 'failed'
    aiMessage.value = fillTemplate(TAVERN_REPORT_PANEL_TEXT.aiFailure, {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    })
    return
  }
  if (sequence !== aiSequence || disposed) return
  if (!result.ok) {
    aiState.value = 'failed'
    if (result.code === 'AI_NOT_CONFIGURED') notConfigured.value = true
    aiMessage.value = failureNotice(result.code, result.message)
    return
  }
  const draft = parseAiReport(result.text)
  if (draft === null) {
    // 解析失败：显示错误、不落库（任务书约定）。
    aiState.value = 'failed'
    aiMessage.value = TAVERN_REPORT_PANEL_TEXT.aiParseFailed
    return
  }
  // 只回填表单、不落库：用户确认标题与正文后手动保存。
  formMode.value = 'create'
  editingId.value = null
  formTitleText.value = draft.title
  formBody.value = draft.body
  formError.value = null
  aiState.value = 'done'
  aiMessage.value = TAVERN_REPORT_PANEL_TEXT.aiDone
}

/** 复制全文：剪贴板优先，失败走 execCommand 兜底；结果如实提示。 */
async function onCopy(): Promise<void> {
  const report = selectedReport.value
  if (report === null) return
  const body = report.body
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  const error = await copyReportText(body, clipboard, () => copyViaExecCommand(document, body))
  copyMessage.value = error ?? TAVERN_REPORT_PANEL_TEXT.copyDone
}
</script>

<template>
  <section class="tavern-report" data-testid="tavern-report-panel" :data-tab-id="props.tab.id">
    <header class="tavern-report__header">
      <h1 class="tavern-report__title">{{ title }}</h1>
      <p class="tavern-report__desc">{{ props.tab.description }}</p>
      <p class="tavern-report__intro" data-testid="tavern-report-intro">
        {{ TAVERN_REPORT_PANEL_TEXT.intro }}
      </p>
    </header>

    <div class="tavern-report__toolbar" data-testid="tavern-report-toolbar">
      <span class="tavern-report__overview" data-testid="tavern-report-overview">{{ overview }}</span>
      <YfeStatusPill :status="saveStatus" data-testid="tavern-report-save-status" />
      <YfeButton
        variant="ghost"
        :label="TAVERN_REPORT_PANEL_TEXT.newReport"
        data-testid="tavern-report-new"
        @click="onNew"
      />
    </div>

    <p
      v-if="notConfigured"
      class="tavern-report__notice tavern-report__notice--warn"
      data-testid="tavern-report-unconfigured"
    >
      {{ TAVERN_REPORT_PANEL_TEXT.notConfigured }}
    </p>
    <p
      v-if="storeError !== null"
      class="tavern-report__notice tavern-report__notice--error"
      data-testid="tavern-report-error"
    >
      {{ storeError }}
    </p>
    <p v-if="aiMessage !== null" class="tavern-report__notice" data-testid="tavern-report-ai-message">
      {{ aiMessage }}
    </p>
    <p
      v-if="copyMessage !== null"
      class="tavern-report__notice"
      data-testid="tavern-report-copy-message"
    >
      {{ copyMessage }}
    </p>
    <p
      v-if="formError !== null"
      class="tavern-report__notice tavern-report__notice--error"
      data-testid="tavern-report-form-error"
    >
      {{ formError }}
    </p>

    <div class="tavern-report__body">
      <section class="tavern-report__pane">
        <h2 class="tavern-report__pane-title" data-testid="tavern-report-list-title">
          {{ TAVERN_REPORT_PANEL_TEXT.listTitle }}
        </h2>
        <p class="tavern-report__pane-hint">{{ TAVERN_REPORT_PANEL_TEXT.listHint }}</p>

        <p v-if="loading" class="tavern-report__state" data-testid="tavern-report-loading">
          {{ TAVERN_REPORT_PANEL_TEXT.loading }}
        </p>
        <p v-else-if="items.length === 0" class="tavern-report__state" data-testid="tavern-report-empty">
          {{ TAVERN_REPORT_PANEL_TEXT.empty }}
        </p>
        <ul v-else class="tavern-report__list" data-testid="tavern-report-list">
          <li
            v-for="report in items"
            :key="report.id"
            class="tavern-report__item"
            :class="{ 'tavern-report__item--selected': report.id === selectedId }"
            :data-testid="`tavern-report-item-${report.id}`"
            @click="selectReport(report)"
          >
            <div class="tavern-report__item-head">
              <span class="tavern-report__item-name" data-testid="tavern-report-item-name">
                {{ report.title }}
              </span>
              <YfeButton
                variant="danger"
                :label="TAVERN_REPORT_PANEL_TEXT.delete"
                data-testid="tavern-report-item-delete"
                @click.stop="askDelete(report)"
              />
            </div>
            <p class="tavern-report__item-time" data-testid="tavern-report-item-time">
              {{ TAVERN_REPORT_PANEL_TEXT.createdLabel }}：{{ formatCreatedAt(report.createdAt) }}
            </p>
            <p class="tavern-report__item-brief" data-testid="tavern-report-item-brief">
              {{ briefBody(report.body) }}
            </p>
          </li>
        </ul>
      </section>

      <section class="tavern-report__pane">
        <h2 class="tavern-report__pane-title" data-testid="tavern-report-form-title">{{ formTitle }}</h2>
        <p class="tavern-report__pane-hint" data-testid="tavern-report-manual-entry">
          {{ TAVERN_REPORT_PANEL_TEXT.manualEntry }}
        </p>

        <div class="tavern-report__form" data-testid="tavern-report-form">
          <label class="tavern-report__field">
            <span class="tavern-report__label">{{ TAVERN_REPORT_PANEL_TEXT.fieldTitle }}</span>
            <input
              v-model="formTitleText"
              class="tavern-report__input"
              type="text"
              :placeholder="TAVERN_REPORT_PANEL_TEXT.titlePlaceholder"
              data-testid="tavern-report-title"
            />
          </label>
          <label class="tavern-report__field">
            <span class="tavern-report__label">{{ TAVERN_REPORT_PANEL_TEXT.fieldBody }}</span>
            <textarea
              v-model="formBody"
              class="tavern-report__input tavern-report__input--area"
              :placeholder="TAVERN_REPORT_PANEL_TEXT.bodyPlaceholder"
              rows="6"
              data-testid="tavern-report-body"
            />
          </label>
          <div class="tavern-report__actions">
            <YfeButton
              variant="primary"
              :label="TAVERN_REPORT_PANEL_TEXT.save"
              :disabled="saving"
              :loading="saving"
              data-testid="tavern-report-save"
              @click="onSave"
            />
            <YfeButton
              v-if="formMode === 'edit'"
              variant="ghost"
              :label="TAVERN_REPORT_PANEL_TEXT.cancelEdit"
              data-testid="tavern-report-cancel-edit"
              @click="resetForm"
            />
          </div>
        </div>

        <section class="tavern-report__preview" data-testid="tavern-report-preview">
          <h3 class="tavern-report__preview-title" data-testid="tavern-report-preview-title">
            {{ TAVERN_REPORT_PANEL_TEXT.previewTitle }}
          </h3>
          <p
            v-if="previewMeta !== ''"
            class="tavern-report__preview-meta"
            data-testid="tavern-report-preview-meta"
          >
            {{ previewMeta }}
          </p>
          <p
            v-if="selectedReport === null"
            class="tavern-report__state"
            data-testid="tavern-report-preview-empty"
          >
            {{ TAVERN_REPORT_PANEL_TEXT.previewEmpty }}
          </p>
          <pre v-else class="tavern-report__preview-body" data-testid="tavern-report-preview-body">{{ selectedReport.body }}</pre>
          <YfeButton
            v-if="selectedReport !== null"
            variant="ghost"
            :label="TAVERN_REPORT_PANEL_TEXT.copy"
            data-testid="tavern-report-copy"
            @click="onCopy"
          />
        </section>

        <section class="tavern-report__ai" data-testid="tavern-report-ai">
          <h3 class="tavern-report__ai-title" data-testid="tavern-report-ai-title">
            {{ TAVERN_REPORT_PANEL_TEXT.aiSectionTitle }}
          </h3>
          <label class="tavern-report__field">
            <span class="tavern-report__label">{{ TAVERN_REPORT_PANEL_TEXT.aiInputLabel }}</span>
            <textarea
              v-model="aiSource"
              class="tavern-report__input tavern-report__input--area"
              :placeholder="TAVERN_REPORT_PANEL_TEXT.aiInputPlaceholder"
              rows="4"
              data-testid="tavern-report-ai-source"
            />
          </label>
          <YfeButton
            variant="ghost"
            :label="aiButtonLabel"
            :disabled="aiGenerating"
            :loading="aiGenerating"
            data-testid="tavern-report-ai-generate"
            @click="onAiGenerate"
          />
        </section>
      </section>
    </div>

    <YfeDialog
      :open="deleteOpen"
      :title="deleteDialogTitle"
      :confirm-label="TAVERN_REPORT_PANEL_TEXT.confirmDelete"
      :cancel-label="TAVERN_REPORT_PANEL_TEXT.cancelDelete"
      tone="danger"
      data-testid="tavern-report-delete-dialog"
      @confirm="onConfirmDelete"
      @cancel="onCancelDelete"
    />
  </section>
</template>

<style scoped>
/* 令牌名与 @yfe/ui 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.tavern-report {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-report__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-report__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-report__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__intro {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-report__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__overview {
  margin-right: auto;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-report__notice--warn {
  border-color: var(--yfe-color-warning, #fbbf24);
  color: var(--yfe-color-warning, #fbbf24);
}

.tavern-report__notice--error {
  border-color: var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.tavern-report__body {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.4fr);
  gap: var(--yfe-space-lg, 16px);
  align-items: start;
}

.tavern-report__pane {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-report__pane-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-report__pane-hint {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__state {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-report__item {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #26262b);
  cursor: pointer;
}

.tavern-report__item--selected {
  border-color: var(--yfe-color-primary, #8b5cf6);
}

.tavern-report__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-report__item-name {
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-report__item-time {
  margin: var(--yfe-space-xs, 4px) 0 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__item-brief {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-report__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-report__label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__input {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
  font: inherit;
}

.tavern-report__input--area {
  resize: vertical;
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-report__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-report__preview {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
}

.tavern-report__preview-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.tavern-report__preview-meta {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-report__preview-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
}

.tavern-report__ai {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
}

.tavern-report__ai-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

@media (max-width: 720px) {
  .tavern-report__body {
    grid-template-columns: 1fr;
  }
}
</style>
