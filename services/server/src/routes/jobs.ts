/**
 * 任务路由（`/api/v1/workspaces/:workspaceId/jobs*`）。
 *
 * ## 鉴权形状（照抄 `routes/sync.ts`，这是硬要求）
 *
 * 每个路由都先挂 `deps.guards.requireWorkspaceAccess({ action })` 做粗筛，
 * 再在处理器内部对**路径上的那个** `workspaceId` 调一次
 * `authorizeWorkspaceAccess(permissionDeps, request, workspaceId, action)`。
 * 两次都要：preHandler 保证未认证请求（401）在读 body 之前就被挡住，
 * 处理器内那次才是"这个主体真的能操作这个工作区"的判定依据。
 *
 * ## 跨工作区一律 404，不用 403
 *
 * 任务不属于路径工作区时返回 `NOT_FOUND_JOB`（404），与 `routes/sync.ts` 里
 * receipts 路由的先例一致：如果别的工作区返回 403、不存在的返回 404，
 * 攻击者就能靠状态码**枚举**出别的工作区里有哪些 jobId。
 * 注意区分两件不同的事：
 * - 主体根本无权访问**工作区** → 由 preHandler 抛 `PERMISSION_DENIED`（403）；
 * - 主体有权访问工作区，但 jobId 不在这个工作区里 → 404。
 *
 * ## 幂等键放在请求体里
 *
 * `Idempotency-Key` 请求头是更"标准"的做法，但本仓先例（`routes/sync.ts` 的
 * `batchId`/`idempotencyKey`）是把键放在请求体，且契约 `WriteContext.idempotencyKey`
 * 也在载荷里。这里只认请求体一个来源：两个来源一旦不一致，就会有"到底以谁为准"
 * 的歧义，歧义在幂等上等于重复执行。
 */

import { ContractError } from '@yfe/contracts'
import type {
  IdempotencyKey,
  Job,
  JobCancelOutput,
  JobId,
  JobStatus,
  JobSubmitOutput,
  RequestId,
  Revision,
  WorkspaceId,
} from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { Principal } from '../auth/permission.js'
import { canonicalByteLength } from '../db/canonical.js'
import { cancelJob, getJobDetail, isJobStatus, listJobs, submitJob } from '../db/jobs.js'
import type { JobRepoDeps } from '../db/jobs.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps } from '../permission/index.js'
import { parseLimit, payloadTooLargeError, requireWellFormedId } from '../sync/protocol.js'
import type { RouteDeps } from './index.js'

/**
 * 任务路由的外部上限。
 *
 * `maxPayloadBytes` 还要和 `config.bodyLimitBytes` 取 `min`：传输层能收下的
 * 上限才是真上限，否则我们会先被 Fastify 413，拿不到带 `detail` 的可执行提示。
 */
export const JOB_LIMITS = {
  /** `payload` 的规范化 JSON 字节上限（256 KiB）。 */
  maxPayloadBytes: 256 * 1024,
  /** `kind` / `executor` / `inputRevision` 的字符串长度上限。 */
  maxFieldLength: 128,
  /** 列表默认/最大条数。 */
  defaultListLimit: 20,
  maxListLimit: 100,
  /** 任务事件（轮询退路）默认/最大条数。 */
  defaultOutputLimit: 200,
  maxOutputLimit: 500,
  /** 取消原因长度上限。 */
  maxCancelReasonLength: 512,
} as const

/**
 * 本模块需要的依赖：`RouteDeps` 的子集（与 `registerSyncRoutes` 的取法一致）。
 *
 * 用 `Pick` 而不是自定义接口，是为了让 `routes/index.ts` 里
 * `registerJobRoutes(app, deps)` 这种"整个 deps 直接传进来"的写法**天然能编译**，
 * 同时测试可以只造这几个字段。
 */
export type JobRouteDeps = Pick<RouteDeps, 'db' | 'policy' | 'now' | 'guards' | 'bodyLimitBytes' | 'log'>

interface SubmitJobBody {
  readonly kind?: string
  readonly executor?: string
  readonly priority?: number
  readonly inputRevision?: string | null
  readonly payload?: Record<string, unknown>
  readonly idempotencyKey?: string
}

interface ListJobsQuery {
  readonly status?: string
  readonly limit?: number
  readonly cursor?: string
}

interface CancelJobBody {
  readonly reason?: string
}

