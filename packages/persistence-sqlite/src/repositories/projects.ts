/**
 * `projects` —— 作品实体的持久化读写（P1-A3 Repository 层）。
 *
 * 设计依据：
 * - `06-数据与本地存储.md`：「db 与 ProjectContext 一律**显式传递**，不新增可变"当前作品"服务单例」；
 *   「数据库写入必须走 Repository 与应用用例，UI 不得直接拼 SQL」。
 * - `10-开发规范与环境.md`：同一禁令；单例会让"两个窗口打开两个作品"在第一次交互时传错数据。
 *
 * 🔴 五条不可动摇的约束：
 * 1. **没有模块级"当前作品"**。每个函数的 `workspaceId`/`projectId` 都由调用方的
 *    `ReadContext`/`WriteContext` 显式给出，本模块不持有任何跨请求状态。
 * 2. **每条实体查询都带 `workspace_id = ?`**。越界访问返回
 *    `PERMISSION_WORKSPACE_MISMATCH`，**绝不静默返回空**（见 {@link loadOwnership} 的理由）。
 * 3. **软删默认不可见**。默认 `deleted = 0`；要取已删记录必须显式传 `{ includeDeleted: true }`。
 * 4. **新建实体的 `revision` 与 `revision_seq` 一起写**，序号从 1 起（`encodeRevision(1)`）。
 *    缺了序号，SaveDraft 的乐观锁没有基线，第一次保存就会覆盖并发修改。
 * 5. **失败只返回 `Result`**，错误码取自 `@yfe/contracts`，不自造异常类型。
 *
 * ⚠️ 本层只写实体表（`projects` / `documents`）。`revisions` / `operations` / `outbox`
 *    的写入属于应用用例（见 `saveDraft`）——**不是** Repository 的职责：
 *    否则"一次拖动重排"会留下一条永远不上传的 outbox 记录。
 */

import {
  errOf,
  isWellFormedId,
  newIds,
  ok,
  type Project,
  type ProjectCreateInput,
  type Err,
  type ProjectCreateOutput,
  type ProjectId,
  type ReadContext,
  type RequestId,
  type Result,
  type Revision,
  type WriteContext,
} from '@yfe/contracts'
import { orderKeyBetween } from '@yfe/domain/orderKey'

import type { SqliteDatabase } from '../schema/index.js'
import {
  INITIAL_REVISION_SEQ,
  MAX_PROJECT_NAME_LENGTH,
  insertDocumentRow,
  loadOwnership,
  nextRevision,
  runRead,
  runWrite,
  type RepositoryDeps,
} from './internal.js'

// ---------------------------------------------------------------------------
// 行映射（列名即 DDL 列名；映射只在读取边界发生一次）
// ---------------------------------------------------------------------------

interface ProjectRow {
  readonly id: string
  readonly workspace_id: string
  readonly name: string
  readonly summary: string
  readonly project_type: string
  readonly revision: string
  readonly revision_seq: number
  readonly deleted: number
  readonly created_at: string
  readonly updated_at: string
}

/** 只取需要的列，绝不 `SELECT *`：`SELECT *` 在后续 DDL 加列时会静默改变返回结构。 */
const PROJECT_COLUMNS =
  'id, workspace_id, name, summary, project_type, revision, revision_seq, deleted, created_at, updated_at'

function toProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    workspaceId: row.workspace_id as Project['workspaceId'],
    name: row.name,
    summary: row.summary,
    projectType: row.project_type,
    revision: row.revision as Revision,
    deleted: row.deleted,
    createdAt: row.created_at as Project['createdAt'],
    updatedAt: row.updated_at as Project['updatedAt'],
  }
}

// ---------------------------------------------------------------------------
// 入参校验（全部在事务外：校验失败不该开事务，更不该取写锁）
// ---------------------------------------------------------------------------

function validateName(name: unknown, requestId: RequestId): Result<string> {
  if (typeof name !== 'string') {
    return errOf('VALIDATION_MISSING_FIELD', '作品名必须是字符串', requestId, { field: 'name' })
  }
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', '作品名不能为空', requestId, { field: 'name' })
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    return errOf('VALIDATION_OUT_OF_RANGE', `作品名不能超过 ${MAX_PROJECT_NAME_LENGTH} 个字符`, requestId, {
      field: 'name',
    })
  }
  return ok(trimmed)
}

