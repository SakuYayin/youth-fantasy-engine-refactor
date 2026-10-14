/**
 * 恢复点校验与恢复。
 *
 * 设计判据：
 * - `06-数据与本地存储.md:73`：**备份恢复先在隔离目录验证，再切换服务**；
 *   独立备份保留误删前版本，同步不是备份。
 * - `11-测试验收与迁移.md:48`：备份恢复必须在新实例完成正文/引用/附件校验，
 *   **不能只验证"备份文件存在"**。
 * - `06-数据与本地存储.md:69`：库比程序新时**拒绝写入**并提供兼容导出或恢复指引。
 *
 * 🔴 两条铁律：
 *    1. **校验失败绝不当成空库**：缺表、摘要不符、计数不符、版本过高都直接报错，
 *       绝不"尽力打开"。把损坏备份当空库恢复，等于用户拿回一个空工作区。
 *    2. **失败不留损坏目标**：先复制到 `<target>.restoring` 并完整校验，再原子换名。
 *       中途失败只删临时副本，原有文件保持原样。
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  checkSchemaCompat,
  errOf,
  ok,
  type RequestId,
  type Result,
  type SchemaCompat,
} from '@yfe/contracts'

import {
  DESKTOP_TABLE_NAMES,
  SCHEMA_MIGRATIONS_TABLE,
  closeDatabase,
  isMemoryPath,
  openDatabase,
  readPragma,
  readSchemaVersion,
  type SqliteDatabase,
} from '../schema/index.js'
import { fsError, reasonOf } from './fsErrors.js'
import {
  corrupt,
  defaultManifestPath,
  readBackupFacts,
  readBackupManifestFile,
  serializeBackupManifest,
  sha256OfFile,
  type BackupEntityCounts,
  type BackupManifest,
} from './manifest.js'

export interface VerifyBackupInput {
  readonly requestId: RequestId
  /** 快照文件路径。 */
  readonly backupPath: string
  /** 清单路径。默认 `<backupPath>.manifest.json`。 */
  readonly manifestPath?: string
}

export interface VerifyBackupOutput {
  readonly manifest: BackupManifest
  readonly databaseSchemaVersion: number
  readonly compat: SchemaCompat
  /** 快照版本低于程序 ⇒ 需要先迁移才能写。恢复本身允许（数据没丢）。 */
  readonly needsMigration: boolean
  readonly integrity: 'ok'
  readonly entityCounts: BackupEntityCounts
}

/**
 * 校验一份备份（**只读**：不写源文件、不改目标库）。
 *
 * 校验项（逐条对应设计判据）：
 * 1. 快照与清单都存在（缺 → `NOT_FOUND_SNAPSHOT`，不是"空备份"）；
 * 2. 清单可严格解析（缺字段 → `STORAGE_CORRUPT`）；
 * 3. 字节数与 SHA-256 与清单一致（不符 → `STORAGE_CORRUPT`）；
 * 4. `PRAGMA integrity_check` 为 `ok`；
 * 5. 17 张逻辑表 + `schema_migrations` 齐全；
 * 6. 库版本与清单一致；库比程序新 → `STORAGE_SCHEMA_TOO_NEW`（critical，拒绝）；
 * 7. 迁移台账（版本 + 校验和）与清单一致；
 * 8. 实体计数与清单逐项一致。
 */
