// @vitest-environment happy-dom
/**
 * 外壳功能端口实现（`apps/desktop/src/renderer/features/ports.ts`）单元测试。
 *
 * 被测对象是界面与主进程之间唯一的粘合层，硬纪律是「端口方法永不抛异常」：
 * IPC 拒绝、畸形载荷、契约失败都必须折算成 `FeatureResult` 失败，绝不穿过组件边界。
 * 本文件用假 `invoke` / 假 `AppState` / 内存 storage 逐条钉住这条纪律，
 * 外加四个投影函数对畸形输入的兜底行为。
 *
 * 期望值全部来自逐行读源码（关键行号写在用例里），不来自注释里的口头描述：
 * 例如 `projectToView` 的 `revision` 根本不兜底（`ports.ts:207` 是 `asString`），
 * 缺字段会抛 `TypeError`，只有经 `toFeatureResult` 才折成 INTERNAL_ERROR。
 */
import { describe, expect, it, vi } from 'vitest'
import { errOf, ok } from '@yfe/contracts'
import type {
  BackupCreateInput,
  BackupCreateOutput,
  BackupListOutput,
  BackupRestoreInput,
  BackupRestoreOutput,
  BackupVerifyInput,
  BackupVerifyOutput,
  Project,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectDeleteInput,
  ProjectDeleteOutput,
  ProjectId,
  ProjectListInput,
  ProjectListOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  RequestId,
  Result,
  Revision,
  UtcTimestamp,
  WorkspaceId,
} from '@yfe/contracts'

import type { AppSnapshot, AppState } from '../../src/renderer/app-state.js'
import { LOCAL_WORKSPACE_ID } from '../../src/shared/local-workspace.js'
import {
  EDITOR_FONT_SIZE_KEY,
  SETTINGS_KEYS,
  type SettingsStorage,
} from '../../src/renderer/features/settings-store.js'
import {
  WELCOME_SEEN_KEY,
  backupCreateToView,
  backupEntryToView,
  backupVerifyToView,
  createFeaturePorts,
  projectToView,
} from '../../src/renderer/features/ports.js'
import type { FeaturePortDeps, InvokeLike } from '../../src/renderer/features/ports.js'
import type {
  AppSettingsView,
  BackupCreateReport,
  BackupEntryView,
  BackupPort,
  BackupVerifyReport,
  FeatureResult,
  ProjectHubSnapshot,
  ProjectHubStore,
  ProjectSummaryView,
  SettingsPort,
  WelcomePort,
} from '../../src/renderer/features/types.js'

const AT = '2026-01-01T00:00:00.000Z'
const AT_LATER = '2026-01-02T00:00:00.000Z'

// --- 品牌类型只能断言构造（`Brand` 与 `brand` 都未导出，见 contracts/src/ids.ts:13-46） ---

function pid(value: string): ProjectId {
  return value as ProjectId
}

function wid(value: string): WorkspaceId {
  return value as WorkspaceId
}

function rev(value: string): Revision {
  return value as Revision
}

function reqId(value: string): RequestId {
  return value as RequestId
}

function stamp(value: string): UtcTimestamp {
  return value as UtcTimestamp
}

// --- 夹具 -------------------------------------------------------------------

/** 契约 `Project` 实体（`invoke.listProjects` 返回的那种形状）。 */
function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: pid('project_1'),
    workspaceId: wid(LOCAL_WORKSPACE_ID),
    deleted: 0,
    revision: rev('rev-1'),
    createdAt: stamp(AT),
    updatedAt: stamp(AT_LATER),
    name: '第一部',
    summary: '摘要',
    projectType: 'full',
    ...overrides,
  }
}

/** `projectToView()` 对上面那份 `Project` 的投影结果。 */
function projectViewFixture(overrides: Partial<ProjectSummaryView> = {}): ProjectSummaryView {
  return {
    id: 'project_1',
    name: '第一部',
    summary: '摘要',
    projectType: 'full',
    createdAt: AT,
    updatedAt: AT_LATER,
    revision: 'rev-1',
    ...overrides,
  }
}

/** 畸形/可控的投影输入：故意用 `Record<string, unknown>` 让字段类型不受契约约束。 */
function loose(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'project_1',
    name: '第一部',
    summary: '摘要',
    projectType: 'full',
    createdAt: AT,
    updatedAt: AT_LATER,
    revision: 'rev-1',
    ...overrides,
  }
}

function backupEntryFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backupPath: 'C:/data/backups/snap-1.db',
    manifestPath: 'C:/data/backups/snap-1.json',
    label: '手动备份',
    createdAt: AT,
    byteSize: 2048,
    readable: true,
    ...overrides,
  }
}

// --- 断言辅助 ---------------------------------------------------------------

/** 解包成功结果；失败时把 code/message 直接抛出来，定位坏掉的行为。 */
function expectOk<T>(result: FeatureResult<T>): T {
  if (!result.ok) {
    throw new Error(`预期端口调用成功，实际失败：${result.code} / ${result.message}`)
  }
  return result.value
}

/** 解包失败结果；成功时直接抛。 */
function expectFailure(result: FeatureResult<unknown>): {
  readonly code: string
  readonly message: string
} {
  if (result.ok) throw new Error('预期端口调用失败，实际成功')
  return { code: result.code, message: result.message }
}

/** `AppState` 是大接口，测试只提供真正走到的成员。 */
function asAppState(partial: Partial<AppState>): AppState {
  return partial as unknown as AppState
}

