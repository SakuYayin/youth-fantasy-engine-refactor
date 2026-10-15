/**
 * 任务仓储、状态机、租约与运行器的验收测试。
 *
 * ## 装置
 *
 * 直接用 `createServer()` 的**完整**路由装配（`routes/index.ts` 已注册 jobs 与 events
 * 路由），**不要**再自己 `registerJobRoutes()`：同一 method+url 注册两次会抛
 * `FST_ERR_ROUTE_ALREADY_DECLARED`（装配完成前的老写法就是这么踩的，见台账 R-39）。
 * 跑的是真钩子、真错误映射、真数据库。
 *
 * ## 时钟
 *
 * 所有时间都来自 `testClock()`，库里**没有**用 `datetime('now')`，
 * 所以"租约到期""重试上限"这类断言是确定性的，不是靠 sleep 撞出来的。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ContractError, newIds } from '@yfe/contracts'
import type { JobId, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import type { SessionPolicy } from '../src/auth/session.js'
import {
  cancelJob,
  claimJob,
  completeJob,
  countJobOutputs,
  failJob,
  heartbeatJob,
  submitJob,
} from '../src/db/jobs.js'
import type { JobRepoDeps } from '../src/db/jobs.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { createJobRunner } from '../src/queue/index.js'
import { seedOwner, testClock } from './helpers.js'
import type { TestClock } from './helpers.js'
import { countRows, loginAs } from './syncHelpers.js'

const POLICY: SessionPolicy = { ...DEFAULT_SESSION_POLICY, cookieSecure: false }
const SERVER_ID = 'srv_jobs_test'
const JOB_KIND = 'chapter.draft'
const JOB_EXECUTOR = 'ai.writer'
const T0 = '2026-01-01T00:00:00.000Z'

interface JobsHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  close(): void
}

const harnesses: JobsHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
})

async function makeJobsHarness(): Promise<JobsHarness> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
    const clock = testClock()
    const config = defaultServerConfig({ sessionPolicy: POLICY })
    ensureServerState(db, SERVER_ID, null)
    // 走**完整**路由装配（`routes/index.ts`）：jobs 路由已在其中，**不要**再自注册
    // （同一 method+url 注册两次会抛 `FST_ERR_ROUTE_ALREADY_DECLARED`）。
    const app = createServer({ config, db, serverId: SERVER_ID, clock, logger: false })
    await app.ready()
    const harness: JobsHarness = {
      app,
      db,
      clock,
      close: () => {
        closeServerDatabase(db)
      },
    }
    harnesses.push(harness)
    return harness
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }
}

function repoDeps(clock: TestClock): JobRepoDeps {
  return { now: () => clock.now(), requestId: newIds.request() }
}

/** 错误码断言：非 `ContractError` 的抛出也要显形，不能被"碰巧没抛"糊过去。 */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof ContractError ? error.code : `UNEXPECTED:${String(error)}`
  }
  return 'NO_THROW'
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`期望 ${what} 非空，实际是 ${String(value)}`)
  return value
}

/** 整行快照：用来断言"非法操作零写入"（比逐个字段比对更难糊弄）。 */
function jobRow(db: ServerDb, jobId: JobId): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined
  if (row === undefined) throw new Error(`任务行不存在：${jobId}`)
  return row
}

function field(db: ServerDb, jobId: JobId, column: string): unknown {
  return jobRow(db, jobId)[column]
}

function jobsUrl(workspaceId: WorkspaceId): string {
  return `/api/v1/workspaces/${workspaceId}/jobs`
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, 5)
    })
  }
}

// ---------------------------------------------------------------------------
// 提交：幂等与校验
// ---------------------------------------------------------------------------

