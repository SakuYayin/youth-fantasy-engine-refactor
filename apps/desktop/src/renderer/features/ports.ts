/**
 * 外壳功能端口的实现 —— 把 `features/types.ts` 定义的能力接到 `AppState` 与 IPC 上。
 *
 * 为什么单独一层：`features/types.ts` 是**契约**（组件只认它），这里是**实现**。
 * 组件不 import 本文件，`App.vue` 从 `FeaturePorts` 里取。
 *
 * 三条实现纪律：
 * 1. **端口方法不抛异常**：每个 `await` 都包在 `guard()` 里，任何异常折算成
 *    `{ok:false, code:'INTERNAL_ERROR'}`，绝不让异常穿过组件边界。
 * 2. **永远给脱敏后的中文 message**：契约错误载荷的 `message` 已是可读文案，
 *    本层只做透传 + 兜底，不把 `cause` / 原始 Error 带出去。
 * 3. **「切换当前作品」一律经 `AppState.openProject`**：它是唯一知道
 *    「先冲刷草稿再换树」这条顺序的地方；本层自己清状态必然丢草稿。
 */

import type {
  BackupCreateInput,
  BackupCreateOutput,
  BackupListOutput,
  BackupRestoreInput,
  BackupRestoreOutput,
  BackupVerifyInput,
  BackupVerifyOutput,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectDeleteInput,
  ProjectDeleteOutput,
  ProjectListInput,
  ProjectListOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  ReadContext,
  Result,
  WriteContext,
} from '@yfe/contracts'

import type { AppState } from '../app-state.js'
import { LOCAL_WORKSPACE_ID } from '../../shared/local-workspace.js'
import type {
  AppSettingsView,
  BackupCreateReport,
  BackupEntryView,
  BackupPort,
  BackupVerifyReport,
  FeaturePorts,
  FeatureResult,
  ProjectCreateRequest,
  ProjectHubSnapshot,
  ProjectHubStore,
  ProjectSummaryView,
  SettingsPort,
  WelcomePort,
} from './types.js'
import {
  readAppSettings,
  saveAppSettings,
  resetAppSettings,
  type SettingsStorage,
} from './settings-store.js'

/**
 * 本层用到的 IPC 调用面。
 *
 * 刻意**不用** `RendererClientPort`：那个接口是「AppState 需要什么」的清单，
 * 这里是「外壳还需要什么」。签名逐字对齐契约，所以 `@yfe/client-sdk` 的
 * `createClient()` 返回值可以直接当 `InvokeLike` 传进来（测试给假实现）。
 *
 * 返回类型是契约 `Result<T>`：失败是**数据**不是异常，本层用 `toFeatureResult`
 * 折算成 `FeatureResult`，绝不让失败穿过组件边界。
 */
export interface InvokeLike {
  readonly createProject: (input: ProjectCreateInput) => Promise<Result<ProjectCreateOutput>>
  readonly listProjects: (input: ProjectListInput) => Promise<Result<ProjectListOutput>>
  readonly updateProject: (input: ProjectUpdateInput) => Promise<Result<ProjectUpdateOutput>>
  readonly deleteProject: (input: ProjectDeleteInput) => Promise<Result<ProjectDeleteOutput>>
  readonly backupCreate: (input: BackupCreateInput) => Promise<Result<BackupCreateOutput>>
  /** 无入参：备份目录由主进程决定，渲染层不传路径（见契约注释）。 */
  readonly backupList: () => Promise<Result<BackupListOutput>>
  readonly backupVerify: (input: BackupVerifyInput) => Promise<Result<BackupVerifyOutput>>
  readonly backupRestore: (input: BackupRestoreInput) => Promise<Result<BackupRestoreOutput>>
}

