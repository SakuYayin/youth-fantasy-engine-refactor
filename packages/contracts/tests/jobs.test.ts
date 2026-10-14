/**
 * jobs 契约测试。
 *
 * 任务状态机是**持久化的**：一次非法迁移会留下永远无法终结的任务，
 * 所以这里穷举迁移表而不是抽查几个例子。重试与预算的边界同样测到，
 * 因为"身份失败却一直重试"的后果是反复失败并反复计费。
 */

import { describe, expect, it } from 'vitest'

import {
  JOB_TRANSITIONS,
  backoffDelayMs,
  canTransitionJob,
  checkJobTransition,
  isBudgetExceeded,
  isRetryableFailure,
} from '../src/jobs/index.js'
import type { JobBudget, JobFailureKind } from '../src/jobs/index.js'
import { TERMINAL_JOB_STATUSES, isTerminalJobStatus } from '../src/entities/index.js'
import type { JobStatus } from '../src/entities/index.js'

const ALL_STATUSES = Object.keys(JOB_TRANSITIONS) as JobStatus[]

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

describe('JOB_TRANSITIONS', () => {
  it('覆盖全部 9 个状态', () => {
    expect(ALL_STATUSES.sort()).toEqual(
      [
        'cancelled',
        'cancelling',
        'failed',
        'paused',
        'queued',
        'running',
        'succeeded',
        'waiting_confirmation',
        'waiting_network',
      ].sort(),
    )
  })

  it('终态没有任何出边', () => {
    for (const terminal of TERMINAL_JOB_STATUSES) {
      expect(JOB_TRANSITIONS[terminal]).toEqual([])
    }
  })

  it('非终态至少有一条出边（否则任务会永久卡住）', () => {
    for (const status of ALL_STATUSES) {
      if (isTerminalJobStatus(status)) continue
      expect(JOB_TRANSITIONS[status].length).toBeGreaterThan(0)
    }
  })

  it('迁移目标都是合法状态（防止拼写错误形成黑洞）', () => {
    for (const from of ALL_STATUSES) {
      for (const to of JOB_TRANSITIONS[from]) {
        expect(ALL_STATUSES).toContain(to)
      }
    }
  })

  it('没有自环（同状态到同状态不是迁移，不该刷事件）', () => {
    for (const from of ALL_STATUSES) {
      expect(JOB_TRANSITIONS[from]).not.toContain(from)
    }
  })

  it('对象被冻结，运行时不可篡改', () => {
    expect(Object.isFrozen(JOB_TRANSITIONS)).toBe(true)
  })
})

describe('canTransitionJob', () => {
  it('主线：queued → running → succeeded', () => {
    expect(canTransitionJob('queued', 'running')).toBe(true)
    expect(canTransitionJob('running', 'succeeded')).toBe(true)
  })

  it('终态不能再去任何地方（已成功的任务不能被重新跑起来）', () => {
    for (const terminal of TERMINAL_JOB_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransitionJob(terminal, to)).toBe(false)
      }
    }
  })

  it('不能从 queued 直接跳到终态 succeeded（必须经过 running）', () => {
    expect(canTransitionJob('queued', 'succeeded')).toBe(false)
  })

  it('等待态只能回到 running 或走向取消/失败', () => {
    for (const waiting of ['waiting_network', 'waiting_confirmation'] as const) {
      expect(canTransitionJob(waiting, 'running')).toBe(true)
      expect(canTransitionJob(waiting, 'cancelling')).toBe(true)
      expect(canTransitionJob(waiting, 'failed')).toBe(true)
      expect(canTransitionJob(waiting, 'succeeded')).toBe(false)
    }
  })

  it('等待态之间不互相跳转（语义不同，必须经 running 中转）', () => {
    expect(canTransitionJob('waiting_network', 'waiting_confirmation')).toBe(false)
    expect(canTransitionJob('waiting_confirmation', 'waiting_network')).toBe(false)
  })

  it('cancelling 只能走向 cancelled 或 failed（等执行器确认）', () => {
    expect(canTransitionJob('cancelling', 'cancelled')).toBe(true)
    expect(canTransitionJob('cancelling', 'failed')).toBe(true)
    expect(canTransitionJob('cancelling', 'succeeded')).toBe(false)
    expect(canTransitionJob('cancelling', 'running')).toBe(false)
  })

  it('paused 可以重新入队或直接恢复', () => {
    expect(canTransitionJob('paused', 'queued')).toBe(true)
    expect(canTransitionJob('paused', 'running')).toBe(true)
    expect(canTransitionJob('paused', 'succeeded')).toBe(false)
  })

  it('🔴 任何状态都能走向 cancelling 或 failed（用户取消与崩溃必须可达）', () => {
    for (const status of ALL_STATUSES) {
      if (isTerminalJobStatus(status)) continue
      const edges = JOB_TRANSITIONS[status]
      expect(edges.includes('cancelling') || edges.includes('failed')).toBe(true)
    }
  })
})

