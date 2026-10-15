/**
 * 远程命令 HTTP 层验收（`routes/commands.ts` + `db/commands.ts`）。
 *
 * 覆盖三条契约：
 * - `POST /api/v1/workspaces/:workspaceId/devices/:deviceId/commands`（会话侧生成）
 * - `POST /api/v1/devices/commands/claim`（设备侧领取，租约制）
 * - `POST /api/v1/devices/commands/:commandId/ack`（设备侧回执，幂等）
 *
 * ## 为什么不用 `makeHarness()`
 *
 * 本文件要注入固定的测试 pepper（`TEST_PEPPER`）来走完"配对码 → 设备令牌 → 领取
 * 命令 → 回执"这条链；全表装配下 pepper 默认只能来自 `config.masterKeyFile`。
 *
 * 所以这里用 `createServer({ pairingPepper: TEST_PEPPER })` 走**完整**路由装配
 * （`routes/index.ts`）：登录/工作区/设备/命令/配对码全在，测的是真正上线的 app。
 * `pairingPepper` 是这个装配点唯一的测试专用注入。
 *
 * ## 纪律
 *
 * 关键断言都回真实数据库（`SELECT`）核，尤其"零二次写入"这类要求：
 * 重复回执后 `acked_at` / `result_json` / `error_code` 必须与第一次**逐个字段**
 * 相同（不是"看起来像"）。时间全部走注入时钟。
 */

import { newIds } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { bearer, seedOwner, TEST_PEPPER, testClock } from './helpers.js'
import type { InjectLike, TestClock } from './helpers.js'
import { countRows, loginAs, withoutCsrf } from './syncHelpers.js'

const START = '2026-01-01T00:00:00.000Z'
/** 默认租约 60s（`DEFAULT_COMMAND_LEASE_MS`）。 */
const LEASE_MS = 60_000

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

async function boot(): Promise<TestApp> {
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
  })
  ensureServerState(db, 'srv_test', null)

  // 完整路由装配 + 测试 pepper：测的是真正上线的 app（登录、设备、命令、配对码全在）。
  const app = createServer({
    config,
    db,
    serverId: 'srv_test',
    clock,
    logger: false,
    pairingPepper: TEST_PEPPER,
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
// 响应形状 / 库行 / 助手
// ---------------------------------------------------------------------------

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, unknown>>
}

interface RemoteCommandView {
  readonly commandId: string
  readonly workspaceId: string
  readonly targetDeviceId: string
  readonly commandType: string
  readonly args: Readonly<Record<string, unknown>>
  readonly expiresAt: string
  readonly issuer: string
  readonly status: string
  readonly createdAt: string
}

interface ClaimBody {
  readonly command: RemoteCommandView | null
  readonly leaseExpiresAt: string | null
}

interface AckBody {
  readonly commandId: string
  readonly status: string
  readonly executionId: string | null
  readonly ackedAt: string | null
  readonly result: Readonly<Record<string, unknown>> | null
  readonly errorCode: string | null
  readonly duplicate: boolean
}

interface PairedDevice {
  readonly deviceId: string
  readonly token: string
  readonly workspaceId: string | null
}

interface RemoteCommandRowLite {
  readonly command_id: string
  readonly workspace_id: string
  readonly target_device_id: string
  readonly command_type: string
  readonly args_json: string
  readonly issuer: string
  readonly status: string
  readonly created_at: string
  readonly expires_at: string
  readonly claimed_by_device_id: string | null
  readonly lease_expires_at: string | null
  readonly execution_id: string | null
  readonly result_json: string | null
  readonly error_code: string | null
  readonly acked_at: string | null
}

interface PairingCodeCreated {
  readonly pairingCodeId: string
  readonly code: string
}

function commandRow(db: ServerDb, id: string): RemoteCommandRowLite {
  const row = db.prepare('SELECT * FROM remote_commands WHERE command_id = ?').get(id) as
    | RemoteCommandRowLite
    | undefined
  if (row === undefined) throw new Error(`远程命令 ${id} 不在库里`)
  return row
}

function at(offsetMs: number): string {
  return new Date(Date.parse(START) + offsetMs).toISOString()
}

async function pairNewDevice(
  app: FastifyInstance,
  headers: Readonly<Record<string, string>>,
  workspaceId: string,
  name: string,
): Promise<PairedDevice> {
  const issued = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/pairing-codes`,
    headers,
  })
  expect(issued.statusCode).toBe(201)
  const created = issued.json<PairingCodeCreated>()
  const paired = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/pair',
    payload: { code: created.code, deviceName: name, workspaceId },
  })
  expect(paired.statusCode).toBe(201)
  return paired.json<PairedDevice>()
}

function createCommand(
  app: FastifyInstance,
  headers: Readonly<Record<string, string>>,
  workspaceId: string,
  deviceId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<InjectLike> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${workspaceId}/devices/${deviceId}/commands`,
    headers,
    payload,
  })
}

