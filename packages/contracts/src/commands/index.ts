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
import type { DocumentKind, DocumentSummary, Project, SettingsEntity } from '../entities/index.js'

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
  /** 只有发生重排时才有值（调用方用它免重拉整棵树）。 */
  readonly orderKey?: string
}

/**
 * 文档软删（默认级联整棵子树）。
 *
 * 软删（`deleted` 标记）而不是物理删：回收站视图与同步墓碑都依赖它
 * （设计文档 07：删除用基线生成墓碑）。级联删除也是「这些实体变了」，
 * 版本号由存储层逐行推进。
 */
export interface DocumentDeleteInput {
  readonly context: WriteContext
  readonly documentId: DocumentId
}

export interface DocumentDeleteOutput {
  readonly revision: Revision
  /** 实际软删的条数（级联时含子树）。 */
  readonly deletedCount: number
}

// ---------------------------------------------------------------------------
// 设定实体（settings_entities）
// ---------------------------------------------------------------------------

/**
 * 列出设定实体。
 *
 * 动态字段（「姓名」「境界」这些由模板决定的列）统一放在 `values` JSON 里，
 * 数据库不为它们建列——否则每加一个字段都要迁移表结构
 * （见 `persistence-sqlite` 的 `stringifyValues`）。
 *
 * `projectId` 省略时是**工作区级**列表（跨作品），否则只列该作品下的实体。
 * `schemaTemplateId` 只做模板过滤，不改变排序：排序始终由 `orderKey` 决定。
 */
export interface SettingsEntityListInput {
  readonly context: ReadContext
  /** 省略 = 列出该工作区下的全部设定实体。 */
  readonly projectId?: ProjectId
  readonly schemaTemplateId?: string
  readonly includeDeleted?: boolean
}

export interface SettingsEntityListOutput {
  readonly entities: readonly SettingsEntity[]
}

/** 读取单个设定实体；已软删的实体默认不可见（`includeDeleted` 走列表接口）。 */
export interface SettingsEntityGetInput {
  readonly context: ReadContext
  readonly entityId: string
}

export interface SettingsEntityGetOutput {
  readonly entity: SettingsEntity
}

/**
 * 新建（`entityId` 省略或 `null`）或更新（给出 `entityId`）设定实体。
 *
 * - 新建要求 `context.expectedRevision === null`，与其它新建命令一致；
 * - 更新走 `context.expectedRevision` 乐观锁，过期返回 `REVISION_CONFLICT`；
 * - `values` 是**整体替换**而不是深合并：深合并会让「删掉一个字段」
 *   变得无法表达，而模板字段是可增可减的；
 * - `orderKey` 是可选的位置覆盖：给了就按它排序（调用方自备分数索引），
 *   不给则由存储层按末位追加。
 */
export interface SettingsEntitySaveInput {
  readonly context: WriteContext
  /** 缺省或 `null` = 新建；给出实体 ID = 更新。 */
  readonly entityId?: string | null
  readonly projectId: ProjectId
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly orderKey?: string | null
}

export interface SettingsEntitySaveOutput {
  readonly entityId: string
  readonly revision: Revision
  readonly orderKey: string
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

// ---------------------------------------------------------------------------
// AI（面板层，桌面主进程执行模型请求）
// ---------------------------------------------------------------------------

/**
 * 一条对话消息。
 *
 * `role` 刻意只留 `user` / `assistant`：system 走独立字段（OpenAI 兼容接口的
 * `messages[0].role === 'system'` 由主进程拼装），面板层不自己拼系统消息。
 */
export interface AiMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/**
 * 一次模型补全请求（渲染层 → 主进程）。
 *
 * 🔴 模型请求只能在 main 进程发（渲染层 CSP `connect-src 'none'`），
 *    因此 `config` 里的 `apiKey` 会经过 IPC——IPC 是本机进程间通道，
 *    但 `apiKey` 仍属敏感值：**绝不进日志、错误载荷与导出**（11:44）。
 */
export interface AiCompleteInput {
  /** OpenAI 兼容端点（如 `https://api.openai.com/v1`），必须 http(s)。 */
  readonly config: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly model: string
    readonly temperature?: number
    readonly maxTokens?: number
    /** 单次请求超时（毫秒）；缺省由主进程决定（长生成要远大于 IPC 默认 15s）。 */
    readonly timeoutMs?: number
  }
  readonly system?: string
  readonly messages: readonly AiMessage[]
}

