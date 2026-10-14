/**
 * 报告：自洽、可序列化、拒绝明细可数、未映射字段与 ID 映射统计齐全。
 *
 * 夹具是 `tests/fixtures.ts` 的**自造合成数据**，不是真实用户数据。
 */

import { describe, expect, it } from 'vitest'

import { countRows, requestId, rowCounts, withDbAsync } from './helpers.js'
import { buildImportReport, counterKeyOfLocation, formatImportReport, serializeImportReport } from '../src/report.js'
import { counterKeyForRefusal, writeImportPlan } from '../src/import.js'
import { buildImportPlan } from '../src/mapping.js'
import { previewLegacyImport, reportToJson, runLegacyImport } from '../src/pipeline.js'
import { MAIN_STORES } from './helpers.js'
import { readerWithCorruptChapters, syntheticCollection, syntheticDeclaration, syntheticReader } from './fixtures.js'

const TABLES = ['workspaces', 'projects', 'documents', 'settings_entities', 'relations', 'revisions', 'config_values', 'plugin_data'] as const

async function readModel() {
  const collection = await syntheticCollection()
  const plan = buildImportPlan(collection, { now: '2026-02-01T00:00:00.000Z' })
  return { collection, plan }
}

describe('报告自洽', () => {
  it('🔴 totals 与每个 byTable 都满足 计划数 = 成功 + 跳过 + 拒绝', async () => {
    await withDbAsync(async (db) => {
      const { plan } = await readModel()
      const outcome = writeImportPlan(db, plan, { requestId: requestId(101), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 12,
        dryRun: false,
      })

      expect(report.consistency.errors).toEqual([])
      expect(report.consistency.ok).toBe(true)
      expect(report.totals.planned).toBe(report.totals.succeeded + report.totals.skipped + report.totals.refused)
      for (const entry of report.byTable) {
        expect(entry.counts.planned, entry.table).toBe(
          entry.counts.succeeded + entry.counts.skipped + entry.counts.refused,
        )
      }
      expect(report.totals.planned).toBeGreaterThan(0)
    })
  })

  it('报告必须含：每类型计数、拒绝明细、未映射字段、ID 映射统计、耗时、报告版本', async () => {
    await withDbAsync(async (db) => {
      const { plan } = await readModel()
      const outcome = writeImportPlan(db, plan, { requestId: requestId(102), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 34,
        dryRun: false,
        sources: (await syntheticCollection()).sources,
      })

      expect(report.reportVersion).toBe(1)
      expect(report.durationMs).toBe(34)
      expect(report.byTable.length).toBeGreaterThan(0)
      expect(report.unmappedFields.length).toBeGreaterThan(0)
      expect(report.idMapping.stats.total).toBeGreaterThan(0)
      expect(report.idMapping.algorithm).toBe('legacy-id-sha256-v1')
      expect(report.idMapping.digestLength).toBe(40)
      expect(report.sources.length).toBeGreaterThan(0)
      expect(report.workspaceId.length).toBeGreaterThan(0)
    })
  })
})

describe('可序列化', () => {
  it('JSON.stringify 无循环引用，且往返后顶层键集合不变', async () => {
    await withDbAsync(async (db) => {
      const { plan } = await readModel()
      const outcome = writeImportPlan(db, plan, { requestId: requestId(103), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 5,
        dryRun: false,
      })

      const text = serializeImportReport(report)
      const parsed = JSON.parse(text) as Record<string, unknown>
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(report).sort())
      expect(text).toContain('"reportVersion"')
      expect(text.length).toBeGreaterThan(100)
    })
  })

  it('人工摘要包含可直接判读的关键数字', async () => {
    await withDbAsync(async (db) => {
      const { plan } = await readModel()
      const outcome = writeImportPlan(db, plan, { requestId: requestId(104), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 8,
        dryRun: false,
      })
      const text = formatImportReport(report)
      expect(text).toContain('旧数据导入报告')
      expect(text).toContain('合计：计划')
      expect(text).toContain('未映射字段')
    })
  })
})

