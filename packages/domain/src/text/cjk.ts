/**
 * 字符分类 —— B-13「字数双口径」的底层判定。
 *
 * ## 真源纪律
 * - 真源＝`_upstream_tmp/youth-fantasy-engine-main/src/lib/editor/textStats.ts`（全文 35 行，
 *   2026-10-16 逐字读取）：`CJK_RE` 在第 19 行、`PUNCT_RE` 在第 26–27 行。
 * - 本文件是它的**副本**：只把上游那两个正则的区段拆成可复用的 code unit 判定，
 *   **不含任何新口径**。改口径必须**双向同步**：先改上游 → 再改这里 → 再同步
 *   `packages/domain/tests/text/cjk.test.ts` 里那份「原样抄自上游」的 oracle 正则。
 * - 上游同一口径还有**第二份已经漂移的副本**：`src/lib/storage/chapterImport.ts:286`
 *   `countWordsLoose()` 用的是 `[\u4e00-\u9fff]`，**漏掉了扩展 A 区 `\u3400-\u4dbf`**。
 *   那是上游的既有 bug：本模块**只对齐 textStats.ts**，不要照抄那个 loose 版。
 *
 * ## 判定粒度：UTF-16 code unit（**不是** code point）
 * 上游 `CJK_RE` 没有 `u` 标志，是逐 code unit 匹配的 ⇒ 代理对（增补平面，如
 * U+20000＝`\uD840\uDC00`）的两个 code unit 都不落在任何区段里，「𠀀」这类字**计 0**。
 * 本模块刻意按 code unit 判定以求**逐字保真**；不要"顺手修正"成码位判定 ——
 * 那会让本仓算出的字数与上游、与网文平台的计费字数都对不上。
 */

/**
 * 上游 `CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g` 的区段（第 19 行）。
 *
 * ⚠️ 只有这两个区段：**不含**假名（U+3040–30FF）、**不含**韩文（U+AC00–D7A3）、
 * **不含** CJK 兼容汉字（U+F900–FAFF）、**不含**增补平面（U+20000+）。
 * 这不是遗漏 —— 上游就是这么写的，汉字之外的字符在 `cjk` 口径里一律不计。
 */
const CJK_CHAR_RANGES: readonly (readonly [number, number])[] = [
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0x3400, 0x4dbf], // CJK 扩展 A 区
]

/**
 * 上游 `PUNCT_RE` 的区段（第 26–27 行）——「网文平台计入字数」的那些标点。
 *
 * ⚠️ 上游**刻意排除**全角字母数字（U+FF10–FF19 / FF21–FF3A / FF41–FF5A），
 * 见上游第 23 行注释。也因此「，」计 1 而「,」计 0。
 * ⚠️ U+3000（全角空格）落在 `\u3000-\u303f` 里 ⇒ 在 `cjk-punct` 口径下**算 1 个字**，
 * 与「空白不计」的直觉相反；这是上游的真实行为。
 */
const CJK_PUNCT_CHAR_RANGES: readonly (readonly [number, number])[] = [
  [0x3000, 0x303f], // CJK 符号与标点（含 U+3000 全角空格）
  [0x2014, 0x2014], // — 破折号
  [0x2018, 0x201d], // ‘ ’ “ ”
  [0x2026, 0x2026], // … 省略号
  [0x00b7, 0x00b7], // · 间隔号
  [0xff01, 0xff0f], // ！＂＃＄％＆＇（）＊＋，－．／
  [0xff1a, 0xff20], // ：；＜＝＞？＠
  [0xff3b, 0xff40], // ［＼］＾＿｀
  [0xff5b, 0xff65], // ｛｜｝～｟｠｡｢｣､･
]

function inRanges(ranges: readonly (readonly [number, number])[], unit: number): boolean {
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]
    if (range === undefined) continue
    if (unit >= range[0] && unit <= range[1]) return true
  }
  return false
}

