/**
 * 权限判定。
 *
 * 设计依据（`04-后端与安全.md`）：
 * - 角色与资源范围**一起**判定；
 * - **所有查询、对象下载、游标、任务订阅和写入均重新鉴权**；
 * - 插件令牌与设备令牌**不能越过工作区边界**；
 * - 客户端**不能提交自报 issuer / 角色**，授权主体一律由服务端会话产生。
 *
 * ## 为什么权限矩阵不写在这里
 *
 * `canWrite` / `canManageMembers` / `canRunRemoteCommand` 在 `@yfe/contracts`
 * 的 `entities` 里已经定义且被契约测试覆盖。服务端再写一份就是**两个真相源**，
 * 改一处漏一处，而漏的那处通常是"少了一条拒绝规则"（fail open）。
 * 所以本文件只做三件事：**取角色、判范围、判属性**，矩阵一律转发给契约。
 *
 * ## 为什么每个请求都回表查角色
 *
 * 把角色塞进会话 Cookie 或内存缓存是常见优化，但它会把"降权"延迟到
 * 会话过期才生效：管理员把某人从 editor 降为 viewer 后，对方仍能写 14 天。
 * 一次主键点查的成本（微秒级）远低于这个风险，所以**不缓存**。
 */

import { ContractError, canManageMembers, canRunRemoteCommand, canWrite } from '@yfe/contracts'
import type {
  DeviceId,
  RequestId,
  UserId,
  UtcTimestamp,
  WorkspaceId,
  WorkspaceRole,
} from '@yfe/contracts'

import { findMember } from '../db/members.js'
import { findUserById } from '../db/users.js'
import type { DeviceRow } from '../db/devices.js'
import type { ServerDb } from '../db/open.js'
import type { SessionRow } from '../db/sessions.js'

/**
 * 认证后的请求主体。
 *
 * 🔴 这个结构体**只能由服务端会话/设备鉴权构造**。
 * 任何从请求体、查询串或请求头里读 `role` / `userId` 的代码路径都是提权漏洞，
 * 因此没有 `principalFromRequest(body)` 这类便捷函数——故意的。
 */
export interface Principal {
  readonly userId: UserId
  /** 用户在当前工作区里的角色。不属于任何工作区时为 `null`。 */
  readonly role: WorkspaceRole | null
  /** 该主体绑定的工作区范围。系统管理员为 `null`（不限范围）。 */
  readonly workspaceId: WorkspaceId | null
  readonly via: 'session' | 'device'
  readonly sessionId: string | null
  readonly deviceId: DeviceId | null
}

/** 从会话构造主体。**唯一**合法的入口。 */
export function principalFromSession(
  db: ServerDb,
  session: SessionRow,
  workspaceId: WorkspaceId | null,
  requestId: RequestId = `req_principal` as RequestId,
): Principal {
  const user = findUserById(db, session.userId)
  if (user === null) {
    throw new ContractError({
      code: 'AUTH_REQUIRED',
      message: '会话对应的用户不存在，请重新登录。',
      requestId,
    })
  }
  if (user.disabled) {
    throw new ContractError({
      code: 'AUTH_REQUIRED',
      message: '账号已被停用。',
      requestId,
    })
  }
  // 角色来自数据库，**不接受调用方传入**。
  const role =
    workspaceId === null ? null : (findMember(db, workspaceId, user.id)?.role ?? null)
  return {
    userId: user.id,
    role,
    workspaceId,
    via: 'session',
    sessionId: session.id,
    deviceId: null,
  }
}

/** 从设备构造主体。设备的工作区是**码绑定的**，不取自请求。 */
export function principalFromDevice(db: ServerDb, device: DeviceRow): Principal {
  const role =
    device.workspaceId === null
      ? null
      : (findMember(db, device.workspaceId, device.userId)?.role ?? null)
  return {
    userId: device.userId,
    role,
    workspaceId: device.workspaceId,
    via: 'device',
    sessionId: null,
    deviceId: device.id,
  }
}

/**
 * 判定主体是否属于某个工作区，并返回其中重新查得的角色。
 *
 * 🔴 这是"所有查询重新鉴权"的落点：即使外层已经鉴权过一次，
 * 内层服务函数也应该拿 `principal` + `workspaceId` 再调一次，
 * 因为工作区是从**路径参数**来的，而路径参数可以被任意替换。
 */
export interface WorkspaceAccess {
  readonly workspaceId: WorkspaceId
  readonly role: WorkspaceRole
}

export function resolveWorkspaceAccess(
  db: ServerDb,
  principal: Principal,
  workspaceId: WorkspaceId,
  requestId: RequestId,
): WorkspaceAccess {
  const member = findMember(db, workspaceId, principal.userId)
  if (member === null) {
    // 🔴 用 PERMISSION_DENIED 而不是 NOT_FOUND：一致性上，前者会泄漏
    // "这个工作区存在"这一事实。但反过来（用 NOT_FOUND 掩盖存在性）会让
    // 合法用户看到"工作区不存在"而误以为数据丢了。设计文档 07 的首版 API
    // 把工作区列表限定为"自己参与的"，所以存在性泄漏面很小；
    // 这里选择**明确报权限问题**，让用户知道该去要授权而不是去找丢失的数据。
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '你不是该工作区的成员，无权执行此操作。',
      requestId,
      detail: { workspaceId },
    })
  }
  if (member.role === 'viewer' && member.workspaceId !== workspaceId) {
    // 不可达（findMember 已按 workspaceId 过滤），保留作为结构与意图说明。
    throw new ContractError({
      code: 'PERMISSION_WORKSPACE_MISMATCH',
      message: '该令牌不能越过工作区边界。',
      requestId,
      detail: { workspaceId },
    })
  }
  return { workspaceId, role: member.role }
}

