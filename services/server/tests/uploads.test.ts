/**
 * 附件上传全链路：会话创建 → 分片上传 → 整对象校验 → 资产登记。
 *
 * 判据集中在三件"真出事才算数"的事上：
 * 1. **分片状态机**：越界、非 open、字节数不符一律拒绝；同一片重传必须幂等
 *    （`received_parts` 不允许被重复计数，因为它要和 `upload_parts` 行数相等）。
 * 2. **内容校验**：改一个字节就得整单作废，而且**盘上不能留半成品**——
 *    这里断言的是 `storageRoot` 下的真实文件列表，不是响应码。
 * 3. **幂等**：重复 `complete` 必须回到同一个 `asset_id`，`assets` 只能有一行。
 *
 * 夹具说明：`tests/helpers.ts` 的 `makeHarness` 会 `await app.ready()`，
 * 而 Fastify 一旦 ready 就不允许再 `addRoute`，所以这里自己搭 app，再注册
 * 本次要测的两组路由；存储根用系统临时目录（`mkdtempSync`），绝不写进仓库。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { DEFAULT_SESSION_POLICY, addMilliseconds, issueSession } from '../src/auth/session.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { findAssetById, findUploadSession, listUploadParts } from '../src/db/assets.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import type { ServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { listFilesRecursive } from '../src/storage/localFs.js'
import { isWithinRoot, resolveUnderRoot } from '../src/storage/paths.js'
import { cleanupTempDirs, makeTempDir, seedOwner, testClock, bearer } from './helpers.js'
import type { TestClock } from './helpers.js'
import { countRows } from './syncHelpers.js'

const SERVER_ID = 'srv_uploads_test'
const PART_CT = 'application/octet-stream'
const MIB = 1024 * 1024

/** 三段式夹具：3 片，前两片 8 字节，最后一片 6 字节。 */
const ORIGINAL = Buffer.from('hello world 0123456789', 'utf8')
const PART_SIZE = 8
const TOTAL_PARTS = 3

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function partOf(bytes: Buffer, partNumber: number): Buffer {
  return bytes.subarray(partNumber * PART_SIZE, (partNumber + 1) * PART_SIZE)
}

interface Ctx {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  readonly config: ServerConfig
  readonly storageRoot: string
  readonly token: string
  readonly otherToken: string
  readonly workspaceId: WorkspaceId
  readonly userId: UserId
  readonly otherWorkspaceId: WorkspaceId
}

let ctx: Ctx

async function makeCtx(): Promise<Ctx> {
  const db = openServerDatabase(':memory:')
  await migrateServerDatabase(db)
  const clock = testClock()
  const config = defaultServerConfig({
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
  })
  ensureServerState(db, SERVER_ID, config.bootstrapSecretFile)
  const policy = config.sessionPolicy
  const storageRoot = makeTempDir()
  // 走**完整**路由装配（`routes/index.ts`）：uploads 与 assets 两组路由都在其中。
  // `storageRoot` 必须显式注入——默认值会落到仓库工作目录的 `data/assets` 下。
  const app = createServer({
    config,
    db,
    serverId: SERVER_ID,
    clock,
    logger: false,
    storageRoot,
  })
  await app.ready()

  const owner = await seedOwner(db, clock.now())
  const other = await seedOwner(db, clock.now(), { username: 'other' })
  const issue = (userId: UserId): string =>
    issueSession(db, {
      userId,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      policy,
    }).accessToken

  return {
    app,
    db,
    clock,
    config,
    storageRoot,
    token: issue(owner.userId),
    otherToken: issue(other.userId),
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    otherWorkspaceId: other.workspaceId,
  }
}

beforeEach(async () => {
  ctx = await makeCtx()
})

afterEach(async () => {
  await ctx.app.close()
  closeServerDatabase(ctx.db)
  cleanupTempDirs()
})

