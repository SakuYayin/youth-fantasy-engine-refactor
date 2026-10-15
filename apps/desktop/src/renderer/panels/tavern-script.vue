<script setup lang="ts">
/**
 * tavern-script（故事剧本）面板：酒馆模式的剧情自动化脚本条目管理（预览版）。
 *
 * 脚本列表（名称 + 备注摘要 + 启用开关）与表单（新建 / 编辑回灌 / 删除确认）；
 * 预览版只保存与查看脚本，**不执行**任何脚本内容（渲染进程禁止 eval / Function / 动态 import）。
 * 数据经 `createPanelStore` 持久化（模板 `panel:tavern-script`，values = `{ items }`），
 * 记录增删改与 AI 解析在 `./tavern-script-model.ts` 纯函数里。
 * AI 只走 `props.state.ai.complete()`（渲染层禁网）；未配置模型时显示引导、按钮不禁用；
 * 生成的草稿只回填代码编辑区，用户确认后手动保存（AI 不替用户落库）。
 * 持久化纪律：面板数据的增删改都是离散动作，用 `autoSaveMs: 0` 只在动作后显式
 * `store.save()`（与 tavern-card / bookbreak 同口径，避免无作品时反复自动保存报错）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { TavernScriptRecord } from '../tavern/types.js'

import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'
import {
  TAVERN_SCRIPT_PANEL_TEXT as TEXT,
  briefNote,
  buildAiScriptRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findScriptById,
  makeScript,
  overviewLine,
  panelSaveStatus,
  parseAiScript,
  removeScript,
  toggleScriptEnabled,
  upsertScript,
  validateScriptForm,
} from './tavern-script-model.js'
import type { PanelSaveStatus, TavernScriptPanelValues } from './tavern-script-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 worlds 同口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const store = createPanelStore<TavernScriptPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

/** 脚本列表（store.data 是 ShallowRef，整体替换后的镜像；坏数据兜底为空数组）。 */
const items = computed<readonly TavernScriptRecord[]>(() => {
  const raw: unknown = store.data.value.items
  return Array.isArray(raw) ? (raw as readonly TavernScriptRecord[]) : []
})

/** 选中脚本（列表高亮 + 编辑回灌）。 */
const selectedId = ref<string | null>(null)

/** 表单（create = 新建；edit = 编辑选中的脚本）。 */
const formMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const formName = ref('')
const formCode = ref('')
const formNote = ref('')
const formError = ref<string | null>(null)

/** 删除确认对话框。 */
const deleteOpen = ref(false)
const deleteTargetId = ref<string | null>(null)
const deleteTarget = computed<TavernScriptRecord | null>(() =>
  findScriptById(items.value, deleteTargetId.value ?? ''),
)
const deleteDialogTitle = computed<string>(() =>
  fillTemplate(TEXT.deleteTitle, { name: deleteTarget.value?.name ?? '' }),
)

/** AI 写脚本：「需求描述」输入 + 生成状态提示。 */
const aiRequirement = ref('')
const aiGenerating = ref(false)
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
  formMode.value === 'edit' ? TEXT.editTitle : TEXT.formTitle,
)
const aiButtonLabel = computed<string>(() =>
  aiGenerating.value ? TEXT.aiGenerating : TEXT.aiGenerate,
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
  formCode.value = ''
  formNote.value = ''
  formError.value = null
}

/** 「新建脚本」：清空表单回到新建态。 */
function onNew(): void {
  resetForm()
}

/** 编辑回灌：选中脚本 → 表单填值。 */
function fillForm(script: TavernScriptRecord): void {
  formMode.value = 'edit'
  editingId.value = script.id
  formName.value = script.name
  formCode.value = script.code
  formNote.value = script.note
  formError.value = null
}

/** 点击列表脚本：选中高亮 + 回灌表单。 */
function selectScript(script: TavernScriptRecord): void {
  selectedId.value = script.id
  fillForm(script)
}

