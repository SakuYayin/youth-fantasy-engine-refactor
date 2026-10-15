/**
 * 远程命令：**会话侧生成** + **设备侧领取/回执**。
 *
 * | 端点 | 身份 | 说明 |
 * | --- | --- | --- |
 * | `POST /api/v1/workspaces/:workspaceId/devices/:deviceId/commands` | 会话（`runRemoteCommand`） | 生成 |
 * | `POST /api/v1/devices/commands/claim` | 设备令牌（`makeRequireDevice`） | 领取（带租约） |
 * | `POST /api/v1/devices/commands/:commandId/ack` | 设备令牌（`makeRequireDevice`） | 回执（幂等） |
 *
 * ## issuer 只认服务端身份
 *
 * `remote_commands.issuer` 一律写 `currentPrincipal(request).userId`。请求体里如果带了
 * `issuer`（契约的 `RemoteCommand` 有这个字段，客户端容易照着回填），**服务端一律忽略它**：
 * schema 里显式声明只是为了不因为未知字段把请求打回 400，处理器从不读它。
 *
 * ## 为什么"领取"不是删除
 *
 * 见 `db/commands.ts`：`claim` 只是写 `claimed_by_device_id` + `lease_expires_at`。
 * 设备崩溃后租约到期，命令重新可领（`status='claimed'` 仍是可领状态之一）。
 *
 * ## executionId 不一致 → 409 `STATE_INVALID_TRANSITION`（**本文件选定的口径**）
 *
 * 首次领取时服务端把一个 `execution_id` 绑到命令上（设备可在领取请求里自带，否则服务端
 * 生成）。回执必须带同一个 `execution_id`：它标识"同一次执行"，防止某台设备把
 * **另一次执行**的结果写到这条命令上。不一致时选 409 而不是 403，因为调用方
 * **就是**这条命令的目标设备（有权限），出问题的只是命令状态与这次上报不匹配：
 * 403 会被误读成"越权"，409 才说得清"冲突的是状态"。
 */

import { ContractError, isUtcTimestamp, newIds } from '@yfe/contracts'
import type { DeviceId, RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { RemoteCommandType } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { DeviceRow } from '../db/devices.js'
import { findDeviceById } from '../db/devices.js'
import { ackRemoteCommand, claimRemoteCommand, DEFAULT_COMMAND_LEASE_MS, insertRemoteCommand, toRemoteCommand } from '../db/commands.js'
import type { RemoteCommandRow } from '../db/commands.js'
import type { ServerDb } from '../db/open.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { createDeviceGuards, currentDeviceAuth, requireDeviceWorkspace } from '../permission/deviceAuth.js'
import type { DeviceGuards } from '../permission/deviceAuth.js'
import { requireWellFormedId } from '../sync/protocol.js'

const COMMAND_TYPES: readonly RemoteCommandType[] = ['workflow.run', 'job.cancel', 'sync.trigger']
const EXECUTION_ID_MAX = 128
/** `args` 序列化后的上限：请求体上限已经卡了一次，这里再卡一次是为了防止
 *  「一个 4MB 的 job.cancel」把这条命令的 JSON 塞成设备侧的负担。 */
const ARGS_JSON_MAX = 64 * 1024

export interface CommandRouteDeps {
  readonly db: ServerDb
  readonly policy: PermissionDeps['policy']
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  /** 可注入；缺省用 `createDeviceGuards({ db })`（即 `makeRequireDevice`）。 */
  readonly deviceGuards?: DeviceGuards
  readonly log?: (line: Record<string, unknown>) => void
}

const WORKSPACE_DEVICE_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'deviceId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const COMMAND_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commandId'],
  properties: {
    commandId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const CREATE_COMMAND_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commandType', 'expiresAt'],
  properties: {
    commandType: { type: 'string', enum: [...COMMAND_TYPES] },
    args: { type: 'object' },
    expiresAt: { type: 'string', minLength: 1, maxLength: 64 },
    // 🔴 只为兼容"照着契约回填"的客户端而声明：服务端**从不读它**，
    // 真正的 issuer 来自会话（`currentPrincipal(request).userId`）。
    issuer: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const

// `null` 放行：领取可以不带任何 body（服务端自己生成 executionId）。
// Fastify 5 把"没有 body"当成 `null` 喂给校验器，只写 `'object'` 会误杀成 400。
const CLAIM_BODY_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    executionId: { type: 'string', minLength: 1, maxLength: EXECUTION_ID_MAX },
  },
} as const

