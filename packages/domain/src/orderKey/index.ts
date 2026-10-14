/**
 * `@yfe/domain/orderKey` —— 分数索引（fractional index）排序键。
 *
 * 用途：`Document.orderKey` / `SettingsEntity.orderKey`（见 `@yfe/contracts`）。
 * 同级节点在两键之间插入时**只改一个键**，不重排整棵树的兄弟节点，
 * 因此并发拖动不会互相打架（`06-数据与本地存储.md`）。
 *
 * ## 键的文法
 *
 * ```
 * key      ::= integer ( "." fraction )?
 * integer  ::= [0-9A-Za-z]+        // 通常由本模块生成为 27 字符定宽
 * fraction ::= [0-9A-Za-z]+        // 🔴 末位不得为 "0"（见下）
 * ```
 *
 * ## 排序
 *
 * 一律按 **ASCII 字节序**比较（JS 的 `<` / `>`，SQLite 的 BINARY 排序）。
 * 🔴 绝不用 `localeCompare`：中文环境下它会给出与 SQLite 不同的顺序，
 * 那会让"本地顺序"和"远端顺序"分歧。
 *
 * 字符表只用 `0-9A-Za-z`（0x30–0x7A）外加分隔符 `.`（0x2E）：
 * `.` 小于所有数字字母，因此 `"A" < "A.5" < "A5"` —— 正好符合直觉。
 *
 * ## 两条不可动摇的性质（性质测试锁死）
 *
 * 1. **严格有序**：`orderKeyBetween(a, b)` 的结果恒满足 `a < 结果 < b`。
 * 2. **总能插入**：只要 `a < b` 且两者都是本模块生成的键，就一定能再插一个新键，
 *    不需要客户端重新平衡、不需要批量重写兄弟键（见下方"容量"）。
 *
 * ## 🔴 调用前提：两个端点必须是**相邻**兄弟
 *
 * `orderKeyBetween` 是**纯函数**：给定同一对端点永远返回同一个中点。因此
 *
 * - 传入**相邻**（你手上没有落在两者之间的键）→ 结果必然是一个全新键，安全；
 * - 传入**不相邻**的两个键（中间还有别人的键）→ 返回的是该区间的二分中点，
 *   若这个中点正是"上次用同一对端点生成的那个键"，就会**返回一个已存在的键**，
 *   于是同一层出现两个相同 `orderKey`，排序结果不稳定。
 *
 * 这不是可以靠增加判断修掉的缺陷：函数签名只拿到两个端点，无从得知中间还有谁。
 * 正确用法是永远拿**相邻**兄弟做端点 —— `orderKeyAt(items, index)` 就是按这个前提
 * 写的（它取 `ordered[index-1]` 与 `ordered[index]`，天然相邻）。
 * 若确实要在不相邻的两键之间插入，请先取出它们之间那个键作为端点。
 *
 * ## 容量与代价（有意接受，非缺陷）
 *
 * - 整数部分按 base62 定宽 27 字符推进，可容纳约 62^26 次追加。
 * - 两个**相邻**整数之间没有整数可用，改走小数部分二分：每次二分键长约 +1 字符。
 *   真实场景（同一父节点下几百到几千个兄弟）键长稳定在 27–35 字符。
 * - 同一个缝隙里连续嵌套插入约 480 次才会触及 `MAX_KEY_LENGTH`；
 *   `spreadOrderKeys` 会把批量导入的键按 65536 间隔铺开，避免一上来就贴在一起。
 *
 * ## 为什么小数部分末位不能是 `"0"`
 *
 * 这是保证"总能插入"的必要条件。反例：`"A"` 与 `"A.0"` 之间**不存在**任何合法键
 * （任何键要么是 `"A"` 本身、要么以 `"A."` 开头且小数部分必须以 ≥ `"0"` 的字符打头）。
 * `isValidOrderKey` 因此拒绝小数末位为 `"0"` 的键，本模块也绝不生成这种键。
 */

// ---------------------------------------------------------------------------
// 字符表与常量
// ---------------------------------------------------------------------------

