/**
 * tavern-card（角色卡片）面板纯逻辑：文案、表单校验、记录增删改、AI 生成解析。
 *
 * 角色卡（立绘卡）是酒馆模式的数据基座：对话 / 跑团 / 情节页签都从这里取角色设定。
 * 持久化走 `createPanelStore`（模板 `panel:tavern-card`，values = `{ items }`）；
 * 记录 ID 用 `newTavernId('card')`、时间戳用 `tavernNow()`（shared 的 tavern/types.ts）。
 * AI 只走 `props.state.ai.complete()`：这里只做请求组装与结果解析（纯函数可单测）。
 */
import type { AiErrorCode, AiRequest } from '../ai/types.js'
import type { TavernCardRecord } from '../tavern/types.js'
import { newTavernId, tavernNow } from '../tavern/types.js'

/** 面板持久化 values（createPanelStore 模板自动 `panel:tavern-card`）。
 *  用 type 而非 interface：interface 没有隐式索引签名，
 *  过不了 `createPanelStore<T extends Record<string, unknown>>` 的约束。 */
export type TavernCardPanelValues = {
  items: TavernCardRecord[]
}

/** 面板默认 values：第一次挂载（库里还没有面板状态行）时使用。 */
export function createDefaultPanelValues(): TavernCardPanelValues {
  return { items: [] }
}

/** AI 生成卡片的输出上限（任务书约定 2048）。 */
export const AI_CARD_MAX_TOKENS = 2048

/** 列表「简述」的截断长度（开场白全文在预览区展示，不截断）。 */
export const BRIEF_MAX_CHARS = 40

/** 面板全部静态文案（全中文；可见文本 ⊆ 页签文案 ∪ 这里）。 */
export const TAVERN_CARD_PANEL_TEXT = {
  intro: '角色卡是酒馆模式的数据基座：对话、跑团与情节页签都会从这里读取角色设定。先在这里建好卡，再去其它页签选用。',
  listTitle: '卡片列表',
  listHint: '点击列表中的卡片可回灌表单编辑，并预览开场白。',
  formTitle: '新建卡片',
  editTitle: '编辑卡片',
  fieldName: '名称',
  fieldDescription: '描述',
  fieldPersonality: '性格',
  fieldFirstMessage: '开场白',
  fieldTags: '标签',
  namePlaceholder: '角色名称（必填）',
  descriptionPlaceholder: '角色的设定简述',
  personalityPlaceholder: '性格与说话风格',
  firstMessagePlaceholder: '角色的第一条消息（开场白）',
  tagsPlaceholder: '多个标签用逗号分隔，如：魔法,少女,学姐',
  nameRequired: '名称不能为空。',
  newCard: '新建卡片',
  save: '保存卡片',
  cancelEdit: '取消编辑',
  delete: '删除',
  deleteTitle: '确定删除「{name}」吗？删除后无法恢复。',
  confirmDelete: '确认删除',
  cancelDelete: '取消',
  loading: '正在载入角色卡…',
  empty: '还没有角色卡。填写表单后点击「保存卡片」创建第一张。',
  noTags: '无标签',
  previewTitle: '开场白预览',
  previewEmpty: '选中一张卡片后，这里显示它的开场白全文。',
  aiGenerate: 'AI 生成卡片',
  aiGenerating: '生成中…',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 生成。',
  aiParseFailed: 'AI 返回的内容无法解析成角色卡 JSON，本次结果未保存。',
  aiDone: '已生成角色卡「{name}」并加入列表。',
  aiFailure: '生成失败：{message}',
} as const

/** 表单收集到的一张卡（新建与 AI 草稿同形）。 */
export interface CardFormInput {
  readonly name: string
  readonly description: string
  readonly personality: string
  readonly firstMessage: string
  readonly tags: readonly string[]
}

