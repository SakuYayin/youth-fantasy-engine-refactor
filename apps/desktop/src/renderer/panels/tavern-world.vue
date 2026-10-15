<script setup lang="ts">
/**
 * 背景设定面板（tavern-world）：世界书条目管理（W7）。
 *
 * 启用条目的关键词会在 AI 对话时按命中注入系统提示词——拼接逻辑在
 * `src/renderer/tavern/types.ts` 的 `buildTavernSystemPrompt`（对话面板消费），
 * 本面板负责条目本身的增删改与启用切换。
 *
 * 数据走 Lead 的 `createPanelStore`（模板 `panel:tavern-world`，autoSaveMs 0 =
 * 离散动作后显式 save，与 tavern-card 同口径，避免无作品时反复自动保存报错）；
 * AI 扩写只走 `props.state.ai.complete`（渲染层不发请求），替换前 YfeDialog 确认。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { TavernWorldEntry } from '../tavern/types.js'
import { tavernNow } from '../tavern/types.js'
import { createPanelStore } from './panel-store.js'
import {
  TAVERN_WORLD_PANEL_TEXT as TEXT,
  briefContent,
  buildAiExpandRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findEntryById,
  makeEntry,
  normalizeEntries,
  overviewLine,
  panelSaveStatus,
  parseAiExpanded,
  removeEntry,
  toggleEntryEnabled,
  upsertEntry,
  validateEntryForm,
} from './tavern-world-model.js'
import type { TavernWorldPanelValues } from './tavern-world-model.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

const title = computed<string>(() => (props.tab.name.length > 0 ? props.tab.name : props.tab.id))

const store = createPanelStore<TavernWorldPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

/**
 * 列表数据：store.data 是 ShallowRef，库里存的 items 可能缺字段/坏类型；
 * 每次读取都过 normalizeEntries 兜底（坏行丢弃、缺 id 补齐、order 归一化）。
 */
const items = computed<readonly TavernWorldEntry[]>(() => normalizeEntries(store.data.value.items))

const loading = computed<boolean>(() => store.loading.value)
const saving = computed<boolean>(() => store.saving.value)
const storeError = computed<string | null>(() => store.error.value)
const saveStatus = computed(() =>
  panelSaveStatus(store.saving.value, store.dirty.value, store.error.value !== null),
)

const selectedId = ref<string | null>(null)
const selectedEntry = computed<TavernWorldEntry | null>(() =>
  selectedId.value === null ? null : findEntryById(items.value, selectedId.value),
)

const formMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const keywordsInput = ref('')
const contentInput = ref('')
const enabledInput = ref(true)
const formError = ref<string | null>(null)
const formTitle = computed<string>(() =>
  formMode.value === 'edit' ? TEXT.editFormTitle : TEXT.formTitle,
)

const deleteOpen = ref(false)
const deleteTargetId = ref<string | null>(null)
const deleteTitle = computed<string>(() => {
  const target = findEntryById(items.value, deleteTargetId.value ?? '')
  return fillTemplate(TEXT.deleteTitle, { keywords: target === null ? '' : target.keywords })
})

const aiState = ref<'idle' | 'generating' | 'pending-confirm' | 'done' | 'failed'>('idle')
const aiMessage = ref<string | null>(null)
const notConfigured = ref(false)
const pendingExpand = ref<{ id: string; keywords: string; text: string } | null>(null)
const expandOpen = computed<boolean>(() => pendingExpand.value !== null)
const aiButtonLabel = computed<string>(() =>
  aiState.value === 'generating' ? TEXT.aiExpanding : TEXT.aiExpand,
)

const overview = computed<string>(() => overviewLine(items.value))

/** 无作品提示：面板数据存不进库（保存会被拒），提前说清楚。 */
const hasProject = ref(true)

let unsubscribe: (() => void) | null = null
let disposed = false

