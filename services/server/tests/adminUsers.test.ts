/**
 * `/api/v1/admin/users*` —— 系统管理员的用户管理面。
 *
 * 这里最要紧的三条：
 * 1. **系统管理员来自 `server_state.owner_user_id`**，不是 `users` 表上的某个列。
 *    `seedOwner` 只落用户与成员关系、**不标记服务器已初始化**，所以本文件所有
 *    管理员用例都要额外 `markServerInitialized(db, admin.userId, at)`。
 * 2. **非管理员是 403，不是 404。** 用 404 掩盖会把权限问题伪装成部署问题，
 *    而且响应体里绝不能出现任何用户数据。
 * 3. **停用/重置密码必须立刻撤销凭据。** 断言方式是"旧会话请求 401"而不是
 *    "响应里有个字段"，因为前者才是攻击者能感知到的边界。
 *
 * ## 装配方式
 *
 * 管理面路由已由 `registerRoutes()` 统一登记（`src/routes/index.ts`），
 * `createServer()` 的全表装配就会带上它们，所以本文件**不再**自行
 * `app.register(...)`：重复注册同一 method+url 会让 Fastify 抛
 * `FST_ERR_ROUTE_ALREADY_DECLARED`，整份文件崩在 `ready()` 之前（R-39）。
 * 这里只需照抄 `makeHarness` 的装配顺序（同样的配置、同样的临时库清理）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { newIds } from '@yfe/contracts'
import type { UserId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { countEnabledSystemAdminsAfterChange } from '../src/db/admin.js'
import { AUDIT_ACTIONS, queryAuditEvents } from '../src/db/audit.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { listSessionsForUser } from '../src/db/sessions.js'
import { ensureServerState, markServerInitialized } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createRateLimiter } from '../src/http/rateLimit.js'
import { createServer } from '../src/http/server.js'
import { cleanupTempDirs, makeTempDir, seedOwner, testClock, TEST_PASSWORD } from './helpers.js'
import type { TestClock } from './helpers.js'
import { loginAs, withoutCsrf } from './syncHelpers.js'

const ADMIN_USERS_URL = '/api/v1/admin/users'
const ME_URL = '/api/v1/users/me'
const LOGIN_URL = '/api/v1/auth/login'
const NEW_PASSWORD = 'brand-new-passphrase-2026'

interface AdminHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  close(): void
}

async function makeAdminHarness(): Promise<AdminHarness> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  const clock = testClock()
  const serverId = 'srv_admin_test'
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

  // 管理面路由由 `createServer` 的全表装配提供（`routes/index.ts` 已登记），
  // 这里**不再**自行 `app.register(...)`：重复注册同一 method+path 会让
  // Fastify 抛 `FST_ERR_ROUTE_ALREADY_DECLARED`，整份测试文件崩在 ready() 之前。

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

const openHarnesses: AdminHarness[] = []

async function makeHarness(): Promise<AdminHarness> {
  const harness = await makeAdminHarness()
  openHarnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of openHarnesses.splice(0)) harness.close()
  cleanupTempDirs()
})

/** 落一个**真正的系统管理员**：先建用户，再把 `server_state` 标记成已初始化。 */
async function seedAdmin(
  harness: AdminHarness,
  username = 'admin',
): Promise<{ readonly userId: UserId }> {
  const at = harness.clock.now()
  const seeded = await seedOwner(harness.db, at, { username, password: TEST_PASSWORD })
  const marked = markServerInitialized(harness.db, seeded.userId, at)
  expect(marked).toBe(true)
  return { userId: seeded.userId }
}

async function seedUser(
  harness: AdminHarness,
  username: string,
): Promise<{ readonly userId: UserId }> {
  const seeded = await seedOwner(harness.db, harness.clock.now(), {
    username,
    password: TEST_PASSWORD,
  })
  return { userId: seeded.userId }
}

