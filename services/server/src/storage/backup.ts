/**
 * 备份 / 校验 / 恢复（task-16 / P3-C5）。
 *
 * ## 为什么不能"复制主库文件"
 *
 * 服务端默认 `journal_mode = wal`：已提交的事务可能还躺在 `-wal` 里，主库文件
 * **本身不是一致的**。因此创建备份一律走 `backupServerDatabase`（SQLite 在线备份
 * API，见 `db/migrator.ts`），它给出的是"某个时刻的完整一致快照"。
 *
 * ## 为什么校验要做这么多步
 *
 * "文件存在"不等于"备份可用"。一次真实的恢复事故通常长这样：备份文件是半截的
 * （磁盘满/进程被杀）、或者表少了一张（某条 DDL 被静默吞掉）、或者备份来自更新
 * 的版本（旧程序打开新库会把不认识的字段**静默丢弃**，不可逆）。
 * 因此校验的顺序是：存在性 → 清单解析 → 字节数 → sha256 → 只读打开 +
 * `integrity_check` → 缺表 → 库版本与清单一致 → 比程序新则拒绝 →
 * 迁移台账版本 + 校验和 → 各表行数。
 *
 * 🔴 **任何一步失败都绝不当成"空库/新库"继续**：那会把"备份坏了"变成
 * "备份是空的，那就重新初始化吧"，直接把用户数据换成一堆空表。
 *
 * ## 恢复的原子性
 *
 * 校验源 → 复制到 `<target>.restoring` → **对副本再校验一次**（拦半截复制）→
 * 原子换名 → 对最终目标再校验。任一步失败都清理临时文件，不留损坏的目标库。
 *
 * ⚠️ 已知陷阱（`./localFs.ts` 的 `moveFile`）：它的语义是**内容寻址搬运**——
 * 目标已存在且大小相同时它会**删掉源文件**并返回 `false`。直接拿它做"覆盖式换名"
 * 会在"新旧库大小恰好相同"时把校验过的副本删掉、留下旧库。所以这里的
 * `atomicReplace` 先删目标再换名，并且换名后**必须再校验**。
 */

import { copyFileSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import type { RequestId, UtcTimestamp } from '@yfe/contracts'
import { APP_VERSION, checkSchemaCompat } from '@yfe/contracts'

import { SERVER_SCHEMA_VERSION, SERVER_TABLES } from '../db/ddl.js'
import type { AppliedMigration } from '../db/migrator.js'
import {
  appliedServerMigrations,
  backupServerDatabase,
  currentServerSchemaVersion,
  missingServerTables,
} from '../db/migrator.js'
import type { ServerDb } from '../db/open.js'
import { closeServerDatabase, openServerDatabase } from '../db/open.js'
import {
  ensureDir,
  fileSizeOrNull,
  fsErrnoOf,
  isRegularFile,
  listFilesRecursive,
  moveFile,
  pathExists,
  removeFileIfExists,
  sha256OfFile,
  writeFileBytes,
} from './localFs.js'
import { isWithinRoot, resolveUnderRoot, StoragePathError } from './paths.js'
import { errorCodeForFsFailure, fail, pathViolationError, type StorageErrorDetail } from './probe.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 清单格式版本。清单结构变化必须 +1，校验时只认这一个值。 */
export const BACKUP_MANIFEST_VERSION = 1

export const BACKUP_FILE_SUFFIX = '.db'
export const BACKUP_MANIFEST_SUFFIX = '.manifest.json'
/** 恢复过程中的临时副本后缀（与目标同目录，保证 rename 不跨卷）。 */
export const BACKUP_RESTORE_TEMP_SUFFIX = '.restoring'

/** 期望的表名单：`SERVER_TABLES` 是对象映射，用 `Object.values` 取表名。 */
export const EXPECTED_SERVER_TABLES: readonly string[] = Object.values(SERVER_TABLES)

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

export interface BackupManifestMigration {
  readonly version: number
  readonly checksum: string
  readonly appliedAt: string
  readonly success: boolean
}

export interface BackupManifestTableCount {
  readonly table: string
  readonly rows: number
}

/**
 * 备份清单。
 *
 * `containsSecrets: false` 是**声明**而不是探测结果：备份集只有数据库文件，
 * 数据库里存的是口令哈希（scrypt）与随机 token，没有可复原的明文秘密。
 * 附件二进制**不在**备份集内（见文件尾"未做"说明）。
 */
export interface BackupManifest {
  readonly manifestVersion: number
  readonly appVersion: string
  /** 备份里那个库文件自身的 schema 版本。 */
  readonly databaseSchemaVersion: number
  /** 生成备份的程序期望的版本，用于识别"库比程序新"。 */
  readonly serverSchemaVersion: number
  readonly database: {
    readonly fileName: string
    readonly sha256: string
    readonly bytes: number
  }
  readonly migrations: readonly BackupManifestMigration[]
  readonly tables: readonly BackupManifestTableCount[]
  readonly tableCount: number
  readonly totalRows: number
  readonly createdAt: UtcTimestamp
  readonly containsSecrets: false
  readonly attachmentsIncluded: false
}

/** 清单解析失败一律 `STORAGE_CORRUPT`：这是磁盘上的文件坏了，不是入参问题。 */
function corrupt(requestId: RequestId, reason: string, message: string, extra: StorageErrorDetail = {}): never {
  fail('STORAGE_CORRUPT', message, requestId, { reason, ...extra })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  requestId: RequestId,
  reason: string,
): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    corrupt(requestId, reason, '备份清单损坏或不完整。', { field: key })
  }
  return value
}

