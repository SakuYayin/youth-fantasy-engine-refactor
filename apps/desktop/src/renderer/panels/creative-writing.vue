<script setup lang="ts">
/**
 * creative-writing（创意写作）面板：AI 续写/改写/润色工作台。
 *
 * 纯逻辑在 creative-writing-model.ts；数据来自 `props.state.getSnapshot()`（订阅刷新），
 * AI 请求只走 `props.state.ai.complete(request)`（不 fetch、不 node:*）。
 * 会话设置经 `createPanelStore` 持久化（panel:<tab.id>，面板卸载时 dispose）。
 * 预览版没有写回正文的通道：结果只展示 + 复制，界面上如实标注（WRITING_COPY.insertNote）。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import { YfeButton, YfePanel, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'

import {
  DEFAULT_WRITING_VALUES,
  MAX_SOURCE_CHARS,
  WRITING_COPY,
  buildWritingRequest,
  isWritingModeId,
  panelSaveStatus,
  parseWritingResult,
  readChapters,
  resolveSessionParams,
  resultCharsLine,
  writingModeById,
  writingModes,
} from './creative-writing-model.js'
import type { WritingModeId, WritingPanelValues } from './creative-writing-model.js'
import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

const snapshot = shallowRef(props.state.getSnapshot())
const unsubscribe = props.state.subscribe((next) => {
  snapshot.value = next
})

const store = createPanelStore<WritingPanelValues>(props.state, props.tab.id, DEFAULT_WRITING_VALUES)

/** 来源正文（不持久化：可能超长，粘贴/带入即用）。 */
const sourceText = ref('')
/** 带入来源章节（文档 id；'' = 未选择）。 */
const chapterId = ref('')
/** 模式（持久化）。 */
const mode = ref<WritingModeId>('continue')
/** 写要求（持久化）。 */
const instruction = ref('')
/** 会话参数输入框原文（持久化，空串 = 不传、按模式默认）。 */
const temperatureInput = ref('')
const maxTokensInput = ref('')

const bringing = ref(false)
const generating = ref(false)
/** 生成状态：空闲/生成中/完成/失败。 */
const genState = ref<'idle' | 'generating' | 'done' | 'failed'>('idle')
const resultText = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const cancelNote = ref<string | null>(null)
const paramHint = ref<string | null>(null)
const bringHint = ref<string | null>(null)
const copyState = ref<string | null>(null)
const truncatedNotice = ref<string | null>(null)
const notConfigured = ref(false)

/** 已发出的生成序号：取消后丢弃 pending 的 AiResult（取消仅忽略结果）。 */
let generationSequence = 0

const chapters = computed(() => readChapters(snapshot.value))
const chapterOptions = computed(() =>
  chapters.value.map((chapter) => ({
    value: String(chapter.id),
    label: chapter.title === '' ? WRITING_COPY.untitledChapter : chapter.title,
  })),
)

const currentMode = computed(() => writingModeById(mode.value))
const saveStatus = computed(() =>
  panelSaveStatus(store.saving.value, store.dirty.value, store.error.value !== null),
)
const storeError = computed(() => store.error.value)
const stateText = computed(() => {
  if (genState.value === 'generating') return WRITING_COPY.stateGenerating
  if (genState.value === 'done') return WRITING_COPY.stateDone
  if (genState.value === 'failed') return WRITING_COPY.stateFailed
  return WRITING_COPY.stateIdle
})

const sourceEmpty = computed(() => sourceText.value.trim() === '')
const sourceOverLimit = computed(() => sourceText.value.length > MAX_SOURCE_CHARS)
const resultCount = computed(() => (resultText.value === null ? 0 : resultText.value.length))
const copyDisabled = computed(() => resultText.value === null || resultText.value === '')
const generateDisabled = computed(() => generating.value || sourceEmpty.value)

onMounted(() => {
  chapterId.value = snapshot.value.selectedDocumentId ?? ''
  notConfigured.value = !props.state.ai.configured()
  void store.load()
})

watch(
  () => store.loading.value,
  (loading, previous) => {
    // 载入结束后用库里的设置回显；本地已有未保存修改时不覆盖用户输入。
    if (previous === true && loading === false && store.dirty.value !== true) {
      const values = store.data.value
      mode.value = isWritingModeId(values.mode) ? values.mode : 'continue'
      instruction.value = typeof values.instruction === 'string' ? values.instruction : ''
      temperatureInput.value = typeof values.temperature === 'string' ? values.temperature : ''
      maxTokensInput.value = typeof values.maxTokens === 'string' ? values.maxTokens : ''
    }
  },
)

