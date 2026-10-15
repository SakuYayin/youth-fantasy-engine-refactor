/**
 * HTTP 错误边界：契约错误码 → HTTP 状态码 → 响应体。
 *
 * 设计依据（`07-同步协议与API.md`）：
 * "普通错误结构为 code、message、requestId、retryable 与可选 details；
 *  **不得包含堆栈、正文和秘密**"；"401=需认证，403=无权限，409=版本/幂等冲突，
 *  410=游标或资源保留期结束，413=超过限制，429=限流，503=暂不可用"；
 * "客户端按 code 分类而非比较错误中文"。
 *
 * ## 为什么状态码表是"逐个码显式列出"而不是按严重度推导
 *
 * 严重度（info/warn/error/critical）描述的是"该不该惊动运维"，
 * 与 HTTP 状态码描述的"客户端该怎么做"**不是一回事**：`NETWORK_TIMEOUT` 是 warn
 * 但要报 408，`STORAGE_DISK_FULL` 是 critical 但要报 503，`NOT_FOUND` 是 info
 * 但要报 404。任何"按 severity 映射状态码"的写法都会在这三个码上出错，
 * 而错的那一面通常是"把客户端错误报成服务端错误"，客户端于是无限重试。
 *
 * 因此这里是**穷尽的 `Record<ErrorCode, number>`**：新增错误码时 TypeScript
 * 会直接编译失败，逼作者当场决定它的 HTTP 语义（见 `tests/http.errors.test.ts`
 * 里对"每个码都在 400/401/403/404/408/409/410/413/429/500/501/503 之内"的断言）。
 *
 * ## 为什么响应体要剥掉 `cause` 与 `severity`
 *
 * `ErrorPayload.cause` 的注释写着"绝不经 IPC/HTTP 外发"——它可能是原始异常消息，
 * 含 SQLite 驱动原文、SQL 片段甚至绝对路径。`severity` 是给日志分级用的，
 * 对外没有意义（客户端只看 code）。边界在这里做减法，而不是指望每个
 * 抛出点都小心翼翼。
 */

import { ContractError, ERROR_CODES, isErrorCode, toErrorPayload } from '@yfe/contracts'
import type { ErrorCode, ErrorPayload, RequestId } from '@yfe/contracts'

/**
 * HTTP 状态码提示。
 *
 * 契约里没有"限流"专用错误码（`ERROR_CODES` 里既没有 RATE_LIMITED 也没有
 * CURSOR_EXPIRED），但它对应的 HTTP 语义是明确的。用 Symbol 挂一个**不可枚举**的
 * 状态码提示，好处是：响应体里绝不会多出这个字段（JSON.stringify 看不到符号键），
 * 也不需要靠 `detail.reason` 这种字符串约定去反推状态码。
 */
const STATUS_HINT: unique symbol = Symbol('yfe.http.status')

/** 给契约错误附加一个传输层状态码（只在 HTTP 层内部使用）。 */
export function withStatusHint<T extends ContractError>(error: T, status: number): T {
  Object.defineProperty(error, STATUS_HINT, { value: status, enumerable: false, configurable: true })
  return error
}

export function statusHintOf(error: ContractError): number | undefined {
  const hint: unknown = (error as unknown as Record<symbol, unknown>)[STATUS_HINT]
  return typeof hint === 'number' ? hint : undefined
}

/** 状态码表里允许出现的全部取值。用于测试穷尽性与防止随手发明新状态码。 */
export const ALLOWED_HTTP_STATUSES: readonly number[] = [
  400, 401, 403, 404, 408, 409, 410, 413, 429, 500, 501, 503,
]

