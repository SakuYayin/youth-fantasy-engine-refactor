<script setup lang="ts">
/**
 * 跑团互动面板（tavern-run）：AI 角色扮演对话（预览版简化实现）。
 *
 * - 对话区：消息列表（user/assistant/system 分色）+ 时间戳 + 滚动到底部；输入框
 *   Enter 发送 / Shift+Enter 换行，或点「发送」。
 * - 角色选择：从 `panel:tavern-card` 的面板状态行读取卡片列表（`values.items`）；
 *   无卡片显示引导。世界书条目从 `panel:tavern-world` 读取，启用的条目进系统提示。
 * - 发送流程：用户消息 push → `buildTavernSystemPrompt(选中卡, 世界条目)` +
 *   `recentMessages(messages, settings.contextMessages)` 拼 AiRequest →
 *   `props.state.ai.complete` → 回复作为 assistant 消息 push。生成中输入禁用。
 * - 新建会话（YfeDialog 确认，清空对话）+ 会话标题（可编辑，失焦保存）。
 * - 持久化走 `createPanelStore`（模板 `panel:tavern-run`）；增删改都是离散动作：
 *   `autoSaveMs: 0` 只在动作后显式 `store.save()`（与 tavern-card 同口径，
 *   避免无作品时反复自动保存报错）。
 * - AI 只走 `props.state.ai.complete`；本文件不 import 'node:*'、不发请求。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { YfeButton, YfeDialog, YfeStatusPill } from '@yfe/ui'

import type {
  TavernCardRecord,
  TavernMessage,
  TavernSettingsRecord,
  TavernWorldEntry,
} from '../tavern/types.js'
import { createPanelStore, panelTemplateId } from './panel-store.js'
import type { PanelProps } from './types.js'
import {
  DEFAULT_SESSION_TITLE,
  TAVERN_RUN_PANEL_TEXT,
  appendMessage,
  buildChatRequest,
  createDefaultPanelValues,
  failureNotice,
  formatMessageTime,
  makeMessage,
  messageCountLine,
  panelSaveStatus,
  parseCards,
  parseWorldEntries,
  resolveSelectedCard,
  resolveSessionTitle,
  resolveSettings,
  roleLabel,
  settingsLine,
} from './tavern-run-model.js'
import type { PanelSaveStatus, TavernRunPanelValues } from './tavern-run-model.js'

const props = defineProps<PanelProps>()

const TEXT = TAVERN_RUN_PANEL_TEXT
/** 角色卡 / 世界书来自同 schema 前缀（`panel:`）的其它面板状态行（只读）。 */
const CARD_TEMPLATE_ID = panelTemplateId('tavern-card')
const WORLD_TEMPLATE_ID = panelTemplateId('tavern-world')

const store = createPanelStore<TavernRunPanelValues>(
  props.state,
  props.tab.id,
  createDefaultPanelValues(),
  { autoSaveMs: 0 },
)

const cards = ref<TavernCardRecord[]>([])
const worldEntries = ref<TavernWorldEntry[]>([])
const generating = ref(false)
const draft = ref('')
const titleDraft = ref(DEFAULT_SESSION_TITLE)
const notConfigured = ref(false)
const notice = ref<string | null>(null)
const newDialogOpen = ref(false)
const listEl = ref<HTMLElement | null>(null)
/** 初次载入（卡片/世界书/面板状态三连查）期间为 true。 */
const initializing = ref(false)

let aiSequence = 0
let disposed = false

const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const loading = computed(() => store.loading.value)
const saving = computed(() => store.saving.value)
const storeError = computed(() => store.error.value)
const showLoading = computed(() => initializing.value || loading.value)
/** 展示用错误：AI 失败的 notice 优先，其次是保存失败的 store.error（已是「码：消息」）。 */
const errorText = computed<string | null>(() => notice.value ?? storeError.value)

const messages = computed<TavernMessage[]>(() => {
  const raw: unknown = store.data.value.messages
  return Array.isArray(raw) ? (raw as readonly TavernMessage[]).slice() : []
})
const settings = computed<TavernSettingsRecord>(() => resolveSettings(store.data.value.settings))
const sessionTitle = computed<string>(() => resolveSessionTitle(store.data.value.sessionTitle))
const selectedCard = computed<TavernCardRecord | null>(() =>
  resolveSelectedCard(cards.value, store.data.value.cardId),
)
const selectedCardId = computed<string>(() => selectedCard.value?.id ?? '')
const assistantLabel = computed<string | null>(() => selectedCard.value?.name ?? null)
const overview = computed(() => messageCountLine(messages.value.length))
const settingsHint = computed(() => settingsLine(settings.value))
const saveStatus = computed<PanelSaveStatus>(() =>
  panelSaveStatus(saving.value, store.dirty.value, storeError.value !== null),
)

