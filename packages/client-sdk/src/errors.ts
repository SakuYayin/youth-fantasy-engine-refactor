/**
 * 错误载荷脱敏 —— 跨进程/跨网络边界前的最后一关（ADR 0006 D2 第 2 条）。
 *
 * 铁律（`packages/contracts/src/errors.ts:171-185` 的注释同义）:
 * - `cause` / stack / SQLite 原文 / 绝对路径 **绝不进入**调用方拿到的载荷；
 * - `detail` 只保留标量。
 *
 * 实现上刻意采用**白名单重建**（逐字段新建对象）而不是「删除若干字段」：
 * 信封里多带的任何键（`cause`、`stack`、以后新增的字段）都不可能顺带漏出去。
 */
import {
  ContractError,
  isErrorCode,
  isRetryable,
  severityOf,
  type ErrorCode,
  type ErrorPayload,
  type ErrorSeverity,
  type RequestId,
} from '@yfe/contracts'
import { newRequestId } from './request-id.js'

/** 面向用户的兜底文案：不含任何内部细节，可安全展示。 */
export const FALLBACK_MESSAGE = '发生未预期的内部错误'

/** `detail` 只允许标量映射（对象/数组最容易夹带内部结构，一律丢弃）。 */
export type ErrorDetail = Readonly<Record<string, string | number | boolean | null>>

const ERROR_SEVERITIES: readonly ErrorSeverity[] = ['info', 'warn', 'error', 'critical']

/**
 * 【既有缺陷，本包只做兼容、不擅自改契约】
 *
 * `PERMISSION_METHOD_NOT_ALLOWED` 是桥接层实际在用的码：
 * - `apps/desktop/src/preload/preload.cjs:52`（白名单外调用本地拒绝）
 * - `apps/desktop/src/main/main.mjs:354`（同样的拒绝信封）
 * - `apps/desktop/src/renderer/renderer.js:32`（渲染层按这个码分支）
 * - `docs/adr/0006-renderer-architecture.md:41`（D2 第 5 条把它写成契约）
 *
 * 但它**不在** `packages/contracts/src/errors.ts:15-98` 的 `ERROR_CODES` 里
 * （那里只有 `PERMISSION_DENIED` / `PERMISSION_WORKSPACE_MISMATCH` /
 * `PERMISSION_PLUGIN_CAPABILITY` / `PERMISSION_READ_ONLY_MODE`），
 * 于是 `isErrorCode('PERMISSION_METHOD_NOT_ALLOWED') === false`。
 *
 * 取舍：渲染层必须能收到这个码（否则 renderer.js:32 的分支永远不成立），
 * 所以这里显式豁免，让它**逐字保留**，而不是像真正的未知码那样降级成 `INTERNAL_ERROR`。
 * 修法应由 contracts 侧补码（或桥接侧改用 `PERMISSION_DENIED`），不属于本包职责。
 */
export const BRIDGE_LEGACY_ERROR_CODES = ['PERMISSION_METHOD_NOT_ALLOWED'] as const

export type BridgeLegacyErrorCode = (typeof BRIDGE_LEGACY_ERROR_CODES)[number]

const BRIDGE_LEGACY_SET: ReadonlySet<string> = new Set<string>(BRIDGE_LEGACY_ERROR_CODES)

export function isBridgeLegacyErrorCode(value: unknown): value is BridgeLegacyErrorCode {
  return typeof value === 'string' && BRIDGE_LEGACY_SET.has(value)
}

const MAX_MESSAGE_LENGTH = 300
const MAX_DETAIL_TEXT_LENGTH = 120
const PATH_PLACEHOLDER = '[path]'

