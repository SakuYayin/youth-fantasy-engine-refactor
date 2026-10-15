/**
 * 迁移器：把数据库版本推进到本程序支持的版本，并留下可审计的台账。
 *
 * 设计依据（`06-数据与本地存储.md`「迁移与向后兼容」）：
 * - `schema_migrations` 记录**版本、校验和与执行结果**；
 * - **迁移前创建一致备份**；
 * - 迁移按**单步事务**执行，**失败不推进版本**；
 * - 数据版本高于程序支持范围时**拒绝写入**并给出兼容导出/恢复指引。
 *
 * 🔴 三条不可动摇的约束：
 * 1. **版本过高必须拒绝**。`checkSchemaCompat` 返回 `'too-new'` 时直接抛
 *    `STORAGE_SCHEMA_TOO_NEW`（critical 级），**绝不"尽力打开"**——用旧代码写新结构
 *    会静默破坏用户数据，且损坏是延迟发现的。
 * 2. **只加不改**。已发布迁移的 `ddl` 文本参与校验和计算，改动即视为篡改并拒绝打开。
 * 3. **迁移前必须备份**，且备份必须是一致快照。用 `VACUUM INTO`（SQLite 官方建议的
 *    在线备份途径之一）而不是复制文件：**复制主文件会遗漏活动 WAL**，
 *    得到的是缺少最近写入的陈旧库。
 *
 * 事务边界（实测确认，见 tests/schema/migrator.test.ts）：
 * - SQLite 的 DDL 是事务性的：`CREATE TABLE` 失败可整体回滚；
 * - `VACUUM INTO` **不能在事务内**执行（`cannot VACUUM from within a transaction`）；
 * - `PRAGMA journal_mode` 在事务内**直接抛错**（不是静默无效）。
 *   因此「备份 → 迁移 → 检查点」必须在事务**外**，每步迁移各自独立成事务。
 *
 * 🔴 失败语义：单步失败 → 该步回滚、写一条 `success = 0` 的审计行、**不推进版本**、
 *    立即停止（不做后续步骤）。数据库停在"最后一个成功版本"上，仍然可以打开与导出。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'

import {
  ContractError,
  DB_SCHEMA_VERSION,
  checkSchemaCompat,
  isRetryable,
  newIds,
  severityOf,
  systemClock,
  type Clock,
  type ErrorPayload,
  type RequestId,
} from '@yfe/contracts'

import {
  DESKTOP_MIGRATION_VERSION_MAX,
  LATEST_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  SCHEMA_MIGRATIONS_DDL,
  SCHEMA_MIGRATIONS_TABLE,
  isDesktopMigrationVersion,
  type SchemaMigration,
} from './ddl.js'
import { isMemoryPath, sqliteErrorPayload, type SqliteDatabase } from './open.js'

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 迁移前备份的落盘位置与结果。只在实际写出文件时存在（见 {@link MigrationReport.backup}）。 */
export interface MigrationBackup {
  /** 备份文件的绝对路径。 */
  readonly path: string
  /** 备份文件字节数。 */
  readonly byteSize: number
  /** 触发该备份时的库版本。 */
  readonly fromVersion: number
}

/**
 * 一次 `migrate` 的完整结果。
 *
 * `fromVersion` / `toVersion` 是**调用方唯一可信的版本来源**：不要从
 * `SCHEMA_MIGRATIONS.length` 之类推导，那会把"失败但不推进"的语义丢掉。
 */
export interface MigrationReport {
  /** 迁移前的库版本（0 表示空库）。 */
  readonly fromVersion: number
  /** 迁移后的库版本；失败时等于最后一个成功版本。 */
  readonly toVersion: number
  /** 本次成功应用的迁移版本，升序。 */
  readonly applied: readonly number[]
  /**
   * 迁移前的备份记录。
   *
   * 🔴 **非 `null` ⟺ 磁盘上确实存在一份可回退的快照**。因此以下情况都是 `null`：
   *    已是最新（没有迁移）、内存库（没有文件可备份）、`backupDir: null` 显式跳过。
   *    把"没有文件"也塞回一个 `path: null` 的对象里，会逼每个消费方自己判空，
   *    迟早有人写成 `report.backup.path!` 并在用户机器上拿到 `null`。
   */
  readonly backup: MigrationBackup | null
  /** 是否真的执行了迁移步骤。 */
  readonly migrated: boolean
}

