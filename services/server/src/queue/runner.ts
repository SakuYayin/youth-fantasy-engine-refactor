/**
 * 任务运行器（骨架）。
 *
 * 职责边界（**刻意不做的事**）：
 * - **不实现真实执行器**：`executor` 由调用方注入（生产里是 AI 流水线，测试里是假执行器）。
 *   本模块不认识模型、不认识提示词，也不认识任何业务。
 * - **不做重试策略**：失败一律落终态 `failed`；重试发生在"租约过期后被重新领取"
 *   这一条路径上（`attempt` 自增、超过 `max_attempts` 判 `JOB_TIMEOUT`）。
 * - **不吞异常**：执行器抛出的错误会出现在 `RunnerOutcome.failed.error` 里，
 *   并且**必须先落库**为 `failed` 才能返回——否则任务会永久卡在 `running`
 *   且租约到期后被别人重跑一遍（同一任务被跑两次，副作用重复）。
 *
 * 崩溃安全的含义：进程在 `executor()` 中途被 kill，任务仍然是 `running` + 租约，
 * 直到 `lease_expires_at` 过去才会被另一个 worker 重新领取。所以 `leaseMs` 必须
 * 与执行器的真实时长成比例。运行器会在执行器运行期间**自动续租**（间隔
 * `lease.heartbeatIntervalMs` = `leaseMs/3`，下限 1 秒）；执行器也可以自己再调
 * `heartbeatJob`，但这不是必须的。
 *
 * 租约栅栏（fencing）：收尾时 `completeJob`/`failJob` 都会带上 `leaseOwner` + `attempt`；
 * 租约已易主的迟到回报会被 `RESOURCE_LOCKED` 拦下，本次结果作废（`stale`）。
 * 没有这层栅栏，租约过期被重领后原执行者仍能改写终态，同一条任务会被跑两遍。
 */

import { ContractError } from '@yfe/contracts'
import type { Job, JobId, JobLease, JobStatus, RequestId, UtcTimestamp } from '@yfe/contracts'

import { DEFAULT_JOB_LEASE_MS, claimJob, completeJob, defaultJobIdSource, failJob, heartbeatJob } from '../db/jobs.js'
import type { JobIdSource, JobRepoDeps } from '../db/jobs.js'
import type { ServerDb } from '../db/open.js'

/** 执行器上下文：租约 + 本次是第几次尝试。 */
export interface JobExecutorContext {
  readonly lease: JobLease
  readonly attempt: number
}

/**
 * 执行器回调。`job` 是领取瞬间的**不可变快照**（状态为 `running`）。
 * 抛错 = 本次尝试失败；返回值被忽略（结果要落库请用 `completeJob`/`appendJobOutput`）。
 */
export type JobExecutor = (job: Job, context: JobExecutorContext) => Promise<void> | void

export interface JobRunnerOptions {
  readonly db: ServerDb
  readonly clock: { now(): UtcTimestamp }
  /** ID/令牌生成器（默认契约的 `newIds`）。 */
  readonly ids?: JobIdSource
  readonly executor: JobExecutor
  /** 租约时长，默认 30 秒。 */
  readonly leaseMs?: number
  /** 空闲时的轮询间隔，默认 1 秒（`start()` 用）。 */
  readonly pollIntervalMs?: number
  /** worker 身份（写入 `lease_owner`）：多实例部署时必须各不相同。 */
  readonly owner?: string
  readonly requestId?: RequestId
  readonly log?: (line: Record<string, unknown>) => void
}

/**
 * 一次 `runOnce()` 的结果。
 *
 * - `idle`：没有可领的任务（也包含"有任务因超过重试上限被本次判死"——两者对调用者的
 *   动作相同：等下一轮）。
 * - `succeeded`：执行器跑完且状态已落 `succeeded`。
 * - `stale`：执行器跑完了，但任务在执行期间已被取消/回收（终态或不再属于我们），
 *   本次结果被丢弃。**不是异常**，是"取消是请求"的正常结局。
 * - `failed`：执行器抛错，已尽力落 `failed`（`failurePersisted` 说明是否真的写进去了）。
 * - `stopped`：`stop()` 之后不再领取。
 */
