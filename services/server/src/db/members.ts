/**
 * 成员与角色仓储。
 *
 * 🔴 本文件的每个读函数都是"**重新鉴权**"的实现：角色从不缓存到会话里，
 * 每次请求都回表查。设计文档 04 明确要求"所有查询、对象下载、游标、任务订阅和写入
 * 均重新鉴权；猜中 documentId、assetHash 或 jobId 不等于有权限"。
 *
 * 为什么不用 `canWrite()` 之外的自定义判定：权限矩阵在 `@yfe/contracts` 的
 * `canWrite` / `canManageMembers` / `canRunRemoteCommand` 里已经定义且被契约测试覆盖，
 * 服务端再写一份就是两个真相源，改一处漏一处。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { UserId, UtcTimestamp, WorkspaceId, WorkspaceRole } from '@yfe/contracts'
import { WORKSPACE_ROLES } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

export interface WorkspaceMemberRow {
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly role: WorkspaceRole
  readonly createdAt: UtcTimestamp
}

interface RawMemberRow {
  readonly workspace_id: string
  readonly user_id: string
  readonly role: string
  readonly created_at: string
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value)
}

/**
 * 把数据库里的 role 文本收窄成契约联合类型。
 *
 * 表上有 CHECK 约束保证取值合法，但**读路径仍然自己校验**：如果有人手工改库、
 * 或未来的迁移放宽了 CHECK，这里必须报错而不是把非法角色当成合法角色用
 * （把未知角色当 `viewer` 会静默降权，当 `editor` 则是提权，两者都不可接受）。
 */
function toMember(raw: RawMemberRow): WorkspaceMemberRow {
  if (!isWorkspaceRole(raw.role)) {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      message: '工作区成员表中存在未知角色，数据库内容不符合契约。',
      requestId: newIds.request(),
      detail: { workspaceId: raw.workspace_id, role: raw.role },
    })
  }
  return {
    workspaceId: raw.workspace_id as WorkspaceId,
    userId: raw.user_id as UserId,
    role: raw.role,
    createdAt: raw.created_at as UtcTimestamp,
  }
}

/** 查成员关系。`null` 表示"确实不是成员"（读失败会抛异常）。 */
export function findMember(
  db: ServerDb,
  workspaceId: WorkspaceId,
  userId: UserId,
): WorkspaceMemberRow | null {
  const raw = db
    .prepare(
      `SELECT workspace_id, user_id, role, created_at
         FROM ${SERVER_TABLES.workspaceMembers}
        WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(workspaceId, userId) as RawMemberRow | undefined
  return raw === undefined ? null : toMember(raw)
}

export function listMembers(
  db: ServerDb,
  workspaceId: WorkspaceId,
): readonly WorkspaceMemberRow[] {
  const rows = db
    .prepare(
      `SELECT workspace_id, user_id, role, created_at
         FROM ${SERVER_TABLES.workspaceMembers}
        WHERE workspace_id = ?
        ORDER BY created_at, user_id`,
    )
    .all(workspaceId) as RawMemberRow[]
  return rows.map(toMember)
}

/** 用户参与的所有工作区及其角色。会话建立后前端用它渲染工作区列表。 */
export function listMemberships(
  db: ServerDb,
  userId: UserId,
): readonly WorkspaceMemberRow[] {
  const rows = db
    .prepare(
      `SELECT workspace_id, user_id, role, created_at
         FROM ${SERVER_TABLES.workspaceMembers}
        WHERE user_id = ?
        ORDER BY created_at, workspace_id`,
    )
    .all(userId) as RawMemberRow[]
  return rows.map(toMember)
}

export function upsertMember(
  db: ServerDb,
  workspaceId: WorkspaceId,
  userId: UserId,
  role: WorkspaceRole,
  at: UtcTimestamp,
): WorkspaceMemberRow {
  db.prepare(
    `INSERT INTO ${SERVER_TABLES.workspaceMembers} (workspace_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`,
  ).run(workspaceId, userId, role, at)

  const member = findMember(db, workspaceId, userId)
  if (member === null) {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '成员写入后无法读回，数据库可能不可用。',
      requestId: newIds.request(),
    })
  }
  return member
}

export function removeMember(db: ServerDb, workspaceId: WorkspaceId, userId: UserId): boolean {
  const info = db
    .prepare(
      `DELETE FROM ${SERVER_TABLES.workspaceMembers} WHERE workspace_id = ? AND user_id = ?`,
    )
    .run(workspaceId, userId)
  return info.changes === 1
}

/**
 * 统计工作区里的 owner 数量。
 *
 * 用途：设计文档 07 要求"最后所有者不可误删"。删除/降级成员前先查这个数，
 * 如果结果是 1 且目标就是那个 owner，必须拒绝（`STATE_INVALID_TRANSITION`）。
 */
export function countOwners(db: ServerDb, workspaceId: WorkspaceId): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${SERVER_TABLES.workspaceMembers}
        WHERE workspace_id = ? AND role IN ('admin', 'owner')`,
    )
    .get(workspaceId) as { count: number }
  return row.count
}
