/**
 * Repository 层内部共享件（**不属于任何实体**）。
 *
 * 🔴 刻意**不在** `./index.js`（barrel）里再导出：这里放的是实现细节
 *    （表名常量、行映射、事务运行器、错误翻译、排序键求解）。
 *    上层要用的东西是各实体模块的公开函数，而不是这些零件。
 *
 * 🔴 分层纪律（与 `src/saveDraft/**` 一致）：
 * - 第一参数恒为数据库句柄，函数**不打开也不关闭**连接（连接由 DB 执行器独占持有）；
 * - 写路径用 `BEGIN IMMEDIATE`（见 {@link runWrite}）：deferred 事务在第一条写语句才升级取锁，
 *   升级失败时已经读过数据，会把「库被别的写连接占用」伪装成事务中途失败；
 * - 事务体内**只有** SQLite 语句与纯计算，不等待网络、不读 `process.env`、不 import Electron/Fastify/DOM；
 * - 业务分支一律用 `@yfe/contracts` 的 `Result` + `ERROR_CODES` 表达，不抛自定义异常、不自造错误码。
 *
 * 🔴 没有模块级「当前作品」单例：`workspaceId` / `projectId` 一律由调用方经
 *    `ReadContext` / `WriteContext` 显式传入，本模块不持有任何可变跨请求状态
 *    （`10-开发规范与环境.md`：ProjectContext 显式传递，不新增可变"当前作品"服务单例）。
 */

import {
  ContractError,
  cryptoRandomSource,
  encodeRevision,
  errOf,
  systemClock,
  toErrorPayload,
  type Clock,
  type DocumentKind,
  type Err,
  type ErrorCode,
  type RandomSource,
  type RequestId,
  type Result,
  type Revision,
  type UtcTimestamp,
  type WriteContext,
} from '@yfe/contracts'
import { isValidOrderKey, orderKeyAfter, orderKeyBetween, type OrderKey } from '@yfe/domain/orderKey'

import { assertSchemaAcceptsWrites, sqliteErrorPayload, type SqliteDatabase } from '../schema/index.js'
import type { RevisionGenerator } from '../saveDraft/index.js'

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

/**
 * 写路径的外部依赖。**必须由调用方显式传入**（与 `saveDraft(db, input, deps)` 同风格），
 * 包内不持有可变全局：时钟、随机源、revision 编码器全部可注入，便于可重复故障测试。
 *
 * 读路径不需要依赖，因此读函数没有 `deps` 参数。
 */
export interface RepositoryDeps {
  readonly clock: Clock
  /** 随机 ID 源。ID 由客户端生成（离线可创建），注入以便测试确定性。 */
  readonly rng: RandomSource
  /**
   * 新 revision 字符串的生成器。
   *
   * ⚠️ 序号**只**来自实体行自己的 `revision_seq + 1`（Lead 架构裁决，见 `docs/契约速查.md`）。
   * 绝不 `SELECT COUNT(*) FROM revisions` 推序号——历史行被 GC 裁剪后序号会倒退，
   * 同一个 revision 字符串被重复使用会静默破坏 outbox 幂等与 baseRevision 校验。
   */
  readonly revisionGenerator: RevisionGenerator
}

/** 默认依赖：系统时钟 + 密码学随机源 + `encodeRevision`。 */
export const defaultRepositoryDeps: RepositoryDeps = {
  clock: systemClock,
  rng: cryptoRandomSource,
  revisionGenerator: { next: encodeRevision },
}

/**
 * 新建实体的初始 `revision_seq`。
 *
 * 🔴 新建实体必须**同时**写 `revision = encodeRevision(1)` 与 `revision_seq = 1`：
 *    只写 revision 而不写序号（或写成 0/NULL），SaveDraft 的乐观锁就拿不到基线，
 *    第一次保存会算错新序号并覆盖别人的修改。
 */
export const INITIAL_REVISION_SEQ = 1

/** 作品名长度上限（本层策略值，契约未规定）。 */
export const MAX_PROJECT_NAME_LENGTH = 200