/**
 * 绝对路径形态（保守，避免误伤普通斜杠 —— `docs/adr/x.md` 不是绝对路径）。
 * 第三条带一个「前置分隔符」捕获组，替换时必须把它放回去。
 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  // Windows 盘符路径：C:\Users\...；负向先行排除 `x:\` 之外紧跟斜杠的畸形串。
  /[A-Za-z]:[\\/](?![\\/])[^\s"'`]*/g,
  // UNC 共享：\\server\share\...
  /\\\\[^\s"'`]+/g,
  // POSIX 绝对路径：前面必须是行首或边界字符，且至少一段。
  /(^|[\s"'(=:,])((?:\/[^\s"'`\\/]+)+)/g,
]

/**
 * 一看就是存储层内部原文的形态。
 *
 * 刻意收窄到"SQLite 报错"的典型排版：宽泛匹配会把正常中文文案也误伤成兜底文案，
 * 那会让用户彻底看不懂发生了什么。
 */
const STORAGE_INTERNAL_PATTERNS: readonly RegExp[] = [
  /\bSQLITE_[A-Z_]+\b/,
  /\bnear\s+"[^"]*"\s*:/,
  /\btable\s+[\w.]+\s+has no column\b/i,
  /\bno such (?:table|column|index)\b/i,
]

export function looksLikeStorageInternals(value: string): boolean {
  return STORAGE_INTERNAL_PATTERNS.some((pattern) => pattern.test(value))
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

/**
 * 文本脱敏：只取第一行（后续行几乎必然是堆栈帧）、折叠空白、绝对路径 → `[path]`、限长。
 */
export function scrubText(value: string, maxLength: number = MAX_DETAIL_TEXT_LENGTH): string {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? ''
  let scrubbed = firstLine.replace(/\s+/g, ' ').trim()
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, (match: string, first: string | number | undefined) => {
      void match
      // 无捕获组的模式在替换回调里收到的是 offset（number），只有 string 才是分隔符。
      return typeof first === 'string' && first !== '' ? `${first}${PATH_PLACEHOLDER}` : PATH_PLACEHOLDER
    })
  }
  return truncate(scrubbed, maxLength)
}

/** 面向用户的文案：非字符串/存储层原文 → 兜底文案；其余过 `scrubText`。 */
export function sanitizeMessage(raw: unknown, fallback: string = FALLBACK_MESSAGE): string {
  if (typeof raw !== 'string') return fallback
  if (looksLikeStorageInternals(raw)) return fallback
  const scrubbed = scrubText(raw, MAX_MESSAGE_LENGTH)
  return scrubbed === '' ? fallback : scrubbed
}

export function isErrorSeverity(value: unknown): value is ErrorSeverity {
  return typeof value === 'string' && (ERROR_SEVERITIES as readonly string[]).includes(value)
}

/** 危险键：赋到普通对象上会改写原型链，直接丢弃。 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function sanitizeDetailValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return scrubText(value)
  // 对象 / 数组 / 函数 / undefined / symbol / bigint 一律丢弃。
  return undefined
}

/** 把任意 `detail` 归一成标量映射；没有可保留字段时返回 `undefined`。 */
export function sanitizeDetail(detail: unknown): ErrorDetail | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined
  const source = detail as Record<string, unknown>
  const safe: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue
    const value = sanitizeDetailValue(source[key])
    if (value !== undefined) safe[key] = value
  }
  return Object.keys(safe).length > 0 ? safe : undefined
}

/** requestId 解析：优先载荷里的非空字符串，其次调用方给的，最后现生成一个。 */
function resolveRequestId(raw: unknown, fallback: RequestId): RequestId {
  if (typeof raw === 'string' && raw !== '') return raw as RequestId
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return newRequestId()
}

/**
 * 把任意（可能畸形、可能来自不可信通道）的错误载荷折算成可安全外发的 `ErrorPayload`。
 *
 * - 未知/缺失契约码 → `INTERNAL_ERROR`，原文（脱敏后）进 `detail.serverCode`：
 *   契约码是闭集，让调用方按前缀分支的代码不能收到一个不存在的码；
 * - `severity`/`retryable` 只在类型正确时沿用信封值，否则按码推导；
 * - `cause` 一定不出现在结果里。
 */
