/**
 * 背景设定面板（tavern-world）纯逻辑与文案常量（W7）。
 *
 * 权威文档：`docs/接口冻结-面板层.md` §4 —— AI 纯逻辑（提示词拼装、响应解析、
 * 表单校验、条目增删改）全部放在本文件，`tavern-world.vue` 只负责渲染与调用。
 *
 * 数据契约：
 * - 条目复用 `@yfe/desktop` 渲染层共享类型 `TavernWorldEntry`
 *   （`src/renderer/tavern/types.ts`，冻结不改）：`{id, keywords, content, enabled, order}`；
 * - 该类型**没有**时间戳字段，因此扩写/保存时间放在 `values.updatedAt`
 *   （`tavernNow()` 生成），条目本身不携带；
 * - `order` 用数组下标：每次增删后 `reindexEntries` 归一化；
 * - 持久化走 Lead 的 `createPanelStore`，模板 `panel:tavern-world`。
 */

import type { AiRequest } from '../ai/types.js'
import type { TavernWorldEntry } from '../tavern/types.js'
import { newTavernId } from '../tavern/types.js'

/** 面板持久化数据（panel-store 模板 `panel:tavern-world` 的 values）。
 *  用 type 而非 interface：interface 没有隐式索引签名，
 *  过不了 `createPanelStore<T extends Record<string, unknown>>` 的约束。 */
export type TavernWorldPanelValues = {
  items: TavernWorldEntry[]
  /** 最近一次本面板写入的时间戳（tavernNow()）。 */
  updatedAt: string
}

export function createDefaultPanelValues(): TavernWorldPanelValues {
  return { items: [], updatedAt: '' }
}

/** AI 扩写的 maxTokens（任务契约写死 2048）。 */
export const AI_EXPAND_MAX_TOKENS = 2048

/** 列表里内容摘要的截断长度（码点计）。 */
export const BRIEF_MAX_CHARS = 40

/** 面板静态文案（全中文；可见文本 ⊆ 页签文案 ∪ 本常量表 ∪ YfeStatusPill 六态）。 */
export const TAVERN_WORLD_PANEL_TEXT = {
  /** 顶部说明条（任务契约要求的固定文案）。 */
  intro: '启用条目的关键词会注入酒馆对话的系统提示词。',
  listTitle: '世界条目',
  listHint: '通常填地名、势力名、招式名这类「提到就需要说明背景」的词。',
  formTitle: '新建条目',
  editFormTitle: '编辑条目',
  fieldKeywords: '关键词',
  keywordsPlaceholder: '多个关键词用逗号分隔，如：魔法学院,灵脉,星陨节',
  keywordsHint: '必填；对话中命中任一关键词才会注入这一条。',
  keywordsRequired: '请填写关键词（多个用逗号分隔）。',
  fieldContent: '内容',
  contentPlaceholder: '这一条世界设定的具体内容，命中关键词时注入对话。',
  fieldEnabled: '启用',
  contentRequired: '请填写这一条的内容。',
  newEntry: '新建条目',
  saveEntry: '保存条目',
  cancelEdit: '取消编辑',
  deleteEntry: '删除',
  deleteTitle: '确定删除关键词「{keywords}」的条目吗？删除后无法恢复。',
  confirmDelete: '确认删除',
  cancel: '取消',
  loading: '正在载入世界条目…',
  empty: '还没有世界条目。填写表单后点击「保存条目」创建第一条。',
  enabledLabel: '已启用',
  disabledLabel: '已停用',
  noProject: '还没有作品：新建作品后，面板数据才能保存。',
  aiExpand: 'AI 扩写条目',
  aiExpanding: '扩写中…',
  aiNeedSelected: '先在列表中选中一条条目，再使用 AI 扩写。',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 扩写。',
  aiParseFailed: 'AI 返回的内容无法解析，本次结果没有写入。',
  aiEntryGone: '条目已被删除，扩写结果没有写入。',
  aiPreviewTitle: 'AI 扩写结果（确认后替换当前内容）',
  expandConfirmTitle: '确认用 AI 扩写结果替换当前内容？',
  expandConfirm: '确认替换',
  aiDone: '已用 AI 扩写条目「{keywords}」，下一轮对话生效。',
  aiCancelled: '已取消替换，原内容保持不变。',
  aiFailure: '扩写失败：{message}',
  previewTitle: '内容预览',
  previewEmpty: '选中一条条目后，这里显示它的完整内容。',
} as const

/** 表单输入（新建与编辑共用）。 */
export interface EntryFormInput {
  readonly keywords: string
  readonly content: string
  readonly enabled: boolean
}

/** 关键词解析：按中英逗号/顿号切分，trim 去空去重保序。 */
export function parseKeywords(input: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of input.split(/[,，、]/)) {
    const keyword = part.trim()
    if (keyword.length === 0 || seen.has(keyword)) continue
    seen.add(keyword)
    result.push(keyword)
  }
  return result
}

/** 关键词回显：中文逗号连接。 */
export function formatKeywords(keywords: readonly string[]): string {
  return keywords.join('，')
}