// ---------------------------------------------------------------------------
// 能力断言（矩阵转发给契约）
// ---------------------------------------------------------------------------

/** 是否可写（编辑/同步/提交变更）。`viewer` 一律拒绝。 */
export function assertCanWrite(access: WorkspaceAccess, requestId: RequestId): void {
  if (!canWrite(access.role)) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '当前角色只能查看与下载，不能提交变更。',
      requestId,
      detail: { role: access.role, required: 'admin | owner | editor' },
    })
  }
}

/** 是否可管理成员（增删成员、改角色）。 */
export function assertCanManageMembers(access: WorkspaceAccess, requestId: RequestId): void {
  if (!canManageMembers(access.role)) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '只有工作区所有者或系统管理员可以管理成员。',
      requestId,
      detail: { role: access.role, required: 'admin | owner' },
    })
  }
}

/** 是否可下发远程命令。 */
export function assertCanRunRemoteCommand(access: WorkspaceAccess, requestId: RequestId): void {
  if (!canRunRemoteCommand(access.role)) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '当前角色不能下发远程命令。',
      requestId,
      detail: { role: access.role, required: 'admin | owner' },
    })
  }
}

/**
 * 设备令牌不能越过工作区边界。
 *
 * 🔴 这条规则独立于角色：即使某人在 ws_A 是 owner，他拿 ws_A 的设备凭据
 * 也不能操作 ws_B。设计文档 04 明文要求"插件令牌与设备令牌不能越过工作区边界"。
 */
export function assertDeviceWithinWorkspace(
  principal: Principal,
  workspaceId: WorkspaceId,
  requestId: RequestId,
): void {
  if (principal.via !== 'device') return
  if (principal.workspaceId !== null && principal.workspaceId !== workspaceId) {
    throw new ContractError({
      code: 'PERMISSION_WORKSPACE_MISMATCH',
      message: '该设备凭据的授权范围不包含此工作区。',
      requestId,
      detail: { workspaceId },
    })
  }
}

/**
 * 能否操作目标设备。
 *
 * 规则（按设计文档 04 的角色表）：
 * - **自己的设备**：本人即可（重命名、撤销自己的设备）；
 * - **工作区范围内的他人设备**：需要该工作区的 admin/owner。
 *
 * 🔴 `target.workspaceId === null`（个人设备）时，**只有 owner 本人**能动它。
 * 否则任何管理员都能借"工作区管理"之名撤销别人的个人设备。
 */
export function assertCanManageDevice(
  db: ServerDb,
  principal: Principal,
  target: DeviceRow,
  requestId: RequestId,
): void {
  if (target.userId === principal.userId) return

  if (target.workspaceId === null) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '无权管理他人的个人设备。',
      requestId,
      detail: { deviceId: target.id },
    })
  }
  const member = findMember(db, target.workspaceId, principal.userId)
  if (member === null || !canManageMembers(member.role)) {
    throw new ContractError({
      code: 'PERMISSION_DENIED',
      message: '只有该工作区的所有者或系统管理员可以管理范围内的设备。',
      requestId,
      detail: { deviceId: target.id },
    })
  }
}

/**
 * 防止"误禁用最后一个管理员"。
 *
 * 设计文档 07 明文要求。没有这条规则，一次点击就能让服务器进入
 * **没有任何人能登录管理**的状态，而恢复需要手工改数据库。
 *
 * @param activeAdminCount 变更后仍将保持启用状态的管理员数量（调用方算好）
 */
export function assertNotLastAdmin(
  activeAdminCountAfterChange: number,
  requestId: RequestId,
): void {
  if (activeAdminCountAfterChange < 1) {
    throw new ContractError({
      code: 'STATE_INVALID_TRANSITION',
      message: '不能停用或降级最后一个系统管理员，否则将无人可以管理服务器。',
      requestId,
      detail: { activeAdminCount: activeAdminCountAfterChange },
    })
  }
}

/**
 * 防止"误删最后一个所有者"。
 *
 * 与上一个函数分开命名是刻意的：管理员是**系统级**角色（在 `users.disabled`），
 * 所有者是**工作区级**角色（在 `workspace_members.role`）。
 * 把两者混成一个 "assertNotLastPrivileged" 会让调用方搞不清该传哪个计数，
 * 而传错计数不会报错，只会让保护静默失效。
 */
export function assertNotLastOwner(
  ownerCountAfterChange: number,
  workspaceId: WorkspaceId,
  requestId: RequestId,
): void {
  if (ownerCountAfterChange < 1) {
    throw new ContractError({
      code: 'STATE_INVALID_TRANSITION',
      message: '不能移除工作区的最后一个所有者，请先指定新的所有者。',
      requestId,
      detail: { workspaceId, ownerCount: ownerCountAfterChange },
    })
  }
}

/**
 * 权限拒绝的审计记录构造。
 *
 * 被拒绝的尝试必须留痕：一次权限拒绝可能是客户端 bug，也可能是**有人在探测**。
 * 只有留痕才能把后者从日志噪声里分辨出来。
 */
export interface DeniedAttempt {
  readonly at: UtcTimestamp
  readonly principalUserId: UserId | null
  readonly workspaceId: WorkspaceId | null
  readonly action: string
  readonly requestId: RequestId
  readonly clientIp: string | null
}
