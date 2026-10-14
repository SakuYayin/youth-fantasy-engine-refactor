/**
 * 把 `auth/permission.ts` 的能力检查接成 Fastify 钩子。
 *
 * 设计依据（`04-后端与安全.md`）：
 * "角色与资源范围**一起**判定"；"**所有查询、对象下载、游标、任务订阅和写入均重新鉴权**"；
 * "Web 端 HttpOnly+Secure+SameSite Cookie + CSRF"。
 *
 * ## 这个模块存在的唯一理由：把"重新鉴权"变成默认动作
 *
 * 只在入口鉴权一次（中间件读角色塞进 `request.user`）是最常见的写法，也是最常见的
 * 漏洞来源：它把角色**缓存进了请求生命周期**，于是同一请求里后来的每一次查询
 * 都用的是入口那一刻的角色快照；更糟的是 `workspaceId` 来自路径参数，
 * 攻击者只要换一个路径参数就能让"入口鉴权通过"的那个身份去访问别人的工作区。
 *
 * 因此本模块提供两种粒度的入口，且**两者都回表查**：
 *
 * 1. `requireSession()`：只确认"有人登录"，用于不涉及工作区的接口（如 `/users/me`）；
 * 2. `requireWorkspaceAccess({ action })`：在 1 的基础上再判 `workspaceId` + 角色；
 * 3. 处理器内部还可以再调 `authorizeWorkspaceAccess()`
 *    —— 当它拿到的 `workspaceId` 不是来自路径参数（例如从某个 documentId
 *    解引用出来的）时，**必须**再判一次，因为钩子里的那个 workspaceId 与
 *    处理器实际要操作的资源未必是同一个。
 *
 * ## CSRF 为什么放在认证钩子里而不是单独一个钩子
 *
 * 因为"要不要校验 CSRF"取决于**凭据来源**：Cookie 认证的写请求必须带 CSRF 头，
 * Bearer 令牌（设备/CLI）没有"浏览器自动附带"这一性质，不需要也不应该要求它。
 * 判定依据（来源）与判定动作（校验）必须挨在一起，否则拆开后很容易
 * 出现"某个新加的写路由忘了挂 CSRF 钩子"。
 */

import { ContractError, isWellFormedId } from '@yfe/contracts'
import type { RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  assertCanManageMembers,
  assertCanRunRemoteCommand,
  assertCanWrite,
  assertDeviceWithinWorkspace,
  principalFromSession,
  resolveWorkspaceAccess,
} from '../auth/permission.js'
import { cookieNames, lookupFailureToError, lookupSessionByAccessToken, verifyCsrf } from '../auth/session.js'
import type { Principal, WorkspaceAccess } from '../auth/permission.js'
import type { SessionPolicy } from '../auth/session.js'
import type { ServerDb } from '../db/open.js'
import type { SessionRow } from '../db/sessions.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** 认证后的请求上下文。由 `attachRequestContext` 初始化为 `null`。 */
    auth: AuthContext | null
    /** 每个请求固定一次的"现在"，由注入的时钟产生（同一请求内所有判定共用）。 */
    yfeNow: UtcTimestamp
  }
}

/** 凭据来源。决定要不要校验 CSRF、以及审计里怎么描述"谁在操作"。 */
export type CredentialSource = 'cookie' | 'bearer'

export interface AuthContext {
  readonly principal: Principal
  /** Cookie/令牌认证时的会话行；设备凭据路径为 `null`。 */
  readonly session: SessionRow | null
  readonly source: CredentialSource
  readonly requestId: RequestId
  readonly now: UtcTimestamp
  readonly clientIp: string | null
  readonly userAgent: string | null
}

export interface PermissionDeps {
  readonly db: ServerDb
  readonly policy: SessionPolicy
}

/** 资源访问动作。语义与 `auth/permission.ts` 里的 `assertCan*` 一一对应。 */
export type AccessAction = 'read' | 'write' | 'manageMembers' | 'runRemoteCommand'

