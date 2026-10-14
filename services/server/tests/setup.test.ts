/**
 * `POST /api/v1/setup`：一次性初始化。
 *
 * 这是整个系统里**唯一**一个不需要认证就能创建账号的端点，所以它必须
 * "用完即永久关闭"。这里的用例覆盖四层保护中的每一层，并且每层都断言
 * 对外错误码（客户端按 code 分类，不按文案）：
 * 限流 → 已初始化 → 引导凭据（文件不可用 / 不匹配）→ 输入校验。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { join } from 'node:path'

import { createRateLimiter } from '../src/http/rateLimit.js'
import { queryAuditEvents } from '../src/db/audit.js'
import { countUsers } from '../src/db/users.js'
import { isServerInitialized, readServerState } from '../src/db/serverState.js'

import {
  SETUP_URL,
  TEST_BOOTSTRAP_SECRET,
  cleanupTempDirs,
  makeHarness,
  makeTempDir,
  writeSecretFile,
} from './helpers.js'
import type { TestHarness, TestHarnessOptions } from './helpers.js'

const harnesses: TestHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
  cleanupTempDirs()
})

interface SetupBody {
  readonly serverId: string
  readonly userId: string
  readonly workspaceId: string
  readonly role: string
  readonly initializedAt: string
}

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly detail?: Record<string, string | number | boolean | null>
  readonly status?: string
}

async function setupHarness(options: TestHarnessOptions = {}) {
  const secretFile = writeSecretFile('bootstrap.key', TEST_BOOTSTRAP_SECRET)
  const harness = await makeHarness({
    ...options,
    bootstrapSecretFile: options.bootstrapSecretFile ?? secretFile,
  })
  harnesses.push(harness)
  return { harness, secretFile }
}

function setupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootstrapSecret: TEST_BOOTSTRAP_SECRET,
    username: 'owner',
    password: 'owner-password-1',
    ...overrides,
  }
}

describe('首次初始化', () => {
  it('用正确引导凭据创建所有者，返回 serverId/workspaceId 且不缓存', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload(),
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<SetupBody>()
    expect(body.serverId).toBe(harness.serverId)
    expect(body.userId.startsWith('usr_')).toBe(true)
    expect(body.workspaceId.startsWith('ws_')).toBe(true)
    expect(body.role).toBe('owner')
    expect(response.headers['cache-control']).toBe('no-store')
    // 响应体里绝不能出现引导凭据。
    expect(response.body).not.toContain(TEST_BOOTSTRAP_SECRET)

    // 数据库副作用：用户 + 所有者成员关系 + 状态行已初始化。
    expect(countUsers(harness.db)).toBe(1)
    expect(isServerInitialized(harness.db)).toBe(true)
    const state = readServerState(harness.db)
    expect(state?.ownerUserId).toBe(body.userId)
    expect(state?.initializedAt).toBe(body.initializedAt)

    const member = harness.db
      .prepare('SELECT workspace_id, user_id, role FROM workspace_members')
      .get() as { workspace_id: string; user_id: string; role: string } | undefined
    // 工作区 id 由服务端生成，客户端不能自报角色。
    expect(member?.workspace_id).toBe(body.workspaceId)
    expect(member?.role).toBe('owner')
  })

  it('成功后立刻可以登录（初始化产出的就是可用账号）', async () => {
    const { harness } = await setupHarness()
    const setup = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload(),
    })
    expect(setup.statusCode).toBe(201)

    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'owner-password-1' },
    })
    expect(login.statusCode).toBe(200)
  })

  it('审计记录一次成功的初始化', async () => {
    const { harness } = await setupHarness()
    await harness.app.inject({ method: 'POST', url: SETUP_URL, payload: setupPayload() })

    const events = queryAuditEvents(harness.db, { action: 'setup.completed' })
    expect(events).toHaveLength(1)
    expect(events[0]?.outcome).toBe('success')
    expect(JSON.stringify(events[0]?.detail)).not.toContain(TEST_BOOTSTRAP_SECRET)
  })
})

describe('第二次调用被拒', () => {
  it('已初始化后再调用 → 409 ALREADY_EXISTS，且不会创建第二个账号', async () => {
    const { harness } = await setupHarness()
    const first = await harness.app.inject({ method: 'POST', url: SETUP_URL, payload: setupPayload() })
    expect(first.statusCode).toBe(201)

    const second = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ username: 'intruder', password: 'intruder-password-1' }),
    })
    expect(second.statusCode).toBe(409)
    const body = second.json<ErrorBody>()
    expect(body.code).toBe('ALREADY_EXISTS')
    expect(body.detail?.['reason']).toBe('already_initialized')
    expect(body.retryable).toBe(false)

    // 关键：第二次调用没有副作用。
    expect(countUsers(harness.db)).toBe(1)
    const users = harness.db.prepare('SELECT username FROM users').all() as readonly {
      username: string
    }[]
    expect(users.map((row) => row.username)).toEqual(['owner'])

    // 被拒也要留审计（否则"有人在初始化后继续敲入口"这件事不可见）。
    const events = queryAuditEvents(harness.db, { action: 'setup.completed' })
    expect(events.some((event) => event.outcome === 'denied')).toBe(true)
  })

  it('即使用错引导凭据也以"已初始化"先行拒绝（不泄露凭据是否正确）', async () => {
    const { harness } = await setupHarness()
    await harness.app.inject({ method: 'POST', url: SETUP_URL, payload: setupPayload() })

    const second = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'wrong-secret-wrong-secret-wrong' }),
    })
    expect(second.statusCode).toBe(409)
    expect(second.json<ErrorBody>().code).toBe('ALREADY_EXISTS')
  })
})

describe('引导凭据', () => {
  it('凭据不匹配 → 401 AUTH_INVALID_CREDENTIALS，且不创建账号', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'nope-nope-nope-nope-nope-nope' }),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<ErrorBody>().code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(countUsers(harness.db)).toBe(0)
    expect(isServerInitialized(harness.db)).toBe(false)

    const events = queryAuditEvents(harness.db, { action: 'setup.completed' })
    expect(events[0]?.outcome).toBe('failure')
    expect(events[0]?.detail?.['reason']).toBe('bootstrap_secret_mismatch')
    expect(JSON.stringify(events[0]?.detail)).not.toContain('nope-nope')
  })

  it('秘密文件不存在 → 503 SERVICE_UNAVAILABLE（不能靠"文件没了"绕过）', async () => {
    const harness = await makeHarness({
      bootstrapSecretFile: join(makeTempDir(), 'missing-bootstrap.key'),
    })
    harnesses.push(harness)

    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload(),
    })
    expect(response.statusCode).toBe(503)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('SERVICE_UNAVAILABLE')
    expect(body.detail?.['reason']).toBe('bootstrap_secret_unavailable')
    // 错误消息只提示"检查文件"，不给出路径以外的任何内容，更不回传路径。
    expect(response.body).not.toContain('bootstrap.key')
  })

  it('未配置引导凭据文件时同样 503（而不是退回"任意凭据都行"）', async () => {
    const harness = await makeHarness({ bootstrapSecretFile: null })
    harnesses.push(harness)
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload(),
    })
    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().code).toBe('SERVICE_UNAVAILABLE')
  })

  it('过短的引导凭据文件被视为不可用（拒绝弱引导秘密）', async () => {
    const weakFile = writeSecretFile('weak.key', 'short')
    const harness = await makeHarness({ bootstrapSecretFile: weakFile })
    harnesses.push(harness)

    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'short' }),
    })
    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().detail?.['reason']).toBe('bootstrap_secret_unavailable')
  })
})

describe('输入校验', () => {
  it('口令太短 → 400 VALIDATION_FAILED，且 detail 里不含口令本身', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ password: 'short' }),
    })
    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(response.body).not.toContain('short')
    expect(countUsers(harness.db)).toBe(0)
  })

  it('口令与用户名相同 → 拒绝（用户名与口令同为 17 字符，确保走到策略判定而非长度校验）', async () => {
    const { harness } = await setupHarness()
    const identical = 'owner-owner-owner'
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ username: identical, password: identical }),
    })
    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(body.detail?.['rule']).toBe('not_username')
    // 口令值本身绝不能出现在响应里。
    expect(response.body).not.toContain(identical)
  })

  it('用户名含非 ASCII 字符 → 拒绝（服务端只做 ASCII 小写折叠）', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ username: '所有者' }),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().code).toBe('VALIDATION_FAILED')
  })

  it('schema 拒绝未知字段（额外的 additionalProperties:false 契约）', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ role: 'admin' }),
    })
    expect(response.statusCode).toBe(400)
    // 框架的 schema 校验错误必须被折算成契约错误，而不是原样外发。
    expect(response.json<ErrorBody>().code).toBe('VALIDATION_FAILED')
  })

  it('缺少必填字段 → 400 且 error 结构完整（code/requestId/retryable）', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: { username: 'owner' },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(typeof body.requestId).toBe('string')
    expect(typeof body.retryable).toBe('boolean')
  })

  it('空 JSON 体 → 400（而不是 500）', async () => {
    const { harness } = await setupHarness()
    const response = await harness.app.inject({ method: 'POST', url: SETUP_URL })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().code).toBe('VALIDATION_FAILED')
  })
})

describe('体积与限流', () => {
  it('超过 bodyLimit 的请求 → 413 PAYLOAD_TOO_LARGE', async () => {
    const { harness } = await setupHarness({ config: { bodyLimitBytes: 512 } })
    const response = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ displayName: 'x'.repeat(2048) }),
    })
    expect(response.statusCode).toBe(413)
    expect(response.json<ErrorBody>().code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('初始化入口限流：超过窗口上限后 429（契约无专用限流码，用 RESOURCE_LOCKED + 429）', async () => {
    const { harness } = await setupHarness({
      limiters: { setup: createRateLimiter({ windowMs: 60_000, maxAttempts: 2 }) },
    })

    const first = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'wrong-secret-wrong-secret-wrong' }),
    })
    const second = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'wrong-secret-wrong-secret-wrong' }),
    })
    expect(first.statusCode).toBe(401)
    expect(second.statusCode).toBe(401)

    const third = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: setupPayload({ bootstrapSecret: 'wrong-secret-wrong-secret-wrong' }),
    })
    expect(third.statusCode).toBe(429)
    const body = third.json<ErrorBody>()
    expect(body.code).toBe('RESOURCE_LOCKED')
    expect(body.detail?.['reason']).toBe('rate_limited')
    expect(typeof body.detail?.['retryAfterSeconds']).toBe('number')
  })
})
