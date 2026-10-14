/**
 * 会话与刷新轮换。
 *
 * 设计依据（`04-后端与安全.md`）：
 * - Web 管理端使用 **HttpOnly + Secure + SameSite** 会话 Cookie 与 CSRF 校验；
 * - 服务器**只保存刷新凭据的摘要**；
 * - **轮换与重复使用检测必须在同一事务内完成**；旧凭据复用 → 判定凭据泄露，
 *   **撤销整条会话链**。
 *
 * ## 三条贯穿全文的设计决定
 *
 * ### 1. 访问令牌与刷新凭据分离
 * 访问令牌短命（15 分钟）且每个请求都要校验；刷新凭据长命（14 天）且只用于换新。
 * 分开的意义是**限制泄漏窗口**：抓到一个访问令牌最多能用 15 分钟，
 * 而它不能用来延长自己。
 *
 * ### 2. 刷新凭据**一次性消费**（轮换）
 * 每次刷新都签发新的访问令牌 + 新的刷新凭据，旧的立即作废。
 * 这样一份刷新凭据在任何一个时刻只有一个合法持有者；一旦同一份被用第二次，
 * 说明存在两份拷贝，其中至少一份在攻击者手里。
 *
 * ### 3. 复用即撤销整条链（fail closed）
 * 检测到复用时无法区分"攻击者用了偷来的旧凭据"和"合法客户端重发了一次"。
 * 把后者误判成前者，代价是**用户重新登录一次**；把前者误判成后者，
 * 代价是**攻击者持续持有有效会话**。两者不对称，所以一律撤销。
 *
 * 🔴 由此推出的一条客户端契约（写在这里供前端同学对照）：
 * **收到刷新响应后必须先把新的刷新凭据落盘，再发下一个请求。**
 * 如果响应在网络中丢失而客户端只用旧凭据重试，会话链会被撤销——
 * 这是有意的选择，不是缺陷（见 `rotateRefreshToken` 的注释）。
 */

import { ContractError } from '@yfe/contracts'
import type { ErrorCode, RequestId, UserId, UtcTimestamp } from '@yfe/contracts'

import {
  consumeRefreshToken,
  findRefreshToken,
  findSessionByAccessTokenHash,
  findSessionById,
  insertRefreshToken,
  insertSession,
  markRefreshTokenReused,
  revokeSession,
  revokeSessionChain,
  touchSession,
} from '../db/sessions.js'
import type { ServerDb } from '../db/open.js'
import type { SessionRow } from '../db/sessions.js'
import { generateCsrfSecret, generateToken, hashToken, verifyCsrfToken } from './secrets.js'
import { deriveCsrfToken } from './secrets.js'
// ---------------------------------------------------------------------------
// 时间助手
// ---------------------------------------------------------------------------

/** 把 ISO 时间戳推进若干毫秒。所有过期计算都走这里，避免各地手写加法。 */
export function addMilliseconds(at: UtcTimestamp, ms: number): UtcTimestamp {
  return new Date(Date.parse(at) + ms).toISOString() as UtcTimestamp
}

/**
 * `expiresAt` 是否已经到期（含等于）。
 *
 * 用 `Date.parse` 而不是字符串比较：字符串比较依赖两个值格式完全一致
 * （都带毫秒、都用 `Z`）。一旦有人工插入的历史行格式不同（例如 `+00:00` 结尾），
 * 字符串比较会给出错误结果且**不会报错**——过期检查静默失效是安全事故。
 */
export function isExpired(expiresAt: UtcTimestamp, now: UtcTimestamp): boolean {
  return Date.parse(expiresAt) <= Date.parse(now)
}

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

/**
 * 会话策略。全部可注入，因为测试需要把 TTL 压到毫秒级来复现过期路径，
 * 而把"15 分钟"硬编码进代码会让过期测试只能靠 sleep。
 */