/** 内容摘要：按码点截断，超长补省略号（防代理对被劈开）。 */
export function briefContent(content: string, limit: number = BRIEF_MAX_CHARS): string {
  const chars = [...content.trim()]
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, limit).join('')}…`
}

/**
 * 由表单输入构造条目：新建用 `newTavernId('world')` 生成 id；
 * 编辑保留原 id（order 沿用原值，由 upsert 保位、reindex 归一）。
 */
export function makeEntry(
  input: EntryFormInput,
  existing?: TavernWorldEntry | null,
  order?: number,
): TavernWorldEntry {
  const keywords = input.keywords.trim()
  const content = input.content.trim()
  if (existing !== null && existing !== undefined) {
    return { ...existing, keywords, content, enabled: input.enabled }
  }
  return {
    id: newTavernId('world'),
    keywords,
    content,
    enabled: input.enabled,
    order: order ?? 0,
  }
}

/** 表单校验：关键词必填（逗号分隔）、内容必填；返回错误文案或 null。 */
export function validateEntryForm(input: EntryFormInput): string | null {
  if (parseKeywords(input.keywords).length === 0) return TAVERN_WORLD_PANEL_TEXT.keywordsRequired
  if (input.content.trim().length === 0) return TAVERN_WORLD_PANEL_TEXT.contentRequired
  return null
}

export const KEYWORDS_REQUIRED = TAVERN_WORLD_PANEL_TEXT.keywordsRequired
export const CONTENT_REQUIRED = TAVERN_WORLD_PANEL_TEXT.contentRequired

/** order 归一化 = 数组下标（不变的条目原样返回，避免无谓重建）。 */
export function reindexEntries(items: readonly TavernWorldEntry[]): TavernWorldEntry[] {
  return items.map((entry, index) => (entry.order === index ? entry : { ...entry, order: index }))
}

/** 新条目追加到末尾，已存在的原位替换；返回新数组（不原地改）。 */
export function upsertEntry(
  items: readonly TavernWorldEntry[],
  entry: TavernWorldEntry,
): TavernWorldEntry[] {
  const index = items.findIndex((candidate) => candidate.id === entry.id)
  if (index < 0) return reindexEntries([...items, entry])
  const next = items.slice()
  next[index] = entry
  return reindexEntries(next)
}

/** 删除后重排 order。 */
export function removeEntry(items: readonly TavernWorldEntry[], id: string): TavernWorldEntry[] {
  return reindexEntries(items.filter((entry) => entry.id !== id))
}

/** 启用/停用切换（不动其它条目）。 */
export function toggleEntryEnabled(
  items: readonly TavernWorldEntry[],
  id: string,
  enabled: boolean,
): TavernWorldEntry[] {
  return items.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
}

export function findEntryById(
  items: readonly TavernWorldEntry[],
  id: string,
): TavernWorldEntry | null {
  return items.find((entry) => entry.id === id) ?? null
}

/**
 * 库值兜底：store.data 是 ShallowRef，存的 items 可能缺字段/坏类型；
 * 非条目形状的行（null/标量/数组）丢弃，其余逐条补齐
 * （缺 id 补 newTavernId('world')、非字符串字段补空串、enabled 缺省 false、order 归一化）。
 */
export function normalizeEntries(value: unknown): TavernWorldEntry[] {
  if (!Array.isArray(value)) return []
  const result: TavernWorldEntry[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const candidate = raw as Record<string, unknown>
    const id =
      typeof candidate.id === 'string' && candidate.id.length > 0
        ? candidate.id
        : newTavernId('world')
    const keywords = typeof candidate.keywords === 'string' ? candidate.keywords : ''
    const content = typeof candidate.content === 'string' ? candidate.content : ''
    const enabled = candidate.enabled === true
    const order =
      typeof candidate.order === 'number' && Number.isFinite(candidate.order)
        ? candidate.order
        : result.length
    result.push({ id, keywords, content, enabled, order })
  }
  return reindexEntries(result)
}

/** 工具条总览行。 */
export function overviewLine(items: readonly TavernWorldEntry[]): string {
  const enabledCount = items.filter((entry) => entry.enabled).length
  return `共 ${items.length} 条条目，已启用 ${enabledCount} 条`
}

/** 保存状态六态（YfeStatusPill 只吃枚举，文案由组件自己映射）。 */
export type PanelSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PanelSaveStatus {
  if (saving) return 'saving'
  if (hasError) return 'error'
  if (dirty) return 'dirty'
  return 'saved'
}

/** 文案模板：`{key}` 占位符替换；未知占位符原样保留。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : value
  })
}

/**
 * AI 扩写请求：把选中条目的关键词 + 内容交给模型，扩写成更完整的世界设定。
 * 只返回设定正文（纯文本），不要求 JSON —— 扩写是整段文字，结构化反而易碎。
 */
export function buildAiExpandRequest(entry: TavernWorldEntry): AiRequest {
  const system = [
    '你是幻想小说的世界设定编辑。请把给出的世界书条目扩写成更完整、可直接注入小说对话的世界设定。',
    '要求：保留原有含义与关键词覆盖的场景，补充贴合的细节（地理、规则、势力、仪式等任选），不引入与原设定矛盾的内容。',
    '只返回扩写后的设定正文，不要解释、不要标题、不要 Markdown 代码块。',
  ].join('\n\n')
  const content = [
    `关键词：${entry.keywords}`,
    `当前内容：${entry.content}`,
    '请扩写成更完整的世界设定。',
  ].join('\n')
  return { system, messages: [{ role: 'user', content }], maxTokens: AI_EXPAND_MAX_TOKENS }
}

/**
 * AI 扩写响应解析：剥代码围栏、trim；空结果视为解析失败（返回 null，不落库）。
 */
export function parseAiExpanded(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const stripped = text
    .replace(/^```(?:json|text)?\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim()
  return stripped.length > 0 ? stripped : null
}

/** AI 失败文案：未配置走引导，其余带脱敏后的 message。 */
export function failureNotice(code: string, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_WORLD_PANEL_TEXT.notConfigured
  return fillTemplate(TAVERN_WORLD_PANEL_TEXT.aiFailure, { message })
}
