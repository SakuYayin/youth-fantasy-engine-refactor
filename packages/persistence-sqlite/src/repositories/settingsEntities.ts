/**
 * `settings_entities` —— 动态 Schema 设定实体的持久化读写（P1-A3 Repository 层）。
 *
 * 设计依据：
 * - `06-数据与本地存储.md`：「设定实体字段由 `schema_template_id` 指向的模板定义，
 *   值以 JSON 存 `values_json`；**数据库不为此建列**——否则用户每加一个字段都要迁移表结构」。
 * - `packages/persistence-sqlite/src/schema/ddl.ts:277`：`values_json` 上有
 *   `CHECK (json_valid(values_json))`；本层在此基础上再保证"是 JSON **对象**"。
 *
 * 🔴 五条不可动摇的约束：
 * 1. **`values` 只以 JSON 文本落库**，不为任何用户自定义字段建列、不建动态表。
 * 2. **写库前必须校验**：非对象、循环引用、不可序列化一律 `VALIDATION_FAILED`
 *    ——让 JS 层的错误在写库**之前**失败，而不是等 `json_valid()` 在 SQLite 里报错。
 * 3. **读库时 JSON 损坏是 `STORAGE_CORRUPT`（critical）**，不是"当成空对象"：
 *    静默降级会让用户看到空设定面板，然后在上面继续编辑、把真实数据覆盖掉。
 * 4. **workspace 隔离 + 软删默认隐藏**，与 `documents` 完全一致。
 * 5. **新建 `revision = encodeRevision(1)` 且 `revision_seq = 1` 一起写**。
 *
 * ⚠️ 排序作用域说明：`order_key` 的排序兄弟是「**同一作品的全部设定实体**」，
 *    与 DDL 声明的索引 `idx_settings_entities_order (project_id, order_key)` 一致。
 *    同一模板列表内部的相对顺序因此仍然正确；若将来要按模板独立编号，
 *    需要改成 `(project_id, schema_template_id, order_key)` 索引，属 Schema 变更（见交付报告）。
 */

import {
  errOf,
  isWellFormedId,
  newIds,
  ok,
  type Err,
  type ProjectId,
  type ReadContext,
  type RequestId,
  type Result,
  type Revision,
  type SettingsEntity,
  type WriteContext,
} from '@yfe/contracts'

import type { SqliteDatabase } from '../schema/index.js'
import {
  INITIAL_REVISION_SEQ,
  MAX_ENTITY_NAME_LENGTH,
  checkContextProject,
  loadOwnership,
  nextRevision,
  orderKeyForPlacement,
  parseValues,
  runRead,
  runWrite,
  stringifyValues,
  type Placement,
  type RepositoryDeps,
} from './internal.js'

/**
 * 设定实体的插入 / 重排位置。
 *
 * ⚠️ 契约里没有设定实体的命令类型（`commands/` 只定义了 Project/Document），
 *    因此这里自己定形状（与文档的 placement 同形），见交付报告的契约缺口。
 */
export type SettingsPlacement = Placement

// ---------------------------------------------------------------------------
// 入参 / 行映射
// ---------------------------------------------------------------------------

export interface SettingsEntityCreateInput {
  readonly context: WriteContext
  readonly projectId: ProjectId
  /** 模板 ID：决定 `values` 里有哪些字段。旧版页签 ID（如 `worldbase`）原样保留。 */
  readonly schemaTemplateId: string
  readonly name: string
  readonly values?: Readonly<Record<string, unknown>>
  /** 默认 `{ mode: 'end' }`（排到该作品设定列表末尾）。 */
  readonly placement?: SettingsPlacement
  /**
   * 显式指定主键（可省略，省略时本层生成）。
   *
   * 存在的理由不是"方便"：`docs/旧功能迁移矩阵.md`（M-04/M-05/M-06）要求导入旧数据时
   * **保留旧 ID 原样**（`id → settings_entities.id`），否则旧库里的引用会全部断链。
   * 也用于人物卡（`CharacterId` 是 `chr_` 前缀，不能借用 `worldSetting` 的 `wld_` 前缀）。
   * 重复 ID 由主键约束拦下，翻译为 `ALREADY_EXISTS`（见 `schema/open.ts:319`）。
   */
  readonly entityId?: string
}

