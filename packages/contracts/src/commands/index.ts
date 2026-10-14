/**
 * 命令契约：桌面 IPC 与后端 HTTP **共用同一套语义**。
 *
 * 设计约束（`01-总体架构.md`）："IPC 与 HTTP 共用命令语义与错误分类，
 * 首版 REST + SSE"。这意味着同一件事（比如保存草稿）在两条传输上的
 * 入参/出参形状必须一致，只有封装不同：
 *
 * | | 桌面 IPC | 后端 HTTP |
 * | --- | --- | --- |
 * | 传输 | `utilityProcess` 消息 | REST + SSE |
 * | 主体 | 宿主注入的本地主体 | 会话令牌解析出的主体 |
 * | 错误 | `ErrorPayload` | 同左，映射为 HTTP 状态码 |
 *
 * 🔴 授权主体**必须由宿主提供**，绝不接受 payload 自报的角色
 * （`01-总体架构.md`：不能凭 payload 提权）。
 */

import type {
  Cursor,
  DocumentId,
  IdempotencyKey,
  JobId,
  ProjectId,
  RequestId,
  Revision,
  UtcTimestamp,
  WorkspaceId,
} from '../ids.js'
import type { DocumentKind, DocumentSummary } from '../entities/index.js'

// ---------------------------------------------------------------------------
// 请求封装：每个命令都带的公共头
// ---------------------------------------------------------------------------

/**
 * 写入命令的公共元数据。
 *
 * 四项缺一不可：
 * - `requestId` 用于日志串联与幂等（`10-开发规范与环境.md`）；
 * - `expectedRevision` 是乐观锁，缺了就会静默覆盖别人的修改；
 * - `workspaceId`/`projectId` 让「当前作品」不依赖模块级可变单例
 *   （明确禁令：不得新增可变的"当前作品"服务单例）。
 */
export interface WriteContext {
  readonly requestId: RequestId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId | null
  /** 期望的当前版本；新建实体传 null。 */
  readonly expectedRevision: Revision | null
  /** 幂等键：同一 key 重复提交必须返回同一结果，绝不二次写入。 */
  readonly idempotencyKey?: IdempotencyKey
}

/** 只读命令的公共元数据：不需要版本与幂等键。 */
export interface ReadContext {
  readonly requestId: RequestId
  readonly workspaceId: WorkspaceId
}

// ---------------------------------------------------------------------------
// 草稿保存（本项目最关键的一条命令）
// ---------------------------------------------------------------------------

/**
 * 保存草稿。
 *
 * `draftSequence` 是**单调递增**的编辑器本地序号，不是数据库修订号：
 * 它解决的是"迟到回包覆盖新稿"问题——保存结果只确认它对应的那个序号，
 * 更旧的序号即使后到也只能被忽略（`02-桌面与界面.md`）。
 */
export interface SaveDraftInput {
  readonly context: WriteContext
  readonly documentId: DocumentId
  readonly draftSequence: number
  /** 已归一化的正文（`@yfe/domain` 的 `normalizeBody`）。 */
  readonly body: string
  /** 编辑器会话 ID：同一章节可能同时有两个窗口，靠它区分草稿水位线。 */
  readonly sessionId: string
}

export interface SaveDraftOutput {
  readonly revision: Revision
  readonly draftSequence: number
  /** 按 `countChars` 计算的字符数，**每次重算**而不是读缓存。 */
  readonly charCount: number
  readonly savedAt: UtcTimestamp
}

// ---------------------------------------------------------------------------
// 作品与文档
// ---------------------------------------------------------------------------

export interface ProjectCreateInput {
  readonly context: WriteContext
  readonly name: string
  readonly summary?: string
  /** 是否自动建卷并写入第一章占位。 */
  readonly seedFirstChapter?: boolean
  readonly templateId?: string
}

export interface ProjectCreateOutput {
  readonly projectId: ProjectId
  readonly revision: Revision
}

export interface DocumentCreateInput {
  readonly context: WriteContext
  readonly projectId: ProjectId
  readonly kind: DocumentKind
  readonly parentId: DocumentId | null
  readonly title: string
  /**
   * 插入位置。
   *
   * 用「末位」或「某节点之后」而不是显式 orderKey：调用方不该关心
   * 分数索引的具体取值，那是存储层的实现细节。
   */
  readonly placement: { readonly mode: 'end' } | { readonly mode: 'after'; readonly afterId: DocumentId }
}

