/**
 * `documents` —— 卷 / 章 / 大纲 / 笔记统一文档树的持久化读写（P1-A3 Repository 层）。
 *
 * 设计依据：
 * - `06-数据与本地存储.md`：「卷/章/大纲/笔记统一为 Document，`kind` 区分，`parent_id` 成树」；
 *   「列表接口**绝不返回正文**」；「树渲染与拖动排序走 `(parent_id, order_key)` 索引」。
 * - `packages/contracts/src/entities/index.ts:130`：`DocumentSummary` 用 `Omit<Document, 'body'>`
 *   把正文**从类型里彻底排除**（不是可选字段）。列表中带正文会让 1000 章作品每次拉数十 MB。
 *
 * 🔴 六条不可动摇的约束：
 * 1. **树列表绝不含 body**。{@link listDocumentTree} 的返回值每个元素恰好 12 个键，
 *    没有 `body` 也没有 `workspaceId`（`DocumentSummary` 的定义如此）；
 *    正文只在 {@link getDocument} 里按单篇返回。
 * 2. **`charCount` 现场算**。契约注释：`charCount` 按 `countChars` 计算，**不从缓存读取**。
 *    因此树查询内部确实要读一次正文（只为数数），但不把它放进返回值。
 * 3. **workspace 隔离**。所有实体查询带 `workspace_id = ?`；跨工作区访问返回
 *    `PERMISSION_WORKSPACE_MISMATCH` 而不是空数组。
 * 4. **排序键由 `@yfe/domain/orderKey` 生成**。绝不用"max(order_key)+1"这类整数步进：
 *    并发两处插入会拿到同一个键，顺序静默错乱。
 * 5. **软删默认隐藏**（`deleted = 0`）；取已删记录必须显式传 `includeDeleted: true`。
 * 6. **新建文档 `revision = encodeRevision(1)` 且 `revision_seq = 1` 一起写**。
 *
 * ⚠️ 已知缺口（只报告，不在本层偷偷绕过）：
 * - 契约的 `DocumentUpdateInput` 允许同时改 `parentId`（移动节点）。本层**只**实现
 *   标题更新与同父重排；跨父移动需要祖先环校验，见交付报告的未完成项。
 * - `revision` 历史 / `operations` / `outbox` 不在本层写入（属应用用例职责）。
 */

import {
  errOf,
  isDocumentKind,
  isWellFormedId,
  newIds,
  ok,
  type DocumentCreateInput,
  type DocumentCreateOutput,
  type DocumentGetInput,
  type DocumentGetOutput,
  type DocumentId,
  type DocumentSummary,
  type DocumentTreeInput,
  type DocumentTreeOutput,
  type Err,
  type ReadContext,
  type RequestId,
  type Result,
  type Revision,
  type WriteContext,
} from '@yfe/contracts'
import { countChars } from '@yfe/domain/text'

import type { SqliteDatabase } from '../schema/index.js'
import {
  INITIAL_REVISION_SEQ,
  MAX_DOCUMENT_TITLE_LENGTH,
  checkContextProject,
  insertDocumentRow,
  loadOwnership,
  nextRevision,
  orderKeyForPlacement,
  runRead,
  runWrite,
  type RepositoryDeps,
} from './internal.js'

/**
 * 插入 / 重排位置。
 *
 * 直接取自契约的**内联联合类型**（`DocumentCreateInput['placement']`），
 * 不另抄一份：抄一份就必然在契约扩展（如加 `before`）时静默漂移。
 */
export type DocumentPlacement = DocumentCreateInput['placement']

/** 插入 `after` 模式时的兄弟节点定位；`afterId` 必须是**同一个父节点下**的兄弟。 */
export type DocumentPlacementInput = DocumentPlacement

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

interface DocumentRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly kind: string
  readonly parent_id: string | null
  readonly order_key: string
  readonly title: string
  readonly body: string
  readonly revision: string
  readonly revision_seq: number
  readonly deleted: number
  readonly created_at: string
  readonly updated_at: string
}

