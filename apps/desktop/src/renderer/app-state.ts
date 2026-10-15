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
 * `IPC_METHODS` 只有六个方法，**没有"列出作品"**。所以"当前作品"由渲染层自己记住
 * （`projectStore`），首次启动没有任何作品时进入空态由用户新建。
 * 这是可用的临时方案，不是终态：真正的多作品列表需要新增契约命令 + IPC 方法。
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
}

/** 渲染层用到的六个 IPC 方法（与 `apps/desktop/src/shared/ipc/channels.ts` 逐字一致）。 */
export interface RendererClientPort {
  readonly systemStatus: () => Promise<Result<SystemStatusOutput>>
  readonly listDocumentTree: (input: DocumentTreeInput) => Promise<Result<DocumentTreeOutput>>
  readonly getDocument: (input: DocumentGetInput) => Promise<Result<DocumentGetOutput>>
  readonly createProject: (input: ProjectCreateInput) => Promise<Result<ProjectCreateOutput>>
  readonly createDocument: (input: DocumentCreateInput) => Promise<Result<DocumentCreateOutput>>
  readonly saveDraft: (input: SaveDraftInput) => Promise<Result<SaveDraftOutput>>
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

    dispose(): void {
      disposed = true
      session?.dispose()
      session = null
      listeners.clear()
    },
  }
}
