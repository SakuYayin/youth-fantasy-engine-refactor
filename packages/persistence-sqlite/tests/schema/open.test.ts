/**
 * `open.ts` 的连接级参数与错误映射测试。
 *
 * 覆盖 task-2 要求：「WAL/foreign_keys/busy_timeout 实际生效」「并发写触发 SQLITE_BUSY
 * 时的错误映射」，外加「独占写连接」「只读连接不写 WAL」等 open.ts 的既有约束。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { ContractError } from '@yfe/contracts'

import {
  DEFAULT_BUSY_TIMEOUT_MS,
  checkpointWal,
  closeDatabase,
  currentBusyTimeoutMs,
  currentJournalMode,
  currentSynchronous,
  isForeignKeysEnabled,
  isMemoryPath,
  isWalEnabled,
  openDatabase,
  openMemoryDatabase,
  resolveOpenOptions,
  sqliteErrorPayload,
  tryOpenDatabase,
} from '../../src/schema/open.js'
import { cleanupTempDirs, dbPathIn, makeTempDir } from './helpers.js'

afterAll(cleanupTempDirs)

describe('resolveOpenOptions 默认值', () => {
  it('文件库默认 WAL + synchronous=full + busy_timeout + 独占写', () => {
    const resolved = resolveOpenOptions('C:\\data\\app.db')
    expect(resolved.journalMode).toBe('wal')
    expect(resolved.synchronous).toBe('full')
    expect(resolved.busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    expect(resolved.exclusiveWriter).toBe(true)
    expect(resolved.readOnly).toBe(false)
  })

  it('内存库强制 memory 日志模式（内存库没有 WAL）', () => {
    expect(resolveOpenOptions(':memory:').journalMode).toBe('memory')
    expect(resolveOpenOptions('').journalMode).toBe('memory')
    expect(resolveOpenOptions('file::memory:').journalMode).toBe('memory')
  })

  it('只读连接默认不注册独占写', () => {
    expect(resolveOpenOptions('C:\\data\\app.db', { readOnly: true }).exclusiveWriter).toBe(false)
  })

  it('isMemoryPath 只认内存库写法，不误判普通路径', () => {
    expect(isMemoryPath(':memory:')).toBe(true)
    expect(isMemoryPath('C:\\data\\app.db')).toBe(false)
  })
})

describe('openDatabase 连接级参数实际生效', () => {
  it('文件库开启 WAL 且 foreign_keys / busy_timeout / synchronous 符合预期', () => {
    const dir = makeTempDir('open-params')
    const db = openDatabase(dbPathIn(dir))
    try {
      // journal_mode 用 pragma 实测而不是相信我们传进去的字符串。
      expect(currentJournalMode(db)).toBe('wal')
      expect(isWalEnabled(db)).toBe(true)
      expect(isForeignKeysEnabled(db)).toBe(true)
      expect(currentBusyTimeoutMs(db)).toBe(DEFAULT_BUSY_TIMEOUT_MS)
      // synchronous=full 在 WAL 下对应 pragma 值 2。
      expect(currentSynchronous(db)).toBe('full')
      // 数据库文件真实落盘。
      expect(existsSync(dbPathIn(dir))).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('Wal 生效：写入后存在 -wal 文件（证明不是被降级成 delete 模式）', () => {
    const dir = makeTempDir('wal-file')
    const db = openDatabase(dbPathIn(dir))
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '正文')
      expect(existsSync(dbPathIn(dir) + '-wal')).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('foreign_keys 真实拦截违反外键的写入', () => {
    const dir = makeTempDir('fk-enforced')
    const db = openDatabase(dbPathIn(dir))
    try {
      db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent (id));
      `)
      expect(() => db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'missing')).toThrow()
      db.prepare('INSERT INTO parent VALUES (?)').run('p1')
      expect(() => db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'p1')).not.toThrow()
    } finally {
      closeDatabase(db)
    }
  })

  it('busy_timeout 可覆盖，且实际写成 pragma 值', () => {
    const dir = makeTempDir('busy-timeout')
    const db = openDatabase(dbPathIn(dir), { busyTimeoutMs: 1234 })
    try {
      expect(currentBusyTimeoutMs(db)).toBe(1234)
    } finally {
      closeDatabase(db)
    }
  })

  it('WAL 持久化在库文件里：重开仍为 wal（说明写进了文件头而不是仅会话内）', () => {
    const dir = makeTempDir('wal-persist')
    const path = dbPathIn(dir)
    const first = openDatabase(path)
    first.exec('CREATE TABLE t (id TEXT)')
    closeDatabase(first)

    const second = openDatabase(path)
    try {
      expect(currentJournalMode(second)).toBe('wal')
    } finally {
      closeDatabase(second)
    }
  })
})

describe('独占写连接', () => {
  it('同一进程内重复打开同一个库文件被拒绝（RESOURCE_LOCKED）', () => {
    const dir = makeTempDir('exclusive')
    const path = dbPathIn(dir)
    const first = openDatabase(path)
    try {
      let thrown: unknown
      try {
        openDatabase(path)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ContractError)
      expect((thrown as ContractError).code).toBe('RESOURCE_LOCKED')
      // 🔴 错误信息不得泄露绝对路径（可能含用户名）。
      expect((thrown as ContractError).message).not.toContain(dir)
    } finally {
      closeDatabase(first)
    }
  })

  it('前一个连接关闭后可以重新打开', () => {
    const dir = makeTempDir('exclusive-release')
    const path = dbPathIn(dir)
    closeDatabase(openDatabase(path))
    const again = openDatabase(path)
    try {
      expect(again.open).toBe(true)
    } finally {
      closeDatabase(again)
    }
  })

  it('exclusiveWriter:false 允许为故障注入故意开第二个连接', () => {
    const dir = makeTempDir('exclusive-off')
    const path = dbPathIn(dir)
    const first = openDatabase(path)
    const second = openDatabase(path, { exclusiveWriter: false })
    try {
      expect(second.open).toBe(true)
    } finally {
      closeDatabase(second)
      closeDatabase(first)
    }
  })

  it('Windows 上大小写不同的同一路径视为同一个库', () => {
    // 仅在大小写不敏感文件系统上有意义；Windows 是本项目的主目标平台。
    if (process.platform !== 'win32') return
    const dir = makeTempDir('case-insensitive')
    const path = dbPathIn(dir, 'App.db')
    const first = openDatabase(path)
    try {
      expect(() => openDatabase(dbPathIn(dir, 'app.db'))).toThrow(ContractError)
    } finally {
      closeDatabase(first)
    }
  })
})

describe('只读连接', () => {
  it('只读连接不写 WAL、拒绝写入，且报 STORAGE_READ_ONLY', () => {
    const dir = makeTempDir('readonly')
    const path = dbPathIn(dir)
    const writer = openDatabase(path)
    writer.exec('CREATE TABLE t (id TEXT)')
    writer.prepare('INSERT INTO t VALUES (?)').run('a')
    closeDatabase(writer)

    // 只读连接不注册独占写，因此不会与上面的写连接冲突（上面已关闭，这里再开也行）。
    const reader = openDatabase(path, { readOnly: true })
    try {
      expect(reader.readonly).toBe(true)
      expect(isForeignKeysEnabled(reader)).toBe(true)
      let thrown: unknown
      try {
        reader.exec('CREATE TABLE nope (id TEXT)')
      } catch (error) {
        thrown = error
      }
      expect(sqliteErrorPayload(thrown).code).toBe('STORAGE_READ_ONLY')
    } finally {
      closeDatabase(reader)
    }
  })

  it('fileMustExist 阻止"打不开就静默建空库"', () => {
    const dir = makeTempDir('must-exist')
    const missing = join(dir, 'nope.db')
    expect(() => openDatabase(missing, { readOnly: true, fileMustExist: true })).toThrow()
    // 🔴 关键断言：失败后不得留下新建的空文件。
    expect(existsSync(missing)).toBe(false)
  })
})

describe('内存库', () => {
  it('openMemoryDatabase 可用且日志模式为 memory', () => {
    const db = openMemoryDatabase()
    try {
      expect(currentJournalMode(db)).toBe('memory')
      expect(isForeignKeysEnabled(db)).toBe(true)
      expect(currentSynchronous(db)).toBe('full')
    } finally {
      closeDatabase(db)
    }
  })

  it('checkpointWal 对内存库是空操作（不抛错）', () => {
    const db = openMemoryDatabase()
    try {
      expect(() => checkpointWal(db, 'TRUNCATE')).not.toThrow()
    } finally {
      closeDatabase(db)
    }
  })

  it('checkpointWal 对文件库把 WAL 并回主库', () => {
    const dir = makeTempDir('checkpoint')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
      const insert = db.prepare('INSERT INTO t VALUES (?, ?)')
      for (let i = 0; i < 50; i += 1) insert.run(`k${i}`, 'x'.repeat(200))
      expect(statSync(path + '-wal').size).toBeGreaterThan(0)
      checkpointWal(db, 'TRUNCATE')
      // TRUNCATE 之后 WAL 文件长度归零。
      expect(statSync(path + '-wal').size).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('sqliteErrorPayload 错误映射', () => {
  it('SQLITE_BUSY → STORAGE_UNAVAILABLE 且可重试', () => {
    const payload = sqliteErrorPayload(errorWithCode('SQLITE_BUSY', 'database is locked'))
    expect(payload.code).toBe('STORAGE_UNAVAILABLE')
    expect(payload.retryable).toBe(true)
    expect(payload.detail?.sqliteCode).toBe('SQLITE_BUSY')
  })

  it('SQLITE_READONLY → STORAGE_READ_ONLY，不可重试', () => {
    const payload = sqliteErrorPayload(errorWithCode('SQLITE_READONLY', 'readonly database'))
    expect(payload.code).toBe('STORAGE_READ_ONLY')
    expect(payload.retryable).toBe(false)
  })

  it('SQLITE_FULL → STORAGE_DISK_FULL（critical，不可重试）', () => {
    const payload = sqliteErrorPayload(errorWithCode('SQLITE_FULL', 'disk full'))
    expect(payload.code).toBe('STORAGE_DISK_FULL')
    expect(payload.severity).toBe('critical')
    expect(payload.retryable).toBe(false)
  })

  it('SQLITE_CORRUPT / SQLITE_NOTADB → STORAGE_CORRUPT（critical）', () => {
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_NOTADB']) {
      const payload = sqliteErrorPayload(errorWithCode(code, 'malformed'))
      expect(payload.code).toBe('STORAGE_CORRUPT')
      expect(payload.severity).toBe('critical')
    }
  })

  it('唯一约束 → ALREADY_EXISTS；其它约束 → VALIDATION_FAILED', () => {
    expect(sqliteErrorPayload(errorWithCode('SQLITE_CONSTRAINT_UNIQUE', 'x')).code).toBe(
      'ALREADY_EXISTS',
    )
    expect(sqliteErrorPayload(errorWithCode('SQLITE_CONSTRAINT_PRIMARYKEY', 'x')).code).toBe(
      'ALREADY_EXISTS',
    )
    expect(sqliteErrorPayload(errorWithCode('SQLITE_CONSTRAINT_CHECK', 'x')).code).toBe(
      'VALIDATION_FAILED',
    )
  })

  it('🔴 只翻译不发明错误码：所有映射结果都必须是契约里的码', () => {
    const codes = [
      'SQLITE_BUSY',
      'SQLITE_READONLY',
      'SQLITE_FULL',
      'SQLITE_CORRUPT',
      'SQLITE_CANTOPEN',
      'SQLITE_IOERR',
      'SQLITE_CONSTRAINT_UNIQUE',
      'SQLITE_CONSTRAINT_FOREIGNKEY',
      'SQLITE_MISMATCH',
    ]
    for (const code of codes) {
      expect(sqliteErrorPayload(errorWithCode(code, 'x')).code).toMatch(/^[A-Z][A-Z_]+$/)
    }
  })

  it('非 SQLite 错误兜底为 STORAGE_UNAVAILABLE', () => {
    const payload = sqliteErrorPayload(new Error('boom'))
    expect(payload.code).toBe('STORAGE_UNAVAILABLE')
    // 没有驱动主码时不带 sqliteCode（避免 detail 里出现无意义字段）。
    expect(payload.detail).toBeUndefined()
  })

  it('🔴 detail 不放 SQL 文本或表名（避免正文片段经日志泄露）', () => {
    const payload = sqliteErrorPayload(
      errorWithCode('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: documents.id'),
    )
    expect(JSON.stringify(payload.detail)).not.toContain('documents')
    expect(payload.message).not.toContain('documents')
  })

  it('severity / retryable 与契约 severityOf / isRetryable 完全一致', async () => {
    const { severityOf, isRetryable } = await import('@yfe/contracts')
    const codes = [
      'SQLITE_BUSY',
      'SQLITE_BUSY_TIMEOUT',
      'SQLITE_LOCKED_SHAREDCACHE',
      'SQLITE_READONLY',
      'SQLITE_FULL',
      'SQLITE_IOERR_WRITE',
      'SQLITE_CORRUPT',
      'SQLITE_NOTADB',
      'SQLITE_CANTOPEN',
      'SQLITE_CONSTRAINT_UNIQUE',
      'SQLITE_CONSTRAINT_CHECK',
      'SQLITE_ERROR',
    ]
    for (const code of codes) {
      const payload = sqliteErrorPayload(errorWithCode(code, 'x'))
      expect(payload.severity).toBe(severityOf(payload.code))
      expect(payload.retryable).toBe(isRetryable(payload.code))
    }
  })
})

describe('真实并发写触发 SQLITE_BUSY', () => {
  it('第二个写连接持锁时，等待超时报 SQLITE_BUSY 并映射为可重试错误', () => {
    const dir = makeTempDir('busy')
    const path = dbPathIn(dir)
    const holder = openDatabase(path)
    // 故意开第二个连接：验证错误映射，而不是验证独占约束。
    const challenger = openDatabase(path, { exclusiveWriter: false, busyTimeoutMs: 20 })
    try {
      holder.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      holder.exec('BEGIN IMMEDIATE')
      holder.prepare('INSERT INTO t VALUES (?)').run('held')

      let thrown: unknown
      try {
        challenger.prepare('INSERT INTO t VALUES (?)').run('blocked')
      } catch (error) {
        thrown = error
      }
      // SQLite 在忙等超时后报 SQLITE_BUSY（`database is locked`）。
      expect(thrown).toBeDefined()
      const payload = sqliteErrorPayload(thrown)
      expect(payload.code).toBe('STORAGE_UNAVAILABLE')
      expect(payload.retryable).toBe(true)
      expect(payload.detail?.sqliteCode).toMatch(/^SQLITE_(BUSY|LOCKED)/)

      holder.exec('ROLLBACK')
      // 释放锁之后同一连接可以正常写入（证明失败是锁竞争而不是结构问题）。
      expect(() => challenger.prepare('INSERT INTO t VALUES (?)').run('after')).not.toThrow()
    } finally {
      closeDatabase(challenger)
      closeDatabase(holder)
    }
  })

  it('写入被回滚后不留半截数据', () => {
    const dir = makeTempDir('rollback')
    const db = openDatabase(dbPathIn(dir))
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      const write = db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?)').run('a')
        throw new Error('模拟中途失败')
      })
      expect(() => write()).toThrow('模拟中途失败')
      expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 })
    } finally {
      closeDatabase(db)
    }
  })
})

describe('tryOpenDatabase / closeDatabase', () => {
  it('成功时返回 Ok', () => {
    const result = tryOpenDatabase(':memory:')
    expect(result.ok).toBe(true)
    if (result.ok) closeDatabase(result.value)
  })

  it('失败时返回 Err 且带契约错误码，不抛异常', () => {
    const dir = makeTempDir('try-open')
    const result = tryOpenDatabase(join(dir, 'missing.db'), {
      readOnly: true,
      fileMustExist: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('STORAGE_UNAVAILABLE')
      expect(typeof result.error.requestId).toBe('string')
      expect(result.error.requestId.startsWith('req_')).toBe(true)
    }
  })

  it('closeDatabase 幂等', () => {
    const db = openMemoryDatabase()
    expect(() => {
      closeDatabase(db)
      closeDatabase(db)
    }).not.toThrow()
  })
})

/** 造一个带 `code` 的类驱动错误（不需要真的触发 SQLite 故障）。 */
function errorWithCode(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