export interface MigrateOptions {
  /**
   * 迁移前备份的落盘目录。
   *
   * 默认：数据库文件同目录下的 `backups/` 子目录。
   * 传 `null` 则**跳过备份**——仅供测试与一次性诊断使用；
   * 生产路径上跳过备份等于放弃"迁移失败可回退"的唯一保证。
   */
  readonly backupDir?: string | null
  /** 时钟。默认 `systemClock`。测试可用 `fixedClock` 让台账时间可断言。 */
  readonly clock?: Clock
  /** 请求 ID。贯通错误载荷，便于把一次失败和一次用户操作对起来。 */
  readonly requestId?: RequestId
  /** 保留的历史备份份数，超出后按时间删除最旧的。默认 {@link DEFAULT_BACKUP_KEEP}。 */
  readonly keepBackups?: number
  /**
   * 覆盖迁移清单。默认 {@link SCHEMA_MIGRATIONS}。
   *
   * 🔴 **仅供测试与诊断**。生产路径必须走默认清单：迁移清单是"这个程序支持什么结构"的
   *    自我描述，由调用方注入等于让上层代码决定底层结构版本。
   *    存在这个口子是为了能测试"多步迁移中第 2 步失败、版本停在第 1 步"——
   *    真实清单只有一步，否则这段顺序逻辑永远测不到。
   */
  readonly migrations?: readonly SchemaMigration[]
  /** 诊断日志回调。默认静默。 */
  readonly verbose?: (message: string) => void
}

/** 迁移前默认保留的历史备份份数。 */
export const DEFAULT_BACKUP_KEEP = 5

/** 备份文件所在目录名（相对数据库文件），与库文件放一起便于用户整包搬走。 */
export const BACKUP_DIR_NAME = 'backups'

// ---------------------------------------------------------------------------
// 台账读写
// ---------------------------------------------------------------------------

/** 在 `schema_migrations` 中登记成功应用的一行。 */
interface AppliedRow {
  readonly version: number
  readonly name: string
  readonly checksum: string
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  // 单独一条 `exec`：`schema_migrations` 必须**在应用任何迁移之前**存在，
  // 否则第一次迁移成功也留不下台账。它本身是 `IF NOT EXISTS`，可重复执行。
  db.exec(SCHEMA_MIGRATIONS_DDL)
}

/**
 * 读取当前库版本。
 *
 * 🔴 只认 `success = 1` 的行：失败审计行不得影响版本判定，这是"失败不推进版本"的落点。
 * 取 `MAX(version)` 而不是 `COUNT(*)`：迁移版本号不保证连续（可能出现被撤回的空号）。
 *
 * 台账表不存在时返回 `0` 而不是抛错：全新库（还没迁移过）是**正常状态**，
 * 而调用方 {@link assertSchemaAcceptsWrites} 可能在写入路径上对全新库调用它。
 * 让这里抛 `SQLITE_ERROR: no such table` 会把它翻译成 `STORAGE_UNAVAILABLE`，
 * 把"还没迁移"误报成"存储不可用"。
 */
export function readSchemaVersion(db: SqliteDatabase): number {
  if (!hasMigrationsTable(db)) return 0
  const row = db
    .prepare(`SELECT MAX(version) AS version FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE success = 1`)
    .get() as { version: number | null } | undefined
  return row?.version ?? 0
}

/** `schema_migrations` 是否已建立（区分"全新库"与"存储坏了"）。 */
export function hasMigrationsTable(db: SqliteDatabase): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(SCHEMA_MIGRATIONS_TABLE) as { name: string } | undefined
  return row !== undefined
}

/** 已成功应用的迁移台账（版本 → 校验和），供校验和比对。 */
function readAppliedRows(db: SqliteDatabase): Map<number, AppliedRow> {
  const rows = db
    .prepare(
      `SELECT version, name, checksum FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE success = 1 ORDER BY version`,
    )
    .all() as AppliedRow[]
  return new Map(rows.map((row) => [row.version, row]))
}

