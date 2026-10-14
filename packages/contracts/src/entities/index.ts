/**
 * 实体契约：跨端共享的数据形状。
 *
 * 设计约束（见 `06-数据与本地存储.md`）：
 * - 实体 ID 由客户端生成随机 UUID，离线可创建，不依赖服务端分配。
 * - `revision` 是不透明字符串，只做相等比较。
 * - 所有时间戳是 UTC ISO-8601 字符串，仅用于展示与审计。
 * - `deleted` 用 0/1 数值标志而非物理删除：墓碑必须能被同步协议看见。
 *
 * 🔴 这些类型同时服务桌面端、后端与（未来的）移动端，是本项目最重要的
 * 兼容面。一旦发布，**只能新增可选字段**，不得改义或删除既有字段。
 */

import type {
  AssetId,
  AttachmentId,
  ChapterId,
  CharacterId,
  DeviceId,
  DocumentId,
  JobId,
  MaterialId,
  ProjectId,
  Revision,
  SnapshotId,
  UserId,
  UtcTimestamp,
  VolumeId,
  WorkspaceId,
} from '../ids.js'

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/**
 * 软删除标志。
 *
 * 类型写成 `0 | number` 而非 `boolean`：SQLite 返回的是整数，
 * 而比较时必须用 `!== 0`（历史数据可能存在非 0/1 的脏值）。
 */
export type DeletedFlag = 0 | number

export interface SoftDeletable {
  readonly deleted: DeletedFlag
}

export interface Versioned {
  /** 不透明修订号。禁止排序、禁止算术、禁止用时间戳推断新旧。 */
  readonly revision: Revision
}

export interface Timestamped {
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

/** 所有工作区实体共有的基底。 */
export interface WorkspaceEntity extends SoftDeletable, Versioned, Timestamped {
  readonly id: string
  readonly workspaceId: WorkspaceId
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

export interface Workspace extends Versioned, Timestamped {
  readonly id: WorkspaceId
  readonly name: string
  readonly deleted: DeletedFlag
  /** 权威同步目标标识；同一工作区只能有一个权威目标（`01-总体架构.md`）。 */
  readonly authorityTargetId: string | null
}

// ---------------------------------------------------------------------------
// 作品
// ---------------------------------------------------------------------------

export interface Project extends WorkspaceEntity {
  readonly id: ProjectId
  readonly name: string
  readonly summary: string
  /** 作品类型（如 `full` / 题材包 ID），决定启用哪些功能面板。 */
  readonly projectType: string
}

// ---------------------------------------------------------------------------
// 文档（卷 / 章 / 大纲 / 笔记统一为 Document）
// ---------------------------------------------------------------------------

/**
 * 文档种类。
 *
 * 设计取舍：卷与章**统一到同一张表**，用 `kind` 区分，而不是 `volumes` + `chapters` 两张表。
 * 理由：章节树是任意深度的，两表模型在「卷下再分卷」或「笔记挂在大纲下」时会退化成
 * 多态外键。统一表 + `parentId` 让树操作（移动、排序、级联软删）只有一套实现。
 */
export type DocumentKind = 'volume' | 'chapter' | 'outline' | 'note'

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['volume', 'chapter', 'outline', 'note']

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value)
}

export interface Document extends WorkspaceEntity {
  readonly id: DocumentId
  readonly projectId: ProjectId
  readonly kind: DocumentKind
  /** 父节点 ID；顶层文档为 null。 */
  readonly parentId: DocumentId | null
  /**
   * 同级排序键。
   *
   * 不透明字符串（分数索引 / fractional index）：在两节点间插入时
   * **只改一个键**，不需要重排整棵树的兄弟节点，因此并发拖动不会互相打架。
   */
  readonly orderKey: string
  readonly title: string
  readonly body: string
}

/**
 * 文档摘要：树与列表视图使用，**不含正文**。
 *
 * 列表接口返回正文会让 1000 章的作品每次拉取数十 MB，
 * 因此正文字段被刻意排除在类型之外（不是可选，是根本不存在）。
 */
export type DocumentSummary = Omit<Document, 'body' | 'workspaceId'> & {
  /** 字符数按 `@yfe/domain` 的 `countChars` 计算，不从缓存读取。 */
  readonly charCount: number
  readonly hasChildren: boolean
}

// ---------------------------------------------------------------------------
// 设定实体（动态 Schema）
// ---------------------------------------------------------------------------