const DOCUMENT_COLUMNS =
  'id, workspace_id, project_id, kind, parent_id, order_key, title, body, revision, revision_seq, deleted, created_at, updated_at'

/**
 * 行 → `DocumentSummary`。
 *
 * 🔴 返回值**只有** `DocumentSummary` 声明的 12 个键：没有 `body`，也没有 `workspaceId`。
 *    `charCount` 用 `countChars`（字素簇）现场计算——与 `saveDraft` 写库时的算法同源。
 */
function toSummary(row: DocumentRow, hasChildren: boolean): DocumentSummary {
  return {
    id: row.id as DocumentId,
    projectId: row.project_id as DocumentSummary['projectId'],
    kind: row.kind as DocumentSummary['kind'],
    parentId: row.parent_id as DocumentId | null,
    orderKey: row.order_key,
    title: row.title,
    revision: row.revision as Revision,
    deleted: row.deleted,
    createdAt: row.created_at as DocumentSummary['createdAt'],
    updatedAt: row.updated_at as DocumentSummary['updatedAt'],
    charCount: countChars(row.body),
    hasChildren,
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function validateId(value: unknown, field: string, requestId: RequestId): Result<string> {
  if (!isWellFormedId(value)) {
    return errOf('VALIDATION_MALFORMED_ID', `${field} 格式不合法`, requestId, { field })
  }
  return ok(value)
}

function validateTitle(title: unknown, requestId: RequestId): Result<string> {
  if (typeof title !== 'string') {
    return errOf('VALIDATION_MISSING_FIELD', '文档标题必须是字符串', requestId, { field: 'title' })
  }
  if (title.length > MAX_DOCUMENT_TITLE_LENGTH) {
    // 空标题合法（未命名章节），只挡超长。
    return errOf(
      'VALIDATION_OUT_OF_RANGE',
      `文档标题不能超过 ${MAX_DOCUMENT_TITLE_LENGTH} 个字符`,
      requestId,
      { field: 'title' },
    )
  }
  return ok(title)
}

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

/** 写路径必须先确认作品存在且未删：否则会往一个已删除作品里塞文档。 */
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
    return errOf('NOT_FOUND_PROJECT', '作品已删除，不能再写入其文档', requestId, { entityId: projectId })
  }
  return null
}

/**
 * 读路径加载文档行：归属探针 → 软删判定 → 按 workspace 过滤取实体。
 *
 * 🔴 两次查询是刻意的：先只取归属列判定「越界 / 不存在 / 已删」，
 *    再带 `workspace_id = ?` 取实体——这样"越界"永远不可能被当成"空结果"。
 */
function loadDocumentForRead(
  db: SqliteDatabase,
  context: ReadContext,
  documentId: string,
  requestId: RequestId,
  includeDeleted: boolean,
): Result<DocumentRow> {
  const ownership = loadOwnership(db, 'documents', documentId, context.workspaceId, requestId, {
    code: 'NOT_FOUND_DOCUMENT',
    message: '文档不存在',
  })
  if (!ownership.ok) return ownership
  if (ownership.value.deleted !== 0 && !includeDeleted) {
    return errOf('NOT_FOUND_DOCUMENT', '文档已删除', requestId, { entityId: documentId })
  }
  const row = db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND workspace_id = ?`)
    .get(documentId, context.workspaceId) as DocumentRow | undefined
  if (row === undefined) {
    return errOf('NOT_FOUND_DOCUMENT', '文档不存在', requestId, { entityId: documentId })
  }
  return ok(row)
}

/** 写路径加载文档行：额外校验 `context.projectId` 与库内归属一致。 */
function loadDocumentForWrite(
  db: SqliteDatabase,
  context: WriteContext,
  documentId: string,
  requestId: RequestId,
): Result<DocumentRow> {
  const ownership = loadOwnership(db, 'documents', documentId, context.workspaceId, requestId, {
    code: 'NOT_FOUND_DOCUMENT',
    message: '文档不存在',
  })
  if (!ownership.ok) return ownership
  if (ownership.value.deleted !== 0) {
    return errOf('NOT_FOUND_DOCUMENT', '文档已删除', requestId, { entityId: documentId })
  }
  const projectErr = checkContextProject(
    context,
    ownership.value.project_id ?? null,
    requestId,
  )
  if (projectErr !== null) return projectErr
  const row = db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ? AND workspace_id = ?`)
    .get(documentId, context.workspaceId) as DocumentRow | undefined
  if (row === undefined) {
    return errOf('NOT_FOUND_DOCUMENT', '文档不存在', requestId, { entityId: documentId })
  }
  return ok(row)
}