/**
 * 计算迁移校验和。
 *
 * 覆盖 `version` / `name` / `ddl` 三者：任何一项被改动都视为篡改。
 * 用 `node:crypto` 的 sha256，输出带 `sha256:` 前缀以便未来换算法时不必猜。
 */
export function checksumOf(migration: SchemaMigration): string {
  const payload = `${migration.version}\u0000${migration.name}\u0000${migration.ddl}`
  return `sha256:${sha256Hex(payload)}`
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

/** WAL 检查点模式：迁移前把 WAL 并回主库，让备份更小且不依赖 WAL 文件。 */
function checkpointBeforeBackup(db: SqliteDatabase): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // 检查点失败不是致命错误：`VACUUM INTO` 读的是连接可见的一致快照，
    // 即使 WAL 未清空，备份内容也是完整的。这里刻意不阻断迁移。
  }
}

function defaultBackupDir(dbPath: string): string {
  return join(dirname(resolvePath(dbPath)), BACKUP_DIR_NAME)
}

function backupFileName(dbPath: string, fromVersion: number, stamp: string): string {
  const base = basename(dbPath).replace(/\.(db|sqlite3?|sqlite)$/i, '')
  // 时间戳里的 `:` 在 Windows 上是非法文件名字符，统一换成 `-`。
  const safeStamp = stamp.replace(/[:.]/g, '-')
  return `${base}.v${fromVersion}.${safeStamp}.db`
}

function pruneBackups(dir: string, keep: number, dbPath: string, log: (m: string) => void): void {
  if (keep <= 0) return
  let entries: Array<{ name: string; mtimeMs: number }>
  try {
    const base = basename(dbPath).replace(/\.(db|sqlite3?|sqlite)$/i, '')
    entries = readDirWithStats(dir).filter((entry) => entry.name.startsWith(`${base}.v`)
      && /^\d+\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db(?:\.\d+\.db)?$/.test(entry.name.slice(base.length + 2)))
  } catch {
    return
  }
  if (entries.length <= keep) return
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const stale of entries.slice(keep)) {
    const target = join(dir, stale.name)
    try {
      rmSync(target)
      log(`已清理过期备份 ${stale.name}`)
    } catch {
      // 清理失败不影响迁移结果；下次再试。
    }
  }
}

