/**
 * 工作区成员管理（`/api/v1/workspaces/:workspaceId/members*`）。
 *
 * ## 两道鉴权，缺一不可
 *
 * 1. **路由守卫**（`preHandler`）：`deps.guards.requireWorkspaceAccess({ action })`；
 * 2. **处理器内再授权**：`authorizeWorkspaceAccess(deps, request, workspaceId, action)`。
 *
 * 守卫只负责"有没有身份 / 能不能进这个工作区"，真正要操作哪个 `workspaceId`
 * 以**处理器里解析出来的值**为准。两处用同一个值再判一次，是为了防止将来有人
 * 改动守卫参数（例如放宽 action）时静默提权——这也是 `routes/devices.ts` 的既有做法。
 *
 * ## 最后一名管理者不可移除/降级
 *
 * `workspace_members.role` 里能管理成员的只有 `admin` / `owner`
 * （`@yfe/contracts` 的 `canManageMembers`）。把最后一名这样的成员删掉或降级成
 * `editor` / `viewer`，这个工作区就再也没人能加人、改角色或授权设备了——
 * 属于设计文档所说的"必须拒绝的状态转换"，走 `auth/permission.ts` 的
 * `assertNotLastOwner`（`STATE_INVALID_TRANSITION`，409）。
 *
 * ## CSRF 不在这里实现
 *
 * 三个写接口都经过 `requireWorkspaceAccess` → `requireSession` 的 CSRF 判定，
 * 由 `permission/index.ts` 统一负责。在这里重复实现会产生第二份判定。
 */

import { ContractError, WORKSPACE_ROLES, canManageMembers } from '@yfe/contracts'
import type { RequestId, UserId, UtcTimestamp, WorkspaceId, WorkspaceRole } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { assertNotLastOwner } from '../auth/permission.js'
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/audit.js'
import {
  countOwners,
  findMember,
  listMemberViews,
  removeMember,
  upsertMember,
} from '../db/members.js'
import type { WorkspaceMemberView } from '../db/members.js'
import type { ServerDb } from '../db/open.js'
import { findUserById, findUserByUsername } from '../db/users.js'
import type { UserRow } from '../db/users.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { requireWellFormedId } from '../sync/protocol.js'

export interface MemberRouteDeps {
  readonly db: ServerDb
  readonly policy: PermissionDeps['policy']
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
}

/** 成员 → 响应对象（**白名单**，逐字段挑出，不用 `{...row}`）。 */
interface MemberSummary {
  readonly userId: UserId
  readonly username: string
  readonly displayName: string
  readonly role: WorkspaceRole
  readonly createdAt: UtcTimestamp
}

function toMemberSummary(view: WorkspaceMemberView): MemberSummary {
  return {
    userId: view.userId,
    username: view.username,
    displayName: view.displayName,
    role: view.role,
    createdAt: view.createdAt,
  }
}

const WORKSPACE_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const MEMBER_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'userId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    userId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

/**
 * 加成员：`userId` 与 `username` 二选一。
 *
 * 两个都给会被 handler 拒绝（`VALIDATION_FAILED`）而不是"以 userId 为准"：
 * 静默忽略其中一个会让客户端以为另一个生效了，而两者指向不同用户时后果是
 * "加错了人"。角色也**必须**显式给（schema `required`），不给就 400。
 */
const ADD_MEMBER_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    userId: { type: 'string', minLength: 1, maxLength: 128 },
    username: { type: 'string', minLength: 1, maxLength: 64 },
    role: { type: 'string', minLength: 1, maxLength: 16 },
  },
} as const

const SET_ROLE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role'],
  properties: {
    role: { type: 'string', minLength: 1, maxLength: 16 },
  },
} as const

interface AddMemberBody {
  readonly userId?: string
  readonly username?: string
  readonly role: string
}

interface SetRoleBody {
  readonly role: string
}

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const params = request.params as { readonly workspaceId?: unknown }
  return requireWellFormedId(params.workspaceId, 'workspaceId', requestId) as WorkspaceId
}

function memberUserIdOf(request: FastifyRequest, requestId: RequestId): UserId {
  const params = request.params as { readonly userId?: unknown }
  return requireWellFormedId(params.userId, 'userId', requestId) as UserId
}