/**
 * 排序字符表。
 *
 * 🔴 必须与 ASCII 字节序完全一致，否则 `Array.prototype.sort` 与 SQLite 的
 * `ORDER BY order_key` 会得出不同顺序。故只用 `0-9A-Za-z`（0x30–0x7A），
 * 不含 `-`、`_` 等会让 JS 与 SQLite 分歧的字符。
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length // 62
const ZERO = '0'
const ONE = '1'
const MAX_DIGIT = 'z' // DIGITS[BASE - 1]
const DOT = '.'

/** 生成的整数部分定宽：1 个量级标记 `A` + 26 位 base62 数字。 */
const INTEGER_LENGTH = 27

/** 空列表时使用的第一个键。 */
const SMALLEST_INTEGER = `A${ZERO.repeat(INTEGER_LENGTH - 1)}`

/** 键长上限；超出即视为非法输入。 */
const MAX_KEY_LENGTH = 512

/** `spreadOrderKeys` 的间隔：65536，足够后续在任意两键之间二分 16 层。 */
const SPREAD_STEP = 0x10000

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一个排序键。类型别名而非 brand，方便契约层直接当 `string` 用。 */
export type OrderKey = string

/** `orderKeyBetween(before, after)` 里允许的端点：`null` 表示"无（开头/结尾）"。 */
export type OrderKeyBound = OrderKey | null

/** 含排序键的最小结构（`Document` / `SettingsEntity` 都满足）。 */
export interface Orderable {
  readonly orderKey: OrderKey
}

// ---------------------------------------------------------------------------
// 主 API
// ---------------------------------------------------------------------------

/**
 * 在 `before` 与 `after` 之间生成一个新排序键。
 *
 * @param before 前一个兄弟的键；`null` 表示插到**最前**。
 * @param after  后一个兄弟的键；`null` 表示插到**最后**。
 * @throws RangeError 端点不是合法键，或 `before >= after`（顺序颠倒）。
 *
 * 🔴 **确定性契约**（`10-开发规范与环境.md` 要求"排序键可复现"）：
 *    本函数是 `(before, after)` 的**纯函数**——同一对边界永远返回同一个键。
 *    推论 1：它的返回值**可能已经在列表里**（同一缝隙取两次中点；或对"相距很远的
 *    两个键"取中点，其值恰好被更紧的一对边界算出过）。调用方必须用**当前相邻**的
 *    两个键作边界（拖动排序、`placement: { mode: 'after', afterId }` 天然满足），
 *    否则会写出重复 `orderKey`，排序退化为不稳定。
 *    推论 2：插入到**末尾/开头**请用 {@link orderKeyAfter} / {@link orderKeyBefore}，
 *    它们拿当前最后一个键当单侧边界，同样永不重复。
 *    推论 3：`before === after` 属于调用方错误（相邻缝隙才是合法边界），直接抛错，
 *    绝不静默返回一个重复键。
 *
 * @example
 * orderKeyBetween(null, null)   // 空列表 → 中间值
 * orderKeyBetween(last, null)   // 追加到结尾
 * orderKeyBetween(null, first)  // 插到开头
 * orderKeyBetween(a, b)         // 中间插入
 */
export function orderKeyBetween(
  before: OrderKeyBound = null,
  after: OrderKeyBound = null,
): OrderKey {
  const lower = normalizeBound(before, 'before')
  const upper = normalizeBound(after, 'after')
  if (lower !== null && upper !== null && lower >= upper) {
    throw new RangeError(
      `orderKeyBetween 要求 before 严格小于 after，收到 before=${JSON.stringify(lower)} after=${JSON.stringify(upper)}`,
    )
  }

  if (lower === null) return upper === null ? SMALLEST_INTEGER : generateBefore(upper)
  if (upper === null) return generateAfter(lower)

  const lowerInt = integerPart(lower)
  const upperInt = integerPart(upper)

  if (lowerInt === upperInt) {
    // 同一整数部分 → 在小数部分继续二分。
    return lowerInt + DOT + midpointFraction(fractionOrNull(lower), fractionOrNull(upper))
  }

  // 整数部分已有间隔，优先返回短的纯整数键（大间隔时）。
  const bridged = midpointInteger(lowerInt, upperInt)
  if (bridged !== null) return bridged

  // 整数部分贴在一起：在下界右侧追加一个比它更大的小数。
  // 因为 lowerInt < upperInt，追加小数后仍严格小于 upper（首个不同字符处已定胜负）。
  return lowerInt + DOT + midpointFraction(fractionOrNull(lower), null)
}

