/**
 * 内存 fake 端口：用例层测试**不碰数据库**（任务硬性要求）。
 *
 * fake 的职责只有两件：
 * 1. 按 `src/ports.ts` 的形状提供最小可用的行为（能建、能读、能提交）；
 * 2. 记录调用次数与最后一次请求，让测试可以断言「用例层到底调了几次端口」。
 *
 * 🔴 fake 刻意**不实现**真实业务规则（如 orderKey 分配、outbox、outbox 事务），
 *    只保留用例层会依赖/会被用例层观察到的部分：归属、revision、草稿水位线。
 *    「适配器该做什么」写在 ports.ts 的注释里，不在这里复制。
 */

import {
  encodeRevision,
  errOf,
  ok,
  type Clock,
  type DeletedFlag,
  type DocumentGetOutput,
  type DocumentId,
  type DocumentKind,
  type DocumentSummary,
  type ProjectId,
  type Result,
  type Revision,
  type SaveDraftOutput,
  type UtcTimestamp,
  type WorkspaceId,
} from '@yfe/contracts'

import {
  createApplicationDeps,
  type ApplicationDeps,
  type ApplicationIdGenerator,
  type ApplicationPorts,
  type CommitDraftRequest,
  type CreateDocumentRequest,
  type CreateProjectRequest,
  type DocumentOwnership,
  type GetDocumentRequest,
  type IdempotencyPort,
  type ListDocumentTreeRequest,
  type SystemStatusFacts,
} from '../src/ports.js'

/** 每个端口方法的调用计数（断言「用例层调用了几次」）。 */
export interface FakeCounts {
  loadDocument: number
  commitDraft: number
  createProject: number
  createDocument: number
  getDocument: number
  listDocumentTree: number
  readSystemStatus: number
}

/** 注入异常用的开关：属性被赋值即抛该值。 */
export interface ThrowConfig {
  loadDocument?: unknown
  commitDraft?: unknown
  createProject?: unknown
  createDocument?: unknown
  getDocument?: unknown
  listDocumentTree?: unknown
  readSystemStatus?: unknown
}