export type RunnerOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'succeeded'; readonly jobId: JobId; readonly attempt: number; readonly lease: JobLease }
  | { readonly kind: 'stale'; readonly jobId: JobId; readonly attempt: number; readonly lease: JobLease; readonly reason: string }
  | {
      readonly kind: 'failed'
      readonly jobId: JobId
      readonly attempt: number
      readonly lease: JobLease
      readonly error: unknown
      readonly failurePersisted: boolean
    }

export interface JobRunner {
  runOnce(): Promise<RunnerOutcome>
  /** 轮询循环（直到 `stop()`）。空闲/失败后等 `pollIntervalMs`，成功后立刻领下一条。 */
  start(): Promise<void>
  /** 停止：不再领取新任务。正在执行的那一条不会被中断（执行器自己负责响应取消）。 */
  stop(): void
  readonly stopped: boolean
}

/** 错误码：执行器自己的契约错误码优先，其它一律归到 `JOB_EXECUTOR_FAILED`。 */
function errorCodeOf(error: unknown): string {
  if (error instanceof ContractError) return error.code
  return 'JOB_EXECUTOR_FAILED'
}

/** 落库的错误文本：只留 `名字: 消息`，**不留 stack**（库里不该有栈，更不该被外发）。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 收尾时允许"认输"的契约错误码：这些表示**任务已经不属于我们**（或已经终态），
 * 不是异常而是并发结局，调用方应把它当 stale 处理。
 *
 * - `STATE_INVALID_TRANSITION`：任务已被并发取消/完成。
 * - `NOT_FOUND_JOB`：行没了。
 * - `RESOURCE_LOCKED`：租约已易主/已过期/`attempt` 不匹配（fencing 拦下的迟到回报）。
 */
const STALE_ERROR_CODES: readonly string[] = ['STATE_INVALID_TRANSITION', 'NOT_FOUND_JOB', 'RESOURCE_LOCKED']

function isStaleError(error: unknown): error is ContractError {
  return error instanceof ContractError && STALE_ERROR_CODES.includes(error.code)
}

/**
 * 执行器运行期间的自动续租。
 *
 * 为什么由运行器负责：默认租约 30 秒，而真实 AI 任务动辄几分钟。执行器一旦忘了调
 * `heartbeatJob`，租约过期就会被另一个 worker 重领 —— 同一条任务被跑两遍（副作用重复）。
 * 续租失败（租约已易主/已过期/任务已终态）只记日志并停表：**真正的裁决在收尾**，
 * 由 `completeJob`/`failJob` 的 fencing 抛 `RESOURCE_LOCKED` 把迟到结果作废。
 */
