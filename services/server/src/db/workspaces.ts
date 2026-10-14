/**
 * 工作区元数据仓库。
 *
 * ## 为什么工作区名字单独建表（而不是塞进 `workspace_members`）
 *
 * `workspace_members` 的语义是"谁在哪个工作区、什么角色"，一对多：工作区名字放进去
 * 就要在每个成员行上重复，改名时要么全表更新、要么出现"同一工作区两个名字"。
 * 版本 1 只建了成员表（当时没有工作区元数据需求），版本 2 补上 `workspaces`
 * 并回填历史数据（见 `./syncDdl.ts` 文件头）。
 *
 * ## 读取用 LEFT JOIN，宁可名字退化也绝不漏工作区
 *
 * `listWorkspacesForUser` 用 LEFT JOIN：万一某个工作区没有元数据行（例如手工导入的
 * 老库、回填被跳过），用户的成员关系仍然要出现在列表里——名字退化成工作区 ID 是
 * 可接受的降级，而"我明明是成员，列表却是空的"会被误当成鉴权故障，排查成本极高。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { UserId, UtcTimestamp, WorkspaceId, WorkspaceRole } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'
import { SYNC_TABLES } from './syncDdl.js'

export interface WorkspaceRow {
  readonly id: WorkspaceId
  readonly name: string
  readonly createdByUserId: UserId
  readonly authorityTargetId: string | null
  readonly deleted: boolean
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
}

/** 列表项：工作区元数据 + 该主体在其中的角色。 */
export interface WorkspaceMembershipSummary {
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly role: WorkspaceRole
  readonly createdAt: UtcTimestamp
}

export interface InsertWorkspaceInput {
  readonly id: WorkspaceId
  readonly name: string
  readonly createdByUserId: UserId
  readonly at: UtcTimestamp
}

const WORKSPACE_COLUMNS = 'id, name, created_by_user_id, authority_target_id, deleted, created_at, updated_at'

interface WorkspaceSqlRow {
  readonly id: string
  readonly name: string
  readonly created_by_user_id: string
  readonly authority_target_id: string | null
  readonly deleted: number
  readonly created_at: string
  readonly updated_at: string
}

function toWorkspace(row: WorkspaceSqlRow): WorkspaceRow {
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.created_at !== 'string') {
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '工作区记录损坏，缺少必要字段。',
    })
  }
  return {
    id: row.id as WorkspaceId,
    name: row.name,
    createdByUserId: row.created_by_user_id as UserId,
    authorityTargetId: row.authority_target_id,
    deleted: row.deleted !== 0,
    createdAt: row.created_at as UtcTimestamp,
    updatedAt: row.updated_at as UtcTimestamp,
  }
}

/** 插入工作区。ID 由调用方生成（与 `createUser` / `insertDevice` 的约定一致）。 */
export function insertWorkspace(db: ServerDb, input: InsertWorkspaceInput): WorkspaceRow {
  db.prepare(
    `INSERT INTO ${SYNC_TABLES.workspaces}
       (id, name, created_by_user_id, authority_target_id, deleted, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?)`,
  ).run(input.id, input.name, input.createdByUserId, input.at, input.at)

  const created = findWorkspace(db, input.id)
  if (created === null) {
    // 插入后读不到：只能是存储层异常。抛出来比返回一个假对象安全。
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      requestId: newIds.request(),
      message: '工作区写入后无法读回，数据库可能已损坏。',
    })
  }
  return created
}

export function findWorkspace(db: ServerDb, id: WorkspaceId): WorkspaceRow | null {
  const row = db
    .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM ${SYNC_TABLES.workspaces} WHERE id = ?`)
    .get(id) as WorkspaceSqlRow | undefined
  return row === undefined ? null : toWorkspace(row)
}

/**
 * 按主体列出其成员工作区。
 *
 * 排序用 `workspace_members.created_at`（加入顺序）+ 工作区 ID 兜底，保证分页/快照式
 * 读取的顺序稳定——列表顺序抖动会让客户端 UI 每次刷新都换位置。
 */
export function listWorkspacesForUser(db: ServerDb, userId: UserId): readonly WorkspaceMembershipSummary[] {
  const rows = db
    .prepare(
      `SELECT m.workspace_id AS workspaceId,
              COALESCE(w.name, m.workspace_id) AS name,
              m.role AS role,
              COALESCE(w.created_at, m.created_at) AS createdAt
         FROM ${SERVER_TABLES.workspaceMembers} m
         LEFT JOIN ${SYNC_TABLES.workspaces} w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND COALESCE(w.deleted, 0) = 0
        ORDER BY m.created_at ASC, m.workspace_id ASC`,
    )
    .all(userId) as readonly {
    readonly workspaceId: string
    readonly name: string
    readonly role: string
    readonly createdAt: string
  }[]

  return rows.map((row) => {
    if (typeof row.workspaceId !== 'string' || typeof row.role !== 'string') {
      throw new ContractError({
        code: 'STORAGE_CORRUPT',
        requestId: newIds.request(),
        message: '工作区成员记录损坏。',
      })
    }
    return {
      workspaceId: row.workspaceId as WorkspaceId,
      name: typeof row.name === 'string' ? row.name : row.workspaceId,
      // 角色文本的合法性由 `role CHECK` + `members.ts` 的 `toMember` 共同守；这里只透传。
      role: row.role as WorkspaceRole,
      createdAt: row.createdAt as UtcTimestamp,
    }
  })
}

/** 工作区数量（仅用于诊断/测试断言，不参与授权判定）。 */
export function countWorkspacesForUser(db: ServerDb, userId: UserId): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${SERVER_TABLES.workspaceMembers} WHERE user_id = ?`)
    .get(userId) as { readonly count?: number } | undefined
  return typeof row?.count === 'number' ? row.count : 0
}
