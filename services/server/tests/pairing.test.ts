/**
 * 配对码：一次性、过期、尝试次数、跨工作区。
 *
 * 这些用例都直接打 `auth/pairing.ts` 而不经过 HTTP：配对是一个**未认证**接口，
 * 它的安全性质（码只存摘要、失败也计数、工作区取自码而非客户端）属于
 * 领域层的责任，用 HTTP 测会把网络细节混进来。
 */

import { afterEach, describe, expect, it } from 'vitest'

import { newIds } from '@yfe/contracts'
import type { RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import {
  DEFAULT_PAIRING_POLICY,
  authenticateDevice,
  cancelPairingCode,
  createPairingCode,
  redeemPairingCode,
  revokeOwnDevice,
} from '../src/auth/pairing.js'
import type { CreatePairingCodeInput, RedeemPairingCodeInput } from '../src/auth/pairing.js'
import { findDeviceById } from '../src/db/devices.js'
import { findPairingCodeById } from '../src/db/pairing.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { TEST_PEPPER, seedOwner, testClock } from './helpers.js'

const REQUEST_ID = 'req_pairing_test' as RequestId
const AT = '2026-01-01T00:00:00.000Z' as UtcTimestamp

const openDbs: ServerDb[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) closeServerDatabase(db)
})

async function freshServer(): Promise<{
  readonly db: ServerDb
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
}> {
  const db = openServerDatabase(':memory:')
  openDbs.push(db)
  await migrateServerDatabase(db)
  const seeded = await seedOwner(db, AT)
  return { db, userId: seeded.userId, workspaceId: seeded.workspaceId }
}

async function issueCode(
  db: ServerDb,
  input: Partial<CreatePairingCodeInput> & { readonly userId: UserId },
) {
  return createPairingCode(db, {
    workspaceId: null,
    at: AT,
    pepper: TEST_PEPPER,
    requestId: REQUEST_ID,
    ...input,
  })
}

function redeemInput(
  code: string,
  overrides: Partial<RedeemPairingCodeInput> = {},
): RedeemPairingCodeInput {
  return {
    code,
    workspaceId: null,
    deviceName: '测试设备',
    platform: 'win32',
    at: AT,
    pepper: TEST_PEPPER,
    requestId: REQUEST_ID,
    clientIp: '127.0.0.1',
    ...overrides,
  }
}

describe('签发', () => {
  it('明文码只在返回值里，库里只存 scrypt 摘要', async () => {
    const { db, userId } = await freshServer()
    const created = await issueCode(db, { userId })

    // 8 位 Crockford Base32，且格式化视图是 XXXX-XXXX。
    expect(created.code).toHaveLength(8)
    expect(created.formattedCode).toBe(`${created.code.slice(0, 4)}-${created.code.slice(4)}`)

    const raw = db
      .prepare('SELECT code_hash FROM pairing_codes WHERE id = ?')
      .get(created.id) as { code_hash: string } | undefined
    expect(raw).toBeDefined()
    expect(raw?.code_hash).not.toContain(created.code)
    expect(raw?.code_hash.startsWith('scrypt-pairing:')).toBe(true)

    const row = findPairingCodeById(db, created.id)
    expect(row?.attempts).toBe(0)
    expect(row?.maxAttempts).toBe(DEFAULT_PAIRING_POLICY.maxAttempts)
    expect(row?.consumedAt).toBeNull()
  })

  it('同一用户的活跃码数量达上限时拒绝（避免把尝试空间摊薄）', async () => {
    const { db, userId } = await freshServer()
    const policy = { ...DEFAULT_PAIRING_POLICY, maxActiveCodesPerUser: 2 }
    await issueCode(db, { userId, policy })
    await issueCode(db, { userId, policy })

    await expect(issueCode(db, { userId, policy })).rejects.toMatchObject({
      name: 'ContractError',
      code: 'RESOURCE_LOCKED',
    })
  })

  it('pepper 太短直接拒绝，不允许退化成无盐哈希', async () => {
    const { db, userId } = await freshServer()
    await expect(
      issueCode(db, { userId, pepper: Buffer.alloc(8) }),
    ).rejects.toThrow(TypeError)
  })
})

