<script setup lang="ts">
/**
 * 自由对话面板（tavern-free）：不绑定角色卡的自由 AI 对话/头脑风暴（预览版简化实现）。
 *
 * - 对话区：消息列表（user/assistant/system 分色）+ 时间戳 + 滚动到底部；输入框
 *   Enter 发送 / Shift+Enter 换行，或点「发送」。
 * - 可选前置设定：「对话前提」textarea，每次请求拼进 system；留空则不带 system。
 * - 发送流程：用户消息 push → 前提拼 system + recentMessages(messages,
 *   settings.contextMessages) 拼 AiRequest → props.state.ai.complete → 回复 push。
 *   生成中 loading、输入禁用。
 * - 未配置模型：显示引导（「模型设置」页签），点击发送后如实提示。
 * - 新建会话（YfeDialog 确认清空）+ 会话标题（可编辑，失焦保存）。
 * - 持久化走 `createPanelStore`（模板 `panel:tavern-free`）；增删改都是离散动作：
 *   `autoSaveMs: 0` 只在动作后显式 `store.save()`（与 tavern-card / tavern-run 同口径，
 *   避免无作品时反复自动保存报错）。
 * - AI 只走 `props.state.ai.complete`；本文件不 import 'node:*'、不发请求。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type { TavernMessage, TavernSettingsRecord } from '../tavern/types.js'
import { createPanelStore } from './panel-store.js'
import type { PanelProps } from './types.js'
import {
  DEFAULT_SESSION_TITLE,
  TAVERN_FREE_PANEL_TEXT,
  appendMessage,
  buildFreeChatRequest,
  createDefaultPanelValues,
  failureNotice,
  formatMessageTime,
  makeMessage,
  messageCountLine,
  newSessionValues,
  panelSaveStatus,
  parseMessages,
  resolvePremise,
  resolveSessionTitle,
  resolveSettings,
  roleLabel,
  settingsLine,
  validateDraft,
} from './tavern-free-model.js'
import type { PanelSaveStatus, TavernFreePanelValues } from './tavern-free-model.js'

const props = defineProps<PanelProps>()

const TEXT = TAVERN_FREE_PANEL_TEXT

const store = createPanelStore<TavernFreePanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

const generating = ref(false)
const draft = ref('')
const titleDraft = ref(DEFAULT_SESSION_TITLE)
const premiseDraft = ref('')
const notConfigured = ref(false)
const notice = ref<string | null>(null)
const newDialogOpen = ref(false)
const listEl = ref<HTMLElement | null>(null)
/** 初次载入面板状态期间为 true。 */
const initializing = ref(false)

let aiSequence = 0
let disposed = false

const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const loading = computed(() => store.loading.value)
const saving = computed(() => store.saving.value)
const storeError = computed(() => store.error.value)
const showLoading = computed(() => initializing.value || loading.value)
/** 展示用错误：AI 失败/输入校验的 notice 优先，其次是保存失败的 store.error（已是「码：消息」）。 */
const errorText = computed<string | null>(() => notice.value ?? storeError.value)

const messages = computed<TavernMessage[]>(() => parseMessages(store.data.value.messages))
const settings = computed<TavernSettingsRecord>(() => resolveSettings(store.data.value.settings))
const sessionTitle = computed<string>(() => resolveSessionTitle(store.data.value.sessionTitle))
const premise = computed<string>(() => resolvePremise(store.data.value.premise))
const overview = computed(() => messageCountLine(messages.value.length))
const settingsHint = computed(() => settingsLine(settings.value))
const saveStatus = computed<PanelSaveStatus>(() =>
  panelSaveStatus(saving.value, store.dirty.value, storeError.value !== null),
)

/** 本地镜像与 store 对齐（load 整体替换后调用）。 */
function syncDraftsFromStore(): void {
  titleDraft.value = sessionTitle.value
  premiseDraft.value = premise.value
}

async function init(): Promise<void> {
  initializing.value = true
  try {
    await store.load()
    syncDraftsFromStore()
  } finally {
    initializing.value = false
  }
}

onMounted(() => {
  notConfigured.value = !props.state.ai.configured()
  void init()
})

onUnmounted(() => {
  disposed = true
  store.dispose()
})

function scrollToBottom(): void {
  void nextTick(() => {
    const el = listEl.value
    if (el !== null) el.scrollTop = el.scrollHeight
  })
}

watch(
  () => messages.value.length,
  () => scrollToBottom(),
)
watch(showLoading, (value) => {
  if (!value) scrollToBottom()
})