function readDirWithStats(dir: string): Array<{ name: string; mtimeMs: number }> {
  // 只统计 `.db`：备份目录里可能有用户手动放的说明文件，不要误删。
  return readdirSync(dir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
}

/**
 * 创建迁移前的一致备份。
 *
 * 🔴 **`VACUUM INTO` 而不是复制文件**：复制主文件会遗漏活动 WAL，
 *    得到的备份缺少最近写入，正好丢掉"用户最后敲的那几段"。
 * 🔴 **必须在事务外执行**：SQLite 明确拒绝事务内 `VACUUM`。
 * 🔴 目标已存在时 SQLite 会报 `output file already exists`（实测），
 *    所以文件名带时间戳，并且真正撞车时生成唯一后缀而不是覆盖。
 */
export function createConsistentBackup(
  db: SqliteDatabase,
  options: {
    readonly dbPath: string
    /**
     * 备份目录。`undefined` → 库文件同级的 `backups/`（生产默认）；
     * `null` → 跳过备份（仅测试/诊断）。
     *
     * 两者必须可区分：`??` 会把 `null` 也当成"取默认"，所以这里显式判 `undefined`。
     */
    readonly backupDir?: string | null
    readonly fromVersion: number
    readonly clock: Clock
    readonly keep?: number
    readonly verbose?: (message: string) => void
  },
): MigrationBackup | null {
  const log = options.verbose ?? (() => {})
  const { dbPath, fromVersion } = options

  // 内存库没有文件可备份：`VACUUM INTO` 对它也无意义（关掉连接数据就没了）。
  if (isMemoryPath(dbPath) || db.memory) {
    return null
  }
  if (options.backupDir === null) {
    return null
  }

  const dir = options.backupDir ?? defaultBackupDir(dbPath)
  mkdirSync(dir, { recursive: true })

  checkpointBeforeBackup(db)

  const stamp = options.clock.now()
  const base = backupFileName(dbPath, fromVersion, stamp)
  let target = join(dir, base)
  for (let attempt = 1; existsSync(target) && attempt < 100; attempt += 1) {
    // 后缀保留 `.db`：清理逻辑只认 `.db`，否则撞车产生的副本会永远留在用户磁盘上。
    target = join(dir, `${base}.${attempt}.db`)
  }
  if (existsSync(target)) {
    throw new ContractError({ code: 'ALREADY_EXISTS', message: '迁移备份文件名冲突过多，请更换备份目录后重试。', requestId: newIds.request() })
  }

  // `VACUUM INTO` 是同步参数绑定；失败时不能留下半截文件。
  try {
    db.prepare('VACUUM INTO ?').run(target)
  } catch (thrown) {
    rmQuietly(target)
    throw thrown
  }

  const byteSize = safeSize(target)
  log(`迁移前备份已创建：${basename(target)}（${byteSize} 字节，版本 ${fromVersion}）`)

  if (options.keep !== undefined) pruneBackups(dir, options.keep, dbPath, log)

  return { path: target, byteSize, fromVersion }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function rmQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
}

// ---------------------------------------------------------------------------
// 校验和核对
// ---------------------------------------------------------------------------

function verifyChecksums(
  db: SqliteDatabase,
  migrations: readonly SchemaMigration[],
  requestId: RequestId,
): void {
  const applied = readAppliedRows(db)
  for (const migration of migrations) {
    const row = applied.get(migration.version)
    if (!row) continue
    const expected = checksumOf(migration)
    if (row.checksum !== expected) {
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: `迁移 v${migration.version}（${row.name}）的校验和与当前程序不一致：该迁移可能被事后修改。已应用迁移不可变更，请恢复正确版本的程序。`,
        requestId,
        detail: {
          version: migration.version,
          appliedName: row.name,
          expectedChecksum: expected,
          appliedChecksum: row.checksum,
        },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 兼容性闸门
// ---------------------------------------------------------------------------

function assertWritable(db: SqliteDatabase, requestId: RequestId): void {
  if (db.readonly) {
    throw new ContractError({
      code: 'STORAGE_READ_ONLY',
      message: '数据库以只读方式打开，无法执行迁移。',
      requestId,
    })
  }
}

/**
 * 版本兼容性闸门。**必须在任何写操作之前调用**（包括备份前的检查点）。
 *
 * 返回 `'ok'` 或 `'needs-migration'`；`'too-new'` 直接抛错。
 */
export function assertSchemaCompatible(
  found: number,
  requestId: RequestId = newIds.request(),
  supported: number = LATEST_SCHEMA_VERSION,
): 'ok' | 'needs-migration' {
  const compat = checkSchemaCompat(found, supported)
  if (compat === 'too-new') {
    // 🔴 critical：绝不"尽力打开"。用当前程序写更高版本的结构会静默破坏数据，
    //    而且损坏往往在很久之后才被发现。
    throw new ContractError({
      code: 'STORAGE_SCHEMA_TOO_NEW',
      message: `数据库结构版本（${found}）高于当前程序支持的版本（${supported}）。请升级应用后再打开；如需降级使用，请先用新版本导出数据。`,
      requestId,
      detail: { foundVersion: found, supportedVersion: supported },
    })
  }
  return compat
}

// ---------------------------------------------------------------------------
// 迁移主流程
// ---------------------------------------------------------------------------

function pendingMigrations(
  from: number,
  migrations: readonly SchemaMigration[],
): readonly SchemaMigration[] {
  return migrations.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  )
}

/**
 * 清单里的最高版本 = 本次迁移的**目标版本**。
 *
 * 刻意不直接用 {@link LATEST_SCHEMA_VERSION}：默认清单下两者相等（有测试断言），
 * 但注入测试清单时目标必须跟着清单走，否则"迁移到最新"会变成一个写死的数字。
 */
function latestVersionOf(migrations: readonly SchemaMigration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0)
}

function assertMigrationListSane(migrations: readonly SchemaMigration[]): void {
  const seen = new Set<number>()
  let previous = 0
  for (const migration of migrations) {
    if (!isDesktopMigrationVersion(migration.version)) {
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: `迁移清单中存在越界的版本号 ${migration.version}：桌面端迁移必须落在 1..${DESKTOP_MIGRATION_VERSION_MAX}。`,
        requestId: newIds.request(),
        detail: { version: migration.version, max: DESKTOP_MIGRATION_VERSION_MAX },
      })
    }
    if (seen.has(migration.version)) {
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: `迁移清单中存在重复版本号 ${migration.version}。`,
        requestId: newIds.request(),
        detail: { version: migration.version },
      })
    }
    if (migration.version <= previous) {
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: '迁移清单必须按版本号严格升序排列。',
        requestId: newIds.request(),
        detail: { version: migration.version, previous },
      })
    }
    seen.add(migration.version)
    previous = migration.version
  }
}

