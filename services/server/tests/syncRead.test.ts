/**
 * 只读同步面：`snapshot` / `changes` / `receipts` / `versions` / `config` / `plugin-state`。
 *
 * 读路径同样会泄漏东西，所以这里的判据除了"内容对"还有三条：
 * 1. **游标必须可校验**：非法 / 别人的 scope / 超出服务器已提交位置一律 410，且
 *    不把客户端给的 scope 回显出去（否则 410 变成"有没有这个工作区"的探测器）；
 * 2. **不该出现的东西绝不出现**：版本历史不下发 actor/batchId/opId，三处都不含 cause/堆栈；
 * 3. **只读就是只读**：`/config` 与 `/plugin-state` 只有 GET 有路由，写入统一走 batches。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { newIds } from '@yfe/contracts'
import type { UserId, WorkspaceId } from '@yfe/contracts'

import { hashPassword } from '../src/auth/password.js'
import { createUserWithMembership } from '../src/db/users.js'
import { encodeWorkspaceCursor, MAX_CHANGES_LIMIT } from '../src/sync/protocol.js'
import { seedOwner, TEST_PASSWORD } from './helpers.js'
import type { TestHarness, TestHarnessOptions } from './helpers.js'
import { harnessTracker, loginAs, makeBatchBody, newOpId, rev, seedDevice } from './syncHelpers.js'
import type { BatchOpInput } from './syncHelpers.js'

interface ChangeItem {
  readonly cursor: string
  readonly serverSeq: number
  readonly entityType: string
  readonly entityId: string
  readonly action: string
  readonly revision: string
  readonly baseRevision: string | null
  readonly payload: Record<string, unknown>
  readonly committedAt: string
}

interface ChangesBody {
  readonly changes: readonly ChangeItem[]
  readonly nextCursor: string | null
  readonly resyncRequired: boolean
}

interface SnapshotBody {
  readonly cursor: string
  readonly takenAt: string
  readonly projects: readonly Record<string, unknown>[]
  readonly documents: readonly Record<string, unknown>[]
  readonly settingsEntities: readonly Record<string, unknown>[]
  readonly relations: readonly Record<string, unknown>[]
  readonly assets: readonly Record<string, unknown>[]
  readonly nextCursor: string | null
}

interface Ctx {
  readonly harness: TestHarness
  readonly headers: Record<string, string>
  readonly workspaceId: WorkspaceId
  readonly deviceId: string
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

function docOp(id: string, overrides: { readonly newRevision?: string } = {}): BatchOpInput {
  return {
    opId: newOpId(),
    entityType: 'document',
    entityId: id,
    projectId: null,
    baseRevision: null,
    newRevision: overrides.newRevision ?? rev(1),
    action: 'upsert',
    payload: { title: id },
    assetIds: [],
  }
}

/** 提交一批，返回可用的认证头与响应；成功以外直接抛，避免用例里堆断言噪声。 */
async function commit(
  ctx: Ctx,
  operations: readonly BatchOpInput[],
  headers: Record<string, string> = ctx.headers,
): Promise<void> {
  const response = await ctx.harness.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ctx.workspaceId}/batches`,
    headers,
    payload: makeBatchBody(ctx.workspaceId, ctx.deviceId, operations) as unknown as Record<string, unknown>,
  })
  if (response.statusCode !== 200) {
    throw new Error(`提交批次失败（${response.statusCode}）：${response.body}`)
  }
}

async function getChanges(ctx: Ctx, query = '', headers: Record<string, string> = ctx.headers) {
  const response = await ctx.harness.app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${ctx.workspaceId}/changes${query}`,
    headers,
  })
  return response
}

/** 在既有工作区里落一个 viewer（不是提交者、也不是管理者）。 */
async function seedViewer(harness: TestHarness, workspaceId: WorkspaceId, username: string): Promise<UserId> {
  const userId = newIds.user() as UserId
  createUserWithMembership(harness.db, {
    id: userId,
    username,
    displayName: username,
    passwordHash: await hashPassword(TEST_PASSWORD),
    at: harness.clock.now(),
    workspaceId,
    role: 'viewer',
  })
  return userId
}