/** 追加到 `last` 之后（`last = null` 表示空列表）。 */
export function orderKeyAfter(last: OrderKeyBound = null): OrderKey {
  return orderKeyBetween(last, null)
}

/** 插到 `first` 之前（`first = null` 表示空列表）。 */
export function orderKeyBefore(first: OrderKeyBound = null): OrderKey {
  return orderKeyBetween(null, first)
}

/**
 * 键是否合法。
 *
 * 规则：非空、长度 ≤ 512、整数部分非空且全为 `0-9A-Za-z`、
 * 小数部分（若有）非空、全为 `0-9A-Za-z` 且**末位不为 `"0"`**。
 */
export function isValidOrderKey(value: unknown): value is OrderKey {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) return false

  const dot = value.indexOf(DOT)
  const int = dot === -1 ? value : value.slice(0, dot)
  if (int.length === 0 || !isAlnum(int)) return false
  if (dot === -1) return true

  const frac = value.slice(dot + 1)
  if (frac.length === 0 || !isAlnum(frac)) return false
  // 🔴 末位不得为 '0'：否则 "A" 与 "A.0" 之间将不存在任何可插入的键。
  return frac[frac.length - 1] !== ZERO
}

/**
 * 稳定比较两个键（ASCII 字节序）。
 *
 * 🔴 返回负数/0/正数，可**直接喂给 `Array.prototype.sort`**。
 */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 按 `orderKey` 升序排序。**不修改入参**，返回新数组。
 *
 * `orderKey` 非法时抛错而不是静默排到某个位置——排序错乱会直接表现为
 * 用户章节顺序错乱，属于必须立刻暴露的数据问题。
 */
export function sortByOrderKey<T extends Orderable>(items: readonly T[]): T[] {
  for (const item of items) {
    if (!isValidOrderKey(item.orderKey)) {
      throw new TypeError(`sortByOrderKey 遇到非法 orderKey：${JSON.stringify(item.orderKey)}`)
    }
  }
  return [...items].sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey))
}

/**
 * 第 `index` 个兄弟的位置上应该用的键（用于"插入到中间"或树视图默认落点）。
 *
 * 🔴 `index` 会先夹到 `[0, items.length]`：调用方常把 `index` 直接取自
 * "当前选中项 + 1"或拖放落点，越界时若不夹紧，`items[index - 1]` 与 `items[index]`
 * **同时**为 `undefined`，本函数会退化成"空列表首键"，于是"插到末尾"变成
 * "插到最前面"——章节顺序直接反了。
 */
export function orderKeyAt<T extends Orderable>(items: readonly T[], index: number): OrderKey {
  const ordered = sortByOrderKey(items)
  const clamped = Number.isFinite(index)
    ? Math.min(Math.max(Math.trunc(index), 0), ordered.length)
    : 0
  const before = ordered[clamped - 1]?.orderKey ?? null
  const after = ordered[clamped]?.orderKey ?? null
  return orderKeyBetween(before, after)
}

/**
 * 重新分配 `count` 个等距键（用于导入、修复、批量重排）。
 *
 * 🔴 这是**唯一的**批量写键入口；日常插入一律走 `orderKeyBetween`，
 * 免得每次插入都重写整层兄弟节点的键（那会让并发拖动重新互相打架）。
 */
export function spreadOrderKeys(count: number): OrderKey[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`spreadOrderKeys 的 count 必须是非负安全整数，收到 ${count}`)
  }
  if (count === 0) return []

  const keys: OrderKey[] = []
  for (let i = 0; i < count; i += 1) {
    keys.push(`A${encodeBase62((i + 1) * SPREAD_STEP, INTEGER_LENGTH - 1)}`)
  }

  for (let i = 1; i < keys.length; i += 1) {
    const prev = keys[i - 1] as string
    const current = keys[i] as string
    if (prev >= current) {
      throw new Error(`spreadOrderKeys 内部错误：第 ${i} 个键未严格递增（${prev} >= ${current}）`)
    }
  }
  return keys
}

