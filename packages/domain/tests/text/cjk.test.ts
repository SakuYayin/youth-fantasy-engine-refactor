/**
 * `packages/domain/src/text/cjk.ts` 的对照测试。
 *
 * ## oracle（**逐字抄自上游**）
 * 真源＝`_upstream_tmp/youth-fantasy-engine-main/src/lib/editor/textStats.ts`（全文 35 行）：
 * - 第 19 行 `const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g`
 * - 第 26–27 行
 *   `const PUNCT_RE =`
 *   `  /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/g`
 *
 * ⚠️ oracle 的**唯一刻意差异**：上游两个正则有 `g` 标志；本文件逐字符对照时**去掉 `g`**
 * （`RegExp.prototype.test` 带 `g` 会改 `lastIndex`，跨用例互相污染）。去掉 `g` 只影响
 * 「从哪个位置开始找」，**不改变字符集合**；最后由穷举用例证明范围逐值相等。
 *
 * 改口径必须双向同步：上游 ↔ `cjk.ts` ↔ 本文件。
 */
import { describe, expect, it } from 'vitest'

import {
  isAsciiWordChar,
  isAsciiWordCodeUnit,
  isCjkChar,
  isCjkCodeUnit,
  isCjkPunctChar,
  isCjkPunctCodeUnit,
} from '../../src/text/cjk.js'

/** 上游 `textStats.ts:19` 的逐字副本（去 `g`，见文件头说明）。 */
const UPSTREAM_CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/

/** 上游 `textStats.ts:26-27` 的逐字副本（去 `g`，见文件头说明）。 */
const UPSTREAM_PUNCT_RE =
  /[\u3000-\u303f\u2014\u2018-\u201d\u2026\u00b7]|[\uff01-\uff0f]|[\uff1a-\uff20]|[\uff3b-\uff40]|[\uff5b-\uff65]/

/** 上游写在 `countWords` 里的 `[a-zA-Z0-9]`（上游没有把它抽成常量）。 */
const UPSTREAM_ASCII_WORD_RE = /[a-zA-Z0-9]/

/** 穷举用：BMP 全部 65536 个 code unit。 */
const BMP_UNITS: readonly number[] = Array.from({ length: 0x10000 }, (_, index) => index)

describe('isCjkCodeUnit / isCjkChar —— 对齐上游 CJK_RE（textStats.ts:19）', () => {
  it('汉字区段：U+4E00 世 / U+9FFF 鿿 / U+3400 㐀 / U+4DBF 䶿 都算汉字', () => {
    for (const char of ['世', '界', '\u4e00', '\u9fff', '\u3400', '\u4dbf']) {
      expect(isCjkChar(char)).toBe(true)
      expect(isCjkCodeUnit(char.charCodeAt(0))).toBe(true)
    }
  })

  it('汉字区段边界：U+33FF 与 U+4DC0 不算（扩展 A 区之外），U+3400 与 U+4DBF 算', () => {
    expect(isCjkChar('\u33ff')).toBe(false)
    expect(isCjkChar('\u4dc0')).toBe(false)
    expect(isCjkChar('\u3400')).toBe(true)
    expect(isCjkChar('\u4dbf')).toBe(true)
  })

  it('统一表意文字上界之外：U+9FFF 算，U+A000（彝文起点）与 U+FAFF 不算', () => {
    expect(isCjkChar('\u4e00')).toBe(true)
    expect(isCjkChar('\u9fff')).toBe(true)
    expect(isCjkChar('\ua000')).toBe(false)
    expect(isCjkChar('\ufaff')).toBe(false)
  })

  it('粒度是 UTF-16 code unit（本仓补充口径）：增补平面「𠀀」(U+20000) 的两个 code unit 都不算汉字', () => {
    expect(isCjkChar('\u{20000}')).toBe(false)
    expect(isCjkCodeUnit(0xd840)).toBe(false)
    expect(isCjkCodeUnit(0xdc00)).toBe(false)
  })

  it('假名（U+3040–30FF）不算汉字 —— 上游「日更 N 字」只数汉字，所以日文正文计 0', () => {
    for (const char of ['\u3042', '\u3040', '\u30a2', '\u30ff']) {
      expect(isCjkChar(char)).toBe(false)
    }
  })

  it('谚文（U+1100–11FF / U+3130–318F / U+AC00–D7A3）不算汉字', () => {
    for (const char of ['\u1100', '\u3131', '\ud55c', '\uac00', '\ud7a3']) {
      expect(isCjkChar(char)).toBe(false)
    }
  })

  it('CJK 兼容汉字（U+F900–FAFF）与 CJK 兼容（U+FE30–FE4F）都不算汉字 —— 乐(U+F9E4) 计 0', () => {
    expect(isCjkChar('\uf9e4')).toBe(false)
    expect(isCjkChar('\ufe30')).toBe(false)
  })

  it('ASCII、拉丁扩展、数字、空白、emoji 都不算汉字', () => {
    for (const char of ['a', 'Z', '0', ' ', '\t', '\n', '\u00e9', '\u2014', '\ud83d', '\udc4d']) {
      expect(isCjkChar(char)).toBe(false)
    }
  })

  it('空串与孤立代理项不抛：isCjkChar(\'\') === false，isCjkCodeUnit(NaN) === false', () => {
    expect(isCjkChar('')).toBe(false)
    expect(isCjkCodeUnit(Number.NaN)).toBe(false)
    expect(isCjkCodeUnit(-1)).toBe(false)
  })

  it('非字符串抛 TypeError（本仓补充口径；文案与 text/index.ts:643 的 assertString 一致）', () => {
    expect(() => isCjkChar(null as unknown as string)).toThrow(TypeError)
    expect(() => isCjkChar(123 as unknown as string)).toThrow(/需要字符串/)
    expect(() => isCjkChar({} as unknown as string)).toThrow(/收到 object/)
    expect(() => isCjkPunctChar(undefined as unknown as string)).toThrow(/收到 undefined/)
    expect(() => isAsciiWordChar(true as unknown as string)).toThrow(/收到 boolean/)
  })

  it('穷举 BMP 全部 65536 个 code unit：与上游 CJK_RE 逐值相等，且恰好 27584 个汉字', () => {
    let cjk = 0
    for (const unit of BMP_UNITS) {
      const char = String.fromCharCode(unit)
      const expected = UPSTREAM_CJK_RE.test(char)
      expect(isCjkCodeUnit(unit), `U+${unit.toString(16)}`).toBe(expected)
      if (expected) cjk += 1
    }
    // 0x9FFF-0x4E00+1 = 20992，0x4DBF-0x3400+1 = 6592，合计 27584。
    expect(cjk).toBe(27584)
  })
})

