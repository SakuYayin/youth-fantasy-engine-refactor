/**
 * 模型配置的纯函数（渲染层 AI 层）。
 *
 * 为什么放纯函数：配置的「归一化 / 是否已配置 / 脱敏」都要单测，
 * 而且不依赖 Vue 与 IPC。`.vue` 与 `ai-port.ts` 只调用。
 *
 * 🔴 `apiKey` 是敏感值：`redactAiConfig` 是唯一允许对外展示的形态；
 *    任何日志/错误/导出里出现明文 key 都算违反设计文档 11:44。
 */

import type { AiModelConfig } from './types.js'

/** 模型配置在 `settings_entities` 里的模板 ID（`panel:` 前缀 = 面板命名空间）。 */
export const AI_CONFIG_TEMPLATE_ID = 'panel:ai-config'
/** 模型配置行的显示名。 */
export const AI_CONFIG_NAME = '模型配置'

export const DEFAULT_AI_MODEL_CONFIG: Readonly<AiModelConfig> = {
  provider: 'openai-compatible',
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMs: 180_000,
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 把库里的 `values` 归一化成配置；缺字段用默认值补齐，未知键忽略。
 *
 * 旧版/手工编辑的库值可能缺字段，归一化保证拿到的一定是完整形状。
 */
export function normalizeAiModelConfig(raw: unknown): AiModelConfig {
  const values = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    provider: asString(values.provider) || DEFAULT_AI_MODEL_CONFIG.provider,
    baseUrl: asString(values.baseUrl).trim(),
    model: asString(values.model).trim(),
    apiKey: asString(values.apiKey),
    temperature: asNumber(values.temperature, DEFAULT_AI_MODEL_CONFIG.temperature),
    maxTokens: asNumber(values.maxTokens, DEFAULT_AI_MODEL_CONFIG.maxTokens),
    timeoutMs: asNumber(values.timeoutMs, DEFAULT_AI_MODEL_CONFIG.timeoutMs),
  }
}

/** 三要素齐全才算配置过（baseUrl/model/apiKey）。 */
export function isAiConfigured(config: AiModelConfig | null): boolean {
  return (
    config !== null &&
    config.baseUrl.length > 0 &&
    /^https?:\/\//i.test(config.baseUrl) &&
    config.model.length > 0 &&
    config.apiKey.trim().length > 0
  )
}

/** 对外展示形态：apiKey 只显示「已配置/未配置」，绝不显示明文。 */
export function redactAiConfig(config: AiModelConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey.trim().length > 0 ? '已配置' : '未配置',
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  }
}

/** 校验用户填的配置是否可保存（表单层用）；返回 null 或中文错误说明。 */
export function validateAiModelConfig(config: AiModelConfig): string | null {
  if (!/^https?:\/\//i.test(config.baseUrl.trim())) {
    return '接口地址必须以 http(s):// 开头'
  }
  if (config.model.trim().length === 0) {
    return '模型名不能为空'
  }
  if (config.apiKey.trim().length === 0) {
    return 'API Key 不能为空'
  }
  if (!(config.temperature >= 0 && config.temperature <= 2)) {
    return 'temperature 取值范围 0–2'
  }
  if (!(config.maxTokens > 0 && config.maxTokens <= 200_000)) {
    return 'maxTokens 取值范围 1–200000'
  }
  if (!(config.timeoutMs > 0 && config.timeoutMs <= 600_000)) {
    return '超时时间取值范围 1–600000 毫秒'
  }
  return null
}
