/**
 * 第三步的报告面：把「清单扫描 + 映射计划 + 写入结果」合成一份**可排期、可序列化**的
 * `ImportReport`（任务语义 7、`docs/旧功能迁移矩阵.md` §2.4 第 ③ 步）。
 *
 * 三条硬约束：
 *
 * 1. **无循环引用**。报告全部是普通对象/数组/字符串/数字/布尔/null，没有函数、Date、
 *    Map、Set、类实例。{@link serializeImportReport} 因此可以无条件 `JSON.stringify`，
 *    并且自带一次往返校验（`serializeImportReport(report, { verify: true })`）。
 * 2. **待办可排**。拒绝明细带 `location`（`<来源>/<库>/<store>`）+ 原因 + 契约错误码，
 *    未映射字段带 `location` + 实体 + 字段名 + 去向，所以每一条都能被派成一张工单，
 *    而不是一句「有些东西没导进来」。
 * 3. **统计自洽**。`countsConsistencyErrors` 的恒等式既在总数上校验，也在每个实体类型上
 *    校验；不成立时报告 `consistency.ok === false` 并列出**每一条**不成立的等式——
 *    报告不会用一句「可能不准」掩盖算错。
 */

import type { ErrorCode } from '@yfe/contracts'

import type { LegacyReadFailureKind, LegacyReadOrigin } from './errors.js'
import { LEGACY_ID_ALGORITHM, LEGACY_ID_DIGEST_LENGTH } from './ids.js'
import type { LegacySourceScan } from './inventory.js'
import type { ImportCounts, ImportCounterKey, WriteOutcome } from './import.js'
import { addCounts, countsConsistencyErrors, emptyCounts } from './import.js'
import type {
  DeferredEntry,
  IdCollisionEntry,
  IdMappingEntry,
  IdMappingStats,
  ImportPlan,
  ImportWarning,
  LegacyEntityKind,
  UnmappedFieldEntry,
} from './mapping.js'

/** 报告结构版本。结构变了就加一，让下游能拒绝解析不认识的报告。 */
export const IMPORT_REPORT_VERSION = 1 as const

/** 实体类型的展示顺序：父在前，和写入顺序一致，便于人工对照。 */
const ENTITY_ORDER: readonly LegacyEntityKind[] = [
  'workspace',
  'project',
  'document',
  'settings_entity',
  'revision',
  'relation',
  'config_value',
  'plugin_data',
]

export interface ImportReportTableCounts {
  readonly table: ImportCounterKey
  readonly counts: ImportCounts
}

export interface ImportReportRefusal {
  readonly location: string
  /** 读取失败的**种类**。`not-found` 与 `decode-failed` 是两回事，报告必须分得开。 */
  readonly kind: LegacyReadFailureKind
  readonly code: ErrorCode
  readonly message: string
  readonly origin: LegacyReadOrigin
  /**
   * 这条拒绝在计数上占的位置。读取失败**不折算成 0 条**，它占的是一条「未知」，
   * 所以每个被拒绝的 store 在计划数/拒绝数里各占 1。
   */
  readonly counterTable: ImportCounterKey
}

export interface ImportReportStore {
  readonly name: string
  readonly status: string
  /** `refused` 时是 `null`——这正是「读不出来」与「0 条」的区别。 */
  readonly rows: number | null
  readonly reason: string | null
}

export interface ImportReportSource {
  readonly sourceId: string
  readonly kind: string
  readonly label: string
  readonly origin: LegacyReadOrigin
  readonly status: string
  readonly version: number | null
  readonly bytes: number | null
  readonly modifiedAt: string | null
  readonly stores: readonly ImportReportStore[]
  readonly notes: readonly string[]
}