/** 列表里的启用开关：整体替换 items（store.data 是 ShallowRef），切换后立即保存。 */
async function onToggleEnabled(script: TavernScriptRecord, event: Event): Promise<void> {
  const target = event.target
  const nextEnabled = target instanceof HTMLInputElement ? target.checked : !script.enabled
  store.set({ items: toggleScriptEnabled(items.value, script.id, nextEnabled) })
  await store.save()
}

/** 点删除：先弹 YfeDialog 确认（tone = danger）。 */
function askDelete(script: TavernScriptRecord): void {
  deleteTargetId.value = script.id
  deleteOpen.value = true
}

function onCancelDelete(): void {
  deleteOpen.value = false
  deleteTargetId.value = null
}

/** 确认删除：改 items → 显式保存；删的是正在编辑的脚本时重置表单。 */
async function onConfirmDelete(): Promise<void> {
  deleteOpen.value = false
  const id = deleteTargetId.value
  deleteTargetId.value = null
  if (id === null) return
  store.set({ items: removeScript(items.value, id) })
  if (selectedId.value === id || editingId.value === id) {
    selectedId.value = null
    resetForm()
  }
  await store.save()
}

/**
 * 保存脚本：名称必填校验 → 新建或原位更新 → 显式保存（失败靠 store.error 显示）。
 * 新建保存成功后切到编辑态：再点「保存脚本」是更新，不会重复建一条。
 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const nameError = validateScriptForm({
    name: formName.value,
    code: formCode.value,
    note: formNote.value,
  })
  if (nameError !== null) {
    formError.value = nameError
    return
  }
  formError.value = null
  const existing =
    formMode.value === 'edit' && editingId.value !== null
      ? findScriptById(items.value, editingId.value)
      : null
  const script = makeScript(
    { name: formName.value, code: formCode.value, note: formNote.value },
    existing,
  )
  store.set({ items: upsertScript(items.value, script) })
  selectedId.value = script.id
  formMode.value = 'edit'
  editingId.value = script.id
  aiMessage.value = null
  await store.save()
}

let aiSequence = 0

/**
 * AI 写脚本：把「需求描述」交给模型生成脚本草稿。
 * 未配置模型显示引导（按钮不禁用）；需求为空提示先填；解析失败只显示错误、不落库；
 * 成功只回填代码编辑区，用户确认后手动保存（AI 不替用户落库）。
 * AiPort 没有 abort：取消 = 丢弃迟到结果（序号守卫）。
 */
async function onAiWrite(): Promise<void> {
  if (aiGenerating.value) return
  if (props.state.ai.configured() !== true) {
    notConfigured.value = true
    aiMessage.value = TEXT.notConfigured
    return
  }
  const requirement = aiRequirement.value.trim()
  if (requirement === '') {
    aiMessage.value = TEXT.aiRequirementRequired
    return
  }
  notConfigured.value = false
  aiMessage.value = null
  aiGenerating.value = true
  const sequence = ++aiSequence
  const request = buildAiScriptRequest(
    requirement,
    items.value.map((item) => item.name),
  )
  let result: AiResult
  try {
    result = await props.state.ai.complete(request)
  } catch (thrown) {
    // AiPort 契约不抛；这里只是防御性兜底（实现故障时不白屏）。
    if (sequence !== aiSequence || disposed) return
    aiGenerating.value = false
    aiMessage.value = fillTemplate(TEXT.aiFailure, {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    })
    return
  }
  if (sequence !== aiSequence || disposed) return
  aiGenerating.value = false
  if (result.ok === false) {
    if (result.code === 'AI_NOT_CONFIGURED') notConfigured.value = true
    aiMessage.value = failureNotice(result.code, result.message)
    return
  }
  const draft = parseAiScript(result.text)
  if (draft === null) {
    // 解析失败：显示错误、不落库（任务书约定）。
    aiMessage.value = TEXT.aiParseFailed
    return
  }
  // 生成成功：只回填代码编辑区，等用户确认后手动保存。
  formCode.value = draft
  aiMessage.value = TEXT.aiDone
}
</script>