function startLeaseHeartbeat(
  db: ServerDb,
  owner: string,
  leaseMs: number,
  lease: JobLease,
  repoDeps: JobRepoDeps,
  log?: (line: Record<string, unknown>) => void,
): { stop(): void } {
  // 下限 250ms：既避免极短租约下的空转，又让单测能在毫秒级验证续租确实发生。
  const intervalMs = Math.max(250, Math.floor(lease.heartbeatIntervalMs))
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
  timer = setInterval(() => {
    try {
      heartbeatJob(db, { jobId: lease.jobId, owner, leaseMs }, repoDeps)
    } catch (error) {
      log?.({ event: 'job.lease_lost', jobId: lease.jobId, code: errorCodeOf(error) })
      stop()
    }
  }, intervalMs)
  // 定时器不阻止进程退出（`start()` 之外的调用方可能只想跑一轮）。
  if (typeof timer.unref === 'function') timer.unref()
  return { stop }
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const ids = options.ids ?? defaultJobIdSource
  const owner = options.owner ?? `worker-${ids.leaseToken()}`
  const repoDeps: JobRepoDeps = { now: () => options.clock.now(), ids, requestId: options.requestId }
  let stopped = false
  let loop: Promise<void> | null = null

  function persistFailure(jobId: JobId, error: unknown, attempt: number): boolean {
    try {
      // fencing：这次失败回报必须带租约身份，否则会把已被别人接手的任务判死。
      failJob(
        options.db,
        { jobId, errorCode: errorCodeOf(error), errorMessage: describeError(error), leaseOwner: owner, attempt },
        repoDeps,
      )
      return true
    } catch (persistError) {
      // 落不了 `failed` 只可能是：任务已经终态（被并发取消/完成）、行没了，或租约已易主。
      // 这不是"吞异常"：原始错误仍在 `RunnerOutcome.failed.error` 里返回给调用方；
      // 其余失败（磁盘/约束/未知）一律向上抛，绝不静默。
      if (isStaleError(persistError)) return false
      throw persistError
    }
  }

  async function runOnce(): Promise<RunnerOutcome> {
    if (stopped) return { kind: 'stopped' }

    const claim = claimJob(options.db, { owner, leaseMs }, repoDeps)
    if (claim === null) return { kind: 'idle' }
    const { job, lease, attempt } = claim
    const heartbeat = startLeaseHeartbeat(options.db, owner, leaseMs, lease, repoDeps, options.log)

    try {
      try {
        await options.executor(job, { lease, attempt })
      } catch (error) {
        const failurePersisted = persistFailure(job.id, error, attempt)
        options.log?.({ event: 'job.executor_failed', jobId: job.id, attempt, code: errorCodeOf(error), persisted: failurePersisted })
        return { kind: 'failed', jobId: job.id, attempt, lease, error, failurePersisted }
      }

      let completed: Job
      try {
        completed = completeJob(options.db, { jobId: job.id, leaseOwner: owner, attempt }, repoDeps)
      } catch (error) {
        if (isStaleError(error)) {
          // 执行期间任务被取消/回收/租约易主：结果无效，丢弃。不把它当失败（任务并没有失败）。
          options.log?.({ event: 'job.stale', jobId: job.id, attempt, code: error.code })
          return { kind: 'stale', jobId: job.id, attempt, lease, reason: error.code }
        }
        throw error
      }

      if (completed.status === 'cancelled') {
        // 执行期间收到了取消：`completeJob` 对 `cancelling` 的落点是 `cancelled`
        // （"取消是请求不是事实"——请求到达后由持有租约的一方推进终态）。
        // 这次结果被丢弃，**不算成功**：报成功会让调用方以为产物已经可用。
        options.log?.({ event: 'job.stale', jobId: job.id, attempt, code: 'JOB_CANCELLED' })
        return { kind: 'stale', jobId: job.id, attempt, lease, reason: 'JOB_CANCELLED' }
      }

      options.log?.({ event: 'job.succeeded', jobId: job.id, attempt })
      return { kind: 'succeeded', jobId: job.id, attempt, lease }
    } finally {
      heartbeat.stop()
    }
  }

  async function sleepSlices(totalMs: number): Promise<void> {
    let left = totalMs
    while (left > 0 && !stopped) {
      const step = Math.min(left, 25)
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve()
        }, step)
      })
      left -= step
    }
  }

  return {
    get stopped(): boolean {
      return stopped
    },
    runOnce,
    start(): Promise<void> {
      if (loop !== null) return loop
      stopped = false
      loop = (async (): Promise<void> => {
        while (!stopped) {
          let outcome: RunnerOutcome
          try {
            outcome = await runOnce()
          } catch (error) {
            // 未知持久化错误：**绝不让循环 promise 拒绝**。调用方通常不 await `start()`，
            // 拒绝会变成 unhandled rejection，而且循环会静默停摆（任务永不推进）。
            // 记日志 → 退避 → 继续。
            options.log?.({ event: 'job.loop_error', code: errorCodeOf(error), message: describeError(error) })
            await sleepSlices(pollIntervalMs)
            continue
          }
          if (outcome.kind === 'stopped') break
          if (outcome.kind !== 'succeeded') await sleepSlices(pollIntervalMs)
        }
      })().finally(() => {
        loop = null
      })
      return loop
    },
    stop(): void {
      stopped = true
    },
  }
}

/** 导出给调用方做类型标注用（避免深层 import 契约类型）。 */
export type RunnerJobStatus = JobStatus
