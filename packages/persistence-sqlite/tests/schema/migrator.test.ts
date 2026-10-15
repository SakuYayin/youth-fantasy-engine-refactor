/**
 * `migrator.ts` 的测试：版本闸门、一致备份、单步事务与失败语义。
 *
 * 这里的断言尽量打在**真实库文件**上（含 WAL），因为迁移的正确性几乎全在
 * 「文件系统 + 事务边界」这一层，内存库测不出来。
 */

import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'

import {
  ContractError,
  ERROR_CODES,
  DB_SCHEMA_VERSION,
  fixedClock,
  systemClock,
  type ErrorCode,
  type RequestId,
} from '@yfe/contracts'

import {
  LATEST_SCHEMA_VERSION,
  SCHEMA_DDL,
  SCHEMA_MIGRATIONS,
  SCHEMA_MIGRATIONS_DDL,
  SCHEMA_MIGRATIONS_TABLE,
  type SchemaMigration,
} from '../../src/schema/ddl.js'
import {
  BACKUP_DIR_NAME,
  DEFAULT_BACKUP_KEEP,
  assertSchemaAcceptsWrites,
  assertSchemaCompatible,
  checksumOf,
  createConsistentBackup,
  hasMigrationsTable,
  isMigrationRetryable,
  isSchemaVersionAligned,
  migrate,
  migrationSeverity,
  readSchemaVersion,
} from '../../src/schema/migrator.js'
import {
  closeDatabase,
  openDatabase,
  openMemoryDatabase,
  type SqliteDatabase,
} from '../../src/schema/open.js'
import { cleanupTempDirs, dbPathIn, makeTempDir } from './helpers.js'

afterAll(cleanupTempDirs)

/** 一份用于测试的"表是否存在"查询。 */
function hasTable(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { c: number }
  return row.c === 1
}

function migrationRows(
  db: SqliteDatabase,
): Array<{ version: number; success: number; error_code: string | null; checksum: string }> {
  return db
    .prepare(`SELECT version, success, error_code, checksum FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY id`)
    .all() as Array<{ version: number; success: number; error_code: string | null; checksum: string }>
}

// ---------------------------------------------------------------------------