/** 同一父节点下的兄弟定位。父为 `null` 时用 `IS ?`（`= NULL` 永远不成立）。 */
const DOCUMENT_SIBLING_SQL = 'workspace_id = ? AND project_id = ? AND parent_id IS ?'

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 新建文档（卷 / 章 / 大纲 / 笔记）。
 *
 * `placement`（契约 `DocumentCreateInput['placement']`）：
 * - `{ mode: 'end' }`：排到同级末尾；
 * - `{ mode: 'after', afterId }`：紧跟同级兄弟 `afterId`。
 *
 * 排序键由 `@yfe/domain/orderKey` 的 `orderKeyBetween(相邻端点)` 生成，
 * 只改新行的一个键、不碰任何已有行——这正是分数索引的意义。
 */
export function createDocument(
  db: SqliteDatabase,
  input: DocumentCreateInput,
  deps: RepositoryDeps,
): Result<DocumentCreateOutput> {
  const { context, projectId, kind, parentId, title, placement } = input
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const projectResult = validateId(projectId, 'projectId', requestId)
  if (!projectResult.ok) return projectResult
  if (!isDocumentKind(kind)) {
    return errOf('VALIDATION_FAILED', '文档种类不合法', requestId, { field: 'kind' })
  }
  if (parentId !== null) {
    const parentResult = validateId(parentId, 'parentId', requestId)
    if (!parentResult.ok) return parentResult
  }
  const titleResult = validateTitle(title, requestId)
  if (!titleResult.ok) return titleResult
  if (context.projectId !== null && context.projectId !== projectId) {
    return errOf('PERMISSION_WORKSPACE_MISMATCH', '入参 projectId 与 context 声明的作品不一致', requestId, {
      field: 'projectId',
    })
  }
  if (context.expectedRevision !== null) {
    return errOf('VALIDATION_FAILED', '新建文档时 expectedRevision 必须为 null', requestId, {
      field: 'expectedRevision',
    })
  }

  return runWrite(db, requestId, '新建文档失败', (): Result<DocumentCreateOutput> => {
    const projectErr = loadAliveProject(db, context.workspaceId, projectId, requestId)
    if (projectErr !== null) return projectErr

    if (parentId !== null) {
      const parentOwnership = loadOwnership(db, 'documents', parentId, context.workspaceId, requestId, {
        code: 'NOT_FOUND_DOCUMENT',
        message: '父节点不存在',
      })
      if (!parentOwnership.ok) return parentOwnership
      if (parentOwnership.value.deleted !== 0) {
        return errOf('NOT_FOUND_DOCUMENT', '父节点已删除', requestId, { entityId: parentId })
      }
      if (parentOwnership.value.project_id !== projectId) {
        return errOf('VALIDATION_FAILED', '父节点不属于该作品', requestId, { entityId: parentId })
      }
    }

    const orderKeyResult = orderKeyForPlacement(
      db,
      {
        table: 'documents',
        siblingSql: DOCUMENT_SIBLING_SQL,
        siblingArgs: [context.workspaceId, projectId, parentId],
        notFound: { code: 'NOT_FOUND_DOCUMENT', message: '排序锚点不存在' },
        requestId,
        excludeId: null,
      },
      placement,
    )
    if (!orderKeyResult.ok) return orderKeyResult

    const documentId = newIds.document(deps.rng)
    const now = deps.clock.now()
    const revision = nextRevision(deps, INITIAL_REVISION_SEQ, requestId)
    insertDocumentRow(db, {
      id: documentId,
      workspaceId: context.workspaceId,
      projectId,
      kind,
      parentId,
      orderKey: orderKeyResult.value,
      title: titleResult.value,
      body: '',
      revision,
      at: now,
    })
    return ok({ documentId, revision, orderKey: orderKeyResult.value })
  })
}

