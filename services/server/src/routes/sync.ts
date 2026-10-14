/**
 * `/api/v1/workspaces/{id}/...` 同步路由：快照、增量、原子批次、回执、版本历史与只读投影。
 *
 * ## 这一层的关键取舍
 *
 * 1. **批次冲突用契约自带的结果信封（HTTP 409），其它失败一律走 `ContractError`。**
 *    契约 `BatchSubmitOutput` 的失败分支是 `{ok:false, code, requestId, conflicts}`
 *    ——"基线冲突"是一个**业务结果**，客户端需要逐操作读冲突元数据（哪个 opId、
 *    期望哪个基线、服务器现在是哪个版本）。把它压进 5 键错误体的 `detail`
 *    （只允许标量）会丢掉结构，客户端只能看到"有一处冲突"却不知道是哪一处。
 *    因此这里唯一不抛异常的分支是冲突；**其它所有失败**（协议不符、未知
 *    entityType、超限、游标非法、幂等键重用）都抛 `ContractError`，由
 *    `http/server.ts` 的 `setErrorHandler` 统一成 5 键响应体。
 *    两种形状都不含 `cause` / 堆栈 / SQLite 原文 / 真实路径。
 * 2. **基线校验（读）与写入（写）分成两段，冲突时一个字节都不写。**
 *    校验阶段只读数据库、只写内存里的 overlay 计划；有任何冲突就返回 409，
 *    写入阶段才开事务。这比"边写边判断、出错再回滚"更可靠：回滚能撤销数据，
 *    但撤销不了**已经产生的副作用**（自动编号被消耗、触发器被触发、日志被写）。
 *    两段之间没有 `await`，better-sqlite3 又是同步执行，所以不存在"校验完
 *    被别的请求插一腿"的窗口。
 * 3. **游标是 `server_seq` 的编码，不是时间。** 顺序来自 `change_feed` 的
 *    AUTOINCREMENT，即服务器提交顺序。多台设备时钟可以差几十分钟，用时间排序
 *    会把"后提交的变更排到前面"，客户端一推进游标就永久漏掉中间那段。
 * 4. **重试回放的是原响应原文。** 同 batchId + 同规范化载荷摘要 → 直接返回
 *    落库时的 `response_json`，不再做一次基线校验（原结果已经成立）。
 */

