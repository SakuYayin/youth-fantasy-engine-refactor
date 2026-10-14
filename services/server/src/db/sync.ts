/**
 * 同步状态仓库：实体投影、变更流、回执与冲突留痕。
 *
 * ## 三个存储决定及其理由
 *
 * 1. **变更流的 `server_seq` 是唯一的顺序来源。**
 *    它由 `change_feed` 的 `AUTOINCREMENT` 主键产生，也就是 SQLite 的提交顺序。
 *    游标、分页、版本历史排序全部只用它，**绝不使用设备时钟或 `committed_at`**
 *    （`07-同步协议与API.md`："增量游标取自服务器提交顺序，不依赖设备时钟"）。
 *    多台设备的时钟可以差几十分钟，用时间排序会让"后提交的变更排到前面"，
 *    客户端一推进游标就直接漏掉中间那段。
 * 2. **实体投影（`sync_entities`）只是 `change_feed` 的物化视图。**
 *    它让快照与基线检查不必每次扫全表变更。两者在**同一个事务**里写，
 *    所以 `last_server_seq <= 快照 cursor` 恒成立，快照与增量不会互相矛盾。
 * 3. **墓碑保留 revision。** 删除写 `deleted = 1` 而不是删行：桌面端的基线检查
 *    需要回答"这个实体在服务器上是不是被删了、删在哪个版本"，
 *    删行会让"离线设备基于旧版本写回来"变成静默复活已删除的内容。
 *
 * ## 幂等回执为什么存响应体原件
 *
 * `sync_receipts.response_json` 存的是**首次提交时返回给客户端的完整响应**。
 * 重试（同 batchId + 同规范化载荷摘要）时原样回放，客户端拿到的 cursor / revision
 * 与第一次完全一致。如果这里改成"重新计算一遍"，一条并发写入就能让重试返回不同的
 * revision——客户端会以为自己丢过一次写入。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { Cursor, DeviceId, OperationAction, ProjectId, Revision, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'
import { SYNC_TABLES } from './syncDdl.js'

/** 冲突原因（与契约 `OperationConflict['reason']` 逐字一致）。 */
export type ConflictReason = 'revision-mismatch' | 'entity-deleted' | 'permission' | 'invalid-payload'

export interface EntityState {
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly revision: Revision
  readonly deleted: boolean
  readonly payload: Readonly<Record<string, unknown>>
  readonly updatedAt: UtcTimestamp
  readonly lastServerSeq: number
}

export interface FeedEntry {
  readonly serverSeq: number
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly action: OperationAction
  readonly revision: Revision
  readonly baseRevision: Revision | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly actorDeviceId: DeviceId | null
  readonly actorUserId: UserId | null
  readonly batchId: string | null
  readonly opId: string | null
  readonly committedAt: UtcTimestamp
}

export interface ReceiptRow {
  readonly batchId: string
  readonly workspaceId: WorkspaceId
  readonly deviceId: DeviceId
  readonly submittedByUserId: UserId
  readonly payloadDigest: string
  readonly operationCount: number
  readonly acceptedAt: UtcTimestamp
  readonly cursor: Cursor
  readonly responseJson: string
  readonly idempotencyKey: string | null
}

export interface AppendChangeInput {
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly action: OperationAction
  readonly revision: Revision
  readonly baseRevision: Revision | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly actorDeviceId: DeviceId | null
  readonly actorUserId: UserId | null
  readonly batchId: string
  readonly opId: string
  readonly committedAt: UtcTimestamp
}

export interface UpsertEntityInput {
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly revision: Revision
  readonly deleted: boolean
  /** 墓碑写 `null`：删除后服务器上不该再留正文。 */
  readonly payload: Readonly<Record<string, unknown>> | null
  readonly at: UtcTimestamp
  readonly lastServerSeq: number
}

export interface RecordConflictInput {
  readonly workspaceId: WorkspaceId
  readonly batchId: string
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly reason: ConflictReason
  readonly expectedBaseRevision: Revision | null
  readonly currentRevision: Revision | null
  readonly submittedByUserId: UserId
  readonly deviceId: DeviceId
  readonly detectedAt: UtcTimestamp
}

const ENTITY_COLUMNS =
  'entity_type, entity_id, project_id, revision, deleted, payload_json, updated_at, last_server_seq'

const FEED_COLUMNS =
  'server_seq, entity_type, entity_id, project_id, action, revision, base_revision, payload_json, actor_device_id, actor_user_id, batch_id, op_id, committed_at'