export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  // --- 输入校验：客户端能自己修 ---
  VALIDATION_FAILED: 400,
  VALIDATION_MISSING_FIELD: 400,
  VALIDATION_UNKNOWN_FIELD: 400,
  VALIDATION_OUT_OF_RANGE: 400,
  VALIDATION_MALFORMED_ID: 400,
  PAYLOAD_TOO_LARGE: 413,

  // --- 认证：先登录/重登 ---
  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_DEVICE_REVOKED: 401,
  AUTH_DEVICE_NOT_PAIRED: 401,

  // --- 授权：换账号也没用 ---
  PERMISSION_DENIED: 403,
  PERMISSION_WORKSPACE_MISMATCH: 403,
  PERMISSION_PLUGIN_CAPABILITY: 403,
  PERMISSION_READ_ONLY_MODE: 403,

  // --- 不存在 ---
  NOT_FOUND: 404,
  NOT_FOUND_PROJECT: 404,
  NOT_FOUND_DOCUMENT: 404,
  NOT_FOUND_ATTACHMENT: 404,
  NOT_FOUND_SNAPSHOT: 404,
  NOT_FOUND_JOB: 404,

  // --- 冲突：重新拉取再提交 ---
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  STATE_INVALID_TRANSITION: 409,
  RESOURCE_LOCKED: 409,
  ALREADY_EXISTS: 409,
  WORKSPACE_ALREADY_AUTHORITATIVE: 409,

  // --- 存储：服务端问题，客户端重试或等运维 ---
  STORAGE_UNAVAILABLE: 503,
  STORAGE_DISK_FULL: 503,
  STORAGE_READ_ONLY: 503,
  STORAGE_CORRUPT: 503,
  STORAGE_MIGRATION_FAILED: 500,
  STORAGE_SCHEMA_TOO_NEW: 503,

  // --- 网络（本服务作为客户端时的外呼失败）---
  NETWORK_UNAVAILABLE: 503,
  NETWORK_TIMEOUT: 408,
  NETWORK_TLS_FAILED: 503,
  NETWORK_SERVER_ERROR: 503,

  // --- AI 调用（契约 AI_ 组）。服务端首版不发起 AI 请求，但总映射必须穷尽：
  // 语义对齐网络组——超时 408、限流 429、上游问题 503；
  // 未配置/取消是调用方自己能解决的，归 400；上游返回畸形按"暂不可用"处理。---
  AI_NOT_CONFIGURED: 400,
  AI_AUTH_FAILED: 503,
  AI_RATE_LIMITED: 429,
  AI_TIMEOUT: 408,
  AI_UPSTREAM_ERROR: 503,
  AI_RESPONSE_MALFORMED: 503,
  AI_CANCELLED: 400,

  // --- 同步协议 ---
  SYNC_PROTOCOL_MISMATCH: 400,
  // 🔴 设计文档与契约测试一致：游标失效走 410（资源保留期结束），不是 404/409。
  SYNC_CURSOR_INVALID: 410,
  SYNC_BATCH_REJECTED: 409,
  SYNC_TARGET_UNREACHABLE: 503,
  SYNC_CAPABILITY_UNSUPPORTED: 400,
  SYNC_AUTHORITY_CONFLICT: 409,

  // --- 任务 ---
  JOB_CANCELLED: 409,
  JOB_TIMEOUT: 408,
  JOB_EXECUTOR_FAILED: 503,
  JOB_INPUT_VERSION_GONE: 410,
  JOB_QUEUE_FULL: 503,
  JOB_BUDGET_EXCEEDED: 429,

  // --- 插件 ---
  PLUGIN_NOT_FOUND: 404,
  PLUGIN_MANIFEST_INVALID: 400,
  PLUGIN_API_INCOMPATIBLE: 400,
  PLUGIN_ACTIVATION_FAILED: 500,
  PLUGIN_DISABLED: 403,

  // --- 服务级 ---
  SERVICE_UNAVAILABLE: 503,
  SERVICE_SHUTTING_DOWN: 503,
  SERVICE_RESTARTED: 503,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
}

/** 单个错误码的 HTTP 状态码。未知码（理论上不可达）兜底 500——**绝不兜底成 200**。 */
export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500
}

/** 实际生效的状态码：优先 Symbol 提示（例如限流 429），其次码表。 */
export function httpStatusForError(error: ContractError): number {
  return statusHintOf(error) ?? httpStatusFor(error.code)
}

/**
 * 对外响应体。
 *
 * 🔴 只有这五个字段。没有 `severity`、没有 `cause`、没有 `stack`、
 * 没有 `data`/`errors` 之类的透传口子——透传口子是堆栈泄漏的常见入口。
 */
