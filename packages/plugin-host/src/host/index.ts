/**
 * 插件宿主（`@yfe/plugin-host/host`）。
 *
 * 职责：把「产品语义的插件生命周期」与「上游 Cordis 的真实行为」隔开，并承担所有
 * 设计文档要求的门禁：安装校验 → 依赖图解析 → 授权检查 → 激活 → 停用 → 清理。
 *
 * 🔴 本文件**不 import cordis**：上游只出现在 `src/adapter/cordis.ts`（ADR 0002 决策 2）。
 *
 * 🔴 六条上游语义在本文件的落点（全部来自探针实测，见 `docs/adr/0002-cordis-lifecycle.md`）：
 * 1. isolate 不隔离事件 → 宿主**不**把插件接到事件总线，事件由宿主显式路由。
 * 2. `get()` 未注册返回 undefined → 服务解析收敛为显式 Result（见 `plugin-context.ts`）。
 * 3. 清理可能永久挂起 → **所有**清理都带超时，超时即 `quarantined`，绝不无限等待。
 * 4. `await plugin()` 判不出「依赖未满足」→ 依赖图由宿主独立解析（`dependency-graph.ts`）。
 * 5. `state` 字段会与 `_getState()` 分歧 → 状态读取统一走适配层。
 * 6. `await effectWrapper` 不触发 disposer → 清理走适配层的显式调用路径。
 *
 * 🔴 安全边界（ADR 008 原话）：「**不能将 Node vm、进程、Worker 当作自动沙箱**；签名也不代表
 * 安全认证」。因此本版本 **只加载可信内置插件**（`kind === 'trusted-builtin'` 且在发行清单
 * `trustedPluginIds` 中），并**如实声明**：能力校验只防误用与降级拒写，不是隔离。
 */

import { PLUGIN_API_VERSION, err, newIds, ok } from '@yfe/contracts'
import type { ErrorPayload, Result, RequestId, WorkspaceId } from '@yfe/contracts'
import { isGrantableCapability, satisfiesRange, validatePluginManifest } from '@yfe/plugin-sdk'
import type {
  ManifestIssue,
  PluginCapability,
  PluginContext,
  PluginLogger,
  PluginManifest,
  ProductPlugin,
} from '@yfe/plugin-sdk'
import { CordisRuntime } from '../adapter/cordis.js'
import type { CordisFiber } from '../adapter/cordis.js'
import { dependentsOf, resolveLoadOrder } from './dependency-graph.js'
import {
  activationFailedPayload,
  disabledPayload,
  hostApiIncompatiblePayload,
  manifestInvalidPayload,
  notFoundPayload,
  notTrustedPayload,
  dependencyCyclePayload,
  dependencyMissingPayload,
  dependencyVersionPayload,
  makePayload,
} from './errors.js'
import type { PluginRuntime } from './plugin-context.js'
import {
  EffectsScopeImpl,
  HostContributionTable,
  HostDataStore,
  TaskScopeImpl,
  createPluginRuntime,
} from './plugin-context.js'

/** 宿主对外暴露的插件状态。刻意与上游 `FiberState` 数值解耦。 */
export type PluginState =
  | 'registered'
  | 'active'
  | 'failed'
  | 'disabled'
  /** 清理超时或清理异常：不再接受任何调用，等待人工/重启处理。 */
  | 'quarantined'

export interface PluginCandidate {
  readonly manifest: unknown
  readonly plugin: ProductPlugin
}

export interface PluginHostOptions {
  readonly workspaceId: WorkspaceId
  /** 宿主实现的插件 API 版本，默认取契约的 `PLUGIN_API_VERSION`。 */
  readonly hostApiVersion?: string
  /** 单个插件清理的总超时（默认 2000ms）。超时 → quarantined。 */
  readonly cleanupTimeoutMs?: number
  /** 🔴 发行清单：只有列在这里的 id 才允许加载（`trusted-builtin` 的兜底）。 */
  readonly trustedPluginIds: readonly string[]
  /** 宿主提供给插件解析的服务（其他子系统注入）。 */
  readonly services?: ReadonlyMap<string, unknown>
  readonly logger?: PluginLogger
}

