/**
 * tavern-control（酒馆模式 · 控制面板）面板纯逻辑。
 *
 * 这里**不发请求、不碰 DOM**：文案常量、模式选项、设置校验、表单 ⇄
 * `TavernSettingsRecord` 装配、库值归一、AI 推荐请求与解析都是纯函数，
 * 逻辑测试（node 环境）直接覆盖这一层。
 *
 * 共享记录类型复用 `../tavern/types.js` 的 `TavernSettingsRecord`，绝不改它：
 * `advanced` 是自由文本键值对（预览版不解析，仅随设置一起保存、供各页签自行取用）。
 */

import type { AiRequest } from '../ai/types.js'
import type { TavernSettingsRecord } from '../tavern/types.js'

/**
 * 面板持久化 values（createPanelStore 的模板自动生成 `panel:tavern-control`）。
 * 类型别名（不是 interface）：createPanelStore 的约束是 `T extends Record<string, unknown>`，
 * 只有类型别名才有隐式索引签名。
 */
export type TavernControlPanelValues = {
  readonly settings: TavernSettingsRecord
}

/** 取值范围（面板层任务书冻结口径）：temperature 0–2 / maxTokens 1–200000 / contextMessages 1–100。 */
export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const MAX_TOKENS_MIN = 1
export const MAX_TOKENS_MAX = 200000
export const CONTEXT_MESSAGES_MIN = 1
export const CONTEXT_MESSAGES_MAX = 100

/** AI 推荐参数的一次补全上限（任务书约定 1024）。 */
export const AI_RECOMMEND_MAX_TOKENS = 1024

/** 对话模式选项（label 在这里定义一次，模板与 AI 请求只消费）。 */
export interface TavernModeOption {
  readonly value: 'normal' | 'free' | 'story'
  readonly label: string
}

export const TAVERN_MODES: readonly TavernModeOption[] = [
  { value: 'normal', label: '正常' },
  { value: 'free', label: '自由' },
  { value: 'story', label: '故事' },
]

/** 出厂默认值：不动它时行为与之前完全一致。 */
export function createDefaultPanelValues(): TavernControlPanelValues {
  return {
    settings: { mode: 'normal', temperature: 0.7, maxTokens: 2048, contextMessages: 20, advanced: {} },
  }
}

/**
 * 面板文案（可见文本 ⊆ 这里 ∪ `TabDef` 文案 ∪ `TAVERN_MODES` 的 label）。
 * 状态文案归属 `YfeStatusPill`，这里不再自造一套。
 */
export const TAVERN_CONTROL_PANEL_TEXT = {
  introLine1: '这里的设置是酒馆组的全局默认值；各页签保存的是各自面板的状态。',
  introLine2: '改完后其它酒馆页签在下次进入时读取。',
  formTitle: '全局设置',
  fieldMode: '模式',
  fieldTemperature: '温度',
  fieldMaxTokens: '单次生成上限',
  fieldContextMessages: '携带最近消息条数',
  fieldAdvanced: '高级参数',
  advancedNote: '开启后显示高级参数说明：自由文本键值对，预览版不解析，仅随设置保存、供各页签自行取用。',
  advancedEmpty: '还没有高级参数键值对。',
  advancedKeyPlaceholder: '参数名',
  advancedValuePlaceholder: '参数值',
  addRow: '添加键值对',
  removeRow: '删除',
  temperatureHint: '0–2，步进 0.1：调大更放飞，调小更稳定。',
  maxTokensHint: '单次回复最多生成的 token 数（1–200000）。',
  contextMessagesHint: '发给模型的上下文里携带的最近消息条数（1–100）。',
  aiTitle: 'AI 推荐参数',
  aiPurposeLabel: '用途',
  aiPurposePlaceholder: '如：轻松闲聊、快速脑暴、精修文风',
  aiButton: '生成推荐',
  aiButtonLoading: '推荐中…',
  aiRecommendation: '推荐结果',
  recommendLine: '温度 {temperature} · 单次生成上限 {maxTokens} · 携带最近 {contextMessages} 条',
  applyButton: '应用此推荐',
  applyDialogTitle: '应用推荐参数？',
  applyDialogConfirm: '应用',
  applyDialogCancel: '取消',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 推荐。',
  aiParseFailed: 'AI 返回的内容无法解析成参数建议（需要 temperature、maxTokens、contextMessages 三个数字），本次未应用。',
  aiFailure: '推荐失败：{message}',
  saveNow: '立即保存',
  loadingDetail: '正在读取面板状态…',
  lastSavedPrefix: '最后保存：',
  notSavedYet: '尚未保存',
  modeInvalid: '请选择对话模式',
  temperatureRange: '温度需在 0–2 之间',
  maxTokensRange: '单次生成上限需在 1–200000 之间',
  contextMessagesRange: '携带消息条数需在 1–100 之间',
  purposeFallback: '暂无补充说明',
} as const

