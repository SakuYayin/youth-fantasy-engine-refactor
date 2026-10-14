/**
 * 设备仓储。
 *
 * 设计依据（`04-后端与安全.md`）：配对码领取后签发**独立 deviceId 与凭据**；
 * 支持重命名、最后活动、撤销、重新配对；**撤销的设备不能继续上传**。
 *
 * 🔴 `token_hash` 是设备凭据的 SHA-256 摘要，明文只在配对响应里出现一次。
 * 🔴 `revoked_at` 一置位即刻生效：鉴权路径每次请求都回表查这一列，
 *    绝不把"设备已授权"缓存进内存或会话——否则撤销要等到缓存过期才生效。
 */

import type { DeviceId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

export interface DeviceRow {
  readonly id: DeviceId
  readonly userId: UserId
  /** 设备被授权的工作区范围；`null` 表示不限工作区（个人设备）。 */
  readonly workspaceId: WorkspaceId | null
  readonly name: string
  readonly platform: string | null
  readonly pairingCodeId: string | null
  readonly createdAt: UtcTimestamp
  readonly lastSeenAt: UtcTimestamp | null
  readonly revokedAt: UtcTimestamp | null
  readonly revokedReason: string | null
}

/** 仅鉴权路径使用：带凭据摘要。**不要**把这个结构体返回给 HTTP 层。 */
export interface DeviceWithCredential extends DeviceRow {
  readonly tokenHash: string
}

interface RawDeviceRow {
  readonly id: string
  readonly user_id: string
  readonly workspace_id: string | null
  readonly name: string
  readonly platform: string | null
  readonly pairing_code_id: string | null
  readonly created_at: string
  readonly last_seen_at: string | null
  readonly revoked_at: string | null
  readonly revoked_reason: string | null
}

interface RawDeviceCredentialRow extends RawDeviceRow {
  readonly token_hash: string
}

function toDevice(raw: RawDeviceRow): DeviceRow {
  return {
    id: raw.id as DeviceId,
    userId: raw.user_id as UserId,
    workspaceId: raw.workspace_id as WorkspaceId | null,
    name: raw.name,
    platform: raw.platform,
    pairingCodeId: raw.pairing_code_id,
    createdAt: raw.created_at as UtcTimestamp,
    lastSeenAt: raw.last_seen_at as UtcTimestamp | null,
    revokedAt: raw.revoked_at as UtcTimestamp | null,
    revokedReason: raw.revoked_reason,
  }
}

const DEVICE_COLUMNS = `id, user_id, workspace_id, name, platform, pairing_code_id,
  created_at, last_seen_at, revoked_at, revoked_reason`

export function findDeviceById(db: ServerDb, id: DeviceId): DeviceRow | null {
  const raw = db
    .prepare(`SELECT ${DEVICE_COLUMNS} FROM ${SERVER_TABLES.devices} WHERE id = ?`)
    .get(id) as RawDeviceRow | undefined
  return raw === undefined ? null : toDevice(raw)
}

/**
 * 按设备凭据摘要查设备。每个携带 `Authorization: Bearer <deviceToken>` 的请求都走这里。
 *
 * 返回**包含 `revoked_at` 的行**而不是"只查未撤销的"：
 * 调用方需要区分 `AUTH_DEVICE_REVOKED`（明确的"你被撤销了，请重新配对"）
 * 与 `AUTH_REQUIRED`（"凭据无效"）。这两者对客户端是完全不同的处理路径。
 */
export function findDeviceByTokenHash(db: ServerDb, tokenHash: string): DeviceWithCredential | null {
  const raw = db
    .prepare(
      `SELECT ${DEVICE_COLUMNS}, token_hash FROM ${SERVER_TABLES.devices} WHERE token_hash = ?`,
    )
    .get(tokenHash) as RawDeviceCredentialRow | undefined
  if (raw === undefined) return null
  return { ...toDevice(raw), tokenHash: raw.token_hash }
}

export interface InsertDeviceInput {
  readonly id: DeviceId
  readonly userId: UserId
  readonly workspaceId: WorkspaceId | null
  readonly name: string
  readonly platform: string | null
  readonly tokenHash: string
  readonly pairingCodeId: string | null
  readonly at: UtcTimestamp
}

export function insertDevice(db: ServerDb, input: InsertDeviceInput): DeviceRow {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.devices}
       (id, user_id, workspace_id, name, platform, token_hash, pairing_code_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.id,
    input.userId,
    input.workspaceId,
    input.name,
    input.platform,
    input.tokenHash,
    input.pairingCodeId,
    input.at,
  )

  const created = findDeviceById(db, input.id)
  if (created === null) {
    // 刚插入却读不回来，只能是库坏了；不能返回 null 让上层以为配对成功但设备不存在。
    throw new Error('设备写入后无法读回，数据库可能不可用。')
  }
  return created
}

/** 重命名。只允许未撤销的设备改名（撤销后改名没有意义，且会掩盖撤销事实）。 */
export function renameDevice(db: ServerDb, id: DeviceId, name: string): boolean {
  const info = db
    .prepare(`UPDATE ${SERVER_TABLES.devices} SET name = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(name, id)
  return info.changes === 1
}

/** 更新最后活动时间。**仅用于展示与审计**，不参与任何冲突裁决（契约 ids.ts 明文）。 */
export function touchDeviceLastSeen(db: ServerDb, id: DeviceId, at: UtcTimestamp): void {
  db.prepare(`UPDATE ${SERVER_TABLES.devices} SET last_seen_at = ? WHERE id = ?`).run(at, id)
}

/** 撤销设备。条件更新保证幂等，且不会把已有的撤销原因覆盖成新的。 */
export function revokeDevice(
  db: ServerDb,
  id: DeviceId,
  at: UtcTimestamp,
  reason: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.devices}
          SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(at, reason, id)
  return info.changes === 1
}

/** 某用户的全部设备（含已撤销，供列表显示"已撤销"状态）。 */
export function listDevicesForUser(db: ServerDb, userId: UserId): readonly DeviceRow[] {
  const rows = db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM ${SERVER_TABLES.devices}
        WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as RawDeviceRow[]
  return rows.map(toDevice)
}

/** 某工作区范围内被授权的设备。管理端"设备授权范围"视图用它。 */
export function listDevicesForWorkspace(
  db: ServerDb,
  workspaceId: WorkspaceId,
): readonly DeviceRow[] {
  const rows = db
    .prepare(
      `SELECT ${DEVICE_COLUMNS} FROM ${SERVER_TABLES.devices}
        WHERE workspace_id = ? ORDER BY created_at DESC`,
    )
    .all(workspaceId) as RawDeviceRow[]
  return rows.map(toDevice)
}

export function countActiveDevices(db: ServerDb, userId: UserId): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${SERVER_TABLES.devices}
        WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .get(userId) as { count: number }
  return row.count
}

/** 撤销某用户的全部设备（停用账号时调用）。 */
export function revokeAllUserDevices(
  db: ServerDb,
  userId: UserId,
  at: UtcTimestamp,
  reason: string,
): number {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.devices}
          SET revoked_at = ?, revoked_reason = ?
        WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(at, reason, userId)
  return info.changes
}