function uploadsUrl(suffix = ''): string {
  return `/api/v1/workspaces/${ctx.workspaceId}/uploads${suffix}`
}

interface CreateOverrides {
  readonly declaredSize?: number
  readonly declaredSha256?: string
  readonly partSizeBytes?: number
  readonly totalParts?: number
  readonly ttlSeconds?: number
  readonly declaredName?: string
  readonly declaredMime?: string
}

function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  return {
    declaredSize: overrides.declaredSize ?? ORIGINAL.byteLength,
    declaredSha256: overrides.declaredSha256 ?? sha256Hex(ORIGINAL),
    partSizeBytes: overrides.partSizeBytes ?? PART_SIZE,
    ...(overrides.totalParts === undefined ? {} : { totalParts: overrides.totalParts }),
    ...(overrides.ttlSeconds === undefined ? {} : { ttlSeconds: overrides.ttlSeconds }),
    ...(overrides.declaredName === undefined ? {} : { declaredName: overrides.declaredName }),
    ...(overrides.declaredMime === undefined ? {} : { declaredMime: overrides.declaredMime }),
  }
}

async function createUpload(overrides: CreateOverrides = {}): Promise<{
  readonly statusCode: number
  readonly body: Record<string, unknown>
}> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: uploadsUrl(),
    headers: bearer(ctx.token),
    payload: createBody(overrides),
  })
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() }
}

async function putPart(
  uploadId: string,
  partNumber: number | string,
  bytes: Buffer | string,
  options: { readonly contentType?: string; readonly token?: string } = {},
): Promise<{ readonly statusCode: number; readonly body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: uploadsUrl(`/${uploadId}/parts/${partNumber}`),
    headers: {
      ...bearer(options.token ?? ctx.token),
      'content-type': options.contentType ?? PART_CT,
    },
    payload: bytes,
  })
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() }
}

async function completeUpload(
  uploadId: string,
  token?: string,
): Promise<{ readonly statusCode: number; readonly body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: uploadsUrl(`/${uploadId}/complete`),
    headers: bearer(token ?? ctx.token),
  })
  return { statusCode: res.statusCode, body: res.json<Record<string, unknown>>() }
}

/** 上传全部分片并断言每一片都成功。 */
async function uploadParts(uploadId: string, bytes: Buffer = ORIGINAL): Promise<void> {
  for (let i = 0; i < TOTAL_PARTS; i += 1) {
    const res = await putPart(uploadId, i, partOf(bytes, i))
    expect(res.statusCode, `part ${i}`).toBe(200)
    expect(res.body.inserted).toBe(true)
  }
}

