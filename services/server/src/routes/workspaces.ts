/**
 * `/api/v1/workspaces` —— 按主体列举成员工作区 / 创建工作区。
 *
 * ## 三条纪律
 *
 * 1. **角色只由服务器决定。** 创建者拿到 `owner`，请求体里出现 `role` 直接
 *    400（`additionalProperties: false`）。"不接受客户端自报角色"如果只在
 *    handler 里"读出来但忽略"，字段就变成一个静默的谎言；这里让它在 schema
 *    层就被拒绝，客户端立刻知道自己想错了。
 * 2. **列举按 `workspace_members` 而不是 `workspaces`。** 成员关系才是访问权的
 *    来源；`workspaces` 只是元数据。元数据行缺失（历史数据、迁移中途）
 *    不能让一个真实成员的工作区从列表里消失，所以 SQL 用 LEFT JOIN + COALESCE。
 * 3. **创建工作区不走 batches。** 工作区自身不在同步实体集合里
 *    （`SYNC_ENTITY_TYPES` 只有 project/document/settingsEntity/relation/configValue/pluginState），
 *    它是"同步的容器"而不是"被同步的内容"。走批次只会让第一条变更依赖一个
 *    自己所在的工作区，形成鸡生蛋问题。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { upsertMember } from '../db/members.js'
import { tx } from '../db/open.js'
import type { ServerDb } from '../db/open.js'
import { countWorkspacesForUser, insertWorkspace, listWorkspacesForUser } from '../db/workspaces.js'
import { currentPrincipal } from '../permission/index.js'
import type { PermissionGuards } from '../permission/index.js'

/**
 * 单用户工作区上限。
 *
 * 存在的理由不是"防滥用"这种空话：`workspaces` 与 `workspace_members` 会进入
 * 每一次列表查询，无上限的增长会让 `GET /api/v1/workspaces` 变成一个可被
 * 自己拖垮的端点。50 是一个"正常作者远用不到、脚本刷不出来"的量级。
 */
export const MAX_WORKSPACES_PER_USER = 50

const CREATE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

interface CreateWorkspaceBody {
  readonly name: string
}

export interface WorkspaceRouteDeps {
  readonly db: ServerDb
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  // ---------------------------------------------------------------- 列举
  app.get(
    '/api/v1/workspaces',
    { preHandler: deps.guards.requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = currentPrincipal(request)
      const workspaces = listWorkspacesForUser(deps.db, principal.userId).map((row) => ({
        workspaceId: row.workspaceId,
        name: row.name,
        role: row.role,
        createdAt: row.createdAt,
      }))
      return reply.status(200).header('cache-control', 'no-store').send({ workspaces })
    },
  )

  // ---------------------------------------------------------------- 创建
  app.post(
    '/api/v1/workspaces',
    { preHandler: deps.guards.requireSession, schema: { body: CREATE_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const principal = currentPrincipal(request)
      const body = request.body as CreateWorkspaceBody

      // schema 的 minLength 放过了纯空白；"   " 不是一个工作区名字。
      const name = body.name.trim()
      if (name.length === 0) {
        throw new ContractError({
          code: 'VALIDATION_FAILED',
          message: '工作区名称不能只有空白字符。',
          requestId,
          detail: { field: 'name' },
        })
      }

      if (countWorkspacesForUser(deps.db, principal.userId) >= MAX_WORKSPACES_PER_USER) {
        throw new ContractError({
          code: 'RESOURCE_LOCKED',
          message: `每个主体最多创建 ${MAX_WORKSPACES_PER_USER} 个工作区，请先归档不再使用的工作区。`,
          requestId,
          detail: { limit: MAX_WORKSPACES_PER_USER },
        })
      }

      const at = deps.now()
      const workspaceId = newIds.workspace() as WorkspaceId

      // 元数据行与成员关系必须一起成立：只写一半会造出"创建者自己都看不见"的工作区。
      const created = tx(deps.db, () => {
        insertWorkspace(deps.db, { id: workspaceId, name, createdByUserId: principal.userId, at })
        upsertMember(deps.db, workspaceId, principal.userId, 'owner', at)
        return listWorkspacesForUser(deps.db, principal.userId).find((row) => row.workspaceId === workspaceId)
      })

      if (created === undefined) {
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '工作区创建后无法读回，数据库状态不可信。',
          requestId,
        })
      }

      deps.log?.({ level: 'info', event: 'workspace.created', requestId, workspaceId })

      return reply.status(201).header('cache-control', 'no-store').send({
        workspaceId: created.workspaceId,
        name: created.name,
        role: created.role,
        createdAt: created.createdAt,
      })
    },
  )
}