// ---------------------------------------------------------------------------
// 生成核心
// ---------------------------------------------------------------------------

/** 插到 `upper` 之前。 */
function generateBefore(upper: string): OrderKey {
  const int = integerPart(upper)
  if (fraction(upper) !== null) {
    // `upper = int + "." + frac`，整数部分本身就是"前缀"，必然更小。
    return int
  }
  const decremented = decrementInteger(int)
  if (decremented !== null) return decremented
  // 整数部分是 `0…0`（理论上需要 62^27 次前插才会走到）：退化成更短的键。
  if (int.length > 1) return int.slice(0, -1)
  throw new RangeError(
    `orderKey 空间已耗尽：无法在 ${JSON.stringify(int)} 之前生成新键（需要重新铺开兄弟键）`,
  )
}

/** 追加到 `lower` 之后。 */
function generateAfter(lower: string): OrderKey {
  // 在下界整数部分的基础上 +1（进位成更长字符串仍然 > 下界），键短且间隔充足。
  return incrementInteger(integerPart(lower))
}

/**
 * 两个**等宽**整数部分的数值中点；不等宽、或两者相邻时返回 `null`
 * （调用方改走小数部分二分）。
 */
function midpointInteger(a: string, b: string): string | null {
  if (a.length !== b.length) return null
  const half = bigDiv2(bigAdd(a, b))
  if (half === a || half === b) return null
  if (half.length !== a.length) return null
  return half
}

// ---------------------------------------------------------------------------
// 小数部分二分
// ---------------------------------------------------------------------------

/**
 * 在 `lower` 与 `upper` 之间的小数部分中点。
 *
 * 语义：把结果当作 `0.<result>` 的 base62 小数，`null` 分别表示下界 `0` 与上界 `1`。
 * 返回值保证：非空、全为 `0-9A-Za-z`、末位不为 `"0"`、且 `lower < 结果 < upper`。
 */
function midpointFraction(lower: string | null, upper: string | null): string {
  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error(
      `midpointFraction 内部错误：下界必须严格小于上界（${JSON.stringify(lower)} >= ${JSON.stringify(upper)}）`,
    )
  }
  if (lower === null) return upper === null ? 'V' : belowFraction(upper)
  if (upper === null) return aboveFraction(lower)

  // 剥掉公共前缀：前缀对"谁在中间"没有影响。
  let i = 0
  while (i < lower.length && i < upper.length && lower[i] === upper[i]) i += 1
  const prefix = lower.slice(0, i)
  const a = lower.slice(i)
  const b = upper.slice(i)

  // `lower` 是 `upper` 的前缀 → 在 0 与剩余部分之间取。
  if (a.length === 0) return prefix + belowFraction(b)

  const v = digitValue(a[0] as string)
  const w = digitValue(b[0] as string)
  if (w - v >= 2) {
    // 首位之间有余量：直接取中点数字，结果最短。
    return prefix + (DIGITS[Math.floor((v + w) / 2)] as string)
  }
  // 首位只差 1：结果必须沿用下界首位才可能小于上界。
  return prefix + (a[0] as string) + aboveFraction(a.slice(1))
}

/** 返回 `d`，满足 `0 < d < b`（字符串序）。`b` 非空且不以 `"0"` 结尾。 */
function belowFraction(b: string): string {
  if (b.length === 0) {
    throw new RangeError('orderKey 空间已耗尽：该缝隙中不存在可插入的键（上界形如 "0" 结尾的小数）')
  }
  const first = digitValue(b[0] as string)
  if (first === 0) return ZERO + belowFraction(b.slice(1))
  if (first === 1) return `0z`
  return DIGITS[Math.floor(first / 2)] as string
}

/** 返回 `d`，满足 `d > t`（字符串序）。`t` 可以是空串。 */
function aboveFraction(t: string): string {
  if (t.length === 0) return ONE
  const first = digitValue(t[0] as string)
  if (first < BASE - 1) return DIGITS[first + 1] as string
  return MAX_DIGIT + aboveFraction(t.slice(1))
}

// ---------------------------------------------------------------------------
// 整数部分（base62 大数，字符串实现）
// ---------------------------------------------------------------------------

