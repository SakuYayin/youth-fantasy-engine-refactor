/**
 * 恢复点创建 —— SQLite 一致快照 + 自描述清单。
 *
 * 设计判据：
 * - `06-数据与本地存储.md:49`：备份必须用 **SQLite 在线备份机制或停服一致复制**，
 *   **禁止只复制主文件而遗漏活动 WAL** —— 复制 `.db` 会丢掉最近写入，
 *   正好丢的是"用户最后敲的那几段"。
 * - `06-数据与本地存储.md:73`：恢复点包含数据库版本、同步协议、插件数据版本、附件清单和校验。
 *
 * 🔴 实现用 `VACUUM INTO`（与 `schema/migrator.ts` 的迁移前备份同一条路径）：
 *    - 它是 SQLite 官方建议的在线一致快照，读到的是**包含活动 WAL 的**一致视图；
 *    - 它顺带压实页面，备份体不再包含已删正文的残留页；
 *    - 它**不能在事务内执行**，所以这里绝不在 `db.transaction()` 里调用；
 *    - 目标已存在时 SQLite 直接报 `output file already exists`，天然防覆盖。
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  errOf,
  ok,
  systemClock,
  type Clock,
  type RequestId,
  type Result,
  type UtcTimestamp,
} from '@yfe/contracts'

import {
  DESKTOP_TABLE_NAMES,
  SCHEMA_MIGRATIONS_TABLE,
  closeDatabase,
  isMemoryPath,
  openDatabase,
  readPragma,
  sqliteErrorPayload,
  type SqliteDatabase,
} from '../schema/index.js'
import { fsError, reasonOf } from './fsErrors.js'
import { sameFilePath } from './paths.js'
import {
  buildBackupManifest,
  corrupt,
  defaultManifestPath,
  serializeBackupManifest,
  type BackupManifest,
} from './manifest.js'

export interface CreateBackupInput {
  readonly requestId: RequestId
  /** 快照落盘路径（必须不存在；存在即 `ALREADY_EXISTS`）。 */
  readonly destinationPath: string
  /** 清单路径。默认 `<destinationPath>.manifest.json`。 */
  readonly manifestPath?: string
}

export interface CreateBackupDeps {
  /** 时钟。默认 `systemClock`；测试注入 `fixedClock` 让 `createdAt` 可断言。 */
  readonly clock?: Clock
}

export interface CreateBackupOutput {
  readonly backupPath: string
  readonly manifestPath: string
  readonly manifest: BackupManifest
  /** 快照 + 清单的墙钟耗时（诊断用；不进清单，避免清单不稳定）。 */
  readonly durationMs: number
}

/**
 * 创建一致备份。
 *
 * 🔴 快照与清单**要么都存在且自洽，要么都不存在**：任何一步失败都会清掉已写出的半成品，
 *    绝不给用户留下"看起来像备份、其实缺清单/是半截文件"的东西。
 */