<template>
  <section class="tavern-script" data-testid="tavern-script-panel" :data-tab-id="props.tab.id">
    <header class="tavern-script__header">
      <h1 class="tavern-script__title">{{ title }}</h1>
      <p class="tavern-script__desc">{{ props.tab.description }}</p>
      <p class="tavern-script__intro" data-testid="tavern-script-intro">{{ TEXT.intro }}</p>
      <p
        class="tavern-script__notice tavern-script__notice--warn"
        data-testid="tavern-script-preview-notice"
      >
        {{ TEXT.previewNotice }}
      </p>
    </header>

    <div class="tavern-script__toolbar" data-testid="tavern-script-toolbar">
      <span class="tavern-script__overview" data-testid="tavern-script-overview">{{ overview }}</span>
      <YfeStatusPill :status="saveStatus" data-testid="tavern-script-save-status" />
      <YfeButton
        variant="ghost"
        :label="TEXT.newScript"
        data-testid="tavern-script-new"
        @click="onNew"
      />
    </div>

    <p
      v-if="notConfigured"
      class="tavern-script__notice tavern-script__notice--warn"
      data-testid="tavern-script-unconfigured"
    >
      {{ TEXT.notConfigured }}
    </p>
    <p
      v-if="storeError !== null"
      class="tavern-script__notice tavern-script__notice--error"
      data-testid="tavern-script-error"
    >
      {{ storeError }}
    </p>
    <p v-if="aiMessage !== null" class="tavern-script__notice" data-testid="tavern-script-ai-message">
      {{ aiMessage }}
    </p>
    <p
      v-if="formError !== null"
      class="tavern-script__notice tavern-script__notice--error"
      data-testid="tavern-script-form-error"
    >
      {{ formError }}
    </p>

    <div class="tavern-script__body">
      <section class="tavern-script__pane">
        <h2 class="tavern-script__pane-title" data-testid="tavern-script-list-title">
          {{ TEXT.listTitle }}
        </h2>
        <p class="tavern-script__pane-hint">{{ TEXT.listHint }}</p>

        <p v-if="loading" class="tavern-script__state" data-testid="tavern-script-loading">
          {{ TEXT.loading }}
        </p>
        <p v-else-if="items.length === 0" class="tavern-script__state" data-testid="tavern-script-empty">
          {{ TEXT.empty }}
        </p>
        <ul v-else class="tavern-script__list" data-testid="tavern-script-list">
          <li
            v-for="script in items"
            :key="script.id"
            class="tavern-script__item"
            :class="{ 'tavern-script__item--selected': script.id === selectedId }"
            :data-testid="`tavern-script-item-${script.id}`"
            @click="selectScript(script)"
          >
            <div class="tavern-script__item-head">
              <span class="tavern-script__item-name" data-testid="tavern-script-item-name">{{ script.name }}</span>
              <label class="tavern-script__toggle" @click.stop>
                <input
                  type="checkbox"
                  :data-testid="`tavern-script-item-toggle-${script.id}`"
                  :checked="script.enabled"
                  @change="onToggleEnabled(script, $event)"
                />
                <span data-testid="tavern-script-item-state">
                  {{ script.enabled ? TEXT.enabledLabel : TEXT.disabledLabel }}
                </span>
              </label>
              <YfeButton
                variant="danger"
                :label="TEXT.delete"
                data-testid="tavern-script-item-delete"
                @click.stop="askDelete(script)"
              />
            </div>
            <p v-if="script.note.trim() !== ''" class="tavern-script__item-note" data-testid="tavern-script-item-note">
              {{ briefNote(script.note) }}
            </p>
          </li>
        </ul>
      </section>

      <section class="tavern-script__pane">
        <h2 class="tavern-script__pane-title" data-testid="tavern-script-form-title">{{ formTitle }}</h2>

        <div class="tavern-script__form" data-testid="tavern-script-form">
          <label class="tavern-script__field">
            <span class="tavern-script__label">{{ TEXT.fieldName }}</span>
            <input
              v-model="formName"
              class="tavern-script__input"
              type="text"
              :placeholder="TEXT.namePlaceholder"
              data-testid="tavern-script-name"
            />
          </label>
          <label class="tavern-script__field">
            <span class="tavern-script__label">{{ TEXT.fieldCode }}</span>
            <textarea
              v-model="formCode"
              class="tavern-script__input tavern-script__input--code"
              :placeholder="TEXT.codePlaceholder"
              rows="8"
              spellcheck="false"
              data-testid="tavern-script-code"
            />
          </label>
          <label class="tavern-script__field">
            <span class="tavern-script__label">{{ TEXT.fieldNote }}</span>
            <textarea
              v-model="formNote"
              class="tavern-script__input tavern-script__input--area"
              :placeholder="TEXT.notePlaceholder"
              rows="2"
              data-testid="tavern-script-note"
            />
          </label>
          <div class="tavern-script__actions">
            <YfeButton
              variant="primary"
              :label="TEXT.save"
              :disabled="saving"
              :loading="saving"
              data-testid="tavern-script-save"
              @click="onSave"
            />
            <YfeButton
              v-if="formMode === 'edit'"
              variant="ghost"
              :label="TEXT.cancelEdit"
              data-testid="tavern-script-cancel-edit"
              @click="resetForm"
            />
          </div>
        </div>

        <section class="tavern-script__ai" data-testid="tavern-script-ai">
          <h3 class="tavern-script__ai-title" data-testid="tavern-script-ai-title">
            {{ TEXT.aiGenerate }}
          </h3>
          <label class="tavern-script__field">
            <span class="tavern-script__label">{{ TEXT.aiRequirementLabel }}</span>
            <textarea
              v-model="aiRequirement"
              class="tavern-script__input tavern-script__input--area"
              :placeholder="TEXT.aiRequirementPlaceholder"
              rows="2"
              data-testid="tavern-script-ai-requirement"
            />
          </label>
          <div class="tavern-script__actions">
            <YfeButton
              variant="ghost"
              :label="aiButtonLabel"
              :disabled="aiGenerating"
              :loading="aiGenerating"
              data-testid="tavern-script-ai-generate"
              @click="onAiWrite"
            />
          </div>
        </section>
      </section>
    </div>

    <YfeDialog
      :open="deleteOpen"
      :title="deleteDialogTitle"
      :confirm-label="TEXT.confirmDelete"
      :cancel-label="TEXT.cancelDelete"
      tone="danger"
      data-testid="tavern-script-delete-dialog"
      @confirm="onConfirmDelete"
      @cancel="onCancelDelete"
    />
  </section>