export function verifyBackup(input: VerifyBackupInput): Result<VerifyBackupOutput> {
  const { requestId } = input
  const backupPath = input.backupPath
  const manifestPath = input.manifestPath ?? defaultManifestPath(backupPath)

  if (typeof backupPath !== 'string' || backupPath.trim().length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', '备份路径不能为空。', requestId, { field: 'backupPath' })
  }
  if (!existsSync(backupPath)) {
    return errOf('NOT_FOUND_SNAPSHOT', '备份文件不存在。', requestId, { field: 'backupPath' })
  }
  if (!existsSync(manifestPath)) {
    return errOf('NOT_FOUND_SNAPSHOT', '备份清单不存在，无法确认备份版本与校验和。', requestId, {
      field: 'manifestPath',
    })
  }

  const manifestResult = readBackupManifestFile(manifestPath, requestId)
  if (!manifestResult.ok) return manifestResult
  const manifest = manifestResult.value

  // ③ 字节数 + 摘要：先比对大小（便宜），再算 SHA-256（贵）。
  let actualByteSize: number
  try {
    actualByteSize = statSync(backupPath).size
  } catch (thrown) {
    return fsError(thrown, requestId, '无法读取备份文件大小。')
  }
  if (actualByteSize !== manifest.databaseFile.byteSize) {
    return corrupt(requestId, '备份文件大小与清单不一致，文件可能被截断。', {
      field: 'databaseFile.byteSize',
      expected: manifest.databaseFile.byteSize,
      actual: actualByteSize,
    })
  }
  let actualSha256: string
  try {
    actualSha256 = sha256OfFile(backupPath)
  } catch (thrown) {
    return fsError(thrown, requestId, '无法计算备份文件校验和。')
  }
  if (actualSha256 !== manifest.databaseFile.sha256) {
    return corrupt(requestId, '备份文件校验和不匹配，文件已损坏或被改动。', {
      field: 'databaseFile.sha256',
      expected: manifest.databaseFile.sha256,
      actual: actualSha256,
    })
  }

  let snapshot: SqliteDatabase
  try {
    snapshot = openDatabase(backupPath, { readOnly: true, fileMustExist: true })
  } catch (thrown) {
    return corrupt(requestId, '备份文件无法作为 SQLite 数据库打开。', { reason: reasonOf(thrown) })
  }

  try {
    const integrity = readPragma(snapshot, 'integrity_check')
    if (integrity !== 'ok') {
      return corrupt(requestId, '备份未通过 SQLite 完整性检查。', {
        integrity: typeof integrity === 'string' ? integrity.slice(0, 120) : 'unknown',
      })
    }

    const missingTable = findMissingTable(snapshot)
    if (missingTable !== null) {
      return corrupt(requestId, `备份缺少必需的表 ${missingTable}。`, { missingTable })
    }

    const databaseSchemaVersion = readSchemaVersion(snapshot)
    if (databaseSchemaVersion !== manifest.databaseSchemaVersion) {
      return corrupt(requestId, '备份实际库版本与清单记录不一致。', {
        field: 'databaseSchemaVersion',
        expected: manifest.databaseSchemaVersion,
        actual: databaseSchemaVersion,
      })
    }
    const compat = checkSchemaCompat(databaseSchemaVersion)
    if (compat === 'too-new') {
      // 🔴 库比程序新：拒绝读取写入，只提示升级/导出的出路。
      return errOf(
        'STORAGE_SCHEMA_TOO_NEW',
        '备份来自更新版本的程序，当前程序无法安全恢复。请升级程序后重试，或使用新版本导出兼容副本。',
        requestId,
        { found: databaseSchemaVersion, supported: manifest.databaseSchemaVersion },
      )
    }

    const facts = readBackupFacts(snapshot)

    // ⑦ 迁移台账：版本与校验和都要对上（只比版本会漏掉"迁移内容被改过"）。
    const ledgerMismatch = firstLedgerMismatch(manifest, facts.migrationLedger)
    if (ledgerMismatch !== null) {
      return corrupt(requestId, `备份迁移台账与清单不一致（版本 ${ledgerMismatch.version}）。`, {
        field: 'migrationLedger',
        version: ledgerMismatch.version,
        reason: ledgerMismatch.reason,
      })
    }

    // ⑧ 实体计数：任何一项不符都说明清单与快照不是同一时刻的产物。
    const countMismatch = firstCountMismatch(manifest.entityCounts, facts.entityCounts)
    if (countMismatch !== null) {
      return corrupt(requestId, `备份实体计数与清单不一致（${countMismatch.field}）。`, {
        field: `entityCounts.${countMismatch.field}`,
        expected: countMismatch.expected,
        actual: countMismatch.actual,
      })
    }

    const workspaceMismatch = firstWorkspaceMismatch(manifest, facts.workspaces)
    if (workspaceMismatch !== null) {
      return corrupt(requestId, '备份工作区归属与清单不一致。', {
        field: 'workspaces',
        workspaceId: workspaceMismatch,
      })
    }

    // 附件清单也要对：清单里的附件声明是"恢复后要核对哪些文件"的依据，
    // 被悄悄改掉会让用户以为附件都在。
    const assetMismatch = firstAssetMismatch(manifest, facts.assets)
    if (assetMismatch !== null) {
      return corrupt(requestId, '备份附件清单与库内容不一致。', {
        field: 'assets',
        assetId: assetMismatch,
      })
    }

    return ok({
      manifest,
      databaseSchemaVersion,
      compat,
      needsMigration: compat === 'needs-migration',
      integrity: 'ok',
      entityCounts: facts.entityCounts,
    })
  } finally {
    closeDatabase(snapshot)
  }
}

