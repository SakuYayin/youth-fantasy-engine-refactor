/**
 * 系统管理面：用户列举 / 改名与停用 / 重置密码（`/api/v1/admin/users*`）。
 *
 * ## 三条纪律
 *
 * 1. **"系统管理员"只有一个来源。** 判定走 `db/admin.ts` 的 `requireSystemAdmin`，
 *    它读的是 `server_state.owner_user_id`。请求体、查询串与请求头里的任何
 *    `role` / `isAdmin` 都不参与判定——那是最典型的提权漏洞。
 * 2. **非管理员是 403 而不是 404。** `/api/v1/admin/*` 的存在不是秘密，
 *    用 404 掩盖会把权限问题伪装成部署问题。
 * 3. **绝不回显凭据。** 重置密码的响应里只有 `userId` / `revokedSessions` /
 *    `updatedAt`；用户对象由 `toAdminUserSummary` 逐字段白名单挑出，没有
 *    `passwordHash`，也没有 `disabledAt` 之外的表内细节。
 *
 * ## 停用与重置密码为什么都要"撤销全部会话"
 *
 * 设计文档 04 要求"撤销凭据立即生效"。两条路径都会让已发出的访问令牌立刻作废：
 * `revokeAllUserSessions` 把该用户所有会话标记为已撤销，而
 * `auth/session.ts` 的刷新轮换会因 `previousSession.revokedAt !== null` 直接拒绝，
 * 所以刷新凭据也同时失效（`refresh_tokens` 行不需要删，它们已经换不出任何东西）。
 *
 * ## CSRF 不在这里实现
 *
 * 三个写接口都经 `deps.guards.requireSession` 的 preHandler，由
 * `permission/index.ts` 对 Cookie 会话的写请求强制校验 `x-csrf-token`。
 * 在这里再写一遍会产生第二份判定，而两份判定出现分歧时以哪份为准并不明确。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UserId, UtcTimestamp } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  assertPasswordDiffersFromUsername,
  validateDisplayName,
  validatePassword,
} from '../auth/credentialPolicy.js'
import { hashPassword } from '../auth/password.js'
import { assertNotLastAdmin } from '../auth/permission.js'
import { countEnabledSystemAdminsAfterChange, requireSystemAdmin } from '../db/admin.js'
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/audit.js'
import type { ServerDb } from '../db/open.js'
import { tx } from '../db/open.js'
import { revokeAllUserSessions } from '../db/sessions.js'
import type { UserRow } from '../db/users.js'
import {
  findUserById,
  listUsers,
  setUserDisabled,
  setUserDisplayName,
  setUserPasswordHash,
} from '../db/users.js'
import { currentPrincipal } from '../permission/index.js'
import type { PermissionGuards } from '../permission/index.js'
import { requireWellFormedId } from '../sync/protocol.js'

export interface AdminUsersRouteDeps {
  readonly db: ServerDb
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
}

/**
 * 用户 → 响应对象（**白名单**）。
 *
 * 与 `UserRow` 一一对应且**不含 `passwordHash`**，这样将来谁把
 * `UserWithCredential` 传进来也不会泄漏摘要。
 */
interface AdminUserSummary {
  readonly userId: UserId
  readonly username: string
  readonly displayName: string
  readonly disabled: boolean
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

function toAdminUserSummary(row: UserRow): AdminUserSummary {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.displayName,
    disabled: row.disabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const USER_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userId'],
  properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

/**
 * `minProperties: 1`：`{}` 是"什么都没要求改"，不是一次成功操作。
 * 与 `removeAdditional: false` 一起，未知字段（如 `role`）会被拒绝而不是静默忽略。
 */
const PATCH_USER_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 64 },
    disabled: { type: 'boolean' },
  },
} as const

