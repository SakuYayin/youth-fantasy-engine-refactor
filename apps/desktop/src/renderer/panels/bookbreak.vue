<script setup lang="ts">
/**
 * 一键拆书面板（tab.id = `bookbreak`）。
 *
 * 只做渲染与调用：状态机、AI 请求、面板状态持久化按任务书接
 * `props.state.ai` 与 `createPanelStore`，提示词 / 截取 / 分节解析在
 * `bookbreak-model.ts` 纯函数里。AI 只走 `props.state.ai.complete(request)`
 * （渲染层 CSP 禁网，模型请求由 main 进程代理），不 import 'node:*'、不 fetch。
 *
 * 状态机：idle / running / done / failed。请求中按钮 loading 且可「取消」
 * —— AiPort 没有 abort，取消只是把 pending 的 AiResult 丢弃（如实提示）。
 * 未配置模型不禁用面板，只给显式引导；无当前作品时保存按钮提示先建作品。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { PanelProps } from './types.js'
import {
  BOOKBREAK_PANEL_TEXT,
  RAW_SECTION_KEY,
  buildBreakRequest,
  copyReportText,
  createDefaultPanelData,
  failureNotice,
  isBlankText,
  parseBreakReport,
  truncateInput,
  truncatedNoticeText,
  type BookBreakPanelData,
  type BreakSection,
} from './bookbreak-model.js'
import { createPanelStore } from './panel-store.js'

const props = defineProps<PanelProps>()

const TEXT = BOOKBREAK_PANEL_TEXT

/** 页签标题：页签名为空时回落页签 id。 */
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

// ---- 面板状态（按作品存，模板 panel:bookbreak）。拆书报告是显式保存的一次性
//      产物，用 autoSaveMs: 0 只手动 save，无作品时也不会反复自动保存报错。----
const store = createPanelStore<BookBreakPanelData>(
  props.state,
  props.tab.id,
  createDefaultPanelData(),
  { autoSaveMs: 0 },
)
const storeData = store.data
const storeSaving = store.saving
const storeDirty = store.dirty
const storeError = store.error

// ---- 输入与拆书状态机 ----
const inputText = ref('')
const phase = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const reportText = ref('')
const reportModel = ref('')
const sections = ref<readonly BreakSection[]>([])
const aiConfigured = ref(true)
const message = ref<string | null>(TEXT.idleHint)
const copyState = ref<'ok' | 'failed' | null>(null)
const saveHint = ref<string | null>(null)

/** 序号守卫：取消 / 重新开始 / 卸载后，在飞结果按序号丢弃（AiPort 没有 abort）。 */
let runSeq = 0
let disposed = false

const running = computed(() => phase.value === 'running')
const startLabel = computed(() => (running.value ? TEXT.starting : TEXT.start))
const inputInfo = computed(() => truncateInput(inputText.value))
const truncated = computed(() => inputInfo.value.truncated)
const truncatedNotice = computed(() =>
  truncatedNoticeText(inputInfo.value.originalChars, inputInfo.value.keptChars),
)
const blank = computed(() => isBlankText(inputText.value))
const rawFallback = computed(() => sections.value.some((section) => section.key === RAW_SECTION_KEY))
const saveHintClass = computed(() =>
  saveHint.value === TEXT.saved
    ? 'bookbreak__hint bookbreak__hint--ok'
    : 'bookbreak__hint bookbreak__hint--warn',
)

onMounted(() => {
  aiConfigured.value = props.state.ai.configured()
  void loadStore()
})

onUnmounted(() => {
  disposed = true
  store.dispose()
})

/** 挂载时 load()：载入当前作品保存的上次拆书报告（无则保持默认空状态）。 */
async function loadStore(): Promise<void> {
  await store.load()
  if (disposed) return
  const saved = storeData.value
  if (saved.report.length > 0) {
    applyReport(saved.report, saved.model)
    message.value = TEXT.loadedFromStore
  }
}

/** 把报告文本套到状态机上（完成态 + 分节解析）。 */
function applyReport(text: string, model: string): void {
  reportText.value = text
  reportModel.value = model
  sections.value = parseBreakReport(text)
  phase.value = 'done'
}

