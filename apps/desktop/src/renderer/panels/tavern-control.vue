<script setup lang="ts">
/**
 * 酒馆控制面板（酒馆模式 · 控制面板）。
 *
 * 酒馆组各页签共用的全局设置：模式 / 温度 / 单次生成上限 / 携带最近消息条数 /
 * 高级参数（自由键值对，预览版不解析）。持久化走 `panel-store`（模板
 * `panel:tavern-control`，values 为 `{ settings: TavernSettingsRecord }`，自动保存
 * 默认 1500ms）；AI 只走 `props.state.ai.complete`（渲染层不发请求）。
 *
 * 说明区：这里的设置是酒馆组的全局默认值，各页签保存的是各自面板的状态；
 * 改完后其它酒馆页签在下次进入时读取。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { AdvancedRow, RecommendDraft, TavernControlPanelValues, TavernSettingsFormRaw } from './tavern-control-model.js'
import type { PanelProps } from './types.js'

import { createPanelStore } from './panel-store.js'
import {
  TAVERN_CONTROL_PANEL_TEXT as TEXT,
  TAVERN_MODES,
  advancedFromRows,
  buildAiRecommendRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  formErrorOnly,
  formatSaveTime,
  modeLabel,
  normalizeMode,
  panelSaveStatus,
  parseAiRecommend,
  resolveSettings,
  rowsFromAdvanced,
  settingsEqual,
  settingsFromForm,
} from './tavern-control-model.js'

const props = defineProps<PanelProps>()

const store = createPanelStore<TavernControlPanelValues>(props.state, props.tab.id, createDefaultPanelValues())
// 自动保存默认 1500ms：设置表单即改即存；非法值不进 store（本地镜像报中文错误）。

/** 表单镜像（number input 全是字符串：原样回显，别替用户改写）。 */
const formMode = ref<string>('normal')
const formTemperature = ref<string>('0.7')
const formMaxTokens = ref<string>('2048')
const formContextMessages = ref<string>('20')

/** 「高级参数」开关与键值行：开启后显示额外说明区；空键行不落库。 */
const advancedOpen = ref<boolean>(false)
const advancedRows = ref<AdvancedRow[]>([])

const formError = ref<string | null>(null)
const aiError = ref<string | null>(null)
const aiNotConfigured = ref<boolean>(false)
const aiState = ref<'idle' | 'loading' | 'done'>('idle')
const recommendDraft = ref<RecommendDraft | null>(null)
const applyDialogOpen = ref<boolean>(false)
const aiPurpose = ref<string>('')
const lastSavedAt = ref<string | null>(null)

const title = computed<string>(() => props.tab.name || props.tab.id)
const status = computed(() =>
  panelSaveStatus(store.saving.value, store.dirty.value, store.error.value !== null),
)
const lastSavedText = computed<string>(() => {
  if (lastSavedAt.value === null) return TEXT.notSavedYet
  const time = formatSaveTime(lastSavedAt.value)
  return time === '' ? TEXT.notSavedYet : `${TEXT.lastSavedPrefix}${time}`
})
const recommendLine = computed<string>(() => {
  const draft = recommendDraft.value
  if (draft === null) return ''
  return fillTemplate(TEXT.recommendLine, {
    temperature: String(draft.temperature),
    maxTokens: String(draft.maxTokens),
    contextMessages: String(draft.contextMessages),
  })
})

function currentForm(): TavernSettingsFormRaw {
  return {
    mode: formMode.value,
    temperature: formTemperature.value,
    maxTokens: formMaxTokens.value,
    contextMessages: formContextMessages.value,
  }
}

/** 表单 → store：非法值只报错不落库；合法且与库值不同才 patch（标脏 → 自动保存）。 */
function syncToStore(): void {
  const result = settingsFromForm(currentForm(), advancedFromRows(advancedRows.value))
  formError.value = result.error
  if (result.settings === null) return
  const current = resolveSettings(store.data.value.settings)
  if (settingsEqual(current, result.settings)) return
  store.patch({ settings: result.settings })
}

