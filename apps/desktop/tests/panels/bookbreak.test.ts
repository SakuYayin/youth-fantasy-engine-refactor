import { describe, expect, it } from 'vitest'

import {
  BOOKBREAK_PANEL_TEXT,
  BREAK_MAX_TOKENS,
  MAX_INPUT_CHARS,
  RAW_SECTION_KEY,
  SECTION_TITLES,
  buildBreakRequest,
  buildSystemPrompt,
  buildUserMessage,
  copyReportText,
  createDefaultPanelData,
  failureNotice,
  isBlankText,
  parseBreakReport,
  truncateInput,
  truncatedNoticeText,
} from '../../src/renderer/panels/bookbreak-model.js'

describe('常量', () => {
  it('MAX_INPUT_CHARS = 30000、BREAK_MAX_TOKENS = 4096', () => {
    expect(MAX_INPUT_CHARS).toBe(30_000)
    expect(BREAK_MAX_TOKENS).toBe(4096)
  })

  it('五节标题固定（一句话故事核/主线梗概/人物卡/爽点清单/章节要点）', () => {
    expect(Object.values(SECTION_TITLES)).toEqual([
      '一句话故事核',
      '主线梗概',
      '人物卡',
      '爽点清单',
      '章节要点',
    ])
  })
})

describe('truncateInput（超长只截取开头）', () => {
  it('短文本原样返回、不标记截取', () => {
    const input = truncateInput('第一章 开局')
    expect(input).toEqual({ text: '第一章 开局', truncated: false, originalChars: 6, keptChars: 6 })
  })

  it('恰好 30000 字不截断', () => {
    const text = '一'.repeat(MAX_INPUT_CHARS)
    const input = truncateInput(text)
    expect(input.truncated).toBe(false)
    expect(input.keptChars).toBe(MAX_INPUT_CHARS)
    expect(input.text).toBe(text)
  })

  it('超长只保留开头 30000 字，绝不静默截断', () => {
    const text = '一'.repeat(MAX_INPUT_CHARS) + '尾'
    const input = truncateInput(text)
    expect(input.truncated).toBe(true)
    expect(input.originalChars).toBe(MAX_INPUT_CHARS + 1)
    expect(input.keptChars).toBe(MAX_INPUT_CHARS)
    expect(input.text).toBe('一'.repeat(MAX_INPUT_CHARS))
    expect(input.text.includes('尾')).toBe(false)
  })

  it('maxChars 覆盖上限', () => {
    const input = truncateInput('一二三四五', 3)
    expect(input.text).toBe('一二三')
    expect(input.truncated).toBe(true)
    expect(input.originalChars).toBe(5)
    expect(input.keptChars).toBe(3)
  })
})

describe('truncatedNoticeText（显式提示）', () => {
  it('包含「已截取前 N 字」与原文总数', () => {
    const notice = truncatedNoticeText(45_000, 30_000)
    expect(notice).toContain('已截取前 30000 字')
    expect(notice).toContain('原文共')
    expect(notice).toContain('45000')
  })
})

describe('isBlankText', () => {
  it('空串与纯空白算没有输入', () => {
    expect(isBlankText('')).toBe(true)
    expect(isBlankText('   \n\t　')).toBe(true)
    expect(isBlankText('第一章')).toBe(false)
  })
})

describe('buildSystemPrompt / buildUserMessage', () => {
  it('system 写明「网文拆书助手」与五节输出结构', () => {
    const prompt = buildSystemPrompt()
    expect(prompt).toContain('网文拆书助手')
    expect(prompt).toContain('【一句话故事核】')
    expect(prompt).toContain('【主线梗概】')
    expect(prompt).toContain('【人物卡】')
    expect(prompt).toContain('【爽点清单】')
    expect(prompt).toContain('【章节要点】')
  })

  it('user 消息带【小说文本】标头并包住正文', () => {
    const message = buildUserMessage('主角开局被退婚。')
    expect(message.startsWith('【小说文本】')).toBe(true)
    expect(message).toContain('主角开局被退婚。')
  })
})

describe('buildBreakRequest', () => {
  it('短文本：单条 user 消息、system、maxTokens 4096、不截断', () => {
    const built = buildBreakRequest('主角开局被退婚。')
    expect(built.truncated).toBe(false)
    expect(built.originalChars).toBe(8)
    expect(built.sentChars).toBe(8)
    expect(built.request.maxTokens).toBe(4096)
    expect(built.request.system).toContain('网文拆书助手')
    expect(built.request.messages).toHaveLength(1)
    const first = built.request.messages[0]
    expect(first?.role).toBe('user')
    expect(first?.content).toContain('主角开局被退婚。')
    expect(first?.content).toContain('【小说文本】')
  })

  it('超长文本只截取开头，并把截取信息显式带回', () => {
    const text = '开'.repeat(10) + '中'.repeat(MAX_INPUT_CHARS - 10) + '尾'.repeat(5)
    const built = buildBreakRequest(text)
    expect(built.truncated).toBe(true)
    expect(built.originalChars).toBe(MAX_INPUT_CHARS + 5)
    expect(built.sentChars).toBe(MAX_INPUT_CHARS)
    const first = built.request.messages[0]
    expect(first?.content).toContain('开'.repeat(10))
    expect(first?.content.includes('尾')).toBe(false)
    // 显式提示（绝不能静默截断）
    expect(truncatedNoticeText(built.originalChars, built.sentChars)).toContain('已截取前 30000 字')
  })

  it('options.maxChars 覆盖上限', () => {
    const built = buildBreakRequest('一二三四五', { maxChars: 3 })
    expect(built.truncated).toBe(true)
    expect(built.sentChars).toBe(3)
    const first = built.request.messages[0]
    expect(first?.content).toContain('一二三')
    expect(first?.content.includes('四五')).toBe(false)
  })
})

