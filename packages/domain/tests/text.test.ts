/**
 * `@yfe/domain/text` 契约测试。
 *
 * 重点覆盖**会算错用户字数的路径**，而不是 happy path：
 * - 字素簇 vs `String.length`（emoji / 组合字符 / 旗帜 / 肤色修饰）；
 * - 换行归一化（CRLF 绝不能被拆成两个换行、U+2028 必须落地）；
 * - 降级引擎（`Intl.Segmenter` 不可用时的近似实现）必须给出同样的字数。
 *
 * 字数直接进 `DocumentSummary.charCount` 并显示给用户，算错就是可见的 bug。
 */

import { describe, expect, it } from 'vitest'

import {
  BODY_NORMALIZATION_VERSION,
  countChars,
  countCharsBreakdown,
  graphemeEngineInfo,
  isNormalizedBody,
  normalizeBody,
  normalizeBodyReport,
  scanGraphemes,
} from '../src/text/index.js'

// ---------------------------------------------------------------------------
// 样本
// ---------------------------------------------------------------------------

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}' // 👨‍👩‍👧‍👦
const THUMB_MEDIUM = '\u{1F44D}\u{1F3FD}' // 👍🏽
const FLAG_CN = '\u{1F1E8}\u{1F1F3}' // 🇨🇳
const FLAG_US = '\u{1F1FA}\u{1F1F8}' // 🇺🇸
const RAINBOW = '\u{1F3F3}\uFE0F\u200D\u{1F308}' // 🏳️‍🌈
const COFFEE_VS16 = '\u2615\uFE0F' // ☕️
const COMBINING = 'e\u0301' // é (分解形)
const DEVA = '\u0915\u094D\u0937' // क्ष

/** 首个码位是否 ASCII 数字或字母（用于核对分解式）。 */
function isAsciiAlnumCluster(segment: string): boolean {
  return /^[0-9A-Za-z]/.test(segment)
}

