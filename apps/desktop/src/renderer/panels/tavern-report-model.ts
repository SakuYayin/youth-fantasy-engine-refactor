/**
 * tavern-report（聊天报告）面板纯逻辑：文案、表单校验、记录增删改、
 * AI 请求组装与结果解析、剪贴板兜底。
 *
 * 聊天报告把酒馆对话整理成剧情摘要并归档：列表 + 表单 + 全文预览 + AI 生成草稿。
 * 持久化走 `createPanelStore`（模板自动 `panel:tavern-report`，values = `{ items }`）；
 * 记录 ID 用 `newTavernId('report')`、时间戳用 `tavernNow()`（shared 的 tavern/types.ts）。
 * AI 只走 `props.state.ai.complete()`：这里只做请求组装与结果解析（纯函数可单测）。
 */
import type { AiErrorCode, AiRequest } from '../ai/types.js'
import type { TavernReportRecord } from '../tavern/types.js'
import { newTavernId, tavernNow } from '../tavern/types.js'

/** 面板持久化 values（createPanelStore 模板自动 `panel:tavern-report`）。 */
export type TavernReportPanelValues = {
  items: TavernReportRecord[]
}

/** 面板默认 values：第一次挂载（库里还没有面板状态行）时使用。 */
export function createDefaultPanelValues(): TavernReportPanelValues {
  return { items: [] }
}

/** AI 生成报告的输出上限（任务书约定 2048）。 */
export const AI_REPORT_MAX_TOKENS = 2048

/** 列表摘要的截断长度（正文全文只在预览区展示，不截断）。 */
export const BRIEF_MAX_CHARS = 60

/** 面板全部静态文案（全中文；可见文本 ⊆ 页签文案 ∪ 这里）。 */
export const TAVERN_REPORT_PANEL_TEXT = {
  intro:
    '把酒馆里产生的对话整理成剧情摘要报告并归档：可以直接撰写，也可以把对话粘贴到下方输入框，用 AI 生成草稿，确认后保存到列表。',
  manualEntry: '在『酒馆对话』页签产生对话后，可在此粘贴对话内容生成报告',
  listTitle: '报告列表',
  listHint: '点击列表中的报告可查看全文、复制全文或编辑。',
  formTitle: '新建报告',
  editTitle: '编辑报告',
  fieldTitle: '标题',
  fieldBody: '正文',
  titlePlaceholder: '报告标题（必填）',
  bodyPlaceholder: '报告正文：梳理对话里的关键剧情、人物与结果',
  titleRequired: '标题不能为空。',
  newReport: '新建报告',
  save: '保存到列表',
  cancelEdit: '取消编辑',
  delete: '删除',
  deleteTitle: '确定删除「{title}」吗？删除后无法恢复。',
  confirmDelete: '确认删除',
  cancelDelete: '取消',
  loading: '正在载入报告…',
  empty: '还没有报告。粘贴对话生成，或直接撰写并保存。',
  previewTitle: '报告全文',
  previewEmpty: '选中一篇报告后，这里展示正文全文。',
  createdLabel: '创建时间',
  copy: '复制全文',
  copyDone: '已复制报告全文。',
  copyFailed: '复制失败：当前环境不允许访问剪贴板。',
  aiSectionTitle: 'AI 生成报告',
  aiInputLabel: '对话内容',
  aiInputPlaceholder: '把「酒馆对话」页签里的对话粘贴到这里，点「AI 生成报告」自动总结',
  aiGenerate: 'AI 生成报告',
  aiGenerating: '生成中…',
  aiEmptySource: '请先在「对话内容」输入框粘贴对话，再使用 AI 生成。',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 生成。',
  aiParseFailed: 'AI 返回的内容无法解析成报告，本次结果未保存。',
  aiDone: '已生成报告草稿，请确认标题与正文后点击「保存到列表」。',
  aiFailure: '生成失败：{message}',
} as const

/** 表单收集到的一篇报告（新建与 AI 草稿同形）。 */
export interface ReportFormInput {
  readonly title: string
  readonly body: string
}