describe('isCjkPunctCodeUnit / isCjkPunctChar —— 对齐上游 PUNCT_RE（textStats.ts:26-27）', () => {
  it('中文标点：。 U+3002 / ， U+FF0C / ！ U+FF01 / ？ U+FF1F / 、 U+3001 / — U+2014 / … U+2026 / · U+00B7 都算', () => {
    for (const char of ['\u3002', '\uff0c', '\uff01', '\uff1f', '\u3001', '\u2014', '\u2026', '\u00b7']) {
      expect(isCjkPunctChar(char)).toBe(true)
      expect(isCjkPunctCodeUnit(char.charCodeAt(0))).toBe(true)
    }
  })

  it('中文引号 U+2018–U+201D 都算（‘ ’ “ ”）；U+2017 与 U+201E 不算（区间刻意留空）', () => {
    for (const char of ['\u2018', '\u2019', '\u201c', '\u201d']) {
      expect(isCjkPunctChar(char)).toBe(true)
    }
    expect(isCjkPunctChar('\u2015')).toBe(false)
    expect(isCjkPunctChar('\u2017')).toBe(false)
    expect(isCjkPunctChar('\u201e')).toBe(false)
  })

  it('U+3000 全角空格算标点 —— 落在 \\u3000-\\u303f 里，与「空白不计」的直觉相反（上游真实行为）', () => {
    expect(isCjkPunctChar('\u3000')).toBe(true)
    expect(isCjkPunctChar(' ')).toBe(false)
  })

  it('CJK 标点区段边界：U+303F 算，U+3040 不算', () => {
    expect(isCjkPunctChar('\u303f')).toBe(true)
    expect(isCjkPunctChar('\u3040')).toBe(false)
  })

  it('全角区段四组边界：U+FF0F 算/U+FF10 不算，U+FF20 算/U+FF21 不算，U+FF40 算/U+FF41 不算，U+FF65 算/U+FF66 不算', () => {
    expect(isCjkPunctChar('\uff0f')).toBe(true)
    expect(isCjkPunctChar('\uff10')).toBe(false)
    expect(isCjkPunctChar('\uff20')).toBe(true)
    expect(isCjkPunctChar('\uff21')).toBe(false)
    expect(isCjkPunctChar('\uff40')).toBe(true)
    expect(isCjkPunctChar('\uff41')).toBe(false)
    expect(isCjkPunctChar('\uff65')).toBe(true)
    expect(isCjkPunctChar('\uff66')).toBe(false)
  })

  it('全角字母数字被上游刻意排除（第 23 行注释）：全角 0/9/A/Z/a/z 都不算标点', () => {
    for (const char of ['\uff10', '\uff19', '\uff21', '\uff3a', '\uff41', '\uff5a']) {
      expect(isCjkPunctChar(char)).toBe(false)
    }
  })

  it('半角 ASCII 标点一个都不算：, . ! ? : ; - ( ) [ ] { } " \' / 都不算', () => {
    for (const char of [',', '.', '!', '?', ':', ';', '-', '(', ')', '[', ']', '{', '}', '"', "'", '/']) {
      expect(isCjkPunctChar(char)).toBe(false)
    }
  })

  it('恰在区间缝里的码位不算：U+2027 ‧ 、U+00B6 ¶ 、U+00B8 ¸ 不算；U+FF5C ｜ 与 U+FF5D ｝ 都算', () => {
    expect(isCjkPunctChar('\u2027')).toBe(false)
    expect(isCjkPunctChar('\u00b6')).toBe(false)
    expect(isCjkPunctChar('\u00b8')).toBe(false)
    expect(isCjkPunctChar('\uff5c')).toBe(true)
    expect(isCjkPunctChar('\uff5d')).toBe(true)
  })

  it('U+FFE0 ￠（半角/全角形式区）不算标点', () => {
    expect(isCjkPunctChar('\uffe0')).toBe(false)
  })

  it('空串不抛：isCjkPunctChar(\'\') === false，isCjkPunctCodeUnit(NaN) === false', () => {
    expect(isCjkPunctChar('')).toBe(false)
    expect(isCjkPunctCodeUnit(Number.NaN)).toBe(false)
  })

  it('穷举 BMP 全部 65536 个 code unit：与上游 PUNCT_RE 逐值相等，且恰好 112 个', () => {
    let punct = 0
    for (const unit of BMP_UNITS) {
      const char = String.fromCharCode(unit)
      const expected = UPSTREAM_PUNCT_RE.test(char)
      expect(isCjkPunctCodeUnit(unit), `U+${unit.toString(16)}`).toBe(expected)
      if (expected) punct += 1
    }
    // 64(3000-303F) +1(2014) +6(2018-201D) +1(2026) +1(00B7) +15(FF01-FF0F)
    // +7(FF1A-FF20) +6(FF3B-FF40) +11(FF5B-FF65) = 112。
    expect(punct).toBe(112)
  })
})

