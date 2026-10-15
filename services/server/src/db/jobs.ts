/**
 * 任务仓储：`jobs` + `job_outputs`（迁移 3 的两张表，DDL 见 `db/assetJobDdl.ts`）。
 *
 * 本文件只做**持久化与状态机**，不认识 HTTP、不认识执行器：
 * 路由（`routes/jobs.ts`）负责鉴权/校验/序列化，运行器（`queue/runner.ts`）负责
 * "领一条 → 交给执行器 → 落终态"。这样三层的失败方式互不污染，测试可以分别夹住。
 *
 * 铁律（与 `db/sync.ts` 同一套）：
 *
 * 1. **第一个参数永远是 `db`**，没有模块级单例：测试要用 `:memory:` 库 + 固定时钟
 *    复现"租约过期"，任何隐藏状态都会让复现失效。
 * 2. **时间一律来自注入时钟**（`deps.now()`），绝不写 `datetime('now')`：
 *    SQLite 的 `now` 拿不到测试的时钟，用它会写出"只能靠 sleep 复现"的用例。
 * 3. **状态机由契约的 `JOB_TRANSITIONS` 表驱动**：非法迁移一律
 *    `STATE_INVALID_TRANSITION`，并且**先判定后写入**——判定失败时该行一个字节都不变。
 * 4. **任务事件只写 `job_outputs`**，绝不碰 `change_feed`：后者是文档同步的游标来源，
 *    混进任务事件会让客户端把任务事件当成文档变更（见 `assetJobDdl.ts` 文件头）。
 * 5. **取消是请求不是事实**：能立刻终结的只有"没有活租约"的任务；有活租约的任务
 *    落到 `cancelling`，由执行器回报完成/失败后才终结（或租约过期后由下一次
 *    取消请求/领取循环收尾）。
 *
 * 事件序号的两个层级（SSE 与轮询退路共用同一张表）：
 * - `seq`：**任务内**序号（`(job_id, seq)` 主键），轮询退路 `?since=<seq>` 用它；
 * - `eventSeq`：**工作区内全局**序号，取 `job_outputs` 的隐式 `rowid`，
 *   SSE 的 `Last-Event-ID` 用它。`job_outputs` 没有 `WITHOUT ROWID`，所以 rowid 是
 *   单调递增的插入序；本仓没有任何"删除任务/裁剪事件"的路径（`ON DELETE CASCADE`
 *   只在删 `jobs` 行时触发，而无处可删），因此 rowid 不会被复用。
 *   ⚠️ 将来若加入删除或裁剪事件的路径，必须改成 AUTOINCREMENT 或独立的事件表，
 *   否则游标会跳过新事件。
 */

import { ContractError, canTransitionJob, isTerminalJobStatus, newIds } from '@yfe/contracts'
import type {
  DeviceId,
  IdempotencyKey,
  Job,
  JobId,
  JobLease,
  JobStatus,
  ProjectId,
  RequestId,
  Revision,
  UserId,
  UtcTimestamp,
  WorkspaceId,
} from '@yfe/contracts'

import { canonicalJson, digestOf } from './canonical.js'
import { tx } from './open.js'
import type { ServerDb } from './open.js'

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 与 DDL 的 `max_attempts ... DEFAULT 3` 保持一致（测试里有一条断言钉住它）。 */
export const DEFAULT_JOB_MAX_ATTEMPTS = 3

/** 默认租约时长：30 秒。执行器应每 `leaseMs / 3` 续租一次。 */
export const DEFAULT_JOB_LEASE_MS = 30_000

/**
 * `job_outputs.kind` 的取值，与 DDL 的 CHECK 逐字一致。
 *
 * 契约包里**没有**对应类型（`JobOutputChunk` 是 `{sequence, text}` 的文本流形状，
 * 承载不了 `payload_json`），所以在这里定义；两处若漂移，DDL 的 CHECK 会先报错。
 */
export const JOB_OUTPUT_KINDS = ['log', 'progress', 'chunk', 'checkpoint', 'result', 'error', 'status'] as const

export type JobOutputKind = (typeof JOB_OUTPUT_KINDS)[number]

export function isJobOutputKind(value: unknown): value is JobOutputKind {
  return typeof value === 'string' && (JOB_OUTPUT_KINDS as readonly string[]).includes(value)
}

/**
 * `JobStatus` 全量取值。
 *
 * 契约只导出了 `TERMINAL_JOB_STATUSES`（终态子集），没有全量数组；这里的字面量必须与
 * `JobStatus` 类型**完全一致**——下面的 `Exact` 断言会在编译期钉死这一点（若契约加了
 * 第 10 个状态而这里没跟上，`tsc` 直接报错，而不是等到 CHECK 约束在运行时炸）。
 */
const JOB_STATUS_VALUES = [
  'queued',
  'running',
  'waiting_network',
  'waiting_confirmation',
  'paused',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
] as const

type JobStatusValue = (typeof JOB_STATUS_VALUES)[number]

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** 编译期断言：本文件的字面量集合与契约 `JobStatus` 完全一致（漂移即 `tsc` 报错）。 */
const STATUS_PARITY: Exact<JobStatusValue, JobStatus> = true
void STATUS_PARITY

export const JOB_STATUSES: readonly JobStatus[] = JOB_STATUS_VALUES

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUS_VALUES as readonly string[]).includes(value)
}

