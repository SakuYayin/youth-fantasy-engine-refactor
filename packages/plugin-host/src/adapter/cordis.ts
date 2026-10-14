/**
 * Cordis 适配层 —— **本模块是全仓库唯一允许 `import 'cordis'` 的地方**。
 *
 * 设计依据：`docs/adr/0002-cordis-lifecycle.md`（决策 2）。上游 README 自述
 * "The API is not yet stable and may change without notice."，所以：
 * - 上层（`src/host/**`、`src/index.ts`、应用层）**不得**直接 import cordis，
 *   只能通过本模块导出的 `CordisRuntime`；本模块导出的类型也**不含**任何 Cordis 类型。
 * - 上游若变更，只有本文件需要改；9 个探针会先失败报警。
 *
 * 🔴 已实测的上游语义（探针输出见 `tests/probes/PROBE-OUTPUT.txt`，勿凭印象改写本文件）：
 * 1. `ctx.isolate()` 只隔离**服务槽位**，**不隔离事件** → 插件事件必须由宿主显式路由。
 * 2. `ctx.get(未注册)` 返回 `undefined` 且不抛错 → 服务解析必须显式判空。
 * 3. 释放分两层：fiber 级并发、单 effect 内严格 LIFO 串行且**一处抛错中断该链**；
 *    永久挂起的 disposer 会让 `fiber.dispose()` **永不 settle** → 必须带超时。
 * 4. `ctx.plugin()` 返回 `Object.create(fiber)` wrapper；`await` 能判「激活抛错」，
 *    **判不出「依赖未满足」**（后者同样 resolve）→ 依赖必须由宿主自校验。
 * 5. `fiber.state` 字段与 `_getState()` 会分歧（FAILED 时 `_setEpoch` 早退）
 *    → 一律用 `_getState()` 读状态。
 * 6. `await effectWrapper` **不会**触发 disposer（上游 `then` 只把 `disposeAsync` 当值返回）
 *    → 释放只能靠显式调用 wrapper。
 */

import { Context } from 'cordis'

/**
 * 上游 `FiberState` 数值。
 *
 * 刻意**不 import 上游的 `const enum FiberState`**：`isolatedModules: true` 下不允许访问
 * ambient const enum（会编译报错），且数值常量能让适配层在无类型依赖的前提下自证语义。
 */
export const RAW_FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** 宿主自己的生命周期语义状态，**不向上层泄漏上游数值**。 */
export type HostFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'unknown'

/**
 * 上游 `Fiber` 的最小结构描述。
 *
 * `_getState()` 在上游 `.d.ts` 里是 `private`（下划线私有），因此这里用结构类型 + 断言访问。
 * 🔴 这是本适配层唯一的「私有 API 依赖点」：若上游删掉它，只需改本文件（ADR 0002 遗留风险 3）。
 */
interface RawFiber {
  readonly uid: number | null
  readonly state: number
  _getState(): number
  await(): Promise<unknown>
  dispose(): Promise<void>
  getEffects(): readonly { readonly label: string; readonly children: readonly unknown[] }[]
}

function asRawFiber(fiber: unknown): RawFiber {
  return fiber as RawFiber
}

/**
 * 从 wrapper 取出真实 fiber。
 *
 * `ctx.plugin()` 返回 `Object.create(fiber)`，因此 `Object.getPrototypeOf(wrapper)` 就是真实 fiber
 * （探针 07/08 实测：`wrapper` 自身 own key 只有 `then`）。
 */
function fiberOf(wrapper: unknown): RawFiber {
  const fromPrototype = Object.getPrototypeOf(wrapper)
  if (fromPrototype && typeof (fromPrototype as RawFiber)._getState === 'function') {
    return fromPrototype as RawFiber
  }
  return asRawFiber(wrapper)
}

/** 读真实状态（**权威**）。见 ADR 0002 结论 5。 */
export function readRawFiberState(fiber: RawFiber): number {
  return fiber._getState()
}

function toPhase(rawState: number): HostFiberPhase {
  switch (rawState) {
    case RAW_FIBER_STATE.PENDING:
      return 'pending'
    case RAW_FIBER_STATE.LOADING:
      return 'loading'
    case RAW_FIBER_STATE.ACTIVE:
      return 'active'
    case RAW_FIBER_STATE.FAILED:
      return 'failed'
    case RAW_FIBER_STATE.DISPOSED:
      return 'disposed'
    case RAW_FIBER_STATE.UNLOADING:
      return 'unloading'
    default:
      return 'unknown'
  }
}

/** 日志挂钩：宿主用它接管上游 `logger.error`（否则上游把插件错误吞进 console）。 */
export interface RuntimeLogSink {
  error(message: string, cause?: unknown): void
}