const ACK_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['executionId', 'status'],
  properties: {
    // 路径里的 commandId 才是权威；这里声明只是为了"显式忽略或显式拒绝"，
    // 不让它掉进 `additionalProperties: false` 的 400 里（见处理器）。
    commandId: { type: 'string', minLength: 1, maxLength: 128 },
    executionId: { type: 'string', minLength: 1, maxLength: EXECUTION_ID_MAX },
    status: { type: 'string', enum: ['succeeded', 'failed'] },
    result: { type: 'object' },
    errorCode: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  return requireWellFormedId(
    (request.params as { workspaceId?: string }).workspaceId,
    'workspaceId',
    requestId,
  ) as WorkspaceId
}

function deviceIdOf(request: FastifyRequest, requestId: RequestId): DeviceId {
  return requireWellFormedId(
    (request.params as { deviceId?: string }).deviceId,
    'deviceId',
    requestId,
  ) as DeviceId
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validationError(requestId: RequestId, field: string, message: string): ContractError {
  return new ContractError({
    code: 'VALIDATION_FAILED',
    message,
    requestId,
    detail: { field },
  })
}

function ackView(row: RemoteCommandRow, duplicate: boolean): Record<string, unknown> {
  return {
    commandId: row.commandId,
    status: row.status,
    executionId: row.executionId,
    ackedAt: row.ackedAt,
    // 重复回执返回的 `result` / `errorCode` 是**库里原来那一份**（零二次写入）。
    result: row.result,
    errorCode: row.errorCode,
    duplicate,
  }
}

export function registerCommandRoutes(app: FastifyInstance, deps: CommandRouteDeps): void {
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const deviceGuards: DeviceGuards = deps.deviceGuards ?? createDeviceGuards({ db: deps.db })

  // ------------------------------------------------------------ 生成（会话）
  app.post(
    '/api/v1/workspaces/:workspaceId/devices/:deviceId/commands',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'runRemoteCommand' }),
      schema: { params: WORKSPACE_DEVICE_PARAMS_SCHEMA, body: CREATE_COMMAND_BODY_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      // 守卫判过一次；这里再判是为了拿到 access，并且保证"真正要操作的 workspaceId"
      // 与守卫看到的是同一个（跨工作区 → 403 PERMISSION_DENIED / PERMISSION_WORKSPACE_MISMATCH）。
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'runRemoteCommand')
      const deviceId = deviceIdOf(request, requestId)

      const device: DeviceRow | null = findDeviceById(deps.db, deviceId)
      if (device === null || device.workspaceId !== workspaceId) {
        throw new ContractError({
          code: 'NOT_FOUND',
          message: '设备不存在。',
          requestId,
          detail: { deviceId },
        })
      }
      if (device.revokedAt !== null) {
        throw new ContractError({
          code: 'STATE_INVALID_TRANSITION',
          message: '设备已撤销，不能再向它下发远程命令。',
          requestId,
          detail: { deviceId },
        })
      }

      const body = request.body as {
        commandType?: unknown
        args?: unknown
        expiresAt?: unknown
        issuer?: unknown
      }

      const commandType = body.commandType
      if (typeof commandType !== 'string' || !COMMAND_TYPES.includes(commandType as RemoteCommandType)) {
        throw validationError(requestId, 'commandType', `commandType 必须是 ${COMMAND_TYPES.join(' / ')} 之一。`)
      }

      let args: Readonly<Record<string, unknown>> = {}
      if (body.args !== undefined && body.args !== null) {
        if (!isPlainObject(body.args)) {
          throw validationError(requestId, 'args', 'args 必须是 JSON 对象。')
        }
        const encoded = JSON.stringify(body.args)
        if (encoded.length > ARGS_JSON_MAX) {
          throw new ContractError({
            code: 'VALIDATION_OUT_OF_RANGE',
            message: `args 序列化后最长 ${ARGS_JSON_MAX} 字节。`,
            requestId,
            detail: { field: 'args', maxBytes: ARGS_JSON_MAX },
          })
        }
        args = body.args
      }

      const now = deps.now()
      const rawExpiresAt = body.expiresAt
      if (typeof rawExpiresAt !== 'string' || !isUtcTimestamp(rawExpiresAt)) {
        throw validationError(requestId, 'expiresAt', 'expiresAt 必须是 UTC ISO 时间戳。')
      }
      if (Date.parse(rawExpiresAt) <= Date.parse(now)) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: 'expiresAt 必须晚于当前时间。',
          requestId,
          detail: { field: 'expiresAt' },
        })
      }

      const principal = currentPrincipal(request)
      const row = insertRemoteCommand(deps.db, {
        commandId: newIds.request(),
        workspaceId,
        targetDeviceId: deviceId,
        commandType: commandType as RemoteCommandType,
        args,
        // 🔴 只认会话身份。`body.issuer` 在这里**故意没有被读**。
        issuer: principal.userId,
        at: now,
        expiresAt: rawExpiresAt,
      })

      deps.log?.({
        level: 'info',
        event: 'remote_command.created',
        requestId,
        workspaceId,
        deviceId,
        commandId: row.commandId,
        commandType: row.commandType,
        issuer: row.issuer,
      })

      return reply.status(201).header('cache-control', 'no-store').send(toRemoteCommand(row))
    },
  )

  // ------------------------------------------------------------ 领取（设备）
  app.post(
    '/api/v1/devices/commands/claim',
    { preHandler: deviceGuards.requireDevice, schema: { body: CLAIM_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const deviceId = currentDeviceAuth(request).deviceId
      const body = (request.body ?? {}) as { executionId?: unknown }
      const executionId = body?.executionId === undefined || body.executionId === null
        ? null
        : requireWellFormedId(body.executionId, 'executionId', requestId)

      const claimed = claimRemoteCommand(deps.db, {
        deviceId,
        at: deps.now(),
        leaseTtlMs: DEFAULT_COMMAND_LEASE_MS,
        executionId,
      })

      if (claimed === null) {
        // 没活儿：**不是**错误，`command: null`（契约如此）。
        return reply.status(200).header('cache-control', 'no-store').send({
          command: null,
          leaseExpiresAt: null,
        })
      }

      // 不变量：命令的目标设备就是自己，命令的工作区必然等于设备自己的工作区
      // （否则说明有人绕过了 `issuer` 侧的工作区校验）。这里显式断言，
      // 让不变量万一被破坏时**大声**失败，而不是悄悄把跨工作区命令交给设备。
      requireDeviceWorkspace(request, claimed.command.workspaceId, requestId)

      deps.log?.({
        level: 'info',
        event: 'remote_command.claimed',
        requestId,
        deviceId,
        commandId: claimed.command.commandId,
      })

      return reply.status(200).header('cache-control', 'no-store').send({
        command: toRemoteCommand(claimed.command),
        leaseExpiresAt: claimed.leaseExpiresAt,
      })
    },
  )

  // ------------------------------------------------------------ 回执（设备）
  app.post(
    '/api/v1/devices/commands/:commandId/ack',
    { preHandler: deviceGuards.requireDevice, schema: { params: COMMAND_PARAMS_SCHEMA, body: ACK_BODY_SCHEMA } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const deviceId = currentDeviceAuth(request).deviceId
      const commandId = requireWellFormedId(
        (request.params as { commandId?: string }).commandId,
        'commandId',
        requestId,
      )

      const body = (request.body ?? {}) as {
        commandId?: unknown
        executionId?: unknown
        status?: unknown
        result?: unknown
        errorCode?: unknown
      }

      if (body.commandId !== undefined && body.commandId !== commandId) {
        throw validationError(requestId, 'commandId', 'body 里的 commandId 与路径不一致。')
      }

      const executionId = requireWellFormedId(body.executionId, 'executionId', requestId)
      const status = body.status
      if (status !== 'succeeded' && status !== 'failed') {
        throw validationError(requestId, 'status', 'status 只能是 succeeded / failed。')
      }

      let result: Readonly<Record<string, unknown>> | null = null
      if (body.result !== undefined && body.result !== null) {
        if (!isPlainObject(body.result)) {
          throw validationError(requestId, 'result', 'result 必须是 JSON 对象。')
        }
        result = body.result
      }
      const errorCode = typeof body.errorCode === 'string' && body.errorCode.length > 0 ? body.errorCode : null

      const outcome = ackRemoteCommand(deps.db, {
        commandId,
        deviceId,
        executionId,
        status,
        result,
        errorCode,
        at: deps.now(),
      })

      if (!outcome.ok) {
        switch (outcome.failure) {
          case 'not_found':
            throw new ContractError({
              code: 'NOT_FOUND',
              message: '远程命令不存在。',
              requestId,
              detail: { commandId },
            })
          case 'not_owned':
            // 命令不是发给自己的：这台设备无权回执。
            throw new ContractError({
              code: 'PERMISSION_DENIED',
              message: '该命令不是发给本设备的。',
              requestId,
              detail: { commandId },
            })
          case 'execution_mismatch':
          case 'invalid_state':
          default:
            throw new ContractError({
              code: 'STATE_INVALID_TRANSITION',
              message: outcome.failure === 'execution_mismatch'
                ? 'executionId 与首次领取时不一致。'
                : '命令当前状态不允许回执。',
              requestId,
              detail: { commandId, reason: outcome.failure },
            })
        }
      }

      deps.log?.({
        level: 'info',
        event: 'remote_command.acked',
        requestId,
        deviceId,
        commandId,
        status: outcome.command.status,
        duplicate: outcome.duplicate,
      })

      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .send(ackView(outcome.command, outcome.duplicate))
    },
  )
}