const RECEIPT_COLUMNS =
  'batch_id, workspace_id, device_id, submitted_by_user_id, payload_digest, operation_count, accepted_at, cursor, response_json, idempotency_key'

interface EntitySqlRow {
  readonly entity_type: string
  readonly entity_id: string
  readonly project_id: string | null
  readonly revision: string
  readonly deleted: number
  readonly payload_json: string | null
  readonly updated_at: string
  readonly last_server_seq: number
}

interface FeedSqlRow {
  readonly server_seq: number
  readonly entity_type: string
  readonly entity_id: string
  readonly project_id: string | null
  readonly action: string
  readonly revision: string
  readonly base_revision: string | null
  readonly payload_json: string
  readonly actor_device_id: string | null
  readonly actor_user_id: string | null
  readonly batch_id: string | null
  readonly op_id: string | null
  readonly committed_at: string
}

interface ReceiptSqlRow {
  readonly batch_id: string
  readonly workspace_id: string
  readonly device_id: string
  readonly submitted_by_user_id: string
  readonly payload_digest: string
  readonly operation_count: number
  readonly accepted_at: string
  readonly cursor: string
  readonly response_json: string
  readonly idempotency_key: string | null
}

/**
 * 解析 `payload_json`。
 *
 * 解析失败一律 `STORAGE_CORRUPT`（critical）：`payload_json` 只由本模块写入，
 * 坏掉的只可能是数据库本身。**绝不**把坏行静默跳过——那等于告诉客户端"这个变更
 * 不存在"，比报错危险得多。
 */
function parsePayload(json: string, entityId: string): Readonly<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '变更记录的内容无法解析，数据库可能已损坏。',
      detail: { entityId },
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '变更记录的内容不是对象，数据库可能已损坏。',
      detail: { entityId },
    })
  }
  return parsed as Readonly<Record<string, unknown>>
}

function toEntity(row: EntitySqlRow): EntityState {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id as ProjectId | null,
    revision: row.revision as Revision,
    deleted: row.deleted !== 0,
    payload: row.payload_json === null ? {} : parsePayload(row.payload_json, row.entity_id),
    updatedAt: row.updated_at as UtcTimestamp,
    lastServerSeq: row.last_server_seq,
  }
}

function toFeedEntry(row: FeedSqlRow): FeedEntry {
  if (row.action !== 'upsert' && row.action !== 'delete') {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '变更记录的动作不合法，数据库可能已损坏。',
      detail: { entityId: row.entity_id },
    })
  }
  return {
    serverSeq: row.server_seq,
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id as ProjectId | null,
    action: row.action,
    revision: row.revision as Revision,
    baseRevision: row.base_revision as Revision | null,
    payload: parsePayload(row.payload_json, row.entity_id),
    actorDeviceId: row.actor_device_id as DeviceId | null,
    actorUserId: row.actor_user_id as UserId | null,
    batchId: row.batch_id,
    opId: row.op_id,
    committedAt: row.committed_at as UtcTimestamp,
  }
}

function toReceipt(row: ReceiptSqlRow): ReceiptRow {
  return {
    batchId: row.batch_id,
    workspaceId: row.workspace_id as WorkspaceId,
    deviceId: row.device_id as DeviceId,
    submittedByUserId: row.submitted_by_user_id as UserId,
    payloadDigest: row.payload_digest,
    operationCount: row.operation_count,
    acceptedAt: row.accepted_at as UtcTimestamp,
    cursor: row.cursor as Cursor,
    responseJson: row.response_json,
    idempotencyKey: row.idempotency_key,
  }
}

// ------------------------------------------------------------------ 变更流

/** 工作区当前提交位置（该工作区最大的 `server_seq`；没有变更时为 0）。 */
export function readHeadSeq(db: ServerDb, workspaceId: WorkspaceId): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(server_seq), 0) AS head FROM ${SERVER_TABLES.changeFeed} WHERE workspace_id = ?`)
    .get(workspaceId) as { readonly head?: number } | undefined
  return typeof row?.head === 'number' ? row.head : 0
}

/** 追加一条变更，返回它拿到的 `server_seq`（在事务内调用）。 */
export function appendChange(db: ServerDb, input: AppendChangeInput): number {
  const result = db
    .prepare(
      `INSERT INTO ${SERVER_TABLES.changeFeed}
         (workspace_id, entity_type, entity_id, project_id, action, revision, base_revision,
          payload_json, actor_device_id, actor_user_id, committed_at, batch_id, op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workspaceId,
      input.entityType,
      input.entityId,
      input.projectId,
      input.action,
      input.revision,
      input.baseRevision,
      JSON.stringify(input.payload),
      input.actorDeviceId,
      input.actorUserId,
      input.committedAt,
      input.batchId,
      input.opId,
    )
  const seq = Number(result.lastInsertRowid)
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '变更写入后没有拿到有效序号，数据库状态不可信。',
    })
  }
  return seq
}