/** 表单镜像（number input 全是字符串：原样回显，别替用户改写；非法值报错不落库）。 */
export interface TavernSettingsFormRaw {
  readonly mode: string
  readonly temperature: string
  readonly maxTokens: string
  readonly contextMessages: string
}

/** 高级参数的一行键值（预览版不解析，仅作备注）。 */
export interface AdvancedRow {
  readonly key: string
  readonly value: string
}

/** 设置校验结果：通过时带解析好的数字，失败时带第一条中文错误。 */
export type SettingsValidation =
  | { readonly ok: true; readonly temperature: number; readonly maxTokens: number; readonly contextMessages: number }
  | { readonly ok: false; readonly error: string }

/** 数字输入解析：空串/无法解析 → null（调用方报中文错误，不静默兜默认值）。 */
export function parseNumberInput(raw: string): number | null {
  const text = raw.trim()
  if (text.length === 0) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

/** 设置校验：mode 必须是 TAVERN_MODES 之一；temperature 允许小数，maxTokens/contextMessages 必须是正整数。 */
export function validateSettings(input: {
  readonly mode: string
  readonly temperature: number | null
  readonly maxTokens: number | null
  readonly contextMessages: number | null
}): SettingsValidation {
  if (!TAVERN_MODES.some((option) => option.value === input.mode)) {
    return { ok: false, error: TAVERN_CONTROL_PANEL_TEXT.modeInvalid }
  }
  if (input.temperature === null || !inRange(input.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)) {
    return { ok: false, error: TAVERN_CONTROL_PANEL_TEXT.temperatureRange }
  }
  if (
    input.maxTokens === null ||
    !Number.isInteger(input.maxTokens) ||
    !inRange(input.maxTokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX)
  ) {
    return { ok: false, error: TAVERN_CONTROL_PANEL_TEXT.maxTokensRange }
  }
  if (
    input.contextMessages === null ||
    !Number.isInteger(input.contextMessages) ||
    !inRange(input.contextMessages, CONTEXT_MESSAGES_MIN, CONTEXT_MESSAGES_MAX)
  ) {
    return { ok: false, error: TAVERN_CONTROL_PANEL_TEXT.contextMessagesRange }
  }
  return {
    ok: true,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    contextMessages: input.contextMessages,
  }
}

/** 表单 → 记录：非法值返回 `{ settings: null, error }`（不落库）。 */
export function settingsFromForm(
  form: TavernSettingsFormRaw,
  advanced: Readonly<Record<string, string>>,
): { readonly settings: TavernSettingsRecord | null; readonly error: string | null } {
  const validation = validateSettings({
    mode: form.mode,
    temperature: parseNumberInput(form.temperature),
    maxTokens: parseNumberInput(form.maxTokens),
    contextMessages: parseNumberInput(form.contextMessages),
  })
  if (!validation.ok) return { settings: null, error: validation.error }
  return {
    settings: {
      mode: form.mode,
      temperature: validation.temperature,
      maxTokens: validation.maxTokens,
      contextMessages: validation.contextMessages,
      advanced: { ...advanced },
    },
    error: null,
  }
}

/** 只校验表单（不改库值时也显式提示，比如载入后发现库值越界）。 */
export function formErrorOnly(form: TavernSettingsFormRaw): string | null {
  const validation = validateSettings({
    mode: form.mode,
    temperature: parseNumberInput(form.temperature),
    maxTokens: parseNumberInput(form.maxTokens),
    contextMessages: parseNumberInput(form.contextMessages),
  })
  return validation.ok ? null : validation.error
}

/** 两份设置是否一致（advanced 按键值序比较；一致就不标脏、不触发无谓的自动保存）。 */
export function settingsEqual(a: TavernSettingsRecord, b: TavernSettingsRecord): boolean {
  return (
    a.mode === b.mode &&
    a.temperature === b.temperature &&
    a.maxTokens === b.maxTokens &&
    a.contextMessages === b.contextMessages &&
    JSON.stringify(a.advanced) === JSON.stringify(b.advanced)
  )
}

/**
 * 库值 → 设置（健壮归一：缺字段/类型不对兜出厂默认值；advanced 过滤掉非字符串值，
 * 预览版不解析只透传）。
 */
export function resolveSettings(value: unknown): TavernSettingsRecord {
  const defaults = createDefaultPanelValues().settings
  if (typeof value !== 'object' || value === null) return { ...defaults }
  const raw = value as Record<string, unknown>
  const advancedRaw =
    typeof raw.advanced === 'object' && raw.advanced !== null && !Array.isArray(raw.advanced)
      ? (raw.advanced as Record<string, unknown>)
      : {}
  const advanced: Record<string, string> = {}
  for (const [key, entry] of Object.entries(advancedRaw)) {
    if (typeof entry === 'string') advanced[key] = entry
  }
  return {
    mode: typeof raw.mode === 'string' ? raw.mode : defaults.mode,
    temperature:
      typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
        ? raw.temperature
        : defaults.temperature,
    maxTokens:
      typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) ? raw.maxTokens : defaults.maxTokens,
    contextMessages:
      typeof raw.contextMessages === 'number' && Number.isInteger(raw.contextMessages) && raw.contextMessages > 0
        ? raw.contextMessages
        : defaults.contextMessages,
    advanced,
  }
}

