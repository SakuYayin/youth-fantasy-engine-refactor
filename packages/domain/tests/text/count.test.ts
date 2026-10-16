/**
 * `packages/domain/src/text/count.ts` 的对照测试（B-13 正文分词与字数统计）。
 *
 * ## oracle（**逐字抄自上游**）
 * 真源＝`_upstream_tmp/youth-fantasy-engine-main/src/lib/editor/textStats.ts`（全文 35 行）：
 * - 第 16 行 `export type WordCountMode = 'cjk' | 'cjk-punct'`
 * - 第 19 行 `const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g`
 * - 第 26–27 行 `const PUNCT_RE = /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/g`
 * - 第 29–35 行 `countWords`
 * 另抄 `src/lib/editor/wordCountMode.ts:36-38` 的 `wordCountModeOf`（与 `:25` 的 key 字面量）。
 *
 * 上游**没有** `textStats.test.ts`：它对 `countWords` 的断言只有
 * `tests/adversarial.test.ts:87`（空串＝0、返回 number、非零）与
 * `tests/platformCheck.test.ts:38`（长章样本 ≈340 字）；`'cjk-punct'` 档上游**零测试**。
 * 因此本文件承担两件事：① 用 oracle 证明「本仓单次遍历」与「上游三次正则」逐值相等；
 * ② 把上游注释里声明过的口径逐条钉死。凡本仓自行补充的口径，用例名里标「本仓补充口径」。
 */
import { describe, expect, it } from 'vitest'

import {
  WORD_COUNT_MODE_DEFAULT,
  WORD_COUNT_WITH_PUNCT_STORAGE_KEY,
  countWords,
  countWordsBreakdown,
  isWordCountMode,
  wordCountModeOf,
  type WordCountMode,
} from '../../src/text/count.js'

/** 上游 `textStats.ts:19` 的逐字副本。 */
const UPSTREAM_CJK_RE_G = /[\u4e00-\u9fff\u3400-\u4dbf]/g

/** 上游 `textStats.ts:26-27` 的逐字副本。 */
const UPSTREAM_PUNCT_RE_G =
  /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/g

/**
 * 上游 `textStats.ts:29-35` 的逐字副本。
 *
 * 唯一改动：`mode` 用它本地的字面量联合，避免测试文件依赖被测模块的类型。
 * 函数体（三行正则、`|| []` 兜底、`mode === 'cjk'` 分支顺序）与上游**逐字相同**。
 */
function upstreamCountWords(text: string, mode: 'cjk' | 'cjk-punct' = 'cjk'): number {
  const cjk = (text.match(UPSTREAM_CJK_RE_G) || []).length
  const words = (text.replace(UPSTREAM_CJK_RE_G, ' ').match(/[a-zA-Z0-9]+/g) || []).length
  if (mode === 'cjk') return cjk + words
  const punct = (text.match(UPSTREAM_PUNCT_RE_G) || []).length
  return cjk + punct + words
}

/** 上游 `wordCountMode.ts:36-38` 的逐字副本。 */
function upstreamWordCountModeOf(withPunct: boolean): 'cjk' | 'cjk-punct' {
  return withPunct ? 'cjk-punct' : 'cjk'
}

const MODES: readonly WordCountMode[] = ['cjk', 'cjk-punct']

/** 交叉验证用样本：覆盖汉字/拉丁/数字/中英标点/空白/emoji/组合字符/代理对/假名/谚文。 */
const SAMPLES: readonly string[] = [
  '',
  ' ',
  '\n\n',
  '世界',
  'hello',
  'Hello World',
  'hello, world!',
  '第 1 章',
  '2026',
  '2026年',
  '世界hello世界',
  '陈渊说：“你好，世界！”',
  '，。！？',
  '　',
  '　，。！？',
  '，,、',
  '“引号”',
  '——',
  '…',
  '·',
  'a，b',
  'A1B2 3C',
  '１２３',
  'ｱｲｳ',
  'あいうえお',
  '한글',
  '㐀𠀀樂',
  '👍🏽👨👩👧👦',
  'café',
  'cafe\u0301',
  'e\u0301',
  '---',
  '－～｜＠＿ｦ･',
  '。，！？，,、',
]

/**
 * 逐字口径表（本仓补充口径：把上面那些「口径」变成可读的断言）。
 *
 * 每一行的两个数字都能由上游三个正则直接推出：汉字＝CJK_RE 命中数；
 * 拉丁数字词＝连续 `[a-zA-Z0-9]` 的段数（汉字先被替换成空格，效果等价于「任何非词字符切词」）；
 * 标点＝PUNCT_RE 命中数；`cjk` 档不计标点。
 */
