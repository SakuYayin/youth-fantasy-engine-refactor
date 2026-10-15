/**
 * 跑团互动面板（tavern-run）的纯逻辑层：AI 角色扮演对话（预览版简化实现）。
 *
 * 职责：文案常量、默认值、消息组装、AI 请求组装、库值防御解析与提示文案。
 * 本文件只做纯逻辑（不 import 'node:*'、不发请求）；副作用（store/AI 调用）都在
 * `tavern-run.vue`。共享记录类型复用 `../tavern/types.js`（该文件绝不改）。
 */

import type { AiErrorCode } from '../ai/types.js'
import type { AiRequest } from '../ai/types.js'
import type {
  TavernCardRecord,
  TavernMessage,
  TavernSettingsRecord,
  TavernWorldEntry,
} from '../tavern/types.js'
import { buildTavernSystemPrompt, newTavernId, recentMessages, tavernNow } from '../tavern/types.js'

/** AI 请求默认采样参数（任务书：temperature=0.7 / maxTokens=2048 / contextMessages=20）。 */
export const AI_RUN_TEMPERATURE = 0.7
export const AI_RUN_MAX_TOKENS = 2048
export const AI_RUN_CONTEXT_MESSAGES = 20
/** 新建会话的默认标题。 */
export const DEFAULT_SESSION_TITLE = '新会话'

/** 跑团互动面板的持久化数据（values，存模板 `panel:tavern-run`）。
 *  用 type 而非 interface：interface 没有隐式索引签名，
 *  过不了 `createPanelStore<T extends Record<string, unknown>>` 的约束。 */
export type TavernRunPanelValues = {
  messages: TavernMessage[]
  sessionTitle: string
  cardId: string | null
  settings: TavernSettingsRecord
}

/**
 * 默认值。
 * `settings.mode` 取共享类型 `TavernSettingsRecord` 注释的文档值 `'chat'`（常规）——
 * 任务书写的 `'normal'` 与注释（'chat'|'story'|'interview'）不一致，按冻结类型文件；
 * `settings.advanced` 是 `Record<string, string>`，默认空对象（任务书的 `false` 过不了类型）。
 */
export function createDefaultPanelValues(): TavernRunPanelValues {
  return {
    messages: [],
    sessionTitle: DEFAULT_SESSION_TITLE,
    cardId: null,
    settings: {
      mode: 'chat',
      temperature: AI_RUN_TEMPERATURE,
      maxTokens: AI_RUN_MAX_TOKENS,
      contextMessages: AI_RUN_CONTEXT_MESSAGES,
      advanced: {},
    },
  }
}

/** 面板静态文案（全中文）。 */
export const TAVERN_RUN_PANEL_TEXT = {
  intro: '预览版简化实现：单会话、无流式输出、无自动摘要记忆',
  loading: '正在载入会话…',
  empty: '还没有对话。在下方输入行动，开始这一局。',
  noCards: '先到『酒馆卡片』页签创建角色卡',
  noCardSelected: '请先选择一张角色卡，再开始对话。',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来开始对话。',
  generating: '正在生成回复…',
  send: '发送',
  newSession: '新建会话',
  newSessionTitle: '新建会话',
  newSessionConfirm: '清空并新建',
  newSessionMessage: '将清空当前对话并开始新的会话，确定继续吗？',
  sessionTitleLabel: '会话标题',
  cardLabel: '角色卡',
  inputPlaceholder: '写下你的行动或对白，Enter 发送（Shift+Enter 换行）',
  roleUser: '你',
  roleAssistant: '角色',
  roleSystem: '系统',
} as const

/** 消息行的保存状态收敛（与 tavern-card / bookbreak 同口径）。 */
export type PanelSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

/** saving → error → dirty → saved。 */
export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PanelSaveStatus {
  if (saving) return 'saving'
  if (hasError) return 'error'
  if (dirty) return 'dirty'
  return 'saved'
}

/** 组装一条消息（id 用 `newTavernId('msg')`、时间用 `tavernNow()`，均来自共享类型文件）。 */
export function makeMessage(role: TavernMessage['role'], content: string): TavernMessage {
  return { id: newTavernId('msg'), role, content, createdAt: tavernNow() }
}

/** 追加消息，不改传入数组。 */
export function appendMessage(
  messages: readonly TavernMessage[],
  message: TavernMessage,
): TavernMessage[] {
  return [...messages, message]
}

/** 消息时间戳显示：`MM-dd HH:mm`；无效时间返回空串。 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 消息列表的角色标签：user→「你」、assistant→选中卡名（缺省「角色」）、system→「系统」。 */
export function roleLabel(role: TavernMessage['role'], cardName: string | null): string {
  if (role === 'user') return TAVERN_RUN_PANEL_TEXT.roleUser
  if (role === 'system') return TAVERN_RUN_PANEL_TEXT.roleSystem
  return cardName !== null && cardName.length > 0 ? cardName : TAVERN_RUN_PANEL_TEXT.roleAssistant
}

