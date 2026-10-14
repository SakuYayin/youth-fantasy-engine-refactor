/**
 * `POST /api/v1/workspaces/{id}/batches` —— 原子批次提交。
 *
 * 这一组用例的判据几乎都用**行数**而不是响应体：响应体是"服务器说了什么"，
 * 行数是"服务器真的做了什么"。历史教训是"回滚看起来发生了，其实已经写进去了"。
 *
 * 三件必须钉死的事：
 * 1. 幂等是 `batchId`/`opId` + **规范化载荷摘要**，重试回原回执且**行数不变**；
 * 2. 任一基线冲突 → 409 且**整批零写入**（不是"部分成功再报错"）；
 * 3. 工作区/主体/deviceId 一律来自路径与认证上下文，**payload 里的同名字段不参与授权**。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { newIds } from '@yfe/contracts'
import type { DeviceId, UserId, WorkspaceId } from '@yfe/contracts'

import { revokeDevice } from '../src/db/devices.js'
import { SYNC_LIMITS, encodeWorkspaceCursor } from '../src/sync/protocol.js'
import { seedOwner, TEST_PASSWORD } from './helpers.js'
import type { TestHarness, TestHarnessOptions } from './helpers.js'
import {
  countRows,
  harnessTracker,
  loginAs,
  makeBatchBody,
  newOpId,
  rev,
  seedDevice,
  withoutCsrf,
} from './syncHelpers.js'
import type { BatchOpInput } from './syncHelpers.js'

interface OperationConflictBody {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly expectedBaseRevision: string | null
  readonly currentRevision: string | null
  readonly reason: string
}

interface BatchSuccessBody {
  readonly ok: true
  readonly batchId: string
  readonly cursor: string
  readonly acceptedAt: string
  readonly revisions: readonly { readonly opId: string; readonly entityId: string; readonly revision: string }[]
  readonly replayed?: boolean
}

interface BatchFailureBody {
  readonly ok: false
  readonly code: string
  readonly requestId: string
  readonly conflicts: readonly OperationConflictBody[]
}

interface Ctx {
  readonly harness: TestHarness
  readonly headers: Record<string, string>
  readonly workspaceId: WorkspaceId
  readonly deviceId: DeviceId
  readonly userId: UserId
}

const tracker = harnessTracker()

afterEach(() => {
  tracker.closeAll()
})

async function setup(options: TestHarnessOptions = {}): Promise<Ctx> {
  const harness = await tracker.make(options)
  const at = harness.clock.now()
  const seeded = await seedOwner(harness.db, at)
  const deviceId = seedDevice(harness.db, at, seeded.userId, seeded.workspaceId)
  const headers = await loginAs(harness.app)
  return { harness, headers, workspaceId: seeded.workspaceId, deviceId, userId: seeded.userId }
}

function batchesUrl(workspaceId: string): string {
  return `/api/v1/workspaces/${workspaceId}/batches`
}

/** 只声明用例真正用到的三个成员，避免被 light-my-request 的重载签名牵着走。 */
interface InjectResponse {
  readonly statusCode: number
  readonly body: string
  json<T = unknown>(): T
}

function postBatch(
  ctx: Ctx,
  body: unknown,
  headers: Record<string, string> = ctx.headers,
  workspaceId: string = ctx.workspaceId,
): Promise<InjectResponse> {
  return ctx.harness.app.inject({
    method: 'POST',
    url: batchesUrl(workspaceId),
    headers,
    payload: body as Record<string, unknown>,
  })
}

function docOp(
  entityId: string,
  overrides: {
    readonly opId?: string
    readonly entityType?: string
    readonly projectId?: string | null
    readonly baseRevision?: string | null
    readonly newRevision?: string
    readonly action?: 'upsert' | 'delete'
    readonly payload?: Readonly<Record<string, unknown>>
    readonly assetIds?: readonly string[]
  } = {},
): BatchOpInput {
  return {
    opId: overrides.opId ?? newOpId(),
    entityType: overrides.entityType ?? 'document',
    entityId,
    projectId: overrides.projectId ?? null,
    baseRevision: overrides.baseRevision ?? null,
    newRevision: overrides.newRevision ?? rev(1),
    action: overrides.action ?? 'upsert',
    payload: overrides.payload ?? { title: entityId },
    assetIds: overrides.assetIds ?? [],
  }
}