/** 载入后回显：库值归一（未知模式显示为「正常」），越界的库值也显式提示但不改写。 */
function fillFromStore(): void {
  const settings = resolveSettings(store.data.value.settings)
  formMode.value = normalizeMode(settings.mode)
  formTemperature.value = String(settings.temperature)
  formMaxTokens.value = String(settings.maxTokens)
  formContextMessages.value = String(settings.contextMessages)
  advancedRows.value = rowsFromAdvanced(settings.advanced)
  advancedOpen.value = Object.keys(settings.advanced).length > 0
  formError.value = formErrorOnly(currentForm())
}

/* 受控输入：@input 里先同步本地镜像，再同步 store（视图测试按这条链路断言）。 */
function onTemperatureInput(event: Event): void {
  formTemperature.value = (event.target as HTMLInputElement).value
  syncToStore()
}

function onMaxTokensInput(event: Event): void {
  formMaxTokens.value = (event.target as HTMLInputElement).value
  syncToStore()
}

function onContextMessagesInput(event: Event): void {
  formContextMessages.value = (event.target as HTMLInputElement).value
  syncToStore()
}

function onModeChange(event: Event): void {
  formMode.value = (event.target as HTMLSelectElement).value
  syncToStore()
}

function onAdvancedToggle(event: Event): void {
  advancedOpen.value = (event.target as HTMLInputElement).checked
}

function onAdvancedKeyInput(event: Event, index: number): void {
  const row = advancedRows.value[index]
  if (row === undefined) return
  advancedRows.value[index] = { key: (event.target as HTMLInputElement).value, value: row.value }
  syncToStore()
}

function onAdvancedValueInput(event: Event, index: number): void {
  const row = advancedRows.value[index]
  if (row === undefined) return
  advancedRows.value[index] = { key: row.key, value: (event.target as HTMLInputElement).value }
  syncToStore()
}

function onAddAdvancedRow(): void {
  advancedRows.value = [...advancedRows.value, { key: '', value: '' }]
}

function onRemoveAdvancedRow(index: number): void {
  advancedRows.value = advancedRows.value.filter((_row, i) => i !== index)
  syncToStore()
}

function onAiPurposeInput(event: Event): void {
  aiPurpose.value = (event.target as HTMLInputElement).value
}

/* AI 联动：未配置显示引导（按钮不禁用）；解析失败显示错误、不落库。 */
let aiSequence = 0

async function onAiRecommend(): Promise<void> {
  aiSequence += 1
  const sequence = aiSequence
  aiError.value = null
  if (aiNotConfigured.value) return
  aiState.value = 'loading'
  const request = buildAiRecommendRequest(formMode.value, aiPurpose.value)
  const result = await props.state.ai.complete(request)
  if (sequence !== aiSequence) return // 已有更新的请求在跑，丢弃这次过期结果
  if (!result.ok) {
    aiError.value = failureNotice(result.code, result.message)
    if (result.code === 'AI_NOT_CONFIGURED') aiNotConfigured.value = true
    aiState.value = 'idle'
    return
  }
  const draft = parseAiRecommend(result.text)
  if (draft === null) {
    aiError.value = TEXT.aiParseFailed
    aiState.value = 'idle'
    return
  }
  recommendDraft.value = draft
  aiState.value = 'done' // 结果展示在面板里；确认对话框由「应用此推荐」打开
}

function onApplyRecommend(): void {
  const draft = recommendDraft.value
  if (draft === null) return
  formTemperature.value = String(draft.temperature)
  formMaxTokens.value = String(draft.maxTokens)
  formContextMessages.value = String(draft.contextMessages)
  applyDialogOpen.value = false
  syncToStore() // 应用后走自动保存
}

function onDismissRecommend(): void {
  applyDialogOpen.value = false
}

async function onSaveNow(): Promise<void> {
  syncToStore() // 非法值会在这里报错、不落库
  if (formError.value !== null) return
  await store.save()
}

/* 最后保存时间：save 成功落库的信号是 saving true→false 且无 error（载入不动 saving）。 */
watch(store.saving, (now, before) => {
  if (before === true && now === false && store.error.value === null) {
    lastSavedAt.value = new Date().toISOString()
  }
})

onMounted(() => {
  aiNotConfigured.value = !props.state.ai.configured()
  void store.load().then(() => {
    fillFromStore()
  })
})

onUnmounted(() => {
  store.dispose()
})
</script>