/**
 * 把会话消息收敛成 AI 请求的 messages：
 * 截取最近 `limit` 条（`recentMessages`）→ 剔除 system 角色消息（AiRequest.messages
 * 只接受 user|assistant）→ 收敛为 `{role, content}`。
 */
export function toAiMessages(
  messages: readonly TavernMessage[],
  limit: number,
): AiRequest['messages'] {
  return recentMessages(messages, limit)
    .filter((message): message is TavernMessage & { role: 'user' | 'assistant' } => {
      return message.role !== 'system'
    })
    .map((message) => ({ role: message.role, content: message.content }))
}

/**
 * 组装 AI 请求：system = 角色卡 + 世界书（`buildTavernSystemPrompt` 内部过滤启用条目，
 * 都为空时返回 ''，此时不发 system 字段）；messages = 最近上下文；
 * 采样参数来自 `settings`。
 */
export function buildChatRequest(
  card: TavernCardRecord | null,
  worldEntries: readonly TavernWorldEntry[],
  messages: readonly TavernMessage[],
  settings: TavernSettingsRecord,
): AiRequest {
  const system = buildTavernSystemPrompt(card, worldEntries)
  // AiRequest.system 是 readonly：不能事后赋值，用条件展开拼进对象字面量。
  return {
    ...(system.length > 0 ? { system } : {}),
    messages: toAiMessages(messages, settings.contextMessages),
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  }
}

/** 选中卡解析：`cardId` 命中返回该卡；否则回落第一张；没有卡返回 null（纯显示回落）。 */
export function resolveSelectedCard(
  cards: readonly TavernCardRecord[],
  cardId: string | null,
): TavernCardRecord | null {
  if (cardId !== null) {
    const matched = cards.find((card) => card.id === cardId)
    if (matched !== undefined) return matched
  }
  return cards[0] ?? null
}

/**
 * 库值防御解析：`panel:tavern-card` 行的 `values.items` → `TavernCardRecord[]`。
 * store.data 是 ShallowRef，深层字段可能是坏数据——非对象/缺 id/缺名的条目整条丢弃。
 */
export function parseCards(value: unknown): TavernCardRecord[] {
  if (!Array.isArray(value)) return []
  const result: TavernCardRecord[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = record.id
    const name = record.name
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string') continue
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    result.push({
      id,
      name,
      description: typeof record.description === 'string' ? record.description : '',
      personality: typeof record.personality === 'string' ? record.personality : '',
      firstMessage: typeof record.firstMessage === 'string' ? record.firstMessage : '',
      tags,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    })
  }
  return result
}

/** 库值防御解析：`panel:tavern-world` 行的 `values.items` → `TavernWorldEntry[]`（坏数据丢弃）。 */
export function parseWorldEntries(value: unknown): TavernWorldEntry[] {
  if (!Array.isArray(value)) return []
  const result: TavernWorldEntry[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = record.id
    const content = record.content
    if (typeof id !== 'string' || id.length === 0 || typeof content !== 'string') continue
    result.push({
      id,
      keywords: typeof record.keywords === 'string' ? record.keywords : '',
      content,
      enabled: record.enabled === true,
      order:
        typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : 0,
    })
  }
  return result
}

/** 设置值兜底：库值可能缺字段/坏类型 → 与默认值浅合并、逐字段校验（库值覆盖默认值）。 */
export function resolveSettings(value: unknown): TavernSettingsRecord {
  const defaults = createDefaultPanelValues().settings
  if (typeof value !== 'object' || value === null) return { ...defaults }
  const merged = { ...defaults, ...(value as Record<string, unknown>) }
  const advanced =
    typeof merged.advanced === 'object' && merged.advanced !== null && !Array.isArray(merged.advanced)
      ? Object.fromEntries(
          Object.entries(merged.advanced as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : { ...defaults.advanced }
  return {
    mode: typeof merged.mode === 'string' ? merged.mode : defaults.mode,
    temperature:
      typeof merged.temperature === 'number' && Number.isFinite(merged.temperature)
        ? merged.temperature
        : defaults.temperature,
    maxTokens:
      typeof merged.maxTokens === 'number' && Number.isFinite(merged.maxTokens)
        ? merged.maxTokens
        : defaults.maxTokens,
    contextMessages:
      typeof merged.contextMessages === 'number' &&
      Number.isFinite(merged.contextMessages) &&
      merged.contextMessages > 0
        ? merged.contextMessages
        : defaults.contextMessages,
    advanced,
  }
}

/** 会话标题兜底：库值是非空字符串才采用，否则默认标题。 */
export function resolveSessionTitle(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) return value
  return DEFAULT_SESSION_TITLE
}

/** 概览行：共 N 条消息。 */
export function messageCountLine(count: number): string {
  return `共 ${count} 条消息`
}

/** 设置摘要行（只读提示）。 */
export function settingsLine(settings: TavernSettingsRecord): string {
  return `上下文：最近 ${settings.contextMessages} 条 · 温度：${settings.temperature} · 最大输出：${settings.maxTokens}`
}

/** AI 失败提示：未配置 → 引导文案；其它如实显示「错误码：消息」。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_RUN_PANEL_TEXT.notConfigured
  return `${code}：${message}`
}