describe('拒绝明细', () => {
  it('🔴 读不出来的 store 出现在 refusals 明细里，且 totals.refused 能在明细里数出来', async () => {
    const collection = await syntheticCollection()
    const plan = buildImportPlan(collection, { now: '2026-02-01T00:00:00.000Z' })

    // 造一份「chapters 读不出来」的计划：直接用带损坏的夹具重新规划。
    const { scanLegacySources } = await import('../src/inventory.js')
    const corrupt = await scanLegacySources(
      [{ declaration: syntheticDeclaration(), reader: readerWithCorruptChapters() }],
      requestId(105),
    )
    const corruptPlan = buildImportPlan(corrupt, { now: '2026-02-01T00:00:00.000Z' })

    await withDbAsync(async (db) => {
      const outcome = writeImportPlan(db, corruptPlan, { requestId: requestId(106), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan: corruptPlan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 3,
        dryRun: false,
      })

      expect(report.refusals.length).toBe(1)
      expect(report.refusals.length).toBe(report.totals.refused)
      expect(report.consistency.ok).toBe(true)
      const detail = report.refusals[0]
      expect(detail?.location).toBe('legacy-main/main/chapters')
      expect(detail?.kind).toBe('decode-failed')
      expect(detail?.message.length).toBeGreaterThan(0)
      expect(detail?.counterTable).toBe('document')

      // 对照：健全的夹具没有拒绝，refused 是 0 而不是「没读到的也算 0」。
      expect(plan.refusals).toEqual([])
    })
  })

  it('报告里能区分「明确不存在」（listed-only/absent）与「读不出来」（refused）', async () => {
    const { scanLegacySources } = await import('../src/inventory.js')
    const { mainDeclaration, makeReader, records, ABSENT } = await import('./helpers.js')
    const { SYNTHETIC_MAIN, syncFileDeclaration } = await import('./fixtures.js')
    const collection = await scanLegacySources(
      [
        {
          declaration: mainDeclaration({
            stores: [
              { name: 'projects', keyField: 'id' },
              { name: 'worlds', keyField: 'id', created: false },
            ],
          }),
          reader: makeReader({ projects: records(SYNTHETIC_MAIN['projects'] ?? []), worlds: ABSENT }),
        },
        { declaration: syncFileDeclaration() },
      ],
      requestId(107),
    )
    const plan = buildImportPlan(collection, { now: '2026-02-01T00:00:00.000Z' })
    await withDbAsync(async (db) => {
      const outcome = writeImportPlan(db, plan, { requestId: requestId(108), now: '2026-02-01T00:00:00.000Z' })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const report = buildImportReport({
        plan,
        outcome: outcome.value,
        generatedAt: '2026-02-01T00:00:00.000Z',
        durationMs: 2,
        dryRun: false,
        sources: collection.sources,
      })

      expect(report.refusals).toEqual([])
      const main = report.sources.find((source) => source.sourceId === 'legacy-main')
      expect(main?.stores.find((store) => store.name === 'worlds')?.status).toBe('absent')
      expect(main?.stores.find((store) => store.name === 'worlds')?.rows).toBe(0)
      const sync = report.sources.find((source) => source.sourceId === 'legacy-sync-file')
      expect(sync?.status).toBe('listed-only')
    })
  })
})

describe('计数桶规则一致性', () => {
  it('report.counterKeyOfLocation 与 import.counterKeyForRefusal 对所有 store 名给出同一答案', () => {
    for (const store of MAIN_STORES) {
      const location = `legacy-main/main/${store.name}`
      expect(counterKeyOfLocation(location), store.name).toBe(counterKeyForRefusal(location))
    }
    // 另一些真实存在的位置（kb / vec / localStorage / 未知名）。
    for (const location of [
      'legacy-kb/kb/docs',
      'legacy-kb/kb/bodies',
      'legacy-vec/indexeddb/embeddings',
      'legacy-local-storage/localstorage/localStorage',
      'legacy-main/main/未听说过的store',
    ]) {
      expect(counterKeyOfLocation(location)).toBe(counterKeyForRefusal(location))
    }
    // 推不出类型的落进 unreadable_unknown，而不是某个看起来像 0 条的桶。
    expect(counterKeyForRefusal('legacy-main/main/未听说过的store')).toBe('unreadable_unknown')
  })
})

