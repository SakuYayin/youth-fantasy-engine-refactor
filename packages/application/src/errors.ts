/**
 * 用例层错误归一：把「任何东西」收敛成契约的 `ErrorPayload`。
 *
 * 设计依据（`10-开发规范与环境.md`）：业务错误用**稳定 code**，禁止把异常文本当契约
 * 穿过 IPC/HTTP 边界；错误码一旦发布即视为对外契约。因此本文件：
 *
 * 1. **不自定义错误码**，只用 `@yfe/contracts` 的 `ERROR_CODES`；
 * 2. 只做「失败原因 → 契约错误码」的映射，以及把越界值（异常、非法 Err、缺字段的
 *    适配器返回）收敛为合法载荷；
 * 3. 🔴 **绝不让堆栈/`cause` 外发**：`ErrorPayload.cause` 的契约语义是「仅本地调试，
 *    绝不经 IPC/HTTP 外发」，而应用用例层的返回值**就是要外发的那一份**，
 *    所以本层返回的载荷一律剥离 `cause`、截断堆栈与超长文本。
 *
 * 映射表（用例层的失败原因 → 契约错误码）：
 *
 * | 失败原因 | 错误码 |
 * | --- | --- |
 * | 入参缺字段 / 空串 | `VALIDATION_MISSING_FIELD` |
 * | ID 形状非法（含 `..`、路径穿越形态） | `VALIDATION_MALFORMED_ID` |
 * | 数值越界（如 `draftSequence < 0`） | `VALIDATION_OUT_OF_RANGE` |
 * | 其余形状不符（kind/placement/类型） | `VALIDATION_FAILED` |
 * | 文档不存在或已软删 | `NOT_FOUND_DOCUMENT` |
 * | 跨工作区 / 归属与 context 声明不符 | `PERMISSION_WORKSPACE_MISMATCH` |
 * | `expectedRevision` 过期、CAS 未命中 | `REVISION_CONFLICT`（存储层权威判定，原样透传） |
 * | 同一幂等键被用于不同请求 | `IDEMPOTENCY_KEY_REUSED` |
 * | 磁盘/结构/占用等驱动问题 | `STORAGE_*`（存储层翻译后原样透传） |
 * | 端口抛异常或返回非法形状 | `INTERNAL_ERROR` |
 */

import {
  ContractError,
  errOf,
  isErrorCode,
  isRetryable,
  severityOf,
  type Err,
  type ErrorCode,
  type ErrorPayload,
  type ErrorSeverity,
  type RequestId,
  type Result,
} from '@yfe/contracts'

/** 面向用户的单条文案上限。超长说明多半是拼接了内部细节，不是给用户看的。 */
const MAX_MESSAGE_LENGTH = 300
/** `detail` 里字符串值的上限（detail 禁止放正文/密钥/绝对路径用户名）。 */
const MAX_DETAIL_STRING_LENGTH = 200
/** `detail` 条目上限：防止适配器把整行数据塞进错误载荷。 */
const MAX_DETAIL_ENTRIES = 20
const FALLBACK_MESSAGE = '发生未预期的内部错误'

/** 堆栈帧起始处：`\n    at ` / `\r\n  at `。命中即在此截断。 */
const STACK_FRAME_START = /\r?\n\s*at\s/

/**
 * 清洗一段将要外发的文本：截断堆栈帧、折叠空白、限制长度。
 *
 * 这不是"格式化"，是**安全边界**：任何来自驱动/适配器的文本都可能带
 * `at C:\Users\<用户名>\...` 这类本地路径信息。
 */
export function sanitizeMessage(text: unknown): string {
  if (typeof text !== 'string') return ''
  const cut = text.search(STACK_FRAME_START)
  const withoutFrames = cut >= 0 ? text.slice(0, cut) : text
  const single = withoutFrames.replace(/\s+/g, ' ').trim()
  return single.length > MAX_MESSAGE_LENGTH ? `${single.slice(0, MAX_MESSAGE_LENGTH)}…` : single
}

function sanitizeDetail(
  detail: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  let count = 0
  for (const [key, value] of Object.entries(detail)) {
    if (count >= MAX_DETAIL_ENTRIES) break
    if (typeof value === 'string') {
      out[key] = sanitizeMessage(value).slice(0, MAX_DETAIL_STRING_LENGTH)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    } else {
      // 对象/数组/函数一律不原样外发：它们可能整块带上内部状态。
      out[key] = '[omitted]'
    }
    count += 1
  }
  return count === 0 ? undefined : out
}

function isSeverity(value: unknown): value is ErrorSeverity {
  return value === 'info' || value === 'warn' || value === 'error' || value === 'critical'
}

/**
 * 把**来源不可信**的载荷收敛为合法 `ErrorPayload`。
 *
 * 与契约 `errOf` 产出的载荷相比，本函数只做三件事：
 * 1. 丢弃 `cause`（契约规定它绝不经 IPC/HTTP 外发）；
 * 2. 未识别的 `code` 降级为 `INTERNAL_ERROR`，缺失的 `severity`/`retryable` 按 code 重算；
 * 3. 清洗 `message` 与 `detail` 中的字符串。
 *
 * 其余字段（`code`/`message`/`detail`）**语义原样保留**：存储层返回的
 * `REVISION_CONFLICT` + `detail.currentRevision` 必须原封不动到达调用方。
 */