export interface SettingsEntityListInput {
  readonly context: ReadContext
  readonly projectId: ProjectId
  /** 只要某一个模板的实体。与 `schemaTemplateIds` 同时给出时后者优先。 */
  readonly schemaTemplateId?: string
  /** 要多个模板的实体（如人物卡的三种卡面）。 */
  readonly schemaTemplateIds?: readonly string[]
  readonly includeDeleted?: boolean
}

/** 局部更新：只改给出的字段；`values` 是**整体替换**（不是深合并）。 */
export interface SettingsEntityPatch {
  readonly name?: string
  readonly values?: Readonly<Record<string, unknown>>
}

interface SettingsEntityRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly schema_template_id: string
  readonly name: string
  readonly values_json: string
  readonly order_key: string
  readonly revision: string
  readonly revision_seq: number
  readonly deleted: number
  readonly created_at: string
  readonly updated_at: string
}

const SETTINGS_ENTITY_COLUMNS =
  'id, workspace_id, project_id, schema_template_id, name, values_json, order_key, revision, revision_seq, deleted, created_at, updated_at'

function toSettingsEntity(
  row: SettingsEntityRow,
  values: Readonly<Record<string, unknown>>,
): SettingsEntity {
  return {
    id: row.id,
    workspaceId: row.workspace_id as SettingsEntity['workspaceId'],
    projectId: row.project_id as ProjectId,
    schemaTemplateId: row.schema_template_id,
    name: row.name,
    values,
    orderKey: row.order_key,
    revision: row.revision as Revision,
    deleted: row.deleted,
    createdAt: row.created_at as SettingsEntity['createdAt'],
    updatedAt: row.updated_at as SettingsEntity['updatedAt'],
  }
}

/**
 * 局部更新是**整体替换** `values_json`，不做深合并。
 *
 * 理由：读-改-写会丢掉并发窗口里别人的字段改动，还会让"未给出的字段"与
 * "显式设为 undefined"无法区分。深合并属于领域逻辑，不属于持久化层。
 */

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function validateReadContext(context: ReadContext): Err | null {
  if (!isWellFormedId(context.workspaceId)) {
    return errOf('VALIDATION_MALFORMED_ID', '工作区 ID 格式不合法', context.requestId, {
      field: 'workspaceId',
    })
  }
  return null
}

function validateWriteContext(context: WriteContext): Err | null {
  const readErr = validateReadContext(context)
  if (readErr !== null) return readErr
  if (context.expectedRevision !== null && typeof context.expectedRevision !== 'string') {
    return errOf('VALIDATION_FAILED', 'expectedRevision 必须是字符串或 null', context.requestId, {
      field: 'expectedRevision',
    })
  }
  return null
}

function validateEntityName(name: unknown, requestId: RequestId): Result<string> {
  if (typeof name !== 'string') {
    return errOf('VALIDATION_MISSING_FIELD', '设定名称必须是字符串', requestId, { field: 'name' })
  }
  if (name.length > MAX_ENTITY_NAME_LENGTH) {
    return errOf(
      'VALIDATION_OUT_OF_RANGE',
      `设定名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`,
      requestId,
      { field: 'name' },
    )
  }
  return ok(name)
}

function validateTemplateId(value: unknown, requestId: RequestId): Result<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', '模板 ID 不能为空', requestId, {
      field: 'schemaTemplateId',
    })
  }
  if (value.length > 128) {
    return errOf('VALIDATION_OUT_OF_RANGE', '模板 ID 不能超过 128 个字符', requestId, {
      field: 'schemaTemplateId',
    })
  }
  return ok(value)
}

function loadAliveProject(
  db: SqliteDatabase,
  workspaceId: string,
  projectId: string,
  requestId: RequestId,
): Err | null {
  const ownership = loadOwnership(db, 'projects', projectId, workspaceId, requestId, {
    code: 'NOT_FOUND_PROJECT',
    message: '作品不存在',
  })
  if (!ownership.ok) return ownership
  if (ownership.value.deleted !== 0) {
    return errOf('NOT_FOUND_PROJECT', '作品已删除，不能再写入其设定', requestId, { entityId: projectId })
  }
  return null
}