describe('pipeline', () => {
  it('runLegacyImport 真跑写入并按报告计数；预演模式一行不写', async () => {
    const collection = await syntheticCollection()
    const real = await withDbAsync(async (db) => {
      const run = await runLegacyImport(db, {
        sources: [{ declaration: syntheticDeclaration(), reader: undefined }],
        requestId: requestId(111),
        now: '2026-02-01T00:00:00.000Z',
      })
      return run
    })
    // 上面故意没给 reader：读取器缺失 ⇒ 来源级拒绝，而不是空库。
    expect(real.ok).toBe(true)
    if (!real.ok) return
    expect(real.value.report.refusals.length).toBeGreaterThan(0)
    expect(real.value.report.consistency.ok).toBe(true)

    expect(collection.sources[0]?.status).toBe('readable')

    const preview = await withDbAsync(async (db) => {
      const before = rowCounts(db, TABLES)
      const run = await runLegacyImport(db, {
        sources: [{ declaration: syntheticDeclaration(), reader: undefined }],
        requestId: requestId(112),
        dryRun: true,
        now: '2026-02-01T00:00:00.000Z',
      })
      return { run, before, after: rowCounts(db, TABLES) }
    })
    expect(preview.run.ok).toBe(true)
    if (!preview.run.ok) return
    expect(preview.run.value.report.dryRun).toBe(true)
    expect(preview.after).toEqual(preview.before)
    expect(Object.values(preview.before).every((n) => n === 0)).toBe(true)
  })

  it('previewLegacyImport 完全不碰数据库（不给 db 也能出报告）', async () => {
    const result = await previewLegacyImport({
      sources: [{ declaration: syntheticDeclaration(), reader: undefined }],
      requestId: requestId(113),
      now: '2026-02-01T00:00:00.000Z',
    })
    // 返回值是裸对象而非 Result：扫描阶段**从不抛错**，读不出来一律变成 refused 记录。
    expect(result.report.dryRun).toBe(true)
    // 🔴 没有目标库时报告也要自洽：计划行记 notImported，拒绝行记 refused，
    //    而不是像空的写入结果那样一片 0（一片 0 就是「把读不出来当空」的翻版）。
    expect(result.report.consistency.ok).toBe(true)
    expect(result.report.consistency.errors).toEqual([])
    expect(result.report.totals.succeeded).toBe(0)
    expect(result.report.totals.planned).toBe(
      result.report.totals.succeeded + result.report.totals.skipped + result.report.totals.refused,
    )
    expect(serializeImportReport(result.report).length).toBeGreaterThan(10)
    expect(reportToJson(result)).toContain('reportVersion')
  })

  it('真跑一次后，报告的行数与库里实际行数一致', async () => {
    await withDbAsync(async (db) => {
      const run = await runLegacyImport(db, {
        sources: [{ declaration: syntheticDeclaration(), reader: syntheticReader() }],
        requestId: requestId(114),
        now: '2026-02-01T00:00:00.000Z',
      })
      expect(run.ok).toBe(true)
      if (!run.ok) return
      const inserted = run.value.report.totals.inserted
      const realRows =
        countRows(db, 'projects') + countRows(db, 'documents') + countRows(db, 'settings_entities') + countRows(db, 'revisions')
      expect(realRows).toBeGreaterThan(0)
      // 报告里的 inserted 覆盖全部目标表，因此不会少于这几张表之和。
      expect(inserted).toBeGreaterThanOrEqual(realRows)
      expect(run.value.report.refusals).toEqual([])
    })
  })
})