/** 文档标题长度上限（本层策略值，契约未规定；空标题合法 = 未命名）。 */
export const MAX_DOCUMENT_TITLE_LENGTH = 512

/** 设定实体 / 人物卡名称长度上限。 */
export const MAX_ENTITY_NAME_LENGTH = 200

// ---------------------------------------------------------------------------
// 排序位置（placement）
// ---------------------------------------------------------------------------

/**
 * 插入 / 重排位置。
 *
 * ⚠️ 契约缺口：`commands/index.ts` 里 placement 是**内联联合类型**，没有导出名字，
 *    三处（`DocumentCreateInput` / `DocumentUpdateInput`）各写一遍。本层在此固定一个
 *    结构化等价的名字，只为在 Repository 内部复用。
 */
export type Placement =
  | { readonly mode: 'end' }
  | { readonly mode: 'after'; readonly afterId: string }

// ---------------------------------------------------------------------------
// 事务运行器与错误翻译
// ---------------------------------------------------------------------------

/** 判定异常是否来自 SQLite 驱动（`SqliteError.code` 形如 `SQLITE_CONSTRAINT_UNIQUE`）。 */
export function isSqliteErrorLike(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null) return false
  const code = (thrown as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_')
}

/** 把任意抛出物翻译成契约 `Err`。**只做翻译**，不新增错误码。 */
export function mapThrown(thrown: unknown, requestId: RequestId, fallbackMessage: string): Err {
  if (thrown instanceof ContractError) return { ok: false, error: thrown.toPayload() }
  if (isSqliteErrorLike(thrown)) return { ok: false, error: sqliteErrorPayload(thrown, requestId) }
  return { ok: false, error: toErrorPayload(thrown, requestId, fallbackMessage) }
}

/**
 * 在一个 `BEGIN IMMEDIATE` 写事务里跑 `body`，并把异常翻译成契约错误。
 *
 * - 事务体返回 `Result<T>`：业务失败（如 `REVISION_CONFLICT`）在事务内判定，
 *   返回时事务**正常提交**（没有任何写语句被落下），语义干净；
 * - 事务体抛出：整个事务回滚，异常经 {@link mapThrown} 翻译；
 * - 写入前调用 `assertSchemaAcceptsWrites`（库结构版本高于程序支持版本时必须拒绝写入，
 *   绝不"尽力打开"）；缺了这道闸门，旧程序会拿新结构静默破坏数据。
 */
export function runWrite<T>(
  db: SqliteDatabase,
  requestId: RequestId,
  fallbackMessage: string,
  body: () => Result<T>,
): Result<T> {
  const tx = db.transaction((): Result<T> => body())
  try {
    assertSchemaAcceptsWrites(db, { requestId })
    const result: Result<T> = tx.immediate()
    return result
  } catch (thrown) {
    return mapThrown(thrown, requestId, fallbackMessage)
  }
}

/** 只读路径的异常翻译包装（不开事务：单条 SELECT 在 SQLite 里天然原子）。 */
export function runRead<T>(requestId: RequestId, fallbackMessage: string, body: () => Result<T>): Result<T> {
  try {
    return body()
  } catch (thrown) {
    return mapThrown(thrown, requestId, fallbackMessage)
  }
}

/**
 * 生成新 revision 字符串。
 *
 * 生成器返回空值时抛 `ContractError(INTERNAL_ERROR)` 而不是"先写入再看"：
 * `revision` 有 `NOT NULL` 约束，但空串能过约束——那会让乐观锁永远匹配不上，
 * 属于必须在事务内立刻中止的静默损坏。
 */
export function nextRevision(deps: RepositoryDeps, seq: number, requestId: RequestId): Revision {
  const revision = deps.revisionGenerator.next(seq)
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new ContractError({
      code: 'INTERNAL_ERROR',
      message: 'revision 生成器返回了空值，写入已中止',
      requestId,
    })
  }
  return revision
}

// ---------------------------------------------------------------------------
// 归属校验（workspace 隔离）
// ---------------------------------------------------------------------------