onMounted(() => {
  notConfigured.value = props.state.ai.configured() !== true
  hasProject.value = props.state.getSnapshot().projectId !== null
  unsubscribe = props.state.subscribe((snapshot) => {
    hasProject.value = snapshot.projectId !== null
    notConfigured.value = props.state.ai.configured() !== true
  })
  void store.load()
})

onUnmounted(() => {
  disposed = true
  unsubscribe?.()
  store.dispose()
})

/** 清空表单回到新建态。 */
function resetForm(): void {
  formMode.value = 'create'
  editingId.value = null
  keywordsInput.value = ''
  contentInput.value = ''
  enabledInput.value = true
  formError.value = null
}

/** 「新建条目」：清空表单并取消选中。 */
function onNew(): void {
  selectedId.value = null
  resetForm()
}

/** 点列表项：选中并回灌表单。 */
function selectEntry(entry: TavernWorldEntry): void {
  selectedId.value = entry.id
  formMode.value = 'edit'
  editingId.value = entry.id
  keywordsInput.value = entry.keywords
  contentInput.value = entry.content
  enabledInput.value = entry.enabled
  formError.value = null
}

/** 「取消编辑」：放弃未保存的表单修改，回到所选条目的已存内容。 */
function onCancelEdit(): void {
  const entry = selectedId.value === null ? null : findEntryById(items.value, selectedId.value)
  if (entry === null) {
    onNew()
    return
  }
  selectEntry(entry)
}

/** 「保存条目」：校验 → makeEntry → upsert → 显式 save。 */
async function onSaveEntry(): Promise<void> {
  if (store.saving.value) return
  const input = {
    keywords: keywordsInput.value,
    content: contentInput.value,
    enabled: enabledInput.value,
  }
  const error = validateEntryForm(input)
  if (error !== null) {
    formError.value = error
    return
  }
  formError.value = null
  const existing =
    formMode.value === 'edit' && editingId.value !== null
      ? findEntryById(items.value, editingId.value)
      : null
  const order = existing !== null ? existing.order : items.value.length
  const entry = makeEntry(input, existing, order)
  store.set({ items: upsertEntry(items.value, entry), updatedAt: tavernNow() })
  if (formMode.value === 'create') {
    // 新建后选中刚建的条目，方便继续编辑或 AI 扩写。
    selectedId.value = entry.id
    formMode.value = 'edit'
    editingId.value = entry.id
  }
  await store.save()
}

/** 列表里的启用开关：整体替换 items（store.data 是 ShallowRef），同步表单镜像。 */
async function onToggleEnabled(entry: TavernWorldEntry, event: Event): Promise<void> {
  const target = event.target
  const nextEnabled = target instanceof HTMLInputElement ? target.checked : !entry.enabled
  store.set({
    items: toggleEntryEnabled(items.value, entry.id, nextEnabled),
    updatedAt: tavernNow(),
  })
  if (selectedId.value === entry.id) enabledInput.value = nextEnabled
  await store.save()
}

/** 「删除」：先确认（YfeDialog tone=danger），确认后才动数据。 */
function requestDelete(entry: TavernWorldEntry): void {
  deleteTargetId.value = entry.id
  deleteOpen.value = true
}

function onCancelDelete(): void {
  deleteOpen.value = false
  deleteTargetId.value = null
}

async function onConfirmDelete(): Promise<void> {
  const id = deleteTargetId.value
  deleteOpen.value = false
  deleteTargetId.value = null
  if (id === null) return
  store.set({ items: removeEntry(items.value, id), updatedAt: tavernNow() })
  if (selectedId.value === id) {
    selectedId.value = null
    resetForm()
  }
  if (pendingExpand.value !== null && pendingExpand.value.id === id) pendingExpand.value = null
  await store.save()
}

let aiSequence = 0

/**
 * 「AI 扩写条目」：把选中条目的关键词 + 内容交给模型扩写。
 * 未配置模型显示引导、按钮不禁用；解析失败显示错误不落库；
 * 成功先挂起待确认（YfeDialog 确认后才替换）。
 */