function requireInteger(
  source: Record<string, unknown>,
  key: string,
  requestId: RequestId,
  reason: string,
): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    corrupt(requestId, reason, '备份清单损坏或不完整。', { field: key })
  }
  return value
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function requireSha256(
  source: Record<string, unknown>,
  key: string,
  requestId: RequestId,
  reason: string,
): string {
  const value = requireString(source, key, requestId, reason)
  if (!SHA256_HEX.test(value)) {
    corrupt(requestId, reason, '备份清单损坏：校验和格式不正确。', { field: key })
  }
  return value
}

function requireBoolean(
  source: Record<string, unknown>,
  key: string,
  requestId: RequestId,
  reason: string,
  expected?: boolean,
): boolean {
  const value = source[key]
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) {
    corrupt(requestId, reason, '备份清单损坏或不完整。', { field: key })
  }
  return value
}

function requireArray(
  source: Record<string, unknown>,
  key: string,
  requestId: RequestId,
  reason: string,
): readonly unknown[] {
  const value = source[key]
  if (!Array.isArray(value)) {
    corrupt(requestId, reason, '备份清单损坏或不完整。', { field: key })
  }
  return value as readonly unknown[]
}

/**
 * 严格解析清单。**缺字段即损坏**，不做"缺了就用默认值"的宽容解析：
 * 宽容解析会把"清单被截断"读成"清单说没有表"，正好是最危险的失败方向。
 */
export function parseBackupManifest(raw: unknown, requestId: RequestId): BackupManifest {
  const root = asRecord(raw)
  if (root === null) corrupt(requestId, 'manifest_not_object', '备份清单不是 JSON 对象。')

  const manifestVersion = requireInteger(root, 'manifestVersion', requestId, 'manifest_field_invalid')
  if (manifestVersion !== BACKUP_MANIFEST_VERSION) {
    corrupt(requestId, 'manifest_version_unsupported', '备份清单版本不受支持。', { manifestVersion })
  }

  const database = asRecord(root['database'])
  if (database === null) corrupt(requestId, 'manifest_field_invalid', '备份清单损坏或不完整。', {
    field: 'database',
  })

  const migrationsRaw = requireArray(root, 'migrations', requestId, 'manifest_field_invalid')
  const migrations: BackupManifestMigration[] = migrationsRaw.map((item) => {
    const record = asRecord(item)
    if (record === null) corrupt(requestId, 'manifest_migration_invalid', '备份清单的迁移台账损坏。')
    return {
      version: requireInteger(record, 'version', requestId, 'manifest_migration_invalid'),
      checksum: requireString(record, 'checksum', requestId, 'manifest_migration_invalid'),
      appliedAt: requireString(record, 'appliedAt', requestId, 'manifest_migration_invalid'),
      success: requireBoolean(record, 'success', requestId, 'manifest_migration_invalid'),
    }
  })

  const tablesRaw = requireArray(root, 'tables', requestId, 'manifest_field_invalid')
  const tables: BackupManifestTableCount[] = tablesRaw.map((item) => {
    const record = asRecord(item)
    if (record === null) corrupt(requestId, 'manifest_table_invalid', '备份清单的表行数损坏。')
    return {
      table: requireString(record, 'table', requestId, 'manifest_table_invalid'),
      rows: requireInteger(record, 'rows', requestId, 'manifest_table_invalid'),
    }
  })

  return {
    manifestVersion,
    appVersion: requireString(root, 'appVersion', requestId, 'manifest_field_invalid'),
    databaseSchemaVersion: requireInteger(root, 'databaseSchemaVersion', requestId, 'manifest_field_invalid'),
    serverSchemaVersion: requireInteger(root, 'serverSchemaVersion', requestId, 'manifest_field_invalid'),
    database: {
      fileName: requireString(database, 'fileName', requestId, 'manifest_field_invalid'),
      sha256: requireSha256(database, 'sha256', requestId, 'manifest_field_invalid'),
      bytes: requireInteger(database, 'bytes', requestId, 'manifest_field_invalid'),
    },
    migrations,
    tables,
    tableCount: requireInteger(root, 'tableCount', requestId, 'manifest_field_invalid'),
    totalRows: requireInteger(root, 'totalRows', requestId, 'manifest_field_invalid'),
    createdAt: requireString(root, 'createdAt', requestId, 'manifest_field_invalid') as UtcTimestamp,
    // 只接受 `false`：清单如果声称"含秘密"，校验不该放行；声称 `true` 的也当成损坏，
    // 因为生成侧只写 `false`，出现别的值说明清单被人改过。
    containsSecrets: requireBoolean(root, 'containsSecrets', requestId, 'manifest_field_invalid', false) as false,
    attachmentsIncluded: requireBoolean(
      root,
      'attachmentsIncluded',
      requestId,
      'manifest_field_invalid',
    ) as false,
  }
}

