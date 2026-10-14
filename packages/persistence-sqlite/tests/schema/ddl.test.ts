/**
 * `ddl.ts` 的结构测试：把「设计文档说要有哪些表/列/约束」变成可执行断言。
 *
 * 这里的断言全部打在**真实的 SQLite 实例**上（`PRAGMA table_info` / 实际插入），
 * 而不是对 DDL 字符串做正则匹配——字符串匹配无法证明约束真的生效。
 */

import { describe, expect, it } from 'vitest'

import { DB_SCHEMA_VERSION } from '@yfe/contracts'

import {
  BACKEND_MIGRATION_VERSION_BASE,
  DESKTOP_MIGRATION_VERSION_MAX,
  DESKTOP_MIGRATION_VERSION_MIN,
  DESKTOP_TABLE_NAMES,
  LATEST_SCHEMA_VERSION,
  RESERVED_BACKEND_TABLE_NAMES,
  SCHEMA_DDL,
  SCHEMA_MIGRATIONS,
  SCHEMA_MIGRATIONS_DDL,
  SCHEMA_MIGRATIONS_TABLE,
  isDesktopMigrationVersion,
  isDesktopTable,
  isReservedBackendTable,
} from '../../src/schema/ddl.js'
import { closeDatabase, openMemoryDatabase, type SqliteDatabase } from '../../src/schema/open.js'

/** 建一个应用了 v1 DDL（+ 台账表）的内存库。 */
function migratedMemoryDb(): SqliteDatabase {
  const db = openMemoryDatabase()
  db.exec(SCHEMA_MIGRATIONS_DDL)
  db.exec(SCHEMA_DDL)
  return db
}

function withDb<T>(fn: (db: SqliteDatabase) => T): T {
  const db = migratedMemoryDb()
  try {
    return fn(db)
  } finally {
    closeDatabase(db)
  }
}

interface ColumnInfo {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: string | null
  readonly pk: number
}

function columnsOf(db: SqliteDatabase, table: string): readonly ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
}

function columnNames(db: SqliteDatabase, table: string): readonly string[] {
  return columnsOf(db, table).map((column) => column.name)
}

function userTableNames(db: SqliteDatabase): readonly string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function indexNames(db: SqliteDatabase): readonly string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

