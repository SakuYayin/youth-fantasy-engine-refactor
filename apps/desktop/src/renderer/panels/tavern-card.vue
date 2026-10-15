<script setup lang="ts">
/**
 * tavern-card（角色卡片）面板：酒馆模式的数据基座（立绘卡 / 角色卡管理）。
 *
 * 卡片列表（名称 + 标签 + 简述）与表单（新建 / 编辑回灌 / 删除确认）；
 * 数据经 `createPanelStore` 持久化（模板 `panel:tavern-card`，values = `{ items }`），
 * 记录增删改与 AI 解析在 `./tavern-card-model.ts` 纯函数里。
 * AI 只走 `props.state.ai.complete()`（渲染层禁网）；未配置模型时显示引导、按钮不禁用。
 * 持久化纪律：面板数据的增删改都是离散动作，用 `autoSaveMs: 0` 只在动作后显式
 * `store.save()`（与 bookbreak 同口径，避免无作品时反复自动保存报错）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { TavernCardRecord } from '../tavern/types.js'

import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'
import {
  TAVERN_CARD_PANEL_TEXT,
  briefDescription,
  buildAiCardRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findCardById,
  formatTags,
  makeCard,
  overviewLine,
  panelSaveStatus,
  parseAiCard,
  parseTags,
  removeCard,
  upsertCard,
  validateCardForm,
} from './tavern-card-model.js'
import type { PanelSaveStatus, TavernCardPanelValues } from './tavern-card-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 worlds 同口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const store = createPanelStore<TavernCardPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

/** 卡片列表（store.data 是 ShallowRef，整体替换后的镜像；坏数据兜底为空数组）。 */
const items = computed<readonly TavernCardRecord[]>(() => {
  const raw: unknown = store.data.value.items
  return Array.isArray(raw) ? (raw as readonly TavernCardRecord[]) : []
})

/** 选中卡片（列表高亮 + 开场白预览 + 编辑回灌）。 */
const selectedId = ref<string | null>(null)
const selectedCard = computed<TavernCardRecord | null>(() =>
  findCardById(items.value, selectedId.value ?? ''),
)

/** 表单（create = 新建；edit = 编辑选中的卡）。 */
const formMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const formName = ref('')
const formDescription = ref('')
const formPersonality = ref('')
const formFirstMessage = ref('')
const formTagsInput = ref('')
const formError = ref<string | null>(null)

/** 删除确认对话框。 */
const deleteOpen = ref(false)
const deleteTargetId = ref<string | null>(null)
const deleteTarget = computed<TavernCardRecord | null>(() =>
  findCardById(items.value, deleteTargetId.value ?? ''),
)
const deleteDialogTitle = computed<string>(() =>
  fillTemplate(TAVERN_CARD_PANEL_TEXT.deleteTitle, { name: deleteTarget.value?.name ?? '' }),
)

/** AI 生成状态（idle / generating / done / failed）与结果提示。 */
const aiState = ref<'idle' | 'generating' | 'done' | 'failed'>('idle')
const aiMessage = ref<string | null>(null)
const notConfigured = ref(false)

const loading = computed<boolean>(() => store.loading.value)
const saving = computed<boolean>(() => store.saving.value)
const storeError = computed<string | null>(() => store.error.value)
const saveStatus = computed<PanelSaveStatus>(() =>
  panelSaveStatus(saving.value, store.dirty.value, storeError.value !== null),
)
const overview = computed<string>(() => overviewLine(items.value.length))
const formTitle = computed<string>(() =>
  formMode.value === 'edit' ? TAVERN_CARD_PANEL_TEXT.editTitle : TAVERN_CARD_PANEL_TEXT.formTitle,
)
const aiGenerating = computed<boolean>(() => aiState.value === 'generating')
const aiButtonLabel = computed<string>(() =>
  aiGenerating.value ? TAVERN_CARD_PANEL_TEXT.aiGenerating : TAVERN_CARD_PANEL_TEXT.aiGenerate,
)

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
  formName.value = ''
  formDescription.value = ''
  formPersonality.value = ''
  formFirstMessage.value = ''
  formTagsInput.value = ''
  formError.value = null
}

/** 「新建卡片」：清空表单回到新建态。 */
function onNew(): void {
  resetForm()
}