/** 清单文件路径与备份文件同目录同名（`<backup>.db.manifest.json`）。 */
export function manifestPathFor(databasePath: string): string {
  return `${databasePath}${BACKUP_MANIFEST_SUFFIX}`
}

export function readBackupManifest(databasePath: string, requestId: RequestId): BackupManifest {
  const path = manifestPathFor(databasePath)
  if (!pathExists(path)) {
    corrupt(requestId, 'manifest_missing', '备份缺少清单文件，无法确认完整性。', {
      fileName: basename(databasePath),
    })
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (thrown) {
    fail('STORAGE_CORRUPT', '无法读取备份清单。', requestId, {
      reason: 'manifest_unreadable',
      fileName: basename(databasePath),
      errno: errorCodeForFsFailure(thrown),
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    corrupt(requestId, 'manifest_not_json', '备份清单不是合法 JSON。', {
      fileName: basename(databasePath),
    })
  }
  return parseBackupManifest(parsed, requestId)
}

// ---------------------------------------------------------------------------
// 只读检视
// ---------------------------------------------------------------------------

type ServerDbLike = ServerDb

export interface DatabaseInspection {
  /** `PRAGMA integrity_check` 的原文（正常为 `ok`）。 */
  readonly integrityCheck: string
  readonly missingTables: readonly string[]
  readonly databaseSchemaVersion: number
  readonly migrations: readonly AppliedMigration[]
  readonly tables: readonly BackupManifestTableCount[]
}

/** 只统计**期望表名单**里的表：表名来自常量，绝不用调用方传进来的字符串拼 SQL。 */
function countRows(db: ServerDbLike, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).get() as { rows?: number } | undefined
  return typeof row?.rows === 'number' ? row.rows : 0
}

function tableRowCounts(db: ServerDbLike): readonly BackupManifestTableCount[] {
  const present = EXPECTED_SERVER_TABLES.filter(
    (table) => missingServerTables(db, [table]).length === 0,
  )
  return present.map((table) => ({ table, rows: countRows(db, table) }))
}

/**
 * 只读打开一个库文件并检视它（不修改任何东西）。
 *
 * 用 `readOnly: true` 打开：`openServerDatabase` 的独占写连接断言在只读模式下
 * 自动失效，所以检视一个"正被主进程打开着"的库文件也不会撞 `RESOURCE_LOCKED`。
 */
export function inspectDatabaseFile(
  databasePath: string,
  requestId: RequestId,
  options: { readonly withRowCounts?: boolean; readonly checkIntegrity?: boolean } = {},
): DatabaseInspection {
  // SQLite 以 WAL 模式打开任何库都会顺手建 `<db>-wal` / `<db>-shm`。校验必须是
  // 「只读且无副作用」的：记下打开前有哪些旁挂文件，关库后只删掉**这次**新生成的。
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`]
  const preexistingSidecars = sidecars.map((candidate) => pathExists(candidate))
  let db: ServerDbLike
  try {
    db = openServerDatabase(databasePath, { readOnly: true, fileMustExist: true })
  } catch (thrown) {
    fail('STORAGE_CORRUPT', '备份无法被只读打开，可能已损坏或不是 SQLite 数据库。', requestId, {
      reason: 'open_failed',
      fileName: basename(databasePath),
      errno: errorCodeForFsFailure(thrown),
    })
  }
  try {
    const result = db.pragma('integrity_check', { simple: true })
    const integrityCheck = typeof result === 'string' ? result : String(result)
    if (options.checkIntegrity !== false && integrityCheck !== 'ok') {
      corrupt(requestId, 'integrity_check_failed', '备份未通过 SQLite 完整性检查。', {
        fileName: basename(databasePath),
        integrity: integrityCheck.slice(0, 120),
      })
    }
    return {
      integrityCheck,
      missingTables: missingServerTables(db, EXPECTED_SERVER_TABLES),
      databaseSchemaVersion: currentServerSchemaVersion(db),
      migrations: appliedServerMigrations(db),
      tables: options.withRowCounts === true ? tableRowCounts(db) : [],
    }
  } finally {
    closeServerDatabase(db)
    removeSidecarsCreatedByUs(sidecars, preexistingSidecars)
  }
}

function removeSidecarsCreatedByUs(sidecars: readonly string[], preexisting: readonly boolean[]): void {
  sidecars.forEach((candidate, index) => {
    if (preexisting[index] === true) return
    try {
      removeFileIfExists(candidate)
    } catch {
      // 清理旁挂文件失败不能把一次成功的校验变成失败，也不影响备份本身是否完整。
    }
  })
}

function assertNoMissingTables(inspection: DatabaseInspection, requestId: RequestId, fileName: string): void {
  if (inspection.missingTables.length === 0) return
  corrupt(requestId, 'missing_table', '备份缺少必要的数据库表。', {
    fileName,
    missingTable: inspection.missingTables[0] ?? null,
    missingCount: inspection.missingTables.length,
  })
}

// ---------------------------------------------------------------------------
// 创建备份
// ---------------------------------------------------------------------------

export interface CreateStorageBackupOptions {
  readonly backupRoot: string
  readonly createdAt: UtcTimestamp
  readonly requestId: RequestId
  /** 应用版本，写进清单。默认取契约里的 `APP_VERSION`。 */
  readonly appVersion?: string
  /** 只允许**纯文件名**，最终仍走 `./paths.ts` 解析成绝对路径。 */
  readonly fileName?: string
}

export interface CreatedStorageBackup {
  readonly databasePath: string
  readonly manifestPath: string
  readonly fileName: string
  readonly bytes: number
  readonly sha256: string
  readonly manifest: BackupManifest
}

/** 备份文件名：`yfe-backup-<UTC 时间戳去分隔符>.db`。 */
export function backupFileName(createdAt: UtcTimestamp): string {
  const compact = createdAt.replace(/[^0-9]/g, '').slice(0, 14)
  return `yfe-backup-${compact}${BACKUP_FILE_SUFFIX}`
}

/** 目标文件名的入参校验（分隔符与保留名交给 `resolveUnderRoot`）。 */
export function assertBackupFileName(fileName: string, requestId: RequestId, field = 'fileName'): string {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    fail('VALIDATION_MISSING_FIELD', '缺少必填字段：fileName', requestId, { field })
  }
  if (fileName.includes('/') || fileName.includes('\\')) {
    fail('VALIDATION_FAILED', '备份文件名只能是纯文件名，不能包含路径分隔符。', requestId, {
      field,
      reason: 'separator_in_file_name',
    })
  }
  return fileName
}

/**
 * 创建一致备份 + 清单。
 *
 * 失败语义（都是"不留半截文件"）：
 * - 目标已存在 → 409 `ALREADY_EXISTS`（不覆盖已有备份）；
 * - 磁盘满 → `STORAGE_DISK_FULL`，删掉半截的备份文件；
 * - 只读 → `STORAGE_READ_ONLY`，同样不留半截文件。
 */
export async function createStorageBackup(
  db: ServerDbLike,
  options: CreateStorageBackupOptions,
): Promise<CreatedStorageBackup> {
  const { backupRoot, createdAt, requestId } = options
  const requested = options.fileName ?? backupFileName(createdAt)
  assertBackupFileName(requested, requestId)

  let databasePath: string
  try {
    databasePath = resolveUnderRoot(backupRoot, requested, 'fileName')
  } catch (thrown) {
    if (thrown instanceof StoragePathError) pathViolationError(thrown, requestId, 'fileName')
    throw thrown
  }
  const manifestPath = manifestPathFor(databasePath)
  const fileName = basename(databasePath)

  if (pathExists(databasePath) || pathExists(manifestPath)) {
    fail('ALREADY_EXISTS', '同名备份已存在，请换一个文件名。', requestId, {
      reason: 'backup_exists',
      fileName,
    })
  }

  ensureDir(backupRoot)
  try {
    await backupServerDatabase(db, databasePath)
  } catch (thrown) {
    removeFileIfExists(databasePath)
    fail(errorCodeForFsFailure(thrown), '创建备份失败，未留下半截文件。', requestId, {
      reason: 'backup_write_failed',
      fileName,
    })
  }

  const bytes = fileSizeOrNull(databasePath)
  if (bytes === null) {
    removeFileIfExists(databasePath)
    fail('STORAGE_UNAVAILABLE', '备份文件写入后不可见。', requestId, { reason: 'backup_missing_after_write', fileName })
  }

  // 检视一次刚写出来的备份：如果它本身缺表/版本不对，宁可现在失败，
  // 也不要留一份"看起来成功、恢复时才发现不可用"的备份。
  const inspection = inspectDatabaseFile(databasePath, requestId, { withRowCounts: true })
  assertNoMissingTables(inspection, requestId, fileName)

  let sha256: string
  try {
    sha256 = await sha256OfFile(databasePath)
  } catch (thrown) {
    removeFileIfExists(databasePath)
    fail(errorCodeForFsFailure(thrown), '备份写入后无法计算校验和。', requestId, {
      reason: 'backup_hash_failed',
      fileName,
    })
  }

  const manifest: BackupManifest = {
    manifestVersion: BACKUP_MANIFEST_VERSION,
    appVersion: options.appVersion ?? APP_VERSION,
    databaseSchemaVersion: inspection.databaseSchemaVersion,
    serverSchemaVersion: SERVER_SCHEMA_VERSION,
    database: { fileName, sha256, bytes },
    migrations: inspection.migrations.map((migration) => ({
      version: migration.version,
      checksum: migration.checksum,
      appliedAt: migration.appliedAt,
      success: migration.success,
    })),
    tables: inspection.tables,
    tableCount: inspection.tables.length,
    totalRows: inspection.tables.reduce((sum, item) => sum + item.rows, 0),
    createdAt,
    containsSecrets: false,
    attachmentsIncluded: false,
  }

  try {
    writeFileBytes(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  } catch (thrown) {
    // 清单写不进去 ⇒ 备份集不完整，连库文件一起收掉（否则下次创建会 409）。
    removeFileIfExists(manifestPath)
    removeFileIfExists(databasePath)
    fail(errorCodeForFsFailure(thrown), '写入备份清单失败，已清理不完整的备份。', requestId, {
      reason: 'manifest_write_failed',
      fileName,
    })
  }

  return { databasePath, manifestPath, fileName, bytes, sha256, manifest }
}

// ---------------------------------------------------------------------------
// 列出备份
// ---------------------------------------------------------------------------

export interface BackupListEntry {
  readonly fileName: string
  readonly bytes: number
  readonly modifiedAt: UtcTimestamp
  readonly hasManifest: boolean
}

/**
 * 列出备份目录里的备份文件。
 *
 * 只回文件名（**绝不回绝对路径**）：绝对路径会带出操作系统的用户名，
 * 而客户端拿文件名就能调用后续接口（路径由服务端在备份根下解析）。
 * 用 `localFs.listFilesRecursive`（不跟随符号链接）而不是自己 walk，
 * 避免把链接指向的外部文件"算成"自己的备份。
 */
export function listStorageBackups(backupRoot: string, requestId: RequestId): readonly BackupListEntry[] {
  if (!pathExists(backupRoot)) return []
  let names: readonly string[]
  try {
    names = listFilesRecursive(backupRoot)
  } catch (thrown) {
    fail(errorCodeForFsFailure(thrown), '无法读取备份目录。', requestId, { reason: 'backup_dir_unreadable' })
  }
  const entries: BackupListEntry[] = []
  for (const relative of names) {
    if (!relative.endsWith(BACKUP_FILE_SUFFIX)) continue
    if (relative.includes('/') || relative.includes('\\')) continue
    const absolute = resolveUnderRoot(backupRoot, relative, 'fileName')
    let modifiedAt: UtcTimestamp
    let bytes: number
    try {
      const stats = statSync(absolute)
      if (!stats.isFile()) continue
      bytes = stats.size
      modifiedAt = stats.mtime.toISOString() as UtcTimestamp
    } catch {
      // 列表是"尽力而为"的展示：单个文件 stat 失败不应该让整个列表 500。
      continue
    }
    entries.push({
      fileName: relative,
      bytes,
      modifiedAt,
      hasManifest: pathExists(manifestPathFor(absolute)),
    })
  }
  return entries.sort((a, b) => (a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0))
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface VerifyStorageBackupOptions {
  readonly databasePath: string
  /** 备份根：不在根内（且未显式批准外部）一律拒绝。 */
  readonly backupRoot: string
  readonly requestId: RequestId
  /** 程序当前期望的 schema 版本，默认 `SERVER_SCHEMA_VERSION`。 */
  readonly expectedSchemaVersion?: number
  /** 管理员对"dataDir 之外的备份位置"的显式批准。 */
  readonly allowExternal?: boolean
}

export interface VerifiedStorageBackup {
  readonly databasePath: string
  readonly fileName: string
  readonly manifestPath: string
  readonly manifest: BackupManifest
  readonly bytes: number
  readonly sha256: string
  readonly integrityCheck: string
  readonly databaseSchemaVersion: number
  readonly migrations: readonly BackupManifestMigration[]
  readonly tables: readonly BackupManifestTableCount[]
  /** 已完成的校验步骤名，供管理页展示"这份备份到底验过什么"。 */
  readonly checks: readonly string[]
}

function assertWithinBackupRoot(databasePath: string, backupRoot: string, allowExternal: boolean, requestId: RequestId): void {
  if (allowExternal || isWithinRoot(backupRoot, databasePath)) return
  fail('PERMISSION_DENIED', '备份文件在备份目录之外，需要显式批准外部位置。', requestId, {
    reason: 'external_backup_requires_acknowledge',
    fileName: basename(databasePath),
  })
}

function requireRegularBackupFile(databasePath: string, requestId: RequestId): number {
  const fileName = basename(databasePath)
  if (!pathExists(databasePath)) {
    fail('NOT_FOUND', '备份文件不存在。', requestId, { reason: 'backup_missing', fileName })
  }
  if (!isRegularFile(databasePath)) {
    corrupt(requestId, 'backup_not_regular_file', '备份路径不是普通文件。', { fileName })
  }
  const bytes = fileSizeOrNull(databasePath)
  if (bytes === null) {
    fail('STORAGE_UNAVAILABLE', '备份文件状态不可读。', requestId, { reason: 'backup_stat_failed', fileName })
  }
  return bytes
}

/**
 * 校验一份备份。失败即抛**具体**的契约错误，绝不返回"看起来还行"的半结果。
 *
 * 错误码分工：
 * - `NOT_FOUND`：备份文件不存在；
 * - `STORAGE_CORRUPT`：清单缺失/损坏、字节数不符、sha256 不符、完整性检查失败、
 *   缺表、库版本与清单不一致、迁移台账不一致、行数不符；
 * - `STORAGE_SCHEMA_TOO_NEW`：库比程序新——**必须拒绝**，不能"尽力打开"；
 * - `PERMISSION_DENIED`：备份在批准范围之外。
 */
export async function verifyStorageBackup(options: VerifyStorageBackupOptions): Promise<VerifiedStorageBackup> {
  const { databasePath, backupRoot, requestId } = options
  const expectedSchema = options.expectedSchemaVersion ?? SERVER_SCHEMA_VERSION
  const fileName = basename(databasePath)
  const checks: string[] = []

  assertWithinBackupRoot(databasePath, backupRoot, options.allowExternal === true, requestId)

  // 1. 存在性 + 普通文件
  const bytes = requireRegularBackupFile(databasePath, requestId)
  checks.push('exists')

  // 2. 清单解析（严格）
  const manifestPath = manifestPathFor(databasePath)
  const manifest = readBackupManifest(databasePath, requestId)
  checks.push('manifest')

  // 3. 字节数
  if (manifest.database.bytes !== bytes) {
    corrupt(requestId, 'size_mismatch', '备份字节数与清单不一致。', {
      fileName,
      expectedBytes: manifest.database.bytes,
      actualBytes: bytes,
    })
  }
  checks.push('bytes')

  // 4. sha256（篡改一个字节就会在这里失败）
  const sha256 = await sha256OfFile(databasePath)
  if (sha256 !== manifest.database.sha256) {
    corrupt(requestId, 'sha256_mismatch', '备份校验和与清单不一致，文件已被改动。', { fileName })
  }
  checks.push('sha256')

  // 5. 只读打开 + integrity_check + 缺表
  const inspection = inspectDatabaseFile(databasePath, requestId, { withRowCounts: true })
  checks.push('integrity_check')
  assertNoMissingTables(inspection, requestId, fileName)
  checks.push('tables_present')

  // 6. 库版本与清单一致
  if (inspection.databaseSchemaVersion !== manifest.databaseSchemaVersion) {
    corrupt(requestId, 'schema_version_mismatch', '备份的库版本与清单不一致。', {
      fileName,
      manifestedVersion: manifest.databaseSchemaVersion,
      actualVersion: inspection.databaseSchemaVersion,
    })
  }
  checks.push('schema_version')

  // 7. 库比程序新 ⇒ 拒绝（不能"尽力打开"）
  const compat = checkSchemaCompat(inspection.databaseSchemaVersion, expectedSchema)
  if (compat === 'too-new') {
    fail('STORAGE_SCHEMA_TOO_NEW', '备份来自更新的程序版本，当前版本无法安全打开它。', requestId, {
      reason: 'schema_too_new',
      fileName,
      databaseSchemaVersion: inspection.databaseSchemaVersion,
      serverSchemaVersion: expectedSchema,
    })
  }
  checks.push('schema_compatible')

  // 8. 迁移台账版本 + 校验和
  const actualMigrations = inspection.migrations
    .filter((migration) => migration.success)
    .map((migration) => ({
      version: migration.version,
      checksum: migration.checksum,
      appliedAt: migration.appliedAt,
      success: migration.success,
    }))
  const manifested = manifest.migrations.filter((migration) => migration.success)
  if (manifested.length !== actualMigrations.length) {
    corrupt(requestId, 'migration_ledger_mismatch', '备份的迁移台账与清单不一致。', {
      fileName,
      manifestedCount: manifested.length,
      actualCount: actualMigrations.length,
    })
  }
  for (const [index, expected] of manifested.entries()) {
    const actual = actualMigrations[index]
    if (actual === undefined || actual.version !== expected.version || actual.checksum !== expected.checksum) {
      corrupt(requestId, 'migration_checksum_mismatch', '备份的迁移校验和与清单不一致。', {
        fileName,
        version: expected.version,
      })
    }
  }
  checks.push('migrations')

  // 9. 各表行数
  const counts = new Map(inspection.tables.map((item) => [item.table, item.rows]))
  for (const expected of manifest.tables) {
    const actual = counts.get(expected.table)
    if (actual === undefined) {
      corrupt(requestId, 'table_missing_in_backup', '备份缺少清单里记录的表。', {
        fileName,
        missingTable: expected.table,
      })
    }
    if (actual !== expected.rows) {
      corrupt(requestId, 'row_count_mismatch', '备份的表行数与清单不一致。', {
        fileName,
        table: expected.table,
        expectedRows: expected.rows,
        actualRows: actual,
      })
    }
  }
  checks.push('row_counts')

  return {
    databasePath,
    fileName,
    manifestPath,
    manifest,
    bytes,
    sha256,
    integrityCheck: inspection.integrityCheck,
    databaseSchemaVersion: inspection.databaseSchemaVersion,
    migrations: actualMigrations,
    tables: inspection.tables,
    checks,
  }
}

/**
 * 校验一个"没有清单"的库文件（恢复过程中对副本/最终目标的复核）。
 *
 * 比 `verifyStorageBackup` 轻：没有清单可用，只验结构（字节数 + 只读打开 +
 * 完整性检查 + 表齐全）。sha256 的对比由调用方在异步路径里做（见下一函数）。
 */
export function verifyCopiedDatabaseFile(
  databasePath: string,
  options: { readonly requestId: RequestId; readonly expectedBytes: number },
): DatabaseInspection {
  const fileName = basename(databasePath)
  const bytes = requireRegularBackupFile(databasePath, options.requestId)
  if (bytes !== options.expectedBytes) {
    corrupt(options.requestId, 'copy_size_mismatch', '恢复副本字节数与源不一致（复制被截断）。', {
      fileName,
      expectedBytes: options.expectedBytes,
      actualBytes: bytes,
    })
  }
  const inspection = inspectDatabaseFile(databasePath, options.requestId, { withRowCounts: false })
  assertNoMissingTables(inspection, options.requestId, fileName)
  return inspection
}

/** 异步版副本复核：先比 sha256 再检视结构。 */
export async function verifyCopiedDatabaseFileWithHash(
  databasePath: string,
  options: {
    readonly requestId: RequestId
    readonly expectedBytes: number
    readonly expectedSha256: string
  },
): Promise<DatabaseInspection> {
  const fileName = basename(databasePath)
  const bytes = requireRegularBackupFile(databasePath, options.requestId)
  if (bytes !== options.expectedBytes) {
    corrupt(options.requestId, 'copy_size_mismatch', '恢复副本字节数与源不一致（复制被截断）。', {
      fileName,
      expectedBytes: options.expectedBytes,
      actualBytes: bytes,
    })
  }
  const sha256 = await sha256OfFile(databasePath)
  if (sha256 !== options.expectedSha256) {
    corrupt(options.requestId, 'copy_hash_mismatch', '恢复副本校验和与源不一致。', { fileName })
  }
  const inspection = inspectDatabaseFile(databasePath, options.requestId, { withRowCounts: false })
  assertNoMissingTables(inspection, options.requestId, fileName)
  return inspection
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/**
 * 原子换名。
 *
 * 🔴 必须先把目标删掉再 `moveFile`：`localFs.moveFile` 在"目标已存在且大小相同"
 * 时会**删源文件**并返回 `false`（内容寻址语义），那样会把刚校验过的副本弄丢。
 */
/** 只判断"是不是目录"；不存在/ENOTDIR 都算 false。 */
function isDirectoryOf(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch (thrown) {
    if (fsErrnoOf(thrown) === 'ENOENT' || fsErrnoOf(thrown) === 'ENOTDIR') return false
    throw thrown
  }
}

function atomicReplace(from: string, to: string, requestId: RequestId): void {
  if (pathExists(to)) {
    removeFileIfExists(to)
  }
  let moved: boolean
  try {
    moved = moveFile(from, to)
  } catch (thrown) {
    fail(errorCodeForFsFailure(thrown), '恢复时无法替换目标文件。', requestId, {
      reason: 'rename_failed',
      fileName: basename(to),
    })
  }
  if (!moved) {
    fail('INTERNAL_ERROR', '恢复时目标文件未被替换。', requestId, {
      reason: 'rename_skipped',
      fileName: basename(to),
    })
  }
}

export interface RestoreStorageBackupOptions {
  readonly requestId: RequestId
  /** 已经过探针规则校验的源文件绝对路径。 */
  readonly sourcePath: string
  /** 目标库绝对路径（通常就是 `config.databasePath`）。 */
  readonly targetPath: string
  readonly overwrite: boolean
  /**
   * 对**副本**与**最终目标**执行的复核。路由注入的版本会做 sha256 + 只读打开 +
   * 缺表校验；测试可以注入一个必然失败的复核来验证"失败不留损坏目标库"。
   */
  readonly verifyDatabase: (databasePath: string) => void
  /** 清理临时文件失败时的兜底日志（清理失败不掩盖原始错误）。 */
  readonly onCleanupFailure?: (message: string) => void
}

export interface RestoredStorageBackup {
  readonly sourcePath: string
  readonly targetPath: string
  readonly bytes: number
  readonly sha256: string
  readonly backupFileName: string
}

/**
 * 恢复一份备份到目标路径。
 *
 * 顺序（每一步都在"目标库"被破坏之前完成校验）：
 * 1. 源必须是普通文件，算出字节数与 sha256；
 * 2. 目标已存在且未 `overwrite` ⇒ 409（**先检查，后动手**）；
 * 3. 复制到 `<target>.restoring`；
 * 4. 对副本再校验（拦半截复制）；
 * 5. 原子换名；
 * 6. 对最终目标再校验。
 *
 * 有且只有第 5 步是不可逆的：一旦换名生效，旧目标就没了。所以第 1–4 步的任何
 * 失败都不会碰目标；第 6 步失败则删掉目标（宁可"没有库"也不要"坏库被当成好库"
 * 继续跑，那才是真正的静默数据损坏）。调用方（路由）必须已经完成
 * 系统管理员 + 维护模式 + 二次认证三道闸门。
 */
export async function restoreStorageBackup(
  options: RestoreStorageBackupOptions,
): Promise<RestoredStorageBackup> {
  const { requestId, sourcePath, targetPath } = options
  const backupFileName = basename(sourcePath)
  const tempPath = `${targetPath}${BACKUP_RESTORE_TEMP_SUFFIX}`

  const cleanup = (path: string): void => {
    try {
      removeFileIfExists(path)
    } catch (thrown) {
      options.onCleanupFailure?.(`恢复临时文件清理失败：${path}（${errorCodeForFsFailure(thrown)}）`)
    }
  }

  // 1. 源
  const bytes = requireRegularBackupFile(sourcePath, requestId)
  const sha256 = await sha256OfFile(sourcePath)

  // 2. 目标已存在？
  if (pathExists(targetPath)) {
    if (isDirectoryOf(targetPath)) {
      // 目标是目录：这不是"覆盖"能表达的事（覆盖一个目录的语义是删掉它），
      // 直接拒掉，而不是让后面的 rename 撞 EPERM 变成 500。
      fail('STATE_INVALID_TRANSITION', '目标路径是一个目录，恢复需要一个文件路径。', requestId, {
        reason: 'target_is_directory',
        targetFileName: basename(targetPath),
      })
    }
    if (!options.overwrite) {
      fail('ALREADY_EXISTS', '目标库已存在。恢复会覆盖它，请显式确认覆盖。', requestId, {
        reason: 'target_exists',
        targetFileName: basename(targetPath),
      })
    }
  }

  // 3. 复制到副本（先清掉上一次崩溃留下的残骸）
  ensureDir(dirname(targetPath))
  cleanup(tempPath)
  try {
    copyFileSync(sourcePath, tempPath)
  } catch (thrown) {
    cleanup(tempPath)
    fail(errorCodeForFsFailure(thrown), '复制备份失败，目标库未被改动。', requestId, {
      reason: 'copy_failed',
      backupFileName,
    })
  }

  // 4. 副本校验（拦"半截复制"）
  try {
    await verifyCopiedDatabaseFileWithHash(tempPath, { requestId, expectedBytes: bytes, expectedSha256: sha256 })
    options.verifyDatabase(tempPath)
  } catch (thrown) {
    cleanup(tempPath)
    throw thrown
  }

  // 5. 原子换名（唯一不可逆的一步）
  try {
    atomicReplace(tempPath, targetPath, requestId)
  } catch (thrown) {
    cleanup(tempPath)
    throw thrown
  }

  // 6. 最终目标再校验
  try {
    const finalBytes = fileSizeOrNull(targetPath)
    if (finalBytes !== bytes) {
      corrupt(requestId, 'restored_size_mismatch', '恢复后的目标库字节数不正确。', {
        targetFileName: basename(targetPath),
        expectedBytes: bytes,
        actualBytes: finalBytes ?? null,
      })
    }
    const finalSha = await sha256OfFile(targetPath)
    if (finalSha !== sha256) {
      corrupt(requestId, 'restored_hash_mismatch', '恢复后的目标库校验和不正确。', {
        targetFileName: basename(targetPath),
      })
    }
    options.verifyDatabase(targetPath)
  } catch (thrown) {
    // 留下的库已被证明不可信：删掉它，让"没有库"显式失败，而不是让坏库顶着用。
    cleanup(targetPath)
    throw thrown
  }

  return { sourcePath, targetPath, bytes, sha256, backupFileName }
}