/**
 * 把数据库迁移到本程序支持的版本。
 *
 * 流程（每一步都刻意分开，见文件头的事务边界说明）：
 * 1. 建 `schema_migrations`（幂等，独立于任何迁移）；
 * 2. 读当前版本 → **兼容性闸门**（版本过高立刻抛，不做任何写入）；
 * 3. 核对已应用迁移的校验和（篡改检测）；
 * 4. 无待应用迁移 → 直接返回（**不备份**，避免每次启动都产备份文件）；
 * 5. 备份（事务外，`VACUUM INTO`）；
 * 6. 逐个迁移：**每个迁移一个独立事务**，成功才写台账；失败回滚 + 写失败审计行 + 停止；
 * 7. 返回 `fromVersion` / `toVersion` / `applied` / `backup`。
 *
 * 🔴 单个迁移一个事务，而不是"所有迁移一个大事务"：
 *    大事务失败会让已完成的前几步一起回滚，用户每次启动都要从头重试；
 *    分步后进度可保留，失败点可精确定位（台账里有失败审计行）。
 *
 * 🔴 迁移内**不允许**出现 `PRAGMA journal_mode` 或 `VACUUM`：
 *    前者在事务内直接抛错、后者被明确拒绝。两者都应放在 `openDatabase` 阶段。
 */
export function migrate(db: SqliteDatabase, options: MigrateOptions = {}): MigrationReport {
  const clock = options.clock ?? systemClock
  const requestId = options.requestId ?? newIds.request()
  const log = options.verbose ?? (() => {})
  const dbPath = db.name
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS

  assertWritable(db, requestId)
  assertMigrationListSane(migrations)
  ensureMigrationsTable(db)

  const fromVersion = readSchemaVersion(db)

  // 🔴 闸门先于一切写入：版本过高时连备份都不该做（备份会写文件系统）。
  const compat = assertSchemaCompatible(fromVersion, requestId, latestVersionOf(migrations))
  verifyChecksums(db, migrations, requestId)

  const latest = latestVersionOf(migrations)
  if (compat === 'ok' && fromVersion >= latest) {
    return { fromVersion, toVersion: fromVersion, applied: [], backup: null, migrated: false }
  }

  const pending = pendingMigrations(fromVersion, migrations)
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backup: null, migrated: false }
  }

  const backup = createConsistentBackup(db, {
    dbPath,
    // `undefined` → 默认备份目录（真实迁移**一定**留一份可回退快照）；
    // `null` → 显式跳过（仅测试/诊断），是唯一能关掉备份的写法。
    backupDir: options.backupDir === undefined ? defaultBackupDir(dbPath) : options.backupDir,
    fromVersion,
    clock,
    ...(options.keepBackups === undefined ? {} : { keep: options.keepBackups }),
    verbose: log,
  })

  const applied: number[] = []
  let current = fromVersion

  for (const migration of pending) {
    const checksum = checksumOf(migration)
    const startedAt = clock.now()
    const startedMs = Date.now()
    log(`应用迁移 v${migration.version} ${migration.name}`)

    try {
      // 每个迁移独立事务：better-sqlite3 的 transaction() 遇错自动回滚并把原错误抛出。
      const run = db.transaction(() => {
        db.exec(migration.ddl)
        db.prepare(
          `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, duration_ms, success)
           VALUES (?, ?, ?, ?, ?, 1)`,
        ).run(migration.version, migration.name, checksum, startedAt, Date.now() - startedMs)
      })
      run()
      applied.push(migration.version)
      current = migration.version
    } catch (thrown) {
      // 回滚由 transaction() 完成；这里只补一条**失败审计行**并停止。
      // 🔴 失败不推进版本：current 不更新，台账里没有该版本的 success = 1 行。
      recordFailure(db, migration, checksum, startedAt, startedMs, thrown, requestId)
      if (thrown instanceof ContractError) throw thrown
      throw new ContractError({
        code: 'STORAGE_MIGRATION_FAILED',
        message: `迁移 v${migration.version}（${migration.name}）执行失败，数据库保持在版本 ${current}。`,
        requestId,
        detail: { version: migration.version, fromVersion: current },
        cause: thrown instanceof Error ? thrown.message : String(thrown),
      })
    }
  }

  log(`迁移完成：v${fromVersion} → v${current}`)
  return { fromVersion, toVersion: current, applied, backup, migrated: true }
}