function loadSettingsRow(
  db: SqliteDatabase,
  context: WriteContext,
  entityId: string,
  requestId: RequestId,
): Result<SettingsEntityRow> {
  const ownership = loadOwnership(db, 'settings_entities', entityId, context.workspaceId, requestId, {
    code: 'NOT_FOUND',
    message: '设定实体不存在',
  })
  if (!ownership.ok) return ownership
  if (ownership.value.deleted !== 0) {
    return errOf('NOT_FOUND', '设定实体已删除', requestId, { entityId })
  }
  const projectErr = checkContextProject(context, ownership.value.project_id ?? null, requestId)
  if (projectErr !== null) return projectErr
  const row = db
    .prepare(`SELECT ${SETTINGS_ENTITY_COLUMNS} FROM settings_entities WHERE id = ? AND workspace_id = ?`)
    .get(entityId, context.workspaceId) as SettingsEntityRow | undefined
  if (row === undefined) {
    return errOf('NOT_FOUND', '设定实体不存在', requestId, { entityId })
  }
  return ok(row)
}

/** 同一作品下全部设定实体的排序（与 `idx_settings_entities_order` 一致）。 */
const SETTINGS_SIBLING_SQL = 'workspace_id = ? AND project_id = ?'

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 新建设定实体。`values` 缺省为 `{}`（DDL 默认值也是这样）。 */
export function createSettingsEntity(
  db: SqliteDatabase,
  input: SettingsEntityCreateInput,
  deps: RepositoryDeps,
): Result<{ readonly entityId: string; readonly revision: Revision; readonly orderKey: string }> {
  const { context, projectId, schemaTemplateId } = input
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  if (!isWellFormedId(projectId)) {
    return errOf('VALIDATION_MALFORMED_ID', '作品 ID 格式不合法', requestId, { field: 'projectId' })
  }
  const templateResult = validateTemplateId(schemaTemplateId, requestId)
  if (!templateResult.ok) return templateResult
  const nameResult = validateEntityName(input.name, requestId)
  if (!nameResult.ok) return nameResult
  if (context.projectId !== null && context.projectId !== projectId) {
    return errOf('PERMISSION_WORKSPACE_MISMATCH', '入参 projectId 与 context 声明的作品不一致', requestId, {
      field: 'projectId',
    })
  }
  if (context.expectedRevision !== null) {
    return errOf('VALIDATION_FAILED', '新建设定实体时 expectedRevision 必须为 null', requestId, {
      field: 'expectedRevision',
    })
  }
  if (input.entityId !== undefined && !isWellFormedId(input.entityId)) {
    return errOf('VALIDATION_MALFORMED_ID', '设定实体 ID 格式不合法', requestId, { field: 'entityId' })
  }
  const valuesJsonResult = stringifyValues(input.values ?? {}, requestId, 'values')
  if (!valuesJsonResult.ok) return valuesJsonResult
  const placement: SettingsPlacement = input.placement ?? { mode: 'end' }

  return runWrite(
    db,
    requestId,
    '新建设定实体失败',
    (): Result<{ entityId: string; revision: Revision; orderKey: string }> => {
      const projectErr = loadAliveProject(db, context.workspaceId, projectId, requestId)
      if (projectErr !== null) return projectErr

      const orderKeyResult = orderKeyForPlacement(
        db,
        {
          table: 'settings_entities',
          siblingSql: SETTINGS_SIBLING_SQL,
          siblingArgs: [context.workspaceId, projectId],
          notFound: { code: 'NOT_FOUND', message: '排序锚点不存在或已被删除' },
          requestId,
          excludeId: null,
        },
        placement,
      )
      if (!orderKeyResult.ok) return orderKeyResult

      const entityId = input.entityId ?? newIds.worldSetting(deps.rng)
      const revision = nextRevision(deps, INITIAL_REVISION_SEQ, requestId)
      const now = deps.clock.now()
      db.prepare(
        `INSERT INTO settings_entities
           (id, workspace_id, project_id, schema_template_id, name, values_json, order_key,
            revision, revision_seq, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${INITIAL_REVISION_SEQ}, 0, ?, ?)`,
      ).run(
        entityId,
        context.workspaceId,
        projectId,
        templateResult.value,
        nameResult.value,
        valuesJsonResult.value,
        orderKeyResult.value,
        revision,
        now,
        now,
      )
      return ok({ entityId, revision, orderKey: orderKeyResult.value })
    },
  )
}