/** 本层会做归属判定的表（内部常量，**绝不来自调用方输入**）。 */
export type ScopedTable = 'projects' | 'documents' | 'settings_entities'

/**
 * 归属探针的固定 SQL。
 *
 * 🔴 每条只取**归属列与删除标志**，绝不取正文/标题/描述等实体数据：
 *    它的唯一职责是把「静默返回空」变成显式的 `PERMISSION_WORKSPACE_MISMATCH`。
 */
const OWNERSHIP_SQL: Readonly<Record<ScopedTable, string>> = {
  projects: `SELECT workspace_id, deleted FROM projects WHERE id = ?`,
  documents: `SELECT workspace_id, deleted, project_id FROM documents WHERE id = ?`,
  settings_entities: `SELECT workspace_id, deleted, project_id FROM settings_entities WHERE id = ?`,
}

/** 归属探针结果。 */
export interface OwnershipRow {
  readonly workspace_id: string
  /** 非 0 即删除（契约 `DeletedFlag` 语义：历史脏值可能是 -1，不能用布尔判断）。 */
  readonly deleted: number
  /** 仅 `documents` / `settings_entities` 有。 */
  readonly project_id?: string
}

/** 找不到实体时的错误码 + 文案。 */
export interface NotFoundSpec {
  readonly code: ErrorCode
  readonly message: string
}

/**
 * 读取实体归属并判定工作区边界。
 *
 * 🔴 跨 workspace 的越界查询**必须报错**，不能静默返回空：
 *    静默返回空会让「ID 拼错」「越权访问」「已被删除」三种完全不同的情况
 *    在调用方看来一模一样，UI 只能显示"没有数据"，用户与开发者都无从判断。
 *
 * @returns `Ok(OwnershipRow)` 或 `Err`（不存在 / 越界）。
 */
export function loadOwnership(
  db: SqliteDatabase,
  table: ScopedTable,
  entityId: string,
  workspaceId: string,
  requestId: RequestId,
  notFound: NotFoundSpec,
): Result<OwnershipRow> {
  const row = db.prepare(OWNERSHIP_SQL[table]).get(entityId) as OwnershipRow | undefined
  if (row === undefined) {
    return errOf(notFound.code, notFound.message, requestId, { entityId })
  }
  if (row.workspace_id !== workspaceId) {
    // 只信库内归属，不信调用方自报。
    return errOf('PERMISSION_WORKSPACE_MISMATCH', '该记录不属于当前工作区', requestId, {
      entityId,
      field: 'workspaceId',
    })
  }
  return { ok: true, value: row }
}

/**
 * `context.projectId` 与库内归属的一致性检查。
 *
 * `WriteContext.projectId === null` 表示宿主未限定作品范围；一旦声明就必须与库内一致
 * （与 `saveDraft` 的判定一致）。
 */
export function checkContextProject(
  context: WriteContext,
  rowProjectId: string | null,
  requestId: RequestId,
): Err | null {
  if (context.projectId !== null && rowProjectId !== null && context.projectId !== rowProjectId) {
    return errOf('PERMISSION_WORKSPACE_MISMATCH', '该记录不属于 context 声明的作品', requestId, {
      field: 'projectId',
    })
  }
  return null
}

// ---------------------------------------------------------------------------
// 文档行写入（projects 的"卷 + 首章"种子与 documents.createDocument 共用）
// ---------------------------------------------------------------------------

/** 新文档行的全部列值。 */
export interface NewDocumentRow {
  readonly id: string
  readonly workspaceId: string
  readonly projectId: string
  readonly kind: DocumentKind
  readonly parentId: string | null
  readonly orderKey: string
  readonly title: string
  readonly body: string
  readonly revision: Revision
  readonly at: UtcTimestamp
}

/**
 * 插入一条 `documents` 行。
 *
 * 🔴 `revision` 与 `revision_seq` **必须一起写**（这里固定为 1）：
 *    新实体的 `revision` 就是 `encodeRevision(1)`，缺了序号 SaveDraft 的乐观锁没有基线。
 */