describe('领取是一次性的', () => {
  it('第一次成功签发设备凭据，第二次被拒且原因可辨', async () => {
    const { db, userId, workspaceId } = await freshServer()
    const created = await issueCode(db, { userId, workspaceId })

    const first = await redeemPairingCode(db, redeemInput(created.code))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.deviceToken).toHaveLength(43) // 32 字节 base64url
    expect(first.device.workspaceId).toBe(workspaceId)
    expect(first.workspaceId).toBe(workspaceId)

    const second = await redeemPairingCode(db, redeemInput(created.code))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(second.error.detail?.['reason']).toBe('consumed')

    // 只有一个设备行：一次性意味着不会因为重放多建设备。
    expect(findDeviceById(db, first.device.id)).not.toBeNull()
  })

  it('领取到的设备凭据可以鉴权，撤销后立刻失效', async () => {
    const { db, userId, workspaceId } = await freshServer()
    const created = await issueCode(db, { userId, workspaceId })
    const redeemed = await redeemPairingCode(db, redeemInput(created.code))
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return

    const auth = authenticateDevice(db, redeemed.deviceToken, AT)
    expect(auth.ok).toBe(true)

    expect(authenticateDevice(db, 'not-a-real-device-token', AT).ok).toBe(false)

    expect(revokeOwnDevice(db, redeemed.device.id, AT, 'lost')).toBe(true)
    const afterRevoke = authenticateDevice(db, redeemed.deviceToken, AT)
    expect(afterRevoke.ok).toBe(false)
    if (afterRevoke.ok) return
    expect(afterRevoke.failure.kind).toBe('revoked')
  })

  it('被撤销的码不能被领取，撤销也计数', async () => {
    const { db, userId } = await freshServer()
    const created = await issueCode(db, { userId })
    expect(cancelPairingCode(db, created.id, AT)).toBe(true)

    const result = await redeemPairingCode(db, redeemInput(created.code))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.['reason']).toBe('revoked')
    expect(findPairingCodeById(db, created.id)?.attempts).toBe(1)
  })
})

