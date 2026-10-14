/**
 * 任务契约。
 *
 * 设计约束（`08-任务与AI.md`）：
 * - 状态机：`queued → running → succeeded|failed|cancelled`；
 *   `waiting_network` / `waiting_confirmation` / `paused` 是**持久等待态**。
 * - 领取任务用数据库事务设置租约，心跳续期；租约失效后**先查输出与外部
 *   请求是否可查询**再决定恢复，不盲目重跑（会导致重复计费）。
 * - 所有可重试副作用必须带幂等键。模型服务不支持幂等时，
 *   不能对外宣称 exactly-once。
 * - 调度的默认限制：两个交互式 AI 请求；CPU 池初始
 *   `min(4, max(1, 可用核心数 - 1))`；长计算不在写连接里做。
 */

import type { JobId, RequestId, Revision, UtcTimestamp, WorkspaceId } from '../ids.js'
import type { JobStatus } from '../entities/index.js'

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 合法状态迁移表。
 *
 * 🔴 写成显式表而不是散落的 `if`：任务状态是持久化的，一次非法迁移
 * 会在重启后留下一个永远无法终结的任务。表驱动让"这个迁移合法吗"
 * 变成一次查表，可被测试穷举。
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ['running', 'cancelling', 'paused', 'failed'],
  running: [
    'succeeded',
    'failed',
    'cancelling',
    'waiting_network',
    'waiting_confirmation',
    'paused',
  ],
  waiting_network: ['running', 'cancelling', 'failed', 'paused'],
  waiting_confirmation: ['running', 'cancelling', 'failed', 'paused'],
  paused: ['queued', 'running', 'cancelling', 'failed'],
  // cancelling 只能走向终态：执行器确认（cancelled）或执行失败（failed）。
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
})

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to)
}

/** 判断迁移是否合法，非法时抛出可直接穿边界的结构化错误。 */
export interface TransitionResult {
  readonly ok: boolean
  readonly from: JobStatus
  readonly to: JobStatus
}

export function checkJobTransition(from: JobStatus, to: JobStatus): TransitionResult {
  return { ok: canTransitionJob(from, to), from, to }
}

// ---------------------------------------------------------------------------
// 租约
// ---------------------------------------------------------------------------

/**
 * 执行租约。
 *
 * 领取与续期都在**数据库事务**内完成：用 `UPDATE ... WHERE status='queued'`
 * 的受影响行数判断是否抢到，而不是"先查再改"——后者在并发下会双领。
 */
export interface JobLease {
  readonly jobId: JobId
  readonly executor: string
  /** 租约令牌：续期与回执必须带上，防止租约过期后的"幽灵执行器"回写。 */
  readonly leaseToken: string
  readonly leasedAt: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly heartbeatIntervalMs: number
}

/** 租约过期的处理决策。 */
export type LeaseExpiryDecision =
  /** 可安全重跑（副作用幂等或未产生外部请求）。 */
  | { readonly kind: 'retry'; readonly attempt: number }
  /** 外部请求可能已成功，必须先查询结果再决定。 */
  | { readonly kind: 'probe'; readonly probeRef: string }
  /** 不可重试（身份失败、预算不足等），直接失败。 */
  | { readonly kind: 'fail'; readonly code: string }

/** 执行器上报的错误分类：决定是否重试。 */
export type JobFailureKind =
  | 'transient'
  | 'network'
  | 'auth'
  | 'schema'
  | 'budget'
  | 'cancelled'
  | 'internal'

/**
 * 重试策略。
 *
 * 🔴 身份失败、Schema 不支持、费用不足**不重试**：循环重试只会
 * 反复失败并可能反复计费（`08-任务与AI.md`）。
 */
export function isRetryableFailure(kind: JobFailureKind): boolean {
  return kind === 'transient' || kind === 'network'
}

/** 指数退避 + 抖动；抖动避免多设备同时重试形成尖峰。 */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const exponential = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1))
  // 抖动取确定性的 ±20%，由调用方注入随机源时再乘随机因子。
  return Math.floor(exponential * 0.8)
}

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

/**
 * 任务预算。
 *
 * 三项都要有上限：只有 token 上限时，一个反复重试的任务仍可能
 * 把费用打满。超预算按 `budget` 类失败终止，不进重试。
 */
export interface JobBudget {
  readonly maxTokens: number | null
  readonly maxCostMicros: number | null
  readonly maxWallClockMs: number | null
}

export interface JobBudgetUsage {
  readonly tokens: number
  readonly costMicros: number
  readonly elapsedMs: number
}

export function isBudgetExceeded(budget: JobBudget, usage: JobBudgetUsage): boolean {
  if (budget.maxTokens !== null && usage.tokens > budget.maxTokens) return true
  if (budget.maxCostMicros !== null && usage.costMicros > budget.maxCostMicros) return true
  if (budget.maxWallClockMs !== null && usage.elapsedMs > budget.maxWallClockMs) return true
  return false
}

// ---------------------------------------------------------------------------
// 输出与检查点
// ---------------------------------------------------------------------------

/**
 * 流式输出检查点。
 *
 * 🔴 **不每 Token 写事务**（`08-任务与AI.md`）：分批持久化，断流后
 * 能从最后一个检查点继续；展示 partial 时**不得标记为成功**。
 */
export interface JobOutputChunk {
  readonly jobId: JobId
  /** 单调递增序号：断流重连后据此请求缺失片段。 */
  readonly sequence: number
  readonly text: string
  readonly createdAt: UtcTimestamp
}

export interface JobCheckpoint {
  readonly jobId: JobId
  readonly sequence: number
  /** 不透明检查点数据，由执行器解释（如已处理的章节 ID 列表）。 */
  readonly state: Readonly<Record<string, unknown>>
  readonly savedAt: UtcTimestamp
}

/**
 * 任务进度事件。
 *
 * 事件只承载**进度通知**，最终结果必须回查持久化的 `jobOutputs`
 * 与任务状态（与同步事件同一原则）。
 */
export interface JobProgressEvent {
  readonly jobId: JobId
  readonly status: JobStatus
  readonly attempt: number
  readonly progress: number
  readonly message: string
  readonly at: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 幂等
// ---------------------------------------------------------------------------

/**
 * 副作用幂等键。
 *
 * 同一 `idempotencyKey` 重复执行必须返回**原结果**。服务端不支持幂等
 * 时（部分模型 API），只能做到"至少一次"，此时必须在结果里标注
 * `exactlyOnce: false`，让上层知道可能需要人工核对。
 */
export interface SideEffectRecord {
  readonly idempotencyKey: string
  readonly jobId: JobId
  readonly attempt: number
  readonly requestId: RequestId
  readonly responseRef: string
  readonly exactlyOnce: boolean
  readonly recordedAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 输入版本固定
// ---------------------------------------------------------------------------

/**
 * 任务输入快照。
 *
 * 任务绑定**不可变输入版本**：切换作品不改变后台任务目标，
 * 任务执行期间正文被改动也不影响本次结果的可解释性。
 */
export interface JobInputPin {
  readonly workspaceId: WorkspaceId
  readonly projectId: string | null
  readonly entityIds: readonly string[]
  /** 每个输入实体的版本，执行前校验：任一变化 → `JOB_INPUT_VERSION_GONE`。 */
  readonly revisions: Readonly<Record<string, Revision>>
}
