<script setup lang="ts">
/**
 * 剧情推演面板（`tavern-plot`）。
 *
 * 职责：酒馆对话的剧情走向规划——场景列表（标题 + 剧情简述摘要 + 顺序）、
 * 新建（标题必填/剧情简述）、编辑（选中回灌）、删除（YfeDialog 确认）、
 * 上移/下移调整顺序（order 用数组下标），以及可选增强「AI 续写剧情线」：
 * 把场景列表拼成大纲交给 `props.state.ai.complete` 推演下一段剧情，
 * 结果展示在结果区，YfeDialog 确认后追加为新场景；解析失败显示错误不落库。
 * 纯逻辑在同级 tavern-plot-model.ts，本文件只做渲染与调用（接口冻结 §4）。
 *
 * 纪律：绝不 import 'node:*'、绝不 fetch/WebSocket；AI 只走 `state.ai.complete`；
 * 持久化只走 `createPanelStore`（模板 `panel:tavern-plot`）；未配置模型必须显式
 * 渲染说明且不发请求（按钮不禁用，点了给引导）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import { createPanelStore } from './panel-store.js'
import {
  TAVERN_PLOT_PANEL_TEXT,
  briefDescription,
  buildAiContinueRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findSceneById,
  makeScene,
  moveScene,
  orderedScenes,
  orderLabel,
  overviewLine,
  panelSaveStatus,
  parseAiPlot,
  removeScene,
  upsertScene,
  validateSceneForm,
} from './tavern-plot-model.js'
import type {
  PanelSaveStatus,
  PlotAiState,
  PlotDraft,
  SceneFormInput,
  TavernPlotPanelValues,
  TavernPlotSceneRecord,
} from './tavern-plot-model.js'
import type { AiResult } from '../ai/types.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

const heading = computed(() => (props.tab.name.length > 0 ? props.tab.name : props.tab.id))
const description = computed(() => props.tab.description ?? '')

/**
 * 面板数据的增删改都是离散动作：`autoSaveMs: 0` 只在动作后显式 `store.save()`
 * （与 tavern-card 同口径，避免无作品时反复自动保存报错）。
 */
const store = createPanelStore<TavernPlotPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

const loading = computed(() => store.loading.value)
const saving = computed(() => store.saving.value)
const storeError = computed(() => store.error.value)
const saveStatus = computed<PanelSaveStatus>(() =>
  panelSaveStatus(saving.value, store.dirty.value, storeError.value !== null),
)

/** 显示顺序：按 order 归一化后的场景列表（深层字段必须整体替换，data 是 ShallowRef）。 */
const items = computed<TavernPlotSceneRecord[]>(() => {
  const stored = store.data.value.items
  if (!Array.isArray(stored)) return []
  return orderedScenes(stored)
})

const overview = computed(() => overviewLine(items.value.length))

// —— 场景表单（新建 / 编辑回灌）——
const formMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const titleInput = ref('')
const briefInput = ref('')
const formError = ref<string | null>(null)

const formHeading = computed(() =>
  formMode.value === 'edit' ? TAVERN_PLOT_PANEL_TEXT.formTitleEdit : TAVERN_PLOT_PANEL_TEXT.formTitleNew,
)

function resetForm(): void {
  formMode.value = 'create'
  editingId.value = null
  titleInput.value = ''
  briefInput.value = ''
  formError.value = null
}

/** 点列表项回灌表单进入编辑态。 */
function fillForm(item: TavernPlotSceneRecord): void {
  formMode.value = 'edit'
  editingId.value = item.id
  titleInput.value = item.title
  briefInput.value = item.brief
  formError.value = null
}

async function onSave(): Promise<void> {
  const input: SceneFormInput = { title: titleInput.value, brief: briefInput.value }
  const invalid = validateSceneForm(input)
  if (invalid !== null) {
    formError.value = invalid
    return
  }
  formError.value = null
  const existing =
    formMode.value === 'edit' ? findSceneById(items.value, editingId.value ?? '') : null
  const scene = makeScene(input, existing)
  store.set({ items: upsertScene(items.value, scene) })
  if (formMode.value === 'edit') {
    resetForm()
  } else {
    // 新建后清空输入并留在新建模式，便于连续建场景。
    titleInput.value = ''
    briefInput.value = ''
  }
  await store.save()
}

// —— 顺序（上移/下移）——
async function onMove(id: string, delta: -1 | 1): Promise<void> {
  const moved = moveScene(items.value, id, delta)
  if (moved === null) return
  store.set({ items: moved })
  await store.save()
}

// —— 删除（YfeDialog 确认）——
const deleteOpen = ref(false)
const deleteTargetId = ref<string | null>(null)