/** `AppSnapshot` 同理：只提供 `getSnapshot()` 被读到的字段。 */
function asSnapshot(partial: Partial<AppSnapshot>): AppSnapshot {
  return partial as unknown as AppSnapshot
}

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const entries = new Map<string, string>(Object.entries(initial))
  return {
    entries,
    getItem: vi.fn((key: string): string | null => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string): void => {
      entries.set(key, value)
    }),
    removeItem: vi.fn((key: string): void => {
      entries.delete(key)
    }),
  }
}

/** 隐私模式下的 `localStorage`：一读就抛（settings-store.ts:115-121 的 `safeRead` 为它存在）。 */
function getItemThrowingStorage(): SettingsStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError：storage 不可用')
    },
    setItem: () => {},
    removeItem: () => {},
  }
}

/** 写不进去的 storage（配额满 / 只读）。 */
function setItemThrowingStorage(): SettingsStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {},
  }
}

interface HarnessOptions {
  /** 快照里的当前作品；缺省 null（空态首页）。 */
  readonly projectId?: string | null
  /** 显式工作区 id；缺省不传（走 `LOCAL_WORKSPACE_ID`）。 */
  readonly workspaceId?: string
  readonly storage?: SettingsStorage
  /** 窗口宽度；缺省 1280（`autoZoomForWidth(1280) === 100`）。 */
  readonly windowWidth?: number
  readonly createDemoProject?: FeaturePortDeps['createDemoProject']
}

function makeHarness(options: HarnessOptions = {}) {
  let snapshot: AppSnapshot = asSnapshot({
    projectId: options.projectId === undefined ? null : options.projectId,
    lastError: null,
  })
  const openProject = vi.fn(async (_projectId: string | null): Promise<boolean> => true)
  const state = asAppState({ getSnapshot: () => snapshot, openProject })

  const listProjects = vi.fn(
    async (_input: ProjectListInput): Promise<Result<ProjectListOutput>> => ok({ projects: [] }),
  )
  const createProject = vi.fn(
    async (_input: ProjectCreateInput): Promise<Result<ProjectCreateOutput>> =>
      ok({ projectId: pid('project_new'), revision: rev('rev-new') }),
  )
  const updateProject = vi.fn(
    async (_input: ProjectUpdateInput): Promise<Result<ProjectUpdateOutput>> =>
      ok({ projectId: pid('project_1'), revision: rev('rev-2') }),
  )
  const deleteProject = vi.fn(
    async (_input: ProjectDeleteInput): Promise<Result<ProjectDeleteOutput>> =>
      ok({ projectId: pid('project_1'), revision: rev('rev-2') }),
  )
  const backupList = vi.fn(async (): Promise<Result<BackupListOutput>> => ok({ backups: [] }))
  const backupCreate = vi.fn(
    async (_input: BackupCreateInput): Promise<Result<BackupCreateOutput>> =>
      ok({
        backupPath: 'C:/data/backups/snap-1.db',
        manifestPath: 'C:/data/backups/snap-1.json',
        createdAt: stamp(AT),
        byteSize: 2048,
        durationMs: 37,
      }),
  )
  const backupVerify = vi.fn(
    async (_input: BackupVerifyInput): Promise<Result<BackupVerifyOutput>> =>
      ok({
        backupPath: 'C:/data/backups/snap-1.db',
        manifestPath: 'C:/data/backups/snap-1.json',
        label: '手动备份',
        createdAt: stamp(AT),
        integrity: 'ok',
        databaseSchemaVersion: 3,
        needsMigration: false,
        byteSize: 2048,
      }),
  )
  const backupRestore = vi.fn(
    async (_input: BackupRestoreInput): Promise<Result<BackupRestoreOutput>> =>
      ok({
        targetPath: 'C:/data/restore-preview/snap-1.db',
        manifestPath: 'C:/data/restore-preview/snap-1.json',
        byteSize: 2048,
        verified: true,
      }),
  )

  const invoke: InvokeLike = {
    createProject,
    listProjects,
    updateProject,
    deleteProject,
    backupCreate,
    backupList,
    backupVerify,
    backupRestore,
  }

  let requestSeq = 0
  const newRequestId = vi.fn(() => `req_${(requestSeq += 1)}`)
  const storage = options.storage ?? memoryStorage()
  const deps: FeaturePortDeps = {
    state,
    invoke,
    storage,
    newRequestId,
    windowWidth: () => options.windowWidth ?? 1280,
    workspaceId: options.workspaceId,
    createDemoProject: options.createDemoProject,
  }

  const ports = createFeaturePorts(deps)

  return {
    deps,
    ports,
    hub: ports.hub,
    backup: ports.backup,
    settings: ports.settings,
    welcome: ports.welcome,
    state,
    openProject,
    listProjects,
    createProject,
    updateProject,
    deleteProject,
    backupList,
    backupCreate,
    backupVerify,
    backupRestore,
    storage,
    newRequestId,
    setSnapshot(patch: Partial<AppSnapshot>): void {
      snapshot = asSnapshot({ ...snapshot, ...patch })
    },
  }
}

// ===========================================================================
// createProjectHubStore —— 快照与列表
// ===========================================================================