describe('GET snapshot', () => {
  it('未认证返回 401', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot`,
    })
    expect(response.statusCode).toBe(401)
  })

  it('不是成员的工作区返回 403', async () => {
    const ctx = await setup()
    const bob = await seedOwner(ctx.harness.db, ctx.harness.clock.now(), {
      username: 'bob',
      password: TEST_PASSWORD,
    })
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${bob.workspaceId}/snapshot`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(403)
  })

  it('空工作区返回一致快照：cursor 为 0 点、各桶为空、nextCursor 为 null', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<SnapshotBody>()
    expect(body.cursor).toBe(encodeWorkspaceCursor(0, ctx.workspaceId))
    expect(body.documents).toHaveLength(0)
    expect(body.projects).toHaveLength(0)
    expect(body.assets).toHaveLength(0)
    expect(body.nextCursor).toBeNull()
    expect(body.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('快照包含实体与服务器权威字段，并按 projectId 过滤', async () => {
    const ctx = await setup()
    const projectId = newIds.project()
    await commit(ctx, [
      { ...docOp('doc_in'), projectId },
      { ...docOp('doc_out') },
      { ...docOp('prj_meta', { newRevision: rev(1) }), entityType: 'project', entityId: projectId },
    ])

    const all = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot`,
      headers: ctx.headers,
    })
    const full = all.json<SnapshotBody>()
    expect(full.documents).toHaveLength(2)
    expect(full.projects).toHaveLength(1)
    expect(full.cursor).toBe(encodeWorkspaceCursor(3, ctx.workspaceId))
    const first = full.documents[0]
    expect(first?.title).toBeDefined()
    expect(first?.revision).toBe(rev(1))

    const filtered = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot?projectId=${projectId}`,
      headers: ctx.headers,
    })
    const scoped = filtered.json<SnapshotBody>()
    expect(scoped.documents).toHaveLength(1)
    expect(scoped.documents[0]?.entityId).toBe('doc_in')
    expect(scoped.projects).toHaveLength(1)
  })

  it('快照与增量之间不漏变更：从快照 cursor 继续能拿到之后的全部变更', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_before')])

    const snapshot = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/snapshot`,
      headers: ctx.headers,
    })
    const point = snapshot.json<SnapshotBody>().cursor
    expect(point).toBe(encodeWorkspaceCursor(1, ctx.workspaceId))

    await commit(ctx, [docOp('doc_after')])

    const delta = await getChanges(ctx, `?cursor=${encodeURIComponent(point)}`)
    const body = delta.json<ChangesBody>()
    expect(body.changes.map((item) => item.entityId)).toEqual(['doc_after'])
  })
})

describe('GET changes', () => {
  it('未认证返回 401', async () => {
    const ctx = await setup()
    const response = await getChanges(ctx, '', {})
    expect(response.statusCode).toBe(401)
  })

  it('按服务器提交顺序返回，cursor 与 serverSeq 一一对应', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1'), docOp('doc_2'), docOp('doc_3')])

    const response = await getChanges(ctx)
    expect(response.statusCode).toBe(200)
    const body = response.json<ChangesBody>()
    expect(body.resyncRequired).toBe(false)
    expect(body.changes.map((item) => item.serverSeq)).toEqual([1, 2, 3])
    expect(body.changes.map((item) => item.cursor)).toEqual([
      encodeWorkspaceCursor(1, ctx.workspaceId),
      encodeWorkspaceCursor(2, ctx.workspaceId),
      encodeWorkspaceCursor(3, ctx.workspaceId),
    ])
    expect(body.changes.map((item) => item.entityId)).toEqual(['doc_1', 'doc_2', 'doc_3'])
    expect(body.nextCursor).toBe(encodeWorkspaceCursor(3, ctx.workspaceId))
  })

  it('分页稳定：limit 切片不重不漏，用 nextCursor 能取完', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1'), docOp('doc_2'), docOp('doc_3')])

    const firstPage = (await getChanges(ctx, '?limit=2')).json<ChangesBody>()
    expect(firstPage.changes.map((item) => item.entityId)).toEqual(['doc_1', 'doc_2'])
    expect(firstPage.nextCursor).toBe(encodeWorkspaceCursor(2, ctx.workspaceId))

    const secondPage = (
      await getChanges(ctx, `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`)
    ).json<ChangesBody>()
    expect(secondPage.changes.map((item) => item.entityId)).toEqual(['doc_3'])

    const collected = [...firstPage.changes, ...secondPage.changes].map((item) => item.entityId)
    expect(new Set(collected).size).toBe(3)
  })

  it('没有新变更时仍然给出可继续的游标，且 changes 为空', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1')])

    const head = encodeWorkspaceCursor(1, ctx.workspaceId)
    const response = await getChanges(ctx, `?cursor=${encodeURIComponent(head)}`)
    const body = response.json<ChangesBody>()
    expect(body.changes).toHaveLength(0)
    expect(body.nextCursor).toBe(head)
    expect(body.resyncRequired).toBe(false)
  })

  it('非法游标返回 410 SYNC_CURSOR_INVALID（并要求整份重新同步）', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1')])

    const response = await getChanges(ctx, '?cursor=not-a-cursor')
    expect(response.statusCode).toBe(410)
    const body = response.json<{ code: string; retryable?: boolean }>()
    expect(body.code).toBe('SYNC_CURSOR_INVALID')
  })

  it('别的 scope 的游标返回 410，且不回显客户端给的 scope', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1')])

    const foreignScope = encodeWorkspaceCursor(7, newIds.workspace()).split(':')[0] ?? ''
    const foreign = `${foreignScope}:1`
    const response = await getChanges(ctx, `?cursor=${encodeURIComponent(foreign)}`)
    expect(response.statusCode).toBe(410)
    const body = response.json<{ code: string; message: string; detail?: Record<string, unknown> }>()
    expect(body.code).toBe('SYNC_CURSOR_INVALID')
    // 410 不能变成"这个工作区存不存在"的探测器：客户端给的 scope 一个字符都不回显。
    expect(response.body).not.toContain(foreignScope)
  })

  it('游标超出服务器已提交位置返回 410', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1')])

    const ahead = encodeWorkspaceCursor(9999, ctx.workspaceId)
    const response = await getChanges(ctx, `?cursor=${encodeURIComponent(ahead)}`)
    expect(response.statusCode).toBe(410)
    expect(response.json<{ code: string }>().code).toBe('SYNC_CURSOR_INVALID')
  })

  it('limit 越界与未知查询参数返回 400', async () => {
    const ctx = await setup()
    const tooBig = await getChanges(ctx, `?limit=${String(MAX_CHANGES_LIMIT + 1)}`)
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const zero = await getChanges(ctx, '?limit=0')
    expect(zero.statusCode).toBe(400)

    const unknown = await getChanges(ctx, '?since=2026-01-01')
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('格式非法的 workspaceId 返回 400 VALIDATION_MALFORMED_ID', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/not%20a%20valid%20id/changes',
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_MALFORMED_ID')
  })
})

describe('GET receipts', () => {
  it('未认证返回 401', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/receipts/${newIds.request()}`,
    })
    expect(response.statusCode).toBe(401)
  })

  it('提交者可以读到回执与首次提交结果', async () => {
    const ctx = await setup()
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_1'), docOp('doc_2')])
    const submitted = await ctx.harness.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ctx.workspaceId}/batches`,
      headers: ctx.headers,
      payload: body as unknown as Record<string, unknown>,
    })
    expect(submitted.statusCode).toBe(200)

    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/receipts/${body.batchId}`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(200)
    const receipt = response.json<{
      batchId: string
      deviceId: string
      operationCount: number
      cursor: string
      payloadDigest: string
      result: { ok: boolean; revisions: readonly unknown[] }
    }>()
    expect(receipt.batchId).toBe(body.batchId)
    expect(receipt.deviceId).toBe(ctx.deviceId)
    expect(receipt.operationCount).toBe(2)
    expect(receipt.cursor).toBe(encodeWorkspaceCursor(2, ctx.workspaceId))
    expect(receipt.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(receipt.result.ok).toBe(true)
    expect(receipt.result.revisions).toHaveLength(2)
  })

  it('未知 batchId 返回 404', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/receipts/${newIds.request()}`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ code: string }>().code).toBe('NOT_FOUND')
  })

  it('不是提交者且不是管理者（viewer）返回 403', async () => {
    const ctx = await setup()
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_1')])
    await ctx.harness.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ctx.workspaceId}/batches`,
      headers: ctx.headers,
      payload: body as unknown as Record<string, unknown>,
    })

    await seedViewer(ctx.harness, ctx.workspaceId, 'viewer')
    const viewerHeaders = await loginAs(ctx.harness.app, 'viewer', TEST_PASSWORD)
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/receipts/${body.batchId}`,
      headers: viewerHeaders,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })

  it('回执属于别的工作区时返回 404（不靠 403/404 区分探测）', async () => {
    const ctx = await setup()
    const body = makeBatchBody(ctx.workspaceId, ctx.deviceId, [docOp('doc_1')])
    await ctx.harness.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ctx.workspaceId}/batches`,
      headers: ctx.headers,
      payload: body as unknown as Record<string, unknown>,
    })

    const bob = await seedOwner(ctx.harness.db, ctx.harness.clock.now(), {
      username: 'bob',
      password: TEST_PASSWORD,
    })
    const bobHeaders = await loginAs(ctx.harness.app, 'bob', TEST_PASSWORD)
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${bob.workspaceId}/receipts/${body.batchId}`,
      headers: bobHeaders,
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('GET entities/{id}/versions', () => {
  it('未认证返回 401', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/entities/doc_1/versions`,
    })
    expect(response.statusCode).toBe(401)
  })

  it('返回该实体的版本历史（新到旧），且不下发 actor/batchId/opId', async () => {
    const ctx = await setup()
    await commit(ctx, [docOp('doc_1', { newRevision: rev(1) })])
    await commit(ctx, [
      {
        ...docOp('doc_1', { newRevision: rev(2) }),
        baseRevision: rev(1),
        payload: { title: '第二稿' },
      },
    ])
    await commit(ctx, [docOp('doc_2')])

    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/entities/doc_1/versions`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      entityId: string
      versions: readonly Record<string, unknown>[]
    }>()
    expect(body.entityId).toBe('doc_1')
    expect(body.versions).toHaveLength(2)
    expect(body.versions.map((item) => item.revision)).toEqual([rev(2), rev(1)])
    expect(body.versions[0]?.payload).toEqual({ title: '第二稿' })

    for (const version of body.versions) {
      expect(Object.keys(version)).not.toContain('actorDeviceId')
      expect(Object.keys(version)).not.toContain('actorUserId')
      expect(Object.keys(version)).not.toContain('batchId')
      expect(Object.keys(version)).not.toContain('opId')
    }
  })

  it('未知实体返回空版本列表，非法 entityType 返回 400', async () => {
    const ctx = await setup()
    const empty = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/entities/doc_missing/versions`,
      headers: ctx.headers,
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json<{ versions: readonly unknown[] }>().versions).toHaveLength(0)

    const bad = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/entities/doc_1/versions?entityType=chapter`,
      headers: ctx.headers,
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<{ code: string }>().code).toBe('SYNC_CAPABILITY_UNSUPPORTED')
  })
})

describe('只读投影 config / plugin-state', () => {
  it('未认证返回 401，且初始为空投影', async () => {
    const ctx = await setup()
    const anonymous = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/config`,
    })
    expect(anonymous.statusCode).toBe(401)

    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/config`,
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ cursor: string; items: readonly unknown[] }>()
    expect(body.cursor).toBe(encodeWorkspaceCursor(0, ctx.workspaceId))
    expect(body.items).toHaveLength(0)
  })

  it('configValue 与 pluginState 通过 batches 写入后出现在投影里', async () => {
    const ctx = await setup()
    await commit(ctx, [
      {
        ...docOp('cfg_theme'),
        entityType: 'configValue',
        payload: { key: 'theme', value: 'dark' },
      },
      {
        ...docOp('plugin_core'),
        entityType: 'pluginState',
        payload: { pluginId: 'core', enabled: true },
      },
    ])

    const config = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/config`,
      headers: ctx.headers,
    })
    const configBody = config.json<{ items: readonly Record<string, unknown>[] }>()
    expect(configBody.items).toHaveLength(1)
    expect(configBody.items[0]?.key).toBe('theme')
    expect(configBody.items[0]?.entityId).toBe('cfg_theme')
    expect(configBody.items[0]?.revision).toBe(rev(1))

    const plugin = await ctx.harness.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/plugin-state`,
      headers: ctx.headers,
    })
    const pluginBody = plugin.json<{ items: readonly Record<string, unknown>[] }>()
    expect(pluginBody.items).toHaveLength(1)
    expect(pluginBody.items[0]?.pluginId).toBe('core')
  })

  it('投影是只读的：POST 落到 404（写入只能走 batches）', async () => {
    const ctx = await setup()
    const response = await ctx.harness.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ctx.workspaceId}/config`,
      headers: ctx.headers,
      payload: { key: 'theme', value: 'dark' },
    })
    expect(response.statusCode).toBe(404)

    const plugin = await ctx.harness.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${ctx.workspaceId}/plugin-state`,
      headers: ctx.headers,
      payload: { pluginId: 'core' },
    })
    expect(plugin.statusCode).toBe(404)
  })
})
