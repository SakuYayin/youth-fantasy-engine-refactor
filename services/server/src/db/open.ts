/**
 * 后端服务自己的 SQLite 连接打开与连接级参数。
 *
 * 设计依据（`06-数据与本地存储.md`「数据库所有权」与 `04-后端与安全.md`）：
 * - `foreign_keys=ON` → `busy_timeout` → `journal_mode=WAL`（必须在事务外）→ `synchronous=FULL`；
 *   顺序是刻意的，WAL 在事务里执行会静默失败。
 * - 🔴 **单实例 SQLite 不能启动多个独立 writer 副本**：同一进程内对同一个库文件
 *   重复打开写连接会互相制造 `SQLITE_BUSY`，因此这里直接拒绝（见 `claimExclusiveWriter`）。
 * - 连接对象（better-sqlite3 是同步驱动）**不跨线程共享**。
 * - 打开失败必须抛错。**绝不允许**"打不开就退回内存库继续跑"——那会让运维以为服务正常，
 *   实际所有写入都落在临时库里（设计文档 09：启动失败不能创建另一个临时空库继续运行）。
 *
 * 与 `@yfe/persistence-sqlite` 的关系：
 * 桌面端的 `openDatabase` 在 `packages/persistence-sqlite/src/schema/open.ts`，但该包的
 * `./schema` 子路径导出（`src/schema/index.ts`）由 T2 在本轮并行实现，尚未发布；
 * 服务端不能在自己包里 import 一个还不存在的导出面。因此这里保留一份**接口与参数语义
 * 完全对齐**的最小实现（同样的 pragma 顺序、同样的独占写连接断言、同样的 `ContractError`）。
 * 待 `@yfe/persistence-sqlite/schema` 导出稳定后，本文件应改为薄封装并删除重复逻辑。
 * 注意：服务端库与桌面库是**两个不同的库文件 / 两套 schema 版本**，不共享 `schema_migrations`。
 */

import { basename, resolve as resolvePath } from 'node:path'

import { ContractError, newIds } from '@yfe/contracts'
import SqliteDriver from 'better-sqlite3'

/** 驱动原始连接类型：调用方需要 `prepare` / `transaction` / `pragma` / `exec` / `close` 的全部行为。 */
export type ServerDb = SqliteDriver.Database

/** 默认忙等待时长（毫秒）。写连接被占用时最多等这么久再报 `SQLITE_BUSY`。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist' | 'memory' | 'off'
export type SynchronousMode = 'full' | 'normal' | 'off' | 'extra'

export interface OpenServerDatabaseOptions {
  /** 只读连接：不写 WAL、不改 `journal_mode`，仅用于诊断/导出。 */
  readonly readOnly?: boolean
  /** 文件必须已存在（避免"打不开就静默建空库"）。 */
  readonly fileMustExist?: boolean
  /** 忙等待毫秒数。默认 {@link DEFAULT_BUSY_TIMEOUT_MS}。 */
  readonly busyTimeoutMs?: number
  /** 日志模式。文件库默认 `wal`；内存库强制 `memory`。只读连接忽略此选项。 */
  readonly journalMode?: JournalMode
  /** 落盘同步级别。默认 `full`（写可靠性优先）。 */
  readonly synchronous?: SynchronousMode
  /** 独占写连接断言，默认 `true`。仅故障注入测试可显式关闭。 */
  readonly exclusiveWriter?: boolean
}

export interface ResolvedServerOpenOptions {
  readonly readOnly: boolean
  readonly journalMode: JournalMode
  readonly synchronous: SynchronousMode
  readonly busyTimeoutMs: number
  readonly exclusiveWriter: boolean
}

/** 判定路径是否指向内存库。内存库没有 WAL，也没有可备份的文件。 */
export function isMemoryDatabasePath(path: string): boolean {
  return path === '' || path === ':memory:' || path.startsWith('file::memory:')
}

/** 展开默认值。纯函数，供测试断言"默认就是 WAL + FULL"。 */
export function resolveServerOpenOptions(
  path: string,
  options: OpenServerDatabaseOptions = {},
): ResolvedServerOpenOptions {
  const memory = isMemoryDatabasePath(path)
  const readOnly = options.readOnly ?? false
  return {
    readOnly,
    journalMode: memory ? 'memory' : (options.journalMode ?? 'wal'),
    synchronous: options.synchronous ?? 'full',
    busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    exclusiveWriter: options.exclusiveWriter ?? !readOnly,
  }
}

