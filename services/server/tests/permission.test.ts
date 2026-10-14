/**
 * 权限钩子（`src/permission/index.ts`）测试。
 *
 * 这里要证明的是**安全属性**，不是"函数能跑"：
 * 1. 每个请求都重新回表读角色 —— 降权立刻生效，不缓存到会话过期；
 * 2. 每个请求都重新校验会话 —— 撤销立刻生效；
 * 3. Cookie 凭据的写请求必须带 CSRF；Bearer 凭据不带（不是浏览器）；
 * 4. 请求声明的工作区与主体实际授权的工作区不一致时拒绝；
 * 5. 设备凭据不能越过配对时绑定的工作区边界。
 *
 * 装置用真实 `createServer()`（真钩子、真错误映射），只在上面临时挂一条
 * `POST /api/v1/__guard/:workspaceId` 走 `requireWorkspaceAccess({action:'write'})`：
 * P3-A1 还没有工作区级路由，但钩子必须先被证明可用，否则"每次写入都重新鉴权"
 * 只是一句注释。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ContractError, newIds } from '@yfe/contracts'
import type { DeviceId, RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import {
  assertDeviceWithinWorkspace,
  assertNotLastOwner,
  principalFromDevice,
  principalFromSession,
} from '../src/auth/permission.js'
import { DEFAULT_SESSION_POLICY, cookieNames, issueSession } from '../src/auth/session.js'
import type { IssuedSession, SessionPolicy } from '../src/auth/session.js'
import { generateToken, hashToken } from '../src/auth/secrets.js'
import { revokeSessionChain } from '../src/db/sessions.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { insertDevice } from '../src/db/devices.js'
import { findMember, upsertMember } from '../src/db/members.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import {
  authorizeWorkspaceAccess,
  createPermissionGuards,
  currentAuth,
} from '../src/permission/index.js'
import { TEST_USERNAME, seedOwner, testClock } from './helpers.js'
import type { TestClock } from './helpers.js'

/** 与 harness 一致的策略：测试里跑 http，不能要求 Secure。 */
const POLICY: SessionPolicy = { ...DEFAULT_SESSION_POLICY, cookieSecure: false }
const ACCESS_COOKIE = cookieNames(POLICY).access
const CSRF_COOKIE = cookieNames(POLICY).csrf
const GUARD_PREFIX = '/api/v1/__guard'

interface GuardHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
  close(): void
}

let active: GuardHarness | null = null

async function makeGuardHarness(
  role: 'owner' | 'admin' | 'editor' | 'viewer' = 'editor',
): Promise<GuardHarness> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  const clock = testClock()
  const config = defaultServerConfig({ sessionPolicy: POLICY })
  ensureServerState(db, 'srv_guard', null)

  const app = createServer({ config, db, serverId: 'srv_guard', clock, logger: false })
  const guards = createPermissionGuards({ db, policy: POLICY })
  app.post(
    `${GUARD_PREFIX}/:workspaceId`,
    { preHandler: guards.requireWorkspaceAccess({ action: 'write' }) },
    async (request) => {
      const auth = currentAuth(request)
      // 🔴 处理器内部再判一次，与生产约定一致：钩子判"请求声明的 workspaceId"，
      // 处理器判"这次真正要动的资源所属 workspaceId"。角色也从这里拿——
      // 钩子里的 principal 刻意不绑定工作区（一个用户可属于多个）。
      const params = request.params as { workspaceId: string }
      const access = authorizeWorkspaceAccess(
        { db, policy: POLICY },
        request,
        params.workspaceId as WorkspaceId,
        'write',
      )
      return {
        ok: true,
        userId: auth.principal.userId,
        role: access.role,
        via: auth.principal.via,
        source: auth.source,
        // principal 本身不绑定工作区（同一用户可属于多个工作区），
        // 所以它的 role 恒为 null；工作区角色只能由 resolveWorkspaceAccess 给出。
        principalRole: auth.principal.role,
      }
    },
  )

  try {
    await app.ready()
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  const seeded = await seedOwner(db, clock.now(), { role })
  const harness: GuardHarness = {
    app,
    db,
    clock,
    userId: seeded.userId,
    workspaceId: seeded.workspaceId,
    close(): void {
      closeServerDatabase(db)
    },
  }
  active = harness
  return harness
}

function issue(harness: GuardHarness): IssuedSession {
  return issueSession(harness.db, {
    userId: harness.userId,
    at: harness.clock.now(),
    userAgent: 'vitest',
    clientIp: '127.0.0.1',
  })
}

