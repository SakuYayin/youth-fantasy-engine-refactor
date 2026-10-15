/**
 * 附件上传与资产登记的仓储层。
 *
 * ## 为什么单独一个文件
 *
 * 四张表（`upload_sessions` / `upload_parts` / `assets` / `asset_refs`）本来就不属于
 * 同步协议那套仓储（`db/sync.ts`），而迁移 3 已经把它们建好了（`db/assetJobDdl.ts`），
 * 所以这里只写 SQL，不改 DDL、不碰 `db/index.ts` 的导出面。
 *
 * ## 一致性的两条硬约束
 *
 * 1. **`received_parts` 必须等于 `upload_parts` 的行数**。重复上传同一分片不能重复计数，
 *    所以写入分片与自增计数在**同一个事务**里做（`recordUploadPart`），用
 *    `INSERT OR IGNORE` 的 `changes` 判定"这一片是不是新收的"。
 * 2. **状态流转只能向前**，且用 `WHERE status = ?` 做 CAS（`markUploadSessionCompleting` /
 *    `completeUploadSession`）：并发两个 `complete` 只有一个能把 `completing` 抢成功，
 *    另一个要么看到 `completed` 直接复用结果，要么拿到 `STATE_INVALID_TRANSITION`。
 *
 * 所有时间戳都由调用方（路由的 `deps.now()`）传入，仓储不自己取时钟——
 * 这样测试能用 `testClock` 精确控制"会话过期"。
 */

import type { UtcTimestamp } from '@yfe/contracts'

import { tx } from './open.js'
import type { ServerDb } from './open.js'

/** `upload_sessions.status` 的取值（与 DDL 的 CHECK 一致）。 */
export type UploadStatus = 'open' | 'completing' | 'completed' | 'aborted' | 'expired'
/** `assets.state` 的取值（与 DDL 的 CHECK 一致）。 */
export type AssetState = 'staged' | 'present' | 'missing' | 'corrupt'

export interface UploadSessionRow {
  readonly uploadId: string
  readonly workspaceId: string
  readonly userId: string
  readonly deviceId: string | null
  readonly declaredName: string | null
  readonly declaredMime: string | null
  readonly declaredSize: number
  readonly declaredSha256: string | null
  readonly partSizeBytes: number
  readonly totalParts: number
  readonly receivedParts: number
  readonly status: UploadStatus
  readonly stagingDir: string
  readonly assetId: string | null
  readonly createdAt: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly completedAt: UtcTimestamp | null
}

export interface UploadPartRow {
  readonly uploadId: string
  readonly partNumber: number
  readonly byteSize: number
  readonly sha256: string | null
  readonly receivedAt: UtcTimestamp
}

export interface AssetRow {
  readonly assetId: string
  readonly workspaceId: string
  readonly attachmentId: string | null
  readonly storageKey: string
  readonly hashAlgorithm: string
  readonly sha256: string
  readonly byteSize: number
  readonly mimeType: string | null
  readonly originalName: string | null
  readonly state: AssetState
  readonly uploadedByUserId: string
  readonly createdAt: UtcTimestamp
  readonly verifiedAt: UtcTimestamp | null
  readonly deleted: number
  readonly deletedAt: UtcTimestamp | null
}

export interface AssetRefRow {
  readonly assetId: string
  readonly workspaceId: string
  readonly entityType: string
  readonly entityId: string
  readonly createdAt: UtcTimestamp
}

