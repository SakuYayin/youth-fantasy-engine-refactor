/**
 * 端到端编排：清单（①）→ 只读解析 + 映射（②）→ 导入 + 校验报告（③）。
 *
 * 这是给上层（桌面主进程 / CLI）用的一个入口；三步各自也都能单独调用，
 * 因为「只想先看看有什么」和「真的要导」是两种不同的用户意图。
 *
 * 🔴 **只读源**在这里是结构事实：本函数只调用调用方注入的 `LegacySourceReader`
 *    来读旧数据，自己不开任何文件、不 import `node:fs`。想证明它没写源目录，
 *    只需要看它的依赖里没有写文件的能力。
 */

import type { RequestId, Result } from '@yfe/contracts'
import type { SqliteDatabase } from '@yfe/persistence-sqlite'

import type { LegacyCollection, LegacySourceDeclaration, LegacySourceReader } from './inventory.js'
import { scanLegacySources } from './inventory.js'
import type { BuildPlanOptions, ImportPlan } from './mapping.js'
import { buildImportPlan } from './mapping.js'
import type { WriteOutcome } from './import.js'
import { writeImportPlan } from './import.js'
import type { ImportReport } from './report.js'
import { buildImportReport, planOnlyOutcome, serializeImportReport } from './report.js'

export interface LegacyImportSourceInput {
  readonly declaration: LegacySourceDeclaration
  /** 只读读取器。缺省表示「这个来源只有声明」——那它会被记为拒绝，而不是空库。 */
  readonly reader?: LegacySourceReader
}

export interface RunLegacyImportInput {
  readonly sources: readonly LegacyImportSourceInput[]
  readonly requestId: RequestId
  readonly dryRun?: boolean
  readonly allowNonEmptyTarget?: boolean
  readonly workspaceName?: string
  readonly now?: string
  readonly charSubItemMode?: BuildPlanOptions['charSubItemMode']
  /** 注入时钟以便测「耗时」可断言；缺省用 `Date.now()`。 */
  readonly nowMs?: () => number
}

export interface LegacyImportRun {
  readonly collection: LegacyCollection
  readonly plan: ImportPlan
  readonly outcome: WriteOutcome
  readonly report: ImportReport
}

export async function runLegacyImport(
  db: SqliteDatabase,
  input: RunLegacyImportInput,
): Promise<Result<LegacyImportRun>> {
  const clockMs = input.nowMs ?? (() => Date.now())
  const startedAt = clockMs()

  const collection = await scanLegacySources(input.sources, input.requestId)

  const planOptions: BuildPlanOptions = {
    ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.charSubItemMode === undefined ? {} : { charSubItemMode: input.charSubItemMode }),
  }
  const plan = buildImportPlan(collection, planOptions)

  // 🔴 预演走 `writeImportPlan(..., {dryRun:true})` 而**不是**在这里 `return emptyOutcome()`：
  //    预演的计数必须由真跑那条代码路径自己算出来，否则「预演说会写 10 条、真跑写了 0 条」
  //    这种偏差就永远测不出来。
  const written = writeImportPlan(db, plan, {
    requestId: input.requestId,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.allowNonEmptyTarget === undefined ? {} : { allowNonEmptyTarget: input.allowNonEmptyTarget }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (!written.ok) return written

  const report = buildImportReport({
    plan,
    outcome: written.value,
    sources: collection.sources,
    generatedAt: utcOf(clockMs(), input.now),
    durationMs: Math.max(0, clockMs() - startedAt),
    dryRun: input.dryRun === true,
  })

  return {
    ok: true,
    value: { collection, plan, outcome: written.value, report },
  }
}

/** 把毫秒时间戳写成契约要求的 UTC ISO 文案；`now` 给定时优先用它（保证计划确定）。 */
function utcOf(ms: number, now: string | undefined): string {
  if (now !== undefined) return now
  return new Date(ms).toISOString()
}

/**
 * 三步中最安全的一步：只扫清单、只出计划、只出**预演**报告，一个字节都不写库。
 *
 * 用途是「用户还没决定切不切换」的阶段——`docs/旧功能迁移矩阵.md` §2.4 第 ④ 步要求
 * 用户看过差异再主动切换，所以需要一个绝对无副作用的入口。
 */
export async function previewLegacyImport(
  input: Omit<RunLegacyImportInput, 'dryRun'>,
): Promise<{ readonly collection: LegacyCollection; readonly plan: ImportPlan; readonly report: ImportReport }> {
  const collection = await scanLegacySources(input.sources, input.requestId)
  const plan = buildImportPlan(collection, {
    ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.charSubItemMode === undefined ? {} : { charSubItemMode: input.charSubItemMode }),
  })
  const outcome = planOnlyOutcome(plan)
  const report = buildImportReport({
    plan,
    outcome,
    sources: collection.sources,
    generatedAt: input.now ?? new Date().toISOString(),
    durationMs: 0,
    dryRun: true,
  })
  return { collection, plan, report }
}

/** 报告 → JSON 文本的转发，方便上层不必再 import `report.ts`。 */
export function reportToJson(run: { readonly report: ImportReport }): string {
  return serializeImportReport(run.report)
}
