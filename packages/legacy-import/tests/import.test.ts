/**
 * 写入新库：dry-run 零写入、幂等重跑、目标库保护、失败整体回滚。
 *
 * 夹具是 `tests/fixtures.ts` 的**自造合成数据**，不是真实用户数据。
 */

import { encodeRevision } from '@yfe/contracts'
import { closeDatabase, openMemoryDatabase } from '@yfe/persistence-sqlite'
import { describe, expect, it } from 'vitest'

import { assertTargetAcceptsImport, writeImportPlan } from '../src/import.js'
import type { PlannedDocument } from '../src/mapping.js'
import { buildImportPlan } from '../src/mapping.js'
import {
  SYNTHETIC_MAIN,
  SYNTHETIC_PROJECT_ID,
  readerWithCorruptChapters,
  syntheticCollection,
  syntheticDeclaration,
} from './fixtures.js'
import { TEST_NOW, countRows, requestId, rowCounts, scan, withDbAsync } from './helpers.js'
import type { LegacyCollection } from '../src/inventory.js'
import { scanLegacySources } from '../src/inventory.js'

const TABLES = [
  'workspaces',
  'projects',
  'documents',
  'settings_entities',
  'relations',
  'revisions',
  'config_values',
  'plugin_data',
] as const

async function corruptCollection(): Promise<LegacyCollection> {
  return scanLegacySources([{ declaration: syntheticDeclaration(), reader: readerWithCorruptChapters() }], requestId(31))
}

describe('dry-run 预演', () => {
  it('🔴 预演一行都不写：行数快照完全不变，且计入 dryRun 而不是 succeeded', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      const before = rowCounts(db, TABLES)
      const result = writeImportPlan(db, plan, { requestId: requestId(41), dryRun: true, now: TEST_NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const after = rowCounts(db, TABLES)

      expect(after).toEqual(before)
      expect(Object.values(before).every((n) => n === 0)).toBe(true)
      expect(result.value.totals.succeeded).toBe(0)
      expect(result.value.totals.inserted).toBe(0)
      expect(result.value.totals.dryRun).toBe(plan.rows.length)
      expect(result.value.totals.skipped).toBe(plan.rows.length)
    })
  })

  it('预演的报告结构与真跑一致（计划数相同）', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      const preview = writeImportPlan(db, plan, { requestId: requestId(42), dryRun: true, now: TEST_NOW })
      const real = writeImportPlan(db, plan, { requestId: requestId(43), now: TEST_NOW })
      expect(preview.ok && real.ok).toBe(true)
      if (!preview.ok || !real.ok) return
      expect(preview.value.totals.planned).toBe(real.value.totals.planned)
      expect(Object.keys(preview.value.counts).sort()).toEqual(Object.keys(real.value.counts).sort())
    })
  })
})

describe('幂等重跑', () => {
  it('🔴 同一夹具导入两次：实体数与 revision 数都不翻倍，第二次全部按「无变化」跳过', async () => {
    const first = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    const second = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    // 两次规划出的行完全一致，这是「同一个旧实体得到同一个新 ID」的直接证据。
    expect(JSON.stringify(second.rows)).toBe(JSON.stringify(first.rows))

    await withDbAsync(async (db) => {
      const run1 = writeImportPlan(db, first, { requestId: requestId(51), now: TEST_NOW })
      expect(run1.ok).toBe(true)
      const afterFirst = rowCounts(db, TABLES)
      expect(afterFirst['projects']).toBe(1)
      expect(afterFirst['documents']).toBeGreaterThan(0)

      const run2 = writeImportPlan(db, second, { requestId: requestId(52), now: TEST_NOW })
      expect(run2.ok).toBe(true)
      if (!run2.ok) return
      const afterSecond = rowCounts(db, TABLES)

      expect(afterSecond).toEqual(afterFirst)
      expect(run2.value.totals.unchanged).toBeGreaterThan(0)
      expect(run2.value.totals.inserted).toBe(0)
      // 重跑不得新增 revision：否则每个历史快照都会被复制一遍。
      expect(afterSecond['revisions']).toBe(afterFirst['revisions'])
    })
  })

  it('内容变化时按幂等「更新」处理，而不是报错也不是再插一份', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      const run1 = writeImportPlan(db, plan, { requestId: requestId(53), now: TEST_NOW })
      expect(run1.ok).toBe(true)
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('被改过的名字', SYNTHETIC_PROJECT_ID)

      const run2 = writeImportPlan(db, plan, { requestId: requestId(54), now: TEST_NOW })
      expect(run2.ok).toBe(true)
      if (!run2.ok) return
      expect(run2.value.totals.updated).toBeGreaterThan(0)
      expect(countRows(db, 'projects')).toBe(1)
      const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(SYNTHETIC_PROJECT_ID) as { name?: string }
      expect(row.name).toBe('合成作品甲')
    })
  })
})