/** 角色收窄。非法取值是 400（`VALIDATION_FAILED`），不是 500，也不是静默降权。 */
function parseRole(raw: string, requestId: RequestId): WorkspaceRole {
  if ((WORKSPACE_ROLES as readonly string[]).includes(raw)) return raw as WorkspaceRole
  throw new ContractError({
    code: 'VALIDATION_FAILED',
    message: `role 必须是 ${WORKSPACE_ROLES.join(' / ')} 之一。`,
    requestId,
    detail: { field: 'role', allowed: WORKSPACE_ROLES.join(',') },
  })
}

function memberNotFound(requestId: RequestId, userId: UserId): ContractError {
  return new ContractError({
    code: 'NOT_FOUND',
    message: '该用户不是这个工作区的成员。',
    requestId,
    detail: { userId },
  })
}

/**
 * 按 `userId` 或 `username` 定位目标用户。
 *
 * 两者都不给 → 400 `VALIDATION_MISSING_FIELD`；两个都给 → 400 `VALIDATION_FAILED`；
 * 找不到 → 404 `NOT_FOUND`（**不是** 400：输入形状合法，是目标不存在）。
 */
function resolveTargetUser(deps: MemberRouteDeps, body: AddMemberBody, requestId: RequestId): UserRow {
  const hasUserId = typeof body.userId === 'string'
  const hasUsername = typeof body.username === 'string'
  if (!hasUserId && !hasUsername) {
    throw new ContractError({
      code: 'VALIDATION_MISSING_FIELD',
      message: '必须给出 userId 或 username 之一。',
      requestId,
      detail: { field: 'userId' },
    })
  }
  if (hasUserId && hasUsername) {
    throw new ContractError({
      code: 'VALIDATION_FAILED',
      message: 'userId 与 username 只能给一个，不能同时给出。',
      requestId,
      detail: { fields: 'userId,username' },
    })
  }

  if (hasUserId) {
    const userId = requireWellFormedId(body.userId, 'userId', requestId) as UserId
    const user = findUserById(deps.db, userId)
    if (user === null) {
      throw new ContractError({ code: 'NOT_FOUND', message: '用户不存在。', requestId, detail: { userId } })
    }
    return user
  }

  const username = body.username as string
  const user = findUserByUsername(deps.db, username)
  if (user === null) {
    // 🔴 detail 里只回显调用方自己传来的 username（不是"库里最接近的那个"），
    // 避免把"某个用户名是否存在"变成一个可枚举的接口。
    throw new ContractError({
      code: 'NOT_FOUND',
      message: '用户不存在。',
      requestId,
      detail: { username },
    })
  }
  return user
}

