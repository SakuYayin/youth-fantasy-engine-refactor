/**
 * 附件上传路由：**创建会话 → 分片上传 → 完成校验并登记资产**。
 *
 * ```
 * POST /api/v1/workspaces/:workspaceId/uploads
 * PUT  /api/v1/workspaces/:workspaceId/uploads/:uploadId/parts/:partNumber
 * POST /api/v1/workspaces/:workspaceId/uploads/:uploadId/complete
 * ```
 *
 * ## 为什么整对象校验放在 complete
 *
 * 分片阶段服务端**只按字节数**校验（便宜、可重试）；整对象 `sha256` 到
 * `complete` 才核对。客户端在 `create` 时已经声明了 `declared_sha256`，分片阶段
 * 逐片核对并不能让它省下"算整对象摘要"的工作，却要在每条分片的错误路径上多一套
 * 语义；放在唯一一次的地方语义最清楚：**只有摘要相符的对象才可能进入 `assets`**。
 * 不符就整体作废（清 staging + 会话置 `aborted`），绝不留下"半成品 + 半条记录"。
 *
 * ## 幂等
 *
 * - 分片：同一 `partNumber` 重复上传只覆盖字节，`received_parts` 不重复计数
 *   （见 `db/assets.ts` 的 `recordUploadPart`，它在事务内用 `COUNT(*)` 回填）；
 * - `complete`：重复调用返回**同一个** `assetId`，绝不产生第二条 `assets`
 *   ——先看会话是否已 `completed`，再用 `open → completing` 的 CAS 兜住并发。
 *
 * ## 鉴权
 *
 * 每条路由都挂 `deps.guards.requireWorkspaceAccess({ action: 'write' })`，并在
 * 处理器内对**真正要操作的** `workspaceId` 再调一次 `authorizeWorkspaceAccess`
 * ——钩子只认"路径里的工作区"，会话/分片的归属是库里的行，两者必须各自判一遍。
 *
 * ## 传输格式
 *
 * 分片是裸字节（`application/octet-stream`）。Fastify 默认没有这个 content-type
 * 的解析器，所以这里注册一个 `parseAs: 'buffer'`；注册前先探测，避免与其它路由
 * 注册的同类解析器重复（Fastify 对同一 content-type 重复注册会直接抛错）。
 */

import { ContractError, makeId, newIds } from '@yfe/contracts'
import type { RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { addMilliseconds, isExpired } from '../auth/session.js'
import type { SessionPolicy } from '../auth/session.js'
import {
  abortUploadSession,
  completeUploadSession,
  findAssetById,
  findAssetByStorageKey,
  findUploadSession,
  insertAsset,
  insertUploadSession,
  listUploadPartNumbers,
  markAssetPresent,
  markUploadSessionCompleting,
  recordUploadPart,
  releaseUploadSessionCompleting,
} from '../db/assets.js'
import type { AssetRow, UploadSessionRow } from '../db/assets.js'
import { tx } from '../db/open.js'
import type { ServerDb } from '../db/open.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { SYNC_ASSETS, payloadTooLargeError, requireWellFormedId } from '../sync/protocol.js'
import { createAssetStorage, ensureStorageRoot, toStorageContractError } from '../storage/index.js'
import { MAX_PART_NUMBER, isSha256Hex, parsePartNumber } from '../storage/paths.js'

export interface UploadRouteDeps {
  readonly db: ServerDb
  readonly policy: SessionPolicy
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  /**
   * 存储根目录（**绝对路径**，来自配置注入，见 `storageRootFromDataDir`）。
   *
   * 注意 `RouteDeps` 里没有这个字段：装配方需要在 `registerRoutes` 里把
   * `join(config.dataDir, 'assets')` 传进来。这里不读 `process.env`——配置只有
   * 一个来源，测试才能把存储根换成临时目录。
   */
  readonly storageRoot: string
  /** 传输层单请求上限（Fastify `bodyLimit`），用于拒绝"永远传不完"的 part 大小。 */
  readonly bodyLimitBytes: number
  readonly log?: (line: Record<string, unknown>) => void
}

/** 上传会话默认存活 24 小时。 */
const DEFAULT_UPLOAD_TTL_SECONDS = 24 * 60 * 60
const MIN_UPLOAD_TTL_SECONDS = 60
const MAX_UPLOAD_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_NAME_LENGTH = 255
const MAX_MIME_LENGTH = 128

/** 分片的传输格式：裸字节。 */
const PART_CONTENT_TYPE = 'application/octet-stream'

const CREATE_UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['declaredSize', 'declaredSha256', 'partSizeBytes'],
  additionalProperties: false,
  properties: {
    declaredSize: { type: 'integer', minimum: 0 },
    declaredSha256: { type: 'string', minLength: 1, maxLength: 128 },
    partSizeBytes: { type: 'integer', minimum: 1 },
    totalParts: { type: 'integer', minimum: 0 },
    declaredName: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_NAME_LENGTH,
      pattern: '^[^\\u0000-\\u001f\\u007f]*$',
    },
    declaredMime: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_MIME_LENGTH,
      pattern: '^[^\\u0000-\\u001f\\u007f]*$',
    },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    ttlSeconds: {
      type: 'integer',
      minimum: MIN_UPLOAD_TTL_SECONDS,
      maximum: MAX_UPLOAD_TTL_SECONDS,
    },
  },
} as const