export function sanitizeErrorPayload(
  payload: ErrorPayload,
  fallbackRequestId?: RequestId,
): ErrorPayload {
  const raw = payload as unknown as {
    code?: unknown
    message?: unknown
    requestId?: unknown
    severity?: unknown
    retryable?: unknown
    detail?: unknown
  }
  const code: ErrorCode = isErrorCode(raw.code) ? raw.code : 'INTERNAL_ERROR'
  const requestId =
    typeof raw.requestId === 'string' && raw.requestId.length > 0
      ? (raw.requestId as RequestId)
      : (fallbackRequestId ?? ('' as RequestId))
  const base: ErrorPayload = {
    code,
    message: sanitizeMessage(raw.message) || FALLBACK_MESSAGE,
    requestId,
    severity: isSeverity(raw.severity) ? raw.severity : severityOf(code),
    retryable: typeof raw.retryable === 'boolean' ? raw.retryable : isRetryable(code),
  }
  const detail = sanitizeDetail(raw.detail)
  return detail === undefined ? base : { ...base, detail }
}

/** 把端口返回的 `Err` 归一为可外发的 `Err`（剥离 `cause`，保留 code/message/detail）。 */
export function errFrom(payload: ErrorPayload, requestId?: RequestId): Err {
  return { ok: false, error: sanitizeErrorPayload(payload, requestId) }
}

/**
 * 把任意抛出物归一为可外发的 `ErrorPayload`。
 *
 * - `ContractError` 携带的都是我们自己写的中文短句，按契约载荷处理；
 * - 其余异常**只保留兜底文案**：异常消息可能含本地路径/正文片段/堆栈，
 *   一律丢弃（`cause` 也不填，因为本层返回值就是要外发的那份）。
 */
export function toErrorPayload(
  thrown: unknown,
  requestId: RequestId,
  fallbackMessage: string = FALLBACK_MESSAGE,
): ErrorPayload {
  if (thrown instanceof ContractError) return sanitizeErrorPayload(thrown.toPayload(), requestId)
  return {
    code: 'INTERNAL_ERROR',
    message: sanitizeMessage(fallbackMessage) || FALLBACK_MESSAGE,
    requestId,
    severity: severityOf('INTERNAL_ERROR'),
    retryable: isRetryable('INTERNAL_ERROR'),
  }
}

/** 归一后的失败结果。 */
export function fail(
  thrown: unknown,
  requestId: RequestId,
  fallbackMessage: string = FALLBACK_MESSAGE,
): Err {
  return { ok: false, error: toErrorPayload(thrown, requestId, fallbackMessage) }
}

/** 构造一个入参校验失败（`VALIDATION_*`）的 `Err`。 */
export function invalid(
  code: ErrorCode,
  message: string,
  requestId: RequestId,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): Err {
  return errFrom(errOf(code, message, requestId, detail).error, requestId)
}

/**
 * 包住整个用例体：注入的 `clock` / `ids` / `revisions` 也是外部代码，
 * 一旦它们抛异常，用例必须仍然返回 `Result` 而不是把异常炸到 IPC/HTTP 边界。
 */
export async function guard<T>(
  requestId: RequestId,
  fallbackMessage: string,
  body: () => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    return await body()
  } catch (thrown) {
    return fail(thrown, requestId, fallbackMessage)
  }
}

/** 运行时判定端口返回值是否是 `Result` 形状（适配器可能不守契约）。 */
export function isResultLike(value: unknown): value is Result<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { ok?: unknown; error?: unknown }
  if (candidate.ok === true) return true
  if (candidate.ok !== false) return false
  return typeof candidate.error === 'object' && candidate.error !== null
}

/**
 * 调用返回 `Result` 的端口，并把「抛异常」与「返回非法形状」统一归一为 `Err`。
 *
 * 🔴 绝不把失败的端口调用翻译成成功：`Err` 原样（清洗后）返回。
 */
export async function callPort<T>(
  operation: () => Promise<Result<T>>,
  requestId: RequestId,
  fallbackMessage: string,
): Promise<Result<T>> {
  let returned: unknown
  try {
    returned = await operation()
  } catch (thrown) {
    return fail(thrown, requestId, fallbackMessage)
  }
  if (!isResultLike(returned)) {
    return fail(
      new TypeError('端口返回了非 Result 值（适配器未遵守 ports.ts 契约）'),
      requestId,
      fallbackMessage,
    )
  }
  if (returned.ok) return { ok: true, value: returned.value as T }
  return errFrom(returned.error, requestId)
}

/**
 * 调用返回「值或 `null`」的只读端口（如 `loadDocument`）。
 *
 * 与 {@link callPort} 的差别只在成功分支：`null` 是合法答案（文档不存在），
 * 由用例决定翻译成哪个错误码。
 */
export async function callPortNullable<T>(
  operation: () => Promise<T | null>,
  requestId: RequestId,
  fallbackMessage: string,
): Promise<Result<T | null>> {
  try {
    const returned = await operation()
    return { ok: true, value: returned }
  } catch (thrown) {
    return fail(thrown, requestId, fallbackMessage)
  }
}