/** 内存里的一篇文档（比 `Document` 多带 `revisionSeq` 便于 fake 推进 revision）。 */
export interface FakeDocument {
  documentId: DocumentId
  workspaceId: string
  projectId: string
  kind: DocumentKind
  parentId: DocumentId | null
  orderKey: string
  title: string
  body: string
  deleted: DeletedFlag
  revisionSeq: number
  revision: Revision
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export interface FakeHarness {
  /** 装配后填充（先建 harness，端口回调里要读 `throwOn` 等状态）。 */
  deps: ApplicationDeps
  ports: ApplicationPorts
  readonly counts: FakeCounts
  readonly documents: Map<string, FakeDocument>
  readonly projects: Map<string, { readonly name: string; readonly projectId: string }>
  readonly commits: CommitDraftRequest[]
  readonly watermarks: Map<string, number>
  readonly throwOn: ThrowConfig
  /** 覆盖 `commitDraft` 的返回（模拟持久化层自己判定出的 `Err`）。 */
  commitOverride?: (request: CommitDraftRequest) => Promise<Result<SaveDraftOutput>>
  lastCreateProject?: CreateProjectRequest
  lastCreateDocument?: CreateDocumentRequest
  lastListTree?: ListDocumentTreeRequest
  lastGetDocument?: GetDocumentRequest
  facts: SystemStatusFacts
}

export interface FakeOptions {
  /** 预置文档（工作区/作品归属由各条自己声明）。 */
  readonly documents?: readonly FakeDocument[]
  readonly clock?: Clock
  readonly ids?: ApplicationIdGenerator
  /** 传入即启用请求级幂等（通常传 `createMemoryIdempotencyLedger().port`）。 */
  readonly idempotency?: IdempotencyPort
  readonly facts?: Partial<SystemStatusFacts>
}

/** 测试用的固定时间戳（用例层的 `savedAt` 必须等于它）。 */
export const TEST_NOW = '2026-10-15T04:00:00.000Z' as UtcTimestamp
/** 测试用的工作区。 */
export const TEST_WORKSPACE = 'ws-test'
/** 测试用的作品。 */
export const TEST_PROJECT = 'prj-a'

/** 建一篇内存文档（默认：测试工作区、作品 A、未删除、revision r00000001）。 */
export function makeDocument(overrides: Partial<FakeDocument> = {}): FakeDocument {
  const id = overrides.documentId ?? ('doc-1' as DocumentId)
  const revisionSeq = overrides.revisionSeq ?? 1
  return {
    documentId: id,
    workspaceId: TEST_WORKSPACE,
    projectId: TEST_PROJECT,
    kind: 'chapter',
    parentId: null,
    orderKey: 'a1',
    title: '第一章',
    body: '初稿',
    deleted: 0,
    revisionSeq,
    revision: encodeRevision(revisionSeq),
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  }
}

/** 从 fake 文档派生端口要返回的归属快照。 */
export function ownershipOf(document: FakeDocument): DocumentOwnership {
  return {
    documentId: document.documentId,
    workspaceId: document.workspaceId as WorkspaceId,
    projectId: document.projectId as ProjectId,
    revision: document.revision,
    deleted: document.deleted,
  }
}

/** 从 fake 文档派生契约摘要（**刻意不含 `workspaceId`**，与契约一致）。 */
export function summaryOf(document: FakeDocument, hasChildren = false): DocumentSummary {
  return {
    id: document.documentId,
    projectId: document.projectId as ProjectId,
    kind: document.kind,
    parentId: document.parentId,
    orderKey: document.orderKey,
    title: document.title,
    deleted: document.deleted,
    revision: document.revision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    // 真实适配器必须用 @yfe/domain 的 countChars；fake 用 Array.from 近似字素计数
    charCount: Array.from(document.body).length,
    hasChildren,
  }
}

/** 顺序 ID 生成器：确定性，便于断言。 */
export function sequentialIds(): ApplicationIdGenerator {
  let counter = 0
  const next = (prefix: string): string => {
    counter += 1
    return `${prefix}-${String(counter).padStart(4, '0')}`
  }
  return {
    revisionRow: () => next('revrow'),
    operation: () => next('op'),
    batch: () => next('batch'),
    project: () => next('prj') as never,
    document: () => next('doc') as never,
  }
}

const DEFAULT_FACTS: SystemStatusFacts = {
  appVersion: '4.0.0-dev.0',
  databaseSchemaVersion: 1,
  databasePath: 'C:/Users/tester/AppData/yfe/yfe.db',
  readOnly: false,
  lastSavedAt: null,
  pendingOutboxCount: 3,
  resourceTemplateVersion: null,
}

function maybeThrow(value: unknown): void {
  if (value !== undefined) throw value
}

/** 装配一套内存端口 + 依赖容器。 */
export function createFakeHarness(options: FakeOptions = {}): FakeHarness {
  const counts: FakeCounts = {
    loadDocument: 0,
    commitDraft: 0,
    createProject: 0,
    createDocument: 0,
    getDocument: 0,
    listDocumentTree: 0,
    readSystemStatus: 0,
  }
  const documents = new Map<string, FakeDocument>()
  for (const document of options.documents ?? []) documents.set(document.documentId, document)

  const harness: FakeHarness = {
    deps: undefined as unknown as ApplicationDeps,
    ports: undefined as unknown as ApplicationPorts,
    counts,
    documents,
    projects: new Map(),
    commits: [],
    watermarks: new Map(),
    throwOn: {},
    facts: { ...DEFAULT_FACTS, ...options.facts },
  }

  const nextRevision = (document: FakeDocument): Revision => {
    document.revisionSeq += 1
    document.revision = encodeRevision(document.revisionSeq)
    return document.revision
  }

  const ports: ApplicationPorts = {
    draft: {
      loadDocument: (documentId) => {
        counts.loadDocument += 1
        maybeThrow(harness.throwOn.loadDocument)
        const document = documents.get(documentId)
        return Promise.resolve(document === undefined ? null : ownershipOf(document))
      },
      commitDraft: (request) => {
        counts.commitDraft += 1
        harness.commits.push(request)
        if (harness.commitOverride !== undefined) return harness.commitOverride(request)
        maybeThrow(harness.throwOn.commitDraft)

        const document = documents.get(request.ownership.documentId)
        if (document === undefined || document.deleted !== 0) {
          return Promise.resolve(
            errOf('NOT_FOUND_DOCUMENT', '文档不存在或已被删除', request.input.context.requestId),
          )
        }
        // 事务内重新校验（TOCTOU）：归属快照过期 → 冲突
        const expected = request.input.context.expectedRevision
        if (document.revision !== request.ownership.revision ||
            (expected !== null && expected !== document.revision)) {
          return Promise.resolve(
            errOf('REVISION_CONFLICT', '文档已被其他改动推进，请基于最新版本重试', request.input.context.requestId, {
              currentRevision: document.revision, expectedRevision: expected,
            }),
          )
        }
        // 已确认更高的草稿序号后再收到旧序号 → 拒绝回写
        const watermark = harness.watermarks.get(document.documentId) ?? -1
        if (request.input.draftSequence < watermark) {
          return Promise.resolve(
            errOf('VALIDATION_OUT_OF_RANGE', 'draftSequence 落后于已确认的序号', request.input.context.requestId, {
              field: 'draftSequence',
            }),
          )
        }
        document.body = request.input.body
        document.updatedAt = request.occurredAt
        harness.watermarks.set(document.documentId, request.input.draftSequence)
        const revision = nextRevision(document)
        return Promise.resolve(
          ok<SaveDraftOutput>({
            revision,
            draftSequence: request.input.draftSequence,
            charCount: Array.from(document.body).length,
            savedAt: request.occurredAt,
          }),
        )
      },
    },
    projects: {
      createProject: (request) => {
        counts.createProject += 1
        harness.lastCreateProject = request
        maybeThrow(harness.throwOn.createProject)
        harness.projects.set(request.projectId, { name: request.name, projectId: request.projectId })
        return Promise.resolve(ok({ revision: encodeRevision(1) }))
      },
    },
    documents: {
      createDocument: (request) => {
        counts.createDocument += 1
        harness.lastCreateDocument = request
        maybeThrow(harness.throwOn.createDocument)
        const siblings = [...documents.values()].filter(
          (document) => document.projectId === request.projectId && document.parentId === request.parentId,
        )
        const orderKey = `a${siblings.length + 1}`
        documents.set(
          request.documentId,
          makeDocument({
            documentId: request.documentId,
            workspaceId: request.context.workspaceId,
            projectId: request.projectId,
            kind: request.kind,
            parentId: request.parentId,
            orderKey,
            title: request.title,
            body: '',
            createdAt: request.occurredAt,
            updatedAt: request.occurredAt,
          }),
        )
        return Promise.resolve(ok({ revision: encodeRevision(1), orderKey }))
      },
      getDocument: (request) => {
        counts.getDocument += 1
        harness.lastGetDocument = request
        maybeThrow(harness.throwOn.getDocument)
        const document = documents.get(request.documentId)
        if (document === undefined || document.deleted !== 0) {
          return Promise.resolve(
            errOf('NOT_FOUND_DOCUMENT', '文档不存在或已被删除', request.context.requestId, {
              field: 'documentId',
            }),
          )
        }
        return Promise.resolve(
          ok<DocumentGetOutput>({ document: summaryOf(document), body: document.body }),
        )
      },
      listDocumentTree: (request) => {
        counts.listDocumentTree += 1
        harness.lastListTree = request
        maybeThrow(harness.throwOn.listDocumentTree)
        const list = [...documents.values()]
          .filter((document) => document.projectId === request.projectId)
          .filter((document) => request.includeDeleted || document.deleted === 0)
          .map((document) => summaryOf(document))
        return Promise.resolve(ok(list))
      },
    },
    system: {
      readSystemStatus: () => {
        counts.readSystemStatus += 1
        maybeThrow(harness.throwOn.readSystemStatus)
        return Promise.resolve(ok(harness.facts))
      },
    },
  }
  if (options.idempotency !== undefined) {
    Object.assign(ports, { idempotency: options.idempotency })
  }

  const overrides: { clock?: Clock; ids?: ApplicationIdGenerator } = {}
  if (options.clock !== undefined) overrides.clock = options.clock
  if (options.ids !== undefined) overrides.ids = options.ids

  harness.ports = ports
  harness.deps = createApplicationDeps(ports, overrides)
  return harness
}