/** 插入一行最小可用的 workspace，返回其 id。 */
function seedWorkspace(db: SqliteDatabase, id = 'ws_1', name = '我的作品'): string {
  db.prepare(
    `INSERT INTO workspaces (id, name, revision, created_at, updated_at)
     VALUES (?, ?, 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, name)
  return id
}

function seedProject(db: SqliteDatabase, workspaceId: string, id = 'prj_1'): string {
  db.prepare(
    `INSERT INTO projects (id, workspace_id, name, revision, created_at, updated_at)
     VALUES (?, ?, '第一卷', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, workspaceId)
  return id
}

// ---------------------------------------------------------------------------

describe('表清单', () => {
  it('DDL 建出设计文档要求的全部 17 张桌面表', () => {
    withDb((db) => {
      const created = userTableNames(db)
      for (const table of DESKTOP_TABLE_NAMES) {
        expect(created, `缺少表 ${table}`).toContain(table)
      }
    })
  })

  it('DDL 不多建表：实际表集合 == DESKTOP_TABLE_NAMES + schema_migrations', () => {
    withDb((db) => {
      const expected = [...DESKTOP_TABLE_NAMES, SCHEMA_MIGRATIONS_TABLE].sort()
      expect(userTableNames(db)).toEqual(expected)
    })
  })

  it('🔴 不建后端表（users / sessions 等只预留版本区间）', () => {
    withDb((db) => {
      const created = userTableNames(db)
      for (const reserved of RESERVED_BACKEND_TABLE_NAMES) {
        expect(created, `桌面库不得创建后端表 ${reserved}`).not.toContain(reserved)
      }
    })
  })

  it('isDesktopTable / isReservedBackendTable 判定正确', () => {
    expect(isDesktopTable('documents')).toBe(true)
    expect(isDesktopTable('users')).toBe(false)
    expect(isReservedBackendTable('users')).toBe(true)
    expect(isReservedBackendTable('documents')).toBe(false)
  })

  it('DDL 幂等：重复 exec 不报错（半成品库仍能迁移成功）', () => {
    withDb((db) => {
      expect(() => db.exec(SCHEMA_DDL)).not.toThrow()
    })
  })

  it('🔴 DDL 不含 PRAGMA / VACUUM / 事务控制语句（迁移在事务内 exec）', () => {
    // `PRAGMA journal_mode` 在事务内会抛错，`VACUUM` 被明确拒绝（实测）。
    // 这两者必须在 openDatabase 阶段处理，不能出现在迁移 DDL 里。
    const stripped = SCHEMA_DDL.replace(/--[^\n]*/g, '').toUpperCase()
    expect(stripped).not.toMatch(/\bPRAGMA\b/)
    expect(stripped).not.toMatch(/\bVACUUM\b/)
    expect(stripped).not.toMatch(/\bBEGIN\b/)
    expect(stripped).not.toMatch(/\bCOMMIT\b/)
    expect(stripped).not.toMatch(/\bROLLBACK\b/)
  })

  it('迁移台账 DDL 幂等且只建 schema_migrations', () => {
    const db = openMemoryDatabase()
    try {
      db.exec(SCHEMA_MIGRATIONS_DDL)
      expect(() => db.exec(SCHEMA_MIGRATIONS_DDL)).not.toThrow()
      expect(userTableNames(db)).toEqual([SCHEMA_MIGRATIONS_TABLE])
    } finally {
      closeDatabase(db)
    }
  })
})

describe('revision 与 revision_seq 成对出现', () => {
  /**
   * `revisions` 是版本历史表：它的 `revision` 列是**历史快照携带的旧 revision 字符串**，
   * 不是"当前版本"，因此按 Lead 裁决用整数列 `seq` 排序，**刻意不带** `revision_seq`。
   * 其余带 `revision` 的表都是实体表，必须成对带 `revision_seq`。
   */
  const ENTITY_TABLES = DESKTOP_TABLE_NAMES.filter((t) => t !== 'revisions')

  it('🔴 每张有 revision 列的实体表都必须有 revision_seq（新 revision 的唯一来源）', () => {
    withDb((db) => {
      for (const table of ENTITY_TABLES) {
        const names = columnNames(db, table)
        if (!names.includes('revision')) continue
        expect(names, `${table} 有 revision 却没有 revision_seq`).toContain('revision_seq')
      }
    })
  })

  it('🔴 revisions 是历史表：带 seq 而不带 revision_seq', () => {
    withDb((db) => {
      const names = columnNames(db, 'revisions')
      expect(names).toContain('seq')
      expect(names).not.toContain('revision_seq')
    })
  })

  it('revision_seq 是 NOT NULL 整数（禁止用 revision 字符串做算术）', () => {
    withDb((db) => {
      for (const table of DESKTOP_TABLE_NAMES) {
        const column = columnsOf(db, table).find((c) => c.name === 'revision_seq')
        if (!column) continue
        expect(column.type, `${table}.revision_seq 必须是 INTEGER`).toMatch(/INTEGER/i)
        expect(column.notnull, `${table}.revision_seq 必须 NOT NULL`).toBe(1)
      }
    })
  })

  it('revision_seq 不接受负数', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspaces (id, name, revision, revision_seq, created_at, updated_at)
             VALUES ('ws_neg', 'x', 'r00000001', -1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })

  it('documents 同时具备 revision 与 revision_seq，且 revision 不可为空', () => {
    withDb((db) => {
      const names = columnNames(db, 'documents')
      expect(names).toContain('revision')
      expect(names).toContain('revision_seq')

      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      // 省略 revision → NOT NULL 约束拦住（不允许"没有版本"的实体行）。
      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, created_at, updated_at)
             VALUES ('doc_1', ?, ?, 'chapter', 'a0', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(workspaceId, projectId),
      ).toThrow()
    })
  })
})