describe('createProjectHubStore / 快照与列表', () => {
  it('getSnapshot().currentProjectId 每次都现读 AppState，不缓存旧值', () => {
    const h = makeHarness({ projectId: 'project_1' })

    expect(h.hub.getSnapshot().currentProjectId).toBe('project_1')

    h.setSnapshot({ projectId: 'project_2' })

    expect(h.hub.getSnapshot().currentProjectId).toBe('project_2')
  })

  it('refresh() 在请求发出前就同步把 loading 置为 true 并通知订阅者', async () => {
    const h = makeHarness()
    const seen: ProjectHubSnapshot[] = []
    h.hub.subscribe((next) => seen.push(next))

    const pending = h.hub.refresh()

    expect(h.hub.getSnapshot().loading).toBe(true)
    expect(seen.map((item) => item.loading)).toEqual([true])
    await pending
  })

  it('refresh() 成功后 loading 归 false、列表落地成视图、lastError 清空', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValue(ok({ projects: [projectFixture()] }))

    await h.hub.refresh()

    expect(h.hub.getSnapshot()).toEqual({
      projects: [projectViewFixture()],
      loading: false,
      lastError: null,
      currentProjectId: null,
    })
  })

  it('refresh() 在开始与结束各通知一次订阅者（两次）', async () => {
    const h = makeHarness()
    const seen: ProjectHubSnapshot[] = []
    h.hub.subscribe((next) => seen.push(next))

    await h.hub.refresh()

    expect(seen.map((item) => item.loading)).toEqual([true, false])
  })

  it('refresh() 收到契约失败时不抛异常，把 code/message 原样写进 lastError', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValueOnce(errOf('STORAGE_UNAVAILABLE', '磁盘没挂上', reqId('req_x')))

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: '磁盘没挂上',
    })
    expect(h.hub.getSnapshot().lastError).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: '磁盘没挂上',
    })
  })

  it('refresh() 失败时保留上一次成功拉到的列表，不清空', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValueOnce(ok({ projects: [projectFixture()] }))
    await h.hub.refresh()

    h.listProjects.mockResolvedValueOnce(errOf('NETWORK_TIMEOUT', '读列表超时', reqId('req_x')))
    await h.hub.refresh()

    expect(h.hub.getSnapshot().projects.map((item) => item.id)).toEqual(['project_1'])
  })

  it('refresh() 的 IPC 直接 reject 时折算成 INTERNAL_ERROR 而不是冒泡', async () => {
    const h = makeHarness()
    h.listProjects.mockRejectedValue(new Error('IPC 通道断了'))

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用失败：IPC 通道断了',
    })
  })

  it('listProjects 返回的不是 Result 形状时折算成「调用没有返回可识别的结果」', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValue(null as unknown as Result<ProjectListOutput>)

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用没有返回可识别的结果',
    })
  })

  it('失败载荷缺 code/message 时用 INTERNAL_ERROR 与「调用失败（CODE）」兜底', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValue({ ok: false, error: {} } as unknown as Result<ProjectListOutput>)

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用失败（INTERNAL_ERROR）',
    })
  })

  it('列表项缺 revision 时投影抛异常被折成「返回数据缺少必要字段」', async () => {
    const h = makeHarness()
    const broken = projectFixture() as unknown as Record<string, unknown>
    delete broken['revision']
    h.listProjects.mockResolvedValue(
      ok({ projects: [broken as unknown as Project] }),
    )

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '返回数据缺少必要字段',
    })
  })

  it('list() 只请求一次，不写快照也不通知订阅者', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValueOnce(ok({ projects: [projectFixture()] }))
    const seen: ProjectHubSnapshot[] = []
    h.hub.subscribe((next) => seen.push(next))

    const result = await h.hub.list()

    expect(expectOk(result).map((item) => item.id)).toEqual(['project_1'])
    expect(h.hub.getSnapshot().projects).toEqual([])
    expect(seen).toEqual([])
  })
})

// ===========================================================================
// createProjectHubStore —— 写操作与生命周期
// ===========================================================================

