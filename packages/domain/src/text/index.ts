/**
 * `@yfe/domain/text` —— 正文归一化、字素簇扫描与字数统计。
 *
 * 设计依据：
 * - `06-数据与本地存储.md`：正文存纯文本 UTF-8，**换行规范化规则版本固定**；
 *   字数是业务算法的派生值，**不用平台字符串 length 替代中文及 Unicode 字数规则**，
 *   移动端与桌面端必须用同一样本验证。
 * - `10-开发规范与环境.md`：领域层无 IO、无 Electron/Fastify/DOM 依赖。
 *
 * 关键取舍：
 * 1. 🔴 `countChars` 按 **字素簇（grapheme cluster, UAX #29）** 计数，不是 UTF-16 code unit。
 *    `'👍'.length === 2`、`'👨‍👩‍👧‍👦'.length === 11`，直接拿 `String.length` 当字数会系统性偏大。
 * 2. 主路径用 `Intl.Segmenter`（Node 24 / 现代 WebView 自带）；运行时缺失或实现异常时
 *    自动降级到内置的码位近似实现，**降级路径不得抛错**（见 `graphemeEngineInfo`）。
 * 3. 🔴 **不做 Unicode NFC 归一化**：NFC 会改写用户原文的字节（"可恢复原文"的前提），
 *    而字素簇计数本来就能正确处理组合字符。这里只做无损的换行/BOM 归一化。
 */

// ---------------------------------------------------------------------------
// 正文归一化
// ---------------------------------------------------------------------------

/**
 * 换行归一化规则版本。
 *
 * 🔴 规则一旦发布只能新增版本号、不得原地改义：导入器与迁移器需要记录"这段正文
 * 是按哪一版规则归一化的"，否则移动端与桌面端算出的字数会不可比。
 */
export const BODY_NORMALIZATION_VERSION = 1 as const

/** 归一化过程中实际执行过的步骤（顺序即执行顺序）。 */
export type NormalizationStep = 'bom' | 'crlf' | 'cr' | 'unicode-separator'

export interface NormalizeBodyOptions {
  /** 去掉**开头**的 BOM（U+FEFF）。默认 `true`。 */
  readonly stripBom?: boolean
  /** `CRLF` 与单独 `CR` → `LF`。默认 `true`。 */
  readonly normalizeLineEndings?: boolean
  /** `U+2028` / `U+2029` → `LF`。默认 `true`。 */
  readonly normalizeUnicodeSeparators?: boolean
}

export interface NormalizeBodyReport {
  readonly text: string
  /** 是否发生了任何改动。导入器据此决定是否需要保留可恢复原文。 */
  readonly changed: boolean
  readonly steps: readonly NormalizationStep[]
}

const BOM_CODE = 0xfeff

/**
 * 归一化并返回**执行报告**。
 *
 * 顺序刻意固定为 BOM → CRLF/CR → U+2028/U+2029，保证同一输入在任何端得到同一输出
 * （`BODY_NORMALIZATION_VERSION = 1` 的语义）。
 */
export function normalizeBodyReport(
  raw: string,
  options: NormalizeBodyOptions = {},
): NormalizeBodyReport {
  assertString(raw, 'normalizeBody')
  const stripBom = options.stripBom ?? true
  const normalizeLineEndings = options.normalizeLineEndings ?? true
  const normalizeSeparators = options.normalizeUnicodeSeparators ?? true

  const steps: NormalizationStep[] = []
  let text = raw

  if (stripBom && text.charCodeAt(0) === BOM_CODE) {
    text = text.slice(1)
    steps.push('bom')
  }

  if (normalizeLineEndings) {
    // 先 CRLF 再单独 CR，避免把 `\r\n` 拆成两个换行。
    if (text.includes('\r\n')) {
      text = text.replace(/\r\n/g, '\n')
      steps.push('crlf')
    }
    if (text.includes('\r')) {
      text = text.replace(/\r/g, '\n')
      steps.push('cr')
    }
  }

  if (normalizeSeparators && (text.includes('\u2028') || text.includes('\u2029'))) {
    // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR：JS 里算行终止符，
    // 但多数编辑器与 SQLite 文本处理不认，必须落成 LF 才能跨端一致。
    text = text.replace(/[\u2028\u2029]/g, '\n')
    steps.push('unicode-separator')
  }

  return { text, changed: steps.length > 0, steps }
}