/** 去掉小数部分后的整数段。 */
function integerPart(key: string): string {
  const dot = key.indexOf(DOT)
  return dot === -1 ? key : key.slice(0, dot)
}

/** 小数段（不含小数点）；没有小数部分时返回 `null`。 */
function fraction(key: string): string | null {
  const dot = key.indexOf(DOT)
  return dot === -1 ? null : key.slice(dot + 1)
}

function fractionOrNull(key: string): string | null {
  return fraction(key)
}

/**
 * base62 大数 `+1`。
 *
 * 🔴 进位溢出时**在末尾补 `"0"`**，绝不可以在前面补 `"1"`：`"1"` < `"z"`，
 * `"zzz"` 加前缀会得到 `"1000"`，而 `"1000" < "zzz"` —— 那会让
 * `orderKeyAfter` 返回一个排在入参**前面**的键，直接把章节顺序搞乱。
 * 变长一位（原串成为新串的前缀）必然更大，这才是溢出时唯一安全的做法。
 */
function incrementInteger(int: string): string {
  const chars = int.split('')
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const next = digitValue(chars[i] as string) + 1
    if (next < BASE) {
      chars[i] = DIGITS[next] as string
      return chars.join('')
    }
    chars[i] = ZERO
  }
  // 全 `z`：该宽度下没有更大的等长整数，只能在末尾延伸一位。
  return int + ZERO
}

/** base62 大数 `-1`；全 `0` 时下溢返回 `null`。 */
function decrementInteger(int: string): string | null {
  const chars = int.split('')
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const next = digitValue(chars[i] as string) - 1
    if (next >= 0) {
      chars[i] = DIGITS[next] as string
      return chars.join('')
    }
    chars[i] = MAX_DIGIT
  }
  return null
}

/** 等长 base62 大数相加（结果可能多一位）。 */
function bigAdd(a: string, b: string): string {
  const length = Math.max(a.length, b.length)
  const left = a.padStart(length, ZERO)
  const right = b.padStart(length, ZERO)
  const out: string[] = new Array<string>(length)
  let carry = 0
  for (let i = length - 1; i >= 0; i -= 1) {
    const sum = digitValue(left[i] as string) + digitValue(right[i] as string) + carry
    carry = sum >= BASE ? 1 : 0
    out[i] = DIGITS[sum % BASE] as string
  }
  return carry > 0 ? ONE + out.join('') : out.join('')
}

/** base62 大数整除 2（丢余数）。 */
function bigDiv2(value: string): string {
  const out: string[] = []
  let remainder = 0
  for (let i = 0; i < value.length; i += 1) {
    const current = remainder * BASE + digitValue(value[i] as string)
    const quotient = Math.floor(current / 2)
    remainder = current % 2
    const ch = DIGITS[quotient] as string
    if (out.length > 0 || ch !== ZERO) out.push(ch)
  }
  return out.length === 0 ? ZERO : out.join('')
}

/** 定宽 base62 编码（高位补 `"0"`）。 */
function encodeBase62(value: number, width: number): string {
  const out: string[] = new Array<string>(width)
  let rest = value
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = DIGITS[rest % BASE] as string
    rest = Math.floor(rest / BASE)
  }
  if (rest !== 0) {
    throw new RangeError(`encodeBase62 溢出：${value} 无法用 ${width} 位 base62 表示`)
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// 字符工具
// ---------------------------------------------------------------------------

function digitValue(ch: string): number {
  const value = DIGITS.indexOf(ch)
  if (value === -1) throw new RangeError(`orderKey 含非法字符：${JSON.stringify(ch)}`)
  return value
}

function isAlnum(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (DIGITS.indexOf(value[i] as string) === -1) return false
  }
  return true
}

function normalizeBound(value: OrderKeyBound, label: string): string | null {
  if (value === null || value === undefined) return null
  if (!isValidOrderKey(value)) {
    throw new RangeError(
      `orderKeyBetween 的 ${label} 不是合法排序键：${JSON.stringify(value)}` +
        `（要求非空、长度 <= ${MAX_KEY_LENGTH}、整数/小数部分仅含 0-9A-Za-z、小数末位不为 "0"）`,
    )
  }
  return value
}