/** 解析标签输入：中英文逗号 / 顿号都算分隔符，去空、去重（保留首次出现顺序）。 */
export function parseTags(input: string): string[] {
  const tags: string[] = []
  for (const piece of input.split(/[,，、]/)) {
    const tag = piece.trim()
    if (tag !== '' && !tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/** 标签数组 → 输入框回显文本（中文逗号连接，与 parseTags 可往返）。 */
export function formatTags(tags: readonly string[]): string {
  return tags.join('，')
}

/** 列表简述：按码点截断并加省略号；不足 limit 原样（trim 后）返回。 */
export function briefDescription(description: string, limit: number = BRIEF_MAX_CHARS): string {
  const chars = [...description.trim()]
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, limit).join('')}…`
}

/**
 * 组装一条记录：新建生成 id / createdAt；编辑保留 id / createdAt、刷新 updatedAt。
 * 文本字段统一 trim；tags 拷贝一份（不共享调用方数组）。
 */
export function makeCard(input: CardFormInput, existing?: TavernCardRecord | null): TavernCardRecord {
  const isNew = existing === null || existing === undefined
  const now = tavernNow()
  return {
    id: isNew ? newTavernId('card') : existing.id,
    name: input.name.trim(),
    description: input.description.trim(),
    personality: input.personality.trim(),
    firstMessage: input.firstMessage.trim(),
    tags: [...input.tags],
    createdAt: isNew ? now : existing.createdAt,
    updatedAt: now,
  }
}

/** 表单校验：名称 trim 后非空。返回 null = 通过。 */
export function validateCardForm(input: { readonly name: string }): string | null {
  if (input.name.trim() === '') return TAVERN_CARD_PANEL_TEXT.nameRequired
  return null
}

/** 按 id 查卡；没有返回 null。 */
export function findCardById(items: readonly TavernCardRecord[], id: string): TavernCardRecord | null {
  return items.find((card) => card.id === id) ?? null
}

/** 新卡追加到末尾、已有卡原位替换；不改传入数组。 */
export function upsertCard(items: readonly TavernCardRecord[], card: TavernCardRecord): TavernCardRecord[] {
  const index = items.findIndex((item) => item.id === card.id)
  if (index < 0) return [...items, card]
  const next = [...items]
  next[index] = card
  return next
}

/** 按 id 删除；不改传入数组。 */
export function removeCard(items: readonly TavernCardRecord[], id: string): TavernCardRecord[] {
  return items.filter((card) => card.id !== id)
}

/** 概览行：共 N 张角色卡。 */
export function overviewLine(count: number): string {
  return `共 ${count} 张角色卡`
}

/** 保存状态推导（与 YfeStatusPill 的六态枚举同形）。 */
export type PanelSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

/** saving 优先，其次 error，再次 dirty，否则 saved。 */
export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PanelSaveStatus {
  if (saving) return 'saving'
  if (hasError) return 'error'
  if (dirty) return 'dirty'
  return 'saved'
}

/** 文案占位符替换：`{key}` → values[key]；没有对应值的占位符原样保留。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
    const value = values[key]
    return value === undefined ? match : value
  })
}

/**
 * 组装 AI 生成卡片的请求：system 要求只返回一个 JSON 对象
 * （name / description / personality / firstMessage / tags），maxTokens 固定 2048。
 * 已有卡名作为「避免重复」的上下文传给模型。
 */
export function buildAiCardRequest(existingNames: readonly string[]): AiRequest {
  const system = [
    '你是「青春幻想引擎」酒馆模式的角色卡设计师，负责生成可直接使用的角色卡（立绘卡）。',
    '只返回一个 JSON 对象：不要解释、不要前后缀、不要代码块标记。',
    [
      'JSON 字段：',
      '- name：角色名（字符串）',
      '- description：角色设定简述（字符串）',
      '- personality：性格与说话风格（字符串）',
      '- firstMessage：角色开场白（字符串）',
      '- tags：标签（字符串数组，2 到 4 个）',
    ].join('\n'),
    '所有字段用中文书写，内容要具体、可直接使用。',
  ].join('\n\n')
  const existing =
    existingNames.length > 0
      ? `已有的角色名（不要重复）：${existingNames.join('、')}`
      : '目前一张卡都没有，任意题材都可以。'
  const user = `请为酒馆模式生成一张新的角色卡。${existing}`
  return { system, messages: [{ role: 'user', content: user }], maxTokens: AI_CARD_MAX_TOKENS }
}

/** 从 AI 返回文本里提取第一段 JSON：剥代码块标记、容忍前后缀文字。 */
function extractJson(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return cleaned.slice(start, end + 1)
}

/** 宽松取字符串：字符串原样；有限数字转字符串；其余 null。 */
function coerceString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** 宽松取标签：字符串走 parseTags；数组逐项取字符串、去空去重；其余空数组。 */
function coerceTags(value: unknown): string[] {
  if (typeof value === 'string') return parseTags(value)
  if (Array.isArray(value)) {
    const tags: string[] = []
    for (const item of value) {
      const tag = coerceString(item)
      if (tag === null) continue
      const trimmed = tag.trim()
      if (trimmed !== '' && !tags.includes(trimmed)) tags.push(trimmed)
    }
    return tags
  }
  return []
}

/**
 * 解析 AI 返回的角色卡 JSON（name 缺失 / 为空或整体解析失败 → null，调用方不落库）。
 * 字段缺失宽松兜底为空串 / 空标签数组，交给用户在表单里补。
 */
export function parseAiCard(text: string): CardFormInput | null {
  const json = extractJson(text)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as { readonly [key: string]: unknown }
  const name = coerceString(record['name'])
  if (name === null || name.trim() === '') return null
  return {
    name: name.trim(),
    description: coerceString(record['description']) ?? '',
    personality: coerceString(record['personality']) ?? '',
    firstMessage: coerceString(record['firstMessage']) ?? '',
    tags: coerceTags(record['tags']),
  }
}

/** AI 失败的用户文案：未配置给引导，其余统一「生成失败：…」。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_CARD_PANEL_TEXT.notConfigured
  return fillTemplate(TAVERN_CARD_PANEL_TEXT.aiFailure, { message })
}
