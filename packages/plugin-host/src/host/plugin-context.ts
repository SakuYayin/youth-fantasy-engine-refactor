/**
 * `PluginContext` 的宿主侧实现（把 SDK 接口落到真实宿主行为）。
 *
 * 🔴 本文件**不得 import cordis**：插件上下文是产品语义，与上游生命周期无关。
 *
 * 关键产品语义（任务要求逐条对应）：
 * - **降级拒写**：未授权 `plugin.data.write` 时所有写操作返回 `PERMISSION_PLUGIN_CAPABILITY`。
 * - **运行任务时禁用插件**：`tasks.start()` 在被禁用后返回 `PLUGIN_DISABLED`，
 *   宿主随后 `drain()` 排空/取消在途任务。
 * - **资源计数器**：`effects.size` / `tasks.activeCount` 供「连续启停后资源回到可解释范围」断言。
 * - 🔴 这些都不是安全隔离（ADR 008）：它们防误用，不防恶意代码。
 */

import { capabilityDeniedPayload, describeCapabilityDenial } from '@yfe/plugin-sdk'
import { err, ok } from '@yfe/contracts'
import type {
  CapabilityGate,
  ContributionDescriptor,
  ContributionDisposer,
  ContributionRegistry,
  DrainOutcome,
  EffectsDisposeReport,
  EffectsFailure,
  EffectsScope,
  PluginCapability,
  PluginContext,
  PluginDataRepository,
  PluginIdentity,
  PluginLogger,
  PluginTaskHandle,
  PluginTaskOutcome,
  PluginTaskScope,
  ProductPlugin,
  ServiceResolver,
} from '@yfe/plugin-sdk'
import type { Err, Result } from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'
import { makePayload, disabledPayload, serviceNotFoundPayload } from './errors.js'

/** 宿主提供的服务实现（`PluginContext.services` 读的就是这张表）。 */
export type ServiceTable = ReadonlyMap<string, unknown>

export interface PluginContextDeps {
  readonly identity: PluginIdentity
  readonly granted: readonly PluginCapability[]
  readonly declared: readonly PluginCapability[]
  readonly config: Readonly<Record<string, unknown>>
  readonly services: ServiceTable
  /** 宿主级贡献点注册表（跨插件唯一性检查）。 */
  readonly contributions: HostContributionTable
  /** 宿主级数据存储（按 workspace+plugin 命名空间隔离）。 */
  readonly data: HostDataStore
  readonly logger: PluginLogger
  readonly requestId: RequestId
}

// ---------------------------------------------------------------------------
// 能力
// ---------------------------------------------------------------------------

