/**
 * 身份路由：`/api/v1/auth/login`、`/auth/refresh`、`/auth/logout`、`/api/v1/users/me`。
 *
 * 设计依据（`04-后端与安全.md` / `07-同步协议与API.md`）：
 * "Web 端 HttpOnly+Secure+SameSite Cookie + CSRF；服务器只存刷新凭据摘要，
 *  轮换与复用检测在事务中完成"；`POST /api/v1/auth/login`（**限流**，Web Cookie
 *  或设备流程）、`POST /api/v1/auth/refresh`、`/auth/logout`（轮换、撤销与 Web CSRF）。
 *
 * ## 三个刻意的传输层决定
 *
 * 1. **登录响应体里没有令牌。** 令牌只走 Cookie（HttpOnly），JS 读不到。
 *    非浏览器客户端走设备流程（`/api/v1/devices/pair` → Bearer），
 *    那是 P3-A3 的范围。把访问令牌塞进响应体会让 XSS 立刻升级成"令牌被偷"，
 *    而 HttpOnly 的全部意义就是不给 JS 这条路径。
 * 2. **刷新不需要 CSRF 头，登出需要。** 理由是 Cookie 的生命周期：
 *    CSRF Cookie 的 maxAge 与访问令牌同寿（15 分钟），而刷新凭据活 14 天。
 *    如果刷新也要求 CSRF，用户在 15 分钟后刷新必定失败、只能重新登录，
 *    等于把"14 天免登录"变成"15 分钟"。刷新自身的防护是
 *    `SameSite=Strict` + 高熵不可猜 + **轮换与复用检测**（旧凭据一旦被重复使用，
 *    整条会话链在同一事务内撤销）——这正是 `rotateRefreshToken` 的语义。
 * 3. **登出总是清 Cookie 并返回 204**，即使凭据已经失效。登出必须幂等：
 *    客户端"点了退出但服务端说 401"只会让它留在半登录状态。
 *    ⚠️ 正因为它幂等、且不复用 `guards.requireSession`，**CSRF 必须在这个
 *    处理器里自己判**（见下方 logout 处的注释与 `tests/cookies.test.ts`
 *    的「登出的 CSRF 防护」）：会话有效却不校验 CSRF，第三方页面就能把
 *    已登录用户静默登出，而状态码仍是 204，只有专门写断言才看得见。
 * 4. **登录没有预会话凭据，因此不做 CSRF。** 登录本身不携带任何既有凭据，
 *    攻击者能造成的最大后果是"把受害者登进攻击者的账号"（login CSRF）；
 *    首版用 `SameSite=Strict` + 登录限流兜住，若将来要补，需要一个
 *    预认证的 CSRF 端点，属 P3-A2 范围（台账风险 R-25）。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UtcTimestamp } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { validatePassword, validateUsername } from '../auth/credentialPolicy.js'
import { burnPasswordCheck, verifyPassword } from '../auth/password.js'
import {
  buildSessionCookies,
  clearSessionCookies,
  cookieNames,
  issueSession,
  logoutSession,
  lookupFailureToError,
  lookupSessionByAccessToken,
  rotateRefreshToken,
  verifyCsrf,
} from '../auth/session.js'
import type { CookieSpec, SessionPolicy } from '../auth/session.js'
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/audit.js'
import { listMemberships } from '../db/members.js'
import { findUserById, findUserWithCredentialByUsername } from '../db/users.js'
import type { ServerDb } from '../db/open.js'
import { createRateLimiter, rateLimitedError } from '../http/rateLimit.js'
import type { RateLimiter } from '../http/rateLimit.js'
import { currentAuth } from '../permission/index.js'
import type { PermissionGuards } from '../permission/index.js'

export interface AuthRouteDeps {
  readonly db: ServerDb
  readonly policy: SessionPolicy
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
  readonly loginRateLimiter?: RateLimiter
}

/** 登录限流：按来源 IP。比 setup 更宽松（正常用户会打错密码），但足以挡住在线爆破。 */
export const DEFAULT_LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAttempts: 20 } as const

const LOGIN_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

