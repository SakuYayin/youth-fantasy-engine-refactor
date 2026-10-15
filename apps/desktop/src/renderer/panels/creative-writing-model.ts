/**
 * creative-writing（创意写作）面板的纯逻辑：提示词拼装、来源截断、结果解析、会话参数解析。
 *
 * 全部为纯函数 + 常量，不依赖 Vue、不触碰状态与 DOM、不发起任何请求；
 * AI 请求由面板组件通过 `props.state.ai.complete(request)` 发出。
 */

import type { DocumentSummary } from '@yfe/contracts'

import type { AppSnapshot } from '../app-state.js'
import type { AiRequest } from '../ai/types.js'

/** 续写模式的默认生成长度（AiRequest.maxTokens，可选项）。改写/润色默认不传 maxTokens。 */
export const CONTINUE_MAX_TOKENS = 4096

/** 来源正文上限（字符）：超长时截取开头并显式提示，绝不静默截断。 */
export const MAX_SOURCE_CHARS = 30_000

/** AiRequest.temperature 的常规上限：超过即视为填写错误。 */
export const TEMPERATURE_MAX = 2

export type WritingModeId = 'continue' | 'rewrite' | 'polish'

export interface WritingMode {
  /** 模式 id，与持久化 values.mode 对应。 */
  readonly id: WritingModeId
  /** 界面展示名。 */
  readonly label: string
  /** 模式说明（界面提示）。 */
  readonly hint: string
  /** 按模式切换的 system 提示词。 */
  readonly system: string
  /** 用户消息末尾的收束指令。 */
  readonly closing: string
}

/** 三种写作模式（system 按模式切换：续写=接着原文自然续写；改写=改写不改原意；润色=只修文字不顺情节）。 */
export const writingModes: readonly WritingMode[] = [
  {
    id: 'continue',
    label: '续写',
    hint: '接着原文自然续写：保持人物、视角与情节走向一致，原文一字不改。',
    system:
      '你是中文网文续写助手。用户给出一段正文，你要接着它自然续写：保持叙事视角、人物性格、文风与情节走向一致；不重复原文，不复述剧情，不解释，直接输出续写的正文。',
    closing: '请接着上面的原文自然续写，直接输出续写内容，不要重复原文，不要任何解释。',
  },
  {
    id: 'rewrite',
    label: '改写',
    hint: '在保持原意不变的前提下改写：可调整表达与细节，不改人物、情节与设定。',
    system:
      '你是中文网文改写助手。用户给出一段正文，你要在保持原意不变的前提下改写它：可以调整句式、表达与细节描写，但不得改变人物设定、情节走向与既有事实；不要解释，直接输出改写后的正文。',
    closing: '请在保持原意的前提下改写上面的正文，直接输出改写结果，不要复述原文，不要任何解释。',
  },
  {
    id: 'polish',
    label: '润色',
    hint: '只修文字：错别字、语病与标点，不顺情节、不增删内容。',
    system:
      '你是中文网文润色助手。用户给出一段正文，你只修正文字层面的问题：错别字、语病、用词不当与标点；不改动情节、人物与设定，不增删情节内容，不续写新情节；不要解释，直接输出润色后的全文。',
    closing: '请只修润上面正文的文字，直接输出润色后的全文，不要改动情节，不要任何解释。',
  },
]

/** 判断字符串是否为合法的模式 id（用于持久化值恢复）。 */
export function isWritingModeId(value: string): value is WritingModeId {
  return value === 'continue' || value === 'rewrite' || value === 'polish'
}

/** 按 id 取模式；未知 id（旧持久化值）回退到「续写」，界面只提供这三种。 */
export function writingModeById(id: string): WritingMode {
  const found = writingModes.find((mode) => mode.id === id)
  return found ?? writingModes[0]!
}

/** 当前作品的可用章节（kind === 'chapter' 且未删除，DeletedFlag 数值语义）。 */
export function readChapters(snapshot: AppSnapshot): readonly DocumentSummary[] {
  if (snapshot.projectId === null) return []
  return snapshot.documents.filter(
    (document) =>
      document.kind === 'chapter' &&
      document.deleted === 0 &&
      document.projectId === snapshot.projectId,
  )
}