/** 发送：守卫 → 用户消息入库 → AI 请求 → 回复入库。失败也保存（用户消息不丢）。 */
async function onSend(): Promise<void> {
  if (generating.value || showLoading.value) return
  const draftError = validateDraft(draft.value)
  if (draftError !== null) {
    notice.value = draftError
    return
  }
  if (!props.state.ai.configured()) {
    notConfigured.value = true
    notice.value = TEXT.notConfigured
    return
  }
  const withUser = appendMessage(messages.value, makeMessage('user', draft.value.trim()))
  store.patch({ messages: withUser })
  draft.value = ''
  notice.value = null
  generating.value = true
  const sequence = ++aiSequence
  try {
    const request = buildFreeChatRequest(premiseDraft.value, withUser, settings.value)
    const result = await props.state.ai.complete(request)
    if (sequence !== aiSequence || disposed) return // 迟到结果：丢弃
    if (!result.ok) {
      if (result.code === 'AI_NOT_CONFIGURED') notConfigured.value = true
      notice.value = failureNotice(result.code, result.message)
      await store.save()
      return
    }
    const base = parseMessages(store.data.value.messages)
    store.patch({
      messages: appendMessage(base.length > 0 ? base : withUser, makeMessage('assistant', result.text)),
    })
    await store.save()
  } catch (thrown) {
    if (sequence !== aiSequence || disposed) return
    notice.value = failureNotice(
      'AI_UPSTREAM_ERROR',
      thrown instanceof Error ? thrown.message : String(thrown),
    )
    await store.save()
  } finally {
    if (sequence === aiSequence) generating.value = false
  }
}

function askNewSession(): void {
  newDialogOpen.value = true
}

/** 确认新建会话：清空对话 + 标题回默认，保留对话前提与设置。在飞回复一并作废。 */
async function onConfirmNewSession(): Promise<void> {
  newDialogOpen.value = false
  aiSequence += 1
  store.patch(newSessionValues(store.data.value))
  titleDraft.value = DEFAULT_SESSION_TITLE
  draft.value = ''
  notice.value = null
  await store.save()
}

function onCancelNewSession(): void {
  newDialogOpen.value = false
}

/** 受控输入：@input 里同步本地镜像 + 入库标脏。 */
function onTitleInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  titleDraft.value = value
  store.patch({ sessionTitle: value })
}

function onTitleBlur(): void {
  if (store.dirty.value) void store.save()
}

function onPremiseInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value
  premiseDraft.value = value
  store.patch({ premise: value })
}

function onPremiseBlur(): void {
  if (store.dirty.value) void store.save()
}
</script>