describe('POST /jobs：幂等提交', () => {
  it('同 (workspace, idempotencyKey) 提交两次 → 同一个 jobId，库里只有一行', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const body = {
      kind: JOB_KIND,
      executor: JOB_EXECUTOR,
      payload: { prompt: '写第一章' },
      idempotencyKey: 'idem-1',
    }

    const first = await h.app.inject({ method: 'POST', url: jobsUrl(workspaceId), headers, payload: body })
    expect(first.statusCode).toBe(201)
    const jobId = first.json<{ jobId: JobId }>().jobId

    const second = await h.app.inject({ method: 'POST', url: jobsUrl(workspaceId), headers, payload: body })
    // 重放没有创建任何东西，所以不是 201（201 会让重试的客户端以为多了一个任务）。
    expect(second.statusCode).toBe(200)
    expect(second.json<{ jobId: JobId }>().jobId).toBe(jobId)

    expect(countRows(h.db, 'jobs')).toBe(1)
    // 提交本身是一条可见事件：SSE 与轮询退路都能看到"已入队"。
    expect(countJobOutputs(h.db, jobId)).toBe(1)
    expect(jobRow(h.db, jobId)['status']).toBe('queued')
  })

  it('同 key 不同 payload → IDEMPOTENCY_KEY_REUSED，且原任务一个字都没被改写', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    const first = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: { prompt: '原始提示词' }, idempotencyKey: 'idem-2' },
    })
    expect(first.statusCode).toBe(201)
    const jobId = first.json<{ jobId: JobId }>().jobId
    const before = jobRow(h.db, jobId)

    const conflict = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: { prompt: '完全不同的提示词' }, idempotencyKey: 'idem-2' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(countRows(h.db, 'jobs')).toBe(1)
    expect(jobRow(h.db, jobId)).toEqual(before)
  })

  it('同 key 换了 executor 也是同一把键的冲突', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)
    const payload = { kind: JOB_KIND, payload: {}, idempotencyKey: 'idem-3' }

    await h.app.inject({ method: 'POST', url, headers, payload: { ...payload, executor: 'ai.writer' } })
    const conflict = await h.app.inject({ method: 'POST', url, headers, payload: { ...payload, executor: 'ai.summarizer' } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('同 key 且 payload 只是键顺序不同 → 不算冲突（按规范化摘要判定）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    const first = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: { a: 1, b: 2 }, idempotencyKey: 'idem-4' },
    })
    expect(first.statusCode).toBe(201)
    const jobId = first.json<{ jobId: JobId }>().jobId

    // 同样的载荷、不同的书写顺序：语义相同，必须判定为同一次提交。
    const replay = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: { b: 2, a: 1 }, idempotencyKey: 'idem-4' },
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json<{ jobId: JobId }>().jobId).toBe(jobId)
    expect(countRows(h.db, 'jobs')).toBe(1)
    // 落库的是规范化 JSON（键有序），所以摘要重算在任何时候都一样。
    expect(field(h.db, jobId, 'payload_json')).toBe('{"a":1,"b":2}')
  })

  it('不同 key → 另一个任务', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    const a = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, idempotencyKey: 'idem-a' },
    })
    const b = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, idempotencyKey: 'idem-b' },
    })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.json<{ jobId: JobId }>().jobId).not.toBe(a.json<{ jobId: JobId }>().jobId)
    expect(countRows(h.db, 'jobs')).toBe(2)
  })
})

