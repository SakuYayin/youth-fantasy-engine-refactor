/**
 * Fastify 装配与启动入口。
 *
 * 设计依据（`04-后端与安全.md` / `07-同步协议与API.md` / `09-部署与运维.md`）：
 * "HTTP 前缀 `/api/v1`，Schema 验证输入输出，统一错误/分页/大小限制"；
 * "代理部署**仅信任配置过的代理层**，不能盲目信任所有 `X-Forwarded-*`"；
 * "日志输出 JSON，requestId 串联请求、任务和操作"；
 * "优雅停止先拒绝新任务再关库"。
 *
 * ## `createServer` 为什么必须是同步的、且返回 Fastify 实例
 *
 * 测试要能 `app.inject()`（不监听端口），运维要能自己决定何时 `listen`。
 * 一旦装配函数变成异步，调用方就得先 `await` 一个"即将就绪"的对象，
 * 而 Fastify 的插件注册与路由注册在 `ready()` 之前都是排队的——返回实例
 * 让"装配"与"就绪"这两件事各自有明确的时机。
 *
 * ## 错误边界为什么只有一个出口
 *
 * `setErrorHandler` 是整个进程里**唯一**把异常变成响应体的地方。任何路由里
 * 自己 `reply.status(500).send({...})` 都会绕过这里，从而绕过"剥掉 cause"、
 * "requestId 与日志一致"、"5xx 不外发原始消息"这三条保证。
 * `setNotFoundHandler` 同理：404 也必须走契约错误结构，否则客户端会遇到
 * 两种形状的 404（框架的 `{statusCode,error,message}` 与契约的 5 字段），
 * 而它会先按契约解析、解析失败后崩在错误处理里。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { ContractError, makeId, newIds, systemClock } from '@yfe/contracts'
import type { Clock, RequestId, UtcTimestamp } from '@yfe/contracts'
import Fastify, { LogController } from 'fastify'
import cookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'

import { attachRequestContext, createPermissionGuards } from '../permission/index.js'
import { ensureServerState } from '../db/serverState.js'
import { migrateServerDatabase } from '../db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../db/open.js'
import type { ServerDb } from '../db/open.js'
import { registerRoutes } from '../routes/index.js'
import { storageRootFromDataDir } from '../storage/paths.js'
import { assertWritableDirectory, loadServerConfig } from './config.js'
import type { ServerConfig } from './config.js'
import {
  contractErrorFromFramework,
  errorResponseBody,
  httpStatusForError,
  toContractError,
} from './errors.js'
import type { FrameworkErrorLike } from './errors.js'
import { createRateLimiter } from './rateLimit.js'
import type { RateLimiter } from './rateLimit.js'

/** 优雅停止闸门。由生命周期持有者（`startServer` / 测试）翻转。 */
export interface ServerLifecycle {
  shuttingDown: boolean
}

export interface CreateServerOptions {
  readonly config: ServerConfig
  readonly db: ServerDb
  readonly serverId: string
  readonly clock?: Clock
  readonly lifecycle?: ServerLifecycle
  /** `false` 关闭日志（测试用）。默认按 `config.logLevel` 输出 JSON。 */
  readonly logger?: boolean
  /**
   * 是否装配业务路由表（`routes/index.ts`）。默认 `true`。
   *
   * `false` 用于"只想要传输层骨架"的测试：它们自己装配某一个路由模块，
   * 并注入只有测试才知道的依赖。若在已装配全表的 app 上再注册同一 method+url，
   * Fastify 会直接抛 `FST_ERR_ROUTE_ALREADY_DECLARED`——那时的报错很难指向真正的原因。
   *
   * ⚠️ 绝大多数测试**不需要**它：要换附件存储根或配对 pepper，用下面两个字段，
   * 这样测的才是真正装配好的 app。关掉全表意味着 `login` 等路由也不存在了。
   */
  readonly includeRoutes?: boolean
  /**
   * 覆盖附件存储根（默认 `storageRootFromDataDir(config.dataDir)`）。
   *
   * 测试必须覆盖它，否则上传会在**仓库工作目录**下写出 `data/assets`。
   */
  readonly storageRoot?: string
  /**
   * 直接注入配对 pepper（≥16 字节）。优先于 `config.masterKeyFile`，测试用。
   */
  readonly pairingPepper?: Buffer | Uint8Array
  readonly rateLimiters?: {
    readonly setup?: RateLimiter
    readonly login?: RateLimiter
  }
}

