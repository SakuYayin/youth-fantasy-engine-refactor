/**
 * 会话与刷新凭据仓储。
 *
 * 设计依据（`04-后端与安全.md`）：Web 管理端用 HttpOnly+Secure+SameSite 会话 Cookie
 * 与 CSRF 校验；**服务器只保存刷新凭据的摘要**；轮换与重复使用检测必须在**同一事务**内完成。
 *
 * 🔴 本文件只负责持久化与"原子条件更新"，不含任何策略判定：
 * - 过期与否由注入时钟判定，**不用 SQLite 的 `datetime('now')`**——
 *   否则测试无法用固定时钟复现"过期"与"复用"两条路径，而且服务器时钟与数据库
 *   时钟在过去/未来不一致时会出现难以复现的判定漂移。
 * - 事务边界由 `../auth/session.js` 划定，本文件提供事务内可直接调用的原子原语。
 *
 * 🔴 `access_token_hash` / `token_hash` 存的是凭据的 SHA-256 摘要，**绝不存明文**。
 * 明文凭据只在签发的那个响应里出现一次，之后任何读路径（包括数据库文件本身被盗）
 * 都拿不回它。
 */

import type { UserId, UtcTimestamp } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

/** 会话行（不含任何明文凭据）。 */
export interface SessionRow {
  readonly id: string
  readonly userId: UserId
  readonly chainId: string
  /**
   * CSRF 校验材料。
   *
   * 它**不是凭据**：泄漏它不能代替会话认证（仍然需要 HttpOnly 的会话 Cookie），
   * 它只用来证明"发起请求的页面能读到本站的 Cookie"，即抵御跨站表单提交。
   */
  readonly csrfSecret: string
  readonly createdAt: UtcTimestamp
  readonly lastUsedAt: UtcTimestamp
  readonly accessExpiresAt: UtcTimestamp
  readonly refreshExpiresAt: UtcTimestamp
  /** 整条会话链的绝对上限：无论怎么轮换都不能越过它。 */
  readonly absoluteExpiresAt: UtcTimestamp
  readonly revokedAt: UtcTimestamp | null
  readonly revokeReason: string | null
  readonly userAgent: string | null
  readonly clientIp: string | null
}

export interface RefreshTokenRow {
  readonly tokenHash: string
  readonly sessionId: string
  readonly chainId: string
  readonly issuedAt: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly consumedAt: UtcTimestamp | null
  /** 轮换后的新凭据摘要。非空表示"这一份已经被换走了"。 */
  readonly replacedByHash: string | null
  /** 检测到复用（在已消费之后又被送来）时置位。 */
  readonly reusedDetectedAt: UtcTimestamp | null
}

interface RawSessionRow {
  readonly id: string
  readonly user_id: string
  readonly chain_id: string
  readonly csrf_secret: string
  readonly created_at: string
  readonly last_used_at: string
  readonly access_expires_at: string
  readonly refresh_expires_at: string
  readonly absolute_expires_at: string
  readonly revoked_at: string | null
  readonly revoke_reason: string | null
  readonly user_agent: string | null
  readonly client_ip: string | null
}

interface RawRefreshTokenRow {
  readonly token_hash: string
  readonly session_id: string
  readonly chain_id: string
  readonly issued_at: string
  readonly expires_at: string
  readonly consumed_at: string | null
  readonly replaced_by_hash: string | null
  readonly reused_detected_at: string | null
}

function toSession(raw: RawSessionRow): SessionRow {
  return {
    id: raw.id,
    userId: raw.user_id as UserId,
    chainId: raw.chain_id,
    csrfSecret: raw.csrf_secret,
    createdAt: raw.created_at as UtcTimestamp,
    lastUsedAt: raw.last_used_at as UtcTimestamp,
    accessExpiresAt: raw.access_expires_at as UtcTimestamp,
    refreshExpiresAt: raw.refresh_expires_at as UtcTimestamp,
    absoluteExpiresAt: raw.absolute_expires_at as UtcTimestamp,
    revokedAt: raw.revoked_at as UtcTimestamp | null,
    revokeReason: raw.revoke_reason,
    userAgent: raw.user_agent,
    clientIp: raw.client_ip,
  }
}

