/**
 * 模型配置纯函数的单测（apps/desktop/src/renderer/ai/config.ts）。
 *
 * 重点：
 * - `redactAiConfig` 是唯一允许对外展示的形态，apiKey 绝不能出现在输出里；
 * - `normalizeAiModelConfig` 要容忍缺字段/非法数字的库值；
 * - `validateAiModelConfig` 的中文错误文案与上下限。
 */

import { describe, expect, it } from 'vitest'

import {
  AI_CONFIG_NAME,
  AI_CONFIG_TEMPLATE_ID,
  DEFAULT_AI_MODEL_CONFIG,
  isAiConfigured,
  normalizeAiModelConfig,
  redactAiConfig,
  validateAiModelConfig,
} from '../src/renderer/ai/config.js'
import type { AiModelConfig } from '../src/renderer/ai/types.js'

function makeConfig(overrides: Partial<AiModelConfig> = {}): AiModelConfig {
  return { ...DEFAULT_AI_MODEL_CONFIG, ...overrides }
}

describe('ai 配置常量与默认值', () => {
  it('模板 ID 走 panel: 命名空间', () => {
    expect(AI_CONFIG_TEMPLATE_ID).toBe('panel:ai-config')
    expect(AI_CONFIG_NAME).toBe('模型配置')
  })

  it('默认配置是空三要素 + 合理采样参数', () => {
    expect(DEFAULT_AI_MODEL_CONFIG.provider).toBe('openai-compatible')
    expect(DEFAULT_AI_MODEL_CONFIG.baseUrl).toBe('')
    expect(DEFAULT_AI_MODEL_CONFIG.model).toBe('')
    expect(DEFAULT_AI_MODEL_CONFIG.apiKey).toBe('')
    expect(DEFAULT_AI_MODEL_CONFIG.temperature).toBe(0.7)
    expect(DEFAULT_AI_MODEL_CONFIG.maxTokens).toBe(2048)
    expect(DEFAULT_AI_MODEL_CONFIG.timeoutMs).toBe(180_000)
  })
})

describe('normalizeAiModelConfig', () => {
  it('null/undefined/非对象折算成默认值', () => {
    for (const raw of [null, undefined, 'x', 42]) {
      const config = normalizeAiModelConfig(raw)
      expect(config.baseUrl).toBe('')
      expect(config.model).toBe('')
      expect(config.apiKey).toBe('')
      expect(config.temperature).toBe(0.7)
      expect(config.maxTokens).toBe(2048)
      expect(config.timeoutMs).toBe(180_000)
    }
  })

  it('缺字段用默认补齐，库值覆盖，未知键忽略', () => {
    const config = normalizeAiModelConfig({
      baseUrl: 'https://api.example.com/v1',
      model: 'glm-5.3-flash',
      temperature: 0.2,
      unknownKey: 'kept-out',
    })
    expect(config.baseUrl).toBe('https://api.example.com/v1')
    expect(config.model).toBe('glm-5.3-flash')
    expect(config.apiKey).toBe('')
    expect(config.temperature).toBe(0.2)
    expect(config.maxTokens).toBe(2048)
    expect('unknownKey' in config).toBe(false)
  })

  it('baseUrl/model 去首尾空白，apiKey 原样保留（不改动密钥）', () => {
    const config = normalizeAiModelConfig({
      baseUrl: '  https://api.example.com/v1  ',
      model: ' glm-5.3-flash ',
      apiKey: '  sk-secret  ',
    })
    expect(config.baseUrl).toBe('https://api.example.com/v1')
    expect(config.model).toBe('glm-5.3-flash')
    expect(config.apiKey).toBe('  sk-secret  ')
  })

  it('非法数字（0/负数/NaN/字符串）回落默认值', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
      const config = normalizeAiModelConfig({ temperature: bad as unknown as number, maxTokens: bad as unknown as number, timeoutMs: bad as unknown as number })
      expect(config.temperature).toBe(0.7)
      expect(config.maxTokens).toBe(2048)
      expect(config.timeoutMs).toBe(180_000)
    }
  })
})

describe('isAiConfigured（三要素）', () => {
  it('null 与默认空配置都算未配置', () => {
    expect(isAiConfigured(null)).toBe(false)
    expect(isAiConfigured(makeConfig())).toBe(false)
  })

  it('缺 model / 缺 apiKey（含纯空白）都算未配置', () => {
    expect(isAiConfigured(makeConfig({ model: '' }))).toBe(false)
    expect(isAiConfigured(makeConfig({ apiKey: '   ' }))).toBe(false)
  })

  it('baseUrl 必须 http(s):// 开头', () => {
    expect(isAiConfigured(makeConfig({ baseUrl: 'ftp://api.example.com', model: 'm', apiKey: 'k' }))).toBe(false)
    expect(isAiConfigured(makeConfig({ baseUrl: 'api.example.com', model: 'm', apiKey: 'k' }))).toBe(false)
    expect(isAiConfigured(makeConfig({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', apiKey: 'k' }))).toBe(true)
    expect(isAiConfigured(makeConfig({ baseUrl: 'HTTPS://api.example.com/v1', model: 'm', apiKey: 'k' }))).toBe(true)
  })
})

describe('redactAiConfig（脱敏展示）', () => {
  it('apiKey 只显示已配置/未配置，明文绝不外泄', () => {
    const configured = redactAiConfig(makeConfig({ apiKey: 'sk-secret-value' }))
    expect(configured.apiKey).toBe('已配置')
    expect(JSON.stringify(configured)).not.toContain('sk-secret-value')

    const empty = redactAiConfig(makeConfig())
    expect(empty.apiKey).toBe('未配置')
  })

  it('其余字段原样展示', () => {
    const out = redactAiConfig(makeConfig({ baseUrl: 'https://api.example.com/v1', model: 'glm-5.3-flash', temperature: 0.3 }))
    expect(out.baseUrl).toBe('https://api.example.com/v1')
    expect(out.model).toBe('glm-5.3-flash')
    expect(out.temperature).toBe(0.3)
    expect(out.maxTokens).toBe(2048)
    expect(out.timeoutMs).toBe(180_000)
  })
})

describe('validateAiModelConfig（表单校验）', () => {
  it('合法配置返回 null', () => {
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }))).toBeNull()
  })

  it('三要素缺失/非法都有中文说明', () => {
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'ftp://x' }))).toContain('接口地址')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: ' ' }))).toContain('模型名')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: '' }))).toContain('API Key')
  })

  it('采样参数越界有中文说明', () => {
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', temperature: 2.1 }))).toContain('temperature')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', temperature: -0.1 }))).toContain('temperature')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', maxTokens: 0 }))).toContain('maxTokens')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', maxTokens: 200_001 }))).toContain('maxTokens')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', timeoutMs: 0 }))).toContain('超时')
    expect(validateAiModelConfig(makeConfig({ baseUrl: 'https://x', model: 'm', apiKey: 'k', timeoutMs: 600_001 }))).toContain('超时')
  })
})