export interface SpawnRequest {
  /** 插件标识，仅用于日志与诊断，不参与上游语义。 */
  readonly label: string
  /**
   * 插件体。收到的 `registration` 只提供**一个**能力：注册 fiber 释放钩子。
   * 刻意不把上游 ctx 交给宿主，避免 Cordis 类型跨过适配层边界。
   */
  readonly apply: (registration: FiberRegistration) => void | Promise<void>
}

/**
 * fiber 作用域内的注册面。
 *
 * 目前只有「注册释放钩子」。按 ADR 0002 结论 3，宿主**只注册一个** disposer，
 * 内部自行逐个 try/catch（上游在同一 effect 内一处抛错会中断后续兄弟清理）。
 */
export interface FiberRegistration {
  registerDisposalHook(hook: () => void | Promise<void>): void
}

export type SpawnResult =
  | { readonly ok: true; readonly fiber: CordisFiber }
  | { readonly ok: false; readonly reason: 'activation-threw'; readonly error: unknown; readonly fiber: CordisFiber }
  | { readonly ok: false; readonly reason: 'rejected'; readonly error: unknown; readonly fiber: CordisFiber | null }

/** 宿主可见的 fiber 句柄：只暴露产品语义，不暴露上游类。 */
export interface CordisFiber {
  readonly label: string
  /** 读**权威**状态（`_getState()`）。 */
  phase(): HostFiberPhase
  /** 上游调试用数值，仅进日志。 */
  rawState(): number
  /** 效果元数据标签树，用于资源泄漏诊断。 */
  effectLabels(): readonly string[]
  /** 释放在途标志：超时后为 true，宿主据此标记 quarantined。 */
  disposalTimedOut(): boolean
  dispose(timeoutMs: number): Promise<DisposeResult>
}

export type DisposeResult =
  | { readonly status: 'disposed'; readonly elapsedMs: number }
  | { readonly status: 'timeout'; readonly elapsedMs: number }
  | { readonly status: 'threw'; readonly elapsedMs: number; readonly error: unknown }

function flattenEffectLabels(
  nodes: readonly { readonly label: string; readonly children: readonly unknown[] }[],
): string[] {
  const labels: string[] = []
  const walk = (list: readonly { readonly label: string; readonly children: readonly unknown[] }[]): void => {
    for (const node of list) {
      labels.push(node.label)
      walk(node.children as readonly { readonly label: string; readonly children: readonly unknown[] }[])
    }
  }
  walk(nodes)
  return labels
}

/** 带超时的释放在途标记：`WeakSet` 避免对 fiber 造成可观察的副作用。 */
class CordisFiberHandle implements CordisFiber {
  readonly label: string
  private readonly fiber: RawFiber
  private timedOut = false
  private disposed = false

  constructor(label: string, fiber: RawFiber) {
    this.label = label
    this.fiber = fiber
  }

  phase(): HostFiberPhase {
    return toPhase(readRawFiberState(this.fiber))
  }

  rawState(): number {
    return readRawFiberState(this.fiber)
  }

  effectLabels(): readonly string[] {
    try {
      return flattenEffectLabels(this.fiber.getEffects())
    } catch {
      // 已 dispose 的 fiber 上取 effect 可能抛错；诊断信息不该让宿主崩。
      return []
    }
  }

  disposalTimedOut(): boolean {
    return this.timedOut
  }

  async dispose(timeoutMs: number): Promise<DisposeResult> {
    if (this.disposed) {
      // 上游 dispose 本身幂等（探针 07 H），这里再加一层，避免重复等待永久挂起的清理。
      return { status: 'disposed', elapsedMs: 0 }
    }
    const startedAt = Date.now()
    let pending: Promise<void>
    try {
      pending = this.fiber.dispose()
    } catch (error) {
      this.disposed = true
      return { status: 'threw', elapsedMs: Date.now() - startedAt, error }
    }
    const raced = await raceWithTimeout(pending, timeoutMs)
    if (raced.kind === 'timeout') {
      // 🔴 上游既不 reject 也不返回（ADR 0002 结论 3）。标记后不再重试，
      // 因为再次 dispose 仍会卡在同一个永久挂起的 disposer 上。
      this.timedOut = true
      this.disposed = true
      return { status: 'timeout', elapsedMs: Date.now() - startedAt }
    }
    this.disposed = true
    if (raced.kind === 'rejected') {
      // 上游 fiber 级释放通常把 disposer 抛错吞进 logger.error（探针 05 C），
      // 走到这里说明 dispose() 自身 reject，属于更上游的异常。
      return { status: 'threw', elapsedMs: Date.now() - startedAt, error: raced.error }
    }
    return { status: 'disposed', elapsedMs: Date.now() - startedAt }
  }
}

type RaceOutcome<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }

/** 超时竞速。**绝不**因超时或 reject 抛出：两种都必须回到产品语义里处理。 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise.then<RaceOutcome<T>, RaceOutcome<T>>(
      (value) => ({ kind: 'fulfilled', value }),
      (error: unknown) => ({ kind: 'rejected', error }),
    )
  }
  return new Promise<RaceOutcome<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
    // 上游清理永久挂起时这个 promise 永不 settle；定时器会先给出 timeout。
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ kind: 'fulfilled', value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve({ kind: 'rejected', error })
      },
    )
  })
}

/**
 * Cordis 运行时封装。
 *
 * 刻意**不暴露** `Context`：宿主只拿到 `spawn()` / `destroy()` 与句柄类型。
 */
export class CordisRuntime {
  private readonly root: Context
  private readonly fibers: CordisFiberHandle[] = []
  private readonly logSink: RuntimeLogSink
  private destroyed = false

  private constructor(root: Context, logSink: RuntimeLogSink) {
    this.root = root
    this.logSink = logSink
    // 接管上游 logger.error：上游把插件回调抛错 / disposer 抛错写进 logger.error 后就不再抛出
    // （探针 05 C、07 B），不接管就会变成宿主无从观测的 console 噪音。
    const logger = this.root.logger as unknown as { error: (...args: unknown[]) => void }
    const original = logger.error
    logger.error = (...args: unknown[]): void => {
      logSink.error('cordis', args.length === 0 ? undefined : args[args.length - 1])
      try {
        original.apply(logger, args)
      } catch {
        // 上游 logger 自身出错不应影响宿主。
      }
    }
  }

  static create(logSink: RuntimeLogSink): CordisRuntime {
    return new CordisRuntime(new Context(), logSink)
  }

  /**
   * 启动一个插件 fiber。
   *
   * 判定规则来自 ADR 0002 结论 4/5（缺一不可）：
   * - `await` reject → `activation-threw`
   * - `await` resolve 且 `_getState() === ACTIVE` → 成功
   * - `await` resolve 但状态是 PENDING → 依赖未满足（上游**不会**报错，必须宿主自己发现）
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (this.destroyed) {
      return { ok: false, reason: 'rejected', error: new Error('cordis runtime already destroyed'), fiber: null }
    }
    let wrapper: unknown
    try {
      wrapper = this.root.plugin(async (ctx: Context) => {
        let disposalHook: (() => void | Promise<void>) | undefined
        // 🔴 单个 effect 只注册一个 disposer（ADR 0002 决策 7）。
        // `ctx.effect` 内部会 assertActive()，在插件体抛错时该 effect 仍已登记，
        // 因此 fiber 被外部释放时钩子仍会跑。
        ctx.effect(() => () => disposalHook?.(), `yfe:${request.label}`)
        await request.apply({
          registerDisposalHook: (hook) => {
            disposalHook = hook
          },
        })
      })
    } catch (error) {
      // 上游对非函数/无 apply 的 plugin 直接 throw（RegistryService.plugin）。
      return { ok: false, reason: 'rejected', error, fiber: null }
    }

    const rawFiber = fiberOf(wrapper)
    const handle = new CordisFiberHandle(request.label, rawFiber)
    this.fibers.push(handle)

    try {
      await (wrapper as PromiseLike<unknown>)
    } catch (error) {
      return { ok: false, reason: 'activation-threw', error, fiber: handle }
    }

    if (handle.phase() !== 'active') {
      // PENDING：依赖未满足；上游 await 同样 resolve（探针 09 E），必须在这里拦住。
      return {
        ok: false,
        reason: 'rejected',
        error: new Error(`plugin fiber not active after await (phase=${handle.phase()})`),
        fiber: handle,
      }
    }
    return { ok: true, fiber: handle }
  }

  /**
   * 关闭运行时：只释放**插件 fiber**，不碰 root fiber。
   *
   * 🔴 绝对不能对 root fiber 调 `dispose()`：root 的 `runtime` 为 `null`，
   * 其 `dispose` 实为 `restart()`（实测，见 ADR 0002「补充结论」的陷阱记录），
   * 会静默重启而不是关闭。
   */
  async destroy(timeoutMs: number): Promise<readonly DisposeResult[]> {
    this.destroyed = true
    const results: DisposeResult[] = []
    // 逆序释放：后加载的先卸载。
    for (const fiber of [...this.fibers].reverse()) {
      results.push(await fiber.dispose(timeoutMs))
    }
    this.fibers.length = 0
    return results
  }
}

/**
 * 事件与服务的适配说明（**不做隔离**）。
 *
 * 适配层**不**为插件创建 isolate 分支，也**不**把插件事件接到 Cordis 事件总线上：
 * 实测 `isolate` 不隔离事件（结论 1），一旦接线就等于让任意插件监听全宿主事件。
 * 插件可见的事件由宿主显式路由（见 `src/host/**`）。
 * 本函数存在只为在类型层面留下这条决策的锚点。
 */
export function cordisEventIsolationSupported(): false {
  return false
}
