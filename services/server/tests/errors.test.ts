/**
 * 统一错误结构。
 *
 * 契约（`07-同步协议与API.md`）："普通错误结构为 code、message、requestId、retryable
 * 与可选 details；**不得包含堆栈、正文和秘密**"。HTTP 层是唯一能保证这一点的
 * 地方——所以这里既测纯函数（`toErrorPayload` → `errorResponseBody` 的剥壳），
 * 也测真实管线：临时挂一个必然抛异常的路由，确认响应体里既没有堆栈、
 * 也没有 SQLite 驱动原文和绝对路径。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ContractError, ERROR_CODES, severityOf, toErrorPayload } from '@yfe/contracts'
import type { ErrorCode, RequestId } from '@yfe/contracts'

import {
  ALLOWED_HTTP_STATUSES,
  HTTP_STATUS_BY_CODE,
  contractErrorFromFramework,
  errorResponseBody,
  httpStatusFor,
  httpStatusForError,
  statusHintOf,
  toContractError,
  withStatusHint,
} from '../src/http/errors.js'
import { rateLimitedError } from '../src/http/rateLimit.js'
import { createServer } from '../src/http/server.js'
import { defaultServerConfig } from '../src/http/config.js'
import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'

import { cleanupTempDirs, makeHarness, LOGIN_URL, TEST_USERNAME, seedOwner } from './helpers.js'
import type { TestHarness } from './helpers.js'

const REQUEST_ID = 'req_errors_test' as RequestId
const openDbs: ServerDb[] = []
const harnesses: TestHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
  for (const db of openDbs.splice(0)) closeServerDatabase(db)
  cleanupTempDirs()
})

// ---------------------------------------------------------------------------
// 映射表
// ---------------------------------------------------------------------------

describe('HTTP 状态码映射表', () => {
  it('每个错误码都有映射，且都落在允许的状态码集合内', () => {
    for (const code of ERROR_CODES) {
      const status = httpStatusFor(code)
      expect(ALLOWED_HTTP_STATUSES, `${code} 映射到 ${status}`).toContain(status)
      expect(HTTP_STATUS_BY_CODE[code]).toBe(status)
    }
    // 61 个码一个都不能漏（漏掉的会静默变成 500）。
    expect(Object.keys(HTTP_STATUS_BY_CODE)).toHaveLength(ERROR_CODES.length)
  })

  it('Lead 定下的基线逐条成立', () => {
    const expected: Record<string, number> = {
      // info → 400 / 404 / 409
      VALIDATION_FAILED: 400,
      VALIDATION_MISSING_FIELD: 400,
      VALIDATION_MALFORMED_ID: 400,
      NOT_FOUND: 404,
      NOT_FOUND_PROJECT: 404,
      NOT_FOUND_DOCUMENT: 404,
      NOT_FOUND_ATTACHMENT: 404,
      NOT_FOUND_SNAPSHOT: 404,
      NOT_FOUND_JOB: 404,
      REVISION_CONFLICT: 409,
      IDEMPOTENCY_KEY_REUSED: 409,
      ALREADY_EXISTS: 409,
      STATE_INVALID_TRANSITION: 409,
      RESOURCE_LOCKED: 409,
      // 超限 / 限流
      PAYLOAD_TOO_LARGE: 413,
      // warn → 401 / 403 / 408 / 429 / 501（含显式覆盖）
      AUTH_REQUIRED: 401,
      AUTH_INVALID_CREDENTIALS: 401,
      AUTH_TOKEN_EXPIRED: 401,
      AUTH_DEVICE_REVOKED: 401,
      AUTH_DEVICE_NOT_PAIRED: 401,
      PERMISSION_DENIED: 403,
      PERMISSION_WORKSPACE_MISMATCH: 403,
      PERMISSION_PLUGIN_CAPABILITY: 403,
      PERMISSION_READ_ONLY_MODE: 403,
      NETWORK_TIMEOUT: 408,
      JOB_TIMEOUT: 408,
      JOB_BUDGET_EXCEEDED: 429,
      NOT_IMPLEMENTED: 501,
      // 游标/资源保留期结束 → 410
      SYNC_CURSOR_INVALID: 410,
      JOB_INPUT_VERSION_GONE: 410,
      // error → 500
      INTERNAL_ERROR: 500,
      STORAGE_MIGRATION_FAILED: 500,
      // critical → 503
      STORAGE_DISK_FULL: 503,
      STORAGE_CORRUPT: 503,
      STORAGE_SCHEMA_TOO_NEW: 503,
      // 服务不可用
      SERVICE_UNAVAILABLE: 503,
      SERVICE_SHUTTING_DOWN: 503,
    }
    for (const [code, status] of Object.entries(expected)) {
      expect(httpStatusFor(code as ErrorCode), `${code} 应为 ${status}`).toBe(status)
    }
  })

  it('critical 一律 503；error 只会是 500 或"依赖不可用"的 503，绝不落进 4xx', () => {
    for (const code of ERROR_CODES) {
      const severity = severityOf(code)
      const status = httpStatusFor(code)
      // `STORAGE_UNAVAILABLE`/`NETWORK_*` 的 severity 是 error，但它们表达的是
      // "上游/依赖暂时不可用"，正确状态是 503（可重试）而不是 500。
      if (severity === 'error') expect([500, 503], `${code}`).toContain(status)
      if (severity === 'critical') expect(status, `${code}`).toBe(503)
      // 反过来：只有 warn/error/critical 才允许 5xx。
      if (status >= 500) expect(['warn', 'error', 'critical']).toContain(severity)
      // 4xx 里绝不能出现"重试也没用"的 error/critical 语义。
      if (severity === 'critical') expect(status).toBeGreaterThanOrEqual(500)
    }
  })

  it('显式状态提示优先于映射表（限流借用 RESOURCE_LOCKED 但要 429）', () => {
    const limited = rateLimitedError(30_000, REQUEST_ID)
    expect(limited.code).toBe('RESOURCE_LOCKED')
    expect(httpStatusFor('RESOURCE_LOCKED')).toBe(409)
    expect(httpStatusForError(limited)).toBe(429)
    expect(statusHintOf(limited)).toBe(429)
    expect(limited.detail?.['reason']).toBe('rate_limited')
    expect(limited.detail?.['retryAfterSeconds']).toBe(30)
  })

  it('状态提示是符号属性，不可枚举也不进序列化', () => {
    const limited = withStatusHint(
      new ContractError({ code: 'RESOURCE_LOCKED', message: 'x', requestId: REQUEST_ID }),
      429,
    )
    const symbols = Object.getOwnPropertySymbols(limited)
    expect(symbols).toHaveLength(1)
    const descriptor = Object.getOwnPropertyDescriptor(limited, symbols[0] as symbol)
    expect(descriptor?.enumerable).toBe(false)
    // 契约载荷里没有 429 这个数字，只由 HTTP 层在映射时使用。
    expect(JSON.stringify(limited.toPayload())).not.toContain('429')
  })
})

// ---------------------------------------------------------------------------
// 剥壳
// ---------------------------------------------------------------------------

describe('toErrorPayload → errorResponseBody', () => {
  it('非 ContractError 一律折算成 INTERNAL_ERROR，原始消息只留在 cause', () => {
    const thrown = new Error(
      'SQLITE_BUSY: database is locked (F:\\youth-fantasy-engine-new\\data\\db\\yfe.db)',
    )
    const payload = toErrorPayload(thrown, REQUEST_ID)
    expect(payload.code).toBe('INTERNAL_ERROR')
    expect(payload.cause).toContain('SQLITE_BUSY')

    const body = errorResponseBody(payload, REQUEST_ID)
    expect(body).not.toHaveProperty('cause')
    expect(body).not.toHaveProperty('severity')
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId', 'retryable'])
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('SQLITE')
    expect(serialized).not.toContain('yfe.db')
    expect(serialized).not.toContain('F:\\')
    expect(serialized).not.toContain('locked')
  })

  it('字符串/数字等非 Error 抛出物也被安全折算', () => {
    const payload = toErrorPayload('secret-token-abc', REQUEST_ID)
    expect(payload.code).toBe('INTERNAL_ERROR')
    const body = errorResponseBody(payload, REQUEST_ID)
    expect(JSON.stringify(body)).not.toContain('secret-token-abc')
  })

  it('requestId 以调用方传入的为准（契约错误里常带构造时的占位 requestId）', () => {
    const error = new ContractError({
      code: 'NOT_FOUND',
      message: '请求的接口不存在。',
      requestId: 'req_from_construction' as RequestId,
    })
    const payload = error.toPayload()
    const body = errorResponseBody(payload, REQUEST_ID)
    expect(body.requestId).toBe(REQUEST_ID)
  })

  it('toContractError：ContractError 原样穿透，其他按 INTERNAL_ERROR 折算', () => {
    const original = new ContractError({
      code: 'PERMISSION_DENIED',
      message: '无权执行此操作。',
      requestId: REQUEST_ID,
      detail: { reason: 'not_owner' },
    })
    expect(toContractError(original, REQUEST_ID)).toBe(original)

    const folded = toContractError(new TypeError('undefined is not a function'), REQUEST_ID)
    expect(folded.code).toBe('INTERNAL_ERROR')
    expect(folded.message).toBe('发生未预期的内部错误')
    expect(folded.severity).toBe('error')
    expect(folded.retryable).toBe(false)
    // 🔴 原始消息只留在服务端的 Error.cause 里，`toPayload()` 刻意不带它——
    // 外发的那份结构永远不含驱动原文。
    expect(String(folded.cause)).toContain('undefined is not a function')
    expect(folded.toPayload()).not.toHaveProperty('cause')
  })
})

describe('框架错误折算', () => {
  it('schema 校验错误 → VALIDATION_FAILED（不是 500，也不是框架原文）', () => {
    const converted = contractErrorFromFramework(
      { statusCode: 400, code: 'FST_ERR_VALIDATION', validation: [{ message: 'x' }] },
      REQUEST_ID,
    )
    expect(converted?.code).toBe('VALIDATION_FAILED')
    expect(converted?.detail?.['issueCount']).toBe(1)
  })

  it('状态码映射：401→AUTH_REQUIRED、403→PERMISSION_DENIED、413→PAYLOAD_TOO_LARGE、415→校验失败', () => {
    const cases: readonly [number, string][] = [
      [401, 'AUTH_REQUIRED'],
      [403, 'PERMISSION_DENIED'],
      [404, 'NOT_FOUND'],
      [409, 'STATE_INVALID_TRANSITION'],
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'VALIDATION_FAILED'],
    ]
    for (const [statusCode, code] of cases) {
      expect(contractErrorFromFramework({ statusCode }, REQUEST_ID)?.code).toBe(code)
    }
  })

  it('框架的 429 → RESOURCE_LOCKED 且保留 429 状态提示', () => {
    const converted = contractErrorFromFramework({ statusCode: 429 }, REQUEST_ID)
    expect(converted).not.toBeNull()
    if (converted === null) return
    expect(converted.code).toBe('RESOURCE_LOCKED')
    expect(httpStatusForError(converted)).toBe(429)
    // 不能把框架原文（可能是内部路由名）外发。
    expect(converted.message).not.toContain('FST_')
  })

  it('无法归类的框架错误返回 null（交给 INTERNAL_ERROR 兜底）', () => {
    expect(contractErrorFromFramework({ statusCode: 418 }, REQUEST_ID)).toBeNull()
    expect(contractErrorFromFramework({}, REQUEST_ID)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 真实管线
// ---------------------------------------------------------------------------

describe('真实 HTTP 管线里的错误响应', () => {
  it('未知路由 → 404，且响应体恰好是契约的五个字段', async () => {
    const harness = await makeHarness()
    harnesses.push(harness)

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/does-not-exist' })
    expect(response.statusCode).toBe(404)
    const body = response.json<Record<string, unknown>>()
    expect(Object.keys(body).sort()).toEqual(['code', 'detail', 'message', 'requestId', 'retryable'])
    expect(body['code']).toBe('NOT_FOUND')
    expect(requestIdMatches(response, harness)).toBe(true)
  })

  it('未认证访问 → 401 AUTH_REQUIRED，带 requestId 且不带堆栈', async () => {
    const harness = await makeHarness()
    harnesses.push(harness)

    const response = await harness.app.inject({ method: 'GET', url: '/api/v1/users/me' })
    expect(response.statusCode).toBe(401)
    const body = response.json<Record<string, unknown>>()
    expect(body['code']).toBe('AUTH_REQUIRED')
    expect(body['retryable']).toBe(false)
    expect(requestIdMatches(response, harness)).toBe(true)
    expectNoLeak(response.body)
  })

  it('处理器里抛出的未预期异常 → 500 INTERNAL_ERROR，堆栈/绝对路径/驱动原文都不外发', async () => {
    const db = openServerDatabase(':memory:')
    openDbs.push(db)
    await migrateServerDatabase(db)
    const config = defaultServerConfig({
      sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
    })
    ensureServerState(db, 'srv_boom', null)
    const app = createServer({ config, db, serverId: 'srv_boom', logger: false })

    const secretValue = 'super-secret-token-value'
    app.get('/api/v1/__boom', async () => {
      throw new Error(
        `SQLITE_IOERR: disk I/O error at F:\\youth-fantasy-engine-new\\data\\db\\yfe.db (token=${secretValue})`,
      )
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/v1/__boom' })
    expect(response.statusCode).toBe(500)
    const body = response.json<Record<string, unknown>>()
    expect(body['code']).toBe('INTERNAL_ERROR')
    expect(body['message']).toBe('发生未预期的内部错误')
    expectNoLeak(response.body)
    expect(response.body).not.toContain(secretValue)
    expect(response.body).not.toContain('SQLITE')
    expect(response.body).not.toContain('F:\\')
    expect(requestIdMatches(response, app)).toBe(true)
  })

  it('ContractError 的 message 原样外发（面向用户的中文短句），但不带 cause，也不回显请求方提交的口令', async () => {
    const harness = await makeHarness()
    harnesses.push(harness)
    await seedOwner(harness.db, harness.clock.now())

    const submitted = 'wrong-password-should-not-be-echoed'
    const response = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: submitted },
    })

    expect(response.statusCode).toBe(401)
    const body = response.json<Record<string, unknown>>()
    expect(body['code']).toBe('AUTH_INVALID_CREDENTIALS')
    // 契约错误的中文短句是给用户看的，必须原样外发。
    expect(body['message']).toBe('用户名或密码不正确。')
    expect(body).not.toHaveProperty('cause')
    expectNoLeak(response.body)
    expect(response.body).not.toContain(submitted)
    expect(requestIdMatches(response, harness)).toBe(true)
  })
})

function requestIdMatches(
  response: { headers: Record<string, unknown>; json<T>(): T },
  _app: unknown,
): boolean {
  const body = response.json<{ requestId?: string }>()
  const header = response.headers['x-request-id']
  return typeof header === 'string' && body.requestId === header
}

function expectNoLeak(body: string): void {
  const lowered = body.toLowerCase()
  expect(lowered).not.toContain('stack')
  expect(lowered).not.toContain('    at ')
  expect(lowered).not.toContain('node_modules')
  expect(lowered).not.toContain('.ts:')
  expect(lowered).not.toContain('sqlite')
}