export interface NewUploadSession {
  readonly uploadId: string
  readonly workspaceId: string
  readonly userId: string
  readonly deviceId: string | null
  readonly declaredName: string | null
  readonly declaredMime: string | null
  readonly declaredSize: number
  readonly declaredSha256: string | null
  readonly partSizeBytes: number
  readonly totalParts: number
  readonly stagingDir: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface ReceivedUploadPart {
  readonly uploadId: string
  readonly partNumber: number
  readonly byteSize: number
  readonly sha256: string
  readonly receivedAt: string
}

/** `recordUploadPart` 的结果：`inserted=false` 表示这是一次幂等重传。 */
export interface RecordedPart {
  readonly inserted: boolean
  readonly receivedParts: number
}

export interface NewAsset {
  readonly assetId: string
  readonly workspaceId: string
  readonly attachmentId: string | null
  readonly storageKey: string
  readonly sha256: string
  readonly byteSize: number
  readonly mimeType: string | null
  readonly originalName: string | null
  readonly uploadedByUserId: string
  readonly createdAt: string
  readonly verifiedAt: string | null
}

export interface NewAssetRef {
  readonly assetId: string
  readonly workspaceId: string
  readonly entityType: string
  readonly entityId: string
  readonly createdAt: string
}

interface RawUploadSessionRow {
  upload_id: string
  workspace_id: string
  user_id: string
  device_id: string | null
  declared_name: string | null
  declared_mime: string | null
  declared_size: number
  declared_sha256: string | null
  part_size_bytes: number
  total_parts: number
  received_parts: number
  status: UploadStatus
  staging_dir: string
  asset_id: string | null
  created_at: string
  expires_at: string
  completed_at: string | null
}

interface RawUploadPartRow {
  upload_id: string
  part_number: number
  byte_size: number
  sha256: string | null
  received_at: string
}

interface RawAssetRow {
  asset_id: string
  workspace_id: string
  attachment_id: string | null
  storage_key: string
  hash_algorithm: string
  sha256: string
  byte_size: number
  mime_type: string | null
  original_name: string | null
  state: AssetState
  uploaded_by_user_id: string
  created_at: string
  verified_at: string | null
  deleted: number
  deleted_at: string | null
}

interface RawAssetRefRow {
  asset_id: string
  workspace_id: string
  entity_type: string
  entity_id: string
  created_at: string
}

const UPLOAD_SESSION_COLUMNS = `upload_id, workspace_id, user_id, device_id, declared_name,
  declared_mime, declared_size, declared_sha256, part_size_bytes, total_parts, received_parts,
  status, staging_dir, asset_id, created_at, expires_at, completed_at`

const UPLOAD_PART_COLUMNS = `upload_id, part_number, byte_size, sha256, received_at`

const ASSET_COLUMNS = `asset_id, workspace_id, attachment_id, storage_key, hash_algorithm, sha256,
  byte_size, mime_type, original_name, state, uploaded_by_user_id, created_at, verified_at,
  deleted, deleted_at`

const ASSET_REF_COLUMNS = `asset_id, workspace_id, entity_type, entity_id, created_at`

function toUploadSession(raw: RawUploadSessionRow): UploadSessionRow {
  return {
    uploadId: raw.upload_id,
    workspaceId: raw.workspace_id,
    userId: raw.user_id,
    deviceId: raw.device_id,
    declaredName: raw.declared_name,
    declaredMime: raw.declared_mime,
    declaredSize: raw.declared_size,
    declaredSha256: raw.declared_sha256,
    partSizeBytes: raw.part_size_bytes,
    totalParts: raw.total_parts,
    receivedParts: raw.received_parts,
    status: raw.status,
    stagingDir: raw.staging_dir,
    assetId: raw.asset_id,
    createdAt: raw.created_at as UtcTimestamp,
    expiresAt: raw.expires_at as UtcTimestamp,
    completedAt: raw.completed_at as UtcTimestamp | null,
  }
}

function toUploadPart(raw: RawUploadPartRow): UploadPartRow {
  return {
    uploadId: raw.upload_id,
    partNumber: raw.part_number,
    byteSize: raw.byte_size,
    sha256: raw.sha256,
    receivedAt: raw.received_at as UtcTimestamp,
  }
}

function toAsset(raw: RawAssetRow): AssetRow {
  return {
    assetId: raw.asset_id,
    workspaceId: raw.workspace_id,
    attachmentId: raw.attachment_id,
    storageKey: raw.storage_key,
    hashAlgorithm: raw.hash_algorithm,
    sha256: raw.sha256,
    byteSize: raw.byte_size,
    mimeType: raw.mime_type,
    originalName: raw.original_name,
    state: raw.state,
    uploadedByUserId: raw.uploaded_by_user_id,
    createdAt: raw.created_at as UtcTimestamp,
    verifiedAt: raw.verified_at as UtcTimestamp | null,
    deleted: raw.deleted,
    deletedAt: raw.deleted_at as UtcTimestamp | null,
  }
}

function toAssetRef(raw: RawAssetRefRow): AssetRefRow {
  return {
    assetId: raw.asset_id,
    workspaceId: raw.workspace_id,
    entityType: raw.entity_type,
    entityId: raw.entity_id,
    createdAt: raw.created_at as UtcTimestamp,
  }
}

// ---------------------------------------------------------------------------
// upload_sessions
// ---------------------------------------------------------------------------

export function insertUploadSession(db: ServerDb, input: NewUploadSession): UploadSessionRow {
  db.prepare(
    `INSERT INTO upload_sessions (${UPLOAD_SESSION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, NULL, ?, ?, NULL)`,
  ).run(
    input.uploadId,
    input.workspaceId,
    input.userId,
    input.deviceId,
    input.declaredName,
    input.declaredMime,
    input.declaredSize,
    input.declaredSha256,
    input.partSizeBytes,
    input.totalParts,
    input.stagingDir,
    input.createdAt,
    input.expiresAt,
  )
  const row = findUploadSession(db, input.uploadId)
  if (row === null) {
    throw new Error('上传会话写入后读不回来。')
  }
  return row
}

export function findUploadSession(db: ServerDb, uploadId: string): UploadSessionRow | null {
  const raw = db
    .prepare(`SELECT ${UPLOAD_SESSION_COLUMNS} FROM upload_sessions WHERE upload_id = ?`)
    .get(uploadId) as RawUploadSessionRow | undefined
  return raw === undefined ? null : toUploadSession(raw)
}

/** CAS：`open` → `completing`。抢到的返回 `true`。 */
export function markUploadSessionCompleting(db: ServerDb, uploadId: string): boolean {
  const info = db
    .prepare(`UPDATE upload_sessions SET status = 'completing' WHERE upload_id = ? AND status = 'open'`)
    .run(uploadId)
  return info.changes === 1
}

/** 终止会话（校验失败 / 客户端放弃）：置终态并清掉已收分片，保证不留半成品记账。 */
export function abortUploadSession(db: ServerDb, uploadId: string, status: 'aborted' | 'expired'): void {
  tx(db, () => {
    db.prepare('DELETE FROM upload_parts WHERE upload_id = ?').run(uploadId)
    db.prepare('UPDATE upload_sessions SET status = ?, received_parts = 0 WHERE upload_id = ?').run(
      status,
      uploadId,
    )
  })
}

/** 复位到 `open`（拼接阶段发现分片文件缺失时用：让客户端能重传缺的那一片）。 */
export function releaseUploadSessionCompleting(db: ServerDb, uploadId: string): boolean {
  const info = db
    .prepare(`UPDATE upload_sessions SET status = 'open' WHERE upload_id = ? AND status = 'completing'`)
    .run(uploadId)
  return info.changes === 1
}

/** CAS：`completing` → `completed`，并回填 `asset_id` / `completed_at`。 */
export function completeUploadSession(
  db: ServerDb,
  uploadId: string,
  assetId: string,
  completedAt: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE upload_sessions SET status = 'completed', asset_id = ?, completed_at = ?
       WHERE upload_id = ? AND status = 'completing'`,
    )
    .run(assetId, completedAt, uploadId)
  return info.changes === 1
}

// ---------------------------------------------------------------------------
// upload_parts（与 upload_sessions.received_parts 同步维护）
// ---------------------------------------------------------------------------

export function listUploadParts(db: ServerDb, uploadId: string): UploadPartRow[] {
  const rows = db
    .prepare(`SELECT ${UPLOAD_PART_COLUMNS} FROM upload_parts WHERE upload_id = ? ORDER BY part_number`)
    .all(uploadId) as RawUploadPartRow[]
  return rows.map(toUploadPart)
}

export function listUploadPartNumbers(db: ServerDb, uploadId: string): number[] {
  const rows = db
    .prepare('SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number')
    .all(uploadId) as { part_number: number }[]
  return rows.map((row) => row.part_number)
}

export function countUploadParts(db: ServerDb, uploadId: string): number {
  const raw = db
    .prepare('SELECT COUNT(*) AS total FROM upload_parts WHERE upload_id = ?')
    .get(uploadId) as { total: number }
  return raw.total
}

/**
 * 记录一个已落盘的分片。
 *
 * `INSERT OR IGNORE` + 条件自增：重复上传同一 `part_number` 时
 * `changes === 0`，计数不动（**幂等重传不重复计数**），但分片行会被更新成
 * 最近一次落盘的内容——"断点以服务器确认的 part 状态为准"。
 */
export function recordUploadPart(db: ServerDb, input: ReceivedUploadPart): RecordedPart {
  return tx(db, () => {
    const existing = db
      .prepare('SELECT 1 AS present FROM upload_parts WHERE upload_id = ? AND part_number = ?')
      .get(input.uploadId, input.partNumber) as { present: number } | undefined
    const inserted = existing === undefined
    if (inserted) {
      db.prepare(
        `INSERT INTO upload_parts (${UPLOAD_PART_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.uploadId,
        input.partNumber,
        input.byteSize,
        input.sha256,
        input.receivedAt,
      )
    } else {
      db.prepare(
        `UPDATE upload_parts SET byte_size = ?, sha256 = ?, received_at = ?
         WHERE upload_id = ? AND part_number = ?`,
      ).run(
        input.byteSize,
        input.sha256,
        input.receivedAt,
        input.uploadId,
        input.partNumber,
      )
    }
    const counted = countUploadParts(db, input.uploadId)
    db.prepare('UPDATE upload_sessions SET received_parts = ? WHERE upload_id = ?').run(
      counted,
      input.uploadId,
    )
    return { inserted, receivedParts: counted }
  })
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

