/**
 * 模型设置面板纯逻辑（model-settings-model）的测试：
 * 表单 ⇄ 配置装配、数字输入解析、脱敏摘要、保存结果文案与校验路径。
 *
 * node 环境（纯函数，无 DOM）。
 */
import { describe, expect, it } from 'vitest'

import { validateAiModelConfig } from '../../src/renderer/ai/config.js'
import type { AiModelConfig } from '../../src/renderer/ai/types.js'
import {
  EMPTY_MODEL_SETTINGS_FORM,
  MODEL_SETTINGS_PANEL_TEXT,
  applyConfigToForm,
  assembleConfig,
  formToConfig,
  parseNumberInput,
  redactedSummary,
  saveOutcome,
  type ModelSettingsFormRaw,
} from '../../src/renderer/panels/model-settings-model.js'

/** 已配置好的配置夹具（含明文 Key——只在模型层流转，绝不进展示）。 */
function configFixture(): AiModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-secret-key',
    temperature: 0.7,
    maxTokens: 2048,
    timeoutMs: 180000,
  }
}

/**
 * 表单夹具基线 = 合法配置的输入框形状（与 configFixture 同值，apiKey 为占位值）：
 * 单字段扰动测试靠「其它字段全合法」来隔离目标字段的校验路径
 * （validateAiModelConfig 按 baseUrl → model → apiKey → temperature → maxTokens → timeout 顺序报错）。
 */
function form(input: Partial<ModelSettingsFormRaw>): ModelSettingsFormRaw {
  return {
    baseUrl: 'https://api.example.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-key',
    temperature: '0.7',
    maxTokens: '2048',
    timeoutMs: '180000',
    ...input,
  }
}

describe('formToConfig：表单 → 配置的装配', () => {
  it('baseUrl / model trim；数字字段解析成 number', () => {
    const config = formToConfig(
      form({
        baseUrl: '  https://api.example.com/v1  ',
        model: ' deepseek-chat ',
        apiKey: '  sk-key  ',
        temperature: '0.9',
        maxTokens: '4096',
        timeoutMs: '120000',
      }),
    )
    expect(config.baseUrl).toBe('https://api.example.com/v1')
    expect(config.model).toBe('deepseek-chat')
    expect(config.apiKey).toBe('sk-key')
    expect(config.temperature).toBe(0.9)
    expect(config.maxTokens).toBe(4096)
    expect(config.timeoutMs).toBe(120000)
  })

  it('数字字段留空 → 回退 DEFAULT_AI_MODEL_CONFIG 的默认值', () => {
    const config = formToConfig(
      form({
        baseUrl: 'https://api.example.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-key',
        temperature: '',
        maxTokens: '',
        timeoutMs: '',
      }),
    )
    expect(config.temperature).toBe(0.7)
    expect(config.maxTokens).toBe(2048)
    expect(config.timeoutMs).toBe(180000)
  })

  it('数字字段乱码 → NaN（交给 validateAiModelConfig 报中文错误，不在装配层吞掉）', () => {
    const config = formToConfig(form({ temperature: 'abc' }))
    expect(config.temperature).toBeNaN()
    expect(validateAiModelConfig(config)).toBe('temperature 取值范围 0–2')
  })

  it('apiKey 键入了新值 → 用新值（trim）', () => {
    const config = formToConfig(form({ apiKey: ' sk-new ' }), configFixture())
    expect(config.apiKey).toBe('sk-new')
  })

  it('apiKey 留空且已加载到旧配置 → 沿用已保存的 Key（不回显明文的代价由装配层补）', () => {
    const config = formToConfig(form({ apiKey: '' }), configFixture())
    expect(config.apiKey).toBe('sk-secret-key')
  })

  it('apiKey 留空且未配置 → 空串，校验报「API Key 不能为空」', () => {
    const config = formToConfig(form({ apiKey: '' }))
    expect(config.apiKey).toBe('')
    expect(validateAiModelConfig(config)).toBe('API Key 不能为空')
  })

  it('provider 沿用旧配置的值；未配置时取默认 openai-compatible', () => {
    expect(formToConfig(form({}), configFixture()).provider).toBe('openai-compatible')
    expect(formToConfig(form({}), null).provider).toBe('openai-compatible')
  })
})

describe('applyConfigToForm：配置 → 表单', () => {
  it('null（尚未配置）→ DEFAULT_AI_MODEL_CONFIG 起底，apiKey 为空', () => {
    const raw = applyConfigToForm(null)
    expect(raw).toEqual({
      baseUrl: '',
      model: '',
      apiKey: '',
      temperature: '0.7',
      maxTokens: '2048',
      timeoutMs: '180000',
    })
  })

  it('已配置 → 字段灌进表单；apiKey 恒为空串（绝不回显明文）', () => {
    const raw = applyConfigToForm(configFixture())
    expect(raw.baseUrl).toBe('https://api.example.com/v1')
    expect(raw.model).toBe('deepseek-chat')
    expect(raw.apiKey).toBe('')
    expect(raw.temperature).toBe('0.7')
    expect(raw.maxTokens).toBe('2048')
    expect(raw.timeoutMs).toBe('180000')
  })

  it('装配往返：applyConfigToForm(config) 后补 Key，formToConfig 还原出同一份配置', () => {
    const fixture = configFixture()
    const raw = { ...applyConfigToForm(fixture), apiKey: fixture.apiKey }
    expect(formToConfig(raw, fixture)).toEqual(fixture)
  })
})