<template>
  <section class="tavern-control" data-testid="tavern-control-panel" :data-tab-id="props.tab.id">
    <header class="tavern-control__header">
      <h1 class="tavern-control__title">{{ title }}</h1>
      <p class="tavern-control__description">{{ props.tab.description }}</p>
      <div class="tavern-control__intro" data-testid="tavern-control-intro">
        <p>{{ TEXT.introLine1 }}</p>
        <p>{{ TEXT.introLine2 }}</p>
      </div>
    </header>

    <div class="tavern-control__toolbar">
      <YfeStatusPill :status="status" />
      <span class="tavern-control__saved-at" data-testid="tavern-control-saved-at">{{ lastSavedText }}</span>
      <YfeButton
        variant="ghost"
        :label="TEXT.saveNow"
        :disabled="store.saving.value"
        data-testid="tavern-control-save-now"
        @click="onSaveNow"
      />
    </div>

    <div class="tavern-control__notices">
      <p
        v-if="store.loading.value"
        class="tavern-control__notice tavern-control__notice--loading"
        data-testid="tavern-control-loading"
      >
        {{ TEXT.loadingDetail }}
      </p>
      <p
        v-if="aiNotConfigured"
        class="tavern-control__notice tavern-control__notice--warn"
        data-testid="tavern-control-not-configured"
      >
        {{ TEXT.notConfigured }}
      </p>
      <p
        v-if="store.error.value !== null"
        class="tavern-control__notice tavern-control__notice--error"
        data-testid="tavern-control-store-error"
      >
        {{ store.error.value }}
      </p>
      <p
        v-if="aiError !== null"
        class="tavern-control__notice tavern-control__notice--error"
        data-testid="tavern-control-ai-error"
      >
        {{ aiError }}
      </p>
      <p
        v-if="formError !== null"
        class="tavern-control__notice tavern-control__notice--error"
        data-testid="tavern-control-form-error"
      >
        {{ formError }}
      </p>
    </div>

    <section class="tavern-control__section" data-testid="tavern-control-form">
      <h2 class="tavern-control__section-title">{{ TEXT.formTitle }}</h2>

      <label class="tavern-control__field">
        <span class="tavern-control__field-label">{{ TEXT.fieldMode }}</span>
        <select
          class="tavern-control__select"
          :value="formMode"
          data-testid="tavern-control-mode"
          @change="onModeChange"
        >
          <option v-for="option in TAVERN_MODES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </label>

      <label class="tavern-control__field">
        <span class="tavern-control__field-label">{{ TEXT.fieldTemperature }}</span>
        <input
          class="tavern-control__input"
          type="number"
          min="0"
          max="2"
          step="0.1"
          :value="formTemperature"
          data-testid="tavern-control-temperature"
          @input="onTemperatureInput"
        />
        <span class="tavern-control__hint">{{ TEXT.temperatureHint }}</span>
      </label>

      <label class="tavern-control__field">
        <span class="tavern-control__field-label">{{ TEXT.fieldMaxTokens }}</span>
        <input
          class="tavern-control__input"
          type="number"
          min="1"
          max="200000"
          step="1"
          :value="formMaxTokens"
          data-testid="tavern-control-max-tokens"
          @input="onMaxTokensInput"
        />
        <span class="tavern-control__hint">{{ TEXT.maxTokensHint }}</span>
      </label>

      <label class="tavern-control__field">
        <span class="tavern-control__field-label">{{ TEXT.fieldContextMessages }}</span>
        <input
          class="tavern-control__input"
          type="number"
          min="1"
          max="100"
          step="1"
          :value="formContextMessages"
          data-testid="tavern-control-context-messages"
          @input="onContextMessagesInput"
        />
        <span class="tavern-control__hint">{{ TEXT.contextMessagesHint }}</span>
      </label>

      <label class="tavern-control__field tavern-control__field--switch">
        <span class="tavern-control__field-label">{{ TEXT.fieldAdvanced }}</span>
        <input
          class="tavern-control__switch"
          type="checkbox"
          :checked="advancedOpen"
          data-testid="tavern-control-advanced"
          @change="onAdvancedToggle"
        />
      </label>

      <div v-if="advancedOpen" class="tavern-control__advanced" data-testid="tavern-control-advanced-area">
        <p class="tavern-control__hint">{{ TEXT.advancedNote }}</p>
        <p v-if="advancedRows.length === 0" class="tavern-control__hint" data-testid="tavern-control-advanced-empty">
          {{ TEXT.advancedEmpty }}
        </p>
        <div v-for="(row, index) in advancedRows" :key="index" class="tavern-control__advanced-row">
          <input
            class="tavern-control__input"
            :value="row.key"
            :placeholder="TEXT.advancedKeyPlaceholder"
            :data-testid="`tavern-control-advanced-key-${index}`"
            @input="onAdvancedKeyInput($event, index)"
          />
          <input
            class="tavern-control__input"
            :value="row.value"
            :placeholder="TEXT.advancedValuePlaceholder"
            :data-testid="`tavern-control-advanced-value-${index}`"
            @input="onAdvancedValueInput($event, index)"
          />
          <YfeButton
            variant="ghost"
            :label="TEXT.removeRow"
            :data-testid="`tavern-control-advanced-remove-${index}`"
            @click="onRemoveAdvancedRow(index)"
          />
        </div>
        <YfeButton variant="ghost" :label="TEXT.addRow" data-testid="tavern-control-advanced-add" @click="onAddAdvancedRow" />
      </div>
    </section>

    <section class="tavern-control__section" data-testid="tavern-control-ai">
      <h2 class="tavern-control__section-title">{{ TEXT.aiTitle }}</h2>
      <label class="tavern-control__field">
        <span class="tavern-control__field-label">{{ TEXT.aiPurposeLabel }}</span>
        <input
          class="tavern-control__input"
          type="text"
          :value="aiPurpose"
          :placeholder="TEXT.aiPurposePlaceholder"
          data-testid="tavern-control-ai-purpose"
          @input="onAiPurposeInput"
        />
      </label>
      <div class="tavern-control__ai-actions">
        <YfeButton
          variant="primary"
          :label="aiState === 'loading' ? TEXT.aiButtonLoading : TEXT.aiButton"
          :loading="aiState === 'loading'"
          data-testid="tavern-control-ai-button"
          @click="onAiRecommend"
        />
      </div>
      <div v-if="recommendDraft !== null" class="tavern-control__recommend" data-testid="tavern-control-recommend">
        <span>{{ TEXT.aiRecommendation }}：{{ recommendLine }}</span>
        <YfeButton
          variant="primary"
          :label="TEXT.applyButton"
          data-testid="tavern-control-ai-apply"
          @click="applyDialogOpen = true"
        />
      </div>
    </section>

    <YfeDialog
      :open="applyDialogOpen"
      :title="TEXT.applyDialogTitle"
      :confirm-label="TEXT.applyDialogConfirm"
      :cancel-label="TEXT.applyDialogCancel"
      @confirm="onApplyRecommend"
      @cancel="onDismissRecommend"
    />
  </section>