<template>
  <section class="tavern-free" data-testid="tavern-free-panel" :data-tab-id="props.tab.id">
    <header class="tavern-free__header">
      <h1 class="tavern-free__title">{{ title }}</h1>
      <p class="tavern-free__desc">{{ props.tab.description }}</p>
      <p class="tavern-free__intro" data-testid="tavern-free-intro">{{ TEXT.intro }}</p>
    </header>

    <div class="tavern-free__toolbar" data-testid="tavern-free-toolbar">
      <span class="tavern-free__overview" data-testid="tavern-free-overview">{{ overview }}</span>
      <span class="tavern-free__settings" data-testid="tavern-free-settings-line">{{ settingsHint }}</span>
      <YfeStatusPill :status="saveStatus" data-testid="tavern-free-save-status" />
    </div>

    <p v-if="notConfigured" class="tavern-free__banner" data-testid="tavern-free-unconfigured">
      {{ TEXT.notConfigured }}
    </p>
    <p v-if="errorText !== null" class="tavern-free__error" data-testid="tavern-free-error" role="alert">
      {{ errorText }}
    </p>

    <div class="tavern-free__session">
      <label class="tavern-free__field">
        <span class="tavern-free__field-label">{{ TEXT.sessionTitleLabel }}</span>
        <input
          class="tavern-free__title-input"
          data-testid="tavern-free-title-input"
          :value="titleDraft"
          :disabled="generating"
          @input="onTitleInput"
          @blur="onTitleBlur"
        />
      </label>
    </div>

    <label class="tavern-free__premise">
      <span class="tavern-free__field-label">{{ TEXT.premiseLabel }}</span>
      <textarea
        class="tavern-free__premise-input"
        data-testid="tavern-free-premise"
        :value="premiseDraft"
        :placeholder="TEXT.premisePlaceholder"
        :disabled="generating"
        rows="2"
        @input="onPremiseInput"
        @blur="onPremiseBlur"
      ></textarea>
      <span class="tavern-free__premise-hint">{{ TEXT.premiseHint }}</span>
    </label>

    <div v-if="showLoading" class="tavern-free__state" data-testid="tavern-free-loading">
      {{ TEXT.loading }}
    </div>
    <ol
      v-else-if="messages.length > 0"
      ref="listEl"
      class="tavern-free__messages"
      data-testid="tavern-free-message-list"
      aria-live="polite"
    >
      <li
        v-for="message in messages"
        :key="message.id"
        class="tavern-free__msg"
        :class="`tavern-free__msg--${message.role}`"
        data-testid="tavern-free-message"
      >
        <div class="tavern-free__msg-head">
          <span class="tavern-free__role" data-testid="tavern-free-role">
            {{ roleLabel(message.role) }}
          </span>
          <span
            v-if="formatMessageTime(message.createdAt).length > 0"
            class="tavern-free__time"
            data-testid="tavern-free-time"
          >
            {{ formatMessageTime(message.createdAt) }}
          </span>
        </div>
        <p class="tavern-free__content" data-testid="tavern-free-content">{{ message.content }}</p>
      </li>
    </ol>
    <div v-else class="tavern-free__state" data-testid="tavern-free-empty">{{ TEXT.empty }}</div>

    <p v-if="generating" class="tavern-free__state" data-testid="tavern-free-generating">
      {{ TEXT.generating }}
    </p>

    <div class="tavern-free__composer">
      <textarea
        v-model="draft"
        class="tavern-free__input"
        data-testid="tavern-free-input"
        :placeholder="TEXT.inputPlaceholder"
        :disabled="generating || showLoading"
        rows="3"
        @keydown.enter.exact.prevent="onSend"
      ></textarea>
      <div class="tavern-free__composer-actions">
        <YfeButton
          :label="TEXT.newSession"
          data-testid="tavern-free-new-session"
          :disabled="generating"
          @click="askNewSession"
        />
        <YfeButton
          :label="TEXT.send"
          variant="primary"
          data-testid="tavern-free-send"
          :disabled="generating || showLoading"
          :loading="generating"
          @click="onSend"
        />
      </div>
    </div>

    <YfeDialog
      :open="newDialogOpen"
      :title="TEXT.newSessionTitle"
      :confirm-label="TEXT.newSessionConfirm"
      tone="danger"
      data-testid="tavern-free-new-dialog"
      @confirm="onConfirmNewSession"
      @cancel="onCancelNewSession"
    >
      <p>{{ TEXT.newSessionMessage }}</p>
    </YfeDialog>
  </section>
</template>

<style scoped>
.tavern-free {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-lg, 12px);
  background: var(--yfe-color-surface, #faf9f5);
  color: var(--yfe-color-text, #2b2a26);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-md, 14px);
}

.tavern-free__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-free__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 18px);
  font-weight: var(--yfe-font-weight-bold, 700);
}

.tavern-free__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__intro {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface-raised, #f1efe7);
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__banner,
.tavern-free__error {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-radius: var(--yfe-radius-sm, 6px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__banner {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #b45309);
  color: var(--yfe-color-warning, #b45309);
}

.tavern-free__error {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-danger, #b91c1c);
  color: var(--yfe-color-danger, #b91c1c);
}

.tavern-free__session {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
}

.tavern-free__field {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-free__field-label {
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
  white-space: nowrap;
}

.tavern-free__title-input {
  min-height: var(--yfe-size-control-height, 32px);
  width: 200px;
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #ffffff);
  color: var(--yfe-color-text, #2b2a26);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__premise {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-free__premise-input {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #ffffff);
  color: var(--yfe-color-text, #2b2a26);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.6);
  resize: vertical;
}

.tavern-free__premise-hint {
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__messages {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  margin: 0;
  padding: var(--yfe-space-md, 12px);
  max-height: 420px;
  overflow-y: auto;
  list-style: none;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #ffffff);
}

.tavern-free__msg {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-left: 3px solid var(--yfe-color-border-strong, #b9b4a5);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface, #faf9f5);
}

.tavern-free__msg--user {
  border-left-color: var(--yfe-color-accent, #2563eb);
}

.tavern-free__msg--assistant {
  border-left-color: var(--yfe-color-success, #16a34a);
}

.tavern-free__msg--system {
  border-left-color: var(--yfe-color-text-muted, #6b7280);
}

.tavern-free__msg-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
  margin-bottom: var(--yfe-space-xs, 4px);
}

.tavern-free__role {
  font-weight: var(--yfe-font-weight-bold, 700);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__time {
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-free__content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.tavern-free__state {
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  color: var(--yfe-color-text-muted, #6b6a62);
  text-align: center;
}

.tavern-free__composer {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-free__input {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #ffffff);
  color: var(--yfe-color-text, #2b2a26);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.6);
  resize: vertical;
}

.tavern-free__composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--yfe-space-sm, 8px);
}
</style>