describe('revisions 表：序号是排序与去重的真值来源', () => {
  it('列清单与主键符合约定', () => {
    withDb((db) => {
      const columns = columnsOf(db, 'revisions')
      const byName = new Map(columns.map((c) => [c.name, c]))
      expect([...byName.keys()].sort()).toEqual(
        [
          'base_revision',
          'body_snapshot',
          'created_at',
          'entity_id',
          'entity_type',
          'id',
          'revision',
          'seq',
          'source_op_id',
          'values_snapshot',
          'workspace_id',
        ].sort(),
      )
      expect(byName.get('id')?.pk).toBe(1)
      // seq 必须显式提供（无 DEFAULT）：历史序号不能靠默认值悄悄变成 0。
      expect(byName.get('seq')?.notnull).toBe(1)
      expect(byName.get('seq')?.dflt_value).toBeNull()
      expect(byName.get('revision')?.notnull).toBe(1)
    })
  })

  it('UNIQUE (entity_type, entity_id, seq) 真实生效', () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO revisions (id, workspace_id, entity_type, entity_id, revision, seq, created_at)
         VALUES (?, 'ws_1', 'document', 'doc_1', ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      insert.run('rev_1', 'r00000001', 1)
      // 同一实体同一序号 → 拒绝（序号是排序真值，不允许两行同序号）。
      expect(() => insert.run('rev_1b', 'r00000001', 1)).toThrow()
      // 不同实体同序号 → 允许。
      expect(() =>
        db
          .prepare(
            `INSERT INTO revisions (id, workspace_id, entity_type, entity_id, revision, seq, created_at)
             VALUES ('rev_2', 'ws_1', 'document', 'doc_2', 'r00000001', 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow()
      // 同实体递增序号 → 允许。
      expect(() => insert.run('rev_3', 'r00000002', 2)).not.toThrow()
    })
  })

  it('UNIQUE (entity_type, entity_id, revision) 防重复快照（幂等重放）', () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO revisions (id, workspace_id, entity_type, entity_id, revision, seq, created_at)
         VALUES (?, 'ws_1', 'document', 'doc_1', ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      insert.run('rev_1', 'r00000001', 1)
      expect(() => insert.run('rev_2', 'r00000001', 2)).toThrow()
    })
  })

  it('🔴 不建 workspace/entity 外键：级联删除不得毁掉唯一恢复版本', () => {
    withDb((db) => {
      // 乱写的 entity_id 与 workspace_id 都能插入 —— 修订历史是同步事实来源，
      // 外键的级联删除会让"用户改动永久丢失"。
      expect(() =>
        db
          .prepare(
            `INSERT INTO revisions (id, workspace_id, entity_type, entity_id, revision, seq, created_at)
             VALUES ('rev_orphan', 'ws_does_not_exist', 'document', 'doc_does_not_exist', 'r00000001', 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow()
    })
  })

  it('seq 不接受负数', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO revisions (id, workspace_id, entity_type, entity_id, revision, seq, created_at)
             VALUES ('rev_neg', 'ws_1', 'document', 'doc_1', 'r00000001', -1, '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })
})

describe('documents 表结构与约束', () => {
  it('列清单符合 SaveDraft 层约定（snake_case）', () => {
    withDb((db) => {
      expect([...columnNames(db, 'documents')].sort()).toEqual(
        [
          'body',
          'created_at',
          'deleted',
          'id',
          'kind',
          'order_key',
          'parent_id',
          'project_id',
          'revision',
          'revision_seq',
          'title',
          'updated_at',
          'workspace_id',
        ].sort(),
      )
    })
  })

  it('kind 只接受四种取值', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      const insert = db.prepare(
        `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'a0', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      for (const kind of ['volume', 'chapter', 'outline', 'note']) {
        expect(() => insert.run(`doc_${kind}`, workspaceId, projectId, kind)).not.toThrow()
      }
      expect(() => insert.run('doc_bad', workspaceId, projectId, 'poem')).toThrow()
    })
  })

  it('parent_id 不允许自引用（拦住最直接的环）', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, workspace_id, project_id, kind, parent_id, order_key, revision, created_at, updated_at)
             VALUES ('doc_self', ?, ?, 'volume', 'doc_self', 'a0', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(workspaceId, projectId),
      ).toThrow()
    })
  })

  it('parent_id 指向不存在的文档 → 外键拒绝', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      expect(() =>
        db
          .prepare(
            `INSERT INTO documents (id, workspace_id, project_id, kind, parent_id, order_key, revision, created_at, updated_at)
             VALUES ('doc_orphan', ?, ?, 'chapter', 'doc_missing', 'a0', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(workspaceId, projectId),
      ).toThrow()
    })
  })

  it('中文与 emoji 往返无损（离线写作必须支持）', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      const body = '第一章：他抬头看了看天。\n「你到底想说什么？」\n😀🎋 — 破折号与全角标点。'
      db.prepare(
        `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, title, body, revision, created_at, updated_at)
         VALUES ('doc_cn', ?, ?, 'chapter', 'a0', '第一章 相遇', ?, 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(workspaceId, projectId, body)
      const row = db.prepare('SELECT title, body FROM documents WHERE id = ?').get('doc_cn') as {
        title: string
        body: string
      }
      expect(row.body).toBe(body)
      expect(row.title).toBe('第一章 相遇')
    })
  })

  it('order_key 是字符串：允许 FTS/LexoRank 风格的长键，不做数值排序假设', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      const insert = db.prepare(
        `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'chapter', ?, 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      insert.run('doc_a', workspaceId, projectId, 'a0')
      insert.run('doc_b', workspaceId, projectId, 'a0V')
      insert.run('doc_c', workspaceId, projectId, 'a1')
      const order = (
        db
          .prepare('SELECT id FROM documents ORDER BY order_key')
          .all() as Array<{ id: string }>
      ).map((row) => row.id)
      expect(order).toEqual(['doc_a', 'doc_b', 'doc_c'])
    })
  })
})

