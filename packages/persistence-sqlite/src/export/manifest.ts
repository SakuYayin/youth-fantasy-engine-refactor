/**
 * 恢复点清单（backup manifest）—— 备份文件的**自描述元数据**。
 *
 * 设计判据：
 * - `06-数据与本地存储.md:73`：恢复点包含**数据库版本、同步协议、插件数据版本、附件清单和校验**。
 * - `11-测试验收与迁移.md:48`：备份恢复必须能在**全新实例**完成正文/引用/附件校验，
 *   不能只验证"备份文件存在"。
 *
 * 🔴 因此清单不是可选的装饰：没有它就无法回答"这个文件是什么版本、属于哪个工作区、
 *    里面的行数是否与预期一致"，恢复只能靠猜。清单与快照**成对存在**，
 *    `verifyBackup` 会同时校验两者。
 *
 * 🔴 清单**绝不放绝对路径**：备份常被复制到 NAS/U 盘/别人机器，绝对路径会泄漏用户名
 *    与目录结构（`09-部署与运维.md` 的隐私取向）。只记 `fileName`（basename）。
 * 🔴 清单**绝不包含秘密**：模型 Key、NAS 密码、会话令牌都不进普通备份
 *    （`06-数据与本地存储.md:63`、`11-测试验收与迁移.md:44`）。
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import {
  APP_VERSION,
  DB_SCHEMA_VERSION,
  SYNC_PROTOCOL_VERSION,
  errOf,
  ok,
  type RequestId,
  type Result,
  type UtcTimestamp,
} from '@yfe/contracts'

import {
  SCHEMA_MIGRATIONS_TABLE,
  type SqliteDatabase,
} from '../schema/index.js'

/** 清单格式版本。字段语义变化时 +1；新增**可选**字段不递增。 */
export const BACKUP_MANIFEST_VERSION = 1

/** 清单文件名后缀（与快照同名并列存放）。 */
export const MANIFEST_EXTENSION = '.manifest.json'

/** 一次哈希读取的块大小（64 KiB）。避免把几十 MB 的库一次性读进内存。 */
const HASH_CHUNK_BYTES = 64 * 1024

/** 备份中的单文件描述。 */
export interface BackupFileEntry {
  /** 文件名（basename），**不是**绝对路径。 */
  readonly fileName: string
  readonly sha256: string
  readonly byteSize: number
}

/** 迁移台账行：恢复时用它核对"这个库确实由这些迁移构成"。 */
export interface BackupMigrationEntry {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly appliedAt: string
}

/** 实体计数：恢复后必须逐项相等，否则说明快照与清单来自不同时刻。 */
export interface BackupEntityCounts {
  readonly projects: number
  readonly documents: number
  readonly settingsEntities: number
  readonly assets: number
  readonly revisions: number
  readonly pluginData: number
  readonly localDrafts: number
}

/** 附件清单条目：只描述**声明**，不复制二进制（本轮不做附件文件搬运）。 */
export interface BackupAssetEntry {
  readonly assetId: string
  readonly workspaceId: string
  readonly storageKey: string
  readonly sha256: string
  readonly byteSize: number
  readonly localState: string
  readonly deleted: boolean
}

/** 工作区归属：备份里每个工作区各有多少实体。 */
export interface BackupWorkspaceEntry {
  readonly workspaceId: string
  readonly name: string
  readonly deleted: boolean
  readonly projectCount: number
  readonly documentCount: number
  readonly assetCount: number
  readonly revisionCount: number
}

export interface BackupManifest {
  readonly manifestVersion: number
  readonly appVersion: string
  readonly databaseSchemaVersion: number
  readonly syncProtocolVersion: { readonly major: number; readonly minor: number }
  readonly createdAt: UtcTimestamp
  /** 快照文件本身（sha256 + 字节数），恢复前必须逐字节对上。 */
  readonly databaseFile: BackupFileEntry
  /** 成功应用的迁移台账（升序）。 */
  readonly migrationLedger: readonly BackupMigrationEntry[]
  readonly entityCounts: BackupEntityCounts
  /** 附件清单（声明）。 */
  readonly assets: readonly BackupAssetEntry[]
  /**
   * 🔴 恒为 `false`：普通备份不搬运附件二进制。
   *    写成字面量 `false` 而不是 `boolean`，是为了让"没搬附件"这件事无法被静默改真。
   */
  readonly attachmentFilesIncluded: false
  /** 🔴 同上：普通备份与同步都**不含**秘密（`06:63`）。 */
  readonly containsSecrets: false
  readonly workspaces: readonly BackupWorkspaceEntry[]
}

