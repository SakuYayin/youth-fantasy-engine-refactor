/**
 * 插件上下文契约（`@yfe/plugin-sdk/context`）。
 *
 * 🔴 **本模块是第三方插件唯一可见的宿主接口面**：
 * - 不得 `import 'cordis'`，不得导出任何 Cordis 类型（`Context`/`Fiber`/`FiberState`/`Service`…）；
 * - 不得导出宿主私有类型（适配层内部类、真实 fiber 句柄、isolate label 等）。
 *
 * 设计依据：`05-插件内核与SDK.md`「SDK 契约草案」与「生命周期」。真实实现由
 * `@yfe/plugin-host` 提供（见 `docs/adr/0002-cordis-lifecycle.md`）。
 *
 * 🔴 能力边界必须是**明说**的：`capabilities.require()` 只能做到「未声明的能力调用被拒绝」，
 * 它**不是安全沙箱**，无法阻止插件绕过本 SDK 直接使用 Node API。依据 ADR 008：
 * 「不能将 Node vm、进程、Worker 当作自动沙箱；签名也不代表安全认证」。
 */

import type { PluginId, RequestId, WorkspaceId } from '@yfe/contracts'
import { ContractError, err, isErr, ok, severityOf, isRetryable } from '@yfe/contracts'
import type { Err, ErrorPayload, Ok, Result } from '@yfe/contracts'
import type { PluginCapability, PluginManifest } from '../manifest/index.js'
import { isGrantableCapability } from '../manifest/index.js'

/** 本 SDK 面向插件作者承诺的接口版本；与 `@yfe/contracts` 的 `PLUGIN_API_VERSION` 对齐。 */
export const PLUGIN_SDK_VERSION = '1.0.0' as const

/** 插件身份。`workspaceId` 参与数据命名空间，插件之间与工作区之间互不可见。 */
export interface PluginIdentity {
  readonly pluginId: PluginId
  readonly workspaceId: WorkspaceId
}

// ---------------------------------------------------------------------------
// 能力（声明 ≠ 授权）
// ---------------------------------------------------------------------------

/**
 * 已授权能力的只读视图。
 *
 * 由宿主在激活前根据「manifest 声明 ∩ 宿主策略」构造，插件**无法**自行扩大。
 */
export interface CapabilityGrant {
  has(capability: PluginCapability): boolean
  list(): readonly PluginCapability[]
}

export interface CapabilityGate extends CapabilityGrant {
  /**
   * 校验能力；**未授权时返回 `PERMISSION_PLUGIN_CAPABILITY` 的 Err，而不是抛错**。
   *
   * 用 Result 而非异常是刻意的：能力不足是可预期的业务分支，调用方必须显式处理
   * （见 `packages/contracts/src/errors.ts` 的分类说明）。
   */
  require(capability: PluginCapability): Result<void>
}

/** 能力被拒绝时的说明文案：区分「没声明」「不可授予」「已声明但宿主未批准」。 */
export function describeCapabilityDenial(
  capability: PluginCapability,
  declared: boolean,
): string {
  if (!isGrantableCapability(capability)) {
    return `能力 ${capability} 在本版本无法安全授予（缺少真实能力隔离，见 ADR 008）`
  }
  if (!declared) {
    return `插件未在 manifest.permissions 声明能力 ${capability}`
  }
  return `宿主未批准能力 ${capability}`
}

/**
 * 能力校验的**唯一实现**：宿主与插件共用，避免两处逻辑漂移。
 *
 * 传入 `declared` 只是为了给出更准确的文案；授权判定只看 `granted`。
 */
export function requireCapability(
  granted: readonly PluginCapability[],
  capability: PluginCapability,
  requestId: RequestId,
  declared = true,
): Result<void> {
  if (granted.includes(capability)) return ok(undefined)
  return err(
    capabilityDeniedPayload(capability, requestId, describeCapabilityDenial(capability, declared)),
  )
}

