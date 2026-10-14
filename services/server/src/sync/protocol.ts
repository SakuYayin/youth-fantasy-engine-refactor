/**
 * 同步协议的服务端常量、边界与游标编解码。
 *
 * ## 为什么单独一个模块
 *
 * 三处必须**用同一份数字**，否则会出现"服务端说允许 100 个操作、实际在第 80 个拒绝"
 * 这类无法排查的问题：
 *
 * 1. `GET /api/v1/capabilities`（把上限告诉客户端）；
 * 2. `POST /api/v1/workspaces/{id}/batches`（真正执行上限）；
 * 3. 测试（断言"上报的上限 == 实际执行的上限"，这是本轮验收的硬要求）。
 *
 * 所以上限只有这一个定义点，路由与测试都从这里取。
 *
 * ## 游标为什么要校验 `scope`
 *
 * 游标字符串的构造是 `encodeCursor(seq, scope)` = `` `${scope}:${seq.toString(36)}` ``，
 * 而服务端把 `scope` 取成 **workspaceId**。于是游标天然带上了"它属于哪个工作区"的
 * 信息，解析时可以直接比对：把 A 工作区的游标交给 B 工作区的 `changes` 必须被拒绝，
 * 否则 B 的 `server_seq` 与 A 的对不上，客户端会静默漏掉整段变更（数据丢失级故障）。
 *
 * `workspaceId` 由 `isWellFormedId` 保证不含 `:`，所以按**第一个** `:` 切分是安全的。
 */

import { ContractError, SYNC_PROTOCOL_VERSION, encodeCursor, isWellFormedId, isProtocolCompatible } from '@yfe/contracts'
import type { Cursor, OperationAction, RemoteCommandType, RequestId, WorkspaceId } from '@yfe/contracts'

/**
 * 首版资源上限（`07-同步协议与API.md`：初始 100 个操作 / 4 MiB）。
 *
 * 🔴 改这里的数字就是改对外契约：`capabilities` 会照实上报，客户端会照此分批。
 */
export const SYNC_LIMITS = {
  /** 单批最大操作数。 */
  maxOperationsPerBatch: 100,
  /** 单批最大字节数（规范化 JSON 的 UTF-8 字节）。 */
  maxBatchBytes: 4 * 1024 * 1024,
  /** 排序键最大长度。实体 ID 的契约上限就是 128。 */
  maxOrderKeyLength: 128,
} as const

/** schema 能接受的最大操作数：比上限大一截，好让"超限"由我们返回 413 而不是被 schema 判成 400。 */
export const MAX_OPERATIONS_ACCEPTED_BY_SCHEMA = 1000

/** 增量拉取的分页大小。 */
export const DEFAULT_CHANGES_LIMIT = 100
export const MAX_CHANGES_LIMIT = 500

/** 版本历史的分页大小。 */
export const DEFAULT_VERSIONS_LIMIT = 50
export const MAX_VERSIONS_LIMIT = 500

/** 本轮不实现附件上传（上传/附件属于后续任务），因此能力上报 `enabled: false`。 */
export const SYNC_ASSETS = {
  enabled: false,
  partSizeBytes: 8 * 1024 * 1024,
  maxAssetBytes: 512 * 1024 * 1024,
} as const

/** 支持的远程命令类型（本轮只"上报"，命令接口属后续任务）。 */
export const SUPPORTED_COMMANDS: readonly RemoteCommandType[] = ['workflow.run', 'job.cancel', 'sync.trigger']

/** 支持的实体动作。 */
export const SUPPORTED_ACTIONS: readonly OperationAction[] = ['upsert', 'delete']

/**
 * 服务端认识的 `entityType` 白名单。
 *
 * 🔴 契约里 `SyncOperation.entityType` 是**裸字符串，没有枚举**
 * （`packages/persistence-sqlite/src/saveDraft/saveDraft.ts:126-130` 专门记录了
 * 这个缺口："同步两端一旦拼写漂移就是'操作被静默丢弃'"）。所以白名单必须由服务端
 * 显式定义，且**未知值一律 400 拒绝，绝不静默丢弃**。
 *
 * 取值与 `SnapshotOutput` 的分桶、以及 `07-同步协议与API.md` 的"写入统一走 batches"
 * 对齐：
 * - `project` / `document` / `settingsEntity` / `relation`：桌面端 17 张表里的同名实体；
 * - `configValue` / `pluginState`：只读投影 `.../config` 与 `.../plugin-state` 的数据源。
 *
 * 刻意**不含 `asset`**：附件必须先经上传/校验流程产生，再被操作引用
 * （"附件先上传/校验，再提交引用"）。当前 `assets.enabled = false`，
 * 允许客户端凭空造 asset 实体会绕过将来上传侧的校验。
 */
export const SYNC_ENTITY_TYPES = ['project', 'document', 'settingsEntity', 'relation', 'configValue', 'pluginState'] as const

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number]

export function isSyncEntityType(value: unknown): value is SyncEntityType {
  return typeof value === 'string' && (SYNC_ENTITY_TYPES as readonly string[]).includes(value)
}

/** 与 `SnapshotOutput` 的五个分桶对应关系（`assets` 恒为空，见上）。 */
export const SNAPSHOT_BUCKETS = {
  project: 'projects',
  document: 'documents',
  settingsEntity: 'settingsEntities',
  relation: 'relations',
} as const

