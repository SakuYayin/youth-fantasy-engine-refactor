/**
 * 任务事件流测试（P3-C2）：`job_outputs` 仓储 + SSE 增量流 + 轮询退路。
 *
 * 覆盖任务书要求的每一条：
 *   - `job_outputs.seq` 严格递增（在写事务内用 `MAX(seq)+1` 分配）、`since` 过滤正确；
 *   - `Last-Event-ID` 续传**只补发更新的条目**，断线不会永久丢事件；
 *   - SSE 只推该工作区的事件（跨工作区 403 / 跨区任务 404）；
 *   - 轮询退路（`GET .../jobs/:jobId/outputs?since=`）读到的是**同一张表**的数据；
 *   - 未认证 401。
 *
 * 装置用真实 `createServer()`（真 preHandler、真错误映射、真 cookie 鉴权），
 * 只是在 `app.ready()` **之前**把 jobs/events 路由挂上去——`routes/index.ts`
 * 由 Lead 统一装配，本文件不许改它。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContractError, newIds } from '@yfe/contracts'
import type { JobId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import type { SessionPolicy } from '../src/auth/session.js'
import { appendJobOutput, countJobOutputs, listJobOutputs, submitJob } from '../src/db/jobs.js'
import * as jobsRepo from '../src/db/jobs.js'
import { revokeAllUserSessions } from '../src/db/sessions.js'
import type { JobOutputRecord, JobRepoDeps } from '../src/db/jobs.js'
import { upsertMember } from '../src/db/members.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { seedOwner, testClock } from './helpers.js'
import type { TestClock } from './helpers.js'
import { loginAs } from './syncHelpers.js'

const SERVER_ID = 'srv_jobevents'
const POLICY: SessionPolicy = { ...DEFAULT_SESSION_POLICY, cookieSecure: false }

const SUBMIT = {
  kind: 'chapter.draft',
  executor: 'ai.writer',
  payload: { prompt: '写一段开场' },
} as const

interface EventsHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  close(): void
}

const harnesses: EventsHarness[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const harness of harnesses.splice(0)) {
    harness.close()
  }
})

async function makeEventsHarness(): Promise<EventsHarness> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }
  const clock = testClock()
  const config = defaultServerConfig({ sessionPolicy: POLICY })
  ensureServerState(db, SERVER_ID, null)

  const app = createServer({ config, db, serverId: SERVER_ID, clock, logger: false })
  await app.ready()

  return { app, db, clock, close: (): void => closeServerDatabase(db) }
}

function repoDeps(clock: TestClock): JobRepoDeps {
  return { now: (): UtcTimestamp => clock.now(), requestId: newIds.request() }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof ContractError ? error.code : `UNEXPECTED:${String(error)}`
  }
  return 'NO_THROW'
}

interface SubmitOutput {
  readonly jobId: JobId
}
interface OutputItemView {
  readonly seq: number
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly createdAt: string
}
interface OutputsView {
  readonly jobId: string
  readonly since: number
  readonly nextSince: number
  readonly hasMore: boolean
  readonly items: readonly OutputItemView[]
}
const eventsUrl = (workspaceId: WorkspaceId, query = ''): string => `/api/v1/workspaces/${workspaceId}/events${query}`
const outputsUrl = (workspaceId: WorkspaceId, jobId: JobId, query = ''): string =>
  `/api/v1/workspaces/${workspaceId}/jobs/${jobId}/outputs${query}`

function submit(harness: EventsHarness, userId: UserId, workspaceId: WorkspaceId): JobId {
  const deps = repoDeps(harness.clock)
  return submitJob(
    harness.db,
    {
      workspaceId,
      kind: SUBMIT.kind,
      executor: SUBMIT.executor,
      payload: SUBMIT.payload,
      submittedByUserId: userId,
    },
    deps,
  ).jobId
}

/** 追加一条输出并返回它（`occurredAt` 一律走注入时钟）。 */
function append(harness: EventsHarness, jobId: JobId, kind: 'log' | 'progress' | 'chunk', payload: Record<string, unknown>): JobOutputRecord {
  harness.clock.advance(1_000)
  return appendJobOutput(harness.db, { jobId, kind, payload, occurredAt: harness.clock.now() }, repoDeps(harness.clock))
}

// ---------------------------------------------------------------------------
// SSE 报文解析
// ---------------------------------------------------------------------------

interface SseFrame {
  readonly id: string | null
  readonly event: string | null
  readonly data: string
}

function sseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of body.split('\n\n')) {
    let id: string | null = null
    let event: string | null = null
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4)
      else if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
    }
    if (id !== null || event !== null || dataLines.length > 0) {
      frames.push({ id, event, data: dataLines.join('\n') })
    }
  }
  return frames
}

interface SseEventView {
  readonly eventSeq: number
  readonly jobId: string
  readonly seq: number
  readonly kind: string
  readonly payload: Record<string, unknown>
  readonly createdAt: string
}

function jobOutputEvents(body: string): SseEventView[] {
  return sseFrames(body)
    .filter((frame) => frame.event === 'job-output' && frame.id !== null)
    .map((frame) => JSON.parse(frame.data) as SseEventView)
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('SSE 连接期间重新鉴权', () => {
  it.each(['membership', 'session', 'disabled'] as const)('%s 被撤销后不再推送后续正文', async (kind) => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    const headers = await loginAs(h.app)
    const list = jobsRepo.listJobEvents
    vi.spyOn(jobsRepo, 'listJobEvents').mockImplementationOnce((db, input, deps) => {
      const page = list(db, input, deps)
      if (kind === 'membership') {
        h.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId)
      } else if (kind === 'session') {
        revokeAllUserSessions(h.db, userId, h.clock.now(), 'test_revoked')
      } else {
        h.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId)
      }
      append(h, jobId, 'chunk', { text: '撤销后的机密正文' })
      return page
    })

    const response = await h.app.inject({
      method: 'GET', url: eventsUrl(workspaceId, '?maxPolls=2&pollIntervalMs=0'), headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: error')
    expect(response.body).not.toContain('撤销后的机密正文')
    expect(jobOutputEvents(response.body)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// job_outputs 仓储
// ---------------------------------------------------------------------------

describe('job_outputs 仓储：seq 分配与 since 过滤', () => {
  it('seq 从 0 起严格递增（写事务内 MAX(seq)+1），since 过滤 / limit / hasMore 正确', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const deps = repoDeps(h.clock)
    const jobId = submit(h, userId, workspaceId)

    // 提交时就会写一条 queued 状态事件（seq 0），让"任务已入队"也能被推出去。
    expect(countJobOutputs(h.db, jobId)).toBe(1)

    const log = append(h, jobId, 'log', { line: '开始生成' })
    const progress = append(h, jobId, 'progress', { percent: 40 })
    const chunk = append(h, jobId, 'chunk', { text: '第一章' })
    expect([log.seq, progress.seq, chunk.seq]).toEqual([1, 2, 3])

    const all = listJobOutputs(h.db, { jobId, sinceSeq: -1, limit: 50 }, deps)
    expect(all.items.map((item) => item.seq)).toEqual([0, 1, 2, 3])
    expect(all.hasMore).toBe(false)
    expect(all.items[0]?.kind).toBe('status')
    expect(all.items[0]?.payload).toMatchObject({ status: 'queued', attempt: 0 })
    expect(all.items[3]?.payload).toMatchObject({ text: '第一章' })
    // created_at 来自注入时钟，不是 SQLite 的 datetime('now')
    expect(all.items[3]?.createdAt).toBe(h.clock.now())

    // since 是"我已经看到 seq 了，给我更大的"
    expect(listJobOutputs(h.db, { jobId, sinceSeq: 1, limit: 50 }, deps).items.map((item) => item.seq)).toEqual([2, 3])
    expect(listJobOutputs(h.db, { jobId, sinceSeq: 3, limit: 50 }, deps).items).toEqual([])
    // 缺省 sinceSeq = -1（从头开始，含 seq 0）
    expect(listJobOutputs(h.db, { jobId, limit: 50 }, deps).items.map((item) => item.seq)).toEqual([0, 1, 2, 3])

    const page = listJobOutputs(h.db, { jobId, sinceSeq: -1, limit: 2 }, deps)
    expect(page.items.map((item) => item.seq)).toEqual([0, 1])
    expect(page.hasMore).toBe(true)

    expect(codeOf(() => listJobOutputs(h.db, { jobId, sinceSeq: -2, limit: 50 }, deps))).toBe('VALIDATION_OUT_OF_RANGE')
    expect(codeOf(() => listJobOutputs(h.db, { jobId, sinceSeq: -1, limit: 5_000 }, deps))).toBe('VALIDATION_OUT_OF_RANGE')
  })

  it('给不存在的任务追加输出 → NOT_FOUND_JOB，且一行都不写', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    await seedOwner(h.db, h.clock.now())
    const ghost = newIds.job()

    expect(
      codeOf(() => appendJobOutput(h.db, { jobId: ghost, kind: 'log', payload: { line: 'x' }, occurredAt: h.clock.now() }, repoDeps(h.clock))),
    ).toBe('NOT_FOUND_JOB')
    expect(countJobOutputs(h.db, ghost)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 轮询退路
// ---------------------------------------------------------------------------

describe('GET /jobs/:jobId/outputs —— 轮询退路', () => {
  it('缺省从头返回全部输出；nextSince 是最后一条 seq，且不前进时可反复轮询', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    append(h, jobId, 'log', { line: '开始生成' })
    append(h, jobId, 'chunk', { text: '正文' })
    const headers = await loginAs(h.app)

    const response = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId), headers })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json<OutputsView>()
    expect(body.jobId).toBe(jobId)
    expect(body.since).toBe(-1)
    expect(body.items.map((item) => item.seq)).toEqual([0, 1, 2])
    expect(body.nextSince).toBe(2)
    expect(body.hasMore).toBe(false)
    expect(body.items[2]?.kind).toBe('chunk')
    expect(body.items[2]?.payload).toMatchObject({ text: '正文' })

    const fromZero = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId, '?since=0'), headers })
    expect(fromZero.json<OutputsView>().items.map((item) => item.seq)).toEqual([1, 2])

    // 拉到尾巴之后：没有新条目，游标原样返回，客户端可以无脑继续轮询
    const drained = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId, '?since=2'), headers })
    const drainedBody = drained.json<OutputsView>()
    expect(drainedBody.items).toEqual([])
    expect(drainedBody.nextSince).toBe(2)
    expect(drainedBody.hasMore).toBe(false)
  })

  it('轮询：since 越界 / limit 超上限 → 400', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    const headers = await loginAs(h.app)

    const badSince = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId, '?since=-2'), headers })
    expect(badSince.statusCode).toBe(400)
    expect(badSince.json<{ code: string }>().code).toBe('VALIDATION_FAILED')

    const badLimit = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId, '?limit=100000'), headers })
    expect(badLimit.statusCode).toBe(400)
    expect(badLimit.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const unknownQuery = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId, '?cursor=abc'), headers })
    expect(unknownQuery.statusCode).toBe(400)
  })

  it('轮询：不存在的任务 → 404 NOT_FOUND_JOB（不泄露存在性）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { workspaceId } = await seedOwner(h.db, h.clock.now())
    const headers = await loginAs(h.app)

    const ghost = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, newIds.job()), headers })
    expect(ghost.statusCode).toBe(404)
    expect(ghost.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')
  })

  it('轮询：同一用户加入两个工作区时，仍按路径工作区校验任务归属（跨区任务 404）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const at = h.clock.now()
    const owner = await seedOwner(h.db, at)
    const other = await seedOwner(h.db, at, { username: 'owner2' })
    const jobA = submit(h, owner.userId, owner.workspaceId)
    append(h, jobA, 'log', { line: '工作区 A 的输出' })
    // 把 A 的 owner 加进 B 当 viewer：过了工作区鉴权，但任务不属于 B
    upsertMember(h.db, other.workspaceId, owner.userId, 'viewer', at)

    const headers = await loginAs(h.app)
    const crossJob = await h.app.inject({ method: 'GET', url: outputsUrl(other.workspaceId, jobA), headers })
    expect(crossJob.statusCode).toBe(404)
    expect(crossJob.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')

    const streamCross = await h.app.inject({ method: 'GET', url: eventsUrl(other.workspaceId, `?jobId=${jobA}`), headers })
    expect(streamCross.statusCode).toBe(404)
    expect(streamCross.json<{ code: string }>().code).toBe('NOT_FOUND_JOB')

    // B 的事件流不含 A 的任何事件
    const streamB = await h.app.inject({ method: 'GET', url: eventsUrl(other.workspaceId), headers })
    expect(streamB.statusCode).toBe(200)
    expect(streamB.body).not.toContain(jobA)
  })
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe('GET /workspaces/:workspaceId/events —— SSE 事件流', () => {
  it('返回 text/event-stream，按 id 递增推该工作区的事件，并且轮询退路能接着读到同一批数据', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    const appended = [append(h, jobId, 'log', { line: '开始生成' }), append(h, jobId, 'progress', { percent: 40 }), append(h, jobId, 'chunk', { text: '正文' })]
    const headers = await loginAs(h.app)

    const response = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId), headers })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['content-type'])).toContain('text/event-stream')
    expect(String(response.headers['cache-control'])).toContain('no-store')

    const body = response.body
    expect(body.startsWith('retry: ')).toBe(true)
    const events = jobOutputEvents(body)
    expect(events.length).toBe(4)
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    expect(events.map((event) => event.kind)).toEqual(['status', 'log', 'progress', 'chunk'])

    // `id:` = 工作区级事件序号，严格递增（客户端靠它续传）
    const idFrames = sseFrames(body)
      .filter((frame) => frame.event === 'job-output')
      .map((frame) => Number(frame.id))
    expect(idFrames.every((value) => Number.isSafeInteger(value) && value > 0)).toBe(true)
    for (let index = 1; index < idFrames.length; index += 1) {
      expect(idFrames[index]).toBeGreaterThan(idFrames[index - 1] as number)
    }

    // 收线帧：告诉客户端这一轮的游标
    const endFrame = sseFrames(body).find((frame) => frame.event === 'end')
    expect(endFrame).toBeDefined()
    expect(JSON.parse(endFrame?.data ?? '{}')).toEqual({ since: idFrames[idFrames.length - 1] })

    // 轮询退路读到的是同一张表：用 SSE 最后一条事件的 seq 去拉增量
    const lastEvent = events[events.length - 1] as SseEventView
    expect(lastEvent.jobId).toBe(jobId)
    const poll = await h.app.inject({
      method: 'GET',
      url: outputsUrl(workspaceId, jobId, `?since=${lastEvent.seq - 1}`),
      headers,
    })
    const pollBody = poll.json<OutputsView>()
    expect(pollBody.items).toHaveLength(1)
    expect(pollBody.items[0]?.seq).toBe(lastEvent.seq)
    expect(pollBody.items[0]?.kind).toBe(lastEvent.kind)
    expect(pollBody.items[0]?.payload).toEqual(lastEvent.payload)
    expect(pollBody.items[0]?.createdAt).toBe(lastEvent.createdAt)
    expect(appended[2]?.seq).toBe(lastEvent.seq)
  })

  it('Last-Event-ID 续传：只补发更大序号的事件，一个都不丢', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    append(h, jobId, 'log', { line: '第一条' })
    const headers = await loginAs(h.app)

    const first = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId), headers })
    const firstEvents = jobOutputEvents(first.body)
    const lastId = firstEvents[firstEvents.length - 1]?.eventSeq as number
    expect(lastId).toBeGreaterThan(0)

    // 断线期间又有新事件产生
    append(h, jobId, 'chunk', { text: '断线期间产生的正文' })
    append(h, jobId, 'progress', { percent: 90 })

    // 重连（Last-Event-ID 优先于 URL 上的 since）：只补发 seq > lastId 的
    const resumed = await h.app.inject({
      method: 'GET',
      url: eventsUrl(workspaceId, `?since=${lastId}`),
      headers: { ...headers, 'last-event-id': String(lastId) },
    })
    const resumedEvents = jobOutputEvents(resumed.body)
    expect(resumedEvents).toHaveLength(2)
    expect(resumedEvents.every((event) => event.eventSeq > lastId)).toBe(true)
    expect(resumedEvents.map((event) => event.kind)).toEqual(['chunk', 'progress'])

    // 首轮之后写入的事件 = 续传补发的全部事件（没有永久丢失）
    const allNow = listJobOutputs(h.db, { jobId, sinceSeq: -1, limit: 50 }, repoDeps(h.clock)).items
    expect(allNow.map((item) => item.seq)).toEqual([0, 1, 2, 3])

    // 已经追平之后再连：没有任何事件可补
    const caughtUp = await h.app.inject({
      method: 'GET',
      url: eventsUrl(workspaceId),
      headers: { ...headers, 'last-event-id': String(resumedEvents[resumedEvents.length - 1]?.eventSeq as number) },
    })
    expect(jobOutputEvents(caughtUp.body)).toEqual([])

    // `?since=` 单独也能续传（没有请求头的情况）
    const byQuery = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, `?since=${lastId}`), headers })
    expect(jobOutputEvents(byQuery.body).map((event) => event.seq)).toEqual([2, 3])
  })

  it('只推本工作区的事件（工作区隔离）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const at = h.clock.now()
    const ownerA = await seedOwner(h.db, at)
    const ownerB = await seedOwner(h.db, at, { username: 'owner2' })
    const jobA = submit(h, ownerA.userId, ownerA.workspaceId)
    const jobB = submit(h, ownerB.userId, ownerB.workspaceId)
    append(h, jobA, 'log', { line: 'A 的日志' })
    append(h, jobB, 'log', { line: 'B 的日志' })

    const streamA = await h.app.inject({ method: 'GET', url: eventsUrl(ownerA.workspaceId), headers: await loginAs(h.app) })
    const eventsA = jobOutputEvents(streamA.body)
    expect(eventsA.length).toBe(2)
    expect(eventsA.every((event) => event.jobId === jobA)).toBe(true)
    expect(streamA.body).not.toContain(jobB)

    const streamB = await h.app.inject({ method: 'GET', url: eventsUrl(ownerB.workspaceId), headers: await loginAs(h.app, 'owner2') })
    expect(jobOutputEvents(streamB.body).every((event) => event.jobId === jobB)).toBe(true)
  })

  it('jobId 过滤：只推该任务的事件', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobOne = submit(h, userId, workspaceId)
    const jobTwo = submit(h, userId, workspaceId)
    append(h, jobOne, 'log', { line: 'one' })
    append(h, jobTwo, 'log', { line: 'two' })
    const headers = await loginAs(h.app)

    const filtered = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, `?jobId=${jobOne}`), headers })
    const events = jobOutputEvents(filtered.body)
    expect(events.length).toBe(2)
    expect(events.every((event) => event.jobId === jobOne)).toBe(true)
    expect(filtered.body).not.toContain(jobTwo)
  })

  it('有界轮询循环是真实的：maxPolls=2 会写 keep-alive 并收线（连接不会被无限占用）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    const headers = await loginAs(h.app)

    const single = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId), headers })
    expect(countOf(single.body, ': keep-alive')).toBe(0)

    const bounded = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, `?maxPolls=2&pollIntervalMs=0`), headers })
    expect(countOf(bounded.body, ': keep-alive')).toBe(1)
    // 每轮都从同一个游标拉起增量：不会重复推、也不会漏推
    expect(jobOutputEvents(bounded.body).map((event) => event.jobId)).toEqual([jobId])
    expect(sseFrames(bounded.body).some((frame) => frame.event === 'end')).toBe(true)
  })

  it('非法参数：Last-Event-ID / since / limit 都会被拒（客户端输入不可信）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)
    const headers = await loginAs(h.app)

    const badHeader = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId), headers: { ...headers, 'last-event-id': 'abc' } })
    expect(badHeader.statusCode).toBe(400)
    expect(badHeader.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const negative = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, '?since=-2'), headers })
    expect(negative.statusCode).toBe(400)
    expect(negative.json<{ code: string }>().code).toBe('VALIDATION_FAILED')

    const tooBig = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, '?limit=100000'), headers })
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const zeroPolls = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, '?maxPolls=0'), headers })
    expect(zeroPolls.statusCode).toBe(400)

    // 事件流本身仍然可用
    const ok = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId, `?jobId=${jobId}`), headers })
    expect(ok.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

describe('事件流鉴权', () => {
  it('未认证 → 401 AUTH_REQUIRED（SSE 与轮询退路都一样）', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const { userId, workspaceId } = await seedOwner(h.db, h.clock.now())
    const jobId = submit(h, userId, workspaceId)

    const stream = await h.app.inject({ method: 'GET', url: eventsUrl(workspaceId) })
    expect(stream.statusCode).toBe(401)
    expect(stream.json<{ code: string }>().code).toBe('AUTH_REQUIRED')

    const outputs = await h.app.inject({ method: 'GET', url: outputsUrl(workspaceId, jobId) })
    expect(outputs.statusCode).toBe(401)
    expect(outputs.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('跨工作区 → 403 PERMISSION_DENIED', async () => {
    const h = await makeEventsHarness()
    harnesses.push(h)
    const at = h.clock.now()
    const ownerA = await seedOwner(h.db, at)
    const ownerB = await seedOwner(h.db, at, { username: 'owner2' })
    const jobB = submit(h, ownerB.userId, ownerB.workspaceId)

    const headers = await loginAs(h.app)
    const stream = await h.app.inject({ method: 'GET', url: eventsUrl(ownerB.workspaceId), headers })
    expect(stream.statusCode).toBe(403)
    expect(stream.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

    const outputs = await h.app.inject({ method: 'GET', url: outputsUrl(ownerB.workspaceId, jobB), headers })
    expect(outputs.statusCode).toBe(403)
    expect(outputs.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

    // A 自己的工作区照常可用（防止"一律 403"式的假通过）
    const own = await h.app.inject({ method: 'GET', url: eventsUrl(ownerA.workspaceId), headers })
    expect(own.statusCode).toBe(200)
  })
})