/**
 * 读取单篇文档（**含正文**）。
 *
 * 只有这一个接口返回 `body`：正文是几十 MB 的对象，必须按需单篇取。
 */
export function getDocument(db: SqliteDatabase, input: DocumentGetInput): Result<DocumentGetOutput> {
  const { context, documentId } = input
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateId(documentId, 'documentId', requestId)
  if (!idResult.ok) return idResult

  return runRead(requestId, '读取文档失败', () => {
    const rowResult = loadDocumentForRead(db, context, documentId, requestId, false)
    if (!rowResult.ok) return rowResult
    const row = rowResult.value
    const childCount = db
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE workspace_id = ? AND parent_id = ? AND deleted = 0')
      .get(context.workspaceId, documentId) as { n: number } | undefined
    const summary = toSummary(row, (childCount?.n ?? 0) > 0)
    return ok({ document: summary, body: row.body })
  })
}

/**
 * 列出作品的全部文档（**平铺**，不含正文）。
 *
 * 🔴 返回的是 `DocumentSummary[]`：每个元素恰好 12 个键，**没有 `body`**。
 *    这里刻意返回平铺数组而不是嵌套树：树的组装是纯前端计算（`parentId` 已经在手），
 *    让 SQL 层拼嵌套结构只会把"每个节点一次查询"的 N+1 带回来。
 *
 * `includeDeleted: true` 时已软删文档也会返回（`deleted` 字段可区分），
 * 用于"回收站"视图；默认只返回未删。
 */
export function listDocumentTree(
  db: SqliteDatabase,
  input: DocumentTreeInput,
): Result<DocumentTreeOutput> {
  const { context, projectId } = input
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  const projectResult = validateId(projectId, 'projectId', requestId)
  if (!projectResult.ok) return projectResult
  const includeDeleted = input.includeDeleted === true

  return runRead(requestId, '列出文档树失败', () => {
    const ownership = loadOwnership(db, 'projects', projectId, context.workspaceId, requestId, {
      code: 'NOT_FOUND_PROJECT',
      message: '作品不存在',
    })
    if (!ownership.ok) return ownership

    const rows = db
      .prepare(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents
          WHERE workspace_id = ? AND project_id = ?${includeDeleted ? '' : ' AND deleted = 0'}
          ORDER BY order_key, id`,
      )
      .all(context.workspaceId, projectId) as readonly DocumentRow[]

    // `hasChildren` 只按**本次返回集合**判定：与 includeDeleted 策略一致。
    // 若按全表判定，回收站视图里会出现"有子节点"但子节点不在结果里的悬空标记。
    const parents = new Set<string>()
    for (const row of rows) {
      if (row.parent_id !== null) parents.add(row.parent_id)
    }
    return ok({ documents: rows.map((row) => toSummary(row, parents.has(row.id))) })
  })
}

/**
 * 更新文档标题（不改结构、不改位置）。
 *
 * 乐观锁为 CAS：`UPDATE ... WHERE id = ? AND revision = ?`，`changes !== 1` 即
 * `REVISION_CONFLICT`。先读后写在多写连接下必然丢失更新。
 */
export function updateDocumentTitle(
  db: SqliteDatabase,
  context: WriteContext,
  documentId: string,
  title: string,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateId(documentId, 'documentId', requestId)
  if (!idResult.ok) return idResult
  const titleResult = validateTitle(title, requestId)
  if (!titleResult.ok) return titleResult
  const newTitle = titleResult.value

  return runWrite(db, requestId, '更新文档标题失败', (): Result<{ revision: Revision }> => {
    const rowResult = loadDocumentForWrite(db, context, documentId, requestId)
    if (!rowResult.ok) return rowResult
    const row = rowResult.value
    if (context.expectedRevision !== null && context.expectedRevision !== row.revision) {
      return errOf('REVISION_CONFLICT', '文档已被其他会话修改，请刷新后重试', requestId, {
        entityId: documentId,
        expected: context.expectedRevision,
        actual: row.revision,
      })
    }
    if (row.title === newTitle) {
      return ok({ revision: row.revision as Revision })
    }
    const revision = nextRevision(deps, row.revision_seq + 1, requestId)
    const info = db
      .prepare(
        `UPDATE documents SET title = ?, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
      )
      .run(newTitle, revision, deps.clock.now(), documentId, context.workspaceId, row.revision)
    if (info.changes !== 1) {
      return errOf('REVISION_CONFLICT', '文档已被其他会话修改，请刷新后重试', requestId, {
        entityId: documentId,
      })
    }
    return ok({ revision })
  })
}

