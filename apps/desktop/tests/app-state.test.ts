import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWellFormedId } from '@yfe/contracts'

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
  SettingsEntity,
  SettingsEntityGetInput,
  SettingsEntityGetOutput,
  SettingsEntityListInput,
  SettingsEntityListOutput,
  SettingsEntitySaveInput,
  SettingsEntitySaveOutput,
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

function settingsEntity(input: {
  id: string
  name: string
  schemaTemplateId?: string
  orderKey?: string
  revision?: string
  deleted?: number
  values?: Readonly<Record<string, unknown>>
}): SettingsEntity {
  return {
    id: input.id as SettingsEntity['id'],
    workspaceId: 'ws-local' as SettingsEntity['workspaceId'],
    projectId: 'prj_1' as ProjectId,
    schemaTemplateId: input.schemaTemplateId ?? 'tpl_character',
    name: input.name,
    values: input.values ?? { 阵营: '青云门' },
    orderKey: input.orderKey ?? 'A1',
    revision: rev(input.revision ?? 'rev_1'),
    deleted: input.deleted ?? 0,
    createdAt: ts(AT),
    updatedAt: ts(AT),
  }
}

interface Overrides {
  status?: () => Result<SystemStatusOutput>
  tree?: () => Result<DocumentTreeOutput>
  get?: (documentId: string) => Result<DocumentGetOutput>
  createProject?: (input: ProjectCreateInput) => Result<ProjectCreateOutput> | Promise<Result<ProjectCreateOutput>>
  createDocument?: (input: DocumentCreateInput) => Result<DocumentCreateOutput>
  save?: (input: SaveDraftInput) => Result<SaveDraftOutput> | Promise<Result<SaveDraftOutput>>
  listSettings?: (input: SettingsEntityListInput) => Result<SettingsEntityListOutput>
  getSettings?: (input: SettingsEntityGetInput) => Result<SettingsEntityGetOutput>
  saveSettings?: (
    input: SettingsEntitySaveInput,
  ) => Result<SettingsEntitySaveOutput> | Promise<Result<SettingsEntitySaveOutput>>
}