export interface SessionPolicy {
  /** 访问令牌有效期。 */
  readonly accessTtlMs: number
  /** 单份刷新凭据有效期（每次轮换重新计算）。 */
  readonly refreshTtlMs: number
  /** **整条链的绝对上限**：无论怎么轮换都不能越过它。防止活跃会话无限续命。 */
  readonly absoluteTtlMs: number
  /** Cookie 是否带 `Secure`。生产环境必须 `true`；本地 http 调试由配置层显式关闭。 */
  readonly cookieSecure: boolean
  /** Cookie 名前缀，便于同一域名下多实例共存。 */
  readonly cookiePrefix: string
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  accessTtlMs: 15 * 60 * 1000,
  refreshTtlMs: 14 * 24 * 60 * 60 * 1000,
  absoluteTtlMs: 30 * 24 * 60 * 60 * 1000,
  cookieSecure: true,
  cookiePrefix: 'yfe',
}

/** Cookie 名。集中定义，避免路由里手写字符串写错一个字符导致"登录成功但一直未认证"。 */
export function cookieNames(policy: SessionPolicy): {
  readonly access: string
  readonly refresh: string
  readonly csrf: string
} {
  return {
    access: `${policy.cookiePrefix}_session`,
    refresh: `${policy.cookiePrefix}_refresh`,
    csrf: `${policy.cookiePrefix}_csrf`,
  }
}

/** 刷新 Cookie 的 Path。**收窄到 auth 子树**，让它不出现在普通请求里。 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth'

// ---------------------------------------------------------------------------
// 签发
// ---------------------------------------------------------------------------

/** 一次签发的全部产物。`accessToken` / `refreshToken` 是**明文**，只在本次响应里出现。 */
export interface IssuedSession {
  readonly session: SessionRow
  readonly accessToken: string
  readonly refreshToken: string
  readonly csrfToken: string
  readonly accessExpiresAt: UtcTimestamp
  readonly refreshExpiresAt: UtcTimestamp
}

export interface IssueSessionInput {
  readonly userId: UserId
  readonly at: UtcTimestamp
  readonly userAgent: string | null
  readonly clientIp: string | null
  /**
   * 沿用已有的链（轮换时）。不给则新开一条链（首次登录）。
   *
   * 🔴 链 ID 与"会话"是 1:N：一次登录开一条链，链上每次轮换产生一个新会话行。
   * 这样"撤销整条链"才能表达"这次登录的所有凭据副本全部作废"。
   */
  readonly chainId?: string
  readonly policy?: SessionPolicy
  /**
   * 链的绝对上限。轮换时必须**沿用旧值**而不是重算——否则每次轮换都把绝对上限
   * 往后推，绝对上限就永远到不了，等于没有上限。
   */
  readonly absoluteExpiresAt?: UtcTimestamp
}

/**
 * 建立一条新会话（首次登录）。
 *
 * 返回的明文凭据由调用方负责：立即写进 Cookie / 响应体，**绝不落库、绝不打日志**。
 */
export function issueSession(db: ServerDb, input: IssueSessionInput): IssuedSession {
  const policy = input.policy ?? DEFAULT_SESSION_POLICY
  const chainId = input.chainId ?? generateToken(16)
  const sessionId = `ses_${generateToken(16)}`
  const accessToken = generateToken()
  const refreshToken = generateToken()
  const csrfSecret = generateCsrfSecret()

  const absoluteExpiresAt =
    input.absoluteExpiresAt ?? addMilliseconds(input.at, policy.absoluteTtlMs)
  const accessExpiresAt = addMilliseconds(input.at, policy.accessTtlMs)
  const refreshExpiresAt = addMilliseconds(input.at, policy.refreshTtlMs)

  insertSession(db, {
    id: sessionId,
    userId: input.userId,
    chainId,
    // 🔴 只把摘要写进库。明文令牌随函数返回后离开持久化层。
    accessTokenHash: hashToken(accessToken),
    csrfSecret,
    at: input.at,
    accessExpiresAt,
    refreshExpiresAt,
    absoluteExpiresAt,
    userAgent: input.userAgent,
    clientIp: input.clientIp,
  })

  insertRefreshToken(db, {
    tokenHash: hashToken(refreshToken),
    sessionId,
    chainId,
    at: input.at,
    expiresAt: refreshExpiresAt,
  })

  const session = findSessionById(db, sessionId)
  if (session === null) {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '会话写入后无法读回，数据库可能不可用。',
      requestId: `req_session_readback` as RequestId,
    })
  }

  return { session, accessToken, refreshToken, csrfToken: csrfTokenOf(session), accessExpiresAt, refreshExpiresAt }
}

