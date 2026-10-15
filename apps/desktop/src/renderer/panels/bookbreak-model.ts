/**
 * 一键拆书面板（tab.id = `bookbreak`）的纯逻辑与文案。
 *
 * 契约见 `docs/接口冻结-面板层.md`（§2 PanelProps、§4 AI 契约、§5 文件所有权）。
 *
 * 职责边界：提示词构造、超长截取、报告分节解析、失败提示、剪贴板复制、
 * 面板状态默认值等纯函数全部收在这里；`bookbreak.vue` 只做渲染与调用。
 * AI 调用只走 `props.state.ai.complete(request)`（渲染层 CSP 禁网，模型请求
 * 由 main 进程代理发出）；本模块不 import 'node:*'、不 fetch、不直连模型服务商。
 *
 * 旧版参考（只读，仅学结构与文案）：
 * `_upstream_tmp/youth-fantasy-engine-main/src/components/bookbreak/BookBreakPanel.tsx`
 * —— 旧版是「切分 → 写入正文 → 逐章抽取 → 草稿审阅 → 汇总设定」的多阶段流水线；
 * 本版按当前任务书收敛为「粘贴文本 → 一次 AI 生成拆书报告 → 复制 / 保存」的单次调用形态。
 */

import type { AiErrorCode, AiRequest } from '../ai/types.js'

/** 超长输入只截取开头的上限（字）。超过后必须显式提示，绝不静默截断。 */
export const MAX_INPUT_CHARS = 30_000

/** 拆书报告需要更大输出：complete 时传给 AiRequest.maxTokens。 */
export const BREAK_MAX_TOKENS = 4096

/** 分节 key 与标题：一句话故事核 / 主线梗概 / 人物卡 / 爽点清单 / 章节要点。 */
export const SECTION_KEYS = ['core', 'outline', 'characters', 'hooks', 'chapters'] as const

export type BreakSectionKey = (typeof SECTION_KEYS)[number]

export const SECTION_TITLES: Readonly<Record<BreakSectionKey, string>> = {
  core: '一句话故事核',
  outline: '主线梗概',
  characters: '人物卡',
  hooks: '爽点清单',
  chapters: '章节要点',
}

/** 兜底分节 key：模型输出没有可识别分节标头时原样显示（失败显原文）。 */
export const RAW_SECTION_KEY = 'raw'

/** 「已截取前 N 字」的显式提示模板。 */
export const TRUNCATED_NOTICE = '已截取前 {kept} 字（原文共 {total} 字）'

export interface BreakSection {
  /** 分节 key（SECTION_KEYS 之一，或兜底 `raw`）。 */
  key: string
  /** 展示用分节标题。 */
  title: string
  /** 分节正文（可能为空串）。 */
  body: string
}

export interface BreakInput {
  /** 发给模型的最终文本（超长时为截取后的开头）。 */
  text: string
  /** 是否发生了截取。 */
  truncated: boolean
  /** 原始输入字数。 */
  originalChars: number
  /** 实际发送字数。 */
  keptChars: number
}

export interface BreakRequest {
  /** 传给 props.state.ai.complete 的请求（system + messages + maxTokens）。 */
  request: AiRequest
  /** 是否发生了截取。 */
  truncated: boolean
  /** 原始输入字数。 */
  originalChars: number
  /** 实际发送字数。 */
  sentChars: number
}

export interface BuildBreakOptions {
  /** 覆盖截取上限（测试用；默认 MAX_INPUT_CHARS）。 */
  maxChars?: number
}

/** 面板状态默认值（按作品持久化，模板 panel:bookbreak）。type 别名以满足 store 的 Record 约束。 */
export type BookBreakPanelData = {
  /** 最近一次拆书报告全文。 */
  report: string
  /** 生成报告时模型返回的模型名（可为空）。 */
  model: string
}

/** 判空：空串或全是空白（含全角空格）都算没有输入。 */
export function isBlankText(text: string): boolean {
  return text.replace(/\s/g, '').length === 0
}

/** 超长只截取开头并显式标记（绝不静默截断）。 */
export function truncateInput(text: string, maxChars: number = MAX_INPUT_CHARS): BreakInput {
  const originalChars = [...text].length
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, keptChars: originalChars }
  }
  const kept = [...text].slice(0, maxChars).join('')
  return { text: kept, truncated: true, originalChars, keptChars: maxChars }
}

/** 「已截取前 N 字（原文共 M 字）」提示。 */
export function truncatedNoticeText(originalChars: number, keptChars: number): string {
  return TRUNCATED_NOTICE.replace('{kept}', String(keptChars)).replace('{total}', String(originalChars))
}

/** system 提示词：写明「网文拆书助手」角色与输出结构。 */
export function buildSystemPrompt(): string {
  return [
    '你是「网文拆书助手」，负责把一段小说原文拆解成结构化报告，供作者研究写法。',
    '请严格按以下五节输出，每节用【】标头，一节都不要省略：',
    '【一句话故事核】用一句话概括本书最核心的卖点与主角目标。',
    '【主线梗概】3-6 句话概括主线剧情走向与关键转折，不逐章流水账。',
    '【人物卡】列出主要人物：身份、性格、动机、与主角的关系，每人物 2-4 句。',
    '【爽点清单】逐条列出让读者情绪高涨的爽点（打脸、扮猪吃虎、金手指、装逼、逆袭等）。',
    '【章节要点】按顺序列出关键章节的推进作用，每章 1-2 句。',
    '只输出拆书报告本身，不要寒暄；原文之外的信息一律不要编造。',
  ].join('\n')
}

