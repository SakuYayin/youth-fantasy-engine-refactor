/**
 * tavern-control（酒馆模式 · 控制面板）面板纯逻辑测试。
 *
 * 覆盖：常量与文案 / 出厂默认值 / 数字输入解析 / 设置校验 / 表单 ⇄ 记录装配 /
 * 库值归一与未知模式 / 高级参数键值行 / AI 推荐请求与解析 / 保存状态 /
 * 最后保存时间格式 / 占位符与失败文案。
 *
 * AI 纯逻辑按冻结契约放在同级 .ts，这里不碰 DOM、不发请求。
 */
import { describe, expect, it } from 'vitest'

import {
  AI_RECOMMEND_MAX_TOKENS,
  CONTEXT_MESSAGES_MAX,
  CONTEXT_MESSAGES_MIN,
  MAX_TOKENS_MAX,
  MAX_TOKENS_MIN,
  TAVERN_CONTROL_PANEL_TEXT as TEXT,
  TAVERN_MODES,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  advancedFromRows,
  buildAiRecommendRequest,
  createDefaultPanelValues,
  extractJson,
  failureNotice,
  fillTemplate,
  formErrorOnly,
  formatSaveTime,
  modeLabel,
  normalizeMode,
  panelSaveStatus,
  parseAiRecommend,
  parseNumberInput,
  resolveSettings,
  rowsFromAdvanced,
  settingsEqual,
  settingsFromForm,
  validateSettings,
} from '../../src/renderer/panels/tavern-control-model.js'
import type { TavernSettingsRecord } from '../../src/renderer/tavern/types.js'

/** TavernSettingsRecord 夹具。 */
function settingsRecord(input: Partial<TavernSettingsRecord> = {}): TavernSettingsRecord {
  return {
    mode: input.mode ?? 'normal',
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 2048,
    contextMessages: input.contextMessages ?? 20,
    advanced: input.advanced ?? {},
  }
}

/** 合法校验输入（逐字段覆盖用）。 */
function validInput(): {
  mode: string
  temperature: number | null
  maxTokens: number | null
  contextMessages: number | null
} {
  return { mode: 'normal', temperature: 0.7, maxTokens: 2048, contextMessages: 20 }
}