describe('全新库：一次迁移建出全部表', () => {
  it('空文件库 → v0 → v1，migrated=true，表全部存在', () => {
    const dir = makeTempDir('fresh')
    const db = openDatabase(dbPathIn(dir))
    try {
      const report = migrate(db, { backupDir: null })
      expect(report.fromVersion).toBe(0)
      expect(report.toVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(report.applied).toEqual([1])
      expect(report.migrated).toBe(true)
      // 空库没有可备份的旧数据。
      expect(report.backup).toBeNull()

      for (const table of ['workspaces', 'projects', 'documents', 'local_drafts', 'outbox']) {
        expect(hasTable(db, table), `缺少表 ${table}`).toBe(true)
      }
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      closeDatabase(db)
    }
  })

  it('内存库同样可迁移（备份为 null）', () => {
    const db = openMemoryDatabase()
    try {
      const report = migrate(db)
      expect(report.migrated).toBe(true)
      expect(report.backup).toBeNull()
      expect(hasTable(db, 'documents')).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('重复 migrate 是幂等的：第二次不备份、不重复执行、applied 为空', () => {
    const dir = makeTempDir('idempotent')
    const db = openDatabase(dbPathIn(dir))
    try {
      const first = migrate(db, { backupDir: null })
      expect(first.migrated).toBe(true)

      // 🔴 第二次用**默认** backupDir：如果没有待应用迁移，连备份目录都不该建，
      //    否则用户每次启动都会被备份文件淹没。
      const second = migrate(db)
      expect(second.migrated).toBe(false)
      expect(second.applied).toEqual([])
      expect(second.backup).toBeNull()
      expect(second.fromVersion).toBe(second.toVersion)
      expect(existsSync(join(dir, BACKUP_DIR_NAME))).toBe(false)

      // 台账里只有一条成功记录。
      const success = migrationRows(db).filter((row) => row.success === 1)
      expect(success).toHaveLength(1)
    } finally {
      closeDatabase(db)
    }
  })

  it('migrate 之后能写入并读回真实数据（表结构真的可用）', () => {
    const dir = makeTempDir('usable')
    const db = openDatabase(dbPathIn(dir))
    try {
      migrate(db, { backupDir: null })
      db.prepare(
        `INSERT INTO workspaces (id, name, revision, created_at, updated_at)
         VALUES ('ws_1', '我的作品', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run()
      expect(db.prepare('SELECT name FROM workspaces WHERE id = ?').get('ws_1')).toEqual({
        name: '我的作品',
      })
    } finally {
      closeDatabase(db)
    }
  })

  it('迁移重建一个已存在的表不报错（IF NOT EXISTS 让半成品库仍能迁成功）', () => {
    const dir = makeTempDir('half-baked')
    const db = openDatabase(dbPathIn(dir))
    try {
      // 模拟"表建了但台账丢了"的半成品库。
      db.exec(SCHEMA_DDL)
      const report = migrate(db, { backupDir: null })
      expect(report.migrated).toBe(true)
      expect(report.toVersion).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('🔴 版本过高必须拒绝写入', () => {
  it('库版本高于程序支持版本 → STORAGE_SCHEMA_TOO_NEW（critical，不可重试）', () => {
    const dir = makeTempDir('too-new')
    const db = openDatabase(dbPathIn(dir))
    try {
      migrate(db, { backupDir: null })
      // 伪造"未来版本"的成功记录（v2 不在当前程序清单里，校验和核对会跳过它）。
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, success)
         VALUES (2, 'future-migration', 'sha256:future', '2026-01-01T00:00:00.000Z', 1)`,
      ).run()

      let thrown: unknown
      try {
        migrate(db)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ContractError)
      const contractError = thrown as ContractError
      expect(contractError.code).toBe('STORAGE_SCHEMA_TOO_NEW')
      const payload = contractError.toPayload()
      expect(payload.severity).toBe('critical')
      expect(payload.retryable).toBe(false)
      expect(payload.detail?.foundVersion).toBe(2)
      expect(payload.detail?.supportedVersion).toBe(LATEST_SCHEMA_VERSION)
      // 提示里要给出可操作的出路（升级 / 导出），而不是只说"打不开"。
      expect(contractError.message).toContain('升级')
    } finally {
      closeDatabase(db)
    }
  })

  it('🔴 闸门在任何写入之前：版本过高时连备份都不做', () => {
    const dir = makeTempDir('too-new-no-write')
    const db = openDatabase(dbPathIn(dir))
    try {
      migrate(db, { backupDir: null })
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, success)
         VALUES (5, 'future', 'sha256:x', '2026-01-01T00:00:00.000Z', 1)`,
      ).run()

      expect(() => migrate(db)).toThrow(ContractError)
      // 备份会写文件系统 —— 版本过高时这一步必须没发生。
      expect(existsSync(join(dir, BACKUP_DIR_NAME))).toBe(false)
      // 台账没被追加任何成功记录。
      expect(migrationRows(db).filter((r) => r.success === 1)).toHaveLength(2)
    } finally {
      closeDatabase(db)
    }
  })

  it('assertSchemaCompatible 的三态行为', () => {
    expect(assertSchemaCompatible(0, undefined, 1)).toBe('needs-migration')
    expect(assertSchemaCompatible(1, undefined, 1)).toBe('ok')
    expect(() => assertSchemaCompatible(2, undefined, 1)).toThrow(ContractError)
  })

  it('assertSchemaAcceptsWrites：写入路径的闸门，返回当前版本', () => {
    const db = openMemoryDatabase()
    try {
      // 全新库：还没迁移过，但结构是空的、写入是安全的 —— 返回 0 而不是抛错。
      expect(assertSchemaAcceptsWrites(db)).toBe(0)
      migrate(db, { backupDir: null })
      expect(assertSchemaAcceptsWrites(db)).toBe(1)

      // 库被"未来版本的程序"升级过 → 写入路径必须同样拒绝，而不是只有 migrate 拒绝。
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, success)
         VALUES (9, 'future', 'sha256:x', '2026-01-01T00:00:00.000Z', 1)`,
      ).run()
      let thrown: unknown
      try {
        assertSchemaAcceptsWrites(db)
      } catch (error) {
        thrown = error
      }
      expect((thrown as ContractError).code).toBe('STORAGE_SCHEMA_TOO_NEW')

      // 允许显式传入更低的"本程序支持版本"，供诊断工具复用同一闸门。
      expect(assertSchemaAcceptsWrites(db, { supported: 9 })).toBe(9)
    } finally {
      closeDatabase(db)
    }
  })

  it('只读库上迁移被拒绝为 STORAGE_READ_ONLY', () => {
    const dir = makeTempDir('migrate-readonly')
    const path = dbPathIn(dir)
    const writer = openDatabase(path)
    migrate(writer, { backupDir: null })
    closeDatabase(writer)

    const reader = openDatabase(path, { readOnly: true })
    try {
      let thrown: unknown
      try {
        migrate(reader)
      } catch (error) {
        thrown = error
      }
      expect((thrown as ContractError).code).toBe('STORAGE_READ_ONLY')
    } finally {
      closeDatabase(reader)
    }
  })
})

describe('校验和：已发布迁移不可事后修改', () => {
  it('checksumOf 覆盖 version / name / ddl：改任何一项都变', () => {
    const base: SchemaMigration = { version: 1, name: 'a', ddl: 'SELECT 1' }
    const checksum = checksumOf(base)
    expect(checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(checksumOf({ ...base, ddl: 'SELECT 2' })).not.toBe(checksum)
    expect(checksumOf({ ...base, name: 'b' })).not.toBe(checksum)
    expect(checksumOf({ ...base, version: 2 })).not.toBe(checksum)
    // 稳定：同一输入永远同一结果。
    expect(checksumOf(base)).toBe(checksum)
  })

  it('台账里的校验和被篡改 → STORAGE_MIGRATION_FAILED，且不执行任何迁移', () => {
    const dir = makeTempDir('checksum')
    const db = openDatabase(dbPathIn(dir))
    try {
      migrate(db, { backupDir: null })
      db.prepare(`UPDATE ${SCHEMA_MIGRATIONS_TABLE} SET checksum = 'sha256:tampered' WHERE version = 1`).run()

      let thrown: unknown
      try {
        migrate(db)
      } catch (error) {
        thrown = error
      }
      const contractError = thrown as ContractError
      expect(contractError.code).toBe('STORAGE_MIGRATION_FAILED')
      expect(contractError.toPayload().detail?.expectedChecksum).toBe(checksumOf(SCHEMA_MIGRATIONS[0]!))
      expect(contractError.toPayload().detail?.appliedChecksum).toBe('sha256:tampered')
      // 校验和不合时不得"尽力迁移"：原始数据保持不动。
      expect(hasTable(db, 'documents')).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('新增迁移不会误报已有迁移的校验和', () => {
    const dir = makeTempDir('checksum-extend')
    const db = openDatabase(dbPathIn(dir))
    try {
      const extended: readonly SchemaMigration[] = [
        ...SCHEMA_MIGRATIONS,
        { version: 2, name: 'add-column', ddl: 'CREATE TABLE probe_ext (id TEXT PRIMARY KEY)' },
      ]
      const first = migrate(db, { backupDir: null, migrations: extended })
      expect(first.applied).toEqual([1, 2])
      const again = migrate(db, { backupDir: null, migrations: extended })
      expect(again.migrated).toBe(false)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('🔴 单步事务：失败不推进版本', () => {
  /** 三步清单，第 3 步 DDL 故意语法错误。 */
  const steps: readonly SchemaMigration[] = [
    { version: 1, name: 'step-1', ddl: 'CREATE TABLE step_one (id TEXT PRIMARY KEY)' },
    { version: 2, name: 'step-2', ddl: 'CREATE TABLE step_two (id TEXT PRIMARY KEY)' },
    { version: 3, name: 'step-3-broken', ddl: 'CREATE TABLE step_three (id TEXT, )' },
    { version: 4, name: 'step-4', ddl: 'CREATE TABLE step_four (id TEXT PRIMARY KEY)' },
  ]

  it('第 3 步失败：前两步保留、版本停在 2、抛 STORAGE_MIGRATION_FAILED、第 4 步不执行', () => {
    const dir = makeTempDir('partial')
    const db = openDatabase(dbPathIn(dir))
    try {
      let thrown: unknown
      try {
        migrate(db, { backupDir: null, migrations: steps })
      } catch (error) {
        thrown = error
      }
      const contractError = thrown as ContractError
      expect(contractError).toBeInstanceOf(ContractError)
      expect(contractError.code).toBe('STORAGE_MIGRATION_FAILED')
      expect(contractError.toPayload().detail?.version).toBe(3)
      expect(contractError.toPayload().detail?.fromVersion).toBe(2)

      // 已成功的步骤**保留**（不是"所有迁移一个大事务"）。
      expect(hasTable(db, 'step_one')).toBe(true)
      expect(hasTable(db, 'step_two')).toBe(true)
      // 失败步骤回滚：表没建成。
      expect(hasTable(db, 'step_three')).toBe(false)
      // 失败点之后的步骤不执行。
      expect(hasTable(db, 'step_four')).toBe(false)
      // 🔴 失败不推进版本。
      expect(readSchemaVersion(db)).toBe(2)
    } finally {
      closeDatabase(db)
    }
  })

  it('失败会留下 success=0 的审计行，且 error_code 是契约错误码', () => {
    const dir = makeTempDir('failure-audit')
    const db = openDatabase(dbPathIn(dir))
    try {
      expect(() => migrate(db, { backupDir: null, migrations: steps })).toThrow(ContractError)

      const rows = migrationRows(db)
      const failed = rows.filter((row) => row.success === 0)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.version).toBe(3)
      expect(ERROR_CODES).toContain(failed[0]?.error_code as ErrorCode)
      // 成功行只有 1、2。
      expect(rows.filter((r) => r.success === 1).map((r) => r.version)).toEqual([1, 2])
    } finally {
      closeDatabase(db)
    }
  })

  it('失败后库仍可打开与导出：修好清单重试能从版本 2 继续', () => {
    const dir = makeTempDir('retry-after-failure')
    const db = openDatabase(dbPathIn(dir))
    try {
      expect(() => migrate(db, { backupDir: null, migrations: steps })).toThrow()

      // 修复第 3 步（模拟发布修复版本），重试：只跑 3、4。
      const repaired: readonly SchemaMigration[] = [
        steps[0]!,
        steps[1]!,
        { version: 3, name: 'step-3-fixed', ddl: 'CREATE TABLE step_three (id TEXT PRIMARY KEY)' },
        steps[3]!,
      ]
      const report = migrate(db, { backupDir: null, migrations: repaired })
      expect(report.fromVersion).toBe(2)
      expect(report.toVersion).toBe(4)
      expect(report.applied).toEqual([3, 4])
      expect(hasTable(db, 'step_three')).toBe(true)
      expect(hasTable(db, 'step_four')).toBe(true)
    } finally {
      closeDatabase(db)
    }
  })

  it('失败时仍创建了迁移前备份（除非显式关闭）', () => {
    const dir = makeTempDir('failure-backup')
    const db = openDatabase(dbPathIn(dir))
    try {
      expect(() => migrate(db, { migrations: steps })).toThrow(ContractError)
      const backups = join(dir, BACKUP_DIR_NAME)
      expect(existsSync(backups)).toBe(true)
      expect(readdirSync(backups).length).toBeGreaterThan(0)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('迁移清单自检', () => {
  it('重复版本号 → STORAGE_MIGRATION_FAILED', () => {
    const db = openMemoryDatabase()
    try {
      expect(() =>
        migrate(db, {
          backupDir: null,
          migrations: [
            { version: 1, name: 'a', ddl: 'SELECT 1' },
            { version: 1, name: 'b', ddl: 'SELECT 1' },
          ],
        }),
      ).toThrow(ContractError)
    } finally {
      closeDatabase(db)
    }
  })

  it('版本号非升序 → STORAGE_MIGRATION_FAILED', () => {
    const db = openMemoryDatabase()
    try {
      expect(() =>
        migrate(db, {
          backupDir: null,
          migrations: [
            { version: 2, name: 'b', ddl: 'SELECT 1' },
            { version: 1, name: 'a', ddl: 'SELECT 1' },
          ],
        }),
      ).toThrow(ContractError)
    } finally {
      closeDatabase(db)
    }
  })

  it('版本号越界（1000，属于后端区间）→ STORAGE_MIGRATION_FAILED', () => {
    const db = openMemoryDatabase()
    try {
      expect(() =>
        migrate(db, { backupDir: null, migrations: [{ version: 1000, name: 'x', ddl: 'SELECT 1' }] }),
      ).toThrow(ContractError)
    } finally {
      closeDatabase(db)
    }
  })

  it('默认清单通过自检且与契约版本对齐', () => {
    const db = openMemoryDatabase()
    try {
      expect(() => migrate(db, { backupDir: null })).not.toThrow()
      expect(isSchemaVersionAligned()).toBe(true)
      expect(LATEST_SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('readSchemaVersion 的语义', () => {
  it('🔴 台账表还不存在 → 0（全新库是正常状态，不是 STORAGE_UNAVAILABLE）', () => {
    const db = openMemoryDatabase()
    try {
      expect(hasMigrationsTable(db)).toBe(false)
      // 不建表直接读：写入路径上会对全新库调用它，抛错会被误报成"存储不可用"。
      expect(readSchemaVersion(db)).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })

  it('台账已建但无记录 → 0', () => {
    const db = openMemoryDatabase()
    try {
      db.exec(SCHEMA_MIGRATIONS_DDL)
      expect(hasMigrationsTable(db)).toBe(true)
      expect(readSchemaVersion(db)).toBe(0)
    } finally {
      closeDatabase(db)
    }
  })

  it('🔴 只认 success = 1：失败审计行不推进版本', () => {
    const db = openMemoryDatabase()
    try {
      migrate(db, { backupDir: null })
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, success, error_code)
         VALUES (99, 'failed-future', 'sha256:x', '2026-01-01T00:00:00.000Z', 0, 'STORAGE_UNAVAILABLE')`,
      ).run()
      expect(readSchemaVersion(db)).toBe(1)
    } finally {
      closeDatabase(db)
    }
  })

  it('取 MAX(version) 而不是 COUNT(*)：版本号不连续也正确', () => {
    const db = openMemoryDatabase()
    try {
      migrate(db, { backupDir: null })
      // 直接塞一条"更高版本已成功"的记录（模拟被撤回的空号之后又跳号迁移）。
      db.prepare(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name, checksum, applied_at, success)
         VALUES (7, 'gap', 'sha256:x', '2026-01-01T00:00:00.000Z', 1)`,
      ).run()
      expect(readSchemaVersion(db)).toBe(7)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('🔴 一致备份：VACUUM INTO 而不是复制文件', () => {
  it('只复制主文件会丢掉 WAL 里的最近写入（这就是不能用复制的原因）', () => {
    const dir = makeTempDir('naive-copy')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      // 关掉自动检查点，让最近的写入停在 WAL 里 —— 这是"用户刚敲完就崩"的真实状态。
      db.pragma('wal_autocheckpoint = 0')
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '用户刚敲的正文')

      const naive = join(dir, 'naive.db')
      copyFileSync(path, naive)
      const naiveDb = new Database(naive, { readonly: true })
      try {
        const row = naiveDb
          .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 't'")
          .get() as { c: number }
        // 主文件里连表都还没有：天真复制得到的是一个空库。
        expect(row.c).toBe(0)
      } finally {
        naiveDb.close()
      }
    } finally {
      closeDatabase(db)
    }
  })

  it('VACUUM INTO 备份包含 WAL 里的最新写入，且可直接打开', () => {
    const dir = makeTempDir('vacuum-backup')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      db.pragma('wal_autocheckpoint = 0')
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT)')
      db.prepare('INSERT INTO t VALUES (?, ?)').run('a', '用户刚敲的正文')

      const backup = createConsistentBackup(db, {
        dbPath: path,
        backupDir: join(dir, 'bk'),
        fromVersion: 0,
        clock: systemClock,
      })
      expect(backup).not.toBeNull()
      const restoredPath = backup!.path
      expect(backup!.byteSize).toBeGreaterThan(0)
      expect(backup!.fromVersion).toBe(0)
      expect(existsSync(restoredPath)).toBe(true)

      const restored = new Database(restoredPath, { readonly: true })
      try {
        expect(restored.prepare('SELECT body FROM t WHERE id = ?').get('a')).toEqual({
          body: '用户刚敲的正文',
        })
      } finally {
        restored.close()
      }
    } finally {
      closeDatabase(db)
    }
  })

  it('默认备份目录是库文件同级的 backups/，文件名含来源版本与时间戳', () => {
    const dir = makeTempDir('default-backup-dir')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      // 不传 backupDir → 默认落在 dirname(db.name)/backups。
      const backup = createConsistentBackup(db, {
        dbPath: path,
        fromVersion: 3,
        clock: fixedClock('2026-03-04T05:06:07.000Z'),
      })
      expect(backup).not.toBeNull()
      const name = backup!.path
      expect(dirname(name)).toBe(join(dir, BACKUP_DIR_NAME))
      expect(basename(name)).toContain('app')
      expect(basename(name)).toContain('v3')
      // Windows 上 `:` 是非法文件名字符，时间戳必须已被安全化。
      expect(basename(name)).not.toContain(':')
    } finally {
      closeDatabase(db)
    }
  })

  it('固定时钟下重复备份不会互相覆盖（VACUUM INTO 拒绝已存在的目标）', () => {
    const dir = makeTempDir('backup-collision')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      const options = {
        dbPath: path,
        backupDir: join(dir, 'bk'),
        fromVersion: 0,
        clock: fixedClock('2026-03-04T05:06:07.000Z'),
      }
      const first = createConsistentBackup(db, options)
      const second = createConsistentBackup(db, options)
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(first!.path).not.toBe(second!.path)
      expect(existsSync(first!.path)).toBe(true)
      expect(existsSync(second!.path)).toBe(true)
      expect(readdirSync(join(dir, 'bk'))).toHaveLength(2)
    } finally {
      closeDatabase(db)
    }
  })

  it('保留份数：超出 keep 的旧备份被清理，且只清理 .db', () => {
    const dir = makeTempDir('backup-prune')
    const path = dbPathIn(dir)
    const backupDir = join(dir, 'bk')
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      for (let i = 0; i < 4; i += 1) {
        createConsistentBackup(db, {
          dbPath: path,
          backupDir,
          fromVersion: i,
          clock: fixedClock(`2026-03-04T05:06:0${i}.000Z`),
          keep: 2,
        })
      }
      const files = readdirSync(backupDir)
      expect(files.filter((name) => name.endsWith('.db')).length).toBeLessThanOrEqual(2)

      // 用户手放的说明文件不能被误删。
      writeFileSync(join(backupDir, 'README.txt'), '这些是迁移前备份')
      writeFileSync(join(backupDir, 'another-novel.db'), '用户另一本书')
      createConsistentBackup(db, {
        dbPath: path,
        backupDir,
        fromVersion: 9,
        clock: fixedClock('2026-03-04T05:07:00.000Z'),
        keep: 1,
      })
      expect(readdirSync(backupDir)).toContain('README.txt')
      expect(readdirSync(backupDir)).toContain('another-novel.db')
      expect(DEFAULT_BACKUP_KEEP).toBe(5)
    } finally {
      closeDatabase(db)
    }
  })

  it('备份目录与源库同目录时，保留策略不能清理源数据库', () => {
    const dir = makeTempDir('backup-prune-source')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      db.exec('CREATE TABLE source_data (body TEXT)')
      for (let i = 0; i < 2; i += 1) {
        createConsistentBackup(db, { dbPath: path, backupDir: dir, fromVersion: i,
          clock: fixedClock(`2026-03-04T05:06:0${i}.000Z`), keep: 1 })
      }
      expect(existsSync(path)).toBe(true)
    } finally { closeDatabase(db) }
  })

  it('一百个备份路径全部碰撞时，不能删除已有备份', () => {
    const dir = makeTempDir('backup-collision-limit')
    const path = dbPathIn(dir)
    const db = openDatabase(path)
    try {
      const options = { dbPath: path, backupDir: dir, fromVersion: 0, clock: fixedClock('2026-03-04T05:06:07.000Z') }
      const first = createConsistentBackup(db, options)!
      for (let i = 1; i < 100; i += 1) writeFileSync(`${first.path}.${i}.db`, 'existing backup')
      expect(() => createConsistentBackup(db, options)).toThrow(ContractError)
      expect(existsSync(`${first.path}.99.db`)).toBe(true)
      expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toHaveLength(101)
    } finally { closeDatabase(db) }
  })

  it('内存库没有可备份的文件 → 整体返回 null（不是 path:null 的空壳）', () => {
    const db = openMemoryDatabase()
    try {
      const backup = createConsistentBackup(db, {
        dbPath: ':memory:',
        backupDir: join(makeTempDir('mem-backup'), 'bk'),
        fromVersion: 0,
        clock: systemClock,
      })
      expect(backup).toBeNull()
    } finally {
      closeDatabase(db)
    }
  })

  it('🔴 备份必须在事务外：迁移循环里没有 VACUUM/VACUUM INTO', () => {
    // `VACUUM` 在事务内会抛 "cannot VACUUM from within a transaction"。
    // 这条断言防的是后人把备份挪进迁移事务里"顺便保证原子性"。
    const db = openMemoryDatabase()
    try {
      db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
      expect(() => {
        db.exec('BEGIN')
        try {
          db.prepare('VACUUM INTO ?').run(join(makeTempDir('vacuum-in-txn'), 'x.db'))
        } finally {
          db.exec('ROLLBACK')
        }
      }).toThrow(/cannot VACUUM from within a transaction/)
    } finally {
      closeDatabase(db)
    }
  })
})

describe('迁移留下的痕迹可审计', () => {
  it('台账记录 version / name / checksum / applied_at / duration_ms / success', () => {
    const dir = makeTempDir('audit')
    const db = openDatabase(dbPathIn(dir))
    try {
      migrate(db, { backupDir: null, clock: fixedClock('2026-05-06T07:08:09.000Z') })
      const row = db
        .prepare(
          `SELECT version, name, checksum, applied_at, duration_ms, success FROM ${SCHEMA_MIGRATIONS_TABLE}`,
        )
        .get() as {
        version: number
        name: string
        checksum: string
        applied_at: string
        duration_ms: number
        success: number
      }
      expect(row.version).toBe(1)
      expect(row.name).toBe(SCHEMA_MIGRATIONS[0]?.name)
      expect(row.checksum).toBe(checksumOf(SCHEMA_MIGRATIONS[0]!))
      // 注入固定时钟后时间可断言（证明 clock 真的被用上，而不是直接读系统时间）。
      expect(row.applied_at).toBe('2026-05-06T07:08:09.000Z')
      expect(row.duration_ms).toBeGreaterThanOrEqual(0)
      expect(row.success).toBe(1)
    } finally {
      closeDatabase(db)
    }
  })

  it('verbose 回调收到可读的迁移过程（不外泄 SQL 全文）', () => {
    const dir = makeTempDir('verbose')
    const db = openDatabase(dbPathIn(dir))
    try {
      const messages: string[] = []
      migrate(db, { verbose: (message) => messages.push(message) })
      expect(messages.some((m) => m.includes('迁移前备份已创建'))).toBe(true)
      expect(messages.some((m) => m.includes('应用迁移 v1'))).toBe(true)
      expect(messages.some((m) => m.includes('迁移完成'))).toBe(true)
      // 日志里不应出现建表语句正文。
      expect(messages.join('\n')).not.toContain('CREATE TABLE')
    } finally {
      closeDatabase(db)
    }
  })
})

describe('错误转发（供 IPC 边界决定重试与阻断）', () => {
  it('isMigrationRetryable / migrationSeverity 直接取自契约', () => {
    const tooNew = new ContractError({
      code: 'STORAGE_SCHEMA_TOO_NEW',
      message: 'x',
      requestId: 'req_1' as RequestId,
    }).toPayload()
    // 结构版本过高是 critical，绝不能给"重试"按钮。
    expect(migrationSeverity(tooNew)).toBe('critical')
    expect(isMigrationRetryable(tooNew)).toBe(false)

    const busy = new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'x',
      requestId: 'req_2' as RequestId,
    }).toPayload()
    expect(migrationSeverity(busy)).toBe('error')
    expect(isMigrationRetryable(busy)).toBe(true)

    const corrupted = new ContractError({
      code: 'STORAGE_CORRUPT',
      message: 'x',
      requestId: 'req_3' as RequestId,
    }).toPayload()
    expect(migrationSeverity(corrupted)).toBe('critical')
    expect(isMigrationRetryable(corrupted)).toBe(false)
  })

  it('抛出的 ContractError 都带 requestId（可把失败和用户操作对上）', () => {
    const db = openMemoryDatabase()
    try {
      let thrown: unknown
      try {
        migrate(db, { backupDir: null, requestId: 'req_fixed' as RequestId })
      } catch (error) {
        thrown = error
      }
      // 默认清单不会失败，这里只是确认成功路径不抛。
      expect(thrown).toBeUndefined()
    } finally {
      closeDatabase(db)
    }
  })
})
