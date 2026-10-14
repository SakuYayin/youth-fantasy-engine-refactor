/**
 * `GET /api/v1/capabilities` —— 能力发现。
 *
 * 重点在两条：
 * 1. **上报的上限必须等于执行的上限。** 用例把 `bodyLimitBytes` 调小，断言
 *    capabilities 跟着收窄；否则客户端会按服务端根本收不下的粒度分片。
 * 2. **不泄漏内部信息。** 这个端点的用途是"告诉客户端协议和上限"，
 *    不是"告诉任何人这台机器怎么部署的"——数据目录、密钥文件、监听参数一个都不该出现。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_BODY_LIMIT_BYTES } from '../src/http/config.js'
import { SYNC_LIMITS, SUPPORTED_COMMANDS } from '../src/sync/protocol.js'
import { seedOwner } from './helpers.js'
import { harnessTracker, loginAs } from './syncHelpers.js'

const CAPABILITIES_URL = '/api/v1/capabilities'

interface CapabilitiesBody {
  readonly serverId: string
  readonly protocolVersion: { readonly major: number; readonly minor: number }
  readonly minClientMajor: number
  readonly limits: {
    readonly maxOperationsPerBatch: number
    readonly maxBatchBytes: number
    readonly maxOrderKeyLength: number
  }
  readonly assets: { readonly enabled: boolean; readonly partSizeBytes: number; readonly maxAssetBytes: number }
  readonly commands: readonly string[]
  readonly readOnly: boolean
}

const tracker = harnessTracker()

afterEach(() => {
  tracker.closeAll()
})

async function authorizedHarness(config?: { readonly bodyLimitBytes?: number }): Promise<{
  readonly app: Awaited<ReturnType<typeof tracker.make>>['app']
  readonly serverId: string
  readonly headers: Record<string, string>
}> {
  const harness = await tracker.make(config === undefined ? {} : { config })
  await seedOwner(harness.db, harness.clock.now())
  const headers = await loginAs(harness.app)
  return { app: harness.app, serverId: harness.serverId, headers }
}

/** 递归收集所有键名：用来断言"某些字段从未出现过"，比逐个 value 匹配更稳。 */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return into
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.add(key)
      collectKeys(item, into)
    }
  }
  return into
}

describe('GET /api/v1/capabilities', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const harness = await tracker.make()
    const response = await harness.app.inject({ method: 'GET', url: CAPABILITIES_URL })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('返回协议版本、资源上限与命令能力，且与执行侧常量逐一一致', async () => {
    const { app, serverId, headers } = await authorizedHarness()
    const response = await app.inject({ method: 'GET', url: CAPABILITIES_URL, headers })
    expect(response.statusCode).toBe(200)

    const body = response.json<CapabilitiesBody>()
    expect(body.serverId).toBe(serverId)
    expect(body.protocolVersion.major).toBe(1)
    expect(body.protocolVersion.minor).toBe(0)
    expect(body.minClientMajor).toBe(1)
    expect(body.limits.maxOperationsPerBatch).toBe(SYNC_LIMITS.maxOperationsPerBatch)
    expect(body.limits.maxBatchBytes).toBe(Math.min(SYNC_LIMITS.maxBatchBytes, DEFAULT_BODY_LIMIT_BYTES))
    expect(body.limits.maxOrderKeyLength).toBe(SYNC_LIMITS.maxOrderKeyLength)
    expect(body.commands).toEqual([...SUPPORTED_COMMANDS])
    // 附件上传是本轮之后的交付：必须**如实说 false**，而不是留一个乐观的 true。
    expect(body.assets.enabled).toBe(false)
    expect(body.assets.partSizeBytes).toBeGreaterThan(0)
    expect(body.readOnly).toBe(false)
  })

  it('运维调小请求体上限后，上报的 maxBatchBytes 同步收窄', async () => {
    const { app, headers } = await authorizedHarness({ bodyLimitBytes: 1024 })
    const body = (await app.inject({ method: 'GET', url: CAPABILITIES_URL, headers })).json<CapabilitiesBody>()
    expect(body.limits.maxBatchBytes).toBe(1024)
  })

  it('响应体不含内部路径、数据目录、密钥文件或监听参数', async () => {
    const { app, headers } = await authorizedHarness()
    const body = (await app.inject({ method: 'GET', url: CAPABILITIES_URL, headers })).json<CapabilitiesBody>()

    const keys = collectKeys(body)
    for (const forbidden of [
      'dataDir',
      'databasePath',
      'masterKeyFile',
      'bootstrapSecretFile',
      'listenHost',
      'listenPort',
      'trustedProxies',
      'sessionPolicy',
      'warnings',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }

    const text = JSON.stringify(body)
    // 任何盘符绝对路径（Windows）或以 / 开头的 POSIX 绝对路径都不该出现。
    expect(/[A-Za-z]:[\\/]/.test(text)).toBe(false)
    expect(/"\/[A-Za-z][^"]*"/.test(text)).toBe(false)
  })
})