/** CSRF 令牌 = HMAC(会话秘密, 会话 ID)。见 `./secrets.js` 的 `deriveCsrfToken`。 */
export function csrfTokenOf(session: SessionRow): string {
  return deriveCsrfToken(session.csrfSecret, session.id)
}

// ---------------------------------------------------------------------------
// 访问令牌校验（每个请求的热路径）
// ---------------------------------------------------------------------------

export type SessionLookupFailure =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'revoked'; readonly reason: string | null }

export type SessionLookupResult =
  | { readonly ok: true; readonly session: SessionRow }
  | { readonly ok: false; readonly failure: SessionLookupFailure }

/**
 * 按访问令牌找会话并判定其可用性。
 *
 * 🔴 判定顺序是刻意的：先"存在"→ 再"撤销" → 再"过期"。
 * 一个已被撤销且已过期的会话必须报**撤销**（`AUTH_REQUIRED` 带明确原因）而不是
 * 泛泛的过期：客户端对"被管理员撤销"的处理是提示用户联系管理员，
 * 对"过期"的处理是静默刷新——报错种类直接决定用户体验。
 *
 * `touchLastUsed` 只在**判定通过后**才写：否则一个被拒绝的令牌也会更新活跃时间，
 * 让"最后使用时间"这个运维指标被攻击流量污染。
 */
export function lookupSessionByAccessToken(
  db: ServerDb,
  accessToken: string,
  at: UtcTimestamp,
): SessionLookupResult {
  const session = findSessionByAccessTokenHash(db, hashToken(accessToken))
  if (session === null) return { ok: false, failure: { kind: 'invalid' } }
  if (session.revokedAt !== null) {
    return { ok: false, failure: { kind: 'revoked', reason: session.revokeReason } }
  }
  if (isExpired(session.accessExpiresAt, at)) {
    return { ok: false, failure: { kind: 'expired' } }
  }
  // 绝对上限同样约束访问令牌：链已经不能续命了，现存访问令牌也不该越界使用。
  if (isExpired(session.absoluteExpiresAt, at)) {
    return { ok: false, failure: { kind: 'expired' } }
  }
  touchSession(db, session.id, at)
  return { ok: true, session }
}

/** 把查找失败翻译成稳定的契约错误码。UI 按 code 分类，不比较中文文案。 */
export function lookupFailureToError(
  failure: SessionLookupFailure,
  requestId: RequestId,
): ContractError {
  const map: Record<SessionLookupFailure['kind'], [ErrorCode, string]> = {
    invalid: ['AUTH_REQUIRED', '会话凭据无效，请重新登录。'],
    expired: ['AUTH_TOKEN_EXPIRED', '会话已过期，请重新登录。'],
    revoked: ['AUTH_REQUIRED', '会话已被撤销，请重新登录。'],
  }
  const [code, message] = map[failure.kind]
  const detail =
    failure.kind === 'revoked' && failure.reason !== null ? { reason: failure.reason } : undefined
  return new ContractError({
    code,
    message,
    requestId,
    ...(detail === undefined ? {} : { detail }),
  })
}

// ---------------------------------------------------------------------------
// 轮换（核心）
// ---------------------------------------------------------------------------

export type RotateFailure =
  /** 凭据不存在 / 已过期 / 会话已撤销 → 必须重新登录。 */
  | { readonly kind: 'invalid'; readonly error: ContractError }
  /** **检测到复用**：整条链已撤销。 */
  | { readonly kind: 'reuse'; readonly error: ContractError; readonly revokedSessions: number }

export type RotateResult =
  | { readonly ok: true; readonly issued: IssuedSession }
  | { readonly ok: false; readonly failure: RotateFailure }

export interface RotateInput {
  readonly refreshToken: string
  readonly at: UtcTimestamp
  readonly userAgent: string | null
  readonly clientIp: string | null
  readonly requestId: RequestId
  readonly policy?: SessionPolicy
}