export interface ImportReportIdMapping {
  /** 派生算法标识，便于报告过期时说明「ID 是按哪套规则算的」。 */
  readonly algorithm: string
  readonly digestLength: number
  readonly stats: IdMappingStats
  readonly entries: readonly IdMappingEntry[]
  /** 旧 ID 已是合法新 ID、却已被本表另一条记录占用时的事件（不会被静默吞掉）。 */
  readonly collisions: readonly IdCollisionEntry[]
}

export interface ImportReportConsistency {
  readonly ok: boolean
  readonly errors: readonly string[]
}

export interface ImportReport {
  readonly reportVersion: typeof IMPORT_REPORT_VERSION
  readonly generatedAt: string
  readonly durationMs: number
  /** `true` = 预演：报告结构与真跑一致，但库里一行都没写。 */
  readonly dryRun: boolean
  readonly idAlgorithm: string
  readonly workspaceId: string
  readonly totals: ImportCounts
  readonly byTable: readonly ImportReportTableCounts[]
  readonly refusals: readonly ImportReportRefusal[]
  readonly unmappedFields: readonly UnmappedFieldEntry[]
  readonly warnings: readonly ImportWarning[]
  readonly deferred: readonly DeferredEntry[]
  readonly idMapping: ImportReportIdMapping
  readonly sources: readonly ImportReportSource[]
  readonly notes: readonly string[]
  readonly consistency: ImportReportConsistency
}

export interface BuildImportReportInput {
  readonly plan: ImportPlan
  /** 写入结果。预演时用 {@link emptyOutcome} 或直接传 `writeImportPlan(..., {dryRun:true})` 的结果。 */
  readonly outcome: WriteOutcome
  readonly generatedAt: string
  readonly durationMs: number
  readonly dryRun: boolean
  /**
   * 清单扫描的来源明细。缺省时报告仍然自洽（只是没有来源级信息），
   * 但正式导入必须传：报告要能回答「我到底读了哪些文件、哪个 store 读不出来」。
   */
  readonly sources?: readonly LegacySourceScan[]
}

export function buildImportReport(input: BuildImportReportInput): ImportReport {
  const { plan, outcome } = input

  const byTable = orderedTableCounts(outcome.counts)
  const refusals: ImportReportRefusal[] = plan.refusals.map((refusal) => ({
    location: refusal.location,
    kind: refusal.kind,
    code: refusal.code,
    message: refusal.message,
    origin: refusal.origin,
    counterTable: counterKeyOfLocation(refusal.location),
  }))
  const sources: ImportReportSource[] = (input.sources ?? []).map(condenseSource)

  const errors = [...countsConsistencyErrors(outcome.totals)]
  for (const entry of byTable) {
    for (const error of countsConsistencyErrors(entry.counts)) {
      errors.push(`[${entry.table}] ${error}`)
    }
  }
  // 拒绝条目必须在报告明细里数得出来，否则「拒绝数」就成了一个孤立的数字。
  const refusedInCounts = outcome.totals.refused
  if (refusedInCounts !== refusals.length) {
    errors.push(`totals.refused=${refusedInCounts} ≠ refusals 明细条数=${refusals.length}`)
  }

  return {
    reportVersion: IMPORT_REPORT_VERSION,
    generatedAt: input.generatedAt,
    durationMs: input.durationMs,
    dryRun: input.dryRun,
    idAlgorithm: `${LEGACY_ID_ALGORITHM} (sha256/${LEGACY_ID_DIGEST_LENGTH}hex)`,
    workspaceId: plan.workspaceId,
    totals: outcome.totals,
    byTable,
    refusals,
    unmappedFields: plan.unmappedFields,
    warnings: plan.warnings,
    deferred: plan.deferred,
    idMapping: {
      algorithm: LEGACY_ID_ALGORITHM,
      digestLength: LEGACY_ID_DIGEST_LENGTH,
      stats: plan.idStats,
      entries: plan.idMapping,
      collisions: plan.collisions,
    },
    sources,
    notes: plan.notes,
    consistency: { ok: errors.length === 0, errors },
  }
}

