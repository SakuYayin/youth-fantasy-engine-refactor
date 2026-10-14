/**
 * `@yfe/legacy-import` —— 第 ①~③ 步旧数据导入（`docs/旧功能迁移矩阵.md` §2.4）。
 *
 * | 模块 | 步骤 | 会不会写盘 |
 * | --- | --- | --- |
 * | `inventory.ts` | ① 建可追踪清单 + ② 只读扫描（拒绝把读取失败当空） | 只读 |
 * | `mapping.ts` | ② 旧 ID / 字段映射成新库的计划行（纯函数） | 不碰 IO |
 * | `import.ts` | ③ 单事务写入新库 + 目标库保护 + dry-run | **唯一**写库处 |
 * | `report.ts` | ③ 可排期、可 `JSON.stringify` 的报告 | 只读 |
 * | `pipeline.ts` | 三步串起来 | 继承 `import.ts` |
 *
 * 设计文档 `重构相关文档/重构开发文档/11-测试验收与迁移.md` 的五步里，
 * 本包只做 ①②③；第 ④ 步「用户看过差异后主动切换」与第 ⑤ 步「新版双端往返后接管」
 * 不属于本包，旧库在本包全程**不被改写**。
 *
 * 用法：
 * ```ts
 * const run = await runLegacyImport(db, {
 *   sources: [{ declaration, reader }],
 *   requestId: newIds.request(),
 *   dryRun: true,
 * })
 * if (run.ok) console.log(formatImportReport(run.value.report))
 * ```
 */

export {
  LEGACY_READ_FAILURE_KINDS,
  LegacyReadError,
  classifyReadFailure,
  classifyThrown,
  errorCodeOfReadFailure,
  isLegacyReadFailureKind,
  legacyReadFailure,
  mustRefuseReadFailure,
  parseJsonStrict,
  readFailureLocation,
  readFailureOrigin,
  throwReadFailure,
} from './errors.js'
export type { LegacyReadFailureInit, LegacyReadFailureKind, LegacyReadOrigin } from './errors.js'

export {
  LEGACY_ID_ALGORITHM,
  LEGACY_ID_DIGEST_LENGTH,
  canonicalLegacyKey,
  legacyDerivedId,
  legacyEntityId,
  legacyKeyDigest,
} from './ids.js'
export type { LegacyIdPrefix, LegacyKeyParts } from './ids.js'

export { readableStoreData, refusalAsErr, scanLegacySource, scanLegacySources } from './inventory.js'
export type {
  LegacyCollection,
  LegacyRefusal,
  LegacySourceDeclaration,
  LegacySourceKind,
  LegacySourceReader,
  LegacySourceScan,
  LegacySourceStatus,
  LegacyStoreDeclaration,
  LegacyStoreScan,
  LegacyStoreStatus,
} from './inventory.js'

export {
  LEGACY_CHARACTER_TEMPLATE_IDS,
  LEGACY_CONFIG_KEY,
  LEGACY_KB_STORE,
  LEGACY_LOCAL_STORAGE_STORE,
  LEGACY_MAIN_STORE,
  LEGACY_PLUGIN_ID,
  LEGACY_VEC_STORE,
  buildImportPlan,
} from './mapping.js'
export type {
  BuildPlanOptions,
  DeferredEntry,
  IdCollisionEntry,
  IdMappingEntry,
  IdMappingStats,
  ImportPlan,
  ImportWarning,
  ImportWarningKind,
  LegacyEntityKind,
  LegacyOriginRef,
  PlannedConfigValue,
  PlannedDocument,
  PlannedPluginData,
  PlannedProject,
  PlannedRelation,
  PlannedRevision,
  PlannedRow,
  PlannedSettingsEntity,
  PlannedWorkspace,
  UnmappedFieldEntry,
} from './mapping.js'

export {
  addCounts,
  assertTargetAcceptsImport,
  counterKeyForRefusal,
  countsAreConsistent,
  countsConsistencyErrors,
  emptyCounts,
  writeImportPlan,
} from './import.js'
export type { ImportCounts, ImportCounterKey, WriteOutcome, WritePlanOptions } from './import.js'

export {
  IMPORT_REPORT_VERSION,
  buildImportReport,
  counterKeyOfLocation,
  emptyOutcome,
  formatImportReport,
  mergeOutcome,
  planOnlyOutcome,
  serializeImportReport,
} from './report.js'
export type {
  BuildImportReportInput,
  ImportReport,
  ImportReportConsistency,
  ImportReportIdMapping,
  ImportReportRefusal,
  ImportReportSource,
  ImportReportStore,
  ImportReportTableCounts,
  SerializeImportReportOptions,
} from './report.js'

export { previewLegacyImport, reportToJson, runLegacyImport } from './pipeline.js'
export type { LegacyImportRun, LegacyImportSourceInput, RunLegacyImportInput } from './pipeline.js'