describe('tavern-control：常量与文案', () => {
  it('文案常量全为非空字符串', () => {
    for (const [key, value] of Object.entries(TEXT)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('模式选项：normal/free/story 三项，label 非空且互不相同', () => {
    expect(TAVERN_MODES).toHaveLength(3)
    expect(TAVERN_MODES.map((option) => option.value)).toEqual(['normal', 'free', 'story'])
    const labels = TAVERN_MODES.map((option) => option.label)
    for (const label of labels) expect(label.length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(3)
  })

  it('取值范围与 AI 补全上限常量符合任务书口径', () => {
    expect(TEMPERATURE_MIN).toBe(0)
    expect(TEMPERATURE_MAX).toBe(2)
    expect(MAX_TOKENS_MIN).toBe(1)
    expect(MAX_TOKENS_MAX).toBe(200000)
    expect(CONTEXT_MESSAGES_MIN).toBe(1)
    expect(CONTEXT_MESSAGES_MAX).toBe(100)
    expect(AI_RECOMMEND_MAX_TOKENS).toBe(1024)
  })
})

describe('tavern-control：出厂默认值', () => {
  it('默认值：normal / 0.7 / 2048 / 20 / 空高级参数', () => {
    expect(createDefaultPanelValues()).toEqual({
      settings: { mode: 'normal', temperature: 0.7, maxTokens: 2048, contextMessages: 20, advanced: {} },
    })
  })

  it('两次调用不共享引用（改一处不串另一处）', () => {
    const first = createDefaultPanelValues()
    const second = createDefaultPanelValues()
    expect(first.settings.advanced).not.toBe(second.settings.advanced)
    expect(first.settings).not.toBe(second.settings)
  })
})

describe('tavern-control：数字输入解析', () => {
  it('空串与纯空白 → null（不静默兜默认值）', () => {
    expect(parseNumberInput('')).toBe(null)
    expect(parseNumberInput('   ')).toBe(null)
  })

  it('非数字 → null', () => {
    expect(parseNumberInput('abc')).toBe(null)
    expect(parseNumberInput('0.7.2')).toBe(null)
  })

  it('合法数字原样解析（含小数、负数、指数）', () => {
    expect(parseNumberInput('1.5')).toBe(1.5)
    expect(parseNumberInput('0')).toBe(0)
    expect(parseNumberInput('-0.5')).toBe(-0.5)
    expect(parseNumberInput(' 2 ')).toBe(2)
    expect(parseNumberInput('1e2')).toBe(100)
  })
})

describe('tavern-control：设置校验', () => {
  it('模式必须是 TAVERN_MODES 之一（含旧版口径之外的值报「请选择对话模式」）', () => {
    expect(validateSettings({ ...validInput(), mode: 'chat' }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), mode: '' }).ok).toBe(false)
    const failed = validateSettings({ ...validInput(), mode: 'chat' })
    if (!failed.ok) expect(failed.error).toBe(TEXT.modeInvalid)
  })

  it('温度：缺值/越界报「温度需在 0–2 之间」，0/2/小数合法', () => {
    expect(validateSettings({ ...validInput(), temperature: null }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), temperature: -0.1 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), temperature: 2.1 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), temperature: 0 }).ok).toBe(true)
    expect(validateSettings({ ...validInput(), temperature: 2 }).ok).toBe(true)
    expect(validateSettings({ ...validInput(), temperature: 1.5 }).ok).toBe(true)
    const failed = validateSettings({ ...validInput(), temperature: 3 })
    if (!failed.ok) expect(failed.error).toBe(TEXT.temperatureRange)
  })

  it('单次生成上限：必须是 1–200000 的正整数', () => {
    expect(validateSettings({ ...validInput(), maxTokens: null }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), maxTokens: 0 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), maxTokens: 200001 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), maxTokens: 1.5 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), maxTokens: 1 }).ok).toBe(true)
    expect(validateSettings({ ...validInput(), maxTokens: 200000 }).ok).toBe(true)
    const failed = validateSettings({ ...validInput(), maxTokens: -1 })
    if (!failed.ok) expect(failed.error).toBe(TEXT.maxTokensRange)
  })

  it('携带消息条数：必须是 1–100 的正整数', () => {
    expect(validateSettings({ ...validInput(), contextMessages: null }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), contextMessages: 0 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), contextMessages: 101 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), contextMessages: 2.5 }).ok).toBe(false)
    expect(validateSettings({ ...validInput(), contextMessages: 1 }).ok).toBe(true)
    expect(validateSettings({ ...validInput(), contextMessages: 100 }).ok).toBe(true)
    const failed = validateSettings({ ...validInput(), contextMessages: 999 })
    if (!failed.ok) expect(failed.error).toBe(TEXT.contextMessagesRange)
  })

  it('全部合法 → ok 带解析好的数字', () => {
    const result = validateSettings({ mode: 'story', temperature: 1.2, maxTokens: 4096, contextMessages: 30 })
    expect(result).toEqual({ ok: true, temperature: 1.2, maxTokens: 4096, contextMessages: 30 })
  })
})

describe('tavern-control：表单 ⇄ 记录装配', () => {
  it('合法表单 → 完整记录，advanced 是拷贝不是同一引用', () => {
    const advanced = { style: '轻小说' }
    const result = settingsFromForm(
      { mode: 'story', temperature: '1.2', maxTokens: '4096', contextMessages: '30' },
      advanced,
    )
    expect(result.error).toBe(null)
    expect(result.settings).toEqual({
      mode: 'story',
      temperature: 1.2,
      maxTokens: 4096,
      contextMessages: 30,
      advanced: { style: '轻小说' },
    })
    expect(result.settings?.advanced).not.toBe(advanced)
  })

  it('非法表单 → settings 为 null 且带第一条中文错误（不落库）', () => {
    const invalid = settingsFromForm(
      { mode: 'normal', temperature: '9', maxTokens: '2048', contextMessages: '20' },
      {},
    )
    expect(invalid.settings).toBe(null)
    expect(invalid.error).toBe(TEXT.temperatureRange)
  })

  it('空串输入 → 报对应中文错误', () => {
    expect(
      settingsFromForm({ mode: 'normal', temperature: '', maxTokens: '2048', contextMessages: '20' }, {}).error,
    ).toBe(TEXT.temperatureRange)
    expect(
      settingsFromForm({ mode: 'normal', temperature: '0.7', maxTokens: '', contextMessages: '20' }, {}).error,
    ).toBe(TEXT.maxTokensRange)
  })

  it('formErrorOnly：合法 → null，非法 → 同一套文案（不改库值时也显式提示）', () => {
    expect(formErrorOnly({ mode: 'normal', temperature: '0.7', maxTokens: '2048', contextMessages: '20' })).toBe(null)
    expect(formErrorOnly({ mode: 'normal', temperature: '0.7', maxTokens: '0', contextMessages: '20' })).toBe(
      TEXT.maxTokensRange,
    )
    expect(formErrorOnly({ mode: 'chat', temperature: '0.7', maxTokens: '2048', contextMessages: '20' })).toBe(
      TEXT.modeInvalid,
    )
  })

  it('settingsEqual：四字段任一差异都判不等', () => {
    const base = settingsRecord()
    expect(settingsEqual(base, settingsRecord())).toBe(true)
    expect(settingsEqual(base, settingsRecord({ mode: 'story' }))).toBe(false)
    expect(settingsEqual(base, settingsRecord({ temperature: 0.8 }))).toBe(false)
    expect(settingsEqual(base, settingsRecord({ maxTokens: 4096 }))).toBe(false)
    expect(settingsEqual(base, settingsRecord({ contextMessages: 30 }))).toBe(false)
    expect(settingsEqual(base, settingsRecord({ advanced: { a: '1' } }))).toBe(false)
  })

  it('settingsEqual：advanced 同内容不同键序按不等处理（保守：顶多多存一次，无害）', () => {
    const a = settingsRecord({ advanced: { a: '1', b: '2' } })
    const b = settingsRecord({ advanced: { b: '2', a: '1' } })
    expect(settingsEqual(a, b)).toBe(false)
  })
})