/** 归一化正文。幂等：`normalizeBody(normalizeBody(x)) === normalizeBody(x)`。 */
export function normalizeBody(raw: string, options: NormalizeBodyOptions = {}): string {
  return normalizeBodyReport(raw, options).text
}

/** 判定一段文本是否已经是归一化形态（用于导入器与保存前的短路检查）。 */
export function isNormalizedBody(text: string, options: NormalizeBodyOptions = {}): boolean {
  assertString(text, 'isNormalizedBody')
  return normalizeBody(text, options) === text
}

// ---------------------------------------------------------------------------
// 字素簇扫描
// ---------------------------------------------------------------------------

/** 字素簇切分引擎。`code-point-fallback` 是 `Intl.Segmenter` 不可用时的降级近似实现。 */
export type GraphemeEngine = 'intl-segmenter' | 'code-point-fallback'

export interface GraphemeScanOptions {
  /** 默认 `'auto'`：优先 `Intl.Segmenter`，不可用时降级。显式指定缺失的引擎会抛错。 */
  readonly engine?: GraphemeEngine | 'auto'
}

/** 一个字素簇。`index` 是 UTF-16 code unit 下标（与 `String.prototype.slice` 一致）。 */
export interface GraphemeSegment {
  readonly segment: string
  readonly index: number
  readonly codePointCount: number
}

export interface GraphemeEngineInfo {
  readonly engine: GraphemeEngine
  /** 降级原因（使用 `intl-segmenter` 时为 `null`）。 */
  readonly fallbackReason: string | null
}

interface SegmenterLike {
  segment(input: string): Iterable<{ readonly segment: string; readonly index: number }>
}

type SegmenterCtor = new (
  locales?: string,
  options?: { readonly granularity?: 'grapheme' },
) => SegmenterLike

/** `undefined` = 尚未探测；`null` = 探测过且不可用。 */
let cachedSegmenter: SegmenterLike | null | undefined
let cachedEngine: GraphemeEngine = 'code-point-fallback'
let cachedFallbackReason: string | null = null

function resolveSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  cachedSegmenter = null
  cachedFallbackReason = null
  try {
    const intl = (globalThis as { Intl?: { Segmenter?: unknown } }).Intl
    const ctor = intl?.Segmenter
    if (typeof ctor !== 'function') {
      cachedFallbackReason = '运行时未提供 Intl.Segmenter'
      return null
    }
    const instance = new (ctor as SegmenterCtor)('zh-Hans', { granularity: 'grapheme' })
    // 探测一次：避免"构造成功但 segment 不可用"的半残实现把字数算错。
    let probeCount = 0
    for (const _ of instance.segment('a\u0301')) probeCount += 1
    if (probeCount !== 1) {
      cachedFallbackReason = `Intl.Segmenter 探测结果异常（'a\\u0301' 得到 ${probeCount} 簇）`
      return null
    }
    cachedSegmenter = instance
    cachedEngine = 'intl-segmenter'
    return instance
  } catch (error) {
    cachedFallbackReason = `Intl.Segmenter 初始化失败：${describeError(error)}`
    return null
  }
}

/** 当前生效的字素簇引擎与降级原因（诊断/日志用，不参与业务判定）。 */
export function graphemeEngineInfo(): GraphemeEngineInfo {
  resolveSegmenter()
  return { engine: cachedEngine, fallbackReason: cachedFallbackReason }
}

function resolveEngine(requested: GraphemeEngine | 'auto' | undefined): GraphemeEngine {
  if (requested === undefined || requested === 'auto') {
    return resolveSegmenter() === null ? 'code-point-fallback' : 'intl-segmenter'
  }
  if (requested === 'intl-segmenter' && resolveSegmenter() === null) {
    throw new Error(
      `请求的字素簇引擎 Intl.Segmenter 不可用：${cachedFallbackReason ?? '未知原因'}`,
    )
  }
  return requested
}