const RESET_PASSWORD_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['password'],
  properties: {
    // 长度下限在 `validatePassword` 里按 credentialPolicy 再判一次；schema 只挡住
    // 空串与非字符串，让 400 的 detail 由一处产生（避免两处给出不同的 min）。
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

interface PatchUserBody {
  readonly displayName?: string
  readonly disabled?: boolean
}

interface ResetPasswordBody {
  readonly password: string
}

function userIdOf(request: FastifyRequest, requestId: RequestId): UserId {
  const params = request.params as { readonly userId?: unknown }
  return requireWellFormedId(params.userId, 'userId', requestId) as UserId
}

function userNotFound(requestId: RequestId, userId: UserId): ContractError {
  return new ContractError({
    code: 'NOT_FOUND',
    message: '用户不存在。',
    requestId,
    detail: { userId },
  })
}

export function registerAdminUserRoutes(app: FastifyInstance, deps: AdminUsersRouteDeps): void {
  // ---------------------------------------------------------------- 列举用户
  app.get(
    '/api/v1/admin/users',
    { preHandler: deps.guards.requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const principal = currentPrincipal(request)
      requireSystemAdmin(deps.db, principal.userId, requestId)

      const users = listUsers(deps.db).map(toAdminUserSummary)
      return reply.status(200).header('cache-control', 'no-store').send({ users })
    },
  )

  // ---------------------------------------------------------------- 改名 / 停用
  app.patch(
    '/api/v1/admin/users/:userId',
    { preHandler: deps.guards.requireSession, schema: { params: USER_PARAMS_SCHEMA, body: PATCH_USER_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const principal = currentPrincipal(request)
      requireSystemAdmin(deps.db, principal.userId, requestId)

      const targetId = userIdOf(request, requestId)
      const target = findUserById(deps.db, targetId)
      if (target === null) throw userNotFound(requestId, targetId)

      const body = request.body as PatchUserBody

      // 停用方向的两条保护，顺序有意义：
      // 1) 不能停用自己——即使将来有多个管理员，"把自己锁在门外"也不是可取的操作；
      // 2) 不能停用最后一个启用的管理员——保护的是"服务器还有人能管"这件事。
      if (body.disabled === true) {
        if (target.id === principal.userId) {
          throw new ContractError({
            code: 'STATE_INVALID_TRANSITION',
            message: '不能停用当前登录的管理员账号。',
            requestId,
            detail: { reason: 'self_disable_forbidden' },
          })
        }
        assertNotLastAdmin(countEnabledSystemAdminsAfterChange(deps.db, target.id), requestId)
      }

      const displayName =
        body.displayName === undefined
          ? undefined
          : validateDisplayName(body.displayName, target.username, requestId)

      const at = deps.now()
      const result = tx(deps.db, () => {
        if (displayName !== undefined) setUserDisplayName(deps.db, target.id, displayName, at)

        let disabledChanged = false
        let revokedSessions = 0
        if (body.disabled !== undefined && body.disabled !== target.disabled) {
          setUserDisabled(deps.db, target.id, body.disabled, at)
          disabledChanged = true
          // 停用必须同时撤销凭据，否则被停用的人手上的访问令牌在过期前仍然可用。
          if (body.disabled) {
            revokedSessions = revokeAllUserSessions(deps.db, target.id, at, 'account_disabled')
          }
        }

        const updated = findUserById(deps.db, target.id)
        if (updated === null) {
          throw new ContractError({
            code: 'STORAGE_CORRUPT',
            message: '用户更新后无法读回，数据库内容不符合契约。',
            requestId,
            detail: { userId: target.id },
          })
        }
        return { updated, disabledChanged, revokedSessions }
      })

      if (result.disabledChanged) {
        recordAuditEvent(deps.db, {
          action: body.disabled === true ? AUDIT_ACTIONS.userDisabled : AUDIT_ACTIONS.userEnabled,
          outcome: 'success',
          at,
          actorUserId: principal.userId,
          targetType: 'user',
          targetId: target.id,
          requestId,
          clientIp: request.ip,
          detail: { revokedSessions: result.revokedSessions },
        })
      }
      if (displayName !== undefined && displayName !== target.displayName) {
        // 契约里没有 `user.renamed` 审计动作（只有 device 有），只留结构化日志。
        deps.log?.({
          level: 'info',
          event: 'admin.user.renamed',
          requestId,
          actorUserId: principal.userId,
          targetUserId: target.id,
        })
      }

      return reply.status(200).header('cache-control', 'no-store').send({
        user: toAdminUserSummary(result.updated),
        revokedSessions: result.revokedSessions,
      })
    },
  )

  // ---------------------------------------------------------------- 重置密码
  app.post(
    '/api/v1/admin/users/:userId/password-reset',
    {
      preHandler: deps.guards.requireSession,
      schema: { params: USER_PARAMS_SCHEMA, body: RESET_PASSWORD_BODY_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const principal = currentPrincipal(request)
      requireSystemAdmin(deps.db, principal.userId, requestId)

      const targetId = userIdOf(request, requestId)
      const target = findUserById(deps.db, targetId)
      if (target === null) throw userNotFound(requestId, targetId)

      const body = request.body as ResetPasswordBody
      const password = validatePassword(body.password, requestId)
      // 管理员也不该把别人的密码设成他的用户名（那是登录接口必然会拒的组合）。
      assertPasswordDiffersFromUsername(password, target.username, requestId)

      // 🔴 摘要在事务外算：scrypt 是 CPU 密集的同步调用，放进事务会拉长持锁时间。
      const passwordHash = await hashPassword(password)

      const at = deps.now()
      const revokedSessions = tx(deps.db, () => {
        setUserPasswordHash(deps.db, target.id, passwordHash, at)
        return revokeAllUserSessions(deps.db, target.id, at, 'password_reset')
      })

      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.passwordReset,
        outcome: 'success',
        at,
        actorUserId: principal.userId,
        targetType: 'user',
        targetId: target.id,
        requestId,
        clientIp: request.ip,
        detail: { revokedSessions },
      })

      // 响应里没有密码、没有摘要、没有盐参数——只有"对谁做了什么"。
      return reply.status(200).header('cache-control', 'no-store').send({
        userId: target.id,
        revokedSessions,
        updatedAt: at,
      })
    },
  )
}