describe('创建上传会话', () => {
  it('返回 uploadId / part 大小 / 已收分片 / expiresAt，staging_dir 存相对键', async () => {
    const res = await createUpload({ declaredName: '报告.txt', declaredMime: 'text/plain' })
    expect(res.statusCode).toBe(201)
    const uploadId = res.body.uploadId as string
    expect(uploadId).toMatch(/^upl_/)
    expect(res.body.workspaceId).toBe(ctx.workspaceId)
    expect(res.body.declaredSize).toBe(ORIGINAL.byteLength)
    expect(res.body.declaredSha256).toBe(sha256Hex(ORIGINAL))
    expect(res.body.partSizeBytes).toBe(PART_SIZE)
    expect(res.body.totalParts).toBe(TOTAL_PARTS)
    expect(res.body.receivedParts).toBe(0)
    expect(res.body.receivedPartNumbers).toEqual([])
    expect(res.body.status).toBe('open')
    expect(Date.parse(res.body.expiresAt as string) - Date.parse(res.body.createdAt as string)).toBe(
      86_400_000,
    )

    const row = findUploadSession(ctx.db, uploadId)
    expect(row).not.toBeNull()
    // 库里存相对键，盘的落点由存储层从根派生——绝对路径不进数据库。
    expect(row?.stagingDir).toBe(`staging/${ctx.workspaceId}/${uploadId}`)
    expect(isAbsolute(row?.stagingDir ?? '')).toBe(false)
    expect(isWithinRoot(ctx.storageRoot, resolveUnderRoot(ctx.storageRoot, row?.stagingDir ?? ''))).toBe(
      true,
    )
  })

  it('totalParts 与 declaredSize/partSizeBytes 不自洽 → 400 且给出期望值', async () => {
    const res = await createUpload({ totalParts: 2 })
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(res.body.detail).toMatchObject({ field: 'totalParts', expected: TOTAL_PARTS, received: 2 })
    expect(countRows(ctx.db, 'upload_sessions')).toBe(0)
  })

  it('declaredSha256 不是 64 位小写 hex → 400 VALIDATION_FAILED', async () => {
    for (const bad of [sha256Hex(ORIGINAL).toUpperCase(), 'abc', 'z'.repeat(64), `${sha256Hex(ORIGINAL)}0`]) {
      const res = await createUpload({ declaredSha256: bad })
      expect(res.statusCode, bad).toBe(400)
      expect(res.body.code, bad).toBe('VALIDATION_FAILED')
      expect(res.body.detail).toMatchObject({ field: 'declaredSha256' })
    }
    expect(countRows(ctx.db, 'upload_sessions')).toBe(0)
  })

  it('declaredSize 为负 → 400（schema 的 minimum 先拦下）', async () => {
    const res = await createUpload({ declaredSize: -1, totalParts: 0 })
    expect(res.statusCode).toBe(400)
    // `CREATE_UPLOAD_BODY_SCHEMA` 里 declaredSize 是 `minimum: 0`，所以负数在
    // 进处理器之前就被 Fastify 的 schema 校验折成 VALIDATION_FAILED。
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(countRows(ctx.db, 'upload_sessions')).toBe(0)
  })

  it('partSizeBytes 超过传输层上限（永远传不完）→ 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await createUpload({ partSizeBytes: 8 * MIB })
    expect(res.statusCode).toBe(413)
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.body.detail).toMatchObject({ field: 'partSizeBytes', limit: ctx.config.bodyLimitBytes })
  })

  it('declaredSize 超过单对象上限 → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await createUpload({ declaredSize: 512 * MIB + 1, partSizeBytes: MIB })
    expect(res.statusCode).toBe(413)
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE')
    expect(res.body.detail).toMatchObject({ field: 'declaredSize' })
  })
})