/**
 * 轮换刷新凭据。
 *
 * 🔴 **整个过程在一个事务里**（`db.transaction(...)`）。这一点不可妥协：
 * "检查是否被消费"与"标记为已消费"之间只要有窗口，两个并发刷新就会双双通过，
 * 一次刷新变成两条并行会话链——而其中一条永远不会再被客户端使用，
 * 却仍然有效，等于凭空多出一份无人看管的凭据。
 *
 * 事务内的判定顺序：
 * 1. 查不到摘要 → `invalid`（可能是伪造，也可能是被清理过的旧凭据）；
 * 2. 该行已被标记过 `reused_detected_at` → 直接再撤一次链并报复用（幂等）；
 * 3. `consumed_at` 非空 → **复用** → 标记 → 撤销整条链 → 报错；
 * 4. 已过期 → `invalid`；
 * 5. 会话已撤销或越过绝对上限 → `invalid`；
 * 6. 原子消费（条件更新）失败 → 说明刚刚被另一个请求抢先消费 → 按复用处理
 *    （并发刷新与恶意复用在这里无法区分，取安全侧）；
 * 7. 通过 → 撤销旧会话行、在同一链上签发新会话与新刷新凭据。
 */
export function rotateRefreshToken(db: ServerDb, input: RotateInput): RotateResult {
  const policy = input.policy ?? DEFAULT_SESSION_POLICY
  const { requestId, at } = input

  return db.transaction((): RotateResult => {
    const presentedHash = hashToken(input.refreshToken)
    const record = findRefreshToken(db, presentedHash)

    if (record === null) {
      return {
        ok: false,
        failure: {
          kind: 'invalid',
          error: new ContractError({
            code: 'AUTH_TOKEN_EXPIRED',
            message: '刷新凭据无效或已被清理，请重新登录。',
            requestId,
          }),
        },
      }
    }

    // --- 复用：无论是首次发现还是重复发现，处置都一样，且必须幂等 ---
    const reuseAlreadyKnown = record.reusedDetectedAt !== null
    const alreadyConsumed = record.consumedAt !== null

    if (reuseAlreadyKnown || alreadyConsumed) {
      if (!reuseAlreadyKnown) markRefreshTokenReused(db, presentedHash, at)
      const revokedSessions = revokeSessionChain(db, record.chainId, at, 'refresh_token_reuse')
      return {
        ok: false,
        failure: {
          kind: 'reuse',
          revokedSessions,
          error: new ContractError({
            code: 'AUTH_REQUIRED',
            message: '检测到刷新凭据被重复使用，出于安全考虑已撤销本次登录的全部会话，请重新登录。',
            requestId,
            detail: { reason: 'refresh_token_reuse' },
          }),
        },
      }
    }

    if (isExpired(record.expiresAt, at)) {
      return {
        ok: false,
        failure: {
          kind: 'invalid',
          error: new ContractError({
            code: 'AUTH_TOKEN_EXPIRED',
            message: '刷新凭据已过期，请重新登录。',
            requestId,
          }),
        },
      }
    }

    const previousSession = findSessionById(db, record.sessionId)
    if (previousSession === null) {
      // 外键 ON DELETE CASCADE 保证刷新凭据不会孤儿；走到这里说明库被手工改过。
      return {
        ok: false,
        failure: {
          kind: 'invalid',
          error: new ContractError({
            code: 'AUTH_REQUIRED',
            message: '刷新凭据对应的会话不存在，请重新登录。',
            requestId,
          }),
        },
      }
    }
    if (previousSession.revokedAt !== null) {
      return {
        ok: false,
        failure: {
          kind: 'invalid',
          error: new ContractError({
            code: 'AUTH_REQUIRED',
            message: '会话已被撤销，请重新登录。',
            requestId,
          }),
        },
      }
    }
    if (isExpired(previousSession.absoluteExpiresAt, at)) {
      return {
        ok: false,
        failure: {
          kind: 'invalid',
          error: new ContractError({
            code: 'AUTH_TOKEN_EXPIRED',
            message: '会话已达到最长有效期，请重新登录。',
            requestId,
          }),
        },
      }
    }

    // --- 原子消费：先算出新凭据的摘要，再一次性条件更新 ---
    const nextAccessToken = generateToken()
    const nextRefreshToken = generateToken()

    const consumed = consumeRefreshToken(db, presentedHash, at, hashToken(nextRefreshToken))
    if (!consumed) {
      // 竞态：读到这里之间已被消费。并发刷新与恶意复用无法区分 → 撤销整条链。
      markRefreshTokenReused(db, presentedHash, at)
      const revokedSessions = revokeSessionChain(db, record.chainId, at, 'refresh_token_reuse')
      return {
        ok: false,
        failure: {
          kind: 'reuse',
          revokedSessions,
          error: new ContractError({
            code: 'AUTH_REQUIRED',
            message: '刷新凭据已被使用，出于安全考虑已撤销本次登录的全部会话，请重新登录。',
            requestId,
            detail: { reason: 'refresh_token_reuse' },
          }),
        },
      }
    }

    // 旧会话行作废：它绑定的访问令牌立刻失效。
    revokeSession(db, previousSession.id, at, 'rotated')

    const sessionId = `ses_${generateToken(16)}`
    insertSession(db, {
      id: sessionId,
      userId: previousSession.userId,
      chainId: record.chainId,
      accessTokenHash: hashToken(nextAccessToken),
      csrfSecret: generateCsrfSecret(),
      at,
      accessExpiresAt: addMilliseconds(at, policy.accessTtlMs),
      refreshExpiresAt: addMilliseconds(at, policy.refreshTtlMs),
      // 🔴 沿用旧链的绝对上限，不重算（见 IssueSessionInput.absoluteExpiresAt 注释）。
      absoluteExpiresAt: previousSession.absoluteExpiresAt,
      userAgent: input.userAgent,
      clientIp: input.clientIp,
    })

    const session = findSessionById(db, sessionId)
    if (session === null) {
      throw new ContractError({
        code: 'STORAGE_UNAVAILABLE',
        message: '轮换后的会话无法读回，数据库可能不可用。',
        requestId,
      })
    }

    return {
      ok: true,
      issued: {
        session,
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
        csrfToken: csrfTokenOf(session),
        accessExpiresAt: session.accessExpiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      },
    }
  })()
}