// ---------------------------------------------------------------------------
// 文件摘要
// ---------------------------------------------------------------------------

/**
 * 计算文件 SHA-256。
 *
 * 分块读取：库文件可能到几十上百 MB，`readFileSync` 会一次性占用同等内存，
 * 在低配机器上直接触发 GC 抖动甚至 OOM。
 */
export function sha256OfFile(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** 生成文件描述条目。 */
export function describeFile(path: string): BackupFileEntry {
  return {
    fileName: basename(path),
    sha256: sha256OfFile(path),
    byteSize: statSync(path).size,
  }
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

export interface BuildBackupManifestOptions {
  readonly requestId: RequestId
  /** 快照文件路径（清单只取其 basename 与摘要）。 */
  readonly snapshotPath: string
  readonly createdAt: UtcTimestamp
}

/**
 * 从一个库连接读出清单所需的**全部事实**。
 *
 * 🔴 创建与校验共用这一个读取器：两边各写一份 SQL 是"清单说 A、校验算 B"的经典来源。
 */
export interface BackupFacts {
  readonly databaseSchemaVersion: number
  readonly migrationLedger: readonly BackupMigrationEntry[]
  readonly entityCounts: BackupEntityCounts
  readonly workspaces: readonly BackupWorkspaceEntry[]
  readonly assets: readonly BackupAssetEntry[]
}

/** 读取清单事实。抛错由调用方翻译（创建路径译成 STORAGE_UNAVAILABLE，校验路径译成 STORAGE_CORRUPT）。 */
export function readBackupFacts(db: SqliteDatabase): BackupFacts {
  return {
    databaseSchemaVersion: readSnapshotSchemaVersion(db),
    migrationLedger: readMigrationLedger(db),
    entityCounts: readEntityCounts(db),
    workspaces: readWorkspaceEntries(db),
    assets: readAssetEntries(db),
  }
}

/**
 * 从一个**快照连接**构建清单。
 *
 * 🔴 必须传快照自己的连接，不要传源库连接：`VACUUM INTO` 之后源库仍可能有新写入，
 *    在源库上计数会得到"清单说 10 章、快照里 11 章"的不一致清单。
 */
export function buildBackupManifest(
  db: SqliteDatabase,
  options: BuildBackupManifestOptions,
): Result<BackupManifest> {
  const { requestId, snapshotPath, createdAt } = options
  try {
    const facts = readBackupFacts(db)
    return ok({
      manifestVersion: BACKUP_MANIFEST_VERSION,
      appVersion: APP_VERSION,
      databaseSchemaVersion: facts.databaseSchemaVersion,
      syncProtocolVersion: { major: SYNC_PROTOCOL_VERSION.major, minor: SYNC_PROTOCOL_VERSION.minor },
      createdAt,
      databaseFile: describeFile(snapshotPath),
      migrationLedger: facts.migrationLedger,
      entityCounts: facts.entityCounts,
      assets: facts.assets,
      attachmentFilesIncluded: false as const,
      containsSecrets: false as const,
      workspaces: facts.workspaces,
    })
  } catch (thrown) {
    return errOf('STORAGE_UNAVAILABLE', '读取快照元数据失败，无法生成备份清单。', requestId, {
      reason: errorReason(thrown),
    })
  }
}

/** 从快照读取 schema 版本；`schema_migrations` 缺失时按 0 处理（全新/损坏库）。 */
function readSnapshotSchemaVersion(db: SqliteDatabase): number {
  const hasTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(SCHEMA_MIGRATIONS_TABLE) as { name: string } | undefined
  if (hasTable === undefined) return 0
  const row = db
    .prepare(`SELECT MAX(version) AS version FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE success = 1`)
    .get() as { version: number | null } | undefined
  return row?.version ?? 0
}

function readMigrationLedger(db: SqliteDatabase): readonly BackupMigrationEntry[] {
  const rows = db
    .prepare(
      `SELECT version, name, checksum, applied_at FROM ${SCHEMA_MIGRATIONS_TABLE}
        WHERE success = 1 ORDER BY version`,
    )
    .all() as readonly { version: number; name: string; checksum: string; applied_at: string }[]
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }))
}

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