describe('parseBreakReport（分节显示）', () => {
  it('五节全解析：保序、标题与正文齐全', () => {
    const report = [
      '【一句话故事核】',
      '废柴少年逆袭成为最强剑修。',
      '【主线梗概】',
      '开局被退婚，随后觉醒金手指。',
      '【人物卡】',
      '林尘：主角，性格坚韧。',
      '【爽点清单】',
      '当众打脸退婚的未婚妻。',
      '【章节要点】',
      '第1章：立主角与金手指。',
    ].join('\n')
    const sections = parseBreakReport(report)
    expect(sections).toHaveLength(5)
    expect(sections[0]?.key).toBe('core')
    expect(sections[0]?.title).toBe('一句话故事核')
    expect(sections[0]?.body).toContain('废柴少年')
    expect(sections[1]?.key).toBe('outline')
    expect(sections[1]?.body).toContain('金手指')
    expect(sections[2]?.key).toBe('characters')
    expect(sections[3]?.key).toBe('hooks')
    expect(sections[4]?.key).toBe('chapters')
    expect(sections[4]?.body).toContain('第1章')
  })

  it('部分分节按出现顺序解析', () => {
    const sections = parseBreakReport('【爽点清单】\n打脸。\n【章节要点】\n第2章推进。')
    expect(sections).toHaveLength(2)
    expect(sections[0]?.key).toBe('hooks')
    expect(sections[0]?.body).toBe('打脸。')
    expect(sections[1]?.key).toBe('chapters')
    expect(sections[1]?.body).toBe('第2章推进。')
  })

  it('无分节标头且非空 → 整段作为 raw 兜底（失败显原文）', () => {
    const sections = parseBreakReport('模型自由发挥的一段话。')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.key).toBe(RAW_SECTION_KEY)
    expect(sections[0]?.title).toBe('原始输出')
    expect(sections[0]?.body).toBe('模型自由发挥的一段话。')
  })

  it('空文本与纯空白返回空数组', () => {
    expect(parseBreakReport('')).toHaveLength(0)
    expect(parseBreakReport('  \n ')).toHaveLength(0)
  })

  it('标头后无正文 → body 为空串', () => {
    const sections = parseBreakReport('【一句话故事核】')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBe('一句话故事核')
    expect(sections[0]?.body).toBe('')
  })

  it('正文里出现的标头也会分节（前缀标头不丢内容）', () => {
    const sections = parseBreakReport('前缀【主线梗概】中段【人物卡】后段')
    expect(sections).toHaveLength(2)
    expect(sections[0]?.title).toBe('主线梗概')
    expect(sections[0]?.body).toBe('中段')
    expect(sections[1]?.title).toBe('人物卡')
    expect(sections[1]?.body).toBe('后段')
  })

  it('无法识别的标头按 extra 分节且不崩溃', () => {
    const sections = parseBreakReport('【世界观】说明')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBe('世界观')
    expect(sections[0]?.body).toBe('说明')
  })
})

describe('failureNotice', () => {
  it('AI_NOT_CONFIGURED 给明确引导（不禁用面板）', () => {
    const notice = failureNotice('AI_NOT_CONFIGURED', '尚未配置可用模型')
    expect(notice).toBe(BOOKBREAK_PANEL_TEXT.notConfigured)
    expect(notice).toContain('模型设置')
  })

  it('其它错误码如实带出服务端 message', () => {
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('拆书失败：请求超时')
  })
})

describe('copyReportText', () => {
  it('无 DOM / 无 clipboard 时返回 false 而不是抛错', async () => {
    await expect(copyReportText('报告')).resolves.toBe(false)
  })
})

describe('createDefaultPanelData', () => {
  it('默认空报告', () => {
    expect(createDefaultPanelData()).toEqual({ report: '', model: '' })
  })
})

describe('BOOKBREAK_PANEL_TEXT 关键文案（全中文）', () => {
  it('未配置模型 / 无作品 / 取消提示齐全', () => {
    expect(BOOKBREAK_PANEL_TEXT.notConfigured).toBe('请先到『模型设置』页签配置接口地址、模型名与 API Key')
    expect(BOOKBREAK_PANEL_TEXT.noProject).toBe('请先在左侧新建作品再保存')
    expect(BOOKBREAK_PANEL_TEXT.cancelHint).toContain('取消仅忽略结果')
    expect(BOOKBREAK_PANEL_TEXT.emptyText).toBe('请先粘贴或导入原文')
    expect(BOOKBREAK_PANEL_TEXT.start).toBe('开始拆书')
    expect(BOOKBREAK_PANEL_TEXT.save).toBe('保存')
    expect(BOOKBREAK_PANEL_TEXT.copy).toBe('复制报告')
  })
})
