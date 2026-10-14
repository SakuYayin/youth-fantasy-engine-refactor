/**
 * P3-A3：**已发布的 v1 库升级到 v2** 的路径。
 *
 * 为什么必须单独测：迁移 2（`src/db/syncDdl.ts`）里唯一带数据语义的语句是
 * `workspaces` 回填 —— v1 把工作区 ID 只存在 `workspace_members` 里，不回填的话
 * 老库的工作区会在 `GET /api/v1/workspaces` 里**整条消失**（列表走 LEFT JOIN，
 * 名字退化成 ID，但 `workspaces` 表本身仍是空的）。而 `makeHarness()` 打开的是全新库：
 * SCHEMA_DDL 建出的成员表是空的，回填语句跑在空表上，无论对错都"通过"。
 * 所以这里手工造一个**带数据的 v1 库**，再走真正的升级路径。
 *
 * 造库手法：SCHEMA_DDL 是版本 1 的全集；迁移器自己的版本记录表不属于任何
 * 被迁移的版本（`migrator.ts:209` 注释），所以照它的 DDL 手工建表并记一条
 * 版本 1 记录，就得到一个"刚刚交付的 v1 生产库"。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { newIds } from '@yfe/contracts'
import type { UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { testClock } from './helpers.js'
import {
  SCHEMA_DDL,
  SERVER_MIGRATIONS_TABLE,
  appliedServerMigrations,
  checksumOf,
  closeServerDatabase,
  createUser,
  currentServerSchemaVersion,
  findWorkspace,
  hasTable,
  listMemberships,
  listWorkspacesForUser,
  migrateServerDatabase,
  openServerDatabase,
  upsertMember,
} from '../src/db/index.js'
import type { ServerDb } from '../src/db/open.js'

/** 时间戳走测试时钟，拿到带品牌的 `UtcTimestamp`（不能直接写裸字符串字面量）。 */
const AT: UtcTimestamp = testClock().now()

const openDatabases: ServerDb[] = []

afterEach(() => {
  while (openDatabases.length > 0) closeServerDatabase(openDatabases.pop() as ServerDb)
})

