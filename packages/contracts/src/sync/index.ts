/**
 * 同步协议契约（v1）。
 *
 * 设计约束（`07-同步协议与API.md`）：路径前缀 `/api/v1`，日期 UTC，
 * ID/revision/cursor 一律字符串，附件摘要 SHA-256，JSON 为 UTF-8。
 *
 * 三条不可妥协的规则：
 * 1. **全部接受或全部拒绝**：首版不支持部分成功。一个批次里任何操作
 *    验证失败，整批回滚，客户端拿到可读的冲突元数据后重新组织。
 * 2. **主体从认证上下文取，不从 payload 取**：`deviceId`/`workspaceId`
 *    以路径与令牌为准，payload 里同名字段只做交叉校验，不一致即拒绝。
 * 3. **幂等键与载荷绑定**：同一 `opId` 配不同载荷 → `IDEMPOTENCY_KEY_REUSED`，
 *    绝不二次写入（否则会静默覆盖已确认的数据）。
 */

import type {
  Cursor,
  IdempotencyKey,
  ProjectId,
  Revision,
  RequestId,
  UtcTimestamp,
  WorkspaceId,
} from '../ids.js'
import type { OperationAction } from '../entities/index.js'

// ---------------------------------------------------------------------------
// 能力协商
// ---------------------------------------------------------------------------

/**
 * 服务端能力声明。
 *
 * 客户端拿到之后要**降级运行**而不是拒之门外：协议主版本不兼容时
 * 保留本地编辑、停止推送并提示，**不能当成空服务重新初始化**
 * （否则用户会以为自己的作品丢了）。
 */
export interface CapabilitiesOutput {
  readonly serverId: string
  readonly protocolVersion: { readonly major: number; readonly minor: number }
  /** 服务端支持的最低客户端主版本。 */
  readonly minClientMajor: number
  readonly limits: {
    /** 单批次最大操作数（初始 100）。 */
    readonly maxOperationsPerBatch: number
    /** 单批次最大字节数（初始 4 MiB）。 */
    readonly maxBatchBytes: number
    /** 分数索引 orderKey 单段最大长度。 */
    readonly maxOrderKeyLength: number
  }
  readonly assets: {
    readonly enabled: boolean
    /** 分片上传的分片大小。 */
    readonly partSizeBytes: number
    readonly maxAssetBytes: number
  }
  /** 支持的远程命令类型。首版仅这三种。 */
  readonly commands: readonly RemoteCommandType[]
  /** 服务端是否处于只读维护模式。 */
  readonly readOnly: boolean
}

// ---------------------------------------------------------------------------
// 变更批次
// ---------------------------------------------------------------------------

/**
 * 一个操作。
 *
 * `baseRevision` 是**乐观锁**：服务端拿它与当前版本比较，
 * 不相等即整批拒绝。新建实体的 `baseRevision` 为 null。
 */
export interface SyncOperation {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  /** 变更前版本；新建为 null。 */
  readonly baseRevision: Revision | null
  /** 变更后版本，由**客户端**生成（离线也要能版本化）。 */
  readonly newRevision: Revision
  readonly action: OperationAction
  readonly payload: Readonly<Record<string, unknown>>
  /** 本操作引用的附件；服务端校验引用权限后才接受。 */
  readonly assetIds: readonly string[]
}

/**
 * 提交批次。
 *
 * 🔴 `protocolVersion` 放在请求体里而不是只靠 HTTP 头：批次可能被
 * 中间层缓存或转发，版本必须跟着数据走。
 */
export interface BatchSubmitInput {
  readonly protocolVersion: number
  readonly batchId: string
  /**
   * 提交设备。
   *
   * 服务端会与认证上下文里的设备比对，**不一致直接拒绝**：
   * 否则被撤销的设备可以冒用其他设备身份继续推送。
   */
  readonly deviceId: string
  readonly workspaceId: WorkspaceId
  readonly operations: readonly SyncOperation[]
  /** 客户端期望的幂等键；服务端也按 `opId` 做二次防护。 */
  readonly idempotencyKey?: IdempotencyKey
}

export type BatchSubmitOutput =
  | {
      readonly ok: true
      readonly batchId: string
      /** 服务器按提交顺序产生的游标，客户端据此推进本地 checkpoint。 */
      readonly cursor: Cursor
      readonly acceptedAt: UtcTimestamp
      /** 本批次涉及实体的服务端权威版本（可能因服务端归一化而与提交值不同）。 */
      readonly revisions: readonly { readonly entityId: string; readonly revision: Revision }[]
      /** 已是幂等重放：未二次写入，返回原始结果。 */
      readonly replayed?: boolean
    }
  | {
      readonly ok: false
      /** 整批被拒的稳定错误码（如 `REVISION_CONFLICT`）。 */
      readonly code: string
      readonly requestId: RequestId
      /** 被拒操作的冲突元数据，供 UI 展示"双方版本"对比。 */
      readonly conflicts: readonly OperationConflict[]
    }

export interface OperationConflict {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly expectedBaseRevision: Revision | null
  readonly currentRevision: Revision | null
  readonly reason: 'revision-mismatch' | 'entity-deleted' | 'permission' | 'invalid-payload'
}

// ---------------------------------------------------------------------------
// 增量拉取
// ---------------------------------------------------------------------------

/**
 * 增量变更请求。
 *
 * 游标过期（服务端保留窗口外）返回 `SYNC_CURSOR_INVALID` / HTTP 410，
 * 客户端**先保存离线分支再下载快照重放**，绝不清空未同步稿件。
 */
export interface ChangesInput {
  readonly workspaceId: WorkspaceId
  readonly cursor: Cursor | null
  readonly limit?: number
}

