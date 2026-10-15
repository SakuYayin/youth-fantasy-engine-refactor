/**
 * 设备管理 + 设备凭据兑换（`/api/v1/devices/*`、`/api/v1/workspaces/:workspaceId/devices*`）。
 *
 * ## 两道鉴权，缺一不可
 *
 * 1. **路由守卫**（`preHandler`）：会话路由用 `deps.guards.requireWorkspaceAccess(...)`；
 * 2. **处理器内再授权**：`authorizeWorkspaceAccess(deps, request, workspaceId, action)`。
 *    守卫只负责"有没有身份 / 能不能进这个工作区"，真正要操作哪个 `workspaceId`
 *    以 **处理器里解析出来的值** 为准；两处都用同一个值再判一次，防止将来有人改动
 *    守卫参数（例如放宽 action）时静默提权。
 *
 * 唯一没有也**不能有**会话守卫的是 `POST /api/v1/devices/pair`：它的入参就是凭据本身
 * （一次性配对码），等价于 `/api/v1/auth/login`。它不需要会话，但需要 pepper。
 *
 * ## 绝不回传的秘密
 *
 * `devices` 表里的 `token_hash`、`pairing_codes` 表里的 `code_hash`、配对码明文
 * **都不出现在任何响应里**：响应对象由 `toDeviceSummary` 逐字段白名单挑出，
 * 而不是 `{...row}`。设备令牌明文只在 `POST /devices/pair` 的**那一次**响应里出现。
 */

import { ContractError } from '@yfe/contracts'
import type { DeviceId, RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { assertCanManageDevice } from '../auth/permission.js'
import { redeemPairingCode } from '../auth/pairing.js'
import type { DeviceRow } from '../db/devices.js'
import { findDeviceById, listDevicesForWorkspace, renameDevice, revokeDevice } from '../db/devices.js'
import type { ServerDb } from '../db/open.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { requireWellFormedId } from '../sync/protocol.js'
import { resolvePairingPepper } from './pairingCodes.js'
import type { PairingSecretSource } from './pairingCodes.js'

/** 设备名长度上限：与 `ddl.ts` 的 CHECK 只要求非空，这里给一个防滥用的合理上限。 */
const DEVICE_NAME_MAX = 120
const PLATFORM_MAX = 64
const REVOKE_REASON_MAX = 200

export interface DeviceRouteDeps extends PairingSecretSource {
  readonly db: ServerDb
  readonly policy: PermissionDeps['policy']
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
}

/**
 * 设备 → 响应对象（**白名单**）。
 *
 * 🔴 故意不包含 `tokenHash`：`DeviceRow` 里没有它，但 `DeviceWithCredential` 有，
 * 这里用显式字段列表把这条路封死——将来谁把 `DeviceWithCredential` 传进来也不会泄漏。
 */
function toDeviceSummary(row: DeviceRow): Record<string, unknown> {
  return {
    deviceId: row.id,
    userId: row.userId,
    workspaceId: row.workspaceId,
    name: row.name,
    platform: row.platform,
    pairingCodeId: row.pairingCodeId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    revoked: row.revokedAt !== null,
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

const DEVICE_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'deviceId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const PATCH_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: DEVICE_NAME_MAX },
  },
} as const

// `null` 放行：DELETE 通常不带请求体，而 Fastify 5 会把"没有 body"当成 `null`
// 喂给校验器 —— 只写 `'object'` 会让不带 body 的撤销变成 400。
const REVOKE_BODY_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: REVOKE_REASON_MAX },
  },
} as const

const PAIR_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'deviceName'],
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 64 },
    deviceName: { type: 'string', minLength: 1, maxLength: DEVICE_NAME_MAX },
    platform: { type: 'string', minLength: 1, maxLength: PLATFORM_MAX },
    // 可选：客户端**声明**自己要配对进哪个工作区。服务端会拿它和配对码所属工作区
    // 比对（不等 → PERMISSION_WORKSPACE_MISMATCH）；设备最终落在哪个工作区
    // **只取决于配对码那一行**，永远不取决于这个字段。
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  return requireWellFormedId(raw, 'workspaceId', requestId) as WorkspaceId
}

