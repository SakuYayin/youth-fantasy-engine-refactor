/**
 * 第二步：旧 ID → 新 ID 映射 + 字段映射（`docs/旧功能迁移矩阵.md` §2.2）。
 *
 * 本模块是**纯函数**：输入一份 {@link LegacyCollection}（已经过只读扫描），
 * 输出一份 {@link ImportPlan}（纯数据行），全程不碰数据库、不读文件、不看时钟
 * （时间来自旧记录本身或调用方显式传入的 `now`）。因此：
 *
 * - 同一个输入**永远**得到同一个计划（含同一批新 ID）⇒ 幂等重跑可断言；
 * - `dry-run` 与真正导入跑的是**同一个函数**，差别只在最后写不写
 *   ⇒ 「预演报告和真实报告是同构的」不是承诺，而是结构事实。
 *
 * 三条硬规则：
 *
 * 1. **未知字段不得丢弃**（任务语义 4）。每个 store 的每个已知字段集都写死在本文件里
 *    （`KNOWN_*_FIELDS`），不在集合里的键一律进 `config_values`（旁存）或
 *    `plugin_data`，并在 {@link ImportPlan.unmappedFields} 里逐条登记
 *    「哪个实体的哪个字段、值是什么、放到哪去了」。
 * 2. **合法主键优先原样保留**（迁移矩阵 M-01/M-05 的「id preserved」），
 *    但新库主键受 `ID_PATTERN` 约束（无冒号、无中文、≤128 字符），
 *    因此只保留 `isWellFormedId()` 为真的旧 ID；不合法或撞车的一律换成
 *    {@link legacyEntityId} 的确定性哈希 ID。走了哪条分支会记进 ID 映射统计
 *    （`verbatim` / `derived` / `collision`），报告里可审计。
 * 3. **引用断了要说出来**。章节找不到所属卷、设定行指向不存在的作品——
 *    这些不是「空」，是 {@link ImportWarning}，一条都不会静默吞掉。
 */

import type { DocumentKind } from '@yfe/contracts'
import { encodeRevision, isWellFormedId } from '@yfe/contracts'
import {
  BODY_NORMALIZATION_VERSION,
  countChars,
  normalizeBody,
  normalizeBodyReport,
  spreadOrderKeys,
} from '@yfe/domain'

import type { LegacyCollection, LegacyRefusal } from './inventory.js'
import {
  canonicalLegacyKey,
  legacyDerivedId,
  legacyEntityId,
  type LegacyIdPrefix,
} from './ids.js'

// ---------------------------------------------------------------------------
// 迁移矩阵里出现的 store 名（§2.1 / §2.2，勿改名）
// ---------------------------------------------------------------------------

/** 主 IndexedDB 库的 16 个 store（`upstream/src/lib/sync/syncCore.ts:27-31`）。 */
export const LEGACY_MAIN_STORE = {
  projects: 'projects',
  volumes: 'volumes',
  chapters: 'chapters',
  formData: 'formData',
  tableRows: 'tableRows',
  cardRecords: 'cardRecords',
  meta: 'meta',
  snapshots: 'snapshots',
  dailyStats: 'dailyStats',
  settingsKV: 'settingsKV',
  trash: 'trash',
  backups: 'backups',
  backupPayloads: 'backupPayloads',
  tavernReports: 'tavernReports',
  aiRuns: 'aiRuns',
  worlds: 'worlds',
} as const

/** 知识库库 / 向量库的 store（迁移矩阵 §2.1）。 */
export const LEGACY_KB_STORE = { docs: 'docs', bodies: 'bodies' } as const
export const LEGACY_VEC_STORE = { embeddings: 'embeddings' } as const
/** localStorage 在本包里被当成一个 store，key 是 localStorage 的键。 */
export const LEGACY_LOCAL_STORAGE_STORE = 'localStorage'

/** 人物卡的三个模板 ID（迁移矩阵 M-06，与 `characters.ts` 的常量一致）。 */
export const LEGACY_CHARACTER_TEMPLATE_IDS = ['char-main', 'char-secondary', 'char-npc'] as const

/** `plugin_data` 的插件 ID（迁移矩阵 M-12/M-13/M-15）。 */
export const LEGACY_PLUGIN_ID = {
  tavern: 'builtin.tavern',
  stats: 'builtin.stats',
  worldPack: 'builtin.world-pack',
  legacyImport: 'builtin.legacy-import',
} as const

/** `config_values` 的键前缀（迁移矩阵 M-03/M-10/M-01）。 */
export const LEGACY_CONFIG_KEY = {
  project: 'legacy.project',
  volume: 'legacy.volume',
  chapter: 'legacy.chapter',
  trash: 'legacy.trash',
  projectId: 'legacy.id',
  localStorage: 'legacy.localStorage',
  syncTombstones: 'legacy.sync-tombstones',
} as const

// 已知字段集（**不在集合里的字段必须进报告，不得丢弃**）
const KNOWN_PROJECT_FIELDS = ['id', 'name', 'intro', 'projectType', 'createdAt', 'updatedAt'] as const
const KNOWN_VOLUME_FIELDS = ['id', 'projectId', 'title', 'description', 'order', 'createdAt', 'updatedAt'] as const
const KNOWN_CHAPTER_FIELDS = [
  'id',
  'projectId',
  'volumeId',
  'title',
  'content',
  'order',
  'createdAt',
  'updatedAt',
  'wordCount',
] as const
const KNOWN_SETTINGS_KV_FIELDS = ['key', 'value', 'updatedAt'] as const

/**
 * 敏感字段（迁移矩阵 §2.3 `R-05`：`SENSITIVE_META_KEYS` + `SENSITIVE_FIELD_RE`）。
 * 命中即**不写入**新库，改记一条 `redacted-sensitive` 警告——明文密钥落进新库
 * 比丢字段严重得多。
 */
const SENSITIVE_META_KEYS = new Set([
  'aiProviders',
  'aiActiveProviderId',
  'aiConfigMigratedToGlobal',
  'app.search',
])
const SENSITIVE_FIELD_RE = /api[-_]?key|secret|token|password|credential/i

// ---------------------------------------------------------------------------
// 计划行
// ---------------------------------------------------------------------------

/** 旧实体的身份引用。所有旁存 / 报告项的 `location` 都由它派生，保证可定位。 */
export interface LegacyOriginRef {
  readonly sourceId: string
  readonly database: string
  readonly store: string
  readonly legacyId: string
  readonly qualifier: string | null
}

export type LegacyEntityKind =
  | 'workspace'
  | 'project'
  | 'document'
  | 'revision'
  | 'settings_entity'
  | 'relation'
  | 'config_value'
  | 'plugin_data'

export interface PlannedWorkspace {
  readonly table: 'workspace'
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly origin: LegacyOriginRef
}

export interface PlannedProject {
  readonly table: 'project'
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly summary: string
  readonly projectType: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly origin: LegacyOriginRef
}

export interface PlannedDocument {
  readonly table: 'document'
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly kind: DocumentKind
  readonly parentId: string | null
  readonly orderKey: string
  readonly title: string
  readonly body: string
  readonly deleted: 0 | 1
  readonly createdAt: string
  readonly updatedAt: string
  /** 归一化后正文的字素簇字数（`@yfe/domain` 的 `countChars`）。 */
  readonly charCount: number
  readonly origin: LegacyOriginRef
}

export interface PlannedRevision {
  readonly table: 'revision'
  readonly id: string
  readonly workspaceId: string
  readonly entityType: string
  readonly entityId: string
  readonly seq: number
  readonly revision: string
  readonly bodySnapshot: string | null
  readonly valuesSnapshot: string | null
  readonly createdAt: string
  readonly origin: LegacyOriginRef
}

export interface PlannedSettingsEntity {
  readonly table: 'settings_entity'
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly orderKey: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly origin: LegacyOriginRef
}

export interface PlannedRelation {
  readonly table: 'relation'
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly kind: 'reference'
  readonly fromEntityId: string
  readonly toEntityId: string
  readonly label: string
  readonly values: Readonly<Record<string, unknown>>
  readonly origin: LegacyOriginRef
}