function onModeChange(id: WritingModeId): void {
  mode.value = id
  store.patch({ mode: id })
}

function onInstructionInput(event: Event): void {
  // 先同步本地镜像：保存状态变化触发重渲染时，:value 绑定不能把旧值回写进输入框。
  const raw = event.target instanceof HTMLTextAreaElement ? event.target.value : ''
  instruction.value = raw
  store.patch({ instruction: raw })
}

function onTemperatureInput(event: Event): void {
  const raw = event.target instanceof HTMLInputElement ? event.target.value : ''
  temperatureInput.value = raw
  store.patch({ temperature: raw })
}

function onMaxTokensInput(event: Event): void {
  const raw = event.target instanceof HTMLInputElement ? event.target.value : ''
  maxTokensInput.value = raw
  store.patch({ maxTokens: raw })
}

async function onBringIn(): Promise<void> {
  if (bringing.value || generating.value) return
  const targetId = chapterId.value !== '' ? chapterId.value : (snapshot.value.selectedDocumentId ?? '')
  if (targetId === '') {
    bringHint.value = WRITING_COPY.bringNoChapter
    return
  }
  bringing.value = true
  bringHint.value = null
  try {
    // 非当前章节：先把正文编辑器切过去（界面上已标注这一副作用），再读快照正文。
    if (targetId !== snapshot.value.selectedDocumentId) {
      const switched = await props.state.selectDocument(targetId)
      if (!switched) {
        bringHint.value = WRITING_COPY.bringFailed
        return
      }
    }
    const next = props.state.getSnapshot()
    if (next.body.trim() === '') {
      bringHint.value = WRITING_COPY.bringEmpty
      return
    }
    sourceText.value = next.body
  } finally {
    bringing.value = false
  }
}

function applyResult(result: AiResult): void {
  if (result.ok) {
    const parsed = parseWritingResult(result.text)
    genState.value = parsed.ok ? 'done' : 'failed'
    // 失败显原文：空结果也把原文留在结果框里，绝不静默丢弃。
    resultText.value = parsed.text
    errorMessage.value = parsed.ok ? null : parsed.message
    notConfigured.value = false
    return
  }
  genState.value = 'failed'
  resultText.value = null
  errorMessage.value = `${result.code}：${result.message}`
  notConfigured.value = result.code === 'AI_NOT_CONFIGURED'
}

async function onGenerate(): Promise<void> {
  if (generating.value) return
  const params = resolveSessionParams(temperatureInput.value, maxTokensInput.value)
  if (params.error !== null) {
    paramHint.value = params.error
    return
  }
  paramHint.value = null
  const built = buildWritingRequest(mode.value, sourceText.value, instruction.value, {
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
  })
  const sequence = generationSequence + 1
  generationSequence = sequence
  generating.value = true
  genState.value = 'generating'
  errorMessage.value = null
  cancelNote.value = null
  resultText.value = null
  notConfigured.value = false
  truncatedNotice.value = built.truncated ? WRITING_COPY.truncatedNotice : null
  try {
    const result: AiResult = await props.state.ai.complete(built.request)
    if (sequence !== generationSequence) return // 已取消：丢弃 pending 的 AiResult
    applyResult(result)
  } catch (thrown) {
    if (sequence !== generationSequence) return
    genState.value = 'failed'
    errorMessage.value = thrown instanceof Error ? thrown.message : String(thrown)
  } finally {
    if (sequence === generationSequence) {
      generating.value = false
    }
  }
}

function onCancel(): void {
  if (!generating.value) return
  // 取消仅忽略结果：序号前移，pending 的 AiResult 结算后被丢弃；模型侧请求不会中断。
  generationSequence += 1
  generating.value = false
  genState.value = 'idle'
  cancelNote.value = WRITING_COPY.cancelNote
}

