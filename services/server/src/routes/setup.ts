/**
 * `POST /api/v1/setup` —— 一次性初始化。
 *
 * 设计依据（`04-后端与安全.md` / `07-同步协议与API.md`）：
 * "首次启动未初始化；一次性引导凭据通过仅管理员可读的秘密文件提供，
 *  日志只提示文件位置，绝不打印秘密值；**初始化仅可执行一次，创建所有者后立即
 *  禁用引导路径，公开部署在开放入口前完成初始化**"。
 *
 * ## 这个端点为什么是全服务最危险的一个
 *
 * 它创建第一个所有者——也就是"能创建其他一切"的账号。因此它有四层保护，
 * 每一层都对应一类真实攻击：
 *
 * 1. **限流**：挡住对引导凭据的在线暴力猜解（凭据在文件里，攻击者只能打接口）；
 * 2. **数据库行上的幂等开关**（不是进程内布尔量）：挡住"重启后重新开放入口"，
 *    以及两个并发 setup 同时创建所有者的竞争；
 * 3. **引导凭据的恒定时间比较**：挡住计时侧信道（复用 `auth/bootstrap.ts`）；
 * 4. **整个初始化在一个事务里**：挡住"用户建好了但成员关系写失败"这种
 *    "已初始化却没有所有者"的死状态（`createUserWithMembership` 的设计注释解释了它）。
 *
 * ## 失败信息为什么必须区分 409 / 401 / 503
 *
 * - `409` 已初始化 → 调用方**不要重试**，这是终态（也是本任务验收要断言的那条）；
 * - `401` 凭据不对 → 调用方检查文件内容；这才该被审计与限流计数；
 * - `503` 凭据文件不可用 → **不是**调用方的错，是部署没放文件；重试无用，
 *   日志里会给出文件路径（日志在第 5 步的启动装配里打，路由自身也打一条结构化日志）。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { verifyBootstrapSecret } from '../auth/bootstrap.js'
import { assertPasswordDiffersFromUsername, validateDisplayName, validatePassword, validateUsername } from '../auth/credentialPolicy.js'
import { hashPassword } from '../auth/password.js'
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/audit.js'
import { createUserWithMembership } from '../db/users.js'
import { markServerInitialized, readServerState } from '../db/serverState.js'
import type { ServerDb } from '../db/open.js'
import { createRateLimiter, rateLimitedError } from '../http/rateLimit.js'
import type { RateLimiter } from '../http/rateLimit.js'

export interface SetupDeps {
  readonly db: ServerDb
  readonly serverId: string
  /** 引导凭据文件路径。`null` = 未配置（setup 返回 503）。 */
  readonly bootstrapSecretFile: string | null
  readonly now: () => UtcTimestamp
  /** 限流器。默认"每 15 分钟 10 次失败"（见 `http/rateLimit.ts` 的窗口说明）。 */
  readonly rateLimiter?: RateLimiter
  /** 结构化日志出口（测试可注入以捕获日志，从而断言秘密值没进日志）。 */
  readonly log?: (line: Record<string, unknown>) => void
}

/** 初始化请求体。字段白名单是"不接受客户端自报角色"的落地方式之一。 */
export interface SetupBody {
  readonly bootstrapSecret: string
  readonly username: string
  readonly password: string
  readonly displayName?: string
}

const SETUP_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bootstrapSecret', 'username', 'password'],
  properties: {
    bootstrapSecret: { type: 'string', minLength: 1, maxLength: 512 },
    username: { type: 'string', minLength: 3, maxLength: 64 },
    password: { type: 'string', minLength: 12, maxLength: 256 },
    displayName: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

export interface SetupResponseBody {
  readonly serverId: string
  readonly userId: UserId
  readonly workspaceId: WorkspaceId
  readonly role: 'owner'
  readonly initializedAt: UtcTimestamp
}

export const DEFAULT_SETUP_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAttempts: 10 } as const

