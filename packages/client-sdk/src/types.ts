/**
 * `@yfe/client-sdk` 的类型契约（权威依据：docs/adr/0006-renderer-architecture.md 的 D2 节）。
 *
 * 这里只有类型；运行时实现在：
 * - `client.ts`   —— `createClient` / 超时 / 白名单守卫
 * - `envelope.ts` —— 响应信封校验（串号检测、畸形拒绝）
 * - `errors.ts`   —— 错误载荷脱敏与 HTTP 适配
 *
 * 依赖只有 `@yfe/contracts`：不得 import DOM / Electron / Vue / `node:`（ADR 0006 D2 第 6 条）。
 */
import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  DocumentGetInput,
  DocumentGetOutput,
  DocumentTreeInput,
  DocumentTreeOutput,
  ProjectCreateInput,
  ProjectCreateOutput,
  Result,
  SaveDraftInput,
  SaveDraftOutput,
  SystemStatusOutput,
} from '@yfe/contracts'

/**
 * 与 main 进程通信的唯一通道。
 *
 * 形状与 `preload.cjs` 暴露的 `window.yfe.call` 一致：异步，且**可能抛**
 * （同步抛出也要被折算成 `Err`，不许穿透到调用方）。
 */
export interface ClientTransport {
  call(method: string, payload: unknown): Promise<unknown>
}

export interface CreateClientOptions {
  /**
   * 单次调用超时（毫秒），默认 15000（ADR 0006 D2 第 3 条）。
   *
   * 非法值（非数字 / NaN / Infinity / <= 0）一律回落到默认值：把 0 解释成
   * 「立即超时」会让所有调用莫名失败，静默回落比静默失败安全。
   */
  readonly timeoutMs?: number
}

/**
 * 方法名 → 契约入参/出参的映射。
 *
 * - 入参/出参直接用 `@yfe/contracts` 类型，**不自造 DTO**；
 * - 方法名必须与 `apps/desktop/src/shared/ipc/channels.ts` 的 `IPC_METHODS` 逐字一致
 *   （客户端另存一份副本，一致性由 `tests/whitelist.test.ts` 锁定）。
 */
export interface ClientContract {
  readonly saveDraft: { readonly input: SaveDraftInput; readonly output: SaveDraftOutput }
  readonly listDocumentTree: { readonly input: DocumentTreeInput; readonly output: DocumentTreeOutput }
  readonly getDocument: { readonly input: DocumentGetInput; readonly output: DocumentGetOutput }
  readonly createProject: { readonly input: ProjectCreateInput; readonly output: ProjectCreateOutput }
  readonly createDocument: { readonly input: DocumentCreateInput; readonly output: DocumentCreateOutput }
  readonly systemStatus: { readonly input: null; readonly output: SystemStatusOutput }
}

/** 六个 IPC 方法名（= `IPC_METHODS` 的联合）。 */
export type ClientMethod = keyof ClientContract

/**
 * 渲染层拿到的客户端。
 *
 * 语义（ADR 0006 D2）：**不抛异常**，一律返回 `Result<T>`；
 * 失败一律是已经脱敏的 `ErrorPayload`。六个方法名与 D2 的表逐字一致。
 */
export interface RendererClient {
  readonly saveDraft: (input: SaveDraftInput) => Promise<Result<SaveDraftOutput>>
  readonly listDocumentTree: (input: DocumentTreeInput) => Promise<Result<DocumentTreeOutput>>
  readonly getDocument: (input: DocumentGetInput) => Promise<Result<DocumentGetOutput>>
  readonly createProject: (input: ProjectCreateInput) => Promise<Result<ProjectCreateOutput>>
  readonly createDocument: (input: DocumentCreateInput) => Promise<Result<DocumentCreateOutput>>
  readonly systemStatus: () => Promise<Result<SystemStatusOutput>>
}