const SUBMIT_JOB_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // 🔴 刻意**不**把 kind/executor 放进 required：schema 失败会统一变成
  // `VALIDATION_FAILED`（见 `http/errors.ts` 的 `contractErrorFromFramework`），
  // 而契约要求"缺字段"报 `VALIDATION_MISSING_FIELD`。所以类型交给 schema、
  // "缺没缺"交给处理器。
  properties: {
    kind: { type: 'string', maxLength: JOB_LIMITS.maxFieldLength },
    executor: { type: 'string', maxLength: JOB_LIMITS.maxFieldLength },
    // 只允许整数：优先级是比较排序键，`1.5` 这种值会静默变成另一个排序。
    priority: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 },
    inputRevision: { type: ['string', 'null'], maxLength: JOB_LIMITS.maxFieldLength },
    // 只允许对象（数组不算 object），`[]`/`"x"`/`3` 会被 ajv 拦成 VALIDATION_FAILED。
    payload: { type: 'object' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const LIST_JOBS_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', minLength: 1, maxLength: 32 },
    // 上限在处理器里用 `parseLimit` 判，好返回带 `{field,max}` 的 400。
    limit: { type: 'integer', minimum: 1 },
    cursor: { type: 'string', minLength: 1, maxLength: 32 },
  },
} as const

const CANCEL_JOB_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: JOB_LIMITS.maxCancelReasonLength },
  },
} as const

/** 路径上的 workspaceId：先做品牌格式校验，再当授权目标。 */
function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  return requireWellFormedId(raw, 'workspaceId', requestId) as WorkspaceId
}

function jobIdOf(request: FastifyRequest, requestId: RequestId): JobId {
  const raw = (request.params as { jobId?: string }).jobId
  return requireWellFormedId(raw, 'jobId', requestId) as JobId
}

function missingField(requestId: RequestId, field: string): ContractError {
  return new ContractError({
    code: 'VALIDATION_MISSING_FIELD',
    message: `缺少必填字段：${field}。`,
    requestId,
    detail: { field },
  })
}

/** 错误 detail 的合法取值形状（与契约 `ErrorPayload.detail` 一致，不能放对象）。 */
type ErrorDetail = Readonly<Record<string, string | number | boolean | null>>

function validationFailed(requestId: RequestId, message: string, detail?: ErrorDetail): ContractError {
  return new ContractError({ code: 'VALIDATION_FAILED', message, requestId, ...(detail === undefined ? {} : { detail }) })
}

/** 非空字符串字段：缺失或全空白都算缺失（全空白会被 SQLite 的 CHECK(length>0) 放过）。 */
function requiredText(value: unknown, field: string, requestId: RequestId, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw missingField(requestId, field)
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `${field} 过长。`,
      requestId,
      detail: { field, max },
    })
  }
  return trimmed
}

/**
 * 任务对外的 JSON 投影。
 *
 * 只输出契约 `Job` 里的字段（外加 `errorCode`，客户端要靠它区分"失败原因"），
 * **绝不**输出 `lease_owner`（worker 身份）、`submitted_by_user_id`（谁提交的）
 * 这类内部字段——客户端要的不是这些，泄漏它们只有风险没有收益。
 * 这里手写映射而不是 `JSON.stringify(row)`：多一个数据库列就会自动多一个对外字段，
 * 那种"顺带泄漏"是这类代码最常见的翻车方式。
 */
