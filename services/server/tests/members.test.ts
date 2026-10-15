/**
 * `/api/v1/workspaces/:workspaceId/members*` —— 工作区成员与角色管理。
 *
 * 这里最要紧的四条：
 * 1. **路径里的 `workspaceId` 才是判定对象。** 守卫判一次、处理器再判一次
 *    （与 `routes/devices.ts` 同样的做法）；不是成员就是 403，猜中 workspaceId 没用。
 * 2. **管成员的资格来自角色。** 只有 `admin` / `owner`（`canManageMembers`）能加人、
 *    改角色、删人；`viewer` 连加人都做不到。
 * 3. **最后一名管理者不能被删掉或降级。** 否则这个工作区再也没人能加人、
 *    改角色或授权设备，只能手工改库。
 * 4. **重复添加是 409，不是静默改角色。** 用 `upsertMember` 直接写会让
 *    "再加一次"变成一次看不出差别的角色变更。
 *
 * ## 装配方式
 *
 * 成员路由已由 `registerRoutes()` 统一登记（`src/routes/index.ts`），
 * `createServer()` 的全表装配就会带上它们，所以本文件**不再**自行
 * `app.register(...)`：重复注册同一 method+url 会让 Fastify 抛
 * `FST_ERR_ROUTE_ALREADY_DECLARED`（R-39）。这里只需照抄 `makeHarness`
 * 的装配顺序与临时库清理。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { newIds } from '@yfe/contracts'
import type { UserId, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createRateLimiter } from '../src/http/rateLimit.js'
import { createServer } from '../src/http/server.js'
import { cleanupTempDirs, makeTempDir, seedOwner, testClock, TEST_PASSWORD } from './helpers.js'
import type { TestClock } from './helpers.js'
import { loginAs, withoutCsrf } from './syncHelpers.js'

interface MemberHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  close(): void
}

async function makeMemberHarness(): Promise<MemberHarness> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  const clock = testClock()
  const serverId = 'srv_member_test'
  const config = defaultServerConfig({
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
  })
  ensureServerState(db, serverId, null)

  const app = createServer({
    config,
    db,
    serverId,
    clock,
    logger: false,
    storageRoot: makeTempDir(),
    rateLimiters: {
      setup: createRateLimiter({ windowMs: 60_000, maxAttempts: 1000 }),
      login: createRateLimiter({ windowMs: 60_000, maxAttempts: 1000 }),
    },
  })

  try {
    await app.ready()
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  return {
    app,
    db,
    clock,
    close(): void {
      closeServerDatabase(db)
    },
  }
}

const openHarnesses: MemberHarness[] = []

async function makeHarness(): Promise<MemberHarness> {
  const harness = await makeMemberHarness()
  openHarnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of openHarnesses.splice(0)) harness.close()
  cleanupTempDirs()
})

interface Seeded {
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
}

async function seedUser(harness: MemberHarness, username: string): Promise<Seeded> {
  return seedOwner(harness.db, harness.clock.now(), { username, password: TEST_PASSWORD })
}

function membersUrl(workspaceId: WorkspaceId | string): string {
  return `/api/v1/workspaces/${workspaceId}/members`
}

interface MemberBody {
  readonly member: {
    readonly userId: string
    readonly username: string
    readonly displayName: string
    readonly role: string
    readonly createdAt: string
  }
}

describe('GET /api/v1/workspaces/:workspaceId/members', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const response = await harness.app.inject({ method: 'GET', url: membersUrl(alice.workspaceId) })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('不是该工作区成员返回 403 PERMISSION_DENIED（猜中 workspaceId 不等于有权限）', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'bob', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'GET',
      url: membersUrl(alice.workspaceId),
      headers,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    expect(response.body).not.toContain('alice')
  })

  it('成员能看到成员列表，字段为 userId/username/displayName/role/createdAt', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'GET',
      url: membersUrl(alice.workspaceId),
      headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ members: readonly MemberBody['member'][] }>()
    expect(body.members).toHaveLength(1)
    const only = body.members[0]
    expect(only?.userId).toBe(alice.userId)
    expect(only?.username).toBe('alice')
    expect(only?.role).toBe('owner')
    expect(typeof only?.displayName).toBe('string')
    expect(typeof only?.createdAt).toBe('string')
  })
})

describe('POST /api/v1/workspaces/:workspaceId/members', () => {
  it('owner 按 username 加成员：201，列表里立刻出现', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const created = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { username: 'bob', role: 'viewer' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json<MemberBody>()
    expect(body.member.userId).toBe(bob.userId)
    expect(body.member.username).toBe('bob')
    expect(body.member.role).toBe('viewer')

    const listed = await harness.app.inject({
      method: 'GET',
      url: membersUrl(alice.workspaceId),
      headers,
    })
    const members = listed.json<{ members: readonly MemberBody['member'][] }>().members
    expect(members).toHaveLength(2)
    expect(members.map((member) => member.userId)).toContain(bob.userId)
  })

  it('owner 按 userId 加成员同样可以', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const created = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'editor' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json<MemberBody>().member.role).toBe('editor')
  })

  it('重复添加同一 (workspace,user) 返回 409 ALREADY_EXISTS，不静默改角色', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const first = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'viewer' },
    })
    expect(first.statusCode).toBe(201)

    const again = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'owner' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json<{ code: string }>().code).toBe('ALREADY_EXISTS')

    // 角色没有被第二次请求改掉。
    const listed = await harness.app.inject({
      method: 'GET',
      url: membersUrl(alice.workspaceId),
      headers,
    })
    const bobRow = listed
      .json<{ members: readonly MemberBody['member'][] }>()
      .members.find((member) => member.userId === bob.userId)
    expect(bobRow?.role).toBe('viewer')
  })

  it('非法角色返回 400 VALIDATION_FAILED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'superadmin' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('目标用户不存在返回 404 NOT_FOUND（userId 与 username 两条路径都是 404）', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const byId = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: newIds.user(), role: 'viewer' },
    })
    expect(byId.statusCode).toBe(404)
    expect(byId.json<{ code: string }>().code).toBe('NOT_FOUND')

    const byName = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { username: 'nobody', role: 'viewer' },
    })
    expect(byName.statusCode).toBe(404)
    expect(byName.json<{ code: string }>().code).toBe('NOT_FOUND')
  })

  it('userId 与 username 都不给是 400 VALIDATION_MISSING_FIELD，同时给是 400 VALIDATION_FAILED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const neither = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { role: 'viewer' },
    })
    expect(neither.statusCode).toBe(400)
    expect(neither.json<{ code: string }>().code).toBe('VALIDATION_MISSING_FIELD')

    const both = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, username: 'bob', role: 'viewer' },
    })
    expect(both.statusCode).toBe(400)
    expect(both.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('viewer 无权加成员：403 PERMISSION_DENIED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const carol = await seedUser(harness, 'carol')
    const ownerHeaders = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const added = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers: ownerHeaders,
      payload: { userId: bob.userId, role: 'viewer' },
    })
    expect(added.statusCode).toBe(201)

    const bobHeaders = await loginAs(harness.app, 'bob', TEST_PASSWORD)
    const denied = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers: bobHeaders,
      payload: { userId: carol.userId, role: 'viewer' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })

  it('缺 CSRF 头返回 403（写请求经既有 CSRF 判定，未在处理器里另写一份）', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers: withoutCsrf(headers),
      payload: { userId: bob.userId, role: 'viewer' },
    })
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_DENIED')
    expect(body.detail?.reason).toBe('csrf_token_invalid')
  })
})

describe('PATCH /api/v1/workspaces/:workspaceId/members/:userId', () => {
  it('owner 改成员角色成功', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)
    await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'viewer' },
    })

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${membersUrl(alice.workspaceId)}/${bob.userId}`,
      headers,
      payload: { role: 'editor' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<MemberBody>().member.role).toBe('editor')
  })

  it('非法角色返回 400 VALIDATION_FAILED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${membersUrl(alice.workspaceId)}/${alice.userId}`,
      headers,
      payload: { role: 'root' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('不能把最后一名 owner 降级：409 STATE_INVALID_TRANSITION', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${membersUrl(alice.workspaceId)}/${alice.userId}`,
      headers,
      payload: { role: 'viewer' },
    })
    expect(response.statusCode).toBe(409)
    const body = response.json<{ code: string; detail?: { ownerCount?: number } }>()
    expect(body.code).toBe('STATE_INVALID_TRANSITION')
    expect(body.detail?.ownerCount).toBe(0)
  })

  it('存在第二名 owner 时，把自己降级是允许的（保护不是无差别拦截）', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)
    await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'owner' },
    })

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${membersUrl(alice.workspaceId)}/${alice.userId}`,
      headers,
      payload: { role: 'viewer' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<MemberBody>().member.role).toBe('viewer')
  })

  it('成员不存在返回 404 NOT_FOUND', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${membersUrl(alice.workspaceId)}/${newIds.user()}`,
      headers,
      payload: { role: 'editor' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ code: string }>().code).toBe('NOT_FOUND')
  })
})

describe('DELETE /api/v1/workspaces/:workspaceId/members/:userId', () => {
  it('删成员成功，列表里不再出现', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)
    await harness.app.inject({
      method: 'POST',
      url: membersUrl(alice.workspaceId),
      headers,
      payload: { userId: bob.userId, role: 'editor' },
    })

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `${membersUrl(alice.workspaceId)}/${bob.userId}`,
      headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ userId: string; removed: boolean }>()
    expect(body.userId).toBe(bob.userId)
    expect(body.removed).toBe(true)

    const listed = await harness.app.inject({
      method: 'GET',
      url: membersUrl(alice.workspaceId),
      headers,
    })
    const members = listed.json<{ members: readonly MemberBody['member'][] }>().members
    expect(members.map((member) => member.userId)).not.toContain(bob.userId)
  })

  it('不能删掉最后一名 owner：409 STATE_INVALID_TRANSITION', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `${membersUrl(alice.workspaceId)}/${alice.userId}`,
      headers,
    })
    expect(response.statusCode).toBe(409)
    const body = response.json<{ code: string; detail?: { ownerCount?: number } }>()
    expect(body.code).toBe('STATE_INVALID_TRANSITION')
    expect(body.detail?.ownerCount).toBe(0)
  })

  it('删不存在的成员返回 404 NOT_FOUND', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `${membersUrl(alice.workspaceId)}/${newIds.user()}`,
      headers,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ code: string }>().code).toBe('NOT_FOUND')
  })

  it('viewer 无权删成员：403 PERMISSION_DENIED', async () => {
    const harness = await makeHarness()
    const alice = await seedUser(harness, 'alice')
    const bob = await seedUser(harness, 'bob')
    const carol = await seedUser(harness, 'carol')
    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)
    for (const [userId, role] of [
      [bob.userId, 'viewer'],
      [carol.userId, 'viewer'],
    ] as const) {
      const added = await harness.app.inject({
        method: 'POST',
        url: membersUrl(alice.workspaceId),
        headers,
        payload: { userId, role },
      })
      expect(added.statusCode).toBe(201)
    }

    const bobHeaders = await loginAs(harness.app, 'bob', TEST_PASSWORD)
    const denied = await harness.app.inject({
      method: 'DELETE',
      url: `${membersUrl(alice.workspaceId)}/${carol.userId}`,
      headers: bobHeaders,
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })
})