function validateProjectId(projectId: unknown, requestId: RequestId): Result<string> {
  if (!isWellFormedId(projectId)) {
    return errOf('VALIDATION_MALFORMED_ID', '作品 ID 格式不合法', requestId, { field: 'projectId' })
  }
  return ok(projectId)
}

/** `ReadContext` 的公共校验：workspaceId 必须是合法 ID。 */
function validateReadContext(context: ReadContext): Err | null {
  if (!isWellFormedId(context.workspaceId)) {
    return errOf('VALIDATION_MALFORMED_ID', '工作区 ID 格式不合法', context.requestId, {
      field: 'workspaceId',
    })
  }
  return null
}

/** `WriteContext` 的公共校验（读的部分 + 期望修订号形态）。 */
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

/** 建库后 `workspaces` 里必须有这条工作区：外键只在 `foreign_keys=ON` 时兜底，错误码也不够明确。 */
function loadAliveWorkspace(
  db: SqliteDatabase,
  workspaceId: string,
  requestId: RequestId,
): Err | null {
  const row = db.prepare('SELECT deleted FROM workspaces WHERE id = ?').get(workspaceId) as
    | { deleted: number }
    | undefined
  if (row === undefined) {
    return errOf('NOT_FOUND', '工作区不存在', requestId, { entityId: workspaceId, field: 'workspaceId' })
  }
  if (row.deleted !== 0) {
    return errOf('NOT_FOUND', '工作区已删除', requestId, { entityId: workspaceId, field: 'workspaceId' })
  }
  return null
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 新建作品。
 *
 * 同一事务内可选播种「第一卷 + 第 1 章」（`seedFirstChapter`），两者的
 * `revision_seq` 都从 1 起——播种不是"半个作品"，要么全有要么全无。
 *
 * ⚠️ 契约缺口：`ProjectCreateInput.templateId` 在 `projects` 表里**没有对应列**。
 *    这里把它落到已有的 `project_type`（契约注释：作品类型可为 `full` / 题材包 ID），
 *    未传时用 DDL 默认值 `full`。见交付报告。
 */
export function createProject(
  db: SqliteDatabase,
  input: ProjectCreateInput & { readonly projectId?: ProjectId },
  deps: RepositoryDeps,
): Result<ProjectCreateOutput> {
  const { context } = input
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  // 新建实体没有"基线版本"，传了期望修订号说明调用方用错了用例。
  if (context.expectedRevision !== null) {
    return errOf('VALIDATION_FAILED', '新建作品时 expectedRevision 必须为 null', requestId, {
      field: 'expectedRevision',
    })
  }
  const nameResult = validateName(input.name, requestId)
  if (!nameResult.ok) return nameResult
  if (input.summary !== undefined && typeof input.summary !== 'string') {
    return errOf('VALIDATION_FAILED', '作品简介必须是字符串', requestId, { field: 'summary' })
  }
  if (input.seedFirstChapter !== undefined && typeof input.seedFirstChapter !== 'boolean') {
    return errOf('VALIDATION_FAILED', 'seedFirstChapter 必须是布尔值', requestId, {
      field: 'seedFirstChapter',
    })
  }
  if (input.templateId !== undefined && typeof input.templateId !== 'string') {
    return errOf('VALIDATION_FAILED', 'templateId 必须是字符串', requestId, { field: 'templateId' })
  }

  // 🔴 调用方（用例层）预生成的 ID 必须先校验，绝不把畸形 ID 写进库。
  if (input.projectId !== undefined && !isWellFormedId(input.projectId)) {
    return errOf('VALIDATION_MALFORMED_ID', 'projectId 格式不合法', requestId, { field: 'projectId' })
  }

  const name = nameResult.value
  const summary = input.summary ?? ''
  const projectType = input.templateId ?? 'full'

  return runWrite(db, requestId, '新建作品失败', (): Result<ProjectCreateOutput> => {
    const workspaceErr = loadAliveWorkspace(db, context.workspaceId, requestId)
    if (workspaceErr !== null) return workspaceErr

    // 🔴 优先采用调用方给的 ID：用例层必须先于端口调用生成 `projectId`（幂等重放要回
    //    同一个 ID），本层再生成一次会让「返回给客户端的 ID」与「落库的 ID」分叉（R-18）。
    //    不传时才自生成，服务迁移脚本与直连测试。
    const projectId = input.projectId ?? newIds.project(deps.rng)
    const revision = nextRevision(deps, INITIAL_REVISION_SEQ, requestId)
    const now = deps.clock.now()

    db.prepare(
      `INSERT INTO projects
         (id, workspace_id, name, summary, project_type, revision, revision_seq, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ${INITIAL_REVISION_SEQ}, 0, ?, ?)`,
    ).run(projectId, context.workspaceId, name, summary, projectType, revision, now, now)

    if (input.seedFirstChapter === true) {
      const volumeId = newIds.document(deps.rng)
      insertDocumentRow(db, {
        id: volumeId,
        workspaceId: context.workspaceId,
        projectId,
        kind: 'volume',
        parentId: null,
        orderKey: orderKeyBetween(null, null),
        title: '第一卷',
        body: '',
        revision: nextRevision(deps, INITIAL_REVISION_SEQ, requestId),
        at: now,
      })
      insertDocumentRow(db, {
        id: newIds.document(deps.rng),
        workspaceId: context.workspaceId,
        projectId,
        kind: 'chapter',
        parentId: volumeId,
        orderKey: orderKeyBetween(null, null),
        title: '第 1 章',
        body: '',
        revision: nextRevision(deps, INITIAL_REVISION_SEQ, requestId),
        at: now,
      })
    }

    return ok({ projectId, revision })
  })
}

/** 读取单个作品。默认不含已软删作品，要读已删的传 `{ includeDeleted: true }`。 */
export function getProject(
  db: SqliteDatabase,
  context: ReadContext,
  projectId: string,
  options?: { readonly includeDeleted?: boolean },
): Result<Project> {
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateProjectId(projectId, requestId)
  if (!idResult.ok) return idResult

  return runRead(requestId, '读取作品失败', () => {
    const ownership = loadOwnership(db, 'projects', projectId, context.workspaceId, requestId, {
      code: 'NOT_FOUND_PROJECT',
      message: '作品不存在',
    })
    if (!ownership.ok) return ownership
    if (ownership.value.deleted !== 0 && options?.includeDeleted !== true) {
      return errOf('NOT_FOUND_PROJECT', '作品已删除', requestId, { entityId: projectId })
    }
    const row = db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND workspace_id = ?`)
      .get(projectId, context.workspaceId) as ProjectRow | undefined
    if (row === undefined) {
      return errOf('NOT_FOUND_PROJECT', '作品不存在', requestId, { entityId: projectId })
    }
    return ok(toProject(row))
  })
}

/**
 * 列出工作区内的作品。
 *
 * ⚠️ 契约缺口：命令契约里没有 `ListProjectsInput`。这里沿用 `ReadContext` +
 *    可选 `{ includeDeleted, projectId }` 的形状，只是为了本层可用；
 *    正式形状应由 Lead 补进 `commands/`（见交付报告）。
 */
export function listProjects(
  db: SqliteDatabase,
  context: ReadContext,
  options?: { readonly includeDeleted?: boolean },
): Result<readonly Project[]> {
  const requestId = context.requestId
  const contextErr = validateReadContext(context)
  if (contextErr !== null) return contextErr
  const includeDeleted = options?.includeDeleted === true

  return runRead(requestId, '列出作品失败', () => {
    const rows = db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM projects
          WHERE workspace_id = ?${includeDeleted ? '' : ' AND deleted = 0'}
          ORDER BY created_at, id`,
      )
      .all(context.workspaceId) as readonly ProjectRow[]
    return ok(rows.map(toProject))
  })
}

