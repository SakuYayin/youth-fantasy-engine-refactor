/**
 * `createClient` 的实现（ADR 0006 D2）。
 *
 * 职责：
 * 1. 方法名与 `IPC_METHODS` 逐字一致；
 * 2. **不抛异常**：一律 `Result<T>`，成功 `ok(value)`，失败 `err(payload)`；
 * 3. 白名单守卫（白名单外的方法**不发往 transport**）；
 * 4. 超时（默认 15000ms，可由 options 覆盖）→ `NETWORK_TIMEOUT` / `retryable: true`；
 * 5. 信封校验与串号检测委托 `envelope.ts`，脱敏委托 `errors.ts`。
 */
import { err, type ErrorPayload, type Result } from '@yfe/contracts'
import type {
  AiCompleteInput,
  AiCompleteOutput,
  DocumentCreateInput,
  DocumentCreateOutput,
  DocumentGetInput,
  DocumentGetOutput,
  DocumentTreeInput,
  DocumentTreeOutput,
  ProjectCreateInput,
  ProjectCreateOutput,
  SaveDraftInput,
  SaveDraftOutput,
  SettingsEntityGetInput,
  SettingsEntityGetOutput,
  SettingsEntityListInput,
  SettingsEntityListOutput,
  SettingsEntitySaveInput,
  SettingsEntitySaveOutput,
  SystemStatusOutput,
} from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'
import { parseResponseEnvelope } from './envelope.js'
import { clientError, fromThrown } from './errors.js'
import { newRequestId } from './request-id.js'
import type { ClientTransport, CreateClientOptions, RendererClient } from './types.js'
import { isIpcMethod, type IpcMethod } from './whitelist.js'

/** 默认超时（ADR 0006 D2 第 3 条）。 */
export const DEFAULT_TIMEOUT_MS = 15000

/** 超时哨兵：只用于内部 `Promise.race`，**绝不**进入任何 ErrorPayload。 */
const TIMEOUT_SIGNAL = Symbol('yfe.client.timeout')

type TimeoutSignal = typeof TIMEOUT_SIGNAL

/**
 * 未包装的调用入口：入参是任意方法名/载荷，出参恒为 `Result<unknown>`。
 *
 * 单独暴露是为了让「白名单外的方法」可测 —— 那在 `RendererClient` 的类型层面
 * 根本表达不出来（它只认六个方法名）。
 */
export type RawInvoke = (method: string, payload: unknown) => Promise<Result<unknown>>

/** 非法超时值回落到默认值：永远不会把 0 / 负数解释成「立即超时」。 */
export function normalizeTimeout(value: unknown): number {
  // 浏览器/Node 的定时器上限是有符号 32 位整数，溢出会变成约 1ms。
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 2_147_483_647
    ? value
    : DEFAULT_TIMEOUT_MS
}

function timeoutError(method: string, timeoutMs: number, requestId: RequestId): ErrorPayload {
  return clientError('NETWORK_TIMEOUT', `IPC 调用超时: ${method} 超过 ${timeoutMs}ms`, requestId, {
    reason: 'timeout',
    method,
    timeoutMs,
  })
}

/**
 * 并发超时包装：先到者定结论，输的一方结果被丢弃。
 *
 * - 两侧都 `clearTimeout`：不留未清理的定时器（否则进程会被拖住）；
 * - 只有第一个 `resolve` 生效，所以迟到的成功/失败都不可能改写已定结论；
 * - 被丢弃的 promise 已经挂了 rejection handler，因此不会产生 unhandledRejection。
 */
function raceWithTimeout(
  result: Promise<Result<unknown>>,
  timeoutMs: number,
): Promise<Result<unknown> | TimeoutSignal> {
  return new Promise<Result<unknown> | TimeoutSignal>((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT_SIGNAL), timeoutMs)
    // 传 `() => resolve(value)` 而不是裸 `resolve`：避免 `.then(resolve)` 丢 this，
    // 也避免将来有人多传一个参数把 reject 通道接错。
    result.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (thrown: unknown) => {
        clearTimeout(timer)
        resolve(err(fromThrown(thrown, newRequestId())))
      },
    )
  })
}

/**
 * 整个调用（**含 transport 往返**）与超时的竞速。
 *
 * 计时器必须在函数进入时**同步**建立，且覆盖 `transport.call` 本身：
 * 否则一个「返回了 promise 却永不 settle」的 transport 会让调用永远挂住 ——
 * 那是比超时报错更糟的失败模式（渲染层无任何反馈）。
 */