export interface PlannedConfigValue {
  readonly table: 'config_value'
  readonly id: string
  readonly scope: 'user' | 'workspace' | 'project' | 'device' | 'plugin'
  readonly ownerId: string
  readonly key: string
  readonly value: unknown
  readonly origin: LegacyOriginRef
}

export interface PlannedPluginData {
  readonly table: 'plugin_data'
  readonly id: string
  readonly workspaceId: string
  readonly pluginId: string
  readonly key: string
  readonly value: unknown
  readonly origin: LegacyOriginRef
}

export type PlannedRow =
  | PlannedWorkspace
  | PlannedProject
  | PlannedDocument
  | PlannedRevision
  | PlannedSettingsEntity
  | PlannedRelation
  | PlannedConfigValue
  | PlannedPluginData

// ---------------------------------------------------------------------------
// 报告素材
// ---------------------------------------------------------------------------

/** 一条「旧字段没有一对一落点，但**没有被丢弃**」的记录。 */
export interface UnmappedFieldEntry {
  readonly location: string
  readonly entityKind: LegacyEntityKind
  readonly entityId: string
  readonly field: string
  /** 值放到了哪里。`raw_payload` = 只在报告里保留（含被脱敏的值）。 */
  readonly disposition: 'values_json' | 'config_values' | 'plugin_data' | 'raw_payload'
  /** JSON 安全的值摘要（敏感值已被替换为 `[redacted]`）。 */
  readonly value: unknown
}

export type ImportWarningKind =
  | 'unknown-project'
  | 'orphan-parent'
  | 'duplicate-key'
  | 'unsupported-shape'
  | 'redacted-sensitive'
  | 'not-implemented'

export interface ImportWarning {
  readonly location: string
  readonly kind: ImportWarningKind
  readonly message: string
}

export interface IdCollisionEntry {
  readonly table: string
  readonly preferred: string
  readonly existingKey: string
  readonly incomingKey: string
  readonly resolution: 'derived'
  readonly derived: string
}

export interface IdMappingEntry {
  readonly canonicalKey: string
  readonly table: string
  readonly legacyId: string
  readonly newId: string
  readonly strategy: 'verbatim' | 'derived' | 'collision-derived'
}

export interface IdMappingStats {
  readonly total: number
  readonly verbatim: number
  readonly derived: number
  readonly collisions: number
  readonly byTable: Readonly<Record<string, number>>
}

/** 被折叠进报告的计划之外的部分（不是失败，是「本包不接管」）。 */
export interface DeferredEntry {
  readonly location: string
  readonly reason: string
}

export interface ImportPlan {
  readonly workspaceId: string
  readonly rows: readonly PlannedRow[]
  readonly unmappedFields: readonly UnmappedFieldEntry[]
  readonly warnings: readonly ImportWarning[]
  readonly refusals: readonly LegacyRefusal[]
  readonly collisions: readonly IdCollisionEntry[]
  readonly idMapping: readonly IdMappingEntry[]
  readonly idStats: IdMappingStats
  readonly deferred: readonly DeferredEntry[]
  readonly notes: readonly string[]
  /** 计划里每种目标表的行数（报告「计划数」的来源）。 */
  readonly plannedByTable: Readonly<Record<LegacyEntityKind, number>>
}

export interface BuildPlanOptions {
  /** 导入工作区的名字（新版 `workspaces.name`）。 */
  readonly workspaceName?: string
  /** 缺省时间戳（旧记录没有 `createdAt` 时使用）。传固定值可得到完全确定的计划。 */
  readonly now?: string
  /**
   * 人物卡子项的落法（迁移矩阵 M-06 让二选一，本包选择并汇报）：
   * - `'suffixed-store'`（默认）：`schema_template_id = <tabId>-sub`，保留子项与主卡的区分；
   * - `'parent-in-values'`：`schema_template_id = <tabId>`，父子关系写进 `values.parentId`。
   */
  readonly charSubItemMode?: 'suffixed-store' | 'parent-in-values'
}

const DEFAULT_WORKSPACE_NAME = '旧版导入'
const DEVICE_OWNER_ID = 'local-device'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 旧记录的主键：优先 store 声明的 `keyField`，否则 `id`，否则调用方给的兜底键。 */
function legacyKeyOf(record: Record<string, unknown>, keyField: string | null, fallback: string): string {
  if (keyField !== null) {
    const value = record[keyField]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number') return String(value)
  }
  const id = record['id']
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number') return String(id)
  return fallback
}

function isoOr(value: string | null, fallback: string): string {
  if (value === null) return fallback
  // 只接受契约的 UTC 形状；旧版里出现过的本地时间串一律退回归一化缺省，
  // 不猜时区（猜错会把章节顺序排乱）。
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? value : fallback
}

/** JSON 安全化：丢掉不可序列化的东西，循环引用替换为标记。 */
function jsonSafe(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value as number) ? value : String(value)
  if (type === 'undefined') return '[undefined]'
  if (type === 'function' || type === 'symbol' || type === 'bigint') return `[${type}]`
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafe(item, seen))
  }
  if (type === 'object') {
    const object = value as object
    if (seen.has(object)) return '[circular]'
    seen.add(object)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(item, seen)
    }
    seen.delete(object)
    return out
  }
  return '[unserializable]'
}

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_RE.test(name)
}

/** 拆出已知字段之外的键。**返回的每个键都必须进报告**。 */
function splitUnknown(
  record: Record<string, unknown>,
  known: readonly string[],
): { readonly knownValues: Record<string, unknown>; readonly unknownValues: Record<string, unknown> } {
  const knownValues: Record<string, unknown> = {}
  const unknownValues: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (known.includes(key)) knownValues[key] = value
    else unknownValues[key] = value
  }
  return { knownValues, unknownValues }
}

function locationOf(ref: LegacyOriginRef): string {
  return ref.qualifier === null
    ? `${ref.sourceId}/${ref.database}/${ref.store}/${ref.legacyId}`
    : `${ref.sourceId}/${ref.database}/${ref.store}/${ref.legacyId}#${ref.qualifier}`
}

// ---------------------------------------------------------------------------
// ID 登记表
// ---------------------------------------------------------------------------

interface IdRegistry {
  readonly byCanonical: Map<string, string>
  readonly usedByTable: Map<string, Map<string, string>>
  /** 规范键 → 已出现的次数（>1 说明旧库里同 id 重复出现）。 */
  readonly occurrences: Map<string, number>
  readonly entries: IdMappingEntry[]
  readonly collisions: IdCollisionEntry[]
}

function newRegistry(): IdRegistry {
  return {
    byCanonical: new Map(),
    usedByTable: new Map(),
    occurrences: new Map(),
    entries: [],
    collisions: [],
  }
}

/**
 * 给一条旧实体分配新 ID。
 *
 * 顺序：
 * 1. 同一个规范键**第一次**出现 → 按 2/3 分配并记进 `byCanonical`。
 * 2. `preferred`（旧 ID）合法且在该表内未被占用 → 原样保留（`verbatim`，M-01/M-05）。
 * 3. 否则用 `legacyEntityId` 派生（`derived`）；若 `preferred` 合法但被占用 →
 *    先把撞车记进 {@link IdCollisionEntry}，再派生（`collision-derived`）。
 * 4. 同一个规范键**再次**出现 → 视为旧库里同 id 重复出现（导出损坏或手工拼接），
 *    记一条撞车并用 `dup-<n>` 限定符派生出**不同**的新 ID。
 *
 * 🔴 第 4 条为什么必须派生而不是复用：复用会让计划里出现两行同一个主键，
 *    写入时 better-sqlite3 直接抛错、**整次导入回滚**——那才是真的丢数据。
 *    这里宁可多出一条「重复键」记录，也要让两行都写得进去。
 */