/**
 * 重命名作品。
 *
 * 乐观锁是 **CAS**（`WHERE id = ? AND revision = ?`）而不是"先读后写"：
 * 两个写连接并存时，先 SELECT 判断再无条件 UPDATE 必然丢失更新。
 */
export function renameProject(
  db: SqliteDatabase,
  context: WriteContext,
  projectId: string,
  name: string,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateProjectId(projectId, requestId)
  if (!idResult.ok) return idResult
  const nameResult = validateName(name, requestId)
  if (!nameResult.ok) return nameResult
  const newName = nameResult.value

  return runWrite(db, requestId, '重命名作品失败', (): Result<{ revision: Revision }> => {
    const ownership = loadOwnership(db, 'projects', projectId, context.workspaceId, requestId, {
      code: 'NOT_FOUND_PROJECT',
      message: '作品不存在',
    })
    if (!ownership.ok) return ownership
    if (ownership.value.deleted !== 0) {
      return errOf('NOT_FOUND_PROJECT', '作品已删除', requestId, { entityId: projectId })
    }
    const current = db
      .prepare('SELECT name, revision, revision_seq FROM projects WHERE id = ? AND workspace_id = ?')
      .get(projectId, context.workspaceId) as
      | { name: string; revision: string; revision_seq: number }
      | undefined
    if (current === undefined) {
      return errOf('NOT_FOUND_PROJECT', '作品不存在', requestId, { entityId: projectId })
    }
    if (context.expectedRevision !== null && context.expectedRevision !== current.revision) {
      return errOf('REVISION_CONFLICT', '作品已被其他会话修改，请刷新后重试', requestId, {
        entityId: projectId,
        expected: context.expectedRevision,
        actual: current.revision,
      })
    }
    if (current.name === newName) {
      // 同名不改：不推进 revision。乐观锁的 revision 是"内容变了"的信号，
      // 无变化的写会让并发编辑器凭空吃到一个 REVISION_CONFLICT。
      return ok({ revision: current.revision as Revision })
    }
    const revision = nextRevision(deps, current.revision_seq + 1, requestId)
    const info = db
      .prepare(
        `UPDATE projects SET name = ?, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
      )
      .run(newName, revision, deps.clock.now(), projectId, context.workspaceId, current.revision)
    if (info.changes !== 1) {
      return errOf('REVISION_CONFLICT', '作品已被其他会话修改，请刷新后重试', requestId, {
        entityId: projectId,
      })
    }
    return ok({ revision })
  })
}

/**
 * 软删作品（`deleted = 1`，**不**物理删除：被删的 id 要留在库里，
 * 否则上次同步的墓碑会消失，另一端会把"删除"当成"新增"）。
 *
 * ⚠️ 不级联软删文档。作品被软删后其文档行仍在（`documents` 无 project 级过滤），
 *    文档的可见性由「作品可见性」决定。级联软删会让"恢复作品"变成不可能的操作，
 *    因此这里刻意不做，留给用例层显式决定（见交付报告）。
 */
export function softDeleteProject(
  db: SqliteDatabase,
  context: WriteContext,
  projectId: string,
  deps: RepositoryDeps,
): Result<{ readonly revision: Revision }> {
  const requestId = context.requestId
  const contextErr = validateWriteContext(context)
  if (contextErr !== null) return contextErr
  const idResult = validateProjectId(projectId, requestId)
  if (!idResult.ok) return idResult

  return runWrite(db, requestId, '删除作品失败', (): Result<{ revision: Revision }> => {
    const ownership = loadOwnership(db, 'projects', projectId, context.workspaceId, requestId, {
      code: 'NOT_FOUND_PROJECT',
      message: '作品不存在',
    })
    if (!ownership.ok) return ownership
    if (ownership.value.deleted !== 0) {
      return errOf('NOT_FOUND_PROJECT', '作品已删除', requestId, { entityId: projectId })
    }
    const current = db
      .prepare('SELECT revision, revision_seq FROM projects WHERE id = ? AND workspace_id = ?')
      .get(projectId, context.workspaceId) as
      | { revision: string; revision_seq: number }
      | undefined
    if (current === undefined) {
      return errOf('NOT_FOUND_PROJECT', '作品不存在', requestId, { entityId: projectId })
    }
    if (context.expectedRevision !== null && context.expectedRevision !== current.revision) {
      return errOf('REVISION_CONFLICT', '作品已被其他会话修改，请刷新后重试', requestId, {
        entityId: projectId,
        expected: context.expectedRevision,
        actual: current.revision,
      })
    }
    const revision = nextRevision(deps, current.revision_seq + 1, requestId)
    const info = db
      .prepare(
        `UPDATE projects
            SET deleted = 1, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND revision = ? AND deleted = 0`,
      )
      .run(revision, deps.clock.now(), projectId, context.workspaceId, current.revision)
    if (info.changes !== 1) {
      return errOf('REVISION_CONFLICT', '作品已被其他会话修改，请刷新后重试', requestId, {
        entityId: projectId,
      })
    }
    return ok({ revision })
  })
}