async function onStart(): Promise<void> {
  if (running.value) return
  if (blank.value) {
    message.value = TEXT.emptyText
    return
  }
  if (!props.state.ai.configured()) {
    aiConfigured.value = false
    message.value = TEXT.notConfigured
    return
  }
  aiConfigured.value = true
  const built = buildBreakRequest(inputText.value)
  const seq = ++runSeq
  phase.value = 'running'
  message.value = null
  copyState.value = null
  saveHint.value = null
  let result: AiResult
  try {
    result = await props.state.ai.complete(built.request)
  } catch (thrown) {
    if (seq !== runSeq || disposed) return
    phase.value = 'failed'
    message.value = `${TEXT.failed}：${thrown instanceof Error ? thrown.message : String(thrown)}`
    return
  }
  if (seq !== runSeq || disposed) return // 已取消 / 已卸载：pending 结果直接丢弃
  if (result.ok) {
    applyReport(result.text, result.model ?? '')
    // 报告写进面板状态（按作品持久化的数据源；真正落库走「保存」按钮）
    store.patch({ report: result.text, model: result.model ?? '' })
    message.value = sections.value.length === 0 ? TEXT.reportEmpty : null
  } else {
    phase.value = 'failed'
    if (result.code === 'AI_NOT_CONFIGURED') aiConfigured.value = false
    message.value = failureNotice(result.code, result.message)
  }
}

/** 取消：AiPort 没有 abort，这里只让在飞结果按序号被丢弃（如实提示）。 */
function onCancel(): void {
  runSeq += 1
  phase.value = 'idle'
  message.value = TEXT.cancelled
}

async function onCopy(): Promise<void> {
  const ok = await copyReportText(reportText.value)
  if (disposed) return
  copyState.value = ok ? 'ok' : 'failed'
}

async function onSave(): Promise<void> {
  saveHint.value = null
  if (props.state.getSnapshot().projectId === null) {
    saveHint.value = TEXT.noProject
    return
  }
  store.patch({ report: reportText.value, model: reportModel.value })
  const ok = await store.save()
  if (disposed) return
  if (ok) saveHint.value = TEXT.saved
  // 失败：store.error 已带「code:message」，面板显示即可；本地 data 不丢
}
</script>

<template>
  <section class="bookbreak" data-testid="bookbreak-panel" :data-tab-id="props.tab.id">
    <header class="bookbreak__header">
      <h1 class="bookbreak__title">{{ title }}</h1>
      <p class="bookbreak__intro">{{ TEXT.intro }}</p>
      <p class="bookbreak__privacy">{{ TEXT.privacyNote }}</p>
    </header>

    <p
      v-if="!aiConfigured"
      class="bookbreak__notice bookbreak__notice--warn"
      data-testid="bookbreak-unconfigured"
    >
      {{ TEXT.notConfigured }}
    </p>

    <div class="bookbreak__input">
      <div class="bookbreak__input-head">
        <label class="bookbreak__input-label" for="bookbreak-input">{{ TEXT.inputLabel }}</label>
        <span class="bookbreak__input-count" data-testid="bookbreak-char-count">
          {{ inputText.length }}{{ TEXT.charCountUnit }}
        </span>
      </div>
      <textarea
        id="bookbreak-input"
        v-model="inputText"
        class="bookbreak__textarea"
        :disabled="running"
        spellcheck="false"
        :placeholder="TEXT.inputPlaceholder"
        data-testid="bookbreak-input"
      />
      <p
        v-if="truncated"
        class="bookbreak__notice bookbreak__notice--warn"
        data-testid="bookbreak-truncated"
      >
        {{ truncatedNotice }}
      </p>
    </div>

    <div class="bookbreak__toolbar">
      <YfeButton
        :label="startLabel"
        variant="primary"
        :loading="running"
        :disabled="blank"
        data-testid="bookbreak-start"
        @click="onStart"
      />
      <YfeButton
        v-if="running"
        :label="TEXT.cancel"
        variant="ghost"
        data-testid="bookbreak-cancel"
        @click="onCancel"
      />
      <span v-if="running" class="bookbreak__cancel-hint" data-testid="bookbreak-cancel-hint">{{
        TEXT.cancelHint
      }}</span>
    </div>

    <p v-if="message !== null" class="bookbreak__state" data-testid="bookbreak-message">{{ message }}</p>

    <div v-if="phase === 'done'" class="bookbreak__report" data-testid="bookbreak-report">
      <div class="bookbreak__report-head">
        <h2 class="bookbreak__report-title">{{ TEXT.reportTitle }}</h2>
        <span v-if="reportModel !== ''" class="bookbreak__report-model">
          {{ TEXT.modelLabel }}：{{ reportModel }}
        </span>
      </div>
      <p v-if="sections.length === 0" class="bookbreak__state">{{ TEXT.reportEmpty }}</p>
      <p v-if="rawFallback" class="bookbreak__notice">{{ TEXT.rawFallbackHint }}</p>
      <section
        v-for="(section, index) in sections"
        :key="`${section.key}-${index}`"
        class="bookbreak__section"
        :data-testid="`bookbreak-section-${section.key}`"
      >
        <h3 class="bookbreak__section-title">{{ section.title }}</h3>
        <p class="bookbreak__section-body">{{ section.body }}</p>
      </section>
      <div class="bookbreak__actions">
        <YfeButton :label="TEXT.copy" variant="ghost" data-testid="bookbreak-copy" @click="onCopy" />
        <YfeButton
          :label="TEXT.save"
          variant="primary"
          :loading="storeSaving"
          data-testid="bookbreak-save"
          @click="onSave"
        />
        <span
          v-if="copyState === 'ok'"
          class="bookbreak__hint bookbreak__hint--ok"
          data-testid="bookbreak-copied"
        >
          {{ TEXT.copied }}
        </span>
        <span
          v-else-if="copyState === 'failed'"
          class="bookbreak__hint bookbreak__hint--warn"
          data-testid="bookbreak-copy-failed"
        >
          {{ TEXT.copyFailed }}
        </span>
        <span v-if="saveHint !== null" :class="saveHintClass" data-testid="bookbreak-save-hint">
          {{ saveHint }}
        </span>
      </div>
      <p v-if="storeDirty && !storeSaving && storeError === null" class="bookbreak__hint">
        {{ TEXT.dirtyHint }}
      </p>
      <p
        v-if="storeError !== null"
        class="bookbreak__state bookbreak__state--error"
        data-testid="bookbreak-save-error"
      >
        {{ storeError }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.bookbreak {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-4, 16px);
  color: var(--yfe-text-primary, #1f2937);
  font-size: var(--yfe-font-size-sm, 14px);
  line-height: 1.6;
}

.bookbreak__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-2, 8px);
}

