/**
 * SQLite 连接的打开与连接级参数。
 *
 * 设计依据（`06-数据与本地存储.md`「数据库所有权」）：
 * - 启用 `foreign_keys`、WAL 与 `busy_timeout`；写可靠性**优先 `synchronous=FULL`**。
 * - **DB 执行器独占写连接**，连接对象**不跨线程共享**。同一进程内对同一个库文件
 *   重复开写连接会互相制造 `SQLITE_BUSY`，因此在 `openDatabase` 里直接拒绝。
 * - 备份必须用 SQLite 在线备份机制（见 `./migrator.js`），禁止只复制主文件而遗漏活动 WAL。
 *
 * 本模块只负责「打开并配置连接」，不做迁移。Schema 与迁移见 `./ddl.js` / `./migrator.js`。
 *
 * 🔴 线程模型：`better-sqlite3` 是**同步**驱动，连接对象只能在创建它的线程/worker 内使用。
 *    跨线程共享连接会让「同步调用」变成未定义行为，必须先序列化到消息通道再调用。
 */

import { basename, resolve as resolvePath } from 'node:path'

import { ContractError, isRetryable, newIds, severityOf } from '@yfe/contracts'
import SqliteDriver from 'better-sqlite3'

/**
 * 连接对象类型别名。
 *
 * 🔴 导出**驱动原始连接类型**而不是自有包装类：调用方（SaveDraft 事务、Repository、
 * 同步引擎）需要 `prepare` / `transaction` / `pragma` / `exec` / `close` 的全部行为，
 * 任何包装都会在 `transaction()` 的同步语义与 `changes` 精确性上引入风险。
 */
export type SqliteDatabase = SqliteDriver.Database

/** 默认忙等待时长（毫秒）。写连接被占用时最多等这么久再报 `SQLITE_BUSY`。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist' | 'memory' | 'off'
export type SynchronousMode = 'full' | 'normal' | 'off' | 'extra'
export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'

export interface OpenDatabaseOptions {
  /** 只读连接：不写 WAL、不改 `journal_mode`，仅用于长查询/导出。 */
  readonly readOnly?: boolean
  /** 文件必须已存在（只读场景建议开启，避免"打不开就静默建空库"）。 */
  readonly fileMustExist?: boolean
  /** 忙等待毫秒数。默认 {@link DEFAULT_BUSY_TIMEOUT_MS}。 */
  readonly busyTimeoutMs?: number
  /** 日志模式。文件库默认 `wal`；内存库强制 `memory`。只读连接忽略此选项。 */
  readonly journalMode?: JournalMode
  /** 落盘同步级别。默认 `full`（写可靠性优先，实测磁盘后再评估降到 `normal`）。 */
  readonly synchronous?: SynchronousMode
  /**
   * 独占写连接断言。默认 `true`：同一进程内对同一库文件已有存活写连接时拒绝再开。
   * 仅故障注入测试（故意制造 `SQLITE_BUSY`）需要显式设为 `false`。
   */
  readonly exclusiveWriter?: boolean
  /** 驱动调试输出。 */
  readonly verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void
  /** 指定原生绑定路径（打包场景）。 */
  readonly nativeBinding?: string
}

/** 解析后的连接参数：默认值已展开，便于测试与诊断直接断言。 */
export interface ResolvedOpenOptions {
  readonly readOnly: boolean
  readonly journalMode: JournalMode
  readonly synchronous: SynchronousMode
  readonly busyTimeoutMs: number
  readonly exclusiveWriter: boolean
}

/** 判定路径是否指向内存库。内存库没有 WAL，也没有可备份的文件。 */
export function isMemoryPath(path: string): boolean {
  return path === '' || path === ':memory:' || path.startsWith('file::memory:')
}

/** 展开默认值。纯函数，供测试断言"默认就是 FULL + WAL"。 */
export function resolveOpenOptions(
  path: string,
  options: OpenDatabaseOptions = {},
): ResolvedOpenOptions {
  const memory = isMemoryPath(path)
  return {
    readOnly: options.readOnly ?? false,
    journalMode: memory ? 'memory' : (options.journalMode ?? 'wal'),
    synchronous: options.synchronous ?? 'full',
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    exclusiveWriter: options.exclusiveWriter ?? !(options.readOnly ?? false),
  }
}

// ---------------------------------------------------------------------------
// 独占写连接登记表
// ---------------------------------------------------------------------------

/**
 * 进程内「一个库文件一个写连接」登记表。
 *
 * 用 `WeakRef` 而不是强引用：连接被 GC 回收即视为已释放，不需要调用方必须显式注销。
 * 判定存活用驱动自身的 `open` 属性，`close()` 之后自动放行新连接。
 */