/** 读取单个设定实体。默认不含已软删，要读已删的传 `{ includeDeleted: true }`。 */
export function getSettingsEntity(
  db: SqliteDatabase,
  context: ReadContext,
  entityId: string,
  options?: { readonly includeDeleted?: boolean },
): Result<SettingsEntity> {
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  if (!isWellFormedId(entityId)) {
    return errOf('VALIDATION_MALFORMED_ID', '设定实体 ID 格式不合法', requestId, { field: 'entityId' })
  }

  return runRead(requestId, '读取设定实体失败', () => {
    const ownership = loadOwnership(db, 'settings_entities', entityId, context.workspaceId, requestId, {
      code: 'NOT_FOUND',
      message: '设定实体不存在',
    })
    if (!ownership.ok) return ownership
    if (ownership.value.deleted !== 0 && options?.includeDeleted !== true) {
      return errOf('NOT_FOUND', '设定实体已删除', requestId, { entityId })
    }
    const row = db
      .prepare(
        `SELECT ${SETTINGS_ENTITY_COLUMNS} FROM settings_entities WHERE id = ? AND workspace_id = ?`,
      )
      .get(entityId, context.workspaceId) as SettingsEntityRow | undefined
    if (row === undefined) {
      return errOf('NOT_FOUND', '设定实体不存在', requestId, { entityId })
    }
    const valuesResult = parseValues(row.values_json, requestId, row.id)
    if (!valuesResult.ok) return valuesResult
    return ok(toSettingsEntity(row, valuesResult.value))
  })
}

/**
 * 列出作品下的设定实体（按 `order_key, id` 排序）。
 *
 * 默认只返回未删；`includeDeleted: true` 时含已删（`deleted` 字段可区分）。
 * 按模板过滤可传 `schemaTemplateId` 或 `schemaTemplateIds`（后者优先，一次 `IN (...)` 查询）。
 */
export function listSettingsEntities(
  db: SqliteDatabase,
  input: SettingsEntityListInput,
): Result<readonly SettingsEntity[]> {
  const { context, projectId } = input
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  if (!isWellFormedId(projectId)) {
    return errOf('VALIDATION_MALFORMED_ID', '作品 ID 格式不合法', requestId, { field: 'projectId' })
  }
  const templateIds: readonly string[] =
    input.schemaTemplateIds ?? (input.schemaTemplateId === undefined ? [] : [input.schemaTemplateId])
  if (templateIds.length === 0 && input.schemaTemplateIds !== undefined) {
    // 显式传了空数组 = "不要任何模板"：`IN ()` 在 SQLite 里是语法错误，直接返回空。
    return ok([])
  }
  const includeDeleted = input.includeDeleted === true

  return runRead(requestId, '列出设定实体失败', () => {
    const ownership = loadOwnership(db, 'projects', projectId, context.workspaceId, requestId, {
      code: 'NOT_FOUND_PROJECT',
      message: '作品不存在',
    })
    if (!ownership.ok) return ownership

    const params: string[] = [context.workspaceId, projectId]
    let sql = `SELECT ${SETTINGS_ENTITY_COLUMNS} FROM settings_entities
                WHERE workspace_id = ? AND project_id = ?`
    if (templateIds.length > 0) {
      sql += ` AND schema_template_id IN (${templateIds.map(() => '?').join(', ')})`
      params.push(...templateIds)
    }
    if (!includeDeleted) sql += ' AND deleted = 0'
    sql += ' ORDER BY order_key, id'

    const rows = db.prepare(sql).all(...params) as readonly SettingsEntityRow[]
    const entities: SettingsEntity[] = []
    for (const row of rows) {
      const valuesResult = parseValues(row.values_json, requestId, row.id)
      if (!valuesResult.ok) return valuesResult
      entities.push(toSettingsEntity(row, valuesResult.value))
    }
    return ok(entities)
  })
}