export interface AiCompleteOutput {
  readonly text: string
  readonly model?: string
  readonly usage?: {
    readonly promptTokens?: number
    readonly completionTokens?: number
  }
}

// ---------------------------------------------------------------------------
// 作品列表 / 重命名 / 删除（项目管理页，旧版 ProjectHub 的对应命令）
// ---------------------------------------------------------------------------

export interface ProjectListInput {
  readonly context: ReadContext
}

export interface ProjectListOutput {
  readonly projects: readonly Project[]
}

/** 重命名作品。CAS 乐观锁在存储层（`WHERE id AND revision`）。 */
export interface ProjectUpdateInput {
  readonly context: WriteContext
  readonly projectId: ProjectId
  readonly name: string
}

export interface ProjectUpdateOutput {
  readonly projectId: ProjectId
  readonly revision: Revision
}

/** 软删作品。🔴 只标记作品行，**不级联**子文档（可见性由作品决定，恢复才可能）；重复删除报 NOT_FOUND_PROJECT。 */
export interface ProjectDeleteInput {
  readonly context: WriteContext
  readonly projectId: ProjectId
}

export interface ProjectDeleteOutput {
  readonly projectId: ProjectId
  readonly revision: Revision
}

// ---------------------------------------------------------------------------
// 备份与恢复（桌面本地，旧版 BackupManager 的对应命令）
// ---------------------------------------------------------------------------

/**
 * 创建一致备份（`VACUUM INTO` 快照 + 清单，成对写出）。
 *
 * 🔴 备份目录由主进程适配器决定（`<数据目录>/backups/`），渲染层**不传任意路径**：
 * 快照落盘位置是存储细节，也避免渲染层借 IPC 读写任意文件。
 */
export interface BackupCreateInput {
  /** 备份标签（清单与列表展示用），缺省用时间戳。 */
  readonly label?: string
}

export interface BackupCreateOutput {
  readonly backupPath: string
  readonly manifestPath: string
  readonly createdAt: UtcTimestamp
  readonly byteSize: number
  readonly durationMs: number
}

/**
 * 备份列表项。
 *
 * 🔴 命名刻意不叫 `BackupFileEntry`：`@yfe/persistence-sqlite` 的清单层已用该名
 *    描述「快照里的一个文件（fileName/sha256/byteSize）」，两者含义不同，同名会误读。
 */
export interface BackupEntry {
  /** 快照绝对路径（主进程生成，渲染层只用于回传给 verify/restore）。 */
  readonly backupPath: string
  readonly manifestPath: string
  readonly label: string
  /** 清单里的创建时间；清单缺失/不可解析时为 null（列表**不因此隐藏**该项）。 */
  readonly createdAt: UtcTimestamp | null
  /** 快照字节数（来自文件系统；清单缺失时仍可显示）。 */
  readonly byteSize: number
  /** 清单是否可解析——false 表示这份备份已损坏，仅能列出不能恢复。 */
  readonly readable: boolean
}

export interface BackupListOutput {
  readonly backups: readonly BackupEntry[]
}

export interface BackupVerifyInput {
  /** 只允许校验备份目录内的文件（防任意文件读取）。 */
  readonly backupPath: string
}

export interface BackupVerifyOutput {
  readonly backupPath: string
  readonly manifestPath: string
  readonly label: string
  readonly createdAt: UtcTimestamp | null
  readonly integrity: 'ok'
  readonly databaseSchemaVersion: number
  /** 快照版本低于程序 ⇒ 需要先迁移才能写。 */
  readonly needsMigration: boolean
  readonly byteSize: number
}

/**
 * 恢复一份备份。
 *
 * 🔴 预览版权衡：恢复**绝不覆盖当前正在使用的库文件**——连接由 db-worker 独占持有，
 *    覆盖正在使用的文件必然损坏（Windows 文件锁 + WAL）。结果写到
 *    `<数据目录>/restore-preview/`，切换当前数据文件需要重启应用（后续批次做切换流程）。
 */
export interface BackupRestoreInput {
  readonly backupPath: string
  /** 目标已存在时是否覆盖。默认 false：覆盖必须是显式决定。 */
  readonly overwrite?: boolean
}

export interface BackupRestoreOutput {
  readonly targetPath: string
  readonly manifestPath: string
  readonly byteSize: number
  readonly verified: boolean
}