export interface RestoreBackupInput {
  readonly requestId: RequestId
  readonly backupPath: string
  readonly manifestPath?: string
  /** 恢复目标（新库路径）。 */
  readonly targetPath: string
  /** 目标已存在时是否覆盖。默认 `false`：覆盖必须是显式决定。 */
  readonly overwrite?: boolean
}

export interface RestoreBackupOutput {
  readonly targetPath: string
  /** 写进目标的清单路径（默认 `<targetPath>.manifest.json`），使恢复结果可再次校验。 */
  readonly manifestPath: string
  readonly manifest: BackupManifest
  readonly byteSize: number
  readonly verified: VerifyBackupOutput
}

/**
 * 把备份恢复到指定路径。
 *
 * 顺序（每一步都为了"失败不留损坏目标"）：
 * 1. 先校验源备份 → 失败直接返回，目标一动不动；
 * 2. 复制到 `<target>.restoring`；
 * 3. **对副本再校验一遍**（磁盘满/坏道造成的半截复制在这里被抓住）；
 * 4. 仅在副本完全合格后才换名到目标；
 * 5. 把清单写到目标旁边（恢复结果本身要是一份可再次校验的恢复点）；
 * 6. 最后对目标做一次独立校验（换名后磁盘立刻损坏时能发现并删除）。
 */
export function restoreBackup(input: RestoreBackupInput): Result<RestoreBackupOutput> {
  const { requestId } = input
  const targetPath = input.targetPath
  const manifestPath = input.manifestPath ?? defaultManifestPath(input.backupPath)

  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', '恢复目标路径不能为空。', requestId, { field: 'targetPath' })
  }
  if (isMemoryPath(targetPath)) {
    return errOf('VALIDATION_FAILED', '恢复目标必须是文件路径，不能是内存库。', requestId, { field: 'targetPath' })
  }
  if (targetPath === input.backupPath) {
    return errOf('VALIDATION_FAILED', '恢复目标不能与备份文件相同，会破坏唯一备份。', requestId, {
      field: 'targetPath',
    })
  }

  const sourceVerified = verifyBackup({ requestId, backupPath: input.backupPath, manifestPath })
  if (!sourceVerified.ok) return sourceVerified

  if (existsSync(targetPath) && input.overwrite !== true) {
    return errOf('ALREADY_EXISTS', '恢复目标已存在。覆盖已有数据库必须显式声明 overwrite。', requestId, {
      field: 'targetPath',
    })
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true })
  } catch (thrown) {
    return fsError(thrown, requestId, '无法创建恢复目标目录，请检查磁盘与权限。')
  }

  const stagingPath = `${targetPath}.restoring`
  removeQuietly(stagingPath)

  try {
    copyFileSync(input.backupPath, stagingPath)
  } catch (thrown) {
    removeQuietly(stagingPath)
    return fsError(thrown, requestId, '复制备份到恢复目标失败，请检查磁盘空间与权限。')
  }

  // ③ 副本自校验：这是"磁盘满导致半截文件"的唯一拦截点。
  const stagedVerified = verifyBackup({ requestId, backupPath: stagingPath, manifestPath })
  if (!stagedVerified.ok) {
    removeQuietly(stagingPath)
    return {
      ok: false,
      error: {
        ...stagedVerified.error,
        message: '恢复副本校验失败，已清理临时文件，目标位置未被修改。',
        detail: { ...(stagedVerified.error.detail ?? {}), stage: 'staged-copy' },
      },
    }
  }

  // ④ 换名。Windows 上 `renameSync` 不能覆盖已存在文件，所以先删旧目标。
  try {
    if (existsSync(targetPath)) rmSync(targetPath, { force: true })
    renameSync(stagingPath, targetPath)
  } catch (thrown) {
    removeQuietly(stagingPath)
    return fsError(thrown, requestId, '写入恢复目标失败，已清理临时文件。')
  }

  // ⑤ 换名后独立复核：走到这里必须成功；失败说明磁盘在换名后立即损坏，不能留坏库。
  //
  // 🔴 顺手把清单也放到目标旁边：恢复出来的目录必须是一份**自洽、可再次校验/再次备份**的
  //    恢复点。只给用户一个孤零零的 .db，他就再也无法验证这份数据、也无法把它当作新备份源
  //    （`06:73` 要求恢复点包含版本与校验信息）。
  const targetManifestPath = defaultManifestPath(targetPath)
  try {
    writeFileSync(targetManifestPath, serializeBackupManifest(sourceVerified.value.manifest), 'utf8')
  } catch (thrown) {
    removeQuietly(targetPath)
    return fsError(
      thrown,
      requestId,
      '恢复目标清单写入失败，已删除恢复出的数据库，以免留下无法校验的库。',
    )
  }

  const finalVerified = verifyBackup({ requestId, backupPath: targetPath, manifestPath: targetManifestPath })
  if (!finalVerified.ok) {
    removeQuietly(targetManifestPath)
    removeQuietly(targetPath)
    return corrupt(requestId, '恢复后的目标库校验失败，已删除该文件以免用户误用损坏库。', {
      reason: finalVerified.error.code,
    })
  }

  let byteSize = sourceVerified.value.manifest.databaseFile.byteSize
  try {
    byteSize = statSync(targetPath).size
  } catch {
    /* 大小读不到不影响：上面已按摘要校验过内容 */
  }

  return ok({
    targetPath,
    manifestPath: targetManifestPath,
    manifest: sourceVerified.value.manifest,
    byteSize,
    verified: finalVerified.value,
  })
}