.bookbreak__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 18px);
  font-weight: 600;
  color: var(--yfe-text-primary, #1f2937);
}

.bookbreak__intro,
.bookbreak__privacy {
  margin: 0;
  color: var(--yfe-text-secondary, #6b7280);
}

.bookbreak__input {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-2, 8px);
}

.bookbreak__input-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--yfe-space-2, 8px);
}

.bookbreak__input-label {
  font-weight: 600;
}

.bookbreak__input-count {
  color: var(--yfe-text-tertiary, #9ca3af);
  font-variant-numeric: tabular-nums;
}

.bookbreak__textarea {
  min-height: 200px;
  padding: var(--yfe-space-3, 12px);
  border: 1px solid var(--yfe-border-color, #d1d5db);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-bg-surface, #ffffff);
  color: var(--yfe-text-primary, #1f2937);
  font: inherit;
  resize: vertical;
}

.bookbreak__textarea:focus {
  outline: none;
  border-color: var(--yfe-color-primary, #2563eb);
}

.bookbreak__textarea:disabled {
  opacity: 0.6;
}

.bookbreak__toolbar {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-3, 12px);
  flex-wrap: wrap;
}

.bookbreak__cancel-hint {
  color: var(--yfe-text-tertiary, #9ca3af);
  font-size: var(--yfe-font-size-xs, 12px);
}

.bookbreak__state {
  margin: 0;
  color: var(--yfe-text-secondary, #6b7280);
}

.bookbreak__state--error {
  color: var(--yfe-color-danger, #dc2626);
}

.bookbreak__notice {
  margin: 0;
  padding: var(--yfe-space-2, 8px) var(--yfe-space-3, 12px);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-bg-muted, #f3f4f6);
  color: var(--yfe-text-secondary, #6b7280);
}

.bookbreak__notice--warn {
  background: var(--yfe-color-warning-bg, #fef3c7);
  color: var(--yfe-color-warning-text, #92400e);
}

.bookbreak__report {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-3, 12px);
  padding: var(--yfe-space-4, 16px);
  border: 1px solid var(--yfe-border-color, #d1d5db);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-bg-surface, #ffffff);
}

.bookbreak__report-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--yfe-space-2, 8px);
}

.bookbreak__report-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 16px);
  font-weight: 600;
}

.bookbreak__report-model {
  color: var(--yfe-text-tertiary, #9ca3af);
  font-size: var(--yfe-font-size-xs, 12px);
}

.bookbreak__section {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-1, 4px);
}

.bookbreak__section-title {
  margin: 0;
  font-weight: 600;
  color: var(--yfe-color-primary, #2563eb);
}

.bookbreak__section-body {
  margin: 0;
  white-space: pre-wrap;
}

.bookbreak__actions {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-3, 12px);
  flex-wrap: wrap;
}

.bookbreak__hint {
  font-size: var(--yfe-font-size-xs, 12px);
  color: var(--yfe-text-secondary, #6b7280);
}

.bookbreak__hint--ok {
  color: var(--yfe-color-success, #16a34a);
}

.bookbreak__hint--warn {
  color: var(--yfe-color-warning-text, #92400e);
}
</style>