export interface ErrorResponseBody {
  readonly code: ErrorCode
  readonly message: string
  readonly requestId: RequestId
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * 把任意抛出物折叠成"可以出网"的响应体。
 *
 * @param requestId **以当前请求为准**：契约错误里带的 requestId 可能来自更内层的
 *   调用（例如构造时就写死的常量），而响应体里的 requestId 必须与日志、与
 *   `X-Request-Id` 响应头完全一致，否则用户拿着它去查日志查不到。
 */
export function errorResponseBody(payload: ErrorPayload, requestId: RequestId): ErrorResponseBody {
  return {
    code: payload.code,
    message: payload.message,
    requestId,
    retryable: payload.retryable,
    ...(payload.detail === undefined ? {} : { detail: payload.detail }),
  }
}

/**
 * 把任意异常折叠成 `ContractError`。
 *
 * 🔴 `ContractError` 是**唯一**允许穿过 HTTP 边界的异常类型。其他异常一律折算成
 * `INTERNAL_ERROR`：原始消息只在服务端日志里（作为 `cause`）出现，
 * 因为 SQLite 驱动的报错会带上表名、SQL 片段和绝对路径。
 */
export function toContractError(thrown: unknown, requestId: RequestId): ContractError {
  if (thrown instanceof ContractError) {
    // 码必须真的是契约里的码（跨包运行时可能因为版本错配拿到别的值）。
    if (!isErrorCode(thrown.code)) {
      return new ContractError({
        code: 'INTERNAL_ERROR',
        message: '发生未预期的内部错误',
        requestId,
        cause: `unknown error code: ${String(thrown.code)}`,
      })
    }
    return thrown
  }
  const payload = toErrorPayload(thrown, requestId)
  return new ContractError({
    code: payload.code,
    message: payload.message,
    requestId,
    ...(payload.cause === undefined ? {} : { cause: payload.cause }),
  })
}

/**
 * Fastify 自带的请求错误（JSON 解析失败、体积超限等）也要有稳定码。
 *
 * Fastify 在 `error.code` 上放的是字符串（如 `FST_ERR_CTP_BODY_TOO_LARGE`），
 * 在 `error.statusCode` 上放的是 HTTP 码。这里按 statusCode 反查契约码，
 * 避免把框架内部错误码泄漏给客户端（客户端只该认契约码）。
 */
export interface FrameworkErrorLike {
  readonly statusCode?: number
  readonly code?: string
  readonly validation?: readonly unknown[]
}

export function contractErrorFromFramework(error: FrameworkErrorLike, requestId: RequestId): ContractError | null {
  if (Array.isArray(error.validation) && error.validation.length > 0) {
    return new ContractError({
      code: 'VALIDATION_FAILED',
      message: '请求参数不合法。',
      requestId,
      detail: { issueCount: error.validation.length },
    })
  }
  switch (error.statusCode) {
    case 400:
      return new ContractError({ code: 'VALIDATION_FAILED', message: '请求格式不合法。', requestId })
    case 401:
      return new ContractError({ code: 'AUTH_REQUIRED', message: '需要登录后才能访问。', requestId })
    case 403:
      return new ContractError({ code: 'PERMISSION_DENIED', message: '没有执行此操作的权限。', requestId })
    case 404:
      return new ContractError({ code: 'NOT_FOUND', message: '请求的资源不存在。', requestId })
    case 409:
      return new ContractError({
        code: 'STATE_INVALID_TRANSITION',
        message: '当前状态不允许此操作。',
        requestId,
      })
    case 413:
      return new ContractError({
        code: 'PAYLOAD_TOO_LARGE',
        message: '请求体超过允许的上限。',
        requestId,
      })
    case 415:
      return new ContractError({
        code: 'VALIDATION_FAILED',
        message: '不支持的内容类型，请使用 application/json。',
        requestId,
      })
    case 429:
      return withStatusHint(
        new ContractError({ code: 'RESOURCE_LOCKED', message: '请求过于频繁，请稍后再试。', requestId }),
        429,
      )
    default:
      return null
  }
}

/** 契约码全集的只读副本，供测试与文档生成使用。 */
export const ALL_ERROR_CODES: readonly ErrorCode[] = ERROR_CODES