export type SnapshotBucket = (typeof SNAPSHOT_BUCKETS)[keyof typeof SNAPSHOT_BUCKETS]

/** 只读投影对应的实体类型。 */
export const CONFIG_ENTITY_TYPE: SyncEntityType = 'configValue'
export const PLUGIN_STATE_ENTITY_TYPE: SyncEntityType = 'pluginState'

/** 协议主版本。客户端 `protocolVersion` 与它不同即 `SYNC_PROTOCOL_MISMATCH`。 */
export const SYNC_PROTOCOL_MAJOR = SYNC_PROTOCOL_VERSION.major

/** 服务端能接受的最低客户端主版本（首版 = 1）。 */
export const MIN_CLIENT_MAJOR = SYNC_PROTOCOL_VERSION.major

/**
 * 校验客户端协议版本。
 *
 * 用契约的 `isProtocolCompatible` 而不是自己比数字：兼容规则（只看主版本）属于契约，
 * 服务端重复实现一份就会在主版本策略变化时漂移。
 */
export function assertProtocolVersion(protocolVersion: unknown, requestId: RequestId): void {
  const major = typeof protocolVersion === 'number' && Number.isInteger(protocolVersion) ? protocolVersion : Number.NaN
  if (!Number.isInteger(major) || !isProtocolCompatible({ major, minor: 0 })) {
    throw new ContractError({
      code: 'SYNC_PROTOCOL_MISMATCH',
      message: '客户端同步协议版本与服务端不兼容。',
      requestId,
      detail: {
        field: 'protocolVersion',
        client: Number.isInteger(major) ? major : 'invalid',
        expected: SYNC_PROTOCOL_VERSION.major,
      },
    })
  }
}

/** ID 形状校验（契约的 `isWellFormedId`）。不通过就是 400 的 `VALIDATION_MALFORMED_ID`。 */
export function requireWellFormedId(value: unknown, field: string, requestId: RequestId): string {
  if (!isWellFormedId(value)) {
    throw new ContractError({
      code: 'VALIDATION_MALFORMED_ID',
      message: `${field} 不是合法的标识符。`,
      requestId,
      detail: { field },
    })
  }
  return value
}

/** 批次（或实体）太大。**必须**和 `capabilities.limits` 上报的数字一致。 */
export function payloadTooLargeError(requestId: RequestId, detail: Record<string, string | number | null>): ContractError {
  return new ContractError({
    code: 'PAYLOAD_TOO_LARGE',
    message: '请求超过服务端允许的上限，请拆分后重试。',
    requestId,
    detail,
  })
}

/** 游标不可用（格式非法 / 属于别的工作区 / 超出服务端当前提交位置）→ 410。 */
export function cursorInvalidError(requestId: RequestId, detail: Record<string, string | number | null>): ContractError {
  return new ContractError({
    code: 'SYNC_CURSOR_INVALID',
    message: '游标已失效，请重新拉取快照。',
    requestId,
    detail,
  })
}

/** 把 `server_seq` 编成该工作区的游标。 */
export function encodeWorkspaceCursor(serverSeq: number, workspaceId: WorkspaceId): Cursor {
  return encodeCursor(serverSeq, workspaceId)
}

/**
 * 解析本工作区的游标。
 *
 * 只做**形状 + 归属**校验（格式、scope、非负整数）；"是否超出服务端当前提交位置"
 * 需要知道 head，由调用方在同一事务里判定（见 `db/sync.ts` 的 `assertCursorWithinHead`）。
 */
export function parseWorkspaceCursor(cursor: string, workspaceId: WorkspaceId, requestId: RequestId): number {
  if (cursor.length === 0 || cursor.length > 256) {
    throw cursorInvalidError(requestId, { reason: 'malformed' })
  }
  const separator = cursor.indexOf(':')
  if (separator <= 0) {
    throw cursorInvalidError(requestId, { reason: 'malformed' })
  }
  const scope = cursor.slice(0, separator)
  const digits = cursor.slice(separator + 1)
  if (scope !== workspaceId) {
    // 明确只回 reason，绝不回显客户端传来的 scope（可能是别人的 workspaceId）。
    throw cursorInvalidError(requestId, { reason: 'workspace_mismatch' })
  }
  if (!/^[0-9a-z]{1,11}$/.test(digits)) {
    throw cursorInvalidError(requestId, { reason: 'malformed' })
  }
  const seq = Number.parseInt(digits, 36)
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw cursorInvalidError(requestId, { reason: 'malformed' })
  }
  return seq
}

/** 解析分页参数。缺省用默认值，越界/非法 → `VALIDATION_OUT_OF_RANGE`（400）。 */
export function parseLimit(raw: unknown, field: string, fallback: number, max: number, requestId: RequestId): number {
  if (raw === undefined || raw === null || raw === '') {
    return fallback
  }
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : ''
  if (!/^[0-9]{1,7}$/.test(text)) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `${field} 必须是 1 到 ${max} 之间的整数。`,
      requestId,
      detail: { field, min: 1, max },
    })
  }
  const value = Number.parseInt(text, 10)
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `${field} 必须是 1 到 ${max} 之间的整数。`,
      requestId,
      detail: { field, min: 1, max },
    })
  }
  return value
}