export interface DocumentCreateOutput {
  readonly documentId: DocumentId
  readonly revision: Revision
  readonly orderKey: string
}

/** 文档树：**平铺**返回，不含正文（列表接口带正文会拖垮大作品）。 */
export interface DocumentTreeInput {
  readonly context: ReadContext
  readonly projectId: ProjectId
  /** 只返回未删除节点；true 时包含墓碑（回收站视图）。 */
  readonly includeDeleted?: boolean
}

export interface DocumentTreeOutput {
  readonly documents: readonly DocumentSummary[]
}

export interface DocumentGetInput {
  readonly context: ReadContext
  readonly documentId: DocumentId
}

export interface DocumentGetOutput {
  readonly document: DocumentSummary
  readonly body: string
}

/** 文档重命名 / 移动 / 软删共用一个入参：只传要改的字段。 */
export interface DocumentUpdateInput {
  readonly context: WriteContext
  readonly documentId: DocumentId
  readonly title?: string
  readonly parentId?: DocumentId | null
  readonly placement?: { readonly mode: 'end' } | { readonly mode: 'after'; readonly afterId: DocumentId }
}

export interface DocumentUpdateOutput {
  readonly revision: Revision
}

// ---------------------------------------------------------------------------
// 系统状态
// ---------------------------------------------------------------------------

/**
 * 系统状态：启动自检与「健康」展示使用。
 *
 * 设计文档 `01-总体架构.md` 要求分别管理五个版本号：应用版本、
 * `databaseSchemaVersion`、`syncProtocolVersion`、`pluginApiVersion`、
 * 资源模板版本。排查问题时第一眼就要能看到它们的实际值。
 *
 * ⚠️ `resourceTemplateVersion` 记录**资源模板包**（主题/模板/工作流包）的版本，
 * 与上面四个版本相互独立演进（P5 才引入模板分发，此处先占位，
 * 未装载任何模板包时为 `null`）。它与 `pluginApiVersion` 不是一回事：
 * 后者是插件**宿主 API 的兼容契约**，前者是**内容包的修订号**。
 */
export interface SystemStatusOutput {
  readonly appVersion: string
  readonly databaseSchemaVersion: number
  readonly syncProtocolVersion: { readonly major: number; readonly minor: number }
  readonly pluginApiVersion: string
  /** 已装载资源模板包的版本；未装载为 `null`。 */
  readonly resourceTemplateVersion: string | null
  /** 数据目录路径，仅供设置页展示，**不写入同步数据**。 */
  readonly databasePath: string
  readonly readOnly: boolean
  readonly lastSavedAt: UtcTimestamp | null
  /** 未推送的操作数：UI 的「待同步」角标读这个值。 */
  readonly pendingOutboxCount: number
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export interface JobSubmitInput {
  readonly context: WriteContext
  readonly kind: string
  readonly executor: string
  readonly priority?: number
  /** 不可变输入版本：任务执行期间输入变化会让结果不可解释。 */
  readonly inputRevision: Revision | null
  readonly payload: Readonly<Record<string, unknown>>
}

export interface JobSubmitOutput {
  readonly jobId: JobId
}

export interface JobCancelInput {
  readonly context: ReadContext
  readonly jobId: JobId
  readonly reason?: string
}

/**
 * 取消结果。
 *
 * 🔴 刻意区分 `cancelling` 与 `cancelled`：取消是**请求**不是事实。
 * 只有执行器确认或租约失效后才是终态（`08-任务与AI.md`）。
 */
export interface JobCancelOutput {
  readonly status: 'cancelling' | 'cancelled' | 'already-terminal'
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

export interface PageRequest {
  readonly cursor?: Cursor
  /** 上限由服务端 `capabilities` 决定，客户端请求值只是期望。 */
  readonly limit?: number
}

export interface PageResult<T> {
  readonly items: readonly T[]
  /** 下一页游标；null 表示已到末尾。**不得数值化**。 */
  readonly nextCursor: Cursor | null
}
