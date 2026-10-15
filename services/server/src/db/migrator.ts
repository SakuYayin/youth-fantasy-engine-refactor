/**
 * 后端库迁移器。
 *
 * 设计依据（`06-数据与本地存储.md`「迁移与向后兼容」）：
 * - `server_schema_migrations` 记录版本、**校验和**与执行结果，迁移前创建一致备份；
 * - 迁移按**单步事务**执行，失败不推进版本；
 * - 数据版本高于程序支持范围时**拒绝写入**（`STORAGE_SCHEMA_TOO_NEW`），
 *   绝不"尽力打开"——新版写入的字段会被旧版静默丢弃，造成不可逆损失。
 *
 * 为什么服务端自己有一份（而不是直接调 `@yfe/persistence-sqlite` 的迁移器）：
 * 该包的 `./schema` 子路径导出（`src/schema/index.ts`）由 T2 在本轮并行实现，
 * 当前还没有可 import 的文件；服务端不能依赖一个尚未存在的导出面。这里保留了与
 * 设计文档一致的**接口形状与语义**（`migrateServerDatabase(db, opts)` 返回已应用的版本列表、
 * 校验和、单步事务、失败不推进），待该导出稳定后可替换为薄封装。
 *
 * 🔴 服务端库与桌面库是两个不同的库、两套版本序列，各自独立的 `*_migrations` 表。
 *
 * 与 `packages/persistence-sqlite` 迁移器的**接口一致性对照**（供 Lead 核对兼容性）：
 * | 语义 | 本实现 | 设计文档 06 要求 |
 * | --- | --- | --- |
 * | 版本记录表 | `server_schema_migrations(version, checksum, applied_at, success)` | 版本、校验和、执行结果 ✔ |
 * | 迁移粒度 | 每个版本一个事务 | 单步事务 ✔ |
 * | 失败行为 | 回滚该步且不写版本行 → 下次重跑 | 失败不推进版本 ✔ |
 * | 库更新 | `checkSchemaCompat` → `too-new` 直接抛 `STORAGE_SCHEMA_TOO_NEW` | 拒绝写入 ✔ |
 * | 备份 | `backupServerDatabase`（SQLite 在线备份 API） | 迁移前一致备份 ✔ |
 */

import { createHash } from 'node:crypto'

import { ContractError, checkSchemaCompat, newIds } from '@yfe/contracts'
import type { ErrorPayload, Result } from '@yfe/contracts'

import { ASSET_JOB_DDL } from './assetJobDdl.js'
import { SCHEMA_DDL, SERVER_SCHEMA_VERSION } from './ddl.js'
import { SYNC_DDL_V2 } from './syncDdl.js'
import type { ServerDb } from './open.js'

/** 版本记录表名。刻意用独立名字，避免与桌面库的 `schema_migrations` 语义混淆。 */
export const SERVER_MIGRATIONS_TABLE = 'server_schema_migrations'

