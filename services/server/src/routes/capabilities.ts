/**
 * `GET /api/v1/capabilities` —— 版本与能力发现。
 *
 * ## 为什么这里没有"未认证也能读"的例外
 *
 * 协议文档 07 的能力表只写了"不返回内部路径和秘密"，没写"公开"。而本仓库的
 * `routes/index.ts` 硬规则是**每个新路由必须挂 guard**——历史上一条漏挂
 * `requireSession` 的路由连 CSRF 都不校验、状态码却完全正常。所以这里挂
 * `requireSession`：能力发现发生在配对/登录**之后**。若后续要让设备在配对前
 * 探测能力，需要在配对流程里单独开一条受限端点，而不是把这条路由改成匿名。
 *
 * ## 上报的上限必须等于执行的上限
 *
 * 文档 07："P0 按样本确定正式上限并由 capabilities 返回，**所有客户端遵守**。"
 * 因此 `maxBatchBytes` 取 `min(SYNC_LIMITS.maxBatchBytes, config.bodyLimitBytes)`：
 * 运维把 `YFE_BODY_LIMIT_BYTES` 调小以后，Fastify 会在进路由之前就 413，
 * 此时如果 capabilities 仍然报 4 MiB，客户端就会按一个服务端根本收不下的上限分片。
 *
 * `assets.partSizeBytes` 同理取 `min(SYNC_ASSETS.partSizeBytes, bodyLimitBytes)`：
 * 默认值恰好是 8 MiB 分片 vs 4 MiB 传输上限，照上报值切分片必被 413（R-41）。
 */

import { SYNC_PROTOCOL_VERSION } from '@yfe/contracts'
import type { CapabilitiesOutput } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { PermissionGuards } from '../permission/index.js'
import { MIN_CLIENT_MAJOR, SYNC_ASSETS, SYNC_LIMITS, SUPPORTED_COMMANDS } from '../sync/protocol.js'

export interface CapabilitiesDeps {
  readonly serverId: string
  /** 传输层请求体上限（`config.bodyLimitBytes`），用来把对外上限收窄到真实可收范围。 */
  readonly bodyLimitBytes: number
  readonly guards: PermissionGuards
}

export function registerCapabilitiesRoute(app: FastifyInstance, deps: CapabilitiesDeps): void {
  app.get(
    '/api/v1/capabilities',
    { preHandler: deps.guards.requireSession },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const output: CapabilitiesOutput = {
        serverId: deps.serverId,
        protocolVersion: { major: SYNC_PROTOCOL_VERSION.major, minor: SYNC_PROTOCOL_VERSION.minor },
        minClientMajor: MIN_CLIENT_MAJOR,
        limits: {
          maxOperationsPerBatch: SYNC_LIMITS.maxOperationsPerBatch,
          maxBatchBytes: Math.min(SYNC_LIMITS.maxBatchBytes, deps.bodyLimitBytes),
          maxOrderKeyLength: SYNC_LIMITS.maxOrderKeyLength,
        },
        assets: {
          enabled: SYNC_ASSETS.enabled,
          partSizeBytes: Math.min(SYNC_ASSETS.partSizeBytes, deps.bodyLimitBytes),
          maxAssetBytes: SYNC_ASSETS.maxAssetBytes,
        },
        commands: SUPPORTED_COMMANDS,
        readOnly: false,
      }
      return reply.status(200).header('cache-control', 'no-store').send(output)
    },
  )
}