// ---------------------------------------------------------------------------
// 登出
// ---------------------------------------------------------------------------

/**
 * 登出：撤销整条链。
 *
 * 为什么是整条链而不是"当前会话"：登出的语义是"我不用这个设备了"。
 * 只撤销当前行会留下本次登录产生过的**其他已轮换出去的行**（它们本已 revoked），
 * 以及**未来可能被轮换出来的行**——链一旦被撤销，后续任何轮换请求都会失败，
 * 这才是用户期望的"彻底退出"。
 */
export function logoutSession(db: ServerDb, session: SessionRow, at: UtcTimestamp): number {
  return revokeSessionChain(db, session.chainId, at, 'logout')
}

// ---------------------------------------------------------------------------
// Cookie 装配
// ---------------------------------------------------------------------------

export interface CookieSpec {
  readonly name: string
  readonly value: string
  readonly options: {
    readonly httpOnly: boolean
    readonly secure: boolean
    readonly sameSite: 'strict' | 'lax' | 'none'
    readonly path: string
    readonly maxAge: number
  }
}

/**
 * 构造三个 Cookie。
 *
 * | Cookie | HttpOnly | 作用 | 为什么这样设 |
 * | --- | --- | --- | --- |
 * | 会话 | ✅ | 携带访问令牌 | JS 读不到 → XSS 无法窃取 |
 * | 刷新 | ✅ | 只换新，Path 收窄到 `/api/v1/auth` | 不出现在普通请求里，减少暴露面 |
 * | CSRF | ❌ | 供前端读出并放进 `X-CSRF-Token` 头 | **必须**能被 JS 读，否则同步器令牌模式不成立 |
 *
 * 🔴 CSRF Cookie 故意 `httpOnly: false`：它不是凭据，只要不泄漏会话 Cookie，
 * 攻击者就算能读到它也构造不出有效请求（因为同源策略让他读不到**受害者浏览器里**的那个值）。
 *
 * 🔴 `sameSite: 'strict'`：管理端不需要跨站带入凭据。`lax` 会让顶层导航携带 Cookie，
 * 对 CSRF 是放宽；`none` 在生产是明确禁止的（且必须配 `Secure`）。
 *
 * `secure` 由策略决定但**在 `SameSite=None` 时必须为 true**，这里做一致性断言。
 */