/** 构造 `PERMISSION_PLUGIN_CAPABILITY` 的 ErrorPayload。 */
export function capabilityDeniedPayload(
  capability: PluginCapability,
  requestId: RequestId,
  message = `缺少插件能力：${capability}`,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): ErrorPayload {
  return {
    code: 'PERMISSION_PLUGIN_CAPABILITY',
    message,
    requestId,
    severity: severityOf('PERMISSION_PLUGIN_CAPABILITY'),
    retryable: isRetryable('PERMISSION_PLUGIN_CAPABILITY'),
    detail: { capability, ...detail },
  }
}

/** 把 Err 载荷包成可抛出的 `ContractError`（仅在调用方要用异常表达时使用）。 */
export function throwCapabilityDenied(payload: ErrorPayload): never {
  throw new ContractError({ ...payload })
}

// ---------------------------------------------------------------------------
// 服务解析
// ---------------------------------------------------------------------------

/**
 * 服务解析器。
 *
 * 🔴 实测（ADR 0002 结论 2）：上游 `ctx.get()` 未注册时返回 `undefined` 且不抛错。
 * 适配层把它收敛为**显式 Result**，强迫插件处理「服务不存在」，不把 undefined 当正常值传递。
 */
export interface ServiceResolver {
  /** 解析服务。未注册返回 `NOT_FOUND`（不是抛错、也不是 undefined）。 */
  get<T = unknown>(name: string): Result<T>
  has(name: string): boolean
  list(): readonly string[]
}

// ---------------------------------------------------------------------------
// 贡献点
// ---------------------------------------------------------------------------

export type ContributionKind = 'panel' | 'command'

export interface ContributionDescriptor {
  readonly kind: ContributionKind
  /** 贡献点 id，必须在 manifest.contributes 里预先声明且全局唯一。 */
  readonly id: string
  /** 展示名/命令标题，面向用户。 */
  readonly title: string
  /** 排序权重，越小越靠前。 */
  readonly order?: number
}

/** 注销句柄：幂等，重复调用不报错。 */
export type ContributionDisposer = () => void

export interface ContributionRegistry {
  /**
   * 注册一个贡献点。
   *
   * 失败分支（返回 Err，不抛错）：
   * - 未声明对应能力 → `PERMISSION_PLUGIN_CAPABILITY`
   * - 未在 manifest.contributes 声明该 id → `PLUGIN_MANIFEST_INVALID`
   * - 该 id 已被别的插件占用 → `ALREADY_EXISTS`
   */
  register(descriptor: ContributionDescriptor): Result<ContributionDisposer>
  /** 当前插件已注册的贡献点 id。 */
  list(): readonly ContributionDescriptor[]
  /** 注销全部（宿主在 deactivate 后兜底调用，防止插件忘记清理）。 */
  disposeAll(): void
}

// ---------------------------------------------------------------------------
// 数据仓库
// ---------------------------------------------------------------------------

/**
 * 插件数据仓库，命名空间为 `(workspaceId, pluginId, key)`。
 *
 * 所有写操作都要求 `plugin.data.write` 能力；未授权返回 `PERMISSION_PLUGIN_CAPABILITY`
 * ——这就是设计文档要求的「**降级拒写**」。
 */
export interface PluginDataRepository {
  get(key: string): Promise<Result<unknown>>
  /** 需要能力 `plugin.data.write`。 */
  set(key: string, value: unknown): Promise<Result<void>>
  /** 需要能力 `plugin.data.write`。 */
  delete(key: string): Promise<Result<void>>
  keys(): Promise<Result<readonly string[]>>
  /** 需要能力 `plugin.data.write`。清空**本插件在本工作区**的全部键。 */
  clear(): Promise<Result<void>>
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

/**
 * 受宿主管理的插件任务。
 *
 * 设计依据：`05-插件内核与SDK.md`「禁用：先停止新任务并解除 UI 入口，按策略排空或取消
 * 运行任务」——所以任务**必须由宿主登记**，插件自己起的裸 Promise 宿主无法排空。
 */
export interface PluginTaskHandle {
  readonly id: string
  /** 任务结束后 settle（不会 reject：失败信息通过 `outcome` 读取）。 */
  readonly done: Promise<void>
  readonly signal: AbortSignal
  readonly settled: boolean
  readonly outcome: PluginTaskOutcome | undefined
}

export type PluginTaskOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'failed' | 'cancelled' | 'rejected-while-disabled'; readonly message: string }