export function sanitizeErrorPayload(raw: unknown, fallbackRequestId: RequestId = newRequestId()): ErrorPayload {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}

  const rawCode = source['code']
  let code: ErrorCode = 'INTERNAL_ERROR'
  let message = FALLBACK_MESSAGE
  let unknownServerCode: string | undefined

  if (isErrorCode(rawCode)) {
    code = rawCode
    message = sanitizeMessage(source['message'])
  } else if (isBridgeLegacyErrorCode(rawCode)) {
    // 桥接层遗留码：类型上不属于闭集，但运行时必须逐字保留（见上方注释）。
    code = rawCode as ErrorCode
    message = sanitizeMessage(source['message'])
  } else if (typeof rawCode === 'string' && rawCode !== '') {
    unknownServerCode = scrubText(rawCode, 64)
  }

  const requestId = resolveRequestId(source['requestId'], fallbackRequestId)

  const rawSeverity = source['severity']
  const severity = isErrorSeverity(rawSeverity) ? rawSeverity : severityOf(code)
  const rawRetryable = source['retryable']
  const retryable = typeof rawRetryable === 'boolean' ? rawRetryable : isRetryable(code)

  const detail: Record<string, string | number | boolean | null> = { ...(sanitizeDetail(source['detail']) ?? {}) }
  if (unknownServerCode !== undefined) detail['serverCode'] = unknownServerCode

  const payload: ErrorPayload = { code, message, requestId, severity, retryable }
  return Object.keys(detail).length > 0 ? { ...payload, detail } : payload
}

/**
 * 构造一个**本地**（未过通道）的脱敏错误载荷。
 *
 * 统一走 `sanitizeErrorPayload`，保证本地产生的错误与 main 回来的错误形状一致
 * ——包括「绝不带 cause」。
 */
export function clientError(
  code: ErrorCode | BridgeLegacyErrorCode,
  message: string,
  requestId: RequestId,
  detail?: ErrorDetail,
): ErrorPayload {
  return sanitizeErrorPayload({ code, message, requestId, detail }, requestId)
}

/** 把任意抛出物描述成一行可安全外发的文本（无 stack、无对象结构、无函数源码）。 */
export function describeThrown(thrown: unknown): string {
  if (thrown === undefined) return 'undefined'
  if (thrown === null) return 'null'
  if (typeof thrown === 'string') return scrubText(thrown)
  if (thrown instanceof Error) {
    const name = typeof thrown.name === 'string' && thrown.name !== '' ? thrown.name : 'Error'
    const message = typeof thrown.message === 'string' ? thrown.message : ''
    return scrubText(message === '' ? name : message)
  }
  // 其余（对象/数组/函数/symbol/number/bigint/boolean）只给类型标签：
  // `String(thrown)` 会把函数源码或数组内容整段带出去，那正是要避免的内部细节。
  return `非 Error 抛出物（typeof=${typeof thrown}）`
}

/**
 * transport 抛出物的折算（ADR 0006 D2 第 4 条）。
 *
 * - 契约错误按它自己的稳定码透传（但仍会重建，剥掉 `cause`）；
 * - 其余一律 `INTERNAL_ERROR` / `retryable: false`：未知抛出物无法判定是否可重试，
 *   在这里猜「可重试」会让上层无脑重放，比不重试更危险；
 * - 只带 `detail.reason` 与 `detail.thrown`（已脱敏的单行文本），
 *   绝不带 stack、绝不带原 Error 对象。
 */
export function fromThrown(thrown: unknown, requestId: RequestId): ErrorPayload {
  if (thrown instanceof ContractError) return sanitizeErrorPayload(thrown.toPayload(), requestId)
  return clientError('INTERNAL_ERROR', FALLBACK_MESSAGE, requestId, {
    reason: 'transport_threw',
    thrown: describeThrown(thrown),
  })
}

/**
 * HTTP/RPC 响应体形状：**不含** `severity`（本层不需要暴露严重度）与 `cause`。
 */
export interface ErrorResponseBody {
  readonly code: ErrorCode
  readonly message: string
  readonly requestId: RequestId
  readonly retryable: boolean
  readonly detail?: ErrorDetail
}

/** 适配层共用的响应体：由脱敏后的载荷再投影一次，字段是白名单。 */
export function errorResponseBody(payload: ErrorPayload, fallbackRequestId?: RequestId): ErrorResponseBody {
  const safe = sanitizeErrorPayload(payload, fallbackRequestId ?? newRequestId())
  const body: ErrorResponseBody = {
    code: safe.code,
    message: safe.message,
    requestId: safe.requestId,
    retryable: safe.retryable,
  }
  return safe.detail ? { ...body, detail: safe.detail } : body
}