/** 编辑回灌：选中卡片 → 表单填值（标签用回显格式）。 */
function fillForm(card: TavernCardRecord): void {
  formMode.value = 'edit'
  editingId.value = card.id
  formName.value = card.name
  formDescription.value = card.description
  formPersonality.value = card.personality
  formFirstMessage.value = card.firstMessage
  formTagsInput.value = formatTags(card.tags)
  formError.value = null
}

/** 点击列表卡片：选中高亮 + 预览开场白 + 回灌表单。 */
function selectCard(card: TavernCardRecord): void {
  selectedId.value = card.id
  fillForm(card)
}

/** 点删除：先弹 YfeDialog 确认（tone = danger）。 */
function askDelete(card: TavernCardRecord): void {
  deleteTargetId.value = card.id
  deleteOpen.value = true
}

function onCancelDelete(): void {
  deleteOpen.value = false
  deleteTargetId.value = null
}

/** 确认删除：改 items → 显式保存；删的是正在编辑的卡时重置表单。 */
async function onConfirmDelete(): Promise<void> {
  deleteOpen.value = false
  const id = deleteTargetId.value
  deleteTargetId.value = null
  if (id === null) return
  store.set({ items: removeCard(items.value, id) })
  if (selectedId.value === id || editingId.value === id) {
    selectedId.value = null
    resetForm()
  }
  await store.save()
}

/** 保存卡片：名称必填校验 → 新建或原位更新 → 显式保存（失败靠 store.error 显示）。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const nameError = validateCardForm({ name: formName.value })
  if (nameError !== null) {
    formError.value = nameError
    return
  }
  formError.value = null
  const existing =
    formMode.value === 'edit' && editingId.value !== null
      ? findCardById(items.value, editingId.value)
      : null
  const card = makeCard(
    {
      name: formName.value,
      description: formDescription.value,
      personality: formPersonality.value,
      firstMessage: formFirstMessage.value,
      tags: parseTags(formTagsInput.value),
    },
    existing,
  )
  store.set({ items: upsertCard(items.value, card) })
  selectedId.value = card.id
  await store.save()
}

let aiSequence = 0

/**
 * AI 生成卡片：未配置显示引导（按钮不禁用）；
 * 成功解析后入库 + 保存，解析失败只显示错误、不落库。
 * AiPort 没有 abort：取消 = 丢弃迟到结果（序号守卫）。
 */
