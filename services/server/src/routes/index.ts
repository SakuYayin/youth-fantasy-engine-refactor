/**
 * 路由总装配。
 *
 * 这里是**唯一**知道"这个服务对外暴露了哪些接口"的地方：`http/server.ts`
 * 只负责传输层（错误边界、requestId、Cookie、优雅停止），具体接口全部登记在此。
 *
 * ## 为什么健康检查从 `http/health.ts` 直接注册
 *
 * 健康检查的路径**在 `/api/v1` 之外**（设计文档 07 明文要求），它与业务路由
 * 没有任何共享前缀或中间件，包一层 `routes/health.ts` 只会多一个转发的空壳。
 * 这里直接登记，并把它列在业务路由之前——`/health/*` 不属于任何版本化契约，
 * 改动它不需要走契约评审。
 *
 * ## 扩展点（P3-A2 / P3-A3）
 *
 * 同步协议路由（`/api/v1/sync/*`、`/api/v1/workspaces/*`、`/api/v1/devices/*`、
 * `/api/v1/pairing-codes`、`/api/v1/admin/users*`、`/api/v1/capabilities`）
 * 在这里追加 `registerXxxRoutes(app, deps)`。
 *
 * 🔴 每个新路由必须挂 `deps.guards.requireSession` 或
 * `deps.guards.requireWorkspaceAccess({ action })`，并在处理器内部对
 * **真正要操作的那个** workspaceId 再调一次
 * `authorizeWorkspaceAccess(deps, request, workspaceId, action)`
 * （理由见 `permission/index.ts` 的文件头）。"在处理器里自己解析 token 然后信它"
 * 是明确禁止的写法。
 */

import type { UtcTimestamp } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import type { SessionPolicy } from '../auth/session.js'
import type { ServerDb } from '../db/open.js'
import { registerHealthRoutes } from '../http/health.js'
import type { RateLimiter } from '../http/rateLimit.js'
import type { PermissionGuards } from '../permission/index.js'
import { registerAuthRoutes } from './auth.js'
import { registerSetupRoute } from './setup.js'

export interface RouteDeps {
  readonly db: ServerDb
  readonly serverId: string
  readonly policy: SessionPolicy
  readonly now: () => UtcTimestamp
  readonly startedAt: UtcTimestamp
  readonly startedAtMs: number
  readonly nowMs: () => number
  readonly bootstrapSecretFile: string | null
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
  readonly rateLimiters?: {
    readonly setup?: RateLimiter
    readonly login?: RateLimiter
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // 存活/就绪探针：不鉴权、不版本化、不查业务表。
  registerHealthRoutes(app, {
    db: deps.db,
    startedAt: deps.startedAt,
    startedAtMs: deps.startedAtMs,
    nowMs: deps.nowMs,
  })

  // 一次性初始化（引导凭据 + 幂等开关）。
  registerSetupRoute(app, {
    db: deps.db,
    serverId: deps.serverId,
    bootstrapSecretFile: deps.bootstrapSecretFile,
    now: deps.now,
    ...(deps.rateLimiters?.setup === undefined ? {} : { rateLimiter: deps.rateLimiters.setup }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 身份：登录 / 轮换 / 登出 / 当前用户。
  registerAuthRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    ...(deps.rateLimiters?.login === undefined ? {} : { loginRateLimiter: deps.rateLimiters.login }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })
}