const openWriters = new Map<string, WeakRef<SqliteDatabase>>()

function canonicalKey(path: string): string {
  const absolute = resolvePath(path)
  // Windows 文件系统大小写不敏感：`A.db` 与 `a.db` 是同一个文件。
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function claimExclusiveWriter(path: string, db: SqliteDatabase): void {
  const key = canonicalKey(path)
  const existing = openWriters.get(key)?.deref()
  if (existing && existing !== db && existing.open) {
    throw new ContractError({
      code: 'RESOURCE_LOCKED',
      // detail/message 不含绝对路径：只带文件名，避免日志泄露用户名。
      message: `数据库 ${basename(path)} 已有存活写连接。DB 执行器必须独占写连接，不得在同一进程内重复打开写连接。`,
      requestId: newIds.request(),
    })
  }
  openWriters.set(key, new WeakRef(db))
}

// ---------------------------------------------------------------------------
// 打开
// ---------------------------------------------------------------------------

/**
 * 打开数据库并应用连接级参数。
 *
 * 应用顺序是刻意的：
 * 1. `foreign_keys=ON` —— 每条连接独立，必须在任何写入前设置；
 * 2. `busy_timeout` —— 让并发写等待而不是立刻失败；
 * 3. `journal_mode=WAL` —— **必须在事务之外**执行，否则静默失败；
 * 4. `synchronous=FULL` —— WAL 下的持久性保证。
 *
 * 打开或配置失败时抛错；边界层用 `tryOpenDatabase` 拿 `Result`，或 `mapSqliteError`
 * 把驱动的 `SqliteError` 翻译成契约错误码。
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const resolved = resolveOpenOptions(path, options)

  const db = new SqliteDriver(path, {
    readonly: resolved.readOnly,
    fileMustExist: options.fileMustExist ?? false,
    timeout: resolved.busyTimeoutMs,
    ...(options.verbose ? { verbose: options.verbose } : {}),
    ...(options.nativeBinding ? { nativeBinding: options.nativeBinding } : {}),
  })

  try {
    db.pragma('foreign_keys = ON')
    db.pragma(`busy_timeout = ${resolved.busyTimeoutMs}`)

    if (!resolved.readOnly) {
      // 内存库没有 WAL：`journal_mode` 只能是 memory，写了也没用。
      if (!isMemoryPath(path) && resolved.journalMode !== 'memory') {
        // 🔴 必须带 `{ simple: true }`：不带时驱动返回 `[{ journal_mode: 'wal' }]`，
        //    `String(...)` 会得到 `[object Object]`，让"WAL 已启用"被误判为失败。
        const applied = String(
          db.pragma(`journal_mode = ${resolved.journalMode}`, { simple: true }),
        ).toLowerCase()
        if (applied !== resolved.journalMode) {
          throw new ContractError({
            code: 'STORAGE_UNAVAILABLE',
            message: `无法启用 ${resolved.journalMode} 日志模式（实际为 ${applied}）。数据库可能位于不支持该模式的介质上。`,
            requestId: newIds.request(),
            detail: { requested: resolved.journalMode, applied },
          })
        }
      }
      db.pragma(`synchronous = ${resolved.synchronous}`)
    }

    if (resolved.exclusiveWriter) claimExclusiveWriter(path, db)
    return db
  } catch (thrown) {
    // 配置失败不得留下半开的连接（尤其是它已经在登记表里占位）。
    try {
      db.close()
    } catch {
      /* 关闭失败不掩盖原始错误 */
    }
    throw thrown
  }
}

/** 打开内存库。测试与一次性导出用；**不得**用它承载用户数据。 */
export function openMemoryDatabase(options: OpenDatabaseOptions = {}): SqliteDatabase {
  return openDatabase(':memory:', options)
}

/**
 * `openDatabase` 的 `Result` 版本。失败时用契约错误码返回，不抛异常。
 *
 * 🔴 读失败绝不能被解释为"空库"：调用方必须在 `Err` 分支阻断，而不是继续用空数据覆盖。
 */
export function tryOpenDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
  requestId = newIds.request(),
): import('@yfe/contracts').Result<SqliteDatabase> {
  try {
    return { ok: true, value: openDatabase(path, options) }
  } catch (thrown) {
    return { ok: false, error: sqliteErrorPayload(thrown, requestId) }
  }
}

/** 关闭连接。幂等：重复关闭不抛错。 */
export function closeDatabase(db: SqliteDatabase): void {
  if (db.open) db.close()
}

// ---------------------------------------------------------------------------
// 连接状态读取（供启动自检与测试断言）
// ---------------------------------------------------------------------------