/**
 * 局部更新设定实体（名称 / 整值替换）。
 *
 * `values` 是**整体替换**：契约把 `values` 定义成一个对象，
 * 深合并会掩盖"字段被删除"与"字段未提供"的区别，也会在校验失败时留下半合并状态。
 */
export function updateSettingsEntity(
  db: SqliteDatabase,
  context: WriteContext,
  entityId: string,
  patch: SettingsEntityPatch,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  if (!isWellFormedId(entityId)) {
    return errOf('VALIDATION_MALFORMED_ID', '设定实体 ID 格式不合法', requestId, { field: 'entityId' })
  }
  if (patch.name === undefined && patch.values === undefined) {
    return errOf('VALIDATION_MISSING_FIELD', '没有需要更新的字段', requestId, { field: 'patch' })
  }
  if (patch.name !== undefined) {
    const nameResult = validateEntityName(patch.name, requestId)
    if (!nameResult.ok) return nameResult
  }
  let valuesJson: string | null = null
  if (patch.values !== undefined) {
    const valuesJsonResult = stringifyValues(patch.values, requestId, 'values')
    if (!valuesJsonResult.ok) return valuesJsonResult
    valuesJson = valuesJsonResult.value
  }

  return runWrite(db, requestId, '更新设定实体失败', (): Result<{ revision: Revision }> => {
    const rowResult = loadSettingsRow(db, context, entityId, requestId)
    if (!rowResult.ok) return rowResult
    const row = rowResult.value
    if (context.expectedRevision !== null && context.expectedRevision !== row.revision) {
      return errOf('REVISION_CONFLICT', '设定实体已被其他会话修改，请刷新后重试', requestId, {
        entityId,
        expected: context.expectedRevision,
        actual: row.revision,
      })
    }

    const nextName = patch.name ?? row.name
    const nextValuesJson = valuesJson ?? row.values_json
    if (nextName === row.name && nextValuesJson === row.values_json) {
      return ok({ revision: row.revision as Revision })
    }

    const revision = nextRevision(deps, row.revision_seq + 1, requestId)
    const info = db
      .prepare(
        `UPDATE settings_entities
            SET name = ?, values_json = ?, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
      )
      .run(
        nextName,
        nextValuesJson,
        revision,
        deps.clock.now(),
        entityId,
        context.workspaceId,
        row.revision,
      )
    if (info.changes !== 1) {
      return errOf('REVISION_CONFLICT', '设定实体已被其他会话修改，请刷新后重试', requestId, {
        entityId,
      })
    }
    return ok({ revision })
  })
}

/** 软删设定实体（不级联：设定之间没有父子结构）。 */
export function softDeleteSettingsEntity(
  db: SqliteDatabase,
  context: WriteContext,
  entityId: string,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  if (!isWellFormedId(entityId)) {
    return errOf('VALIDATION_MALFORMED_ID', '设定实体 ID 格式不合法', requestId, { field: 'entityId' })
  }

  return runWrite(db, requestId, '删除设定实体失败', (): Result<{ revision: Revision }> => {
    const rowResult = loadSettingsRow(db, context, entityId, requestId)
    if (!rowResult.ok) return rowResult
    const row = rowResult.value
    if (context.expectedRevision !== null && context.expectedRevision !== row.revision) {
      return errOf('REVISION_CONFLICT', '设定实体已被其他会话修改，请刷新后重试', requestId, {
        entityId,
        expected: context.expectedRevision,
        actual: row.revision,
      })
    }
    const revision = nextRevision(deps, row.revision_seq + 1, requestId)
    const info = db
      .prepare(
        `UPDATE settings_entities
            SET deleted = 1, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted = 0`,
      )
      .run(revision, deps.clock.now(), entityId, context.workspaceId, row.revision)
    if (info.changes !== 1) {
      return errOf('REVISION_CONFLICT', '设定实体已被其他会话修改，请刷新后重试', requestId, {
        entityId,
      })
    }
    return ok({ revision })
  })
}
