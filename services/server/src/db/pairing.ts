/**
 * 配对码仓储。
 *
 * 设计依据（`04-后端与安全.md`）：配对码**短期、一次性、限定用户/工作区**；
 * 领取后签发独立 deviceId 与凭据。
 *
 * 🔴 一次性与尝试次数都用**条件更新**实现，而不是"先查再写"：
 * 两个并发的领取请求如果先各自读到 `consumed_at IS NULL`，就会双双通过检查、
 * 双双签发设备凭据——一次性直接失效。`WHERE consumed_at IS NULL` 让数据库
 * 决定谁赢（`changes` 为 1 的那个），这是唯一在并发下正确的写法。
 *
 * 🔴 `code_hash` 存**摘要**，不存明文配对码：配对码本身就是短期凭据，
 * 明文落库意味着任何能读库文件的人都能直接领取设备。
 * 因为码空间小（人工输入），一律用 `../auth/secrets.js` 的
 * `hashPairingCode()`（带服务端侧固定盐的慢哈希），而不是裸 SHA-256——
 * 裸 SHA-256 对 6~8 位数字码是可以瞬间枚举的。
 */

import type { DeviceId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

export interface PairingCodeRow {
  readonly id: string
  readonly userId: UserId
  readonly workspaceId: WorkspaceId | null
  readonly createdAt: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly maxAttempts: number
  readonly attempts: number
  readonly consumedAt: UtcTimestamp | null
  readonly consumedDeviceId: DeviceId | null
  readonly revokedAt: UtcTimestamp | null
}

interface RawPairingCodeRow {
  readonly id: string
  readonly code_hash: string
  readonly user_id: string
  readonly workspace_id: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly max_attempts: number
  readonly attempts: number
  readonly consumed_at: string | null
  readonly consumed_device_id: string | null
  readonly revoked_at: string | null
}

function toPairingCode(raw: RawPairingCodeRow): PairingCodeRow {
  return {
    id: raw.id,
    userId: raw.user_id as UserId,
    workspaceId: raw.workspace_id as WorkspaceId | null,
    createdAt: raw.created_at as UtcTimestamp,
    expiresAt: raw.expires_at as UtcTimestamp,
    maxAttempts: raw.max_attempts,
    attempts: raw.attempts,
    consumedAt: raw.consumed_at as UtcTimestamp | null,
    consumedDeviceId: raw.consumed_device_id as DeviceId | null,
    revokedAt: raw.revoked_at as UtcTimestamp | null,
  }
}

const PAIRING_COLUMNS = `id, code_hash, user_id, workspace_id, created_at, expires_at,
  max_attempts, attempts, consumed_at, consumed_device_id, revoked_at`

export interface InsertPairingCodeInput {
  readonly id: string
  readonly codeHash: string
  readonly userId: UserId
  readonly workspaceId: WorkspaceId | null
  readonly at: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly maxAttempts: number
}

export function insertPairingCode(db: ServerDb, input: InsertPairingCodeInput): void {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.pairingCodes}
       (id, code_hash, user_id, workspace_id, created_at, expires_at, max_attempts, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    input.id,
    input.codeHash,
    input.userId,
    input.workspaceId,
    input.at,
    input.expiresAt,
    input.maxAttempts,
  )
}

export function findPairingCodeByHash(db: ServerDb, codeHash: string): PairingCodeRow | null {
  const raw = db
    .prepare(
      `SELECT ${PAIRING_COLUMNS} FROM ${SERVER_TABLES.pairingCodes} WHERE code_hash = ?`,
    )
    .get(codeHash) as RawPairingCodeRow | undefined
  return raw === undefined ? null : toPairingCode(raw)
}

export function findPairingCodeById(db: ServerDb, id: string): PairingCodeRow | null {
  const raw = db
    .prepare(`SELECT ${PAIRING_COLUMNS} FROM ${SERVER_TABLES.pairingCodes} WHERE id = ?`)
    .get(id) as RawPairingCodeRow | undefined
  return raw === undefined ? null : toPairingCode(raw)
}

/**
 * 记一次失败尝试。**先于**任何"是否有效"的判定执行。
 *
 * 🔴 为什么失败也要计数、且必须在判定之前自增：如果不计数，攻击者可以对着
 * 一个已过期的码无限重试（服务端每次都走"过期"分支），或者对着有效码做
 * 在线爆破而服务端从不设限。计数与判定同一个事务，`changes === 1` 才继续。
 *
 * 返回自增后的次数；`null` 表示行不存在。
 */
export function recordPairingAttempt(db: ServerDb, id: string): number | null {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.pairingCodes}
          SET attempts = attempts + 1
        WHERE id = ?`,
    )
    .run(id)
  if (info.changes !== 1) return null
  const row = db
    .prepare(`SELECT attempts FROM ${SERVER_TABLES.pairingCodes} WHERE id = ?`)
    .get(id) as { attempts: number } | undefined
  return row === undefined ? null : row.attempts
}

/**
 * **原子消费**配对码，同时绑定领取到的设备。
 *
 * 三个条件缺一不可：
 * - `consumed_at IS NULL` → 一次性；
 * - `revoked_at IS NULL`  → 管理员撤销后立即失效；
 * - `attempts < max_attempts` → 次数上限在数据库层也强制一遍，
 *   避免应用层判定与写入之间的竞态。
 *
 * 时间窗口（`expires_at`）**不放在 WHERE 里**：过期时刻由应用层用注入时钟判定，
 * 因为 SQLite 里的时间字符串比较虽然可行，但一旦格式不一致（例如带 `Z` 与不带）
 * 就会静默判错；用注入时钟能让测试确定性地复现过期路径。
 */
export function consumePairingCode(
  db: ServerDb,
  id: string,
  deviceId: DeviceId,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.pairingCodes}
          SET consumed_at = ?, consumed_device_id = ?
        WHERE id = ?
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND attempts <= max_attempts`,
    )
    .run(at, deviceId, id)
  return info.changes === 1
}

/** 撤销未使用的配对码。用户停用、成员被移出工作区时调用。 */
export function revokePairingCode(db: ServerDb, id: string, at: UtcTimestamp): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.pairingCodes}
          SET revoked_at = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(at, id)
  return info.changes === 1
}

/** 撤销某用户的全部未使用配对码（停用账号时调用）。 */
export function revokeAllPairingCodesForUser(
  db: ServerDb,
  userId: UserId,
  at: UtcTimestamp,
): number {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.pairingCodes}
          SET revoked_at = ?
        WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
    )
    .run(at, userId)
  return info.changes
}

export function listPairingCodesForUser(
  db: ServerDb,
  userId: UserId,
): readonly PairingCodeRow[] {
  const rows = db
    .prepare(
      `SELECT ${PAIRING_COLUMNS} FROM ${SERVER_TABLES.pairingCodes}
        WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as RawPairingCodeRow[]
  return rows.map(toPairingCode)
}

/**
 * 清理已经过期且未被消费的配对码。
 *
 * 只删"未消费"的：已消费的行是审计证据（哪个码领了哪台设备），不能清。
 */
export function purgeExpiredPairingCodes(db: ServerDb, now: UtcTimestamp): number {
  const info = db
    .prepare(
      `DELETE FROM ${SERVER_TABLES.pairingCodes}
        WHERE expires_at <= ? AND consumed_at IS NULL`,
    )
    .run(now)
  return info.changes
}
