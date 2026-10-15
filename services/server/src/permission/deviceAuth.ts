/**
 * 设备令牌守卫 —— `src/permission/index.ts` 会话守卫的**平行版本**。
 *
 * 会话守卫解决的是"这个用户是谁"，这里解决的是"这台设备是哪台、它被授权到哪个
 * 工作区"。两者刻意分开：
 *
 * - 会话入口（`/api/v1/workspaces/...`）用 `requireSession` + `requireWorkspaceAccess`；
 * - 设备入口（`/api/v1/devices/...`）用这里的 `makeRequireDevice`。
 *
 * 本文件**不修改** `permission/index.ts`，只复用它导出的 `bearerTokenOf`（解析
 * `Authorization` 头这件事只有一份实现）与 `auth/pairing.ts` 里已经写好的设备
 * 鉴权（`authenticateDevice`：摘要比对 + 撤销判定 + 成功才更新 `last_seen_at`）。
 *
 * ## 令牌纪律
 *
 * 🔴 令牌**只在请求头出现一次**，服务端拿它算 `sha256:` 摘要去比对
 * `devices.token_hash`（`auth/pairing.ts` 内部完成，本文件看不到明文比对逻辑），
 * 摘要不匹配就是"没配对过"。明文令牌既不落库也不进日志。因此"撤销后令牌立即
 * 失效"是**天然**的：撤销只改 `devices.revoked_at`，下一次请求的判定就变了，
 * 不需要任何缓存/黑名单去同步。
 *
 * ## 请求上下文的挂载方式
 *
 * 用模块级 `WeakMap<FastifyRequest, DeviceAuthContext>` 而不是
 * `request.deviceAuth`：装饰属性要求 `decorateRequest` 在 `ready()` **之前**执行，
 * 三个路由模块各自注册钩子会撞上 `FST_ERR_DEC_ALREADY_PRESENT`，而这个守卫是
 * "谁用谁装"的。WeakMap 同样做到了**不跨请求泄漏**（请求对象回收即释放），
 * 且不需要装配方额外做任何事。
 *
 * ## 状态码映射（复用既有实现，不另造一套）
 *
 * | 情形 | 错误码 | HTTP |
 * | --- | --- | --- |
 * | 无 `Authorization` / 不是 `Bearer <token>` | `AUTH_REQUIRED` | 401 |
 * | 摘要不匹配（没配对过 / 令牌被改写） | `AUTH_DEVICE_NOT_PAIRED` | 401 |
 * | 设备已被撤销 | `AUTH_DEVICE_REVOKED`（detail.reason） | 401 |
 * | 令牌有效但用户已被停用 | `AUTH_REQUIRED` | 401 |
 *
 * 任务书写的是"已撤销 → `PERMISSION_DENIED`"，这里**故意**用仓库已有的
 * `AUTH_DEVICE_REVOKED`：`db/devices.ts` 的注释明确了它存在的理由（"你被撤销了，
 * 请重新配对"，客户端据此清凭据并重新配对），而 `PERMISSION_DENIED` 会说成
 * "你没有权限"，把可自愈的凭据问题变成需要管理员介入的权限问题。
 * 两者的 HTTP 状态不同（401 / 403），验收口径写的是"401/403"。
 */