/** 结构化日志出口。路由层用它记录"发生了什么"，而不是直接依赖 pino 形状。 */
function makeLogSink(app: FastifyInstance): (line: Record<string, unknown>) => void {
  return (line) => {
    const level = typeof line['level'] === 'string' ? line['level'] : 'info'
    const payload: Record<string, unknown> = { ...line }
    delete payload['level']
    switch (level) {
      case 'fatal':
        app.log.fatal(payload)
        break
      case 'error':
        app.log.error(payload)
        break
      case 'warn':
        app.log.warn(payload)
        break
      case 'debug':
        app.log.debug(payload)
        break
      case 'trace':
        app.log.trace(payload)
        break
      default:
        app.log.info(payload)
    }
  }
}

export function createServer(options: CreateServerOptions): FastifyInstance {
  const { config, db, serverId } = options
  const clock = options.clock ?? systemClock
  const lifecycle: ServerLifecycle = options.lifecycle ?? { shuttingDown: false }

  const app = Fastify({
    // 体积上限在传输层就拒绝，不让超大 body 进到 JSON 解析与业务校验。
    bodyLimit: config.bodyLimitBytes,
    // 🔴 只信任配置过的代理层。空列表 = 完全不信任 `X-Forwarded-*`，
    // 此时 `request.ip` 是直连对端地址。绝不能写成 `true`。
    trustProxy: config.trustedProxies.length > 0 ? [...config.trustedProxies] : false,
    // 请求日志由下面的钩子自己打（要带 route 模式而不是原始 URL，见注释）。
    // 用 `new LogController(...)` 而不是已废弃的顶层 `disableRequestLogging`：
    // 后者会在每次建实例时打 FSTDEP023 警告。注意这里必须传**实例**，
    // 传普通选项对象会在运行时炸（fastify 会当成控制器直接调方法）。
    logController: new LogController({ disableRequestLogging: true }),
    // 🔴 `requestIdHeader: false`：**不接受**客户端提供的 requestId。
    // 允许客户端指定会让攻击者用别人（或未来）的 id 污染日志串联，
    // 也会让"从日志反查一次请求"这件事失去可信度。
    requestIdHeader: false,
    genReqId: () => newIds.request(),
    // 🔴 Fastify 默认 `removeAdditional: true`：带 `additionalProperties: false`
    // 的 schema 会把未知字段**静默删掉**然后当合法请求继续处理。这对客户端是
    // 最坏的选择——它以为提交了 `role: 'admin'`，服务端当作没看见，出问题时
    // 双方都看不出曾经发生过什么。改成拒绝：未知字段直接 400 VALIDATION_FAILED。
    ajv: { customOptions: { removeAdditional: false } },
    ...(options.logger === false
      ? { logger: false }
      : {
          logger: {
            level: config.logLevel,
            base: { service: '@yfe/server', serverId },
            // 兜底：即使将来有人打开了 header 序列化，凭据也不会落到日志里。
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-csrf-token"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
        }),
  })

  app.register(cookie)

  // --- 1. 优雅停止闸门：先拒绝新请求，再关库（顺序见 close()）---
  app.addHook('onRequest', async (request) => {
    if (!lifecycle.shuttingDown) return
    // 停止过程中仍然要能探测存活：否则编排器会以为进程挂了。
    if (request.url === '/health/live' || request.url.startsWith('/health/live?')) return
    throw new ContractError({
      code: 'SERVICE_SHUTTING_DOWN',
      message: '服务正在停止，暂时无法处理请求。',
      requestId: request.id as RequestId,
    })
  })

  // --- 2. requestId 回写响应头（与日志、响应体三处一致）---
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id)
    reply.header('x-content-type-options', 'nosniff')
  })

  // --- 3. 请求日志：只记录路由模式，不记录原始 URL ---
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        event: 'http.request.completed',
        requestId: request.id,
        method: request.method,
        // 🔴 用路由模式（`/api/v1/projects/:projectId`）而不是 `request.url`：
        // 原始 URL 带查询串，令牌、游标、邮箱都可能出现在里面。
        route: request.routeOptions.url ?? null,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        clientIp: request.ip,
      },
      'request completed',
    )
  })

  // --- 4. 请求上下文（auth=null、每请求一个 now）---
  attachRequestContext(app, { db, policy: config.sessionPolicy }, clock)
  const guards = createPermissionGuards({ db, policy: config.sessionPolicy })

  // --- 5. 错误边界 ---
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id as RequestId
    let contractError: ContractError
    if (error instanceof ContractError) {
      contractError = error
    } else {
      // Fastify 自己的错误（schema 校验、体积超限、JSON 解析失败）优先按
      // statusCode 归类，剩下的（业务代码里漏出的 TypeError、SQLite 异常等）
      // 一律折算成 INTERNAL_ERROR，原始消息只留在日志的 `cause` 里。
      contractError =
        contractErrorFromFramework(error as FrameworkErrorLike, requestId) ??
        toContractError(error, requestId)
    }
    const status = httpStatusForError(contractError)
    const payload = contractError.toPayload()

    const logLine = {
      event: 'http.error',
      requestId,
      code: payload.code,
      status,
      method: request.method,
      route: request.routeOptions.url ?? null,
      // 🔴 `cause` 只出现在日志里（它可能含 SQLite 原文或 SQL 片段），
      // 响应体由 `errorResponseBody` 剥掉它。
      cause: payload.cause ?? null,
    }
    if (status >= 500) request.log.error(logLine)
    else request.log.warn(logLine)

    reply
      .status(status)
      .header('cache-control', 'no-store')
      .header('x-request-id', requestId)
      .send(errorResponseBody(payload, requestId))
  })

  app.setNotFoundHandler((request, reply) => {
    const requestId = request.id as RequestId
    const payload = new ContractError({
      code: 'NOT_FOUND',
      message: '请求的接口不存在。',
      requestId,
      detail: { method: request.method, route: request.routeOptions.url ?? null },
    }).toPayload()
    return reply
      .status(404)
      .header('cache-control', 'no-store')
      .header('x-request-id', requestId)
      .send(errorResponseBody(payload, requestId))
  })

  // --- 6. 业务路由 ---
  // `includeRoutes: false` 只用于"自己装配某个路由模块"的测试，见 CreateServerOptions。
  if (options.includeRoutes !== false) {
    registerRoutes(app, {
      db,
      serverId,
      policy: config.sessionPolicy,
      now: () => clock.now(),
      startedAt: startedAtIso,
      startedAtMs: startedAtMs,
      nowMs: () => Date.now(),
      bootstrapSecretFile: config.bootstrapSecretFile,
      // 附件存储根：路由不读 env，唯一来源是配置（测试可覆盖成临时目录）。
      storageRoot: options.storageRoot ?? storageRootFromDataDir(config.dataDir),
      // 配对码 pepper 的来源；为 null 时配对码接口 fail closed（503）。
      masterKeyFile: config.masterKeyFile,
      ...(options.pairingPepper === undefined ? {} : { pairingPepper: options.pairingPepper }),
      bodyLimitBytes: config.bodyLimitBytes,
      guards,
      log: makeLogSink(app),
      ...(options.rateLimiters === undefined ? {} : { rateLimiters: options.rateLimiters }),
    })
  }

  return app
}

