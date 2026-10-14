/**
 * 第三步：写入新库（`docs/旧功能迁移矩阵.md` §2.4 第 ③ 步）。
 *
 * 本模块是唯一会写数据库的地方，四条结构性保证：
 *
 * 1. **单事务**。所有写入在一个 `BEGIN IMMEDIATE` 事务里，任何一行失败都整体回滚——
 *    不存在「导了一半」的库（任务语义 6）。
 * 2. **目标库保护**。写之前先过 {@link assertTargetAcceptsImport}：
 *    库版本过新 → `STORAGE_SCHEMA_TOO_NEW`；库没初始化 → `STORAGE_MIGRATION_FAILED`；
 *    库里已有**不属于本次导入工作区**的数据 → 拒绝（`ALREADY_EXISTS`）。
 * 3. **幂等重跑**。每张表都按主键先查后写：主键不存在 → INSERT；存在且内容一致 →
 *    记为「跳过」且**一个字节都不写**；存在但内容不同 → UPDATE。
 *    因此「两次导入同一夹具」的行数不会翻倍，报告也能自洽说出「多少条是重跑命中的」。
 * 4. **dry-run 走同一条代码路径**，只在 `dryRun` 时把写语句整段跳过——
 *    「预演和真跑的报告同构」因此是结构事实，而不是两套代码各自维护的承诺。
 *
 * ⚠️ 为什么不复用 `@yfe/persistence-sqlite` 的 repository：repository 的
 *    `createDocument` 不接受 `body`（写入后还要单独再写一次正文），也不覆盖
 *    `workspaces` / `revisions` / `config_values` / `plugin_data` / `relations`
 *    这五张本任务必须写的表；而迁移又要求保真写入 `deleted`、`created_at`（保留旧时间）
 *    与 `revision_seq`。这里仍然**用契约的错误语义**（`Result` + `ERROR_CODES`），
 *    并且每次写之前都调用契约提供的 `assertSchemaAcceptsWrites`，
 *    所以「绕过 repository」不等于「绕过契约」。
 */

import { errOf, encodeRevision, ok, type Err, type RequestId, type Result } from '@yfe/contracts'
import type { SqliteDatabase } from '@yfe/persistence-sqlite'
import { assertSchemaAcceptsWrites, LATEST_SCHEMA_VERSION, readSchemaVersion } from '@yfe/persistence-sqlite'

import type { ImportPlan, PlannedRow } from './mapping.js'
import { LEGACY_PLUGIN_ID } from './mapping.js'

// ---------------------------------------------------------------------------
// 计数
// ---------------------------------------------------------------------------

/**
 * 一个桶的计数。恒等式（报告自洽的判据）：
 *
 * ```
 * planned === succeeded + skipped + refused
 * succeeded === inserted + updated
 * skipped   === unchanged + dryRun + notImported
 * ```
 *
 * `refused` 只记**条目数**，不记行数：读不出来的 store 连有多少行都不知道，
 * 给它记 0 行正是本任务要消灭的那个错误。因此每个被拒绝的 store 在
 * 「计划数」里占 1 条，在「拒绝数」里占 1 条——它不是空的，它是未知的。
 */
export interface ImportCounts {
  readonly planned: number
  readonly succeeded: number
  readonly skipped: number
  readonly refused: number
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  readonly dryRun: number
  readonly notImported: number
}

export function emptyCounts(): ImportCounts {
  return {
    planned: 0,
    succeeded: 0,
    skipped: 0,
    refused: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    dryRun: 0,
    notImported: 0,
  }
}

export function addCounts(a: ImportCounts, b: ImportCounts): ImportCounts {
  return {
    planned: a.planned + b.planned,
    succeeded: a.succeeded + b.succeeded,
    skipped: a.skipped + b.skipped,
    refused: a.refused + b.refused,
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    unchanged: a.unchanged + b.unchanged,
    dryRun: a.dryRun + b.dryRun,
    notImported: a.notImported + b.notImported,
  }
}

