/**
 * `@yfe/application` 的端口（Ports & Adapters）。
 *
 * 设计依据：
 * - `01-总体架构.md`「模块依赖」：`application` 的禁止依赖是「具体页面或全局当前项目」；
 *   本包进一步**不 import 任何具体驱动**（better-sqlite3 / Electron / Fastify / DOM）。
 * - `10-开发规范与环境.md`：时间、随机 ID、模型、网络、凭据一律**以接口注入**，
 *   `ProjectContext` 显式传递，不得新增可变的「当前作品」单例。
 *
 * 🔴 本文件是**应用层与适配器之间唯一的书面接口**。真实适配器（`@yfe/persistence-sqlite`、
 *    未来的 HTTP 后端、移动端原生 SQLite）由宿主装配后注入 {@link ApplicationDeps}，
 *    用例只认这里的形状。因此：
 *    1. 端口方法的**入参与返回值都必须来自 `@yfe/contracts` 或本文件的公开类型**，
 *       不得泄漏 SQL、行对象、连接句柄或驱动异常。
 *    2. 端口方法一律 `async`：本地 SQLite 是同步的，但服务端/远端适配器不是；
 *       统一异步让同一份用例在桌面、后端、移动端可互换。
 *    3. 只读端口**必须自行按 `context.workspaceId` 过滤**（跨工作区泄漏是安全缺陷，
 *       不是风格问题），因为用例层拿不到 WorkspaceEntity 的 `workspaceId`
 *       （`DocumentSummary` 刻意 `Omit` 掉了它）。
 */