export interface RequireWorkspaceOptions {
  readonly action: AccessAction
  /**
   * 从哪里取 `workspaceId`。默认按 `params.workspaceId` → `body.workspaceId`
   * → `query.workspaceId` 的顺序找。
   *
   * 🔴 调用方如果知道工作区来自别处（例如 `projectId` 反查），应该显式传
   * 提取函数，让"判定用的 workspaceId"与"实际操作的 workspaceId"是同一个值。
   */
  readonly workspaceIdOf?: (request: FastifyRequest) => unknown
}

/** 从请求中解析 `Authorization: Bearer <token>`。 */
export function bearerTokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  // `request.cookies` 由 @fastify/cookie 注入；未注册时是 undefined，
  // 这里不抛异常而是当作"没有 Cookie"，让上层报 AUTH_REQUIRED。
  const cookies: unknown = (request as { cookies?: unknown }).cookies
  if (cookies === null || typeof cookies !== 'object') return undefined
  const value = (cookies as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isMutatingMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

/**
 * 安装请求上下文装饰器与 `onRequest` 钩子。
 *
 * 🔴 每个请求都要把 `auth` 重置为 `null`：Fastify 的 `decorateRequest`
 * 默认值是**共享引用**层面的初始化，但一旦某个请求把 `auth` 赋值成对象，
 * 后续请求如果忘记重置就可能读到上一个请求的主体（跨请求身份泄漏）。
 * 这里在 `onRequest` 的最前面显式置空，把它变成不可省略的一步。
 */
export function attachRequestContext(app: FastifyInstance, deps: PermissionDeps, clock: { now(): UtcTimestamp }): void {
  app.decorateRequest('auth', null)
  // 占位默认值：真正的时刻在下面的钩子里逐请求写入。
  // 这里必须显式断言成品牌类型——`UtcTimestamp` 是品牌字符串，
  // 空串字面量不是合法的 `UtcTimestamp`（正是想要的那种"不能乱写"）。
  app.decorateRequest('yfeNow', '' as UtcTimestamp)
  app.addHook('onRequest', async (request) => {
    request.auth = null
    request.yfeNow = clock.now()
  })
}

function requireAuthContext(request: FastifyRequest): AuthContext {
  const auth = request.auth
  if (auth === null) {
    throw new ContractError({
      code: 'AUTH_REQUIRED',
      message: '需要登录后才能访问。',
      requestId: request.id as RequestId,
    })
  }
  return auth
}

/** 认证钩子：解析凭据、校验会话、必要时校验 CSRF，并写入 `request.auth`。 */
export function makeRequireSession(deps: PermissionDeps) {
  const names = cookieNames(deps.policy)
  return async function requireSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const requestId = request.id as RequestId
    const now = request.yfeNow

    const bearer = bearerTokenOf(request)
    const cookieToken = readCookie(request, names.access)
    const source: CredentialSource = bearer !== null ? 'bearer' : 'cookie'
    const token = bearer ?? cookieToken ?? null

    if (token === null) {
      throw new ContractError({
        code: 'AUTH_REQUIRED',
        message: '需要登录后才能访问。',
        requestId,
      })
    }

    const result = lookupSessionByAccessToken(deps.db, token, now)
    if (!result.ok) {
      throw lookupFailureToError(result.failure, requestId)
    }

    // 会话有效 → 立刻判定 CSRF（写请求 + Cookie 凭据）。
    if (source === 'cookie' && isMutatingMethod(request.method)) {
      const presented = request.headers['x-csrf-token']
      const csrfToken = typeof presented === 'string' ? presented : undefined
      if (!verifyCsrf(result.session, csrfToken)) {
        // 用一个专属的 detail.reason 让前端能区分"没登录"与"CSRF 过期/缺失"。
        throw new ContractError({
          code: 'PERMISSION_DENIED',
          message: 'CSRF 校验未通过，请刷新页面后重试。',
          requestId,
          detail: { reason: 'csrf_token_invalid' },
        })
      }
    }

    request.auth = {
      principal: principalFromSession(deps.db, result.session, null, requestId),
      session: result.session,
      source,
      requestId,
      now,
      clientIp: request.ip ?? null,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    }
  }
}