// ---------------------------------------------------------------------------
// 独占写连接登记表
// ---------------------------------------------------------------------------

const openWriters = new Map<string, WeakRef<ServerDb>>()

function canonicalKey(path: string): string {
  const absolute = resolvePath(path)
  // Windows 文件系统大小写不敏感：`A.db` 与 `a.db` 是同一个文件。
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function claimExclusiveWriter(path: string, db: ServerDb): void {
  const key = canonicalKey(path)
  const existing = openWriters.get(key)?.deref()
  if (existing && existing !== db && existing.open) {
    throw new ContractError({
      code: 'RESOURCE_LOCKED',
      // message 只带文件名：日志里的绝对路径会泄露用户名。
      message: `数据库 ${basename(path)} 已有存活写连接。后端必须独占写连接，不得启动多个独立 writer 副本。`,
      requestId: newIds.request(),
    })
  }
  openWriters.set(key, new WeakRef(db))
}

// ---------------------------------------------------------------------------
// 打开 / 关闭
// ---------------------------------------------------------------------------

export function openServerDatabase(
  path: string,
  options: OpenServerDatabaseOptions = {},
): ServerDb {
  const resolved = resolveServerOpenOptions(path, options)

  const db = new SqliteDriver(path, {
    readonly: resolved.readOnly,
    fileMustExist: options.fileMustExist ?? false,
    timeout: resolved.busyTimeoutMs,
  })

  try {
    db.pragma('foreign_keys = ON')
    db.pragma(`busy_timeout = ${resolved.busyTimeoutMs}`)

    if (!resolved.readOnly) {
      if (!isMemoryDatabasePath(path) && resolved.journalMode !== 'memory') {
        // 🔴 必须带 `{ simple: true }`：不带时驱动返回 `[{ journal_mode: 'wal' }]`，
        // `String(...)` 会得到 `[object Object]`，于是"文件库永远启不了 WAL"，
        // 服务一启动就报 STORAGE_UNAVAILABLE。内存库走不到这条分支，所以只有
        // 真实文件库的启动路径会踩到——正是 bootstrapServer 必经的一步。
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
    // 配置失败不得留下半开的连接（尤其它可能已在登记表里占位）。
    try {
      db.close()
    } catch {
      /* 关闭失败不掩盖原始错误 */
    }
    throw thrown
  }
}

/** 关闭连接。幂等：重复关闭不抛错。 */
export function closeServerDatabase(db: ServerDb): void {
  if (db.open) db.close()
}

/** 连接是否仍然可用。就绪探针用它区分"进程活着但库已关闭"。 */
export function isServerDatabaseOpen(db: ServerDb): boolean {
  return db.open
}

/**
 * 同步短事务包装。
 *
 * 🔴 事务内**绝不等待网络 / 文件上传**（设计文档 06）。better-sqlite3 的 `transaction`
 * 嵌套调用会自动降级为 SAVEPOINT，所以服务层可以安全地在事务里调用另一个事务函数。
 */
export function tx<T>(db: ServerDb, fn: () => T): T {
  return db.transaction(fn)()
}

// ---------------------------------------------------------------------------
// 状态读取（供启动自检、就绪探针与测试断言）
// ---------------------------------------------------------------------------

export function readPragma(db: ServerDb, name: string): unknown {
  return db.pragma(name, { simple: true })
}

export interface ServerDatabasePragmaState {
  readonly foreignKeys: boolean
  readonly journalMode: string
  readonly synchronous: string
  readonly busyTimeoutMs: number
}

export function serverDatabasePragmaState(db: ServerDb): ServerDatabasePragmaState {
  return {
    foreignKeys: Number(readPragma(db, 'foreign_keys')) === 1,
    journalMode: String(readPragma(db, 'journal_mode')).toLowerCase(),
    synchronous: String(readPragma(db, 'synchronous')).toLowerCase(),
    busyTimeoutMs: Number(readPragma(db, 'busy_timeout')),
  }
}

/** 表是否存在。就绪探针与"后续任务才建表"的兼容判断用它，避免把缺表当空数据。 */
export function hasTable(db: ServerDb, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: number } | undefined
  return row !== undefined
}

/** 列出所有用户表（排除 SQLite 内部表）。 */
export function listUserTables(db: ServerDb): readonly string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}