function assignId(
  registry: IdRegistry,
  table: LegacyEntityKind,
  prefix: LegacyIdPrefix,
  ref: LegacyOriginRef,
  preferred: string | null,
): string {
  const canonical = canonicalLegacyKey(ref)
  const used = registry.usedByTable.get(table) ?? new Map<string, string>()
  registry.usedByTable.set(table, used)

  if (registry.byCanonical.has(canonical)) {
    const occurrence = (registry.occurrences.get(canonical) ?? 1) + 1
    registry.occurrences.set(canonical, occurrence)
    const duplicateRef: LegacyOriginRef = { ...ref, qualifier: `dup-${occurrence}` }
    const id = legacyEntityId(prefix, duplicateRef)
    used.set(id, canonical)
    registry.collisions.push({
      table,
      preferred: preferred ?? registry.byCanonical.get(canonical) ?? '',
      existingKey: registry.byCanonical.get(canonical) ?? '',
      incomingKey: canonical,
      resolution: 'derived',
      derived: id,
    })
    registry.entries.push({ canonicalKey: canonical, table, legacyId: ref.legacyId, newId: id, strategy: 'derived' })
    return id
  }

  let id: string | null = null
  let strategy: IdMappingEntry['strategy'] = 'derived'
  if (preferred !== null && isWellFormedId(preferred)) {
    const owner = used.get(preferred)
    if (owner === undefined) {
      id = preferred
      strategy = 'verbatim'
    } else {
      const derived = legacyEntityId(prefix, ref)
      registry.collisions.push({
        table,
        preferred,
        existingKey: owner,
        incomingKey: canonical,
        resolution: 'derived',
        derived,
      })
      id = derived
      strategy = 'collision-derived'
    }
  }
  if (id === null) {
    id = legacyEntityId(prefix, ref)
    strategy = 'derived'
  }

  registry.byCanonical.set(canonical, id)
  registry.occurrences.set(canonical, 1)
  used.set(id, canonical)
  registry.entries.push({ canonicalKey: canonical, table, legacyId: ref.legacyId, newId: id, strategy })
  return id
}

function summarizeIds(entries: readonly IdMappingEntry[], collisions: readonly IdCollisionEntry[]): IdMappingStats {
  const byTable: Record<string, number> = {}
  let verbatim = 0
  let derived = 0
  for (const entry of entries) {
    byTable[entry.table] = (byTable[entry.table] ?? 0) + 1
    if (entry.strategy === 'verbatim') verbatim += 1
    else derived += 1
  }
  return { total: entries.length, verbatim, derived, collisions: collisions.length, byTable }
}

// ---------------------------------------------------------------------------
// 构建计划
// ---------------------------------------------------------------------------

/**
 * 把只读扫描结果映射成导入计划。
 *
 * 🔴 注意：`refusals` 从扫描结果**原样带过来**，并且不影响其它 store 的映射。
 *    计划里永远不会有「因为读不出来所以按 0 条处理」的路径——
 *    没被读到的 store 根本不会进这个循环（见 `inventory.ts` 的 `readableStoreData`）。
 */