async function onAiGenerate(): Promise<void> {
  if (aiState.value === 'generating') return
  if (!props.state.ai.configured()) {
    notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = TAVERN_CARD_PANEL_TEXT.notConfigured
    return
  }
  notConfigured.value = false
  aiMessage.value = null
  const sequence = ++aiSequence
  aiState.value = 'generating'
  const request = buildAiCardRequest(items.value.map((card) => card.name))
  let result: AiResult
  try {
    result = await props.state.ai.complete(request)
  } catch (thrown) {
    // AiPort 契约不抛；这里只是防御性兜底（实现故障时不白屏）。
    if (sequence !== aiSequence || disposed) return
    aiState.value = 'failed'
    aiMessage.value = fillTemplate(TAVERN_CARD_PANEL_TEXT.aiFailure, {
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
  const draft = parseAiCard(result.text)
  if (draft === null) {
    // 解析失败：显示错误、不落库（任务书约定）。
    aiState.value = 'failed'
    aiMessage.value = TAVERN_CARD_PANEL_TEXT.aiParseFailed
    return
  }
  const card = makeCard(draft, null)
  store.set({ items: upsertCard(items.value, card) })
  selectedId.value = card.id
  fillForm(card)
  aiState.value = 'done'
  aiMessage.value = fillTemplate(TAVERN_CARD_PANEL_TEXT.aiDone, { name: card.name })
  await store.save()
}
</script>

<template>
  <section class="tavern-card" data-testid="tavern-card-panel" :data-tab-id="props.tab.id">
    <header class="tavern-card__header">
      <h1 class="tavern-card__title">{{ title }}</h1>
      <p class="tavern-card__desc">{{ props.tab.description }}</p>
      <p class="tavern-card__intro" data-testid="tavern-card-intro">{{ TAVERN_CARD_PANEL_TEXT.intro }}</p>
    </header>

    <div class="tavern-card__toolbar" data-testid="tavern-card-toolbar">
      <span class="tavern-card__overview" data-testid="tavern-card-overview">{{ overview }}</span>
      <YfeStatusPill :status="saveStatus" data-testid="tavern-card-save-status" />
      <YfeButton
        variant="ghost"
        :label="TAVERN_CARD_PANEL_TEXT.newCard"
        data-testid="tavern-card-new"
        @click="onNew"
      />
    </div>

    <p
      v-if="notConfigured"
      class="tavern-card__notice tavern-card__notice--warn"
      data-testid="tavern-card-unconfigured"
    >
      {{ TAVERN_CARD_PANEL_TEXT.notConfigured }}
    </p>
    <p v-if="storeError !== null" class="tavern-card__notice tavern-card__notice--error" data-testid="tavern-card-error">
      {{ storeError }}
    </p>
    <p v-if="aiMessage !== null" class="tavern-card__notice" data-testid="tavern-card-ai-message">
      {{ aiMessage }}
    </p>
    <p v-if="formError !== null" class="tavern-card__notice tavern-card__notice--error" data-testid="tavern-card-form-error">
      {{ formError }}
    </p>

    <div class="tavern-card__body">
      <section class="tavern-card__pane">
        <h2 class="tavern-card__pane-title" data-testid="tavern-card-list-title">
          {{ TAVERN_CARD_PANEL_TEXT.listTitle }}
        </h2>
        <p class="tavern-card__pane-hint">{{ TAVERN_CARD_PANEL_TEXT.listHint }}</p>

        <p v-if="loading" class="tavern-card__state" data-testid="tavern-card-loading">
          {{ TAVERN_CARD_PANEL_TEXT.loading }}
        </p>
        <p v-else-if="items.length === 0" class="tavern-card__state" data-testid="tavern-card-empty">
          {{ TAVERN_CARD_PANEL_TEXT.empty }}
        </p>
        <ul v-else class="tavern-card__list" data-testid="tavern-card-list">
          <li
            v-for="card in items"
            :key="card.id"
            class="tavern-card__item"
            :class="{ 'tavern-card__item--selected': card.id === selectedId }"
            :data-testid="`tavern-card-item-${card.id}`"
            @click="selectCard(card)"
          >
            <div class="tavern-card__item-head">
              <span class="tavern-card__item-name" data-testid="tavern-card-item-name">{{ card.name }}</span>
              <YfeButton
                variant="danger"
                :label="TAVERN_CARD_PANEL_TEXT.delete"
                data-testid="tavern-card-item-delete"
                @click.stop="askDelete(card)"
              />
            </div>
            <div class="tavern-card__item-tags" data-testid="tavern-card-item-tags">
              <span v-for="tag in card.tags" :key="tag" class="tavern-card__tag">{{ tag }}</span>
              <span v-if="card.tags.length === 0" class="tavern-card__tag tavern-card__tag--empty">
                {{ TAVERN_CARD_PANEL_TEXT.noTags }}
              </span>
            </div>
            <p class="tavern-card__item-brief" data-testid="tavern-card-item-brief">
              {{ briefDescription(card.description) }}
            </p>
          </li>
        </ul>
      </section>

      <section class="tavern-card__pane">
        <h2 class="tavern-card__pane-title" data-testid="tavern-card-form-title">{{ formTitle }}</h2>

        <div class="tavern-card__form" data-testid="tavern-card-form">
          <label class="tavern-card__field">
            <span class="tavern-card__label">{{ TAVERN_CARD_PANEL_TEXT.fieldName }}</span>
            <input
              v-model="formName"
              class="tavern-card__input"
              type="text"
              :placeholder="TAVERN_CARD_PANEL_TEXT.namePlaceholder"
              data-testid="tavern-card-name"
            />
          </label>
          <label class="tavern-card__field">
            <span class="tavern-card__label">{{ TAVERN_CARD_PANEL_TEXT.fieldDescription }}</span>
            <textarea
              v-model="formDescription"
              class="tavern-card__input tavern-card__input--area"
              :placeholder="TAVERN_CARD_PANEL_TEXT.descriptionPlaceholder"
              rows="3"
              data-testid="tavern-card-description"
            />
          </label>
          <label class="tavern-card__field">
            <span class="tavern-card__label">{{ TAVERN_CARD_PANEL_TEXT.fieldPersonality }}</span>
            <textarea
              v-model="formPersonality"
              class="tavern-card__input tavern-card__input--area"
              :placeholder="TAVERN_CARD_PANEL_TEXT.personalityPlaceholder"
              rows="2"
              data-testid="tavern-card-personality"
            />
          </label>
          <label class="tavern-card__field">
            <span class="tavern-card__label">{{ TAVERN_CARD_PANEL_TEXT.fieldFirstMessage }}</span>
            <textarea
              v-model="formFirstMessage"
              class="tavern-card__input tavern-card__input--area"
              :placeholder="TAVERN_CARD_PANEL_TEXT.firstMessagePlaceholder"
              rows="3"
              data-testid="tavern-card-first-message"
            />
          </label>
          <label class="tavern-card__field">
            <span class="tavern-card__label">{{ TAVERN_CARD_PANEL_TEXT.fieldTags }}</span>
            <input
              v-model="formTagsInput"
              class="tavern-card__input"
              type="text"
              :placeholder="TAVERN_CARD_PANEL_TEXT.tagsPlaceholder"
              data-testid="tavern-card-tags"
            />
          </label>
          <div class="tavern-card__actions">
            <YfeButton
              variant="primary"
              :label="TAVERN_CARD_PANEL_TEXT.save"
              :disabled="saving"
              :loading="saving"
              data-testid="tavern-card-save"
              @click="onSave"
            />
            <YfeButton
              v-if="formMode === 'edit'"
              variant="ghost"
              :label="TAVERN_CARD_PANEL_TEXT.cancelEdit"
              data-testid="tavern-card-cancel-edit"
              @click="resetForm"
            />
            <YfeButton
              variant="ghost"
              :label="aiButtonLabel"
              :disabled="aiGenerating"
              :loading="aiGenerating"
              data-testid="tavern-card-ai-generate"
              @click="onAiGenerate"
            />
          </div>
        </div>

        <section class="tavern-card__preview" data-testid="tavern-card-preview">
          <h3 class="tavern-card__preview-title" data-testid="tavern-card-preview-title">
            {{ TAVERN_CARD_PANEL_TEXT.previewTitle }}
          </h3>
          <p v-if="selectedCard === null" class="tavern-card__state" data-testid="tavern-card-preview-empty">
            {{ TAVERN_CARD_PANEL_TEXT.previewEmpty }}
          </p>
          <p v-else class="tavern-card__preview-body" data-testid="tavern-card-preview-body">
            {{ selectedCard.firstMessage }}
          </p>
        </section>
      </section>
    </div>

    <YfeDialog
      :open="deleteOpen"
      :title="deleteDialogTitle"
      :confirm-label="TAVERN_CARD_PANEL_TEXT.confirmDelete"
      :cancel-label="TAVERN_CARD_PANEL_TEXT.cancelDelete"
      tone="danger"
      data-testid="tavern-card-delete-dialog"
      @confirm="onConfirmDelete"
      @cancel="onCancelDelete"
    />
  </section>
</template>

<style scoped>
/* 令牌名与 @yfe/ui 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.tavern-card {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-card__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-card__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-card__intro {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-card__overview {
  margin-right: auto;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-card__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__notice--warn {
  border-color: var(--yfe-color-warning, #fbbf24);
  color: var(--yfe-color-warning, #fbbf24);
}

.tavern-card__notice--error {
  border-color: var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.tavern-card__body {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.2fr);
  gap: var(--yfe-space-lg, 16px);
  align-items: start;
}

@media (max-width: 720px) {
  .tavern-card__body {
    grid-template-columns: 1fr;
  }
}

.tavern-card__pane {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-card__pane-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__pane-hint {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-card__state {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-card__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-card__item {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  cursor: pointer;
}

.tavern-card__item--selected {
  border-color: var(--yfe-color-primary, #7c9cff);
  box-shadow: 0 0 0 1px var(--yfe-color-primary, #7c9cff);
}

.tavern-card__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-card__item-name {
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-card__tag {
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-sm, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-card__tag--empty {
  border-style: dashed;
}

.tavern-card__item-brief {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-card__form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-card__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-card__label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-card__input {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-card__input--area {
  resize: vertical;
  min-height: 3em;
}

.tavern-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-card__preview {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-card__preview-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-card__preview-body {
  margin: 0;
  white-space: pre-wrap;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}
</style>