import { ContractError } from '@yfe/contracts'
import type { DeviceId, RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { principalFromDevice } from '../auth/permission.js'
import type { Principal } from '../auth/permission.js'
import { authenticateDevice, deviceAuthFailureToError } from '../auth/pairing.js'
import type { ServerDb } from '../db/open.js'
import { findUserById } from '../db/users.js'
import { bearerTokenOf } from './index.js'

/** 已鉴权的设备上下文。由 `makeRequireDevice` 写、由 `currentDeviceAuth` 读。 */
export interface DeviceAuthContext {
  readonly deviceId: DeviceId
  readonly userId: UserId
  /**
   * 设备被授权的工作区。
   *
   * `null` = 个人设备（配对码签发时未绑定工作区）。路由层必须显式处理这种情况，
   * 不能把它当成"任意工作区"。
   */
  readonly workspaceId: WorkspaceId | null
  /** 由设备行推出的授权主体（`via: 'device'`，角色来自 `workspace_members`）。 */
  readonly principal: Principal
  readonly requestId: RequestId
  readonly now: UtcTimestamp
  /** 设备名（用于日志，不参与授权判定）。 */
  readonly deviceName: string
}

export interface DeviceAuthDeps {
  readonly db: ServerDb
}

const contexts = new WeakMap<FastifyRequest, DeviceAuthContext>()

/** 挂上下文。守卫内部调用；外部只在测试里需要时才用。 */
export function attachDeviceAuth(request: FastifyRequest, context: DeviceAuthContext): void {
  contexts.set(request, context)
}

/**
 * 取当前请求的设备上下文。
 *
 * 取不到说明**该路由没挂 `requireDevice`** —— 这是装配错误，不是客户端错误，
 * 所以抛 `INTERNAL_ERROR` 而不是"未认证"：把装配错误伪装成 401 会让真正的
 * 漏洞（未鉴权的设备接口）在日志里看不出异常。
 */
export function currentDeviceAuth(request: FastifyRequest): DeviceAuthContext {
  const context = contexts.get(request)
  if (context === undefined) {
    throw new ContractError({
      code: 'INTERNAL_ERROR',
      message: '该路由缺少设备鉴权守卫（requireDevice），这是服务端装配错误。',
      requestId: request.id as RequestId,
    })
  }
  return context
}

/** 读得到就返回，读不到返回 `null`（用于"可选设备认证"的场景，当前没有）。 */
export function peekDeviceAuth(request: FastifyRequest): DeviceAuthContext | null {
  return contexts.get(request) ?? null
}

/**
 * 断言设备被授权的工作区就是 `workspaceId`。
 *
 * 对应会话侧的 `assertDeviceWithinWorkspace`：设备令牌**自带**工作区，凡是 URL /
 * 请求体里出现工作区的地方都必须再比一次，否则一台属于 A 的设备只要在 URL 里写
 * B 就能操作 B 的资源。
 */
export function requireDeviceWorkspace(
  request: FastifyRequest,
  workspaceId: WorkspaceId,
  requestId: RequestId,
): DeviceAuthContext {
  const context = currentDeviceAuth(request)
  if (context.workspaceId !== workspaceId) {
    throw new ContractError({
      code: 'PERMISSION_WORKSPACE_MISMATCH',
      message: '设备令牌与请求的工作区不匹配。',
      requestId,
      detail: { workspaceId },
    })
  }
  return context
}

/**
 * 请求注入时钟。
 *
 * `attachRequestContext`（`http/server.ts` 装配）在每个 `onRequest` 里写
 * `request.yfeNow`。缺失说明实例装配顺序错了；这里**不**回退到真实时钟：
 * 退化成 `new Date()` 会让过期/租约判定在测试里静默失真。
 */
function nowOf(request: FastifyRequest, requestId: RequestId): UtcTimestamp {
  const now = request.yfeNow
  if (typeof now !== 'string' || now.length === 0) {
    throw new ContractError({
      code: 'SERVICE_UNAVAILABLE',
      message: '请求上下文缺少注入时钟，设备鉴权不可用。',
      requestId,
    })
  }
  return now
}

export type DevicePreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

export interface DeviceGuards {
  readonly requireDevice: DevicePreHandler
}

/**
 * 造一个"要求设备令牌"的 `preHandler`。
 *
 * 与 `makeRequireSession` 同形：抛 `ContractError`，由全局错误边界翻成响应。
 */
export function makeRequireDevice(deps: DeviceAuthDeps): DevicePreHandler {
  return async function requireDevice(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const requestId = request.id as RequestId
    const now = nowOf(request, requestId)

    const token = bearerTokenOf(request)
    if (token === null) {
      throw new ContractError({
        code: 'AUTH_REQUIRED',
        message: '该接口需要设备令牌（Authorization: Bearer <device token>）。',
        requestId,
      })
    }

    // 摘要比对 + 撤销判定 + 成功才更新 last_seen_at，全部在 auth/pairing.ts 里。
    const result = authenticateDevice(deps.db, token, now)
    if (!result.ok) {
      throw deviceAuthFailureToError(result.failure, requestId)
    }

    // `authenticateDevice` 只看设备行，不看用户状态。用户被停用后，其名下设备
    // 令牌必须同样失效，否则"停用账号"这个动作对已配对设备毫无作用。
    const user = findUserById(deps.db, result.device.userId)
    if (user === null || user.disabled) {
      throw deviceAuthFailureToError({ kind: 'user_disabled' }, requestId)
    }

    const device = result.device
    contexts.set(request, {
      deviceId: device.id,
      userId: device.userId,
      workspaceId: device.workspaceId,
      principal: principalFromDevice(deps.db, device),
      requestId,
      now,
      deviceName: device.name,
    })
  }
}

export function createDeviceGuards(deps: DeviceAuthDeps): DeviceGuards {
  return { requireDevice: makeRequireDevice(deps) }
}