import {
  newRevision,
  newIds,
  systemClock,
  isWellFormedId,
  type Clock,
  type DocumentCreateInput,
  type DocumentGetOutput,
  type DocumentId,
  type DocumentKind,
  type DocumentSummary,
  type IdempotencyKey,
  type ProjectId,
  type Project,
  type RandomSource,
  type ReadContext,
  type Result,
  type Revision,
  type SaveDraftInput,
  type SaveDraftOutput,
  type SettingsEntity,
  type UtcTimestamp,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'

// ---------------------------------------------------------------------------
// 依赖注入容器
// ---------------------------------------------------------------------------

/**
 * 新 revision 字符串的生成器。
 *
 * 形状与 `@yfe/persistence-sqlite` 的 `SaveDraftDeps['revisionGenerator']`
 * **逐字一致**（`{ next(seq: number): Revision }`），因此同一个对象可以在两侧互换使用。
 * 序号从哪里来由存储层负责（实体行的 `revision_seq`），本层只透传生成器。
 */
export interface RevisionGenerator {
  next(seq: number): Revision
}

/**
 * 持久化内部行 ID 生成器。
 *
 * 形状与 persistence 包 `SaveDraftDeps['ids']` **逐字一致**，保持可互换：
 * `revisionRow` / `operation` / `batch` 分别对应 `revisions.id`、`operations.op_id`、
 * `operations.batch_id`。用例层自身不使用这三个方法，它们存在只是为了
 * 「同一个 ids 对象既能喂给应用用例、又能喂给持久化事务」。
 *
 * ⚠️ 契约缺口（已上报，不自行修改 contracts）：契约里没有 revision 行 ID / opId / batchId
 * 的专用工厂类型，它们是裸 `string`。
 */
export interface IdGenerator {
  /** `revisions.id`（主键）。 */
  revisionRow(): string
  /** `operations.op_id` / `outbox.op_id`。 */
  operation(): string
  /** `operations.batch_id`：一次跨实体改动共享一个批次 ID。 */
  batch(): string
}

/**
 * 应用层需要的**实体 ID** 工厂。
 *
 * `project()` / `document()` 由用例在调用端口**之前**生成：ID 由客户端产生、离线可创建
 * （`06-数据与本地存储.md`），并且这样「返回给调用方的 ID」与「写进库的 ID」必然同源。
 */
export interface ApplicationIdGenerator extends IdGenerator {
  project(): ProjectId
  document(): DocumentId
  /**
   * 设定实体主键。
   *
   * 与人物卡共用 `settings_entities` 表，但**新建通用设定实体**一律用 `wld_` 前缀：
   * 前缀是 ID 自带的类型标签（`isWellFormedId` 之外的人眼分类），人物卡的 `chr_`
   * 由人物卡用例负责，不能靠这里的默认值产生。
   */
  settingsEntity(): string
}

/** 应用层所需的全部持久化端口。装配由宿主完成，本包不含任何适配器实现。 */
export interface ApplicationPorts {
  readonly draft: DraftPersistencePort
  readonly projects: ProjectPort
  readonly documents: DocumentPort
  readonly settingsEntities: SettingsEntityPort
  readonly system: SystemStatusPort
  /**
   * 幂等记录端口（可选）。
   *
   * 可选是刻意的：CLI 单次进程、只读模式等场景没有持久化幂等表也能工作；
   * 桌面/后端应实现它，否则「响应丢失后重试」会退化成依赖存储层序号判定。
   */
  readonly idempotency?: IdempotencyPort
}

/**
 * 用例层的全部外部依赖。**必须由调用方注入**，包内不持有可变全局。
 *
 * 四个成员刻意与 persistence 包的 `SaveDraftDeps` 同形（`clock` / `ids` / `revisions`），
 * 这样桌面宿主可以用同一组对象同时装配应用用例与本地写事务。
 */
export interface ApplicationDeps {
  readonly clock: Clock
  readonly ids: ApplicationIdGenerator
  readonly revisions: RevisionGenerator
  readonly persistence: ApplicationPorts
}

// ---------------------------------------------------------------------------
// 草稿：读归属 + 提交（本项目最关键的一条用例）
// ---------------------------------------------------------------------------

/**
 * 文档的**权威归属与版本事实**（不含正文）。
 *
 * 🔴 唯一真值来自库内行：`context.workspaceId` / `context.projectId` 只能与它**比对**，
 *    绝不能拿 payload 自报的值当授权依据。
 */
export interface DocumentOwnership {
  readonly documentId: DocumentId
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly revision: Revision
  /** 软删标志：**必须与 0 比较**（`!== 0` 即已删），`-1` 之类的脏值也算已删。 */
  readonly deleted: number
}

/** 运行时守卫：适配器返回的行形状非法时用例层必须失败，而不是拿 `undefined` 当已删除。 */
export function isDocumentOwnership(value: unknown): value is DocumentOwnership {
  if (typeof value !== 'object' || value === null) return false
  const row = value as {
    documentId?: unknown
    workspaceId?: unknown
    projectId?: unknown
    revision?: unknown
    deleted?: unknown
  }
  return (
    isWellFormedId(row.documentId) &&
    isWellFormedId(row.workspaceId) &&
    isWellFormedId(row.projectId) &&
    typeof row.revision === 'string' &&
    row.revision.length > 0 &&
    typeof row.deleted === 'number'
  )
}

/** 提交草稿的请求。 */
export interface CommitDraftRequest {
  /** 契约入参**原样透传**，用例层不改写正文、不重算序号。 */
  readonly input: SaveDraftInput
  /** 用例在事务外读到的归属快照。 */
  readonly ownership: DocumentOwnership
  /**
   * 用例时钟打点。
   *
   * 🔴 适配器**应当原样把它当作本次写入的时间戳**（`savedAt` 必须回传同一个值），
   *    这样「同一个请求里的所有时间点」只有一个来源，测试也可复现。
   *    适配器若自行另取时钟，迟到回包的时间戳就不再可对齐。
   */
  readonly occurredAt: UtcTimestamp
}

/** 草稿端口：`saveDraft` 用例只依赖这两件事。 */
export interface DraftPersistencePort {
  /**
   * 读文档归属（不读正文）。
   *
   * 返回 `null` 表示文档不存在；用例据此返回 `NOT_FOUND_DOCUMENT`。
   * 适配器**不得**在这里按工作区过滤后返回 `null`——「不属于本工作区」与「不存在」
   * 必须是两种不同结果，否则跨工作区写入的失败原因会被伪装成 404（不利于排查与审计）。
   */
  loadDocument(documentId: DocumentId): Promise<DocumentOwnership | null>
  /**
   * 提交一次草稿。
   *
   * 🔴 必须在**同一事务**内按 `06-数据与本地存储.md`「保存事务」的顺序完成：
   *    校验主体与 ProjectContext → 比较 `expectedRevision` → 写正文和新 revision
   *    → 写版本记录 → 写 operation 与 outbox → 提交。失败即整体回滚
   *    （「写入失败不能消耗 outbox，也不能提前显示成功」）。
   * 🔴 适配器必须在事务内**重新校验** `ownership`（防 TOCTOU：用例读归属与提交之间
   *    文档可能被移动/删除/推进版本）。
   * 🔴 `SaveDraftOutput.charCount` 必须用 `@yfe/domain` 的 `countChars(body)` 计算，
   *    **禁止**用 `body.length`（中文与 Unicode 字数规则不同，且桌面/移动要用同一算法）。
   *    应用层不依赖 `@yfe/domain`，所以这个派生值由适配器负责产出。
   * 🔴 `context.idempotencyKey` 的**请求级幂等由用例层处理**（见 `src/idempotency.ts`），
   *    适配器只需保证「同一 `draftSequence` 重放不写坏数据」这一层。
   */
  commitDraft(request: CommitDraftRequest): Promise<Result<SaveDraftOutput>>
}

// ---------------------------------------------------------------------------
// 作品
// ---------------------------------------------------------------------------

export interface CreateProjectRequest {
  readonly context: WriteContext
  /** 由用例生成，保证「返回给调用方的 ID」与「落库的 ID」同源。 */
  readonly projectId: ProjectId
  readonly name: string
  /** 契约里 `summary` 可选，用例归一为字符串（缺省 `''`）后再下发。 */
  readonly summary: string
  readonly seedFirstChapter: boolean
  readonly templateId: string | null
  readonly occurredAt: UtcTimestamp
}

export interface ProjectWriteResult {
  readonly revision: Revision
}

export interface ProjectPort {
  /** 建作品；`seedFirstChapter === true` 时同一事务内建首章（由适配器决定结构）。 */
  createProject(request: CreateProjectRequest): Promise<Result<ProjectWriteResult>>
  /** 列出工作区内的作品（适配器按 `context.workspaceId` 过滤；`deleted === 0` 的行）。 */
  listProjects(request: ListProjectsRequest): Promise<Result<readonly Project[]>>
  /** 重命名作品（CAS 乐观锁在适配器）。 */
  updateProject(request: UpdateProjectRequest): Promise<Result<ProjectWriteResult>>
  /** 软删作品（级联子文档；适配器返回实际标记删除的行数）。 */
  deleteProject(request: DeleteProjectRequest): Promise<Result<ProjectDeleteResult>>
}

export interface ListProjectsRequest {
  readonly context: ReadContext
  /** 用例已归一为布尔值（契约里是可选字段）。 */
  readonly includeDeleted: boolean
}

export interface UpdateProjectRequest {
  readonly context: WriteContext
  readonly projectId: ProjectId
  readonly name: string
  readonly occurredAt: UtcTimestamp
}

export interface DeleteProjectRequest {
  readonly context: WriteContext
  readonly projectId: ProjectId
  readonly occurredAt: UtcTimestamp
}

export interface ProjectDeleteResult {
  readonly revision: Revision
  readonly deletedCount: number
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export interface CreateDocumentRequest {
  readonly context: WriteContext
  readonly projectId: ProjectId
  /** 由用例生成。 */
  readonly documentId: DocumentId
  readonly kind: DocumentKind
  readonly parentId: DocumentId | null
  readonly title: string
  /** 直接用契约的插入位置联合类型，避免应用层另造一套语义。 */
  readonly placement: DocumentCreateInput['placement']
  readonly occurredAt: UtcTimestamp
}

export interface DocumentWriteResult {
  readonly revision: Revision
  readonly orderKey: string
}
export interface GetDocumentRequest {
  readonly context: ReadContext
  readonly documentId: DocumentId
}

export interface ListDocumentTreeRequest {
  readonly context: ReadContext
  readonly projectId: ProjectId
  /** 用例已归一为布尔值（契约里是可选字段）。 */
  readonly includeDeleted: boolean
}

export interface UpdateDocumentRequest {
  readonly context: WriteContext
  readonly documentId: DocumentId
  /** 重命名：不给就不改标题。 */
  readonly title?: string
  /** 重排：不给就不动位置。 */
  readonly placement?: { readonly mode: 'end' } | { readonly mode: 'after'; readonly afterId: DocumentId }
}

export interface UpdateDocumentResult {
  readonly revision: Revision
  /** 只有发生重排时才有值；调用方用它免重拉整棵树。 */
  readonly orderKey?: string
}

export interface DeleteDocumentRequest {
  readonly context: WriteContext
  readonly documentId: DocumentId
}

export interface DeleteDocumentResult {
  readonly revision: Revision
  readonly deletedCount: number
}

export interface DocumentPort {
  /**
   * 建文档。
   *
   * `orderKey` 由适配器用 `@yfe/domain` 的排序键函数生成，并把生成值回传：
   * - `placement.mode === 'end'` → `orderKeyAfter(同级最大键)`；
   * - `placement.mode === 'after'` → `orderKeyBetween(被引用文档的键, 其下一个同级键)`。
   *
   * 🔴 必须**在事务内读同级键并生成**，否则离线并发建章会生成重复键
   *    （`orderKeyBetween` 需要真实的相邻两侧键，客户端算不出来）。
   * 🔴 必须校验 `projectId` 属于 `context.workspaceId`、`parentId`（若有）属于同一
   *    `projectId`：用例层拿不到他人实体的 `workspaceId`，这条归属校验只能在这里做。
   */
  createDocument(request: CreateDocumentRequest): Promise<Result<DocumentWriteResult>>
  /** 返回契约的 `DocumentGetOutput`（摘要 + 正文）；必须按 `context.workspaceId` 过滤。 */
  getDocument(request: GetDocumentRequest): Promise<Result<DocumentGetOutput>>
  /** 平铺返回文档树，**不含正文**；必须按 `context.workspaceId` 过滤。 */
  listDocumentTree(request: ListDocumentTreeRequest): Promise<Result<readonly DocumentSummary[]>>
  /**
   * 重命名与/或重排。两者同时给时适配器按「先改名、后重排」顺序执行；
   * `expectedRevision` 乐观锁与工作区归属由存储层复查（`loadDocumentForWrite`）。
   * 重排时必须回传新 `orderKey`（调用方用它免重拉整棵树）。
   */
  updateDocument(request: UpdateDocumentRequest): Promise<Result<UpdateDocumentResult>>
  /** 级联软删子树（`cascade` 默认 true）；返回墓碑 revision 与实际删除条数。 */
  deleteDocument(request: DeleteDocumentRequest): Promise<Result<DeleteDocumentResult>>
}

// ---------------------------------------------------------------------------
// 设定实体
// ---------------------------------------------------------------------------

/**
 * 列出设定实体的请求。
 *
 * `projectId === null` 表示**工作区级**列表（跨作品）；`schemaTemplateId === null`
 * 表示不按模板过滤。两个可选字段在用例层就已归一成 `null`，端口因此不必
 * 区分「没传」与「传了 undefined」——这对适配器是实打实的简化。
 */
export interface ListSettingsEntitiesRequest {
  readonly context: ReadContext
  readonly projectId: ProjectId | null
  readonly schemaTemplateId: string | null
  readonly includeDeleted: boolean
}

export interface GetSettingsEntityRequest {
  readonly context: ReadContext
  readonly entityId: string
}

export interface SaveSettingsEntityRequest {
  readonly context: WriteContext
  /**
   * 实体主键：新建时由用例在调用端口**之前**生成（与 `createProject` 同规矩：
   * 「返回给调用方的 ID」与「落库的 ID」必须同源），更新时等于入参里的 `entityId`。
   */
  readonly entityId: string
  /**
   * 这次是新建还是更新。
   *
   * 用例已经用「入参 `entityId` 是否为空」判定过一次，这里再显式传下来，是为了让
   * 适配器不必重复推断——判定规则将来若变（比如支持「按 ID upsert」），只改用例层。
   */
  readonly isCreate: boolean
  readonly projectId: ProjectId
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  /** 显式排序键；`null` = 由适配器按末位追加（只在新建时有意义）。 */
  readonly orderKey: string | null
  /** 用例时钟打点；适配器应当原样当作本次写入的时间戳。 */
  readonly occurredAt: UtcTimestamp
}

export interface SettingsEntityWriteResult {
  readonly entityId: string
  readonly revision: Revision
  readonly orderKey: string
}

/**
 * 设定实体端口。
 *
 * 🔴 读路径**必须自行按 `context.workspaceId` 过滤**（跨工作区泄漏是安全缺陷）。
 * 用例层拿不到 `SettingsEntity` 的 `workspaceId`（它继承 `WorkspaceEntity`，
 * 但契约输出里带的是实体本身，无法用来授权比对），因此归属校验只能在适配器/存储层做，
 * 用例层能做的只是「把 `context` 原样传下去，绝不接受 payload 自报的工作区」。
 * 🔴 跨工作区访问必须返回 `PERMISSION_WORKSPACE_MISMATCH` 而不是 `NOT_FOUND`：
 *    两者混淆会让越权访问在日志里看起来像普通的「不存在」。
 */
export interface SettingsEntityPort {
  /** 只读；已软删实体默认不可见。 */
  listSettingsEntities(
    request: ListSettingsEntitiesRequest,
  ): Promise<Result<readonly SettingsEntity[]>>
  getSettingsEntity(request: GetSettingsEntityRequest): Promise<Result<SettingsEntity>>
  /**
   * 新建或更新。
   *
   * 🔴 更新必须走 `context.expectedRevision` 乐观锁，过期返回 `REVISION_CONFLICT`；
   *    新建必须要求 `expectedRevision === null`（否则调用方是在用更新的语义做新建）。
   * 🔴 `values` 是**整体替换**而不是深合并。
   */
  saveSettingsEntity(
    request: SaveSettingsEntityRequest,
  ): Promise<Result<SettingsEntityWriteResult>>
}

// ---------------------------------------------------------------------------
// 系统状态
// ---------------------------------------------------------------------------

/**
 * 系统状态里**只有宿主/运行时知道**的那部分事实。
 *
 * `syncProtocolVersion` 与 `pluginApiVersion` 不在这里：它们是跨端协议常量
 * （`@yfe/contracts` 的 `SYNC_PROTOCOL_VERSION` / `PLUGIN_API_VERSION`），
 * 由用例直接取契约值，避免每个宿主各写一遍导致版本号漂移。
 */
export interface SystemStatusFacts {
  /** 宿主应用版本（桌面取 `app.getVersion()`，后端取自己构建的版本）。 */
  readonly appVersion: string
  /** **实际打开的库**结构版本（persistence 的 `readSchemaVersion(db)`）。 */
  readonly databaseSchemaVersion: number
  /** 数据目录路径，仅供设置页展示，**不写入同步数据**。 */
  readonly databasePath: string
  readonly readOnly: boolean
  readonly lastSavedAt: UtcTimestamp | null
  /** UI「待同步」角标读它。 */
  readonly pendingOutboxCount: number
  /** 已装载资源模板包版本；未装载为 `null`（不是 `undefined`）。 */
  readonly resourceTemplateVersion: string | null
}

export interface SystemStatusPort {
  /** 读运行时事实。读库失败必须返回 `Err`（`STORAGE_*`），不得伪造一份空状态。 */
  readSystemStatus(): Promise<Result<SystemStatusFacts>>
}

// ---------------------------------------------------------------------------
// 幂等记录
// ---------------------------------------------------------------------------

/**
 * 一条已确认结果的幂等记录。
 *
 * `value` 是契约输出的**规范化 JSON 文本**（`JSON.stringify(SaveDraftOutput)` 等）。
 * 用文本而非 `unknown` 是为了让端口形状无泛型、可被任意适配器实现（SQLite 一行一列即可），
 * 且避免把结构化对象按引用缓存进来被后续改写。
 */
export interface IdempotencyRecord {
  readonly key: IdempotencyKey
  /** 用例名（`saveDraft` / `createProject` / `createDocument`）。同键跨用例即 `IDEMPOTENCY_KEY_REUSED`。 */
  readonly scope: string
  readonly value: string
  /** 规范化请求身份，只用于精确比较，禁止写入日志或错误。 */
  readonly requestIdentity?: string
}

/**
 * 幂等记录端口。
 *
 * 契约要求「请求确认丢失后，重复提交相同 opId 返回原结果」，而
 * `@yfe/persistence-sqlite` 的 `saveDraft` **完全没有使用 `idempotencyKey`**
 * （它只处理同 `draftSequence` 重放），因此请求级幂等只能落在用例层，
 * 记录本身则必须由适配器持久化（进程内 Map 只能覆盖单进程窗口）。
 *
 * 参考实现可用 `operations.op_id` 或一张 `idempotency_records(key, scope, value)` 表。
 * 若宿主不提供本端口，用例层的幂等缓存被跳过（此时同键重放退回存储层判定）。
 */
export interface IdempotencyPort {
  /** 未命中返回 `null`（而不是 `Err`）：没记录是正常路径。 */
  find(key: IdempotencyKey): Promise<IdempotencyRecord | null>
  /** 只保存成功结果；失败不落盘，以便调用方重试。 */
  save(record: IdempotencyRecord): Promise<void>
}

// ---------------------------------------------------------------------------
// 默认实现（宿主可覆盖；测试请注入确定性实现）
// ---------------------------------------------------------------------------

/**
 * 基于 `@yfe/contracts` 的 ID 生成器。
 *
 * 🔴 包内不直接 `crypto.randomUUID()`：随机源由契约的 `RandomSource` 注入，
 *    测试传确定性源即可复现字节级差异。
 */
export function createApplicationIds(rng?: RandomSource): ApplicationIdGenerator {
  return {
    revisionRow: () => newIds.request(rng),
    operation: () => newIds.request(rng),
    batch: () => newIds.request(rng),
    project: () => newIds.project(rng),
    document: () => newIds.document(rng),
    settingsEntity: () => newIds.worldSetting(rng),
  }
}

/** 默认标识跨设备唯一；排序使用数据库内部序号。 */
export const systemRevisionGenerator: RevisionGenerator = { next: newRevision }

/** 用给定端口装配完整依赖；`clock` / `ids` / `revisions` 可覆盖（测试必覆盖）。 */
export function createApplicationDeps(
  persistence: ApplicationPorts,
  overrides: Partial<Pick<ApplicationDeps, 'clock' | 'ids' | 'revisions'>> = {},
): ApplicationDeps {
  return {
    clock: overrides.clock ?? systemClock,
    ids: overrides.ids ?? createApplicationIds(),
    revisions: overrides.revisions ?? systemRevisionGenerator,
    persistence,
  }
}