/**
 * 设定实体。
 *
 * 世界观设定是**用户可自定义字段**的：人物、势力、地点、物品、时间线共用此表，
 * 字段定义存在 `schemaTemplateId` 指向的模板里，值以 JSON 存在 `values` 中。
 * 数据库不为此建列——否则用户每加一个字段都要迁移表结构。
 */
export interface SettingsEntity extends WorkspaceEntity {
  readonly id: string
  readonly projectId: ProjectId
  /** 模板 ID：决定 `values` 里有哪些字段与校验规则。 */
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly orderKey: string
}

// ---------------------------------------------------------------------------
// 关系（人物关系图 / 实体引用）
// ---------------------------------------------------------------------------

export type RelationKind = 'character' | 'reference' | 'timeline' | 'custom'

export interface Relation extends WorkspaceEntity {
  readonly id: string
  readonly projectId: ProjectId
  readonly kind: RelationKind
  readonly fromEntityId: string
  readonly toEntityId: string
  /** 关系标签（如「师徒」「宿敌」）。 */
  readonly label: string
  readonly values: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// 版本与操作（同步的基石）
// ---------------------------------------------------------------------------

/**
 * 修订记录：每次正文变更留一份快照。
 *
 * 设计取舍：初期**按章存完整文本**，不做字符级 CRDT（`06-数据与本地存储.md` 明确禁止自制 CRDT）。
 * 理由：自研 CRDT 的正确性风险远高于它节省的存储；章节文本压缩后完全可接受。
 */
export interface RevisionRecord {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly revision: Revision
  /** 变更前的版本；新建实体为 null。 */
  readonly baseRevision: Revision | null
  readonly bodySnapshot: string | null
  readonly valuesSnapshot: string | null
  readonly createdAt: UtcTimestamp
}

export type OperationAction = 'upsert' | 'delete'

/**
 * 操作记录：同步协议的最小传输单元。
 *
 * 与 `RevisionRecord` 的区别：revision 面向「历史回溯」，operation 面向「传输给对端」。
 * 一次跨实体改动共享同一 `batchId`，保证在单事务内提交。
 */
export interface OperationRecord {
  readonly opId: string
  readonly batchId: string
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly projectId: ProjectId | null
  readonly baseRevision: Revision | null
  readonly newRevision: Revision
  readonly action: OperationAction
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdAt: UtcTimestamp
}

/**
 * 发件箱：本地已提交但**尚未被权威目标确认**的操作。
 *
 * 这是「离线优先」的核心数据结构：本地保存必须能在完全离线时成功，
 * 因此操作先入 outbox，再由同步引擎异步推送。
 * 🔴 推送成功前不得从 outbox 删除；失败也不得消耗（否则用户改动永久丢失）。
 */
export interface OutboxEntry {
  readonly opId: string
  readonly workspaceId: WorkspaceId
  readonly batchId: string
  /** 同步目标标识；本地模式为 `local`。 */
  readonly targetId: string
  readonly attemptCount: number
  readonly nextAttemptAt: UtcTimestamp | null
  readonly lastErrorCode: string | null
  readonly createdAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 本地草稿（未确认的输入缓冲）
// ---------------------------------------------------------------------------

/**
 * 本地草稿：编辑器与已保存正文之间的缓冲区。
 *
 * 设计约束（`06-数据与本地存储.md`）：
 * - 序号单调递增；**确认后不删行**，只更新 `confirmedRevision` 并清空 body。
 *   删行会让「同序号重试」被误判为新草稿，产生重复 operation。
 * - 确认水位线用于幂等重放：同序号 + 已确认 → 直接返回原 revision，不重复写入。
 */
export interface LocalDraft {
  readonly documentId: DocumentId
  readonly sessionId: string
  readonly sequence: number
  readonly body: string
  readonly baseRevision: Revision | null
  /** 已确认的版本；null 表示尚未写库。 */
  readonly confirmedRevision: Revision | null
  readonly updatedAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 附件
// ---------------------------------------------------------------------------

/**
 * 附件：内容与引用分离。
 *
 * 🔴 `storageKey` 是**逻辑键**，绝不是 Windows 绝对路径：路径会随设备变化，
 * 写进同步数据会在另一端变成无效引用（`06-数据与本地存储.md`）。
 * 跨用户去重时不得泄露「他人是否持有此文件」——因此引用校验必须带权限。
 */
export interface Asset {
  readonly id: AssetId
  readonly workspaceId: WorkspaceId
  readonly attachmentId: AttachmentId | null
  /** 逻辑存储键（不透明）。 */
  readonly storageKey: string
  readonly byteSize: number
  /** SHA-256 十六进制摘要。 */
  readonly sha256: string
  readonly mimeType: string
  readonly originalName: string
  readonly deleted: DeletedFlag
  readonly createdAt: UtcTimestamp
}

/** 附件引用：删除附件前必须先处理引用，否则产生悬空引用。 */
export interface AssetRef {
  readonly assetId: AssetId
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly createdAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

export interface Snapshot {
  readonly id: SnapshotId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId | null
  readonly label: string
  /** 该快照覆盖到的同步游标，用于「恢复到某一致点」。 */
  readonly cursor: string | null
  readonly byteSize: number
  readonly createdAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/**
 * 任务状态机（`08-任务与AI.md`）。
 *
 * `waiting_network` / `waiting_confirmation` / `paused` 是**持久等待态**：
 * 重启后必须能恢复到这些状态，而不是被当成失败重跑。
 * `cancelling` 是过渡态：只有执行器确认或租约失效后才进入 `cancelled`。
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_network'
  | 'waiting_confirmation'
  | 'paused'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled']

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status)
}

export interface Job {
  readonly id: JobId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId | null
  readonly kind: string
  readonly executor: string
  readonly status: JobStatus
  /** 不可变输入版本：任务执行期间输入不得变化，否则结果不可解释。 */
  readonly inputRevision: Revision | null
  readonly configRevision: Revision | null
  readonly priority: number
  readonly attempt: number
  readonly checkpoint: string | null
  readonly outputRef: string | null
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

export type ConflictKind = 'text-diverged' | 'delete-vs-edit' | 'schema-drift' | 'field-template'

export type ConflictResolution = 'local-wins' | 'remote-wins' | 'merged' | 'pending'

export interface Conflict {
  readonly id: string
  readonly workspaceId: WorkspaceId
  readonly entityType: string
  readonly entityId: string
  readonly kind: ConflictKind
  readonly baseRevision: Revision | null
  readonly localRevision: Revision
  /** 远端**影子版本**：先存下来，不直接覆盖输入框。 */
  readonly remoteRevision: Revision
  readonly remotePayload: string | null
  readonly resolution: ConflictResolution
  readonly createdAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 用户与设备（后端）
// ---------------------------------------------------------------------------

export type WorkspaceRole = 'admin' | 'owner' | 'editor' | 'viewer'

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'owner', 'editor', 'viewer']

/**
 * 角色权限矩阵（`04-后端与安全.md`）。
 *
 * 实现要点：每个查询、下载、游标、任务订阅、写入都要**重新鉴权**，
 * 不允许在会话建立时判定一次就长期信任。
 */
export function canWrite(role: WorkspaceRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'editor'
}

export function canManageMembers(role: WorkspaceRole): boolean {
  return role === 'admin' || role === 'owner'
}

export function canRunRemoteCommand(role: WorkspaceRole): boolean {
  return role === 'admin' || role === 'owner'
}

export interface User {
  readonly id: UserId
  readonly username: string
  readonly displayName: string
  readonly disabled: boolean
  readonly createdAt: UtcTimestamp
}

export interface Device {
  readonly id: DeviceId
  readonly userId: UserId
  readonly name: string
  /** 最近活动时间，仅用于展示与审计，不用于冲突裁决。 */
  readonly lastSeenAt: UtcTimestamp | null
  readonly revokedAt: UtcTimestamp | null
  readonly createdAt: UtcTimestamp
}

export interface WorkspaceMember {
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly role: WorkspaceRole
  readonly createdAt: UtcTimestamp
}

/** 素材库条目。 */
export interface Material extends WorkspaceEntity {
  readonly id: MaterialId
  readonly projectId: ProjectId | null
  readonly title: string
  readonly body: string
  readonly tags: readonly string[]
}

/** 人物卡（与 SettingsEntity 分离：人物字段是固定的，不走动态模板）。 */
export interface Character extends WorkspaceEntity {
  readonly id: CharacterId
  readonly projectId: ProjectId
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly orderKey: string
}

/** 卷（保留独立类型以便旧数据映射；新实现中卷也是 Document）。 */
export type VolumeRef = { readonly id: VolumeId; readonly title: string }

/** 章（同上）。 */
export type ChapterRef = { readonly id: ChapterId; readonly title: string }
