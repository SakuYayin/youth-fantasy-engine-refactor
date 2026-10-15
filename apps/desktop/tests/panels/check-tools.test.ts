/**
 * 检查工具面板纯逻辑（check-tools-model）的测试：
 * 行/段口径 / 字数统计 / 全角半角混用 / 连续重复标点 / 连续重复词 / 段落过长 / 行尾空白 / 连续空行 / 组装 / 汇总 / 常量。
 *
 * node 环境（纯函数，无 DOM）。所有 detail 期望串与模型实现逐字锁死，防止文案漂移。
 */
import { describe, expect, it } from 'vitest'

import {
  BLANK_LINES_TITLE,
  BUTTON_CLEAR,
  BUTTON_RUN,
  DISCLAIMER,
  EMPTY_RESULT_LABEL,
  INITIAL_HINT,
  LONG_PARAGRAPH_CHARS,
  MIN_BLANK_LINES,
  MIN_REPEAT_PUNCT,
  MIXED_WIDTH_TITLE,
  NO_PERSIST_NOTE,
  PANEL_INPUT_TITLE,
  PANEL_RESULT_TITLE,
  REPEAT_PUNCT_TITLE,
  REPEAT_WORD_TITLE,
  SEVERITY_LABEL,
  TEXTAREA_PLACEHOLDER,
  TRAILING_SPACE_TITLE,
  WORD_COUNT_TITLE,
  buildCheckSummary,
  checkText,
  formatCharCount,
  formatIssueSummary,
  formatSeverityHeader,
  getTextStats,
  splitLines,
  type CheckIssue,
} from '../../src/renderer/panels/check-tools-model.js'

describe('splitLines 行口径', () => {
  it('按 \\r\\n | \\n | \\r 统一切分', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c'])
    expect(splitLines('a\nb\rc')).toEqual(['a', 'b', 'c'])
  })

  it('末尾换行不产生额外空行，空文本无行', () => {
    expect(splitLines('a\n')).toEqual(['a'])
    expect(splitLines('a\r\n\r\n')).toEqual(['a', ''])
    expect(splitLines('')).toEqual([])
    expect(splitLines('\r')).toEqual([''])
  })
})

describe('getTextStats 字数与段落口径', () => {
  it('字符数按 Unicode 码点（含标点），段落数=连续非空行', () => {
    expect(getTextStats('你好世界。')).toEqual({ charCount: 5, paragraphCount: 1 })
  })

  it('相邻非空行同段，空行分段', () => {
    expect(getTextStats('a\nb')).toEqual({ charCount: 3, paragraphCount: 1 })
    expect(getTextStats('a\n\nb\nc')).toEqual({ charCount: 6, paragraphCount: 2 })
  })

  it('空文本与纯空白文本：0 段落', () => {
    expect(getTextStats('')).toEqual({ charCount: 0, paragraphCount: 0 })
    expect(getTextStats('  \n\n  ')).toEqual({ charCount: 6, paragraphCount: 0 })
  })
})

describe('规则：字数统计（info）', () => {
  it('首条问题为字数统计，detail 精确', () => {
    const issues = checkText('你好。世界')
    expect(issues[0]).toEqual({
      id: 'word-count',
      severity: 'info',
      title: WORD_COUNT_TITLE,
      detail: '全文共 5 字符、1 个段落',
    })
  })

  it('字符数千分位', () => {
    const issues = checkText('好'.repeat(1234))
    expect(issues[0]?.detail).toBe('全文共 1,234 字符、1 个段落')
  })

  it('空文本 / 纯空白文本：无字数统计问题', () => {
    expect(checkText('')).toEqual([])
    expect(checkText('   \n   ')).toEqual([])
  })
})