const deleteTitle = computed(() => {
  const target = deleteTargetId.value === null ? null : findSceneById(items.value, deleteTargetId.value)
  if (target === null) return TAVERN_PLOT_PANEL_TEXT.deleteTitle
  return fillTemplate(TAVERN_PLOT_PANEL_TEXT.deleteTitle, { name: target.title })
})

function askDelete(id: string): void {
  deleteTargetId.value = id
  deleteOpen.value = true
}

function closeDeleteDialog(): void {
  deleteOpen.value = false
  deleteTargetId.value = null
}

async function onConfirmDelete(): Promise<void> {
  const id = deleteTargetId.value
  closeDeleteDialog()
  if (id === null) return
  if (editingId.value === id) resetForm()
  store.set({ items: removeScene(items.value, id) })
  await store.save()
}

// —— AI 续写（可选增强；未配模型显示引导，按钮不禁用）——
const notConfigured = ref(false)
const aiState = ref<PlotAiState>('idle')
const aiMessage = ref<string | null>(null)
const aiResultText = ref<string | null>(null)
const aiDraft = ref<PlotDraft | null>(null)
const appendOpen = ref(false)
/** 迟到结果守卫：面板换轮次/卸载后回来的 AI 结果直接丢弃。 */
let aiSequence = 0
let disposed = false

onMounted(() => {
  notConfigured.value = !props.state.ai.configured()
  void store.load()
})

onUnmounted(() => {
  disposed = true
  store.dispose()
})

const appendTitle = computed(() =>
  fillTemplate(TAVERN_PLOT_PANEL_TEXT.appendTitle, {
    name: aiDraft.value === null ? '' : aiDraft.value.title,
  }),
)

function openAppendDialog(): void {
  if (aiDraft.value === null) return
  appendOpen.value = true
}

function closeAppendDialog(): void {
  appendOpen.value = false
}

async function onAiContinue(): Promise<void> {
  if (aiState.value === 'generating') return
  if (!props.state.ai.configured()) {
    notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = TAVERN_PLOT_PANEL_TEXT.notConfigured
    return
  }
  notConfigured.value = false
  aiState.value = 'generating'
  aiMessage.value = null
  const sequence = aiSequence + 1
  aiSequence = sequence
  let result: AiResult
  try {
    result = await props.state.ai.complete(buildAiContinueRequest(items.value))
  } catch (thrown) {
    result = {
      ok: false,
      code: 'AI_UPSTREAM_ERROR',
      message: thrown instanceof Error ? thrown.message : String(thrown),
    }
  }
  if (disposed || sequence !== aiSequence) return
  if (!result.ok) {
    if (result.code === 'AI_NOT_CONFIGURED') notConfigured.value = true
    aiState.value = 'failed'
    aiMessage.value = failureNotice(result.code, result.message)
    return
  }
  const draft = parseAiPlot(result.text)
  if (draft === null) {
    // 解析失败：显示错误不落库；原文留在结果区供排查。
    aiState.value = 'failed'
    aiMessage.value = TAVERN_PLOT_PANEL_TEXT.aiParseFailed
    aiResultText.value = result.text
    return
  }
  aiState.value = 'done'
  aiResultText.value = result.text
  aiDraft.value = draft
  appendOpen.value = true
}

async function onConfirmAppend(): Promise<void> {
  const draft = aiDraft.value
  closeAppendDialog()
  if (draft === null) return
  const scene = makeScene({ title: draft.title, brief: draft.brief }, null)
  store.set({ items: upsertScene(items.value, scene) })
  aiDraft.value = null
  aiState.value = 'idle'
  aiMessage.value = fillTemplate(TAVERN_PLOT_PANEL_TEXT.aiDone, { name: draft.title })
  await store.save()
}
</script>