describe('POST batches —— 认证与授权', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const ctx = await setup()
    const response = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')]), {})
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('缺 CSRF 头返回 403（写路由必须挡在没有 CSRF 的请求前面）', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')]),
      withoutCsrf(ctx.headers),
    )
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_DENIED')
    expect(body.detail?.reason).toBe('csrf_token_invalid')
  })

  it('往不是自己成员的工作区提交返回 403', async () => {
    const ctx = await setup()
    const at = ctx.harness.clock.now()
    const bob = await seedOwner(ctx.harness.db, at, { username: 'bob', password: TEST_PASSWORD })

    const response = await postBatch(
      ctx,
      makeBatchBody(bob.workspaceId, ctx.deviceId, [docOp('doc_a')]),
      ctx.headers,
      bob.workspaceId,
    )
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })

  it('请求体 workspaceId 与路径不一致返回 403 PERMISSION_WORKSPACE_MISMATCH', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(newIds.workspace(), ctx.deviceId, [docOp('doc_a')]),
    )
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(body.detail?.reason).toBe('path_body_mismatch')
  })

  it('payload 里的 workspaceId / role 不参与归属：变更只会落在路径工作区', async () => {
    const ctx = await setup()
    const at = ctx.harness.clock.now()
    const bob = await seedOwner(ctx.harness.db, at, { username: 'bob', password: TEST_PASSWORD })

    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [
        docOp('doc_escalate', { payload: { workspaceId: bob.workspaceId, role: 'admin', title: 't' } }),
      ]),
    )
    expect(response.statusCode).toBe(200)

    // bob 的工作区里必须一条变更都没有：payload 不是授权通道，也不是归属通道。
    const bobHeaders = await loginAs(ctx.harness.app, 'bob', TEST_PASSWORD)
    const bobChanges = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${bob.workspaceId}/changes`,
      headers: bobHeaders,
    })
    expect(bobChanges.statusCode).toBe(200)
    expect(bobChanges.json<{ changes: readonly unknown[] }>().changes).toHaveLength(0)

    const mine = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/changes`,
      headers: ctx.headers,
    })
    expect(mine.json<{ changes: readonly unknown[] }>().changes).toHaveLength(1)
  })
})

describe('POST batches —— 协议与形状校验', () => {
  it('protocolVersion 不兼容返回 400 SYNC_PROTOCOL_MISMATCH', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')], { protocolVersion: 2 }),
    )
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('SYNC_PROTOCOL_MISMATCH')
  })

  it('未知 entityType 返回 400 而不是静默丢弃', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a', { entityType: 'chapter' })]),
    )
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('SYNC_CAPABILITY_UNSUPPORTED')
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(0)
  })

  it('未知 action 返回 400', async () => {
    const ctx = await setup()
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')])
    const broken = {
      ...body,
      operations: [{ ...body.operations[0], action: 'patch' }],
    }
    const response = await postBatch(ctx, broken)
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('同一批次内 opId 重复返回 400', async () => {
    const ctx = await setup()
    const shared = newOpId()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [
        docOp('doc_a', { opId: shared }),
        docOp('doc_b', { opId: shared }),
      ]),
    )
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('assetIds 非空返回 400：capabilities 说 assets.enabled=false，服务端就必须真的不收', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a', { assetIds: ['ast_1'] })]),
    )
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('SYNC_CAPABILITY_UNSUPPORTED')
  })

  it('删除操作缺 baseRevision 返回 400', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [
        docOp('doc_a', { action: 'delete', newRevision: rev(2) }),
      ]),
    )
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('未知请求体字段返回 400（不静默丢弃）', async () => {
    const ctx = await setup()
    const response = await postBatch(ctx, {
      ...makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')]),
      force: true,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })
})