describe('tavern-control：库值归一与未知模式', () => {
  it('非对象（null/字符串/数字/数组）→ 出厂默认值', () => {
    const defaults = settingsRecord()
    expect(resolveSettings(null)).toEqual(defaults)
    expect(resolveSettings('旧数据')).toEqual(defaults)
    expect(resolveSettings(42)).toEqual(defaults)
    expect(resolveSettings([1, 2])).toEqual(defaults)
  })

  it('缺字段 → 逐字段补默认', () => {
    expect(resolveSettings({ mode: 'story' })).toEqual(settingsRecord({ mode: 'story' }))
    expect(resolveSettings({ temperature: 1.2 })).toEqual(settingsRecord({ temperature: 1.2 }))
    expect(resolveSettings({})).toEqual(settingsRecord())
  })

  it('非法值逐字段兜默认：NaN/Infinity/非正整数', () => {
    expect(resolveSettings({ temperature: Number.NaN }).temperature).toBe(0.7)
    expect(resolveSettings({ temperature: Number.POSITIVE_INFINITY }).temperature).toBe(0.7)
    expect(resolveSettings({ maxTokens: '很多' }).maxTokens).toBe(2048)
    expect(resolveSettings({ contextMessages: 0 }).contextMessages).toBe(20)
    expect(resolveSettings({ contextMessages: -3 }).contextMessages).toBe(20)
    expect(resolveSettings({ contextMessages: 2.5 }).contextMessages).toBe(20)
  })

  it('advanced 只收字符串键值（非字符串过滤，数组当空）', () => {
    expect(resolveSettings({ advanced: { a: '1', b: 2, c: null } }).advanced).toEqual({ a: '1' })
    expect(resolveSettings({ advanced: ['a', 'b'] }).advanced).toEqual({})
    expect(resolveSettings({ advanced: '自由文本' }).advanced).toEqual({})
  })

  it('库里的未知模式（旧版 chat）显示归一成「正常」', () => {
    expect(normalizeMode('normal')).toBe('normal')
    expect(normalizeMode('free')).toBe('free')
    expect(normalizeMode('story')).toBe('story')
    expect(normalizeMode('chat')).toBe('normal')
    expect(normalizeMode('')).toBe('normal')
  })

  it('modeLabel：已知值给中文 label，未知值原样透出（不静默吞掉）', () => {
    expect(modeLabel('normal')).toBe('正常')
    expect(modeLabel('free')).toBe('自由')
    expect(modeLabel('story')).toBe('故事')
    expect(modeLabel('chat')).toBe('chat')
  })
})

describe('tavern-control：高级参数键值行', () => {
  it('rowsFromAdvanced：记录 → 行（undefined 给空数组）', () => {
    expect(rowsFromAdvanced({ style: '轻小说' })).toEqual([{ key: 'style', value: '轻小说' }])
    expect(rowsFromAdvanced(undefined)).toEqual([])
    expect(rowsFromAdvanced({})).toEqual([])
  })

  it('advancedFromRows：空键/纯空白键跳过，键 trim，重复键后值覆盖', () => {
    expect(
      advancedFromRows([
        { key: '', value: '丢弃' },
        { key: '  ', value: '也丢弃' },
        { key: ' style ', value: '轻小说' },
        { key: 'style', value: '散文' },
      ]),
    ).toEqual({ style: '散文' })
  })

  it('行 ⇄ 记录往返一致', () => {
    const advanced = { style: '轻小说', tone: '明亮' }
    expect(advancedFromRows(rowsFromAdvanced(advanced))).toEqual(advanced)
  })
})

