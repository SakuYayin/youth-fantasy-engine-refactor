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
 *
 * ## 装配方必须注入的两个"环境事实"
 *
 * `RouteDeps` 里有两个字段**故意不设默认值**，因为它们的正确取值只有配置层知道：
 *
 * 1. `storageRoot`：附件存储根（`storageRootFromDataDir(config.dataDir)`）。
 *    路由不读 `process.env`，测试才能把它换成临时目录。
 * 2. `masterKeyFile`：配对码 pepper 的来源。为 `null` 时配对码接口会
 *    **fail closed 返回 503**（`pairing_pepper_missing`），而不是退化成无盐哈希。
 */

import type { UtcTimestamp } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import type { SessionPolicy } from '../auth/session.js'
import type { ServerDb } from '../db/open.js'
import { registerHealthRoutes } from '../http/health.js'
import type { RateLimiter } from '../http/rateLimit.js'
import type { PermissionGuards } from '../permission/index.js'
import { registerAdminUserRoutes } from './adminUsers.js'
import { registerAssetRoutes } from './assets.js'
import { registerAuthRoutes } from './auth.js'
import { registerCapabilitiesRoute } from './capabilities.js'
import { registerCommandRoutes } from './commands.js'
import { registerDeviceRoutes } from './devices.js'
import { registerJobEventRoutes } from './events.js'
import { registerJobRoutes } from './jobs.js'
import { registerMemberRoutes } from './members.js'
import { registerPairingCodeRoutes } from './pairingCodes.js'
import { registerSetupRoute } from './setup.js'
import { registerSyncRoutes } from './sync.js'
import { registerUploadRoutes } from './uploads.js'
import { registerWorkspaceRoutes } from './workspaces.js'

export interface RouteDeps {
  readonly db: ServerDb
  readonly serverId: string
  readonly policy: SessionPolicy
  readonly now: () => UtcTimestamp
  readonly startedAt: UtcTimestamp
  readonly startedAtMs: number
  readonly nowMs: () => number
  readonly bootstrapSecretFile: string | null
  /**
   * 附件存储根（绝对路径）。见文件头"装配方必须注入的两个环境事实"。
   */
  readonly storageRoot: string
  /**
   * 主密钥文件路径（32 字节 Base64），配对码 pepper 的来源；`null` ⇒ 配对码接口 503。
   */
  readonly masterKeyFile: string | null
  /**
   * 直接注入的配对 pepper（≥16 字节）。仅测试与嵌入方使用：它优先于
   * `masterKeyFile`（见 `resolvePairingPepper`），让测试不必造 32 字节密钥文件。
   */
  readonly pairingPepper?: Buffer | Uint8Array
  /**
   * 传输层请求体上限（来自 `config.bodyLimitBytes`）。
   *
   * 透传给 capabilities 与批次路由，让"对外上报的上限"与"实际能收下的上限"
   * 永远是同一个数：运维调小 `YFE_BODY_LIMIT_BYTES` 后，Fastify 会在进路由之前
   * 就 413，如果 capabilities 仍报 4 MiB，客户端会按服务端收不下的粒度分片。
   */
  readonly bodyLimitBytes: number
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

  // 能力发现：协议版本、资源上限、附件与远程命令能力。
  registerCapabilitiesRoute(app, {
    serverId: deps.serverId,
    bodyLimitBytes: deps.bodyLimitBytes,
    guards: deps.guards,
  })

  // 工作区元数据：按主体列举 / 创建（角色由服务端决定）。
  registerWorkspaceRoutes(app, {
    db: deps.db,
    now: deps.now,
    guards: deps.guards,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 工作区成员：列举 / 添加 / 改角色 / 移除。
  // `policy` 是处理器内 `authorizeWorkspaceAccess` 需要的（与 devices/sync 同形）。
  registerMemberRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 同步：快照 / 增量 / 原子批次 / 回执 / 版本历史 / 只读投影。
  registerSyncRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    bodyLimitBytes: deps.bodyLimitBytes,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 附件：分片上传会话 → 校验 → 资产登记 → 引用索引。
  // `storageRoot` 由配置注入（本文件的 RouteDeps 已写明理由）。
  registerUploadRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    storageRoot: deps.storageRoot,
    bodyLimitBytes: deps.bodyLimitBytes,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 资产：下载已校验对象 + 查询引用（`AssetRouteDeps` 就是 `UploadRouteDeps` 的别名）。
  registerAssetRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    storageRoot: deps.storageRoot,
    bodyLimitBytes: deps.bodyLimitBytes,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 任务：提交 / 列举 / 详情 / 取消（提交进队列，执行由注入的执行器完成）。
  registerJobRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    bodyLimitBytes: deps.bodyLimitBytes,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 任务事件流（SSE）：按 jobId 订阅输出与状态，支持断点续读。
  registerJobEventRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    bodyLimitBytes: deps.bodyLimitBytes,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 设备：列表 / 重命名 / 撤销 / 换凭据（`POST /api/v1/devices/pair`）。
  registerDeviceRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    // 设备侧路由用设备令牌鉴权（`makeRequireDevice`），不套会话守卫；
    // `masterKeyFile`/`pairingPepper` 只用于配对码 pepper（缺失即 503）。
    masterKeyFile: deps.masterKeyFile,
    ...(deps.pairingPepper === undefined ? {} : { pepper: deps.pairingPepper }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 远程命令：生成（会话）/ 领取（设备令牌 + 租约）/ 回执（幂等）。
  registerCommandRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 配对码：签发 / 列举 / 撤销。缺 pepper 时 fail closed（503），绝不无盐哈希。
  registerPairingCodeRoutes(app, {
    db: deps.db,
    policy: deps.policy,
    now: deps.now,
    guards: deps.guards,
    masterKeyFile: deps.masterKeyFile,
    ...(deps.pairingPepper === undefined ? {} : { pepper: deps.pairingPepper }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })

  // 系统管理面：用户列举 / 改名与停用 / 重置密码。
  // 管理员身份的唯一来源是 `server_state.owner_user_id`（见 `db/admin.ts` 文件头）：
  // 请求体里的 `role` / `isAdmin` 一律不参与判定，非管理员是 403 而不是 404。
  registerAdminUserRoutes(app, {
    db: deps.db,
    now: deps.now,
    guards: deps.guards,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })
}