describe('POST /jobs：字段校验', () => {
  it('kind / executor 缺失 → VALIDATION_MISSING_FIELD', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    const noKind = await h.app.inject({ method: 'POST', url, headers, payload: { executor: JOB_EXECUTOR, payload: {} } })
    expect(noKind.statusCode).toBe(400)
    expect(noKind.json<{ code: string }>().code).toBe('VALIDATION_MISSING_FIELD')
    expect(noKind.json<{ detail?: { field?: string } }>().detail?.field).toBe('kind')

    const noExecutor = await h.app.inject({ method: 'POST', url, headers, payload: { kind: JOB_KIND, payload: {} } })
    expect(noExecutor.statusCode).toBe(400)
    expect(noExecutor.json<{ code: string }>().code).toBe('VALIDATION_MISSING_FIELD')

    expect(countRows(h.db, 'jobs')).toBe(0)
  })

  it('kind 只有空白字符 → VALIDATION_MISSING_FIELD（不能被 CHECK(length>0) 放过）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)

    const res = await h.app.inject({
      method: 'POST',
      url: jobsUrl(workspaceId),
      headers,
      payload: { kind: '   ', executor: JOB_EXECUTOR, payload: {} },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_MISSING_FIELD')
  })

  it('payload 不是对象 → VALIDATION_FAILED', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    for (const bad of [[], 'not-an-object', 3, null]) {
      const res = await h.app.inject({
        method: 'POST',
        url,
        headers,
        payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: bad },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
    }
    expect(countRows(h.db, 'jobs')).toBe(0)
  })

  it('未知字段 / 非法 priority → 400（不给多余字段留后门）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const url = jobsUrl(workspaceId)

    const extra = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, leaseOwner: 'attacker' },
    })
    expect(extra.statusCode).toBe(400)
    expect(extra.json<{ code: string }>().code).toBe('VALIDATION_FAILED')

    const floatPriority = await h.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, priority: 1.5 },
    })
    expect(floatPriority.statusCode).toBe(400)
    expect(floatPriority.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('inputRevision 落库并可回读', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)

    const created = await h.app.inject({
      method: 'POST',
      url: jobsUrl(workspaceId),
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, inputRevision: 'r1a' },
    })
    expect(created.statusCode).toBe(201)
    const jobId = created.json<{ jobId: JobId }>().jobId
    expect(field(h.db, jobId, 'input_revision')).toBe('r1a')

    const detail = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}/${jobId}`, headers })
    expect(detail.json<{ inputRevision: string | null }>().inputRevision).toBe('r1a')
  })
})

// ---------------------------------------------------------------------------
// 租约
// ---------------------------------------------------------------------------

describe('租约：领取 / 心跳 / 过期重领', () => {
  it('领取写 lease_owner / lease_expires_at / started_at，并让 attempt 自增', async () => {
    const h = await makeJobsHarness()
    const at = h.clock.now()
    const { userId, workspaceId } = await seedOwner(h.db, at)
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )

    const claim = must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), '领取结果')
    expect(claim.job.id).toBe(jobId)
    expect(claim.attempt).toBe(1)
    expect(claim.lease.leaseToken).toBe('worker-a')
    expect(claim.lease.leasedAt).toBe(at)
    expect(claim.lease.expiresAt).toBe('2026-01-01T00:00:30.000Z')
    expect(claim.lease.heartbeatIntervalMs).toBe(10_000)

    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'running',
      attempt: 1,
      lease_owner: 'worker-a',
      lease_expires_at: '2026-01-01T00:00:30.000Z',
      started_at: T0,
      updated_at: T0,
      finished_at: null,
    })
  })

  it('租约未过期时第二个 worker 领不到；到期后可重新领取且 attempt 自增', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )

    const first = must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    expect(first.attempt).toBe(1)

    // 还差 1 毫秒到期：领不到。
    h.clock.advance(29_999)
    expect(claimJob(h.db, { owner: 'worker-b', leaseMs: 30_000 }, deps)).toBeNull()
    expect(jobRow(h.db, jobId)['lease_owner']).toBe('worker-a')

    // 到点（lease_expires_at <= now）：租约失效，可以被另一个 worker 抢走。
    h.clock.advance(1)
    const second = must(claimJob(h.db, { owner: 'worker-b', leaseMs: 30_000 }, deps), 'worker-b 的领取')
    expect(second.job.id).toBe(jobId)
    expect(second.attempt).toBe(2)
    expect(second.lease.leaseToken).toBe('worker-b')
    expect(second.lease.leasedAt).toBe('2026-01-01T00:00:30.000Z')
    expect(second.lease.expiresAt).toBe('2026-01-01T00:01:00.000Z')

    const row = jobRow(h.db, jobId)
    expect(row).toMatchObject({
      status: 'running',
      attempt: 2,
      lease_owner: 'worker-b',
      // started_at 是"第一次被领取"的时刻，重新领取不重置它。
      started_at: T0,
      updated_at: '2026-01-01T00:00:30.000Z',
    })
  })

  it('领取顺序：priority DESC, created_at ASC', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const submit = (priority: number): JobId =>
      submitJob(
        h.db,
        { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, priority, submittedByUserId: userId },
        deps,
      ).jobId

    const low = submit(0)
    const high = submit(10)
    const mid = submit(5)

    const claimed = [
      must(claimJob(h.db, { owner: 'w', leaseMs: 30_000 }, deps), '第一次领取').job.id,
      must(claimJob(h.db, { owner: 'w', leaseMs: 30_000 }, deps), '第二次领取').job.id,
      must(claimJob(h.db, { owner: 'w', leaseMs: 30_000 }, deps), '第三次领取').job.id,
    ]
    expect(claimed).toEqual([high, mid, low])
    expect(claimJob(h.db, { owner: 'w', leaseMs: 30_000 }, deps)).toBeNull()
  })

  it('心跳：只有持有者能续租；非持有者 / 已过期 → RESOURCE_LOCKED', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')

    h.clock.advance(10_000)
    const renewed = heartbeatJob(h.db, { jobId, owner: 'worker-a', leaseMs: 30_000 }, deps)
    expect(renewed.expiresAt).toBe('2026-01-01T00:00:40.000Z')
    expect(field(h.db, jobId, 'lease_expires_at')).toBe('2026-01-01T00:00:40.000Z')
    expect(field(h.db, jobId, 'updated_at')).toBe('2026-01-01T00:00:10.000Z')

    // 不是持有者：不能续别人的租约。
    expect(codeOf(() => heartbeatJob(h.db, { jobId, owner: 'worker-b', leaseMs: 30_000 }, deps))).toBe('RESOURCE_LOCKED')
    // 已到期：过期的租约不是你的租约（否则两个 worker 会同时以为自己持有它）。
    h.clock.advance(30_000)
    expect(codeOf(() => heartbeatJob(h.db, { jobId, owner: 'worker-a', leaseMs: 30_000 }, deps))).toBe('RESOURCE_LOCKED')
    expect(field(h.db, jobId, 'lease_expires_at')).toBe('2026-01-01T00:00:40.000Z')
  })

  it('终态任务不可续租（STATE_INVALID_TRANSITION）且零写入', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    completeJob(h.db, { jobId }, deps)
    const before = jobRow(h.db, jobId)

    expect(codeOf(() => heartbeatJob(h.db, { jobId, owner: 'worker-a', leaseMs: 30_000 }, deps))).toBe(
      'STATE_INVALID_TRANSITION',
    )
    expect(jobRow(h.db, jobId)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 状态机 / 终态
// ---------------------------------------------------------------------------

describe('状态机：非法迁移零写入', () => {
  it('queued 任务直接 completeJob → STATE_INVALID_TRANSITION，整行不变', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const before = jobRow(h.db, jobId)
    const outputsBefore = countJobOutputs(h.db, jobId)

    expect(codeOf(() => completeJob(h.db, { jobId, result: { text: '不该存在的结果' } }, deps))).toBe(
      'STATE_INVALID_TRANSITION',
    )
    expect(jobRow(h.db, jobId)).toEqual(before)
    expect(countJobOutputs(h.db, jobId)).toBe(outputsBefore)
    expect(field(h.db, jobId, 'result_json')).toBeNull()
  })

  it('queued 任务直接 failJob 是合法迁移（契约 JOB_TRANSITIONS.queued 含 failed）', async () => {
    // ⚠️ 这里**不能**断言抛出：`packages/contracts/src/jobs/index.ts:30` 的
    // `JOB_TRANSITIONS.queued = ['running','cancelling','paused','failed']` 明确允许
    // queued → failed（派发前就被判失败的任务，例如执行器不可用/载荷不合法）。
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )

    const failed = failJob(h.db, { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '派发前失败' }, deps)
    expect(failed.status).toBe('failed')
    expect(field(h.db, jobId, 'error_message')).toBe('派发前失败')
    expect(field(h.db, jobId, 'finished_at')).not.toBeNull()
  })

  it('终态任务再 failJob → STATE_INVALID_TRANSITION，整行不变', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    failJob(h.db, { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '第一次失败' }, deps)
    const before = jobRow(h.db, jobId)
    const outputsBefore = countJobOutputs(h.db, jobId)

    expect(
      codeOf(() =>
        failJob(h.db, { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '不该覆盖第一次' }, deps),
      ),
    ).toBe('STATE_INVALID_TRANSITION')
    expect(jobRow(h.db, jobId)).toEqual(before)
    expect(field(h.db, jobId, 'error_message')).toBe('第一次失败')
    expect(countJobOutputs(h.db, jobId)).toBe(outputsBefore)
  })

  it('succeeded 之后：不可领取、再取消 → already-terminal、再完成 → 非法迁移且零写入', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    const done = completeJob(h.db, { jobId, result: { text: '第一章' } }, deps)
    expect(done.status).toBe('succeeded')

    // 终态不可被领取——即使租约已经过期。
    h.clock.advance(120_000)
    expect(claimJob(h.db, { owner: 'worker-b', leaseMs: 30_000 }, deps)).toBeNull()

    const before = jobRow(h.db, jobId)
    expect(before['lease_owner']).toBeNull()

    // 终态取消：回 already-terminal（不是错误，取消本来就是幂等的）。
    const cancel = cancelJob(h.db, { jobId, reason: '太晚了' }, deps)
    expect(cancel.status).toBe('already-terminal')
    expect(jobRow(h.db, jobId)).toEqual(before)

    expect(codeOf(() => completeJob(h.db, { jobId }, deps))).toBe('STATE_INVALID_TRANSITION')
    expect(codeOf(() => failJob(h.db, { jobId, errorCode: 'JOB_CANCELLED', errorMessage: 'x' }, deps))).toBe(
      'STATE_INVALID_TRANSITION',
    )
    expect(jobRow(h.db, jobId)).toEqual(before)
    expect(JSON.parse(String(field(h.db, jobId, 'result_json')))).toEqual({ text: '第一章' })
  })

  it('cancelled 之后同样不可领取', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    expect(cancelJob(h.db, { jobId }, deps).status).toBe('cancelled')
    h.clock.advance(10_000)
    expect(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps)).toBeNull()
  })

  it('不存在的任务：写操作抛 NOT_FOUND_JOB；空队列领取返回 null 而不是抛错', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const ghost = newIds.job()

    expect(codeOf(() => claimJob(h.db, { owner: 'w', leaseMs: 1_000, workspaceId }, deps))).toBe('NO_THROW')
    expect(claimJob(h.db, { owner: 'w', leaseMs: 1_000, workspaceId }, deps)).toBeNull()
    expect(codeOf(() => completeJob(h.db, { jobId: ghost }, deps))).toBe('NOT_FOUND_JOB')
    expect(codeOf(() => cancelJob(h.db, { jobId: ghost }, deps))).toBe('NOT_FOUND_JOB')
    expect(codeOf(() => failJob(h.db, { jobId: ghost, errorCode: 'X', errorMessage: 'y' }, deps))).toBe('NOT_FOUND_JOB')
  })
})

// ---------------------------------------------------------------------------
// 租约栅栏（fencing）：迟到的回报不能改写别人的任务
// ---------------------------------------------------------------------------

describe('租约栅栏：迟到的终态回报被 RESOURCE_LOCKED 拦下', () => {
  async function claimingHarness(owner: string, leaseMs = 30_000) {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const claim = must(claimJob(h.db, { owner, leaseMs }, deps), `${owner} 的领取`)
    return { h, deps, jobId, attempt: claim.attempt }
  }

  it('租约过期被重领后，原 worker 的 completeJob → RESOURCE_LOCKED 且整行不变', async () => {
    const { h, deps, jobId, attempt } = await claimingHarness('worker-a', 10_000)
    // worker-a 还在跑，租约到期 → worker-b 领走同一条任务（attempt 变 2）。
    h.clock.advance(10_000)
    const stolen = must(claimJob(h.db, { owner: 'worker-b', leaseMs: 10_000 }, deps), 'worker-b 的领取')
    expect(stolen.attempt).toBe(2)
    const before = jobRow(h.db, jobId)
    const outputsBefore = countJobOutputs(h.db, jobId)

    expect(
      codeOf(() => completeJob(h.db, { jobId, leaseOwner: 'worker-a', attempt, result: { text: '迟到的产物' } }, deps)),
    ).toBe('RESOURCE_LOCKED')
    // 没有栅栏的话这里会被写成 succeeded：同一条任务跑两遍、产物互相覆盖。
    expect(jobRow(h.db, jobId)).toEqual(before)
    expect(countJobOutputs(h.db, jobId)).toBe(outputsBefore)
    expect(field(h.db, jobId, 'result_json')).toBeNull()

    // 真正的持有者仍然能正常收尾。
    const done = completeJob(h.db, { jobId, leaseOwner: 'worker-b', attempt: stolen.attempt }, deps)
    expect(done.status).toBe('succeeded')
  })

  it('原 worker 的迟到 failJob 不会把别人的任务判死', async () => {
    const { h, deps, jobId, attempt } = await claimingHarness('worker-a', 10_000)
    h.clock.advance(10_000)
    const stolen = must(claimJob(h.db, { owner: 'worker-b', leaseMs: 10_000 }, deps), 'worker-b 的领取')
    const before = jobRow(h.db, jobId)

    expect(
      codeOf(() =>
        failJob(h.db, { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '迟到的失败', leaseOwner: 'worker-a', attempt }, deps),
      ),
    ).toBe('RESOURCE_LOCKED')
    expect(jobRow(h.db, jobId)).toEqual(before)
    expect(field(h.db, jobId, 'error_message')).toBeNull()

    const failed = failJob(
      h.db,
      { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '真的失败', leaseOwner: 'worker-b', attempt: stolen.attempt },
      deps,
    )
    expect(failed.status).toBe('failed')
    expect(field(h.db, jobId, 'error_message')).toBe('真的失败')
  })

  it('attempt 不匹配 → RESOURCE_LOCKED（同一个 owner 名重用也要拦）', async () => {
    const { h, deps, jobId, attempt } = await claimingHarness('worker-a', 10_000)
    h.clock.advance(10_000)
    const second = must(claimJob(h.db, { owner: 'worker-a', leaseMs: 10_000 }, deps), 'worker-a 的第二次领取')
    expect(second.attempt).toBe(2)

    // 同一个 worker 名、但 attempt 是上一轮的：这是"上一次执行"的迟到回报，不能落库。
    expect(codeOf(() => completeJob(h.db, { jobId, leaseOwner: 'worker-a', attempt }, deps))).toBe('RESOURCE_LOCKED')
    expect(field(h.db, jobId, 'status')).toBe('running')
    expect(completeJob(h.db, { jobId, leaseOwner: 'worker-a', attempt: second.attempt }, deps).status).toBe('succeeded')
  })

  it('不传 leaseOwner 时保持旧行为（迁移脚本与无租约路径）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    // queued 无租约：仍然是状态迁移错误，而不是 RESOURCE_LOCKED。
    expect(codeOf(() => completeJob(h.db, { jobId }, deps))).toBe('STATE_INVALID_TRANSITION')
    // queued → failed 合法且不需要租约身份。
    expect(failJob(h.db, { jobId, errorCode: 'JOB_EXECUTOR_FAILED', errorMessage: '派发前失败' }, deps).status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

describe('取消：请求不是事实', () => {
  it('queued（无租约）→ cancelled，落 finished_at / cancel_reason', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )

    const result = cancelJob(h.db, { jobId, reason: '用户放弃' }, deps)
    expect(result.status).toBe('cancelled')
    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'cancelled',
      cancel_reason: '用户放弃',
      cancel_requested_at: T0,
      finished_at: T0,
      lease_owner: null,
    })
  })

  it('running（有活租约）→ cancelling，**不是** cancelled', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    h.clock.advance(5_000)

    const result = cancelJob(h.db, { jobId, reason: '换用别的模型' }, deps)
    expect(result.status).toBe('cancelling')
    expect(result.job.status).toBe('cancelling')
    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'cancelling',
      cancel_reason: '换用别的模型',
      cancel_requested_at: '2026-01-01T00:00:05.000Z',
      finished_at: null,
      // 租约还在：执行者要继续持有它，直到自己把终态推上去。
      lease_owner: 'worker-a',
    })

    // 再取消一次（租约仍活）：仍是 cancelling，且不覆盖第一次的原因与时间。
    const again = cancelJob(h.db, { jobId, reason: '第二次原因' }, deps)
    expect(again.status).toBe('cancelling')
    expect(jobRow(h.db, jobId)).toMatchObject({
      cancel_reason: '换用别的模型',
      cancel_requested_at: '2026-01-01T00:00:05.000Z',
    })
  })

  it('running 但租约已过期 → 直接 cancelled（没有执行者会观察中间态）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    h.clock.advance(30_000)

    const result = cancelJob(h.db, { jobId, reason: 'worker 已死' }, deps)
    expect(result.status).toBe('cancelled')
    expect(jobRow(h.db, jobId)).toMatchObject({ status: 'cancelled', finished_at: '2026-01-01T00:00:30.000Z' })
  })

  it('取消后完成：cancelling → cancelled（结果被丢弃，不会变成 succeeded）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    must(claimJob(h.db, { owner: 'worker-a', leaseMs: 30_000 }, deps), 'worker-a 的领取')
    expect(cancelJob(h.db, { jobId }, deps).status).toBe('cancelling')

    const finished = completeJob(h.db, { jobId, result: { text: '不该可见的产物' } }, deps)
    expect(finished.status).toBe('cancelled')
    expect(jobRow(h.db, jobId)['status']).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// 重试上限
// ---------------------------------------------------------------------------

describe('重试上限', () => {
  it('attempt 超过 maxAttempts → failed + error_code=JOB_TIMEOUT，之后不可再领取', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      {
        workspaceId,
        kind: JOB_KIND,
        executor: JOB_EXECUTOR,
        payload: {},
        maxAttempts: 2,
        submittedByUserId: userId,
      },
      deps,
    )
    expect(field(h.db, jobId, 'max_attempts')).toBe(2)

    // 第 1、2 次领取都在上限内。
    expect(must(claimJob(h.db, { owner: 'w1', leaseMs: 10_000 }, deps), '第 1 次').attempt).toBe(1)
    h.clock.advance(10_000)
    expect(must(claimJob(h.db, { owner: 'w2', leaseMs: 10_000 }, deps), '第 2 次').attempt).toBe(2)

    // 第 3 次：attempt 会变成 3 > max_attempts=2 → 判死，且**不交给执行器**。
    h.clock.advance(10_000)
    expect(claimJob(h.db, { owner: 'w3', leaseMs: 10_000 }, deps)).toBeNull()
    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'failed',
      attempt: 3,
      error_code: 'JOB_TIMEOUT',
      finished_at: '2026-01-01T00:00:20.000Z',
      lease_owner: null,
      lease_expires_at: null,
    })
    expect(String(field(h.db, jobId, 'error_message'))).toContain('max_attempts=2')

    // 判死之后再等多久都不会被领取。
    h.clock.advance(3_600_000)
    expect(claimJob(h.db, { owner: 'w4', leaseMs: 10_000 }, deps)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 列表 / 详情
// ---------------------------------------------------------------------------

describe('列表与详情', () => {
  it('列表按工作区隔离 + limit 有上限 + status 过滤 + cursor 翻页', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const deps = repoDeps(h.clock)
    for (let index = 0; index < 3; index += 1) {
      submitJob(
        h.db,
        { workspaceId, kind: `${JOB_KIND}.${index}`, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
        deps,
      )
    }

    const first = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?limit=2`, headers })
    expect(first.statusCode).toBe(200)
    const firstPage = first.json<{ items: readonly { id: JobId }[]; nextCursor: string | null; hasMore: boolean }>()
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe('2')

    const second = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?limit=2&cursor=2`, headers })
    const secondPage = second.json<{ items: readonly { id: JobId }[]; nextCursor: string | null; hasMore: boolean }>()
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.hasMore).toBe(false)
    expect(secondPage.nextCursor).toBeNull()

    const filtered = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?status=queued`, headers })
    expect(filtered.json<{ items: readonly unknown[] }>().items).toHaveLength(3)

    const noneLeft = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?status=succeeded`, headers })
    expect(noneLeft.json<{ items: readonly unknown[] }>().items).toHaveLength(0)

    const badStatus = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?status=nope`, headers })
    expect(badStatus.statusCode).toBe(400)
    expect(badStatus.json<{ code: string }>().code).toBe('VALIDATION_FAILED')

    // limit 上限由处理器判（好返回带 {field,max} 的提示），超了就 400。
    const tooBig = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?limit=1000`, headers })
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const badCursor = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}?cursor=abc`, headers })
    expect(badCursor.statusCode).toBe(400)
    expect(badCursor.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')
  })

  it('详情只吐契约字段（不外泄 lease_owner / submitted_by_user_id）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const created = await h.app.inject({
      method: 'POST',
      url: jobsUrl(workspaceId),
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: { prompt: '写第一章' } },
    })
    const jobId = created.json<{ jobId: JobId }>().jobId

    const detail = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}/${jobId}`, headers })
    expect(detail.statusCode).toBe(200)
    const body = detail.json<Record<string, unknown>>()
    expect(body['id']).toBe(jobId)
    expect(body['workspaceId']).toBe(workspaceId)
    expect(body['kind']).toBe(JOB_KIND)
    expect(body['executor']).toBe(JOB_EXECUTOR)
    expect(body['status']).toBe('queued')
    expect(body['attempt']).toBe(0)
    expect(body['maxAttempts']).toBe(3)
    expect(body['payload']).toEqual({ prompt: '写第一章' })
    expect(body['errorCode']).toBeNull()
    expect(Object.keys(body)).not.toContain('lease_owner')
    expect(Object.keys(body)).not.toContain('submitted_by_user_id')
    expect(Object.keys(body)).not.toContain('idempotency_key')
  })

  it('不存在与跨工作区的任务都返回 NOT_FOUND_JOB 404（不用 403 泄露存在性）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)

    const missing = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}/${newIds.job()}`, headers })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')

    // 同一个用户的第二个工作区：它有资格访问，所以这里的 404 是"任务不属于你"。
    const other = await h.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers,
      payload: { name: '第二个工作区' },
    })
    expect(other.statusCode).toBe(201)
    const otherWorkspaceId = other.json<{ workspaceId: WorkspaceId }>().workspaceId

    const created = await h.app.inject({
      method: 'POST',
      url: jobsUrl(otherWorkspaceId),
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {} },
    })
    expect(created.statusCode).toBe(201)
    const otherJobId = created.json<{ jobId: JobId }>().jobId

    const hidden = await h.app.inject({ method: 'GET', url: `${jobsUrl(workspaceId)}/${otherJobId}`, headers })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')

    const hiddenCancel = await h.app.inject({
      method: 'POST',
      url: `${jobsUrl(workspaceId)}/${otherJobId}/cancel`,
      headers,
      payload: {},
    })
    expect(hiddenCancel.statusCode).toBe(404)
    expect(hiddenCancel.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')

    // 别人的任务也不能出现在我的列表里。
    const list = await h.app.inject({ method: 'GET', url: jobsUrl(workspaceId), headers })
    const ids = list.json<{ items: readonly { id: JobId }[] }>().items.map((item) => item.id)
    expect(ids).not.toContain(otherJobId)
  })
})

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