describe('tavern-control：AI 推荐请求与解析', () => {
  it('请求：单条 user 消息、maxTokens 1024、system 要 JSON 与三个字段名', () => {
    const request = buildAiRecommendRequest('normal', '轻松闲聊')
    expect(request.maxTokens).toBe(1024)
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.system).toContain('JSON')
    expect(request.system).toContain('temperature')
    expect(request.system).toContain('maxTokens')
    expect(request.system).toContain('contextMessages')
  })

  it('请求带当前模式中文与用途；用途空白给兜底文案', () => {
    const withPurpose = buildAiRecommendRequest('story', '  精修文风  ')
    expect(withPurpose.messages[0]?.content).toContain('当前模式：故事')
    expect(withPurpose.messages[0]?.content).toContain('用途：精修文风')
    const withoutPurpose = buildAiRecommendRequest('free', '   ')
    expect(withoutPurpose.messages[0]?.content).toContain(`用途：${TEXT.purposeFallback}`)
  })

  it('extractJson：剥掉代码围栏、容忍前后说明文字、无大括号原样返回', () => {
    expect(extractJson('```json\n{"temperature":1}\n```')).toBe('{"temperature":1}')
    expect(extractJson('建议如下：{"temperature":1} 请参考')).toBe('{"temperature":1}')
    expect(extractJson('没有对象')).toBe('没有对象')
  })

  it('parseAiRecommend：合法 JSON（含围栏与前后缀）→ 三数字草稿', () => {
    expect(parseAiRecommend('{"temperature":0.8,"maxTokens":1024,"contextMessages":12}')).toEqual({
      temperature: 0.8,
      maxTokens: 1024,
      contextMessages: 12,
    })
    expect(
      parseAiRecommend('好的，推荐如下\n```json\n{"temperature":0.8,"maxTokens":1024,"contextMessages":12}\n```\n'),
    ).toEqual({ temperature: 0.8, maxTokens: 1024, contextMessages: 12 })
  })

  it('parseAiRecommend：数字字符串也收（"0.8" → 0.8）', () => {
    expect(parseAiRecommend('{"temperature":"0.8","maxTokens":"1024","contextMessages":"12"}')).toEqual({
      temperature: 0.8,
      maxTokens: 1024,
      contextMessages: 12,
    })
  })

  it('parseAiRecommend：缺字段/越界/非整数 → null（显示错误、不落库）', () => {
    expect(parseAiRecommend('{"temperature":0.8,"maxTokens":1024}')).toBe(null)
    expect(parseAiRecommend('{"temperature":3,"maxTokens":1024,"contextMessages":12}')).toBe(null)
    expect(parseAiRecommend('{"temperature":-1,"maxTokens":1024,"contextMessages":12}')).toBe(null)
    expect(parseAiRecommend('{"temperature":0.8,"maxTokens":1024.5,"contextMessages":12}')).toBe(null)
    expect(parseAiRecommend('{"temperature":0.8,"maxTokens":0,"contextMessages":12}')).toBe(null)
    expect(parseAiRecommend('{"temperature":0.8,"maxTokens":1024,"contextMessages":101}')).toBe(null)
    expect(parseAiRecommend('{"temperature":"","maxTokens":1024,"contextMessages":12}')).toBe(null)
  })

  it('parseAiRecommend：非 JSON / 数组 / null 字面量 → null', () => {
    expect(parseAiRecommend('我建议温度 1.1，其余自己看着办')).toBe(null)
    expect(parseAiRecommend('[1,2,3]')).toBe(null)
    expect(parseAiRecommend('null')).toBe(null)
    expect(parseAiRecommend('')).toBe(null)
  })
})

describe('tavern-control：保存状态与显示', () => {
  it('panelSaveStatus：保存中 > 错误 > 未保存 > 已保存', () => {
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, false, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })

  it('formatSaveTime：本地构造 → ISO → 时分秒往返（不依赖时区）', () => {
    const local = new Date(2026, 5, 1, 12, 34, 56)
    expect(formatSaveTime(local.toISOString())).toBe('12:34:56')
    expect(formatSaveTime('2026-06-01T00:00:00.000Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('formatSaveTime：解析失败给空串（调用方退回「尚未保存」）', () => {
    expect(formatSaveTime('不是时间')).toBe('')
  })

  it('fillTemplate：{key} 替换、缺失 key 原样保留', () => {
    expect(fillTemplate(TEXT.recommendLine, { temperature: '0.8', maxTokens: '1024', contextMessages: '12' })).toBe(
      '温度 0.8 · 单次生成上限 1024 · 携带最近 12 条',
    )
    expect(fillTemplate('值 {missing} 不变', { other: 'x' })).toBe('值 {missing} 不变')
  })

  it('failureNotice：未配置给引导文案，其它给「推荐失败：{message}」', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '任意')).toBe(TEXT.notConfigured)
    expect(failureNotice('AI_TIMEOUT', '上游超时')).toBe('推荐失败：上游超时')
  })
})