/** 自洽校验：`planned === succeeded + skipped + refused`。 */
export function countsAreConsistent(counts: ImportCounts): boolean {
  return counts.planned === counts.succeeded + counts.skipped + counts.refused
}

export function countsConsistencyErrors(counts: ImportCounts): readonly string[] {
  const errors: string[] = []
  if (counts.planned !== counts.succeeded + counts.skipped + counts.refused) {
    errors.push(
      `planned=${counts.planned} ≠ succeeded=${counts.succeeded} + skipped=${counts.skipped} + refused=${counts.refused}`,
    )
  }
  if (counts.succeeded !== counts.inserted + counts.updated) {
    errors.push(`succeeded=${counts.succeeded} ≠ inserted=${counts.inserted} + updated=${counts.updated}`)
  }
  if (counts.skipped !== counts.unchanged + counts.dryRun + counts.notImported) {
    errors.push(
      `skipped=${counts.skipped} ≠ unchanged=${counts.unchanged} + dryRun=${counts.dryRun} + notImported=${counts.notImported}`,
    )
  }
  return errors
}

// ---------------------------------------------------------------------------
// 写入结果
// ---------------------------------------------------------------------------

/** 计数桶的键。`unreadable_unknown` 收留「连目标类型都推不出来」的读取失败。 */
export type ImportCounterKey = string

export interface WriteOutcome {
  readonly counts: Readonly<Record<ImportCounterKey, ImportCounts>>
  readonly totals: ImportCounts
  /** 每个计数桶里被判定为「内容有变、执行了 UPDATE」的行数。 */
  readonly updatedKeys: readonly string[]
}

export interface WritePlanOptions {
  readonly requestId: RequestId
  /** 预演：不执行任何 INSERT/UPDATE，报告结构与真跑完全一致。 */
  readonly dryRun?: boolean
  /** 允许目标库非空（默认拒绝，除非里面只有本次导入工作区的数据）。 */
  readonly allowNonEmptyTarget?: boolean
  /** 缺省时间戳（`config_values` / `plugin_data` 没有旧时间可用时）。 */
  readonly now?: string
}

// ---------------------------------------------------------------------------
// 目标库保护
// ---------------------------------------------------------------------------

/**
 * 目标库可以接受这次导入吗？
 *
 * 三种拒绝，全部用契约错误码，**没有一种会退化成「那就当空库继续写」**：
 * - 库版本 > `LATEST_SCHEMA_VERSION` → `STORAGE_SCHEMA_TOO_NEW`（`R-12`：过新的库禁止写入）；
 * - 库未初始化（无 `schema_migrations`）→ `STORAGE_MIGRATION_FAILED`（应先 `migrate()`）；
 * - 库里已有其它工作区的数据 → `ALREADY_EXISTS`
 *   （幂等重跑不算「其它工作区」，因为我们自己的 `workspace_id` 是确定性派生的）。
 */
export function assertTargetAcceptsImport(
  db: SqliteDatabase,
  input: { readonly requestId: RequestId; readonly workspaceId: string; readonly allowNonEmptyTarget?: boolean },
): Result<{ readonly schemaVersion: number }> {
  const version = readSchemaVersion(db)
  if (version > LATEST_SCHEMA_VERSION) {
    return errOf(
      'STORAGE_SCHEMA_TOO_NEW',
      `目标库 schema 版本 ${version} 高于本程序支持的 ${LATEST_SCHEMA_VERSION}，拒绝写入。`,
      input.requestId,
      { schemaVersion: version, supported: LATEST_SCHEMA_VERSION },
    )
  }
  if (version < 1) {
    return errOf(
      'STORAGE_MIGRATION_FAILED',
      '目标库尚未初始化（找不到 schema_migrations），请先调用 migrate() 建表再导入。',
      input.requestId,
      { schemaVersion: version },
    )
  }
  if (input.allowNonEmptyTarget === true) return ok({ schemaVersion: version })

  const foreignWorkspaces = count(db, 'SELECT COUNT(*) AS n FROM workspaces WHERE id <> ?', [input.workspaceId])
  const foreignProjects = count(db, 'SELECT COUNT(*) AS n FROM projects WHERE workspace_id <> ?', [input.workspaceId])
  if (foreignWorkspaces > 0 || foreignProjects > 0) {
    return errOf(
      'ALREADY_EXISTS',
      `目标库已存在其它工作区的数据（workspaces ${foreignWorkspaces} 条，projects ${foreignProjects} 条）；导入只允许写入新库或本来源的幂等重跑，如需强行合库请显式传 allowNonEmptyTarget。`,
      input.requestId,
      { foreignWorkspaces, foreignProjects, workspaceId: input.workspaceId },
    )
  }
  return ok({ schemaVersion: version })
}