describe('目标库保护', () => {
  it.each([true, false])('合库时同 ID 的项目归属冲突被拒绝且所有原行保持不变（dryRun=%s）', async (dryRun) => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    const workspace = plan.rows.find((row) => row.table === 'workspace')
    const project = plan.rows.find((row) => row.table === 'project')
    if (workspace?.table !== 'workspace' || project?.table !== 'project') throw new Error('missing fixture')
    const incoming = {
      ...plan,
      workspaceId: 'ws_other_import',
      rows: [
        { ...workspace, id: 'ws_other_import' },
        { ...project, workspaceId: 'ws_other_import', name: '不得覆盖的名字' },
      ],
    }
    await withDbAsync(async (db) => {
      expect(writeImportPlan(db, plan, { requestId: requestId(60), now: TEST_NOW }).ok).toBe(true)
      const before = TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())
      const result = writeImportPlan(db, incoming, {
        requestId: requestId(61), now: TEST_NOW, allowNonEmptyTarget: true, dryRun,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('ALREADY_EXISTS')
      expect(result.error.detail?.['reason']).toBe('import-owner-conflict')
      expect(TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
    })
  })

  it('库结构版本过新 → 拒绝导入并给出契约错误码 STORAGE_SCHEMA_TOO_NEW', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms, success) VALUES (?, ?, ?, ?, 0, 1)',
      ).run(999, 'future-schema', 'x', TEST_NOW)
      const result = writeImportPlan(db, plan, { requestId: requestId(61), now: TEST_NOW })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('STORAGE_SCHEMA_TOO_NEW')
      expect(countRows(db, 'documents')).toBe(0)
    })
  })

  it('库未初始化（没有 schema_migrations）→ STORAGE_MIGRATION_FAILED，不静默当空库写', () => {
    const db = openMemoryDatabase()
    try {
      const guard = assertTargetAcceptsImport(db, { requestId: requestId(62), workspaceId: 'ws_legacy' })
      expect(guard.ok).toBe(false)
      if (guard.ok) return
      expect(guard.error.code).toBe('STORAGE_MIGRATION_FAILED')
    } finally {
      closeDatabase(db)
    }
  })

  it('目标库里已有别的工作区的数据 → ALREADY_EXISTS（本包不接管非空库）', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      db.prepare(
        'INSERT INTO workspaces (id, name, revision, revision_seq, deleted, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)',
      ).run('ws_someone_else', '别人的工作区', encodeRevision(1), TEST_NOW, TEST_NOW)
      const result = writeImportPlan(db, plan, { requestId: requestId(63), now: TEST_NOW })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('ALREADY_EXISTS')
      expect(countRows(db, 'projects')).toBe(0)
    })
  })

  it('幂等重跑不会被「非空库保护」误伤：自己的工作区不算「别人」', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      expect(writeImportPlan(db, plan, { requestId: requestId(64), now: TEST_NOW }).ok).toBe(true)
      expect(writeImportPlan(db, plan, { requestId: requestId(65), now: TEST_NOW }).ok).toBe(true)
    })
  })
})

describe('失败整体回滚', () => {
  it('🔴 中途写入失败 → 整个事务回滚，一行半截数据都不留', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    const broken: PlannedDocument = {
      table: 'document',
      id: 'vol_broken_fk',
      workspaceId: plan.workspaceId,
      projectId: 'prj_does_not_exist',
      kind: 'volume',
      parentId: null,
      orderKey: 'Z',
      title: '外键故意指向不存在的作品',
      body: '',
      deleted: 0,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      charCount: 0,
      origin: { sourceId: 'legacy-main', database: 'main', store: 'volumes', legacyId: 'broken', qualifier: null },
    }
    const sabotaged = { ...plan, rows: [...plan.rows, broken] }

    await withDbAsync(async (db) => {
      const result = writeImportPlan(db, sabotaged, { requestId: requestId(71), now: TEST_NOW })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.detail?.['rolledBack']).toBe(true)
      // 🔴 关键：不只是一行没写，而是**整个事务**都没留下痕迹。
      expect(rowCounts(db, TABLES)).toEqual(
        Object.fromEntries(TABLES.map((table) => [table, 0])),
      )
    })
  })

  it('回滚后目标库仍是可用的空库，能接着导入一份干净的计划', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    const broken = {
      ...plan,
      rows: [
        ...plan.rows,
        {
          table: 'document' as const,
          id: 'chp_broken_fk_2',
          workspaceId: plan.workspaceId,
          projectId: 'prj_does_not_exist',
          kind: 'chapter' as const,
          parentId: null,
          orderKey: 'Z',
          title: '外键故意指向不存在的作品',
          body: '',
          deleted: 0 as const,
          createdAt: TEST_NOW,
          updatedAt: TEST_NOW,
          charCount: 0,
          origin: { sourceId: 'legacy-main', database: 'main', store: 'chapters', legacyId: 'broken2', qualifier: null },
        },
      ],
    }
    await withDbAsync(async (db) => {
      const failed = writeImportPlan(db, broken, { requestId: requestId(72), now: TEST_NOW })
      expect(failed.ok).toBe(false)
      expect(countRows(db, 'projects')).toBe(0)

      const retry = writeImportPlan(db, plan, { requestId: requestId(73), now: TEST_NOW })
      expect(retry.ok).toBe(true)
      if (!retry.ok) return
      expect(retry.value.totals.inserted).toBeGreaterThan(0)
      expect(countRows(db, 'projects')).toBe(1)
    })
  })
})