async function onAiExpand(): Promise<void> {
  if (aiState.value === 'generating') return
  const entry = selectedEntry.value
  if (entry === null) {
    aiState.value = 'failed'
    aiMessage.value = TEXT.aiNeedSelected
    return
  }
  if (props.state.ai.configured() !== true) {
    notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = TEXT.notConfigured
    return
  }
  notConfigured.value = false
  aiState.value = 'generating'
  aiMessage.value = null
  const sequence = ++aiSequence
  let result: AiResult
  try {
    result = await props.state.ai.complete(buildAiExpandRequest(entry))
  } catch {
    // complete 契约不抛；这里兜底防御，别让一次异常把面板砸了。
    if (disposed || sequence !== aiSequence) return
    aiState.value = 'failed'
    aiMessage.value = failureNotice('AI_UPSTREAM_ERROR', '未知错误')
    return
  }
  if (disposed || sequence !== aiSequence) return
  if (result.ok !== true) {
    if (result.code === 'AI_NOT_CONFIGURED') notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = failureNotice(result.code, result.message)
    return
  }
  const expanded = parseAiExpanded(result.text)
  if (expanded === null) {
    aiState.value = 'failed'
    aiMessage.value = TEXT.aiParseFailed
    return
  }
  pendingExpand.value = { id: entry.id, keywords: entry.keywords, text: expanded }
  aiState.value = 'pending-confirm'
  aiMessage.value = null
}

/** 确认替换：扩写结果写入所选条目的 content，再显式 save。 */
async function onConfirmExpand(): Promise<void> {
  const pending = pendingExpand.value
  pendingExpand.value = null
  if (pending === null) return
  const entry = findEntryById(items.value, pending.id)
  if (entry === null) {
    aiState.value = 'failed'
    aiMessage.value = TEXT.aiEntryGone
    return
  }
  store.set({
    items: upsertEntry(items.value, { ...entry, content: pending.text }),
    updatedAt: tavernNow(),
  })
  if (selectedId.value === entry.id) contentInput.value = pending.text
  aiState.value = 'done'
  aiMessage.value = fillTemplate(TEXT.aiDone, { keywords: entry.keywords })
  await store.save()
}

/** 取消替换：丢弃扩写结果，原内容保持不变。 */
function onCancelExpand(): void {
  pendingExpand.value = null
  aiState.value = 'idle'
  aiMessage.value = TEXT.aiCancelled
}
</script>