const PINNED: readonly (readonly [string, number, number])[] = [
  // 空串 / 全空白 —— 上游 `adversarial.test.ts:87` 钉住 countWords('') === 0。
  ['', 0, 0],
  ['   \t\n', 0, 0],
  ['\n\n', 0, 0],
  ['\u3000', 0, 1], // U+3000 全角空格属 PUNCT_RE 区间 ⇒ cjk-punct 档计 1
  // 纯汉字 / 纯拉丁 / 中英混排。
  ['世界', 2, 2],
  ['hello', 1, 1],
  ['Hello World', 2, 2],
  ['世界hello世界', 5, 5],
  ['第1章 世界', 5, 5],
  // 数字：`2026` 是**一个词**（上游 `[a-zA-Z0-9]+`），不是 4 个字。
  ['2026', 1, 1],
  ['2026年', 2, 2],
  ['第 1 章', 3, 3],
  ['A1B2 3C', 2, 2],
  ['１２３', 0, 0], // 全角数字不在 [a-zA-Z0-9] 里 ⇒ 0 个词
  // 中文标点：cjk 档不计，cjk-punct 档计。
  ['，', 0, 1],
  ['。', 0, 1],
  ['。，！？', 0, 4],
  ['“引号”', 2, 4],
  ['…', 0, 1], // U+2026
  ['……', 0, 2],
  ['——', 0, 2], // U+2014 ×2
  ['·', 0, 1], // U+00B7
  ['，,、', 0, 2], // 半角逗号 002C 被上游刻意排除
  ['　，。！？', 0, 5],
  // 英文标点：上游 PUNCT_RE 不覆盖 ASCII ⇒ 两档都一样。
  ['hello, world!', 2, 2],
  ['...', 0, 0], // 半角句点/U+FF0E 都不是 U+2026
  ['---', 0, 0],
  ['a，b', 2, 3],
  // 与上游注释第 22–25 行 + 我方交付报告一致的综合例句：汉字 4、词 2、标点 4。
  ['陈渊说：“你好，世界！”', 7, 12],
  // emoji（代理对）与 ZWJ 序列：不落在任何区间 ⇒ 计 0。
  ['👍', 0, 0],
  ['👍🏽', 0, 0],
  ['👨‍👩‍👧‍👦', 0, 0],
  ['👍世界👍', 2, 2],
  // 组合字符：é 的两种写法都只算 1 个词。
  ['e\u0301', 1, 1], // e + U+0301 组合尖音符
  ['café', 1, 1], // U+00E9 预组合
  ['cafe\u0301', 1, 1], // e + U+0301
  ["l'été", 2, 2], // l / t 各一词，é 与 ' 都切词
  // 假名（半角/全角）与谚文：上游只管汉字与拉丁数字。
  ['あいうえお', 0, 0],
  ['アアイイ', 0, 0],
  ['ｱｲｳ', 0, 0], // U+FF71–FF73 半角片假名
  ['한글', 0, 0],
  // 汉字区间边界与平台外汉字（本仓补充口径以展示真源的范围）：
  ['㐀', 1, 1], // U+3400 扩展 A 区首字
  ['䶿', 1, 1], // U+4DBF 扩展 A 区末字
  ['\uf9e4', 0, 0], // U+F9E4「樂」CJK 兼容汉字不在区间内（对比：U+6A02 在区间内，计 1）
  ['𠀀', 0, 0], // U+20000 增补平面汉字（代理对）
  // 全角标点/字母的边界。
  ['／', 0, 1], // U+FF0F 在区间内
  ['０', 0, 0], // U+FF10 被排除
  ['＠', 0, 1], // U+FF20 在区间内
  ['Ａ', 0, 0], // U+FF21 被排除
  ['＿', 0, 1], // U+FF3F
  ['Ｚ', 0, 0], // U+FF3A 被排除
  ['｛', 0, 1], // U+FF5B 在区间内
  ['ｚ', 0, 0], // U+FF5A 被排除
  ['･', 0, 1], // U+FF65 半角中点，区间末位
  ['ｦ', 0, 0], // U+FF66 被排除
  ['！＠［｛', 0, 4],
  ['～', 0, 1], // U+FF5E
  ['~', 0, 0], // U+007E ASCII
  ['－', 0, 1], // U+FF0D
  ['￠', 0, 0], // U+FFE0
  ['―', 0, 0], // U+2015
  ['‷', 0, 0], // U+2017
  ['”', 0, 1], // U+201D
  ['‟', 0, 0], // U+201E
  ['‧', 0, 0], // U+2027
  ['¶', 0, 0], // U+00B6
  ['¸', 0, 0], // U+00B8
]