</template>

<style scoped>
.tavern-control {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-control__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-control__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: 600;
}

.tavern-control__description {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-control__intro {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-left: 3px solid var(--yfe-color-accent, #5b8cff);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface-raised, #20242e);
}

.tavern-control__intro p {
  margin: 0;
}

.tavern-control__toolbar {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
}

.tavern-control__saved-at {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-control__notices {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-control__notice {
  margin: 0;
}

.tavern-control__notice--loading {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.tavern-control__notice--warn {
  color: var(--yfe-color-warning, #e8b96b);
}

.tavern-control__notice--error {
  color: var(--yfe-color-danger, #ff7b72);
}

.tavern-control__section {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
}

.tavern-control__section-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: 600;
}

.tavern-control__field {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-control__field--switch {
  gap: var(--yfe-space-sm, 8px);
}

.tavern-control__field-label {
  flex: 0 0 auto;
  min-width: 8em;
  color: var(--yfe-color-text, #e6e8ee);
}

.tavern-control__input,
.tavern-control__select {
  box-sizing: border-box;
  min-width: 0;
  flex: 1 1 auto;
  max-width: 16em;
  padding: 0 var(--yfe-space-sm, 8px);
  height: 2.2em;
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: inherit;
}

.tavern-control__switch {
  width: 1.1em;
  height: 1.1em;
  accent-color: var(--yfe-color-accent, #5b8cff);
}

.tavern-control__hint {
  margin: 0;
  flex: 1 1 auto;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-control__advanced {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px);
  border: 1px dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
}

.tavern-control__advanced-row {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-control__advanced-row .tavern-control__input {
  max-width: 12em;
}

.tavern-control__ai-actions {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-control__recommend {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-success, #5ddc9a);
}
</style>