<template>
  <section class="tavern-world" data-testid="tavern-world-panel" :data-tab-id="props.tab.id">
    <header class="tavern-world__header">
      <h1 class="tavern-world__title">{{ title }}</h1>
      <p class="tavern-world__desc">{{ props.tab.description }}</p>
      <p class="tavern-world__intro" data-testid="tavern-world-intro">{{ TEXT.intro }}</p>
    </header>

    <div class="tavern-world__toolbar" data-testid="tavern-world-toolbar">
      <span class="tavern-world__overview" data-testid="tavern-world-overview">{{ overview }}</span>
      <YfeStatusPill :status="saveStatus" />
      <YfeButton
        :label="TEXT.newEntry"
        variant="primary"
        data-testid="tavern-world-new"
        @click="onNew"
      />
    </div>

    <p
      v-if="!hasProject"
      class="tavern-world__notice tavern-world__notice--warn"
      data-testid="tavern-world-no-project"
    >
      {{ TEXT.noProject }}
    </p>
    <p
      v-if="notConfigured"
      class="tavern-world__notice tavern-world__notice--warn"
      data-testid="tavern-world-unconfigured"
    >
      {{ TEXT.notConfigured }}
    </p>

    <div class="tavern-world__notices">
      <p
        v-if="storeError !== null"
        class="tavern-world__notice tavern-world__notice--error"
        data-testid="tavern-world-error"
      >
        {{ storeError }}
      </p>
      <p
        v-if="aiMessage !== null"
        class="tavern-world__notice"
        :class="aiState === 'failed' ? 'tavern-world__notice--error' : 'tavern-world__notice--info'"
        data-testid="tavern-world-ai-message"
      >
        {{ aiMessage }}
      </p>
      <p
        v-if="formError !== null"
        class="tavern-world__notice tavern-world__notice--error"
        data-testid="tavern-world-form-error"
      >
        {{ formError }}
      </p>
    </div>

    <div class="tavern-world__body">
      <div class="tavern-world__pane tavern-world__pane--list">
        <h2 class="tavern-world__pane-title">{{ TEXT.listTitle }}</h2>
        <p class="tavern-world__hint">{{ TEXT.listHint }}</p>
        <p v-if="loading" class="tavern-world__state" data-testid="tavern-world-loading">
          {{ TEXT.loading }}
        </p>
        <p v-else-if="items.length === 0" class="tavern-world__state" data-testid="tavern-world-empty">
          {{ TEXT.empty }}
        </p>
        <ul v-else class="tavern-world__list" data-testid="tavern-world-list">
          <li
            v-for="entry in items"
            :key="entry.id"
            class="tavern-world__item"
            :class="{ 'tavern-world__item--selected': entry.id === selectedId }"
            :data-testid="`tavern-world-item-${entry.id}`"
            @click="selectEntry(entry)"
          >
            <div class="tavern-world__item-head">
              <span class="tavern-world__item-keywords" data-testid="tavern-world-item-keywords">
                {{ entry.keywords }}
              </span>
              <label class="tavern-world__switch" @click.stop>
                <input
                  type="checkbox"
                  class="tavern-world__switch-input"
                  :data-testid="`tavern-world-item-toggle-${entry.id}`"
                  :checked="entry.enabled"
                  @change="onToggleEnabled(entry, $event)"
                />
                <span class="tavern-world__switch-text">
                  {{ entry.enabled ? TEXT.enabledLabel : TEXT.disabledLabel }}
                </span>
              </label>
            </div>
            <p class="tavern-world__item-brief" data-testid="tavern-world-item-brief">
              {{ briefContent(entry.content) }}
            </p>
            <div class="tavern-world__item-actions">
              <YfeButton
                :label="TEXT.deleteEntry"
                variant="ghost"
                :data-testid="`tavern-world-item-delete-${entry.id}`"
                @click.stop="requestDelete(entry)"
              />
            </div>
          </li>
        </ul>
      </div>

      <div class="tavern-world__pane tavern-world__pane--form">
        <h2 class="tavern-world__pane-title" data-testid="tavern-world-form-title">{{ formTitle }}</h2>
        <form class="tavern-world__form" data-testid="tavern-world-form" @submit.prevent="onSaveEntry">
          <label class="tavern-world__field">
            <span class="tavern-world__field-label">{{ TEXT.fieldKeywords }}</span>
            <input
              v-model="keywordsInput"
              class="tavern-world__input"
              type="text"
              :placeholder="TEXT.keywordsPlaceholder"
              data-testid="tavern-world-keywords"
            />
          </label>
          <p class="tavern-world__field-hint">{{ TEXT.keywordsHint }}</p>
          <label class="tavern-world__field">
            <span class="tavern-world__field-label">{{ TEXT.fieldContent }}</span>
            <textarea
              v-model="contentInput"
              class="tavern-world__textarea"
              rows="5"
              :placeholder="TEXT.contentPlaceholder"
              data-testid="tavern-world-content"
            />
          </label>
          <label class="tavern-world__field tavern-world__field--check">
            <input
              v-model="enabledInput"
              type="checkbox"
              class="tavern-world__check"
              data-testid="tavern-world-enabled"
            />
            <span>{{ TEXT.fieldEnabled }}</span>
          </label>
          <div class="tavern-world__form-actions">
            <YfeButton
              :label="TEXT.saveEntry"
              variant="primary"
              :disabled="saving"
              :loading="saving"
              data-testid="tavern-world-save"
              @click="onSaveEntry"
            />
            <YfeButton
              v-if="formMode === 'edit'"
              :label="TEXT.cancelEdit"
              variant="ghost"
              data-testid="tavern-world-cancel-edit"
              @click="onCancelEdit"
            />
            <YfeButton
              :label="aiButtonLabel"
              variant="ghost"
              :loading="aiState === 'generating'"
              data-testid="tavern-world-ai-expand"
              @click="onAiExpand"
            />
          </div>
        </form>
      </div>
    </div>

    <section v-if="selectedEntry !== null" class="tavern-world__preview" data-testid="tavern-world-preview">
      <h2 class="tavern-world__pane-title">{{ TEXT.previewTitle }}</h2>
      <p class="tavern-world__preview-body" data-testid="tavern-world-preview-body">
        {{ selectedEntry.content }}
      </p>
    </section>
    <p v-else class="tavern-world__preview-empty" data-testid="tavern-world-preview-empty">
      {{ TEXT.previewEmpty }}
    </p>

    <section
      v-if="pendingExpand !== null"
      class="tavern-world__ai-preview"
      data-testid="tavern-world-ai-preview"
    >
      <h2 class="tavern-world__pane-title">{{ TEXT.aiPreviewTitle }}</h2>
      <p class="tavern-world__preview-body" data-testid="tavern-world-ai-preview-body">
        {{ pendingExpand.text }}
      </p>
    </section>

    <YfeDialog
      :open="deleteOpen"
      :title="deleteTitle"
      :confirm-label="TEXT.confirmDelete"
      :cancel-label="TEXT.cancel"
      tone="danger"
      data-testid="tavern-world-delete-dialog"
      @confirm="onConfirmDelete"
      @cancel="onCancelDelete"
    />
    <YfeDialog
      :open="expandOpen"
      :title="TEXT.expandConfirmTitle"
      :confirm-label="TEXT.expandConfirm"
      :cancel-label="TEXT.cancel"
      data-testid="tavern-world-expand-dialog"
      @confirm="onConfirmExpand"
      @cancel="onCancelExpand"
    />
  </section>