export function readPragma(db: SqliteDatabase, name: string): unknown {
  return db.pragma(name, { simple: true })
}

export function isForeignKeysEnabled(db: SqliteDatabase): boolean {
  return Number(readPragma(db, 'foreign_keys')) === 1
}

export function currentJournalMode(db: SqliteDatabase): string {
  return String(readPragma(db, 'journal_mode')).toLowerCase()
}

export function isWalEnabled(db: SqliteDatabase): boolean {
  return currentJournalMode(db) === 'wal'
}

export function currentBusyTimeoutMs(db: SqliteDatabase): number {
  return Number(readPragma(db, 'busy_timeout'))
}

const SYNCHRONOUS_NAMES: Readonly<Record<number, SynchronousMode>> = {
  0: 'off',
  1: 'normal',
  2: 'full',
  3: 'extra',
}

export function currentSynchronous(db: SqliteDatabase): SynchronousMode | 'unknown' {
  return SYNCHRONOUS_NAMES[Number(readPragma(db, 'synchronous'))] ?? 'unknown'
}

/**
 * 执行 WAL 检查点。
 *
 * 用途：迁移前把 WAL 内容并回主库（备份更小），迁移后截断 WAL（避免无限增长）。
 * 内存库与只读连接下是空操作。
 */
export function checkpointWal(db: SqliteDatabase, mode: WalCheckpointMode = 'PASSIVE'): void {
  if (db.readonly) return
  if (isMemoryPath(db.name)) return
  db.pragma(`wal_checkpoint(${mode})`)
}

// ---------------------------------------------------------------------------
// 驱动错误 → 契约错误码
// ---------------------------------------------------------------------------

/** better-sqlite3 的 `SqliteError` 结构（`code` 形如 `SQLITE_BUSY` / `SQLITE_CONSTRAINT_UNIQUE`）。 */
export interface SqliteLikeError extends Error {
  readonly code?: string
}

function sqliteCodeOf(thrown: unknown): string | null {
  if (typeof thrown !== 'object' || thrown === null) return null
  const code = (thrown as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : null
}

/**
 * 把驱动异常翻译成契约错误载荷。
 *
 * 🔴 只做**翻译**，不新增错误码：目标码全部取自 `@yfe/contracts` 的 `ERROR_CODES`。
 * 🔴 `detail` 只放 SQLite 主码与拓展码，**绝不放 SQL 文本或表名**（可能含正文片段）。
 */
export function sqliteErrorPayload(
  thrown: unknown,
  requestId = newIds.request(),
): import('@yfe/contracts').ErrorPayload {
  const code = sqliteCodeOf(thrown)
  const detail = code === null ? undefined : { sqliteCode: code }
  const pick = (
    mapped: import('@yfe/contracts').ErrorCode,
    message: string,
  ): import('@yfe/contracts').ErrorPayload => ({
    code: mapped,
    message,
    requestId,
    // 🔴 严重度与可重试性**直接取自契约**，不手抄前缀表：
    //    手抄副本会在契约新增/调整错误码时静默漂移，导致 UI 展示的"重试"按钮与实际可重试性不一致。
    severity: severityOf(mapped),
    retryable: isRetryable(mapped),
    ...(detail ? { detail } : {}),
  })

  if (code === null) {
    const raw = thrown instanceof Error ? thrown.message : String(thrown)
    return pick('STORAGE_UNAVAILABLE', raw.length > 0 ? raw : '本地存储发生未预期错误')
  }

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_TIMEOUT' || code.startsWith('SQLITE_LOCKED')) {
    return pick('STORAGE_UNAVAILABLE', '数据库正被其他写入占用，请稍后重试')
  }
  if (code.startsWith('SQLITE_READONLY')) {
    return pick('STORAGE_READ_ONLY', '数据库或所在目录为只读，无法写入')
  }
  if (code === 'SQLITE_FULL' || code === 'SQLITE_IOERR_WRITE' || code === 'SQLITE_IOERR_FSYNC') {
    return pick('STORAGE_DISK_FULL', '磁盘空间不足，保存失败')
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return pick('STORAGE_CORRUPT', '数据库文件已损坏，请从备份恢复')
  }
  if (code === 'SQLITE_CANTOPEN' || code.startsWith('SQLITE_IOERR')) {
    return pick('STORAGE_UNAVAILABLE', '无法打开数据库文件，请检查存储位置是否可用')
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return pick('ALREADY_EXISTS', '目标记录已存在')
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return pick('VALIDATION_FAILED', '数据不满足完整性约束')
  }
  return pick('STORAGE_UNAVAILABLE', '本地存储发生未预期错误')
}