export function registerMemberRoutes(app: FastifyInstance, deps: MemberRouteDeps): void {
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const requireMemberRead = deps.guards.requireWorkspaceAccess({ action: 'read' })
  const requireMemberManage = deps.guards.requireWorkspaceAccess({ action: 'manageMembers' })

  // ---------------------------------------------------------------- 列举成员
  app.get(
    '/api/v1/workspaces/:workspaceId/members',
    { preHandler: requireMemberRead, schema: { params: WORKSPACE_PARAMS_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')

      const principal = currentPrincipal(request)
      const members = listMemberViews(deps.db, workspaceId).map(toMemberSummary)
      deps.log?.({
        level: 'debug',
        event: 'workspace.members.listed',
        requestId,
        workspaceId,
        actorUserId: principal.userId,
        count: members.length,
      })
      return reply.status(200).header('cache-control', 'no-store').send({ members })
    },
  )

  // ---------------------------------------------------------------- 加成员
  app.post(
    '/api/v1/workspaces/:workspaceId/members',
    { preHandler: requireMemberManage, schema: { params: WORKSPACE_PARAMS_SCHEMA, body: ADD_MEMBER_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const principal = currentPrincipal(request)
      const body = request.body as AddMemberBody
      const role = parseRole(body.role, requestId)
      const target = resolveTargetUser(deps, body, requestId)

      // 重复添加是 409 而不是"覆盖角色"：`upsertMember` 的语义是 upsert，
      // 直接用它会让"再加一次"变成一次静默的改角色，客户端看不出发生了两件事。
      // 并发下两个请求可能都通过这一检查，此时主键 `(workspace_id, user_id)`
      // 保证只有一行，后写者覆盖角色——不会产生重复成员，仅让其中一个请求
      // 看到 201 而非 409。
      if (findMember(deps.db, workspaceId, target.id) !== null) {
        throw new ContractError({
          code: 'ALREADY_EXISTS',
          message: '该用户已经是这个工作区的成员。',
          requestId,
          detail: { workspaceId, userId: target.id },
        })
      }

      const at = deps.now()
      upsertMember(deps.db, workspaceId, target.id, role, at)
      const created = listMemberViews(deps.db, workspaceId).find((m) => m.userId === target.id)
      if (created === undefined) {
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '成员写入后无法读回，数据库内容不符合契约。',
          requestId,
          detail: { workspaceId, userId: target.id },
        })
      }

      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.memberAdded,
        outcome: 'success',
        at,
        actorUserId: principal.userId,
        targetType: 'user',
        targetId: target.id,
        workspaceId,
        requestId,
        clientIp: request.ip,
        detail: { role, via: body.username === undefined ? 'userId' : 'username' },
      })

      return reply.status(201).header('cache-control', 'no-store').send({ member: toMemberSummary(created) })
    },
  )

  // ---------------------------------------------------------------- 改角色
  app.patch(
    '/api/v1/workspaces/:workspaceId/members/:userId',
    { preHandler: requireMemberManage, schema: { params: MEMBER_PARAMS_SCHEMA, body: SET_ROLE_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const principal = currentPrincipal(request)
      const targetUserId = memberUserIdOf(request, requestId)
      const role = parseRole((request.body as SetRoleBody).role, requestId)

      const member = findMember(deps.db, workspaceId, targetUserId)
      if (member === null) throw memberNotFound(requestId, targetUserId)

      // 只有"确实在收回管理能力"时才检查最后一名：把一个 viewer 改成 editor
      // 不该因为"这个工作区当前 0 个 owner"（手工改库才可能出现的状态）被误拦。
      if (canManageMembers(member.role) && !canManageMembers(role)) {
        assertNotLastOwner(countOwners(deps.db, workspaceId) - 1, workspaceId, requestId)
      }

      const at = deps.now()
      upsertMember(deps.db, workspaceId, targetUserId, role, at)
      const updated = listMemberViews(deps.db, workspaceId).find((m) => m.userId === targetUserId)
      if (updated === undefined) {
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '成员角色更新后无法读回，数据库内容不符合契约。',
          requestId,
          detail: { workspaceId, userId: targetUserId },
        })
      }

      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.memberRoleChanged,
        outcome: 'success',
        at,
        actorUserId: principal.userId,
        targetType: 'user',
        targetId: targetUserId,
        workspaceId,
        requestId,
        clientIp: request.ip,
        detail: { from: member.role, to: role },
      })

      return reply.status(200).header('cache-control', 'no-store').send({ member: toMemberSummary(updated) })
    },
  )

  // ---------------------------------------------------------------- 删成员
  app.delete(
    '/api/v1/workspaces/:workspaceId/members/:userId',
    { preHandler: requireMemberManage, schema: { params: MEMBER_PARAMS_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const principal = currentPrincipal(request)
      const targetUserId = memberUserIdOf(request, requestId)

      const member = findMember(deps.db, workspaceId, targetUserId)
      if (member === null) throw memberNotFound(requestId, targetUserId)

      // 删掉最后一名 admin/owner = 这个工作区再也没人能管理成员或授权设备。
      if (canManageMembers(member.role)) {
        assertNotLastOwner(countOwners(deps.db, workspaceId) - 1, workspaceId, requestId)
      }

      const at = deps.now()
      if (!removeMember(deps.db, workspaceId, targetUserId)) {
        // 检查通过后行消失：并发删除。对外和"本来就不存在"是同一个结果。
        throw memberNotFound(requestId, targetUserId)
      }

      recordAuditEvent(deps.db, {
        action: AUDIT_ACTIONS.memberRemoved,
        outcome: 'success',
        at,
        actorUserId: principal.userId,
        targetType: 'user',
        targetId: targetUserId,
        workspaceId,
        requestId,
        clientIp: request.ip,
        detail: { role: member.role },
      })

      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .send({ workspaceId, userId: targetUserId, removed: true })
    },
  )
}