function deviceIdOf(request: FastifyRequest, requestId: RequestId): DeviceId {
  const raw = (request.params as { deviceId?: string }).deviceId
  return requireWellFormedId(raw, 'deviceId', requestId) as DeviceId
}

function requiredString(requestId: RequestId, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContractError({
      code: 'VALIDATION_MISSING_FIELD',
      message: `缺少必填字段：${field}`,
      requestId,
      detail: { field },
    })
  }
  return value.trim()
}

/** 找到"属于本工作区"的设备；不存在或不属于本工作区都返回 `null`（避免探测他人设备 id）。 */
function findWorkspaceDevice(db: ServerDb, deviceId: DeviceId, workspaceId: WorkspaceId): DeviceRow | null {
  const device = findDeviceById(db, deviceId)
  if (device === null) return null
  return device.workspaceId === workspaceId ? device : null
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DeviceRouteDeps): void {
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }

  // ------------------------------------------------------------ 列表
  app.get(
    '/api/v1/workspaces/:workspaceId/devices',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }),
      schema: { params: WORKSPACE_PARAMS_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')

      const items = listDevicesForWorkspace(deps.db, workspaceId).map(toDeviceSummary)
      // 列表里 **没有** token_hash，也没有任何配对码明文。
      return reply.status(200).header('cache-control', 'no-store').send({ items })
    },
  )

  // ------------------------------------------------------------ 重命名
  app.patch(
    '/api/v1/workspaces/:workspaceId/devices/:deviceId',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'manageMembers' }),
      schema: { params: DEVICE_PARAMS_SCHEMA, body: PATCH_BODY_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')
      const deviceId = deviceIdOf(request, requestId)

      const principal = currentPrincipal(request)
      const device = findWorkspaceDevice(deps.db, deviceId, workspaceId)
      if (device === null) {
        throw new ContractError({
          code: 'NOT_FOUND',
          message: '设备不存在。',
          requestId,
          detail: { deviceId },
        })
      }
      assertCanManageDevice(deps.db, principal, device, requestId)

      // 全空白名字在 schema 层是合法的（`minLength: 1`），到这一层再按 `trim` 后的
      // 结果判定：库里存一个看不见的名字比拒绝它更糟。
      const name = requiredString(requestId, (request.body as { name?: unknown }).name, 'name')
      if (name.length > DEVICE_NAME_MAX) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: `设备名最长 ${DEVICE_NAME_MAX} 个字符。`,
          requestId,
          detail: { field: 'name', maxLength: DEVICE_NAME_MAX },
        })
      }

      const renamed = renameDevice(deps.db, deviceId, name)
      if (!renamed) {
        // `renameDevice` 带 `revoked_at IS NULL`：已撤销的设备不允许改名。
        throw new ContractError({
          code: 'STATE_INVALID_TRANSITION',
          message: '设备已撤销，不能再改名。',
          requestId,
          detail: { deviceId },
        })
      }

      const updated = findDeviceById(deps.db, deviceId)
      deps.log?.({ level: 'info', event: 'device.renamed', requestId, workspaceId, deviceId })
      return reply.status(200).header('cache-control', 'no-store').send({
        device: updated === null ? null : toDeviceSummary(updated),
      })
    },
  )

  // ------------------------------------------------------------ 撤销
  app.delete(
    '/api/v1/workspaces/:workspaceId/devices/:deviceId',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'manageMembers' }),
      schema: { params: DEVICE_PARAMS_SCHEMA, body: REVOKE_BODY_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')
      const deviceId = deviceIdOf(request, requestId)

      const principal = currentPrincipal(request)
      const device = findWorkspaceDevice(deps.db, deviceId, workspaceId)
      if (device === null) {
        throw new ContractError({
          code: 'NOT_FOUND',
          message: '设备不存在。',
          requestId,
          detail: { deviceId },
        })
      }
      assertCanManageDevice(deps.db, principal, device, requestId)

      const body = (request.body ?? {}) as { reason?: string }
      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim()
        : 'revoked_by_user'

      // 幂等：`revokeDevice` 只在 `revoked_at IS NULL` 时写入，重复撤销不会覆盖
      // 第一次的 `revoked_at` / `revoked_reason`（零二次写入）。
      revokeDevice(deps.db, deviceId, deps.now(), reason)
      const updated = findDeviceById(deps.db, deviceId)
      deps.log?.({ level: 'info', event: 'device.revoked', requestId, workspaceId, deviceId })
      return reply.status(200).header('cache-control', 'no-store').send({
        deviceId,
        revoked: true,
        revokedAt: updated?.revokedAt ?? null,
        revokedReason: updated?.revokedReason ?? null,
      })
    },
  )

  // ------------------------------------------------------------ 配对（一次性配对码 → 设备令牌）
  //
  // 这一条 **没有会话守卫**：它就是"用配对码换设备身份"本身，等价于登录接口。
  // 安全性来自配对码（一次性、短期、有尝试上限、加 pepper 哈希）。
  app.post(
    '/api/v1/devices/pair',
    { schema: { body: PAIR_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const body = request.body as {
        code?: unknown
        deviceName?: unknown
        platform?: unknown
        workspaceId?: unknown
      }

      const code = requiredString(requestId, body.code, 'code')
      const deviceName = requiredString(requestId, body.deviceName, 'deviceName')
      if (deviceName.length > DEVICE_NAME_MAX) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: `设备名最长 ${DEVICE_NAME_MAX} 个字符。`,
          requestId,
          detail: { field: 'deviceName', maxLength: DEVICE_NAME_MAX },
        })
      }
      let platform: string | null = null
      if (body.platform !== undefined && body.platform !== null) {
        platform = requiredString(requestId, body.platform, 'platform')
      }

      // 客户端"声明"的工作区，只用于比对，不会写进 devices.workspace_id。
      const declaredWorkspaceId =
        body.workspaceId === undefined || body.workspaceId === null
          ? null
          : (requireWellFormedId(body.workspaceId, 'workspaceId', requestId) as WorkspaceId)

      const pepper = resolvePairingPepper(deps, requestId)
      const now = deps.now()

      const outcome = await redeemPairingCode(deps.db, {
        code,
        workspaceId: declaredWorkspaceId,
        deviceName,
        platform,
        at: now,
        pepper,
        requestId,
        clientIp: request.ip,
        // ⚠️ 已知降级：`redeemPairingCode` 要求**调用方**先按摘要查一次行才能知道
        // 码属于谁，从而判断用户是否已停用；那等于第二次 scrypt（本接口没有限流，
        // 不想把 CPU 成本翻倍）。这里传 false：最坏情况是给一个已停用用户建出一条
        // 永远不会被接受的设备行——`makeRequireDevice` 每次请求都会查
        // `users.disabled`，该设备令牌**立即不可用**（AUTH_REQUIRED）。安全性不受影响。
        userDisabled: false,
      })

      if (!outcome.ok) throw outcome.error

      deps.log?.({
        level: 'info',
        event: 'device.paired',
        requestId,
        deviceId: outcome.device.id,
        workspaceId: outcome.workspaceId,
        userId: outcome.device.userId,
      })

      // 🔴 设备令牌明文**只在这里出现一次**；库里只有 `token_hash`。
      return reply.status(201).header('cache-control', 'no-store').send({
        deviceId: outcome.device.id,
        token: outcome.deviceToken,
        workspaceId: outcome.workspaceId,
      })
    },
  )
}