describe('checkJobTransition', () => {
  it('返回结构化结果，携带原 from/to 便于日志', () => {
    expect(checkJobTransition('queued', 'running')).toEqual({ ok: true, from: 'queued', to: 'running' })
  })

  it('非法迁移返回 ok:false 而不是抛异常（业务分支不用异常表达）', () => {
    expect(checkJobTransition('succeeded', 'running')).toEqual({ ok: false, from: 'succeeded', to: 'running' })
  })

  it('与 canTransitionJob 判定完全一致（穷举全部组合）', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(checkJobTransition(from, to).ok).toBe(canTransitionJob(from, to))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 失败分类与重试
// ---------------------------------------------------------------------------

describe('isRetryableFailure', () => {
  it('瞬态与网络故障可重试', () => {
    expect(isRetryableFailure('transient')).toBe(true)
    expect(isRetryableFailure('network')).toBe(true)
  })

  it('🔴 身份失败不重试（否则就是暴力破解自己的账号）', () => {
    expect(isRetryableFailure('auth')).toBe(false)
  })

  it('🔴 Schema 不支持不重试（同一输入重试只会同样失败）', () => {
    expect(isRetryableFailure('schema')).toBe(false)
  })

  it('🔴 预算不足不重试（重试会继续烧钱）', () => {
    expect(isRetryableFailure('budget')).toBe(false)
  })

  it('用户取消与内部错误不自动重试', () => {
    expect(isRetryableFailure('cancelled')).toBe(false)
    expect(isRetryableFailure('internal')).toBe(false)
  })

  it('分类完备：每个 kind 都有明确判定', () => {
    const kinds: JobFailureKind[] = ['transient', 'network', 'auth', 'schema', 'budget', 'cancelled', 'internal']
    for (const kind of kinds) {
      expect(typeof isRetryableFailure(kind)).toBe('boolean')
    }
    expect(kinds.filter(isRetryableFailure)).toEqual(['transient', 'network'])
  })
})

// ---------------------------------------------------------------------------
// 退避
// ---------------------------------------------------------------------------

describe('backoffDelayMs', () => {
  it('随尝试次数指数增长', () => {
    const d1 = backoffDelayMs(1, 1000, 60_000)
    const d2 = backoffDelayMs(2, 1000, 60_000)
    const d3 = backoffDelayMs(3, 1000, 60_000)
    expect(d2).toBeGreaterThan(d1)
    expect(d3).toBeGreaterThan(d2)
  })

  it('永不超出上限（避免无限等待后的天量延迟）', () => {
    for (const attempt of [1, 5, 20, 100, 1000]) {
      expect(backoffDelayMs(attempt, 1000, 60_000)).toBeLessThanOrEqual(60_000)
    }
  })

  it('迟滞到上限后保持恒定', () => {
    const atCap = backoffDelayMs(50, 1000, 60_000)
    expect(backoffDelayMs(51, 1000, 60_000)).toBe(atCap)
    expect(backoffDelayMs(500, 1000, 60_000)).toBe(atCap)
  })

  it('返回非负整数毫秒', () => {
    for (const attempt of [1, 2, 3, 7]) {
      const d = backoffDelayMs(attempt)
      expect(Number.isInteger(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(0)
    }
  })

  it('非法 attempt 被夹到 1（0 或负数不该产生 0 延迟的忙等）', () => {
    expect(backoffDelayMs(0)).toBe(backoffDelayMs(1))
    expect(backoffDelayMs(-5)).toBe(backoffDelayMs(1))
    expect(backoffDelayMs(1.9)).toBe(backoffDelayMs(1))
  })

  it('抖动是确定性下调，不引入随机（随机由调用方注入以保测试可复现）', () => {
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(backoffDelayMs(1, 1000, 60_000))
    // 当前实现为 index * 0.8：第一次尝试 = 1000 * 0.8
    expect(backoffDelayMs(1, 1000, 60_000)).toBe(800)
    expect(backoffDelayMs(2, 1000, 60_000)).toBe(1600)
  })

  it('首次退避不能是 0（0 延迟会让失败任务瞬间打满重试次数）', () => {
    expect(backoffDelayMs(1)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

const budget = (over: Partial<JobBudget> = {}): JobBudget => ({
  maxTokens: null,
  maxCostMicros: null,
  maxWallClockMs: null,
  ...over,
})
const usage = (over: Partial<{ tokens: number; costMicros: number; elapsedMs: number }> = {}) => ({
  tokens: 0,
  costMicros: 0,
  elapsedMs: 0,
  ...over,
})

describe('isBudgetExceeded', () => {
  it('全部为 null 时不设限，永不超预算', () => {
    expect(isBudgetExceeded(budget(), usage({ tokens: 10 ** 9, costMicros: 10 ** 9, elapsedMs: 10 ** 9 }))).toBe(false)
  })

  it('token 超限即判定', () => {
    expect(isBudgetExceeded(budget({ maxTokens: 100 }), usage({ tokens: 101 }))).toBe(true)
  })

  it('恰好等于上限不算超（边界是 >，不是 >=）', () => {
    expect(isBudgetExceeded(budget({ maxTokens: 100 }), usage({ tokens: 100 }))).toBe(false)
    expect(isBudgetExceeded(budget({ maxCostMicros: 500 }), usage({ costMicros: 500 }))).toBe(false)
    expect(isBudgetExceeded(budget({ maxWallClockMs: 1000 }), usage({ elapsedMs: 1000 }))).toBe(false)
  })

  it('费用超限即判定（只有 token 上限时反复重试仍能烧满费用）', () => {
    expect(isBudgetExceeded(budget({ maxCostMicros: 500 }), usage({ costMicros: 501 }))).toBe(true)
  })

  it('墙钟超限即判定', () => {
    expect(isBudgetExceeded(budget({ maxWallClockMs: 1000 }), usage({ elapsedMs: 1001 }))).toBe(true)
  })

  it('任一项超限即整体超限（三项是 AND 关系下的上限集合）', () => {
    const b = budget({ maxTokens: 1_000_000, maxCostMicros: 1_000_000, maxWallClockMs: 1_000_000 })
    expect(isBudgetExceeded(b, usage({ tokens: 10 }))).toBe(false)
    expect(isBudgetExceeded(b, usage({ costMicros: 2_000_000 }))).toBe(true)
    expect(isBudgetExceeded(b, usage({ elapsedMs: 2_000_000 }))).toBe(true)
  })
})