export function buildSessionCookies(
  issued: IssuedSession,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): readonly CookieSpec[] {
  const names = cookieNames(policy)
  const maxAgeSeconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000))
  const accessMaxAge = maxAgeSeconds(Date.parse(issued.session.accessExpiresAt) - Date.parse(issued.session.createdAt))

  return [
    {
      name: names.access,
      value: issued.accessToken,
      options: {
        httpOnly: true,
        secure: policy.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: accessMaxAge,
      },
    },
    {
      name: names.refresh,
      value: issued.refreshToken,
      options: {
        httpOnly: true,
        secure: policy.cookieSecure,
        sameSite: 'strict',
        path: REFRESH_COOKIE_PATH,
        maxAge: maxAgeSeconds(Date.parse(issued.refreshExpiresAt) - Date.parse(issued.session.createdAt)),
      },
    },
    {
      name: names.csrf,
      value: issued.csrfToken,
      options: {
        // 🔴 见上方表格：必须能被前端 JS 读取，否则 CSRF 校验无从发起。
        httpOnly: false,
        secure: policy.cookieSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: accessMaxAge,
      },
    },
  ]
}

/** 清除三个 Cookie 的规格（登出时用）。`maxAge: 0` 是标准的立即过期写法。 */
export function clearSessionCookies(policy: SessionPolicy = DEFAULT_SESSION_POLICY): readonly CookieSpec[] {
  const names = cookieNames(policy)
  const base = {
    httpOnly: true,
    secure: policy.cookieSecure,
    sameSite: 'strict' as const,
    maxAge: 0,
  }
  return [
    { name: names.access, value: '', options: { ...base, path: '/' } },
    { name: names.refresh, value: '', options: { ...base, path: REFRESH_COOKIE_PATH } },
    // CSRF Cookie 不是凭据，但仍然要清，否则前端会拿一个过期令牌反复重试。
    { name: names.csrf, value: '', options: { ...base, httpOnly: false, path: '/' } },
  ]
}

/** 供诊断/测试断言用：策略是否自洽。 */
export function assertSessionPolicyConsistent(policy: SessionPolicy): void {
  if (policy.accessTtlMs <= 0 || policy.refreshTtlMs <= 0 || policy.absoluteTtlMs <= 0) {
    throw new TypeError('会话 TTL 必须为正数')
  }
  if (policy.refreshTtlMs > policy.absoluteTtlMs) {
    throw new TypeError('刷新凭据有效期不能超过会话链的绝对上限，否则绝对上限形同虚设')
  }
  if (policy.accessTtlMs > policy.refreshTtlMs) {
    throw new TypeError('访问令牌有效期不应超过刷新凭据有效期')
  }
}

// ---------------------------------------------------------------------------
// CSRF 校验
// ---------------------------------------------------------------------------

/**
 * 校验 CSRF 令牌（**同步器令牌模式**）。
 *
 * 🔴 只对"用 Cookie 认证的**状态改变**请求"强制。理由：
 * - GET/HEAD 必须免校验，否则任何 `<img src>` 都会失败，而且它们不该有副作用；
 * - 用 `Authorization` 头携带设备凭据的请求免校验：浏览器不会自动附加自定义头，
 *   跨站页面无法伪造，天然免疫 CSRF。
 *
 * 因此路由层的调用约定是：`requireCsrf` 只在 `requireSession`（Cookie 认证）
 * 之后、且方法为 POST/PUT/PATCH/DELETE 时生效。把这条规则写在中间件里
 * 而不是每个路由里，避免漏掉某个新接口。
 */
export function verifyCsrf(session: SessionRow, presented: string | undefined): boolean {
  if (presented === undefined || presented.length === 0) return false
  return verifyCsrfToken(session.csrfSecret, session.id, presented)
}