describe('规则：全角/半角标点混用（warn，按段）', () => {
  it('同段出现全角句号与半角句点', () => {
    const issues = checkText('你好。world.')
    const mixed = issues.filter((issue) => issue.id !== 'word-count')
    expect(mixed).toEqual([
      {
        id: 'mixed-p1-period',
        severity: 'warn',
        title: MIXED_WIDTH_TITLE,
        detail: '第 1 段同时出现全角与半角句号（。 与 .）',
      },
    ])
  })

  it('同类多形态各自成条：逗号与冒号', () => {
    const issues = checkText('a，b,c：d:e')
    const ids = issues.map((issue) => issue.id)
    expect(ids).toContain('mixed-p1-comma')
    expect(ids).toContain('mixed-p1-colon')
  })

  it('跨段独立报告（段号正确）', () => {
    const issues = checkText('你好。ok.\n\n再见。hi.')
    const mixed = issues.filter((issue) => issue.id.startsWith('mixed-'))
    expect(mixed.map((issue) => issue.id)).toEqual(['mixed-p1-period', 'mixed-p2-period'])
  })

  it('引号与括号类', () => {
    expect(
      checkText('他说“你好”然后说 "hi"').some((issue) => issue.id === 'mixed-p1-quote'),
    ).toBe(true)
    expect(checkText('（注意）(note)').some((issue) => issue.id === 'mixed-p1-paren')).toBe(true)
  })

  it('单一形态不报混用', () => {
    const issues = checkText('你好。世界，很好！')
    expect(issues.every((issue) => !issue.id.startsWith('mixed-'))).toBe(true)
  })
})

describe('规则：连续重复标点（warn，按行）', () => {
  it('3 连及以上报告，2 连不报', () => {
    const issues = checkText('太好了！！！')
    const punct = issues.filter((issue) => issue.id.startsWith('repeat-punct-'))
    expect(punct).toEqual([
      {
        id: 'repeat-punct-1',
        severity: 'warn',
        title: REPEAT_PUNCT_TITLE,
        detail: '第 1 行连续出现 3 个「！！！」',
      },
    ])
    expect(checkText('什么？？').every((issue) => !issue.id.startsWith('repeat-punct-'))).toBe(true)
  })

  it('交替标点（！？！）不算连续重复', () => {
    expect(checkText('什么！？！').every((issue) => !issue.id.startsWith('repeat-punct-'))).toBe(
      true,
    )
  })

  it('超长摘录截断为 6 字符加省略号', () => {
    const issues = checkText('啊'.repeat(2) + '！'.repeat(7))
    const punct = issues.find((issue) => issue.id === 'repeat-punct-1')
    expect(punct?.detail).toBe('第 1 行连续出现 7 个「！！！！！！…」')
  })

  it('多行多条，序号递增', () => {
    const issues = checkText('太好了！！！\n什么？？？')
    const punct = issues.filter((issue) => issue.id.startsWith('repeat-punct-'))
    expect(punct.map((issue) => issue.id)).toEqual(['repeat-punct-1', 'repeat-punct-2'])
    expect(punct[1]?.detail).toBe('第 2 行连续出现 3 个「？？？」')
  })

  it('省略号与破折号是规范用法，不参与检查', () => {
    expect(checkText('他说……然后——').every((issue) => !issue.id.startsWith('repeat-punct-'))).toBe(
      true,
    )
  })
})

describe('规则：连续重复词（warn，按行）', () => {
  it('单字虚词相邻重复：「的的」', () => {
    const issues = checkText('我喜欢的的这本书')
    const words = issues.filter((issue) => issue.id.startsWith('repeat-word-'))
    expect(words).toEqual([
      {
        id: 'repeat-word-1',
        severity: 'warn',
        title: REPEAT_WORD_TITLE,
        detail: '第 1 行出现连续重复词「的的」',
      },
    ])
  })

  it('两字重复：「我我」（截断到两字报告）', () => {
    const issues = checkText('他说我我你不知道')
    const words = issues.filter((issue) => issue.id.startsWith('repeat-word-'))
    expect(words.map((issue) => issue.detail)).toEqual(['第 1 行出现连续重复词「我我」'])
  })

  it('四字重复按最长单元报告：「我我我我」', () => {
    const issues = checkText('我我我我不知道')
    const words = issues.filter((issue) => issue.id.startsWith('repeat-word-'))
    expect(words.map((issue) => issue.detail)).toEqual(['第 1 行出现连续重复词「我我我我」'])
  })

  it('多字重复：「他们他们」「什么什么」', () => {
    expect(
      checkText('他们他们两个人').some(
        (issue) => issue.detail === '第 1 行出现连续重复词「他们他们」',
      ),
    ).toBe(true)
    expect(
      checkText('什么什么都是这样').some(
        (issue) => issue.detail === '第 1 行出现连续重复词「什么什么」',
      ),
    ).toBe(true)
  })

  it('三连单字只报一条：的的的，且「的确」不误报', () => {
    const issues = checkText('的的的确')
    const words = issues.filter((issue) => issue.id.startsWith('repeat-word-'))
    expect(words).toHaveLength(1)
    expect(words[0]?.detail).toBe('第 1 行出现连续重复词「的的」')
    expect(checkText('这的确很好').every((issue) => !issue.id.startsWith('repeat-word-'))).toBe(
      true,
    )
  })

  it('合法叠词与应答不报：看看 / 慢慢 / 一一对应 / 哈哈哈哈 / 是是是', () => {
    for (const text of ['我们看看世界', '慢慢走', '一一对应', '哈哈哈哈', '是是是，好的']) {
      expect(checkText(text).every((issue) => !issue.id.startsWith('repeat-word-'))).toBe(true)
    }
  })

  it('空格分隔不算相邻重复', () => {
    expect(
      checkText('他们 他们都来了').every((issue) => !issue.id.startsWith('repeat-word-')),
    ).toBe(true)
  })

  it('重复标点不进重复词检查，英文重复不在预览版范围', () => {
    expect(
      checkText('！！！').every((issue) => !issue.id.startsWith('repeat-word-')),
    ).toBe(true)
    expect(checkText('say the the words').every((issue) => !issue.id.startsWith('repeat-word-'))).toBe(
      true,
    )
  })
})