describe('isAsciiWordCodeUnit / isAsciiWordChar —— 对齐上游 [a-zA-Z0-9]', () => {
  it('ASCII 数字/大写/小写六个边界码位都算词的构成单位', () => {
    for (const char of ['0', '9', 'A', 'Z', 'a', 'z']) {
      expect(isAsciiWordChar(char)).toBe(true)
      expect(isAsciiWordCodeUnit(char.charCodeAt(0))).toBe(true)
    }
  })

  it('区间边界：U+002F / 与 U+003A : 、U+0040 @ 与 U+005B [ 、U+0060 ` 与 U+007B { 都不算', () => {
    for (const char of ['/', ':', '@', '[', '`', '{']) {
      expect(isAsciiWordChar(char)).toBe(false)
    }
  })

  it('全角数字与全角字母都不算 —— 上游只认 ASCII，[０] 计 0 个词', () => {
    for (const char of ['\uff10', '\uff19', '\uff21', '\uff3a', '\uff41', '\uff5a']) {
      expect(isAsciiWordChar(char)).toBe(false)
    }
  })

  it('带变音符的拉丁字母不算：é(U+00E9) / ü(U+00FC) / å(U+00E5) / 组合用重音 U+0301', () => {
    for (const char of ['\u00e9', '\u00fc', '\u00e5', '\u0301']) {
      expect(isAsciiWordChar(char)).toBe(false)
    }
  })

  it('下划线、连字符、空格、换行都不算词的构成单位', () => {
    for (const char of ['_', '-', ' ', '\t', '\n', '\u3000']) {
      expect(isAsciiWordChar(char)).toBe(false)
    }
  })

  it('空串返回 false；非字符串抛 TypeError', () => {
    expect(isAsciiWordChar('')).toBe(false)
    expect(isAsciiWordCodeUnit(Number.NaN)).toBe(false)
    expect(() => isAsciiWordChar([] as unknown as string)).toThrow(TypeError)
  })

  it('穷举 BMP：与上游 [a-zA-Z0-9] 逐值相等，且恰好 62 个 code unit', () => {
    let words = 0
    for (const unit of BMP_UNITS) {
      const char = String.fromCharCode(unit)
      const expected = UPSTREAM_ASCII_WORD_RE.test(char)
      expect(isAsciiWordCodeUnit(unit), `U+${unit.toString(16)}`).toBe(expected)
      if (expected) words += 1
    }
    // 10 个数字 + 26 个大写 + 26 个小写 = 62。
    expect(words).toBe(62)
  })
})