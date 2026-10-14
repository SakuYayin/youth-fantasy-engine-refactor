/**
 * 旧版只读导入器 —— 读取失败的分类学（**本包的地基**）。
 *
 * 设计依据 `docs/旧功能迁移矩阵.md` §2.3（R-01 / R-04 / R-06 / R-11）与
 * `重构相关文档/重构开发文档/11-测试验收与迁移.md:59`：
 *
 * > 只读解析副本，建立旧 ID/字段映射，**拒绝读取失败当空**。
 *
 * 🔴 本文件只做一件事：把「读不出来」翻译成**契约错误码**，让它在整条链路上
 *    都不可能被折叠成「0 条记录」。三条不可动摇的规则：
 *
 * 1. **`kind` 只描述失败形态，不描述严重性**；严重性由 `severityOf(code)` 决定，
 *    本包不自造严重性、不自造错误码（`ERROR_CODES` 是闭集）。
 * 2. **`kind` 走 `detail.kind`**（`ErrorPayload.detail` 允许 string），
 *    这样读取失败仍然是标准 `Result<T>` 的 `Err`，不需要一套平行的 Result 类型。
 * 3. **`location` 恒为「来源里的什么位置」**（`数据库/store/键` 或文件相对路径），
 *    报告里靠它定位；绝不放绝对路径（`R-03`：文案要告诉用户文件在哪，但日志不泄露用户名）。
 */

import {
  errOf,
  type Err,
  type ErrorCode,
  type ErrorPayload,
  type RequestId,
} from '@yfe/contracts'

// ---------------------------------------------------------------------------
// 失败形态
// ---------------------------------------------------------------------------

/**
 * 读取失败的六种形态。
 *
 * 「明确不存在」与「读不出来」**必须**分开：
 * - `not-found` / `store-missing` 是「证据说它不在」——**只有**在旧库清单显式声明
 *   该 store 从未创建时，才允许折算成 0 条；无声明时一律按 `refused` 处理
 *   （`desktop.ts:459-462` 原文：「missing 未知时不能当『首次使用』放行」）。
 * - `decode-failed` / `package-corrupt` / `permission-denied` / `timeout` 是「我们没读到」，
 *   **任何情况下**都不允许当空（`syncTransport.ts:182-183`、`syncCore.ts:476`）。
 */
export type LegacyReadFailureKind =
  | 'not-found'
  | 'store-missing'
  | 'decode-failed'
  | 'package-corrupt'
  | 'permission-denied'
  | 'timeout'
  | 'unknown'

export const LEGACY_READ_FAILURE_KINDS = [
  'not-found',
  'store-missing',
  'decode-failed',
  'package-corrupt',
  'permission-denied',
  'timeout',
  'unknown',
] as const satisfies readonly LegacyReadFailureKind[]

export function isLegacyReadFailureKind(value: unknown): value is LegacyReadFailureKind {
  return typeof value === 'string' && (LEGACY_READ_FAILURE_KINDS as readonly string[]).includes(value)
}

/** 读取通道：决定 `timeout` 落在 NETWORK 还是 STORAGE 域（`R-04` 的口径）。 */
export type LegacyReadOrigin = 'local' | 'remote'

/**
 * 形态 → 契约错误码。
 *
 * ⚠️ 契约缺口（只报告，不改别人的文件）：`ERROR_CODES` 里**没有**「本地读取超时」这一码，
 *    因此 `timeout` 按通道分流：远端（WebDAV/S3）→ `NETWORK_TIMEOUT`，
 *    本地（IndexedDB / 文件 / sidecar）→ `STORAGE_UNAVAILABLE`。
 *    形态本身由 `detail.kind` 保真，报告里不会丢失「是超时还是损坏」。
 */