import { ContractError, canManageMembers } from '@yfe/contracts'
import type {
  BatchSubmitOutput,
  ChangeEntry,
  ChangesOutput,
  DeviceId,
  OperationConflict,
  OperationAction,
  ProjectId,
  RequestId,
  Revision,
  UtcTimestamp,
  WorkspaceId,
} from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { SessionPolicy } from '../auth/session.js'
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/audit.js'
import { canonicalByteLength, digestOf } from '../db/canonical.js'
import { findDeviceById } from '../db/devices.js'
import { tx } from '../db/open.js'
import type { ServerDb } from '../db/open.js'
import {
  appendChange,
  findEntityState,
  findFeedEntryByOpId,
  findReceipt,
  insertReceipt,
  listChanges,
  listEntityVersions,
  listLiveEntities,
  readHeadSeq,
  recordConflicts,
  upsertEntity,
} from '../db/sync.js'
import type { EntityState, FeedEntry } from '../db/sync.js'
import { authorizeWorkspaceAccess, currentAuth, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import {
  CONFIG_ENTITY_TYPE,
  DEFAULT_CHANGES_LIMIT,
  DEFAULT_VERSIONS_LIMIT,
  MAX_CHANGES_LIMIT,
  MAX_OPERATIONS_ACCEPTED_BY_SCHEMA,
  MAX_VERSIONS_LIMIT,
  PLUGIN_STATE_ENTITY_TYPE,
  SYNC_LIMITS,
  assertProtocolVersion,
  cursorInvalidError,
  encodeWorkspaceCursor,
  isSyncEntityType,
  parseLimit,
  parseWorkspaceCursor,
  payloadTooLargeError,
  requireWellFormedId,
} from '../sync/protocol.js'

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

interface BatchOperationBody {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly projectId?: string | null
  readonly baseRevision?: string | null
  readonly newRevision: string
  readonly action: 'upsert' | 'delete'
  readonly payload: Readonly<Record<string, unknown>>
  readonly assetIds?: readonly string[]
}

interface BatchBody {
  readonly protocolVersion: number
  readonly batchId: string
  readonly deviceId: string
  readonly workspaceId: string
  readonly operations: readonly BatchOperationBody[]
  readonly idempotencyKey?: string
}

/** 校验通过后的规范化操作：可空字段已经落成 `null`，不再有 `undefined` 分叉。 */
interface NormalizedOp {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly baseRevision: Revision | null
  readonly newRevision: Revision
  readonly action: OperationAction
  readonly payload: Readonly<Record<string, unknown>>
}

const OPERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // `projectId` / `baseRevision` / `assetIds` 不设 required：缺省语义是"null/空"，
  // 与契约里的可空字段一致；而**认不出**的字段一律拒绝（additionalProperties: false），
  // 不做静默丢弃。
  required: ['opId', 'entityType', 'entityId', 'newRevision', 'action', 'payload'],
  properties: {
    opId: { type: 'string', minLength: 1, maxLength: 128 },
    entityType: { type: 'string', minLength: 1, maxLength: 64 },
    entityId: { type: 'string', minLength: 1, maxLength: 128 },
    projectId: { type: ['string', 'null'], maxLength: 128 },
    baseRevision: { type: ['string', 'null'], maxLength: 128 },
    newRevision: { type: 'string', minLength: 1, maxLength: 128 },
    action: { type: 'string', enum: ['upsert', 'delete'] },
    payload: { type: 'object' },
    assetIds: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 128 } },
  },
} as const

const BATCH_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'batchId', 'deviceId', 'workspaceId', 'operations'],
  properties: {
    protocolVersion: { type: 'integer', minimum: 1 },
    batchId: { type: 'string', minLength: 1, maxLength: 128 },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    // 🔴 契约要求带 workspaceId；它只用于**交叉验证**，绝不作为写入目标。
    // 真正的目标工作区来自路径，并已被 requireWorkspaceAccess 授权过。
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    operations: {
      type: 'array',
      minItems: 1,
      // 上限放到 1000：操作数超限要由我们返回带 detail 的 413，
      // 而不是被 ajv 拦成没有可执行提示的 400。1001 以上才交给 schema。
      maxItems: MAX_OPERATIONS_ACCEPTED_BY_SCHEMA,
      items: OPERATION_SCHEMA,
    },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const CHANGES_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 256 },
    limit: { type: 'integer', minimum: 1 },
  },
} as const

const VERSIONS_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entityType: { type: 'string', minLength: 1, maxLength: 64 },
    limit: { type: 'integer', minimum: 1 },
  },
} as const

const SNAPSHOT_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