interface LoginBody {
  readonly username: string
  readonly password: string
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const log = deps.log ?? (() => {})
  const limiter = deps.loginRateLimiter ?? createRateLimiter(DEFAULT_LOGIN_RATE_LIMIT)
  const names = cookieNames(deps.policy)

  const applyCookies = (reply: FastifyReply, specs: readonly CookieSpec[]): void => {
    for (const spec of specs) {
      reply.setCookie(spec.name, spec.value, spec.options)
    }
  }

  const clearAuthCookies = (reply: FastifyReply): void => {
    for (const spec of clearSessionCookies(deps.policy)) {
      reply.clearCookie(spec.name, { path: spec.options.path })
    }
  }

  // ---------------------------------------------------------------- login
  app.post(
    '/api/v1/auth/login',
    { schema: { body: LOGIN_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const at = deps.now()
      const clientIp = request.ip ?? null
      const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null
      const body = request.body as LoginBody

      const verdict = limiter.hit(`login:${clientIp ?? 'unknown'}`)
      if (!verdict.allowed) {
        log({ level: 'warn', event: 'auth.login.rate_limited', requestId, clientIp })
        throw rateLimitedError(verdict.retryAfterMs, requestId)
      }

      const username = validateUsername(body.username, requestId)
      const password = validatePassword(body.password, requestId)

      const user = findUserWithCredentialByUsername(deps.db, username)
      if (user === null) {
        // 🔴 用户不存在也要消耗一次同等成本的 KDF：否则"不存在"比"密码错"
        // 快一个数量级，攻击者可以用响应时间枚举出哪些用户名真实存在。
        await burnPasswordCheck(password)
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.loginFailed,
          outcome: 'failure',
          at,
          requestId,
          clientIp,
          targetType: 'user',
          targetId: username,
          detail: { reason: 'unknown_user' },
        })
        throw new ContractError({
          code: 'AUTH_INVALID_CREDENTIALS',
          message: '用户名或密码不正确。',
          requestId,
        })
      }

      const passwordOk = await verifyPassword(password, user.passwordHash)
      if (!passwordOk) {
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.loginFailed,
          outcome: 'failure',
          at,
          actorUserId: user.id,
          requestId,
          clientIp,
          detail: { reason: 'bad_password' },
        })
        // 消息与"用户不存在"**逐字相同**：不能从响应体区分两种失败。
        throw new ContractError({
          code: 'AUTH_INVALID_CREDENTIALS',
          message: '用户名或密码不正确。',
          requestId,
        })
      }
      if (user.disabled) {
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.loginFailed,
          outcome: 'denied',
          at,
          actorUserId: user.id,
          requestId,
          clientIp,
          detail: { reason: 'disabled' },
        })
        throw new ContractError({ code: 'AUTH_REQUIRED', message: '账号已被停用。', requestId })
      }

      const issued = issueSession(deps.db, { userId: user.id, at, userAgent, clientIp, policy: deps.policy })
      applyCookies(reply, buildSessionCookies(issued, deps.policy))
      limiter.reset(`login:${clientIp ?? 'unknown'}`)
      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.loginSucceeded,
        outcome: 'success',
        at,
        actorUserId: user.id,
        requestId,
        clientIp,
        detail: { sessionId: issued.session.id },
      })

      return reply.status(200).header('cache-control', 'no-store').send({
        user: { id: user.id, username: user.username, displayName: user.displayName },
        session: {
          accessExpiresAt: issued.accessExpiresAt,
          refreshExpiresAt: issued.refreshExpiresAt,
          absoluteExpiresAt: issued.session.absoluteExpiresAt,
        },
      })
    },
  )

  // -------------------------------------------------------------- refresh
  app.post('/api/v1/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id as RequestId
    const at = deps.now()
    const clientIp = request.ip ?? null
    const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null
    const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies
    const refreshToken = cookies?.[names.refresh]

    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      throw new ContractError({
        code: 'AUTH_REQUIRED',
        message: '缺少刷新凭据，请重新登录。',
        requestId,
      })
    }

    const result = rotateRefreshToken(deps.db, { refreshToken, at, userAgent, clientIp, requestId, policy: deps.policy })
    if (!result.ok) {
      // 失败一律清 Cookie：无论是"凭据坏了"还是"检测到复用、整条链已被撤销"，
      // 继续让浏览器带着它只会造成每次请求都失败。
      clearAuthCookies(reply)
      if (result.failure.kind === 'reuse') {
        log({
          level: 'warn',
          event: 'auth.refresh.reuse_detected',
          requestId,
          clientIp,
          revokedSessions: result.failure.revokedSessions,
        })
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.refreshReuseDetected,
          outcome: 'denied',
          at,
          requestId,
          clientIp,
          detail: { revokedSessions: result.failure.revokedSessions },
        })
      }
      throw result.failure.error
    }

    applyCookies(reply, buildSessionCookies(result.issued, deps.policy))
    recordAuditEvent(deps.db, {
      action: AUDIT_ACTIONS.refreshRotated,
      outcome: 'success',
      at,
      actorUserId: result.issued.session.userId,
      requestId,
      clientIp,
      detail: { sessionId: result.issued.session.id },
    })

    return reply.status(200).header('cache-control', 'no-store').send({
      rotated: true,
      session: {
        accessExpiresAt: result.issued.accessExpiresAt,
        refreshExpiresAt: result.issued.refreshExpiresAt,
        absoluteExpiresAt: result.issued.session.absoluteExpiresAt,
      },
    })
  })

  // --------------------------------------------------------------- logout
  app.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id as RequestId
    const at = deps.now()
    const cookies = (request as { cookies?: Record<string, string | undefined> }).cookies
    const accessToken = cookies?.[names.access]

    // 🔴 登出是**写操作**，而它走的是 Cookie 凭据——所以必须自己过 CSRF。
    //
    // 这里刻意不挂 `guards.requireSession`：登出必须幂等（会话过期/已撤销/
    // 根本没 Cookie 时也要能清掉本地 Cookie），挂上钩子会把"退出"变成 401，
    // 客户端会卡在"看似已退出、实际 Cookie 还在"的半登录状态。
    //
    // 但只有**有效会话**才需要 CSRF：那张会话是真实凭据，一旦被第三方站点
    // 静默撤销就是实打实的越权副作用；反过来，凭据已经无效时清 Cookie 不改
    // 任何服务端状态，不需要 CSRF。
    //
    // 少了这段检查的表现是"最坏的那种"——第三方页面 POST 一下就登出了，
    // 而只看状态码永远是 204，测试和代码审查都发现不了。
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      const lookup = lookupSessionByAccessToken(deps.db, accessToken, at)
      if (lookup.ok) {
        const presented = request.headers['x-csrf-token']
        if (!verifyCsrf(lookup.session, typeof presented === 'string' ? presented : undefined)) {
          throw new ContractError({
            code: 'PERMISSION_DENIED',
            message: 'CSRF 校验未通过，请刷新页面后重试。',
            requestId,
            detail: { reason: 'csrf_token_invalid' },
          })
        }
        const revoked = logoutSession(deps.db, lookup.session, at)
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.logout,
          outcome: 'success',
          at,
          actorUserId: lookup.session.userId,
          requestId,
          clientIp: request.ip ?? null,
          detail: { revokedSessions: revoked },
        })
      } else if (lookup.failure.kind === 'revoked') {
        // 已经撤销过了：不是错误，只是重复登出。不审计（否则会被刷爆）。
      }
    }

    clearAuthCookies(reply)
    return reply.status(204).header('cache-control', 'no-store').send()
  })

  // ------------------------------------------------------------ users/me
  app.get('/api/v1/users/me', { preHandler: deps.guards.requireSession }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = currentAuth(request)
    const user = findUserById(deps.db, auth.principal.userId)
    if (user === null) {
      // 会话有效但用户没了：只有"用户被删"这一种可能，必须当认证失败处理。
      throw lookupFailureToError({ kind: 'invalid' }, auth.requestId)
    }
    const memberships = listMemberships(deps.db, user.id).map((member) => ({
      workspaceId: member.workspaceId,
      role: member.role,
    }))
    return reply.status(200).header('cache-control', 'no-store').send({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      memberships,
      credential: { source: auth.source, sessionId: auth.session?.id ?? null },
    })
  })
}