export function errorCodeOfReadFailure(
  kind: LegacyReadFailureKind,
  origin: LegacyReadOrigin = 'local',
): ErrorCode {
  switch (kind) {
    case 'not-found':
      return 'NOT_FOUND'
    case 'store-missing':
      return 'NOT_FOUND'
    case 'decode-failed':
      return 'STORAGE_CORRUPT'
    case 'package-corrupt':
      return 'STORAGE_CORRUPT'
    case 'permission-denied':
      return 'PERMISSION_DENIED'
    case 'timeout':
      return origin === 'remote' ? 'NETWORK_TIMEOUT' : 'STORAGE_UNAVAILABLE'
    case 'unknown':
      return 'STORAGE_UNAVAILABLE'
  }
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export interface LegacyReadFailureInit {
  readonly kind: LegacyReadFailureKind
  /** 面向用户的中文短句。 */
  readonly message: string
  /** 来源里的位置：`<database>/<store>` 或文件相对路径。**不放绝对路径**。 */
  readonly location: string
  readonly origin?: LegacyReadOrigin
  /** 仅本地调试可见。 */
  readonly cause?: string
}

/**
 * 构造一个带契约错误码的读取失败。
 *
 * `detail` 固定携带 `kind` / `location` / `origin`，因此调用方**总能**把失败形态读回来
 * （{@link classifyReadFailure}），不需要 `instanceof` 或字符串匹配。
 */
export function legacyReadFailure(init: LegacyReadFailureInit, requestId: RequestId): Err {
  const origin: LegacyReadOrigin = init.origin ?? 'local'
  const code = errorCodeOfReadFailure(init.kind, origin)
  const detail: Record<string, string | number | boolean | null> = {
    kind: init.kind,
    location: init.location,
    origin,
  }
  const base = errOf(code, init.message, requestId, detail)
  return init.cause === undefined ? base : { ok: false, error: { ...base.error, cause: init.cause } }
}

/** 读回失败形态。缺 `detail.kind`（例如别人构造的 `Err`）时按 `unknown` 保守处理。 */
export function classifyReadFailure(error: ErrorPayload): LegacyReadFailureKind {
  const kind = error.detail?.['kind']
  return isLegacyReadFailureKind(kind) ? kind : 'unknown'
}

export function readFailureLocation(error: ErrorPayload): string {
  const location = error.detail?.['location']
  return typeof location === 'string' ? location : ''
}

export function readFailureOrigin(error: ErrorPayload): LegacyReadOrigin {
  return error.detail?.['origin'] === 'remote' ? 'remote' : 'local'
}

/**
 * 🔴 「这一条失败**绝不**能折算成 0 条记录吗？」
 *
 * 只有一种例外：`not-found` / `store-missing` **且**旧库清单显式声明该 store
 * 从未被创建（`created: false`）。那是「证据说它不在」，不是「我们没读到」。
 * 其余形态恒返回 `true`。
 */
export function mustRefuseReadFailure(
  kind: LegacyReadFailureKind,
  declarationSaysNeverCreated: boolean,
): boolean {
  if (declarationSaysNeverCreated && (kind === 'not-found' || kind === 'store-missing')) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 抛出版本（只读输入层的实际用法）
// ---------------------------------------------------------------------------

/**
 * 只读输入层抛出的读取失败。
 *
 * 🔴 为什么要有这个类，而不是让读取方直接 `return err(...)`：
 *    IndexedDB 的 `onsuccess/onerror`、`fs.readFile` 的 callback、`JSON.parse` 都是**抛**语义，
 *    把每一次底层失败都手工翻译成 `Result` 会让「漏翻译一处 = 静默吞掉一条失败 = 当空」
 *    变成一个随时会再犯的错误。这里让**抛**成为唯一出口，由
 *    {@link classifyThrown} 在边界处一次性转成契约 `Err`——
 *    边界只有一个，漏翻译就不可能发生。
 */
export class LegacyReadError extends Error {
  readonly kind: LegacyReadFailureKind
  readonly location: string
  readonly origin: LegacyReadOrigin
  readonly causeText: string | null

  constructor(init: LegacyReadFailureInit) {
    super(init.message)
    this.name = 'LegacyReadError'
    this.kind = init.kind
    this.location = init.location
    this.origin = init.origin ?? 'local'
    this.causeText = init.cause ?? null
  }
}

/**
 * 把任意抛出物转成契约 `Err`。
 *
 * ⚠️ **默认不是 `unknown`，而是按 `origin` 保守取值**：一个既不是
 *    `LegacyReadError` 也不是可识别 `ContractError` 的抛出物，说明「我们不知道发生了什么」，
 *    在只读导入里「不知道」必须等价于「读不出来」（`R-11`：`probeLegacy()` 的 `error`
 *    不许被读成「没有旧数据」）。因此这里返回 `STORAGE_UNAVAILABLE` / `NETWORK_UNAVAILABLE`，
 *    **绝不返回 `ok([])`**。
 */
export function classifyThrown(
  thrown: unknown,
  fallback: { readonly location: string; readonly origin?: LegacyReadOrigin; readonly requestId: RequestId },
): Err {
  const origin: LegacyReadOrigin = fallback.origin ?? 'local'
  if (thrown instanceof LegacyReadError) {
    return legacyReadFailure(
      {
        kind: thrown.kind,
        message: thrown.message,
        location: thrown.location,
        ...(thrown.origin === 'local' ? {} : { origin: thrown.origin }),
        ...(thrown.causeText === null ? {} : { cause: thrown.causeText }),
      },
      fallback.requestId,
    )
  }
  const causeText = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
  return legacyReadFailure(
    {
      kind: 'unknown',
      message: `读取旧数据时发生未预期的失败：${causeText}`,
      location: fallback.location,
      ...(origin === 'local' ? {} : { origin }),
      cause: causeText,
    },
    fallback.requestId,
  )
}

/** 抛一个 {@link LegacyReadError}。 */
export function throwReadFailure(init: LegacyReadFailureInit): never {
  throw new LegacyReadError(init)
}

/**
 * 解析 JSON 文本，失败即抛（**不返回 `null`、不返回 `{}`**）。
 *
 * 这是 `desktop.ts:459-462` 那条规则的最小实现：`JSON.parse` 失败必须变成
 * `lock`（= 本包的 `refused` / `decode-failed`），而不是「空库」。
 */
export function parseJsonStrict(text: string, location: string): unknown {
  if (typeof text !== 'string' || text.trim() === '') {
    throwReadFailure({
      kind: 'decode-failed',
      message: `旧数据文件内容为空，无法解析（位置：${location}）。这不等于「没有数据」。`,
      location,
    })
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throwReadFailure({
      kind: 'decode-failed',
      message: `旧数据文件不是合法 JSON，解析失败（位置：${location}）。这不等于「没有数据」。`,
      location,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