</template>

<style scoped>
.tavern-world {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-world__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-world__title {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.tavern-world__desc,
.tavern-world__hint,
.tavern-world__field-hint,
.tavern-world__preview-empty {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-world__intro {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-world__toolbar {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
  flex-wrap: wrap;
}

.tavern-world__overview {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-world__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-radius: var(--yfe-radius-sm, 4px);
}

.tavern-world__notice--warn {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #fbbf24);
  color: var(--yfe-color-warning, #fbbf24);
}

.tavern-world__notice--error {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.tavern-world__notice--info {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-world__body {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: var(--yfe-space-lg, 16px);
}

.tavern-world__pane {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-world__pane-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.tavern-world__state {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-world__list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tavern-world__item {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  cursor: pointer;
}

.tavern-world__item--selected {
  border-color: var(--yfe-color-primary, #7c9cff);
}

.tavern-world__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-world__item-keywords {
  color: var(--yfe-color-primary, #7c9cff);
  font-weight: var(--yfe-font-weight-bold, 600);
  word-break: break-all;
}

.tavern-world__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  cursor: pointer;
}

.tavern-world__switch-text {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-world__item-brief {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-world__item-actions {
  display: flex;
  justify-content: flex-end;
}

.tavern-world__form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-world__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-world__field--check {
  flex-direction: row;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-world__field-label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-world__input,
.tavern-world__textarea {
  box-sizing: border-box;
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-world__form-actions {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
  flex-wrap: wrap;
}

.tavern-world__preview,
.tavern-world__ai-preview {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-world__preview-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 720px) {
  .tavern-world__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