/**
 * 扫描字素簇。
 *
 * 返回值长度即 `countChars` 的结果；需要逐簇分类（字数分解）时用本函数。
 */
export function scanGraphemes(
  text: string,
  options: GraphemeScanOptions = {},
): readonly GraphemeSegment[] {
  assertString(text, 'scanGraphemes')
  const engine = resolveEngine(options.engine)
  const out: GraphemeSegment[] = []

  if (engine === 'intl-segmenter') {
    const segmenter = resolveSegmenter()
    if (segmenter !== null) {
      for (const part of segmenter.segment(text)) {
        out.push({
          segment: part.segment,
          index: part.index,
          codePointCount: countCodePoints(part.segment),
        })
      }
      return out
    }
  }

  for (const part of fallbackGraphemes(text)) out.push(part)
  return out
}

// ---------------------------------------------------------------------------
// 字数统计
// ---------------------------------------------------------------------------

/**
 * 字数：**字素簇个数**。
 *
 * 🔴 调用方必须先 `normalizeBody`：`'\r\n'` 在 UAX #29 里是**一个字素簇**，
 * 未归一化的正文会得到与归一化后不同的字数。
 */
export function countChars(text: string, options: GraphemeScanOptions = {}): number {
  assertString(text, 'countChars')
  if (text.length === 0) return 0

  const engine = resolveEngine(options.engine)
  if (engine === 'intl-segmenter') {
    const segmenter = resolveSegmenter()
    if (segmenter !== null) {
      // 大正文不该为了数数分配数组：直接迭代计数。
      let total = 0
      for (const _ of segmenter.segment(text)) total += 1
      return total
    }
  }

  let total = 0
  for (const _ of fallbackGraphemes(text)) total += 1
  return total
}

/** 字数分解。`total` 恒等于 `countChars(text)`，且等于其余各项之和。 */
export interface CharCountBreakdown {
  readonly total: number
  /** 中日韩表意文字与假名（按首码位判定）。 */
  readonly chinese: number
  /** 英文/数字**词**数：连续拉丁字母数字字素簇算一个词，`don't` / `l'été` 记一个词。 */
  readonly latinWords: number
  /** 标点与符号。 */
  readonly punctuation: number
  /** 空白（含 `\n`、`\t`、U+3000 等）。 */
  readonly whitespace: number
  /** 其余（emoji、西里尔/希腊字母、非 ASCII 符号等），每个字素簇记 1。 */
  readonly other: number
}

/**
 * 字数分解：中文/英文词/标点/空白分别计数。
 *
 * 分类按**字素簇的首个码位**判定（因此 `'e'+U+0301` 记作拉丁字母、
 * `'好'+VS17` 记作中文、`'👍🏽'` 记作 other），每个字素簇恰好落入一个**类别**。
 *
 * 🔴 不变量（注意 `latinWords` 计的是**词**不是簇，所以各项之和**不等于** `total`）：
 *
 * - `total === countChars(text)`，且等于字素簇总数；
 * - `chinese + punctuation + whitespace + other` 数的是簇；
 *   余下的 `total - (chinese + punctuation + whitespace + other)` 就是拉丁字母/数字**簇**数；
 * - `latinWords` 是该簇序列里的**词**数（连续 alnum 算一个词，`don't` 记一个词），
 *   故 `latinWords <= 拉丁簇数`，且仅当没有多字母单词时取等。
 *
 * 界面上要显示"总字数"时请用 `total`/`countChars`，不要用各项之和。
 */