function copyViaSelection(text: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

async function onCopy(): Promise<void> {
  if (generating.value) return
  const text = resultText.value
  if (text === null || text === '') return
  let copied = false
  try {
    const clipboard = navigator.clipboard
    if (clipboard !== undefined) {
      await clipboard.writeText(text)
      copied = true
    }
  } catch {
    copied = false
  }
  if (!copied) {
    copied = copyViaSelection(text)
  }
  copyState.value = copied ? WRITING_COPY.copied : WRITING_COPY.copyFailed
}

onUnmounted(() => {
  unsubscribe()
  store.dispose()
})
</script>

<template>
  <section class="creative-writing" data-testid="creative-writing-panel">
    <header class="creative-writing__header">
      <h2 class="creative-writing__title">{{ tab.name }}</h2>
      <p class="creative-writing__intro">{{ WRITING_COPY.intro }}</p>
    </header>

    <p
      v-if="notConfigured"
      class="creative-writing__notice"
      data-testid="creative-writing-not-configured"
    >
      {{ WRITING_COPY.notConfiguredGuide }}
    </p>

    <YfePanel :title="WRITING_COPY.sourceTitle" dense>
      <div v-if="chapters.length > 0" class="creative-writing__bring">
        <label class="creative-writing__field">
          <span class="creative-writing__field-label">{{ WRITING_COPY.chaptersLabel }}</span>
          <select
            v-model="chapterId"
            class="creative-writing__select"
            data-testid="creative-writing-chapter-select"
          >
            <option v-for="option in chapterOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <YfeButton
          :label="WRITING_COPY.bringLabel"
          :loading="bringing"
          :disabled="generating"
          data-testid="creative-writing-bring"
          @click="onBringIn"
        />
      </div>
      <p v-else class="creative-writing__empty" data-testid="creative-writing-empty-chapters">
        {{ WRITING_COPY.emptyChapters }}
      </p>
      <p v-if="chapters.length > 0" class="creative-writing__note">
        {{ WRITING_COPY.bringNote }}
      </p>
      <p
        v-if="bringHint !== null"
        class="creative-writing__hint"
        data-testid="creative-writing-bring-hint"
      >
        {{ bringHint }}
      </p>
      <textarea
        v-model="sourceText"
        class="creative-writing__textarea"
        data-testid="creative-writing-source"
        rows="8"
        :placeholder="WRITING_COPY.sourcePlaceholder"
      />
      <p class="creative-writing__meta" data-testid="creative-writing-source-meta">
        <span data-testid="creative-writing-source-chars">{{ sourceText.length }}</span>
        <span>{{ WRITING_COPY.charsUnit }}</span>
      </p>
      <p
        v-if="sourceOverLimit"
        class="creative-writing__notice"
        data-testid="creative-writing-source-overlimit"
      >
        {{ WRITING_COPY.sourceOverLimit }}
      </p>
      <p
        v-if="sourceEmpty"
        class="creative-writing__hint"
        data-testid="creative-writing-source-hint"
      >
        {{ WRITING_COPY.sourceRequired }}
      </p>
    </YfePanel>

    <YfePanel :title="WRITING_COPY.modeTitle" dense>
      <div
        class="creative-writing__modes"
        role="radiogroup"
        :aria-label="WRITING_COPY.modeLabel"
        data-testid="creative-writing-modes"
      >
        <label v-for="modeItem in writingModes" :key="modeItem.id" class="creative-writing__mode">
          <input
            type="radio"
            name="creative-writing-mode"
            :value="modeItem.id"
            :checked="mode === modeItem.id"
            :data-testid="`creative-writing-mode-${modeItem.id}`"
            @change="onModeChange(modeItem.id)"
          />
          <span>{{ modeItem.label }}</span>
        </label>
      </div>
      <p class="creative-writing__note" data-testid="creative-writing-mode-hint">
        {{ currentMode.hint }}
      </p>
      <label class="creative-writing__field">
        <span class="creative-writing__field-label">{{ WRITING_COPY.instructionLabel }}</span>
        <textarea
          class="creative-writing__textarea creative-writing__textarea--short"
          data-testid="creative-writing-instruction"
          rows="2"
          :value="instruction"
          :placeholder="WRITING_COPY.instructionPlaceholder"
          @input="onInstructionInput"
        />
      </label>
      <div class="creative-writing__params">
        <label class="creative-writing__field">
          <span class="creative-writing__field-label">{{ WRITING_COPY.temperatureLabel }}</span>
          <input
            class="creative-writing__input"
            data-testid="creative-writing-temperature"
            inputmode="decimal"
            :value="temperatureInput"
            @input="onTemperatureInput"
          />
        </label>
        <label class="creative-writing__field">
          <span class="creative-writing__field-label">{{ WRITING_COPY.maxTokensLabel }}</span>
          <input
            class="creative-writing__input"
            data-testid="creative-writing-max-tokens"
            inputmode="numeric"
            :value="maxTokensInput"
            @input="onMaxTokensInput"
          />
        </label>
      </div>
      <p class="creative-writing__note" data-testid="creative-writing-params-note">
        {{ WRITING_COPY.maxTokensHint }}
      </p>
      <p
        v-if="paramHint !== null"
        class="creative-writing__hint"
        data-testid="creative-writing-param-hint"
      >
        {{ paramHint }}
      </p>
    </YfePanel>

    <div class="creative-writing__actions" data-testid="creative-writing-actions">
      <YfeButton
        :label="WRITING_COPY.generateLabel"
        variant="primary"
        :loading="generating"
        :disabled="generateDisabled"
        data-testid="creative-writing-generate"
        @click="onGenerate"
      />
      <YfeButton
        v-if="generating"
        :label="WRITING_COPY.cancelLabel"
        data-testid="creative-writing-cancel"
        @click="onCancel"
      />
      <YfeStatusPill :status="saveStatus" data-testid="creative-writing-save-status" />
      <span class="creative-writing__state">
        <span>{{ WRITING_COPY.stateLabel }}</span>
        <span data-testid="creative-writing-state">{{ stateText }}</span>
      </span>
    </div>

    <p
      v-if="cancelNote !== null"
      class="creative-writing__hint"
      data-testid="creative-writing-cancel-note"
    >
      {{ cancelNote }}
    </p>
    <p
      v-if="errorMessage !== null"
      class="creative-writing__error"
      data-testid="creative-writing-error"
    >
      {{ errorMessage }}
    </p>
    <p
      v-if="storeError !== null"
      class="creative-writing__error"
      data-testid="creative-writing-save-error"
    >
      {{ storeError }}
    </p>

    <YfePanel :title="WRITING_COPY.resultTitle" dense>
      <textarea
        v-if="resultText !== null"
        class="creative-writing__textarea"
        data-testid="creative-writing-result"
        rows="10"
        readonly
        :value="resultText"
      />
      <p v-else class="creative-writing__empty" data-testid="creative-writing-result-empty">
        {{ WRITING_COPY.resultEmptyBox }}
      </p>
      <p
        v-if="truncatedNotice !== null"
        class="creative-writing__notice"
        data-testid="creative-writing-truncated"
      >
        {{ truncatedNotice }}
      </p>
      <p
        v-if="resultCount > 0"
        class="creative-writing__meta"
        data-testid="creative-writing-result-chars"
      >
        {{ resultCharsLine(resultCount) }}
      </p>
      <div class="creative-writing__actions">
        <YfeButton
          :label="WRITING_COPY.copyLabel"
          :disabled="copyDisabled"
          data-testid="creative-writing-copy"
          @click="onCopy"
        />
      </div>
      <p
        v-if="copyState !== null"
        class="creative-writing__hint"
        data-testid="creative-writing-copy-state"
      >
        {{ copyState }}
      </p>
      <p class="creative-writing__note" data-testid="creative-writing-insert-note">
        {{ WRITING_COPY.insertNote }}
      </p>
    </YfePanel>
  </section>
</template>

<style scoped>
.creative-writing {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  color: var(--yfe-color-text, #e8e8ea);
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.6;
}

.creative-writing__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.creative-writing__title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 15px);
  font-weight: 600;
}

