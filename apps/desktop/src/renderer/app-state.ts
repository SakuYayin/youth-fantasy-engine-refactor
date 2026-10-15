/**
 * 渲染层应用状态（纯逻辑，无 Vue、无 DOM ⇒ 可无头测试）。
 *
 * 它只做三件事，其余都交给下层：
 * 1. 把「系统状态 → 当前作品 → 章节树 → 当前章节」串起来（每次调用都带 context，
 *    没有模块级"当前作品"单例）；
 * 2. 持有当前章节的 `DraftSession`（防抖保存、迟到结果丢弃、冲突裁决都在那里），
 *    并把它的快照翻译成界面能直接渲染的状态；
 * 3. 保证**网络错误绝不覆盖本地保存状态**（ADR 0006 / D5）：连通性单独一格，
 *    只有在"本地已保存"的前提下才显示"离线（本地已保存）"。
 *
 * ## 已知契约缺口（R-48，见台账）
 *
 * `IPC_METHODS` 里**没有"列出作品"**。所以"当前作品"由渲染层自己记住
 * （`projectStore`），首次启动没有任何作品时进入空态由用户新建。
 * 这是可用的临时方案，不是终态：真正的多作品列表需要新增契约命令 + IPC 方法。
 *
 * 设定实体（`settingsEntities`）这条通道不借道章节的串行队列：页签的数据读写
 * 与正文草稿互不阻塞（切页签、刷新列表都不该打断正在输入的正文）。
 */

import { countChars } from '@yfe/domain'
import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  DocumentGetInput,
  DocumentGetOutput,
  DocumentId,
  DocumentKind,
  DocumentSummary,
  DocumentTreeInput,
  DocumentTreeOutput,
  IdempotencyKey,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectId,
  RequestId,
  Result,
  Revision,
  SaveDraftInput,
  SaveDraftOutput,
  SettingsEntity,
  SettingsEntityGetInput,
  SettingsEntityGetOutput,
  SettingsEntityListInput,
  SettingsEntityListOutput,
  SettingsEntitySaveInput,
  SettingsEntitySaveOutput,
  SystemStatusOutput,
  WorkspaceId,
} from '@yfe/contracts'

import { LOCAL_WORKSPACE_ID } from '../shared/local-workspace.js'
import {
  createDraftSession,
  type ConflictResolution,
  type DraftConflict,
  type DraftSaveOutcome,
  type DraftSaveRequest,
  type DraftSession,
} from './state/draft-session.js'

/**
 * 界面用的保存状态。
 *
 * `offline` 与其余五态的区别：它**不是**保存失败，而是"本地已保存、但连不上服务"。
 * 只有 `DraftSession` 处于 `saved` 时才会被推导出来，因此网络抖动永远不会让
 * 用户以为自己刚写的字丢了。
 */
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

export interface ChapterNodeView {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly kind: DocumentKind
  readonly hasChildren: boolean
  readonly deleted: boolean
  readonly current: boolean
}

export interface AppErrorSummary {
  readonly code: string
  readonly message: string
}

/**
 * 界面里的设定实体。
 *
 * 与契约 `SettingsEntity` 一一对应，唯一差别是把品牌类型（`ProjectId` / `Revision`）
 * 收敛成 `string`：渲染层不该为了把一个 ID 塞进 `v-for` 的 key 去做类型断言。
 * `values` 原样透传——字段由 `schemaTemplateId` 指的模板决定，渲染层不解释它。
 */
export interface SettingsEntityView {
  readonly id: string
  readonly projectId: string
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly orderKey: string
  readonly revision: string
  readonly deleted: boolean
}

/** `loadSettingsEntities` 的过滤条件。 */
export interface SettingsEntityQuery {
  readonly schemaTemplateId?: string
  readonly includeDeleted?: boolean
  /**
   * `true` = 跨作品列出**整个工作区**的设定实体（全局检索 / 回收站视图用）。
   *
   * 默认 `false`：只看当前作品。没有当前作品时这一项无意义——存储层会直接按
   * 工作区列（`projectId` 缺省 = 跨作品），因为没有作品可限定。
   */
  readonly allProjects?: boolean
}