export function countCharsBreakdown(
  text: string,
  options: GraphemeScanOptions = {},
): CharCountBreakdown {
  assertString(text, 'countCharsBreakdown')
  const graphemes = scanGraphemes(text, options)

  let chinese = 0
  let latinWords = 0
  let punctuation = 0
  let whitespace = 0
  let other = 0
  let inLatinRun = false

  for (let i = 0; i < graphemes.length; i += 1) {
    const current = graphemes[i]
    if (current === undefined) continue
    const cls = classifyGrapheme(current.segment)

    if (cls === 'latin') {
      if (!inLatinRun) {
        latinWords += 1
        inLatinRun = true
      }
      continue
    }

    if (cls === 'punctuation' && inLatinRun && isWordJoinerPunctuation(current.segment)) {
      // `don't` / `l'été`：撇号夹在拉丁词中间时不切断词。
      // 🔴 仍要把这一簇记进 `punctuation`，否则它哪个桶都不落、
      // "总簇数 = 四个簇桶 + 拉丁簇数"这条核对式就失效了。
      const next = graphemes[i + 1]
      if (next !== undefined && classifyGrapheme(next.segment) === 'latin') {
        punctuation += 1
        continue
      }
    }

    inLatinRun = false
    if (cls === 'chinese') chinese += 1
    else if (cls === 'punctuation') punctuation += 1
    else if (cls === 'whitespace') whitespace += 1
    else other += 1
  }

  return {
    total: graphemes.length,
    chinese,
    latinWords,
    punctuation,
    whitespace,
    other,
  }
}

type GraphemeClass = 'whitespace' | 'chinese' | 'latin' | 'punctuation' | 'other'

function classifyGrapheme(segment: string): GraphemeClass {
  const first = segment.codePointAt(0) ?? 0
  if (isWhitespaceCodePoint(first)) return 'whitespace'
  if (isCjkCodePoint(first)) return 'chinese'
  if (isLatinCodePoint(first)) return 'latin'
  if (isPunctuationCodePoint(first)) return 'punctuation'
  return 'other'
}

function countCodePoints(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

// ---------------------------------------------------------------------------
// 降级实现（码位 + UAX #29 近似规则）
// ---------------------------------------------------------------------------

/**
 * 码位级近似切分，仅在 `Intl.Segmenter` 不可用时使用。
 *
 * 覆盖：CRLF、组合记号/变体选择符/肤色修饰符、ZWJ 序列（家庭 emoji）、区域指示符
 * 成对（国旗）、印度语系连写（virama）。
 * 已知偏差：Hangul Jamo 组合、部分 Prepend、少数稀有的 GB9c 形态可能被切成多簇
 * （只会**高估**簇数，不会把两个字误并成一个）。
 */
function* fallbackGraphemes(text: string): Generator<GraphemeSegment> {
  const len = text.length
  let i = 0

  while (i < len) {
    const start = i
    let prev = text.codePointAt(i) ?? 0
    i += codePointSize(prev)
    let codePointCount = 1
    let regionalRun = isRegionalIndicator(prev) ? 1 : 0
    let prevWasVirama = isVirama(prev)

    while (i < len) {
      const next = text.codePointAt(i) ?? 0
      let joins: boolean

      if (prev === 0x0d && next === 0x0a) {
        joins = true // GB3：CR × LF
      } else if (isBreakControl(prev) || isBreakControl(next)) {
        joins = false // GB4 / GB5
      } else if (next === 0x200d || isExtendLike(next)) {
        joins = true // GB9 / GB9a
      } else if (prev === 0x200d && isPictographic(next)) {
        joins = true // GB11
      } else if (prevWasVirama && isLetterCodePoint(next)) {
        joins = true // GB9c 近似：virama 后的辅音并入同一簇
      } else if (isRegionalIndicator(next)) {
        joins = regionalRun % 2 === 1 // GB12 / GB13：国旗两两成对
      } else {
        joins = false // GB999
      }

      if (!joins) break
      i += codePointSize(next)
      codePointCount += 1
      if (isRegionalIndicator(next)) regionalRun += 1
      prevWasVirama = isVirama(next)
      prev = next
    }

    yield { segment: text.slice(start, i), index: start, codePointCount }
  }
}

function codePointSize(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1
}

// ---------------------------------------------------------------------------
// 码位分类表（刻意不依赖 `\p{...}` Unicode 属性转义：
// 移动端精简 JS 运行时可能不支持属性转义，属性转义缺失不应让领域层直接崩溃）
// ---------------------------------------------------------------------------

function inRange(codePoint: number, lo: number, hi: number): boolean {
  return codePoint >= lo && codePoint <= hi
}

/** JS `\s` 语义的空白码位。 */
function isWhitespaceCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0b || codePoint === 0x0c) {
    return true
  }
  if (codePoint === 0x0d || codePoint === 0x20 || codePoint === 0xa0) return true
  if (codePoint === 0x1680) return true
  if (inRange(codePoint, 0x2000, 0x200a)) return true
  if (codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x202f) return true
  if (codePoint === 0x205f || codePoint === 0x3000 || codePoint === 0xfeff) return true
  return false
}