function claim(
  app: FastifyInstance,
  token: string,
  payload?: Readonly<Record<string, unknown>>,
): Promise<InjectLike> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/devices/commands/claim',
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  })
}

function ack(
  app: FastifyInstance,
  token: string,
  commandId: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<InjectLike> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/devices/commands/${commandId}/ack`,
    headers: bearer(token),
    payload,
  })
}

/** 会话 + 一台同工作区设备 + 一个稳定 payload 的常用组合。 */
async function scene(): Promise<{
  readonly t: TestApp
  readonly userId: string
  readonly workspaceId: string
  readonly session: Record<string, string>
  readonly device: PairedDevice
}> {
  const t = await boot()
  const owner = await seedOwner(t.db, t.clock.now())
  const session = await loginAs(t.app)
  const device = await pairNewDevice(t.app, session, owner.workspaceId, '目标设备')
  return { t, userId: owner.userId, workspaceId: owner.workspaceId, session, device }
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

describe('POST /api/v1/workspaces/:workspaceId/devices/:deviceId/commands', () => {
  it('生成命令：落 pending，issuer 取服务端会话身份，请求体里的 issuer 被彻底忽略', async () => {
    const { t, userId, workspaceId, session, device } = await scene()
    const args = { workflowId: 'wf_1', input: { retries: 2 } }

    const response = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'workflow.run',
      args,
      expiresAt: at(5 * 60 * 1000),
      // 🔴 伪造的 issuer：契约要求由服务端会话产生，客户端自报一律丢弃。
      issuer: 'usr_forged_by_client',
    })
    expect(response.statusCode).toBe(201)
    const body = response.json<RemoteCommandView>()

    expect(body.commandId.startsWith('req_')).toBe(true)
    expect(body.workspaceId).toBe(workspaceId)
    expect(body.targetDeviceId).toBe(device.deviceId)
    expect(body.commandType).toBe('workflow.run')
    expect(body.args).toEqual(args)
    expect(body.expiresAt).toBe(at(5 * 60 * 1000))
    expect(body.status).toBe('pending')
    expect(body.createdAt).toBe(START)
    expect(body.issuer).toBe(userId)
    expect(body.issuer).not.toBe('usr_forged_by_client')
    expect(Object.keys(body).sort()).toEqual(
      ['args', 'commandId', 'commandType', 'createdAt', 'expiresAt', 'issuer', 'status', 'targetDeviceId', 'workspaceId'].sort(),
    )

    const row = commandRow(t.db, body.commandId)
    expect(row.status).toBe('pending')
    expect(row.issuer).toBe(userId)
    expect(row.args_json).toBe(JSON.stringify(args))
    expect(row.claimed_by_device_id).toBeNull()
    expect(row.lease_expires_at).toBeNull()
    expect(row.execution_id).toBeNull()
    expect(row.acked_at).toBeNull()
    expect(row.result_json).toBeNull()
  })

  it('参数校验：命令类型白名单 / expiresAt 必须晚于当前时刻 / args 必须是对象', async () => {
    const { t, workspaceId, session, device } = await scene()

    const badType = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'reboot.now',
      expiresAt: at(60_000),
    })
    expect(badType.statusCode).toBe(400)
    expect(badType.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    const past = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(-1000),
    })
    expect(past.statusCode).toBe(400)
    expect(past.json<ErrorBody>().code).toBe('VALIDATION_OUT_OF_RANGE')

    const notATime = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: '明天',
    })
    expect(notATime.statusCode).toBe(400)
    expect(notATime.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    const arrayArgs = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      args: ['nope'],
      expiresAt: at(60_000),
    })
    expect(arrayArgs.statusCode).toBe(400)
    expect(arrayArgs.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    expect(countRows(t.db, 'remote_commands')).toBe(0)
  })

  it('跨工作区生成 → 403，且不落库；不属于该工作区的设备 → 404', async () => {
    const t = await boot()
    const a = await seedOwner(t.db, t.clock.now())
    const b = await seedOwner(t.db, t.clock.now(), { username: 'owner-b' })
    const sessionB = await loginAs(t.app, 'owner-b')
    const deviceB = await pairNewDevice(t.app, sessionB, b.workspaceId, 'B 的设备')
    const sessionA = await loginAs(t.app)

    // A 的会话打 B 的工作区：守卫就拦了。
    const crossWorkspace = await createCommand(t.app, sessionA, b.workspaceId, deviceB.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(60_000),
    })
    expect(crossWorkspace.statusCode).toBe(403)
    expect(crossWorkspace.json<ErrorBody>().code).toBe('PERMISSION_DENIED')

    // 工作区是自己的，设备却是别人的：不能借道。
    const crossDevice = await createCommand(t.app, sessionA, a.workspaceId, deviceB.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(60_000),
    })
    expect(crossDevice.statusCode).toBe(404)
    expect(crossDevice.json<ErrorBody>().code).toBe('NOT_FOUND')

    // 设备令牌不是会话：生成接口只认会话。
    const deviceOnSession = await createCommand(t.app, bearer(deviceB.token), a.workspaceId, deviceB.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(60_000),
    })
    expect(deviceOnSession.statusCode).toBe(401)

    const noCsrf = await createCommand(t.app, withoutCsrf(sessionA), a.workspaceId, deviceB.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(60_000),
    })
    expect(noCsrf.statusCode).toBe(403)

    expect(countRows(t.db, 'remote_commands')).toBe(0)
  })

  it('已撤销设备不能接收命令（409）；不存在的设备 404', async () => {
    const { t, workspaceId, session, device } = await scene()

    const revoke = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceId}/devices/${device.deviceId}`,
      headers: session,
      payload: { reason: '不再使用' },
    })
    expect(revoke.statusCode).toBe(200)

    const revoked = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'job.cancel',
      args: { jobId: 'job_1' },
      expiresAt: at(60_000),
    })
    expect(revoked.statusCode).toBe(409)
    expect(revoked.json<ErrorBody>().code).toBe('STATE_INVALID_TRANSITION')

    const unknown = await createCommand(t.app, session, workspaceId, newIds.device(), {
      commandType: 'job.cancel',
      expiresAt: at(60_000),
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json<ErrorBody>().code).toBe('NOT_FOUND')

    expect(countRows(t.db, 'remote_commands')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 领取
// ---------------------------------------------------------------------------

describe('POST /api/v1/devices/commands/claim', () => {
  it('只领自己的命令：非目标设备拿不到（command: null），且按 created_at ASC 先到先得', async () => {
    const { t, workspaceId, session, device } = await scene()
    const other = await pairNewDevice(t.app, session, workspaceId, '旁路设备')

    t.clock.advance(1000)
    const early = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(10 * 60 * 1000),
    })
    const earlyId = early.json<RemoteCommandView>().commandId
    t.clock.advance(1000)
    const late = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(10 * 60 * 1000),
    })
    const lateId = late.json<RemoteCommandView>().commandId

    // 别人的命令：空手而归，且不得碰任何行。
    const stolen = await claim(t.app, other.token)
    expect(stolen.statusCode).toBe(200)
    expect(stolen.json<ClaimBody>()).toEqual({ command: null, leaseExpiresAt: null })
    expect(commandRow(t.db, earlyId).status).toBe('pending')
    expect(commandRow(t.db, earlyId).claimed_by_device_id).toBeNull()

    // 没有 body 也能领（服务端自己生成 executionId）。
    const first = await claim(t.app, device.token)
    expect(first.statusCode).toBe(200)
    const claimed = first.json<ClaimBody>()
    expect(claimed.command?.commandId).toBe(earlyId)
    expect(claimed.command?.status).toBe('claimed')
    expect(claimed.leaseExpiresAt).toBe(at(2000 + LEASE_MS))
    expect(claimed.command?.issuer).toBe(early.json<RemoteCommandView>().issuer)

    const row = commandRow(t.db, earlyId)
    expect(row.status).toBe('claimed')
    expect(row.claimed_by_device_id).toBe(device.deviceId)
    expect(row.lease_expires_at).toBe(at(2000 + LEASE_MS))
    expect(row.execution_id).not.toBeNull()
    // 第二条还躺在那儿等下一次领取。
    expect(commandRow(t.db, lateId).status).toBe('pending')
  })

  it('领取不是删除：租约未过期时不可重领，过期后可以重新领取且不改写 executionId', async () => {
    const { t, workspaceId, session, device } = await scene()
    const created = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(30 * 60 * 1000),
    })
    const commandId = created.json<RemoteCommandView>().commandId

    const first = await claim(t.app, device.token, { executionId: 'exec-lease-1' })
    expect(first.statusCode).toBe(200)
    expect(first.json<ClaimBody>().command?.commandId).toBe(commandId)
    expect(commandRow(t.db, commandId).execution_id).toBe('exec-lease-1')

    // 租约还活着：同一台设备也领不到（领取不会把命令重发一遍）。
    const whileLive = await claim(t.app, device.token, { executionId: 'exec-lease-2' })
    expect(whileLive.statusCode).toBe(200)
    expect(whileLive.json<ClaimBody>()).toEqual({ command: null, leaseExpiresAt: null })
    expect(commandRow(t.db, commandId).execution_id).toBe('exec-lease-1')

    // 走完租约（设备崩溃场景）：命令必须能重新领取。
    t.clock.advance(LEASE_MS)
    const reclaimed = await claim(t.app, device.token, { executionId: 'exec-lease-2' })
    expect(reclaimed.statusCode).toBe(200)
    const body = reclaimed.json<ClaimBody>()
    expect(body.command?.commandId).toBe(commandId)
    expect(body.leaseExpiresAt).toBe(at(LEASE_MS * 2))

    const row = commandRow(t.db, commandId)
    expect(row.status).toBe('claimed')
    expect(row.claimed_by_device_id).toBe(device.deviceId)
    expect(row.lease_expires_at).toBe(at(LEASE_MS * 2))
    // 🔴 重领**不改写** executionId，否则设备崩溃重领后第一次回执会全部"不一致"。
    expect(row.execution_id).toBe('exec-lease-1')
  })

  it('expiresAt 已过的命令在领取时被置 expired，且不会被发出去', async () => {
    const { t, workspaceId, session, device } = await scene()
    const dead = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(1000),
    })
    const deadId = dead.json<RemoteCommandView>().commandId

    t.clock.advance(2000)
    // 顺带造一条还活着的：过期扫描不能连它一起打死。
    const alive = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(60 * 60 * 1000),
    })
    const aliveId = alive.json<RemoteCommandView>().commandId

    const response = await claim(t.app, device.token)
    expect(response.statusCode).toBe(200)
    const body = response.json<ClaimBody>()
    expect(body.command?.commandId).toBe(aliveId)

    const deadRow = commandRow(t.db, deadId)
    expect(deadRow.status).toBe('expired')
    expect(deadRow.claimed_by_device_id).toBeNull()
    expect(deadRow.lease_expires_at).toBeNull()
    expect(commandRow(t.db, aliveId).status).toBe('claimed')
  })

  it('领取必须用设备令牌：没有令牌 401', async () => {
    const t = await boot()
    await seedOwner(t.db, t.clock.now())

    const anonymous = await t.app.inject({ method: 'POST', url: '/api/v1/devices/commands/claim' })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.json<ErrorBody>().code).toBe('AUTH_REQUIRED')
  })
})