/**
 * 进程启动时刻。
 *
 * 刻意在模块加载时取一次而不是每次 `createServer` 都取：同一个进程里
 * 反复建 app（测试里很常见）不应让 uptime 归零——uptime 描述的是**进程**，
 * 不是实例。
 */
const startedAtIso: UtcTimestamp = systemClock.now()
const startedAtMs = Date.now()

export interface ServerHandle {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly config: ServerConfig
  readonly serverId: string
  readonly lifecycle: ServerLifecycle
  /** 停止：先关闸门（拒绝新请求）→ 关 Fastify → 关数据库。 */
  close(): Promise<void>
}

/** 监听端口并返回句柄。测试优先用 `createServer(...).inject()`，不监听端口。 */
export async function startServer(options: CreateServerOptions): Promise<ServerHandle> {
  const lifecycle: ServerLifecycle = options.lifecycle ?? { shuttingDown: false }
  const app = createServer({ ...options, lifecycle })
  await app.listen({ host: options.config.listenHost, port: options.config.listenPort })

  let closed = false
  return {
    app,
    db: options.db,
    config: options.config,
    serverId: options.serverId,
    lifecycle,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // 顺序有意义：先让在途请求与新请求都被拒绝，再关库，
      // 否则一个正在跑的处理器会拿到"数据库已关闭"的错误。
      lifecycle.shuttingDown = true
      await app.close()
      closeServerDatabase(options.db)
    },
  }
}

