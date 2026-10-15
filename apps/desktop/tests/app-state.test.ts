import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  DocumentGetOutput,
  DocumentId,
  DocumentSummary,
  DocumentTreeOutput,
  ErrorCode,
  ErrorPayload,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectId,
  RequestId,
  Result,
  Revision,
  SaveDraftInput,
  SaveDraftOutput,
  SystemStatusOutput,
  UtcTimestamp,
} from '@yfe/contracts'

import {
  createAppState,
  type AppState,
  type ProjectStorePort,
  type RendererClientPort,
} from '../src/renderer/app-state.js'

const AT = '2026-01-01T00:00:00.000Z'

function ts(value: string): UtcTimestamp {
  return value as UtcTimestamp
}

function rev(value: string): Revision {
  return value as Revision
}

function failure(code: ErrorCode): { ok: false; error: ErrorPayload } {
  return {
    ok: false,
    error: {
      code,
      message: `${code}：测试装置构造的失败`,
      requestId: 'req_test' as RequestId,
      severity: 'warn',
      retryable: false,
    },
  }
}

/** 把会话内部的 promise 链推完（retry 不走防抖定时器，只推微任务）。 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

interface SummaryInput {
  readonly id: string
  readonly title: string
  readonly kind?: DocumentSummary['kind']
  readonly parentId?: string | null
  readonly orderKey?: string
  readonly charCount?: number
  readonly hasChildren?: boolean
}

function summary(input: SummaryInput): DocumentSummary {
  return {
    id: input.id as DocumentId,
    projectId: 'prj_1' as ProjectId,
    kind: input.kind ?? 'chapter',
    parentId: (input.parentId ?? null) as DocumentId | null,
    orderKey: input.orderKey ?? 'A1',
    title: input.title,
    revision: rev('rev_1'),
    deleted: 0,
    createdAt: ts(AT),
    updatedAt: ts(AT),
    charCount: input.charCount ?? 0,
    hasChildren: input.hasChildren ?? false,
  }
}

function systemStatus(): SystemStatusOutput {
  return {
    appVersion: '4.0.0-dev.0',
    databaseSchemaVersion: 1,
    syncProtocolVersion: { major: 1, minor: 0 },
    pluginApiVersion: '1.0.0',
    resourceTemplateVersion: null,
    databasePath: 'C:/tmp/app.db',
    readOnly: false,
    lastSavedAt: null,
    pendingOutboxCount: 0,
  }
}

function savedOutput(input: SaveDraftInput, sequence: number): Result<SaveDraftOutput> {
  return {
    ok: true,
    value: {
      revision: rev(`rev_${sequence + 10}`),
      draftSequence: input.draftSequence,
      charCount: [...input.body].length,
      savedAt: ts(AT),
    },
  }
}

interface Overrides {
  status?: () => Result<SystemStatusOutput>
  tree?: () => Result<DocumentTreeOutput>
  get?: (documentId: string) => Result<DocumentGetOutput>
  createProject?: (input: ProjectCreateInput) => Result<ProjectCreateOutput>
  createDocument?: (input: DocumentCreateInput) => Result<DocumentCreateOutput>
  save?: (input: SaveDraftInput) => Result<SaveDraftOutput>
}

interface Harness {
  readonly state: AppState
  readonly store: ProjectStorePort & { value: string | null }
  readonly saves: readonly SaveDraftInput[]
  readonly projectInputs: readonly ProjectCreateInput[]
  readonly documentInputs: readonly DocumentCreateInput[]
  readonly overrides: Overrides
  readonly documents: readonly DocumentSummary[]
}

function makeHarness(initial: Overrides = {}, storedProject: string | null = 'prj_1'): Harness {
  const documents: DocumentSummary[] = [
    summary({ id: 'doc_1', title: '第 1 章', charCount: 5 }),
    summary({ id: 'doc_2', title: '第 2 章', orderKey: 'A2', charCount: 5 }),
  ]
  const overrides: Overrides = initial
  const saves: SaveDraftInput[] = []
  const projectInputs: ProjectCreateInput[] = []
  const documentInputs: DocumentCreateInput[] = []

  const client: RendererClientPort = {
    systemStatus: async () => overrides.status?.() ?? { ok: true, value: systemStatus() },
    listDocumentTree: async () => overrides.tree?.() ?? { ok: true, value: { documents } },
    getDocument: async (input) => {
      const id = String(input.documentId)
      if (overrides.get !== undefined) return overrides.get(id)
      const document_ = documents.find((candidate) => String(candidate.id) === id)
      if (document_ === undefined) return failure('NOT_FOUND_DOCUMENT') as never
      return { ok: true, value: { document: document_, body: `${document_.title}正文` } }
    },
    createProject: async (input) => {
      projectInputs.push(input)
      if (overrides.createProject !== undefined) return overrides.createProject(input)
      return { ok: true, value: { projectId: 'prj_new' as ProjectId, revision: rev('rev_1') } }
    },
    createDocument: async (input) => {
      documentInputs.push(input)
      if (overrides.createDocument !== undefined) return overrides.createDocument(input)
      // 假服务必须真的把新章节落进树里：否则 getDocument('doc_new') 会 404，
      // 「新建后选中新章节」测的就是假数据的缺口，而不是实现的导航行为。
      const created = summary({
        id: 'doc_new',
        title: input.title,
        kind: input.kind,
        parentId: input.parentId,
        orderKey: 'A9',
      })
      documents.push(created)
      return {
        ok: true,
        value: { documentId: created.id, revision: rev('rev_1'), orderKey: created.orderKey },
      }
    },
    saveDraft: async (input) => {
      saves.push(input)
      if (overrides.save !== undefined) return overrides.save(input)
      return savedOutput(input, saves.length)
    },
  }

  const store = {
    value: storedProject,
    read: (): string | null => store.value,
    write: (projectId: string | null): void => {
      store.value = projectId
    },
  }

  let counter = 0
  const state = createAppState({
    client,
    projectStore: store,
    newRequestId: () => `req_${++counter}`,
    newSessionId: () => `sess_${counter}`,
    debounceMs: 10,
    maxWaitMs: 50,
  })

  return { state, store, saves, projectInputs, documentInputs, overrides, documents }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('app-state：启动与导航', () => {
  it('没记住作品时进入空态，仍然把系统状态显示出来', async () => {
    const harness = makeHarness({}, null)
    await harness.state.start()
    const snapshot = harness.state.getSnapshot()
    expect(snapshot.ready).toBe(true)
    expect(snapshot.projectId).toBeNull()
    expect(snapshot.tree).toEqual([])
    expect(snapshot.selectedDocumentId).toBeNull()
    expect(snapshot.databasePath).toBe('C:/tmp/app.db')
    expect(snapshot.appVersion).toBe('4.0.0-dev.0')
  })

  it('记住的作品会载入章节树并自动选中第一个章节', async () => {
    const harness = makeHarness()
    await harness.state.start()
    const snapshot = harness.state.getSnapshot()
    expect(snapshot.projectId).toBe('prj_1')
    expect(snapshot.tree.map((node) => node.id)).toEqual(['doc_1', 'doc_2'])
    expect(snapshot.tree[0]?.current).toBe(true)
    expect(snapshot.selectedDocumentId).toBe('doc_1')
    expect(snapshot.title).toBe('第 1 章')
    expect(snapshot.body).toBe('第 1 章正文')
    expect(snapshot.saveStatus).toBe('saved')
  })

  it('章节树按父子关系算深度，父节点标记 hasChildren', async () => {
    const harness = makeHarness({
      tree: () => ({
        ok: true,
        value: {
          documents: [
            summary({ id: 'vol_1', title: '第一卷', kind: 'volume' }),
            summary({ id: 'doc_1', title: '第 1 章', parentId: 'vol_1', orderKey: 'B1' }),
          ],
        },
      }),
    })
    await harness.state.start()
    const tree = harness.state.getSnapshot().tree
    expect(tree.map((node) => [node.id, node.depth])).toEqual([
      ['vol_1', 0],
      ['doc_1', 1],
    ])
    expect(tree[0]?.hasChildren).toBe(true)
  })
})

describe('app-state：保存状态机', () => {
  it('编辑后进入 dirty，防抖到点后按草稿序号提交，成功后回到 saved', async () => {
    vi.useFakeTimers()
    const harness = makeHarness()
    await harness.state.start()

    harness.state.edit('甲甲甲')
    expect(harness.state.getSnapshot().saveStatus).toBe('dirty')
    expect(harness.state.getSnapshot().charCount).toBe(3)

    await vi.advanceTimersByTimeAsync(10)
    expect(harness.saves).toHaveLength(1)
    expect(harness.saves[0]?.body).toBe('甲甲甲')
    expect(harness.saves[0]?.documentId).toBe('doc_1')
    // 幂等键只跟「文档 + 草稿序号」有关：同序号重放必须命中同一条幂等记录。
    expect(harness.saves[0]?.context.idempotencyKey).toBe('draft:doc_1:1')
    expect(harness.saves[0]?.context.expectedRevision).toBe('rev_1')
    expect(harness.state.getSnapshot().saveStatus).toBe('saved')
  })

  it('保存失败进入 error 并保留正文；retry 成功后转 saved', async () => {
    vi.useFakeTimers()
    let failNext = true
    const harness = makeHarness({
      save: (input) => {
        if (failNext) return failure('STORAGE_DISK_FULL')
        return savedOutput(input, 7)
      },
    })
    await harness.state.start()

    harness.state.edit('写了一半')
    await vi.advanceTimersByTimeAsync(10)
    expect(harness.state.getSnapshot().saveStatus).toBe('error')
    expect(harness.state.getSnapshot().body).toBe('写了一半')

    failNext = false
    harness.state.retrySave()
    // retry 不经过防抖定时器，只推微任务链（saveDraft → commitDraft → settle）；
    // advanceTimersByTimeAsync(1) 在没有定时器到点时并不会把这条链跑完。
    await flushMicrotasks()
    expect(harness.state.getSnapshot().saveStatus).toBe('saved')
    expect(harness.state.getSnapshot().body).toBe('写了一半')
  })

  it('网络错误不覆盖本地保存状态：已保存后再载入失败只显示 offline', async () => {
    const harness = makeHarness()
    await harness.state.start()

    harness.overrides.tree = () => failure('SERVICE_UNAVAILABLE') as never
    await harness.state.refresh()

    const snapshot = harness.state.getSnapshot()
    expect(snapshot.saveStatus).toBe('offline')
    expect(snapshot.saveDetail).toContain('本地已保存')
    // 正文与标题必须原样保留：连不上服务不代表本地稿不可信。
    expect(snapshot.body).toBe('第 1 章正文')
    expect(snapshot.title).toBe('第 1 章')
    expect(snapshot.lastError?.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('切章前先冲刷待保存草稿，再载入新章节', async () => {
    vi.useFakeTimers()
    const harness = makeHarness()
    await harness.state.start()

    harness.state.edit('旧章改动')
    await harness.state.selectDocument('doc_2')

    expect(harness.saves).toHaveLength(1)
    expect(harness.saves[0]?.documentId).toBe('doc_1')
    expect(harness.state.getSnapshot().selectedDocumentId).toBe('doc_2')
    expect(harness.state.getSnapshot().body).toBe('第 2 章正文')
  })
})

describe('app-state：冲突与外部更新', () => {
  it('没有本地改动时外部更新直接应用', async () => {
    const harness = makeHarness()
    await harness.state.start()
    const applied = harness.state.applyExternalUpdate({
      documentId: 'doc_1',
      revision: 'rev_99',
      body: '别处改过的正文',
    })
    expect(applied).toBe(true)
    expect(harness.state.getSnapshot().body).toBe('别处改过的正文')
    expect(harness.state.getSnapshot().revision).toBe('rev_99')
  })

  it('有本地未提交改动时进入冲突且不覆盖输入框，裁决后可切到外部版本', async () => {
    const harness = makeHarness()
    await harness.state.start()

    harness.state.edit('我的改动')
    const applied = harness.state.applyExternalUpdate({
      documentId: 'doc_1',
      revision: 'rev_100',
      body: '外部的新正文',
    })

    expect(applied).toBe(false)
    const conflicted = harness.state.getSnapshot()
    expect(conflicted.saveStatus).toBe('conflict')
    expect(conflicted.conflict?.externalRevision).toBe('rev_100')
    expect(conflicted.body).toBe('我的改动')

    harness.state.resolveConflict('take-external')
    const resolved = harness.state.getSnapshot()
    expect(resolved.body).toBe('外部的新正文')
    expect(resolved.revision).toBe('rev_100')
    expect(resolved.conflict).toBeNull()
  })

  it('外部更新只作用于当前章节', async () => {
    const harness = makeHarness()
    await harness.state.start()
    const applied = harness.state.applyExternalUpdate({
      documentId: 'doc_2',
      revision: 'rev_5',
      body: '第二章的外部版本',
    })
    expect(applied).toBe(false)
    expect(harness.state.getSnapshot().body).toBe('第 1 章正文')
    expect(harness.state.getSnapshot().conflict).toBeNull()
  })
})

describe('app-state：新建作品与章节', () => {
  it('新建作品后记住 ID 并载入第一章', async () => {
    const harness = makeHarness({}, null)
    await harness.state.start()
    const created = await harness.state.createProject('青春幻想')
    expect(created).toBe(true)
    expect(harness.store.value).toBe('prj_new')
    expect(harness.projectInputs[0]?.name).toBe('青春幻想')
    expect(harness.projectInputs[0]?.seedFirstChapter).toBe(true)
    expect(harness.projectInputs[0]?.context.projectId).toBeNull()
    expect(harness.state.getSnapshot().projectId).toBe('prj_new')
    expect(harness.state.getSnapshot().selectedDocumentId).toBe('doc_1')
  })

  it('新建章节后刷新树并选中新章节；没有作品时报错而不是静默失败', async () => {
    const harness = makeHarness()
    await harness.state.start()
    expect(await harness.state.createChapter('第 3 章')).toBe(true)
    expect(harness.documentInputs[0]?.kind).toBe('chapter')
    expect(harness.documentInputs[0]?.placement).toEqual({ mode: 'end' })
    expect(harness.state.getSnapshot().selectedDocumentId).toBe('doc_new')

    const empty = makeHarness({}, null)
    await empty.state.start()
    expect(await empty.state.createChapter('第 1 章')).toBe(false)
    expect(empty.state.getSnapshot().lastError?.code).toBe('VALIDATION_MISSING_FIELD')
  })
})
