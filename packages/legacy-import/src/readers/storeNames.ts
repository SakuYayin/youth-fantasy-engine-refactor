/**
 * 旧库各 store 的**真实主键字段**（读取器与调用方拼 `LegacyStoreDeclaration.keyField` 时用）。
 *
 * 出处（两份副本必须逐项一致，上游自己也有这个坑，见 `desktop.ts:321-324` 的注释）：
 * · 主库 16 store：`upstream/src/lib/sync/syncCore.ts:27-39`（`SYNC_STORES` + `KEY_FIELD`）；
 * · 桌面整库：`upstream/src/lib/app/desktop.ts:325-341`（`KEY_PATHS`，多出 tavernReports/aiRuns/worlds）；
 * · 便携 sidecar：`upstream/src/lib/storage/fileBackend.ts:60-67`（`PORTABLE_KEY_FIELDS`）。
 *
 * 为什么值得单独导出：主键字段不是猜的——`formData` 是 `tabId`（不是 `id`），
 * `meta` / `settingsKV` / `dailyStats` 是 `key`（`upstream/src/lib/db/tabs.ts:7-14`、
 * `upstream/src/lib/db/meta.ts:7-13`、`:19-25`、`:37-60`）。上层 `mapping.ts:371-373`
 * 的 `legacyKeyOf` 完全依赖调用方传对的 `keyField`，传错会把复合键读成 `''`。
 */

/** 主 IndexedDB 库（`youth-fantasy-engine` v13）16 个 store 的主键字段。 */
export const LEGACY_MAIN_STORE_KEY_FIELDS: Readonly<Record<string, string>> = {
  projects: 'id',
  volumes: 'id',
  chapters: 'id',
  tableRows: 'id',
  cardRecords: 'id',
  snapshots: 'id',
  trash: 'id',
  formData: 'tabId',
  meta: 'key',
  dailyStats: 'key',
  settingsKV: 'key',
  backups: 'id',
  backupPayloads: 'id',
  tavernReports: 'id',
  aiRuns: 'id',
  worlds: 'id',
}

/** 便携 sidecar 四个外置 store 的主键字段（whole 布局下整表只有一个 `__all__` 键）。 */
export const LEGACY_SIDECAR_STORE_KEY_FIELDS: Readonly<Record<string, string>> = {
  backupPayloads: 'id',
  vecRows: 'id',
  kbDocs: 'id',
  kbBodies: 'id',
}

/** 知识库（`-kb`）两个 store 的主键字段：`docs` / `bodies` 都是 `id`。 */
export const LEGACY_KB_STORE_KEY_FIELDS: Readonly<Record<string, string>> = {
  docs: 'id',
  bodies: 'id',
}

/** 向量库（`-vec`）`embeddings` 的主键字段：`id`。 */
export const LEGACY_VEC_STORE_KEY_FIELDS: Readonly<Record<string, string>> = {
  embeddings: 'id',
}