export interface PluginTaskScope {
  /**
   * 启动任务。
   *
   * `body` 收到一个 `AbortSignal`，**必须**在长循环里检查 `signal.aborted`；
   * 宿主取消时只 abort，不会强杀（无法安全的强杀，见 ADR 0002 结论 3）。
   *
   * 插件已被禁用时返回 Err(`PLUGIN_DISABLED`)。
   */
  start(
    name: string,
    body: (signal: AbortSignal) => Promise<void>,
  ): Result<PluginTaskHandle>
  /** 仍在运行的任务数——资源泄漏断言依赖它。 */
  readonly activeCount: number
  /** 宿主排空用：取消全部任务并等待结束（可能超时）。 */
  drain(timeoutMs: number): Promise<DrainOutcome>
}

export type DrainOutcome = 'drained' | 'timeout' | 'idle'

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export interface PluginLogger {
  debug(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void
  info(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void
  warn(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void
  error(message: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void
}

// ---------------------------------------------------------------------------
// 插件上下文
// ---------------------------------------------------------------------------

/** 宿主注入给插件的全部能力面。除这些之外插件不应假设任何其它 API 存在。 */
export interface PluginContext {
  readonly identity: PluginIdentity
  readonly capabilities: CapabilityGate
  readonly services: ServiceResolver
  readonly contributions: ContributionRegistry
  readonly config: Readonly<Record<string, unknown>>
  readonly data: PluginDataRepository
  readonly tasks: PluginTaskScope
  readonly logger: PluginLogger
  /**
   * 注册清理动作。宿主保证在 `deactivate` 之后**逆序**执行（LIFO），
   * 并对每个 disposer 单独 try/catch + 超时（ADR 0002 结论 3/6）。
   *
   * 返回的句柄可提前注销该清理动作；幂等。
   */
  readonly effects: EffectsScope
}

export interface EffectsScope {
  add(dispose: () => void | Promise<void>): EffectsDisposer
  readonly size: number
  /** 宿主调用；插件不应主动调用（提前释放会打乱 LIFO 语义）。 */
  disposeAll(): Promise<EffectsDisposeReport>
}

export type EffectsDisposer = () => void

export interface EffectsDisposeReport {
  readonly attempted: number
  /** 恒等于 `attempted`——每个 disposer 都会被尝试，不因一个失败而中断。 */
  readonly completed: number
  readonly failures: readonly EffectsFailure[]
  /** 是否因超时提前返回；为 true 时宿主应把插件置为 quarantined。 */
  readonly timedOut: boolean
}

export interface EffectsFailure {
  readonly index: number
  readonly message: string
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 插件实现。与 Manifest 分离：Manifest 是数据，本接口是行为。
 *
 * 契约：
 * - `activate` 抛错 ⇒ 宿主标记 `PLUGIN_ACTIVATION_FAILED`，且**不影响其它插件**；
 * - `deactivate` 抛错 ⇒ 宿主记日志、继续执行 `effects` 清理，插件最终仍是已停用；
 * - 两者都必须可被重复调用（幂等）——宿主在异常路径上会兜底再调一次。
 */
export interface ProductPlugin {
  activate(context: PluginContext): Promise<void>
  deactivate?(): Promise<void>
}

/** Manifest + 行为，宿主注册插件时使用的最小单元。 */
export interface PluginModule {
  readonly manifest: PluginManifest
  readonly plugin: ProductPlugin
}

/** 作者侧的类型辅助：保持字面量推断，不做任何运行时行为。 */
export function definePlugin(plugin: ProductPlugin): ProductPlugin {
  return plugin
}

// ---------------------------------------------------------------------------
// 小工具（插件作者常用，避免各自重复实现）
// ---------------------------------------------------------------------------

export function isOkResult<T>(result: Result<T>): result is Ok<T> {
  return result.ok
}

export function isErrResult<T>(result: Result<T>): result is Err {
  return isErr(result)
}

/** 把 Result 解包为值，失败时抛 `ContractError`。仅在插件内部深层代码使用。 */
export function expectOk<T>(result: Result<T>): T {
  if (result.ok) return result.value
  throw new ContractError({ ...result.error })
}
