/**
 * 设备 / 配对码 HTTP 层验收（`devices.ts`、`pairingCodes.ts`）。
 *
 * ## 为什么不用 `makeHarness()`
 *
 * `makeHarness` 用完整的 `routes/index.ts` 装配，但**不给**测试注入配对 pepper
 * 的口子；本文件要固定 `TEST_PEPPER`，还要验"故意不配 pepper"的失败态。
 *
 * 因此这里 `createServer({ pairingPepper: ... })` 走同样**完整**的装配，只多这一个
 * 注入。生产路径（`bootstrapServer`）用的是配置里的 `masterKeyFile`，两者都会经过
 * `resolvePairingPepper`：拿不到就 fail closed 返回 503。
 *
 * ## 纪律
 *
 * - 断言全部回真实数据库（`SELECT`）与真实响应，不用 mock 反推；
 * - 时间只走注入时钟 `TestClock`；
 * - 夹具路径用 `fileURLToPath(new URL(...))`，**不用** `import.meta.dirname`。
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { newIds } from '@yfe/contracts'
import type { WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { hashToken } from '../src/auth/secrets.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { bearer, seedOwner, TEST_PEPPER, testClock, writeSecretFile } from './helpers.js'
import type { InjectLike, TestClock } from './helpers.js'
import { countRows, loginAs, withoutCsrf } from './syncHelpers.js'

/** 测试文件所在目录（夹具/路径解析一律基于它，不用 `import.meta.dirname`）。 */
const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

interface TestApp {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  close(): void
}

const booted: TestApp[] = []

interface BootOptions {
  /** 不传则用 `TEST_PEPPER`；传 `null` 表示"故意不配 pepper"。 */
  readonly pepper?: Buffer | null
  readonly masterKeyFile?: string
}

async function boot(options: BootOptions = {}): Promise<TestApp> {
  const db = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }
  const clock = testClock()
  const config = defaultServerConfig({
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
    // `masterKeyFile` 是**配置**的一部分（生产由环境变量给），测试用它验证
    // "只有密钥文件、没有 pepper"的那条派生路径。
    ...(options.masterKeyFile === undefined ? {} : { masterKeyFile: options.masterKeyFile }),
  })
  ensureServerState(db, 'srv_test', null)

  // 走**完整**路由装配（`routes/index.ts`）：登录/工作区/同步都在，测的才是真正
  // 上线的 app。唯一的测试专用注入是 pepper——`pairingPepper` 优先于 `masterKeyFile`。
  const app = createServer({
    config,
    db,
    serverId: 'srv_test',
    clock,
    logger: false,
    ...(options.pepper === null ? {} : { pairingPepper: options.pepper ?? TEST_PEPPER }),
  })
  await app.ready()

  const entry: TestApp = {
    app,
    db,
    clock,
    close(): void {
      closeServerDatabase(db)
    },
  }
  booted.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of booted.splice(0)) entry.close()
})

// ---------------------------------------------------------------------------
// 响应形状 + 直读数据库
// ---------------------------------------------------------------------------

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, unknown>>
}

interface PairingCodeCreated {
  readonly pairingCodeId: string
  readonly code: string
  readonly workspaceId: string | null
  readonly expiresAt: string
  readonly maxAttempts: number
}

interface PairingCodeItem {
  readonly pairingCodeId: string
  readonly workspaceId: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly expired: boolean
  readonly exhausted: boolean
}

interface PairingCodeList {
  readonly items: readonly PairingCodeItem[]
}

interface PairedDevice {
  readonly deviceId: string
  readonly token: string
  readonly workspaceId: string | null
}

interface DeviceSummary {
  readonly deviceId: string
  readonly userId: string
  readonly workspaceId: string | null
  readonly name: string
  readonly platform: string | null
  readonly pairingCodeId: string | null
  readonly createdAt: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
  readonly revokedReason: string | null
  readonly revoked: boolean
}

interface DeviceList {
  readonly items: readonly DeviceSummary[]
}

interface RevokedBody {
  readonly deviceId: string
  readonly revoked: boolean
  readonly revokedAt: string | null
  readonly revokedReason: string | null
}

interface DeviceRowLite {
  readonly id: string
  readonly user_id: string
  readonly workspace_id: string | null
  readonly name: string
  readonly platform: string | null
  readonly token_hash: string
  readonly pairing_code_id: string | null
  readonly created_at: string
  readonly last_seen_at: string | null
  readonly revoked_at: string | null
  readonly revoked_reason: string | null
}