describe('分片上传状态机', () => {
  it('正常分片逐个收下，repeated 上传同一片幂等且不重复计数', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string

    const first = await putPart(uploadId, 0, partOf(ORIGINAL, 0))
    expect(first.statusCode).toBe(200)
    expect(first.body).toMatchObject({ partNumber: 0, byteSize: PART_SIZE, receivedParts: 1, inserted: true })
    expect(first.body.sha256).toBe(sha256Hex(partOf(ORIGINAL, 0)))
    expect(first.body.totalParts).toBe(TOTAL_PARTS)

    // 落盘证据：暂存目录里确实有这一片。
    expect(listFilesRecursive(ctx.storageRoot)).toContain(
      `staging/${ctx.workspaceId}/${uploadId}/part-0000000000`,
    )

    // 同一片重传：`inserted=false`，计数不动。
    const again = await putPart(uploadId, 0, partOf(ORIGINAL, 0))
    expect(again.statusCode).toBe(200)
    expect(again.body.inserted).toBe(false)
    expect(again.body.receivedParts).toBe(1)

    const aggregate = await ctx.db
      .prepare('SELECT received_parts FROM upload_sessions WHERE upload_id = ?')
      .get(uploadId) as { received_parts: number } | undefined
    expect(aggregate?.received_parts).toBe(listUploadParts(ctx.db, uploadId).length)
    expect(aggregate?.received_parts).toBe(1)

    const second = await putPart(uploadId, 1, partOf(ORIGINAL, 1))
    expect(second.body.receivedParts).toBe(2)
    expect(countRows(ctx.db, 'upload_parts')).toBe(2)
  })

  it('partNumber 越界 → 400 VALIDATION_OUT_OF_RANGE', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string

    const tooBig = await putPart(uploadId, TOTAL_PARTS, partOf(ORIGINAL, 0))
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.body.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(tooBig.body.detail).toMatchObject({
      field: 'partNumber',
      received: TOTAL_PARTS,
      maximum: TOTAL_PARTS - 1,
    })

    const absurd = await putPart(uploadId, 999_999_999, Buffer.alloc(1, 0x41))
    expect(absurd.statusCode).toBe(400)
    expect(absurd.body.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(listFilesRecursive(ctx.storageRoot)).toEqual([])
  })

  it('partNumber 不是十进制非负整数 → 400 VALIDATION_FAILED', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    for (const bad of ['abc', '-1', '1.0', '+1', '0x1']) {
      const res = await putPart(uploadId, bad, partOf(ORIGINAL, 0))
      expect(res.statusCode, bad).toBe(400)
      expect(res.body.code, bad).toBe('VALIDATION_FAILED')
      expect(res.body.detail, bad).toMatchObject({ field: 'partNumber' })
    }
    expect(listFilesRecursive(ctx.storageRoot)).toEqual([])
  })

  it('分片字节数不符（非末片）→ 400 VALIDATION_FAILED', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string

    const short = await putPart(uploadId, 0, partOf(ORIGINAL, 0).subarray(0, PART_SIZE - 1))
    expect(short.statusCode).toBe(400)
    expect(short.body.code).toBe('VALIDATION_FAILED')
    expect(short.body.detail).toMatchObject({ field: 'byteSize', expected: PART_SIZE, received: PART_SIZE - 1 })

    const long = await putPart(uploadId, 0, Buffer.concat([partOf(ORIGINAL, 0), Buffer.from('x')]))
    expect(long.statusCode).toBe(400)
    expect(long.body.detail).toMatchObject({ expected: PART_SIZE, received: PART_SIZE + 1 })

    // 末片按 declaredSize 的余数算，不是 partSizeBytes。
    const lastOverlong = await putPart(uploadId, TOTAL_PARTS - 1, Buffer.alloc(PART_SIZE, 1))
    expect(lastOverlong.statusCode).toBe(400)
    expect(lastOverlong.body.detail).toMatchObject({ expected: ORIGINAL.byteLength - PART_SIZE * 2 })
    expect(countRows(ctx.db, 'upload_parts')).toBe(0)
  })

  it('分片必须以裸字节提交 → 400 VALIDATION_FAILED', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    const res = await putPart(uploadId, 0, 'hello', { contentType: 'text/plain' })
    expect(res.statusCode).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.detail).toMatchObject({ field: 'body', expected: PART_CT })
  })

  it('未知 uploadId → 404 NOT_FOUND', async () => {
    const res = await putPart('upl_does_not_exist', 0, partOf(ORIGINAL, 0))
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('会话过期后 PUT → 409，且会话置 expired、暂存被清', async () => {
    const created = await createUpload({ ttlSeconds: 60 })
    const uploadId = created.body.uploadId as string
    expect((await putPart(uploadId, 0, partOf(ORIGINAL, 0))).statusCode).toBe(200)

    ctx.clock.advance(60_000 + 1_000)
    const res = await putPart(uploadId, 1, partOf(ORIGINAL, 1))
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('STATE_INVALID_TRANSITION')
    expect(res.body.detail).toMatchObject({ status: 'expired', uploadId })
    expect(findUploadSession(ctx.db, uploadId)?.status).toBe('expired')
    expect(listFilesRecursive(ctx.storageRoot)).toEqual([])
    expect(countRows(ctx.db, 'upload_parts')).toBe(0)
  })

  it('已完成的会话不能再收分片 → 409 STATE_INVALID_TRANSITION', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    await uploadParts(uploadId)
    expect((await completeUpload(uploadId)).statusCode).toBe(200)

    const res = await putPart(uploadId, 0, partOf(ORIGINAL, 0))
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('STATE_INVALID_TRANSITION')
    expect(res.body.detail).toMatchObject({ status: 'completed', uploadId })
  })
})

