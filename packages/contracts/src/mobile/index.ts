/**
 * 移动端原生模块契约（uni-app x / Android 首发）。
 *
 * 为什么这些接口放在 `@yfe/contracts` 而不是等 P4 再定：
 * 用户明确（m00632）本轮预览版的目的是**为移动端兼容打底**。桌面端如果
 * 直接把 better-sqlite3 的 `Database` 句柄、`fs` 路径或 Electron IPC 泄漏进
 * 业务层，P4 就必须推翻已固化的架构。因此本轮**只定义接口**，
 * 桌面实现与移动实现各自满足它。
 *
 * 设计约束（`03-移动端.md`）：
 * - 手机**不加载 better-sqlite3**；用 Android SQLite 或 Room，由 UTS/Kotlin 封装事务。
 * - 正文、revision 与 outbox 必须在**同一事务**保存；单纯异步 KV 或多个
 *   `storage.set` 不等价于这个事务。
 * - 前台与 WorkManager 通过**同一移动数据模块**访问数据库，采用序列化写事务，
 *   不得各自维护一套独立同步状态。
 * - 缓存淘汰**不得删除**未同步草稿、冲突版本或待上传附件。
 * - 设备空间不足时报保存失败，**不得标记"已保存"**。
 * - 不提供"忽略所有证书错误"开关；自签服务走受信任 CA 或明确导入信任配置。
 *
 * 🔴 这五个接口是跨端能力边界。桌面端可以不实现 `mobile` 子集，
 * 但**任何一端都不得越过这些接口直接访问底层资源**。
 */

import type { Cursor, DeviceId, RequestId, Revision, UtcTimestamp, WorkspaceId } from '../ids.js'

// ---------------------------------------------------------------------------
// database —— 事务化命令与查询
// ---------------------------------------------------------------------------

/**
 * 移动端数据库能力的**最小**接口面。
 *
 * 🔴 这里刻意不暴露任何 SQL 驱动类型（`Database` / `Statement`）：
 * 一旦暴露，业务代码就会开始拼 SQL，驱动替换与迁移校验都会失守
 * （`10-开发规范与环境.md`：UI、模型工具与插件不得直接拼 SQL）。
 *
 * 所有写操作必须能组成一个事务；`tx` 回调抛错即整体回滚。
 */
export interface MobileDatabase {
  /** 是否已打开且通过完整性自检。 */
  readonly isOpen: boolean
  /** 当前 Schema 版本，用于与 `DB_SCHEMA_VERSION` 比较。 */
  readonly schemaVersion: number

  open(): Promise<void>
  close(): Promise<void>

  /**
   * 执行一个写事务。
   *
   * 🔴 `mutator` 内部**不得等待网络**：事务里挂起会长时间持有写锁，
   * 在前台/后台并发的手机上直接表现为"保存不动"。
   * 需要联网的副作用应在事务提交后执行。
   */
  transaction<T>(mutator: (tx: MobileTransaction) => T | Promise<T>): Promise<T>

  /** 只读查询，不参与写锁。 */
  query<T>(statement: MobileStatement, params?: readonly unknown[]): Promise<readonly T[]>

  /** 一致性备份到指定逻辑位置，返回可校验的备份句柄。 */
  backup(to: string): Promise<{ readonly handle: string; readonly bytes: number }>
}

/** 事务上下文：只有事务内才允许写。 */
export interface MobileTransaction {
  execute(statement: MobileStatement, params?: readonly unknown[]): Promise<{ readonly changes: number }>
  query<T>(statement: MobileStatement, params?: readonly unknown[]): Promise<readonly T[]>
}

/**
 * 具名语句而不是裸 SQL 字符串。
 *
 * 理由：UTS/Kotlin 侧可以预编译并缓存这些语句，同时把 SQL 集中在一处
 * 便于审计；调用方无法拼接用户输入进 SQL。
 */
export interface MobileStatement {
  readonly name: string
  readonly sql: string
}

// ---------------------------------------------------------------------------
// secureStore —— 密钥与设备凭据
// ---------------------------------------------------------------------------

/**
 * 安全存储。
 *
 * 设备撤销时必须**清理**对应凭据引用，而不是留着等过期：
 * 撤销的语义是"立刻失效"，留存的刷新凭据是一个可被恢复的攻击面。
 */
export interface SecureStore {
  /** 写入密钥；同名覆盖。 */
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  /** 按前缀批量清理，用于设备撤销时一次性清空该设备的所有凭据引用。 */
  deleteByPrefix(prefix: string): Promise<number>
  /** 是否具备硬件级保护（Keystore）；不可用时上层要降级提示。 */
  readonly hardwareBacked: boolean
}

// ---------------------------------------------------------------------------
// fileAccess —— 用户选文件与导入导出
// ---------------------------------------------------------------------------

/**
 * 文件访问。
 *
 * 🔴 不要求全盘权限：只通过系统文件选择器拿持久 URI 授权。
 * 这样既符合 Android 的存储访问模型，也避免应用被授予过大权限。
 */
export interface FileAccess {
  /** 让用户选一个或多个文件，返回持久授权的 URI 列表。 */
  pickFiles(options: { readonly multiple: boolean; readonly mimeTypes: readonly string[] }): Promise<readonly PickedFile[]>
  /** 让用户选一个保存位置，返回可写 URI。 */
  pickSaveTarget(options: { readonly suggestedName: string; readonly mimeType: string }): Promise<PickedFile | null>
  readText(uri: string): Promise<string>
  writeText(uri: string, content: string): Promise<void>
  /** 释放不再需要的持久授权，避免占满系统授权配额。 */
  release(uri: string): Promise<void>
}