/**
 * 库值里的未知模式（比如旧版写入的 'chat'）在 UI 里归一成 'normal'：
 * 下拉只认 TAVERN_MODES，未知值没有可显示的选项。
 */
export function normalizeMode(mode: string): TavernModeOption['value'] {
  for (const option of TAVERN_MODES) {
    if (option.value === mode) return option.value
  }
  return 'normal'
}

/** 模式 → 中文 label（未知值原样透出，别静默吞掉）。 */
export function modeLabel(mode: string): string {
  for (const option of TAVERN_MODES) {
    if (option.value === mode) return option.label
  }
  return mode
}

/** 键值行 → advanced：空键（还没起名）跳过，别把 `{ "": "" }` 存进库。 */
export function advancedFromRows(rows: readonly AdvancedRow[]): Record<string, string> {
  const advanced: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    advanced[key] = row.value
  }
  return advanced
}

/** advanced → 键值行（载入时回显）。 */
export function rowsFromAdvanced(advanced: Readonly<Record<string, string>> | undefined): AdvancedRow[] {
  return Object.entries(advanced ?? {}).map(([key, value]) => ({ key, value }))
}

/**
 * 推荐参数请求：当前模式 + 用途交给模型；system 要求只回 JSON，
 * `maxTokens` 传 1024（任务书约定）。
 */
export function buildAiRecommendRequest(mode: string, purpose: string): AiRequest {
  const system = [
    '你是「青春幻想引擎」的参数助手。',
    '用户会给出当前对话模式与用途，请只输出一个 JSON 对象，字段：',
    '{"temperature": 0 到 2 的数字, "maxTokens": 1 到 200000 的整数, "contextMessages": 1 到 100 的整数}',
    '不要输出解释文字，不要输出代码围栏以外的内容。',
  ].join('\n')
  const effectivePurpose = purpose.trim().length === 0 ? TAVERN_CONTROL_PANEL_TEXT.purposeFallback : purpose.trim()
  const user = [
    `当前模式：${modeLabel(mode)}。`,
    `用途：${effectivePurpose}。`,
    '请给这一组对话推荐 temperature、maxTokens、contextMessages。',
  ].join('\n')
  return { system, messages: [{ role: 'user', content: user }], maxTokens: AI_RECOMMEND_MAX_TOKENS }
}

/** 推荐参数（三个数字都解析成功才有效）。 */
export interface RecommendDraft {
  readonly temperature: number
  readonly maxTokens: number
  readonly contextMessages: number
}

/** 剥掉 ```json 代码围栏（AI 有时会包一层），容忍前后说明文字。 */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  // noUncheckedIndexedAccess 下捕获组是 string | undefined：空围栏回退原文。
  const body = fenced === null || fenced[1] === undefined ? text : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // 模型常把数字包成字符串（"0.8"）：能解析就收，不能就当解析失败。
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * AI 回复 → 推荐参数。严格口径：JSON 解析失败、缺字段、越界、maxTokens/contextMessages
 * 非整数都算解析失败（返回 null），调用方显示错误、不落库。
 */
export function parseAiRecommend(text: string): RecommendDraft | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(text))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as Record<string, unknown>
  const temperature = coerceNumber(raw.temperature)
  const maxTokens = coerceNumber(raw.maxTokens)
  const contextMessages = coerceNumber(raw.contextMessages)
  if (temperature === null || !inRange(temperature, TEMPERATURE_MIN, TEMPERATURE_MAX)) return null
  if (maxTokens === null || !Number.isInteger(maxTokens) || !inRange(maxTokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX)) {
    return null
  }
  if (
    contextMessages === null ||
    !Number.isInteger(contextMessages) ||
    !inRange(contextMessages, CONTEXT_MESSAGES_MIN, CONTEXT_MESSAGES_MAX)
  ) {
    return null
  }
  return { temperature, maxTokens, contextMessages }
}

/** 保存状态（六态里本面板只会出现四种；中文文案归属 YfeStatusPill，这里只定枚举）。 */
export type PanelSaveStatus = 'saved' | 'dirty' | 'saving' | 'error'

/** 保存中 > 错误 > 未保存 > 已保存。 */
export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PanelSaveStatus {
  if (saving) return 'saving'
  if (hasError) return 'error'
  if (dirty) return 'dirty'
  return 'saved'
}

/** 最后保存时间 → HH:MM:SS（解析失败给空串，调用方退回「尚未保存」）。 */
export function formatSaveTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `{key}` 占位符替换（tavern-card 同款）。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** AI 失败 → 提示文案：未配置给引导，其它给「推荐失败：{message}」。 */
export function failureNotice(code: string, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') return TAVERN_CONTROL_PANEL_TEXT.notConfigured
  return fillTemplate(TAVERN_CONTROL_PANEL_TEXT.aiFailure, { message })
}