interface Harness {
  readonly state: AppState
  readonly store: ProjectStorePort & { value: string | null }
  readonly saves: readonly SaveDraftInput[]
  readonly projectInputs: readonly ProjectCreateInput[]
  readonly documentInputs: readonly DocumentCreateInput[]
  readonly overrides: Overrides
  readonly documents: readonly DocumentSummary[]
  readonly settings: readonly SettingsEntity[]
  readonly settingsListInputs: readonly SettingsEntityListInput[]
  readonly settingsSaveInputs: readonly SettingsEntitySaveInput[]
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
  const settings: SettingsEntity[] = [
    settingsEntity({ id: 'wld_1', name: '青云门', schemaTemplateId: 'tpl_faction', orderKey: 'A1' }),
    settingsEntity({ id: 'wld_2', name: '魔教', schemaTemplateId: 'tpl_faction', orderKey: 'A2' }),
  ]
  const settingsListInputs: SettingsEntityListInput[] = []
  const settingsSaveInputs: SettingsEntitySaveInput[] = []

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
    listSettingsEntities: async (input) => {
      settingsListInputs.push(input)
      if (overrides.listSettings !== undefined) return overrides.listSettings(input)
      // 假服务按被请求的作品过滤：状态机有没有真的把作用域传下来，靠它才测得出来。
      const scoped =
        input.projectId === undefined
          ? settings
          : settings.filter((entity) => String(entity.projectId) === String(input.projectId))
      return { ok: true, value: { entities: scoped } }
    },
    getSettingsEntity: async (input) => {
      if (overrides.getSettings !== undefined) return overrides.getSettings(input)
      const found = settings.find((entity) => String(entity.id) === String(input.entityId))
      if (found === undefined) return failure('NOT_FOUND') as never
      return { ok: true, value: { entity: found } }
    },
    saveSettingsEntity: async (input) => {
      settingsSaveInputs.push(input)
      if (overrides.saveSettings !== undefined) return overrides.saveSettings(input)
      const written = settingsEntity({
        // 新建时用例层才生成 ID（在服务端），所以客户端传下来的是 null。
        id: input.entityId ?? 'wld_new',
        name: input.name,
        schemaTemplateId: input.schemaTemplateId,
        orderKey: input.orderKey ?? undefined,
        values: input.values,
        revision: `rev_s${settingsSaveInputs.length}`,
      })
      const index = settings.findIndex((entity) => String(entity.id) === String(written.id))
      if (index >= 0) settings[index] = written
      else settings.push(written)
      return {
        ok: true,
        value: {
          entityId: written.id,
          revision: written.revision,
          orderKey: written.orderKey,
        },
      }
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

  return {
    state,
    store,
    saves,
    projectInputs,
    documentInputs,
    overrides,
    documents,
    settings,
    settingsListInputs,
    settingsSaveInputs,
  }
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
    expect(isWellFormedId(harness.saves[0]?.context.idempotencyKey)).toBe(true)
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
  it('保存失败或冲突时切章/新建均保留旧正文，不创建替代会话', async () => {
    for (const action of ['select', 'chapter', 'project'] as const) {
      const harness = makeHarness({ save: () => failure('STORAGE_DISK_FULL') })
      await harness.state.start()
      harness.state.edit('不能丢失的正文')
      const changed = action === 'select' ? await harness.state.selectDocument('doc_2')
        : action === 'chapter' ? await harness.state.createChapter('新章') : await harness.state.createProject('新作品')
      expect(changed).toBe(false)
      expect(harness.state.getSnapshot().selectedDocumentId).toBe('doc_1')
      expect(harness.state.getSnapshot().body).toBe('不能丢失的正文')
      expect(harness.documentInputs).toHaveLength(0)
      expect(harness.projectInputs).toHaveLength(0)
      harness.state.dispose()
    }
  })

  it('新建章节前冲刷旧稿；重开同文档产生新会话幂等键', async () => {
    const harness = makeHarness()
    await harness.state.start()
    harness.state.edit('切换前正文')
    expect(await harness.state.createChapter('第三章')).toBe(true)
    expect(harness.saves[0]?.body).toBe('切换前正文')
    await harness.state.selectDocument('doc_1')
    harness.state.edit('重开后的正文')
    await harness.state.flush()
    expect(harness.saves[1]?.draftSequence).toBe(1)
    expect(harness.saves[1]?.context.idempotencyKey).not.toBe(harness.saves[0]?.context.idempotencyKey)
    harness.state.dispose()
  })

  it('输入法组合态阻止导航；导航在途禁止编辑，退出冲刷等待导航完成', async () => {
    const harness = makeHarness()
    await harness.state.start()
    harness.state.setNavigationGuard(() => false)
    expect(await harness.state.selectDocument('doc_2')).toBe(false)
    expect(harness.state.getSnapshot().selectedDocumentId).toBe('doc_1')
    harness.state.setNavigationGuard(null)
    let resolveCreation: (result: Result<ProjectCreateOutput>) => void = () => {}
    harness.overrides.createProject = () => new Promise<Result<ProjectCreateOutput>>((resolve) => {
      resolveCreation = resolve
    })
    const creating = harness.state.createProject('导航中的作品')
    await flushMicrotasks()
    harness.state.edit('导航期间不能混入的旧正文')
    expect(harness.state.getSnapshot().body).toBe('第 1 章正文')
    let closed = false
    const closing = harness.state.flush().then((saved) => { closed = true; return saved })
    await flushMicrotasks()
    expect(closed).toBe(false)
    resolveCreation({ ok: true, value: { projectId: 'prj_new' as ProjectId, revision: rev('rev_1') } })
    expect(await creating).toBe(true)
    expect(await closing).toBe(true)
    expect(harness.store.value).toBe('prj_new')
    harness.state.dispose()
  })

  it('旧回执不会把新正文的字数改回旧稿字数，也不会回退冲突裁决版本', async () => {
    const harness = makeHarness()
    let settle: ((result: Result<SaveDraftOutput>) => void) | undefined
    harness.overrides.save = (input) => new Promise<Result<SaveDraftOutput>>((resolve) => {
      settle = resolve
      void input
    })
    await harness.state.start()
    harness.state.edit('短')
    const flushed = harness.state.flush()
    await flushMicrotasks()
    harness.state.edit('这是当前的新正文')
    harness.state.applyExternalUpdate({ documentId: 'doc_1', revision: 'external', body: '外部正文' })
    harness.state.resolveConflict('take-external')
    settle?.(savedOutput(harness.saves[0]!, 1))
    await flushed
    await flushMicrotasks()
    expect(harness.state.getSnapshot().body).toBe('外部正文')
    expect(harness.state.getSnapshot().revision).toBe('external')
    expect(harness.state.getSnapshot().charCount).toBe(4)
    harness.state.dispose()
  })

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

describe('app-state：设定实体通道', () => {
  it('列表限定在当前作品；allProjects 才跨作品；没有作品时不带 projectId', async () => {
    const harness = makeHarness()
    await harness.state.start()
    expect(await harness.state.loadSettingsEntities()).toBe(true)
    expect(harness.settingsListInputs[0]?.projectId).toBe('prj_1')
    expect(harness.settingsListInputs[0]?.context.workspaceId).toBe('ws_local')

    await harness.state.loadSettingsEntities({ allProjects: true, includeDeleted: true })
    expect(harness.settingsListInputs[1]?.projectId).toBeUndefined()
    expect(harness.settingsListInputs[1]?.includeDeleted).toBe(true)

    const empty = makeHarness({}, null)
    await empty.state.start()
    await empty.state.loadSettingsEntities()
    expect(empty.settingsListInputs[0]?.projectId).toBeUndefined()

    const template = makeHarness()
    await template.state.start()
    await template.state.loadSettingsEntities({ schemaTemplateId: 'tpl_faction' })
    expect(template.settingsListInputs[0]?.schemaTemplateId).toBe('tpl_faction')
    harness.state.dispose()
    empty.state.dispose()
    template.state.dispose()
  })

  it('载入后快照直接给出视图；values 原样透传且 ID 不当品牌类型用', async () => {
    const harness = makeHarness()
    await harness.state.start()
    await harness.state.loadSettingsEntities()
    const snapshot = harness.state.getSnapshot()
    expect(snapshot.settingsEntities.map((entity) => entity.id)).toEqual(['wld_1', 'wld_2'])
    expect(snapshot.settingsEntities[0]?.name).toBe('青云门')
    expect(snapshot.settingsEntities[0]?.values).toEqual({ 阵营: '青云门' })
    expect(snapshot.settingsLoading).toBe(false)
    expect(snapshot.selectedSettingsEntity).toBeNull()
    harness.state.dispose()
  })

  it('选中命中本地不发起 get；未命中才读一次；读到后合并并按 order_key 重排', async () => {
    const harness = makeHarness()
    let gets = 0
    harness.overrides.getSettings = (input) => {
      gets += 1
      void input
      return {
        ok: true,
        value: {
          entity: settingsEntity({
            id: 'wld_9',
            name: '散修联盟',
            schemaTemplateId: 'tpl_faction',
            orderKey: 'A15',
          }),
        },
      }
    }
    const { state } = harness
    await state.start()
    await state.loadSettingsEntities()
    expect(await state.selectSettingsEntity('wld_1')).toBe(true)
    expect(gets).toBe(0)
    expect(state.getSnapshot().selectedSettingsEntityId).toBe('wld_1')

    expect(await state.selectSettingsEntity('wld_9')).toBe(true)
    expect(gets).toBe(1)
    const snapshot = state.getSnapshot()
    expect(snapshot.selectedSettingsEntity?.name).toBe('散修联盟')
    // 合并进列表时按 order_key 重排，而不是一律追加到末尾。
    //
    // 🔴 比较是**逐字符**的（与存储层 `ORDER BY order_key, id` 同语义，SQLite 默认
    //    BINARY 排序），所以 'A15' 落在 'A1' 与 'A2' 之间：'1' < '2'。
    //    这正是 order_key 必须由 `orderKeyBetween` 生成、不能手写成 'A15' 的原因——
    //    手写的键在真实排序里不会得到「第 15 位」的直觉位置。
    expect(snapshot.settingsEntities.map((entity) => entity.id)).toEqual(['wld_1', 'wld_9', 'wld_2'])
    state.dispose()
  })

  it('新建提交：entityId 与 expectedRevision 都是 null，结果合并进列表并选中', async () => {
    const harness = makeHarness()
    const { state } = harness
    await state.start()
    const result = await state.submitSettingsEntity({
      schemaTemplateId: 'tpl_faction',
      name: '太虚剑宗',
      values: { 阵营: '正道', 掌门: '李长生' },
      idempotencyKey: 'form_1',
    })
    expect(result).toEqual({ ok: true, entityId: 'wld_new', revision: 'rev_s1', orderKey: 'A1' })
    const sent = harness.settingsSaveInputs[0]
    expect(sent?.entityId).toBeNull()
    expect(sent?.context.expectedRevision).toBeNull()
    expect(sent?.context.projectId).toBe('prj_1')
    expect(sent?.context.idempotencyKey).toBe('form_1')
    expect(sent?.orderKey).toBeNull()
    const snapshot = state.getSnapshot()
    expect(snapshot.selectedSettingsEntityId).toBe('wld_new')
    expect(snapshot.selectedSettingsEntity?.values).toEqual({ 阵营: '正道', 掌门: '李长生' })
    state.dispose()
  })

  it('更新提交：省略 expectedRevision 时自动用已加载的 revision，显式 null 则不比旧版本', async () => {
    const harness = makeHarness()
    const { state } = harness
    await state.start()
    await state.loadSettingsEntities()

    expect(
      await state.submitSettingsEntity({
        entityId: 'wld_1',
        schemaTemplateId: 'tpl_faction',
        name: '青云门（改名）',
        values: { 阵营: '正道' },
      }),
    ).toEqual({ ok: true, entityId: 'wld_1', revision: 'rev_s1', orderKey: 'A1' })
    expect(harness.settingsSaveInputs[0]?.context.expectedRevision).toBe('rev_1')

    // 显式 null = 「不管旧版本」：
    await state.submitSettingsEntity({
      entityId: 'wld_2',
      schemaTemplateId: 'tpl_faction',
      name: '魔教（强制覆盖）',
      values: { 阵营: '邪道' },
      expectedRevision: null,
    })
    expect(harness.settingsSaveInputs[1]?.context.expectedRevision).toBeNull()
    state.dispose()
  })

  it('没有作品时提交不发 IPC；冲突失败把脱敏错误码交给界面并记进 lastError', async () => {
    const empty = makeHarness({}, null)
    await empty.state.start()
    expect(
      await empty.state.submitSettingsEntity({
        schemaTemplateId: 'tpl_faction',
        name: '无作品的设定',
        values: {},
      }),
    ).toEqual({
      ok: false,
      code: 'VALIDATION_MISSING_FIELD',
      message: '还没有作品，先新建作品再保存设定。',
    })
    expect(empty.settingsSaveInputs).toHaveLength(0)
    expect(empty.state.getSnapshot().lastError?.code).toBe('VALIDATION_MISSING_FIELD')

    const harness = makeHarness()
    harness.overrides.saveSettings = () => failure('REVISION_CONFLICT') as never
    await harness.state.start()
    const conflicted = await harness.state.submitSettingsEntity({
      schemaTemplateId: 'tpl_faction',
      name: '被别人改过的设定',
      values: {},
    })
    expect(conflicted.ok).toBe(false)
    expect(conflicted.ok === false && conflicted.code).toBe('REVISION_CONFLICT')
    expect(harness.state.getSnapshot().lastError?.code).toBe('REVISION_CONFLICT')
    expect(harness.state.getSnapshot().settingsEntities).toEqual([])
    empty.state.dispose()
    harness.state.dispose()
  })

  it('读失败不清空已载入的列表；换作品后设定实体全部清空', async () => {
    const harness = makeHarness()
    const { state } = harness
    await state.start()
    await state.loadSettingsEntities()
    expect(state.getSnapshot().settingsEntities).toHaveLength(2)

    harness.overrides.listSettings = () => failure('STORAGE_CORRUPT') as never
    expect(await state.loadSettingsEntities()).toBe(false)
    expect(state.getSnapshot().lastError?.code).toBe('STORAGE_CORRUPT')
    expect(state.getSnapshot().settingsEntities).toHaveLength(2)

    harness.overrides.listSettings = undefined
    expect(await state.createProject('第二部')).toBe(true)
    expect(state.getSnapshot().settingsEntities).toEqual([])
    expect(state.getSnapshot().selectedSettingsEntityId).toBeNull()
    state.dispose()
  })
})