describe('POST batches —— 上限', () => {
  it(`超过 ${SYNC_LIMITS.maxOperationsPerBatch} 个操作返回 413`, async () => {
    const ctx = await setup()
    const operations = Array.from({ length: SYNC_LIMITS.maxOperationsPerBatch + 1 }, (_unused, index) =>
      docOp(`doc_${String(index)}`),
    )
    const response = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, operations))
    expect(response.statusCode).toBe(413)
    const body = response.json<{ code: string; detail?: { limit?: string } }>()
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(body.detail?.limit).toBe('maxOperationsPerBatch')
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(0)
  })

  it(`批次字节数超过 ${SYNC_LIMITS.maxBatchBytes} 返回 413`, async () => {
    // 把传输层上限调高，才能证明"413 是批次自己的上限判出来的"，不是 Fastify 顺手挡的。
    const ctx = await setup({ config: { bodyLimitBytes: SYNC_LIMITS.maxBatchBytes * 2 } })
    const huge = 'x'.repeat(SYNC_LIMITS.maxBatchBytes + 1024)
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_huge', { payload: { title: huge } })]),
    )
    expect(response.statusCode).toBe(413)
    const body = response.json<{ code: string; detail?: { limit?: string } }>()
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(body.detail?.limit).toBe('maxBatchBytes')
  })
})

describe('POST batches —— 原子写入', () => {
  it('成功后回执给出每个 opId 的 revision 与游标，并落库变更/实体/回执', async () => {
    const ctx = await setup()
    const first = docOp('doc_one')
    const second = docOp('doc_two')
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [first, second])

    const response = await postBatch(ctx, body)
    expect(response.statusCode).toBe(200)
    const accepted = response.json<BatchSuccessBody>()
    expect(accepted.ok).toBe(true)
    expect(accepted.batchId).toBe(body.batchId)
    expect(accepted.revisions.map((item) => item.opId)).toEqual([first.opId, second.opId])
    expect(accepted.revisions.map((item) => item.revision)).toEqual([first.newRevision, second.newRevision])
    // 游标来自服务器提交顺序（change_feed.server_seq），两个操作 → 第 2 条。
    expect(accepted.cursor).toBe(encodeWorkspaceCursor(2, ctx.workspaceId))

    expect(countRows(ctx.harness.db, 'change_feed')).toBe(2)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(2)
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(1)
  })

  it('同一批次内后一个操作可以引用前一个操作刚产出的 newRevision（离线链）', async () => {
    const ctx = await setup()
    const created = docOp('doc_chain', { newRevision: rev(1) })
    const updated = docOp('doc_chain', { baseRevision: rev(1), newRevision: rev(2), payload: { title: '第二稿' } })
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [created, updated])

    const response = await postBatch(ctx, body)
    expect(response.statusCode).toBe(200)
    expect(response.json<BatchSuccessBody>().ok).toBe(true)
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(2)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(1)

    const changes = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/changes`,
      headers: ctx.headers,
    })
    const entries = changes.json<{ changes: readonly { revision: string; payload: { title?: string } }[] }>().changes
    expect(entries.map((entry) => entry.revision)).toEqual([rev(1), rev(2)])
    expect(entries[1]?.payload.title).toBe('第二稿')
  })

  it('删除写墓碑：实体的正文被清掉，快照不再包含它，变更流留两条', async () => {
    const ctx = await setup()
    const created = docOp('doc_gone', { newRevision: rev(1), payload: { title: '要删的文档' } })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [created]))).statusCode).toBe(200)

    const deleted = docOp('doc_gone', {
      action: 'delete',
      baseRevision: rev(1),
      newRevision: rev(2),
      payload: { title: '要删的文档' },
    })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [deleted]))).statusCode).toBe(200)

    expect(countRows(ctx.harness.db, 'change_feed')).toBe(2)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(1)

    const tombstone = ctx.harness.db
      .prepare('SELECT deleted, payload_json FROM sync_entities WHERE entity_id = ?')
      .get('doc_gone') as { readonly deleted?: number; readonly payload_json?: string | null } | undefined
    expect(tombstone?.deleted).toBe(1)
    // 墓碑不带正文：删除之后服务器上不该再留着被删的内容。
    expect(tombstone?.payload_json).toBeNull()

    const snapshot = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot`,
      headers: ctx.headers,
    })
    expect(snapshot.json<{ documents: readonly unknown[] }>().documents).toHaveLength(0)
  })
})

