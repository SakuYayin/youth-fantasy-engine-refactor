/**
 * 任务输出 / 任务事件流路由。
 *
 * ## 两条路，一个数据源（这是"不丢事件"的全部秘密）
 *
 * - **轮询退路**：`GET .../jobs/:jobId/outputs?since=<seq>` 直接读 `job_outputs`
 *   （`seq` 是**任务内**严格递增的序号，见 `db/jobs.ts` 的 `appendJobOutput`）。
 * - **SSE**：`GET .../events` 也读 `job_outputs`，只是换成**工作区级**的事件序号
 *   （`job_outputs` 的隐式 rowid，全局单调递增），支持 `Last-Event-ID` 续传。
 *
 * 事件不放进内存广播队列、也不写 `change_feed`：`change_feed` 是文档同步游标的
 * 来源，任务事件混进去会让客户端把"任务进度"当成"文档变更"。
 * `job_outputs` 是持久表，所以客户端**任何时刻**都能靠 `since`/`Last-Event-ID`
 * 把断线期间的事件补齐——SSE 断了不会永久丢事件，最多是晚一点到手。
 *
 * ## SSE 的实现取舍（**有界增量流**，不是无限长连接）
 *
 * 这里没有做"永不结束的响应 + 心跳 timer"：
 * 应用层框架（Fastify）在 `reply.send()` 之后就没有"主动再推一条"的原生时机，
 * 硬做要么持有 socket 手写 frame、要么加一个进程内 pub/sub（多实例下还要外部
 * broker），这两条路都超出本模块的改动面，也无法在 `app.inject()` 下确定性测试。
 *
 * 所以 `/events` 是**有界**的：连接后立刻补发 `> since` 的增量，
 * 然后按 `maxPolls`/`pollIntervalMs` 做**有界轮询**（每轮之间发 `: keep-alive`），
 * 最后发一条 `event: end` 收线。客户端（EventSource/fetch）按 `id:` 记住位置，
 * 断了就带着 `Last-Event-ID` 重连——语义与"无限长连接"等价，
 * 代价是固定间隔的重连（`retry:` 已声明为 1s）。
 */

import { ContractError } from '@yfe/contracts'
import type { JobId, RequestId, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'

import { getJobDetail, listJobEvents, listJobOutputs } from '../db/jobs.js'
import type { JobOutputRecord, JobRepoDeps, JobStreamEvent } from '../db/jobs.js'
import { authorizeWorkspaceAccess } from '../permission/index.js'
import type { PermissionDeps } from '../permission/index.js'
import { parseLimit, requireWellFormedId } from '../sync/protocol.js'
import { JOB_LIMITS } from './jobs.js'
import type { JobRouteDeps } from './jobs.js'

/** 事件流的边界（全部有上限：一个连接不可能把服务端钉死）。 */
export const JOB_EVENT_LIMITS = {
  /** 单次连接最多补发/推送的事件条数。 */
  defaultStreamLimit: 200,
  maxStreamLimit: 500,
  /** 单次连接最多的轮询轮数（1 = 只补发一次就收线）。 */
  defaultStreamPolls: 1,
  maxStreamPolls: 30,
  /** 轮询间隔上限：把一条连接的最长占用时间钉在 `maxPolls × maxPollIntervalMs`。 */
  defaultPollIntervalMs: 500,
  maxPollIntervalMs: 1_000,
  /** SSE `retry:`：客户端断线后的重连间隔。 */
  streamRetryMs: 1_000,
} as const

interface OutputsQuery {
  readonly since?: number
  readonly limit?: number
}

interface EventStreamQuery {
  readonly since?: number
  readonly jobId?: string
  readonly limit?: number
  readonly maxPolls?: number
  readonly pollIntervalMs?: number
}

const OUTPUTS_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /**
     * `since` 是**任务内**序号，语义是「我已经看到 seq 了，给我更大的」。
     * 任务的第一个事件 seq = 0（提交时的 queued 状态事件），所以缺省值必须是
     * `-1`——只有 `-1` 能表达「从头开始」，缺省 0 会让首个事件永远取不到。
     */
    since: { type: 'integer', minimum: -1 },
    limit: { type: 'integer', minimum: 1 },
  },
} as const