export function insertDocumentRow(db: SqliteDatabase, row: NewDocumentRow): void {
  db.prepare(
    `INSERT INTO documents
       (id, workspace_id, project_id, kind, parent_id, order_key, title, body,
        revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${INITIAL_REVISION_SEQ}, 0, ?, ?)`,
  ).run(
    row.id,
    row.workspaceId,
    row.projectId,
    row.kind,
    row.parentId,
    row.orderKey,
    row.title,
    row.body,
    row.revision,
    row.at,
    row.at,
  )
}

/** 读取库里某行 `documents` 的排序相关列（供排序求解与重排使用）。 */
export interface DocumentOrderRow {
  readonly id: string
  readonly project_id: string
  readonly parent_id: string | null
  readonly order_key: string
  readonly revision: string
  readonly revision_seq: number
  readonly deleted: number
}

// ---------------------------------------------------------------------------
// 排序键求解
// ---------------------------------------------------------------------------

/** 兄弟集合的定位信息。`siblingSql` 是本模块固定的常量片段，绝不来自调用方输入。 */
export interface OrderKeyScope {
  /** 目标表（内部常量）。 */
  readonly table: 'documents' | 'settings_entities'
  /**
   * 兄弟集合的 WHERE 片段（**不含** `deleted` 与 `order_key` 条件），
   * 形如 `workspace_id = ? AND project_id = ? AND parent_id IS ?`。
   */
  readonly siblingSql: string
  /** 与 `siblingSql` 中 `?` 一一对应的参数。 */
  readonly siblingArgs: readonly (string | null)[]
  /** 锚点（`placement.afterId`）找不到时的错误码与文案。 */
  readonly notFound: NotFoundSpec
  readonly requestId: RequestId
  /** 重排时排除自身：把自己的键从兄弟集合里摘掉，否则"移动到自己后面"会算出原地键。 */
  readonly excludeId: string | null
}

/**
 * 求 `placement` 对应的新排序键。
 *
 * 🔴 端点必须**相邻**（`@yfe/domain/orderKey` 的硬性前提）：`orderKeyBetween` 是纯函数，
 *    同一对端点永远返回同一个中点。所以这里总是取「锚点键」与「锚点之后的第一个兄弟键」，
 *    两者之间没有别的兄弟，结果必然是全新键。
 *
 * 🔴 软删兄弟**不参与**排序（`deleted = 0`），墓碑键不再占位。
 */
export function orderKeyForPlacement(
  db: SqliteDatabase,
  scope: OrderKeyScope,
  placement: Placement,
): Result<OrderKey> {
  if (placement.mode === 'end') {
    const excludeClause = scope.excludeId === null ? '' : 'AND id <> ?'
    const args: Array<string | null> = [...scope.siblingArgs]
    if (scope.excludeId !== null) args.push(scope.excludeId)
    const row = db
      .prepare(
        `SELECT order_key FROM ${scope.table}
          WHERE ${scope.siblingSql} AND deleted = 0 ${excludeClause}
          ORDER BY order_key DESC LIMIT 1`,
      )
      .get(...args) as { order_key: string } | undefined
    const last = row?.order_key ?? null
    const bad = invalidKeyError(last, scope)
    if (bad !== null) return bad
    // `orderKeyAfter(null)` = 空列表的首键。
    return okKey(orderKeyAfter(last))
  }

  const afterId = placement.afterId
  if (scope.excludeId !== null && afterId === scope.excludeId) {
    return errOf('VALIDATION_FAILED', '不能把节点排到它自己之后', scope.requestId, {
      field: 'placement',
      entityId: afterId,
    })
  }

  const anchor = db
    .prepare(
      `SELECT id, order_key FROM ${scope.table}
        WHERE ${scope.siblingSql} AND id = ? AND deleted = 0`,
    )
    .get(...scope.siblingArgs, afterId) as { id: string; order_key: string } | undefined
  if (anchor === undefined) {
    return errOf(scope.notFound.code, scope.notFound.message, scope.requestId, { entityId: afterId })
  }
  const badAnchor = invalidKeyError(anchor.order_key, scope)
  if (badAnchor !== null) return badAnchor

  const excludeClause = scope.excludeId === null ? '' : 'AND id <> ?'
  const nextArgs: Array<string | null> = [...scope.siblingArgs, anchor.order_key]
  if (scope.excludeId !== null) nextArgs.push(scope.excludeId)
  const next = db
    .prepare(
      `SELECT order_key FROM ${scope.table}
        WHERE ${scope.siblingSql} AND deleted = 0 AND order_key > ? ${excludeClause}
        ORDER BY order_key LIMIT 1`,
    )
    .get(...nextArgs) as { order_key: string } | undefined
  const nextKey = next?.order_key ?? null
  const badNext = invalidKeyError(nextKey, scope)
  if (badNext !== null) return badNext

  return okKey(orderKeyBetween(anchor.order_key, nextKey))
}