/**
 * 通用表单/卡片页签提交的载荷。
 *
 * - `entityId` 省略/`null` = 新建；
 * - `expectedRevision` 省略 = 更新时自动用**状态机已加载到的那份 revision**
 *   （表单刚读出来的那个），拿不到才退化成「不比对旧版本」；
 *   显式给 `null` 才表示「不管旧版本，直接覆盖」；
 * - `idempotencyKey` 省略 = 不启用幂等回执。新建表单应当为**一次表单会话**给一个稳定键，
 *   否则用户双击「保存」会建出两条设定（幂等键按请求去重，不按键值去重）。
 * - `orderKey` 省略/`null` = 新建时追加到末尾，更新时保持原位置。
 */
export interface SettingsEntitySubmit {
  readonly entityId?: string | null
  readonly schemaTemplateId: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  readonly expectedRevision?: string | null
  readonly orderKey?: string | null
  readonly idempotencyKey?: string
}

/** 提交结果：失败也**不抛**，把脱敏后的错误码交给界面自己决定怎么提示。 */
export type SettingsEntitySubmitResult =
  | { readonly ok: true; readonly entityId: string; readonly revision: string; readonly orderKey: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface AppSnapshot {
  readonly ready: boolean
  readonly loading: boolean
  readonly appVersion: string | null
  readonly databasePath: string | null
  readonly databaseSchemaVersion: number | null
  readonly readOnly: boolean
  readonly pendingOutboxCount: number
  readonly lastSavedAt: string | null
  readonly projectId: string | null
  readonly tree: readonly ChapterNodeView[]
  readonly selectedDocumentId: string | null
  readonly title: string
  readonly body: string
  readonly charCount: number
  readonly revision: string | null
  readonly saveStatus: SaveStatus
  readonly saveDetail: string | null
  readonly conflict: DraftConflict | null
  readonly lastError: AppErrorSummary | null
  readonly expandedIds: readonly string[]
  /** 当前作品的设定实体（`loadSettingsEntities` 之前为空数组）。 */
  readonly settingsEntities: readonly SettingsEntityView[]
  /** 设定实体的读/写是否在途（与章节的 `loading` 分开：两者互不阻塞）。 */
  readonly settingsLoading: boolean
  readonly selectedSettingsEntityId: string | null
  readonly selectedSettingsEntity: SettingsEntityView | null
}

/** 渲染层用到的 IPC 方法（与 `apps/desktop/src/shared/ipc/channels.ts` 逐字一致）。 */
export interface RendererClientPort {
  readonly systemStatus: () => Promise<Result<SystemStatusOutput>>
  readonly listDocumentTree: (input: DocumentTreeInput) => Promise<Result<DocumentTreeOutput>>
  readonly getDocument: (input: DocumentGetInput) => Promise<Result<DocumentGetOutput>>
  readonly createProject: (input: ProjectCreateInput) => Promise<Result<ProjectCreateOutput>>
  readonly createDocument: (input: DocumentCreateInput) => Promise<Result<DocumentCreateOutput>>
  readonly saveDraft: (input: SaveDraftInput) => Promise<Result<SaveDraftOutput>>
  readonly listSettingsEntities: (
    input: SettingsEntityListInput,
  ) => Promise<Result<SettingsEntityListOutput>>
  readonly getSettingsEntity: (
    input: SettingsEntityGetInput,
  ) => Promise<Result<SettingsEntityGetOutput>>
  readonly saveSettingsEntity: (
    input: SettingsEntitySaveInput,
  ) => Promise<Result<SettingsEntitySaveOutput>>
}

/** 当前作品的记忆位置（渲染层本地存储；Electron 下是 file:// 源的 localStorage）。 */
export interface ProjectStorePort {
  read(): string | null
  write(projectId: string | null): void
}

export interface AppStateDeps {
  readonly client: RendererClientPort
  readonly projectStore: ProjectStorePort
  readonly workspaceId?: string
  readonly newRequestId: () => string
  readonly newSessionId: () => string
  readonly debounceMs?: number
  readonly maxWaitMs?: number
}

export interface AppState {
  getSnapshot(): AppSnapshot
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
  /** 读系统状态 + 载入当前作品（没有作品时进入空态）。 */
  start(): Promise<void>
  refresh(): Promise<void>
  createProject(name: string): Promise<boolean>
  createChapter(title: string): Promise<boolean>
  selectDocument(documentId: string): Promise<boolean>
  edit(body: string): void
  /** 切章 / 关窗前调用：把待保存的草稿冲刷掉。 */
  flush(): Promise<boolean>
  /**
   * 收到外部（同步/别处编辑）版本时调用。
   *
   * 只有当前章节接受；本地有未提交编辑时**不会覆盖输入框**，而是进入冲突态等用户裁决
   * （真正裁决在 `DraftSession` 里）。返回 true 表示已直接应用。
   */
  applyExternalUpdate(update: { documentId: string; revision: string; body: string }): boolean
  retrySave(): void
  resolveConflict(resolution: ConflictResolution): void
  toggleExpanded(documentId: string): void
  setNavigationGuard(guard: (() => boolean) | null): void
  dispose(): void
  /**
   * 列出设定实体（通用表单/表格/卡片页签的数据源）。
   *
   * 与章节导航**互不阻塞**：设定页签的载入不冲刷草稿、也不走章节的串行队列
   * （切页签不该打断正在输入的正文）。返回 false 表示失败，`lastError` 里有脱敏原因。
   */
  loadSettingsEntities(options?: SettingsEntityQuery): Promise<boolean>
  /** 选中一条设定实体；状态机里没有就去读一次。 */
  selectSettingsEntity(entityId: string): Promise<boolean>
  /** 重新读一条设定实体并合并进列表（外部改动后刷新用）。 */
  refreshSettingsEntity(entityId: string): Promise<boolean>
  /** 新建或更新（`entityId` 缺省 = 新建）。 */
  submitSettingsEntity(submit: SettingsEntitySubmit): Promise<SettingsEntitySubmitResult>
}

/**
 * 哪些错误码算"连不上"。
 *
 * 只影响 `offline` 这一格的显示；**不影响保存状态本身**。
 */
const TRANSPORT_DOWN_CODES: ReadonlySet<string> = new Set([
  'NETWORK_TIMEOUT',
  'NETWORK_UNREACHABLE',
  'NETWORK_PROTOCOL_MISMATCH',
  'SERVICE_UNAVAILABLE',
  'SERVICE_SHUTTING_DOWN',
  'SERVICE_RESTARTED',
])

export function createAppState(deps: AppStateDeps): AppState {
  const workspaceId = deps.workspaceId ?? LOCAL_WORKSPACE_ID

  let ready = false
  let loading = false
  let appVersion: string | null = null
  let databasePath: string | null = null
  let databaseSchemaVersion: number | null = null
  let readOnly = false
  let pendingOutboxCount = 0
  let lastSavedAt: string | null = null
  let projectId: string | null = deps.projectStore.read()
  let documents: readonly DocumentSummary[] = []
  let selectedDocumentId: string | null = null
  let title = ''
  let body = ''
  let charCount = 0
  let revision: string | null = null
  let lastError: AppErrorSummary | null = null
  let transportDown = false
  let expandedIds: readonly string[] = []
  let session: DraftSession | null = null
  let disposed = false
  let navigation: Promise<void> = Promise.resolve()
  let navigationGuard: (() => boolean) | null = null
  let settingsEntities: readonly SettingsEntityView[] = []
  let settingsLoading = false
  let selectedSettingsEntityId: string | null = null

  const listeners = new Set<(snapshot: AppSnapshot) => void>()

  function readContext(): { requestId: RequestId; workspaceId: WorkspaceId } {
    return {
      requestId: deps.newRequestId() as RequestId,
      workspaceId: workspaceId as WorkspaceId,
    }
  }

  function buildTree(): readonly ChapterNodeView[] {
    const byParent = new Map<string | null, DocumentSummary[]>()
    for (const document of documents) {
      const key = document.parentId === null ? null : String(document.parentId)
      const bucket = byParent.get(key)
      if (bucket === undefined) byParent.set(key, [document])
      else bucket.push(document)
    }
    for (const bucket of byParent.values()) {
      bucket.sort((left, right) => (left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : 0))
    }

    const views: ChapterNodeView[] = []
    const visited = new Set<string>()
    const walk = (parentKey: string | null, depth: number): void => {
      for (const document of byParent.get(parentKey) ?? []) {
        const id = String(document.id)
        // 防御：坏数据造成环时不能把渲染层拖进死循环。
        if (visited.has(id)) continue
        visited.add(id)
        views.push({
          id,
          label: document.title,
          depth,
          kind: document.kind,
          hasChildren: document.hasChildren || (byParent.get(id)?.length ?? 0) > 0,
          deleted: document.deleted !== 0,
          current: id === selectedDocumentId,
        })
        walk(id, depth + 1)
      }
    }
    walk(null, 0)
    return views
  }

  function deriveSaveStatus(): { status: SaveStatus; detail: string | null } {
    if (session === null) return { status: 'saved', detail: null }
    const snapshot = session.getSnapshot()
    if (snapshot.conflict !== null) return { status: 'conflict', detail: '存在未裁决的外部版本' }
    if (transportDown && snapshot.status === 'saved') {
      return { status: 'offline', detail: '本地已保存，暂时连不上服务' }
    }
    if (snapshot.status === 'error') return { status: 'error', detail: snapshot.lastErrorCode }
    return { status: snapshot.status, detail: null }
  }

  function getSnapshot(): AppSnapshot {
    const derived = deriveSaveStatus()
    const sessionSnapshot = session?.getSnapshot() ?? null
    return {
      ready,
      loading,
      appVersion,
      databasePath,
      databaseSchemaVersion,
      readOnly,
      pendingOutboxCount,
      lastSavedAt,
      projectId,
      tree: buildTree(),
      selectedDocumentId,
      title,
      body,
      charCount,
      revision,
      saveStatus: derived.status,
      saveDetail: derived.detail,
      conflict: sessionSnapshot?.conflict ?? null,
      lastError,
      expandedIds,
      settingsEntities,
      settingsLoading,
      selectedSettingsEntityId,
      selectedSettingsEntity:
        settingsEntities.find((entity) => entity.id === selectedSettingsEntityId) ?? null,
    }
  }

  function emit(): void {
    if (disposed) return
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) listener(snapshot)
  }

  function noteFailure(code: string, message: string): void {
    if (TRANSPORT_DOWN_CODES.has(code)) transportDown = true
    lastError = { code, message }
  }

  function noteSuccess(): void {
    transportDown = false
    lastError = null
  }

  function openSession(documentIdValue: string, initialBody: string, initialRevision: string): void {
    session?.dispose()
    session = createDraftSession(
      {
        documentId: documentIdValue,
        sessionId: deps.newSessionId(),
        body: initialBody,
        revision: initialRevision,
      },
      {
        save: (request) => commitDraft(documentIdValue, request),
        onStateChange: (next) => {
          if (session?.getSnapshot().sessionId !== next.sessionId) return
          body = next.body
          charCount = countChars(body)
          revision = next.revision
          emit()
        },
        ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
        ...(deps.maxWaitMs === undefined ? {} : { maxWaitMs: deps.maxWaitMs }),
      },
    )
    selectedDocumentId = documentIdValue
  }

  async function commitDraft(documentIdValue: string, request: DraftSaveRequest): Promise<DraftSaveOutcome> {
    const input: SaveDraftInput = {
      context: {
        requestId: deps.newRequestId() as RequestId,
        workspaceId: workspaceId as WorkspaceId,
        projectId: (projectId ?? null) as ProjectId | null,
        expectedRevision: request.expectedRevision as Revision,
        // 同一草稿序号的重复提交必须命中同一幂等键（重放返回同一结果，绝不二次写入）。
        idempotencyKey: `draft_${request.sessionId}_${documentIdValue}_${request.draftSequence}` as IdempotencyKey,
      },
      documentId: documentIdValue as DocumentId,
      draftSequence: request.draftSequence,
      body: request.body,
      sessionId: request.sessionId,
    }
    const result = await deps.client.saveDraft(input)
    const active = session?.getSnapshot()
    const isCurrent = !disposed && active?.sessionId === request.sessionId &&
      active.inFlightSequence === request.draftSequence && active.revision === request.expectedRevision
    if (!result.ok) {
      if (isCurrent) {
        noteFailure(result.error.code, result.error.message)
        emit()
      }
      return { ok: false, draftSequence: request.draftSequence, code: result.error.code }
    }
    if (isCurrent) {
      noteSuccess()
      lastSavedAt = result.value.savedAt
    }
    return {
      ok: true,
      draftSequence: result.value.draftSequence,
      revision: result.value.revision,
    }
  }

  async function loadTree(): Promise<void> {
    if (projectId === null) {
      documents = []
      return
    }
    const result = await deps.client.listDocumentTree({
      context: readContext(),
      projectId: projectId as ProjectId,
      includeDeleted: false,
    })
    if (!result.ok) {
      noteFailure(result.error.code, result.error.message)
      return
    }
    noteSuccess()
    documents = result.value.documents
  }

  async function loadDocument(documentIdValue: string): Promise<boolean> {
    const result = await deps.client.getDocument({
      context: readContext(),
      documentId: documentIdValue as DocumentId,
    })
    if (!result.ok) {
      noteFailure(result.error.code, result.error.message)
      emit()
      return false
    }
    // 读取期间仍可能有键入；确认旧会话全部保存后才能替换。
    if (!await flushCurrent()) return false
    noteSuccess()
    title = result.value.document.title
    body = result.value.body
    revision = result.value.document.revision
    charCount = result.value.document.charCount
    openSession(documentIdValue, result.value.body, result.value.document.revision)
    return true
  }

  /** 树里第一个可编辑的章节（第一卷 → 第 1 章 的种子结构下就是第一章）。 */
  function firstChapter(): string | null {
    const chapter = documents.find((document) => document.kind === 'chapter' && document.deleted === 0)
    if (chapter !== undefined) return String(chapter.id)
    const anyAlive = documents.find((document) => document.deleted === 0)
    return anyAlive === undefined ? null : String(anyAlive.id)
  }

  async function flushCurrent(): Promise<boolean> {
    const current = session
    const deadline = Date.now() + 15_000
    while (current !== null) {
      await current.flush()
      const snapshot = current.getSnapshot()
      if (disposed || session !== current) return false
      if (snapshot.conflict !== null || snapshot.status === 'error') return false
      if (!snapshot.hasUnsavedChanges && snapshot.inFlightSequence === null) return true
      if (Date.now() >= deadline) return false
    }
    return true
  }

  function toSettingsEntityView(entity: SettingsEntity): SettingsEntityView {
    return {
      id: String(entity.id),
      projectId: String(entity.projectId),
      schemaTemplateId: entity.schemaTemplateId,
      name: entity.name,
      values: entity.values,
      orderKey: entity.orderKey,
      revision: String(entity.revision),
      deleted: entity.deleted !== 0,
    }
  }

  /** 合并一条实体并按存储层的顺序（`order_key, id`）重排，避免刷新后位置漂移。 */
  function mergeSettingsEntity(view: SettingsEntityView): void {
    const next = settingsEntities.filter((entity) => entity.id !== view.id)
    next.push(view)
    next.sort((left, right) => {
      if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1
      if (left.id === right.id) return 0
      return left.id < right.id ? -1 : 1
    })
    settingsEntities = next
  }

  /** 读一条设定实体并合并。返回 false 时 `lastError` 里是脱敏后的原因。 */
  async function loadSettingsEntity(entityId: string): Promise<boolean> {
    settingsLoading = true
    emit()
    try {
      const result = await deps.client.getSettingsEntity({ context: readContext(), entityId })
      if (!result.ok) {
        noteFailure(result.error.code, result.error.message)
        return false
      }
      noteSuccess()
      const view = toSettingsEntityView(result.value.entity)
      mergeSettingsEntity(view)
      selectedSettingsEntityId = view.id
      return true
    } finally {
      settingsLoading = false
      emit()
    }
  }

  function navigate(action: () => Promise<boolean>): Promise<boolean> {
    const task = navigation.then(async () => {
      if (disposed) return false
      if (navigationGuard?.() === false) {
        noteFailure('STATE_INVALID_TRANSITION', '请先完成当前输入，再切换作品或章节。')
        emit()
        return false
      }
      loading = true
      emit()
      try { return await action() }
      finally { loading = false; emit() }
    })
    navigation = task.then(() => {}, () => {})
    return task
  }

  return {
    getSnapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async start(): Promise<void> {
      loading = true
      emit()
      const status = await deps.client.systemStatus()
      if (status.ok) {
        noteSuccess()
        appVersion = status.value.appVersion
        databasePath = status.value.databasePath
        databaseSchemaVersion = status.value.databaseSchemaVersion
        readOnly = status.value.readOnly
        pendingOutboxCount = status.value.pendingOutboxCount
        lastSavedAt = status.value.lastSavedAt
      } else {
        noteFailure(status.error.code, status.error.message)
      }
      await loadTree()
      const target = firstChapter()
      if (target !== null) await loadDocument(target)
      loading = false
      ready = true
      emit()
    },

    async refresh(): Promise<void> {
      await loadTree()
      emit()
    },

    async createProject(name: string): Promise<boolean> {
      return navigate(async () => {
      if (!await flushCurrent()) return false
      const input: ProjectCreateInput = {
        context: {
          requestId: deps.newRequestId() as RequestId,
          workspaceId: workspaceId as WorkspaceId,
          projectId: null,
          expectedRevision: null,
        },
        name,
        seedFirstChapter: true,
      }
      const result = await deps.client.createProject(input)
      if (!result.ok) {
        noteFailure(result.error.code, result.error.message)
        emit()
        return false
      }
      if (!await flushCurrent()) return false
      noteSuccess()
      projectId = String(result.value.projectId)
      deps.projectStore.write(projectId)
      documents = []
      selectedDocumentId = null
      // 换了作品，上一部的设定实体一条都不能留：它们属于别的 projectId。
      settingsEntities = []
      selectedSettingsEntityId = null
      session?.dispose()
      session = null
      title = ''
      body = ''
      revision = null
      charCount = 0
      await loadTree()
      const target = firstChapter()
      if (target !== null) await loadDocument(target)
      emit()
      return true
      })
    },

    async createChapter(chapterTitle: string): Promise<boolean> {
      return navigate(async () => {
      if (!await flushCurrent()) return false
      if (projectId === null) {
        noteFailure('VALIDATION_MISSING_FIELD', '还没有作品，先新建作品再建章节。')
        emit()
        return false
      }
      const input: DocumentCreateInput = {
        context: {
          requestId: deps.newRequestId() as RequestId,
          workspaceId: workspaceId as WorkspaceId,
          projectId: projectId as ProjectId,
          expectedRevision: null,
        },
        projectId: projectId as ProjectId,
        kind: 'chapter',
        parentId: null,
        title: chapterTitle,
        placement: { mode: 'end' },
      }
      const result = await deps.client.createDocument(input)
      if (!result.ok) {
        noteFailure(result.error.code, result.error.message)
        emit()
        return false
      }
      noteSuccess()
      await loadTree()
      const opened = await loadDocument(String(result.value.documentId))
      emit()
      return opened
      })
    },

    async selectDocument(documentIdValue: string): Promise<boolean> {
      return navigate(async () => {
      if (documentIdValue === selectedDocumentId && session !== null) return true
      // 切章前先冲刷：否则防抖窗口里的输入会跟着新章节一起被丢掉。
      if (!await flushCurrent()) return false
      const loaded = await loadDocument(documentIdValue)
      emit()
      return loaded
      })
    },

    edit(nextBody: string): void {
      if (session === null || loading || readOnly || disposed) return
      body = nextBody
      charCount = countChars(nextBody)
      session.onInput(nextBody)
      emit()
    },

    async flush(): Promise<boolean> {
      await navigation
      if (navigationGuard?.() === false) return false
      const saved = await flushCurrent()
      emit()
      return saved
    },

    applyExternalUpdate(update): boolean {
      if (session === null || update.documentId !== selectedDocumentId) return false
      const outcome = session.applyExternalUpdate({ revision: update.revision, body: update.body })
      const sessionSnapshot = session.getSnapshot()
      // 冲突时 session 保留的是**本地**正文，所以这里读快照而不是 read update.body。
      body = sessionSnapshot.body
      charCount = countChars(body)
      revision = sessionSnapshot.revision
      emit()
      return outcome === 'applied'
    },

    retrySave(): void {
      session?.retry()
      emit()
    },

    resolveConflict(resolution: ConflictResolution): void {
      if (session === null) return
      session.resolveConflict(resolution)
      body = session.getSnapshot().body
      charCount = countChars(body)
      revision = session.getSnapshot().revision
      emit()
    },

    toggleExpanded(documentIdValue: string): void {
      expandedIds = expandedIds.includes(documentIdValue)
        ? expandedIds.filter((id) => id !== documentIdValue)
        : [...expandedIds, documentIdValue]
      emit()
    },

    setNavigationGuard(guard): void { navigationGuard = guard },

    async loadSettingsEntities(options: SettingsEntityQuery = {}): Promise<boolean> {
      settingsLoading = true
      emit()
      try {
        // 没有当前作品时 `projectId` 缺省 = 跨作品列出整个工作区（存储层语义）；
        // 有当前作品且没显式要跨作品，就限定到当前作品。
        const scoped = projectId !== null && options.allProjects !== true
        const input: SettingsEntityListInput = {
          context: readContext(),
          ...(scoped ? { projectId: projectId as ProjectId } : {}),
          ...(options.schemaTemplateId === undefined
            ? {}
            : { schemaTemplateId: options.schemaTemplateId }),
          ...(options.includeDeleted === undefined
            ? {}
            : { includeDeleted: options.includeDeleted }),
        }
        const result = await deps.client.listSettingsEntities(input)
        if (!result.ok) {
          noteFailure(result.error.code, result.error.message)
          return false
        }
        noteSuccess()
        settingsEntities = result.value.entities.map(toSettingsEntityView)
        // 选中项可能已不在列表里（被删 / 换了过滤条件）：不能留一个指向空气的 ID。
        if (
          selectedSettingsEntityId !== null &&
          !settingsEntities.some((entity) => entity.id === selectedSettingsEntityId)
        ) {
          selectedSettingsEntityId = null
        }
        return true
      } finally {
        settingsLoading = false
        emit()
      }
    },

    async selectSettingsEntity(entityIdValue: string): Promise<boolean> {
      const known = settingsEntities.find((entity) => entity.id === entityIdValue)
      if (known !== undefined) {
        selectedSettingsEntityId = known.id
        emit()
        return true
      }
      return loadSettingsEntity(entityIdValue)
    },

    async refreshSettingsEntity(entityIdValue: string): Promise<boolean> {
      return loadSettingsEntity(entityIdValue)
    },

    async submitSettingsEntity(submit: SettingsEntitySubmit): Promise<SettingsEntitySubmitResult> {
      if (projectId === null) {
        noteFailure('VALIDATION_MISSING_FIELD', '还没有作品，先新建作品再保存设定。')
        emit()
        return {
          ok: false,
          code: 'VALIDATION_MISSING_FIELD',
          message: '还没有作品，先新建作品再保存设定。',
        }
      }
      const entityId = submit.entityId ?? null
      const known = entityId === null ? undefined : settingsEntities.find((e) => e.id === entityId)
      // 省略 expectedRevision ⇒ 用刚读出来的那份（表单的自然语义）；
      // 显式 null ⇒ 调用方明确要求「不比对旧版本」。
      const expected =
        submit.expectedRevision !== undefined ? submit.expectedRevision : known?.revision ?? null
      const input: SettingsEntitySaveInput = {
        context: {
          requestId: deps.newRequestId() as RequestId,
          workspaceId: workspaceId as WorkspaceId,
          projectId: projectId as ProjectId,
          expectedRevision: expected === null ? null : (expected as Revision),
          ...(submit.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: submit.idempotencyKey as IdempotencyKey }),
        },
        entityId,
        projectId: projectId as ProjectId,
        schemaTemplateId: submit.schemaTemplateId,
        name: submit.name,
        values: submit.values,
        orderKey: submit.orderKey ?? null,
      }
      settingsLoading = true
      emit()
      try {
        const result = await deps.client.saveSettingsEntity(input)
        if (!result.ok) {
          noteFailure(result.error.code, result.error.message)
          return { ok: false, code: result.error.code, message: result.error.message }
        }
        noteSuccess()
        // 服务端只回 { entityId, revision, orderKey }，其余字段用提交的载荷补全：
        // 这些值刚被写进去，回读一次只是为了形状好看，不如直接用已知值。
        const view: SettingsEntityView = {
          id: String(result.value.entityId),
          projectId: String(projectId),
          schemaTemplateId: submit.schemaTemplateId,
          name: submit.name,
          values: submit.values,
          orderKey: String(result.value.orderKey),
          revision: String(result.value.revision),
          deleted: false,
        }
        mergeSettingsEntity(view)
        selectedSettingsEntityId = view.id
        return {
          ok: true,
          entityId: view.id,
          revision: view.revision,
          orderKey: view.orderKey,
        }
      } finally {
        settingsLoading = false
        emit()
      }
    },

    dispose(): void {
      disposed = true
      session?.dispose()
      session = null
      listeners.clear()
    },
  }
}