function readEntityCounts(db: SqliteDatabase): BackupEntityCounts {
  return {
    projects: countRows(db, 'projects'),
    documents: countRows(db, 'documents'),
    settingsEntities: countRows(db, 'settings_entities'),
    assets: countRows(db, 'assets'),
    revisions: countRows(db, 'revisions'),
    pluginData: countRows(db, 'plugin_data'),
    localDrafts: countRows(db, 'local_drafts'),
  }
}

function readWorkspaceEntries(db: SqliteDatabase): readonly BackupWorkspaceEntry[] {
  const rows = db
    .prepare(`SELECT id, name, deleted FROM workspaces ORDER BY id`)
    .all() as readonly { id: string; name: string; deleted: number }[]
  return rows.map((row) => ({
    workspaceId: row.id,
    name: row.name,
    deleted: row.deleted !== 0,
    projectCount: countRowsWhere(db, 'projects', row.id),
    documentCount: countRowsWhere(db, 'documents', row.id),
    assetCount: countRowsWhere(db, 'assets', row.id),
    revisionCount: countRowsWhere(db, 'revisions', row.id),
  }))
}

function countRowsWhere(db: SqliteDatabase, table: string, workspaceId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE workspace_id = ?`).get(workspaceId) as {
    c: number
  }
  return row.c
}

function readAssetEntries(db: SqliteDatabase): readonly BackupAssetEntry[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, storage_key, sha256, byte_size, local_state, deleted
         FROM assets ORDER BY id`,
    )
    .all() as readonly {
    id: string
    workspace_id: string
    storage_key: string
    sha256: string
    byte_size: number
    local_state: string
    deleted: number
  }[]
  return rows.map((row) => ({
    assetId: row.id,
    workspaceId: row.workspace_id,
    storageKey: row.storage_key,
    sha256: row.sha256,
    byteSize: row.byte_size,
    localState: row.local_state,
    deleted: row.deleted !== 0,
  }))
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