describe('完成上传', () => {
  it('分片齐全且摘要相符 → 登记 present 资产、内容寻址、暂存清空', async () => {
    const created = await createUpload({ declaredName: '报告.txt', declaredMime: 'text/plain' })
    const uploadId = created.body.uploadId as string
    await uploadParts(uploadId)

    const res = await completeUpload(uploadId)
    expect(res.statusCode).toBe(200)
    const digest = sha256Hex(ORIGINAL)
    const storageKey = `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`
    const assetId = res.body.assetId as string

    expect(res.body).toMatchObject({
      assetId,
      workspaceId: ctx.workspaceId,
      storageKey,
      hashAlgorithm: 'sha256',
      sha256: digest,
      byteSize: ORIGINAL.byteLength,
      mimeType: 'text/plain',
      originalName: '报告.txt',
      state: 'present',
      deleted: false,
      uploadId,
    })
    expect(typeof res.body.verifiedAt).toBe('string')

    const session = findUploadSession(ctx.db, uploadId)
    expect(session?.status).toBe('completed')
    expect(session?.assetId).toBe(assetId)
    expect(typeof session?.completedAt).toBe('string')
    expect(session?.completedAt).toBe(res.body.verifiedAt)

    const asset = findAssetById(ctx.db, assetId)
    expect(asset?.state).toBe('present')
    expect(asset?.deleted).toBe(0)
    expect(asset?.verifiedAt).not.toBeNull()
    expect(asset?.uploadedByUserId).toBe(ctx.userId)

    // 对象真的落在内容寻址路径上，且字节完整；暂存目录被整棵清掉。
    const files = listFilesRecursive(ctx.storageRoot)
    expect(files).toEqual([`objects/${storageKey}`])
    expect(
      resolveUnderRoot(ctx.storageRoot, `objects/${storageKey}`),
    ).toBe(join(ctx.storageRoot, 'objects', 'sha256', digest.slice(0, 2), digest.slice(2, 4), digest))
    expect(readFileSync(resolveUnderRoot(ctx.storageRoot, `objects/${storageKey}`))).toEqual(ORIGINAL)  })

  it('分片有空洞 → 409 STATE_INVALID_TRANSITION，不写资产', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    expect((await putPart(uploadId, 1, partOf(ORIGINAL, 1))).statusCode).toBe(200)

    const res = await completeUpload(uploadId)
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('STATE_INVALID_TRANSITION')
    expect(res.body.detail).toMatchObject({ uploadId, receivedParts: 1, totalParts: TOTAL_PARTS, partCount: 1 })
    expect(countRows(ctx.db, 'assets')).toBe(0)
    expect(findUploadSession(ctx.db, uploadId)?.status).toBe('open')
  })

  it('篡改一个字节 → 503 STORAGE_CORRUPT，且不留半成品', async () => {
    const tampered = Buffer.from(ORIGINAL)
    // `noUncheckedIndexedAccess` 下 `tampered[0]` 是 `number | undefined`。
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(ORIGINAL))

    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    await uploadParts(uploadId, tampered)

    const res = await completeUpload(uploadId)
    expect(res.statusCode).toBe(503)
    expect(res.body.code).toBe('STORAGE_CORRUPT')
    expect(res.body.detail).toMatchObject({ field: 'sha256', expected: sha256Hex(ORIGINAL), actual: sha256Hex(tampered) })

    // 暂存与对象目录都不许留东西：既没有半截文件，也没有"校验失败但已提交"的对象。
    expect(listFilesRecursive(ctx.storageRoot)).toEqual([])
    expect(countRows(ctx.db, 'assets')).toBe(0)
    expect(findUploadSession(ctx.db, uploadId)?.status).toBe('aborted')

    // 摘要不符之后，这个会话不能再被拿去 complete（不会偷偷成功第二次）。
    const retry = await completeUpload(uploadId)
    expect(retry.statusCode).toBe(409)
    expect(countRows(ctx.db, 'assets')).toBe(0)
  })

  it('重复 complete 幂等：同一个 assetId，assets 只有一行', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string
    await uploadParts(uploadId)

    const first = await completeUpload(uploadId)
    expect(first.statusCode).toBe(200)
    const second = await completeUpload(uploadId)

    expect(second.statusCode).toBe(200)
    expect(second.body.assetId).toBe(first.body.assetId)
    expect(second.body).toMatchObject({ idempotent: true, deduplicated: true, storageKey: first.body.storageKey })
    expect(countRows(ctx.db, 'assets')).toBe(1)
    expect(listFilesRecursive(ctx.storageRoot)).toHaveLength(1)
    expect(findUploadSession(ctx.db, uploadId)?.assetId).toBe(first.body.assetId)
  })

  it('同一内容二次上传（另一会话）复用同一资产，不产生第二行', async () => {
    const first = await createUpload()
    await uploadParts(first.body.uploadId as string)
    const firstDone = await completeUpload(first.body.uploadId as string)
    expect(firstDone.statusCode).toBe(200)
    const originalBytes = listFilesRecursive(ctx.storageRoot).slice()

    const second = await createUpload()
    await uploadParts(second.body.uploadId as string)
    const secondDone = await completeUpload(second.body.uploadId as string)

    expect(secondDone.statusCode).toBe(200)
    expect(secondDone.body.assetId).toBe(firstDone.body.assetId)
    expect(secondDone.body.deduplicated).toBe(true)
    expect(countRows(ctx.db, 'assets')).toBe(1)
    // 第二次上传的暂存被清掉，对象没有被写坏也没有多出副本。
    expect(listFilesRecursive(ctx.storageRoot)).toEqual(originalBytes)
  })

  it('未知 uploadId → 404 NOT_FOUND', async () => {
    const res = await completeUpload('upl_does_not_exist')
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })
})