export interface BootstrapResult extends ServerHandle {
  readonly warnings: readonly string[]
}

/**
 * 启动装配：配置 → 目录 → 开库 → 迁移 → 服务状态行 → （可选）监听。
 *
 * 🔴 数据目录不可写时**直接失败**，绝不改用一个临时目录继续跑
 * （`09-部署与运维.md`："启动失败不能创建另一个临时空库继续运行"）。
 */
export async function bootstrapServer(
  config: ServerConfig = loadServerConfig(),
  options: { readonly listen?: boolean; readonly logger?: boolean; readonly clock?: Clock } = {},
): Promise<BootstrapResult> {
  assertWritableDirectory(config.dataDir)
  const dbDir = dirname(config.databasePath)
  mkdirSync(dbDir, { recursive: true })
  assertWritableDirectory(dbDir)

  const db = openServerDatabase(config.databasePath)
  try {
    await migrateServerDatabase(db)
    // serverId 只在首次插入时生效，之后从库里读回同一个值——
    // 所以这里生成的候选值每次重启都不同也没关系。
    const state = ensureServerState(db, makeId('srv'), config.bootstrapSecretFile)
    const serverId = state.serverId

    const lifecycle: ServerLifecycle = { shuttingDown: false }
    const handle =
      options.listen === false
        ? {
            app: createServer({
              config,
              db,
              serverId,
              lifecycle,
              ...(options.clock === undefined ? {} : { clock: options.clock }),
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            }),
            db,
            config,
            serverId,
            lifecycle,
            async close(): Promise<void> {
              lifecycle.shuttingDown = true
              closeServerDatabase(db)
            },
          }
        : await startServer({
            config,
            db,
            serverId,
            lifecycle,
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
          })

    const log = makeLogSink(handle.app)
    for (const warning of config.warnings) {
      log({ level: 'warn', event: 'config.warning', message: warning })
    }
    // 🔴 只提示文件位置与可用性，绝不打印内容。
    log({
      level: 'info',
      event: 'config.secrets',
      masterKeyFile: config.masterKeyFile,
      bootstrapSecretFile: config.bootstrapSecretFile,
      bootstrapSecretAvailable: config.bootstrapSecretFile !== null,
    })

    return { ...handle, warnings: config.warnings }
  } catch (thrown) {
    // 装配中途失败必须关掉已打开的连接：`openServerDatabase` 会为同一路径
    // 登记独占写者，泄漏的连接会让"修好配置后重启"直接失败。
    closeServerDatabase(db)
    throw thrown
  }
}

/** 默认限流器（供启动路径显式注入，测试可替换）。 */
export function defaultRateLimiters(): { setup: RateLimiter; login: RateLimiter } {
  return {
    setup: createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 10 }),
    login: createRateLimiter({ windowMs: 15 * 60 * 1000, maxAttempts: 20 }),
  }
}