function toRefreshToken(raw: RawRefreshTokenRow): RefreshTokenRow {
  return {
    tokenHash: raw.token_hash,
    sessionId: raw.session_id,
    chainId: raw.chain_id,
    issuedAt: raw.issued_at as UtcTimestamp,
    expiresAt: raw.expires_at as UtcTimestamp,
    consumedAt: raw.consumed_at as UtcTimestamp | null,
    replacedByHash: raw.replaced_by_hash,
    reusedDetectedAt: raw.reused_detected_at as UtcTimestamp | null,
  }
}

const SESSION_COLUMNS = `id, user_id, chain_id, csrf_secret, created_at, last_used_at,
  access_expires_at, refresh_expires_at, absolute_expires_at, revoked_at, revoke_reason,
  user_agent, client_ip`

const REFRESH_COLUMNS = `token_hash, session_id, chain_id, issued_at, expires_at,
  consumed_at, replaced_by_hash, reused_detected_at`

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface InsertSessionInput {
  readonly id: string
  readonly userId: UserId
  readonly chainId: string
  readonly accessTokenHash: string
  readonly csrfSecret: string
  readonly at: UtcTimestamp
  readonly accessExpiresAt: UtcTimestamp
  readonly refreshExpiresAt: UtcTimestamp
  readonly absoluteExpiresAt: UtcTimestamp
  readonly userAgent: string | null
  readonly clientIp: string | null
}

export function insertSession(db: ServerDb, input: InsertSessionInput): void {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.sessions}
       (id, user_id, chain_id, access_token_hash, csrf_secret, created_at, last_used_at,
        access_expires_at, refresh_expires_at, absolute_expires_at, user_agent, client_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.chainId,
    input.accessTokenHash,
    input.csrfSecret,
    input.at,
    input.at,
    input.accessExpiresAt,
    input.refreshExpiresAt,
    input.absoluteExpiresAt,
    input.userAgent,
    input.clientIp,
  )
}

export function findSessionById(db: ServerDb, id: string): SessionRow | null {
  const raw = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM ${SERVER_TABLES.sessions} WHERE id = ?`)
    .get(id) as RawSessionRow | undefined
  return raw === undefined ? null : toSession(raw)
}

/**
 * 按访问令牌摘要查会话。这是每个 HTTP 请求的热路径。
 *
 * `access_token_hash` 上有 UNIQUE 索引，所以是索引点查而不是扫描。
 */
export function findSessionByAccessTokenHash(db: ServerDb, hash: string): SessionRow | null {
  const raw = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM ${SERVER_TABLES.sessions} WHERE access_token_hash = ?`)
    .get(hash) as RawSessionRow | undefined
  return raw === undefined ? null : toSession(raw)
}

/** 更新最近使用时间。用于"会话列表"展示与空闲超时，**不参与任何鉴权判定**。 */
export function touchSession(db: ServerDb, id: string, at: UtcTimestamp): void {
  db.prepare(`UPDATE ${SERVER_TABLES.sessions} SET last_used_at = ? WHERE id = ?`).run(at, id)
}

/** 撤销单个会话。返回是否确实改动了行（`false` 表示它本来已撤销或不存在）。 */
export function revokeSession(db: ServerDb, id: string, at: UtcTimestamp, reason: string): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.sessions}
          SET revoked_at = ?, revoke_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(at, reason, id)
  return info.changes === 1
}

/**
 * 撤销整条会话链（**复用检测的处置动作**）。
 *
 * 🔴 为什么是整条链而不是"出问题的那一个会话"：刷新凭据复用的两种可能——
 * (a) 攻击者偷到了旧凭据，(b) 合法客户端重放了。两者都无法从服务端区分，
 * 而把 (a) 当成 (b) 放过去的代价是攻击者继续持有有效会话。
 * 撤销整条链让双方都回到"重新登录"，是把不可判定问题变成安全失败的标准做法。
 */