/** 穷举用：BMP 全部 65536 个 code unit 拼成的 65536 字符文本（分块拼接，避免超长实参）。 */
function buildBmpText(): string {
  let out = ''
  for (let base = 0; base < 0x10000; base += 0x1000) {
    const units: number[] = []
    for (let unit = base; unit < base + 0x1000; unit += 1) units.push(unit)
    out += String.fromCharCode(...units)
  }
  return out
}

const BMP_TEXT = buildBmpText()

describe('与上游 textStats.ts 逐值等价（表驱动交叉验证）', () => {
  for (const sample of SAMPLES) {
    it(`样本 ${JSON.stringify(sample)}：两种口径都与上游正则算法逐值相等`, () => {
      for (const mode of MODES) {
        expect(countWords(sample, mode), `mode=${mode}`).toBe(upstreamCountWords(sample, mode))
        expect(countWordsBreakdown(sample, mode).total, `breakdown mode=${mode}`).toBe(
          upstreamCountWords(sample, mode),
        )
      }
    })
  }

  it('穷举 BMP 全部 65536 个 code unit：两种口径都与上游正则算法逐值相等', () => {
    for (const mode of MODES) {
      expect(countWords(BMP_TEXT, mode), `mode=${mode}`).toBe(upstreamCountWords(BMP_TEXT, mode))
    }
  })

  it('穷举 BMP：分解为 27584 汉字 + 3 个词 + 112 标点 ⇒ 27587（cjk）/ 27699（cjk-punct）', () => {
    expect(countWordsBreakdown(BMP_TEXT)).toEqual({
      total: 27587,
      cjk: 27584,
      latinWords: 3, // 0-9 / A-Z / a-z 三段
      punctuation: 112,
    })
    expect(countWords(BMP_TEXT)).toBe(27587)
    expect(countWords(BMP_TEXT, 'cjk-punct')).toBe(27699)
  })
})

describe('逐字口径表（每条都能由上游三个正则推出）', () => {
  for (const [text, cjkTotal, punctTotal] of PINNED) {
    it(`countWords(${JSON.stringify(text)}) → cjk=${cjkTotal} / cjk-punct=${punctTotal}`, () => {
      expect(countWords(text)).toBe(cjkTotal)
      expect(countWords(text, 'cjk')).toBe(cjkTotal)
      expect(countWords(text, 'cjk-punct')).toBe(punctTotal)
      expect(upstreamCountWords(text)).toBe(cjkTotal)
      expect(upstreamCountWords(text, 'cjk-punct')).toBe(punctTotal)
    })
  }
})

describe('口径与模式', () => {
  it('默认口径是 cjk（上游 countWords(text, mode = \'cjk\')）', () => {
    expect(countWords('世界！')).toBe(2)
    expect(countWords('世界！', WORD_COUNT_MODE_DEFAULT)).toBe(2)
  })

  it('WORD_COUNT_MODE_DEFAULT 与上游默认参数一致', () => {
    expect(WORD_COUNT_MODE_DEFAULT).toBe('cjk')
  })

  it('上游兜底：任何非 \'cjk\' 的 mode 都按 cjk-punct 处理（count.ts 刻意复刻该兜底）', () => {
    const bogusMode = 'nonsense' as unknown as WordCountMode
    expect(countWords('世界！', bogusMode)).toBe(3)
    expect(upstreamCountWords('世界！', bogusMode)).toBe(3)
  })

  it('wordCountModeOf 与上游 wordCountMode.ts:36-38 逐值一致', () => {
    for (const withPunct of [false, true]) {
      expect(wordCountModeOf(withPunct)).toBe(upstreamWordCountModeOf(withPunct))
    }
    expect(wordCountModeOf(false)).toBe('cjk')
    expect(wordCountModeOf(true)).toBe('cjk-punct')
  })

  it('WORD_COUNT_WITH_PUNCT_STORAGE_KEY 与上游 wordCountMode.ts:25 的字面量一致', () => {
    expect(WORD_COUNT_WITH_PUNCT_STORAGE_KEY).toBe('word-count-with-punct')
  })

  it('isWordCountMode（本仓补充口径）只认两个字面量', () => {
    expect(isWordCountMode('cjk')).toBe(true)
    expect(isWordCountMode('cjk-punct')).toBe(true)
    for (const value of ['CJK', '', undefined, null, 0, {}, [], true]) {
      expect(isWordCountMode(value)).toBe(false)
    }
  })
})