/** Cookie 凭据（浏览器路径）：必须同时带 access 与 csrf 两个 cookie。 */
function cookieCredentials(issued: IssuedSession): Record<string, string> {
  return {
    cookie: `${ACCESS_COOKIE}=${issued.accessToken}; ${CSRF_COOKIE}=${issued.csrfToken}`,
    'x-csrf-token': issued.csrfToken,
  }
}

async function writeAs(
  harness: GuardHarness,
  workspaceId: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `${GUARD_PREFIX}/${workspaceId}`,
    headers,
  })
  return { statusCode: response.statusCode, body: response.json<Record<string, unknown>>() }
}

afterEach(() => {
  active?.close()
  active = null
})

describe('工作区鉴权钩子', () => {
  it('没有凭据时拒绝为 401，且不回显"该工作区是否存在"', async () => {
    const harness = await makeGuardHarness()
    const { statusCode, body } = await writeAs(harness, harness.workspaceId, {})
    expect(statusCode).toBe(401)
    expect(body['code']).toBe('AUTH_REQUIRED')
    expect(body['detail']).toBeUndefined()
  })

  it('editor 带 Cookie + CSRF 可以写入', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)
    const { statusCode, body } = await writeAs(
      harness,
      harness.workspaceId,
      cookieCredentials(issued),
    )
    expect(statusCode).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      userId: harness.userId,
      role: 'editor',
      via: 'session',
      source: 'cookie',
      principalRole: null,
    })
  })

  it('Cookie 凭据的写请求缺 CSRF 头 → 403；带对了才放行', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)

    const missing = await writeAs(harness, harness.workspaceId, {
      cookie: `${ACCESS_COOKIE}=${issued.accessToken}; ${CSRF_COOKIE}=${issued.csrfToken}`,
    })
    expect(missing.statusCode).toBe(403)
    expect(missing.body['code']).toBe('PERMISSION_DENIED')
    expect(missing.body['detail']).toMatchObject({ reason: 'csrf_token_invalid' })

    const wrong = await writeAs(harness, harness.workspaceId, {
      cookie: `${ACCESS_COOKIE}=${issued.accessToken}; ${CSRF_COOKIE}=${issued.csrfToken}`,
      'x-csrf-token': `${issued.csrfToken}x`,
    })
    expect(wrong.statusCode).toBe(403)

    const ok = await writeAs(harness, harness.workspaceId, cookieCredentials(issued))
    expect(ok.statusCode).toBe(200)
  })

  it('Bearer 凭据（非浏览器）不要求 CSRF，但同一令牌必须有效', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)

    const withBearer = await writeAs(harness, harness.workspaceId, {
      authorization: `Bearer ${issued.accessToken}`,
    })
    expect(withBearer.statusCode).toBe(200)
    expect(withBearer.body['source']).toBe('bearer')

    const bogus = await writeAs(harness, harness.workspaceId, {
      authorization: `Bearer ${generateToken()}`,
    })
    // 🔴 未知令牌被当成"重放/已清理的凭据"，不是 403：它不是权限问题而是认证问题。
    expect(bogus.statusCode).toBe(401)
    expect(bogus.body['code']).toBe('AUTH_REQUIRED')
  })

  it('viewer 写入被拒为 403，并在 detail 里给出当前角色', async () => {
    const harness = await makeGuardHarness('viewer')
    const issued = issue(harness)
    const { statusCode, body } = await writeAs(
      harness,
      harness.workspaceId,
      cookieCredentials(issued),
    )
    expect(statusCode).toBe(403)
    expect(body['code']).toBe('PERMISSION_DENIED')
    expect(body['detail']).toMatchObject({ role: 'viewer' })
    // 拒绝理由只描述能力，不泄露工作区内部信息。
    expect(body['stack']).toBeUndefined()
  })

  it('降权立即生效：同一会话先 200、改角色后立刻 403（不缓存角色）', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)
    const credentials = cookieCredentials(issued)

    expect((await writeAs(harness, harness.workspaceId, credentials)).statusCode).toBe(200)

    upsertMember(harness.db, harness.workspaceId, harness.userId, 'viewer', harness.clock.now())
    expect(
      findMember(harness.db, harness.workspaceId, harness.userId)?.role,
    ).toBe('viewer')

    // 会话本身没有任何变化：变的只是"回表读到的角色"。
    const after = await writeAs(harness, harness.workspaceId, credentials)
    expect(after.statusCode).toBe(403)
    expect(after.body['code']).toBe('PERMISSION_DENIED')
  })

  it('会话被撤销后同一凭据立刻失效（不缓存会话）', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)
    const credentials = cookieCredentials(issued)

    expect((await writeAs(harness, harness.workspaceId, credentials)).statusCode).toBe(200)

    const revoked = revokeSessionChain(
      harness.db,
      issued.session.chainId,
      harness.clock.now(),
      'test_revoke',
    )
    expect(revoked).toBeGreaterThanOrEqual(1)

    const after = await writeAs(harness, harness.workspaceId, credentials)
    expect(after.statusCode).toBe(401)
    expect(after.body['code']).toBe('AUTH_REQUIRED')
  })

  it('访问令牌过期后 401，错误码区分"过期"与"无效"', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)
    const credentials = cookieCredentials(issued)

    harness.clock.advance(DEFAULT_SESSION_POLICY.accessTtlMs + 1)
    const expired = await writeAs(harness, harness.workspaceId, credentials)
    expect(expired.statusCode).toBe(401)
    expect(expired.body['code']).toBe('AUTH_TOKEN_EXPIRED')
  })

  it('非成员的工作区被拒为 403，且不泄露工作区内容', async () => {
    const harness = await makeGuardHarness('owner')
    const issued = issue(harness)
    const stranger = newIds.workspace() as WorkspaceId

    const { statusCode, body } = await writeAs(
      harness,
      stranger,
      cookieCredentials(issued),
    )
    expect(statusCode).toBe(403)
    expect(body['code']).toBe('PERMISSION_DENIED')
    expect(body['detail']).toMatchObject({ workspaceId: stranger })
  })

  it('workspaceId 不合法 → 400，而不是 403（参数问题不该被当成权限问题）', async () => {
    const harness = await makeGuardHarness('owner')
    const issued = issue(harness)
    const { statusCode, body } = await writeAs(harness, 'bad%20id', cookieCredentials(issued))
    expect(statusCode).toBe(400)
    expect(body['code']).toBe('VALIDATION_MALFORMED_ID')
    expect(body['detail']).toMatchObject({ field: 'workspaceId' })
  })
})