/** 端口实现依赖。 */
export interface FeaturePortDeps {
  /** 当前作品状态机；`hub.open/close` 必须经过它。 */
  readonly state: AppState
  /** 状态机没有的能力（列出/改名/删除作品、备份四件套）直接发 IPC。 */
  readonly invoke: InvokeLike
  /** 设置与向导的本地存储（`window.localStorage` 或测试假实现）。 */
  readonly storage: SettingsStorage
  /** 请求号工厂（与 `AppState` 用同一个 `crypto.randomUUID`）。 */
  readonly newRequestId: () => string
  /** 工作区 id；缺省 `ws_local`（单机预览版只有这一个工作区）。 */
  readonly workspaceId?: string
  /**
   * 窗口宽度。
   *
   * 自动缩放与「大屏用 300px 侧栏」都按它算。**由调用方传**（`window.innerWidth`），
   * 不在本层读全局 —— 这样逐值驱动就能测出边界（`settings-store.ts:319` 同口径）。
   */
  readonly windowWidth: () => number
  /** 建示范项目的实现；缺省时 `WelcomePort.createDemoProject` 返回「还没接入」。 */
  readonly createDemoProject?: () => Promise<FeatureResult<{ readonly projectId: string }>>
}

/** 首启向导「已走过」的键（旧版是 `db.setMeta('welcomeDone','1')`，这里落本地存储）。 */
export const WELCOME_SEEN_KEY = 'yfe.welcomeSeen'

interface Success<T> {
  readonly ok: true
  readonly value: T
}
interface Failure {
  readonly ok: false
  readonly error: unknown
}

/** 契约 `Result` 的形状判据（不 import 契约运行时，只看结构）。 */
function isResult(value: unknown): value is Success<unknown> | Failure {
  return typeof value === 'object' && value !== null && 'ok' in value
}

function isFailure(value: unknown): value is Failure {
  return isResult(value) && value.ok === false
}

function errorField(error: unknown, key: string): unknown {
  if (typeof error === 'object' && error !== null && key in error) {
    return (error as Record<string, unknown>)[key]
  }
  return undefined
}

/** 从契约失败载荷里取脱敏后的 code/message；缺 message 时用 code 拼一句兜底。 */
function failureOf(result: Failure): { code: string; message: string } {
  const code = errorField(result.error, 'code')
  const message = errorField(result.error, 'message')
  const codeText = typeof code === 'string' && code !== '' ? code : 'INTERNAL_ERROR'
  const messageText = typeof message === 'string' && message !== '' ? message : ''
  return {
    code: codeText,
    message: messageText === '' ? `调用失败（${codeText}）` : messageText,
  }
}

/**
 * 把一次可能抛异常的异步调用折算成 `FeatureResult`。
 *
 * 异常文案直取 `Error.message`：这些异常来自本进程（客户端超时、畸形载荷），
 * 不是后端内部细节；但仍**不附 `cause`/stack**，避免把文件路径带进界面。
 */
async function guard<T>(run: () => Promise<FeatureResult<T>>): Promise<FeatureResult<T>> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : '未知错误'
    return { ok: false, code: 'INTERNAL_ERROR', message: `调用失败：${message}` }
  }
}