/** 序列化清单：2 空格缩进 + 尾随换行（`git diff` 友好，也便于人工核对）。 */
export function serializeBackupManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** 读取并解析清单文件。 */
export function readBackupManifestFile(manifestPath: string, requestId: RequestId): Result<BackupManifest> {
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (thrown) {
    return errOf('NOT_FOUND_SNAPSHOT', '备份清单文件不存在或不可读。', requestId, {
      reason: errorReason(thrown),
    })
  }
  return parseBackupManifest(text, requestId)
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * 严格解析清单。
 *
 * 🔴 **不允许"宽松解析"**：缺字段就报 `STORAGE_CORRUPT`，不补默认值。
 *    恢复路径上任何"猜一个默认值"都会把损坏的备份当成好备份用下去。
 */
export function parseBackupManifest(text: string, requestId: RequestId): Result<BackupManifest> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (thrown) {
    return corrupt(requestId, '备份清单不是合法 JSON。', { reason: errorReason(thrown) })
  }
  if (!isRecord(raw)) return corrupt(requestId, '备份清单顶层必须是对象。', { field: '$' })

  const manifestVersion = raw.manifestVersion
  if (typeof manifestVersion !== 'number' || !Number.isInteger(manifestVersion)) {
    return corrupt(requestId, '备份清单缺少 manifestVersion。', { field: 'manifestVersion' })
  }
  if (manifestVersion > BACKUP_MANIFEST_VERSION) {
    // 清单比程序新：不猜字段语义，直接拒绝（与 STORAGE_SCHEMA_TOO_NEW 同一取向）。
    return errOf('STORAGE_SCHEMA_TOO_NEW', '备份清单版本高于当前程序支持的版本，请升级程序后再恢复。', requestId, {
      field: 'manifestVersion',
      found: manifestVersion,
      supported: BACKUP_MANIFEST_VERSION,
    })
  }

  const appVersionValue = raw.appVersion
  if (typeof appVersionValue !== 'string' || appVersionValue.length === 0) {
    return corrupt(requestId, '备份清单缺少 appVersion。', { field: 'appVersion' })
  }
  const databaseSchemaVersion = raw.databaseSchemaVersion
  if (typeof databaseSchemaVersion !== 'number' || !Number.isInteger(databaseSchemaVersion) || databaseSchemaVersion < 0) {
    return corrupt(requestId, '备份清单的 databaseSchemaVersion 不是非负整数。', { field: 'databaseSchemaVersion' })
  }
  const syncProtocolVersion = raw.syncProtocolVersion
  if (
    !isRecord(syncProtocolVersion) ||
    typeof syncProtocolVersion.major !== 'number' ||
    typeof syncProtocolVersion.minor !== 'number'
  ) {
    return corrupt(requestId, '备份清单缺少 syncProtocolVersion。', { field: 'syncProtocolVersion' })
  }
  const createdAt = raw.createdAt
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    return corrupt(requestId, '备份清单缺少 createdAt。', { field: 'createdAt' })
  }

  const databaseFile = raw.databaseFile
  if (!isRecord(databaseFile)) return corrupt(requestId, '备份清单缺少 databaseFile。', { field: 'databaseFile' })
  if (typeof databaseFile.fileName !== 'string' || databaseFile.fileName.length === 0) {
    return corrupt(requestId, '备份清单的 databaseFile.fileName 不合法。', { field: 'databaseFile.fileName' })
  }
  if (typeof databaseFile.sha256 !== 'string' || !SHA256_PATTERN.test(databaseFile.sha256)) {
    return corrupt(requestId, '备份清单的 databaseFile.sha256 不是 64 位小写十六进制。', {
      field: 'databaseFile.sha256',
    })
  }
  if (!isNonNegativeInteger(databaseFile.byteSize)) {
    return corrupt(requestId, '备份清单的 databaseFile.byteSize 不是非负整数。', { field: 'databaseFile.byteSize' })
  }

  const entityCounts = raw.entityCounts
  if (!isRecord(entityCounts)) return corrupt(requestId, '备份清单缺少 entityCounts。', { field: 'entityCounts' })
  const counts: Record<keyof BackupEntityCounts, number> = {
    projects: 0,
    documents: 0,
    settingsEntities: 0,
    assets: 0,
    revisions: 0,
    pluginData: 0,
    localDrafts: 0,
  }
  for (const key of Object.keys(counts) as (keyof BackupEntityCounts)[]) {
    const value = entityCounts[key]
    if (!isNonNegativeInteger(value)) {
      return corrupt(requestId, `备份清单的 entityCounts.${key} 不是非负整数。`, { field: `entityCounts.${key}` })
    }
    counts[key] = value
  }

  const migrationLedgerRaw = raw.migrationLedger
  if (!Array.isArray(migrationLedgerRaw)) {
    return corrupt(requestId, '备份清单缺少 migrationLedger。', { field: 'migrationLedger' })
  }
  const migrationLedger: BackupMigrationEntry[] = []
  for (const item of migrationLedgerRaw) {
    if (
      !isRecord(item) ||
      !isNonNegativeInteger(item.version) ||
      typeof item.name !== 'string' ||
      typeof item.checksum !== 'string' ||
      typeof item.appliedAt !== 'string'
    ) {
      return corrupt(requestId, '备份清单的 migrationLedger 存在不合法条目。', { field: 'migrationLedger' })
    }
    migrationLedger.push({
      version: item.version,
      name: item.name,
      checksum: item.checksum,
      appliedAt: item.appliedAt,
    })
  }

  const assetsRaw = raw.assets
  if (!Array.isArray(assetsRaw)) return corrupt(requestId, '备份清单缺少 assets。', { field: 'assets' })
  const assets: BackupAssetEntry[] = []
  for (const item of assetsRaw) {
    if (
      !isRecord(item) ||
      typeof item.assetId !== 'string' ||
      typeof item.workspaceId !== 'string' ||
      typeof item.storageKey !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !isNonNegativeInteger(item.byteSize) ||
      typeof item.localState !== 'string' ||
      typeof item.deleted !== 'boolean'
    ) {
      return corrupt(requestId, '备份清单的 assets 存在不合法条目。', { field: 'assets' })
    }
    assets.push({
      assetId: item.assetId,
      workspaceId: item.workspaceId,
      storageKey: item.storageKey,
      sha256: item.sha256,
      byteSize: item.byteSize,
      localState: item.localState,
      deleted: item.deleted,
    })
  }

  const workspacesRaw = raw.workspaces
  if (!Array.isArray(workspacesRaw)) return corrupt(requestId, '备份清单缺少 workspaces。', { field: 'workspaces' })
  const workspaces: BackupWorkspaceEntry[] = []
  for (const item of workspacesRaw) {
    if (
      !isRecord(item) ||
      typeof item.workspaceId !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.deleted !== 'boolean' ||
      !isNonNegativeInteger(item.projectCount) ||
      !isNonNegativeInteger(item.documentCount) ||
      !isNonNegativeInteger(item.assetCount) ||
      !isNonNegativeInteger(item.revisionCount)
    ) {
      return corrupt(requestId, '备份清单的 workspaces 存在不合法条目。', { field: 'workspaces' })
    }
    workspaces.push({
      workspaceId: item.workspaceId,
      name: item.name,
      deleted: item.deleted,
      projectCount: item.projectCount,
      documentCount: item.documentCount,
      assetCount: item.assetCount,
      revisionCount: item.revisionCount,
    })
  }

  // 🔴 containsSecrets 必须是字面量 false：清单里出现 true 说明产出方破坏了约定。
  if (raw.containsSecrets !== false) {
    return corrupt(requestId, '备份清单声明 containsSecrets 非 false，拒绝把可能含秘密的备份当作安全备份。', {
      field: 'containsSecrets',
    })
  }
  if (raw.attachmentFilesIncluded !== false) {
    return corrupt(requestId, '备份清单声明 attachmentFilesIncluded 非 false，当前版本不支持搬运附件二进制。', {
      field: 'attachmentFilesIncluded',
    })
  }

  return ok({
    manifestVersion,
    appVersion: appVersionValue,
    databaseSchemaVersion,
    syncProtocolVersion: { major: syncProtocolVersion.major, minor: syncProtocolVersion.minor },
    createdAt: createdAt as UtcTimestamp,
    databaseFile: {
      fileName: databaseFile.fileName,
      sha256: databaseFile.sha256,
      byteSize: databaseFile.byteSize,
    },
    migrationLedger,
    entityCounts: counts,
    assets,
    attachmentFilesIncluded: false,
    containsSecrets: false,
    workspaces,
  })
}

/** 由 schema 版本推出"需不需要迁移"，供恢复路径统一判定。 */
export function expectedSchemaVersion(): number {
  return DB_SCHEMA_VERSION
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 是否为本模块产出的清单文件名。 */
export function isBackupManifestPath(path: string): boolean {
  return path.endsWith(MANIFEST_EXTENSION)
}

/** 快照文件对应的默认清单路径。 */
export function defaultManifestPath(snapshotPath: string): string {
  return `${snapshotPath}${MANIFEST_EXTENSION}`
}

/** 统一的"损坏"错误：绝不静默降级。 */
export function corrupt(requestId: RequestId, message: string, detail?: Record<string, string | number>): Result<never> {
  return errOf('STORAGE_CORRUPT', message, requestId, detail)
}

function errorReason(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message
  return String(thrown)
}