const UPLOAD_PARAMS_SCHEMA = {
  type: 'object',
  required: ['workspaceId', 'uploadId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    uploadId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const PART_PARAMS_SCHEMA = {
  type: 'object',
  required: ['workspaceId', 'uploadId', 'partNumber'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    uploadId: { type: 'string', minLength: 1, maxLength: 128 },
    partNumber: { type: 'string', minLength: 1, maxLength: 20 },
  },
} as const

interface CreateUploadBody {
  readonly declaredSize: number
  readonly declaredSha256: string
  readonly partSizeBytes: number
  readonly totalParts?: number
  readonly declaredName?: string
  readonly declaredMime?: string
  readonly deviceId?: string
  readonly ttlSeconds?: number
}

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  requireWellFormedId(raw, 'workspaceId', requestId)
  return raw as WorkspaceId
}

function uploadIdOf(request: FastifyRequest, requestId: RequestId): string {
  return requireWellFormedId(
    (request.params as { uploadId?: string }).uploadId,
    'uploadId',
    requestId,
  )
}

function requireSafeInteger(value: unknown, field: string, requestId: RequestId): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ContractError({
      code: 'VALIDATION_OUT_OF_RANGE',
      message: `字段 ${field} 必须是安全整数。`,
      requestId,
      detail: { field },
    })
  }
  return value
}

function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
  requestId: RequestId,
): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new ContractError({
      code: 'VALIDATION_FAILED',
      message: `字段 ${field} 长度非法。`,
      requestId,
      detail: { field, maxLength },
    })
  }
  return value
}

/** 第 `partNumber` 片应有的字节数（只有最后一片可以短）。 */
function expectedPartByteSize(session: UploadSessionRow, partNumber: number): number {
  const lastIndex = session.totalParts - 1
  if (partNumber === lastIndex) {
    return session.declaredSize - session.partSizeBytes * lastIndex
  }
  return session.partSizeBytes
}

/** 分片编号必须是 `0..totalParts-1` 且**无空洞**。 */
function partNumbersAreComplete(partNumbers: readonly number[], totalParts: number): boolean {
  if (partNumbers.length !== totalParts) {
    return false
  }
  return partNumbers.every((partNumber, index) => partNumber === index)
}