.creative-writing__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #9a9aa2);
}

.creative-writing__bring {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--yfe-space-sm, 8px);
  margin-bottom: var(--yfe-space-sm, 8px);
}

.creative-writing__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  flex: 1 1 220px;
}

.creative-writing__field-label {
  color: var(--yfe-color-text-muted, #9a9aa2);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__select,
.creative-writing__input {
  box-sizing: border-box;
  height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a42);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface, #232329);
  color: var(--yfe-color-text, #e8e8ea);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-sm, 13px);
}

.creative-writing__textarea {
  box-sizing: border-box;
  width: 100%;
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a42);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface, #232329);
  color: var(--yfe-color-text, #e8e8ea);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1.6;
  resize: vertical;
}

.creative-writing__textarea--short {
  min-height: 48px;
}

.creative-writing__params {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.creative-writing__modes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
}

.creative-writing__mode {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  cursor: pointer;
}

.creative-writing__note {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #9a9aa2);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__hint {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-warning, #d9a53f);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__notice {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #d9a53f);
  border-radius: var(--yfe-radius-sm, 6px);
  color: var(--yfe-color-warning, #d9a53f);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__empty {
  margin: 0;
  color: var(--yfe-color-text-muted, #9a9aa2);
}

.creative-writing__meta {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #9a9aa2);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__error {
  margin: 0;
  color: var(--yfe-color-danger, #e5646c);
  font-size: var(--yfe-font-size-xs, 12px);
}

.creative-writing__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.creative-writing__state {
  display: inline-flex;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #9a9aa2);
  font-size: var(--yfe-font-size-xs, 12px);
}
</style>