/** 中日韩表意文字（含扩展区）与假名。 */
function isCjkCodePoint(codePoint: number): boolean {
  if (inRange(codePoint, 0x3400, 0x4dbf)) return true
  if (inRange(codePoint, 0x4e00, 0x9fff)) return true
  if (inRange(codePoint, 0xf900, 0xfaff)) return true
  if (inRange(codePoint, 0x3040, 0x30ff)) return true // 平假名 / 片假名
  if (inRange(codePoint, 0x31f0, 0x31ff)) return true
  if (inRange(codePoint, 0xff66, 0xff9d)) return true // 半角片假名
  if (inRange(codePoint, 0x20000, 0x2a6df)) return true
  if (inRange(codePoint, 0x2a700, 0x2ebef)) return true
  if (inRange(codePoint, 0x2f800, 0x2fa1f)) return true
  if (inRange(codePoint, 0x30000, 0x3134f)) return true
  return false
}

/** 拉丁字母/数字（含全角形）。 */
function isAlnumCodePoint(codePoint: number): boolean {
  if (inRange(codePoint, 0x30, 0x39)) return true
  if (inRange(codePoint, 0x41, 0x5a)) return true
  if (inRange(codePoint, 0x61, 0x7a)) return true
  if (inRange(codePoint, 0xff10, 0xff19)) return true
  if (inRange(codePoint, 0xff21, 0xff3a)) return true
  if (inRange(codePoint, 0xff41, 0xff5a)) return true
  return false
}

/**
 * 拉丁字母/数字（含带变音符的拉丁字母）。
 *
 * 🔴 必须包含 `é`（U+00E9）这类**预组合**拉丁字母：否则 `café`、`l'été` 会被
 * 拆成两个词（`caf` + `é`），英文词数直接算错。`0x00D7`（×）与 `0x00F7`（÷）
 * 是数学符号而非字母，刻意从区间里挖掉。
 */
function isLatinCodePoint(codePoint: number): boolean {
  if (isAlnumCodePoint(codePoint)) return true
  if (inRange(codePoint, 0x00c0, 0x00d6)) return true
  if (inRange(codePoint, 0x00d8, 0x00f6)) return true
  if (inRange(codePoint, 0x00f8, 0x02af)) return true // Latin-1 补充 + Extended-A/B + IPA
  if (inRange(codePoint, 0x1e00, 0x1eff)) return true // Latin Extended Additional
  if (inRange(codePoint, 0x2c60, 0x2c7f)) return true
  if (inRange(codePoint, 0xa720, 0xa7ff)) return true
  return false
}

function isLetterCodePoint(codePoint: number): boolean {
  if (isAlnumCodePoint(codePoint)) return true
  if (isCjkCodePoint(codePoint)) return true
  if (inRange(codePoint, 0x0900, 0x0dff)) return true // 印度语系
  if (inRange(codePoint, 0x0370, 0x03ff)) return true // 希腊
  if (inRange(codePoint, 0x0400, 0x04ff)) return true // 西里尔
  return false
}

function isPunctuationCodePoint(codePoint: number): boolean {
  if (inRange(codePoint, 0x21, 0x2f)) return true
  if (inRange(codePoint, 0x3a, 0x40)) return true
  if (inRange(codePoint, 0x5b, 0x60)) return true
  if (inRange(codePoint, 0x7b, 0x7e)) return true
  if (inRange(codePoint, 0x2000, 0x206f)) return true // General Punctuation
  if (inRange(codePoint, 0x3001, 0x303f)) return true // CJK 标点
  if (inRange(codePoint, 0xfe10, 0xfe19)) return true
  if (inRange(codePoint, 0xfe30, 0xfe6f)) return true
  if (inRange(codePoint, 0xff01, 0xff0f)) return true
  if (inRange(codePoint, 0xff1a, 0xff20)) return true
  if (inRange(codePoint, 0xff3b, 0xff40)) return true
  if (inRange(codePoint, 0xff5b, 0xff65)) return true
  return false
}