<template>
  <section class="tavern-plot" data-testid="tavern-plot-panel" :data-tab-id="props.tab.id">
    <header class="tavern-plot__header">
      <h1 class="tavern-plot__heading">{{ heading }}</h1>
      <p class="tavern-plot__desc">{{ description }}</p>
      <p class="tavern-plot__intro">{{ TAVERN_PLOT_PANEL_TEXT.intro }}</p>
    </header>

    <div class="tavern-plot__toolbar">
      <span class="tavern-plot__overview" data-testid="tavern-plot-overview">{{ overview }}</span>
      <YfeStatusPill :status="saveStatus" />
      <span class="tavern-plot__toolbar-gap" />
      <YfeButton
        :label="TAVERN_PLOT_PANEL_TEXT.newScene"
        variant="ghost"
        data-testid="tavern-plot-new"
        @click="resetForm"
      />
      <YfeButton
        :label="aiState === 'generating' ? TAVERN_PLOT_PANEL_TEXT.aiGenerating : TAVERN_PLOT_PANEL_TEXT.aiGenerate"
        variant="ghost"
        :disabled="aiState === 'generating'"
        data-testid="tavern-plot-ai"
        @click="onAiContinue"
      />
    </div>

    <p
      v-if="notConfigured"
      class="tavern-plot__notice tavern-plot__notice--warn"
      data-testid="tavern-plot-not-configured"
    >
      {{ TAVERN_PLOT_PANEL_TEXT.notConfigured }}
    </p>
    <p
      v-if="storeError !== null"
      class="tavern-plot__notice tavern-plot__notice--error"
      data-testid="tavern-plot-store-error"
    >
      {{ storeError }}
    </p>
    <p
      v-if="aiMessage !== null"
      class="tavern-plot__notice"
      :class="aiState === 'failed' ? 'tavern-plot__notice--error' : 'tavern-plot__notice--ok'"
      data-testid="tavern-plot-ai-message"
    >
      {{ aiMessage }}
    </p>

    <div class="tavern-plot__body">
      <div class="tavern-plot__pane tavern-plot__pane--list">
        <h2 class="tavern-plot__pane-title">{{ TAVERN_PLOT_PANEL_TEXT.listTitle }}</h2>
        <p class="tavern-plot__hint">{{ TAVERN_PLOT_PANEL_TEXT.listHint }}</p>
        <p v-if="loading" class="tavern-plot__state" data-testid="tavern-plot-loading">
          {{ TAVERN_PLOT_PANEL_TEXT.loading }}
        </p>
        <p v-else-if="items.length === 0" class="tavern-plot__state" data-testid="tavern-plot-empty">
          {{ TAVERN_PLOT_PANEL_TEXT.empty }}
        </p>
        <ul v-else class="tavern-plot__list" data-testid="tavern-plot-list">
          <li
            v-for="(scene, index) in items"
            :key="scene.id"
            class="tavern-plot__item"
            :class="{ 'tavern-plot__item--selected': scene.id === editingId }"
            :data-testid="`tavern-plot-item-${scene.id}`"
            @click="fillForm(scene)"
          >
            <div class="tavern-plot__item-main">
              <span class="tavern-plot__item-order">{{ orderLabel(index + 1) }}</span>
              <span class="tavern-plot__item-title">{{ scene.title }}</span>
              <span class="tavern-plot__item-brief">{{ briefDescription(scene.brief) }}</span>
            </div>
            <div class="tavern-plot__item-actions">
              <YfeButton
                :label="TAVERN_PLOT_PANEL_TEXT.moveUp"
                variant="ghost"
                :disabled="index === 0"
                :data-testid="`tavern-plot-up-${scene.id}`"
                @click.stop="onMove(scene.id, -1)"
              />
              <YfeButton
                :label="TAVERN_PLOT_PANEL_TEXT.moveDown"
                variant="ghost"
                :disabled="index === items.length - 1"
                :data-testid="`tavern-plot-down-${scene.id}`"
                @click.stop="onMove(scene.id, 1)"
              />
              <YfeButton
                :label="TAVERN_PLOT_PANEL_TEXT.delete"
                variant="danger"
                :data-testid="`tavern-plot-delete-${scene.id}`"
                @click.stop="askDelete(scene.id)"
              />
            </div>
          </li>
        </ul>
      </div>

      <div class="tavern-plot__pane tavern-plot__pane--form">
        <h2 class="tavern-plot__pane-title">{{ formHeading }}</h2>
        <label class="tavern-plot__field">
          <span class="tavern-plot__field-label">{{ TAVERN_PLOT_PANEL_TEXT.fieldTitle }}</span>
          <input
            v-model="titleInput"
            class="tavern-plot__input"
            type="text"
            :placeholder="TAVERN_PLOT_PANEL_TEXT.titlePlaceholder"
            data-testid="tavern-plot-input-title"
          />
        </label>
        <label class="tavern-plot__field">
          <span class="tavern-plot__field-label">{{ TAVERN_PLOT_PANEL_TEXT.fieldBrief }}</span>
          <textarea
            v-model="briefInput"
            class="tavern-plot__textarea"
            rows="4"
            :placeholder="TAVERN_PLOT_PANEL_TEXT.briefPlaceholder"
            data-testid="tavern-plot-input-brief"
          />
        </label>
        <p
          v-if="formError !== null"
          class="tavern-plot__notice tavern-plot__notice--error"
          data-testid="tavern-plot-form-error"
        >
          {{ formError }}
        </p>
        <div class="tavern-plot__form-actions">
          <YfeButton
            :label="TAVERN_PLOT_PANEL_TEXT.saveScene"
            variant="primary"
            :disabled="saving"
            :loading="saving"
            data-testid="tavern-plot-save"
            @click="onSave"
          />
          <YfeButton
            v-if="formMode === 'edit'"
            :label="TAVERN_PLOT_PANEL_TEXT.cancelEdit"
            variant="ghost"
            data-testid="tavern-plot-cancel-edit"
            @click="resetForm"
          />
        </div>

        <h2 class="tavern-plot__pane-title">{{ TAVERN_PLOT_PANEL_TEXT.resultTitle }}</h2>
        <p v-if="aiResultText === null" class="tavern-plot__state" data-testid="tavern-plot-result-empty">
          {{ TAVERN_PLOT_PANEL_TEXT.resultEmpty }}
        </p>
        <template v-else>
          <pre class="tavern-plot__result" data-testid="tavern-plot-ai-result">{{ aiResultText }}</pre>
          <YfeButton
            :label="TAVERN_PLOT_PANEL_TEXT.appendScene"
            variant="primary"
            :disabled="aiDraft === null"
            data-testid="tavern-plot-append"
            @click="openAppendDialog"
          />
        </template>
      </div>
    </div>

    <YfeDialog
      :open="deleteOpen"
      :title="deleteTitle"
      :confirm-label="TAVERN_PLOT_PANEL_TEXT.confirmDelete"
      :cancel-label="TAVERN_PLOT_PANEL_TEXT.cancelDelete"
      tone="danger"
      @confirm="onConfirmDelete"
      @cancel="closeDeleteDialog"
    />
    <YfeDialog
      :open="appendOpen"
      :title="appendTitle"
      :confirm-label="TAVERN_PLOT_PANEL_TEXT.appendScene"
      :cancel-label="TAVERN_PLOT_PANEL_TEXT.cancelDelete"
      @confirm="onConfirmAppend"
      @cancel="closeAppendDialog"
    />
  </section>