/** 排序键非法 = 库内容损坏：返回 `STORAGE_CORRUPT` 而不是让 `RangeError` 冒泡成 INTERNAL_ERROR。 */
function invalidKeyError(key: string | null, scope: OrderKeyScope): Err | null {
  if (key === null) return null
  if (isValidOrderKey(key)) return null
  return errOf('STORAGE_CORRUPT', '库中存在非法的排序键，排序已中止', scope.requestId, {
    table: scope.table,
  })
}

function okKey(key: OrderKey): Result<OrderKey> {
  return { ok: true, value: key }
}

// ---------------------------------------------------------------------------
// settings_entities 的 JSON 值
// ---------------------------------------------------------------------------

/** 是否是「JSON 对象」形态（排除 null 与数组）。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并序列化动态 Schema 的字段值。
 *
 * `values` 存 JSON **文本**（`settings_entities.values_json`，列上有 `json_valid()` CHECK），
 * 数据库不为用户自定义字段建列——否则每加一个字段都要迁移表结构。
 *
 * ⚠️ 已知语义边界：`JSON.stringify` 对 `undefined` / 函数 / Symbol 会**静默丢弃**，
 *    对循环引用会抛错（这里会翻译成 `VALIDATION_FAILED`）。本层只保证
 *    「是对象且可序列化且可再解析」，不保证逐字段类型（字段类型由模板决定，属上层校验）。
 */
export function stringifyValues(
  values: unknown,
  requestId: RequestId,
  field: string,
): Result<string> {
  if (!isPlainRecord(values)) {
    return errOf('VALIDATION_FAILED', `${field} 必须是 JSON 对象`, requestId, { field })
  }
  let json: string
  try {
    const encoded: unknown = JSON.stringify(values)
    if (typeof encoded !== 'string') {
      return errOf('VALIDATION_FAILED', `${field} 无法序列化为 JSON`, requestId, { field })
    }
    json = encoded
  } catch {
    // 循环引用等：JSON.stringify 抛 TypeError。
    return errOf('VALIDATION_FAILED', `${field} 无法序列化为 JSON`, requestId, { field })
  }
  const roundTrip: unknown = JSON.parse(json)
  if (!isPlainRecord(roundTrip)) {
    return errOf('VALIDATION_FAILED', `${field} 序列化后不是 JSON 对象`, requestId, { field })
  }
  return { ok: true, value: json }
}

/** 解析库里的 `values_json`。损坏时返回 `STORAGE_CORRUPT`（critical，必须阻断而不是当成空值）。 */
export function parseValues(
  json: string,
  requestId: RequestId,
  entityId: string,
): Result<Readonly<Record<string, unknown>>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return errOf('STORAGE_CORRUPT', '设定值不是合法 JSON，已中止读取', requestId, { entityId })
  }
  if (!isPlainRecord(parsed)) {
    return errOf('STORAGE_CORRUPT', '设定值不是 JSON 对象，已中止读取', requestId, { entityId })
  }
  return { ok: true, value: parsed }
}