export interface PluginStatus {
  readonly pluginId: string
  readonly version: string
  readonly kind: string
  readonly state: PluginState
  readonly grantedCapabilities: readonly PluginCapability[]
  readonly declaredCapabilities: readonly PluginCapability[]
  /** 最近一次失败/隔离的原因摘要，便于诊断（可为空）。 */
  readonly lastFailure: string | undefined
}

export interface DisableReport {
  readonly pluginId: string
  readonly state: PluginState
  /** 排空在途任务的结果。 */
  readonly drain: 'drained' | 'timeout' | 'idle'
  readonly effectsAttempted: number
  readonly effectsFailed: number
  readonly contributionsReleased: number
  readonly cleanupTimedOut: boolean
  readonly elapsedMs: number
}

export interface LoadReport {
  readonly pluginId: string
  /** 本次实际激活的插件（含按依赖图自动带上的依赖），顺序即激活顺序。 */
  readonly activated: readonly string[]
  readonly alreadyActive: readonly string[]
}

/** 资源计数器：用于「反复 enable/disable 后无泄漏」的断言（发布门禁必测项）。 */
export interface ResourceSnapshot {
  readonly registeredPlugins: number
  readonly activePlugins: number
  readonly liveFibers: number
  readonly contributions: number
  readonly dataBuckets: number
  readonly pendingTasks: number
  readonly liveEffects: number
  readonly quarantined: number
}

interface PluginRecord {
  readonly manifest: PluginManifest
  readonly plugin: ProductPlugin
  state: PluginState
  granted: readonly PluginCapability[]
  runtime: PluginRuntime | null
  fiber: CordisFiber | null
  lastFailure: string | undefined
  /** 该插件的 tasks/effects 在停用后仍保留引用以便诊断，因此单独持有。 */
  retiredTasks: TaskScopeImpl | null
  retiredEffects: EffectsScopeImpl | null
}