export interface PickedFile {
  readonly uri: string
  readonly name: string
  readonly byteSize: number | null
  readonly mimeType: string | null
}

// ---------------------------------------------------------------------------
// backgroundSync —— 后台同步
// ---------------------------------------------------------------------------

/**
 * 后台同步。
 *
 * 设计约束（`03-移动端.md`）：
 * - **每工作区唯一任务**：多个任务并发会在服务器侧表现为重复批次。
 * - 系统可能延迟后台工作；用户强行停止应用后**不能承诺**自动唤醒或实时同步。
 * - 推送只是提示，不是数据真相。
 */
export interface BackgroundSync {
  /** 为一个工作区登记唯一同步任务；重复调用应幂等更新约束而不是新建。 */
  schedule(input: {
    readonly workspaceId: WorkspaceId
    readonly deviceId: DeviceId
    /** 仅在满足网络约束时执行。 */
    readonly requiresUnmetered: boolean
    /** 最小重试间隔，退避由平台侧执行。 */
    readonly minIntervalMs: number
  }): Promise<{ readonly taskId: string }>
  cancel(workspaceId: WorkspaceId): Promise<void>
  /** 立即尝试一次（前台手动触发）。 */
  triggerNow(workspaceId: WorkspaceId): Promise<void>
  /** 当前登记的任务状态，供"同步"页面展示。 */
  readonly scheduled: readonly { readonly workspaceId: WorkspaceId; readonly taskId: string }[]
}

// ---------------------------------------------------------------------------
// editor —— 移动端基础编辑
// ---------------------------------------------------------------------------

/**
 * 移动端编辑控件适配器。
 *
 * 🔴 与桌面 CodeMirror 的 `Editor Adapter` **同语义、不同实现**：
 * - 基础输入**不能**通过网络保存回包反复替换控件全文（会导致光标跳动、
 *   输入法组合态被打断）。
 * - 锁屏、切页或进程回收时，以**最近已确认事务 + 可恢复草稿**为准。
 * - 长文本验证不通过时拆分章节或扩展原生控件，**不得**临时改成
 *   不可控的整本单文本框。
 */
export interface MobileEditorAdapter {
  open(input: { readonly documentId: string; readonly body: string; readonly revision: Revision | null }): Promise<void>
  getSelection(): Promise<{ readonly start: number; readonly end: number }>
  getBody(): Promise<string>
  replace(input: { readonly start: number; readonly end: number; readonly text: string }): Promise<void>
  undo(): Promise<void>
  redo(): Promise<void>
  /** 把当前控件内容冲刷到草稿存储，返回可保存的正文与序号。 */
  flush(): Promise<{ readonly body: string; readonly draftSequence: number }>
  /** 应用平台能力（主题、只读等），不得改变正文字符。 */
  decorate(input: { readonly readOnly: boolean; readonly themeTokens: Readonly<Record<string, string>> }): Promise<void>
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// 移动端运行时装配
// ---------------------------------------------------------------------------

/**
 * 移动端平台能力集合。
 *
 * 与桌面宿主注入应用服务是同一个模式：应用层只依赖这个接口，
 * 不关心背后是 Kotlin 还是 Node。
 */
export interface MobilePlatform {
  readonly database: MobileDatabase
  readonly secureStore: SecureStore
  readonly fileAccess: FileAccess
  readonly backgroundSync: BackgroundSync
  readonly editor: MobileEditorAdapter
  readonly platform: 'android'
  readonly appVersion: string
  /** 系统输入法/语言环境标识，用于诊断中文与 emoji 问题。 */
  readonly inputLocale: string
}

// ---------------------------------------------------------------------------
// 移动端同步约定
// ---------------------------------------------------------------------------

/**
 * 移动端同步状态（供"同步"页面展示）。
 *
 * 🔴 与桌面端同一原则：**网络错误不得覆盖本地保存状态**。
 * "本地已保存"与"已同步"是两个独立维度，UI 必须分别呈现。
 */
export interface MobileSyncState {
  readonly workspaceId: WorkspaceId
  readonly deviceId: DeviceId
  /** 本地已提交但未推送的操作数。 */
  readonly pendingOperations: number
  readonly cursor: Cursor | null
  readonly lastAttemptAt: UtcTimestamp | null
  readonly lastErrorCode: string | null
  readonly localSaveState: 'saved' | 'saving' | 'failed'
  readonly connectivity: 'online' | 'offline' | 'metered'
}

/** 移动端缓存淘汰决策。 */
export type MobileEvictionDecision =
  | { readonly kind: 'evict' }
  | { readonly kind: 'keep'; readonly reason: 'unsynced-draft' | 'conflict' | 'pending-upload' }

/**
 * 判断当前缓存对象能否被淘汰。
 *
 * 🔴 只要存在未同步草稿、冲突版本或待上传附件，就**不得**淘汰：
 * 这些数据在服务器上没有副本，删掉即永久丢失。
 */
export function canEvict(probe: {
  readonly hasUnsyncedDraft: boolean
  readonly hasConflict: boolean
  readonly hasPendingUpload: boolean
}): MobileEvictionDecision {
  if (probe.hasUnsyncedDraft) return { kind: 'keep', reason: 'unsynced-draft' }
  if (probe.hasConflict) return { kind: 'keep', reason: 'conflict' }
  if (probe.hasPendingUpload) return { kind: 'keep', reason: 'pending-upload' }
  return { kind: 'evict' }
}

/** 移动端请求包装：每条命令都带 requestId，便于跨端日志串联。 */
export interface MobileRequest<T> {
  readonly requestId: RequestId
  readonly workspaceId: WorkspaceId
  readonly payload: T
}