export function insertAsset(db: ServerDb, input: NewAsset): AssetRow {
  db.prepare(
    `INSERT INTO assets (${ASSET_COLUMNS})
     VALUES (?, ?, ?, ?, 'sha256', ?, ?, ?, ?, 'present', ?, ?, ?, 0, NULL)`,
  ).run(
    input.assetId,
    input.workspaceId,
    input.attachmentId,
    input.storageKey,
    input.sha256,
    input.byteSize,
    input.mimeType,
    input.originalName,
    input.uploadedByUserId,
    input.createdAt,
    input.verifiedAt,
  )
  const row = findAssetById(db, input.assetId)
  if (row === null) {
    throw new Error('资产写入后读不回来。')
  }
  return row
}

export function findAssetById(db: ServerDb, assetId: string): AssetRow | null {
  const raw = db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE asset_id = ?`)
    .get(assetId) as RawAssetRow | undefined
  return raw === undefined ? null : toAsset(raw)
}

/** 按 `(workspace_id, storage_key)` 查已有资产（唯一索引保证最多一行）。 */
export function findAssetByStorageKey(
  db: ServerDb,
  workspaceId: string,
  storageKey: string,
): AssetRow | null {
  const raw = db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE workspace_id = ? AND storage_key = ?`)
    .get(workspaceId, storageKey) as RawAssetRow | undefined
  return raw === undefined ? null : toAsset(raw)
}