describe('createProjectHubStore / 写操作与生命周期', () => {
  it('create() 成功后自动刷新列表（listProjects 被调用一次）', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })

    expect(h.listProjects).toHaveBeenCalledTimes(1)
  })

  it('create() 失败时不刷新列表', async () => {
    const h = makeHarness()
    h.createProject.mockResolvedValue(errOf('VALIDATION_FAILED', '名字不能为空', reqId('req_x')))

    await h.hub.create({ name: '' })

    expect(h.listProjects).not.toHaveBeenCalled()
  })

  it('create() 缺省 seedFirstChapter 时给 IPC 传 true', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })

    expect(h.createProject.mock.calls[0]![0].seedFirstChapter).toBe(true)
  })

  it('create() 显式 seedFirstChapter:false 时给 IPC 传 false', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书', seedFirstChapter: false })

    expect(h.createProject.mock.calls[0]![0].seedFirstChapter).toBe(false)
  })

  it('create() 把 request.projectType 映射到 IPC 入参的 templateId', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书', projectType: 'custom' })

    expect(h.createProject.mock.calls[0]![0].templateId).toBe('custom')
  })

  it('create() 缺省 idempotencyKey 时入参 context 里没有这个键', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })

    expect('idempotencyKey' in h.createProject.mock.calls[0]![0].context).toBe(false)
  })

  it('create() 提供 idempotencyKey 时原样写进 context', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书', idempotencyKey: 'idem_1' })

    expect(h.createProject.mock.calls[0]![0].context.idempotencyKey).toBe('idem_1')
  })

  it('create() 的 context 用 projectId=null 与 expectedRevision=null 表示「还没有作品」', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })

    const context = h.createProject.mock.calls[0]![0].context
    expect(context.projectId).toBeNull()
    expect(context.expectedRevision).toBeNull()
  })

  it('create() 的 context.requestId 来自 deps.newRequestId()', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })

    expect(h.createProject.mock.calls[0]![0].context.requestId).toBe('req_1')
    expect(h.newRequestId).toHaveBeenCalled()
  })

  it('remove() 删掉的正好是当前作品时让 AppState 退出到空态', async () => {
    const h = makeHarness({ projectId: 'project_1' })

    await h.hub.remove('project_1')

    expect(h.openProject).toHaveBeenCalledWith(null)
  })

  it('remove() 删掉的不是当前作品时不动 AppState 的当前作品', async () => {
    const h = makeHarness({ projectId: 'project_2' })

    await h.hub.remove('project_1')

    expect(h.openProject).not.toHaveBeenCalled()
  })

  it('rename() 用列表里读到的 revision 作为 CAS 的 expectedRevision', async () => {
    const h = makeHarness()
    h.listProjects.mockResolvedValueOnce(
      ok({ projects: [projectFixture({ revision: rev('rev-7') })] }),
    )
    await h.hub.refresh()

    await h.hub.rename('project_1', '新名字')

    const context = h.updateProject.mock.calls[0]![0].context
    expect(context.projectId).toBe('project_1')
    expect(context.expectedRevision).toBe('rev-7')
  })

  it('rename() 在列表里找不到该作品时 expectedRevision 退化为 null', async () => {
    const h = makeHarness()

    await h.hub.rename('project_404', '新名字')

    expect(h.updateProject.mock.calls[0]![0].context.expectedRevision).toBeNull()
  })

  it('open() 成功时返回 ok:null 并通知订阅者', async () => {
    const h = makeHarness()
    const seen: ProjectHubSnapshot[] = []
    h.hub.subscribe((next) => seen.push(next))

    const result = await h.hub.open('project_1')

    expect(h.openProject).toHaveBeenCalledWith('project_1')
    expect(expectOk(result)).toBeNull()
    expect(seen).toHaveLength(1)
  })

  it('open() 失败时取 AppState 的 lastError 作为失败原因', async () => {
    const h = makeHarness()
    h.openProject.mockResolvedValue(false)
    h.setSnapshot({ lastError: { code: 'REVISION_CONFLICT', message: '草稿冲刷失败' } })

    const result = await h.hub.open('project_2')

    expect(expectFailure(result)).toEqual({
      code: 'REVISION_CONFLICT',
      message: '草稿冲刷失败',
    })
  })

  it('open() 失败且 lastError 为空时用 INTERNAL_ERROR / 打开作品失败 兜底', async () => {
    const h = makeHarness()
    h.openProject.mockResolvedValue(false)

    const result = await h.hub.open('project_2')

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '打开作品失败',
    })
  })

  it('close() 失败且 lastError 为空时用「返回作品列表失败」兜底', async () => {
    const h = makeHarness()
    h.openProject.mockResolvedValue(false)

    const result = await h.hub.close()

    expect(h.openProject).toHaveBeenCalledWith(null)
    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '返回作品列表失败',
    })
  })

  it('dispose() 之后 refresh() 返回 STATE_INVALID_TRANSITION', async () => {
    const h = makeHarness()
    h.hub.dispose()

    const result = await h.hub.refresh()

    expect(expectFailure(result)).toEqual({
      code: 'STATE_INVALID_TRANSITION',
      message: '作品中心已关闭',
    })
  })

  it('dispose() 之后 refresh() 不再通知已订阅的监听者', async () => {
    const h = makeHarness()
    const seen: ProjectHubSnapshot[] = []
    h.hub.subscribe((next) => seen.push(next))
    h.hub.dispose()

    await h.hub.refresh()

    expect(seen).toEqual([])
  })

  it('subscribe() 返回的退订函数真的能阻止后续通知', async () => {
    const h = makeHarness()
    const seen: ProjectHubSnapshot[] = []
    const unsubscribe = h.hub.subscribe((next) => seen.push(next))

    unsubscribe()
    await h.hub.refresh()

    expect(seen).toEqual([])
  })

  it('写操作的 context.workspaceId 缺省用 LOCAL_WORKSPACE_ID', async () => {
    const h = makeHarness()

    await h.hub.create({ name: '新书' })
    await h.hub.rename('project_1', '新名字')
    await h.hub.remove('project_1')

    expect(h.createProject.mock.calls[0]![0].context.workspaceId).toBe(LOCAL_WORKSPACE_ID)
    expect(h.updateProject.mock.calls[0]![0].context.workspaceId).toBe(LOCAL_WORKSPACE_ID)
    expect(h.deleteProject.mock.calls[0]![0].context.workspaceId).toBe(LOCAL_WORKSPACE_ID)
  })

  it('显式传 workspaceId 时读与写都用它', async () => {
    const h = makeHarness({ workspaceId: 'ws_other' })

    await h.hub.list()
    await h.hub.create({ name: '新书' })

    expect(h.listProjects.mock.calls[0]![0].context.workspaceId).toBe('ws_other')
    expect(h.createProject.mock.calls[0]![0].context.workspaceId).toBe('ws_other')
  })
})

// ===========================================================================
// createBackupPort
// ===========================================================================