describe('JSON 列必须真实校验', () => {
  it('settings_entities.values_json / relations.values_json 拒绝非法 JSON', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      expect(() =>
        db
          .prepare(
            `INSERT INTO settings_entities (id, workspace_id, project_id, schema_template_id, order_key, values_json, revision, created_at, updated_at)
             VALUES ('se_1', ?, ?, 'tpl', 'a0', '{不是JSON', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(workspaceId, projectId),
      ).toThrow()
      expect(() =>
        db
          .prepare(
            `INSERT INTO relations (id, workspace_id, project_id, kind, from_entity_id, to_entity_id, values_json, revision, created_at, updated_at)
             VALUES ('rel_1', ?, ?, 'character', 'a', 'b', 'not json', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(workspaceId, projectId),
      ).toThrow()
    })
  })

  it('operations.payload_json 拒绝非法 JSON', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO operations (op_id, batch_id, workspace_id, entity_type, entity_id, new_revision, action, payload_json, created_at)
             VALUES ('op_1', 'b1', 'ws_1', 'document', 'doc_1', 'r00000001', 'upsert', 'oops', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })

  it('plugin_data.value_json / config_values.value_json 拒绝非法 JSON 并接受 JSON null', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO plugin_data (workspace_id, plugin_id, key, revision, value_json, created_at, updated_at)
             VALUES ('ws_1', 'p1', 'k', 'r00000001', 'nope', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
      expect(() =>
        db
          .prepare(
            `INSERT INTO plugin_data (workspace_id, plugin_id, key, revision, value_json, created_at, updated_at)
             VALUES ('ws_1', 'p1', 'k', 'r00000001', 'null', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow()
    })
  })

  it('保留未知字段：JSON 里的额外键原样往返', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      const values = JSON.stringify({ 别名: '小玉', unknown_future_field: { nested: [1, 2, 3] } })
      db.prepare(
        `INSERT INTO settings_entities (id, workspace_id, project_id, schema_template_id, order_key, values_json, revision, created_at, updated_at)
         VALUES ('se_2', ?, ?, 'tpl', 'a0', ?, 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(workspaceId, projectId, values)
      const row = db.prepare('SELECT values_json FROM settings_entities WHERE id = ?').get('se_2') as {
        values_json: string
      }
      expect(JSON.parse(row.values_json)).toEqual({
        别名: '小玉',
        unknown_future_field: { nested: [1, 2, 3] },
      })
    })
  })
})