/** 空写入结果。预演报告、或「只在清单阶段失败」的早退都用它，保证报告结构不缺字段。 */
export function emptyOutcome(): WriteOutcome {
  return { counts: {}, totals: emptyCounts(), updatedKeys: [] }
}

/**
 * 「只出计划、没有目标库」的结果。
 *
 * 与 {@link emptyOutcome} 的区别是它**如实反映计划**：每个计划行记
 * `planned +1 / skipped +1 / notImported +1`（没有目标库可比，所以既没成功也没「无变化」），
 * 每条拒绝记 `planned +1 / refused +1`。这样
 * `planned === succeeded + skipped + refused` 仍然成立，
 * 报告不会因为「还没有库」就变成一堆 0 —— 一堆 0 正是「把读不出来当空」的翻版。
 */
export function planOnlyOutcome(plan: ImportPlan): WriteOutcome {
  const counts: Record<ImportCounterKey, ImportCounts> = {}
  const bump = (key: ImportCounterKey, mutate: (draft: ImportCounts) => ImportCounts) => {
    counts[key] = mutate(counts[key] ?? emptyCounts())
  }
  for (const row of plan.rows) {
    bump(row.table, (draft) => ({
      ...draft,
      planned: draft.planned + 1,
      skipped: draft.skipped + 1,
      notImported: draft.notImported + 1,
    }))
  }
  for (const refusal of plan.refusals) {
    const key = counterKeyOfLocation(refusal.location)
    bump(key, (draft) => ({ ...draft, planned: draft.planned + 1, refused: draft.refused + 1 }))
  }
  let totals = emptyCounts()
  for (const value of Object.values(counts)) totals = addCounts(totals, value)
  return { counts, totals, updatedKeys: [] }
}

/** 把写入结果与另一份合并（例如「清单阶段一份 + 写入阶段一份」）。 */
export function mergeOutcome(a: WriteOutcome, b: WriteOutcome): WriteOutcome {
  const counts: Record<ImportCounterKey, ImportCounts> = {}
  for (const key of new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])) {
    counts[key] = addCounts(a.counts[key] ?? emptyCounts(), b.counts[key] ?? emptyCounts())
  }
  return {
    counts,
    totals: addCounts(a.totals, b.totals),
    updatedKeys: [...a.updatedKeys, ...b.updatedKeys],
  }
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

export interface SerializeImportReportOptions {
  readonly space?: number
  /** 往返校验：解析回来后键集合一致才返回，否则抛错。默认 `true`。 */
  readonly verify?: boolean
}

/**
 * 报告 → JSON 文本。
 *
 * 🔴 默认做一次 `JSON.parse` 往返校验：报告带循环引用时会在这里**当场失败**，
 *    而不是等到排期系统里发现「报告打不开」。同时校验顶层键集合，
 *    防止将来有人塞进一个会被 `JSON.stringify` 静默丢掉的 `undefined` 字段。
 */