/** 契约 `Result` → `FeatureResult<T>`；`project` 负责把成功载荷投影成视图（可能抛→折算）。 */
function toFeatureResult<T>(result: unknown, project: (value: unknown) => T): FeatureResult<T> {
  if (!isResult(result)) {
    return { ok: false, code: 'INTERNAL_ERROR', message: '调用没有返回可识别的结果' }
  }
  if (isFailure(result)) {
    const { code, message } = failureOf(result)
    return { ok: false, code, message }
  }
  try {
    return { ok: true, value: project(result.value) }
  } catch {
    return { ok: false, code: 'INTERNAL_ERROR', message: '返回数据缺少必要字段' }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new TypeError('不是对象')
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new TypeError('不是字符串')
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError('不是有限数字')
}

/** 契约 `Project` → 视图（顶层字段全收敛成 `string`，组件不认品牌类型）。 */
export function projectToView(input: unknown): ProjectSummaryView {
  const record = asRecord(input)
  return {
    id: asString(record['id']),
    name: asString(record['name']),
    summary: typeof record['summary'] === 'string' ? record['summary'] : '',
    projectType: typeof record['projectType'] === 'string' ? record['projectType'] : 'full',
    createdAt: asStringOrNull(record['createdAt']),
    updatedAt: asStringOrNull(record['updatedAt']),
    revision: asString(record['revision']),
  }
}

/** 契约 `BackupEntry` → 视图。 */
export function backupEntryToView(input: unknown): BackupEntryView {
  const record = asRecord(input)
  return {
    backupPath: asString(record['backupPath']),
    label: asString(record['label']),
    createdAt: asStringOrNull(record['createdAt']),
    byteSize: asNumber(record['byteSize']),
    // readable 非 `true` 一律按「不可恢复」处理：宁可拦着用户，也不能让人去恢复
    // 一份读不懂的快照（典型来源=迁移器留下的无清单快照）。
    readable: record['readable'] === true,
  }
}

/** 契约 `BackupVerifyOutput` → 视图。 */
export function backupVerifyToView(input: unknown): BackupVerifyReport {
  const record = asRecord(input)
  return {
    backupPath: asString(record['backupPath']),
    // 契约里这个字段只有 `'ok'` 一个取值：校验不通过是错误码，不是这个字段的值。
    integrity: 'ok',
    databaseSchemaVersion: asNumber(record['databaseSchemaVersion']),
    needsMigration: record['needsMigration'] === true,
    byteSize: asNumber(record['byteSize']),
    createdAt: asStringOrNull(record['createdAt']),
  }
}

/** 契约 `BackupCreateOutput` → 视图。 */
export function backupCreateToView(input: unknown): BackupCreateReport {
  const record = asRecord(input)
  return {
    backupPath: asString(record['backupPath']),
    byteSize: asNumber(record['byteSize']),
    createdAt: asString(record['createdAt']),
    durationMs: asNumber(record['durationMs']),
  }
}

/**
 * 取作品 id 与 revision。
 *
 * 改名/删除都带 `expectedRevision`（CAS）：列表里读到就带上，撞车时后端报
 * `REVISION_CONFLICT`，用户看到「这条已经被改过了」而不是静默覆盖别人的改动。
 */
function projectVersionOf(
  projects: readonly ProjectSummaryView[],
  projectId: string,
): string | null {
  return projects.find((project) => project.id === projectId)?.revision ?? null
}

/**
 * 建作品中心：`ProjectHubPort` + 可观察快照。
 *
 * 列表刻意**不放进 `AppSnapshot`**（理由见 `types.ts` 的注释）：它是跨作品的，
 * 必须能在没有当前作品时工作。这个 store 是它唯一的持有者。
 */
export function createProjectHubStore(deps: FeaturePortDeps): ProjectHubStore {
  const listeners = new Set<(snapshot: ProjectHubSnapshot) => void>()
  const workspaceId = deps.workspaceId ?? LOCAL_WORKSPACE_ID
  let projects: readonly ProjectSummaryView[] = []
  let loading = false
  let lastError: { code: string; message: string } | null = null
  let disposed = false

  function readContext(): ReadContext {
    return {
      requestId: deps.newRequestId() as ReadContext['requestId'],
      workspaceId: workspaceId as ReadContext['workspaceId'],
    }
  }

  function writeContext(projectId: string, expectedRevision: string | null): WriteContext {
    return {
      requestId: deps.newRequestId() as WriteContext['requestId'],
      workspaceId: workspaceId as WriteContext['workspaceId'],
      projectId: projectId as WriteContext['projectId'],
      expectedRevision: expectedRevision as WriteContext['expectedRevision'],
    }
  }

  function snapshot(): ProjectHubSnapshot {
    return Object.freeze({
      projects,
      loading,
      lastError,
      // 当前作品直接问状态机：它是唯一真相源，两边不会漂移。
      currentProjectId: deps.state.getSnapshot().projectId,
    })
  }

  function emit(): void {
    const next = snapshot()
    // 复制一份再遍历：监听者可能在回调里退订（`emit` 的常规防御）。
    for (const listener of [...listeners]) listener(next)
  }

  async function listOnce(): Promise<FeatureResult<readonly ProjectSummaryView[]>> {
    return guard(async () => {
      const result = await deps.invoke.listProjects({ context: readContext() })
      return toFeatureResult(result, (value) =>
        (asRecord(value)['projects'] as unknown[]).map(projectToView),
      )
    })
  }

  /**
   * 拉一次列表并把结果落到快照上（loading/lastError 都跟着走）。
   *
   * 独立成函数是因为 `refresh()` 之外还有三处要「改完顺手刷新」：新建、改名、删除。
   * 直接在返回对象里调 `refresh()` 会绕开加载态与错误态（写操作成功后列表必须
   * 是最新的，且失败要让用户看见原因）。
   */
  async function refreshOnce(): Promise<FeatureResult<readonly ProjectSummaryView[]>> {
    if (disposed) {
      return { ok: false, code: 'STATE_INVALID_TRANSITION', message: '作品中心已关闭' }
    }
    loading = true
    lastError = null
    emit()
    const result = await listOnce()
    // dispose 之后再落状态是无意义的写入（也没有监听者了）；但仍把结果返回给调用方。
    if (disposed) return result
    loading = false
    if (result.ok) {
      projects = result.value
      lastError = null
    } else {
      lastError = { code: result.code, message: result.message }
    }
    emit()
    return result
  }

  return {
    getSnapshot: snapshot,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    refresh: refreshOnce,

    list(): Promise<FeatureResult<readonly ProjectSummaryView[]>> {
      return listOnce()
    },

    async create(request: ProjectCreateRequest): Promise<FeatureResult<{ projectId: string }>> {
      return guard(async () => {
        const input: ProjectCreateInput = {
          context: {
            requestId: deps.newRequestId() as WriteContext['requestId'],
            workspaceId: workspaceId as WriteContext['workspaceId'],
            // 新建作品时还没有作品：契约要求显式 null（不是省略）。
            projectId: null,
            expectedRevision: null,
            ...(request.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: request.idempotencyKey as WriteContext['idempotencyKey'] }),
          },
          name: request.name,
          ...(request.summary === undefined ? {} : { summary: request.summary }),
          seedFirstChapter: request.seedFirstChapter ?? true,
          // 项目形态走 `templateId`：契约里它没有独立列，实现把它当 `project_type`
          // 用（`repositories/projects.ts` 的注释）。旧版「完整 / 自定义」由此落库。
          ...(request.projectType === undefined ? {} : { templateId: request.projectType }),
        }
        const result = await deps.invoke.createProject(input)
        const created = toFeatureResult(result, (value) => ({
          projectId: asString(asRecord(value)['projectId']),
        }))
        if (created.ok) await refreshOnce()
        return created
      })
    },

    async rename(projectId: string, name: string): Promise<FeatureResult<null>> {
      return guard(async () => {
        const input: ProjectUpdateInput = {
          context: writeContext(projectId, projectVersionOf(projects, projectId)),
          projectId: projectId as ProjectUpdateInput['projectId'],
          name,
        }
        const result = await deps.invoke.updateProject(input)
        const renamed = toFeatureResult(result, () => null)
        if (renamed.ok) await refreshOnce()
        return renamed
      })
    },

    async remove(projectId: string): Promise<FeatureResult<null>> {
      return guard(async () => {
        const input: ProjectDeleteInput = {
          context: writeContext(projectId, projectVersionOf(projects, projectId)),
          projectId: projectId as ProjectDeleteInput['projectId'],
        }
        const result = await deps.invoke.deleteProject(input)
        const removed = toFeatureResult(result, () => null)
        // 删掉的正好是当前打开的作品：状态机必须一起退出，否则界面还停在一棵
        // 已经软删的树上（列表里看不到它，正文却还在编辑）。
        if (removed.ok && deps.state.getSnapshot().projectId === projectId) {
          await deps.state.openProject(null)
        }
        if (removed.ok) await refreshOnce()
        return removed
      })
    },

    async open(projectId: string): Promise<FeatureResult<null>> {
      return guard(async () => {
        const opened = await deps.state.openProject(projectId)
        emit()
        if (opened) return { ok: true, value: null }
        // 失败原因由状态机写在 `lastError` 上（冲刷失败 / 服务端拒绝）。
        const error = deps.state.getSnapshot().lastError
        return {
          ok: false,
          code: error?.code ?? 'INTERNAL_ERROR',
          message: error?.message ?? '打开作品失败',
        }
      })
    },

    async close(): Promise<FeatureResult<null>> {
      return guard(async () => {
        const closed = await deps.state.openProject(null)
        emit()
        if (closed) return { ok: true, value: null }
        const error = deps.state.getSnapshot().lastError
        return {
          ok: false,
          code: error?.code ?? 'INTERNAL_ERROR',
          message: error?.message ?? '返回作品列表失败',
        }
      })
    },

    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}

/** 备份端口：直接转发 IPC，**不做缓存**（快照是磁盘状态，缓存只会骗人）。 */
export function createBackupPort(deps: FeaturePortDeps): BackupPort {
  return {
    async list(): Promise<FeatureResult<readonly BackupEntryView[]>> {
      return guard(async () => {
        const result = await deps.invoke.backupList()
        return toFeatureResult(result, (value) =>
          (asRecord(value)['backups'] as unknown[]).map(backupEntryToView),
        )
      })
    },

    async create(label?: string): Promise<FeatureResult<BackupCreateReport>> {
      return guard(async () => {
        const input: BackupCreateInput = label === undefined ? {} : { label }
        const result = await deps.invoke.backupCreate(input)
        return toFeatureResult(result, backupCreateToView)
      })
    },

    async verify(backupPath: string): Promise<FeatureResult<BackupVerifyReport>> {
      return guard(async () => {
        const input: BackupVerifyInput = { backupPath }
        const result = await deps.invoke.backupVerify(input)
        return toFeatureResult(result, backupVerifyToView)
      })
    },

    async restore(
      backupPath: string,
      overwrite?: boolean,
    ): Promise<FeatureResult<{ targetPath: string; byteSize: number }>> {
      return guard(async () => {
        const input: BackupRestoreInput =
          overwrite === undefined ? { backupPath } : { backupPath, overwrite }
        const result = await deps.invoke.backupRestore(input)
        return toFeatureResult(result, (value) => {
          const record = asRecord(value)
          return {
            targetPath: asString(record['targetPath']),
            byteSize: asNumber(record['byteSize']),
          }
        })
      })
    },
  }
}

/** 设置端口：读写都落 localStorage，**永不失败**（读不到就是默认值）。 */
export function createSettingsPort(deps: FeaturePortDeps): SettingsPort {
  return {
    load(): AppSettingsView {
      return readAppSettings(deps.storage, deps.windowWidth())
    },
    save(patch: Partial<AppSettingsView>): AppSettingsView {
      return saveAppSettings(deps.storage, patch, deps.windowWidth())
    },
    reset(): AppSettingsView {
      resetAppSettings(deps.storage)
      return readAppSettings(deps.storage, deps.windowWidth())
    },
  }
}

/** 首启向导端口。 */
export function createWelcomePort(deps: FeaturePortDeps): WelcomePort {
  return {
    seen(): boolean {
      try {
        return deps.storage.getItem(WELCOME_SEEN_KEY) === '1'
      } catch {
        // 隐私模式读 localStorage 会抛 SecurityError；当作「没走过」比「走过」安全：
        // 宁可多显示一次向导，也不要让新用户面对一个空白首页。
        return false
      }
    },
    markSeen(): void {
      try {
        deps.storage.setItem(WELCOME_SEEN_KEY, '1')
      } catch {
        // 写不进去就算了：下次启动会再显示一次向导，不影响任何数据。
      }
    },
    async createDemoProject(): Promise<FeatureResult<{ projectId: string }>> {
      const create = deps.createDemoProject
      if (create === undefined) {
        return { ok: false, code: 'NOT_IMPLEMENTED', message: '示范项目数据还没接入预览版' }
      }
      // 成功的记忆动作**不在这里做**：由向导在 `emit('done')` 后调 `markSeen()`，
      // 这样「建失败」时用户能重试，而不是被永久跳过。
      return guard(() => create())
    },
  }
}

/** 组装全部端口。`main.ts` 建一次，`App.vue` 收成 prop 后分发。 */
export function createFeaturePorts(deps: FeaturePortDeps): FeaturePorts {
  return {
    hub: createProjectHubStore(deps),
    backup: createBackupPort(deps),
    settings: createSettingsPort(deps),
    welcome: createWelcomePort(deps),
  }
}

export type { FeaturePorts, ProjectHubStore, BackupPort, SettingsPort, WelcomePort }