export function createBackup(
  db: SqliteDatabase,
  input: CreateBackupInput,
  deps: CreateBackupDeps = {},
): Result<CreateBackupOutput> {
  const { requestId, destinationPath } = input
  const manifestPath = input.manifestPath ?? defaultManifestPath(destinationPath)
  const clock = deps.clock ?? systemClock

  if (typeof destinationPath !== 'string' || destinationPath.trim().length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', '备份目标路径不能为空。', requestId, { field: 'destinationPath' })
  }
  if (isMemoryPath(destinationPath)) {
    return errOf('VALIDATION_FAILED', '备份目标必须是文件路径，不能是内存库。', requestId, {
      field: 'destinationPath',
    })
  }
  if (existsSync(destinationPath)) {
    return errOf('ALREADY_EXISTS', '备份目标已存在，请换一个路径或先删除它。', requestId, {
      field: 'destinationPath',
    })
  }
  if (sameFilePath(manifestPath, destinationPath)) {
    return errOf('VALIDATION_FAILED', '清单路径不能与快照路径相同。', requestId, { field: 'manifestPath' })
  }
  if (existsSync(manifestPath)) {
    return errOf('ALREADY_EXISTS', '备份清单已存在，请换一个路径或先删除它。', requestId, {
      field: 'manifestPath',
    })
  }

  try {
    mkdirSync(dirname(destinationPath), { recursive: true })
  } catch (thrown) {
    return fsError(thrown, requestId, '无法创建备份目录，请检查磁盘与权限。')
  }

  const startedAt = Date.now()
  const createdAt = clock.now() as UtcTimestamp

  // 🔴 事务外执行；失败不能留下半截文件。
  try {
    db.prepare('VACUUM INTO ?').run(destinationPath)
  } catch (thrown) {
    removeQuietly(destinationPath)
    const payload = sqliteErrorPayload(thrown, requestId)
    return { ok: false, error: { ...payload, message: '创建数据库快照失败，磁盘可能已满或目录不可写。' } }
  }

  let snapshot: SqliteDatabase
  try {
    snapshot = openDatabase(destinationPath, { readOnly: true, fileMustExist: true })
  } catch (thrown) {
    removeQuietly(destinationPath)
    return fsError(thrown, requestId, '快照写入后无法重新打开，已删除该文件，请重试。')
  }

  let result: Result<CreateBackupOutput>
  try {
    result = describeSnapshotAndWriteManifest(snapshot, {
      requestId,
      destinationPath,
      manifestPath,
      createdAt,
      startedAt,
    })
  } finally {
    // 🔴 **必须先关连接再清理文件**：Windows 上仍被打开的文件删不掉，
    //    `rmSync(..., { force: true })` 会静默失败，于是留下"没有清单的孤儿快照"——
    //    比直接报错更糟，因为用户会以为备份成功。清理统一放到关闭之后。
    closeDatabase(snapshot)
  }

  if (!result.ok) {
    removeQuietly(manifestPath)
    removeQuietly(destinationPath)
  }
  return result
}

/**
 * 校验快照自身，并把清单写到磁盘。
 *
 * 🔴 顺序不能反：先证明"这个文件是一个完好的库"，再写清单。
 *    反了会产出"清单描述一个损坏文件"——用户拿到清单就以为备份是好的。
 */
function describeSnapshotAndWriteManifest(
  snapshot: SqliteDatabase,
  context: {
    readonly requestId: RequestId
    readonly destinationPath: string
    readonly manifestPath: string
    readonly createdAt: UtcTimestamp
    readonly startedAt: number
  },
): Result<CreateBackupOutput> {
  const { requestId, destinationPath, manifestPath, createdAt, startedAt } = context
  try {
    const integrity = readPragma(snapshot, 'integrity_check')
    if (integrity !== 'ok') {
      return corrupt(requestId, '新建快照未通过完整性检查，已删除该文件。', {
        integrity: typeof integrity === 'string' ? integrity.slice(0, 120) : 'unknown',
      })
    }

    const missingTable = findMissingTable(snapshot)
    if (missingTable !== null) {
      return corrupt(requestId, `新建快照缺少必需的表 ${missingTable}，已删除该文件。`, {
        missingTable,
      })
    }
    if ((snapshot.pragma('foreign_key_check') as readonly unknown[]).length !== 0) {
      return corrupt(requestId, '新建快照存在失效的实体引用，已删除该文件。', { field: 'foreignKeys' })
    }

    const manifestResult = buildBackupManifest(snapshot, { requestId, snapshotPath: destinationPath, createdAt })
    if (!manifestResult.ok) return manifestResult
    const manifest = manifestResult.value

    try {
      writeFileSync(manifestPath, serializeBackupManifest(manifest), 'utf8')
    } catch (thrown) {
      // 清单写不出来 ⇒ 快照也不能留（否则用户会以为备份成功）。
      return fsError(thrown, requestId, '备份清单写入失败，已删除快照，请检查磁盘空间。')
    }

    return ok({
      backupPath: destinationPath,
      manifestPath,
      manifest,
      durationMs: Date.now() - startedAt,
    })
  } catch (thrown) {
    return corrupt(requestId, '读取快照元数据时失败，已删除该文件。', { reason: reasonOf(thrown) })
  }
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

/** 删除文件但吞掉错误（清理路径不该覆盖原始失败原因）。 */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* 清理失败不影响错误语义 */
  }
}

/** 快照文件当前字节数（诊断/断言用）。 */
export function snapshotByteSize(path: string): number {
  return statSync(path).size
}