export function revokeSessionChain(
  db: ServerDb,
  chainId: string,
  at: UtcTimestamp,
  reason: string,
): number {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.sessions}
          SET revoked_at = ?, revoke_reason = ?
        WHERE chain_id = ? AND revoked_at IS NULL`,
    )
    .run(at, reason, chainId)
  return info.changes
}

/** 撤销某用户的全部会话（停用账号、改密码时调用）。 */
export function revokeAllUserSessions(
  db: ServerDb,
  userId: UserId,
  at: UtcTimestamp,
  reason: string,
): number {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.sessions}
          SET revoked_at = ?, revoke_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(at, reason, userId)
  return info.changes
}

export function listSessionsForUser(db: ServerDb, userId: UserId): readonly SessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM ${SERVER_TABLES.sessions}
        WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as RawSessionRow[]
  return rows.map(toSession)
}

// ---------------------------------------------------------------------------
// 刷新凭据
// ---------------------------------------------------------------------------

export interface InsertRefreshTokenInput {
  readonly tokenHash: string
  readonly sessionId: string
  readonly chainId: string
  readonly at: UtcTimestamp
  readonly expiresAt: UtcTimestamp
}

export function insertRefreshToken(db: ServerDb, input: InsertRefreshTokenInput): void {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.refreshTokens}
       (token_hash, session_id, chain_id, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.tokenHash, input.sessionId, input.chainId, input.at, input.expiresAt)
}

export function findRefreshToken(db: ServerDb, tokenHash: string): RefreshTokenRow | null {
  const raw = db
    .prepare(`SELECT ${REFRESH_COLUMNS} FROM ${SERVER_TABLES.refreshTokens} WHERE token_hash = ?`)
    .get(tokenHash) as RawRefreshTokenRow | undefined
  return raw === undefined ? null : toRefreshToken(raw)
}

/**
 * **原子消费**一份刷新凭据。这是轮换正确性的核心。
 *
 * `WHERE ... AND consumed_at IS NULL` 让"消费"变成一次条件更新：
 * - 返回 `true`  → 本次调用是唯一赢家，可以继续签发新凭据；
 * - 返回 `false` → 它已经被消费过（或不存在）→ 调用方必须走复用检测分支。
 *
 * 用条件更新而不是"先 SELECT 判断再 UPDATE"：后者在并发下两个请求都会读到
 * `consumed_at IS NULL`，然后双双签发新凭据，一次刷新变成两条并行会话链。
 */
export function consumeRefreshToken(
  db: ServerDb,
  tokenHash: string,
  at: UtcTimestamp,
  replacedByHash: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.refreshTokens}
          SET consumed_at = ?, replaced_by_hash = ?
        WHERE token_hash = ? AND consumed_at IS NULL`,
    )
    .run(at, replacedByHash, tokenHash)
  return info.changes === 1
}

/** 标记"检测到复用"。仅状态记录，撤销动作由 `revokeSessionChain` 完成。 */
export function markRefreshTokenReused(
  db: ServerDb,
  tokenHash: string,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.refreshTokens}
          SET reused_detected_at = ?
        WHERE token_hash = ? AND reused_detected_at IS NULL`,
    )
    .run(at, tokenHash)
  return info.changes === 1
}

export function listRefreshTokensForChain(db: ServerDb, chainId: string): readonly RefreshTokenRow[] {
  const rows = db
    .prepare(
      `SELECT ${REFRESH_COLUMNS} FROM ${SERVER_TABLES.refreshTokens}
        WHERE chain_id = ? ORDER BY issued_at`,
    )
    .all(chainId) as RawRefreshTokenRow[]
  return rows.map(toRefreshToken)
}

/**
 * 清理已过期且未被消费的刷新凭据。
 *
 * 🔴 只删除**已过期**的行：未过期但已消费的行必须保留，因为它们是复用检测的证据——
 * 删掉之后旧的刷新凭据再来就变成"查无此凭据"，我们就无法区分
 * "凭据是伪造的"和"凭据是偷来的旧凭据"，也就无法触发整链撤销。
 */
export function purgeExpiredRefreshTokens(db: ServerDb, now: UtcTimestamp): number {
  const info = db
    .prepare(`DELETE FROM ${SERVER_TABLES.refreshTokens} WHERE expires_at <= ?`)
    .run(now)
  return info.changes
}

/** 清理早已过期且未撤销的会话行，避免表无限增长。保留期由调用方给。 */
export function purgeStaleSessions(db: ServerDb, before: UtcTimestamp): number {
  const info = db
    .prepare(`DELETE FROM ${SERVER_TABLES.sessions} WHERE absolute_expires_at <= ?`)
    .run(before)
  return info.changes
}