describe('鉴权（上传链路）', () => {
  it('未认证 → 401 AUTH_REQUIRED', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: uploadsUrl(),
      payload: createBody(),
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('跨工作区 → 403 PERMISSION_DENIED（不泄漏会话是否存在）', async () => {
    const created = await createUpload()
    const uploadId = created.body.uploadId as string

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ctx.otherWorkspaceId}/uploads`,
      headers: bearer(ctx.token),
      payload: createBody(),
    })
    expect(create.statusCode).toBe(403)
    expect(create.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

    const part = await putPart(uploadId, 0, partOf(ORIGINAL, 0), { token: ctx.otherToken })
    expect(part.statusCode).toBe(403)
    expect(part.body.code).toBe('PERMISSION_DENIED')

    const done = await completeUpload(uploadId, ctx.otherToken)
    expect(done.statusCode).toBe(403)
    expect(done.body.code).toBe('PERMISSION_DENIED')
    expect(listFilesRecursive(ctx.storageRoot)).toEqual([])
  })

  it('非法 workspaceId → 400 VALIDATION_MALFORMED_ID', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/x!y/uploads',
      headers: bearer(ctx.token),
      payload: createBody(),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_MALFORMED_ID')
  })

  it('会话过期时间由 ttlSeconds 决定', async () => {
    const created = await createUpload({ ttlSeconds: 3600 })
    const createdAt = created.body.createdAt as UtcTimestamp
    expect(created.body.expiresAt).toBe(addMilliseconds(createdAt, 3600 * 1000))
    expect(Date.parse(created.body.expiresAt as string)).toBeGreaterThan(Date.parse(ctx.clock.now()))
  })
})
