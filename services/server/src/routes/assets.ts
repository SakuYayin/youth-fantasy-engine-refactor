/**
 * 资产路由：**下载 / 软删 / 引用**。
 *
 * ```
 * GET    /api/v1/workspaces/:workspaceId/assets/:assetId
 * DELETE /api/v1/workspaces/:workspaceId/assets/:assetId
 * POST   /api/v1/workspaces/:workspaceId/assets/:assetId/refs
 * GET    /api/v1/workspaces/:workspaceId/assets/:assetId/refs
 * GET    /api/v1/workspaces/:workspaceId/asset-refs?entityType=&entityId=
 * ```
 *
 * ## 为什么 DELETE 要先看引用
 *
 * `asset_refs` 是"谁在用这个文件"的唯一记账。软删一个还有引用的资产，会让引用方
 * 拿到一个指向已删记录的 `assetId`——这类错误在远端很难定位，所以**宁可拒绝**：
 * 有引用 → `RESOURCE_LOCKED`（409），并把引用列表放进 `detail`，让调用方能自己
 * 决定"先解引用"还是"改设计"。没有引用才置 `deleted=1` + `deleted_at`。
 *
 * `detail` 的取值只能是 `string | number | boolean | null`（见
 * `packages/contracts/src/errors.ts` 的 `ErrorPayload`），**放不了数组**，所以
 * 引用列表以 JSON 字符串放在 `detail.refs`，同时给一个 `detail.refCount`。
 *
 * ## 幂等
 *
 * - 建引用：`INSERT OR IGNORE`，重复建返回 200（而不是 409），天然幂等；
 * - 软删：已删过再删返回 200，`deletedAt` 保持第一次的时间。
 *
 * ## 下载
 *
 * 读盘路径**只**由 `storage_key` 经 `storage.objectLocation()` 派生，而它会走
 * `paths.ts` 的逃逸检查；路由里没有任何拼接路径的地方，所以不管 `storage_key`
 * 被写成什么样（`..`、`C:\`、UNC、NUL），都到不了根目录之外。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { SessionPolicy } from '../auth/session.js'
import {
  countAssetRefs,
  deleteAssetRef,
  findAssetById,
  insertAssetRef,
  listAssetRefs,
  listAssetRefsForEntity,
  softDeleteAsset,
} from '../db/assets.js'
import type { AssetRefRow, AssetRow } from '../db/assets.js'
import type { ServerDb } from '../db/open.js'
import { authorizeWorkspaceAccess } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { requireWellFormedId } from '../sync/protocol.js'
import { createAssetStorage, toStorageContractError } from '../storage/index.js'
import type { UploadRouteDeps } from './uploads.js'

/**
 * 资产路由的装配形状**与上传路由完全一致**（含未使用的 `bodyLimitBytes`）。
 * 这样装配方可以用同一个 deps 对象把两组路由一次注册完，不会因为多/少一个字段
 * 在 `routes/index.ts` 里踩 excess-property 检查。
 */
export type AssetRouteDeps = UploadRouteDeps

/** `entity_type` 的形状：短、稳定、可读。 */
const ENTITY_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