describe('规则：段落过长（info）', () => {
  it('单段 801 字符报告拆段建议', () => {
    const issues = checkText('好'.repeat(801))
    const long = issues.filter((issue) => issue.id.startsWith('long-p'))
    expect(long).toEqual([
      {
        id: 'long-p1',
        severity: 'info',
        title: '段落过长',
        detail: '第 1 段共 801 字符，超过 800 字，建议拆段',
      },
    ])
  })

  it('恰好 800 字符不报', () => {
    expect(checkText('好'.repeat(800)).every((issue) => !issue.id.startsWith('long-p'))).toBe(true)
  })

  it('跨行段落按段内字符合计（含换行）计数', () => {
    const issues = checkText('好'.repeat(500) + '\n' + '好'.repeat(301))
    const long = issues.find((issue) => issue.id === 'long-p1')
    expect(long?.detail).toBe('第 1 段共 802 字符，超过 800 字，建议拆段')
  })
})

describe('规则：行尾空白字符（info）', () => {
  it('半角空格 / 制表符 / 全角空格都计为空白', () => {
    const issues = checkText('你好 \n世界\t\n哈哈\u3000\n干净行')
    const trailing = issues.filter((issue) => issue.id.startsWith('trailing-'))
    expect(trailing.map((issue) => issue.id)).toEqual(['trailing-l1', 'trailing-l2', 'trailing-l3'])
    expect(trailing[0]?.detail).toBe('第 1 行行尾有 1 个空白字符')
  })

  it('多个空白计数正确', () => {
    const issues = checkText('你好  ')
    expect(issues.find((issue) => issue.id === 'trailing-l1')?.detail).toBe(
      '第 1 行行尾有 2 个空白字符',
    )
  })

  it('纯空白行不报行尾空白（交给空行规则）', () => {
    const issues = checkText('你好\n   \n世界')
    expect(issues.every((issue) => !issue.id.startsWith('trailing-'))).toBe(true)
  })
})

describe('规则：连续空行（info）', () => {
  it('3 连空行报告，2 连不报', () => {
    const issues = checkText('a\n\n\n\nb')
    expect(issues.filter((issue) => issue.id.startsWith('blank-'))).toEqual([
      {
        id: 'blank-l2',
        severity: 'info',
        title: BLANK_LINES_TITLE,
        detail: '第 2–4 行连续空行 3 行，建议精简',
      },
    ])
    expect(checkText('a\n\n\nb').every((issue) => !issue.id.startsWith('blank-'))).toBe(true)
  })

  it('纯空白行也算空行', () => {
    const issues = checkText('a\n  \n\t\n \nb')
    const blank = issues.find((issue) => issue.id.startsWith('blank-'))
    expect(blank?.detail).toBe('第 2–4 行连续空行 3 行，建议精简')
  })

  it('开头连续空行同样报告', () => {
    const issues = checkText('\n\n\na')
    expect(issues.find((issue) => issue.id.startsWith('blank-'))?.id).toBe('blank-l1')
  })

  it('纯空白文本只报空行问题（≥3 连时）', () => {
    const issues = checkText('  \n\n\n\n  ')
    expect(issues.map((issue) => issue.id)).toEqual(['blank-l1'])
    expect(issues[0]?.detail).toBe('第 1–5 行连续空行 5 行，建议精简')
  })
})