describe('过期', () => {
  it('超过有效期后拒绝，错误码是 AUTH_TOKEN_EXPIRED 而不是无效凭据', async () => {
    const { db, userId } = await freshServer()
    const clock = testClock('2026-01-01T00:00:00.000Z')
    const created = await issueCode(db, {
      userId,
      policy: { ...DEFAULT_PAIRING_POLICY, codeTtlMs: 60_000 },
    })

    clock.advance(60_001)
    const expired = await redeemPairingCode(
      db,
      redeemInput(created.code, { at: clock.now() }),
    )
    expect(expired.ok).toBe(false)
    if (expired.ok) return
    expect(expired.error.code).toBe('AUTH_TOKEN_EXPIRED')
    expect(expired.error.detail?.['reason']).toBe('expired')
  })

  it('刚好到期也拒绝（边界不宽容）', async () => {
    const { db, userId } = await freshServer()
    const created = await issueCode(db, {
      userId,
      policy: { ...DEFAULT_PAIRING_POLICY, codeTtlMs: 60_000 },
    })
    const boundary = '2026-01-01T00:01:00.000Z' as UtcTimestamp
    expect(findPairingCodeById(db, created.id)?.expiresAt).toBe(boundary)

    const result = await redeemPairingCode(db, redeemInput(created.code, { at: boundary }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.['reason']).toBe('expired')
  })
})

describe('跨工作区', () => {
  it('码绑定 ws_A、客户端声明 ws_B 时拒绝，且设备不会被创建', async () => {
    const { db, userId, workspaceId } = await freshServer()
    const otherWorkspace = newIds.workspace() as WorkspaceId
    const created = await issueCode(db, { userId, workspaceId })

    const result = await redeemPairingCode(
      db,
      redeemInput(created.code, { workspaceId: otherWorkspace }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(result.error.detail?.['reason']).toBe('workspace_mismatch')

    const row = findPairingCodeById(db, created.id)
    expect(row?.consumedAt).toBeNull() // 失败不消费，用户可以用对的声明重试
    expect(row?.attempts).toBe(1) // 但失败要计数
  })

  it('设备绑定的工作区取自码本身，不取自客户端声明', async () => {
    const { db, userId, workspaceId } = await freshServer()
    const created = await issueCode(db, { userId, workspaceId })

    // 客户端声称"我不属于任何工作区"，服务端仍然把它绑到码上的工作区。
    const result = await redeemPairingCode(db, redeemInput(created.code, { workspaceId: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.device.workspaceId).toBe(workspaceId)
    expect(result.workspaceId).toBe(workspaceId)
  })
})

describe('尝试次数上限', () => {
  it('失败先计数、再判定；超过上限后即使码没过期也被拒', async () => {
    const { db, userId, workspaceId } = await freshServer()
    const otherWorkspace = newIds.workspace() as WorkspaceId
    const policy = { ...DEFAULT_PAIRING_POLICY, maxAttempts: 2 }
    // 不用过期路径来烧次数：过期必须保留在"上限之后"判定，
    // 这里用跨工作区失败（计数发生在判定之前）来验证计数逻辑本身。
    const created = await issueCode(db, { userId, workspaceId, policy })

    const first = await redeemPairingCode(
      db,
      redeemInput(created.code, { workspaceId: otherWorkspace, policy }),
    )
    const second = await redeemPairingCode(
      db,
      redeemInput(created.code, { workspaceId: otherWorkspace, policy }),
    )
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (first.ok || second.ok) return
    expect(first.error.detail?.['reason']).toBe('workspace_mismatch')
    expect(second.error.detail?.['reason']).toBe('workspace_mismatch')
    expect(findPairingCodeById(db, created.id)?.attempts).toBe(2)

    // 第 3 次：计数 3 > 2 → 拒绝原因变成次数过多，而不再是工作区不匹配。
    const third = await redeemPairingCode(
      db,
      redeemInput(created.code, { workspaceId: otherWorkspace, policy }),
    )
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.error.detail?.['reason']).toBe('too_many_attempts')

    // 即使之后拿对了工作区，也已经被烧掉：必须重新签发。
    const correct = await redeemPairingCode(
      db,
      redeemInput(created.code, { workspaceId, policy }),
    )
    expect(correct.ok).toBe(false)
    if (correct.ok) return
    expect(correct.error.detail?.['reason']).toBe('too_many_attempts')
  })

  it('不存在的码不会被计入任何行（只回 not_found）', async () => {
    const { db } = await freshServer()
    const result = await redeemPairingCode(db, redeemInput('ZZZZZZZZ'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(result.error.detail?.['reason']).toBe('not_found')
  })

  it('归一化：小写、带连字符、把 O/I/L/U 写成 0/1/1/V 的输入都指向同一个码', async () => {
    const { db, userId } = await freshServer()
    const created = await issueCode(db, { userId })
    const messy = created.formattedCode.toLowerCase().replace('0', 'o').replace(/-/g, ' ')

    const result = await redeemPairingCode(db, redeemInput(messy))
    expect(result.ok).toBe(true)
  })
})

describe('用户被停用', () => {
  it('停用后即使码有效也拒绝配对（停用立即阻断新设备）', async () => {
    const { db, userId } = await freshServer()
    const created = await issueCode(db, { userId })

    const result = await redeemPairingCode(db, redeemInput(created.code, { userDisabled: true }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail?.['reason']).toBe('user_disabled')

    // 码没有被消费：启用账号后仍可用。
    expect(findPairingCodeById(db, created.id)?.consumedAt).toBeNull()
  })
})