interface PairingRowLite {
  readonly id: string
  readonly code_hash: string
  readonly workspace_id: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly max_attempts: number
  readonly attempts: number
  readonly consumed_at: string | null
  readonly consumed_device_id: string | null
  readonly revoked_at: string | null
}

function deviceRow(db: ServerDb, id: string): DeviceRowLite {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRowLite | undefined
  if (row === undefined) throw new Error(`设备 ${id} 不在库里`)
  return row
}

function pairingRow(db: ServerDb, id: string): PairingRowLite {
  const row = db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id) as PairingRowLite | undefined
  if (row === undefined) throw new Error(`配对码 ${id} 不在库里`)
  return row
}

async function issueCode(
  app: FastifyInstance,
  headers: Readonly<Record<string, string>>,
  workspaceId: WorkspaceId,
): Promise<PairingCodeCreated> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/pairing-codes`,
    headers,
  })
  expect(response.statusCode).toBe(201)
  return response.json<PairingCodeCreated>()
}

function pair(
  app: FastifyInstance,
  payload: Readonly<Record<string, unknown>>,
): Promise<InjectLike> {
  return app.inject({ method: 'POST', url: '/api/v1/devices/pair', payload })
}

/** 签发 + 兑换，返回设备摘要（多数用例只关心"有一台可用设备"）。 */
async function pairNewDevice(
  app: FastifyInstance,
  headers: Readonly<Record<string, string>>,
  workspaceId: WorkspaceId,
  deviceName = '测试设备',
): Promise<{ readonly created: PairingCodeCreated; readonly device: PairedDevice }> {
  const created = await issueCode(app, headers, workspaceId)
  const response = await pair(app, { code: created.code, deviceName, workspaceId })
  expect(response.statusCode).toBe(201)
  return { created, device: response.json<PairedDevice>() }
}

// ---------------------------------------------------------------------------
// 配对码签发
// ---------------------------------------------------------------------------

describe('POST /api/v1/workspaces/:workspaceId/pairing-codes', () => {
  it('签发：明文码只回一次，库里只有加 pepper 的摘要', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)

    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/pairing-codes`,
      headers: session,
    })
    expect(response.statusCode).toBe(201)
    const created = response.json<PairingCodeCreated>()

    expect(created.workspaceId).toBe(workspaceId)
    expect(created.maxAttempts).toBe(5)
    expect(created.code.length).toBeGreaterThanOrEqual(8)
    // 注入时钟 + 默认 10 分钟 TTL：绝对时间由时钟决定，不靠 sleep。
    expect(created.expiresAt).toBe('2026-01-01T00:10:00.000Z')
    expect(response.headers['cache-control']).toBe('no-store')

    const row = pairingRow(t.db, created.pairingCodeId)
    expect(row.code_hash.startsWith('scrypt-pairing:')).toBe(true)
    expect(row.code_hash).not.toContain(created.code)
    expect(row.code_hash).not.toBe(created.code)
    expect(row.workspace_id).toBe(workspaceId)
    expect(row.attempts).toBe(0)
    expect(row.max_attempts).toBe(5)
    expect(row.consumed_at).toBeNull()
    expect(row.revoked_at).toBeNull()
    expect(countRows(t.db, 'devices')).toBe(0)
  })

  it('列举：只有元数据，绝不含明文码、摘要、token', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const created = await issueCode(t.app, session, workspaceId)

    const response = await t.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/pairing-codes`,
      headers: session,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<PairingCodeList>()
    expect(body.items).toHaveLength(1)
    const item = body.items[0] as PairingCodeItem
    expect(Object.keys(item).sort()).toEqual(
      ['attempts', 'createdAt', 'exhausted', 'expired', 'expiresAt', 'maxAttempts', 'pairingCodeId', 'workspaceId'].sort(),
    )
    expect(item.pairingCodeId).toBe(created.pairingCodeId)
    expect(item.workspaceId).toBe(workspaceId)
    expect(item.attempts).toBe(0)
    expect(item.maxAttempts).toBe(5)
    expect(item.expired).toBe(false)
    expect(item.exhausted).toBe(false)

    expect(response.body).not.toContain(created.code)
    expect(response.body).not.toContain('scrypt-pairing:')
    expect(response.body).not.toContain('code_hash')
    expect(response.body).not.toContain('codeHash')
  })

  it('未登录：签发与列举都 401；Cookie 写请求缺 CSRF 头 403', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const url = `/api/v1/workspaces/${workspaceId}/pairing-codes`

    const anonymousCreate = await t.app.inject({ method: 'POST', url })
    expect(anonymousCreate.statusCode).toBe(401)
    expect(anonymousCreate.json<ErrorBody>().code).toBe('AUTH_REQUIRED')

    const anonymousList = await t.app.inject({ method: 'GET', url })
    expect(anonymousList.statusCode).toBe(401)

    const session = await loginAs(t.app)
    const noCsrf = await t.app.inject({ method: 'POST', url, headers: withoutCsrf(session) })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
    expect(countRows(t.db, 'pairing_codes')).toBe(0)
  })

  it('非成员不能给别人的工作区签发配对码（403）', async () => {
    const t = await boot()
    const { workspaceId: mine } = await seedOwner(t.db, t.clock.now())
    const other = await seedOwner(t.db, t.clock.now(), { username: 'owner-b' })
    const session = await loginAs(t.app)

    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${other.workspaceId}/pairing-codes`,
      headers: session,
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
    expect(countRows(t.db, 'pairing_codes')).toBe(0)
    // 自己的工作区仍然是可用的（证明失败是"跨工作区"而不是"角色不够"）。
    const own = await issueCode(t.app, session, mine)
    expect(own.workspaceId).toBe(mine)
  })
})