describe('createBackupPort', () => {
  it('list() 调用 IPC 时不带任何入参', async () => {
    const h = makeHarness()

    await h.backup.list()

    expect(h.backupList).toHaveBeenCalledWith()
    expect(h.backupList.mock.calls[0]).toEqual([])
  })

  it('list() 成功时把备份项投影成视图（readable 严格 true 才为 true）', async () => {
    const h = makeHarness()
    h.backupList.mockResolvedValue(
      ok({
        backups: [
          backupEntryFixture(),
          backupEntryFixture({ backupPath: 'C:/data/backups/snap-2.db', readable: false }),
        ] as unknown as BackupListOutput['backups'],
      }),
    )

    const result = await h.backup.list()

    const views: readonly BackupEntryView[] = expectOk(result)
    expect(views).toEqual([
      {
        backupPath: 'C:/data/backups/snap-1.db',
        label: '手动备份',
        createdAt: AT,
        byteSize: 2048,
        readable: true,
      },
      {
        backupPath: 'C:/data/backups/snap-2.db',
        label: '手动备份',
        createdAt: AT,
        byteSize: 2048,
        readable: false,
      },
    ])
  })

  it('create() 缺省 label 时给 IPC 传空对象', async () => {
    const h = makeHarness()

    await h.backup.create()

    expect(h.backupCreate.mock.calls[0]![0]).toEqual({})
  })

  it('create() 带 label 时给 IPC 传 { label }', async () => {
    const h = makeHarness()

    await h.backup.create('手动备份')

    expect(h.backupCreate.mock.calls[0]![0]).toEqual({ label: '手动备份' })
  })

  it('create() 成功时投影出四个字段（createdAt 是 string）', async () => {
    const h = makeHarness()

    const report: BackupCreateReport = expectOk(await h.backup.create())

    expect(report).toEqual({
      backupPath: 'C:/data/backups/snap-1.db',
      byteSize: 2048,
      createdAt: AT,
      durationMs: 37,
    })
  })

  it('verify() 把 backupPath 原样转发，并把 integrity 固定成 ok', async () => {
    const h = makeHarness()

    const report: BackupVerifyReport = expectOk(await h.backup.verify('C:/data/backups/snap-1.db'))

    expect(h.backupVerify.mock.calls[0]![0]).toEqual({ backupPath: 'C:/data/backups/snap-1.db' })
    expect(report).toEqual({
      backupPath: 'C:/data/backups/snap-1.db',
      integrity: 'ok',
      databaseSchemaVersion: 3,
      needsMigration: false,
      byteSize: 2048,
      createdAt: AT,
    })
  })

  it('restore() 缺省 overwrite 时入参里没有这个键', async () => {
    const h = makeHarness()

    await h.backup.restore('C:/data/backups/snap-1.db')

    const input = h.backupRestore.mock.calls[0]![0]
    expect(input).toEqual({ backupPath: 'C:/data/backups/snap-1.db' })
    expect('overwrite' in input).toBe(false)
  })

  it('restore() 显式 overwrite:true 时入参里有这个键', async () => {
    const h = makeHarness()

    await h.backup.restore('C:/data/backups/snap-1.db', true)

    expect(h.backupRestore.mock.calls[0]![0]).toEqual({
      backupPath: 'C:/data/backups/snap-1.db',
      overwrite: true,
    })
  })

  it('restore() 只投影 targetPath 与 byteSize', async () => {
    const h = makeHarness()

    const restored = expectOk(await h.backup.restore('C:/data/backups/snap-1.db'))

    expect(restored).toEqual({ targetPath: 'C:/data/restore-preview/snap-1.db', byteSize: 2048 })
  })

  it('list() 把契约失败原样折算成 FeatureResult 失败', async () => {
    const h = makeHarness()
    h.backupList.mockResolvedValue(errOf('STORAGE_UNAVAILABLE', '备份目录不可读', reqId('req_x')))

    expect(expectFailure(await h.backup.list())).toEqual({
      code: 'STORAGE_UNAVAILABLE',
      message: '备份目录不可读',
    })
  })

  it('create() 把契约失败原样折算成 FeatureResult 失败', async () => {
    const h = makeHarness()
    h.backupCreate.mockResolvedValue(errOf('STORAGE_DISK_FULL', '磁盘满了', reqId('req_x')))

    expect(expectFailure(await h.backup.create())).toEqual({
      code: 'STORAGE_DISK_FULL',
      message: '磁盘满了',
    })
  })

  it('verify() 的 IPC reject 被折算成 INTERNAL_ERROR 而不是冒泡', async () => {
    const h = makeHarness()
    h.backupVerify.mockRejectedValue(new Error('主进程没有响应'))

    expect(expectFailure(await h.backup.verify('C:/data/backups/snap-1.db'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用失败：主进程没有响应',
    })
  })

  it('restore() 的 IPC reject 被折算成 INTERNAL_ERROR 而不是冒泡', async () => {
    const h = makeHarness()
    h.backupRestore.mockRejectedValue(new Error('目标被占用'))

    expect(expectFailure(await h.backup.restore('C:/data/backups/snap-1.db'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用失败：目标被占用',
    })
  })

  it('list() 收到缺 byteSize 的备份项时折成「返回数据缺少必要字段」', async () => {
    const h = makeHarness()
    h.backupList.mockResolvedValue(
      ok({ backups: [backupEntryFixture({ byteSize: undefined })] as unknown as BackupListOutput['backups'] }),
    )

    expect(expectFailure(await h.backup.list())).toEqual({
      code: 'INTERNAL_ERROR',
      message: '返回数据缺少必要字段',
    })
  })
})

// ===========================================================================
// createSettingsPort
// ===========================================================================

describe('createSettingsPort', () => {
  it('load() 在空存储上给出默认视图', () => {
    const h = makeHarness()

    expect(h.settings.load()).toEqual<AppSettingsView>({
      themeId: 'eye-care',
      fontFamily: null,
      fontSize: '16px',
      zoomPercent: 100,
      // 空存储 = 从未手动调过缩放 ⇒ 自动模式（`isZoomAuto` 只在键值恰为 `'1'` 时为假）。
      // 上游同口径：`upstream/src/lib/settings/theme.ts:173-175`。
      zoomManual: false,
      sidebarWidth: 224,
      collapsedGroups: [],
    })
  })

  it('全新配置（无任何设置键）时缩放模式是自动，与上游一致', () => {
    const h = makeHarness()

    // 上游 `upstream/src/lib/settings/theme.ts:173-175` 是
    // `isZoomAuto() { return safeGet(ZOOM_MANUAL_KEY) !== '1' }` —— 缺键 = 自动。
    // 本仓曾反向判定（只在 `'0'` 时为自动），导致新用户首启「跟随窗口」不被勾选、
    // reset() 之后也被推回手动；已按上游修正，上游测试
    // `upstream/tests/themeZoom.test.ts:43` 断言未手动指定时 `getStoredZoom() === 132`。
    expect(h.settings.load().zoomManual).toBe(false)
    expect(h.settings.load().zoomPercent).toBe(100)
  })

  it("缩放模式键为 '0' 时也是跟随窗口（非 '1' 即自动）", () => {
    const h = makeHarness({ storage: memoryStorage({ [SETTINGS_KEYS.zoomManual]: '0' }) })

    expect(h.settings.load().zoomManual).toBe(false)
  })

  it("缩放模式键为 '1' 时判定为手动", () => {
    const h = makeHarness({ storage: memoryStorage({ [SETTINGS_KEYS.zoomManual]: '1' }) })

    expect(h.settings.load().zoomManual).toBe(true)
  })

  it('save({themeId}) 只改主题，不重置缩放模式与缩放值', () => {
    const h = makeHarness({
      storage: memoryStorage({ [SETTINGS_KEYS.zoomManual]: '0' }),
      windowWidth: 1600,
    })

    const view = h.settings.save({ themeId: 'sepia' })

    expect(view.themeId).toBe('sepia')
    expect(view.zoomManual).toBe(false)
    expect(view.zoomPercent).toBe(108)
  })

  it('save() 返回重新读出来的完整七字段视图', () => {
    const h = makeHarness()

    const view = h.settings.save({
      themeId: 'sepia',
      fontSize: '18px',
      sidebarWidth: 260,
      collapsedGroups: ['world'],
    })

    expect(Object.keys(view).sort()).toEqual([
      'collapsedGroups',
      'fontFamily',
      'fontSize',
      'sidebarWidth',
      'themeId',
      'zoomManual',
      'zoomPercent',
    ])
    expect(view).toEqual<AppSettingsView>({
      themeId: 'sepia',
      fontFamily: null,
      fontSize: '18px',
      zoomPercent: 100,
      // 本次 patch 没碰缩放 ⇒ 缩放模式保持存储原样（空存储 = 自动）。
      zoomManual: false,
      sidebarWidth: 260,
      collapsedGroups: ['world'],
    })
  })

  it('save({zoomPercent}) 缺省把缩放模式切到手动', () => {
    const h = makeHarness()

    const view = h.settings.save({ zoomPercent: 150 })

    expect(view.zoomPercent).toBe(150)
    expect(view.zoomManual).toBe(true)
  })

  it('save({zoomManual:false}) 只切模式并把缩放键写成当时的当前值', () => {
    const h = makeHarness({
      storage: memoryStorage({ [SETTINGS_KEYS.zoom]: '150', [SETTINGS_KEYS.zoomManual]: '1' }),
    })

    const view = h.settings.save({ zoomManual: false })

    expect(view.zoomManual).toBe(false)
    expect(view.zoomPercent).toBe(100)
  })

  it('reset() 清掉全部设置键并返回默认视图', () => {
    const storage = memoryStorage({
      [SETTINGS_KEYS.theme]: 'sepia',
      [SETTINGS_KEYS.zoom]: '150',
      [SETTINGS_KEYS.zoomManual]: '1',
      [SETTINGS_KEYS.fontPrefs]: JSON.stringify({ editor: '楷体', ui: '' }),
      [SETTINGS_KEYS.sidebarWidth]: '300',
      [SETTINGS_KEYS.collapsedGroups]: JSON.stringify(['world']),
      [EDITOR_FONT_SIZE_KEY]: '22px',
    })
    const h = makeHarness({ storage })

    const view = h.settings.reset()

    expect([...storage.entries.keys()]).toEqual([])
    expect(view).toEqual<AppSettingsView>({
      themeId: 'eye-care',
      fontFamily: null,
      fontSize: '16px',
      zoomPercent: 100,
      // 恢复默认 = 回到「跟随窗口」（缺键即自动），与 load() 同一口径。
      zoomManual: false,
      sidebarWidth: 224,
      collapsedGroups: [],
    })
  })

  it('storage.getItem 抛异常时 load() 仍返回默认视图而不是崩', () => {
    const h = makeHarness({ storage: getItemThrowingStorage() })

    expect(h.settings.load()).toEqual<AppSettingsView>({
      themeId: 'eye-care',
      fontFamily: null,
      fontSize: '16px',
      zoomPercent: 100,
      zoomManual: false,
      sidebarWidth: 224,
      collapsedGroups: [],
    })
  })

  it('storage.setItem 抛异常时 save() 不抛，返回未变更的视图', () => {
    const h = makeHarness({ storage: setItemThrowingStorage() })

    const view = h.settings.save({ themeId: 'sepia' })

    expect(view.themeId).toBe('eye-care')
  })
})

// ===========================================================================
// createWelcomePort
// ===========================================================================

describe('createWelcomePort', () => {
  it('seen() 在没写过键时为 false', () => {
    const h = makeHarness()

    expect(h.welcome.seen()).toBe(false)
  })

  it("seen() 在键值为 '1' 时为 true", () => {
    const h = makeHarness({ storage: memoryStorage({ [WELCOME_SEEN_KEY]: '1' }) })

    expect(h.welcome.seen()).toBe(true)
  })

  it("seen() 对非 '1' 的脏值仍为 false", () => {
    const h = makeHarness({ storage: memoryStorage({ [WELCOME_SEEN_KEY]: 'true' }) })

    expect(h.welcome.seen()).toBe(false)
  })

  it('markSeen() 之后同一个 storage 上 seen() 变成 true', () => {
    const storage = memoryStorage()
    const h = makeHarness({ storage })

    h.welcome.markSeen()

    expect(storage.entries.get(WELCOME_SEEN_KEY)).toBe('1')
    expect(h.welcome.seen()).toBe(true)
  })

  it('seen() 遇 storage.getItem 抛异常时当作「没走过」而不是崩', () => {
    const h = makeHarness({ storage: getItemThrowingStorage() })

    expect(h.welcome.seen()).toBe(false)
  })

  it('markSeen() 遇 storage 抛异常时吞掉异常', () => {
    const h = makeHarness({ storage: setItemThrowingStorage() })

    expect(() => h.welcome.markSeen()).not.toThrow()
  })

  it('createDemoProject() 在没注入实现时返回 NOT_IMPLEMENTED 与中文说明', async () => {
    const h = makeHarness()

    const result = await h.welcome.createDemoProject()

    expect(expectFailure(result)).toEqual({
      code: 'NOT_IMPLEMENTED',
      message: '示范项目数据还没接入预览版',
    })
  })

  it('createDemoProject() 原样转发注入实现的成功结果', async () => {
    const demo: FeatureResult<{ readonly projectId: string }> = {
      ok: true,
      value: { projectId: 'project_demo' },
    }
    const createDemoProject = vi.fn(async () => demo)
    const h = makeHarness({ createDemoProject })

    const result = await h.welcome.createDemoProject()

    expect(result).toBe(demo)
    expect(createDemoProject).toHaveBeenCalledTimes(1)
  })

  it('createDemoProject() 原样转发注入实现的失败结果', async () => {
    const demo: FeatureResult<{ readonly projectId: string }> = {
      ok: false,
      code: 'STORAGE_UNAVAILABLE',
      message: '数据库没起来',
    }
    const createDemoProject = vi.fn(async () => demo)
    const h = makeHarness({ createDemoProject })

    const result = await h.welcome.createDemoProject()

    expect(result).toBe(demo)
  })

  it('createDemoProject() 的注入实现抛异常时折算成 INTERNAL_ERROR', async () => {
    const createDemoProject = vi.fn(
      async (): Promise<FeatureResult<{ readonly projectId: string }>> => {
        throw new Error('主进程没有响应')
      },
    )
    const h = makeHarness({ createDemoProject })

    const result = await h.welcome.createDemoProject()

    expect(expectFailure(result)).toEqual({
      code: 'INTERNAL_ERROR',
      message: '调用失败：主进程没有响应',
    })
  })

  it('createDemoProject() 自己不调用 markSeen（记忆动作留给向导在成功后做）', async () => {
    const storage = memoryStorage()
    const h = makeHarness({
      storage,
      createDemoProject: vi.fn(async () => ({ ok: true as const, value: { projectId: 'project_demo' } })),
    })

    await h.welcome.createDemoProject()

    expect(storage.setItem).not.toHaveBeenCalledWith(WELCOME_SEEN_KEY, '1')
  })
})

// ===========================================================================
// 视图投影函数（畸形输入）
// ===========================================================================

describe('projectToView 的畸形输入兜底', () => {
  it('把完整的契约 Project 投影成七字段视图', () => {
    expect(projectToView(projectFixture())).toEqual(projectViewFixture())
  })

  it('projectType 缺省或非字符串时回落 full', () => {
    expect(projectToView(loose({ projectType: undefined })).projectType).toBe('full')
    expect(projectToView(loose({ projectType: 42 })).projectType).toBe('full')
  })

  it('summary 缺省或非字符串时回落空串', () => {
    expect(projectToView(loose({ summary: undefined })).summary).toBe('')
    expect(projectToView(loose({ summary: { text: 'x' } })).summary).toBe('')
  })

  it('createdAt / updatedAt 非字符串时回落 null', () => {
    const view = projectToView(loose({ createdAt: 1700000000000, updatedAt: undefined }))

    expect(view.createdAt).toBeNull()
    expect(view.updatedAt).toBeNull()
  })

  it('revision 是可转字符串的数字时用 String() 收下', () => {
    expect(projectToView(loose({ revision: 7 })).revision).toBe('7')
  })

  it('revision 缺字段时不兜底，直接抛 TypeError（源码 ports.ts:207 用的是 asString）', () => {
    expect(() => projectToView(loose({ revision: undefined }))).toThrow(TypeError)
  })

  it('输入为 null 时抛 TypeError 而不是给兜底值', () => {
    expect(() => projectToView(null)).toThrow(TypeError)
  })

  it('输入为字符串时抛 TypeError 而不是给兜底值', () => {
    expect(() => projectToView('project_1')).toThrow(TypeError)
  })
})

describe('backupEntryToView 的畸形输入兜底', () => {
  it('把完整的备份项投影成五字段视图', () => {
    expect(backupEntryToView(backupEntryFixture())).toEqual<BackupEntryView>({
      backupPath: 'C:/data/backups/snap-1.db',
      label: '手动备份',
      createdAt: AT,
      byteSize: 2048,
      readable: true,
    })
  })

  it("readable 是字符串 'true' 时按不可恢复处理", () => {
    expect(backupEntryToView(backupEntryFixture({ readable: 'true' })).readable).toBe(false)
  })

  it('readable 是数字 1 时按不可恢复处理', () => {
    expect(backupEntryToView(backupEntryFixture({ readable: 1 })).readable).toBe(false)
  })

  it('readable 缺字段时按不可恢复处理', () => {
    expect(backupEntryToView(backupEntryFixture({ readable: undefined })).readable).toBe(false)
  })

  it('createdAt 缺字段时回落 null', () => {
    expect(backupEntryToView(backupEntryFixture({ createdAt: undefined })).createdAt).toBeNull()
  })

  it('byteSize 是数字字符串时抛 TypeError（asNumber 只认有限数字）', () => {
    expect(() => backupEntryToView(backupEntryFixture({ byteSize: '2048' }))).toThrow(TypeError)
  })

  it('byteSize 是 NaN 时抛 TypeError', () => {
    expect(() => backupEntryToView(backupEntryFixture({ byteSize: Number.NaN }))).toThrow(TypeError)
  })
})

describe('backupVerifyToView / backupCreateToView 的畸形输入兜底', () => {
  it('integrity 不看入参，恒定投影成 ok', () => {
    const view = backupVerifyToView({
      backupPath: 'C:/data/backups/snap-1.db',
      integrity: 'broken',
      databaseSchemaVersion: 3,
      needsMigration: false,
      byteSize: 2048,
      createdAt: AT,
    })

    expect(view.integrity).toBe('ok')
  })

  it("needsMigration 非严格 true（'true'/1）时按 false 处理", () => {
    const base = {
      backupPath: 'C:/data/backups/snap-1.db',
      databaseSchemaVersion: 3,
      byteSize: 2048,
      createdAt: AT,
    }

    expect(backupVerifyToView({ ...base, needsMigration: 'true' }).needsMigration).toBe(false)
    expect(backupVerifyToView({ ...base, needsMigration: 1 }).needsMigration).toBe(false)
  })

  it('校验报告的 createdAt 缺字段时回落 null', () => {
    const view = backupVerifyToView({
      backupPath: 'C:/data/backups/snap-1.db',
      databaseSchemaVersion: 3,
      needsMigration: false,
      byteSize: 2048,
    })

    expect(view.createdAt).toBeNull()
  })

  it('备份创建报告的 createdAt 缺字段时抛 TypeError（这里用的是 asString 而非 asStringOrNull）', () => {
    expect(() =>
      backupCreateToView({
        backupPath: 'C:/data/backups/snap-1.db',
        byteSize: 2048,
        durationMs: 37,
      }),
    ).toThrow(TypeError)
  })

  it('备份创建报告正常入参时投影四字段', () => {
    const view = backupCreateToView({
      backupPath: 'C:/data/backups/snap-1.db',
      byteSize: 2048,
      createdAt: AT,
      durationMs: 37,
    })

    expect(view).toEqual({
      backupPath: 'C:/data/backups/snap-1.db',
      byteSize: 2048,
      createdAt: AT,
      durationMs: 37,
    })
  })
})

// ===========================================================================
// 组装
// ===========================================================================

describe('createFeaturePorts', () => {
  it('一次组装出 hub / backup / settings / welcome 四个端口', () => {
    const h = makeHarness()

    expect(Object.keys(h.ports).sort()).toEqual(['backup', 'hub', 'settings', 'welcome'])
  })

  it('backup / settings / welcome 都是端口形状（方法齐全）', () => {
    const h = makeHarness()
    const backup: BackupPort = h.backup
    const settings: SettingsPort = h.settings
    const welcome: WelcomePort = h.welcome
    const hub: ProjectHubStore = h.hub

    expect([
      typeof backup.list,
      typeof backup.create,
      typeof backup.verify,
      typeof backup.restore,
      typeof settings.load,
      typeof settings.save,
      typeof settings.reset,
      typeof welcome.seen,
      typeof welcome.markSeen,
      typeof welcome.createDemoProject,
      typeof hub.getSnapshot,
      typeof hub.subscribe,
      typeof hub.refresh,
      typeof hub.dispose,
    ]).toEqual(Array.from({ length: 14 }, () => 'function'))
  })
})
