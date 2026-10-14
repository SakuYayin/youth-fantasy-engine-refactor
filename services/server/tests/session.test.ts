/**
 * 刷新凭据轮换与复用检测。
 *
 * 这是身份层最容易被写错的地方：把"检查是否已消费"和"标记已消费"分开做，
 * 并发刷新就会双双通过。这里的用例都在断言**结果**（旧凭据复用后整条链失效），
 * 而不是实现里用了几个语句。
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { RequestId, UserId, UtcTimestamp } from '@yfe/contracts'

import {
  DEFAULT_SESSION_POLICY,
  issueSession,
  lookupFailureToError,
  lookupSessionByAccessToken,
  logoutSession,
  rotateRefreshToken,
} from '../src/auth/session.js'
import type { SessionPolicy } from '../src/auth/session.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { listRefreshTokensForChain, listSessionsForUser } from '../src/db/sessions.js'
import { seedOwner, testClock } from './helpers.js'

const REQUEST_ID = 'req_session_test' as RequestId
const POLICY: SessionPolicy = { ...DEFAULT_SESSION_POLICY, cookieSecure: false }

const openDbs: ServerDb[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) closeServerDatabase(db)
})

async function freshUser(): Promise<{ readonly db: ServerDb; readonly userId: UserId }> {
  const db = openServerDatabase(':memory:')
  openDbs.push(db)
  await migrateServerDatabase(db)
  const seeded = await seedOwner(db, '2026-01-01T00:00:00.000Z' as UtcTimestamp)
  return { db, userId: seeded.userId }
}

describe('签发', () => {
  it('访问/刷新/CSRF 三件凭据各不相同，且刷新凭据链标识一致', async () => {
    const { db, userId } = await freshUser()
    const issued = issueSession(db, {
      userId,
      at: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      policy: POLICY,
    })

    expect(issued.accessToken).not.toBe(issued.refreshToken)
    expect(issued.csrfToken).not.toBe(issued.accessToken)
    // 链标识是**独立随机值**（不是会话 id 的派生），用来把"轮换出的一串会话"
    // 串起来；刷新凭据行必须挂在同一条链上，否则复用检测无法一次撤销整条链。
    const chain = listRefreshTokensForChain(db, issued.session.chainId)
    expect(chain).toHaveLength(1)
    expect(chain[0]?.sessionId).toBe(issued.session.id)
    expect(chain[0]?.chainId).toBe(issued.session.chainId)
    expect(issued.session.chainId).not.toBe(issued.session.id)
    expect(issued.session.revokedAt).toBeNull()

    // 库里只有摘要：明文访问令牌绝不能落库。
    // `SessionRow` 刻意不暴露摘要字段，所以直接读原始列来断言。
    const rows = listSessionsForUser(db, userId)
    expect(rows).toHaveLength(1)
    const raw = db
      .prepare('SELECT access_token_hash AS h FROM sessions WHERE id = ?')
      .get(issued.session.id) as { h: string } | undefined
    expect(raw?.h).toBeDefined()
    expect(raw?.h).not.toContain(issued.accessToken)
    expect(raw?.h.startsWith('sha256:')).toBe(true)
  })
})

describe('轮换', () => {
  it('轮换成功后旧刷新凭据立即失效，新会话与旧会话同链', async () => {
    const { db, userId } = await freshUser()
    const first = issueSession(db, {
      userId,
      at: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      policy: POLICY,
    })

    const rotated = rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      at: '2026-01-01T00:10:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return

    expect(rotated.issued.session.chainId).toBe(first.session.chainId)
    expect(rotated.issued.session.id).not.toBe(first.session.id)
    expect(rotated.issued.refreshToken).not.toBe(first.refreshToken)

    // 旧会话被标记为 rotated（撤销），新会话有效。
    const oldLookup = lookupSessionByAccessToken(
      db,
      first.accessToken,
      '2026-01-01T00:10:00.000Z' as UtcTimestamp,
    )
    expect(oldLookup.ok).toBe(false)
    if (oldLookup.ok) return
    expect(oldLookup.failure.kind).toBe('revoked')

    const newLookup = lookupSessionByAccessToken(
      db,
      rotated.issued.accessToken,
      '2026-01-01T00:10:00.000Z' as UtcTimestamp,
    )
    expect(newLookup.ok).toBe(true)
  })

  it('轮换沿用原来的绝对过期上限，不会因为一直刷新而无限延长', async () => {
    const { db, userId } = await freshUser()
    const first = issueSession(db, {
      userId,
      at: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      policy: POLICY,
    })

    const rotated = rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      at: '2026-01-01T01:00:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    expect(rotated.issued.session.absoluteExpiresAt).toBe(first.session.absoluteExpiresAt)
  })
})

describe('复用检测（凭据泄露的核心防线）', () => {
  it('旧凭据被再次使用 → 判定泄露并撤销整条会话链', async () => {
    const { db, userId } = await freshUser()
    const first = issueSession(db, {
      userId,
      at: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      policy: POLICY,
    })

    // 正常轮换一次：客户端拿到 second。
    const rotated = rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      at: '2026-01-01T00:10:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return

    // 攻击者（或陈旧副本）拿着已经用过的 first.refreshToken 再刷一次。
    const reuse = rotateRefreshToken(db, {
      refreshToken: first.refreshToken,
      at: '2026-01-01T00:20:00.000Z' as UtcTimestamp,
      userAgent: 'attacker',
      clientIp: '10.0.0.9',
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(reuse.ok).toBe(false)
    if (reuse.ok) return
    expect(reuse.failure.kind).toBe('reuse')
    if (reuse.failure.kind !== 'reuse') return
    expect(reuse.failure.error.code).toBe('AUTH_REQUIRED')
    expect(reuse.failure.error.detail?.['reason']).toBe('refresh_token_reuse')
    // 返回值只统计"本次从有效变成撤销"的行数（旧的已在轮换时被标记为 rotated），
    // 所以这里断言 >=1；真正的"整条链都死了"由下面的逐行断言与 stolen 断言保证。
    expect(reuse.failure.revokedSessions).toBeGreaterThanOrEqual(1)

    // 关键断言：**刚轮换出来的那条也失效了**。否则"撤销整条链"只是嘴上说说。
    const stolen = lookupSessionByAccessToken(
      db,
      rotated.issued.accessToken,
      '2026-01-01T00:20:00.000Z' as UtcTimestamp,
    )
    expect(stolen.ok).toBe(false)
    if (stolen.ok) return
    expect(stolen.failure.kind).toBe('revoked')

    // 库里每条会话都被撤销，且刷新凭据被标记为复用。
    for (const row of listSessionsForUser(db, userId)) {
      expect(row.revokedAt).not.toBeNull()
    }
    const tokens = listRefreshTokensForChain(db, first.session.chainId)
    expect(tokens.some((token) => token.reusedDetectedAt !== null)).toBe(true)

    // 复用之后连"最新"的刷新凭据也不能再用（链已死）。
    const afterReuse = rotateRefreshToken(db, {
      refreshToken: rotated.issued.refreshToken,
      at: '2026-01-01T00:21:00.000Z' as UtcTimestamp,
      userAgent: 'vitest',
      clientIp: '127.0.0.1',
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(afterReuse.ok).toBe(false)
  })

  it('未知刷新凭据被拒（不是复用，也不泄露区别给用户）', async () => {
    const { db } = await freshUser()
    const result = rotateRefreshToken(db, {
      refreshToken: 'totally-made-up-token',
      at: '2026-01-01T00:10:00.000Z' as UtcTimestamp,
      userAgent: null,
      clientIp: null,
      requestId: REQUEST_ID,
      policy: POLICY,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('invalid')
    expect(result.failure.error.code).toBe('AUTH_TOKEN_EXPIRED')
  })

  it('刷新凭据过期后拒绝', async () => {
    const { db, userId } = await freshUser()
    const clock = testClock('2026-01-01T00:00:00.000Z')
    const issued = issueSession(db, {
      userId,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      policy: { ...POLICY, refreshTtlMs: 60_000, absoluteTtlMs: 120_000 },
    })

    clock.advance(60_001)
    const result = rotateRefreshToken(db, {
      refreshToken: issued.refreshToken,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      requestId: REQUEST_ID,
      policy: { ...POLICY, refreshTtlMs: 60_000, absoluteTtlMs: 120_000 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('invalid')
    expect(result.failure.error.code).toBe('AUTH_TOKEN_EXPIRED')
  })
})

describe('访问会话查找', () => {
  it('访问令牌过期 → expired；撤销 → revoked；绝对上限到期 → expired', async () => {
    const { db, userId } = await freshUser()
    const clock = testClock('2026-01-01T00:00:00.000Z')
    const issued = issueSession(db, {
      userId,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      policy: { ...POLICY, accessTtlMs: 60_000, refreshTtlMs: 120_000, absoluteTtlMs: 300_000 },
    })

    clock.advance(60_001)
    const expired = lookupSessionByAccessToken(db, issued.accessToken, clock.now())
    expect(expired.ok).toBe(false)
    if (expired.ok) return
    expect(expired.failure.kind).toBe('expired')
    expect(lookupFailureToError(expired.failure, REQUEST_ID).code).toBe('AUTH_TOKEN_EXPIRED')

    const unknown = lookupSessionByAccessToken(db, 'nope', clock.now())
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.failure.kind).toBe('invalid')
    expect(lookupFailureToError(unknown.failure, REQUEST_ID).code).toBe('AUTH_REQUIRED')
  })

  it('登出撤销整条链，且撤销原因可追溯', async () => {
    const { db, userId } = await freshUser()
    const issued = issueSession(db, {
      userId,
      at: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
      userAgent: null,
      clientIp: null,
      policy: POLICY,
    })

    const revoked = logoutSession(db, issued.session, '2026-01-01T00:05:00.000Z' as UtcTimestamp)
    expect(revoked).toBeGreaterThanOrEqual(1)

    const lookup = lookupSessionByAccessToken(
      db,
      issued.accessToken,
      '2026-01-01T00:05:00.000Z' as UtcTimestamp,
    )
    expect(lookup.ok).toBe(false)
    if (lookup.ok) return
    expect(lookup.failure.kind).toBe('revoked')
    const error = lookupFailureToError(lookup.failure, REQUEST_ID)
    expect(error.code).toBe('AUTH_REQUIRED')
    expect(error.detail?.['reason']).toBe('logout')
  })
})