function count(db: SqliteDatabase, sql: string, params: readonly (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined
  const value = row?.n
  return typeof value === 'number' ? value : 0
}

// ---------------------------------------------------------------------------
// 表规格
// ---------------------------------------------------------------------------

type SqlValue = string | number | null

interface TableSpec {
  readonly table: string
  readonly key: ImportCounterKey
  readonly columns: readonly string[]
  /** `ON CONFLICT(...)` 的目标（唯一约束的列清单）。 */
  readonly conflict: string
  /** 判定「这行是不是已经存在」的列。 */
  readonly keyColumns: readonly string[]
}

const SPECS: readonly TableSpec[] = [
  {
    table: 'workspaces',
    key: 'workspace',
    columns: ['id', 'name', 'schema_version', 'authority_target_id', 'revision', 'revision_seq', 'deleted', 'created_at', 'updated_at'],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'projects',
    key: 'project',
    columns: ['id', 'workspace_id', 'name', 'summary', 'project_type', 'revision', 'revision_seq', 'deleted', 'created_at', 'updated_at'],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'documents',
    key: 'document',
    columns: [
      'id',
      'workspace_id',
      'project_id',
      'kind',
      'parent_id',
      'order_key',
      'title',
      'body',
      'revision',
      'revision_seq',
      'deleted',
      'created_at',
      'updated_at',
    ],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'settings_entities',
    key: 'settings_entity',
    columns: [
      'id',
      'workspace_id',
      'project_id',
      'schema_template_id',
      'name',
      'values_json',
      'order_key',
      'revision',
      'revision_seq',
      'deleted',
      'created_at',
      'updated_at',
    ],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'revisions',
    key: 'revision',
    columns: [
      'id',
      'workspace_id',
      'entity_type',
      'entity_id',
      'revision',
      'seq',
      'base_revision',
      'body_snapshot',
      'values_snapshot',
      'source_op_id',
      'created_at',
    ],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'relations',
    key: 'relation',
    columns: [
      'id',
      'workspace_id',
      'project_id',
      'kind',
      'from_entity_id',
      'to_entity_id',
      'label',
      'values_json',
      'revision',
      'revision_seq',
      'deleted',
      'created_at',
      'updated_at',
    ],
    conflict: 'id',
    keyColumns: ['id'],
  },
  {
    table: 'config_values',
    key: 'config_value',
    columns: [
      'scope',
      'owner_id',
      'key',
      'schema_version',
      'revision',
      'revision_seq',
      'value_json',
      'created_at',
      'updated_at',
    ],
    conflict: 'scope, owner_id, key',
    keyColumns: ['scope', 'owner_id', 'key'],
  },
  {
    table: 'plugin_data',
    key: 'plugin_data',
    columns: ['workspace_id', 'plugin_id', 'key', 'schema_version', 'revision', 'revision_seq', 'value_json', 'created_at', 'updated_at'],
    conflict: 'workspace_id, plugin_id, key',
    keyColumns: ['workspace_id', 'plugin_id', 'key'],
  },
]

/** 按**实体种类**（计划行的 `row.table`）索引，而不是 SQL 表名。 */
const SPEC_BY_KIND = new Map(SPECS.map((spec) => [spec.key, spec]))

/** 插入顺序：父表在前，避免外键在事务中途失败（那会整体回滚，白跑一趟）。 */
const TABLE_ORDER = ['workspace', 'project', 'document', 'settings_entity', 'revision', 'relation', 'config_value', 'plugin_data'] as const

function jsonText(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? 'null' : text
}

/** 把一条计划行摊平成某张表的列值。 */
function valuesFor(spec: TableSpec, row: PlannedRow, now: string): readonly SqlValue[] {
  switch (row.table) {
    case 'workspace':
      return [row.id, row.name, 1, null, encodeRevision(1), 1, 0, row.createdAt, row.updatedAt]
    case 'project':
      return [row.id, row.workspaceId, row.name, row.summary, row.projectType, encodeRevision(1), 1, 0, row.createdAt, row.updatedAt]
    case 'document':
      return [
        row.id,
        row.workspaceId,
        row.projectId,
        row.kind,
        row.parentId,
        row.orderKey,
        row.title,
        row.body,
        encodeRevision(1),
        1,
        row.deleted,
        row.createdAt,
        row.updatedAt,
      ]
    case 'settings_entity':
      return [
        row.id,
        row.workspaceId,
        row.projectId,
        row.schemaTemplateId,
        row.name,
        jsonText(row.values),
        row.orderKey,
        encodeRevision(1),
        1,
        0,
        row.createdAt,
        row.updatedAt,
      ]
    case 'revision':
      return [
        row.id,
        row.workspaceId,
        row.entityType,
        row.entityId,
        row.revision,
        row.seq,
        null,
        row.bodySnapshot,
        row.valuesSnapshot,
        null,
        row.createdAt,
      ]
    case 'relation':
      return [
        row.id,
        row.workspaceId,
        row.projectId,
        row.kind,
        row.fromEntityId,
        row.toEntityId,
        row.label,
        jsonText(row.values),
        encodeRevision(1),
        1,
        0,
        now,
        now,
      ]
    case 'config_value':
      return [row.scope, row.ownerId, row.key, 1, encodeRevision(1), 1, jsonText(row.value), now, now]
    case 'plugin_data':
      return [row.workspaceId, row.pluginId, row.key, 1, encodeRevision(1), 1, jsonText(row.value), now, now]
  }
}

function tableOf(row: PlannedRow): string {
  return row.table
}

// ---------------------------------------------------------------------------
// 写事务
// ---------------------------------------------------------------------------

/**
 * 把一份计划写进目标库（或预演）。
 *
 * 🔴 事务边界就在这个函数里，且**只有一个**：`db.transaction(...).immediate()`。
 *    任何一行抛错（例如卷行缺失导致章节外键失败）都会让 better-sqlite3 回滚整个事务，
 *    调用方拿到 `Err`，库里一行都不留。
 */
export function writeImportPlan(
  db: SqliteDatabase,
  plan: ImportPlan,
  options: WritePlanOptions,
): Result<WriteOutcome> {
  const { requestId } = options
  const now = options.now ?? new Date().toISOString()
  const dryRun = options.dryRun === true

  const guard = assertTargetAcceptsImport(db, {
    requestId,
    workspaceId: plan.workspaceId,
    ...(options.allowNonEmptyTarget === undefined ? {} : { allowNonEmptyTarget: options.allowNonEmptyTarget }),
  })
  if (!guard.ok) return guard

  const counts = new Map<ImportCounterKey, ImportCounts>()
  const updatedKeys: string[] = []
  const bump = (key: ImportCounterKey, mutate: (draft: ImportCounts) => ImportCounts) => {
    counts.set(key, mutate(counts.get(key) ?? emptyCounts()))
  }

  const ordered = [...plan.rows].sort((a, b) => TABLE_ORDER.indexOf(a.table) - TABLE_ORDER.indexOf(b.table))

  const body = (): Map<ImportCounterKey, ImportCounts> => {
      assertSchemaAcceptsWrites(db, { requestId })
      for (const row of ordered) {
        const spec = SPEC_BY_KIND.get(tableOf(row))
        if (spec === undefined) {
          throw new Error(`计划里出现了未知目标表「${tableOf(row)}」`)
        }
        const values = valuesFor(spec, row, now)
        const keyValues = spec.keyColumns.map((column) => {
          const index = spec.columns.indexOf(column)
          return values[index] ?? null
        })
        bump(spec.key, (draft) => ({ ...draft, planned: draft.planned + 1 }))

        const existing = db
          .prepare(
            `SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE ${spec.keyColumns.map((c) => `${c} = ?`).join(' AND ')}`,
          )
          .get(...keyValues) as Record<string, unknown> | undefined

        if (existing === undefined) {
          if (!dryRun) {
            db.prepare(
              `INSERT INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${spec.columns.map(() => '?').join(', ')})`,
            ).run(...values)
          }
          bump(spec.key, (draft) =>
            dryRun
              ? { ...draft, skipped: draft.skipped + 1, dryRun: draft.dryRun + 1 }
              : { ...draft, succeeded: draft.succeeded + 1, inserted: draft.inserted + 1 },
          )
          continue
        }

        const same = spec.columns.every((column, index) => normalise(existing[column]) === normalise(values[index] ?? null))
        if (same) {
          bump(spec.key, (draft) => ({ ...draft, skipped: draft.skipped + 1, unchanged: draft.unchanged + 1 }))
          continue
        }
        if (dryRun) {
          bump(spec.key, (draft) => ({ ...draft, skipped: draft.skipped + 1, dryRun: draft.dryRun + 1 }))
          continue
        }
        db.prepare(
          `UPDATE ${spec.table} SET ${spec.columns.map((c) => `${c} = ?`).join(', ')} WHERE ${spec.keyColumns
            .map((c) => `${c} = ?`)
            .join(' AND ')}`,
        ).run(...values, ...keyValues)
        bump(spec.key, (draft) => ({ ...draft, succeeded: draft.succeeded + 1, updated: draft.updated + 1 }))
        updatedKeys.push(`${spec.table}:${keyValues.join('/')}`)
      }
      return counts
  }

  try {
    // 🔴 预演连写事务都不开：dry-run 的「一行都不写」因此不是靠 `if (dryRun)` 少写几条
    //    语句来保证的，而是它根本不进 `BEGIN IMMEDIATE`——只读打开的库也能预演。
    if (dryRun) body()
    else db.transaction(body).immediate()
  } catch (thrown) {
    return mapWriteThrown(thrown, requestId)
  }

  // 读取失败在报告里各占一个「拒绝条目」——这是「拒绝把读取失败当空」在计数上的落点。
  // 每个被拒绝的 store 记 `planned +1 / refused +1`：我们连它有多少行都没读到，
  // 给它记「0 条」正是本任务要消灭的那个错误，所以它占的是一条**未知**而不是零。
  for (const refusal of plan.refusals) {
    const key = counterKeyForRefusal(refusal.location)
    bump(key, (draft) => ({ ...draft, planned: draft.planned + 1, refused: draft.refused + 1 }))
  }

  const record: Record<string, ImportCounts> = {}
  let totals = emptyCounts()
  for (const [key, value] of counts) {
    record[key] = value
    totals = addCounts(totals, value)
  }
  return ok({ counts: record, totals, updatedKeys })
}

function normalise(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Uint8Array) return `<blob:${value.length}>`
  return JSON.stringify(value)
}

/**
 * 读取失败位置 → 计数桶。用 store 名推目标类型；推不出来时进 `unreadable_unknown`，
 * 而**不是**悄悄塞进某个看起来像 0 条的桶。
 */
export function counterKeyForRefusal(location: string): ImportCounterKey {
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

function mapWriteThrown(thrown: unknown, requestId: RequestId): Err {
  const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  const code = /FOREIGN KEY|constraint failed/i.test(message) ? 'VALIDATION_FAILED' : 'STORAGE_UNAVAILABLE'
  return errOf(code, `导入事务失败并已整体回滚：${message}`, requestId, {
    rolledBack: true,
    pluginHint: LEGACY_PLUGIN_ID.legacyImport,
  })
}