describe('assembleConfig：装配 + 校验编排', () => {
  it('合法表单 → error 为 null，config 为归一化结果', () => {
    const { config, error } = assembleConfig(
      form({
        baseUrl: 'https://api.example.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-key',
        temperature: '1.5',
        maxTokens: '4096',
        timeoutMs: '600000',
      }),
    )
    expect(error).toBeNull()
    expect(config.temperature).toBe(1.5)
    expect(config.timeoutMs).toBe(600000)
  })

  it('各字段的中文错误串（validateAiModelConfig 的映射路径）', () => {
    expect(assembleConfig(form({ baseUrl: 'ftp://x' })).error).toBe('接口地址必须以 http(s):// 开头')
    expect(assembleConfig(form({ model: '' })).error).toBe('模型名不能为空')
    expect(assembleConfig(form({ apiKey: '' })).error).toBe('API Key 不能为空')
    expect(assembleConfig(form({ temperature: '3' })).error).toBe('temperature 取值范围 0–2')
    expect(assembleConfig(form({ maxTokens: '0' })).error).toBe('maxTokens 取值范围 1–200000')
    expect(assembleConfig(form({ timeoutMs: '700000' })).error).toBe('超时时间取值范围 1–600000 毫秒')
  })

  it('temperature = 0 合法（0 是边界值，不是缺省）', () => {
    const { error } = assembleConfig(form({ temperature: '0' }))
    expect(error).toBeNull()
  })
})

describe('redactedSummary：脱敏摘要', () => {
  it('apiKey 显示「已配置」，明文 Key 绝不进返回值', () => {
    const items = redactedSummary(configFixture())
    const apiKeyItem = items.find((item) => item.label === 'API Key')
    expect(apiKeyItem?.value).toBe('已配置')
    expect(JSON.stringify(items)).not.toContain('sk-secret-key')
  })

  it('apiKey 为空显示「未配置」', () => {
    const items = redactedSummary({ ...configFixture(), apiKey: '   ' })
    expect(items.find((item) => item.label === 'API Key')?.value).toBe('未配置')
  })

  it('摘要按表单字段顺序给出全部六项（label 与表单标签一致）', () => {
    const items = redactedSummary(configFixture())
    expect(items.map((item) => item.label)).toEqual([
      MODEL_SETTINGS_PANEL_TEXT.fieldBaseUrl,
      MODEL_SETTINGS_PANEL_TEXT.fieldModel,
      MODEL_SETTINGS_PANEL_TEXT.fieldApiKey,
      MODEL_SETTINGS_PANEL_TEXT.fieldTemperature,
      MODEL_SETTINGS_PANEL_TEXT.fieldMaxTokens,
      MODEL_SETTINGS_PANEL_TEXT.fieldTimeoutMs,
    ])
    expect(items[0]?.value).toBe('https://api.example.com/v1')
    expect(items[1]?.value).toBe('deepseek-chat')
    expect(items[3]?.value).toBe('0.7')
    expect(items[4]?.value).toBe('2048')
    expect(items[5]?.value).toBe('180000')
  })
})

describe('saveOutcome：保存结果文案', () => {
  it('成功 → saved（配置已保存）', () => {
    const outcome = saveOutcome(true, true)
    expect(outcome.kind).toBe('saved')
    expect(outcome.message).toBe(MODEL_SETTINGS_PANEL_TEXT.saveOk)
  })

  it('失败且无当前作品 → needProject（按作品保存的硬性引导文案，逐字）', () => {
    const outcome = saveOutcome(false, false)
    expect(outcome.kind).toBe('needProject')
    expect(outcome.message).toBe('请先在左侧新建作品再保存配置（模型配置按作品保存）')
  })

  it('失败但有当前作品 → failed（保存失败，请重试，逐字）', () => {
    const outcome = saveOutcome(false, true)
    expect(outcome.kind).toBe('failed')
    expect(outcome.message).toBe('保存失败，请重试')
  })
})

describe('常量与契约', () => {
  it('EMPTY_MODEL_SETTINGS_FORM 的数字字段与 DEFAULT_AI_MODEL_CONFIG 对应', () => {
    expect(EMPTY_MODEL_SETTINGS_FORM.temperature).toBe('0.7')
    expect(EMPTY_MODEL_SETTINGS_FORM.maxTokens).toBe('2048')
    expect(EMPTY_MODEL_SETTINGS_FORM.timeoutMs).toBe('180000')
    expect(EMPTY_MODEL_SETTINGS_FORM.apiKey).toBe('')
  })

  it('parseNumberInput：空串回退 / 数字解析 / 乱码 NaN', () => {
    expect(parseNumberInput('', 7)).toBe(7)
    expect(parseNumberInput('  ', 7)).toBe(7)
    expect(parseNumberInput('42', 7)).toBe(42)
    expect(parseNumberInput('abc', 7)).toBeNaN()
  })
})