function createCapabilityGate(
  granted: readonly PluginCapability[],
  declared: readonly PluginCapability[],
  requestId: RequestId,
): CapabilityGate {
  const grantedSet = new Set(granted)
  return {
    has: (capability) => grantedSet.has(capability),
    list: () => [...grantedSet],
    require: (capability): Result<void> => {
      if (grantedSet.has(capability)) return ok(undefined)
      const declaredSet = new Set(declared)
      return err(
        capabilityDeniedPayload(
          capability,
          requestId,
          describeCapabilityDenial(capability, declaredSet.has(capability)),
          { declared: declaredSet.has(capability) },
        ),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function createServiceResolver(services: ServiceTable, requestId: RequestId): ServiceResolver {
  return {
    // 🔴 实测：上游 `ctx.get()` 未注册时返回 undefined 且不抛错（ADR 0002 结论 2）。
    // 这里收敛为显式 Result，逼迫插件处理「服务不存在」。
    get: <T = unknown,>(name: string): Result<T> => {
      if (!services.has(name)) return err(serviceNotFoundPayload(name, requestId))
      return ok(services.get(name) as T)
    },
    has: (name) => services.has(name),
    list: () => [...services.keys()],
  }
}

// ---------------------------------------------------------------------------
// 贡献点
// ---------------------------------------------------------------------------

interface ContributionEntry {
  readonly pluginId: string
  readonly descriptor: ContributionDescriptor
}

/** 宿主级贡献点表：负责跨插件 id 唯一性。 */
export class HostContributionTable {
  private readonly entries = new Map<string, ContributionEntry>()

  /** 未声明能力 / 未在 manifest 声明该 id / 被别的插件占用时的拒绝逻辑在这里集中。 */
  claim(
    pluginId: string,
    descriptor: ContributionDescriptor,
    declaredIds: readonly string[],
    requestId: RequestId,
  ): Result<ContributionDisposer> {
    const capability: PluginCapability =
      descriptor.kind === 'panel' ? 'plugin.ui.panel' : 'plugin.commands.register'
    if (!declaredIds.includes(descriptor.id)) {
      return err(
        makePayload(
          'PLUGIN_MANIFEST_INVALID',
          `插件 ${pluginId} 未在 manifest.contributes 声明贡献点 ${descriptor.id}`,
          requestId,
          { pluginId, reason: 'contribution-not-declared', contributionId: descriptor.id },
        ),
      )
    }
    const key = `${descriptor.kind}:${descriptor.id}`
    const existing = this.entries.get(key)
    if (existing) {
      return err(
        makePayload(
          'ALREADY_EXISTS',
          `贡献点 ${descriptor.id} 已被插件 ${existing.pluginId} 占用`,
          requestId,
          { pluginId, reason: 'contribution-taken', contributionId: descriptor.id, owner: existing.pluginId, capability },
        ),
      )
    }
    this.entries.set(key, { pluginId, descriptor })
    let released = false
    return ok((): void => {
      if (released) return
      released = true
      this.entries.delete(key)
    })
  }

  /** 宿主在插件停用时兜底清理（插件忘记注销也不会泄漏）。 */
  releasePlugin(pluginId: string): number {
    let released = 0
    for (const [key, entry] of [...this.entries]) {
      if (entry.pluginId !== pluginId) continue
      this.entries.delete(key)
      released += 1
    }
    return released
  }

  listAll(): readonly ContributionEntry[] {
    return [...this.entries.values()]
  }

  /** 泄漏断言用：当前登记的贡献点总数。 */
  get size(): number {
    return this.entries.size
  }
}

function createContributionRegistry(
  pluginId: string,
  table: HostContributionTable,
  declared: { readonly panels: readonly string[]; readonly commands: readonly string[] },
  gate: CapabilityGate,
  requestId: RequestId,
): ContributionRegistry {
  const mine: ContributionDescriptor[] = []
  const releaseHooks: ContributionDisposer[] = []

  return {
    register: (descriptor): Result<ContributionDisposer> => {
      const capability: PluginCapability =
        descriptor.kind === 'panel' ? 'plugin.ui.panel' : 'plugin.commands.register'
      const permission = gate.require(capability)
      if (!permission.ok) return permission
      const declaredIds = descriptor.kind === 'panel' ? declared.panels : declared.commands
      const claimed = table.claim(pluginId, descriptor, declaredIds, requestId)
      if (!claimed.ok) return claimed
      mine.push(descriptor)
      const release = claimed.value
      releaseHooks.push(release)
      return ok((): void => {
        release()
        const index = mine.indexOf(descriptor)
        if (index >= 0) mine.splice(index, 1)
      })
    },
    list: () => [...mine],
    disposeAll: (): void => {
      // 逆序注销，与 effects 的 LIFO 语义一致。
      for (const release of [...releaseHooks].reverse()) release()
      releaseHooks.length = 0
      mine.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// 数据（降级拒写）
// ---------------------------------------------------------------------------

/** 按 `(workspaceId, pluginId)` 命名空间的内存数据表；持久化实现由 persistence 包后续接入。 */
export class HostDataStore {
  private readonly buckets = new Map<string, Map<string, unknown>>()

  private bucketKey(workspaceId: string, pluginId: string): string {
    return `${workspaceId}\u0000${pluginId}`
  }

  private bucket(workspaceId: string, pluginId: string, create: boolean): Map<string, unknown> | undefined {
    const key = this.bucketKey(workspaceId, pluginId)
    let found = this.buckets.get(key)
    if (!found && create) {
      found = new Map<string, unknown>()
      this.buckets.set(key, found)
    }
    return found
  }

  get(workspaceId: string, pluginId: string, key: string): unknown {
    return this.bucket(workspaceId, pluginId, false)?.get(key)
  }

  set(workspaceId: string, pluginId: string, key: string, value: unknown): void {
    const bucket = this.bucket(workspaceId, pluginId, true)
    bucket?.set(key, value)
  }

  delete(workspaceId: string, pluginId: string, key: string): boolean {
    return this.bucket(workspaceId, pluginId, false)?.delete(key) ?? false
  }

  keys(workspaceId: string, pluginId: string): readonly string[] {
    const bucket = this.bucket(workspaceId, pluginId, false)
    return bucket ? [...bucket.keys()].sort() : []
  }

  clear(workspaceId: string, pluginId: string): number {
    const bucket = this.bucket(workspaceId, pluginId, false)
    if (!bucket) return 0
    const count = bucket.size
    bucket.clear()
    return count
  }

  /** 泄漏断言用：当前存活的命名空间桶数。 */
  get bucketCount(): number {
    return this.buckets.size
  }
}

function createDataRepository(
  identity: PluginIdentity,
  store: HostDataStore,
  gate: CapabilityGate,
  requestId: RequestId,
): PluginDataRepository {
  const writeDenied = (): Err =>
    err(
      capabilityDeniedPayload(
        'plugin.data.write',
        requestId,
        describeCapabilityDenial('plugin.data.write', gate.has('plugin.data.read')),
        { operation: 'write' },
      ),
    )

  return {
    get: async (key) => ok(store.get(identity.workspaceId, identity.pluginId, key)),
    // 🔴 降级拒写：没有 plugin.data.write 就一律拒绝，绝不静默丢弃。
    set: async (key, value) => {
      if (!gate.has('plugin.data.write')) return writeDenied()
      store.set(identity.workspaceId, identity.pluginId, key, value)
      return ok(undefined)
    },
    delete: async (key) => {
      if (!gate.has('plugin.data.write')) return writeDenied()
      store.delete(identity.workspaceId, identity.pluginId, key)
      return ok(undefined)
    },
    keys: async () => ok(store.keys(identity.workspaceId, identity.pluginId)),
    clear: async () => {
      if (!gate.has('plugin.data.write')) return writeDenied()
      store.clear(identity.workspaceId, identity.pluginId)
      return ok(undefined)
    },
  }
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

interface TaskRecord {
  readonly id: string
  readonly name: string
  readonly handle: MutableTaskHandle
  readonly abort: AbortController
  settled: boolean
}

interface MutableTaskHandle {
  id: string
  done: Promise<void>
  readonly signal: AbortSignal
  settled: boolean
  outcome: PluginTaskOutcome | undefined
}

/**
 * 任务作用域实现。
 *
 * 🔴 设计要点：任务**必须**登记在宿主，插件不能自己起裸 Promise——否则「运行任务时禁用插件」
 * 无法排空。禁用后 `start()` 直接返回 `PLUGIN_DISABLED`（拒绝新任务）。
 */
export class TaskScopeImpl implements PluginTaskScope {
  private readonly tasks = new Set<TaskRecord>()
  private disabled = false
  private counter = 0
  private readonly pluginId: string
  private readonly requestId: RequestId

  constructor(pluginId: string, requestId: RequestId) {
    this.pluginId = pluginId
    this.requestId = requestId
  }

  /** 宿主在 disable 时调用：先关闸再排空（设计文档要求的顺序）。 */
  closeGate(): void {
    this.disabled = true
  }

  get activeCount(): number {
    return this.tasks.size
  }

  start(name: string, body: (signal: AbortSignal) => Promise<void>): Result<PluginTaskHandle> {
    if (this.disabled) return err(disabledPayload(this.pluginId, this.requestId))
    this.counter += 1
    const id = `${this.pluginId}#task-${this.counter}`
    const abort = new AbortController()
    const taskPromise = body(abort.signal)
    const handle: MutableTaskHandle = {
      id,
      done: Promise.resolve(),
      signal: abort.signal,
      settled: false,
      outcome: undefined,
    }
    let record: TaskRecord | null = null
    handle.done = taskPromise.then(
      () => {
        handle.settled = true
        handle.outcome = abort.signal.aborted
          ? { ok: false, reason: 'cancelled', message: '任务被取消' }
          : { ok: true }
        if (record) this.tasks.delete(record)
      },
      (error: unknown) => {
        handle.settled = true
        handle.outcome = abort.signal.aborted
          ? { ok: false, reason: 'cancelled', message: '任务被取消' }
          : {
              ok: false,
              reason: 'failed',
              message: error instanceof Error ? error.message : String(error),
            }
        if (record) this.tasks.delete(record)
      },
    )
    record = { id, name, handle, abort, settled: false }
    this.tasks.add(record)
    return ok(handle)
  }

  /**
   * 取消全部在途任务并等待结束。
   *
   * 🔴 只发 abort 信号，**不强杀**：ADR 008 明确不能把进程/Worker 当沙箱，本版本也没有
   * 强杀能力；插件若不检查 `signal.aborted` 就会走到 `timeout`，此时插件应被判为
   * quarantined 而不是假装清理成功。
   */
  async drain(timeoutMs: number): Promise<DrainOutcome> {
    if (this.tasks.size === 0) return 'idle'
    const pending = [...this.tasks]
    for (const record of pending) record.abort.abort()
    const all = Promise.all(pending.map((record) => record.handle.done))
    const raced = await raceOutcome(all, timeoutMs)
    if (raced === 'timeout') return 'timeout'
    return 'drained'
  }

  /** 测试与诊断用：仍在途的任务 id。 */
  pendingIds(): readonly string[] {
    return [...this.tasks].map((record) => record.id).sort()
  }
}

async function raceOutcome<T>(promise: Promise<T>, timeoutMs: number): Promise<'ok' | 'timeout'> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await promise
    return 'ok'
  }
  return new Promise<'ok' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve('ok')
      },
      () => {
        clearTimeout(timer)
        resolve('ok')
      },
    )
  })
}

// ---------------------------------------------------------------------------
// 清理动作（effects）
// ---------------------------------------------------------------------------

interface EffectEntry {
  readonly dispose: () => void | Promise<void>
}

/**
 * 清理动作作用域。
 *
 * 🔴 为什么由适配层自己管理列表，而不是每个清理动作各注册一个上游 effect：
 * 实测（ADR 0002 结论 3）**同一个上游 effect 内**一处 disposer 抛错会**中断该链**，
 * 后续兄弟不再执行；而 fiber 级又只把错误吞进 logger。因此宿主只注册一个上游 effect，
 * 内部自行 LIFO + 逐个 try/catch + 整体超时，才能保证「一个插件清理失败不影响其它清理」。
 */
export class EffectsScopeImpl implements EffectsScope {
  private readonly entries: EffectEntry[] = []

  add(dispose: () => void | Promise<void>): () => void {
    const entry: EffectEntry = { dispose }
    this.entries.push(entry)
    let released = false
    return (): void => {
      if (released) return
      released = true
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  get size(): number {
    return this.entries.length
  }

  async disposeAll(): Promise<EffectsDisposeReport> {
    const snapshot = [...this.entries].reverse()
    this.entries.length = 0
    const failures: EffectsFailure[] = []
    let completed = 0
    for (const [index, entry] of snapshot.entries()) {
      try {
        await entry.dispose()
        completed += 1
      } catch (error) {
        failures.push({
          index,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { attempted: snapshot.length, completed, failures, timedOut: false }
  }

  /**
   * 带超时的清理：超时即判定 `timedOut`，宿主据此把插件置为 quarantined。
   * 不能等——上游的永久挂起 disposer 会永不 settle（ADR 0002 结论 3）。
   */
  async disposeAllWithTimeout(timeoutMs: number): Promise<EffectsDisposeReport> {
    const outcome = await raceOutcomeWithValue(this.disposeAll(), timeoutMs)
    if (outcome === 'timeout') {
      const attempted = this.entries.length
      this.entries.length = 0
      return { attempted, completed: 0, failures: [], timedOut: true }
    }
    return outcome
  }
}

async function raceOutcomeWithValue<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve('timeout')
      },
    )
  })
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/** 插件运行期的可变内部状态：宿主在停用时需要拿到它做排空与清理。 */
export interface PluginRuntime {
  readonly context: PluginContext
  readonly tasks: TaskScopeImpl
  readonly effects: EffectsScopeImpl
}

export function createPluginRuntime(
  deps: PluginContextDeps,
  declared: { readonly panels: readonly string[]; readonly commands: readonly string[] },
): PluginRuntime {
  const gate = createCapabilityGate(deps.granted, deps.declared, deps.requestId)
  const tasks = new TaskScopeImpl(deps.identity.pluginId, deps.requestId)
  const effects = new EffectsScopeImpl()

  const contributions = createContributionRegistry(
    deps.identity.pluginId,
    deps.contributions,
    declared,
    gate,
    deps.requestId,
  )

  const context: PluginContext = {
    identity: deps.identity,
    capabilities: gate,
    services: createServiceResolver(deps.services, deps.requestId),
    contributions,
    config: deps.config,
    data: createDataRepository(deps.identity, deps.data, gate, deps.requestId),
    tasks,
    logger: deps.logger,
    effects,
  }
  return { context, tasks, effects }
}

/** 供宿主类型检查：插件实现必须满足 `ProductPlugin`。 */
export type { ProductPlugin }