export interface SyncRouteDeps {
  readonly db: ServerDb
  readonly policy: SessionPolicy
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  /** 传输层请求体上限，用来把 capabilities 上报的批次上限收窄到真实可收范围。 */
  readonly bodyLimitBytes: number
  readonly log?: (line: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/** 实体投影：服务器权威字段放在 payload 之后，避免载荷里的同名字段覆盖身份。 */
function toEntityItem(entity: EntityState): Record<string, unknown> {
  return {
    ...entity.payload,
    entityId: entity.entityId,
    revision: entity.revision,
    projectId: entity.projectId,
    updatedAt: entity.updatedAt,
  }
}

function toChangeEntry(entry: FeedEntry, workspaceId: WorkspaceId): ChangeEntry {
  return {
    cursor: encodeWorkspaceCursor(entry.serverSeq, workspaceId),
    entityType: entry.entityType,
    entityId: entry.entityId,
    projectId: entry.projectId,
    action: entry.action,
    revision: entry.revision,
    baseRevision: entry.baseRevision,
    payload: entry.payload,
    committedAt: entry.committedAt,
    serverSeq: entry.serverSeq,
  }
}

/**
 * 版本历史条目。
 *
 * 刻意**不下发** actor 字段（`actorDeviceId` / `actorUserId`）与 `batchId` / `opId`：
 * 版本历史回答的是"这个实体改过哪几版、内容是什么"，把"谁在哪台设备上改的"
 * 一并给出会让一个有读权限的成员拿到其他主体的设备标识。
 */
function toVersionItem(entry: FeedEntry, workspaceId: WorkspaceId): Record<string, unknown> {
  return {
    cursor: encodeWorkspaceCursor(entry.serverSeq, workspaceId),
    serverSeq: entry.serverSeq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    projectId: entry.projectId,
    action: entry.action,
    revision: entry.revision,
    baseRevision: entry.baseRevision,
    payload: entry.payload,
    committedAt: entry.committedAt,
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  requireWellFormedId(raw, 'workspaceId', requestId)
  return raw as WorkspaceId
}

function requireRevision(value: unknown, field: string, requestId: RequestId): Revision {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError({
      code: 'VALIDATION_FAILED',
      message: `字段 ${field} 必须是非空字符串。`,
      requestId,
      detail: { field },
    })
  }
  if (value.length > SYNC_LIMITS.maxOrderKeyLength) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `字段 ${field} 超过 ${SYNC_LIMITS.maxOrderKeyLength} 字符上限。`,
      requestId,
      detail: { field, max: SYNC_LIMITS.maxOrderKeyLength },
    })
  }
  return value as Revision
}

function normalizeOperations(
  raw: readonly BatchOperationBody[],
  requestId: RequestId,
): readonly NormalizedOp[] {
  const seen = new Set<string>()
  const operations: NormalizedOp[] = []
  for (const [index, op] of raw.entries()) {
    requireWellFormedId(op.opId, `operations[${index}].opId`, requestId)
    if (seen.has(op.opId)) {
      throw new ContractError({
        code: 'VALIDATION_FAILED',
        message: '同一批次内 opId 不能重复。',
        requestId,
        detail: { opId: op.opId },
      })
    }
    seen.add(op.opId)

    if (!isSyncEntityType(op.entityType)) {
      // 未知类型绝不静默丢弃：丢一个 create 比报错危险得多（客户端以为写进去了）。
      throw new ContractError({
        code: 'SYNC_CAPABILITY_UNSUPPORTED',
        message: '本服务器暂不支持该 entityType，请升级客户端或改用受支持的实体类型。',
        requestId,
        detail: { entityType: op.entityType, opId: op.opId },
      })
    }
    requireWellFormedId(op.entityId, `operations[${index}].entityId`, requestId)

    let projectId: ProjectId | null = null
    if (op.projectId !== undefined && op.projectId !== null) {
      requireWellFormedId(op.projectId, `operations[${index}].projectId`, requestId)
      projectId = op.projectId as ProjectId
    }

    let baseRevision: Revision | null = null
    if (op.baseRevision !== undefined && op.baseRevision !== null) {
      baseRevision = requireRevision(op.baseRevision, `operations[${index}].baseRevision`, requestId)
    }
    const newRevision = requireRevision(op.newRevision, `operations[${index}].newRevision`, requestId)

    if (op.action === 'delete' && baseRevision === null) {
      throw new ContractError({
        code: 'VALIDATION_FAILED',
        message: '删除操作必须给出 baseRevision（"删除一个还不存在的东西"不是有效操作）。',
        requestId,
        detail: { opId: op.opId, field: 'baseRevision' },
      })
    }
    if (baseRevision !== null && baseRevision === newRevision) {
      throw new ContractError({
        code: 'VALIDATION_FAILED',
        message: 'newRevision 必须与 baseRevision 不同。',
        requestId,
        detail: { opId: op.opId },
      })
    }
    if (op.assetIds !== undefined && op.assetIds.length > 0) {
      throw new ContractError({
        code: 'SYNC_CAPABILITY_UNSUPPORTED',
        message: '本服务器尚未启用附件上传，批次不得引用 assetIds（capabilities.assets.enabled 为 false）。',
        requestId,
        detail: { opId: op.opId, assetCount: op.assetIds.length },
      })
    }

    operations.push({
      opId: op.opId,
      entityType: op.entityType,
      entityId: op.entityId,
      projectId,
      baseRevision,
      newRevision,
      action: op.action,
      payload: op.payload,
    })
  }
  return operations
}