/** 不给外部日志实现时用的内存日志器：宿主诊断不依赖 console。 */
class MemoryLogger implements PluginLogger {
  readonly records: { level: string; message: string; detail?: Readonly<Record<string, string | number | boolean | null>> }[] = []
  private push(level: string, message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void {
    this.records.push(detail === undefined ? { level, message } : { level, message, detail })
  }
  debug(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void {
    this.push('debug', message, detail)
  }
  info(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void {
    this.push('info', message, detail)
  }
  warn(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void {
    this.push('warn', message, detail)
  }
  error(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void {
    this.push('error', message, detail)
  }
}

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>()
  private readonly contributions = new HostContributionTable()
  private readonly data = new HostDataStore()
  private readonly services = new Map<string, unknown>()
  private readonly workspaceId: WorkspaceId
  private readonly hostApiVersion: string
  private readonly cleanupTimeoutMs: number
  private readonly trustedPluginIds: ReadonlySet<string>
  private readonly logger: PluginLogger
  private readonly memoryLogger: MemoryLogger
  private readonly runtime: CordisRuntime
  private destroyed = false

  constructor(options: PluginHostOptions) {
    this.workspaceId = options.workspaceId
    this.hostApiVersion = options.hostApiVersion ?? PLUGIN_API_VERSION
    this.cleanupTimeoutMs = typeof options.cleanupTimeoutMs === 'number' && Number.isFinite(options.cleanupTimeoutMs) && options.cleanupTimeoutMs > 0
      ? options.cleanupTimeoutMs
      : DEFAULT_CLEANUP_TIMEOUT_MS
    this.trustedPluginIds = new Set(options.trustedPluginIds)
    this.memoryLogger = new MemoryLogger()
    this.logger = options.logger ?? this.memoryLogger
    for (const [name, impl] of options.services ?? []) this.services.set(name, impl)
    this.runtime = CordisRuntime.create({
      error: (message, cause) => {
        // 上游把插件回调/清理抛错吞进 logger.error；不接管就变成无从观测的 console 噪音。
        this.logger.error(`cordis:${message}`, {
          cause: cause instanceof Error ? cause.message : String(cause),
        })
      },
    })
  }

  /** 宿主诊断日志（默认内存收集）。 */
  get logs(): readonly { level: string; message: string; detail?: Readonly<Record<string, string | number | boolean | null>> }[] {
    return this.memoryLogger.records
  }

  /** 注册宿主服务，供插件的 `requiredServices` 解析。返回注销函数。 */
  provideService(name: string, impl: unknown): () => void {
    this.services.set(name, impl)
    return (): void => {
      this.services.delete(name)
    }
  }

  // -------------------------------------------------------------------------
  // 注册（安装校验）
  // -------------------------------------------------------------------------

  /**
   * 注册插件：校验 manifest、校验可信来源、检查本版本不加载任意第三方代码。
   *
   * 失败返回 Err（不抛错）：
   * - manifest 非法 → `PLUGIN_MANIFEST_INVALID`（`detail.reason = 'manifest-invalid'`）
   * - 不在发行清单 / kind 非 trusted-builtin → `PLUGIN_MANIFEST_INVALID`（`not-trusted-builtin`）
   * - id 重复注册 → `ALREADY_EXISTS`
   */
  register(candidate: PluginCandidate, requestId: RequestId = newIds.request()): Result<PluginStatus> {
    const validation = validatePluginManifest(candidate.manifest)
    if (!validation.ok) {
      return err(this.manifestInvalidPayload('unknown', requestId, validation.issues))
    }
    const manifest = validation.value

    if (!this.isTrusted(manifest)) {
      return err(notTrustedPayload(manifest.id, requestId))
    }
    if (this.records.has(manifest.id)) {
      return err(
        makePayload('ALREADY_EXISTS', `插件 ${manifest.id} 已注册`, requestId, {
          pluginId: manifest.id,
        }),
      )
    }
    if (typeof candidate.plugin?.activate !== 'function') {
      return err(
        makePayload('PLUGIN_MANIFEST_INVALID', `插件 ${manifest.id} 未提供 activate() 实现`, requestId, {
          pluginId: manifest.id,
          reason: 'missing-activate',
        }),
      )
    }

    this.records.set(manifest.id, {
      manifest,
      plugin: candidate.plugin,
      state: 'registered',
      granted: grantableOf(manifest.permissions),
      runtime: null,
      fiber: null,
      lastFailure: undefined,
      retiredTasks: null,
      retiredEffects: null,
    })
    this.logger.info('plugin registered', { pluginId: manifest.id, version: manifest.version })
    return ok(this.statusOf(manifest.id) as PluginStatus)
  }

  private isTrusted(manifest: PluginManifest): boolean {
    // 🔴 双条件：kind 是「格式声明」不是信任授予（设计文档），必须叠加发行清单确认。
    if (manifest.kind !== 'trusted-builtin') return false
    return this.trustedPluginIds.has(manifest.id)
  }

  private manifestInvalidPayload(
    pluginId: string,
    requestId: RequestId,
    issues: readonly ManifestIssue[],
  ): ErrorPayload {
    const first = issues[0]
    return manifestInvalidPayload(pluginId, requestId, {
      reason: 'manifest-invalid',
      issueCount: issues.length,
      issueCodes: issues.map((issue) => issue.code).join(','),
      ...(first === undefined
        ? {}
        : { firstPath: first.path === '' ? '<root>' : first.path, firstCode: first.code }),
    })
  }

  // -------------------------------------------------------------------------
  // 加载 / 激活
  // -------------------------------------------------------------------------

  /**
   * 加载插件（含依赖图解析）。
   *
   * 与上游行为的关键差异：**依赖缺失 / 循环 / 版本不符一律拒绝**，而不是让 Cordis 把插件
   * 静默留在 PENDING（ADR 0002 结论 4）。
   */
  async load(pluginId: string, requestId: RequestId = newIds.request()): Promise<Result<LoadReport>> {
    const record = this.records.get(pluginId)
    if (!record) return err(notFoundPayload(pluginId, requestId))

    const available = new Map<string, PluginManifest>()
    for (const [id, item] of this.records) available.set(id, item.manifest)

    const resolution = resolveLoadOrder([pluginId], available)
    if (!resolution.ok) {
      const failure = resolution.failure
      switch (failure.kind) {
        case 'missing':
          return err(dependencyMissingPayload(failure.pluginId, failure.missingId, requestId))
        case 'cycle':
          return err(dependencyCyclePayload(failure.pluginId, failure.cycle, requestId))
        case 'version-mismatch':
          return err(
            dependencyVersionPayload(
              failure.pluginId,
              failure.dependencyId,
              failure.required,
              failure.found,
              requestId,
            ),
          )
      }
    }

    const activated: string[] = []
    const alreadyActive: string[] = []
    for (const id of resolution.order) {
      const item = this.records.get(id)
      if (!item) continue
      if (item.state === 'active') {
        alreadyActive.push(id)
        continue
      }
      if (item.state === 'quarantined') {
        return err(
          activationFailedPayload(
            id,
            'cleanup-timeout',
            `插件 ${id} 处于 quarantined，拒绝重新加载（需重启插件宿主）`,
            requestId,
          ),
        )
      }
      const result = await this.activateOne(id, requestId)
      if (!result.ok) return result
      activated.push(id)
    }
    return ok({ pluginId, activated, alreadyActive })
  }

  private async activateOne(pluginId: string, requestId: RequestId): Promise<Result<PluginStatus>> {
    const record = this.records.get(pluginId)
    if (!record) return err(notFoundPayload(pluginId, requestId))

    // 宿主 API 兼容性（manifest 声明 hostApiRange）。
    if (!satisfiesRange(this.hostApiVersion, record.manifest.hostApiRange)) {
      const payload = hostApiIncompatiblePayload(
        pluginId,
        record.manifest.hostApiRange,
        this.hostApiVersion,
        requestId,
      )
      this.markFailed(record, 'host-api-incompatible')
      return err(payload)
    }

    // 依赖必须已经在本次加载顺序里激活（拓扑序保证依赖在前）。
    for (const dependency of record.manifest.dependencies) {
      const dependencyRecord = this.records.get(dependency.id)
      if (!dependencyRecord || dependencyRecord.state !== 'active') {
        const payload = activationFailedPayload(
          pluginId,
          'dependency-not-active',
          `插件 ${pluginId} 的依赖 ${dependency.id} 未处于激活状态`,
          requestId,
          { dependencyId: dependency.id },
        )
        this.markFailed(record, 'dependency-not-active')
        return err(payload)
      }
    }

    // requiredServices 必须已由宿主提供。
    for (const service of record.manifest.requiredServices) {
      if (!this.services.has(service)) {
        const payload = activationFailedPayload(
          pluginId,
          'required-service-missing',
          `插件 ${pluginId} 要求宿主服务 ${service}，但宿主未提供`,
          requestId,
          { service },
        )
        this.markFailed(record, 'required-service-missing')
        return err(payload)
      }
    }

    const runtime = createPluginRuntime(
      {
        identity: { pluginId: record.manifest.id as PluginContext['identity']['pluginId'], workspaceId: this.workspaceId },
        granted: record.granted,
        declared: record.manifest.permissions,
        config: Object.freeze({ ...(record.manifest.configSchema ?? {}) }),
        services: this.services,
        contributions: this.contributions,
        data: this.data,
        logger: this.logger,
        requestId,
      },
      {
        panels: record.manifest.contributes.panels ?? [],
        commands: record.manifest.contributes.commands ?? [],
      },
    )

    // 清理钩子：fiber 被外部释放时也能跑一遍我们的清理（幂等）。
    let cleanupHookInstalled = false
    let rollbackTimedOut = false
    const spawn = await this.runtime.spawn({
      label: pluginId,
      apply: (registration) => {
        registration.registerDisposalHook(async () => {
          if (cleanupHookInstalled) return
          cleanupHookInstalled = true
          runtime.tasks.closeGate()
          if (await runtime.tasks.drain(this.cleanupTimeoutMs) === 'timeout') rollbackTimedOut = true
          const effects = await runtime.effects.disposeAllWithTimeout(this.cleanupTimeoutMs)
          if (effects.timedOut) rollbackTimedOut = true
          this.contributions.releasePlugin(pluginId)
        })
        return record.plugin.activate(runtime.context)
      },
    })

    if (!spawn.ok) {
      record.fiber = spawn.fiber
      const message =
        spawn.error instanceof Error ? spawn.error.message : `插件 ${pluginId} 激活失败`
      const reason = spawn.reason === 'activation-threw' ? 'activation-threw' : 'dependency-not-active'
      // 🔴 激活失败必须回滚：释放 fiber + 清理已注册的副作用，宿主继续服务其它插件。
      runtime.tasks.closeGate()
      if (spawn.fiber) {
        const disposed = await spawn.fiber.dispose(this.cleanupTimeoutMs)
        if (disposed.status !== 'disposed') rollbackTimedOut = true
      }
      if (await runtime.tasks.drain(this.cleanupTimeoutMs) === 'timeout') rollbackTimedOut = true
      const effects = await runtime.effects.disposeAllWithTimeout(this.cleanupTimeoutMs)
      if (effects.timedOut) rollbackTimedOut = true
      this.contributions.releasePlugin(pluginId)
      record.runtime = null
      record.retiredTasks = runtime.tasks
      record.retiredEffects = runtime.effects
      this.markFailed(record, reason)
      if (rollbackTimedOut) {
        record.state = 'quarantined'
        record.lastFailure = 'cleanup-timeout'
      }
      this.logger.error('plugin activation failed', { pluginId, reason, message })
      return err(activationFailedPayload(pluginId, reason, message, requestId, { activationError: message }))
    }

    record.runtime = runtime
    record.fiber = spawn.fiber
    record.state = 'active'
    record.lastFailure = undefined
    this.logger.info('plugin activated', { pluginId, phase: spawn.fiber.phase() })
    return ok(this.statusOf(pluginId) as PluginStatus)
  }

  private markFailed(record: PluginRecord, reason: string): void {
    record.state = 'failed'
    record.lastFailure = reason
    record.fiber = null
  }

  // -------------------------------------------------------------------------
  // 停用 / 卸载
  // -------------------------------------------------------------------------

  /**
   * 停用插件（设计文档「禁用」流程的完整实现）。
   *
   * 顺序（不可调换）：
   * 1. **关闭任务闸门** —— 之后 `tasks.start()` 返回 `PLUGIN_DISABLED`（运行任务时禁用）。
   * 2. **排空/取消在途任务** —— 只发 abort，不强杀；超时即判 quarantined。
   * 3. 调 `plugin.deactivate()`（抛错只记日志，不阻断后续清理）。
   * 4. 逆序执行插件登记的清理动作（逐个 try/catch + 整体超时）。
   * 5. 释放贡献点（含宿主兜底，插件忘记注销也不会泄漏）。
   * 6. 释放 fiber（带超时；上游可能永不返回）。
   *
   * `force` 为 false 时，若有其它**已激活**插件依赖本插件 → 拒绝并返回 `STATE_INVALID_TRANSITION`。
   */
  async disable(
    pluginId: string,
    options: { readonly force?: boolean; readonly requestId?: RequestId } = {},
  ): Promise<Result<DisableReport>> {
    const requestId = options.requestId ?? newIds.request()
    const record = this.records.get(pluginId)
    if (!record) return err(notFoundPayload(pluginId, requestId))
    if (record.state === 'disabled' || record.state === 'quarantined') {
      // 幂等：重复禁用不算错误（发布门禁要求「重复卸载」可用）。
      return ok({
        pluginId,
        state: record.state,
        drain: 'idle',
        effectsAttempted: 0,
        effectsFailed: 0,
        contributionsReleased: 0,
        cleanupTimedOut: record.state === 'quarantined',
        elapsedMs: 0,
      })
    }

    const available = new Map<string, PluginManifest>()
    for (const [id, item] of this.records) available.set(id, item.manifest)
    if (options.force !== true) {
      const blocking = dependentsOf(pluginId, available).filter(
        (id) => this.records.get(id)?.state === 'active',
      )
      if (blocking.length > 0) {
        return err(
          makePayload(
            'STATE_INVALID_TRANSITION',
            `插件 ${pluginId} 仍被已激活的插件依赖：${blocking.join(', ')}；请先停用它们或使用 force`,
            requestId,
            { pluginId, dependents: blocking.join(',') },
          ),
        )
      }
    }

    const startedAt = Date.now()
    const runtime = record.runtime
    let drain: DisableReport['drain'] = 'idle'
    let cleanupTimedOut = false

    // 1 + 2：关闸 → 排空。
    if (runtime) {
      runtime.tasks.closeGate()
      drain = await runtime.tasks.drain(this.cleanupTimeoutMs)
      if (drain === 'timeout') cleanupTimedOut = true
    }

    // 3：插件自己的 deactivate。抛错不阻断后续清理。
    const deactivated = await boundedCleanup(() => record.plugin.deactivate?.(), this.cleanupTimeoutMs)
    if (deactivated.status === 'timeout') cleanupTimedOut = true
    if (deactivated.status === 'threw') {
      this.logger.error('plugin deactivate threw', {
        pluginId,
        message: deactivated.error instanceof Error ? deactivated.error.message : String(deactivated.error),
      })
    }

    // 4：逆序清理（LIFO，逐个 try/catch + 整体超时）。
    const effectsReport = runtime
      ? await runtime.effects.disposeAllWithTimeout(this.cleanupTimeoutMs)
      : { attempted: 0, completed: 0, failures: [], timedOut: false }
    if (effectsReport.timedOut) cleanupTimedOut = true

    // 5：贡献点兜底释放。
    const contributionsReleased = this.contributions.releasePlugin(pluginId)

    // 6：释放 fiber（带超时）。
    if (record.fiber) {
      const disposed = await record.fiber.dispose(this.cleanupTimeoutMs)
      if (disposed.status === 'timeout') cleanupTimedOut = true
      record.fiber = null
    }

    record.retiredTasks = runtime?.tasks ?? record.retiredTasks
    record.retiredEffects = runtime?.effects ?? record.retiredEffects
    record.runtime = null
    record.state = cleanupTimedOut ? 'quarantined' : 'disabled'
    record.lastFailure = cleanupTimedOut ? 'cleanup-timeout' : undefined

    this.logger.info(cleanupTimedOut ? 'plugin quarantined' : 'plugin disabled', {
      pluginId,
      drain,
      effectsAttempted: effectsReport.attempted,
    })

    return ok({
      pluginId,
      state: record.state,
      drain,
      effectsAttempted: effectsReport.attempted,
      effectsFailed: effectsReport.failures.length,
      contributionsReleased,
      cleanupTimedOut,
      elapsedMs: Date.now() - startedAt,
    })
  }

  /** `enable` 是 `load` 的产品语义别名（反复 enable/disable 必须可循环）。 */
  async enable(pluginId: string, requestId: RequestId = newIds.request()): Promise<Result<LoadReport>> {
    const record = this.records.get(pluginId)
    if (!record) return err(notFoundPayload(pluginId, requestId))
    if (record.state === 'quarantined') {
      return err(
        activationFailedPayload(
          pluginId,
          'cleanup-timeout',
          `插件 ${pluginId} 处于 quarantined，必须先重启插件宿主`,
          requestId,
        ),
      )
    }
    return this.load(pluginId, requestId)
  }

  // -------------------------------------------------------------------------
  // 查询与关闭
  // -------------------------------------------------------------------------

  statusOf(pluginId: string): PluginStatus | undefined {
    const record = this.records.get(pluginId)
    if (!record) return undefined
    return {
      pluginId,
      version: record.manifest.version,
      kind: record.manifest.kind,
      state: record.state,
      grantedCapabilities: record.granted,
      declaredCapabilities: record.manifest.permissions,
      lastFailure: record.lastFailure,
    }
  }

  list(): readonly PluginStatus[] {
    return [...this.records.keys()].sort().map((id) => this.statusOf(id) as PluginStatus)
  }

  /** 插件是否处于 active（宿主内部判定，避免调用方误读状态字符串）。 */
  isActive(pluginId: string): boolean {
    return this.records.get(pluginId)?.state === 'active'
  }

  /** 运行期上下文（测试用：验证「禁用后调用被拒」）。 */
  contextOf(pluginId: string): PluginContext | undefined {
    return this.records.get(pluginId)?.runtime?.context
  }

  /** 资源计数器：发布门禁的「连续启停后资源回到可解释范围」断言依赖它。 */
  resources(): ResourceSnapshot {
    let activePlugins = 0
    let liveFibers = 0
    let quarantined = 0
    let pendingTasks = 0
    let liveEffects = 0
    for (const record of this.records.values()) {
      if (record.state === 'active') activePlugins += 1
      if (record.state === 'quarantined') quarantined += 1
      if (record.fiber) liveFibers += 1
      if (record.runtime) {
        pendingTasks += record.runtime.tasks.activeCount
        liveEffects += record.runtime.effects.size
      } else if (record.state === 'quarantined') {
        pendingTasks += record.retiredTasks?.activeCount ?? 0
        liveEffects += record.retiredEffects?.size ?? 0
      }
    }
    return {
      registeredPlugins: this.records.size,
      activePlugins,
      liveFibers,
      contributions: this.contributions.size,
      dataBuckets: this.data.bucketCount,
      pendingTasks,
      liveEffects,
      quarantined,
    }
  }

  /** 关闭宿主：释放全部插件 fiber。**不碰 root fiber**（见适配层注释）。 */
  async destroy(): Promise<readonly string[]> {
    if (this.destroyed) return []
    this.destroyed = true
    const ids = [...this.records.keys()].reverse()
    const quarantined: string[] = []
    for (const id of ids) {
      const result = await this.disable(id, { force: true })
      if (result.ok && result.value.state === 'quarantined') quarantined.push(id)
    }
    await this.runtime.destroy(this.cleanupTimeoutMs)
    return quarantined
  }
}

/** 授权 = 声明 ∩ 可授予（本版本无法安全授予的能力一律不批，见 ADR 008）。 */
function grantableOf(declared: readonly PluginCapability[]): readonly PluginCapability[] {
  // 复用 SDK 的判定，避免两处逻辑漂移。
  return declared.filter((capability) => isGrantableCapability(capability))
}

/** 供测试构造合法候选；也导出给宿主的使用者。 */
export function defineCandidate(manifest: unknown, plugin: ProductPlugin): PluginCandidate {
  return { manifest, plugin }
}

/** 暴露给上层的默认清理超时（毫秒），供 UI 侧的提示文案复用。 */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 2000

type CleanupOutcome = { readonly status: 'done' } | { readonly status: 'timeout' } | { readonly status: 'threw'; readonly error: unknown }

/** 插件生命周期回调与 effects 一样可能永久挂起；迟到拒绝也必须被接住。 */
async function boundedCleanup(body: () => void | Promise<void>, timeoutMs: number): Promise<CleanupOutcome> {
  return new Promise<CleanupOutcome>((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
    Promise.resolve().then(body).then(
      () => { clearTimeout(timer); resolve({ status: 'done' }) },
      (error: unknown) => { clearTimeout(timer); resolve({ status: 'threw', error }) },
    )
  })
}