/**
 * 软删文档。
 *
 * 默认**级联软删子树**（`cascade: true`）：契约把文档建模成一棵树，
 * 「删掉卷」而留下孤儿子章会让树渲染出现没有父节点的幽灵节点。
 * 递归用 `UNION`（不是 `UNION ALL`）——即使库里存在历史环也不会无限递归。
 *
 * 每行推进**各自的** `revision_seq`：级联删除也是"这些实体变了"，
 * 版本号必须逐个往前走，否则并发写者会拿旧 revision 覆盖已删状态。
 */
export function softDeleteDocument(
  db: SqliteDatabase,
  context: WriteContext,
  documentId: string,
  deps: RepositoryDeps,
  options?: { readonly cascade?: boolean },
): Result<{ readonly revision: Revision; readonly deletedCount: number }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateId(documentId, 'documentId', requestId)
  if (!idResult.ok) return idResult
  const cascade = options?.cascade !== false

  return runWrite(
    db,
    requestId,
    '删除文档失败',
    (): Result<{ revision: Revision; deletedCount: number }> => {
      const rowResult = loadDocumentForWrite(db, context, documentId, requestId)
      if (!rowResult.ok) return rowResult
      const root = rowResult.value
      if (context.expectedRevision !== null && context.expectedRevision !== root.revision) {
        return errOf('REVISION_CONFLICT', '文档已被其他会话修改，请刷新后重试', requestId, {
          entityId: documentId,
          expected: context.expectedRevision,
          actual: root.revision,
        })
      }

      const targets = cascade
        ? (db
            .prepare(
              `WITH RECURSIVE subtree (id, revision, revision_seq) AS (
                 SELECT id, revision, revision_seq FROM documents
                  WHERE id = ? AND workspace_id = ? AND project_id = ? AND deleted = 0
                 UNION
                 SELECT d.id, d.revision, d.revision_seq FROM documents d
                   JOIN subtree s ON d.parent_id = s.id
                  WHERE d.workspace_id = ? AND d.project_id = ? AND d.deleted = 0
               )
               SELECT id, revision, revision_seq FROM subtree`,
            )
            .all(
              documentId,
              context.workspaceId,
              root.project_id,
              context.workspaceId,
              root.project_id,
            ) as readonly { id: string; revision: string; revision_seq: number }[])
        : [{ id: root.id, revision: root.revision, revision_seq: root.revision_seq }]

      const now = deps.clock.now()
      let rootRevision: Revision | null = null
      for (const target of targets) {
        const revision = nextRevision(deps, target.revision_seq + 1, requestId)
        const info = db
          .prepare(
            `UPDATE documents
                SET deleted = 1, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted = 0`,
          )
          .run(revision, now, target.id, context.workspaceId, target.revision)
        if (info.changes !== 1) {
          return errOf('REVISION_CONFLICT', '文档树在删除过程中被其他会话修改，请重试', requestId, {
            entityId: target.id,
          })
        }
        if (target.id === documentId) rootRevision = revision
      }
      if (rootRevision === null) {
        // 根节点必然在子树里（CTE 的锚点就是它）；走到这里说明库内容与预期不符。
        return errOf('STORAGE_CORRUPT', '删除文档时未取到根节点的新版本号', requestId, {
          entityId: documentId,
        })
      }
      return ok({ revision: rootRevision, deletedCount: targets.length })
    },
  )
}