/** 按提交顺序取某工作区 `server_seq > afterSeq` 的变更（升序，稳定分页）。 */
export function listChanges(
  db: ServerDb,
  workspaceId: WorkspaceId,
  afterSeq: number,
  limit: number,
): readonly FeedEntry[] {
  const rows = db
    .prepare(
      `SELECT ${FEED_COLUMNS} FROM ${SERVER_TABLES.changeFeed}
        WHERE workspace_id = ? AND server_seq > ?
        ORDER BY server_seq ASC
        LIMIT ?`,
    )
    .all(workspaceId, afterSeq, limit) as readonly FeedSqlRow[]
  return rows.map(toFeedEntry)
}

/** 某实体的版本历史（倒序：最新在前）。`entityType` 为 `null` 时跨类型聚合。 */
export function listEntityVersions(
  db: ServerDb,
  workspaceId: WorkspaceId,
  entityId: string,
  entityType: string | null,
  limit: number,
): readonly FeedEntry[] {
  const rows =
    entityType === null
      ? (db
          .prepare(
            `SELECT ${FEED_COLUMNS} FROM ${SERVER_TABLES.changeFeed}
              WHERE workspace_id = ? AND entity_id = ?
              ORDER BY server_seq DESC
              LIMIT ?`,
          )
          .all(workspaceId, entityId, limit) as readonly FeedSqlRow[])
      : (db
          .prepare(
            `SELECT ${FEED_COLUMNS} FROM ${SERVER_TABLES.changeFeed}
              WHERE workspace_id = ? AND entity_id = ? AND entity_type = ?
              ORDER BY server_seq DESC
              LIMIT ?`,
          )
          .all(workspaceId, entityId, entityType, limit) as readonly FeedSqlRow[])
  return rows.map(toFeedEntry)
}

/**
 * 按 `opId` 找该操作已经提交过的变更。
 *
 * 用来分辨两种"同一个 opId 又来了一次"：
 * - 同载荷同 revision → 真重放，不二次写入；
 * - 不同载荷或不同 revision → 幂等键重用（`IDEMPOTENCY_KEY_REUSED`）。
 *
 * 只按 `(workspace_id, op_id)` 查：opId 是客户端生成的，跨工作区撞车在语义上
 * 是两回事，各工作区各自幂等。
 */
export function findFeedEntryByOpId(db: ServerDb, workspaceId: WorkspaceId, opId: string): FeedEntry | null {
  const row = db
    .prepare(
      `SELECT ${FEED_COLUMNS} FROM ${SERVER_TABLES.changeFeed}
        WHERE workspace_id = ? AND op_id = ?
        ORDER BY server_seq ASC
        LIMIT 1`,
    )
    .get(workspaceId, opId) as FeedSqlRow | undefined
  return row === undefined ? null : toFeedEntry(row)
}

// ------------------------------------------------------------------ 实体投影

export function findEntityState(
  db: ServerDb,
  workspaceId: WorkspaceId,
  entityType: string,
  entityId: string,
): EntityState | null {
  const row = db
    .prepare(
      `SELECT ${ENTITY_COLUMNS} FROM ${SYNC_TABLES.syncEntities}
        WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?`,
    )
    .get(workspaceId, entityType, entityId) as EntitySqlRow | undefined
  return row === undefined ? null : toEntity(row)
}

/** 某工作区里未删除的实体（快照用）。按 `entity_id` 排序，保证同一 cursor 下顺序稳定。 */
export function listLiveEntities(
  db: ServerDb,
  workspaceId: WorkspaceId,
  entityType: string | null,
): readonly EntityState[] {
  const rows =
    entityType === null
      ? (db
          .prepare(
            `SELECT ${ENTITY_COLUMNS} FROM ${SYNC_TABLES.syncEntities}
              WHERE workspace_id = ? AND deleted = 0
              ORDER BY entity_type ASC, entity_id ASC`,
          )
          .all(workspaceId) as readonly EntitySqlRow[])
      : (db
          .prepare(
            `SELECT ${ENTITY_COLUMNS} FROM ${SYNC_TABLES.syncEntities}
              WHERE workspace_id = ? AND entity_type = ? AND deleted = 0
              ORDER BY entity_id ASC`,
          )
          .all(workspaceId, entityType) as readonly EntitySqlRow[])
  return rows.map(toEntity)
}