export function registerSetupRoute(app: FastifyInstance, deps: SetupDeps): void {
  const limiter = deps.rateLimiter ?? createRateLimiter(DEFAULT_SETUP_RATE_LIMIT)
  const log = deps.log ?? (() => {})

  app.post(
    '/api/v1/setup',
    { schema: { body: SETUP_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const at = deps.now()
      const clientIp = request.ip ?? null
      const body = request.body as SetupBody

      // --- 第 1 层：限流（按来源 IP，独立于登录的计数器）---
      const verdict = limiter.hit(`setup:${clientIp ?? 'unknown'}`)
      if (!verdict.allowed) {
        log({ level: 'warn', event: 'setup.rate_limited', requestId, clientIp, retryAfterMs: verdict.retryAfterMs })
        throw rateLimitedError(verdict.retryAfterMs, requestId)
      }

      // --- 第 2 层：幂等开关。行不存在说明启动装配没跑完，那是服务端故障 ---
      const state = readServerState(deps.db)
      if (state === null) {
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '服务状态表缺少唯一行，数据库可能已损坏。',
          requestId,
        })
      }
      if (state.initializedAt !== null) {
        // 明确、终态、不可重试。审计一条 denied，因为"对已初始化服务再打 setup"
        // 可能是攻击者在探测，也可能是运维搞错了环境，两者都值得留痕。
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.setupCompleted,
          outcome: 'denied',
          at,
          requestId,
          clientIp,
          targetType: 'server',
          targetId: deps.serverId,
          detail: { reason: 'already_initialized' },
        })
        throw new ContractError({
          code: 'ALREADY_EXISTS',
          message: '服务已完成初始化，初始化入口已永久关闭。',
          requestId,
          detail: { reason: 'already_initialized', initializedAt: state.initializedAt },
        })
      }

      // --- 第 3 层：引导凭据（恒定时间比较；文件不可用是 503，不是 401）---
      const verification = verifyBootstrapSecret(deps.bootstrapSecretFile, body.bootstrapSecret)
      if (!verification.ok) {
        if (verification.unavailable) {
          // 只提示文件位置，绝不打印文件内容，也绝不回显调用方提交的值。
          log({
            level: 'error',
            event: 'setup.bootstrap_unavailable',
            requestId,
            bootstrapSecretFile: deps.bootstrapSecretFile,
            reason: verification.reason,
          })
          throw new ContractError({
            code: 'SERVICE_UNAVAILABLE',
            message: '初始化入口当前不可用，请检查服务器上的引导凭据文件。',
            requestId,
            detail: { reason: 'bootstrap_secret_unavailable' },
          })
        }
        recordAuditEvent(deps.db, {
          action: AUDIT_ACTIONS.setupCompleted,
          outcome: 'failure',
          at,
          requestId,
          clientIp,
          targetType: 'server',
          targetId: deps.serverId,
          detail: { reason: 'bootstrap_secret_mismatch' },
        })
        throw new ContractError({
          code: 'AUTH_INVALID_CREDENTIALS',
          message: '引导凭据不正确。',
          requestId,
        })
      }

      // --- 第 4 层：输入校验（schema 已挡一次，这里是纵深防御）---
      const username = validateUsername(body.username, requestId)
      const password = validatePassword(body.password, requestId)
      assertPasswordDiffersFromUsername(password, username, requestId)
      const displayName = validateDisplayName(body.displayName, username, requestId)

      // --- 初始化事务 ---
      const userId = newIds.user() as UserId
      const workspaceId = newIds.workspace() as WorkspaceId
      const passwordHash = await hashPassword(password)

      const created = deps.db.transaction(() => {
        const user = createUserWithMembership(deps.db, {
          id: userId,
          username,
          displayName,
          passwordHash,
          at,
          workspaceId,
          role: 'owner',
        })
        const marked = markServerInitialized(deps.db, user.id, at)
        if (!marked) {
          // 并发 setup：另一个请求先占了位。抛异常让整个事务回滚，
          // 这样不会留下"建了用户但没成为所有者"的孤儿账号。
          throw new ContractError({
            code: 'ALREADY_EXISTS',
            message: '服务已完成初始化，初始化入口已永久关闭。',
            requestId,
            detail: { reason: 'already_initialized' },
          })
        }
        return user
      })()

      // 审计是旁路（`recordAuditEvent` 写失败只返回 false，不抛）。
      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.setupCompleted,
        outcome: 'success',
        at,
        actorUserId: created.id,
        requestId,
        clientIp,
        targetType: 'server',
        targetId: deps.serverId,
        workspaceId,
        detail: { username },
      })

      // 成功即清零限流计数：正常运维不该因为"前面试错了两次"再被卡住。
      limiter.reset(`setup:${clientIp ?? 'unknown'}`)

      const response: SetupResponseBody = {
        serverId: deps.serverId,
        userId: created.id,
        workspaceId,
        role: 'owner',
        initializedAt: at,
      }
      return reply.status(201).header('cache-control', 'no-store').send(response)
    },
  )
}