function assertStringInput(value: unknown, fn: string): asserts value is string {
  if (typeof value !== 'string') {
    // 与 `packages/domain/src/text/index.ts` 的 `assertString` 同文案。
    // 🔴 刻意不导出：`text/index.ts` 里那份是私有的且不在本任务可改范围内，
    //    共享它需要 Lead 先把它导出（见交付报告「建议」）。
    throw new TypeError(`${fn} 需要字符串，收到 ${value === null ? 'null' : typeof value}`)
  }
}

/**
 * 该 **UTF-16 code unit** 是否上游口径的「汉字」。
 *
 * 对应上游 `CJK_RE`（第 19 行）：U+4E00–U+9FFF、U+3400–U+4DBF。
 * 假名/韩文/兼容汉字/增补平面汉字一律 `false`。
 * 传非有限数（NaN）时返回 `false`（区间比较天然为 false，不抛）。
 */
export function isCjkCodeUnit(unit: number): boolean {
  return inRanges(CJK_CHAR_RANGES, unit)
}

/**
 * 该 **UTF-16 code unit** 是否上游口径的「中文标点」（`cjk-punct` 口径才计）。
 *
 * 对应上游 `PUNCT_RE`（第 26–27 行）；全角字母数字**不算**标点。详见
 * `CJK_PUNCT_CHAR_RANGES` 的注释。
 */
export function isCjkPunctCodeUnit(unit: number): boolean {
  return inRanges(CJK_PUNCT_CHAR_RANGES, unit)
}

/** 该 **UTF-16 code unit** 是否是 `[a-zA-Z0-9]`（上游按「连续这些字符＝一个词」计数）。 */
export function isAsciiWordCodeUnit(unit: number): boolean {
  if (unit >= 0x30 && unit <= 0x39) return true // 0-9
  if (unit >= 0x41 && unit <= 0x5a) return true // A-Z
  if (unit >= 0x61 && unit <= 0x7a) return true // a-z
  return false
}

/**
 * 单个字符（取其**首个 code unit**）是否上游口径的「汉字」。
 *
 * - 传入 `'世界'` 只看 `'世'`；要数整段请用 `countWords`。
 * - 传空串返回 `false`。
 * - 传 `null` / `undefined` / 数字 / 对象：抛 `TypeError`（上游正则只在字符串上有定义；
 *   本仓与 `countChars` 的处理一致 —— 见 `packages/domain/src/text/index.ts:643`）。
 *
 * 🔴 本函数是**本仓补充口径**：上游没有导出 `isCjk` 之类的判定函数，
 * 它只把区段写死在 `textStats.ts` 的两个正则里。行为由 `cjk.test.ts` 的
 * 「穷举 BMP 65536 个 code unit 与上游正则对照」用例钉住。
 */
export function isCjkChar(char: string): boolean {
  assertStringInput(char, 'isCjkChar')
  if (char.length === 0) return false
  return isCjkCodeUnit(char.charCodeAt(0))
}

/**
 * 单个字符（取其**首个 code unit**）是否上游口径的「中文标点」。
 *
 * 口径、边界与异常行为同 `isCjkChar`。🔴 同样是**本仓补充口径**（上游无此导出）。
 */
export function isCjkPunctChar(char: string): boolean {
  assertStringInput(char, 'isCjkPunctChar')
  if (char.length === 0) return false
  return isCjkPunctCodeUnit(char.charCodeAt(0))
}

/**
 * 单个字符（取其**首个 code unit**）是否是 `[a-zA-Z0-9]` —— 上游「词」的构成单位。
 *
 * 🔴 全角数字（U+FF10–FF19）**不是**：上游 `[a-zA-Z0-9]` 只认 ASCII，
 * 所以 `'２０２６'` 算 0 个词而 `'2026'` 算 1 个词。
 * 🔴 同样是**本仓补充口径**（上游无此导出）。
 */
export function isAsciiWordChar(char: string): boolean {
  assertStringInput(char, 'isAsciiWordChar')
  if (char.length === 0) return false
  return isAsciiWordCodeUnit(char.charCodeAt(0))
}