/**
 * 可被领取的状态集合。
 *
 * **刻意不含 `cancelling`**：已经收到取消请求的任务不允许被重新领取执行
 * （否则"取消"会被下一个 worker 当成"重跑"）。它与任务书的"所有非终态"有一处偏差，
 * 代价是 `cancelling` 且租约已过期的任务需要一个收尾路径——这个收尾放在
 * `cancelJob()` 里（再次取消时会把它推进到 `cancelled`），不额外起扫描器。
 * 硬理由：`cancelling → running` **不在**契约冻结的 `JOB_TRANSITIONS` 表里，
 * 领取它就必须写一次非法迁移。
 *
 * `paused` 在集合内，但"可领"还需要**租约确实过期**（NULL 不算过期），
 * 所以"用户暂停、从未被领取"的任务不会被 worker 抢跑。
 */
export const CLAIMABLE_JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'waiting_network',
  'waiting_confirmation',
  'paused',
]

/** ID 生成器（可注入：测试要固定 ID 以便断言）。 */
export interface JobIdSource {
  jobId(): JobId
  leaseToken(): string
}

export const defaultJobIdSource: JobIdSource = {
  jobId: () => newIds.job(),
  leaseToken: () => newIds.request(),
}

/** 仓储依赖：注入时钟 + ID 生成器 + 请求号（进错误体，便于把日志和客户端投诉对上）。 */
export interface JobRepoDeps {
  readonly now: () => UtcTimestamp
  readonly ids?: JobIdSource
  readonly requestId?: RequestId
}

// ---------------------------------------------------------------------------
// 契约形状：Job / 输出事件 / 详情
// ---------------------------------------------------------------------------

/** `job_outputs` 的一行（`payload_json` 已解析）。轮询退路与 SSE 共用它。 */
export interface JobOutputRecord {
  readonly jobId: JobId
  readonly seq: number
  readonly kind: JobOutputKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdAt: UtcTimestamp
}

/** 工作区内的事件（比 `JobOutputRecord` 多一个全局 `eventSeq`，即 SSE 的 `id:`）。 */
export interface JobStreamEvent extends JobOutputRecord {
  readonly eventSeq: number
}

/**
 * 任务详情：契约 `Job` 之外，把客户端真正需要的几项单独给出来。
 *
 * 🔴 **不含 `error_message`**：执行器抛出的原始文本可能带绝对路径或 SQLite 原文，
 * 而对外响应绝不能带这些（`http/errors.ts` 的纪律）。库里留着供运维排查，
 * 客户端看 `errorCode` + 执行器自己写的 `kind='error'` 输出（由执行器保证可外发）。
 */
export interface JobDetail {
  readonly job: Job
  readonly attempt: number
  readonly maxAttempts: number
  readonly payload: Readonly<Record<string, unknown>>
  readonly errorCode: string | null
  readonly cancelRequestedAt: UtcTimestamp | null
  readonly cancelReason: string | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: UtcTimestamp | null
}

// ---------------------------------------------------------------------------
// 行形状与映射
// ---------------------------------------------------------------------------

interface JobRow {
  readonly job_id: string
  readonly workspace_id: string
  readonly project_id: string | null
  readonly kind: string
  readonly executor: string
  readonly status: string
  readonly payload_json: string
  readonly input_revision: string | null
  readonly config_revision: string | null
  readonly priority: number
  readonly attempt: number
  readonly max_attempts: number
  readonly lease_owner: string | null
  readonly lease_expires_at: string | null
  readonly checkpoint: string | null
  readonly output_ref: string | null
  readonly progress_json: string | null
  readonly result_json: string | null
  readonly error_code: string | null
  readonly error_message: string | null
  readonly submitted_by_user_id: string
  readonly submitted_by_device_id: string | null
  readonly idempotency_key: string | null
  readonly cancel_requested_at: string | null
  readonly cancel_reason: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly expires_at: string | null
}

interface JobOutputRow {
  readonly job_id: string
  readonly seq: number
  readonly kind: string
  readonly payload_json: string
  readonly created_at: string
}

interface JobEventRow extends JobOutputRow {
  readonly event_seq: number
}

function requestIdOf(deps: JobRepoDeps): RequestId {
  return deps.requestId ?? (newIds.request() as RequestId)
}

function rangeError(deps: JobRepoDeps, field: string, min: number, max?: number): ContractError {
  return new ContractError({
    code: 'VALIDATION_OUT_OF_RANGE',
    message: max === undefined ? `${field} 必须是不小于 ${min} 的整数。` : `${field} 必须是 ${min} 到 ${max} 之间的整数。`,
    requestId: requestIdOf(deps),
    detail: max === undefined ? { field, min } : { field, min, max },
  })
}

function notFoundJob(deps: JobRepoDeps, jobId: string): ContractError {
  return new ContractError({
    code: 'NOT_FOUND_JOB',
    message: '任务不存在。',
    requestId: requestIdOf(deps),
    detail: { jobId },
  })
}

function invalidTransition(deps: JobRepoDeps, detail: Record<string, string | number | null>): ContractError {
  return new ContractError({
    code: 'STATE_INVALID_TRANSITION',
    message: '当前状态不允许该迁移。',
    requestId: requestIdOf(deps),
    detail,
  })
}