</template>

<style scoped>
.tavern-plot {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  box-sizing: border-box;
  height: 100%;
  padding: var(--yfe-space-lg, 16px);
  overflow-y: auto;
  background: var(--yfe-color-bg, #141416);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-plot__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-plot__heading {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 18px);
  font-weight: var(--yfe-font-weight-bold, 700);
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-plot__desc,
.tavern-plot__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.5);
}

.tavern-plot__intro {
  color: var(--yfe-color-accent, #7c9cff);
}

.tavern-plot__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-plot__toolbar-gap {
  flex: 1;
}

.tavern-plot__overview {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-plot__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 8px);
  line-height: var(--yfe-font-line-height, 1.5);
}

.tavern-plot__notice--warn {
  border-color: var(--yfe-color-warning, #fbbf24);
  color: var(--yfe-color-warning, #fbbf24);
}

.tavern-plot__notice--error {
  border-color: var(--yfe-color-danger, #f87171);
  color: var(--yfe-color-danger, #f87171);
}

.tavern-plot__notice--ok {
  border-color: var(--yfe-color-accent, #7c9cff);
  color: var(--yfe-color-accent, #7c9cff);
}

.tavern-plot__body {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: var(--yfe-space-md, 12px);
  align-items: start;
}

.tavern-plot__pane {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-lg, 12px);
  background: var(--yfe-color-surface, #1e1e21);
}

.tavern-plot__pane-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 700);
}

.tavern-plot__hint,
.tavern-plot__state {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.5);
}

.tavern-plot__list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tavern-plot__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #26262b);
  cursor: pointer;
}

.tavern-plot__item--selected {
  border-color: var(--yfe-color-accent, #7c9cff);
}

.tavern-plot__item-main {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  min-width: 0;
}

.tavern-plot__item-order {
  color: var(--yfe-color-accent, #7c9cff);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-plot__item-title {
  overflow-wrap: anywhere;
  font-weight: var(--yfe-font-weight-bold, 700);
}

.tavern-plot__item-brief {
  overflow: hidden;
  color: var(--yfe-color-text-muted, #8b93a7);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tavern-plot__item-actions {
  display: flex;
  flex-shrink: 0;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-plot__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-plot__field-label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-plot__input,
.tavern-plot__textarea {
  box-sizing: border-box;
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #26262b);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: inherit;
  resize: vertical;
}

.tavern-plot__input:focus-visible,
.tavern-plot__textarea:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #7c9cff);
  outline-offset: 1px;
}

.tavern-plot__form-actions {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-plot__result {
  margin: 0;
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #26262b);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow-y: auto;
}

@media (max-width: 720px) {
  .tavern-plot__body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