/**
 * 把资产标记为"已核实存在"。
 *
 * 复用同一内容寻址键时也走这里：`state` 回到 `present`、`verified_at` 刷新，
 * 之前被软删的行一并复活（字节又回来了，引用虽然已清空，但资产本身可用）。
 */
export function markAssetPresent(db: ServerDb, assetId: string, verifiedAt: string): boolean {
  const info = db
    .prepare(
      `UPDATE assets SET state = 'present', verified_at = ?, deleted = 0, deleted_at = NULL
       WHERE asset_id = ?`,
    )
    .run(verifiedAt, assetId)
  return info.changes === 1
}

/** CAS 软删：已删过返回 `false`（调用方按幂等处理）。 */
export function softDeleteAsset(db: ServerDb, assetId: string, deletedAt: string): boolean {
  const info = db
    .prepare('UPDATE assets SET deleted = 1, deleted_at = ? WHERE asset_id = ? AND deleted = 0')
    .run(deletedAt, assetId)
  return info.changes === 1
}

export function updateAssetState(db: ServerDb, assetId: string, state: AssetState): boolean {
  const info = db.prepare('UPDATE assets SET state = ? WHERE asset_id = ?').run(state, assetId)
  return info.changes === 1
}

// ---------------------------------------------------------------------------
// asset_refs
// ---------------------------------------------------------------------------

/** 建引用（幂等）：已存在返回 `created=false` 并回读原行。 */
export function insertAssetRef(
  db: ServerDb,
  input: NewAssetRef,
): { readonly created: boolean; readonly row: AssetRefRow } {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO asset_refs (${ASSET_REF_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.assetId, input.workspaceId, input.entityType, input.entityId, input.createdAt)
  const raw = db
    .prepare(
      `SELECT ${ASSET_REF_COLUMNS} FROM asset_refs
       WHERE asset_id = ? AND entity_type = ? AND entity_id = ?`,
    )
    .get(input.assetId, input.entityType, input.entityId) as RawAssetRefRow | undefined
  if (raw === undefined) {
    throw new Error('资产引用写入后读不回来。')
  }
  return { created: info.changes === 1, row: toAssetRef(raw) }
}

export function listAssetRefs(db: ServerDb, assetId: string): AssetRefRow[] {
  const rows = db
    .prepare(
      `SELECT ${ASSET_REF_COLUMNS} FROM asset_refs WHERE asset_id = ?
       ORDER BY entity_type, entity_id`,
    )
    .all(assetId) as RawAssetRefRow[]
  return rows.map(toAssetRef)
}

export function listAssetRefsForEntity(
  db: ServerDb,
  workspaceId: string,
  entityType: string,
  entityId: string,
): AssetRefRow[] {
  const rows = db
    .prepare(
      `SELECT ${ASSET_REF_COLUMNS} FROM asset_refs
       WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?
       ORDER BY asset_id`,
    )
    .all(workspaceId, entityType, entityId) as RawAssetRefRow[]
  return rows.map(toAssetRef)
}

export function countAssetRefs(db: ServerDb, assetId: string): number {
  const raw = db
    .prepare('SELECT COUNT(*) AS total FROM asset_refs WHERE asset_id = ?')
    .get(assetId) as { total: number }
  return raw.total
}

export function deleteAssetRef(
  db: ServerDb,
  assetId: string,
  entityType: string,
  entityId: string,
): boolean {
  const info = db
    .prepare('DELETE FROM asset_refs WHERE asset_id = ? AND entity_type = ? AND entity_id = ?')
    .run(assetId, entityType, entityId)
  return info.changes === 1
}