// ---------------------------------------------------------------------------
// 比对辅助
// ---------------------------------------------------------------------------

function firstLedgerMismatch(
  manifest: BackupManifest,
  actual: readonly { version: number; name: string; checksum: string }[],
): { version: number; reason: string } | null {
  if (manifest.migrationLedger.length !== actual.length) {
    return {
      version: -1,
      reason: `清单 ${manifest.migrationLedger.length} 条、实际 ${actual.length} 条`,
    }
  }
  for (let index = 0; index < manifest.migrationLedger.length; index += 1) {
    const expected = manifest.migrationLedger[index]
    const found = actual[index]
    if (expected === undefined || found === undefined) {
      return { version: -1, reason: '条目数不一致' }
    }
    if (expected.version !== found.version) {
      return { version: found.version, reason: '版本号不一致' }
    }
    if (expected.checksum !== found.checksum) {
      return { version: found.version, reason: '校验和不一致' }
    }
  }
  return null
}

const COUNT_KEYS: readonly (keyof BackupEntityCounts)[] = [
  'projects',
  'documents',
  'settingsEntities',
  'assets',
  'revisions',
  'pluginData',
  'localDrafts',
]

function firstCountMismatch(
  expected: BackupEntityCounts,
  actual: BackupEntityCounts,
): { field: keyof BackupEntityCounts; expected: number; actual: number } | null {
  for (const key of COUNT_KEYS) {
    if (expected[key] !== actual[key]) {
      return { field: key, expected: expected[key], actual: actual[key] }
    }
  }
  return null
}

function firstWorkspaceMismatch(
  manifest: BackupManifest,
  actual: readonly { workspaceId: string; documentCount: number; projectCount: number }[],
): string | null {
  if (manifest.workspaces.length !== actual.length) return 'count-mismatch'
  for (let index = 0; index < manifest.workspaces.length; index += 1) {
    const expected = manifest.workspaces[index]
    const found = actual[index]
    if (expected === undefined || found === undefined) return 'count-mismatch'
    if (expected.workspaceId !== found.workspaceId) return found.workspaceId
    if (expected.documentCount !== found.documentCount || expected.projectCount !== found.projectCount) {
      return found.workspaceId
    }
  }
  return null
}

/** 附件清单比对：长度与 (assetId, sha256) 必须逐项一致。 */
function firstAssetMismatch(
  manifest: BackupManifest,
  actual: readonly { assetId: string; sha256: string }[],
): string | null {
  if (manifest.assets.length !== actual.length) return 'count-mismatch'
  for (let index = 0; index < manifest.assets.length; index += 1) {
    const expected = manifest.assets[index]
    const found = actual[index]
    if (expected === undefined || found === undefined) return 'count-mismatch'
    if (expected.assetId !== found.assetId || expected.sha256 !== found.sha256) return found.assetId
  }
  return null
}

/** 第一张缺失的必需表；齐全返回 `null`。 */
function findMissingTable(db: SqliteDatabase): string | null {
  const required = [...DESKTOP_TABLE_NAMES, SCHEMA_MIGRATIONS_TABLE]
  const statement = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
  for (const name of required) {
    if (statement.get(name) === undefined) return name
  }
  return null
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* 清理失败不影响错误语义 */
  }
}