function resourceLocked(deps: JobRepoDeps, detail: Record<string, string | number | null>): ContractError {
  return new ContractError({
    code: 'RESOURCE_LOCKED',
    message: '任务的租约不在你手里或已过期。',
    requestId: requestIdOf(deps),
    detail,
  })
}

function parsePayloadJson(json: string, deps: JobRepoDeps): Readonly<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '任务载荷已损坏，无法解析。',
      requestId: requestIdOf(deps),
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '任务载荷已损坏，无法解析。',
      requestId: requestIdOf(deps),
    })
  }
  return parsed as Readonly<Record<string, unknown>>
}

function toJob(row: JobRow): Job {
  return {
    id: row.job_id as JobId,
    workspaceId: row.workspace_id as WorkspaceId,
    projectId: row.project_id === null ? null : (row.project_id as ProjectId),
    kind: row.kind,
    executor: row.executor,
    status: row.status as JobStatus,
    inputRevision: row.input_revision === null ? null : (row.input_revision as Revision),
    configRevision: row.config_revision === null ? null : (row.config_revision as Revision),
    priority: row.priority,
    attempt: row.attempt,
    checkpoint: row.checkpoint,
    outputRef: row.output_ref,
    createdAt: row.created_at as UtcTimestamp,
    updatedAt: row.updated_at as UtcTimestamp,
  }
}

function toOutputRecord(row: JobOutputRow, deps: JobRepoDeps): JobOutputRecord {
  if (!isJobOutputKind(row.kind)) {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '任务事件类型无法识别。',
      requestId: requestIdOf(deps),
    })
  }
  return {
    jobId: row.job_id as JobId,
    seq: row.seq,
    kind: row.kind,
    payload: parsePayloadJson(row.payload_json, deps),
    createdAt: row.created_at as UtcTimestamp,
  }
}

function getJobRow(db: ServerDb, jobId: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined
}

function requireJobRow(db: ServerDb, jobId: string, deps: JobRepoDeps): JobRow {
  const row = getJobRow(db, jobId)
  if (row === undefined) {
    throw notFoundJob(deps, jobId)
  }
  return row
}

/** 时间加法：`UtcTimestamp` 是定宽 ISO-8601（毫秒），所以字符串比较就是时间比较。 */
export function addMs(at: UtcTimestamp, ms: number): UtcTimestamp {
  return new Date(Date.parse(at) + ms).toISOString() as UtcTimestamp
}

function hasActiveLease(row: JobRow, at: UtcTimestamp): boolean {
  return row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at > at
}

// ---------------------------------------------------------------------------
// 输出事件（job_outputs）
// ---------------------------------------------------------------------------

export interface AppendJobOutputRequest {
  readonly jobId: JobId
  readonly kind: JobOutputKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly occurredAt: UtcTimestamp
}

/**
 * 追加一条任务事件。
 *
 * `seq` 在本事务内用 `COALESCE(MAX(seq), -1) + 1` 分配——**必须在写事务里**
 * 分配，否则两个并发写会拿到同一个序号，`(job_id, seq)` 主键直接报错。
 * 单写者 SQLite 下这段不会真并发，但规律必须写在代码里，不能靠运气。
 */