export interface ChangeEntry {
  readonly cursor: Cursor
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly action: OperationAction
  readonly revision: Revision
  readonly baseRevision: Revision | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly committedAt: UtcTimestamp
  /** 产生此变更的服务器提交序号，仅用于排序展示。 */
  readonly serverSeq: number
}

export interface ChangesOutput {
  readonly changes: readonly ChangeEntry[]
  readonly nextCursor: Cursor | null
  /** 游标已过期，客户端必须走全量重同步。 */
  readonly resyncRequired: boolean
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/**
 * 工作区快照：一个**固定一致点**及其游标。
 *
 * 用于新设备首次同步与游标过期后的全量重同步。返回的 `cursor`
 * 让客户端知道"快照对应到哪个变更点"，从而只补拉之后的增量。
 */
export interface SnapshotInput {
  readonly workspaceId: WorkspaceId
  readonly projectId?: ProjectId
}

export interface SnapshotOutput {
  readonly cursor: Cursor
  readonly takenAt: UtcTimestamp
  readonly projects: readonly Record<string, unknown>[]
  readonly documents: readonly Record<string, unknown>[]
  readonly settingsEntities: readonly Record<string, unknown>[]
  readonly relations: readonly Record<string, unknown>[]
  readonly assets: readonly Record<string, unknown>[]
  /** 分页：快照可能很大，`nextCursor` 为 null 时表示结束。 */
  readonly nextCursor: Cursor | null
}

// ---------------------------------------------------------------------------
// 幂等回执
// ---------------------------------------------------------------------------

/**
 * 批次回执。
 *
 * 服务端必须保留幂等回执至少覆盖增量窗口：客户端在断网重试时
 * 会重复提交同一批次，此时必须拿回**原来的结果**而不是重新执行。
 */
export interface ReceiptOutput {
  readonly batchId: string
  readonly deviceId: string
  readonly acceptedAt: UtcTimestamp
  readonly operationCount: number
  readonly cursor: Cursor
  /**
   * 载荷摘要（规范化后计算）。
   *
   * 同一 `batchId` 配不同摘要 → `IDEMPOTENCY_KEY_REUSED`。
   * 摘要把"重试"和"篡改"区分开。
   */
  readonly payloadDigest: string
}

// ---------------------------------------------------------------------------
// 远程命令
// ---------------------------------------------------------------------------

/** 首版只允许这三种命令：不开放任意代码执行（ADR 008）。 */
export type RemoteCommandType = 'workflow.run' | 'job.cancel' | 'sync.trigger'

export type RemoteCommandStatus = 'pending' | 'claimed' | 'acked' | 'expired' | 'failed'

export interface RemoteCommand {
  readonly commandId: string
  readonly workspaceId: WorkspaceId
  readonly targetDeviceId: string
  readonly commandType: RemoteCommandType
  readonly args: Readonly<Record<string, unknown>>
  readonly expiresAt: UtcTimestamp
  /**
   * 签发者。
   *
   * 🔴 **由服务端会话产生，不接受客户端自报**：否则任何设备都能伪造
   * "管理员下的命令"。客户端侧同名字段只用于展示。
   */
  readonly issuer: string
  readonly status: RemoteCommandStatus
  readonly createdAt: UtcTimestamp
}

export interface CommandClaimOutput {
  readonly command: RemoteCommand | null
  /**
   * 租约到期时间。
   *
   * 用租约而不是"领取即删除"：设备领取后崩溃，命令必须能在租约
   * 失效后重新被领取，否则命令永久卡死。
   */
  readonly leaseExpiresAt: UtcTimestamp | null
}

export interface CommandAckInput {
  readonly commandId: string
  /**
   * 执行 ID。
   *
   * 重复投递同一命令必须只返回**原执行结果**：设备重连后可能重复
   * 上报，服务端据此去重。
   */
  readonly executionId: string
  readonly status: 'succeeded' | 'failed'
  readonly result?: Readonly<Record<string, unknown>>
  readonly errorCode?: string
}

// ---------------------------------------------------------------------------
// 健康检查（在 API 前缀之外）
// ---------------------------------------------------------------------------

export interface HealthLiveOutput {
  readonly status: 'live'
  readonly uptimeSeconds: number
}

/**
 * 就绪探针：容器健康检查用它。
 *
 * 区分 live 与 ready 是刻意的：进程活着但数据库迁移未完成时，
 * `live` 应为 200 而 `ready` 必须失败，否则负载均衡会把流量
 * 打到一个读不了数据的实例上。
 */
export interface HealthReadyOutput {
  readonly status: 'ready' | 'not-ready'
  readonly database: 'ok' | 'migrating' | 'unavailable' | 'too-new'
  readonly disk: 'ok' | 'low' | 'full'
  /** 队列积压，运维据此判断是否需要扩容或排查。 */
  readonly queueDepth: number
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail?: string }[]
}

// ---------------------------------------------------------------------------
// SSE 事件
// ---------------------------------------------------------------------------

/**
 * 服务端推送事件。
 *
 * 🔴 流事件**只是通知**，不是最终结果：数据库与任务状态才是权威
 * （`01-总体架构.md`）。因此事件只带实体 ID、版本与最小差异，
 * 客户端收到后要回查或按游标增量拉取，不能凭事件内容直接改库。
 */
export type SyncEvent =
  | { readonly type: 'hello'; readonly serverId: string; readonly cursor: Cursor }
  | { readonly type: 'change'; readonly cursor: Cursor; readonly entityIds: readonly string[] }
  | { readonly type: 'job'; readonly jobId: string; readonly status: string }
  | { readonly type: 'command'; readonly commandId: string }
  | { readonly type: 'ping'; readonly at: UtcTimestamp }