</template>

<style scoped>
/* 令牌名与 @yfe/ui 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.tavern-script {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-script__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-script__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-script__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-script__intro {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-script__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-script__overview {
  margin-right: auto;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-script__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-script__notice--warn {
  border-color: var(--yfe-color-warning, #fbbf24);
  color: var(--yfe-color-warning, #fbbf24);
}

.tavern-script__notice--error {
  border-color: var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.tavern-script__body {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(300px, 1.2fr);
  gap: var(--yfe-space-lg, 16px);
  align-items: start;
}

@media (max-width: 720px) {
  .tavern-script__body {
    grid-template-columns: 1fr;
  }
}

.tavern-script__pane {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-script__pane-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-script__pane-hint {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-script__state {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-script__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-script__item {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  cursor: pointer;
}

.tavern-script__item--selected {
  border-color: var(--yfe-color-primary, #7c9cff);
  box-shadow: 0 0 0 1px var(--yfe-color-primary, #7c9cff);
}

.tavern-script__item-head {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-script__item-name {
  margin-right: auto;
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-script__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  cursor: pointer;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  white-space: nowrap;
}

.tavern-script__item-note {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-script__form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-script__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-script__label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-script__input {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.tavern-script__input--area {
  resize: vertical;
  min-height: 3em;
}

/* 脚本代码按等宽字体展示（预览版按纯文本保存，不执行）。 */
.tavern-script__input--code {
  resize: vertical;
  min-height: 10em;
  font-family: var(--yfe-font-family-mono, Consolas, 'Cascadia Mono', monospace);
  white-space: pre;
}

.tavern-script__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-script__ai {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-script__ai-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}
</style>