const ASSET_PARAMS_SCHEMA = {
  type: 'object',
  required: ['workspaceId', 'assetId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    assetId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const CREATE_REF_BODY_SCHEMA = {
  type: 'object',
  required: ['entityType', 'entityId'],
  additionalProperties: false,
  properties: {
    entityType: { type: 'string', minLength: 1, maxLength: 64 },
    entityId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const ENTITY_QUERY_SCHEMA = {
  type: 'object',
  required: ['entityType', 'entityId'],
  properties: {
    entityType: { type: 'string', minLength: 1, maxLength: 64 },
    entityId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

interface CreateRefBody {
  readonly entityType: string
  readonly entityId: string
}

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  requireWellFormedId(raw, 'workspaceId', requestId)
  return raw as WorkspaceId
}

/** 资产摘要（与上传路由的返回体保持同一批字段）。 */
function assetSummary(
  asset: AssetRow,
  extra: Record<string, string | number | boolean | null> = {},
): Record<string, unknown> {
  return {
    assetId: asset.assetId,
    workspaceId: asset.workspaceId,
    storageKey: asset.storageKey,
    hashAlgorithm: asset.hashAlgorithm,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
    state: asset.state,
    deleted: asset.deleted === 1,
    verifiedAt: asset.verifiedAt,
    createdAt: asset.createdAt,
    ...extra,
  }
}

function refSummary(ref: AssetRefRow): Record<string, string> {
  return {
    assetId: ref.assetId,
    entityType: ref.entityType,
    entityId: ref.entityId,
    createdAt: ref.createdAt,
  }
}

/** `detail` 放不下数组，引用列表序列化成 JSON 字符串。 */
function refListDetail(refs: readonly AssetRefRow[]): Record<string, string | number> {
  return {
    refCount: refs.length,
    refs: JSON.stringify(refs.map((ref) => `${ref.entityType}:${ref.entityId}`)),
  }
}

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): void {
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const storage = createAssetStorage(deps.storageRoot)
  const log = deps.log ?? ((): void => {})

  const storageFailure = (error: unknown, requestId: RequestId, field: string): never => {
    const mapped = toStorageContractError(error, requestId, field)
    if (mapped === null) {
      throw error
    }
    log({ event: 'asset.storage_failure', requestId, field, code: mapped.code })
    throw mapped
  }

  const withStorage = <T>(requestId: RequestId, field: string, run: () => T): T => {
    try {
      return run()
    } catch (error) {
      return storageFailure(error, requestId, field)
    }
  }

  /** 取资产；不属于本工作区的资产一律当"不存在"（不泄漏存在性）。 */
  const requireAssetRow = (
    requestId: RequestId,
    assetId: string,
    workspaceId: WorkspaceId,
  ): AssetRow => {
    const asset = findAssetById(deps.db, assetId)
    if (asset === null || asset.workspaceId !== workspaceId) {
      throw new ContractError({
        code: 'NOT_FOUND_ATTACHMENT',
        message: '资产不存在。',
        requestId,
        detail: { assetId },
      })
    }
    return asset
  }

  const assetIdOf = (request: FastifyRequest, requestId: RequestId): string =>
    requireWellFormedId((request.params as { assetId?: string }).assetId, 'assetId', requestId)

  const requireEntityType = (value: unknown, requestId: RequestId): string => {
    if (typeof value !== 'string' || !ENTITY_TYPE_PATTERN.test(value)) {
      throw new ContractError({
        code: 'VALIDATION_FAILED',
        message: 'entityType 形状非法（1-64 位，字母开头，允许字母数字与 _ . : -）。',
        requestId,
        detail: { field: 'entityType' },
      })
    }
    return value
  }

  // -------------------------------------------------------------------------
  // 1. 下载（读盘）
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/workspaces/:workspaceId/assets/:assetId',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }),
      schema: { params: ASSET_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const assetId = assetIdOf(request, requestId)
      const asset = requireAssetRow(requestId, assetId, workspaceId)

      if (asset.deleted === 1) {
        // 软删之后字节可能还在盘上，但语义上这个资产已经不存在了。
        throw new ContractError({
          code: 'NOT_FOUND_ATTACHMENT',
          message: '资产已被删除。',
          requestId,
          detail: { assetId, deletedAt: asset.deletedAt },
        })
      }

      const byteSize = withStorage(requestId, 'storage_key', () =>
        storage.objectSizeOrNull(asset.storageKey),
      )
      if (byteSize === null) {
        // 记账说 `present`，盘上却没有：这是存储与数据库不一致，必须让人知道。
        log({
          event: 'asset.object_missing',
          requestId,
          assetId,
          storageKey: asset.storageKey,
        })
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '资产的存储对象不存在，无法下载。',
          requestId,
          detail: { field: 'storage_key', assetId },
        })
      }

      const stream = withStorage(requestId, 'storage_key', () =>
        storage.openObjectStream(asset.storageKey),
      )

      reply
        .status(200)
        .header('cache-control', 'no-store')
        .header('content-type', asset.mimeType ?? 'application/octet-stream')
        .header('content-length', byteSize)

      {
        // 无文件名的 HTML/SVG 也必须下载，避免用户上传的脚本在应用源下执行。
        const originalName = asset.originalName || `${asset.assetId}.bin`
        // 头里只能放 ASCII：给一个降级的 filename，再用 RFC 5987 的
        // filename* 携带原文，避免非 ASCII 文件名把头写坏（Node 会抛
        // ERR_INVALID_CHAR，那会变成 500 而不是"下载了个名字怪的文件"）。
        const asciiName = originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
        reply.header(
          'content-disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
            originalName,
          )}`,
        )
      }

      log({ event: 'asset.download_started', requestId, assetId, byteSize })
      return reply.send(stream)
    },
  )

  // -------------------------------------------------------------------------
  // 2. 软删（有引用则拒绝）
  // -------------------------------------------------------------------------
  app.delete(
    '/api/v1/workspaces/:workspaceId/assets/:assetId',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { params: ASSET_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const assetId = assetIdOf(request, requestId)
      const asset = requireAssetRow(requestId, assetId, workspaceId)

      if (asset.deleted === 1) {
        return reply.status(200).header('cache-control', 'no-store').send(
          assetSummary(asset, { deleted: true, idempotent: true, refCount: countAssetRefs(deps.db, assetId) }),
        )
      }

      const refs = listAssetRefs(deps.db, assetId)
      if (refs.length > 0) {
        log({ event: 'asset.delete_locked', requestId, assetId, refCount: refs.length })
        throw new ContractError({
          code: 'RESOURCE_LOCKED',
          message: '资产仍被引用，请先移除引用再删除。',
          requestId,
          detail: { assetId, ...refListDetail(refs) },
        })
      }

      const deletedAt = deps.now() as UtcTimestamp
      const deleted = softDeleteAsset(deps.db, assetId, deletedAt)
      if (!deleted) {
        // 并发下被别人删掉了：读回真实状态，按幂等返回。
        const latest = requireAssetRow(requestId, assetId, workspaceId)
        return reply.status(200).header('cache-control', 'no-store').send(
          assetSummary(latest, { deleted: true, idempotent: true, refCount: 0 }),
        )
      }

      log({ event: 'asset.soft_deleted', requestId, assetId })
      return reply.status(200).header('cache-control', 'no-store').send(
        assetSummary(asset, { deleted: true, deletedAt, refCount: 0 }),
      )
    },
  )

  // -------------------------------------------------------------------------
  // 3. 建引用（幂等）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/workspaces/:workspaceId/assets/:assetId/refs',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { params: ASSET_PARAMS_SCHEMA, body: CREATE_REF_BODY_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const assetId = assetIdOf(request, requestId)
      const asset = requireAssetRow(requestId, assetId, workspaceId)
      const body = request.body as CreateRefBody

      if (asset.deleted === 1) {
        throw new ContractError({
          code: 'STATE_INVALID_TRANSITION',
          message: '已软删的资产不能新增引用。',
          requestId,
          detail: { assetId, status: 'deleted' },
        })
      }

      const entityType = requireEntityType(body.entityType, requestId)
      const entityId = requireWellFormedId(body.entityId, 'entityId', requestId)
      const created = insertAssetRef(deps.db, {
        assetId,
        workspaceId,
        entityType,
        entityId,
        createdAt: deps.now(),
      })

      log({
        event: created.created ? 'asset.ref_created' : 'asset.ref_existing',
        requestId,
        assetId,
        entityType,
        entityId,
      })

      return reply
        .status(created.created ? 201 : 200)
        .header('cache-control', 'no-store')
        .send({ ...refSummary(created.row), created: created.created, refCount: countAssetRefs(deps.db, assetId) })
    },
  )

  // -------------------------------------------------------------------------
  // 4. 列某资产的引用
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/workspaces/:workspaceId/assets/:assetId/refs',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }),
      schema: { params: ASSET_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const assetId = assetIdOf(request, requestId)
      const asset = requireAssetRow(requestId, assetId, workspaceId)
      const refs = listAssetRefs(deps.db, assetId)

      return reply.status(200).header('cache-control', 'no-store').send({
        assetId,
        workspaceId,
        deleted: asset.deleted === 1,
        refCount: refs.length,
        refs: refs.map(refSummary),
      })
    },
  )

  // -------------------------------------------------------------------------
  // 5. 按实体反查引用
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/workspaces/:workspaceId/asset-refs',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'read' }),
      schema: { querystring: ENTITY_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'read')
      const query = request.query as { entityType?: string; entityId?: string }

      const entityType = requireEntityType(query.entityType, requestId)
      const entityId = requireWellFormedId(query.entityId, 'entityId', requestId)
      const refs = listAssetRefsForEntity(deps.db, workspaceId, entityType, entityId)

      return reply.status(200).header('cache-control', 'no-store').send({
        workspaceId,
        entityType,
        entityId,
        refCount: refs.length,
        assetIds: refs.map((ref) => ref.assetId),
        refs: refs.map(refSummary),
      })
    },
  )

  // -------------------------------------------------------------------------
  // 6. 删除某条引用（幂等）
  // -------------------------------------------------------------------------
  //
  // 契约里只写了"建引用/列引用"，但**没有解引用**的接口时 `RESOURCE_LOCKED`
  // 就是一条死路：被引用的资产永远删不掉。所以这里补一个最小的解引用端点，
  // 语义是"确保这条引用不存在"（`removed=false` 表示本来就没有）。
  app.delete(
    '/api/v1/workspaces/:workspaceId/assets/:assetId/refs',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { params: ASSET_PARAMS_SCHEMA, querystring: ENTITY_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const assetId = assetIdOf(request, requestId)
      requireAssetRow(requestId, assetId, workspaceId)
      const query = request.query as { entityType?: string; entityId?: string }

      const entityType = requireEntityType(query.entityType, requestId)
      const entityId = requireWellFormedId(query.entityId, 'entityId', requestId)
      const removed = deleteAssetRef(deps.db, assetId, entityType, entityId)

      log({ event: 'asset.ref_deleted', requestId, assetId, entityType, entityId, removed })

      return reply.status(200).header('cache-control', 'no-store').send({
        assetId,
        workspaceId,
        entityType,
        entityId,
        removed,
        refCount: countAssetRefs(deps.db, assetId),
      })
    },
  )
}
