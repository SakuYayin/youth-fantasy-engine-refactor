/**
 * tavern-script（故事剧本）面板纯逻辑：文案、表单校验、记录增删改、AI 生成解析。
 *
 * 脚本是酒馆模式的剧情自动化条目：每条脚本是一段纯文本资产（name / code / note / enabled），
 * 预览版只保存与查看，**不执行**任何脚本内容（渲染进程禁止 eval / Function / 动态 import）。
 * 持久化走 `createPanelStore`（模板 `panel:tavern-script`，values = `{ items }`）；
 * 记录 ID 用 `newTavernId('script')`、时间戳用 `tavernNow()`（shared 的 tavern/types.ts）。
 * AI 只走 `props.state.ai.complete()`：这里只做请求组装与结果解析（纯函数可单测）。
 */
import type { AiErrorCode, AiRequest } from '../ai/types.js'
import type { TavernScriptRecord } from '../tavern/types.js'
import { newTavernId, tavernNow } from '../tavern/types.js'

/** 面板持久化 values（createPanelStore 模板自动 `panel:tavern-script`）。
 *  用 type 而非 interface：interface 没有隐式索引签名，
 *  过不了 `createPanelStore<T extends Record<string, unknown>>` 的约束。 */
export type TavernScriptPanelValues = {
  items: TavernScriptRecord[]
}

/** 面板默认 values：第一次挂载（库里还没有面板状态行）时使用。 */
export function createDefaultPanelValues(): TavernScriptPanelValues {
  return { items: [] }
}

/** AI 生成脚本草稿的输出上限（任务书约定 2048）。 */
export const AI_SCRIPT_MAX_TOKENS = 2048

/** 列表「备注摘要」的截断长度（脚本全文在代码编辑区展示，不截断）。 */
export const NOTE_MAX_CHARS = 40

/** 面板全部静态文案（全中文；可见文本 ⊆ 页签文案 ∪ 这里）。 */
export const TAVERN_SCRIPT_PANEL_TEXT = {
  intro: '脚本是剧情自动化的文本条目：先在这里写好、存好，再去其它页签引用。',
  previewNotice: '预览版只保存与查看脚本，不会在任何时机执行脚本内容。',
  listTitle: '脚本列表',
  listHint: '点击脚本条目回灌表单编辑；开关控制启用/停用，切换会立即保存。',
  formTitle: '新建脚本',
  editTitle: '编辑脚本',
  fieldName: '名称',
  fieldCode: '脚本代码',
  fieldNote: '备注',
  namePlaceholder: '脚本名称（必填）',
  codePlaceholder: '脚本内容（预览版按纯文本保存，不执行）',
  notePlaceholder: '这条脚本做什么用（可选）',
  nameRequired: '名称不能为空。',
  newScript: '新建脚本',
  save: '保存脚本',
  cancelEdit: '取消编辑',
  delete: '删除',
  deleteTitle: '确定删除「{name}」吗？删除后无法恢复。',
  confirmDelete: '确认删除',
  cancelDelete: '取消',
  loading: '正在载入脚本…',
  empty: '还没有脚本。填写表单后点击「保存脚本」创建第一条。',
  enabledLabel: '启用',
  disabledLabel: '停用',
  previewTitle: '脚本预览',
  previewEmpty: '选中一条脚本后，这里显示它的内容全文。',
  aiRequirementLabel: '需求描述',
  aiRequirementPlaceholder: '描述这段脚本要做什么，如：主角捡起一把发光的剑，剑身浮现古老文字',
  aiGenerate: 'AI 写脚本',
  aiGenerating: '生成中…',
  aiRequirementRequired: '请先在「需求描述」里填写这段脚本要做什么。',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 写脚本。',
  aiParseFailed: 'AI 返回的内容无法解析成脚本代码，本次结果未保存。',
  aiDone: '已生成脚本草稿并回填代码编辑区，请确认后点击「保存脚本」保存。',
  aiFailure: '生成失败：{message}',
} as const

/** 表单收集到的一条脚本（enabled 由列表开关管理，不在表单里；新建默认启用）。 */
export interface ScriptFormInput {
  readonly name: string
  readonly code: string
  readonly note: string
}

/**
 * 组装一条记录：新建生成 id（默认启用）；编辑保留 id / enabled、刷新 updatedAt。
 * 文本字段统一 trim。
 */
export function makeScript(
  input: ScriptFormInput,
  existing?: TavernScriptRecord | null,
): TavernScriptRecord {
  const isNew = existing === null || existing === undefined
  const now = tavernNow()
  return {
    id: isNew ? newTavernId('script') : existing.id,
    name: input.name.trim(),
    code: input.code.trim(),
    enabled: isNew ? true : existing.enabled,
    note: input.note.trim(),
    updatedAt: now,
  }
}