// ---------------------------------------------------------------------------
// 兑换设备凭据
// ---------------------------------------------------------------------------

describe('POST /api/v1/devices/pair', () => {
  it('一次性配对码换设备凭据：令牌明文只在响应里出现一次', async () => {
    const t = await boot()
    const { userId, workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const created = await issueCode(t.app, session, workspaceId)

    const response = await pair(t.app, {
      code: created.code,
      deviceName: '工作室台式机',
      platform: 'windows',
      workspaceId,
    })
    expect(response.statusCode).toBe(201)
    const paired = response.json<PairedDevice>()
    expect(paired.workspaceId).toBe(workspaceId)
    expect(paired.token.length).toBeGreaterThanOrEqual(40)

    expect(countRows(t.db, 'devices')).toBe(1)
    const device = deviceRow(t.db, paired.deviceId)
    expect(device.token_hash).toBe(hashToken(paired.token))
    expect(device.token_hash).not.toBe(paired.token)
    expect(device.user_id).toBe(userId)
    expect(device.workspace_id).toBe(workspaceId)
    expect(device.name).toBe('工作室台式机')
    expect(device.platform).toBe('windows')
    expect(device.pairing_code_id).toBe(created.pairingCodeId)
    expect(device.revoked_at).toBeNull()
    expect(device.last_seen_at).toBeNull()

    const code = pairingRow(t.db, created.pairingCodeId)
    expect(code.consumed_at).toBe(t.clock.now())
    expect(code.consumed_device_id).toBe(paired.deviceId)
  })

  it('同一配对码第二次使用必须失败，且不产生第二台设备', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const { created, device } = await pairNewDevice(t.app, session, workspaceId)

    const second = await pair(t.app, { code: created.code, deviceName: '第二台', workspaceId })
    expect(second.statusCode).toBe(401)
    const error = second.json<ErrorBody>()
    expect(error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(error.detail?.reason).toBe('consumed')

    expect(countRows(t.db, 'devices')).toBe(1)
    expect(deviceRow(t.db, device.deviceId).name).toBe('测试设备')
    expect(pairingRow(t.db, created.pairingCodeId).consumed_device_id).toBe(device.deviceId)
  })

  it('尝试次数超限后配对码失效（每失败一次 attempts 自增）', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const created = await issueCode(t.app, session, workspaceId)
    const otherWorkspace = newIds.workspace() as WorkspaceId

    // 前 5 次：工作区不匹配（可恢复的失败）——每一次都要计数。
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await pair(t.app, {
        code: created.code,
        deviceName: '含糊设备',
        workspaceId: otherWorkspace,
      })
      expect(response.statusCode).toBe(403)
      expect(response.json<ErrorBody>().code).toBe('PERMISSION_WORKSPACE_MISMATCH')
      expect(pairingRow(t.db, created.pairingCodeId).attempts).toBe(attempt)
    }

    // 第 6 次：次数已经超上限，即使这次给的还是同一个错误工作区。
    const sixth = await pair(t.app, { code: created.code, deviceName: 'x', workspaceId: otherWorkspace })
    expect(sixth.statusCode).toBe(401)
    expect(sixth.json<ErrorBody>().code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(sixth.json<ErrorBody>().detail?.reason).toBe('too_many_attempts')
    expect(pairingRow(t.db, created.pairingCodeId).attempts).toBe(6)

    // 第 7 次：**一切参数都正确**也无效——次数上限已经把这个码打死。
    const correct = await pair(t.app, { code: created.code, deviceName: 'x', workspaceId })
    expect(correct.statusCode).toBe(401)
    expect(correct.json<ErrorBody>().detail?.reason).toBe('too_many_attempts')

    const row = pairingRow(t.db, created.pairingCodeId)
    expect(row.attempts).toBe(7)
    expect(row.consumed_at).toBeNull()
    expect(countRows(t.db, 'devices')).toBe(0)
  })

  it('过期配对码拒绝（用注入时钟推进）', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const created = await issueCode(t.app, session, workspaceId)

    t.clock.advance(11 * 60 * 1000)
    const response = await pair(t.app, { code: created.code, deviceName: '迟到设备', workspaceId })
    expect(response.statusCode).toBe(401)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('AUTH_TOKEN_EXPIRED')
    expect(error.detail?.reason).toBe('expired')
    expect(countRows(t.db, 'devices')).toBe(0)
    expect(pairingRow(t.db, created.pairingCodeId).consumed_at).toBeNull()
  })

  it('不存在的码：401 且不计数、不建行（防"往表里塞垃圾"）', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    await issueCode(t.app, session, workspaceId)

    const response = await pair(t.app, { code: 'ZZZZZZZZ', deviceName: '幽灵设备', workspaceId })
    expect(response.statusCode).toBe(401)
    expect(response.json<ErrorBody>().detail?.reason).toBe('not_found')
    expect(countRows(t.db, 'pairing_codes')).toBe(1)
    expect(countRows(t.db, 'devices')).toBe(0)
  })

  it('设备名空/全空白 → 400 VALIDATION_*', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const created = await issueCode(t.app, session, workspaceId)

    const empty = await pair(t.app, { code: created.code, deviceName: '', workspaceId })
    expect(empty.statusCode).toBe(400)
    expect(empty.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    const blank = await pair(t.app, { code: created.code, deviceName: '   ', workspaceId })
    expect(blank.statusCode).toBe(400)
    expect(blank.json<ErrorBody>().code.startsWith('VALIDATION_')).toBe(true)
    expect(countRows(t.db, 'devices')).toBe(0)
  })

  it('装配方只给 masterKeyFile 时也能签发与兑换（读文件 → 派生 pepper）', async () => {
    const keyFile = writeSecretFile('master.key', Buffer.alloc(32, 9).toString('base64'))
    const t = await boot({ masterKeyFile: keyFile })
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)

    const { device } = await pairNewDevice(t.app, session, workspaceId, 'masterKey 设备')
    expect(device.workspaceId).toBe(workspaceId)
    expect(countRows(t.db, 'devices')).toBe(1)
  })

  it('没配 pepper / masterKeyFile 时 fail closed：503，且响应不含密钥路径', async () => {
    // 夹具路径用 fileURLToPath 解析（不用 import.meta.dirname）。
    const missingKeyFile = join(TESTS_DIR, 'no-such-master-key.bin')
    const t = await boot({ pepper: null, masterKeyFile: missingKeyFile })
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)

    const response = await t.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/pairing-codes`,
      headers: session,
    })
    expect(response.statusCode).toBe(503)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.detail?.reason).toBe('master_key_unavailable')
    // 🔴 绝不回传绝对路径 / 文件系统细节。
    expect(response.body).not.toContain(missingKeyFile)
    expect(response.body).not.toContain(TESTS_DIR)
    expect(countRows(t.db, 'pairing_codes')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 设备管理
// ---------------------------------------------------------------------------

describe('设备管理', () => {
  it('列表：不含 token_hash，也不含令牌/配对码明文', async () => {
    const t = await boot()
    const { userId, workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const { created, device } = await pairNewDevice(t.app, session, workspaceId, '客厅台式机')

    const response = await t.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/devices`,
      headers: session,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<DeviceList>()
    expect(body.items).toHaveLength(1)
    const item = body.items[0] as DeviceSummary
    expect(Object.keys(item).sort()).toEqual(
      [
        'createdAt', 'deviceId', 'lastSeenAt', 'name', 'pairingCodeId', 'platform',
        'revoked', 'revokedAt', 'revokedReason', 'userId', 'workspaceId',
      ].sort(),
    )
    expect(item.deviceId).toBe(device.deviceId)
    expect(item.userId).toBe(userId)
    expect(item.workspaceId).toBe(workspaceId)
    expect(item.name).toBe('客厅台式机')
    expect(item.pairingCodeId).toBe(created.pairingCodeId)
    expect(item.lastSeenAt).toBeNull()
    expect(item.revokedAt).toBeNull()
    expect(item.revoked).toBe(false)

    expect(response.body).not.toContain(device.token)
    expect(response.body).not.toContain('token_hash')
    expect(response.body).not.toContain('tokenHash')
    expect(response.body).not.toContain(created.code)
  })

  it('重命名：空名 → VALIDATION_FAILED，正常名生效', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const { device } = await pairNewDevice(t.app, session, workspaceId)
    const url = `/api/v1/workspaces/${workspaceId}/devices/${device.deviceId}`

    const empty = await t.app.inject({ method: 'PATCH', url, headers: session, payload: { name: '' } })
    expect(empty.statusCode).toBe(400)
    expect(empty.json<ErrorBody>().code).toBe('VALIDATION_FAILED')
    expect(deviceRow(t.db, device.deviceId).name).toBe('测试设备')

    const blank = await t.app.inject({ method: 'PATCH', url, headers: session, payload: { name: '   ' } })
    expect(blank.statusCode).toBe(400)
    expect(blank.json<ErrorBody>().code.startsWith('VALIDATION_')).toBe(true)

    const renamed = await t.app.inject({ method: 'PATCH', url, headers: session, payload: { name: '书房笔记本' } })
    expect(renamed.statusCode).toBe(200)
    expect(deviceRow(t.db, device.deviceId).name).toBe('书房笔记本')
  })

  it('撤销：撤销前令牌可用，撤销后立刻不可用；重复撤销零二次写入', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const { device } = await pairNewDevice(t.app, session, workspaceId, '会被偷的笔记本')
    const claimUrl = '/api/v1/devices/commands/claim'

    // 撤销前：设备令牌可用（顺带证明 last_seen_at 会被更新）。
    const before = await t.app.inject({ method: 'POST', url: claimUrl, headers: bearer(device.token) })
    expect(before.statusCode).toBe(200)
    const seenAt = deviceRow(t.db, device.deviceId).last_seen_at
    expect(seenAt).toBe(t.clock.now())

    const ttl = `/api/v1/workspaces/${workspaceId}/devices/${device.deviceId}`
    t.clock.advance(1000)
    const revoked = await t.app.inject({
      method: 'DELETE',
      url: ttl,
      headers: session,
      payload: { reason: '笔记本丢了' },
    })
    expect(revoked.statusCode).toBe(200)
    const revokedBody = revoked.json<RevokedBody>()
    expect(revokedBody.revoked).toBe(true)
    const revokedAt = revokedBody.revokedAt
    expect(revokedAt).toBe(t.clock.now())

    const row = deviceRow(t.db, device.deviceId)
    expect(row.revoked_at).toBe(revokedAt)
    expect(row.revoked_reason).toBe('笔记本丢了')

    // 撤销后：同一个令牌立刻失败（撤销是"立即生效"的，不需要等任何缓存过期）。
    const after = await t.app.inject({ method: 'POST', url: claimUrl, headers: bearer(device.token) })
    expect(after.statusCode).toBe(401)
    const error = after.json<ErrorBody>()
    expect(error.code).toBe('AUTH_DEVICE_REVOKED')
    expect(error.detail?.reason).toBe('笔记本丢了')
    // 拒绝路径不更新 last_seen_at（现在时钟已经比那一次成功请求晚了 1 秒）。
    expect(deviceRow(t.db, device.deviceId).last_seen_at).toBe(seenAt)

    // 重复撤销（不带 body）：幂等，`revoked_at` / `revoked_reason` 都不被覆盖。
    t.clock.advance(5000)
    const again = await t.app.inject({ method: 'DELETE', url: ttl, headers: session })
    expect(again.statusCode).toBe(200)
    expect(again.json<RevokedBody>().revokedAt).toBe(revokedAt)
    const rowAgain = deviceRow(t.db, device.deviceId)
    expect(rowAgain.revoked_at).toBe(revokedAt)
    expect(rowAgain.revoked_reason).toBe('笔记本丢了')

    // 列表里能看到撤销状态。
    const list = await t.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/devices`,
      headers: session,
    })
    const item = list.json<DeviceList>().items[0] as DeviceSummary
    expect(item.revoked).toBe(true)
    expect(item.revokedAt).toBe(revokedAt)
    expect(item.revokedReason).toBe('笔记本丢了')
  })

  it('会话身份不能换成设备身份，设备令牌不能换成会话身份', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)
    const { device } = await pairNewDevice(t.app, session, workspaceId)

    // 会话（Cookie）打设备路由：没有 Bearer → AUTH_REQUIRED。
    const sessionOnDevice = await t.app.inject({
      method: 'POST',
      url: '/api/v1/devices/commands/claim',
      headers: session,
    })
    expect(sessionOnDevice.statusCode).toBe(401)
    expect(sessionOnDevice.json<ErrorBody>().code).toBe('AUTH_REQUIRED')

    // 设备令牌打会话路由：它不是会话令牌 → 401。
    const deviceOnSession = await t.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceId}/devices`,
      headers: bearer(device.token),
    })
    expect(deviceOnSession.statusCode).toBe(401)

    // 畸形 / 无效设备令牌 → 401。
    const malformed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/devices/commands/claim',
      headers: { authorization: 'Basic abc' },
    })
    expect(malformed.statusCode).toBe(401)
    expect(malformed.json<ErrorBody>().code).toBe('AUTH_REQUIRED')

    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/v1/devices/commands/claim',
      headers: bearer('not-a-real-device-token'),
    })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json<ErrorBody>().code).toBe('AUTH_DEVICE_NOT_PAIRED')
  })

  it('跨工作区：A 的会话看不到也改不了 B 的设备', async () => {
    const t = await boot()
    const a = await seedOwner(t.db, t.clock.now())
    const b = await seedOwner(t.db, t.clock.now(), { username: 'owner-b' })
    const sessionB = await loginAs(t.app, 'owner-b')
    const { device: deviceB } = await pairNewDevice(t.app, sessionB, b.workspaceId, 'B 的设备')

    const sessionA = await loginAs(t.app)
    const listUrl = `/api/v1/workspaces/${b.workspaceId}/devices`
    const itemUrl = `${listUrl}/${deviceB.deviceId}`

    const list = await t.app.inject({ method: 'GET', url: listUrl, headers: sessionA })
    expect(list.statusCode).toBe(403)
    expect(list.json<ErrorBody>().code).toBe('PERMISSION_DENIED')

    const patch = await t.app.inject({ method: 'PATCH', url: itemUrl, headers: sessionA, payload: { name: '越权改名' } })
    expect(patch.statusCode).toBe(403)

    const del = await t.app.inject({ method: 'DELETE', url: itemUrl, headers: sessionA })
    expect(del.statusCode).toBe(403)
    expect(deviceRow(t.db, deviceB.deviceId).revoked_at).toBeNull()
    expect(deviceRow(t.db, deviceB.deviceId).name).toBe('B 的设备')

    // 自己的设备仍然可管（证明不是"整体拒绝"）。
    expect(a.workspaceId).toBeTruthy()
    const ownList = await t.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${a.workspaceId}/devices`,
      headers: sessionA,
    })
    expect(ownList.statusCode).toBe(200)
  })

  it('不存在的设备 → 404；畸形 id → 400 VALIDATION_MALFORMED_ID', async () => {
    const t = await boot()
    const { workspaceId } = await seedOwner(t.db, t.clock.now())
    const session = await loginAs(t.app)

    const missing = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/devices/${newIds.device()}`,
      headers: session,
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<ErrorBody>().code).toBe('NOT_FOUND')

    const malformed = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/devices/dev..x`,
      headers: session,
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json<ErrorBody>().code).toBe('VALIDATION_MALFORMED_ID')
  })
})