/** user 消息：把书文本包进固定标头，避免与指令混淆。 */
export function buildUserMessage(text: string): string {
  return `【小说文本】\n${text}`
}

/** 构造完整拆书请求：超长只截取开头并显式标记。 */
export function buildBreakRequest(text: string, options: BuildBreakOptions = {}): BreakRequest {
  const input = truncateInput(text, options.maxChars ?? MAX_INPUT_CHARS)
  const messages: AiRequest['messages'] = [{ role: 'user', content: buildUserMessage(input.text) }]
  return {
    request: { system: buildSystemPrompt(), messages, maxTokens: BREAK_MAX_TOKENS },
    truncated: input.truncated,
    originalChars: input.originalChars,
    sentChars: input.keptChars,
  }
}

/** 分节标头：【一句话故事核】。 */
const HEADING_PATTERN = /【([^【】]{1,20})】/g

/** 把分节标题归位到固定五节之一；识别不了返回 null。 */
function sectionKeyFor(title: string): BreakSectionKey | null {
  for (const key of SECTION_KEYS) {
    if (SECTION_TITLES[key] === title) return key
  }
  return null
}

/**
 * 解析拆书报告：按【】分节显示；模型输出没有可识别分节标头且非空时，
 * 整段作为 `raw` 兜底分节原样显示（失败显原文）。
 */
export function parseBreakReport(text: string): readonly BreakSection[] {
  if (text.replace(/\s/g, '').length === 0) return []

  const marks: { title: string; index: number }[] = []
  for (const match of text.matchAll(HEADING_PATTERN)) {
    const title = match[1]
    if (title === undefined) continue
    marks.push({ title, index: match.index ?? 0 })
  }
  if (marks.length === 0) {
    return [{ key: RAW_SECTION_KEY, title: '原始输出', body: text }]
  }

  const sections: BreakSection[] = []
  const first = marks[0]
  if (first === undefined) return [{ key: RAW_SECTION_KEY, title: '原始输出', body: text }]

  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i]
    if (mark === undefined) continue
    const start = mark.index + mark.title.length + 2
    const end = i + 1 < marks.length ? (marks[i + 1]?.index ?? text.length) : text.length
    const body = text.slice(start, end).replace(/^\s+/, '').replace(/\s+$/, '')
    const key = sectionKeyFor(mark.title)
    sections.push({ key: key ?? `extra:${mark.title}`, title: mark.title, body })
  }
  return sections
}

/** 失败提示：未配置模型给明确引导，其余如实带出服务端 message。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') {
    return '请先到『模型设置』页签配置接口地址、模型名与 API Key'
  }
  return `拆书失败：${message}`
}

/**
 * 复制报告：优先 navigator.clipboard，不可用（无 DOM / 无权限）时回退
 * document.execCommand('copy')；两者都不可用返回 false（面板提示失败）。
 * 不 import 'node:*'，不触碰网络。
 */
export async function copyReportText(text: string): Promise<boolean> {
  const nav = typeof navigator === 'undefined' ? null : navigator
  if (nav !== null && nav.clipboard !== undefined) {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      // 落到 execCommand 回退
    }
  }
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  return ok
}

/** 面板状态默认值。 */
export function createDefaultPanelData(): BookBreakPanelData {
  return { report: '', model: '' }
}

/** 面板文案（全中文）。 */
export const BOOKBREAK_PANEL_TEXT = {
  idleHint: '把要拆解的书文本粘贴到下方，点「开始拆书」即可生成拆书报告。',
  intro: '粘贴书文本后点「开始拆书」，AI 按五节结构（一句话故事核 / 主线梗概 / 人物卡 / 爽点清单 / 章节要点）生成拆书报告，可复制或保存到当前作品。',
  privacyNote: '原文只发给你当前选定的模型；本地模型不出本机。',
  inputLabel: '书文本',
  inputPlaceholder: '把小说原文粘贴到这里…',
  charCountUnit: ' 字',
  start: '开始拆书',
  starting: '拆书中…',
  cancel: '取消',
  cancelHint: '取消仅忽略结果，不会中止已发出的请求',
  cancelled: '已取消，结果将被忽略',
  copy: '复制报告',
  copied: '已复制到剪贴板',
  copyFailed: '复制失败，请手动选中文本复制',
  save: '保存',
  saved: '已保存到当前作品',
  noProject: '请先在左侧新建作品再保存',
  dirtyHint: '有未保存修改，点「保存」落库',
  reportTitle: '拆书报告',
  modelLabel: '模型',
  emptyText: '请先粘贴或导入原文',
  notConfigured: '请先到『模型设置』页签配置接口地址、模型名与 API Key',
  reportEmpty: '模型返回了空报告，请重试或更换模型',
  loadedFromStore: '已载入当前作品保存的上次拆书报告。',
  rawFallbackHint: '模型输出没有可识别的分节标头，以下为原始输出。',
  failed: '拆书失败',
} as const