const EVENT_STREAM_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since: { type: 'integer', minimum: 0 },
    jobId: { type: 'string', minLength: 1, maxLength: 128 },
    limit: { type: 'integer', minimum: 1 },
    maxPolls: { type: 'integer', minimum: 1 },
    pollIntervalMs: { type: 'integer', minimum: 0 },
  },
} as const

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  return requireWellFormedId(raw, 'workspaceId', requestId) as WorkspaceId
}

function jobIdOf(request: FastifyRequest, requestId: RequestId): JobId {
  const raw = (request.params as { jobId?: string }).jobId
  return requireWellFormedId(raw, 'jobId', requestId) as JobId
}

/**
 * 非负整数序号解析（`Last-Event-ID` 请求头是**客户端可控**的字符串，
 * 必须当成不可信输入解析，不能直接拼进 SQL）。
 */
function parseSeq(value: unknown, field: string, fallback: number, requestId: RequestId): number {
  if (value === undefined || value === null || value === '') return fallback
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,15}$/.test(text)) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `${field} 必须是非负整数。`,
      requestId,
      detail: { field, min: 0 },
    })
  }
  const parsed = Number.parseInt(text, 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `${field} 超出可表示范围。`,
      requestId,
      detail: { field, min: 0, max: Number.MAX_SAFE_INTEGER },
    })
  }
  return parsed
}

/** 任务必须存在且属于路径工作区，否则 404（理由见 `routes/jobs.ts` 文件头）。 */
function requireJobInWorkspace(deps: JobRouteDeps, jobId: JobId, workspaceId: WorkspaceId, requestId: RequestId): void {
  const detail = getJobDetail(deps.db, jobId, { now: deps.now, requestId })
  if (detail === null || detail.job.workspaceId !== workspaceId) {
    throw new ContractError({ code: 'NOT_FOUND_JOB', message: '任务不存在。', requestId, detail: { jobId } })
  }
}

function outputView(record: JobOutputRecord): Record<string, unknown> {
  return { seq: record.seq, kind: record.kind, payload: record.payload, createdAt: record.createdAt }
}