/** 从快照提取卡片（loadSettingsEntities 整体替换快照，必须调用后立即提取）。 */
function extractCards(): TavernCardRecord[] {
  const rows = props.state.getSnapshot().settingsEntities
  const mine = rows.filter((row) => row.schemaTemplateId === CARD_TEMPLATE_ID && !row.deleted)
  const result: TavernCardRecord[] = []
  for (const row of mine) result.push(...parseCards(row.values.items))
  return result
}

/** 从快照提取世界书条目（同上，调用后立即提取）。 */
function extractWorldEntries(): TavernWorldEntry[] {
  const rows = props.state.getSnapshot().settingsEntities
  const mine = rows.filter((row) => row.schemaTemplateId === WORLD_TEMPLATE_ID && !row.deleted)
  const result: TavernWorldEntry[] = []
  for (const row of mine) result.push(...parseWorldEntries(row.values.items))
  return result
}

function syncTitleFromStore(): void {
  titleDraft.value = sessionTitle.value
}

async function init(): Promise<void> {
  initializing.value = true
  try {
    // 1. 角色卡：panel:tavern-card。
    try {
      await props.state.loadSettingsEntities({ schemaTemplateId: CARD_TEMPLATE_ID })
      cards.value = extractCards()
    } catch {
      cards.value = []
    }
    // 2. 世界书：panel:tavern-world（启用的条目由 buildTavernSystemPrompt 过滤）。
    try {
      await props.state.loadSettingsEntities({ schemaTemplateId: WORLD_TEMPLATE_ID })
      worldEntries.value = extractWorldEntries()
    } catch {
      worldEntries.value = []
    }
    // 3. 自己的面板状态：panel:tavern-run。
    await store.load()
    syncTitleFromStore()
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
  const content = draft.value.trim()
  if (content.length === 0) return
  if (!props.state.ai.configured()) {
    notice.value = TEXT.notConfigured
    return
  }
  const card = selectedCard.value
  if (card === null) {
    notice.value = TEXT.noCards
    return
  }
  const withUser = appendMessage(messages.value, makeMessage('user', content))
  store.patch({ messages: withUser, cardId: card.id })
  draft.value = ''
  notice.value = null
  generating.value = true
  const sequence = ++aiSequence
  try {
    const request = buildChatRequest(card, worldEntries.value, withUser, settings.value)
    const result = await props.state.ai.complete(request)
    if (sequence !== aiSequence || disposed) return // 迟到结果：丢弃
    if (!result.ok) {
      notice.value = failureNotice(result.code, result.message)
      await store.save()
      return
    }
    const current: unknown = store.data.value.messages
    const base = Array.isArray(current) ? (current as readonly TavernMessage[]) : withUser
    store.patch({ messages: appendMessage(base, makeMessage('assistant', result.text)) })
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

/** 确认新建会话：清空对话 + 标题回默认，保留角色卡。在飞回复一并作废。 */
async function onConfirmNewSession(): Promise<void> {
  newDialogOpen.value = false
  aiSequence += 1
  store.patch({ messages: [], sessionTitle: DEFAULT_SESSION_TITLE })
  titleDraft.value = DEFAULT_SESSION_TITLE
  draft.value = ''
  notice.value = null
  await store.save()
}

function onCancelNewSession(): void {
  newDialogOpen.value = false
}

function onCardChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value.length > 0 && value !== (store.data.value.cardId ?? '')) {
    store.patch({ cardId: value })
    void store.save()
  }
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
</script>

<template>
  <section class="tavern-run" data-testid="tavern-run-panel" :data-tab-id="props.tab.id">
    <header class="tavern-run__header">
      <h1 class="tavern-run__title">{{ title }}</h1>
      <p class="tavern-run__desc">{{ props.tab.description }}</p>
      <p class="tavern-run__intro" data-testid="tavern-run-intro">{{ TEXT.intro }}</p>
    </header>

    <div class="tavern-run__toolbar" data-testid="tavern-run-toolbar">
      <span class="tavern-run__overview" data-testid="tavern-run-overview">{{ overview }}</span>
      <span class="tavern-run__settings" data-testid="tavern-run-settings-line">{{ settingsHint }}</span>
      <YfeStatusPill :status="saveStatus" data-testid="tavern-run-save-status" />
    </div>

    <p v-if="notConfigured" class="tavern-run__banner" data-testid="tavern-run-unconfigured">
      {{ TEXT.notConfigured }}
    </p>
    <p v-if="errorText !== null" class="tavern-run__error" data-testid="tavern-run-error" role="alert">
      {{ errorText }}
    </p>

    <div class="tavern-run__session">
      <label class="tavern-run__field">
        <span class="tavern-run__field-label">{{ TEXT.sessionTitleLabel }}</span>
        <input
          class="tavern-run__title-input"
          data-testid="tavern-run-title-input"
          :value="titleDraft"
          :disabled="generating"
          @input="onTitleInput"
          @blur="onTitleBlur"
        />
      </label>
      <label v-if="cards.length > 0" class="tavern-run__field">
        <span class="tavern-run__field-label">{{ TEXT.cardLabel }}</span>
        <select
          class="tavern-run__card-select"
          data-testid="tavern-run-card-select"
          :value="selectedCardId"
          :disabled="generating"
          @change="onCardChange"
        >
          <option v-for="card in cards" :key="card.id" :value="card.id">{{ card.name }}</option>
        </select>
      </label>
    </div>
    <p v-if="cards.length === 0" class="tavern-run__no-cards" data-testid="tavern-run-no-cards">
      {{ TEXT.noCards }}
    </p>

    <div v-if="showLoading" class="tavern-run__state" data-testid="tavern-run-loading">
      {{ TEXT.loading }}
    </div>
    <ol
      v-else-if="messages.length > 0"
      ref="listEl"
      class="tavern-run__messages"
      data-testid="tavern-run-message-list"
      aria-live="polite"
    >
      <li
        v-for="message in messages"
        :key="message.id"
        class="tavern-run__msg"
        :class="`tavern-run__msg--${message.role}`"
        data-testid="tavern-run-message"
      >
        <div class="tavern-run__msg-head">
          <span class="tavern-run__role" data-testid="tavern-run-role">
            {{ roleLabel(message.role, assistantLabel) }}
          </span>
          <span
            v-if="formatMessageTime(message.createdAt).length > 0"
            class="tavern-run__time"
            data-testid="tavern-run-time"
          >
            {{ formatMessageTime(message.createdAt) }}
          </span>
        </div>
        <p class="tavern-run__content" data-testid="tavern-run-content">{{ message.content }}</p>
      </li>
    </ol>
    <div v-else class="tavern-run__state" data-testid="tavern-run-empty">{{ TEXT.empty }}</div>

    <p v-if="generating" class="tavern-run__state" data-testid="tavern-run-generating">
      {{ TEXT.generating }}
    </p>

    <div class="tavern-run__composer">
      <textarea
        v-model="draft"
        class="tavern-run__input"
        data-testid="tavern-run-input"
        :placeholder="TEXT.inputPlaceholder"
        :disabled="generating || showLoading"
        rows="3"
        @keydown.enter.exact.prevent="onSend"
      ></textarea>
      <div class="tavern-run__composer-actions">
        <YfeButton
          :label="TEXT.newSession"
          data-testid="tavern-run-new-session"
          :disabled="generating"
          @click="askNewSession"
        />
        <YfeButton
          :label="TEXT.send"
          variant="primary"
          data-testid="tavern-run-send"
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
      data-testid="tavern-run-new-dialog"
      @confirm="onConfirmNewSession"
      @cancel="onCancelNewSession"
    >
      <p>{{ TEXT.newSessionMessage }}</p>
    </YfeDialog>
  </section>
</template>

<style scoped>
.tavern-run {
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

.tavern-run__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-run__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 18px);
  font-weight: var(--yfe-font-weight-bold, 700);
}

.tavern-run__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__intro {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface-raised, #f1efe7);
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__banner,
.tavern-run__error,
.tavern-run__no-cards {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-radius: var(--yfe-radius-sm, 6px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__banner {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #b45309);
  color: var(--yfe-color-warning, #b45309);
}

.tavern-run__error {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-danger, #b91c1c);
  color: var(--yfe-color-danger, #b91c1c);
}

.tavern-run__no-cards {
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border-strong, #b9b4a5);
  color: var(--yfe-color-text-muted, #6b6a62);
}

.tavern-run__session {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
}

.tavern-run__field {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.tavern-run__field-label {
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
  white-space: nowrap;
}

.tavern-run__title-input,
.tavern-run__card-select {
  min-height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #ffffff);
  color: var(--yfe-color-text, #2b2a26);
  font-family: var(--yfe-font-family, inherit);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__title-input {
  width: 200px;
}

.tavern-run__messages {
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

.tavern-run__msg {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-left: 3px solid var(--yfe-color-border-strong, #b9b4a5);
  border-radius: var(--yfe-radius-sm, 6px);
  background: var(--yfe-color-surface, #faf9f5);
}

.tavern-run__msg--user {
  border-left-color: var(--yfe-color-accent, #2563eb);
}

.tavern-run__msg--assistant {
  border-left-color: var(--yfe-color-success, #16a34a);
}

.tavern-run__msg--system {
  border-left-color: var(--yfe-color-text-muted, #6b7280);
}

.tavern-run__msg-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
  margin-bottom: var(--yfe-space-xs, 4px);
}

.tavern-run__role {
  font-weight: var(--yfe-font-weight-bold, 700);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__time {
  color: var(--yfe-color-text-muted, #6b6a62);
  font-size: var(--yfe-font-size-sm, 12px);
}

.tavern-run__content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.tavern-run__state {
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #d8d4c8);
  border-radius: var(--yfe-radius-md, 8px);
  color: var(--yfe-color-text-muted, #6b6a62);
  text-align: center;
}

.tavern-run__composer {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.tavern-run__input {
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

.tavern-run__composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--yfe-space-sm, 8px);
}
</style>