describe('权限判定的数据库级边界', () => {
  it('principalFromSession 每次调用都回表读角色', async () => {
    const harness = await makeGuardHarness('editor')
    const issued = issue(harness)

    const before = principalFromSession(harness.db, issued.session, harness.workspaceId, 'req_p' as RequestId)
    expect(before.role).toBe('editor')
    expect(before.via).toBe('session')

    upsertMember(harness.db, harness.workspaceId, harness.userId, 'viewer', harness.clock.now())
    const after = principalFromSession(harness.db, issued.session, harness.workspaceId, 'req_p' as RequestId)
    expect(after.role).toBe('viewer')
  })

  it('设备凭据不能越过配对时绑定的工作区', async () => {
    const harness = await makeGuardHarness('owner')
    const other = newIds.workspace() as WorkspaceId
    const now: UtcTimestamp = harness.clock.now()
    const device = insertDevice(harness.db, {
      id: newIds.device() as DeviceId,
      userId: harness.userId,
      workspaceId: harness.workspaceId,
      name: 'desktop',
      platform: 'win32',
      tokenHash: hashToken(generateToken()),
      pairingCodeId: null,
      at: now,
    })

    const principal = principalFromDevice(harness.db, device)
    expect(principal.via).toBe('device')
    expect(() =>
      assertDeviceWithinWorkspace(principal, other, 'req_dev' as RequestId),
    ).toThrow(ContractError)
    expect(() =>
      assertDeviceWithinWorkspace(principal, harness.workspaceId, 'req_dev' as RequestId),
    ).not.toThrow()
  })

  it('最后一个所有者不能被移除', async () => {
    const harness = await makeGuardHarness('owner')
    expect(() =>
      assertNotLastOwner(0, harness.workspaceId, 'req_owner' as RequestId),
    ).toThrow(ContractError)
    expect(() =>
      assertNotLastOwner(1, harness.workspaceId, 'req_owner' as RequestId),
    ).not.toThrow()
  })

  it('seedOwner 默认落一个 owner 成员行（测试基座自身的保证）', async () => {
    const harness = await makeGuardHarness('owner')
    const member = findMember(harness.db, harness.workspaceId, harness.userId)
    expect(member?.role).toBe('owner')
    expect(TEST_USERNAME).toBe('owner')
  })
})