function appendOutputTx(db: ServerDb, request: AppendJobOutputRequest, deps: JobRepoDeps): JobOutputRecord & { eventSeq: number } {
  if (getJobRow(db, request.jobId) === undefined) {
    throw notFoundJob(deps, request.jobId)
  }
  const next = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM job_outputs WHERE job_id = ?').get(request.jobId) as
    | { next_seq: number }
    | undefined
  const seq = next?.next_seq ?? 0
  const payloadJson = canonicalJson(request.payload)
  const info = db
    .prepare('INSERT INTO job_outputs (job_id, seq, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(request.jobId, seq, request.kind, payloadJson, request.occurredAt)
  return {
    jobId: request.jobId,
    seq,
    kind: request.kind,
    payload: request.payload,
    createdAt: request.occurredAt,
    eventSeq: Number(info.lastInsertRowid),
  }
}

export function appendJobOutput(db: ServerDb, request: AppendJobOutputRequest, deps: JobRepoDeps): JobOutputRecord {
  const appended = tx(db, () => appendOutputTx(db, request, deps))
  return {
    jobId: appended.jobId,
    seq: appended.seq,
    kind: appended.kind,
    payload: appended.payload,
    createdAt: appended.createdAt,
  }
}

/** 状态变更事件：只带状态/尝试次数/错误码，**绝不放 error_message**（可外发）。 */
function appendStatusEvent(db: ServerDb, jobId: JobId, at: UtcTimestamp, status: JobStatus, attempt: number, errorCode: string | null, deps: JobRepoDeps): void {
  const payload: Record<string, unknown> = { status, attempt }
  if (errorCode !== null) payload['errorCode'] = errorCode
  appendOutputTx(db, { jobId, kind: 'status', payload, occurredAt: at }, deps)
}

export interface ListJobOutputsRequest {
  readonly jobId: JobId
  readonly sinceSeq?: number
  readonly limit?: number
}

/** 轮询退路：`seq > sinceSeq` 的增量。返回 `hasMore` 让客户端知道还有积压。`sinceSeq = -1` 表示从头开始（含 seq 0）。 */
export function listJobOutputs(db: ServerDb, request: ListJobOutputsRequest, deps: JobRepoDeps): { readonly items: readonly JobOutputRecord[]; readonly hasMore: boolean } {
  const since = request.sinceSeq ?? -1
  const limit = request.limit ?? 200
  if (!Number.isSafeInteger(since) || since < -1) {
    throw rangeError(deps, 'since', -1)
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw rangeError(deps, 'limit', 1, 500)
  }
  const rows = db
    .prepare('SELECT job_id, seq, kind, payload_json, created_at FROM job_outputs WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
    .all(request.jobId, since, limit + 1) as JobOutputRow[]
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return { items: page.map((row) => toOutputRecord(row, deps)), hasMore }
}

export interface ListJobEventsRequest {
  readonly workspaceId: WorkspaceId
  /** 全局事件序号（SSE 的 `Last-Event-ID` / 轮询的 `?since=`），只返回更大的。 */
  readonly sinceEventSeq?: number
  readonly jobId?: JobId | null
  readonly limit?: number
}

/**
 * 工作区级事件流：SSE 与"按 Last-Event-ID 拉增量"共用这一条查询。
 *
 * 归属校验靠 `JOIN jobs` 的 `workspace_id` 条件——**事件只能从工作区边界内取出**，
 * 客户端传来的 `since` 不可能越过它（越界只会拿到自己工作区的事件）。
 */
export function listJobEvents(db: ServerDb, request: ListJobEventsRequest, deps: JobRepoDeps): { readonly items: readonly JobStreamEvent[]; readonly hasMore: boolean } {
  const since = request.sinceEventSeq ?? 0
  const limit = request.limit ?? 200
  if (!Number.isSafeInteger(since) || since < 0) {
    throw rangeError(deps, 'since', 0)
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw rangeError(deps, 'limit', 1, 500)
  }
  const jobFilter = request.jobId === undefined || request.jobId === null ? '' : ' AND o.job_id = ?'
  const params: (string | number)[] = [request.workspaceId, since]
  if (jobFilter !== '') params.push(request.jobId as string)
  params.push(limit + 1)
  const rows = db
    .prepare(
      `SELECT o.job_id, o.seq, o.kind, o.payload_json, o.created_at, o.rowid AS event_seq
         FROM job_outputs o
         JOIN jobs j ON j.job_id = o.job_id
        WHERE j.workspace_id = ? AND o.rowid > ?${jobFilter}
        ORDER BY o.rowid ASC
        LIMIT ?`,
    )
    .all(...params) as JobEventRow[]
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    items: page.map((row) => ({ ...toOutputRecord(row, deps), eventSeq: row.event_seq })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// 提交（幂等）
// ---------------------------------------------------------------------------

export interface SubmitJobRequest {
  readonly workspaceId: WorkspaceId
  readonly projectId?: ProjectId | null
  readonly kind: string
  readonly executor: string
  readonly priority?: number
  readonly inputRevision?: Revision | null
  readonly payload?: Readonly<Record<string, unknown>>
  readonly idempotencyKey?: IdempotencyKey | null
  readonly maxAttempts?: number
  readonly submittedByUserId: UserId
  readonly submittedByDeviceId?: DeviceId | null
  readonly expiresAt?: UtcTimestamp | null
}

export interface SubmitJobResult {
  readonly jobId: JobId
  /** `true` = 本次真的插入了新行；`false` = 幂等命中已有任务（同一个 jobId）。 */
  readonly created: boolean
  readonly job: Job
}

/**
 * 幂等的"同键即同请求"判定。
 *
 * 比较四样东西：`kind`、`executor`、`input_revision`、载荷摘要。
 * 载荷摘要从 `payload_json` **现场重算**（`payload_json` 存的是规范化原始载荷，
 * 所以 `digestOf(JSON.parse(payload_json)) === digestOf(载荷)` 恒成立）。
 * `priority` 刻意不参与比较：它是调度提示，不是执行输入；改优先级重提同一键
 * 不该被判成"换了任务"（这一点在报告里列为已知取舍）。
 */
function assertSameRequest(row: JobRow, request: SubmitJobRequest, payloadDigest: string, deps: JobRepoDeps): void {
  const sameRevision = (row.input_revision ?? null) === (request.inputRevision ?? null)
  let samePayload = false
  try {
    samePayload = digestOf(JSON.parse(row.payload_json)) === payloadDigest
  } catch {
    samePayload = false
  }
  const sameKind = row.kind === request.kind
  const sameExecutor = row.executor === request.executor
  if (sameKind && sameExecutor && sameRevision && samePayload) return
  throw new ContractError({
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: '同一个幂等键被用于了另一次不同的任务提交。',
    requestId: requestIdOf(deps),
    detail: { jobId: row.job_id, sameKind, sameExecutor, sameRevision, samePayload },
  })
}

export function submitJob(db: ServerDb, request: SubmitJobRequest, deps: JobRepoDeps): SubmitJobResult {
  const at = deps.now()
  const ids = deps.ids ?? defaultJobIdSource
  const payload = request.payload ?? {}
  const payloadJson = canonicalJson(payload)
  const payloadDigest = digestOf(payload)
  const idempotencyKey = request.idempotencyKey ?? null
  const maxAttempts = request.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw rangeError(deps, 'maxAttempts', 1)
  }

  return tx(db, () => {
    if (idempotencyKey !== null) {
      const existing = findByIdempotencyKey(db, request.workspaceId, idempotencyKey)
      if (existing !== undefined) {
        assertSameRequest(existing, request, payloadDigest, deps)
        return { jobId: existing.job_id as JobId, created: false, job: toJob(existing) }
      }
    }

    const jobId = ids.jobId()
    try {
      db.prepare(
        `INSERT INTO jobs (
           job_id, workspace_id, project_id, kind, executor, status, payload_json,
           input_revision, priority, attempt, max_attempts,
           submitted_by_user_id, submitted_by_device_id, idempotency_key,
           created_at, updated_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobId,
        request.workspaceId,
        request.projectId ?? null,
        request.kind,
        request.executor,
        payloadJson,
        request.inputRevision ?? null,
        request.priority ?? 0,
        maxAttempts,
        request.submittedByUserId,
        request.submittedByDeviceId ?? null,
        idempotencyKey,
        at,
        at,
        request.expiresAt ?? null,
      )
    } catch (error) {
      // 兜底：部分唯一索引 `uq_jobs_idempotency` 才是幂等的**唯一**权威。
      // 单写者下上面那次 SELECT 已经足够，但多进程同时提交时只有唯一索引拦得住。
      const code = (error as { code?: unknown }).code
      if (idempotencyKey !== null && typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
        const raced = findByIdempotencyKey(db, request.workspaceId, idempotencyKey)
        if (raced !== undefined) {
          assertSameRequest(raced, request, payloadDigest, deps)
          return { jobId: raced.job_id as JobId, created: false, job: toJob(raced) }
        }
      }
      throw error
    }

    // 提交本身也是一个可观察事件：SSE 与轮询都能看到任务"已入队"。
    appendStatusEvent(db, jobId, at, 'queued', 0, null, deps)
    const inserted = getJobRow(db, jobId)
    if (inserted === undefined) throw notFoundJob(deps, jobId)
    return { jobId, created: true, job: toJob(inserted) }
  })
}

function findByIdempotencyKey(db: ServerDb, workspaceId: WorkspaceId, idempotencyKey: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE workspace_id = ? AND idempotency_key = ?').get(workspaceId, idempotencyKey) as
    | JobRow
    | undefined
}

// ---------------------------------------------------------------------------
// 领取 / 心跳（租约）
// ---------------------------------------------------------------------------

export interface ClaimJobRequest {
  /** worker 身份，写入 `lease_owner`；同时充当租约令牌（DDL 只有一个 lease_owner 列）。 */
  readonly owner: string
  readonly leaseMs: number
  /** 可选：只领某个工作区的任务（多租户 worker 用）。 */
  readonly workspaceId?: WorkspaceId
}

export interface ClaimJobResult {
  readonly job: Job
  readonly lease: JobLease
  readonly attempt: number
}

/**
 * 领取一条可执行任务。
 *
 * 可领取 = `queued`，**或**非终态且（没有租约 / 租约已过期）。顺序 `priority DESC,
 * created_at ASC`（索引 `idx_jobs_claimable` 的顺序）。领取即自增 `attempt`：
 * `attempt > max_attempts` 说明这条任务已经被反复领取到超过上限，直接判死为
 * `failed` + `JOB_TIMEOUT` 并返回 `null`——**绝不再交给执行器**。
 *
 * 注意 `running→running`（复活一条租约过期的任务）不在 `JOB_TRANSITIONS` 里
 * （那是同一状态，本来就不是"迁移"），所以这里不调用 `canTransitionJob`，
 * 只对 `waiting_*`/`paused → running` 这类真实迁移做判定。
 */
export function claimJob(db: ServerDb, request: ClaimJobRequest, deps: JobRepoDeps): ClaimJobResult | null {
  const at = deps.now()
  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0) {
    throw rangeError(deps, 'leaseMs', 1)
  }
  if (request.owner.length === 0) {
    throw rangeError(deps, 'owner', 1)
  }
  const leaseToken = request.owner
  const expiresAt = addMs(at, request.leaseMs)

  return tx(db, () => {
    const placeholders = CLAIMABLE_JOB_STATUSES.map(() => '?').join(', ')
    const workspaceFilter = request.workspaceId === undefined ? '' : ' AND workspace_id = ?'
    const params: (string)[] = [...CLAIMABLE_JOB_STATUSES, at]
    if (request.workspaceId !== undefined) params.push(request.workspaceId)
    const row = db
      .prepare(
        `SELECT * FROM jobs
          WHERE status IN (${placeholders})
            AND (status = 'queued' OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))${workspaceFilter}
          ORDER BY priority DESC, created_at ASC, job_id ASC
          LIMIT 1`,
      )
      .get(...params) as JobRow | undefined
    if (row === undefined) return null

    const attempt = row.attempt + 1
    if (attempt > row.max_attempts) {
      // 超过重试上限：判死。留痕（attempt 记下"这次没有真的执行"）并写事件。
      db.prepare(
        `UPDATE jobs
            SET status = 'failed', attempt = ?, error_code = 'JOB_TIMEOUT',
                error_message = ?, finished_at = ?, updated_at = ?,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE job_id = ?`,
      ).run(
        attempt,
        `任务在租约过期后被反复领取，超过重试上限（max_attempts=${row.max_attempts}）。`,
        at,
        at,
        row.job_id,
      )
      appendStatusEvent(db, row.job_id as JobId, at, 'failed', attempt, 'JOB_TIMEOUT', deps)
      return null
    }

    const info = db
      .prepare(
        `UPDATE jobs
            SET status = 'running', attempt = ?, lease_owner = ?, lease_expires_at = ?,
                started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE job_id = ?
            AND (status = 'queued' OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`,
      )
      .run(attempt, leaseToken, expiresAt, at, at, row.job_id, at)
    if (info.changes !== 1) {
      // 另一个 worker 在同一个时间片里抢走了（多进程才会发生）：没有领到就是没有领到。
      return null
    }

    appendStatusEvent(db, row.job_id as JobId, at, 'running', attempt, null, deps)
    const claimed = requireJobRow(db, row.job_id, deps)
    return {
      job: toJob(claimed),
      attempt,
      lease: {
        jobId: claimed.job_id as JobId,
        executor: claimed.executor,
        leaseToken,
        leasedAt: at,
        expiresAt,
        heartbeatIntervalMs: Math.max(1, Math.floor(request.leaseMs / 3)),
      },
    }
  })
}

export interface HeartbeatJobRequest {
  readonly jobId: JobId
  readonly owner: string
  readonly leaseMs: number
}

/**
 * 续租。租约不属于自己或已过期 → `RESOURCE_LOCKED`：
 * "过期的租约不是你的租约"，否则两个 worker 会同时以为自己拥有同一条任务。
 */
export function heartbeatJob(db: ServerDb, request: HeartbeatJobRequest, deps: JobRepoDeps): JobLease {
  const at = deps.now()
  if (!Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0) {
    throw rangeError(deps, 'leaseMs', 1)
  }
  return tx(db, () => {
    const row = requireJobRow(db, request.jobId, deps)
    if (isTerminalJobStatus(row.status as JobStatus)) {
      throw invalidTransition(deps, { from: row.status, to: 'running', reason: 'terminal' })
    }
    if (row.lease_owner !== request.owner) {
      throw resourceLocked(deps, { jobId: row.job_id, reason: 'not_owner' })
    }
    if (row.lease_expires_at === null || row.lease_expires_at <= at) {
      throw resourceLocked(deps, { jobId: row.job_id, reason: 'expired' })
    }
    const expiresAt = addMs(at, request.leaseMs)
    const info = db
      .prepare('UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE job_id = ? AND lease_owner = ? AND lease_expires_at > ?')
      .run(expiresAt, at, row.job_id, request.owner, at)
    if (info.changes !== 1) {
      // 上面的 SELECT 与 UPDATE 在同一个事务里，走到这里只可能是别的进程改了租约。
      throw resourceLocked(deps, { jobId: row.job_id, reason: 'lost' })
    }
    return {
      jobId: row.job_id as JobId,
      executor: row.executor,
      leaseToken: request.owner,
      leasedAt: at,
      expiresAt,
      heartbeatIntervalMs: Math.max(1, Math.floor(request.leaseMs / 3)),
    }
  })
}

// ---------------------------------------------------------------------------
// 终态迁移
// ---------------------------------------------------------------------------

/**
 * 租约栅栏（fencing）：确认"这行任务现在仍归我"。
 *
 * 为什么必须有：领取用租约，租约过期后任何人都能重领同一条任务。如果回报终态时只带
 * `jobId`，那么**租约已失效的原执行者**仍能把行写成 `succeeded`/`failed` —— 同一任务被
 * 两个 worker 执行（副作用重复），第二个收尾时反而被判成 stale，真相被掩盖。
 *
 * 语义：
 * - `leaseOwner` 不传 = 不做栅栏（迁移脚本、单测里对没有租约的 `queued` 任务判死等场景）。
 * - 传了则 `lease_owner` 必须逐字相同，`attempt`（若同时传）也必须相同 → 否则
 *   `RESOURCE_LOCKED`，**且该行零变化**。
 * - 判定顺序：**先状态迁移、再租约栅栏**。终态任务一律报 `STATE_INVALID_TRANSITION`
 *   （与"是不是你的"无关，反正一个字都不会写）；只有当"这次写入本来会被接受"时，
 *   才需要问"这行现在还归我吗" —— 那才是栅栏要拦的迟到回报。
 */
function assertLeaseFence(
  row: JobRow,
  request: { readonly leaseOwner?: string; readonly attempt?: number },
  deps: JobRepoDeps,
): void {
  if (request.leaseOwner === undefined) return
  if (row.lease_owner === null) {
    throw resourceLocked(deps, { jobId: row.job_id, reason: 'no_lease' })
  }
  if (row.lease_owner !== request.leaseOwner) {
    throw resourceLocked(deps, { jobId: row.job_id, reason: 'not_owner' })
  }
  if (request.attempt !== undefined && row.attempt !== request.attempt) {
    throw resourceLocked(deps, { jobId: row.job_id, reason: 'attempt_mismatch' })
  }
}

export interface CompleteJobRequest {
  readonly jobId: JobId
  readonly result?: Readonly<Record<string, unknown>> | null
  readonly outputRef?: string | null
  /** 租约所有者（fencing）。执行器路径必须传，见 `assertLeaseFence`。 */
  readonly leaseOwner?: string
  /** 本次尝试序号（fencing）。与 `claimJob` 返回的 `attempt` 对应。 */
  readonly attempt?: number
}

/**
 * 执行器回报成功。
 *
 * - 目标状态默认 `succeeded`；但若期间收到过取消请求（`cancelling`），落 `cancelled`
 *   ——"取消是请求不是事实"的另一半：执行器跑完了也不能把已请求取消的任务标成成功。
 * - 其它非法入口（例如对 `queued` 任务调它：这条任务根本没有租约，不该有人回报完成）
 *   一律 `STATE_INVALID_TRANSITION`，且在写之前判定 → 该行零变化。
 * - 传了 `leaseOwner`：状态迁移合法之后再过租约栅栏，租约已易主 → `RESOURCE_LOCKED` 且零变化。
 */
export function completeJob(db: ServerDb, request: CompleteJobRequest, deps: JobRepoDeps): Job {
  const at = deps.now()
  return tx(db, () => {
    const row = requireJobRow(db, request.jobId, deps)
    const from = row.status as JobStatus
    const target: JobStatus = from === 'cancelling' ? 'cancelled' : 'succeeded'
    if (!canTransitionJob(from, target)) {
      throw invalidTransition(deps, { from, to: target })
    }
    assertLeaseFence(row, request, deps)
    db.prepare(
      `UPDATE jobs
          SET status = ?, result_json = ?, output_ref = COALESCE(?, output_ref),
              finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE job_id = ?`,
    ).run(target, request.result === undefined || request.result === null ? null : canonicalJson(request.result), request.outputRef ?? null, at, at, row.job_id)
    appendStatusEvent(db, row.job_id as JobId, at, target, row.attempt, null, deps)
    const updated = requireJobRow(db, row.job_id, deps)
    return toJob(updated)
  })
}

export interface FailJobRequest {
  readonly jobId: JobId
  /** 契约错误码（如 `JOB_EXECUTOR_FAILED` / `JOB_TIMEOUT` / `JOB_CANCELLED`）。 */
  readonly errorCode: string
  /** 内部诊断文本：**不对外返回**，只落库。 */
  readonly errorMessage: string
  readonly checkpoint?: string | null
  /** 租约所有者（fencing）。执行器路径必须传，见 `assertLeaseFence`。 */
  readonly leaseOwner?: string
  /** 本次尝试序号（fencing）。与 `claimJob` 返回的 `attempt` 对应。 */
  readonly attempt?: number
}

/**
 * 执行器失败：落终态 `failed` + `error_code`/`error_message`（幂等重试不做，见报告）。
 *
 * 传了 `leaseOwner`：状态迁移合法之后再过租约栅栏 —— **租约已被别人接手的任务，
 * 原执行者的失败回报不能落库**，否则会把别人正在跑的任务判死。
 */
export function failJob(db: ServerDb, request: FailJobRequest, deps: JobRepoDeps): Job {
  const at = deps.now()
  return tx(db, () => {
    const row = requireJobRow(db, request.jobId, deps)
    const from = row.status as JobStatus
    if (!canTransitionJob(from, 'failed')) {
      throw invalidTransition(deps, { from, to: 'failed' })
    }
    assertLeaseFence(row, request, deps)
    db.prepare(
      `UPDATE jobs
          SET status = 'failed', error_code = ?, error_message = ?,
              checkpoint = COALESCE(?, checkpoint),
              finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE job_id = ?`,
    ).run(request.errorCode, request.errorMessage.slice(0, 2000), request.checkpoint ?? null, at, at, row.job_id)
    appendStatusEvent(db, row.job_id as JobId, at, 'failed', row.attempt, request.errorCode, deps)
    const updated = requireJobRow(db, row.job_id, deps)
    return toJob(updated)
  })
}

export interface CancelJobRequest {
  readonly jobId: JobId
  readonly reason?: string | null
}

export type CancelJobStatus = 'cancelling' | 'cancelled' | 'already-terminal'

export interface CancelJobResult {
  readonly jobId: JobId
  readonly status: CancelJobStatus
  readonly job: Job
}

/**
 * 取消。**取消是请求不是事实**：
 *
 * - 终态 → `already-terminal`（不写一行：终态任务的状态不能再被"取消"改写）；
 * - `queued`（无租约）→ 直接 `cancelled`：没有人在执行，它就是事实；
 * - 非终态且**有活租约** → `cancelling` + `cancel_requested_at`/`cancel_reason`：
 *   执行器还在跑，服务端只能"请求"它停；真正的终结由执行器回报
 *   （`completeJob` → `cancelled` / `failJob` → `failed`）。
 * - 非终态且**无活租约**（worker 已死或租约过期）→ 直接 `cancelled`：
 *   没有执行者可以观察 `cancelling`，停在中间态只会让任务永久卡住。
 *   这也是 `cancelling` 且租约已过期时的收尾路径（再次取消即推进到 `cancelled`）。
 */
export function cancelJob(db: ServerDb, request: CancelJobRequest, deps: JobRepoDeps): CancelJobResult {
  const at = deps.now()
  const reason = request.reason ?? null
  return tx(db, () => {
    const row = requireJobRow(db, request.jobId, deps)
    const from = row.status as JobStatus

    if (isTerminalJobStatus(from)) {
      return { jobId: row.job_id as JobId, status: 'already-terminal' as const, job: toJob(row) }
    }

    if (from === 'queued') {
      db.prepare(
        `UPDATE jobs
            SET status = 'cancelled', cancel_requested_at = ?, cancel_reason = ?,
                finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
          WHERE job_id = ?`,
      ).run(at, reason, at, at, row.job_id)
      appendStatusEvent(db, row.job_id as JobId, at, 'cancelled', row.attempt, null, deps)
      return { jobId: row.job_id as JobId, status: 'cancelled' as const, job: toJob(requireJobRow(db, row.job_id, deps)) }
    }

    if (hasActiveLease(row, at)) {
      // `running`/`waiting_*`/`paused` → `cancelling` 都在契约迁移表里；
      // 若状态是 `cancelling` 本身，说明取消已经请求过，原样回 `cancelling`（零写入）。
      if (from !== 'cancelling') {
        if (!canTransitionJob(from, 'cancelling')) {
          throw invalidTransition(deps, { from, to: 'cancelling' })
        }
        db.prepare('UPDATE jobs SET status = ?, cancel_requested_at = ?, cancel_reason = ?, updated_at = ? WHERE job_id = ?').run(
          'cancelling',
          at,
          reason,
          at,
          row.job_id,
        )
        appendStatusEvent(db, row.job_id as JobId, at, 'cancelling', row.attempt, null, deps)
      }
      return { jobId: row.job_id as JobId, status: 'cancelling' as const, job: toJob(requireJobRow(db, row.job_id, deps)) }
    }

    // 无活租约：没有执行者可以观察中间态，直接终结。
    // `cancelling → cancelled` 在迁移表内；`running/waiting_*/paused → cancelling` 也在表内，
    // 所以这里用"是否允许发起取消"来判定，而不是要求 `→ cancelled` 这一跳（表里没有这条边）。
    if (from !== 'cancelling' && !canTransitionJob(from, 'cancelling')) {
      throw invalidTransition(deps, { from, to: 'cancelling' })
    }
    db.prepare(
      `UPDATE jobs
          SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
              cancel_reason = COALESCE(?, cancel_reason),
              finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE job_id = ?`,
    ).run(at, reason, at, at, row.job_id)
    appendStatusEvent(db, row.job_id as JobId, at, 'cancelled', row.attempt, null, deps)
    return { jobId: row.job_id as JobId, status: 'cancelled' as const, job: toJob(requireJobRow(db, row.job_id, deps)) }
  })
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export function getJob(db: ServerDb, jobId: JobId): Job | null {
  const row = getJobRow(db, jobId)
  return row === undefined ? null : toJob(row)
}

export function getJobDetail(db: ServerDb, jobId: JobId, deps: JobRepoDeps): JobDetail | null {
  const row = getJobRow(db, jobId)
  if (row === undefined) return null
  return {
    job: toJob(row),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    payload: parsePayloadJson(row.payload_json, deps),
    errorCode: row.error_code,
    cancelRequestedAt: row.cancel_requested_at === null ? null : (row.cancel_requested_at as UtcTimestamp),
    cancelReason: row.cancel_reason,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null ? null : (row.lease_expires_at as UtcTimestamp),
  }
}

export interface ListJobsRequest {
  readonly workspaceId: WorkspaceId
  readonly status?: readonly JobStatus[] | null
  readonly projectId?: ProjectId | null
  readonly limit: number
  /** 由路由把游标解析成的偏移量（游标本身的形状/归属校验在路由层）。 */
  readonly offset?: number
}

/** 按工作区分页列出（`created_at DESC, job_id DESC`）。 */
export function listJobs(db: ServerDb, request: ListJobsRequest, deps: JobRepoDeps): { readonly jobs: readonly Job[]; readonly hasMore: boolean } {
  const limit = request.limit
  const offset = request.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw rangeError(deps, 'limit', 1, 500)
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw rangeError(deps, 'cursor', 0)
  }
  const conditions: string[] = ['workspace_id = ?']
  const params: (string | number)[] = [request.workspaceId]
  const statuses = request.status ?? null
  if (statuses !== null && statuses.length > 0) {
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    for (const status of statuses) params.push(status)
  }
  if (request.projectId !== undefined && request.projectId !== null) {
    conditions.push('project_id = ?')
    params.push(request.projectId)
  }
  params.push(limit + 1, offset)
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, job_id DESC LIMIT ? OFFSET ?`)
    .all(...params) as JobRow[]
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return { jobs: page.map((row) => toJob(row)), hasMore }
}

/** 只给测试/运维用：数一数某状态有多少条（路由不用它）。 */
export function countJobsByStatus(db: ServerDb, workspaceId: WorkspaceId): Readonly<Record<string, number>> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs WHERE workspace_id = ? GROUP BY status').all(workspaceId) as {
    readonly status: string
    readonly n: number
  }[]
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = row.n
  return counts
}

/** 供测试断言"零写入"：某任务的事件行数。 */
export function countJobOutputs(db: ServerDb, jobId: JobId): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM job_outputs WHERE job_id = ?').get(jobId) as { readonly n: number } | undefined
  return row?.n ?? 0
}