describe('POST batches —— 幂等', () => {
  it('同 batchId 同载荷重试返回原回执，且实体/版本/变更行数不变', async () => {
    const ctx = await setup()
    const first = docOp('doc_idem')
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [first])

    const initial = await postBatch(ctx, body)
    expect(initial.statusCode).toBe(200)
    const before = {
      feed: countRows(ctx.harness.db, 'change_feed'),
      entities: countRows(ctx.harness.db, 'sync_entities'),
      receipts: countRows(ctx.harness.db, 'sync_receipts'),
    }

    const retry = await postBatch(ctx, body)
    expect(retry.statusCode).toBe(200)
    expect(retry.json<BatchSuccessBody>()).toEqual(initial.json<BatchSuccessBody>())

    expect(countRows(ctx.harness.db, 'change_feed')).toBe(before.feed)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(before.entities)
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(before.receipts)
  })

  it('同 batchId 不同载荷返回 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const ctx = await setup()
    const batchId = newIds.request()
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')], { batchId })
    expect((await postBatch(ctx, body)).statusCode).toBe(200)

    const mutated = makeBatchBody(
      ctx.workspaceId,
      ctx.deviceId,
      [docOp('doc_a', { payload: { title: '换了内容' } })],
      { batchId },
    )
    const response = await postBatch(ctx, mutated)
    expect(response.statusCode).toBe(409)
    expect(response.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(1)
  })

  it('同 opId 同载荷在不同批次里重放：不二次写入，只是把既有 revision 还回来', async () => {
    const ctx = await setup()
    const op = docOp('doc_opid', { newRevision: rev(1) })
    const firstBody = makeBatchBody(ctx.workspaceId, ctx.deviceId, [op])
    const initial = await postBatch(ctx, firstBody)
    expect(initial.statusCode).toBe(200)

    const secondBody = makeBatchBody(ctx.workspaceId, ctx.deviceId, [op])
    const replayed = await postBatch(ctx, secondBody)
    expect(replayed.statusCode).toBe(200)
    const accepted = replayed.json<BatchSuccessBody>()
    expect(accepted.ok).toBe(true)
    expect(accepted.revisions).toEqual([
      { opId: op.opId, entityId: op.entityId, revision: op.newRevision },
    ])

    expect(countRows(ctx.harness.db, 'change_feed')).toBe(1)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(1)
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(2)
  })

  it('同 opId 不同载荷返回 409（旧 opId 不能复用在新内容上）', async () => {
    const ctx = await setup()
    const opId = newOpId()
    const firstBody = makeBatchBody(ctx.workspaceId, ctx.deviceId, [
      docOp('doc_opid', { opId, newRevision: rev(1), payload: { title: '甲' } }),
    ])
    expect((await postBatch(ctx, firstBody)).statusCode).toBe(200)

    const secondBody = makeBatchBody(ctx.workspaceId, ctx.deviceId, [
      docOp('doc_opid', { opId, newRevision: rev(2), payload: { title: '乙' }, baseRevision: rev(1) }),
    ])
    const response = await postBatch(ctx, secondBody)
    expect(response.statusCode).toBe(409)
    expect(response.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REUSED')
  })
})

