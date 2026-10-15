/**
 * 系统管理面仓储：谁在管理这台服务器。
 *
 * ## 为什么"系统管理员"不在 `users` 表里
 *
 * 设计文档 04 的权限模型区分**系统级角色**与**工作区级角色**：系统管理员管
 * 服务设置、用户、存储与运维；工作区所有者管成员与工作区配置。`users` 表上
 * 刻意**没有** `is_admin` 列——系统管理员是"这台服务器的所有者"，唯一真相源是
 * `server_state.owner_user_id`（`ddl.ts` 里 `server_state` 是单行表，
 * `CHECK (id = 1)`）。多一份 `users.is_admin` 就会多一个能与它对不上的真相，
 * 而两者不一致时没人能说清哪份是对的。
 *
 * ## 仓储层不做鉴权，只回答事实
 *
 * 这里只提供"某个 userId 是不是系统管理员"之类的**事实查询**与一个断言函数；
 * 403 的响应形状、审计与日志由路由层决定。这样`db/*` 保持可被任何调用方复用，
 * 而"非管理员必须 403 而不是 404"这类**接口语义**只写在 HTTP 边界上。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UserId } from '@yfe/contracts'

import type { ServerDb } from './open.js'
import { readServerState } from './serverState.js'
import { findUserById } from './users.js'

/**
 * 当前系统管理员的 userId。
 *
 * `null` 有两种可能，对调用方是同一件事（服务器还没有管理员）：服务尚未初始化
 * （`initialized_at IS NULL` 时 `owner_user_id` 必然为 `NULL`，表上有 CHECK 约束），
 * 或者确实读不到行——后者 `readServerState` 会先抛异常，不会被当成 null。
 */
export function systemAdminUserId(db: ServerDb): UserId | null {
  return readServerState(db)?.ownerUserId ?? null
}

export function isSystemAdmin(db: ServerDb, userId: UserId): boolean {
  return systemAdminUserId(db) === userId
}

/**
 * 断言调用者是系统管理员，否则抛 `PERMISSION_DENIED`（HTTP 403）。
 *
 * 🔴 用 403 而不是 404：`/api/v1/admin/*` 的存在不是秘密（客户端的导航与文档都
 * 写着它），用 404 掩盖只会让管理员以为"接口没部署"，把一次权限问题排查成运维
 * 问题。这里的 `detail.reason` 只说明"缺少系统管理员身份"，不透露任何用户数据。
 */
export function requireSystemAdmin(db: ServerDb, userId: UserId, requestId: RequestId): void {
  if (isSystemAdmin(db, userId)) return
  throw new ContractError({
    code: 'PERMISSION_DENIED',
    message: '只有系统管理员可以访问管理接口。',
    requestId,
    detail: { reason: 'system_admin_required' },
  })
}

/**
 * 变更后仍将保持**启用**的系统管理员数量（把 `disabledUserId` 当作已被停用）。
 *
 * 给 `auth/permission.ts` 的 `assertNotLastAdmin(activeAdminCountAfterChange, ...)`
 * 用。首版系统管理员唯一，所以：
 * - `disabledUserId` 就是当前管理员 → 返回 0 → 停用被拒（"不能停用最后一个管理员"）；
 * - 目标不是管理员 → 返回 1（管理员的启用状态没变）→ 不误拦。
 *
 * 之所以单独成函数而不是写死 `1`：将来若支持多个系统管理员，判定逻辑只需要改这里，
 * 而路由层的保护语句一个字都不用动。
 */
export function countEnabledSystemAdminsAfterChange(
  db: ServerDb,
  disabledUserId: UserId,
): number {
  const ownerId = systemAdminUserId(db)
  if (ownerId === null) return 0
  if (ownerId === disabledUserId) return 0
  const owner = findUserById(db, ownerId)
  if (owner === null || owner.disabled) return 0
  return 1
}