export interface TruncatedSource {
  /** 截断后的正文（未超长时与原文相同）。 */
  readonly text: string
  /** 是否发生截断：调用方必须把提示显式展示给用户。 */
  readonly truncated: boolean
}

/**
 * 超长截取开头 MAX_SOURCE_CHARS 字。
 * 调用方必须把 truncated 显式提示给用户（「已截取前 30000 字」），绝不静默截断。
 */
export function truncateSource(sourceText: string): TruncatedSource {
  if (sourceText.length <= MAX_SOURCE_CHARS) {
    return { text: sourceText, truncated: false }
  }
  return { text: sourceText.slice(0, MAX_SOURCE_CHARS), truncated: true }
}

/** 会话参数（AiRequest 的可选项）；缺省字段表示「不传、按模式默认」。 */
export interface WritingSessionOptions {
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface BuiltWritingRequest {
  /** 待发送的 AI 请求（system 按模式切换）。 */
  readonly request: AiRequest
  /** 来源是否被截断（显式提示用）。 */
  readonly truncated: boolean
  /** 实际发送的正文长度。 */
  readonly sourceChars: number
  /** 实际使用的 maxTokens：null 表示不传（改写/润色未指定时）。 */
  readonly usedMaxTokens: number | null
}

/**
 * 拼装 AI 请求：用户消息 =【正文】+【写作要求】(可选) + 模式收束指令。
 * 续写默认 maxTokens: 4096；其它模式默认不传 maxTokens；
 * options 显式给出的 temperature/maxTokens 优先。
 */
export function buildWritingRequest(
  modeId: WritingModeId,
  sourceText: string,
  instruction: string,
  options: WritingSessionOptions = {},
): BuiltWritingRequest {
  const mode = writingModeById(modeId)
  const source = truncateSource(sourceText)
  const requirement = instruction.trim()

  const sections: string[] = [`【正文】\n${source.text}`]
  if (requirement !== '') {
    sections.push(`【写作要求】\n${requirement}`)
  }
  sections.push(mode.closing)

  const maxTokens: number | undefined =
    options.maxTokens ?? (modeId === 'continue' ? CONTINUE_MAX_TOKENS : undefined)

  const request: AiRequest = {
    system: mode.system,
    messages: [{ role: 'user', content: sections.join('\n\n') }],
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }

  return {
    request,
    truncated: source.truncated,
    sourceChars: source.text.length,
    usedMaxTokens: maxTokens === undefined ? null : maxTokens,
  }
}

export interface ParsedWritingResult {
  readonly ok: boolean
  /** 展示用文本：成功 = 整理后的结果；失败 = 原文（失败显原文，不静默丢弃内容）。 */
  readonly text: string
  readonly message: string | null
}

/**
 * 解析 AI 返回文本：纯文本续写/改写/润色，无 JSON 结构，原样展示（只去首尾空白）；
 * 空结果视为失败（message 提示），展示文本保留原文，绝不静默丢弃内容。
 */
export function parseWritingResult(text: string): ParsedWritingResult {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { ok: false, text, message: WRITING_COPY.resultEmpty }
  }
  return { ok: true, text: trimmed, message: null }
}

/** 解析可选数字输入框：空串 = 未填（undefined，不传）；合法数字 = 数值；其它 = 无效（null，调用方提示）。 */
export function parseOptionalNumber(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return undefined
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    return null
  }
  return value
}

export interface ResolvedSessionParams {
  readonly temperature?: number
  readonly maxTokens?: number
  /** 非空表示参数非法：调用方给出提示且不发送请求。 */
  readonly error: string | null
}

/** 解析会话参数（temperature 0–2；maxTokens 正整数）：空 = 不传；非法/越界 = 中文错误且不发送。 */
export function resolveSessionParams(temperatureRaw: string, maxTokensRaw: string): ResolvedSessionParams {
  const temperature = parseOptionalNumber(temperatureRaw)
  if (temperature === null || (temperature !== undefined && temperature > TEMPERATURE_MAX)) {
    return { error: WRITING_COPY.paramInvalid }
  }
  const maxTokens = parseOptionalNumber(maxTokensRaw)
  if (maxTokens === null || (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1))) {
    return { error: WRITING_COPY.paramInvalid }
  }
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    error: null,
  }
}