/**
 * 设备交叉验证。
 *
 * 批次由**设备**发起，`deviceId` 是审计与冲突归属的一部分。所以它必须：
 * 属于当前主体、未被撤销、且（若绑定了工作区）属于目标工作区。
 * "设备不存在"与"不属于你"返回**同一条消息**：否则这个端点会变成
 * 一台设备 id 是否存在的探测器。
 */
function assertDeviceForBatch(
  db: ServerDb,
  request: FastifyRequest,
  deviceId: DeviceId,
  userId: string,
  workspaceId: WorkspaceId,
  requestId: RequestId,
): void {
  const device = findDeviceById(db, deviceId)
  if (device === null || device.userId !== userId) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '设备不存在或不属于当前主体。',
      requestId,
      detail: { reason: 'unknown_device' },
    })
  }
  const auth = currentAuth(request)
  if (auth.principal.via === 'device' && auth.principal.deviceId !== null && auth.principal.deviceId !== deviceId) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '设备凭据只能代表它自己的 deviceId。',
      requestId,
      detail: { reason: 'device_mismatch' },
    })
  }
  if (device.revokedAt !== null) {
    throw new ContractError({
      code: 'AUTH_DEVICE_REVOKED',
      message: '该设备已被撤销，请重新配对后再同步。',
      requestId,
      detail: { deviceId },
    })
  }
  if (device.workspaceId !== null && device.workspaceId !== workspaceId) {
    throw new ContractError({
      code: 'PERMISSION_WORKSPACE_MISMATCH',
      message: '该设备不属于目标工作区。',
      requestId,
      detail: { reason: 'device_workspace_mismatch' },
    })
  }
}

interface BaselinePlan {
  readonly conflicts: readonly OperationConflict[]
  /** 已经提交过的 opId → 既有 revision（同载荷重放，不二次写入）。 */
  readonly replays: ReadonlyMap<string, Revision>
}

/**
 * 基线校验（纯读）。
 *
 * `overlay` 是同一批次内的依赖链：文档 07 要求"后一个操作可以引用前一个操作刚
 * 产出的 newRevision"。没有 overlay 时，`create A (base=null, new=r1)` 之后紧跟
 * 的 `update A (base=r1, ...)` 会被判成 revision-mismatch —— 而它在离线链上
 * 完全合法。overlay 只影响同一批次内的后续操作，不写库。
 */