/** 写入/更新实体投影（在事务内调用，且必须与 `appendChange` 同事务）。 */
export function upsertEntity(db: ServerDb, input: UpsertEntityInput): void {
  db.prepare(
    `INSERT INTO ${SYNC_TABLES.syncEntities}
       (workspace_id, entity_type, entity_id, project_id, revision, deleted, payload_json, updated_at, last_server_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET
       project_id = excluded.project_id,
       revision = excluded.revision,
       deleted = excluded.deleted,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at,
       last_server_seq = excluded.last_server_seq`,
  ).run(
    input.workspaceId,
    input.entityType,
    input.entityId,
    input.projectId,
    input.revision,
    input.deleted ? 1 : 0,
    input.payload === null ? null : JSON.stringify(input.payload),
    input.at,
    input.lastServerSeq,
  )
}

// ------------------------------------------------------------------ 回执

export function findReceipt(db: ServerDb, batchId: string): ReceiptRow | null {
  const row = db
    .prepare(`SELECT ${RECEIPT_COLUMNS} FROM ${SERVER_TABLES.syncReceipts} WHERE batch_id = ?`)
    .get(batchId) as ReceiptSqlRow | undefined
  return row === undefined ? null : toReceipt(row)
}

export interface InsertReceiptInput {
  readonly batchId: string
  readonly workspaceId: WorkspaceId
  readonly deviceId: DeviceId
  readonly submittedByUserId: UserId
  readonly payloadDigest: string
  readonly operationCount: number
  readonly acceptedAt: UtcTimestamp
  readonly cursor: Cursor
  readonly responseJson: string
  readonly idempotencyKey: string | null
}

export function insertReceipt(db: ServerDb, input: InsertReceiptInput): void {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.syncReceipts}
       (batch_id, workspace_id, device_id, submitted_by_user_id, payload_digest, operation_count,
        accepted_at, cursor, response_json, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.batchId,
    input.workspaceId,
    input.deviceId,
    input.submittedByUserId,
    input.payloadDigest,
    input.operationCount,
    input.acceptedAt,
    input.cursor,
    input.responseJson,
    input.idempotencyKey,
  )
}

// ------------------------------------------------------------------ 冲突留痕

/**
 * 记录一批冲突。
 *
 * `INSERT OR IGNORE` + `(batch_id, op_id)` 唯一索引：同一个冲突批次重试时不会重复膨胀。
 * 冲突是**旁路**：写失败不影响已经做出的"整批拒绝"判定（拒绝本身不需要落库才成立）。
 */
export function recordConflicts(db: ServerDb, conflicts: readonly RecordConflictInput[]): number {
  if (conflicts.length === 0) {
    return 0
  }
  const statement = db.prepare(
    `INSERT OR IGNORE INTO ${SYNC_TABLES.syncConflicts}
       (id, workspace_id, batch_id, op_id, entity_type, entity_id, project_id, reason,
        expected_base_revision, current_revision, submitted_by_user_id, device_id, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let written = 0
  const run = db.transaction(() => {
    for (const conflict of conflicts) {
      const result = statement.run(
        newIds.request(),
        conflict.workspaceId,
        conflict.batchId,
        conflict.opId,
        conflict.entityType,
        conflict.entityId,
        conflict.projectId,
        conflict.reason,
        conflict.expectedBaseRevision,
        conflict.currentRevision,
        conflict.submittedByUserId,
        conflict.deviceId,
        conflict.detectedAt,
      )
      written += Number(result.changes)
    }
  })
  run()
  return written
}

/** 读某批的冲突留痕（诊断用；对外接口留给后续的冲突解决任务）。 */
export function listConflictsForBatch(
  db: ServerDb,
  batchId: string,
): readonly { readonly opId: string; readonly reason: ConflictReason }[] {
  const rows = db
    .prepare(`SELECT op_id, reason FROM ${SYNC_TABLES.syncConflicts} WHERE batch_id = ? ORDER BY op_id ASC`)
    .all(batchId) as readonly { readonly op_id: string; readonly reason: string }[]
  return rows.map((row) => ({ opId: row.op_id, reason: row.reason as ConflictReason }))
}