export function buildImportPlan(collection: LegacyCollection, options: BuildPlanOptions = {}): ImportPlan {
  const now = options.now ?? new Date().toISOString()
  const charSubItemMode = options.charSubItemMode ?? 'suffixed-store'
  const registry = newRegistry()
  const rows: PlannedRow[] = []
  const unmappedFields: UnmappedFieldEntry[] = []
  const warnings: ImportWarning[] = [...collection.refusals.map(refusalWarning)]
  const deferred: DeferredEntry[] = []
  const notes: string[] = []

  // ---- 工作区：一次导入一个工作区，ID 由全部来源 ID 派生，重跑必然复用同一个。 ----
  const sourceIds = [...collection.sources.map((source) => source.sourceId)].sort()
  const workspaceRef: LegacyOriginRef = {
    sourceId: sourceIds.join('+') || 'legacy',
    database: 'import',
    store: 'workspace',
    legacyId: 'workspace',
    qualifier: null,
  }
  const workspaceId = assignId(registry, 'workspace', 'ws', workspaceRef, null)
  rows.push({
    table: 'workspace',
    id: workspaceId,
    name: options.workspaceName ?? DEFAULT_WORKSPACE_NAME,
    createdAt: now,
    updatedAt: now,
    origin: workspaceRef,
  })

  // ---- 索引：旧 ID → 新 ID（跨 store 引用解析用） ----
  const projectIdByLegacy = new Map<string, string>()
  const volumeIdByLegacy = new Map<string, string>()
  const documentIdByLegacy = new Map<string, { readonly projectId: string; readonly kind: DocumentKind }>()
  const settingsEntityIdByLegacy = new Map<string, string>()
  const projectRefByProjectId = new Map<string, LegacyOriginRef>()

  const storeData = (name: string) =>
    collection.sources.flatMap((source) =>
      source.stores
        .filter((store) => store.name === name && (store.status === 'ok' || store.status === 'absent'))
        .map((store) => ({ source, store })),
    )

  const warn = (location: string, kind: ImportWarningKind, message: string) => {
    warnings.push({ location, kind, message })
  }

  const recordUnknown = (
    ref: LegacyOriginRef,
    entityKind: LegacyEntityKind,
    entityId: string,
    values: Record<string, unknown>,
    disposition: UnmappedFieldEntry['disposition'],
  ) => {
    for (const [field, value] of Object.entries(values)) {
      unmappedFields.push({
        location: locationOf(ref),
        entityKind,
        entityId,
        field,
        disposition,
        value: jsonSafe(value),
      })
    }
  }

  const pushConfigValue = (
    ref: LegacyOriginRef,
    scope: PlannedConfigValue['scope'],
    ownerId: string,
    key: string,
    value: unknown,
    qualifier: string,
  ) => {
    const derivedRef: LegacyOriginRef = { ...ref, qualifier }
    const id = legacyDerivedId('cfg', derivedRef, qualifier)
    rows.push({ table: 'config_value', id, scope, ownerId, key, value, origin: derivedRef })
  }

  // =====================================================================
  // M-01 作品 → projects（+ 未知字段旁存）
  // =====================================================================
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.projects)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/projects[${index}]`, 'unsupported-shape', '作品记录不是对象，已跳过（不明形态不等于空）。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = {
        sourceId: source.sourceId,
        database: 'main',
        store: 'projects',
        legacyId,
        qualifier: null,
      }
      const projectId = assignId(registry, 'project', 'prj', ref, legacyId)
      projectIdByLegacy.set(legacyId, projectId)
      projectRefByProjectId.set(projectId, ref)
      const { unknownValues } = splitUnknown(record, KNOWN_PROJECT_FIELDS)
      rows.push({
        table: 'project',
        id: projectId,
        workspaceId,
        name: str(record, 'name') ?? '',
        summary: str(record, 'intro') ?? '',
        projectType: str(record, 'projectType') ?? 'full',
        createdAt: isoOr(str(record, 'createdAt'), now),
        updatedAt: isoOr(str(record, 'updatedAt'), now),
        origin: ref,
      })
      if (Object.keys(unknownValues).length > 0) {
        pushConfigValue(ref, 'project', projectId, LEGACY_CONFIG_KEY.project, unknownValues, 'unknown-fields')
        recordUnknown(ref, 'project', projectId, unknownValues, 'config_values')
      }
      pushConfigValue(ref, 'project', projectId, LEGACY_CONFIG_KEY.projectId, legacyId, 'legacy-id')
    })
  }

  // =====================================================================
  // M-02 卷 → documents(kind='volume')，父为空，order_key 用 spreadOrderKeys 保序
  // =====================================================================
  interface PendingVolume {
    readonly ref: LegacyOriginRef
    readonly projectId: string | null
    readonly legacyProjectId: string | null
    readonly title: string
    readonly body: string
    readonly order: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly legacyId: string
    readonly documentId: string
    readonly unknown: Record<string, unknown>
  }
  const pendingVolumes: PendingVolume[] = []
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.volumes)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/volumes[${index}]`, 'unsupported-shape', '卷记录不是对象，已跳过。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'volumes', legacyId, qualifier: null }
      const documentId = assignId(registry, 'document', 'vol', ref, legacyId)
      const legacyProjectId = str(record, 'projectId')
      const projectId = legacyProjectId === null ? null : (projectIdByLegacy.get(legacyProjectId) ?? null)
      if (legacyProjectId !== null && projectId === null) {
        warn(locationOf(ref), 'unknown-project', `卷引用的作品「${legacyProjectId}」不在本次导入范围内，其父级留空。`)
      }
      const { unknownValues } = splitUnknown(record, KNOWN_VOLUME_FIELDS)
      pendingVolumes.push({
        ref,
        projectId,
        legacyProjectId,
        title: str(record, 'title') ?? '',
        body: normalizeBody(str(record, 'description') ?? ''),
        order: num(record, 'order') ?? index,
        createdAt: isoOr(str(record, 'createdAt'), now),
        updatedAt: isoOr(str(record, 'updatedAt'), now),
        legacyId,
        documentId,
        unknown: unknownValues,
      })
    })
  }

  // =====================================================================
  // M-03 章节 → documents(kind='chapter') + revisions（首版）
  // =====================================================================
  interface PendingChapter {
    readonly ref: LegacyOriginRef
    readonly projectId: string | null
    readonly legacyVolumeId: string | null
    readonly title: string
    readonly rawBody: string
    readonly body: string
    readonly normalizationSteps: readonly string[]
    readonly charCount: number
    readonly legacyWordCount: number | null
    readonly order: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly legacyId: string
    readonly documentId: string
    readonly unknown: Record<string, unknown>
  }
  const pendingChapters: PendingChapter[] = []
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.chapters)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/chapters[${index}]`, 'unsupported-shape', '章节记录不是对象，已跳过。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'chapters', legacyId, qualifier: null }
      const documentId = assignId(registry, 'document', 'doc', ref, legacyId)
      const legacyProjectId = str(record, 'projectId')
      const projectId = legacyProjectId === null ? null : (projectIdByLegacy.get(legacyProjectId) ?? null)
      const legacyVolumeId = str(record, 'volumeId')
      if (legacyVolumeId !== null && !volumeIdByLegacy.has(legacyVolumeId)) {
        // 卷可能还没轮到处理；延后到卷全部就绪后再判，见下方 fixup。
      }
      const rawBody = str(record, 'content') ?? ''
      const report = normalizeBodyReport(rawBody)
      const { unknownValues } = splitUnknown(record, KNOWN_CHAPTER_FIELDS)
      pendingChapters.push({
        ref,
        projectId,
        legacyVolumeId,
        title: str(record, 'title') ?? '',
        rawBody,
        body: report.text,
        normalizationSteps: report.steps,
        charCount: countChars(report.text),
        legacyWordCount: num(record, 'wordCount'),
        order: num(record, 'order') ?? index,
        createdAt: isoOr(str(record, 'createdAt'), now),
        updatedAt: isoOr(str(record, 'updatedAt'), now),
        legacyId,
        documentId,
        unknown: unknownValues,
      })
    })
  }

  // 卷先入索引，章节才能解析 parentId。
  for (const volume of pendingVolumes) {
    volumeIdByLegacy.set(volume.legacyId, volume.documentId)
  }

  /**
   * 旧卷 ID 或旧章节 ID → 新 `documents.id`。
   * 快照与回收站都用它归位；两处共用同一张表，避免「快照认得章节、回收站认不得」这类分叉。
   */
  const documentIdForLegacy = (legacyId: string): string | null =>
    volumeIdByLegacy.get(legacyId) ??
    pendingChapters.find((chapter) => chapter.legacyId === legacyId)?.documentId ??
    null

  // order_key：按旧 `order` 排序后批量取键（`spreadOrderKeys` 是唯一的批量入口）。
  const orderKeyByDocumentId = new Map<string, string>()
  const assignOrderKeys = (items: readonly { readonly documentId: string; readonly order: number; readonly legacyId: string }[]) => {
    const sorted = [...items].sort((a, b) =>
      a.order === b.order ? (a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0) : a.order - b.order,
    )
    const keys = spreadOrderKeys(sorted.length)
    sorted.forEach((item, index) => {
      const key = keys[index]
      if (key !== undefined) orderKeyByDocumentId.set(item.documentId, key)
    })
  }
  assignOrderKeys(pendingVolumes)

  // 章节按「卷内」分批排序：同卷内按旧 order，跨卷互不干扰。
  const chaptersByVolume = new Map<string, PendingChapter[]>()
  for (const chapter of pendingChapters) {
    const bucket = chapter.legacyVolumeId ?? '__no-volume__'
    const list = chaptersByVolume.get(bucket)
    if (list === undefined) chaptersByVolume.set(bucket, [chapter])
    else list.push(chapter)
  }
  for (const list of chaptersByVolume.values()) {
    assignOrderKeys(list)
  }

  for (const volume of pendingVolumes) {
    const orderKey = orderKeyByDocumentId.get(volume.documentId)
    if (orderKey === undefined) {
      warn(locationOf(volume.ref), 'unsupported-shape', '卷未取得排序键，已跳过（不静默生成 0 条）。')
      continue
    }
    documentIdByLegacy.set(volume.legacyId, { projectId: volume.projectId ?? '', kind: 'volume' })
    rows.push({
      table: 'document',
      id: volume.documentId,
      workspaceId,
      projectId: volume.projectId ?? '',
      kind: 'volume',
      parentId: null,
      orderKey,
      title: volume.title,
      body: volume.body,
      deleted: 0,
      createdAt: volume.createdAt,
      updatedAt: volume.updatedAt,
      charCount: countChars(volume.body),
      origin: volume.ref,
    })
    if (Object.keys(volume.unknown).length > 0) {
      pushConfigValue(volume.ref, 'project', volume.projectId ?? '', `${LEGACY_CONFIG_KEY.volume}.${volume.legacyId}`, volume.unknown, 'unknown-fields')
      recordUnknown(volume.ref, 'document', volume.documentId, volume.unknown, 'config_values')
    }
  }

  const revisionRows: PlannedRevision[] = []
  for (const chapter of pendingChapters) {
    const orderKey = orderKeyByDocumentId.get(chapter.documentId)
    if (orderKey === undefined) {
      warn(locationOf(chapter.ref), 'unsupported-shape', '章节未取得排序键，已跳过（不静默生成 0 条）。')
      continue
    }
    let parentId: string | null = null
    if (chapter.legacyVolumeId !== null) {
      parentId = volumeIdByLegacy.get(chapter.legacyVolumeId) ?? null
      if (parentId === null) {
        warn(
          locationOf(chapter.ref),
          'orphan-parent',
          `章节引用的卷「${chapter.legacyVolumeId}」未出现在本次导入中，章节保留但其父级为空（未丢弃正文）。`,
        )
        recordUnknown(chapter.ref, 'document', chapter.documentId, { volumeId: chapter.legacyVolumeId }, 'raw_payload')
      }
    }
    documentIdByLegacy.set(chapter.legacyId, { projectId: chapter.projectId ?? '', kind: 'chapter' })
    rows.push({
      table: 'document',
      id: chapter.documentId,
      workspaceId,
      projectId: chapter.projectId ?? '',
      kind: 'chapter',
      parentId,
      orderKey,
      title: chapter.title,
      body: chapter.body,
      deleted: 0,
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
      charCount: chapter.charCount,
      origin: chapter.ref,
    })

    // M-03：每条章节生成一个初始 revision（seq = 1，绝不由 COUNT(*) 推导）。
    const revisionRef: LegacyOriginRef = { ...chapter.ref, qualifier: 'initial' }
    revisionRows.push({
      table: 'revision',
      id: legacyDerivedId('rev', revisionRef, 'initial'),
      workspaceId,
      entityType: 'document',
      entityId: chapter.documentId,
      seq: 1,
      revision: encodeRevision(1),
      bodySnapshot: chapter.body,
      valuesSnapshot: JSON.stringify({
        kind: 'chapter',
        charCount: chapter.charCount,
        normalization: { version: BODY_NORMALIZATION_VERSION, steps: chapter.normalizationSteps },
        legacyWordCount: chapter.legacyWordCount,
        legacyBodyChanged: chapter.rawBody !== chapter.body,
      }),
      createdAt: chapter.createdAt,
      origin: revisionRef,
    })
    if (Object.keys(chapter.unknown).length > 0) {
      pushConfigValue(
        chapter.ref,
        'project',
        chapter.projectId ?? '',
        `${LEGACY_CONFIG_KEY.chapter}.${chapter.legacyId}`,
        chapter.unknown,
        'unknown-fields',
      )
      recordUnknown(chapter.ref, 'document', chapter.documentId, chapter.unknown, 'config_values')
    }
  }

  // =====================================================================
  // M-04 / M-05 / M-06 设定数据 → settings_entities
  // =====================================================================
  interface PendingEntity {
    readonly ref: LegacyOriginRef
    readonly projectId: string | null
    readonly legacyProjectId: string | null
    readonly schemaTemplateId: string
    readonly name: string
    readonly values: Record<string, unknown>
    readonly order: number
    readonly createdAt: string
    readonly updatedAt: string
    readonly entityId: string
    readonly groupKey: string
  }
  const pendingEntities: PendingEntity[] = []
  /** 子项 → 父卡的旧 ID，等全部 ID 分配完再回填（顺序无关）。 */
  interface PendingSubLink {
    readonly entity: PendingEntity
    readonly legacyParentId: string | null
  }
  const pendingSubLinks: PendingSubLink[] = []

  const collectSettingsRows = (storeName: string, templateOf: (record: Record<string, unknown>) => string | null) => {
    for (const { source, store } of storeData(storeName)) {
      store.records.forEach((raw, index) => {
        const record = asRecord(raw)
        if (record === null) {
          warn(`${source.sourceId}/main/${storeName}[${index}]`, 'unsupported-shape', `${storeName} 记录不是对象，已跳过。`)
          return
        }
        const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
        const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: storeName, legacyId, qualifier: null }
        const data = asRecord(record['data']) ?? {}
        const templateId = templateOf(record)
        if (templateId === null) {
          warn(locationOf(ref), 'unsupported-shape', `${storeName} 记录缺少 tabId，无法确定 schema_template_id，已跳过并保留原始载荷。`)
          recordUnknown(ref, 'settings_entity', legacyId, { __raw: rawPayloadOf(record) }, 'raw_payload')
          return
        }
        const legacyProjectId = str(record, 'projectId')
        const projectId = legacyProjectId === null ? null : (projectIdByLegacy.get(legacyProjectId) ?? null)
        if (legacyProjectId !== null && projectId === null) {
          warn(locationOf(ref), 'unknown-project', `${storeName} 记录引用的作品「${legacyProjectId}」不在本次导入范围内。`)
        }
        const name = str(data, '名称') ?? str(data, 'name') ?? ''
        const entityId = assignId(registry, 'settings_entity', templateId.startsWith('char-') ? 'chr' : 'set', ref, legacyId)
        // 🔴 用**原始旧 ID** 作键：派生 relations 时拿到的引用值就是原始旧 ID
        //    （`${storeName}:${legacyId}` 那种复合键在引用解析里永远查不到，等于关系全丢）。
        settingsEntityIdByLegacy.set(legacyId, entityId)
        pendingEntities.push({
          ref,
          projectId,
          legacyProjectId,
          schemaTemplateId: templateId,
          name,
          values: data,
          order: num(record, 'order') ?? index,
          createdAt: isoOr(str(record, 'createdAt'), now),
          updatedAt: isoOr(str(record, 'updatedAt'), now),
          entityId,
          groupKey: `${projectId ?? ''}\u0000${templateId}`,
        })
      })
    }
  }

  // M-04：`formData` 的键是 `<projectId>::<tabId>`，tabId 原样当 schema_template_id。
  collectSettingsRows(LEGACY_MAIN_STORE.formData, (record) => {
    const tabId = str(record, 'tabId')
    if (tabId !== null && tabId !== '') return tabId
    const key = str(record, 'id') ?? str(record, 'key')
    if (key === null) return null
    const split = key.indexOf('::')
    return split >= 0 ? key.slice(split + 2) : null
  })
  // M-05：`tableRows` 每行一个设定实体。
  collectSettingsRows(LEGACY_MAIN_STORE.tableRows, (record) => str(record, 'tabId'))
  // M-06：人物卡。子项按 `charSubItemMode` 决定落法。
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.cardRecords)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/cardRecords[${index}]`, 'unsupported-shape', '人物卡记录不是对象，已跳过。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'cardRecords', legacyId, qualifier: null }
      const cardTabId = str(record, 'tabId') ?? ''
      const isCharacterCard = (LEGACY_CHARACTER_TEMPLATE_IDS as readonly string[]).includes(cardTabId)
      const legacyProjectId = str(record, 'projectId')
      const projectId = legacyProjectId === null ? null : (projectIdByLegacy.get(legacyProjectId) ?? null)
      const data = asRecord(record['data']) ?? {}
      // 旧版把人物卡子项存成**独立记录**，`tabId` 带 `-sub` 后缀
      // （`upstream/src/lib/app/codeRefs.ts:106`：「子项挂在 `<tabId>-sub` 下」）。
      const isSubRecord = cardTabId.endsWith('-sub')
      const baseCardTabId = isSubRecord ? cardTabId.slice(0, -'-sub'.length) : cardTabId
      const parentId = assignId(registry, 'settings_entity', 'chr', ref, legacyId)
      settingsEntityIdByLegacy.set(legacyId, parentId)

      // 立绘 dataURL：迁移矩阵 M-06 要求外置成 assets + asset_refs。
      // 本包不落二进制（只读解析层不写任何文件），因此**原样保留在 values_json**，
      // 并在报告里点名说明，绝不悄悄丢掉。
      const values: Record<string, unknown> = { ...data }
      for (const field of ['portrait', 'portrait2'] as const) {
        const value = record[field] ?? data[field]
        if (typeof value !== 'string' || value === '') continue
        values[field] = value
        recordUnknown(ref, 'settings_entity', parentId, { [field]: `${value.slice(0, 32)}…(${value.length} 字符 dataURL)` }, 'values_json')
        warnings.push({
          location: locationOf(ref),
          kind: 'not-implemented',
          message: `字段「${field}」是内嵌 dataURL：已原样保留在 values_json，但迁移矩阵 M-06 要求的 assets/asset_refs 外置本包未实现。`,
        })
      }

      const templateId = isSubRecord && charSubItemMode === 'parent-in-values'
        ? baseCardTabId
        : isCharacterCard || isSubRecord
          ? cardTabId
          : cardTabId === ''
            ? 'char-main'
            : cardTabId
      const entity: PendingEntity = {
        ref,
        projectId,
        legacyProjectId,
        schemaTemplateId: templateId,
        name: str(data, '名称') ?? str(data, 'name') ?? '',
        values,
        order: num(record, 'order') ?? index,
        createdAt: isoOr(str(record, 'createdAt'), now),
        updatedAt: isoOr(str(record, 'updatedAt'), now),
        entityId: parentId,
        groupKey: `${projectId ?? ''}\u0000${templateId}`,
      }
      pendingEntities.push(entity)
      if (isSubRecord) {
        pendingSubLinks.push({ entity, legacyParentId: str(data, 'parentId') })
      }

      const subItems = Array.isArray(record['subItems']) ? (record['subItems'] as readonly unknown[]) : []
      subItems.forEach((subRaw, subIndex) => {
        const sub = asRecord(subRaw)
        if (sub === null) {
          warn(locationOf(ref), 'unsupported-shape', `人物卡子项 #${subIndex} 不是对象，已跳过。`)
          return
        }
        const subLegacyId = str(sub, 'id') ?? `${legacyId}#sub${subIndex}`
        const subRef: LegacyOriginRef = { ...ref, legacyId: subLegacyId, qualifier: 'sub' }
        const subData = asRecord(sub['data']) ?? sub
        const subTemplateId = charSubItemMode === 'suffixed-store' ? `${cardTabId}-sub` : cardTabId
        const subEntityId = assignId(registry, 'settings_entity', 'chr', subRef, subLegacyId)
        const subEntity: PendingEntity = {
          ref: subRef,
          projectId,
          legacyProjectId,
          schemaTemplateId: subTemplateId,
          name: str(subData, '名称') ?? str(subData, 'name') ?? '',
          values: { ...subData },
          order: subIndex,
          createdAt: isoOr(str(sub, 'createdAt'), now),
          updatedAt: isoOr(str(sub, 'updatedAt'), now),
          entityId: subEntityId,
          groupKey: `${projectId ?? ''}\u0000${subTemplateId}`,
        }
        pendingEntities.push(subEntity)
        pendingSubLinks.push({ entity: subEntity, legacyParentId: legacyId })
      })
    })
  }

  // 子项的父引用：等**所有**设定实体的新 ID 都分配完再回填，避免依赖记录顺序。
  // 迁移矩阵 M-06 让「`char-main-sub` 原样保留」与「`char-main` + values.parentId」二选一，
  // 两种模式下都把这层关系写成**新 ID**，这样新库里不会留一个指向旧库的悬空引用。
  for (const link of pendingSubLinks) {
    const legacyParentId = link.legacyParentId
    if (legacyParentId === null || legacyParentId === '') continue
    const parentNewId = settingsEntityIdByLegacy.get(legacyParentId)
    if (parentNewId === undefined) {
      warn(
        locationOf(link.entity.ref),
        'orphan-parent',
        `人物卡子项引用的父卡「${legacyParentId}」不在本次导入范围内，父子关系只能靠旧 ID 保留。`,
      )
      continue
    }
    link.entity.values['parentId'] = parentNewId
  }

  // settings_entities 的 order_key：按 (project, template) 分组后批量取键。
  const entitiesByGroup = new Map<string, PendingEntity[]>()
  for (const entity of pendingEntities) {
    const list = entitiesByGroup.get(entity.groupKey)
    if (list === undefined) entitiesByGroup.set(entity.groupKey, [entity])
    else list.push(entity)
  }
  const entityOrderKey = new Map<string, string>()
  for (const list of entitiesByGroup.values()) {
    const sorted = [...list].sort((a, b) =>
      a.order === b.order ? (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0) : a.order - b.order,
    )
    const keys = spreadOrderKeys(sorted.length)
    sorted.forEach((entity, index) => {
      const key = keys[index]
      if (key !== undefined) entityOrderKey.set(entity.entityId, key)
    })
  }
  for (const entity of pendingEntities) {
    const orderKey = entityOrderKey.get(entity.entityId)
    if (orderKey === undefined) {
      warn(locationOf(entity.ref), 'unsupported-shape', '设定实体未取得排序键，已跳过。')
      continue
    }
    rows.push({
      table: 'settings_entity',
      id: entity.entityId,
      workspaceId,
      projectId: entity.projectId ?? '',
      schemaTemplateId: entity.schemaTemplateId,
      name: entity.name,
      values: entity.values,
      orderKey,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      origin: entity.ref,
    })
  }

  // =====================================================================
  // M-08 settingsKV → config_values(scope='project')，键剥掉 `<projectId>::` 前缀
  // =====================================================================
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.settingsKV)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/settingsKV[${index}]`, 'unsupported-shape', 'settingsKV 记录不是对象，已跳过。')
        return
      }
      const rawKey = str(record, 'key') ?? legacyKeyOf(record, store.keyField, `#${index}`)
      const split = rawKey.indexOf('::')
      const legacyProjectId = split >= 0 ? rawKey.slice(0, split) : null
      const key = split >= 0 ? rawKey.slice(split + 2) : rawKey
      const projectId = legacyProjectId === null ? '' : (projectIdByLegacy.get(legacyProjectId) ?? '')
      if (legacyProjectId !== null && projectId === '') {
        warn(`${source.sourceId}/main/settingsKV/${rawKey}`, 'unknown-project', `settingsKV 键前缀指向未知作品「${legacyProjectId}」。`)
      }
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'settingsKV', legacyId: rawKey, qualifier: null }
      const { unknownValues } = splitUnknown(record, KNOWN_SETTINGS_KV_FIELDS)
      pushConfigValue(ref, 'project', projectId, key, record['value'] ?? null, 'kv')
      if (Object.keys(unknownValues).length > 0) {
        recordUnknown(ref, 'config_value', `${projectId}:${key}`, unknownValues, 'config_values')
      }
    })
  }

  // =====================================================================
  // M-07 meta → config_values(scope='device') + plugin_data('builtin.tavern')
  //     敏感键**不落库**
  // =====================================================================
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.meta)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/meta[${index}]`, 'unsupported-shape', 'meta 记录不是对象，已跳过。')
        return
      }
      const key = str(record, 'key') ?? legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'meta', legacyId: key, qualifier: null }
      const sensitive = SENSITIVE_META_KEYS.has(key) || isSensitiveField(key)
      if (sensitive) {
        unmappedFields.push({
          location: locationOf(ref),
          entityKind: 'config_value',
          entityId: key,
          field: key,
          disposition: 'raw_payload',
          value: '[redacted]',
        })
        warn(locationOf(ref), 'redacted-sensitive', `meta 键「${key}」命中敏感字段清单，未写入新库（新版应走 secureStore + secretRef）。`)
        return
      }
      if (key === 'tavern' || key.startsWith('tavern.')) {
        const derived: LegacyOriginRef = { ...ref, qualifier: 'plugin' }
        rows.push({
          table: 'plugin_data',
          id: legacyDerivedId('cfg', derived, 'plugin'),
          workspaceId,
          pluginId: LEGACY_PLUGIN_ID.tavern,
          key,
          value: record['value'] ?? null,
          origin: derived,
        })
        return
      }
      pushConfigValue(ref, 'device', DEVICE_OWNER_ID, `legacy.meta.${key}`, record['value'] ?? null, 'meta')
    })
  }

  // =====================================================================
  // M-09 快照 → revisions（seq 由旧快照自身顺序推导，**绝不用 COUNT(*)**）
  // =====================================================================
  interface PendingSnapshot {
    readonly ref: LegacyOriginRef
    readonly targetLegacyId: string
    /** 目标文档的新 ID —— 在收集时就解析好，避免二轮查表。 */
    readonly targetDocumentId: string
    readonly createdAt: string
    readonly body: string
  }
  const pendingSnapshots: PendingSnapshot[] = []
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.snapshots)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/main/snapshots[${index}]`, 'unsupported-shape', '快照记录不是对象，已跳过。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'snapshots', legacyId, qualifier: null }
      const target = str(record, 'chapterId') ?? str(record, 'documentId') ?? str(record, 'entityId')
      const targetDocumentId = target === null ? null : documentIdForLegacy(target)
      if (target === null || targetDocumentId === null) {
        warn(locationOf(ref), 'unsupported-shape', '快照未指向本次导入中的章节/卷，无法归位，已原样登记而不写入。')
        deferred.push({ location: locationOf(ref), reason: '快照目标不在导入范围内' })
        return
      }
      const nested = asRecord(record['data']) ?? {}
      const body = normalizeBody(str(record, 'content') ?? str(record, 'body') ?? str(nested, 'content') ?? '')
      pendingSnapshots.push({
        ref,
        targetLegacyId: target,
        targetDocumentId,
        createdAt: isoOr(str(record, 'createdAt'), now),
        body,
      })
    })
  }
  const snapshotsByTarget = new Map<string, PendingSnapshot[]>()
  for (const snapshot of pendingSnapshots) {
    const list = snapshotsByTarget.get(snapshot.targetDocumentId)
    if (list === undefined) snapshotsByTarget.set(snapshot.targetDocumentId, [snapshot])
    else list.push(snapshot)
  }
  for (const [entityId, list] of snapshotsByTarget) {
    const sorted = [...list].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.ref.legacyId < b.ref.legacyId
          ? -1
          : a.ref.legacyId > b.ref.legacyId
            ? 1
            : 0
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    )
    sorted.forEach((snapshot, index) => {
      // 首版 revision 占了 seq = 1；历史快照从 2 起。用**排序后的数组下标**而不是
      // COUNT(*)：COUNT(*) 在重跑或部分失败后会给出不同的 seq，
      // 直接撞上 UNIQUE(entity_type, entity_id, seq)——这正是 DDL 注释禁止的用法。
      const seq = index + 2
      revisionRows.push({
        table: 'revision',
        id: legacyDerivedId('rev', snapshot.ref, `snapshot-${seq}`),
        workspaceId,
        entityType: 'document',
        entityId,
        seq,
        revision: encodeRevision(seq),
        bodySnapshot: snapshot.body,
        valuesSnapshot: JSON.stringify({
          kind: 'snapshot',
          snapshotId: snapshot.ref.legacyId,
          source: snapshot.ref.sourceId,
        }),
        createdAt: snapshot.createdAt,
        origin: { ...snapshot.ref, qualifier: `snapshot-${seq}` },
      })
    })
  }
  rows.push(...revisionRows)

  // =====================================================================
  // M-10 回收站 → documents.deleted = 1 + 旁存时间
  // =====================================================================
  const deletedDocumentIds = new Set<string>()
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.trash)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      const legacyId =
        record === null ? `#${index}` : (str(record, 'id') ?? str(record, 'entityId') ?? legacyKeyOf(record, store.keyField, `#${index}`))
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: 'trash', legacyId, qualifier: null }
      const documentId = documentIdForLegacy(legacyId)
      if (documentId === null) {
        warn(locationOf(ref), 'unsupported-shape', '回收站条目未指向本次导入中的文档，已原样登记而不改动任何行。')
        deferred.push({ location: locationOf(ref), reason: '回收站目标不在导入范围内' })
        return
      }
      deletedDocumentIds.add(documentId)
      const deletedAt = record === null ? null : (str(record, 'deletedAt') ?? str(record, 'createdAt'))
      pushConfigValue(ref, 'project', documentId, `${LEGACY_CONFIG_KEY.trash}.${legacyId}`, deletedAt ?? true, 'trash')
    })
  }

  // =====================================================================
  // M-16 / M-19 知识库 → documents(kind='note')（bodies 是不可再生的用户正文）
  // =====================================================================
  const kbBodyByDocId = new Map<string, string>()
  for (const { source, store } of storeData(LEGACY_KB_STORE.bodies)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/kb/bodies[${index}]`, 'unsupported-shape', '知识库正文不是对象，已跳过。')
        return
      }
      const docId = str(record, 'docId') ?? str(record, 'id') ?? legacyKeyOf(record, store.keyField, `#${index}`)
      const body = str(record, 'content') ?? str(record, 'body') ?? str(record, 'text')
      if (body !== null) kbBodyByDocId.set(docId, body)
    })
  }
  for (const { source, store } of storeData(LEGACY_KB_STORE.docs)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/kb/docs[${index}]`, 'unsupported-shape', '知识库文档不是对象，已跳过。')
        return
      }
      const legacyId = legacyKeyOf(record, store.keyField, `#${index}`)
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'kb', store: 'docs', legacyId, qualifier: null }
      const documentId = assignId(registry, 'document', 'doc', ref, legacyId)
      const rawBody = kbBodyByDocId.get(legacyId) ?? str(record, 'content') ?? ''
      const report = normalizeBodyReport(rawBody)
      const legacyProjectId = str(record, 'projectId')
      const projectId = legacyProjectId === null ? '' : (projectIdByLegacy.get(legacyProjectId) ?? '')
      const { unknownValues } = splitUnknown(record, ['id', 'title', 'content', 'body', 'projectId', 'createdAt', 'updatedAt', 'tags'])
      documentIdByLegacy.set(legacyId, { projectId, kind: 'note' })
      rows.push({
        table: 'document',
        id: documentId,
        workspaceId,
        projectId,
        kind: 'note',
        parentId: null,
        orderKey: spreadOrderKeys(index + 1)[index] ?? 'A',
        title: str(record, 'title') ?? '',
        body: report.text,
        deleted: 0,
        createdAt: isoOr(str(record, 'createdAt'), now),
        updatedAt: isoOr(str(record, 'updatedAt'), now),
        charCount: countChars(report.text),
        origin: ref,
      })
      if (kbBodyByDocId.has(legacyId)) {
        // 正文缺失 = 不可再生内容丢失，必须点名。
      } else {
        warn(locationOf(ref), 'unsupported-shape', '知识库文档在 bodies 里没有对应正文，正文按空写入（原文档确实可能无正文，此处仅登记）。')
      }
      if (Object.keys(unknownValues).length > 0) {
        pushConfigValue(ref, 'project', projectId, `legacy.kb.${legacyId}`, unknownValues, 'unknown-fields')
        recordUnknown(ref, 'document', documentId, unknownValues, 'config_values')
      }
    })
  }

  // =====================================================================
  // M-12 / M-13 / M-15 → plugin_data
  // =====================================================================
  const pluginStores: readonly { readonly store: string; readonly pluginId: string }[] = [
    { store: LEGACY_MAIN_STORE.worlds, pluginId: LEGACY_PLUGIN_ID.worldPack },
    { store: LEGACY_MAIN_STORE.tavernReports, pluginId: LEGACY_PLUGIN_ID.tavern },
    { store: LEGACY_MAIN_STORE.dailyStats, pluginId: LEGACY_PLUGIN_ID.stats },
  ]
  for (const { store: storeName, pluginId } of pluginStores) {
    for (const { source, store } of storeData(storeName)) {
      store.records.forEach((raw, index) => {
        const record = asRecord(raw)
        const key =
          record === null
            ? `#${index}`
            : (str(record, 'id') ?? str(record, 'key') ?? legacyKeyOf(record, store.keyField, `#${index}`))
        const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'main', store: storeName, legacyId: key, qualifier: null }
        rows.push({
          table: 'plugin_data',
          id: legacyDerivedId('cfg', ref, 'plugin'),
          workspaceId,
          pluginId,
          key,
          value: record === null ? rawPayloadOf(raw) : record,
          origin: ref,
        })
      })
    }
  }

  // =====================================================================
  // M-22 localStorage → config_values(scope='device')
  // =====================================================================
  for (const { source, store } of storeData(LEGACY_LOCAL_STORAGE_STORE)) {
    store.records.forEach((raw, index) => {
      const record = asRecord(raw)
      if (record === null) {
        warn(`${source.sourceId}/localstorage[${index}]`, 'unsupported-shape', 'localStorage 条目不是对象，已跳过。')
        return
      }
      const key = str(record, 'key') ?? `#${index}`
      const ref: LegacyOriginRef = { sourceId: source.sourceId, database: 'localstorage', store: 'localStorage', legacyId: key, qualifier: null }
      const rawValue = record['value']
      if (isSensitiveField(key)) {
        unmappedFields.push({
          location: locationOf(ref),
          entityKind: 'config_value',
          entityId: key,
          field: key,
          disposition: 'raw_payload',
          value: '[redacted]',
        })
        warn(locationOf(ref), 'redacted-sensitive', `localStorage 键「${key}」命中敏感字段清单，未写入新库。`)
        return
      }
      let parsed: unknown = rawValue
      if (typeof rawValue === 'string' && rawValue !== '') {
        try {
          parsed = JSON.parse(rawValue)
        } catch {
          parsed = rawValue
        }
      }
      // R-07：墓碑读不出来会让已删作品"复活"，因此 `yfe-sync-tombstones` 单独落键、永不丢弃。
      const configKey =
        key === 'yfe-sync-tombstones'
          ? LEGACY_CONFIG_KEY.syncTombstones
          : `${LEGACY_CONFIG_KEY.localStorage}.${key}`
      pushConfigValue(ref, 'device', DEVICE_OWNER_ID, configKey, parsed, 'localstorage')
    })
  }

  // =====================================================================
  // 只登记不导入的来源（迁移矩阵 M-11 / M-17 / M-21）
  // =====================================================================
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.backups)) {
    deferred.push({ location: `${source.sourceId}/main/backups`, reason: `备份元数据只进报告（${store.records.length} 条）` })
  }
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.backupPayloads)) {
    deferred.push({ location: `${source.sourceId}/main/backupPayloads`, reason: `备份载荷只进报告（${store.records.length} 条）` })
  }
  // M-14 运行记录：迁移矩阵要求映射到 `jobs` + `job_outputs`（旧 4 状态 → 新 9 状态，
  // `aborted → cancelled`）。🔴 本包**尚未实现**该映射，但绝不能因此让它悄悄消失：
  // 逐条登记进 deferred，并在警告里点名，这样报告里数得出来「有多少运行记录没被接管」。
  for (const { source, store } of storeData(LEGACY_MAIN_STORE.aiRuns)) {
    const location = `${source.sourceId}/main/aiRuns`
    deferred.push({
      location,
      reason: `运行记录按迁移矩阵 M-14 应落 jobs + job_outputs（旧 4 状态 → 新 9 状态），本包未实现该映射；已原样登记 ${store.records.length} 条，不丢弃。`,
    })
    if (store.records.length > 0) {
      warnings.push({
        location,
        kind: 'not-implemented',
        message: `aiRuns 的 ${store.records.length} 条运行记录未迁移到 jobs/job_outputs（M-14 未实现）；它们仍在旧库里，未被删除。`,
      })
    }
  }
  for (const source of collection.sources) {
    for (const store of source.stores) {
      if (store.name === LEGACY_VEC_STORE.embeddings && store.status === 'ok') {
        deferred.push({
          location: `${source.sourceId}/vec/embeddings`,
          reason: `向量可由正文重建，按迁移矩阵 M-17 不迁移（${store.rows ?? 0} 条）`,
        })
      }
      if (source.kind === 'sync-file') {
        deferred.push({
          location: `${source.sourceId}`,
          reason: '`.yfe` 同步文件按迁移矩阵 M-21 只识别不导入：同步不是备份，导入它等于把「另一台设备的状态」当成本机真相。',
        })
      }
    }
  }

  // ---- M-05 派生引用关系：值里出现本次导入已知的旧 ID → relations(kind='reference') ----
  // 迁移矩阵 M-05 要求为设定行额外派生 `relations`（kind='reference'）。
  // 本包用「值恰好等于某个已知旧 ID」来判定引用：这是可复现的、不需要旧版列名清单的判据，
  // 代价是可能多认几条（误报），因此每条都带 `legacyField` / `legacyValue` 便于人工核对。
  for (const entity of pendingEntities) {
    const fromId = entity.entityId
    for (const [field, value] of Object.entries(entity.values)) {
      if (typeof value !== 'string' || value === '') continue
      const target = documentIdForLegacy(value) ?? settingsEntityIdByLegacy.get(value) ?? projectIdByLegacy.get(value) ?? null
      if (target === null || target === fromId) continue
      const relationRef: LegacyOriginRef = { ...entity.ref, qualifier: `ref:${field}` }
      rows.push({
        table: 'relation',
        id: legacyDerivedId('rel', relationRef, `ref:${field}`),
        workspaceId,
        projectId: entity.projectId ?? '',
        kind: 'reference',
        fromEntityId: fromId,
        toEntityId: target,
        label: field,
        values: { legacyField: field, legacyValue: value },
        origin: relationRef,
      })
    }
  }

  // ---- 孤儿归属：给「所属作品不在本次导入范围内」的行一个落点 ----
  //
  // 🔴 为什么不直接丢掉这些行：`documents` 的 `project_id` 有外键、`settings_entities`
  //    同理，写 `''` 会撞外键让整次导入回滚——那才是真的丢数据。这里显式建一个
  //    「（旧版未归类）」作品把它们接住，正文一条不丢，同时用 warning 点名。
  const hasOrphans = rows.some(
    (row) =>
      (row.table === 'document' || row.table === 'settings_entity' || row.table === 'relation') && row.projectId === '',
  )
  let fallbackProjectId: string | null = null
  if (hasOrphans) {
    const fallbackRef: LegacyOriginRef = {
      sourceId: workspaceRef.sourceId,
      database: 'import',
      store: 'project',
      legacyId: 'unassigned',
      qualifier: null,
    }
    fallbackProjectId = assignId(registry, 'project', 'prj', fallbackRef, null)
    rows.push({
      table: 'project',
      id: fallbackProjectId,
      workspaceId,
      name: '（旧版未归类）',
      summary: '导入时未能归入任何旧作品的章节与设定，原样保留以便人工归位。',
      projectType: 'full',
      createdAt: now,
      updatedAt: now,
      origin: fallbackRef,
    })
    warnings.push({
      location: `${workspaceRef.sourceId}/import/project/unassigned`,
      kind: 'unknown-project',
      message: '存在未归入任何旧作品的章节/设定，已挂到自动创建的「（旧版未归类）」作品下，正文未丢弃。',
    })
  }

  // ---- 收尾：孤儿挂载 + 回收站标记（post-pass，只改自己规划出来的行） ----
  const finalRows: PlannedRow[] = rows.map((row) => {
    let next: PlannedRow = row
    if (
      fallbackProjectId !== null &&
      (row.table === 'document' || row.table === 'settings_entity' || row.table === 'relation') &&
      row.projectId === ''
    ) {
      next = { ...row, projectId: fallbackProjectId }
    }
    if (fallbackProjectId !== null && next.table === 'config_value' && next.scope === 'project' && next.ownerId === '') {
      next = { ...next, ownerId: fallbackProjectId }
    }
    if (next.table === 'document' && deletedDocumentIds.has(next.id)) {
      next = { ...next, deleted: 1 }
    }
    return next
  })

  // 撞车的旧 ID 逐条点名：不是「悄悄换个 ID 就算了」，而是让报告里数得出来。
  for (const collision of registry.collisions) {
    warnings.push({
      location: `${workspaceRef.sourceId}/import/${collision.table}`,
      kind: 'duplicate-key',
      message: `旧 ID「${collision.preferred}」在目标表 ${collision.table} 内被两个实体占用，后一个改用派生 ID「${collision.derived}」；两行都会写入，数据不丢。`,
    })
  }

  const plannedByTable: Record<string, number> = {}
  for (const row of finalRows) {
    plannedByTable[row.table] = (plannedByTable[row.table] ?? 0) + 1
  }

  notes.push(
    `ID 映射算法 ${'legacy-id-sha256-v1'}：同一旧实体在任意次导入中都会得到同一个新 ID（详见 idMapping）。`,
  )
  notes.push('未知字段一律旁存到 config_values（scope=project/device）或原样保留在 values_json，并在 unmappedFields 中逐条登记。')
  notes.push(
    `人物卡子项落法（迁移矩阵 M-06 二选一，本包已选定）：${
      charSubItemMode === 'suffixed-store'
        ? 'schema_template_id = `<tabId>-sub`，保留子项与主卡的区分（char-main / char-main-sub）。'
        : 'schema_template_id = `<tabId>`，父子关系写进 values.parentId。'
    }`,
  )
  notes.push(
    '世界包（旧 `worlds`）落到 plugin_data(plugin_id=\'builtin.world-pack\')，不进 settings_entities：后者 project_id 非空，会把可跨作品复用的世界包绑死在一个作品上。',
  )
  if (deletedDocumentIds.size > 0) {
    notes.push(`回收站条目把 ${deletedDocumentIds.size} 篇文档标记为已删（documents.deleted = 1）。`)
  }
  for (const entry of deferred) {
    notes.push(`未导入：${entry.location} —— ${entry.reason}`)
  }

  return {
    workspaceId,
    rows: finalRows,
    unmappedFields,
    warnings,
    refusals: collection.refusals,
    collisions: registry.collisions,
    idMapping: registry.entries,
    idStats: summarizeIds(registry.entries, registry.collisions),
    deferred,
    notes: [...new Set([...collection.notes, ...notes])],
    plannedByTable: plannedByTable as Record<LegacyEntityKind, number>,
  }
}

function refusalWarning(refusal: LegacyRefusal): ImportWarning {
  return { location: refusal.location, kind: 'unsupported-shape', message: `【拒绝读作空】${refusal.message}` }
}

/** 原样保留一份旧记录（用于无法归位的载荷），但保证 JSON 可序列化。 */
function rawPayloadOf(value: unknown): unknown {
  return jsonSafe(value)
}