describe('鉴权', () => {
  it('未认证：提交 / 列表 / 详情 / 取消 全部 401 AUTH_REQUIRED', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = newIds.job()

    const calls = [
      { method: 'POST' as const, url: jobsUrl(workspaceId), payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {} } },
      { method: 'GET' as const, url: jobsUrl(workspaceId) },
      { method: 'GET' as const, url: `${jobsUrl(workspaceId)}/${jobId}` },
      { method: 'POST' as const, url: `${jobsUrl(workspaceId)}/${jobId}/cancel`, payload: {} },
    ]
    for (const call of calls) {
      const res = await h.app.inject(call)
      expect(res.statusCode).toBe(401)
      expect(res.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
    }
  })

  it('不是成员的工作区 → 403 PERMISSION_DENIED（写与读都一样）', async () => {
    const h = await makeJobsHarness()
    await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const foreign = newIds.workspace()

    const write = await h.app.inject({
      method: 'POST',
      url: jobsUrl(foreign),
      headers,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {} },
    })
    expect(write.statusCode).toBe(403)
    expect(write.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

    const read = await h.app.inject({ method: 'GET', url: jobsUrl(foreign), headers })
    expect(read.statusCode).toBe(403)
    expect(read.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })

  it('写请求缺 CSRF 头 → 403（Cookie 凭据下写操作必须带 x-csrf-token）', async () => {
    const h = await makeJobsHarness()
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)
    const withoutCsrf = { cookie: headers['cookie'] ?? '' }

    const res = await h.app.inject({
      method: 'POST',
      url: jobsUrl(workspaceId),
      headers: withoutCsrf,
      payload: { kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {} },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    expect(countRows(h.db, 'jobs')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

describe('运行器', () => {
  it('runOnce：领一条 → 执行器成功 → succeeded，租约被清掉', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const seen: JobId[] = []
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-runner',
      leaseMs: 60_000,
      executor: (job) => {
        seen.push(job.id)
        expect(job.status).toBe('running')
      },
    })

    const outcome = await runner.runOnce()
    expect(outcome.kind).toBe('succeeded')
    if (outcome.kind !== 'succeeded') throw new Error('unreachable')
    expect(outcome.jobId).toBe(jobId)
    expect(outcome.attempt).toBe(1)
    expect(seen).toEqual([jobId])
    expect(jobRow(h.db, jobId)).toMatchObject({ status: 'succeeded', finished_at: T0, lease_owner: null })
    expect(await runner.runOnce()).toEqual({ kind: 'idle' })
  })

  it('runOnce：没有可领的任务 → idle', async () => {
    const h = await makeJobsHarness()
    const runner = createJobRunner({ db: h.db, clock: h.clock, owner: 'w', leaseMs: 10_000, executor: () => {} })
    expect(await runner.runOnce()).toEqual({ kind: 'idle' })
  })

  it('runOnce：执行器抛错 → 落 failed 且错误原样返回（不吞异常）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const boom = new Error('执行器炸了')
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-fail',
      leaseMs: 60_000,
      executor: () => {
        throw boom
      },
    })

    const outcome = await runner.runOnce()
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.failurePersisted).toBe(true)
    // 同一个错误对象：异常没有被吞掉，只是被"落库 + 上报"了。
    expect(outcome.error).toBe(boom)
    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'failed',
      error_code: 'JOB_EXECUTOR_FAILED',
      error_message: 'Error: 执行器炸了',
      finished_at: T0,
      lease_owner: null,
    })
    // 失败也是可见事件：客户端能从事件流里看到终态。
    expect(countJobOutputs(h.db, jobId)).toBe(3) // queued → running → failed
  })

  it('runOnce：执行器抛契约错误 → 用它的错误码落库', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-contract',
      leaseMs: 60_000,
      executor: () => {
        throw new ContractError({ code: 'JOB_INPUT_VERSION_GONE', message: '输入版本已失效', requestId: newIds.request() })
      },
    })

    expect((await runner.runOnce()).kind).toBe('failed')
    expect(jobRow(h.db, jobId)).toMatchObject({ status: 'failed', error_code: 'JOB_INPUT_VERSION_GONE' })
  })

  it('runOnce：执行期间收到取消 → 终态 cancelled，本次结果被丢弃（stale）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-cancel',
      leaseMs: 60_000,
      executor: (job) => {
        // 执行到一半用户点了取消：任务变成 cancelling，但租约还在我们手里。
        expect(cancelJob(h.db, { jobId: job.id, reason: '用户取消' }, deps).status).toBe('cancelling')
      },
    })

    const outcome = await runner.runOnce()
    if (outcome.kind !== 'stale') throw new Error(`期望 stale，实际是 ${outcome.kind}`)
    expect(outcome.reason).toBe('JOB_CANCELLED')
    expect(jobRow(h.db, jobId)).toMatchObject({ status: 'cancelled', cancel_reason: '用户取消' })
  })

  it('runOnce：执行器跑完时任务已被判死 → 不覆盖终态（stale）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-stale',
      leaseMs: 60_000,
      executor: (job) => {
        failJob(h.db, { jobId: job.id, errorCode: 'JOB_CANCELLED', errorMessage: '外层判死' }, deps)
      },
    })

    const outcome = await runner.runOnce()
    if (outcome.kind !== 'stale') throw new Error(`期望 stale，实际是 ${outcome.kind}`)
    expect(outcome.reason).toBe('STATE_INVALID_TRANSITION')
    expect(jobRow(h.db, jobId)).toMatchObject({
      status: 'failed',
      error_code: 'JOB_CANCELLED',
      error_message: '外层判死',
    })
  })

  it('runOnce：执行期间租约被重领 → 迟到的成功回报作废（stale / RESOURCE_LOCKED）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-runner',
      leaseMs: 10_000,
      executor: () => {
        // 执行器跑得太久：租约到期后另一个 worker 领走了同一条任务（attempt 变 2）。
        h.clock.advance(10_000)
        const stolen = must(claimJob(h.db, { owner: 'worker-thief', leaseMs: 10_000 }, deps), 'worker-thief 的领取')
        expect(stolen.attempt).toBe(2)
      },
    })

    const outcome = await runner.runOnce()
    if (outcome.kind !== 'stale') throw new Error(`期望 stale，实际是 ${outcome.kind}`)
    expect(outcome.reason).toBe('RESOURCE_LOCKED')
    // 任务仍归 worker-thief，且没有被我们写成 succeeded。
    expect(jobRow(h.db, jobId)).toMatchObject({ status: 'running', lease_owner: 'worker-thief', result_json: null })
  })

  it('runOnce：执行期间自动续租（长任务不会被重领）', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    // leaseMs=900 → heartbeatIntervalMs=300 → 续租定时器 300ms 一跳。
    let expiryDuringRun: unknown = null
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-hb',
      leaseMs: 900,
      executor: async () => {
        // 时钟前进 500ms（还没到 T0+900 的到期点），然后真的等过一跳续租。
        h.clock.advance(500)
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            resolve()
          }, 500)
        })
        expiryDuringRun = field(h.db, jobId, 'lease_expires_at')
      },
    })

    const outcome = await runner.runOnce()
    expect(outcome.kind).toBe('succeeded')
    // T0+500 时心跳把到期点推到 T0+1400；没有自动续租的话这里还是 T0+900。
    expect(expiryDuringRun).toBe('2026-01-01T00:00:01.400Z')
  })

  it('start()：未知持久化错误不会让循环 promise 拒绝，而是记日志继续', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    submitJob(h.db, { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId }, deps)
    const lines: Record<string, unknown>[] = []
    let calls = 0
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-loop-err',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      log: (line) => lines.push(line),
      executor: () => {
        calls += 1
        // 制造"未知持久化错误"：删掉事件表，之后 `failJob` 里 `appendStatusEvent` 抛的是
        // 驱动错误（不是 ContractError）→ `persistFailure` 照契约向上抛 → 走循环的 catch。
        h.db.exec('DROP TABLE job_outputs')
        throw new Error('执行器炸了')
      },
    })

    const loop = runner.start()
    await waitFor(() => lines.some((line) => line['event'] === 'job.loop_error'), '循环记录了未知错误')
    runner.stop()
    await loop // 循环 promise 若拒绝，这里会抛 → 测试失败

    expect(calls).toBe(1)
  })

  it('stop() 之后不再领取，任务留在队列里', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const { jobId } = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const runner = createJobRunner({ db: h.db, clock: h.clock, owner: 'w', leaseMs: 10_000, executor: () => {} })

    runner.stop()
    expect(runner.stopped).toBe(true)
    expect(await runner.runOnce()).toEqual({ kind: 'stopped' })
    expect(jobRow(h.db, jobId)['status']).toBe('queued')
    expect(jobRow(h.db, jobId)['attempt']).toBe(0)
  })

  it('start()：轮询把队列跑空，stop() 后循环退出且不重复执行', async () => {
    const h = await makeJobsHarness()
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const first = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const second = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    const ran: JobId[] = []
    const runner = createJobRunner({
      db: h.db,
      clock: h.clock,
      owner: 'worker-loop',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      executor: (job) => {
        ran.push(job.id)
      },
    })

    const loop = runner.start()
    await waitFor(() => ran.length === 2, '两条任务都被执行')
    runner.stop()
    await loop

    expect(ran).toHaveLength(2)
    expect(new Set(ran)).toEqual(new Set([first.jobId, second.jobId]))
    expect(jobRow(h.db, first.jobId)['status']).toBe('succeeded')
    expect(jobRow(h.db, second.jobId)['status']).toBe('succeeded')

    // 停止之后新任务不会被领走。
    const third = submitJob(
      h.db,
      { workspaceId, kind: JOB_KIND, executor: JOB_EXECUTOR, payload: {}, submittedByUserId: userId },
      deps,
    )
    expect(await runner.runOnce()).toEqual({ kind: 'stopped' })
    expect(jobRow(h.db, third.jobId)['status']).toBe('queued')
  })
})
