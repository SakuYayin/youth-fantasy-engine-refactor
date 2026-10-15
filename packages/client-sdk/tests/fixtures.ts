/**
 * 测试夹具：**手写**的固定契约对象 + 几个 transport/信封 helper。
 *
 * 为什么不用 `newIds()`：随机 ID 会让失败输出无法比对，断言需要可读、可复现的字面量。
 * 品牌类型（`WorkspaceId` 等）是纯编译期标记，运行时就是字符串，只能用 `as` 落到字面量上
 * —— 这是契约层既有的约定。
 */
import type { Err, Ok, Result } from '@yfe/contracts'
import type { DocumentId, ProjectId, RequestId, Revision, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
// 契约类型一律从权威来源 @yfe/contracts 取：client-sdk 不重导出（也不"拥有"）它们，
// 只有 transport 这种本包自己发明的类型才从 src 取。
import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  DocumentGetInput,
  DocumentGetOutput,
  DocumentSummary,
  DocumentTreeInput,
  DocumentTreeOutput,
  ProjectCreateInput,
  ProjectCreateOutput,
  SaveDraftInput,
  SaveDraftOutput,
  SystemStatusOutput,
} from '@yfe/contracts'
import type { ClientTransport } from '../src/index.js'

export const WORKSPACE_ID = 'ws_fixture1' as WorkspaceId
export const PROJECT_ID = 'prj_fixture1' as ProjectId
export const DOCUMENT_ID = 'doc_fixture1' as DocumentId
export const SAVED_AT = '2026-10-15T02:00:00.000Z' as UtcTimestamp
export const MAIN_REQUEST_ID = 'req_main_fixture' as RequestId

export const readContext = { requestId: 'req_read_fixture' as RequestId, workspaceId: WORKSPACE_ID }
export const writeContext = {
  requestId: 'req_write_fixture' as RequestId,
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  expectedRevision: 'r0000003' as Revision,
}

export const documentSummary: DocumentSummary = {
  id: DOCUMENT_ID,
  projectId: PROJECT_ID,
  kind: 'chapter',
  parentId: null,
  orderKey: 'a1',
  title: '第一章 雨夜',
  deleted: 0,
  revision: 'r0000003' as Revision,
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  charCount: 1234,
  hasChildren: false,
}

export const saveDraftInput: SaveDraftInput = {
  context: writeContext,
  documentId: DOCUMENT_ID,
  draftSequence: 7,
  body: '她推开窗，雨声灌了进来。',
  sessionId: 'sess-1',
}
export const saveDraftOutput: SaveDraftOutput = {
  revision: 'r0000004' as Revision,
  draftSequence: 7,
  charCount: 14,
  savedAt: SAVED_AT,
}

export const documentTreeInput: DocumentTreeInput = { context: readContext, projectId: PROJECT_ID }
export const documentTreeOutput: DocumentTreeOutput = { documents: [documentSummary] }

export const documentGetInput: DocumentGetInput = { context: readContext, documentId: DOCUMENT_ID }
export const documentGetOutput: DocumentGetOutput = { document: documentSummary, body: '她推开窗，雨声灌了进来。' }

export const projectCreateInput: ProjectCreateInput = { context: writeContext, name: '青春幻想', summary: '第一部' }
export const projectCreateOutput: ProjectCreateOutput = { projectId: PROJECT_ID, revision: 'r0000001' as Revision }

export const documentCreateInput: DocumentCreateInput = {
  context: writeContext,
  projectId: PROJECT_ID,
  kind: 'chapter',
  parentId: null,
  title: '第二章',
  placement: { mode: 'end' },
}
export const documentCreateOutput: DocumentCreateOutput = {
  documentId: DOCUMENT_ID,
  revision: 'r0000005' as Revision,
  orderKey: 'a2',
}

/** 成功值里**故意**放一个绝对路径：证明成功路径逐字透传，不做任何脱敏改写。 */
export const systemStatusOutput: SystemStatusOutput = {
  appVersion: '4.0.0-dev.0',
  databaseSchemaVersion: 7,
  syncProtocolVersion: { major: 1, minor: 0 },
  pluginApiVersion: '1.0.0',
  resourceTemplateVersion: null,
  databasePath: 'D:/yfe/data/db.sqlite3',
  readOnly: false,
  lastSavedAt: SAVED_AT,
  pendingOutboxCount: 3,
}

// ---------------------------------------------------------------------------
// 信封与 transport helper
// ---------------------------------------------------------------------------

export interface TransportCall {
  readonly method: string
  readonly payload: unknown
}

export function successEnvelope(method: string, value: unknown): unknown {
  return { kind: 'response', requestId: MAIN_REQUEST_ID, ok: true, method, value }
}

export function failureEnvelope(method: string, error: Readonly<Record<string, unknown>>): unknown {
  return {
    kind: 'response',
    requestId: MAIN_REQUEST_ID,
    ok: false,
    method,
    error: { requestId: MAIN_REQUEST_ID, ...error },
  }
}

/** 记录调用的 transport：把「transport 有没有被调用、收到什么载荷」变成可断言的事实。 */
export function recordingTransport(responder: (method: string, payload: unknown) => unknown): {
  readonly transport: ClientTransport
  readonly calls: TransportCall[]
} {
  const calls: TransportCall[] = []
  return {
    calls,
    transport: {
      call: (method, payload) => {
        calls.push({ method, payload })
        return Promise.resolve(responder(method, payload))
      },
    },
  }
}

export interface DeferredTransport {
  readonly transport: ClientTransport
  readonly calls: TransportCall[]
  resolve(value: unknown): void
  reject(reason: unknown): void
}

/** 永不主动 settle 的 transport：用来验证超时与「迟到结果被忽略」。 */
export function deferredTransport(): DeferredTransport {
  const calls: TransportCall[] = []
  let settle: { resolve: (value: unknown) => void; reject: (reason: unknown) => void } | undefined
  return {
    calls,
    transport: {
      call: (method, payload) => {
        calls.push({ method, payload })
        return new Promise<unknown>((resolve, reject) => {
          settle = { resolve, reject }
        })
      },
    },
    resolve: (value) => settle?.resolve(value),
    reject: (reason) => settle?.reject(reason),
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 断言 helper：让「结果是 ok 还是 err」的失败信息可读
// ---------------------------------------------------------------------------

export function expectOk<T>(result: Result<T>): Ok<T> {
  if (!result.ok) {
    throw new Error(`期望 ok，实际是 err：${JSON.stringify(result.error)}`)
  }
  return result
}

export function expectErr<T>(result: Result<T>): Err {
  if (result.ok) {
    throw new Error(`期望 err，实际是 ok：${JSON.stringify(result.value)}`)
  }
  return result
}