describe('countWordsBreakdown（本仓补充口径）', () => {
  it('两种 mode 下 total 恒等于 countWords（分解不引入新口径）', () => {
    for (const sample of SAMPLES) {
      for (const mode of MODES) {
        expect(countWordsBreakdown(sample, mode).total).toBe(countWords(sample, mode))
      }
    }
  })

  it('punctuation 恒为实测值：cjk 档下也如实给出标点数', () => {
    expect(countWordsBreakdown('世界！')).toEqual({
      total: 2,
      cjk: 2,
      latinWords: 0,
      punctuation: 1,
    })
    expect(countWordsBreakdown('世界！', 'cjk-punct')).toEqual({
      total: 3,
      cjk: 2,
      latinWords: 0,
      punctuation: 1,
    })
  })

  it('各项为非负整数', () => {
    for (const sample of SAMPLES) {
      const breakdown = countWordsBreakdown(sample, 'cjk-punct')
      for (const value of [breakdown.total, breakdown.cjk, breakdown.latinWords, breakdown.punctuation]) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('每次返回全新对象（纯函数证据，调用方改动不会污染下一次调用）', () => {
    const first = countWordsBreakdown('世界！')
    const second = countWordsBreakdown('世界！')
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  it('空串分解全为 0', () => {
    expect(countWordsBreakdown('')).toEqual({ total: 0, cjk: 0, latinWords: 0, punctuation: 0 })
  })
})

describe('入参边界（抛 TypeError —— 对齐上游隐式行为；文案对齐 text/index.ts:643）', () => {
  it('null / undefined / 数字 / 对象 / 数组 / 布尔 全部抛 TypeError', () => {
    const bad: readonly unknown[] = [null, undefined, 0, 1, Number.NaN, {}, [], true, Symbol('x'), () => 1]
    for (const value of bad) {
      expect(() => countWords(value as string)).toThrow(TypeError)
    }
  })

  it('错误信息区分 null 与 typeof（与 text/index.ts:643 的 assertString 同文案）', () => {
    expect(() => countWords(null as unknown as string)).toThrow('countWords 需要字符串，收到 null')
    expect(() => countWords(1 as unknown as string)).toThrow('countWords 需要字符串，收到 number')
  })

  it('countWordsBreakdown 同样抛 TypeError', () => {
    expect(() => countWordsBreakdown(null as unknown as string)).toThrow(
      'countWordsBreakdown 需要字符串，收到 null',
    )
  })

  it('冻结字符串照常统计（不抛、不试图改写入参，本仓补充口径）', () => {
    const frozen = Object.freeze('世界，hello 2026！') as unknown as string
    expect(countWords(frozen)).toBe(4) // 世/界 2 + hello 1 + 2026 1，标点不计
    expect(countWords(frozen, 'cjk-punct')).toBe(6) // + ，！
    expect(frozen).toBe('世界，hello 2026！')
    expect(frozen.length).toBe(14)
  })
})

describe('性能：大输入（1,000,000 字符）不卡死', () => {
  const hugeText = `${'汉'.repeat(500_000)}${'a'.repeat(499_990)}${',。'.repeat(5)}`

  it('1e6 字符两种口径各算一次，总耗时 < 2000ms，结果为整数', () => {
    expect(hugeText.length).toBe(1_000_000)
    const started = performance.now()
    const cjkTotal = countWords(hugeText)
    const punctTotal = countWords(hugeText, 'cjk-punct')
    const elapsed = performance.now() - started
    expect(Number.isInteger(cjkTotal)).toBe(true)
    expect(Number.isInteger(punctTotal)).toBe(true)
    expect(cjkTotal).toBe(500_001) // 500000 汉字 + 1 个字母词
    expect(punctTotal).toBe(500_006) // + 5 个标点
    expect(elapsed).toBeLessThan(2000)
  })

  it('大输入的分解自洽：total = cjk + latinWords + punctuation', () => {
    const breakdown = countWordsBreakdown(hugeText, 'cjk-punct')
    expect(breakdown.cjk).toBe(500_000)
    expect(breakdown.latinWords).toBe(1)
    expect(breakdown.punctuation).toBe(5)
    expect(breakdown.total).toBe(500_006)
    expect(breakdown.total).toBe(breakdown.cjk + breakdown.latinWords + breakdown.punctuation)
  })

  it('大输入结果与上游正则算法一致（1e6 字符只做一次对照）', () => {
    expect(countWords(hugeText, 'cjk-punct')).toBe(upstreamCountWords(hugeText, 'cjk-punct'))
  })
})