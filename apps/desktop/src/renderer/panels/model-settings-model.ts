/**
 * 模型设置面板（model-settings）的纯逻辑与文案：表单 ⇄ 配置的装配、
 * 数字输入解析、脱敏摘要与保存结果文案。
 *
 * 权威文档：docs/接口冻结-面板层.md（§2 PanelProps / §4 AI 契约 / §5 文件所有权）。
 *
 * 三条纪律（§4 AI 契约）：
 * 1. apiKey 是敏感值：表单**不回显明文**（password 型，加载后恒为空字符串），
 *    留空保存时回退到已保存的 Key（不丢失）；对外展示一律 `redactAiConfig`
 *    （apiKey 只显「已配置/未配置」——设计文档 11:44）。
 * 2. 配置按作品保存：saveConfig 失败且没有当前作品时，面板先引导建作品，
 *    文案由本模块常量统一给出（不得自造）。
 * 3. 归一化/校验/脱敏直接调用共享层 `renderer/ai/config.ts` 的现成函数，
 *    本模块只做「表单 ⇄ 配置」的装配与编排，不重写任何校验逻辑。
 */

import { DEFAULT_AI_MODEL_CONFIG, redactAiConfig, validateAiModelConfig } from '../ai/config.js'
import type { AiModelConfig } from '../ai/types.js'

/** 面板文案（全中文；§2：组件内不写死大段静态文案，放同级 .ts 便于测试与替换）。 */
export const MODEL_SETTINGS_PANEL_TEXT = {
  /** 面板引言（tab.description 之外的补充说明）。 */
  intro: '模型请求只在主进程发出（渲染层不联网）；配置按作品保存，API Key 只存本地库、永不回显明文。',
  /** 状态区标签。 */
  statusLabel: '模型状态',
  /** 已配置状态（绿）。 */
  statusConfigured: '已配置',
  /** 未配置状态（灰）。 */
  statusNotConfigured: '未配置',
  /** 表单区块标题。 */
  formTitle: '模型配置',
  /** 字段标签（顺序 = 表单字段顺序）。 */
  fieldBaseUrl: '接口地址',
  fieldModel: '模型名',
  fieldApiKey: 'API Key',
  fieldTemperature: 'temperature',
  fieldMaxTokens: 'maxTokens',
  fieldTimeoutMs: '超时时间（毫秒）',
  /** 字段占位（apiKey 的两个占位按「是否已配置」切换）。 */
  fieldBaseUrlPlaceholder: 'https://api.example.com/v1',
  fieldModelPlaceholder: '如 deepseek-chat',
  fieldApiKeyPlaceholderConfigured: '已保存的 Key 不回显：留空保持不变，输入新值则覆盖',
  fieldApiKeyPlaceholderEmpty: '尚未配置，请输入 API Key',
  /** 保存按钮与在途文案。 */
  save: '保存配置',
  saving: '保存中…',
  /** 保存成功提示。 */
  saveOk: '配置已保存',
  /** 重载按钮与在途文案。 */
  reload: '重载配置',
  reloading: '重载中…',
  /** 无当前作品时的引导（按作品保存的硬性文案，验收逐字断言）。 */
  needProject: '请先在左侧新建作品再保存配置（模型配置按作品保存）',
  /** 其它保存失败的兜底文案。 */
  saveFailed: '保存失败，请重试',
  /** 新建作品失败（引导流程里 createProject 返回 false）。 */
  createProjectFailed: '新建作品失败，请重试',
  /** 引导块里的作品名输入。 */
  projectNameLabel: '作品名',
  projectNamePlaceholder: '输入作品名后新建',
  /** 引导块按钮：新建作品成功后自动重跑保存。 */
  createAndRetry: '新建作品并保存',
} as const

/**
 * 表单原始值：**全字符串**（v-model 绑定文本输入框的天然形状），
 * 数字字段由 `parseNumberInput` 在装配时解析。
 *
 * 字段可写（无 readonly）：v-model 需要就地赋值；表单缓冲区不是契约对象。
 */
export interface ModelSettingsFormRaw {
  baseUrl: string
  model: string
  apiKey: string
  temperature: string
  maxTokens: string
  timeoutMs: string
}

/**
 * 空表单（未配置时的起底 = DEFAULT_AI_MODEL_CONFIG 的输入框形状）。
 * apiKey 恒为空串：绝不把已保存的明文 Key 灌回输入框。
 */
export const EMPTY_MODEL_SETTINGS_FORM: Readonly<ModelSettingsFormRaw> = {
  baseUrl: DEFAULT_AI_MODEL_CONFIG.baseUrl,
  model: DEFAULT_AI_MODEL_CONFIG.model,
  apiKey: '',
  temperature: String(DEFAULT_AI_MODEL_CONFIG.temperature),
  maxTokens: String(DEFAULT_AI_MODEL_CONFIG.maxTokens),
  timeoutMs: String(DEFAULT_AI_MODEL_CONFIG.timeoutMs),
}

