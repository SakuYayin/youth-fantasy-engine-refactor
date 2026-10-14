/**
 * 极简固定窗口限流。
 *
 * 设计依据（`04-后端与安全.md`）："登录、配对、上传、任务与模型调用**分别限流**"；
 * `auth/pairing.ts:287` 的注释把全局性限流明确推给 HTTP 层（"全局限流由 HTTP 层负责"），
 * 所以它落在本层职责内。
 *
 * ## 为什么不是令牌桶 / 滑动窗口
 *
 * 这里的目的是**抗在线暴力猜解**（猜密码、猜配对码、猜引导凭据），
 * 对象是"同一个来源在短时间内的失败次数"。固定窗口的缺点（窗口边界双倍突发）
 * 对这类攻击没有实际收益：攻击者面对的是"每 15 分钟 5 次"的硬上限，
 * 边界突发最多让它多试几次，而成本是他必须持续打真实请求、留真实审计。
 * 换成令牌桶只会让实现更难验证，且需要额外的内存清理逻辑。
 *
 * ## 为什么按 `bucket + key` 双键而不是单键
 *
 * "登录失败 5 次"和"setup 失败 5 次"必须是两个独立的计数器：合并之后
 * 攻击者可以用 login 的失败次数去消耗 setup 的预算（或反之），把限流变成
 * 拒绝服务工具。`bucket` 由调用方给出（`'login'` / `'setup'` / `'pairing'`）。
 *
 * ## 时钟与容量
 *
 * 时钟可注入（测试里不 sleep）。条目数量有上限，超过后按最早过期的条目淘汰，
 * 防止"攻击者用海量伪造 IP 把 Map 撑爆"这一条内存 DoS。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'

import { withStatusHint } from './errors.js'

export interface RateLimitPolicy {
  readonly windowMs: number
  readonly maxAttempts: number
}

export interface RateLimitVerdict {
  readonly allowed: boolean
  readonly remaining: number
  /** 距离本窗口结束还有多久（毫秒）。用于 `Retry-After`。 */
  readonly retryAfterMs: number
}

export interface RateLimiter {
  /** 记一次尝试并返回判定。**先记后判**：达到上限的那一次也会被计数。 */
  hit(key: string): RateLimitVerdict
  /** 只看不记（例如渲染表单前提示剩余次数）。 */
  peek(key: string): RateLimitVerdict
  /** 成功后清零（例如登录成功就不该继续背着失败计数）。 */
  reset(key: string): void
  /** 当前受追踪的键数量（运维/测试用）。 */
  size(): number
}

/** 单例限流器的最大键数量。超出后淘汰最旧窗口。 */
export const MAX_RATE_LIMIT_ENTRIES = 4096

interface WindowEntry {
  count: number
  windowStart: number
}

export function createRateLimiter(
  policy: RateLimitPolicy,
  now: () => number = Date.now,
  maxEntries: number = MAX_RATE_LIMIT_ENTRIES,
): RateLimiter {
  if (!Number.isFinite(policy.windowMs) || policy.windowMs <= 0) {
    throw new TypeError('限流窗口必须是正数毫秒')
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new TypeError('限流上限必须是正整数')
  }
  const entries = new Map<string, WindowEntry>()

  const verdictOf = (entry: WindowEntry | undefined, at: number): RateLimitVerdict => {
    if (entry === undefined) {
      return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 }
    }
    const elapsed = at - entry.windowStart
    if (elapsed >= policy.windowMs) {
      return { allowed: true, remaining: policy.maxAttempts, retryAfterMs: 0 }
    }
    const remaining = Math.max(0, policy.maxAttempts - entry.count)
    // 🔴 边界语义：`maxAttempts` 是"窗口内**允许**的尝试次数"。
    // 第 `maxAttempts` 次仍然放行（第 20 次登录失败本身不该被拒），
    // 第 `maxAttempts + 1` 次才拒绝。写成 `remaining > 0` 会让上限悄悄少一次，
    // 而"少一次"在运维眼里就是"配置写了 20 却只让试 19 次"。
    return { allowed: entry.count <= policy.maxAttempts, remaining, retryAfterMs: policy.windowMs - elapsed }
  }

  const evictIfNeeded = (): void => {
    if (entries.size <= maxEntries) return
    // Map 保持插入顺序，最早插入的键最可能已经过期。
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
  }

  return {
    hit(key: string): RateLimitVerdict {
      const at = now()
      const existing = entries.get(key)
      const elapsed = existing === undefined ? Number.POSITIVE_INFINITY : at - existing.windowStart
      const entry: WindowEntry =
        existing === undefined || elapsed >= policy.windowMs
          ? { count: 1, windowStart: at }
          : { count: existing.count + 1, windowStart: existing.windowStart }
      entries.delete(key) // 重新插入以刷新"最近使用"顺序
      entries.set(key, entry)
      evictIfNeeded()
      return verdictOf(entry, at)
    },
    peek(key: string): RateLimitVerdict {
      return verdictOf(entries.get(key), now())
    },
    reset(key: string): void {
      entries.delete(key)
    },
    size(): number {
      return entries.size
    },
  }
}

/**
 * 把"超限"翻译成契约错误。
 *
 * 🔴 契约里**没有**限流专用码。这里用 `RESOURCE_LOCKED`（唯一可重试的 info 码，
 * 语义"资源暂时锁住，稍后再来"）并挂上 429 状态码提示：
 * 客户端按 code 分类会看到"可重试"，按状态码分类会看到 429。
 * 契约一旦新增限流码，只需改这一个函数。
 */
export function rateLimitedError(retryAfterMs: number, requestId: RequestId): ContractError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return withStatusHint(
    new ContractError({
      code: 'RESOURCE_LOCKED',
      message: '操作过于频繁，请稍后再试。',
      requestId,
      detail: { reason: 'rate_limited', retryAfterSeconds },
    }),
    429,
  )
}