/** 表单校验：只校验必填的名称（代码 / 备注可以为空）。返回 null = 通过。 */
export function validateScriptForm(input: ScriptFormInput): string | null {
  if (input.name.trim() === '') return TAVERN_SCRIPT_PANEL_TEXT.nameRequired
  return null
}

/** 按 id 查脚本；没有返回 null。 */
export function findScriptById(
  items: readonly TavernScriptRecord[],
  id: string,
): TavernScriptRecord | null {
  return items.find((item) => item.id === id) ?? null
}

/** 新脚本追加到末尾、已有脚本原位替换；不改传入数组。 */
export function upsertScript(
  items: readonly TavernScriptRecord[],
  script: TavernScriptRecord,
): TavernScriptRecord[] {
  const index = items.findIndex((item) => item.id === script.id)
  if (index < 0) return [...items, script]
  const next = [...items]
  next[index] = script
  return next
}

/** 按 id 删除；不改传入数组。 */
export function removeScript(
  items: readonly TavernScriptRecord[],
  id: string,
): TavernScriptRecord[] {
  return items.filter((item) => item.id !== id)
}

/** 启用/停用切换（不动其它条目；记录变了要刷新 updatedAt）。 */
export function toggleScriptEnabled(
  items: readonly TavernScriptRecord[],
  id: string,
  enabled: boolean,
): TavernScriptRecord[] {
  return items.map((item) =>
    item.id === id ? { ...item, enabled, updatedAt: tavernNow() } : item,
  )
}

/** 备注摘要：按码点截断并加省略号；不足 limit 原样（trim 后）返回；空备注返回空串。 */
export function briefNote(note: string, limit: number = NOTE_MAX_CHARS): string {
  const chars = [...note.trim()]
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, limit).join('')}…`
}

/** 概览行：共 N 条脚本。 */
export function overviewLine(count: number): string {
  return `共 ${count} 条脚本`
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
 * 组装 AI 写脚本的请求：system 要求只返回脚本正文（纯文本，不解释、不围栏），
 * maxTokens 固定 2048。需求描述来自面板的「需求描述」输入框。
 * 已有脚本名作为「避免重复」的上下文传给模型。
 */
export function buildAiScriptRequest(
  requirement: string,
  existingNames: readonly string[],
): AiRequest {
  const system = [
    '你是「青春幻想引擎」酒馆模式的剧本作者，负责把需求描述写成可直接保存的脚本（纯文本资产，预览版不会执行）。',
    '只返回脚本正文本身：不要解释、不要前后缀、不要 Markdown 代码块标记。',
    '脚本用中文书写，写清楚这段剧情里发生的事、触发的时机与涉及的角色，方便作者直接阅读与修改。',
  ].join('\n\n')
  const names =
    existingNames.length > 0
      ? `\n\n已有的脚本名（不要重复）：${existingNames.join('、')}`
      : ''
  const user = `请根据下面的需求描述写一段脚本。\n\n需求描述：${requirement.trim()}${names}`
  return { system, messages: [{ role: 'user', content: user }], maxTokens: AI_SCRIPT_MAX_TOKENS }
}

/** Markdown 围栏：```（可带语言标注）换行 正文 换行 ```。 */
const FENCE_RE = /```[^\n`]*\n?([\s\S]*?)\n?```/

/** 整段就是一个空围栏（可带语言标注、换行后直接闭合），如 ``` ``` 与 ```js\n```。 */
const EMPTY_FENCE_RE = /^```[^\n`]*\n```$/

/** 整段是单行围栏 ```正文```（无换行）。 */
const SINGLE_FENCE_RE = /^```([^`\n]+)```$/

/**
 * 解析 AI 返回的脚本草稿：剥掉 Markdown 围栏标记、容忍前后缀文字。
 * 整段空白或只有围栏没有正文（含只有语言标注，如 ```js\n```）→ null，调用方不落库。
 */
export function parseAiScript(text: string): string | null {
  const cleaned = text.trim()
  if (cleaned === '') return null
  if (EMPTY_FENCE_RE.test(cleaned)) return null
  const single = SINGLE_FENCE_RE.exec(cleaned)
  if (single !== null) {
    const inner = (single[1] ?? '').trim()
    return inner === '' ? null : inner
  }
  const fenced = FENCE_RE.exec(cleaned)
  if (fenced === null) {
    // 没有围栏：整段就是脚本正文（system 要求只返回正文本身）。
    return cleaned
  }
  const inner = (fenced[1] ?? '').trim()
  if (inner !== '') return inner
  // 兜底：去掉全部围栏标记后重试（前后缀文字包裹的怪异形态）。
  const stripped = cleaned.replace(/```/g, '').trim()
  return stripped === '' ? null : stripped
}

/** AI 失败的用户文案：未配置给引导，其余统一「生成失败：…」。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_SCRIPT_PANEL_TEXT.notConfigured
  return fillTemplate(TAVERN_SCRIPT_PANEL_TEXT.aiFailure, { message })
}