function isWordJoinerPunctuation(segment: string): boolean {
  return segment === "'" || segment === '\u2019'
}

/** Cc / Cf / Zl / Zp —— 字素簇一律在这里断开（ZWJ 除外，它是 GB9/GB11 的连接符）。 */
function isBreakControl(codePoint: number): boolean {
  if (codePoint === 0x200d) return false
  if (inRange(codePoint, 0x00, 0x1f)) return true
  if (inRange(codePoint, 0x7f, 0x9f)) return true
  if (codePoint === 0x2028 || codePoint === 0x2029) return true
  if (inRange(codePoint, 0x200b, 0x200f)) return true
  return false
}

function isRegionalIndicator(codePoint: number): boolean {
  return inRange(codePoint, 0x1f1e6, 0x1f1ff)
}

function isVirama(codePoint: number): boolean {
  switch (codePoint) {
    case 0x094d: // Devanagari
    case 0x09cd: // Bengali
    case 0x0a4d: // Gurmukhi
    case 0x0acd: // Gujarati
    case 0x0b4d: // Oriya
    case 0x0bcd: // Tamil
    case 0x0c4d: // Telugu
    case 0x0ccd: // Kannada
    case 0x0d4d: // Malayalam
    case 0x0dca: // Sinhala
    case 0x0f84: // Tibetan
      return true
    default:
      return false
  }
}

/** GB9 / GB9a：组合记号（`\p{M}`）与变体选择符、肤色修饰符、标签字符。 */
const EXTEND_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0900, 0x0903],
  [0x093a, 0x094f],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0983],
  [0x09bc, 0x09cd],
  [0x0a01, 0x0a03],
  [0x0a3c, 0x0a4d],
  [0x0b01, 0x0b03],
  [0x0b3c, 0x0b4d],
  [0x0c00, 0x0c04],
  [0x0c3e, 0x0c4d],
  [0x0d00, 0x0d03],
  [0x0d3b, 0x0d4d],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc],
  [0x0f18, 0x0f19],
  [0x0f35, 0x0f35],
  [0x0f37, 0x0f37],
  [0x0f39, 0x0f39],
  [0x0f71, 0x0f84],
  [0x102b, 0x103e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20f0],
  [0x2cef, 0x2cf1],
  [0x302a, 0x302f],
  [0x3099, 0x309a],
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff], // emoji 肤色修饰符
  [0xe0020, 0xe007f], // tag 字符（旗帜子序列）
  [0xe0100, 0xe01ef], // 变体选择符补充
]

function isExtendLike(codePoint: number): boolean {
  for (const range of EXTEND_RANGES) {
    if (inRange(codePoint, range[0], range[1])) return true
  }
  return false
}

/** GB11 的 Extended_Pictographic（近似：emoji 主要区段）。 */
const PICTOGRAPHIC_RANGES: readonly (readonly [number, number])[] = [
  [0x00a9, 0x00a9],
  [0x00ae, 0x00ae],
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122],
  [0x2139, 0x2139],
  [0x2194, 0x21aa],
  [0x231a, 0x231b],
  [0x2328, 0x2328],
  [0x23cf, 0x23cf],
  [0x23e9, 0x23f3],
  [0x23f8, 0x23fa],
  [0x24c2, 0x24c2],
  [0x25aa, 0x25ab],
  [0x25b6, 0x25b6],
  [0x25c0, 0x25c0],
  [0x25fb, 0x25fe],
  [0x2600, 0x27bf],
  [0x2934, 0x2935],
  [0x2b05, 0x2b55],
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
  [0x1f000, 0x1faff],
  [0x1fc00, 0x1fffd],
]

function isPictographic(codePoint: number): boolean {
  for (const range of PICTOGRAPHIC_RANGES) {
    if (inRange(codePoint, range[0], range[1])) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function assertString(value: unknown, fn: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${fn} 需要字符串，收到 ${value === null ? 'null' : typeof value}`)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