/** 版本记录表的 DDL 与 `migrator.ts` 保持一致（迁移器的私有元数据表）。 */
const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${SERVER_MIGRATIONS_TABLE} (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  note TEXT
)`

function openV1Database(): { db: ServerDb; userId: UserId; workspaceId: WorkspaceId } {
  const db = openServerDatabase(':memory:')
  openDatabases.push(db)

  // 1) 版本 1 的全部基线表（**原样**执行，不碰任何语句）。
  for (const statement of SCHEMA_DDL) db.exec(statement)

  // 2) 迁移器的元数据：记一条版本 1，校验和与当前清单一致。
  db.exec(MIGRATIONS_TABLE_DDL)
  db
    .prepare(
      `INSERT INTO ${SERVER_MIGRATIONS_TABLE} (version, checksum, applied_at, success) VALUES (1, ?, ?, 1)`,
    )
    .run(checksumOf(SCHEMA_DDL), AT)

  // 3) v1 时代的数据：所有者 + 成员关系（v1 没有 workspaces 元数据表）。
  const userId = newIds.user()
  const workspaceId = newIds.workspace()
  createUser(db, {
    id: userId,
    username: 'legacy-owner',
    displayName: '老库所有者',
    passwordHash: 'not-a-real-hash',
    at: AT,
  })
  upsertMember(db, workspaceId, userId, 'owner', AT)

  return { db, userId, workspaceId }
}

function columnNames(db: ServerDb, table: string): readonly string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

describe('已发布 v1 库升级到 v2', () => {
  it('v1 的工作区在升级后被回填进 workspaces，且不丢角色归属', async () => {
    const { db, userId, workspaceId } = openV1Database()

    // 升级前：工作区只存在于成员表里 —— `workspaces` 这张表根本不存在。
    expect(currentServerSchemaVersion(db)).toBe(1)
    expect(hasTable(db, 'workspaces')).toBe(false)
    expect(listMemberships(db, userId).map((member) => member.workspaceId)).toEqual([workspaceId])

    const result = await migrateServerDatabase(db)

    expect(result.applied).toEqual([2])
    expect(currentServerSchemaVersion(db)).toBe(2)

    const workspace = findWorkspace(db, workspaceId)
    expect(workspace).not.toBeNull()
    expect(workspace?.name).toBe('默认工作区')
    expect(workspace?.createdByUserId).toBe(userId)
    expect(workspace?.createdAt).toBe(AT)

    // 成员关系原样保留，列表里能拿到回填后的名字与角色。
    const summaries = listWorkspacesForUser(db, userId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.workspaceId).toBe(workspaceId)
    expect(summaries[0]?.role).toBe('owner')
    expect(summaries[0]?.name).toBe('默认工作区')
  })

  it('升级可重复执行：第二次没有待应用版本，也不覆盖已回填的元数据', async () => {
    const { db, workspaceId } = openV1Database()

    const first = await migrateServerDatabase(db)
    expect(first.applied).toEqual([2])

    const second = await migrateServerDatabase(db)
    expect(second.applied).toEqual([])
    expect(second.schemaVersion).toBe(2)

    const versions = appliedServerMigrations(db)
    expect(versions.map((entry) => entry.version)).toEqual([1, 2])
    expect(versions.every((entry) => entry.success)).toBe(true)
    // 版本 1 的记录没被改写（已发布迁移的校验和是防偷改的锚点）。
    expect(versions[0]?.checksum).toBe(checksumOf(SCHEMA_DDL))

    expect(findWorkspace(db, workspaceId)?.name).toBe('默认工作区')
  })

  it('升级补齐新表与新列，且不动 v1 的既有列', async () => {
    const { db } = openV1Database()

    await migrateServerDatabase(db)

    for (const table of ['workspaces', 'sync_entities', 'sync_conflicts']) {
      expect(hasTable(db, table), `缺表 ${table}`).toBe(true)
    }

    // 新列：回执的幂等键、change_feed 的批/操作溯源。
    expect(columnNames(db, 'sync_receipts')).toContain('idempotency_key')
    expect(columnNames(db, 'change_feed')).toContain('batch_id')
    expect(columnNames(db, 'change_feed')).toContain('op_id')

    // v1 的既有列一个都没丢（ALTER TABLE 只加不改）。
    for (const column of [
      'batch_id',
      'workspace_id',
      'device_id',
      'submitted_by_user_id',
      'payload_digest',
      'operation_count',
      'accepted_at',
      'cursor',
      'response_json',
    ]) {
      expect(columnNames(db, 'sync_receipts'), `sync_receipts 缺列 ${column}`).toContain(column)
    }
    for (const column of ['server_seq', 'workspace_id', 'entity_type', 'entity_id', 'action']) {
      expect(columnNames(db, 'change_feed'), `change_feed 缺列 ${column}`).toContain(column)
    }
  })

  it('库版本高于程序支持范围时拒绝迁移，一个字节都不写（STORAGE_SCHEMA_TOO_NEW）', async () => {
    const { db } = openV1Database()
    await migrateServerDatabase(db)

    // 伪造"来自未来"的迁移记录。
    const future = 99
    db
      .prepare(
        `INSERT INTO ${SERVER_MIGRATIONS_TABLE} (version, checksum, applied_at, success) VALUES (?, ?, ?, 1)`,
      )
      .run(future, 'future-checksum', AT)

    await expect(migrateServerDatabase(db)).rejects.toMatchObject({
      code: 'STORAGE_SCHEMA_TOO_NEW',
    })
    // 拒绝发生在任何语句执行之前：新表仍在，维度没变。
    expect(currentServerSchemaVersion(db)).toBe(future)
    expect(hasTable(db, 'sync_entities')).toBe(true)
  })
})