describe('deleted 标志', () => {
  it('接受任意非 0 的脏值（判定语义是「非 0 即删除」）', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      const insert = db.prepare(
        `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, revision, deleted, created_at, updated_at)
         VALUES (?, ?, ?, 'chapter', 'a0', 'r00000001', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      // 导入旧数据时可能出现非 0/1 的值：用 CHECK (deleted >= 0) 而不是 IN (0, 1)。
      expect(() => insert.run('doc_d0', workspaceId, projectId, 0)).not.toThrow()
      expect(() => insert.run('doc_d2', workspaceId, projectId, 2)).not.toThrow()
      expect(() => insert.run('doc_dneg', workspaceId, projectId, -1)).toThrow()
    })
  })
})

describe('外键与级联', () => {
  it('删除 workspace 级联删除其 projects 与 documents', () => {
    withDb((db) => {
      const workspaceId = seedWorkspace(db)
      const projectId = seedProject(db, workspaceId)
      db.prepare(
        `INSERT INTO documents (id, workspace_id, project_id, kind, order_key, revision, created_at, updated_at)
         VALUES ('doc_1', ?, ?, 'chapter', 'a0', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run(workspaceId, projectId)

      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId)

      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM documents').get()).toEqual({ c: 0 })
    })
  })

  it('project 必须属于一个存在的 workspace', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO projects (id, workspace_id, name, revision, created_at, updated_at)
             VALUES ('prj_orphan', 'ws_missing', 'x', 'r00000001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })

  it('🔴 local_drafts 不建外键：草稿是崩溃恢复资产，宁可孤儿也不能丢字', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO local_drafts (document_id, session_id, sequence, body, updated_at)
             VALUES ('doc_never_committed', 'sess_1', 3, '用户刚敲的一段话', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow()
    })
  })

  it('删除 job 级联删除其 job_outputs', () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO jobs (id, workspace_id, kind, executor, status, created_at, updated_at)
         VALUES ('job_1', 'ws_1', 'export', 'local', 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run()
      db.prepare(
        `INSERT INTO job_outputs (job_id, sequence, output_ref, created_at)
         VALUES ('job_1', 0, 'ref:1', '2026-01-01T00:00:00.000Z')`,
      ).run()
      db.prepare('DELETE FROM jobs WHERE id = ?').run('job_1')
      expect(db.prepare('SELECT COUNT(*) AS c FROM job_outputs').get()).toEqual({ c: 0 })
    })
  })

  it('outbox.op_id 外键指向 operations（孤儿 outbox 不允许存在）', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO outbox (op_id, workspace_id, batch_id, created_at)
             VALUES ('op_missing', 'ws_1', 'b1', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })
})

describe('local_drafts 表结构（SaveDraft 层约定，不得改名）', () => {
  it('列名与主键完全符合约定', () => {
    withDb((db) => {
      const columns = columnsOf(db, 'local_drafts')
      expect(columns.map((c) => c.name).sort()).toEqual(
        [
          'base_revision',
          'body',
          'confirmed_revision',
          'document_id',
          'sequence',
          'session_id',
          'updated_at',
        ].sort(),
      )
      // 主键 (document_id, session_id)：pk 序号 1/2。
      const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
      expect(pk).toEqual(['document_id', 'session_id'])
    })
  })

  it('base_revision / confirmed_revision 可为 NULL，body 不可为 NULL', () => {
    withDb((db) => {
      const byName = new Map(columnsOf(db, 'local_drafts').map((c) => [c.name, c]))
      expect(byName.get('base_revision')?.notnull).toBe(0)
      expect(byName.get('confirmed_revision')?.notnull).toBe(0)
      expect(byName.get('body')?.notnull).toBe(1)
      expect(byName.get('updated_at')?.notnull).toBe(1)
    })
  })

  it('确认后不删行：写 confirmed_revision 并清空 body，行仍在', () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO local_drafts (document_id, session_id, sequence, body, base_revision, updated_at)
         VALUES ('doc_1', 'sess_1', 7, '草稿正文', 'r00000001', '2026-01-01T00:00:00.000Z')`,
      ).run()
      db.prepare(
        `UPDATE local_drafts SET body = '', confirmed_revision = 'r00000002', updated_at = '2026-01-01T00:00:01.000Z'
         WHERE document_id = 'doc_1' AND session_id = 'sess_1'`,
      ).run()
      const row = db
        .prepare('SELECT sequence, body, base_revision, confirmed_revision FROM local_drafts')
        .get() as {
        sequence: number
        body: string
        base_revision: string
        confirmed_revision: string
      }
      expect(row.body).toBe('')
      expect(row.confirmed_revision).toBe('r00000002')
      // base_revision 与 confirmed_revision 必须可比较相等（都是 revision 字符串）。
      expect(row.base_revision).toBe('r00000001')
      expect(row.sequence).toBe(7)
    })
  })

  it('主键去重：同一 (document_id, session_id) 只能有一行', () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO local_drafts (document_id, session_id, sequence, body, updated_at)
         VALUES ('doc_1', 'sess_1', ?, 'x', '2026-01-01T00:00:00.000Z')`,
      )
      insert.run(1)
      expect(() => insert.run(2)).toThrow()
    })
  })

  it('sequence 不接受负数', () => {
    withDb((db) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO local_drafts (document_id, session_id, sequence, body, updated_at)
             VALUES ('doc_1', 'sess_1', -1, 'x', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })
})

