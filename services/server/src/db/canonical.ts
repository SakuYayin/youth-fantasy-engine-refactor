/**
 * 规范化 JSON 与载荷摘要。
 *
 * ## 为什么必须有"规范化"这一步
 *
 * 幂等判定的语义是"同 ID 同载荷 → 返回原回执；同 ID 不同载荷 →
 * `IDEMPOTENCY_KEY_REUSED`"。而"同一个载荷"在 JSON 里有很多种写法：
 *
 * ```json
 * {"a":1,"b":2}      {"b":2,"a":1}
 * {"a":1,"b":2}      { "a" : 1 , "b" : 2 }
 * ```
 *
 * 如果直接对**原始字节**求摘要，客户端换一个序列化器（或只是键顺序不同）
 * 重试同一批操作，就会被判成"载荷不同"而拿到 `IDEMPOTENCY_KEY_REUSED`——
 * 这是最坏的一类假冲突：用户的写作内容没变，却被告知"幂等键被复用了"，
 * 只能整批重建，而重建过程可能覆盖别人的编辑。
 *
 * 所以摘要取的是**规范化后的结构**：对象键按 UTF-16 码元升序排列、数组保持
 * 顺序（操作顺序是语义的一部分）、`undefined` 的属性视同不存在。
 * 这也和 `07-同步协议与API.md`"服务端先比对 batchId/opId 与**规范化**载荷摘要"
 * 的措辞一致。
 *
 * ## 为什么不直接复用桌面端的实现
 *
 * 桌面端在 `packages/persistence-sqlite`，服务端不能依赖它的内部私有模块
 * （`packages/**` 对本次任务只读，且跨包的摘要算法一旦漂移，两端会算不出同一个
 * 摘要）。这里用 `node:crypto` 自算，输出带 `sha256:` 前缀——前缀是**算法标识**，
 * 将来换算法时旧回执不会被误判成"同载荷"。
 */

import { createHash } from 'node:crypto'

/**
 * 递归规范化：对象键排序、`undefined` 属性丢弃、数组保持顺序。
 *
 * 非有限数字（`NaN` / `Infinity`）折成 `null`：JSON 里本来就没有它们，
 * 真出现只可能来自程序内部，折成 `null` 比让 `JSON.stringify` 抛异常好——
 * 摘要计算**绝不能**成为批处理的失败点。
 */
function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalize(item)))
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = source[key]
      if (item === undefined) {
        continue
      }
      sorted[key] = normalize(item)
    }
    return sorted
  }
  // 函数/符号/BigInt 不可能来自 JSON.parse；真出现也只是摘要里的 null，不抛。
  return null
}

/** 规范化 JSON 文本。同结构必然得到同文本，与键顺序、空白无关。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

/** 载荷摘要，形如 `sha256:<64 位十六进制>`。 */
export function digestOf(value: unknown): string {
  const hash = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
  return `sha256:${hash}`
}

/** 规范化 JSON 的 UTF-8 字节数。用于"批次最大字节数"的判定（与客户端同一把尺子）。 */
export function canonicalByteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}