interface AdminUserBody {
  readonly user: {
    readonly userId: string
    readonly username: string
    readonly displayName: string
    readonly disabled: boolean
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly revokedSessions?: number
}

describe('GET /api/v1/admin/users', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const harness = await makeHarness()
    const response = await harness.app.inject({ method: 'GET', url: ADMIN_USERS_URL })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('非系统管理员返回 403 PERMISSION_DENIED，且响应体不含任何用户数据', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'bob', TEST_PASSWORD)

    const response = await harness.app.inject({ method: 'GET', url: ADMIN_USERS_URL, headers })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    // 不是 404：接口存在，只是这个主体不能看。响应体里也没有用户列表。
    expect(response.statusCode).not.toBe(404)
    expect(response.body).not.toContain('bob')
    expect(response.body).not.toContain('"users"')
  })

  it('系统管理员拿到用户列表，字段按白名单投影且没有密码摘要', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({ method: 'GET', url: ADMIN_USERS_URL, headers })
    expect(response.statusCode).toBe(200)

    const body = response.json<{ users: readonly AdminUserBody['user'][] }>()
    expect(body.users).toHaveLength(2)
    const ids = body.users.map((user) => user.userId)
    expect(ids).toContain(admin.userId)
    expect(ids).toContain(bob.userId)

    const listed = body.users.find((user) => user.userId === bob.userId)
    expect(listed?.username).toBe('bob')
    expect(listed?.disabled).toBe(false)
    expect(typeof listed?.displayName).toBe('string')
    expect(typeof listed?.createdAt).toBe('string')
    expect(typeof listed?.updatedAt).toBe('string')

    // 摘要（或任何 scrypt 参数）绝不能出现在响应里。
    expect(response.body).not.toContain('passwordHash')
    expect(response.body).not.toContain('scrypt')
  })
})