/** 列表摘要：按码点截断并加省略号；不足 limit 原样（trim 后）返回。 */
export function briefBody(body: string, limit: number = BRIEF_MAX_CHARS): string {
  const chars = [...body.trim()]
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, limit).join('')}…`
}

/** ISO 时间戳 → 本地「YYYY-MM-DD HH:mm」；解析失败原样返回。 */
export function formatCreatedAt(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  )
}

/** 组装一条记录：新建生成 id / createdAt；编辑保留 id / createdAt。文本字段统一 trim。 */
export function makeReport(
  input: ReportFormInput,
  existing?: TavernReportRecord | null,
): TavernReportRecord {
  const isNew = existing === null || existing === undefined
  return {
    id: isNew ? newTavernId('report') : existing.id,
    title: input.title.trim(),
    body: input.body.trim(),
    createdAt: isNew ? tavernNow() : existing.createdAt,
  }
}

/** 表单校验：标题 trim 后非空。返回 null = 通过。 */
export function validateReportForm(input: { readonly title: string }): string | null {
  if (input.title.trim() === '') return TAVERN_REPORT_PANEL_TEXT.titleRequired
  return null
}

/** 按 id 查报告；没有返回 null。 */
export function findReportById(
  items: readonly TavernReportRecord[],
  id: string,
): TavernReportRecord | null {
  return items.find((report) => report.id === id) ?? null
}

/** 新报告追加到末尾、已有报告原位替换；不改传入数组。 */
export function upsertReport(
  items: readonly TavernReportRecord[],
  report: TavernReportRecord,
): TavernReportRecord[] {
  const index = items.findIndex((item) => item.id === report.id)
  if (index < 0) return [...items, report]
  const next = [...items]
  next[index] = report
  return next
}

/** 按 id 删除；不改传入数组。 */
export function removeReport(items: readonly TavernReportRecord[], id: string): TavernReportRecord[] {
  return items.filter((report) => report.id !== id)
}

/** 概览行：共 N 篇报告。 */
export function overviewLine(count: number): string {
  return `共 ${count} 篇报告`
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

/** AI 源文本校验：粘贴的对话 trim 后为空 → null（不发请求）。 */
export function validateAiSource(source: string): string | null {
  const trimmed = source.trim()
  if (trimmed === '') return null
  return trimmed
}

/**
 * 组装 AI 生成报告的请求：system 要求只返回一个 JSON 对象（title / body），
 * user 带上粘贴的对话原文，maxTokens 固定 2048。
 */
export function buildAiReportRequest(source: string): AiRequest {
  const system = [
    '你是「青春幻想引擎」酒馆模式的剧情编辑，负责把跑团对话整理成剧情摘要报告。',
    '只返回一个 JSON 对象：不要解释、不要前后缀、不要代码块标记。',
    ['JSON 字段：', '- title：报告标题（字符串，20 字以内）', '- body：剧情摘要正文（字符串，200 到 400 字，覆盖关键事件、人物与结果）'].join('\n'),
    '所有内容用中文书写，要具体、可直接归档。',
  ].join('\n\n')
  const user = `请把下面的酒馆对话整理成剧情摘要报告。\n【对话原文】\n${source}`
  return { system, messages: [{ role: 'user', content: user }], maxTokens: AI_REPORT_MAX_TOKENS }
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

/**
 * 解析 AI 返回的报告 JSON（title 缺失 / 为空或整体解析失败 → null，调用方不落库）。
 * body 缺失宽松兜底为空串，交给用户在表单里补。
 */
export function parseAiReport(text: string): ReportFormInput | null {
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
  const title = coerceString(record['title'])
  if (title === null || title.trim() === '') return null
  return {
    title: title.trim(),
    body: coerceString(record['body']) ?? '',
  }
}

/** AI 失败的用户文案：未配置给引导，其余统一「生成失败：…」。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_REPORT_PANEL_TEXT.notConfigured
  return fillTemplate(TAVERN_REPORT_PANEL_TEXT.aiFailure, { message })
}

/**
 * 复制报告全文：优先剪贴板 API，失败走 execCommand 兜底；
 * 全部失败返回错误文案（如实提示），成功返回 null。
 * clipboard 传 navigator.clipboard（unknown 类型，运行时形状校验，node 环境无 DOM）。
 */
export async function copyReportText(
  text: string,
  clipboard: unknown,
  fallback: () => boolean,
): Promise<string | null> {
  if (
    clipboard !== null &&
    typeof clipboard === 'object' &&
    typeof (clipboard as { writeText?: unknown }).writeText === 'function'
  ) {
    try {
      await (clipboard as { writeText: (value: string) => Promise<void> }).writeText(text)
      return null
    } catch {
      // 剪贴板被拒或写入失败：走 execCommand 兜底。
    }
  }
  return fallback() ? null : TAVERN_REPORT_PANEL_TEXT.copyFailed
}

/** execCommand 兜底：隐藏 textarea + document.execCommand('copy')。Document 由调用方传入（仅类型引用）。 */
export function copyViaExecCommand(doc: Document, text: string): boolean {
  const body = doc.body
  if (body === null) return false
  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  body.appendChild(textarea)
  let copied = false
  try {
    textarea.select()
    copied = doc.execCommand('copy') === true
  } catch {
    copied = false
  } finally {
    body.removeChild(textarea)
  }
  return copied
}