/** Intl 可用时返回真正的字素簇数；否则返回 `null`（CI 上不该发生）。 */
function intlCount(text: string): number | null {
  return graphemeEngineInfo().engine === 'intl-segmenter' ? countChars(text) : null
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

describe('normalizeBody', () => {
  it('导出固定的归一化规则版本号', () => {
    // 规则一旦发布只能加版本号、不得原地改义：导入器要记录"这段正文按哪一版归一化"。
    expect(BODY_NORMALIZATION_VERSION).toBe(1)
  })

  it('去掉开头的 BOM，并报告执行过 bom 步骤', () => {
    const report = normalizeBodyReport('\uFEFF你好')
    expect(report.text).toBe('你好')
    expect(report.changed).toBe(true)
    expect(report.steps).toEqual(['bom'])
  })

  it('只去掉开头的 BOM，不动正文中间的 U+FEFF', () => {
    expect(normalizeBody('你\uFEFF好')).toBe('你\uFEFF好')
  })

  it('CRLF 归一化为单个 LF —— 绝不能拆成两个换行', () => {
    // 🔴 这是本模块最容易写错的地方：先替 `\r` 再替 `\r\n` 会把一行变两行。
    const report = normalizeBodyReport('第一行\r\n第二行')
    expect(report.text).toBe('第一行\n第二行')
    expect(report.steps).toEqual(['crlf'])
    expect(report.text.match(/\n/g)).toHaveLength(1)
    expect(report.text).not.toContain('\r')
  })

  it('单独的 CR（老 Mac 换行）归一化为 LF', () => {
    const report = normalizeBodyReport('第一行\r第二行')
    expect(report.text).toBe('第一行\n第二行')
    expect(report.steps).toEqual(['cr'])
  })

  it('CRLF 与单独 CR 混排时两个步骤都执行，且顺序为 crlf → cr', () => {
    const report = normalizeBodyReport('a\r\nb\rc')
    expect(report.text).toBe('a\nb\nc')
    expect(report.steps).toEqual(['crlf', 'cr'])
  })

  it('U+2028 / U+2029 归一化为 LF', () => {
    const report = normalizeBodyReport('a\u2028b\u2029c')
    expect(report.text).toBe('a\nb\nc')
    expect(report.steps).toEqual(['unicode-separator'])
  })

  it('BOM + CRLF + U+2028 混排时按固定顺序执行全部步骤', () => {
    const report = normalizeBodyReport('\uFEFFa\r\nb\u2028c')
    expect(report.text).toBe('a\nb\nc')
    expect(report.steps).toEqual(['bom', 'crlf', 'unicode-separator'])
  })

  it('未改动时 changed 为 false 且 steps 为空', () => {
    const report = normalizeBodyReport('已经\n是归一化形态')
    expect(report.changed).toBe(false)
    expect(report.steps).toEqual([])
  })

  it('幂等：normalizeBody(normalizeBody(x)) === normalizeBody(x)', () => {
    const raw = '\uFEFF一\r\n二\r三\u2028四\u2029五'
    const once = normalizeBody(raw)
    expect(normalizeBody(once)).toBe(once)
  })

  it('可以按需关闭各个步骤', () => {
    const raw = '\uFEFFa\r\nb'
    expect(normalizeBody(raw, { stripBom: false })).toBe('\uFEFFa\nb')
    expect(normalizeBody(raw, { normalizeLineEndings: false })).toBe('a\r\nb')
    expect(normalizeBody(raw, { normalizeUnicodeSeparators: false })).toBe('a\nb')
    expect(
      normalizeBody(raw, {
        stripBom: false,
        normalizeLineEndings: false,
        normalizeUnicodeSeparators: false,
      }),
    ).toBe(raw)
  })

  it('isNormalizedBody 判定归一化形态', () => {
    expect(isNormalizedBody('a\nb')).toBe(true)
    expect(isNormalizedBody('a\r\nb')).toBe(false)
    expect(isNormalizedBody('\uFEFFa')).toBe(false)
    expect(isNormalizedBody('a\u2028b')).toBe(false)
  })

  it('空字符串是合法输入', () => {
    expect(normalizeBody('')).toBe('')
    expect(isNormalizedBody('')).toBe(true)
  })

  it('非字符串抛 TypeError，而不是静默返回空串', () => {
    expect(() => normalizeBody(null as unknown as string)).toThrow(TypeError)
    expect(() => normalizeBody(undefined as unknown as string)).toThrow(TypeError)
    expect(() => normalizeBody(42 as unknown as string)).toThrow(TypeError)
    expect(() => isNormalizedBody(null as unknown as string)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// 字数：必须按字素簇
// ---------------------------------------------------------------------------

describe('countChars', () => {
  it('中文按字计', () => {
    expect(countChars('你好世界')).toBe(4)
    expect(countChars('，。！？')).toBe(4)
  })

  it('🔴 绝不等同于 String.length：emoji 修正', () => {
    // '👍'.length === 2，但用户看到的是一张图，必须算 1 个字。
    expect('👍'.length).toBe(2)
    expect(countChars('👍')).toBe(1)

    expect(FAMILY.length).toBe(11)
    expect(countChars(FAMILY)).toBe(1)

    expect(THUMB_MEDIUM.length).toBe(4)
    expect(countChars(THUMB_MEDIUM)).toBe(1)

    expect(FLAG_CN.length).toBe(4)
    expect(countChars(FLAG_CN)).toBe(1)
  })

  it('组合字符算一个字（NFC 与分解形同结果）', () => {
    const precomposed = '\u00E9' // é
    expect(precomposed.length).toBe(1)
    expect(COMBINING.length).toBe(2)
    expect(countChars(precomposed)).toBe(1)
    expect(countChars(COMBINING)).toBe(1)
  })

  it('CRLF 是一个字素簇，但仍必须先归一化', () => {
    // UAX #29 把 CRLF 视作单簇，所以这里不归一化也不会多算一行；
    // 关键在于归一化后 `a\r\nb` 与 `a\nb` 字数一致，跨端可比。
    expect(countChars('a\r\nb')).toBe(3)
    expect(countChars(normalizeBody('a\r\nb'))).toBe(countChars(normalizeBody('a\nb')))
  })

  it('空串为 0', () => {
    expect(countChars('')).toBe(0)
  })

  it('等于 scanGraphemes 的簇数，且 index/segment 自洽', () => {
    const text = `第一章 ${FAMILY} 出发${COMBINING}`
    const graphemes = scanGraphemes(text)
    expect(graphemes).toHaveLength(countChars(text))

    // 每簇的 index 必须能 slice 回自己 → 扫描结果与 String 下标一致。
    for (const grapheme of graphemes) {
      expect(text.slice(grapheme.index, grapheme.index + grapheme.segment.length)).toBe(
        grapheme.segment,
      )
    }
    // 拼接还原原文，证明没有丢字符。
    expect(graphemes.map((grapheme) => grapheme.segment).join('')).toBe(text)
    // index 严格递增。
    const indexes = graphemes.map((grapheme) => grapheme.index)
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)
  })

  it('codePointCount 反映簇内码位数（家庭 emoji 是 7 个码位）', () => {
    const [family] = scanGraphemes(FAMILY)
    expect(family?.codePointCount).toBe(7)
    expect(family?.segment).toBe(FAMILY)
  })

  it('大文本计数不因长度而失准', () => {
    const line = '这是一行文字，带 emoji 👍 与英文 words。'
    const body = normalizeBody(Array.from({ length: 500 }, () => line).join('\n'))
    const expected = countChars(line) * 500 + 499 // 499 个换行
    expect(countChars(body)).toBe(expected)
  })

  it('非字符串抛 TypeError', () => {
    expect(() => countChars(null as unknown as string)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// 降级引擎：Intl.Segmenter 不可用时也不能算错
// ---------------------------------------------------------------------------

describe('降级引擎（code-point-fallback）', () => {
  const corpus: readonly string[] = [
    '你好，世界。',
    'Hello, world!',
    `一家人 ${FAMILY}`,
    THUMB_MEDIUM,
    `${FLAG_CN}${FLAG_US}`,
    RAINBOW,
    COFFEE_VS16,
    'e\u0301a\u0301o\u0308',
    DEVA,
    'a\r\nb',
    '\u{20000}扩展B区',
    '한글 조합',
    'Tiếng Việt',
    '🙂🙃',
    '第一章 出发',
  ]

  it('对真实语料给出与 Intl.Segmenter 完全一致的字数', () => {
    const reference = intlCount('你好')
    if (reference === null) return // 运行时没有 Intl，跳过对照

    for (const text of corpus) {
      expect(
        countChars(text, { engine: 'code-point-fallback' }),
        `降级引擎在 ${JSON.stringify(text)} 上算错`,
      ).toBe(countChars(text, { engine: 'intl-segmenter' }))
    }
  })

  it('单独覆盖 GB11（ZWJ 序列）与 GB9a（肤色修饰符）', () => {
    const fallback = countChars(FAMILY, { engine: 'code-point-fallback' })
    expect(fallback).toBe(1)
    expect(countChars(THUMB_MEDIUM, { engine: 'code-point-fallback' })).toBe(1)
    expect(countChars(RAINBOW, { engine: 'code-point-fallback' })).toBe(1)
  })

  it('单独覆盖 GB12/GB13（区域指示符两两成对）', () => {
    expect(countChars(FLAG_CN, { engine: 'code-point-fallback' })).toBe(1)
    expect(countChars(`${FLAG_CN}${FLAG_US}`, { engine: 'code-point-fallback' })).toBe(2)
    // 五个区域指示符 → 两对国旗 + 一个落单 = 3 簇。
    const odd = `${FLAG_CN}${FLAG_US}\u{1F1E9}`
    expect(odd).toHaveLength(10)
    expect(countChars(odd, { engine: 'code-point-fallback' })).toBe(3)
  })

  it('单独覆盖 GB3（CR × LF 合成一簇）', () => {
    expect(countChars('\r\n', { engine: 'code-point-fallback' })).toBe(1)
    expect(countChars('a\r\nb', { engine: 'code-point-fallback' })).toBe(3)
  })

  it('降级路径与默认路径的分解式一致', () => {
    const text = `第一章 ${FAMILY} hello`
    const withIntl = countCharsBreakdown(text, { engine: 'intl-segmenter' })
    const fallback = countCharsBreakdown(text, { engine: 'code-point-fallback' })
    expect(fallback).toEqual(withIntl)
  })

  it('显式请求不可用的引擎时抛错，而不是悄悄降级', () => {
    const info = graphemeEngineInfo()
    if (info.engine === 'intl-segmenter') {
      // 运行时有 Intl：显式请求降级引擎仍然可用（是显式选择，不算错误）。
      expect(() => countChars('a', { engine: 'code-point-fallback' })).not.toThrow()
    } else {
      expect(() => countChars('a', { engine: 'intl-segmenter' })).toThrow(/Intl\.Segmenter/)
    }
  })

  it('graphemeEngineInfo 报告引擎且降级时给出原因', () => {
    const info = graphemeEngineInfo()
    expect(['intl-segmenter', 'code-point-fallback']).toContain(info.engine)
    if (info.engine === 'intl-segmenter') {
      expect(info.fallbackReason).toBeNull()
    } else {
      expect(typeof info.fallbackReason).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// 字数分解
// ---------------------------------------------------------------------------

describe('countCharsBreakdown', () => {
  it('中文标点分别归类', () => {
    const breakdown = countCharsBreakdown('你好，世界。')
    expect(breakdown).toMatchObject({
      total: 6,
      chinese: 4,
      punctuation: 2,
      whitespace: 0,
      latinWords: 0,
      other: 0,
    })
  })

  it('英文按词计，不按字母计', () => {
    const breakdown = countCharsBreakdown('hello world')
    expect(breakdown.total).toBe(11)
    expect(breakdown.latinWords).toBe(2)
    expect(breakdown.whitespace).toBe(1)
  })

  it('撇号不切断英文单词', () => {
    expect(countCharsBreakdown("don't").latinWords).toBe(1)
    expect(countCharsBreakdown('l\u2019\u00E9t\u00E9').latinWords).toBe(1)
  })

  it('中英混排', () => {
    const breakdown = countCharsBreakdown('中文 abc 123')
    expect(breakdown).toMatchObject({
      total: 10,
      chinese: 2,
      latinWords: 2,
      whitespace: 2,
    })
  })

  it('emoji 计入 other 且每个簇算 1', () => {
    const breakdown = countCharsBreakdown(FAMILY)
    expect(breakdown).toMatchObject({ total: 1, other: 1 })
    expect(countCharsBreakdown(THUMB_MEDIUM).other).toBe(1)
    expect(countCharsBreakdown(`${FAMILY}${THUMB_MEDIUM}`).other).toBe(2)
  })

  it('全角空格与制表符算空白', () => {
    expect(countCharsBreakdown('a\u3000b').whitespace).toBe(1)
    expect(countCharsBreakdown('a\tb').whitespace).toBe(1)
  })

  it('🔴 分解式恒等：total === 四个簇桶 + 拉丁簇数，且 latinWords 不多于拉丁簇数', () => {
    const corpus = [
      '你好，世界。',
      'hello world',
      "don't stop",
      `第一章 ${FAMILY} 出发，hello 世界！`,
      '   ',
      '',
      '中文 abc 123 混合\n第二行',
      `${FLAG_CN} 国旗`,
    ]

    for (const text of corpus) {
      const breakdown = countCharsBreakdown(text)
      const latinClusters = scanGraphemes(text).filter((grapheme) =>
        isAsciiAlnumCluster(grapheme.segment),
      ).length

      expect(breakdown.total, `total 必须等于 countChars：${JSON.stringify(text)}`).toBe(
        countChars(text),
      )
      expect(
        breakdown.chinese + breakdown.punctuation + breakdown.whitespace + breakdown.other,
        `四个簇桶之和 + 拉丁簇数必须等于总簇数：${JSON.stringify(text)}`,
      ).toBe(breakdown.total - latinClusters)
      expect(
        breakdown.latinWords,
        `词数不可能多于字母簇数：${JSON.stringify(text)}`,
      ).toBeLessThanOrEqual(latinClusters)
      for (const value of Object.values(breakdown)) {
        expect(Number.isSafeInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('空串全为 0', () => {
    expect(countCharsBreakdown('')).toEqual({
      total: 0,
      chinese: 0,
      latinWords: 0,
      punctuation: 0,
      whitespace: 0,
      other: 0,
    })
  })

  it('非字符串抛 TypeError', () => {
    expect(() => countCharsBreakdown(undefined as unknown as string)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// 端到端：导入 → 归一化 → 字数（DocumentSummary.charCount 的取值路径）
// ---------------------------------------------------------------------------

describe('导入路径端到端', () => {
  it('CRLF 文本导入后的字数与 LF 文本一致', () => {
    const line = `第一章 出发 ${FAMILY}`
    const crlf = Array.from({ length: 20 }, () => line).join('\r\n')
    const lf = Array.from({ length: 20 }, () => line).join('\n')

    const fromCrlf = countChars(normalizeBody(crlf))
    const fromLf = countChars(normalizeBody(lf))
    expect(fromCrlf).toBe(fromLf)
    expect(fromCrlf).toBe(countChars(line) * 20 + 19)
  })

  it('归一化不改变字数（BOM 除外）', () => {
    const raw = `\uFEFF第一章\r\n${THUMB_MEDIUM} 出发\u2028继续`
    const normalized = normalizeBody(raw)
    expect(countChars(normalized)).toBe(countChars(raw) - 1) // 少掉被剥掉的 BOM
    expect(isNormalizedBody(normalized)).toBe(true)
    expect(isNormalizedBody(normalized + '\r')).toBe(false)
  })

  it('归一化不丢正文内容，只改换行与 BOM', () => {
    const raw = '\uFEFF甲\r\n乙\r丙\u2028丁\u2029戊'
    const normalized = normalizeBody(raw)
    expect(normalized.replace(/\n/g, '')).toBe('甲乙丙丁戊')
  })
})