function eventData(event: JobStreamEvent): string {
  return JSON.stringify({
    eventSeq: event.eventSeq,
    jobId: event.jobId,
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

export function registerJobEventRoutes(app: FastifyInstance, deps: JobRouteDeps): void {
  const log = deps.log ?? ((): void => {})
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }

  // ------------------------------------------------------- 轮询退路（任务输出）
  app.get(
    '/api/v1/workspaces/:workspaceId/jobs/:jobId/outputs',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: OUTPUTS_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const jobId = jobIdOf(request, requestId)
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }
      requireJobInWorkspace(deps, jobId, workspaceId, requestId)

      const query = request.query as OutputsQuery
      // 缺省 `-1` = 从头开始（seq > -1 即包含 seq 0）。
      const since = query.since === undefined ? -1 : query.since
      const limit = parseLimit(query.limit, 'limit', JOB_LIMITS.defaultOutputLimit, JOB_LIMITS.maxOutputLimit, requestId)

      const page = listJobOutputs(deps.db, { jobId, sinceSeq: since, limit }, repoDeps)
      const last = page.items.length > 0 ? page.items[page.items.length - 1] : undefined
      return reply.status(200).header('cache-control', 'no-store').send({
        jobId,
        since,
        // `nextSince` 在"本次没拉到任何东西"时**原样返回 since**：客户端可以无脑
        // 用同一个游标反复轮询，而不会因为拿到 null 就以为"到此为止"。
        nextSince: last === undefined ? since : last.seq,
        hasMore: page.hasMore,
        items: page.items.map(outputView),
      })
    },
  )

  // --------------------------------------------------------------- SSE 事件流
  app.get(
    '/api/v1/workspaces/:workspaceId/events',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: EVENT_STREAM_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const repoDeps: JobRepoDeps = { now: deps.now, requestId }
      const query = request.query as EventStreamQuery

      // 🔴 `Last-Event-ID` 优先于 `?since=`：浏览器重连时会自动带上它，
      // 它才是客户端**真实的**续传位置；URL 里的 since 是首次连接的起点。
      // 两者都在时以请求头为准，否则重连会把已经推过的事件再推一遍。
      const headerValue = request.headers['last-event-id']
      const since = parseSeq(headerValue, 'Last-Event-ID', parseSeq(query.since, 'since', 0, requestId), requestId)

      const limit = parseLimit(
        query.limit,
        'limit',
        JOB_EVENT_LIMITS.defaultStreamLimit,
        JOB_EVENT_LIMITS.maxStreamLimit,
        requestId,
      )
      const maxPolls = Math.min(query.maxPolls ?? JOB_EVENT_LIMITS.defaultStreamPolls, JOB_EVENT_LIMITS.maxStreamPolls)
      const pollIntervalMs = Math.min(
        query.pollIntervalMs ?? JOB_EVENT_LIMITS.defaultPollIntervalMs,
        JOB_EVENT_LIMITS.maxPollIntervalMs,
      )

      let jobIdFilter: JobId | null = null
      if (query.jobId !== undefined) {
        jobIdFilter = requireWellFormedId(query.jobId, 'jobId', requestId) as JobId
        // 过滤一个不属于本工作区的 jobId 直接 404：否则"有没有这个 jobId"
        // 会通过"事件流是否静默"泄出去。
        requireJobInWorkspace(deps, jobIdFilter, workspaceId, requestId)
      }

      async function* frames(): AsyncGenerator<string> {
        yield `retry: ${JOB_EVENT_LIMITS.streamRetryMs}\n\n`
        let cursor = since
        for (let poll = 0; poll < maxPolls; poll += 1) {
          try {
            // 长连接跨越多个事件循环；会话、账号和成员资格必须按当前状态重查。
            request.yfeNow = deps.now()
            await deps.guards.requireSession(request, reply)
            authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
          } catch (error) {
            if (!(error instanceof ContractError)) throw error
            yield `event: error\ndata: ${JSON.stringify({ code: error.code, requestId })}\n\n`
            return
          }
          const page = listJobEvents(
            deps.db,
            { workspaceId, sinceEventSeq: cursor, jobId: jobIdFilter, limit },
            repoDeps,
          )
          for (const item of page.items) {
            cursor = item.eventSeq
            // `id:` 是事件序号（十进制）：客户端下次带 `Last-Event-ID: <它>` 即可续传。
            yield `id: ${item.eventSeq}\nevent: job-output\ndata: ${eventData(item)}\n\n`
          }
          if (poll + 1 >= maxPolls) break
          if (page.items.length >= limit) continue // 还有积压：立刻再拉一轮，不等
          if (pollIntervalMs > 0) await delay(pollIntervalMs)
          yield ': keep-alive\n\n'
        }
        // 有界流收线：告诉客户端"这一轮到此为止"，新的位置在 data 里。
        yield `event: end\ndata: ${JSON.stringify({ since: cursor })}\n\n`
      }

      log({ level: 'info', event: 'job.events.stream_opened', requestId, workspaceId, since, maxPolls })

      return reply
        .status(200)
        .type('text/event-stream; charset=utf-8')
        .header('cache-control', 'no-store, no-transform')
        .header('connection', 'keep-alive')
        // 反向代理（nginx）默认会缓冲整个响应，SSE 会因此变成"最后一次性到达"。
        .header('x-accel-buffering', 'no')
        .send(Readable.from(frames(), { objectMode: false }))
    },
  )
}