describe('可读性单独隔离', () => {
  it('🔴 一个 store 读不出来：它记成 refused（不是 0），其余可读的部分照常导入', async () => {
    const plan = buildImportPlan(await corruptCollection(), { now: TEST_NOW })
    expect(plan.refusals.map((refusal) => refusal.location)).toEqual(['legacy-main/main/chapters'])

    await withDbAsync(async (db) => {
      const result = writeImportPlan(db, plan, { requestId: requestId(81), now: TEST_NOW })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      // chapters 那一条拒绝落在 document 桶里，且**占一条计划数**。
      const documentCounts = result.value.counts['document']
      expect(documentCounts?.refused).toBe(1)
      expect(documentCounts?.planned).toBe((documentCounts?.succeeded ?? 0) + (documentCounts?.skipped ?? 0) + 1)
      expect(result.value.totals.refused).toBe(1)

      // 其余部分确实进去了：作品与卷没被这一条失败连坐。
      expect(countRows(db, 'projects')).toBeGreaterThan(0)
      expect(countRows(db, 'documents')).toBeGreaterThan(0)
      // 章节正文一行都没写进去——但我们知道的是「没读到」，报告里说清楚了。
      const chapters = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind = 'chapter'").get() as { n: number }
      expect(chapters.n).toBe(0)
    })
  })

  it('读不出来的来源在报告素材里带着原因与位置，可被排期处理', async () => {
    const collection = await corruptCollection()
    const refusal = collection.refusals[0]
    expect(refusal?.kind).toBe('decode-failed')
    expect(refusal?.code).toBe('STORAGE_CORRUPT')
    expect(refusal?.message).toContain('JSON 解析失败')
    expect(refusal?.location).toBe('legacy-main/main/chapters')
  })
})

describe('写入的行内容与旧数据一致', () => {
  it('作品、卷、章、设定、快照都真的落库，且层级正确', async () => {
    const plan = buildImportPlan(await syntheticCollection(), { now: TEST_NOW })
    await withDbAsync(async (db) => {
      const result = writeImportPlan(db, plan, { requestId: requestId(91), now: TEST_NOW })
      expect(result.ok).toBe(true)

      const project = db.prepare('SELECT name, summary FROM projects WHERE id = ?').get(SYNTHETIC_PROJECT_ID) as
        | { name?: string; summary?: string }
        | undefined
      expect(project?.name).toBe('合成作品甲')
      expect(project?.summary).toBe('合成简介')

      const volume = db.prepare("SELECT id FROM documents WHERE kind = 'volume' AND title = ?").get('合成第一卷') as
        | { id?: string }
        | undefined
      expect(volume?.id).toBeDefined()

      const chapter = db.prepare("SELECT parent_id, body FROM documents WHERE title = ?").get('合成第 1 章') as
        | { parent_id?: string; body?: string }
        | undefined
      expect(chapter?.parent_id).toBe(volume?.id)
      expect(chapter?.body).toBe('第一行\n第二行\n')

      // 快照 → revisions，且首版是 seq=1。
      const seqs = db
        .prepare("SELECT seq FROM revisions WHERE entity_type = 'document' ORDER BY seq")
        .all() as readonly { seq: number }[]
      expect(seqs.map((row) => row.seq)).toContain(1)
      expect(seqs.map((row) => row.seq)).toContain(2)

      // 未知字段旁存确实落库了（不是只写在报告里）。
      const carried = db
        .prepare("SELECT value_json FROM config_values WHERE scope = 'project' AND owner_id = ? AND key = 'legacy.project'")
        .get(SYNTHETIC_PROJECT_ID) as { value_json?: string } | undefined
      expect(carried?.value_json).toContain('奇幻')
    })
  })

  it('source 目录只被读取：扫描期间没有任何写入痕迹', async () => {
    let reads = 0
    const collection = await scan(syntheticDeclaration(), {
      listStores: () => Object.keys(SYNTHETIC_MAIN),
      readRecords: (store) => {
        reads += 1
        return SYNTHETIC_MAIN[store] ?? []
      },
    })
    expect(reads).toBeGreaterThan(0)
    expect(collection.sources[0]?.status).toBe('readable')
    // 读取器接口只有 listStores / readRecords——没有写方法可供调用，
    // 所以「只读源」是类型层面就成立的，而不是靠约定。
  })
})