describe('checkText 组装', () => {
  /** 综合样本：行1尾空格 / 行2 我我 / 行4 句号混用（的确非重复词）/ 行5-7 三连空行 / 行8 ！！！ */
  const SAMPLE = '第一章 觉醒 \n他说我我不知道。\n\n这的确很好，world，ok. no。\n\n\n\n太好了！！！'

  it('问题顺序固定：字数 → 混用 → 重复标点 → 重复词 → 段落过长 → 行尾空白 → 空行', () => {
    expect(checkText(SAMPLE).map((issue) => issue.id)).toEqual([
      'word-count',
      'mixed-p2-period',
      'repeat-punct-1',
      'repeat-word-1',
      'trailing-l1',
      'blank-l5',
    ])
  })

  it('同一文本多次调用结果完全一致（确定性）', () => {
    expect(checkText(SAMPLE)).toEqual(checkText(SAMPLE))
  })

  it('id 在结果内唯一，severity 只取 warn/info', () => {
    const issues = checkText(SAMPLE)
    const ids = issues.map((issue) => issue.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const issue of issues as readonly CheckIssue[]) {
      expect(['warn', 'info']).toContain(issue.severity)
    }
  })

  it('严重度分配：语病类为 warn，统计与排版类为 info', () => {
    const issues = checkText(SAMPLE)
    for (const issue of issues) {
      if (issue.id === 'word-count' || issue.id.startsWith('long-') || issue.id.startsWith('trailing-') || issue.id.startsWith('blank-')) {
        expect(issue.severity).toBe('info')
      } else {
        expect(issue.severity).toBe('warn')
      }
    }
  })
})

describe('汇总与格式化', () => {
  it('buildCheckSummary 按严重度计数', () => {
    const issues = checkText('你好。world.\n\n太好了！！！')
    expect(buildCheckSummary(issues)).toEqual({ total: 3, warn: 2, info: 1 })
  })

  it('空结果汇总为零', () => {
    expect(buildCheckSummary([])).toEqual({ total: 0, warn: 0, info: 0 })
  })

  it('formatIssueSummary 顶部汇总文案', () => {
    expect(formatIssueSummary(5, 2, 3)).toBe('共 5 个问题（警告 2、提示 3）')
  })

  it('formatSeverityHeader 分组标题文案', () => {
    expect(formatSeverityHeader('warn', 2)).toBe('警告（2）')
    expect(formatSeverityHeader('info', 3)).toBe('提示（3）')
  })

  it('formatCharCount 千分位', () => {
    expect(formatCharCount(46)).toBe('46')
    expect(formatCharCount(1234)).toBe('1,234')
    expect(formatCharCount(1234567)).toBe('1,234,567')
  })
})

describe('文案与阈值常量（视图可见文本的唯一来源）', () => {
  it('规则标题', () => {
    expect(WORD_COUNT_TITLE).toBe('字数统计')
    expect(MIXED_WIDTH_TITLE).toBe('全角与半角标点混用')
    expect(REPEAT_PUNCT_TITLE).toBe('连续重复标点')
    expect(REPEAT_WORD_TITLE).toBe('连续重复词')
    expect(TRAILING_SPACE_TITLE).toBe('行尾空白字符')
    expect(BLANK_LINES_TITLE).toBe('连续空行')
  })

  it('严重度显示名与阈值', () => {
    expect(SEVERITY_LABEL.warn).toBe('警告')
    expect(SEVERITY_LABEL.info).toBe('提示')
    expect(LONG_PARAGRAPH_CHARS).toBe(800)
    expect(MIN_REPEAT_PUNCT).toBe(3)
    expect(MIN_BLANK_LINES).toBe(3)
  })

  it('视图结构文案', () => {
    expect(PANEL_INPUT_TITLE).toBe('正文输入')
    expect(PANEL_RESULT_TITLE).toBe('检查结果')
    expect(BUTTON_RUN).toBe('开始检查')
    expect(BUTTON_CLEAR).toBe('清空')
    expect(EMPTY_RESULT_LABEL).toBe('未发现问题')
    expect(TEXTAREA_PLACEHOLDER.length).toBeGreaterThan(0)
    expect(INITIAL_HINT).toContain('开始检查')
  })

  it('能力与持久化边界说明如实声明', () => {
    expect(DISCLAIMER).toContain('预览版')
    expect(DISCLAIMER).toContain('不调用 AI')
    expect(NO_PERSIST_NOTE).toContain('不会被保存或上传')
  })
})