function jobView(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    projectId: job.projectId,
    kind: job.kind,
    executor: job.executor,
    status: job.status,
    inputRevision: job.inputRevision,
    configRevision: job.configRevision,
    priority: job.priority,
    attempt: job.attempt,
    checkpoint: job.checkpoint,
    outputRef: job.outputRef,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function principalOf(request: FastifyRequest): Principal {
  // `currentPrincipal` 未认证即抛 401（`AUTH_REQUIRED`）——401 而不是 500。
  return currentPrincipal(request)
}

export function registerJobRoutes(app: FastifyInstance, deps: JobRouteDeps): void {
  const log = deps.log ?? ((): void => {})
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const maxPayloadBytes = Math.min(JOB_LIMITS.maxPayloadBytes, deps.bodyLimitBytes)

  // ------------------------------------------------------------------ 提交
  app.post(
    '/api/v1/workspaces/:workspaceId/jobs',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }), schema: { body: SUBMIT_JOB_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const principal = principalOf(request)
      const body = (request.body ?? {}) as SubmitJobBody
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }

      const kind = requiredText(body.kind, 'kind', requestId, JOB_LIMITS.maxFieldLength)
      const executor = requiredText(body.executor, 'executor', requestId, JOB_LIMITS.maxFieldLength)

      const payload: Readonly<Record<string, unknown>> = body.payload ?? {}
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw validationFailed(requestId, 'payload 必须是 JSON 对象。', { field: 'payload' })
      }
      const bytes = canonicalByteLength(payload)
      if (bytes > maxPayloadBytes) {
        throw payloadTooLargeError(requestId, { limit: 'payloadJsonBytes', max: maxPayloadBytes, actual: bytes })
      }

      let inputRevision: Revision | null = null
      if (body.inputRevision !== undefined && body.inputRevision !== null) {
        inputRevision = requiredText(body.inputRevision, 'inputRevision', requestId, JOB_LIMITS.maxFieldLength) as Revision
      }

      let idempotencyKey: IdempotencyKey | null = null
      if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
        idempotencyKey = requiredText(body.idempotencyKey, 'idempotencyKey', requestId, 128) as IdempotencyKey
      }

      const result = submitJob(
        deps.db,
        {
          workspaceId,
          kind,
          executor,
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          inputRevision,
          payload,
          idempotencyKey,
          submittedByUserId: principal.userId,
          submittedByDeviceId: principal.deviceId,
        },
        repoDeps,
      )

      const output: JobSubmitOutput = { jobId: result.jobId }
      log({
        level: 'info',
        event: result.created ? 'job.submitted' : 'job.submitted.replayed',
        requestId,
        workspaceId,
        jobId: result.jobId,
      })
      // 幂等重放返回 200：这次调用**没有**创建任何东西，201 会让重试的客户端
      // 以为多了一个任务（HTTP 的语义在这里是给重试逻辑看的）。
      return reply
        .status(result.created ? 201 : 200)
        .header('cache-control', 'no-store')
        .send(output)
    },
  )

  // ------------------------------------------------------------------ 列表
  app.get(
    '/api/v1/workspaces/:workspaceId/jobs',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: LIST_JOBS_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const query = request.query as ListJobsQuery
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }

      const limit = parseLimit(query.limit, 'limit', JOB_LIMITS.defaultListLimit, JOB_LIMITS.maxListLimit, requestId)

      let statuses: readonly JobStatus[] | null = null
      if (query.status !== undefined) {
        if (!isJobStatus(query.status)) {
          throw validationFailed(requestId, 'status 不是合法的任务状态。', { field: 'status' })
        }
        statuses = [query.status]
      }

      // 游标是**偏移量**的十进制表示，不是可长期持有的位置。任务列表按
      // `created_at DESC, job_id DESC` 排序，翻页期间新提交的任务会让后续页
      // 整体后移——列表页能接受，但客户端不应该拿它做增量同步（增量同步用事件流）。
      let offset = 0
      if (query.cursor !== undefined) {
        if (!/^\d{1,10}$/.test(query.cursor)) {
          throw new ContractError({
            code: 'VALIDATION_OUT_OF_RANGE',
            message: 'cursor 必须是非负整数。',
            requestId,
            detail: { field: 'cursor', min: 0 },
          })
        }
        offset = Number.parseInt(query.cursor, 10)
      }

      const page = listJobs(deps.db, { workspaceId, status: statuses, limit, offset }, repoDeps)
      const nextOffset = offset + page.jobs.length
      return reply.status(200).header('cache-control', 'no-store').send({
        items: page.jobs.map(jobView),
        nextCursor: page.hasMore ? String(nextOffset) : null,
        hasMore: page.hasMore,
      })
    },
  )

  // ------------------------------------------------------------------ 详情
  app.get(
    '/api/v1/workspaces/:workspaceId/jobs/:jobId',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const jobId = jobIdOf(request, requestId)
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }

      const detail = getJobDetail(deps.db, jobId, repoDeps)
      if (detail === null || detail.job.workspaceId !== workspaceId) {
        // 不存在与"属于别的工作区"返回同一个东西：见文件头。
        throw new ContractError({ code: 'NOT_FOUND_JOB', message: '任务不存在。', requestId, detail: { jobId } })
      }

      return reply.status(200).header('cache-control', 'no-store').send({
        ...jobView(detail.job),
        maxAttempts: detail.maxAttempts,
        payload: detail.payload,
        errorCode: detail.errorCode,
        cancelRequestedAt: detail.cancelRequestedAt,
        cancelReason: detail.cancelReason,
      })
    },
  )

  // ------------------------------------------------------------------ 取消
  app.post(
    '/api/v1/workspaces/:workspaceId/jobs/:jobId/cancel',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }), schema: { body: CANCEL_JOB_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const jobId = jobIdOf(request, requestId)
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }
      const body = (request.body ?? {}) as CancelJobBody

      const existing = getJobDetail(deps.db, jobId, repoDeps)
      if (existing === null || existing.job.workspaceId !== workspaceId) {
        throw new ContractError({ code: 'NOT_FOUND_JOB', message: '任务不存在。', requestId, detail: { jobId } })
      }

      const result = cancelJob(deps.db, { jobId, reason: body.reason ?? null }, repoDeps)
      const output: JobCancelOutput = { status: result.status }
      log({ level: 'info', event: 'job.cancel_requested', requestId, workspaceId, jobId, status: result.status })
      return reply.status(200).header('cache-control', 'no-store').send(output)
    },
  )
}