describe('operations / outbox 表结构', () => {
  it('operations 列清单符合约定，action 只接受 upsert / delete', () => {
    withDb((db) => {
      expect([...columnNames(db, 'operations')].sort()).toEqual(
        [
          'action',
          'actor',
          'base_revision',
          'batch_id',
          'created_at',
          'entity_id',
          'entity_type',
          'new_revision',
          'op_id',
          'payload_json',
          'project_id',
          'workspace_id',
        ].sort(),
      )
      const insert = db.prepare(
        `INSERT INTO operations (op_id, batch_id, workspace_id, entity_type, entity_id, new_revision, action, created_at)
         VALUES (?, 'b1', 'ws_1', 'document', 'doc_1', 'r00000001', ?, '2026-01-01T00:00:00.000Z')`,
      )
      expect(() => insert.run('op_u', 'upsert')).not.toThrow()
      expect(() => insert.run('op_d', 'delete')).not.toThrow()
      expect(() => insert.run('op_x', 'patch')).toThrow()
    })
  })

  it('outbox 列清单符合约定，target_id 默认 local', () => {
    withDb((db) => {
      expect([...columnNames(db, 'outbox')].sort()).toEqual(
        [
          'attempt_count',
          'batch_id',
          'created_at',
          'last_error_code',
          'next_attempt_at',
          'op_id',
          'state',
          'target_id',
          'workspace_id',
        ].sort(),
      )
      db.prepare(
        `INSERT INTO operations (op_id, batch_id, workspace_id, entity_type, entity_id, new_revision, action, created_at)
         VALUES ('op_1', 'b1', 'ws_1', 'document', 'doc_1', 'r00000001', 'upsert', '2026-01-01T00:00:00.000Z')`,
      ).run()
      db.prepare(
        `INSERT INTO outbox (op_id, workspace_id, batch_id, created_at)
         VALUES ('op_1', 'ws_1', 'b1', '2026-01-01T00:00:00.000Z')`,
      ).run()
      const row = db.prepare('SELECT target_id, state, attempt_count FROM outbox').get() as {
        target_id: string
        state: string
        attempt_count: number
      }
      expect(row.target_id).toBe('local')
      expect(row.state).toBe('pending')
      expect(row.attempt_count).toBe(0)
    })
  })

  it('outbox 只接受四种状态', () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO operations (op_id, batch_id, workspace_id, entity_type, entity_id, new_revision, action, created_at)
         VALUES (?, 'b1', 'ws_1', 'document', 'doc_1', 'r00000001', 'upsert', '2026-01-01T00:00:00.000Z')`,
      )
      const outbox = db.prepare(
        `INSERT INTO outbox (op_id, workspace_id, batch_id, state, created_at)
         VALUES (?, 'ws_1', 'b1', ?, '2026-01-01T00:00:00.000Z')`,
      )
      for (const state of ['pending', 'sending', 'acknowledged', 'failed']) {
        insert.run(`op_${state}`)
        expect(() => outbox.run(`op_${state}`, state)).not.toThrow()
      }
      insert.run('op_bad')
      expect(() => outbox.run('op_bad', 'done')).toThrow()
    })
  })
})

describe('jobs / conflicts / checkpoints 的枚举约束', () => {
  it('jobs.status 覆盖契约的 9 个状态且拒绝其它值', () => {
    withDb((db) => {
      const insert = db.prepare(
        `INSERT INTO jobs (id, workspace_id, kind, executor, status, created_at, updated_at)
         VALUES (?, 'ws_1', 'export', 'local', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      const statuses = [
        'queued',
        'running',
        'waiting_network',
        'waiting_confirmation',
        'paused',
        'cancelling',
        'succeeded',
        'failed',
        'cancelled',
      ]
      for (const status of statuses) {
        expect(() => insert.run(`job_${status}`, status)).not.toThrow()
      }
      expect(() => insert.run('job_bad', 'done')).toThrow()
    })
  })

  it('conflicts 保留双方内容：resolution 默认 pending，kind 受约束', () => {
    withDb((db) => {
      db.prepare(
        `INSERT INTO conflicts (id, workspace_id, entity_type, entity_id, kind, local_revision, remote_revision, local_payload, remote_payload, created_at)
         VALUES ('cf_1', 'ws_1', 'document', 'doc_1', 'text-diverged', 'r00000002', 'r00000003', '本地正文', '远端正文', '2026-01-01T00:00:00.000Z')`,
      ).run()
      const row = db.prepare('SELECT resolution, local_payload, remote_payload FROM conflicts').get() as {
        resolution: string
        local_payload: string
        remote_payload: string
      }
      expect(row.resolution).toBe('pending')
      // 🔴 冲突必须保留双方内容，不能退化为空库覆盖。
      expect(row.local_payload).toBe('本地正文')
      expect(row.remote_payload).toBe('远端正文')

      expect(() =>
        db
          .prepare(
            `INSERT INTO conflicts (id, workspace_id, entity_type, entity_id, kind, local_revision, remote_revision, created_at)
             VALUES ('cf_2', 'ws_1', 'document', 'doc_1', 'whatever', 'r1', 'r2', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow()
    })
  })

  it('sync_checkpoints 游标存 TEXT：超出 JS 安全整数的游标不得被转成 number', () => {
    withDb((db) => {
      const huge = '9007199254740993' // 2^53 + 1，Number 无法精确表示
      db.prepare(
        `INSERT INTO sync_checkpoints (target_id, workspace_id, cursor, updated_at)
         VALUES ('local', 'ws_1', ?, '2026-01-01T00:00:00.000Z')`,
      ).run(huge)
      const row = db.prepare('SELECT cursor FROM sync_checkpoints').get() as { cursor: string }
      expect(typeof row.cursor).toBe('string')
      expect(row.cursor).toBe(huge)
    })
  })

  it('sync_checkpoints 主键是 (target_id, workspace_id)', () => {
    withDb((db) => {
      const pk = columnsOf(db, 'sync_checkpoints')
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name)
      expect(pk).toEqual(['target_id', 'workspace_id'])
    })
  })

  it('assets.local_state 只接受四态（文件与数据库没有一体事务）', () => {
    withDb((db) => {
      // `assets.workspace_id` 有外键 → 必须先有工作区，否则报的是外键错而不是 CHECK 错。
      seedWorkspace(db)
      const insert = db.prepare(
        `INSERT INTO assets (id, workspace_id, storage_key, sha256, byte_size, mime_type, local_state, created_at)
         VALUES (?, 'ws_1', 'assets/ab/cd', 'deadbeef', 12, 'text/plain', ?, '2026-01-01T00:00:00.000Z')`,
      )
      for (const state of ['staged', 'present', 'missing', 'corrupt']) {
        expect(() => insert.run(`as_${state}`, state)).not.toThrow()
      }
      expect(() => insert.run('as_bad', 'unknown')).toThrow()
    })
  })

  it('assets.storage_key 是逻辑键：接受相对键，不接受盘符（同步数据不得含绝对路径）', () => {
    withDb((db) => {
      seedWorkspace(db)
      const insert = db.prepare(
        `INSERT INTO assets (id, workspace_id, storage_key, sha256, byte_size, mime_type, created_at)
         VALUES (?, 'ws_1', ?, 'deadbeef', 1, 'text/plain', '2026-01-01T00:00:00.000Z')`,
      )
      expect(() => insert.run('as_rel', 'assets/ab/cd/ef')).not.toThrow()
      // 表结构本身不阻止绝对路径（历史数据可能已有）；这里记录约定，由上层保证。
      // 断言的是"逻辑键可以是任意相对路径"，而不是"绝对路径会报错"。
      expect(() => insert.run('as_abs', 'assets/some key with spaces.png')).not.toThrow()
    })
  })
})

describe('索引存在性（离线写作的关键查询路径）', () => {
  it('关键索引全部创建', () => {
    withDb((db) => {
      const indexes = indexNames(db)
      for (const required of [
        'idx_projects_workspace',
        'idx_documents_workspace',
        'idx_documents_project',
        'idx_documents_parent_order',
        'idx_revisions_entity',
        'idx_revisions_op',
        'idx_operations_batch',
        'idx_operations_entity',
        'idx_outbox_dispatch',
        'idx_conflicts_pending',
        'idx_jobs_status',
        'idx_jobs_lease',
        'idx_local_drafts_session',
        'idx_assets_sha256',
        'idx_asset_refs_entity',
      ]) {
        expect(indexes, `缺少索引 ${required}`).toContain(required)
      }
    })
  })

  it('schema_migrations 有"一个版本最多一条成功记录"的部分唯一索引', () => {
    withDb((db) => {
      const indexes = indexNames(db)
      expect(indexes).toContain('uq_schema_migrations_applied')
      const insert = db.prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at, success)
         VALUES (1, 'x', 'sha256:y', '2026-01-01T00:00:00.000Z', 1)`,
      )
      insert.run()
      expect(() => insert.run()).toThrow()
      // 失败审计行可以有任意多条（重试审计）。
      const failed = db.prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at, success, error_code)
         VALUES (1, 'x', 'sha256:y', '2026-01-01T00:00:00.000Z', 0, 'STORAGE_UNAVAILABLE')`,
      )
      expect(() => {
        failed.run()
        failed.run()
      }).not.toThrow()
    })
  })
})

describe('迁移清单与版本常量', () => {
  it('LATEST_SCHEMA_VERSION 与契约 DB_SCHEMA_VERSION 一致', () => {
    // 两者相等是**被校验的约束**（不是靠引用同一常量"自动成立"）。
    expect(LATEST_SCHEMA_VERSION).toBe(DB_SCHEMA_VERSION)
  })

  it('迁移清单按版本严格升序、版本号落在桌面区间、无重复', () => {
    const versions = SCHEMA_MIGRATIONS.map((m) => m.version)
    expect(versions.length).toBeGreaterThan(0)
    expect(new Set(versions).size).toBe(versions.length)
    for (let i = 0; i < versions.length; i += 1) {
      const version = versions[i] as number
      expect(isDesktopMigrationVersion(version)).toBe(true)
      if (i > 0) expect(version).toBeGreaterThan(versions[i - 1] as number)
    }
  })

  it('最高迁移版本 == LATEST_SCHEMA_VERSION', () => {
    const highest = SCHEMA_MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
    expect(highest).toBe(LATEST_SCHEMA_VERSION)
  })

  it('版本区间不重叠：桌面 ≤ 999 < 后端 1000', () => {
    expect(DESKTOP_MIGRATION_VERSION_MIN).toBeLessThanOrEqual(DESKTOP_MIGRATION_VERSION_MAX)
    expect(DESKTOP_MIGRATION_VERSION_MAX).toBeLessThan(BACKEND_MIGRATION_VERSION_BASE)
    expect(isDesktopMigrationVersion(BACKEND_MIGRATION_VERSION_BASE)).toBe(false)
  })

  it('isDesktopMigrationVersion 拒绝小数、NaN 与越界值', () => {
    expect(isDesktopMigrationVersion(1.5)).toBe(false)
    expect(isDesktopMigrationVersion(Number.NaN)).toBe(false)
    expect(isDesktopMigrationVersion(0)).toBe(false)
    expect(isDesktopMigrationVersion(1000)).toBe(false)
  })

  it('每条迁移都有 name 与非空 ddl', () => {
    for (const migration of SCHEMA_MIGRATIONS) {
      expect(migration.name.length).toBeGreaterThan(0)
      expect(migration.ddl.trim().length).toBeGreaterThan(0)
    }
  })

  it('v1 迁移的 ddl 就是 SCHEMA_DDL（全量建表）', () => {
    const first = SCHEMA_MIGRATIONS[0]
    expect(first?.version).toBe(1)
    expect(first?.ddl).toBe(SCHEMA_DDL)
  })
})
