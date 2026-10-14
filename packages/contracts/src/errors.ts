/**
 * 稳定错误码与 Result 契约。
 *
 * 设计约束（见 10-开发规范与环境.md）：
 * - 业务错误用**稳定 code**，禁止把异常文本当契约穿过 IPC/HTTP 边界。
 * - IPC 与 HTTP 共用同一套错误分类，只是传输封装不同。
 * - 错误码一旦发布即视为对外契约，只能新增、不得改义。
 *
 * 分类前缀是刻意的：调用方可以按前缀粗粒度处理（如 `AUTH_*` 一律跳登录），
 * 也可以按精确码细粒度分支。
 */

import type { RequestId } from './ids.js'

export const ERROR_CODES = [
  // --- VALIDATION：入参不符合 Schema，客户端可自行修正后重试 ---
  'VALIDATION_FAILED',
  'VALIDATION_MISSING_FIELD',
  'VALIDATION_UNKNOWN_FIELD',
  'VALIDATION_OUT_OF_RANGE',
  'VALIDATION_MALFORMED_ID',
  'PAYLOAD_TOO_LARGE',

  // --- AUTH：身份未建立或已失效，重新认证后可能成功 ---
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_DEVICE_REVOKED',
  'AUTH_DEVICE_NOT_PAIRED',

  // --- PERMISSION：身份有效但无权执行，重试无用 ---
  'PERMISSION_DENIED',
  'PERMISSION_WORKSPACE_MISMATCH',
  'PERMISSION_PLUGIN_CAPABILITY',
  'PERMISSION_READ_ONLY_MODE',

  // --- NOT_FOUND：目标不存在或已被删除 ---
  'NOT_FOUND',
  'NOT_FOUND_PROJECT',
  'NOT_FOUND_DOCUMENT',
  'NOT_FOUND_ATTACHMENT',
  'NOT_FOUND_SNAPSHOT',
  'NOT_FOUND_JOB',

  // --- CONFLICT：并发或状态冲突，携当前状态可重试 ---
  'REVISION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'STATE_INVALID_TRANSITION',
  'RESOURCE_LOCKED',
  'ALREADY_EXISTS',
  'WORKSPACE_ALREADY_AUTHORITATIVE',

  // --- STORAGE：本地或服务端持久化失败 ---
  'STORAGE_UNAVAILABLE',
  'STORAGE_DISK_FULL',
  'STORAGE_READ_ONLY',
  'STORAGE_CORRUPT',
  'STORAGE_MIGRATION_FAILED',
  'STORAGE_SCHEMA_TOO_NEW',

  // --- NETWORK：传输层问题，重试可能成功 ---
  'NETWORK_UNAVAILABLE',
  'NETWORK_TIMEOUT',
  'NETWORK_TLS_FAILED',
  'NETWORK_SERVER_ERROR',

  // --- SYNC：同步协议层问题 ---
  'SYNC_PROTOCOL_MISMATCH',
  'SYNC_CURSOR_INVALID',
  'SYNC_BATCH_REJECTED',
  'SYNC_TARGET_UNREACHABLE',
  'SYNC_CAPABILITY_UNSUPPORTED',
  'SYNC_AUTHORITY_CONFLICT',

  // --- JOB：后台任务问题 ---
  'JOB_CANCELLED',
  'JOB_TIMEOUT',
  'JOB_EXECUTOR_FAILED',
  'JOB_INPUT_VERSION_GONE',
  'JOB_QUEUE_FULL',
  'JOB_BUDGET_EXCEEDED',

  // --- PLUGIN：插件内核问题 ---
  'PLUGIN_NOT_FOUND',
  'PLUGIN_MANIFEST_INVALID',
  'PLUGIN_API_INCOMPATIBLE',
  'PLUGIN_ACTIVATION_FAILED',
  'PLUGIN_DISABLED',

  // --- SERVICE：进程级故障 ---
  'SERVICE_UNAVAILABLE',
  'SERVICE_SHUTTING_DOWN',
  'SERVICE_RESTARTED',
  'INTERNAL_ERROR',
  'NOT_IMPLEMENTED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES)

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

/**
 * 错误严重度：决定 UI 呈现方式与是否计入发布门禁。
 * - `info`    预期内的业务分支（如冲突），必须给出可操作下一步
 * - `warn`    异常但已降级处理，用户数据未受影响
 * - `error`   操作失败，用户数据可能未写入
 * - `critical` 数据可靠性受威胁（如读失败被当成空库），必须阻断并上报
 */
export type ErrorSeverity = 'info' | 'warn' | 'error' | 'critical'

const SEVERITY_BY_PREFIX: ReadonlyArray<readonly [string, ErrorSeverity]> = [
  ['VALIDATION_', 'info'],
  ['AUTH_', 'warn'],
  ['PERMISSION_', 'warn'],
  ['NOT_FOUND_', 'info'],
  ['REVISION_CONFLICT', 'info'],
  ['ALREADY_EXISTS', 'info'],
  ['STORAGE_DISK_FULL', 'critical'],
  ['STORAGE_CORRUPT', 'critical'],
  ['STORAGE_SCHEMA_TOO_NEW', 'critical'],
  ['STORAGE_', 'error'],
  ['NETWORK_', 'warn'],
  ['SYNC_', 'warn'],
  ['JOB_CANCELLED', 'info'],
  ['JOB_', 'warn'],
  ['PLUGIN_', 'warn'],
  ['SERVICE_', 'error'],
  ['INTERNAL_ERROR', 'error'],
  ['NOT_IMPLEMENTED', 'warn'],
]

export function severityOf(code: ErrorCode): ErrorSeverity {
  for (const [prefix, severity] of SEVERITY_BY_PREFIX) {
    if (code.startsWith(prefix)) return severity
  }
  return 'error'
}

/** 该错误重试是否可能成功。UI 据此决定是否显示"重试"按钮。 */
export function isRetryable(code: ErrorCode): boolean {
  const severity = severityOf(code)
  if (severity === 'info') return code === 'REVISION_CONFLICT' || code === 'RESOURCE_LOCKED'
  return (
    code.startsWith('NETWORK_') ||
    code.startsWith('SYNC_TARGET') ||
    code === 'STORAGE_UNAVAILABLE' ||
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'JOB_EXECUTOR_FAILED'
  )
}

/**
 * 结构化错误载荷。
 *
 * `detail` 明文禁止存放正文内容与凭据：日志与错误上报会原样带走它
 * （见 10-开发规范与环境.md：分享日志前脱敏，日志默认无正文）。
 */
export interface ErrorPayload {
  readonly code: ErrorCode
  /** 面向用户的中文短句，可直接展示。 */
  readonly message: string
  readonly requestId: RequestId
  readonly severity: ErrorSeverity
  readonly retryable: boolean
  /**
   * 机器可读的附加上下文：字段名、期望值、当前 revision 等。
   * 禁止放入正文、密钥、绝对路径中的用户名。
   */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
  /** 仅本地调试可见，绝不经 IPC/HTTP 外发。 */
  readonly cause?: string
}

/** 跨边界可安全序列化的错误载体。 */
export class ContractError extends Error {
  readonly code: ErrorCode
  readonly requestId: RequestId
  readonly severity: ErrorSeverity
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>

  constructor(payload: Omit<ErrorPayload, 'severity' | 'retryable'> & Partial<Pick<ErrorPayload, 'severity' | 'retryable'>>) {
    super(payload.message)
    this.name = 'ContractError'
    this.code = payload.code
    this.requestId = payload.requestId
    this.severity = payload.severity ?? severityOf(payload.code)
    this.retryable = payload.retryable ?? isRetryable(payload.code)
    if (payload.detail) this.detail = payload.detail
    if (payload.cause) this.cause = payload.cause
  }

  toPayload(): ErrorPayload {
    const base: ErrorPayload = {
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      severity: this.severity,
      retryable: this.retryable,
    }
    return this.detail ? { ...base, detail: this.detail } : base
  }
}

// ---------------------------------------------------------------------------
// Result：显式成功/失败，不用异常表达业务分支
// ---------------------------------------------------------------------------

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err = { readonly ok: false; readonly error: ErrorPayload }
export type Result<T> = Ok<T> | Err

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err(payload: ErrorPayload): Err {
  return { ok: false, error: payload }
}

export function errOf(
  code: ErrorCode,
  message: string,
  requestId: RequestId,
  detail?: Readonly<Record<string, string | number | boolean | null>>,
): Err {
  const base: ErrorPayload = {
    code,
    message,
    requestId,
    severity: severityOf(code),
    retryable: isRetryable(code),
  }
  return err(detail ? { ...base, detail } : base)
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok
}

export function isErr<T>(r: Result<T>): r is Err {
  return !r.ok
}

/** 解包，失败时抛出。仅用于深层内部代码，边界层必须显式处理 Err。 */
export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value
  throw new ContractError({ ...r.error })
}

/** 把任意抛出物归一为 ErrorPayload，防止非契约异常泄漏到边界之外。 */
export function toErrorPayload(
  thrown: unknown,
  requestId: RequestId,
  fallbackMessage = '发生未预期的内部错误',
): ErrorPayload {
  if (thrown instanceof ContractError) return thrown.toPayload()
  if (thrown instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: fallbackMessage,
      requestId,
      severity: 'error',
      retryable: false,
      cause: thrown.message,
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: fallbackMessage,
    requestId,
    severity: 'error',
    retryable: false,
    cause: String(thrown),
  }
}