function planBaselines(
  db: ServerDb,
  workspaceId: WorkspaceId,
  operations: readonly NormalizedOp[],
  requestId: RequestId,
): BaselinePlan {
  const conflicts: OperationConflict[] = []
  const replays = new Map<string, Revision>()
  const overlay = new Map<string, { readonly revision: Revision; readonly deleted: boolean }>()

  for (const op of operations) {
    const key = `${op.entityType}\u0000${op.entityId}`

    const prior = findFeedEntryByOpId(db, workspaceId, op.opId)
    if (prior !== null) {
      if (
        prior.revision !== op.newRevision ||
        prior.action !== op.action ||
        digestOf(prior.payload) !== digestOf(op.payload)
      ) {
        throw new ContractError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: '该 opId 之前已以不同载荷提交过；请换一个新的 opId。',
          requestId,
          detail: { opId: op.opId },
        })
      }
      replays.set(op.opId, prior.revision)
      overlay.set(key, { revision: prior.revision, deleted: prior.action === 'delete' })
      continue
    }

    const planned = overlay.get(key)
    const current =
      planned ??
      ((): { readonly revision: Revision; readonly deleted: boolean } | null => {
        const state = findEntityState(db, workspaceId, op.entityType, op.entityId)
        return state === null ? null : { revision: state.revision, deleted: state.deleted }
      })()

    if (op.baseRevision === null) {
      if (current !== null && !current.deleted) {
        conflicts.push({
          opId: op.opId,
          entityType: op.entityType,
          entityId: op.entityId,
          expectedBaseRevision: null,
          currentRevision: current.revision,
          reason: 'revision-mismatch',
        })
        continue
      }
    } else if (current === null || current.deleted) {
      conflicts.push({
        opId: op.opId,
        entityType: op.entityType,
        entityId: op.entityId,
        expectedBaseRevision: op.baseRevision,
        currentRevision: current === null ? null : current.revision,
        reason: 'entity-deleted',
      })
      continue
    } else if (current.revision !== op.baseRevision) {
      conflicts.push({
        opId: op.opId,
        entityType: op.entityType,
        entityId: op.entityId,
        expectedBaseRevision: op.baseRevision,
        currentRevision: current.revision,
        reason: 'revision-mismatch',
      })
      continue
    }

    overlay.set(key, { revision: op.newRevision, deleted: op.action === 'delete' })
  }

  return { conflicts, replays }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const log = deps.log ?? ((): void => {})
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const maxBatchBytes = Math.min(SYNC_LIMITS.maxBatchBytes, deps.bodyLimitBytes)

  // ------------------------------------------------------------ 一致快照
  app.get(
    '/api/v1/workspaces/:workspaceId/snapshot',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: SNAPSHOT_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')

      const query = request.query as { projectId?: string }
      let projectId: ProjectId | null = null
      if (query.projectId !== undefined) {
        requireWellFormedId(query.projectId, 'projectId', requestId)
        projectId = query.projectId as ProjectId
      }

      // cursor 先取、实体后读，两者之间没有 await（better-sqlite3 同步执行），
      // 因此快照描述的就是这个 cursor 对应的那一瞬间。
      const cursor = encodeWorkspaceCursor(readHeadSeq(deps.db, workspaceId), workspaceId)
      const bucket = (entityType: string, matchById = false): readonly Record<string, unknown>[] =>
        listLiveEntities(deps.db, workspaceId, entityType)
          .filter((entity) =>
            projectId === null ? true : matchById ? entity.entityId === projectId : entity.projectId === projectId,
          )
          .map(toEntityItem)

      return reply.status(200).header('cache-control', 'no-store').send({
        cursor,
        takenAt: deps.now(),
        projects: bucket('project', true),
        documents: bucket('document'),
        settingsEntities: bucket('settingsEntity'),
        relations: bucket('relation'),
        // capabilities.assets.enabled 为 false：附件上传是后续任务，
        // 这里返回空数组而不是省略字段，客户端不必区分"没有附件"和"字段缺失"。
        assets: [],
        nextCursor: null,
      })
    },
  )

  // ------------------------------------------------------------ 增量变更
  app.get(
    '/api/v1/workspaces/:workspaceId/changes',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: CHANGES_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')

      const query = request.query as { cursor?: string; limit?: number }
      const limit = parseLimit(query.limit, 'limit', DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT, requestId)
      const head = readHeadSeq(deps.db, workspaceId)

      let afterSeq = 0
      if (query.cursor !== undefined) {
        afterSeq = parseWorkspaceCursor(query.cursor, workspaceId, requestId)
        // 游标指向服务器还没提交到的位置：客户端拿的是别的分支/被回滚过的状态，
        // 必须重新同步而不是"等一下就有了"（等下去就是永久空洞）。
        if (afterSeq > head) {
          throw cursorInvalidError(requestId, { reason: 'beyond_head', head })
        }
      }

      const changes: ChangeEntry[] = listChanges(deps.db, workspaceId, afterSeq, limit).map((entry) =>
        toChangeEntry(entry, workspaceId),
      )
      const last = changes.at(-1)
      const output: ChangesOutput = {
        changes,
        // 增量流是无限的：即使这次没有变更，也要给一个可继续的游标，
        // 而不是 null（null 会被客户端理解成"到此为止，别再拉了"）。
        nextCursor: last === undefined ? encodeWorkspaceCursor(afterSeq, workspaceId) : last.cursor,
        resyncRequired: false,
      }
      return reply.status(200).header('cache-control', 'no-store').send(output)
    },
  )

  // ------------------------------------------------------------ 原子批次
  app.post(
    '/api/v1/workspaces/:workspaceId/batches',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }), schema: { body: BATCH_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      const access = authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const principal = currentPrincipal(request)
      const body = request.body as BatchBody
      const at = deps.now()

      if (body.workspaceId !== workspaceId) {
        throw new ContractError({
          code: 'PERMISSION_WORKSPACE_MISMATCH',
          message: '请求体中的 workspaceId 与路径不一致。',
          requestId,
          detail: { reason: 'path_body_mismatch' },
        })
      }

      assertProtocolVersion(body.protocolVersion, requestId)
      requireWellFormedId(body.batchId, 'batchId', requestId)
      requireWellFormedId(body.deviceId, 'deviceId', requestId)
      const deviceId = body.deviceId as DeviceId

      if (body.operations.length > SYNC_LIMITS.maxOperationsPerBatch) {
        throw payloadTooLargeError(requestId, {
          limit: 'maxOperationsPerBatch',
          max: SYNC_LIMITS.maxOperationsPerBatch,
          actual: body.operations.length,
        })
      }

      const envelope = {
        protocolVersion: body.protocolVersion,
        workspaceId,
        deviceId,
        operations: body.operations,
      }
      const bytes = canonicalByteLength(envelope)
      if (bytes > maxBatchBytes) {
        throw payloadTooLargeError(requestId, { limit: 'maxBatchBytes', max: maxBatchBytes, actual: bytes })
      }

      const operations = normalizeOperations(body.operations, requestId)
      assertDeviceForBatch(deps.db, request, deviceId, principal.userId, workspaceId, requestId)

      // 幂等：batchId + 规范化载荷摘要。
      const digest = digestOf(envelope)
      const existing = findReceipt(deps.db, body.batchId)
      if (existing !== null) {
        if (existing.workspaceId !== workspaceId || existing.payloadDigest !== digest) {
          throw new ContractError({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: '该 batchId 已被用于另一份载荷；请换一个新的 batchId 重新提交。',
            requestId,
            detail: { batchId: body.batchId },
          })
        }
        log({ level: 'info', event: 'sync.batch.replayed', requestId, workspaceId, batchId: body.batchId })
        // 原样回放：不做第二次基线校验（原结果已经成立），不产生第二次写入。
        return reply
          .status(200)
          .header('cache-control', 'no-store')
          .send(JSON.parse(existing.responseJson) as BatchSubmitOutput)
      }

      const plan = planBaselines(deps.db, workspaceId, operations, requestId)
      if (plan.conflicts.length > 0) {
        const conflictInputs = plan.conflicts.map((conflict) => {
          const op = operations.find((candidate) => candidate.opId === conflict.opId)
          return {
            workspaceId,
            batchId: body.batchId,
            opId: conflict.opId,
            entityType: conflict.entityType,
            entityId: conflict.entityId,
            projectId: op?.projectId ?? null,
            reason: conflict.reason,
            expectedBaseRevision: conflict.expectedBaseRevision,
            currentRevision: conflict.currentRevision,
            submittedByUserId: principal.userId,
            deviceId,
            detectedAt: at,
          }
        })
        try {
          recordConflicts(deps.db, conflictInputs)
        } catch (error) {
          // 冲突留痕是旁路：落库失败不影响"整批拒绝"这个判定本身。
          log({
            level: 'warn',
            event: 'sync.batch.conflict_record_failed',
            requestId,
            reason: error instanceof Error ? error.name : 'unknown',
          })
        }
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.syncBatchRejected,
          outcome: 'denied',
          at,
          actorUserId: principal.userId,
          actorDeviceId: deviceId,
          workspaceId,
          requestId,
          detail: { conflictCount: plan.conflicts.length },
        })

        const failure: BatchSubmitOutput = {
          ok: false,
          code: 'SYNC_BATCH_REJECTED',
          requestId,
          conflicts: plan.conflicts,
        }
        log({
          level: 'info',
          event: 'sync.batch.rejected',
          requestId,
          workspaceId,
          batchId: body.batchId,
          conflictCount: plan.conflicts.length,
        })
        return reply.status(409).header('cache-control', 'no-store').send(failure)
      }

      const acceptedAt = at
      const output = tx(deps.db, (): BatchSubmitOutput => {
        let head = readHeadSeq(deps.db, workspaceId)
        const revisions: { opId: string; entityId: string; revision: Revision }[] = []

        for (const op of operations) {
          const replayed = plan.replays.get(op.opId)
          if (replayed !== undefined) {
            // 同 opId 同载荷：不二次写入，回执里给出既有 revision。
            revisions.push({ opId: op.opId, entityId: op.entityId, revision: replayed })
            continue
          }

          const seq = appendChange(deps.db, {
            workspaceId,
            entityType: op.entityType,
            entityId: op.entityId,
            projectId: op.projectId,
            action: op.action,
            revision: op.newRevision,
            baseRevision: op.baseRevision,
            payload: op.payload,
            actorDeviceId: deviceId,
            actorUserId: principal.userId,
            batchId: body.batchId,
            opId: op.opId,
            committedAt: acceptedAt,
          })
          upsertEntity(deps.db, {
            workspaceId,
            entityType: op.entityType,
            entityId: op.entityId,
            projectId: op.projectId,
            revision: op.newRevision,
            deleted: op.action === 'delete',
            // 墓碑不带正文：删除后服务器上不该再留着被删的内容。
            payload: op.action === 'delete' ? null : op.payload,
            at: acceptedAt,
            lastServerSeq: seq,
          })
          head = Math.max(head, seq)
          revisions.push({ opId: op.opId, entityId: op.entityId, revision: op.newRevision })
        }

        const cursor = encodeWorkspaceCursor(head, workspaceId)
        const accepted: BatchSubmitOutput = {
          ok: true,
          batchId: body.batchId,
          cursor,
          acceptedAt,
          revisions,
        }
        // 回执与实体/变更**同事务**：不存在"数据写了但回执没写"的中间态，
        // 也就不存在"重试时既查不到回执、又不敢重写"的僵局。
        insertReceipt(deps.db, {
          batchId: body.batchId,
          workspaceId,
          deviceId,
          submittedByUserId: principal.userId,
          payloadDigest: digest,
          operationCount: operations.length,
          acceptedAt,
          cursor,
          responseJson: JSON.stringify(accepted),
          idempotencyKey: body.idempotencyKey ?? null,
        })
        return accepted
      })

      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.syncBatchAccepted,
        outcome: 'success',
        at: acceptedAt,
        actorUserId: principal.userId,
        actorDeviceId: deviceId,
        workspaceId,
        requestId,
        targetType: 'batch',
        targetId: body.batchId,
        detail: { operationCount: operations.length, role: access.role },
      })
      log({
        level: 'info',
        event: 'sync.batch.accepted',
        requestId,
        workspaceId,
        batchId: body.batchId,
        operationCount: operations.length,
      })

      return reply.status(200).header('cache-control', 'no-store').send(output)
    },
  )

  // ------------------------------------------------------------ 批次回执
  app.get(
    '/api/v1/workspaces/:workspaceId/receipts/:batchId',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      const access = authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const principal = currentPrincipal(request)

      const batchId = requireWellFormedId((request.params as { batchId?: string }).batchId, 'batchId', requestId)
      const receipt = findReceipt(deps.db, batchId)

      // 跨工作区探测一律 404：不能靠"403 还是 404"反推别的工作区有哪些 batchId。
      if (receipt === null || receipt.workspaceId !== workspaceId) {
        throw new ContractError({
          code: 'NOT_FOUND',
          message: '找不到该批次回执。',
          requestId,
          detail: { batchId },
        })
      }
      if (receipt.submittedByUserId !== principal.userId && !canManageMembers(access.role)) {
        throw new ContractError({
          code: 'PERMISSION_DENIED',
          message: '只有原提交者或工作区管理者可以读取该回执。',
          requestId,
          detail: { batchId },
        })
      }

      return reply.status(200).header('cache-control', 'no-store').send({
        batchId: receipt.batchId,
        deviceId: receipt.deviceId,
        acceptedAt: receipt.acceptedAt,
        operationCount: receipt.operationCount,
        cursor: receipt.cursor,
        payloadDigest: receipt.payloadDigest,
        // 契约 ReceiptOutput 是回执的"头"；这里额外附带首次提交的完整结果，
        // 让"确认响应丢了"的客户端不必重新提交即可拿到每个 opId 的 revision。
        result: JSON.parse(receipt.responseJson) as unknown,
      })
    },
  )

  // ------------------------------------------------------------ 版本历史
  app.get(
    '/api/v1/workspaces/:workspaceId/entities/:entityId/versions',
    { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }), schema: { querystring: VERSIONS_QUERY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')

      const query = request.query as { entityType?: string; limit?: number }
      const entityId = requireWellFormedId(
        (request.params as { entityId?: string }).entityId,
        'entityId',
        requestId,
      )

      let entityType: string | null = null
      if (query.entityType !== undefined) {
        if (!isSyncEntityType(query.entityType)) {
          throw new ContractError({
            code: 'SYNC_CAPABILITY_UNSUPPORTED',
            message: '本服务器暂不支持该 entityType。',
            requestId,
            detail: { entityType: query.entityType },
          })
        }
        entityType = query.entityType
      }

      const limit = parseLimit(query.limit, 'limit', DEFAULT_VERSIONS_LIMIT, MAX_VERSIONS_LIMIT, requestId)
      const versions = listEntityVersions(deps.db, workspaceId, entityId, entityType, limit).map((entry) =>
        toVersionItem(entry, workspaceId),
      )
      return reply.status(200).header('cache-control', 'no-store').send({
        entityId,
        entityType,
        versions,
      })
    },
  )

  // ------------------------------------------------------------ 只读投影
  const registerProjection = (path: string, entityType: string): void => {
    app.get(
      path,
      { preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }) },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId = request.id as RequestId
        const workspaceId = workspaceIdOf(request, requestId)
        authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
        const cursor = encodeWorkspaceCursor(readHeadSeq(deps.db, workspaceId), workspaceId)
        const items = listLiveEntities(deps.db, workspaceId, entityType).map(toEntityItem)
        return reply.status(200).header('cache-control', 'no-store').send({ cursor, items })
      },
    )
  }

  // 只注册 GET：配置与插件状态的写入统一走 batches，所以这两个路径上
  // 不存在任何可写的动词（POST/PUT/PATCH 会落到 404）。
  registerProjection('/api/v1/workspaces/:workspaceId/config', CONFIG_ENTITY_TYPE)
  registerProjection('/api/v1/workspaces/:workspaceId/plugin-state', PLUGIN_STATE_ENTITY_TYPE)
}
