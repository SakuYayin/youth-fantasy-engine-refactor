/**
 * 自由对话面板（tavern-free）的纯逻辑层：不绑定角色卡的自由 AI 对话/头脑风暴
 * （预览版简化实现）。
 *
 * 职责：文案常量、默认值、消息组装、AI 请求组装、库值防御解析与提示文案。
 * 本文件只做纯逻辑（不 import 'node:*'、不发请求）；副作用（store/AI 调用）都在
 * `tavern-free.vue`。共享记录类型复用 `../tavern/types.js`（该文件绝不改）。
 */

import type { AiErrorCode } from '../ai/types.js'
import type { AiRequest } from '../ai/types.js'
import type { TavernMessage, TavernSettingsRecord } from '../tavern/types.js'
import { newTavernId, recentMessages, tavernNow } from '../tavern/types.js'

/** AI 请求默认采样参数（任务书：mode='free' / temperature=0.9 / maxTokens=2048 / contextMessages=20）。 */
export const AI_FREE_TEMPERATURE = 0.9
export const AI_FREE_MAX_TOKENS = 2048
export const AI_FREE_CONTEXT_MESSAGES = 20
/** 新建会话的默认标题。 */
export const DEFAULT_SESSION_TITLE = '新会话'
/** 对话前提拼进 system 的前缀（让模型知道这是一段前置设定；前提留空则整个 system 缺省）。 */
export const PREMISE_PROMPT_PREFIX = '请在对话中遵守以下前提设定：\n'

/** 自由对话面板的持久化数据（values，存模板 `panel:tavern-free`）。
 *  用 type 而非 interface：interface 没有隐式索引签名，
 *  过不了 `createPanelStore<T extends Record<string, unknown>>` 的约束。 */
export type TavernFreePanelValues = {
  messages: TavernMessage[]
  sessionTitle: string
  premise: string
  settings: TavernSettingsRecord
}

/**
 * 默认值。
 * `settings.mode` 取任务书文档值 `'free'`（`TavernSettingsRecord.mode` 是 `string`，可自由取值）；
 * `settings.advanced` 是 `Record<string, string>`，默认空对象（任务书的 `false` 过不了类型）。
 */
export function createDefaultPanelValues(): TavernFreePanelValues {
  return {
    messages: [],
    sessionTitle: DEFAULT_SESSION_TITLE,
    premise: '',
    settings: {
      mode: 'free',
      temperature: AI_FREE_TEMPERATURE,
      maxTokens: AI_FREE_MAX_TOKENS,
      contextMessages: AI_FREE_CONTEXT_MESSAGES,
      advanced: {},
    },
  }
}

/** 面板静态文案（全中文）。 */
export const TAVERN_FREE_PANEL_TEXT = {
  intro: '自由对话不绑定角色卡，预览版无流式输出与自动记忆',
  loading: '正在载入会话…',
  empty: '还没有对话。在下方输入第一句话，开始这次自由对话。',
  inputRequired: '请输入内容后再发送。',
  premiseLabel: '对话前提',
  premisePlaceholder: '可选：写下对话前提，例如「你是一名编辑，帮我审稿」',
  premiseHint: '对话前提会拼进每次请求的系统提示，留空则不带系统提示。',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来开始对话。',
  generating: '正在生成回复…',
  send: '发送',
  newSession: '新建会话',
  newSessionTitle: '新建会话',
  newSessionConfirm: '清空并新建',
  newSessionMessage: '将清空当前对话并开始新的会话，对话前提与设置保留，确定继续吗？',
  sessionTitleLabel: '会话标题',
  inputPlaceholder: '写下你想聊的内容或灵感，Enter 发送（Shift+Enter 换行）',
  roleUser: '我',
  roleAssistant: 'AI',
  roleSystem: '系统',
} as const

/** 消息行的保存状态收敛（与 tavern-card / tavern-run 同口径）。 */
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

/**
 * 库值防御解析：`values.messages` → `TavernMessage[]`。
 * store.data 是 ShallowRef，深层字段可能是坏数据——非数组按空处理；
 * 缺 id / 缺 content / role 非法的条目整条丢弃（role 非法不能进 AiRequest）。
 */
export function parseMessages(value: unknown): TavernMessage[] {
  if (!Array.isArray(value)) return []
  const result: TavernMessage[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const id = record.id
    const content = record.content
    const role = record.role
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof content !== 'string') continue
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue
    result.push({
      id,
      role,
      content,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    })
  }
  return result
}

/** 发送前校验：空 / 纯空白输入不能发送，返回提示文案；可发送返回 null。 */
export function validateDraft(content: string): string | null {
  if (content.trim().length === 0) return TAVERN_FREE_PANEL_TEXT.inputRequired
  return null
}

/**
 * 对话前提 → system 提示：trim 后非空才拼（前缀 + 前提文本）；
 * 留空返回 undefined，表示本次请求不带 system 字段（任务书第 2 条）。
 */
export function buildSystemPrompt(premise: string): string | undefined {
  const trimmed = premise.trim()
  if (trimmed.length === 0) return undefined
  return `${PREMISE_PROMPT_PREFIX}${trimmed}`
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
 * 组装 AI 请求：premise 非空时拼进 system（留空不带 system 字段）；
 * messages = 最近上下文（`recentMessages` + 剔除 system 角色）；采样参数来自 `settings`。
 */
export function buildFreeChatRequest(
  premise: string,
  messages: readonly TavernMessage[],
  settings: TavernSettingsRecord,
): AiRequest {
  const system = buildSystemPrompt(premise)
  // AiRequest.system 是 readonly：不能事后赋值，用条件展开拼进对象字面量。
  return {
    ...(system === undefined ? {} : { system }),
    messages: toAiMessages(messages, settings.contextMessages),
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  }
}

/**
 * 新建会话：清空消息、标题回默认；对话前提与设置保留（前提是给下一轮用的
 * 前置设定，清掉就得重打）。不改传入对象。
 */
export function newSessionValues(previous: TavernFreePanelValues): TavernFreePanelValues {
  return { ...previous, messages: [], sessionTitle: DEFAULT_SESSION_TITLE }
}

/** 消息时间戳显示：`MM-dd HH:mm`（本地时区）；无效时间返回空串。 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 消息列表的角色标签：user→「我」、assistant→「AI」、system→「系统」。 */
export function roleLabel(role: TavernMessage['role']): string {
  if (role === 'user') return TAVERN_FREE_PANEL_TEXT.roleUser
  if (role === 'system') return TAVERN_FREE_PANEL_TEXT.roleSystem
  return TAVERN_FREE_PANEL_TEXT.roleAssistant
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

/** 对话前提兜底：库值是字符串才采用（含空串 = 无前提），否则空串。 */
export function resolvePremise(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 概览行：共 N 条消息。 */
export function messageCountLine(count: number): string {
  return `共 ${count} 条消息`
}

/** 设置摘要行（只读提示）。 */
export function settingsLine(settings: TavernSettingsRecord): string {
  return `上下文：最近 ${settings.contextMessages} 条 · 温度：${settings.temperature} · 最大输出：${settings.maxTokens}`
}

/** AI 失败提示：未配置 → 引导文案；其它如实显示「错误码：消息」（任务书第 7 条）。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_FREE_PANEL_TEXT.notConfigured
  return `${code}：${message}`
}