/**
 * **每个查询/写入都重新鉴权**的执行点。
 *
 * 钩子调用一次、处理器内部再调用一次是有意的冗余：钩子判的是"请求声明的
 * workspaceId"，处理器判的才是"这次真正要动的资源所属的 workspaceId"。
 */
export function authorizeWorkspaceAccess(
  deps: PermissionDeps,
  request: FastifyRequest,
  workspaceId: WorkspaceId,
  action: AccessAction,
): WorkspaceAccess {
  const auth = requireAuthContext(request)
  assertDeviceWithinWorkspace(auth.principal, workspaceId, auth.requestId)
  const access = resolveWorkspaceAccess(deps.db, auth.principal, workspaceId, auth.requestId)
  switch (action) {
    case 'read':
      break
    case 'write':
      assertCanWrite(access, auth.requestId)
      break
    case 'manageMembers':
      assertCanManageMembers(access, auth.requestId)
      break
    case 'runRemoteCommand':
      assertCanRunRemoteCommand(access, auth.requestId)
      break
  }
  return access
}

function defaultWorkspaceIdOf(request: FastifyRequest): unknown {
  const params: unknown = request.params
  if (params !== null && typeof params === 'object') {
    const value = (params as Record<string, unknown>)['workspaceId']
    if (value !== undefined) return value
  }
  const body: unknown = request.body
  if (body !== null && typeof body === 'object') {
    const value = (body as Record<string, unknown>)['workspaceId']
    if (value !== undefined) return value
  }
  const query: unknown = request.query
  if (query !== null && typeof query === 'object') {
    const value = (query as Record<string, unknown>)['workspaceId']
    if (value !== undefined) return value
  }
  return undefined
}

function coerceWorkspaceId(raw: unknown, requestId: RequestId): WorkspaceId {
  if (typeof raw !== 'string' || !isWellFormedId(raw)) {
    throw new ContractError({
      code: 'VALIDATION_MALFORMED_ID',
      message: '工作区标识不合法。',
      requestId,
      detail: { field: 'workspaceId' },
    })
  }
  return raw as WorkspaceId
}

/**
 * 工作区鉴权钩子：认证 + 解析 workspaceId + 能力判定。
 *
 * 🔴 判定用的 `workspaceId` **只从请求里取，绝不从会话或设备上"推断"**：
 * 会话不绑定工作区（一个用户可以属于多个），设备凭据才绑定，
 * 而设备那条边界由 `assertDeviceWithinWorkspace` 单独把关。
 */
export function makeRequireWorkspaceAccess(deps: PermissionDeps) {
  const requireSession = makeRequireSession(deps)
  return function requireWorkspaceAccess(options: RequireWorkspaceOptions) {
    const extract = options.workspaceIdOf ?? defaultWorkspaceIdOf
    return async function workspaceAccessGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      await requireSession(request, reply)
      const requestId = request.id as RequestId
      const workspaceId = coerceWorkspaceId(extract(request), requestId)
      authorizeWorkspaceAccess(deps, request, workspaceId, options.action)
    }
  }
}

/** 供处理器内部使用：取当前主体，未认证即抛 401。 */
export function currentPrincipal(request: FastifyRequest): Principal {
  return requireAuthContext(request).principal
}

/** 供处理器内部使用：取当前认证上下文。 */
export function currentAuth(request: FastifyRequest): AuthContext {
  return requireAuthContext(request)
}

/** 创建一套钩子（避免调用方自己反复 bind 依赖）。 */
export interface PermissionGuards {
  readonly requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  readonly requireWorkspaceAccess: (
    options: RequireWorkspaceOptions,
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
}

export function createPermissionGuards(deps: PermissionDeps): PermissionGuards {
  return {
    requireSession: makeRequireSession(deps),
    requireWorkspaceAccess: makeRequireWorkspaceAccess(deps),
  }
}