/**
 * 数字输入解析：空串 → 回退默认值；可解析 → 数字；其余（乱码）→ NaN，
 * NaN 交给 `validateAiModelConfig` 报中文错误，不在装配层吞掉。
 */
export function parseNumberInput(raw: string, fallback: number): number {
  if (raw.trim().length === 0) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * 表单 → 配置：归一化（trim / 数字解析 / apiKey 回退）。
 *
 * - apiKey：输入框里键入了新值就用新值（trim）；留空且已加载到旧配置则**沿用已保存的
 *   Key**（不回显明文的代价由装配层补：留空 = 保持不变）；都没有 → 空串，
 *   由 `validateAiModelConfig` 报「API Key 不能为空」。
 * - provider：表单没有该字段（目前只有 openai-compatible），沿用旧配置的值，否则取默认。
 * - `existing` 是最近一次 `props.state.ai.getConfig()` 的结果（可为 null）。
 */
export function formToConfig(raw: ModelSettingsFormRaw, existing?: AiModelConfig | null): AiModelConfig {
  const typedKey = raw.apiKey.trim()
  return {
    provider: existing?.provider ?? DEFAULT_AI_MODEL_CONFIG.provider,
    baseUrl: raw.baseUrl.trim(),
    model: raw.model.trim(),
    apiKey: typedKey.length > 0 ? typedKey : (existing?.apiKey ?? ''),
    temperature: parseNumberInput(raw.temperature, DEFAULT_AI_MODEL_CONFIG.temperature),
    maxTokens: parseNumberInput(raw.maxTokens, DEFAULT_AI_MODEL_CONFIG.maxTokens),
    timeoutMs: parseNumberInput(raw.timeoutMs, DEFAULT_AI_MODEL_CONFIG.timeoutMs),
  }
}

/**
 * 配置 → 表单：灌进输入框的形状。
 *
 * `config === null`（尚未配置）→ 用 DEFAULT_AI_MODEL_CONFIG 起底；
 * apiKey **恒为空串**（绝不回显明文，占位文案提示「留空保持不变」）。
 */
export function applyConfigToForm(config: AiModelConfig | null): ModelSettingsFormRaw {
  if (config === null) return { ...EMPTY_MODEL_SETTINGS_FORM }
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: '',
    temperature: String(config.temperature),
    maxTokens: String(config.maxTokens),
    timeoutMs: String(config.timeoutMs),
  }
}

/** 表单装配结果：`error` 非 null 时为中文错误说明（直接显示、不发保存）。 */
export interface ModelSettingsAssembly {
  readonly config: AiModelConfig
  readonly error: string | null
}

/** 编排：formToConfig + validateAiModelConfig（.vue 只调用这一个函数）。 */
export function assembleConfig(raw: ModelSettingsFormRaw, existing?: AiModelConfig | null): ModelSettingsAssembly {
  const config = formToConfig(raw, existing)
  return { config, error: validateAiModelConfig(config) }
}

/** 状态区摘要条目（label：value）。 */
export interface ModelSettingsSummaryItem {
  readonly label: string
  readonly value: string
}

/**
 * 状态区摘要：全部走 `redactAiConfig`（apiKey 只显「已配置/未配置」，
 * 明文 Key 绝不进返回值）。
 */
export function redactedSummary(config: AiModelConfig): readonly ModelSettingsSummaryItem[] {
  const redacted = redactAiConfig(config)
  return [
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldBaseUrl, value: String(redacted.baseUrl) },
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldModel, value: String(redacted.model) },
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldApiKey, value: String(redacted.apiKey) },
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldTemperature, value: String(redacted.temperature) },
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldMaxTokens, value: String(redacted.maxTokens) },
    { label: MODEL_SETTINGS_PANEL_TEXT.fieldTimeoutMs, value: String(redacted.timeoutMs) },
  ]
}

/** 保存结果：三分支各带显示文案（.vue 只按 kind 决定渲染哪一块）。 */
export type ModelSettingsSaveOutcome =
  | { readonly kind: 'saved'; readonly message: string }
  | { readonly kind: 'needProject'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * 保存结果编排：
 * - 成功 → `saved`（配置已保存）；
 * - 失败且没有当前作品（`saveConfig` 按作品存）→ `needProject`（引导建作品）；
 * - 其它失败 → `failed`（保存失败，请重试）。
 */
export function saveOutcome(saveOk: boolean, hasProject: boolean): ModelSettingsSaveOutcome {
  if (saveOk) return { kind: 'saved', message: MODEL_SETTINGS_PANEL_TEXT.saveOk }
  if (!hasProject) return { kind: 'needProject', message: MODEL_SETTINGS_PANEL_TEXT.needProject }
  return { kind: 'failed', message: MODEL_SETTINGS_PANEL_TEXT.saveFailed }
}
