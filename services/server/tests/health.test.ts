/**
 * 健康检查：live 与 ready 的**差异**。
 *
 * 这条差异是运维契约的核心：live 只说明"进程还能回话"，ready 说明"可以接业务"。
 * 把两者写成同一个端点会让编排器在数据库坏掉时继续把流量送进来，
 * 也会让"重启进程"变成对数据库故障的无效反应。所以这里最关键的一条断言是
 * **关掉数据库之后 live 仍然 200、ready 变成 503**。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { closeServerDatabase } from '../src/db/open.js'

import { SETUP_URL, TEST_BOOTSTRAP_SECRET, cleanupTempDirs, makeHarness, writeSecretFile } from './helpers.js'
import type { TestHarness } from './helpers.js'

const harnesses: TestHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
  cleanupTempDirs()
})

async function readyHarness(): Promise<TestHarness> {
  const secretFile = writeSecretFile('bootstrap.key', TEST_BOOTSTRAP_SECRET)
  const harness = await makeHarness({ bootstrapSecretFile: secretFile })
  harnesses.push(harness)
  return harness
}

interface LiveBody {
  readonly status: string
  readonly uptimeMs: number
  readonly startedAt: string
}

interface ReadyBody {
  readonly status: string
  readonly uptimeMs: number
  readonly initialized: boolean
  readonly database: { readonly ok: boolean; readonly journalMode?: string; readonly reason?: string }
  readonly migrations: { readonly ok: boolean; readonly current?: number; readonly expected?: number }
  readonly code?: string
  readonly requestId?: string
}

describe('GET /health/live', () => {
  it('进程活着就 200，路径在 /api/v1 之外，且不缓存', async () => {
    const harness = await readyHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/health/live' })

    expect(response.statusCode).toBe(200)
    const body = response.json<LiveBody>()
    expect(body.status).toBe('ok')
    expect(typeof body.uptimeMs).toBe('number')
    expect(Number.isFinite(Date.parse(body.startedAt))).toBe(true)
    expect(response.headers['cache-control']).toBe('no-store')

    // 不该被版本前缀“包”进去：`/api/v1/health/live` 必须是 404。
    const versioned = await harness.app.inject({ method: 'GET', url: '/api/v1/health/live' })
    expect(versioned.statusCode).toBe(404)
  })

  it('数据库不可用时 live 仍然是 200（进程存活与业务可用是两件事）', async () => {
    const harness = await readyHarness()
    closeServerDatabase(harness.db)

    const live = await harness.app.inject({ method: 'GET', url: '/health/live' })
    expect(live.statusCode).toBe(200)
    expect(live.json<LiveBody>().status).toBe('ok')
  })
})

describe('GET /health/ready', () => {
  it('数据库与迁移都正常时 200，并给出可诊断的状态字段', async () => {
    const harness = await readyHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(200)
    const body = response.json<ReadyBody>()
    expect(body.status).toBe('ok')
    expect(body.database.ok).toBe(true)
    expect(body.database.journalMode).toBe('memory') // 内存测试库
    expect(body.migrations.ok).toBe(true)
    expect(body.migrations.current).toBe(body.migrations.expected)
    // 还没跑 setup：服务状态行存在但 initialized_at 为空。
    expect(body.initialized).toBe(false)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('初始化之后 initialized 变为 true', async () => {
    const harness = await readyHarness()
    const setup = await harness.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: {
        bootstrapSecret: TEST_BOOTSTRAP_SECRET,
        username: 'owner',
        password: 'owner-password-1',
      },
    })
    expect(setup.statusCode).toBe(201)

    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json<ReadyBody>().initialized).toBe(true)
  })

  it('数据库不可用时 503，且响应体仍然带 database/migrations 状态（便于定位）', async () => {
    const harness = await readyHarness()
    closeServerDatabase(harness.db)

    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    const body = response.json<ReadyBody>()
    expect(body.status).toBe('unavailable')
    expect(body.database.ok).toBe(false)
    expect(body.database.reason).toBe('closed')
    expect(body.migrations.ok).toBe(false)
    // 走统一错误结构：code 可判、requestId 可串联，但**不回传驱动原文**。
    expect(body.code).toBe('STORAGE_UNAVAILABLE')
    expect(typeof body.requestId).toBe('string')
    expect(response.body).not.toContain('SQLITE')
    expect(response.headers['retry-after']).toBe('5')
  })

  it('响应体里不出现数据库路径或堆栈', async () => {
    const harness = await readyHarness()
    const response = await harness.app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.body).not.toContain('stack')
    expect(response.body).not.toContain('.db')
    expect(response.body).not.toContain('at ')
  })
})