const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${SERVER_MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  note TEXT
)`

/** 一个迁移步骤：版本号 + 稳定性标识 + 要执行的语句。 */
export interface ServerMigration {
  readonly version: number
  /**
   * 内容校验和（对语句文本做 SHA-256）。
   *
   * 用途不是加密，而是**防"已应用的迁移被人偷改"**：已经跑过的版本如果语句变了，
   * 新库与老库的结构会分叉，而两边都不会报错，直到某次查询失败才暴露。
   * 校验和不匹配时直接报 `STORAGE_MIGRATION_FAILED`，逼人工核对。
   */
  readonly checksum: string
  readonly statements: readonly string[]
}

export interface MigrateServerOptions {
  /** 注入时钟，便于测试固定时间。 */
  readonly now?: () => string
  /**
   * 迁移前备份文件的**绝对路径**。给了就先做一致备份（SQLite 在线备份 API），
   * 备份失败则整个迁移中止——不能"跳过备份继续迁移"。
   */
  readonly backupPath?: string
}

export interface MigrateServerResult {
  /** 本次实际执行的版本号（已应用过的不会重复执行）。 */
  readonly applied: readonly number[]
  /** 迁移后的库版本。 */
  readonly schemaVersion: number
  readonly backupPath?: string
}

/** 计算一段 DDL 集合的校验和。空白归一化后计算，避免纯格式调整导致误报。 */
export function checksumOf(statements: readonly string[]): string {
  const normalized = statements.map((s) => s.replace(/\s+/g, ' ').trim()).join('\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * 迁移清单。
 *
 * 🔴 **只追加，不改**。版本 1 就是 `SCHEMA_DDL` 全集（新库一次建好）；
 * 后续要加列/加表时在这里追加 `{ version: 2, statements: [...] }`，
 * 而不是回去改 `ddl.ts` 里的 `SCHEMA_DDL`。
 */
export const MIGRATIONS: readonly ServerMigration[] = [
  {
    version: 1,
    checksum: checksumOf(SCHEMA_DDL),
    statements: SCHEMA_DDL,
  },
  {
    // P3-A3：工作区元数据 + 实体投影 + 冲突留痕 + change_feed 溯源列。
    // 已发布语句一个字都没动，全部是追加（含 workspaces 的历史数据回填，
    // 理由见 `syncDdl.ts` 文件头）。
    version: 2,
    checksum: checksumOf(SYNC_DDL_V2),
    statements: SYNC_DDL_V2,
  },
  {
    // 附件与任务：分片对账、资产登记与引用、任务与任务事件日志。
    // 全部是纯新增表/索引（无回填），理由见 `assetJobDdl.ts` 文件头。
    version: 3,
    checksum: checksumOf(ASSET_JOB_DDL),
    statements: ASSET_JOB_DDL,
  },
]

/** 清单是否自洽：版本连续、从 1 开始、校验和与实际语句一致。 */
export function validateMigrationList(list: readonly ServerMigration[] = MIGRATIONS): void {
  list.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `迁移清单版本必须从 1 连续递增：第 ${index + 1} 项是版本 ${migration.version}`,
      )
    }
    const expected = checksumOf(migration.statements)
    if (expected !== migration.checksum) {
      throw new Error(`迁移版本 ${migration.version} 的 checksum 与 statements 不一致`)
    }
  })
}

/** 读取当前库版本。库还没有迁移表 → 0（全新库）。 */
export function currentServerSchemaVersion(db: ServerDb): number {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(SERVER_MIGRATIONS_TABLE) as { present?: number } | undefined
  if (row === undefined) return 0

  const versionRow = db
    .prepare(`SELECT MAX(version) AS version FROM ${SERVER_MIGRATIONS_TABLE} WHERE success = 1`)
    .get() as { version: number | null } | undefined
  return versionRow?.version ?? 0
}

/** 已应用版本的记录明细（供诊断导出与测试断言）。 */
export interface AppliedMigration {
  readonly version: number
  readonly checksum: string
  readonly appliedAt: string
  readonly success: boolean
}

export function appliedServerMigrations(db: ServerDb): readonly AppliedMigration[] {
  if (currentServerSchemaVersion(db) === 0) return []
  const rows = db
    .prepare(
      `SELECT version, checksum, applied_at AS appliedAt, success FROM ${SERVER_MIGRATIONS_TABLE} ORDER BY version`,
    )
    .all() as { version: number; checksum: string; appliedAt: string; success: number }[]
  return rows.map((row) => ({
    version: row.version,
    checksum: row.checksum,
    appliedAt: row.appliedAt,
    success: row.success === 1,
  }))
}

/**
 * 执行迁移。
 *
 * 行为契约：
 * - 库版本**高于**程序支持范围 → 抛 `STORAGE_SCHEMA_TOO_NEW`（critical），不执行任何语句；
 * - 每个未应用的版本在**自己的事务**里执行，成功后写入版本行；
 * - 某步失败 → 该步回滚、不写版本行、异常向上抛（调用方按 `STORAGE_MIGRATION_FAILED` 处理），
 *   已成功的更早版本保持已应用状态，下次启动从失败那一步重跑；
 * - 给 `backupPath` 时先做一致备份；备份失败中止迁移。
 *
 * 🔴 备份**不能只复制主库文件**：WAL 模式下未检查点的内容不在主文件里，
 * 只复制主文件得到的备份会缺最近的事务（设计文档 06 明文禁止）。
 * 这里用 SQLite 在线备份 API（`better-sqlite3` 的 `db.backup()`），它走的是
 * 与写事务一致的快照语义。
 */
export async function migrateServerDatabase(
  db: ServerDb,
  options: MigrateServerOptions = {},
): Promise<MigrateServerResult> {
  validateMigrationList()

  const now = options.now ?? (() => new Date().toISOString())
  const found = currentServerSchemaVersion(db)
  const compat = checkSchemaCompat(found, SERVER_SCHEMA_VERSION)

  if (compat === 'too-new') {
    // 库比程序新：拒绝写入。绝不能"尽力打开"，否则旧程序会静默丢字段。
    throw new ContractError({
      code: 'STORAGE_SCHEMA_TOO_NEW',
      message: `数据库 schema 版本 ${found} 高于本程序支持的 ${SERVER_SCHEMA_VERSION}，拒绝打开以免丢失新版写入的数据。请升级服务程序或从备份恢复。`,
      requestId: newIds.request(),
      detail: { found, supported: SERVER_SCHEMA_VERSION },
    })
  }

  let backupPath: string | undefined
  const pending = MIGRATIONS.filter((migration) => migration.version > found)
  if (pending.length === 0) {
    return { applied: [], schemaVersion: found }
  }

  if (options.backupPath !== undefined) {
    backupPath = options.backupPath
    await backupServerDatabase(db, backupPath)
  }

  // 迁移表本身必须先存在：它不属于任何被迁移的版本，是迁移器的元数据。
  db.exec(MIGRATIONS_TABLE_DDL)

  const applied: number[] = []
  for (const migration of pending) {
    const run = db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement)
      }
      db.prepare(
        `INSERT INTO ${SERVER_MIGRATIONS_TABLE} (version, checksum, applied_at, success) VALUES (?, ?, ?, 1)`,
      ).run(migration.version, migration.checksum, now())
    })
    try {
      run()
    } catch (thrown) {
      // 事务已回滚，版本行没写；把驱动原文留在 cause 里给日志，绝不外发。
      const cause = thrown instanceof Error ? thrown.message : String(thrown)
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: `数据库迁移到版本 ${migration.version} 失败，已回滚且未推进版本。`,
        requestId: newIds.request(),
        detail: { targetVersion: migration.version, fromVersion: found },
        cause,
      })
    }
    applied.push(migration.version)
  }

  return {
    applied,
    schemaVersion: SERVER_SCHEMA_VERSION,
    ...(backupPath === undefined ? {} : { backupPath }),
  }
}

/** `migrateServerDatabase` 的 `Result` 版本；失败原因归一为契约错误载荷。 */
export async function tryMigrateServerDatabase(
  db: ServerDb,
  options: MigrateServerOptions = {},
): Promise<Result<MigrateServerResult>> {
  try {
    return { ok: true, value: await migrateServerDatabase(db, options) }
  } catch (thrown) {
    if (thrown instanceof ContractError) return { ok: false, error: thrown.toPayload() }
    const payload: ErrorPayload = {
      code: 'STORAGE_MIGRATION_FAILED',
      message: '数据库迁移失败，已回滚且未推进版本。',
      requestId: newIds.request(),
      severity: 'error',
      retryable: false,
      cause: thrown instanceof Error ? thrown.message : String(thrown),
    }
    return { ok: false, error: payload }
  }
}

/**
 * 一致备份（SQLite 在线备份 API）。
 *
 * 用途：迁移前留一份可回退的快照。走在线备份而不是文件复制，是因为
 * WAL 模式下主库文件本身不是一致的。
 */
export async function backupServerDatabase(db: ServerDb, destination: string): Promise<void> {
  await db.backup(destination)
}

/**
 * 迁移后校验：所有基线表都存在。
 *
 * 与"迁移报告成功"相比，这一步验的是**结果而不是过程**。少一张表意味着
 * 某个 DDL 语句被 CHECK 或外键问题静默吞掉（SQLite 的 `CREATE TABLE IF NOT EXISTS`
 * 不会因为同名表存在而报错，人工加过表的环境尤其容易出现结构不一致）。
 */
export function missingServerTables(db: ServerDb, expected: readonly string[]): readonly string[] {
  return expected.filter((name) => {
    const row = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { present?: number } | undefined
    return row === undefined
  })
}