// ---------------------------------------------------------------------------
// 回执
// ---------------------------------------------------------------------------

describe('POST /api/v1/devices/commands/:commandId/ack', () => {
  it('成功回执：落 acked + result，重复回执返回原结果且零二次写入', async () => {
    const { t, workspaceId, session, device } = await scene()
    const created = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'workflow.run',
      expiresAt: at(30 * 60 * 1000),
    })
    const commandId = created.json<RemoteCommandView>().commandId
    await claim(t.app, device.token, { executionId: 'exec-1' })

    const result = { ok: true, artifacts: ['out/a.txt'] }
    const first = await ack(t.app, device.token, commandId, {
      executionId: 'exec-1',
      status: 'succeeded',
      result,
    })
    expect(first.statusCode).toBe(200)
    const firstBody = first.json<AckBody>()
    expect(firstBody.duplicate).toBe(false)
    expect(firstBody.commandId).toBe(commandId)
    expect(firstBody.status).toBe('acked')
    expect(firstBody.executionId).toBe('exec-1')
    expect(firstBody.ackedAt).toBe(START)
    expect(firstBody.result).toEqual(result)
    expect(firstBody.errorCode).toBeNull()

    const row = commandRow(t.db, commandId)
    expect(row.status).toBe('acked')
    expect(row.acked_at).toBe(START)
    expect(row.result_json).toBe(JSON.stringify(result))
    expect(row.error_code).toBeNull()
    expect(row.lease_expires_at).not.toBeNull()

    // 重复回执：即使这次报的是"失败 + 新结果 + 新错误码"，也必须原样返回第一次的结果。
    t.clock.advance(9000)
    const duplicate = await ack(t.app, device.token, commandId, {
      executionId: 'exec-1',
      status: 'failed',
      result: { ok: false, tampered: true },
      errorCode: 'E_SHOULD_BE_IGNORED',
    })
    expect(duplicate.statusCode).toBe(200)
    const duplicateBody = duplicate.json<AckBody>()
    expect(duplicateBody.duplicate).toBe(true)
    expect(duplicateBody.status).toBe('acked')
    expect(duplicateBody.result).toEqual(result)
    expect(duplicateBody.errorCode).toBeNull()
    expect(duplicateBody.ackedAt).toBe(START)

    const rowAgain = commandRow(t.db, commandId)
    expect(rowAgain.status).toBe('acked')
    expect(rowAgain.acked_at).toBe(START)
    expect(rowAgain.result_json).toBe(JSON.stringify(result))
    expect(rowAgain.error_code).toBeNull()
  })

  it('executionId 与首次领取不一致 → 409，且命令状态不变', async () => {
    const { t, workspaceId, session, device } = await scene()
    const created = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(30 * 60 * 1000),
    })
    const commandId = created.json<RemoteCommandView>().commandId
    await claim(t.app, device.token, { executionId: 'exec-right' })

    const mismatched = await ack(t.app, device.token, commandId, {
      executionId: 'exec-wrong',
      status: 'succeeded',
      result: { ok: true },
    })
    expect(mismatched.statusCode).toBe(409)
    expect(mismatched.json<ErrorBody>().code).toBe('STATE_INVALID_TRANSITION')

    const row = commandRow(t.db, commandId)
    expect(row.status).toBe('claimed')
    expect(row.acked_at).toBeNull()
    expect(row.result_json).toBeNull()
    expect(row.execution_id).toBe('exec-right')
  })

  it('失败回执落 failed + errorCode；别人的命令 403；未领取的命令 409；不存在的命令 404', async () => {
    const { t, workspaceId, session, device } = await scene()
    const other = await pairNewDevice(t.app, session, workspaceId, '另一台设备')

    const created = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'job.cancel',
      args: { jobId: 'job_9' },
      expiresAt: at(30 * 60 * 1000),
    })
    const commandId = created.json<RemoteCommandView>().commandId

    // 不是自己的命令：403（不能变成 404 探测出"这条命令存在"）。
    const foreign = await ack(t.app, other.token, commandId, {
      executionId: 'exec-x',
      status: 'succeeded',
    })
    expect(foreign.statusCode).toBe(403)
    expect(foreign.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
    expect(commandRow(t.db, commandId).status).toBe('pending')

    // 不存在的命令。
    const missing = await ack(t.app, device.token, newIds.request(), {
      executionId: 'exec-x',
      status: 'succeeded',
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<ErrorBody>().code).toBe('NOT_FOUND')

    // 还没领取就回执：状态非法。
    const tooEarly = await ack(t.app, device.token, commandId, {
      executionId: 'exec-x',
      status: 'succeeded',
    })
    expect(tooEarly.statusCode).toBe(409)
    expect(tooEarly.json<ErrorBody>().code).toBe('STATE_INVALID_TRANSITION')

    // 正常路径：领取 → 失败回执。
    await claim(t.app, device.token, { executionId: 'exec-9' })
    const failed = await ack(t.app, device.token, commandId, {
      executionId: 'exec-9',
      status: 'failed',
      errorCode: 'E_WORKFLOW_TIMEOUT',
    })
    expect(failed.statusCode).toBe(200)
    const failedBody = failed.json<AckBody>()
    expect(failedBody.duplicate).toBe(false)
    expect(failedBody.status).toBe('failed')
    expect(failedBody.errorCode).toBe('E_WORKFLOW_TIMEOUT')
    expect(failedBody.ackedAt).toBe(START)

    const row = commandRow(t.db, commandId)
    expect(row.status).toBe('failed')
    expect(row.error_code).toBe('E_WORKFLOW_TIMEOUT')
    expect(row.acked_at).toBe(START)
  })

  it('回执参数校验：status 只能是 succeeded/failed，executionId 必填；路径 commandId 权威', async () => {
    const { t, workspaceId, session, device } = await scene()
    const created = await createCommand(t.app, session, workspaceId, device.deviceId, {
      commandType: 'sync.trigger',
      expiresAt: at(30 * 60 * 1000),
    })
    const commandId = created.json<RemoteCommandView>().commandId
    await claim(t.app, device.token, { executionId: 'exec-1' })

    const badStatus = await ack(t.app, device.token, commandId, {
      executionId: 'exec-1',
      status: 'maybe',
    })
    expect(badStatus.statusCode).toBe(400)
    expect(badStatus.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    const noExecution = await ack(t.app, device.token, commandId, { status: 'succeeded' })
    expect(noExecution.statusCode).toBe(400)
    expect(noExecution.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    // body 里的 commandId 与路径不一致 → 拒绝，不做"二选一"。
    const conflicting = await ack(t.app, device.token, commandId, {
      commandId: newIds.request(),
      executionId: 'exec-1',
      status: 'succeeded',
    })
    expect(conflicting.statusCode).toBe(400)
    expect(conflicting.json<ErrorBody>().code).toBe('VALIDATION_FAILED')

    expect(commandRow(t.db, commandId).status).toBe('claimed')
  })
})