/**
 * 写一条失败审计行。
 *
 * 🔴 这一步**不能**和迁移在同事务里：迁移事务已经回滚，审计行必须单独提交，
 *    否则"失败不推进版本"就变成了"失败连日志都没有"。
 * 🔴 如果连审计行都写不进去（例如磁盘满），**绝不掩盖原始错误**——
 *    原始异常才是用户需要看到的（`STORAGE_DISK_FULL` 等），审计失败只吞掉自己。
 */
function recordFailure(
  db: SqliteDatabase,
  migration: SchemaMigration,
  checksum: string,
  appliedAt: string,
  startedMs: number,
  thrown: unknown,
  requestId: RequestId,
): void {
  const payload: ErrorPayload = sqliteErrorPayload(thrown, requestId)
  try {
    db.prepare(
      `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, duration_ms, success, error_code)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(migration.version, migration.name, checksum, appliedAt, Date.now() - startedMs, payload.code)
  } catch {
    // 审计写入失败时静默：原始错误更重要，不能被覆盖。
  }
}

// ---------------------------------------------------------------------------
// 只读自检 / 诊断
// ---------------------------------------------------------------------------

/**
 * 写入前的版本闸门。**任何写用户数据的路径都应在事务开始前调用它一次。**
 *
 * 🔴 为什么不能只靠 `migrate()` 里的闸门：迁移是**启动时**的一次性动作，而写入是长期的。
 *    用户可能先打开旧程序（此时库已是新版本 → migrate 抛错 → 但上层若忽略了错误照常进入编辑器），
 *    或者库在运行中被新版本程序升级（用户双开）。少了这道检查，
 *    旧代码就会拿新结构去写，静默破坏数据——而且是延迟发现的损坏。
 *
 * 返回本次读到的版本号，便于调用方记日志/上报。
 */
export function assertSchemaAcceptsWrites(
  db: SqliteDatabase,
  options: { readonly requestId?: RequestId; readonly supported?: number } = {},
): number {
  const found = readSchemaVersion(db)
  assertSchemaCompatible(found, options.requestId ?? newIds.request(), options.supported ?? LATEST_SCHEMA_VERSION)
  return found
}

/**
 * 迁移器可重试性判定。供 IPC 边界决定是否显示"重试"。
 * 只做转发，理由：错误载荷里的 `retryable` 必须来自契约的唯一真值。
 */
export function isMigrationRetryable(payload: ErrorPayload): boolean {
  return payload.retryable && isRetryable(payload.code)
}

/** 严重度转发（`STORAGE_SCHEMA_TOO_NEW` 是 critical，UI 必须阻断而非提示）。 */
export function migrationSeverity(payload: ErrorPayload): ReturnType<typeof severityOf> {
  return severityOf(payload.code)
}

/**
 * 自检：已知契约的 `DB_SCHEMA_VERSION` 与本包的最高迁移版本是否一致。
 *
 * 两者相等是**被校验的约束**（见 ddl.ts 的 LATEST_SCHEMA_VERSION 注释），
 * 因此这里显式断言，而不是让 `LATEST_SCHEMA_VERSION = DB_SCHEMA_VERSION` 引用同一常量
 * 把差异悄悄抹掉。
 */
export function isSchemaVersionAligned(): boolean {
  return LATEST_SCHEMA_VERSION === DB_SCHEMA_VERSION
}