export function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDeps): void {
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }
  const storage = createAssetStorage(deps.storageRoot)
  const log = deps.log ?? ((): void => {})
  const effectivePartSizeLimit = Math.min(SYNC_ASSETS.partSizeBytes, deps.bodyLimitBytes)

  if (!app.hasContentTypeParser(PART_CONTENT_TYPE)) {
    app.addContentTypeParser(
      PART_CONTENT_TYPE,
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body)
      },
    )
  }

  /** 存储异常 → 契约错误；不认识的异常原样上抛（由 Fastify 错误边界收口）。 */
  const storageFailure = (error: unknown, requestId: RequestId, field: string): never => {
    const mapped = toStorageContractError(error, requestId, field)
    if (mapped === null) {
      throw error
    }
    log({ event: 'upload.storage_failure', requestId, field, code: mapped.code })
    throw mapped
  }

  /** 包一层存储调用，把 `STORAGE_*` 语义统一折出来。 */
  const withStorage = <T>(requestId: RequestId, field: string, run: () => T): T => {
    try {
      return run()
    } catch (error) {
      return storageFailure(error, requestId, field)
    }
  }

  const withAsyncStorage = async <T>(requestId: RequestId, field: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      return storageFailure(error, requestId, field)
    }
  }

  /** 清理 staging（失败只记日志：残留目录不影响正确性，但要知道）。 */
  const cleanupStaging = (workspaceId: string, uploadId: string): void => {
    try {
      storage.removeStaging(workspaceId, uploadId)
    } catch (error) {
      log({
        event: 'upload.staging_cleanup_failed',
        workspaceId,
        uploadId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 取会话；**不属于本工作区的会话一律当"不存在"**（不泄漏存在性）。 */
  const requireSessionRow = (
    requestId: RequestId,
    uploadId: string,
    workspaceId: WorkspaceId,
  ): UploadSessionRow => {
    const session = findUploadSession(deps.db, uploadId)
    if (session === null || session.workspaceId !== workspaceId) {
      throw new ContractError({
        code: 'NOT_FOUND',
        message: '上传会话不存在。',
        requestId,
        detail: { uploadId },
      })
    }
    return session
  }

  const stateError = (
    requestId: RequestId,
    uploadId: string,
    status: string,
    extra: Record<string, string | number> = {},
  ): ContractError =>
    new ContractError({
      code: 'STATE_INVALID_TRANSITION',
      message: `上传会话当前状态为 ${status}，不能执行该操作。`,
      requestId,
      detail: { uploadId, status, ...extra },
    })

  const assetSummary = (
    asset: AssetRow,
    extra: Record<string, string | number | boolean | null> = {},
  ): Record<string, unknown> => ({
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
  })

  /** `complete` 的幂等出口：会话上已有的 `asset_id` 就是唯一权威。 */
  const completedSessionResponse = (
    requestId: RequestId,
    workspaceId: WorkspaceId,
    uploadId: string,
    assetId: string,
  ): Record<string, unknown> => {
    const asset = findAssetById(deps.db, assetId)
    if (asset === null || asset.workspaceId !== workspaceId) {
      throw new ContractError({
        code: 'STORAGE_CORRUPT',
        message: '上传会话指向的资产不存在或不属于本工作区。',
        requestId,
        detail: { uploadId, assetId },
      })
    }
    return assetSummary(asset, { uploadId, deduplicated: true, idempotent: true })
  }

  // -------------------------------------------------------------------------
  // 1. 创建上传会话
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/workspaces/:workspaceId/uploads',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { body: CREATE_UPLOAD_BODY_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const principal = currentPrincipal(request)
      const body = request.body as CreateUploadBody

      const declaredSize = requireSafeInteger(body.declaredSize, 'declaredSize', requestId)
      if (declaredSize < 0) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: 'declaredSize 不能为负数。',
          requestId,
          detail: { field: 'declaredSize', minimum: 0 },
        })
      }
      if (declaredSize > SYNC_ASSETS.maxAssetBytes) {
        throw payloadTooLargeError(requestId, {
          field: 'declaredSize',
          limit: SYNC_ASSETS.maxAssetBytes,
          received: declaredSize,
        })
      }

      const partSizeBytes = requireSafeInteger(body.partSizeBytes, 'partSizeBytes', requestId)
      if (partSizeBytes < 1) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: 'partSizeBytes 必须大于 0。',
          requestId,
          detail: { field: 'partSizeBytes', minimum: 1 },
        })
      }
      if (partSizeBytes > effectivePartSizeLimit) {
        // 大于传输层上限的分片**永远传不完**，必须在建会话时就拒绝，
        // 否则客户端会拿到一个必然失败的上传计划。
        throw payloadTooLargeError(requestId, {
          field: 'partSizeBytes',
          limit: effectivePartSizeLimit,
          received: partSizeBytes,
        })
      }

      const expectedTotalParts = Math.ceil(declaredSize / partSizeBytes)
      let totalParts = expectedTotalParts
      if (body.totalParts !== undefined) {
        const declaredTotalParts = requireSafeInteger(body.totalParts, 'totalParts', requestId)
        if (declaredTotalParts !== expectedTotalParts) {
          throw new ContractError({
            code: 'VALIDATION_OUT_OF_RANGE',
            message: `totalParts 与 declaredSize/partSizeBytes 不自洽：期望 ${expectedTotalParts}。`,
            requestId,
            detail: {
              field: 'totalParts',
              expected: expectedTotalParts,
              received: declaredTotalParts,
              declaredSize,
              partSizeBytes,
            },
          })
        }
        totalParts = declaredTotalParts
      }

      if (totalParts > MAX_PART_NUMBER) {
        // 分片文件名是定宽十进制，编号超过上限就派生不出路径了；
        // 与其在 PUT 阶段抛存储错误，不如在建会话时告诉客户端"计划不可行"。
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: `分片数超出上限 ${MAX_PART_NUMBER}，请减小 partSizeBytes。`,
          requestId,
          detail: {
            field: 'partSizeBytes',
            expectedTotalParts,
            maximum: MAX_PART_NUMBER,
            declaredSize,
          },
        })
      }

      if (!isSha256Hex(body.declaredSha256)) {
        throw new ContractError({
          code: 'VALIDATION_FAILED',
          message: 'declaredSha256 必须是 64 位小写十六进制 sha256。',
          requestId,
          detail: { field: 'declaredSha256', expected: '64 位小写十六进制' },
        })
      }

      const declaredName = optionalText(body.declaredName, 'declaredName', MAX_NAME_LENGTH, requestId)
      const declaredMime = optionalText(body.declaredMime, 'declaredMime', MAX_MIME_LENGTH, requestId)

      let deviceId: string | null = principal.deviceId
      if (body.deviceId !== undefined) {
        deviceId = requireWellFormedId(body.deviceId, 'deviceId', requestId)
        if (principal.deviceId !== null && principal.deviceId !== deviceId) {
          throw new ContractError({
            code: 'PERMISSION_WORKSPACE_MISMATCH',
            message: '设备令牌不能代替另一台设备登记上传。',
            requestId,
            detail: { field: 'deviceId' },
          })
        }
      }

      const ttlSeconds =
        body.ttlSeconds === undefined
          ? DEFAULT_UPLOAD_TTL_SECONDS
          : requireSafeInteger(body.ttlSeconds, 'ttlSeconds', requestId)
      if (ttlSeconds < MIN_UPLOAD_TTL_SECONDS || ttlSeconds > MAX_UPLOAD_TTL_SECONDS) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: 'ttlSeconds 超出允许范围。',
          requestId,
          detail: {
            field: 'ttlSeconds',
            minimum: MIN_UPLOAD_TTL_SECONDS,
            maximum: MAX_UPLOAD_TTL_SECONDS,
            received: ttlSeconds,
          },
        })
      }

      const uploadId = makeId('upl')
      withStorage(requestId, 'storage_root', () => {
        // 存储根建出来即可；`staging/<ws>/<upload>` 会在写第一片时按需创建。
        ensureStorageRoot(storage)
      })
      const stagingKey = storage.stagingDir(workspaceId, uploadId).key

      const createdAt = deps.now()
      const expiresAt = addMilliseconds(createdAt, ttlSeconds * 1000)
      const session = insertUploadSession(deps.db, {
        uploadId,
        workspaceId,
        userId: principal.userId,
        deviceId,
        declaredName,
        declaredMime,
        declaredSize,
        declaredSha256: body.declaredSha256,
        partSizeBytes,
        totalParts,
        stagingDir: stagingKey,
        createdAt,
        expiresAt,
      })

      log({
        event: 'upload.session_created',
        requestId,
        uploadId,
        workspaceId,
        declaredSize,
        partSizeBytes,
        totalParts,
      })

      return reply.status(201).header('cache-control', 'no-store').send({
        uploadId: session.uploadId,
        workspaceId: session.workspaceId,
        declaredSize: session.declaredSize,
        declaredSha256: session.declaredSha256,
        partSizeBytes: session.partSizeBytes,
        totalParts: session.totalParts,
        receivedParts: session.receivedParts,
        receivedPartNumbers: listUploadPartNumbers(deps.db, uploadId),
        status: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      })
    },
  )

  // -------------------------------------------------------------------------
  // 2. 上传分片（幂等）
  // -------------------------------------------------------------------------
  app.put(
    '/api/v1/workspaces/:workspaceId/uploads/:uploadId/parts/:partNumber',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { params: PART_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const uploadId = uploadIdOf(request, requestId)

      const rawPartNumber = (request.params as { partNumber?: string }).partNumber
      const partNumber = rawPartNumber === undefined ? null : parsePartNumber(rawPartNumber)
      if (partNumber === null) {
        throw new ContractError({
          code: 'VALIDATION_FAILED',
          message: 'partNumber 必须是十进制非负整数。',
          requestId,
          detail: { field: 'partNumber' },
        })
      }
      if (partNumber > MAX_PART_NUMBER) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: `partNumber 超出上限 ${MAX_PART_NUMBER}。`,
          requestId,
          detail: { field: 'partNumber', received: partNumber, maximum: MAX_PART_NUMBER },
        })
      }

      let session = requireSessionRow(requestId, uploadId, workspaceId)
      const now = deps.now()

      if (isExpired(session.expiresAt, now)) {
        // 过期的会话就地作废：清掉暂存字节（best-effort），状态置 expired。
        cleanupStaging(workspaceId, uploadId)
        abortUploadSession(deps.db, uploadId, 'expired')
        throw stateError(requestId, uploadId, 'expired', { expiresAt: session.expiresAt })
      }
      if (session.status !== 'open') {
        throw stateError(requestId, uploadId, session.status)
      }
      if (partNumber >= session.totalParts) {
        throw new ContractError({
          code: 'VALIDATION_OUT_OF_RANGE',
          message: 'partNumber 超出本会话的分片范围。',
          requestId,
          detail: {
            field: 'partNumber',
            received: partNumber,
            totalParts: session.totalParts,
            maximum: session.totalParts - 1,
          },
        })
      }

      const expectedBytes = expectedPartByteSize(session, partNumber)
      const body: unknown = request.body
      if (!Buffer.isBuffer(body)) {
        throw new ContractError({
          code: 'VALIDATION_FAILED',
          message: `分片必须以 ${PART_CONTENT_TYPE} 提交裸字节。`,
          requestId,
          detail: { field: 'body', expected: PART_CONTENT_TYPE },
        })
      }
      if (body.byteLength !== expectedBytes) {
        throw new ContractError({
          code: 'VALIDATION_FAILED',
          message: '分片字节数与该分片声明的长度不符。',
          requestId,
          detail: { field: 'byteSize', expected: expectedBytes, received: body.byteLength },
        })
      }

      const stored = withStorage(requestId, 'part', () =>
        storage.writePart(workspaceId, uploadId, partNumber, body),
      )
      // 落盘与记账放在一起：先写文件再写行，两步都成功才算收到这一片。
      const recorded = recordUploadPart(deps.db, {
        uploadId,
        partNumber,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        receivedAt: now,
      })

      log({
        event: 'upload.part_received',
        requestId,
        uploadId,
        partNumber,
        byteSize: stored.byteSize,
        inserted: recorded.inserted,
        receivedParts: recorded.receivedParts,
      })

      return reply.status(200).header('cache-control', 'no-store').send({
        uploadId,
        partNumber,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        receivedParts: recorded.receivedParts,
        totalParts: session.totalParts,
        inserted: recorded.inserted,
        receivedAt: now,
      })
    },
  )

  // -------------------------------------------------------------------------
  // 3. 完成上传：整对象校验 → 登记资产（幂等）
  // -------------------------------------------------------------------------
  app.post(
    '/api/v1/workspaces/:workspaceId/uploads/:uploadId/complete',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'write' }),
      schema: { params: UPLOAD_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')
      const uploadId = uploadIdOf(request, requestId)
      const now = deps.now()

      const session = requireSessionRow(requestId, uploadId, workspaceId)

      if (session.status === 'completed') {
        if (session.assetId === null) {
          throw new ContractError({
            code: 'STORAGE_CORRUPT',
            message: '上传会话已完成但没有关联资产。',
            requestId,
            detail: { uploadId },
          })
        }
        return reply
          .status(200)
          .header('cache-control', 'no-store')
          .send(completedSessionResponse(requestId, workspaceId, uploadId, session.assetId))
      }

      if (isExpired(session.expiresAt, now)) {
        cleanupStaging(workspaceId, uploadId)
        abortUploadSession(deps.db, uploadId, 'expired')
        throw stateError(requestId, uploadId, 'expired', { expiresAt: session.expiresAt })
      }
      if (session.status !== 'open') {
        throw stateError(requestId, uploadId, session.status)
      }

      const declaredSha256 = session.declaredSha256
      if (declaredSha256 === null || !isSha256Hex(declaredSha256)) {
        throw new ContractError({
          code: 'STORAGE_CORRUPT',
          message: '上传会话缺少可用的 declared_sha256，无法校验。',
          requestId,
          detail: { field: 'declaredSha256' },
        })
      }

      const partNumbers = listUploadPartNumbers(deps.db, uploadId)
      if (!partNumbersAreComplete(partNumbers, session.totalParts)) {
        throw new ContractError({
          code: 'STATE_INVALID_TRANSITION',
          message: '分片不齐，无法完成上传。',
          requestId,
          detail: {
            uploadId,
            receivedParts: session.receivedParts,
            totalParts: session.totalParts,
            partCount: partNumbers.length,
          },
        })
      }

      // CAS open → completing：并发下只有一个请求能进入"校验并入库"。
      if (!markUploadSessionCompleting(deps.db, uploadId)) {
        const latest = requireSessionRow(requestId, uploadId, workspaceId)
        if (latest.status === 'completed' && latest.assetId !== null) {
          return reply
            .status(200)
            .header('cache-control', 'no-store')
            .send(completedSessionResponse(requestId, workspaceId, uploadId, latest.assetId))
        }
        throw stateError(requestId, uploadId, latest.status)
      }

      try {
        const assembled = await withAsyncStorage(requestId, 'assembled', () =>
          storage.assembleObject(workspaceId, uploadId, partNumbers),
        )
        const actualSha256 = await withAsyncStorage(requestId, 'sha256', () =>
          storage.sha256OfFile(assembled.absolutePath),
        )

        // 流式 I/O 期间角色/会话可能被撤销；在提交前使用当前时刻重新认证。
        request.yfeNow = deps.now()
        await deps.guards.requireSession(request, reply)
        authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'write')

        if (assembled.byteSize !== session.declaredSize || actualSha256 !== declaredSha256) {
          // 内容与声明不符 → 整单作废：清掉 staging（**不留半成品**），会话置 aborted。
          cleanupStaging(workspaceId, uploadId)
          abortUploadSession(deps.db, uploadId, 'aborted')
          log({
            event: 'upload.integrity_failed',
            requestId,
            uploadId,
            expectedSha256: declaredSha256,
            actualSha256,
            expectedSize: session.declaredSize,
            actualSize: assembled.byteSize,
          })
          throw new ContractError({
            code: 'STORAGE_CORRUPT',
            message: '整对象 sha256 与声明的摘要不符，本次上传已作废。',
            requestId,
            detail: {
              field: 'sha256',
              expected: declaredSha256,
              actual: actualSha256,
              expectedSize: session.declaredSize,
              actualSize: assembled.byteSize,
            },
          })
        }

        const committed = withStorage(requestId, 'storage_key', () =>
          storage.commitObject(actualSha256, assembled.absolutePath, assembled.byteSize),
        )

        const outcome = tx(deps.db, () => {
          const finishSession = (asset: AssetRow, deduplicated: boolean) => {
            if (!completeUploadSession(deps.db, uploadId, asset.assetId, now)) {
              throw stateError(requestId, uploadId, requireSessionRow(requestId, uploadId, workspaceId).status)
            }
            return { asset, deduplicated }
          }
          const existing = findAssetByStorageKey(deps.db, workspaceId, committed.storageKey)
          if (existing !== null) {
            // 同一内容此前已登记：复用同一 asset_id，只把状态刷回 present。
            markAssetPresent(deps.db, existing.assetId, now)
            const refreshed = findAssetById(deps.db, existing.assetId) ?? existing
            return finishSession(refreshed, true)
          }
          const asset = insertAsset(deps.db, {
            assetId: newIds.asset(),
            workspaceId,
            attachmentId: null,
            storageKey: committed.storageKey,
            sha256: actualSha256,
            byteSize: assembled.byteSize,
            mimeType: session.declaredMime,
            originalName: session.declaredName,
            uploadedByUserId: session.userId,
            createdAt: now,
            verifiedAt: now,
          })
          return finishSession(asset, false)
        })

        cleanupStaging(workspaceId, uploadId)
        log({
          event: 'upload.completed',
          requestId,
          uploadId,
          assetId: outcome.asset.assetId,
          storageKey: outcome.asset.storageKey,
          byteSize: outcome.asset.byteSize,
          deduplicated: outcome.deduplicated || committed.deduplicated,
        })

        return reply.status(200).header('cache-control', 'no-store').send(
          assetSummary(outcome.asset, {
            uploadId,
            deduplicated: outcome.deduplicated || committed.deduplicated,
          }),
        )
      } finally {
        // 失败可重传/重试；已完成或已作废的会话不会被 CAS 重新打开。
        releaseUploadSessionCompleting(deps.db, uploadId)
      }
    },
  )
}