describe('PATCH /api/v1/admin/users/:userId', () => {
  it('缺 CSRF 头返回 403（Cookie 会话的写请求必须校验 CSRF，管理面不例外）', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${admin.userId}`,
      headers: withoutCsrf(headers),
      payload: { displayName: '新名字' },
    })
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_DENIED')
    expect(body.detail?.reason).toBe('csrf_token_invalid')
  })

  it('空 body 与未知字段都被拒（不能把 displayName 之外的字段静默忽略）', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const empty = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${admin.userId}`,
      headers,
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json<{ code: string }>().code).toBe('VALIDATION_FAILED')

    const unknown = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${admin.userId}`,
      headers,
      payload: { displayName: '新名字', role: 'admin' },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('改 displayName 成功：用户名字不变，updatedAt 前进', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const before = await harness.app.inject({ method: 'GET', url: ADMIN_USERS_URL, headers })
    const beforeRow = before
      .json<{ users: readonly AdminUserBody['user'][] }>()
      .users.find((user) => user.userId === bob.userId)
    expect(beforeRow?.displayName).toBe('Owner')

    harness.clock.advance(60_000)
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${bob.userId}`,
      headers,
      payload: { displayName: '  鲍勃  ' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<AdminUserBody>()
    expect(body.user.userId).toBe(bob.userId)
    expect(body.user.username).toBe('bob')
    expect(body.user.displayName).toBe('鲍勃')
    expect(body.user.disabled).toBe(false)
    expect(body.user.createdAt).toBe(beforeRow?.createdAt)
    expect(body.user.updatedAt).not.toBe(beforeRow?.updatedAt)
    expect(response.body).not.toContain('passwordHash')
  })

  it('用户不存在返回 404 NOT_FOUND', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${newIds.user()}`,
      headers,
      payload: { displayName: '幽灵' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ code: string }>().code).toBe('NOT_FOUND')
  })

  it('管理员不能停用自己', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${admin.userId}`,
      headers,
      payload: { disabled: true },
    })
    expect(response.statusCode).toBe(409)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('STATE_INVALID_TRANSITION')
    expect(body.detail?.reason).toBe('self_disable_forbidden')

    // 自己仍然可用，且没有被写坏。
    const me = await harness.app.inject({ method: 'GET', url: ME_URL, headers })
    expect(me.statusCode).toBe(200)
  })

  it('最后一名系统管理员的保护：停用他之后启用管理员数会变成 0', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)

    // 首版系统管理员唯一（`server_state.owner_user_id` 只有一列），所以
    // "停用最后一个管理员"与"停用自己"在 HTTP 上是同一次请求；这里直接断言
    // 计数函数算出的"变更后数量"，保证保护逻辑本身没有被写成恒真。
    expect(countEnabledSystemAdminsAfterChange(harness.db, admin.userId)).toBe(0)
    const bob = await seedUser(harness, 'bob')
    expect(countEnabledSystemAdminsAfterChange(harness.db, bob.userId)).toBe(1)
  })

  it('停用他人立刻撤销其全部会话，重新启用也不会让旧凭据复活', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const bobHeaders = await loginAs(harness.app, 'bob', TEST_PASSWORD)
    const before = listSessionsForUser(harness.db, bob.userId)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((session) => session.revokedAt === null)).toBe(true)

    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)
    const disabled = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${bob.userId}`,
      headers,
      payload: { disabled: true },
    })
    expect(disabled.statusCode).toBe(200)
    const body = disabled.json<AdminUserBody>()
    expect(body.user.disabled).toBe(true)
    expect(body.revokedSessions ?? 0).toBeGreaterThanOrEqual(1)

    // 库里所有会话都被撤销。
    const after = listSessionsForUser(harness.db, bob.userId)
    expect(after.every((session) => session.revokedAt !== null)).toBe(true)

    // 被停用的人手上的会话 Cookie 立刻失效。
    const me = await harness.app.inject({ method: 'GET', url: ME_URL, headers: bobHeaders })
    expect(me.statusCode).toBe(401)
    expect(me.json<{ code: string }>().code).toBe('AUTH_REQUIRED')

    // 连密码也登不进来（登录接口自己也会拒停用账号）。
    const relogin = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: 'bob', password: TEST_PASSWORD },
    })
    expect(relogin.statusCode).toBe(401)
    expect(relogin.json<{ code: string }>().code).toBe('AUTH_REQUIRED')

    // 启用后旧 Cookie **不会**复活（撤销是不可逆的），但可以重新登录。
    const enabled = await harness.app.inject({
      method: 'PATCH',
      url: `${ADMIN_USERS_URL}/${bob.userId}`,
      headers,
      payload: { disabled: false },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json<AdminUserBody>().user.disabled).toBe(false)

    const meAfter = await harness.app.inject({ method: 'GET', url: ME_URL, headers: bobHeaders })
    expect(meAfter.statusCode).toBe(401)

    const reloginAfter = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: 'bob', password: TEST_PASSWORD },
    })
    expect(reloginAfter.statusCode).toBe(200)
  })
})

describe('POST /api/v1/admin/users/:userId/password-reset', () => {
  it('非系统管理员返回 403 PERMISSION_DENIED', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'bob', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: `${ADMIN_USERS_URL}/${bob.userId}/password-reset`,
      headers,
      payload: { password: NEW_PASSWORD },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
  })

  it('目标用户不存在返回 404 NOT_FOUND', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: `${ADMIN_USERS_URL}/${newIds.user()}/password-reset`,
      headers,
      payload: { password: NEW_PASSWORD },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ code: string }>().code).toBe('NOT_FOUND')
  })

  it('密码短于 12 位返回 400（下限与 setup 相同）', async () => {
    const harness = await makeHarness()
    await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: `${ADMIN_USERS_URL}/${bob.userId}/password-reset`,
      headers,
      payload: { password: 'short-pass1' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_OUT_OF_RANGE')
  })

  it('重置成功：旧密码失效、新密码可用、全部会话被撤销、响应与审计都不回显密码', async () => {
    const harness = await makeHarness()
    const admin = await seedAdmin(harness)
    const bob = await seedUser(harness, 'bob')
    const bobHeaders = await loginAs(harness.app, 'bob', TEST_PASSWORD)
    expect(bobHeaders['cookie']).toBeTruthy()
    const headers = await loginAs(harness.app, 'admin', TEST_PASSWORD)

    const response = await harness.app.inject({
      method: 'POST',
      url: `${ADMIN_USERS_URL}/${bob.userId}/password-reset`,
      headers,
      payload: { password: NEW_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ userId: string; revokedSessions: number; updatedAt: string }>()
    expect(body.userId).toBe(bob.userId)
    expect(body.revokedSessions).toBeGreaterThanOrEqual(1)
    expect(typeof body.updatedAt).toBe('string')

    // 🔴 响应里没有明文、没有摘要、没有盐参数。
    expect(response.body).not.toContain(NEW_PASSWORD)
    expect(response.body).not.toContain('scrypt')
    expect(response.body).not.toContain('passwordHash')

    // 旧密码登不进来（用户名或密码不正确），旧会话也被撤销。
    const oldLogin = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: 'bob', password: TEST_PASSWORD },
    })
    expect(oldLogin.statusCode).toBe(401)
    expect(oldLogin.json<{ code: string }>().code).toBe('AUTH_INVALID_CREDENTIALS')

    const sessions = listSessionsForUser(harness.db, bob.userId)
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.every((session) => session.revokedAt !== null)).toBe(true)

    const me = await harness.app.inject({ method: 'GET', url: ME_URL, headers: bobHeaders })
    expect(me.statusCode).toBe(401)

    // 新密码可以登录。
    const newLogin = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: 'bob', password: NEW_PASSWORD },
    })
    expect(newLogin.statusCode).toBe(200)

    // 审计留痕：有、且只记"对谁做了什么"，不含密码。
    const events = queryAuditEvents(harness.db, { action: AUDIT_ACTIONS.passwordReset })
    expect(events).toHaveLength(1)
    expect(events[0]?.actorUserId).toBe(admin.userId)
    expect(events[0]?.targetId).toBe(bob.userId)
    expect(JSON.stringify(events.map((event) => event.detail))).not.toContain(NEW_PASSWORD)
  })
})