describe('POST batches —— 基线冲突整批回滚', () => {
  it('任一操作基线冲突 → 409 + 冲突元数据，且整批零写入', async () => {
    const ctx = await setup()
    const created = docOp('doc_conflict', { newRevision: rev(1) })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [created]))).statusCode).toBe(200)

    const before = {
      feed: countRows(ctx.harness.db, 'change_feed'),
      entities: countRows(ctx.harness.db, 'sync_entities'),
      receipts: countRows(ctx.harness.db, 'sync_receipts'),
    }

    // 同一批次里：一个合法的新建 + 一个基线过期的更新。
    const innocent = docOp('doc_innocent', { newRevision: rev(1) })
    const stale = docOp('doc_conflict', { baseRevision: rev(9), newRevision: rev(10) })
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [innocent, stale]),
    )

    expect(response.statusCode).toBe(409)
    const failure = response.json<BatchFailureBody>()
    expect(failure.ok).toBe(false)
    expect(failure.code).toBe('SYNC_BATCH_REJECTED')
    expect(failure.conflicts).toHaveLength(1)
    const conflict = failure.conflicts[0]
    expect(conflict?.opId).toBe(stale.opId)
    expect(conflict?.entityId).toBe('doc_conflict')
    expect(conflict?.reason).toBe('revision-mismatch')
    expect(conflict?.expectedBaseRevision).toBe(rev(9))
    expect(conflict?.currentRevision).toBe(rev(1))

    // 整批零写入：连那个完全合法的操作也不能落库，回执也不能有。
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(before.feed)
    expect(countRows(ctx.harness.db, 'sync_entities')).toBe(before.entities)
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(before.receipts)
    // 冲突留痕是唯一被允许的写入（可读冲突元数据的持久化副本）。
    expect(countRows(ctx.harness.db, 'sync_conflicts')).toBe(1)
  })

  it('更新必须匹配当前 revision：基线过期 → 409', async () => {
    const ctx = await setup()
    const created = docOp('doc_create_twice', { newRevision: rev(1) })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [created]))).statusCode).toBe(200)

    const again = docOp('doc_create_twice', { baseRevision: rev(1), newRevision: rev(2) })
    const response = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [again]))
    // base 与当前一致 → 这是合法的"接着改"，不是冲突；换个过期基线才是冲突。
    expect(response.statusCode).toBe(200)

    const staleCreate = docOp('doc_create_twice', { baseRevision: rev(7), newRevision: rev(8) })
    const staleResponse = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [staleCreate]))
    expect(staleResponse.statusCode).toBe(409)
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(2)
  })

  it('对已删除的实体提交更新 → 409 entity-deleted', async () => {
    const ctx = await setup()
    const created = docOp('doc_deleted_base', { newRevision: rev(1) })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [created]))).statusCode).toBe(200)
    const deleted = docOp('doc_deleted_base', {
      action: 'delete',
      baseRevision: rev(1),
      newRevision: rev(2),
    })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [deleted]))).statusCode).toBe(200)

    const feed = countRows(ctx.harness.db, 'change_feed')
    const resurrect = docOp('doc_deleted_base', { baseRevision: rev(2), newRevision: rev(3) })
    const response = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [resurrect]))
    expect(response.statusCode).toBe(409)
    const failure = response.json<BatchFailureBody>()
    expect(failure.conflicts[0]?.reason).toBe('entity-deleted')
    expect(failure.conflicts[0]?.currentRevision).toBe(rev(2))
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(feed)
  })

  it('409 冲突响应体不含 cause 或堆栈', async () => {
    const ctx = await setup()
    const created = docOp('doc_conflict_body', { newRevision: rev(1) })
    expect((await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [created]))).statusCode).toBe(200)
    const stale = docOp('doc_conflict_body', { baseRevision: rev(5), newRevision: rev(6) })

    const response = await postBatch(ctx, makeBatchBody(ctx.workspaceId, ctx.deviceId, [stale]))
    expect(response.statusCode).toBe(409)
    expect(response.body).not.toContain('"cause"')
    expect(response.body).not.toContain('"stack"')
    expect(response.body).not.toContain('SqliteError')
  })
})

describe('POST batches —— 设备交叉验证', () => {
  it('设备属于其他主体返回 403，且不透露设备是否存在', async () => {
    const ctx = await setup()
    const at = ctx.harness.clock.now()
    const bob = await seedOwner(ctx.harness.db, at, { username: 'bob', password: TEST_PASSWORD })
    const bobDevice = seedDevice(ctx.harness.db, at, bob.userId, bob.workspaceId)

    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, bobDevice, [docOp('doc_a')]),
    )
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_DENIED')
    expect(body.detail?.reason).toBe('unknown_device')
  })

  it('未知 deviceId 返回 403', async () => {
    const ctx = await setup()
    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, newIds.device(), [docOp('doc_a')]),
    )
    expect(response.statusCode).toBe(403)
    expect(response.json<{ detail?: { reason?: string } }>().detail?.reason).toBe('unknown_device')
  })

  it('已撤销的设备返回 401 AUTH_DEVICE_REVOKED', async () => {
    const ctx = await setup()
    revokeDevice(ctx.harness.db, ctx.deviceId, ctx.harness.clock.now(), '测试撤销')

    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_a')]),
    )
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_DEVICE_REVOKED')
  })

  it('设备绑定了别的工作区返回 403 PERMISSION_WORKSPACE_MISMATCH', async () => {
    const ctx = await setup()
    const at = ctx.harness.clock.now()
    const bob = await seedOwner(ctx.harness.db, at, { username: 'bob', password: TEST_PASSWORD })
    const foreignDevice = seedDevice(ctx.harness.db, at, ctx.userId, bob.workspaceId)

    const response = await postBatch(
      ctx,
      makeBatchBody(ctx.workspaceId, foreignDevice, [docOp('doc_a')]),
    )
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(body.detail?.reason).toBe('device_workspace_mismatch')
  })
})