/** 结果字数行（展示用）。 */
export function resultCharsLine(count: number): string {
  return `${WRITING_COPY.resultCharsPrefix} ${count} ${WRITING_COPY.resultCharsSuffix}`
}

/** 面板持久化 values（createPanelStore 模板自动 panel:creative-writing）。 */
export interface WritingPanelValues extends Record<string, unknown> {
  readonly mode: WritingModeId
  readonly instruction: string
  readonly temperature: string
  readonly maxTokens: string
}

export const DEFAULT_WRITING_VALUES: WritingPanelValues = {
  mode: 'continue',
  instruction: '',
  temperature: '',
  maxTokens: '',
}

/** 面板自身持久化的保存状态（YfeStatusPill 六态的子集）。 */
export type WritingSaveStatus = 'saving' | 'dirty' | 'error' | 'saved'

/** 面板保存态：saving > error > dirty > saved。 */
export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): WritingSaveStatus {
  if (saving) {
    return 'saving'
  }
  if (hasError) {
    return 'error'
  }
  if (dirty) {
    return 'dirty'
  }
  return 'saved'
}

/** 面板界面文案唯一来源（全中文）。 */
export const WRITING_COPY = {
  intro: '把正文粘贴到下面，或从当前作品带入一章；选择模式与写要求后生成，结果先给你过目。',
  sourceTitle: '来源正文',
  sourcePlaceholder: '粘贴正文，或点上方「带入正文」从当前作品带一章进来…',
  sourceRequired: '请先粘贴正文，或选择章节后点「带入正文」。',
  sourceOverLimit: '正文超过 30000 字：生成时将只截取开头 30000 字，其余不发送。',
  truncatedNotice: '已截取前 30000 字：原文超长，本次只把开头 30000 字发给模型。',
  chaptersLabel: '章节（带入来源）',
  bringLabel: '带入正文',
  bringNote: '带入非当前章节时会同时把正文编辑器切到该章节。',
  bringNoChapter: '请先选择一章。',
  bringFailed: '带入失败：章节读取失败，请稍后重试。',
  bringEmpty: '该章节还没有正文：先在正文编辑器里写点内容，或直接粘贴正文。',
  loadingChapters: '正在带入章节…',
  emptyChapters: '当前作品还没有可用章节：先在正文编辑器新建作品与章节，或直接在下方粘贴正文。',
  modeTitle: '模式与要求',
  modeLabel: '模式',
  instructionLabel: '写要求（可选）',
  instructionPlaceholder: '例如「打斗写细一点」「对话再口语些」「结尾的钩子更狠一些」…',
  paramsLabel: '会话参数',
  temperatureLabel: '采样温度（可选，0–2）',
  maxTokensLabel: '最大生成长度（可选）',
  maxTokensHint: '留空＝按模式默认：续写 4096，改写/润色不传（由模型配置决定）。',
  paramInvalid: '会话参数需为数字（温度 0–2、生成长度正整数）；本次未发送。',
  generateLabel: '生成',
  cancelLabel: '取消',
  cancelNote: '已取消：仅忽略这次结果，模型侧请求不会中断。',
  copyLabel: '复制',
  copied: '已复制到剪贴板。',
  copyFailed: '复制失败：请手动选中结果文本复制。',
  insertNote: '插入到正文：预览版没有写回正文的通道 —— 请先复制，再到正文编辑器手动粘贴。',
  stateLabel: '状态：',
  stateIdle: '空闲',
  stateGenerating: '生成中…',
  stateDone: '已完成',
  stateFailed: '生成失败',
  resultTitle: 'AI 结果',
  resultEmptyBox: '（还没有生成结果）',
  resultCharsPrefix: '结果',
  resultCharsSuffix: '字',
  charsUnit: '字',
  notConfiguredGuide: '未配置模型：请先到『模型设置』页签配置接口地址、模型名与 API Key，再回来生成。',
  resultEmpty: '模型返回了空内容：请重试或调整写要求。',
  untitledChapter: '未命名章节',
} as const