async function callWithTimeout(
  transport: ClientTransport,
  method: IpcMethod,
  payload: unknown,
  timeoutMs: number,
  requestId: RequestId,
): Promise<Result<unknown>> {
  const call = (async (): Promise<Result<unknown>> => {
    let raw: unknown
    try {
      raw = await transport.call(method, payload)
    } catch (thrown) {
      // transport 抛出的异常（native Error / 字符串 / undefined）都折算成载荷，
      // 绝不外泄原异常对象、stack 或 cause。
      return err(fromThrown(thrown, requestId))
    }
    // 信封校验与串号检测；畸形一律 Err（绝不把畸形当成功）。
    return parseResponseEnvelope(raw, method, requestId)
  })()

  const outcome = await raceWithTimeout(call, timeoutMs)
  if (outcome === TIMEOUT_SIGNAL) return err(timeoutError(method, timeoutMs, requestId))
  return outcome
}

/**
 * 构造一个不越过白名单、带超时、恒返回 `Result` 的原始调用入口。
 */
export function createRawInvoke(transport: ClientTransport, options?: CreateClientOptions): RawInvoke {
  const timeoutMs = normalizeTimeout(options?.timeoutMs)
  const transportUsable =
    typeof transport === 'object' && transport !== null && typeof (transport as ClientTransport).call === 'function'

  return async (method, payload) => {
    const requestId = newRequestId()

    // 守卫必须在发往 transport **之前**：白名单外的方法连一条消息都不该产生
    // （与 preload.cjs 的本地拒绝同构 —— 两层各自守一遍，任一层被绕过都还有另一层）。
    if (!isIpcMethod(method)) {
      return err(
        clientError('PERMISSION_METHOD_NOT_ALLOWED', `IPC 方法不在白名单: ${method}`, requestId, {
          reason: 'method_not_whitelisted',
        }),
      )
    }
    if (!transportUsable) {
      return err(
        clientError('INTERNAL_ERROR', 'IPC 传输不可用，调用未发出', requestId, {
          reason: 'transport_unavailable',
        }),
      )
    }
    return callWithTimeout(transport, method, payload, timeoutMs, requestId)
  }
}

/** 把 `RawInvoke` 收敛成具名方法：无参方法载荷为 `null`，返回值恰好是契约出参类型。 */
function createRendererClient(invoke: RawInvoke): RendererClient {
  return {
    saveDraft: (input: SaveDraftInput) => invoke('saveDraft', input) as Promise<Result<SaveDraftOutput>>,
    listDocumentTree: (input: DocumentTreeInput) =>
      invoke('listDocumentTree', input) as Promise<Result<DocumentTreeOutput>>,
    getDocument: (input: DocumentGetInput) => invoke('getDocument', input) as Promise<Result<DocumentGetOutput>>,
    createProject: (input: ProjectCreateInput) =>
      invoke('createProject', input) as Promise<Result<ProjectCreateOutput>>,
    createDocument: (input: DocumentCreateInput) =>
      invoke('createDocument', input) as Promise<Result<DocumentCreateOutput>>,
    systemStatus: () => invoke('systemStatus', null) as Promise<Result<SystemStatusOutput>>,
    listSettingsEntities: (input: SettingsEntityListInput) =>
      invoke('listSettingsEntities', input) as Promise<Result<SettingsEntityListOutput>>,
    getSettingsEntity: (input: SettingsEntityGetInput) =>
      invoke('getSettingsEntity', input) as Promise<Result<SettingsEntityGetOutput>>,
    saveSettingsEntity: (input: SettingsEntitySaveInput) =>
      invoke('saveSettingsEntity', input) as Promise<Result<SettingsEntitySaveOutput>>,
    aiComplete: (input: AiCompleteInput) => invoke('aiComplete', input) as Promise<Result<AiCompleteOutput>>,
  }
}

/**
 * 渲染层客户端工厂。
 *
 * @param transport 与 main 通信的通道（preload 暴露的 `window.yfe.call` 即符合此形状）
 * @param options   `{ timeoutMs?: number }`，默认 15000
 */
export function createClient(transport: ClientTransport, options?: CreateClientOptions): RendererClient {
  return createRendererClient(createRawInvoke(transport, options))
}