export function serializeImportReport(report: ImportReport, options: SerializeImportReportOptions = {}): string {
  const text = JSON.stringify(report, null, options.space ?? 2)
  if (options.verify !== false) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const expected = Object.keys(report).sort()
    const actual = Object.keys(parsed).sort()
    if (expected.join('\u0000') !== actual.join('\u0000')) {
      throw new Error(`报告序列化后键集合发生变化：期望 [${expected.join(', ')}]，实得 [${actual.join(', ')}]`)
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// 人工视图
// ---------------------------------------------------------------------------

/**
 * 一段给人看的摘要。**不替代报告**——排期与差异比较必须读结构化字段，
 * 这段文本只是让人一眼看出「能不能切换」。
 */
export function formatImportReport(report: ImportReport): string {
  const lines: string[] = []
  lines.push(`旧数据导入${report.dryRun ? '预演' : ''}报告（${report.generatedAt}，耗时 ${report.durationMs}ms）`)
  lines.push(
    `合计：计划 ${report.totals.planned}（成功 ${report.totals.succeeded} / 跳过 ${report.totals.skipped} / 拒绝 ${report.totals.refused}）`,
  )
  for (const entry of report.byTable) {
    const c = entry.counts
    lines.push(`  - ${entry.table}: 计划 ${c.planned} 成功 ${c.succeeded} 跳过 ${c.skipped} 拒绝 ${c.refused}`)
  }
  if (report.refusals.length > 0) {
    lines.push(`读取失败 ${report.refusals.length} 处（拒绝折算为 0 条）：`)
    for (const refusal of report.refusals) {
      lines.push(`  ! [${refusal.kind}] ${refusal.location}: ${refusal.message}`)
    }
  }
  if (report.unmappedFields.length > 0) {
    lines.push(`未映射字段 ${report.unmappedFields.length} 条（已旁存，未丢弃）：`)
    for (const field of report.unmappedFields.slice(0, 20)) {
      lines.push(`  ? ${field.location}#${field.field} → ${field.disposition}`)
    }
    if (report.unmappedFields.length > 20) lines.push(`  … 其余 ${report.unmappedFields.length - 20} 条见报告 JSON`)
  }
  lines.push(
    `ID 映射：共 ${report.idMapping.stats.total}（逐字保留 ${report.idMapping.stats.verbatim} / 派生 ${report.idMapping.stats.derived} / 冲突降级 ${report.idMapping.stats.collisions}）`,
  )
  if (report.deferred.length > 0) {
    lines.push(`本包不接管 ${report.deferred.length} 项（已登记，未静默丢弃）：`)
    for (const entry of report.deferred) lines.push(`  - ${entry.location}: ${entry.reason}`)
  }
  lines.push(`自洽校验：${report.consistency.ok ? '通过' : `不通过（${report.consistency.errors.join('；')}）`}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function orderedTableCounts(counts: Readonly<Record<ImportCounterKey, ImportCounts>>): readonly ImportReportTableCounts[] {
  const known = ENTITY_ORDER.filter((table) => counts[table] !== undefined)
  const extras = Object.keys(counts)
    .filter((table) => !(ENTITY_ORDER as readonly string[]).includes(table))
    .sort()
  return [...known, ...extras].map((table) => ({ table, counts: counts[table] ?? emptyCounts() }))
}

function condenseSource(source: LegacySourceScan): ImportReportSource {
  return {
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label,
    origin: source.origin,
    status: source.status,
    version: source.version,
    bytes: source.bytes,
    modifiedAt: source.modifiedAt,
    stores: source.stores.map((store) => ({
      name: store.name,
      status: store.status,
      rows: store.rows,
      reason: store.reason,
    })),
    notes: source.notes,
  }
}

/**
 * 读取失败位置 → 计数桶。与 `import.ts` 的同一规则。
 *
 * ⚠️ 这里有**两处**实现（`import.ts` 用它记账、`report.ts` 用它标注明细），
 * 故意重复而不是互相 import：报告必须能在不加载写入模块的情况下生成。
 * 测试 `report.test.ts` 会断言两者对所有 store 名给出相同结果。
 */
export function counterKeyOfLocation(location: string): ImportCounterKey {
  const parts = location.split('/')
  const store = parts.length >= 3 ? (parts[2] ?? '') : (parts[parts.length - 1] ?? '')
  switch (store) {
    case 'projects':
      return 'project'
    case 'volumes':
    case 'chapters':
    case 'docs':
    case 'bodies':
    case 'trash':
      return 'document'
    case 'formData':
    case 'tableRows':
    case 'cardRecords':
      return 'settings_entity'
    case 'snapshots':
      return 'revision'
    case 'settingsKV':
    case 'meta':
    case 'localStorage':
      return 'config_value'
    case 'worlds':
    case 'tavernReports':
    case 'dailyStats':
      return 'plugin_data'
    default:
      return 'unreadable_unknown'
  }
}