/**
 * 同父节点内重排文档（拖动排序）。
 *
 * 🔴 只改**一行**的 `order_key`：相邻端点由 SQL 现场取（锚点键 + 锚点之后第一个
 *    未删兄弟键），保证两个端点之间没有别的兄弟，`orderKeyBetween` 的结果必然是新键。
 *
 * 位置与标题一样受乐观锁保护（同一 `revision` 通路），
 * 拖动与正文保存的冲突才不会互相覆盖。
 *
 * ⚠️ 不变更 `parentId`（跨父移动）——见文件头"已知缺口"。
 */
export function reorderDocument(
  db: SqliteDatabase,
  context: WriteContext,
  documentId: string,
  placement: DocumentPlacement,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision; readonly orderKey: string }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateId(documentId, 'documentId', requestId)
  if (!idResult.ok) return idResult
  if (placement.mode === 'after') {
    const afterResult = validateId(placement.afterId, 'placement.afterId', requestId)
    if (!afterResult.ok) return afterResult
    if (placement.afterId === documentId) {
      return errOf('VALIDATION_FAILED', '不能把文档排到它自己之后', requestId, { field: 'placement' })
    }
  }

  return runWrite(
    db,
    requestId,
    '重排文档失败',
    (): Result<{ revision: Revision; orderKey: string }> => {
      const rowResult = loadDocumentForWrite(db, context, documentId, requestId)
      if (!rowResult.ok) return rowResult
      const row = rowResult.value
      if (context.expectedRevision !== null && context.expectedRevision !== row.revision) {
        return errOf('REVISION_CONFLICT', '文档已被其他会话修改，请刷新后重试', requestId, {
          entityId: documentId,
          expected: context.expectedRevision,
          actual: row.revision,
        })
      }

      const orderKeyResult = orderKeyForPlacement(
        db,
        {
          table: 'documents',
          siblingSql: DOCUMENT_SIBLING_SQL,
          siblingArgs: [context.workspaceId, row.project_id, row.parent_id],
          notFound: { code: 'NOT_FOUND_DOCUMENT', message: '排序锚点不存在或已被删除' },
          requestId,
          // 把自己从兄弟集合里摘掉：否则"移到自己后面"会算出自己的键。
          excludeId: documentId,
        },
        placement,
      )
      if (!orderKeyResult.ok) return orderKeyResult
      const orderKey = orderKeyResult.value

      if (orderKey === row.order_key) {
        // 位置没变（例如已在本级末尾又拖到末尾）：不推进 revision。
        // 否则 UI 的一次无效拖动会让另一个窗口凭空吃到 REVISION_CONFLICT。
        return ok({ revision: row.revision as Revision, orderKey })
      }

      const revision = nextRevision(deps, row.revision_seq + 1, requestId)
      const info = db
        .prepare(
          `UPDATE documents SET order_key = ?, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND revision = ?`,
        )
        .run(orderKey, revision, deps.clock.now(), documentId, context.workspaceId, row.revision)
      if (info.changes !== 1) {
        return errOf('REVISION_CONFLICT', '文档已被其他会话修改，请刷新后重试', requestId, {
          entityId: documentId,
        })
      }
      return ok({ revision, orderKey })
    },
  )
}
