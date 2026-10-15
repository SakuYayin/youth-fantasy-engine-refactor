/**
 * 资产登记面：下载 / 软删 / 引用。
 *
 * 三条判据：
 * 1. **下载读的是盘上的对象**（内容逐字节相等 + 头部正确），且对象不在盘上时
 *    必须报 `STORAGE_CORRUPT`，而不是回一个空的 200；
 * 2. **`storage_key` 是攻击面**：库里若出现逃逸键（这里直接插一行来模拟被污染的
 *    记账），下载必须被拒，而且根目录之外不能出现任何文件；
 * 3. **引用锁有效**：有引用时软删被拒并给出引用列表，解引用之后才能删；
 *    删完是软删（`deleted=1` + `deleted_at`），字节留在盘上。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { UserId, WorkspaceId } from '@yfe/contracts'

import { DEFAULT_SESSION_POLICY, issueSession } from '../src/auth/session.js'
import { findAssetById, insertAsset, listAssetRefs } from '../src/db/assets.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { ensureServerState } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { removeFileIfExists } from '../src/storage/localFs.js'
import { resolveUnderRoot } from '../src/storage/paths.js'
import { bearer, cleanupTempDirs, makeTempDir, seedOwner, testClock } from './helpers.js'
import type { TestClock } from './helpers.js'

const SERVER_ID = 'srv_assets_test'
const PART_SIZE = 8
const TOTAL_PARTS = 3
const ORIGINAL = Buffer.from('hello world 0123456789', 'utf8')
const ESCAPE_PROBE = 'yfe-escape-probe'

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Ctx {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
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
    issueSession(db, { userId, at: clock.now(), userAgent: null, clientIp: null, policy })
      .accessToken

  return {
    app,
    db,
    clock,
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

function assetsUrl(assetId: string, suffix = ''): string {
  return `/api/v1/workspaces/${ctx.workspaceId}/assets/${assetId}${suffix}`
}

/** 走完整链路造一个真实资产：建会话 → 传分片 → complete。 */
async function uploadAsset(
  bytes: Buffer = ORIGINAL,
  overrides: { readonly declaredName?: string; readonly declaredMime?: string } = {},
): Promise<{ readonly assetId: string; readonly storageKey: string; readonly digest: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ctx.workspaceId}/uploads`,
    headers: bearer(ctx.token),
    payload: {
      declaredSize: bytes.byteLength,
      declaredSha256: sha256Hex(bytes),
      partSizeBytes: PART_SIZE,
      ...(overrides.declaredName === undefined ? {} : { declaredName: overrides.declaredName }),
      ...(overrides.declaredMime === undefined ? {} : { declaredMime: overrides.declaredMime }),
    },
  })
  expect(created.statusCode).toBe(201)
  const uploadId = created.json<{ uploadId: string }>().uploadId

  for (let i = 0; i < TOTAL_PARTS; i += 1) {
    const part = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/workspaces/${ctx.workspaceId}/uploads/${uploadId}/parts/${i}`,
      headers: { ...bearer(ctx.token), 'content-type': 'application/octet-stream' },
      payload: bytes.subarray(i * PART_SIZE, (i + 1) * PART_SIZE),
    })
    expect(part.statusCode, `part ${i}`).toBe(200)
  }

  const done = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ctx.workspaceId}/uploads/${uploadId}/complete`,
    headers: bearer(ctx.token),
  })
  expect(done.statusCode).toBe(200)
  const body = done.json<{ assetId: string; storageKey: string; sha256: string }>()
  return { assetId: body.assetId, storageKey: body.storageKey, digest: body.sha256 }
}

function objectPath(storageKey: string): string {
  return resolveUnderRoot(ctx.storageRoot, `objects/${storageKey}`)
}

/** 直接插一行"记账说存在、键却是逃逸键"的资产，用来打下载路径的校验。 */
function insertHostileAsset(storageKey: string): string {
  const assetId = 'ast_hostile_probe'
  insertAsset(ctx.db, {
    assetId,
    workspaceId: ctx.workspaceId,
    attachmentId: null,
    storageKey,
    sha256: sha256Hex(ORIGINAL),
    byteSize: ORIGINAL.byteLength,
    mimeType: 'application/octet-stream',
    originalName: 'evil.bin',
    uploadedByUserId: ctx.userId,
    createdAt: ctx.clock.now(),
    verifiedAt: ctx.clock.now(),
  })
  return assetId
}

describe('下载资产', () => {
  it('缺少原文件名时仍强制 attachment，客户端声明 HTML 不能内联执行', async () => {
    const asset = await uploadAsset(ORIGINAL, { declaredMime: 'text/html' })
    const res = await ctx.app.inject({ method: 'GET', url: assetsUrl(asset.assetId), headers: bearer(ctx.token) })
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['content-disposition'])).toContain('attachment;')
    expect(String(res.headers['content-disposition'])).toContain(`${asset.assetId}.bin`)
    expect(res.rawPayload).toEqual(ORIGINAL)
  })

  it('按 storage_key 读盘，字节与头部都对', async () => {
    const asset = await uploadAsset(ORIGINAL, {
      declaredName: '报告.txt',
      declaredMime: 'text/plain',
    })

    const res = await ctx.app.inject({ method: 'GET', url: assetsUrl(asset.assetId), headers: bearer(ctx.token) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/plain')
    expect(res.headers['content-length']).toBe(String(ORIGINAL.byteLength))
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.rawPayload).toEqual(ORIGINAL)

    // 非 ASCII 文件名走 RFC 5987，头本身必须仍是 ASCII。
    const disposition = String(res.headers['content-disposition'])
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('报告.txt')}`)
    expect(/^[\x20-\x7e]*$/.test(disposition)).toBe(true)
  })

  it('没有声明 mime 时按 application/octet-stream 下发', async () => {
    const asset = await uploadAsset()
    const res = await ctx.app.inject({ method: 'GET', url: assetsUrl(asset.assetId), headers: bearer(ctx.token) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.rawPayload).toEqual(ORIGINAL)
  })

  it('未知资产 / 别的会话的资产 → 404 NOT_FOUND_ATTACHMENT', async () => {
    const missing = await ctx.app.inject({
      method: 'GET',
      url: assetsUrl('ast_does_not_exist'),
      headers: bearer(ctx.token),
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<{ code: string }>().code).toBe('NOT_FOUND_ATTACHMENT')

    const asset = await uploadAsset()
    // 换成"另一个工作区 + 那个工作区的成员"来要同一个 assetId：按不属于自己处理。
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.otherWorkspaceId}/assets/${asset.assetId}`,
      headers: bearer(ctx.otherToken),
    })
    expect(foreign.statusCode).toBe(404)
    expect(foreign.json<{ code: string }>().code).toBe('NOT_FOUND_ATTACHMENT')
  })

  it('记账说 present 但盘上对象没了 → 503 STORAGE_CORRUPT', async () => {
    const asset = await uploadAsset()
    expect(removeFileIfExists(objectPath(asset.storageKey))).toBe(true)

    const res = await ctx.app.inject({ method: 'GET', url: assetsUrl(asset.assetId), headers: bearer(ctx.token) })
    expect(res.statusCode).toBe(503)
    expect(res.json<{ code: string }>().code).toBe('STORAGE_CORRUPT')
  })

  it('库里的逃逸 storage_key 被拒，且根目录之外不会创建任何文件', async () => {
    const outside = resolve(ctx.storageRoot, '..', '..', '..', ESCAPE_PROBE)
    expect(existsSync(outside)).toBe(false)

    for (const hostileKey of [
      `../../../${ESCAPE_PROBE}/evil.bin`,
      '..\\..\\..\\' + ESCAPE_PROBE + '\\evil.bin',
      '/etc/passwd',
      'C:\\Windows\\System32\\evil.dll',
      `objects/../../${ESCAPE_PROBE}/evil.bin`,
    ]) {
      const assetId = insertHostileAsset(hostileKey)
      const res = await ctx.app.inject({
        method: 'GET',
        url: assetsUrl(assetId),
        headers: bearer(ctx.token),
      })
      expect(res.statusCode, hostileKey).toBe(503)
      expect(res.json<{ code: string }>().code, hostileKey).toBe('STORAGE_CORRUPT')
      // 错误体里不能带出本地绝对路径（也不会有栈）。
      expect(res.body, hostileKey).not.toContain(ctx.storageRoot)
      await ctx.db.prepare('DELETE FROM assets WHERE asset_id = ?').run(assetId)
    }

    expect(existsSync(outside)).toBe(false)
    expect(existsSync(resolve(outside, 'evil.bin'))).toBe(false)
  })
})

describe('引用（幂等）与按实体反查', () => {
  it('POST 建引用幂等：第一次 201，第二次 200，只有一行', async () => {
    const asset = await uploadAsset()
    const first = await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: 'n1' },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json<Record<string, unknown>>()).toMatchObject({
      assetId: asset.assetId,
      entityType: 'note',
      entityId: 'n1',
      created: true,
      refCount: 1,
    })

    const again = await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: 'n1' },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json<Record<string, unknown>>()).toMatchObject({ created: false, refCount: 1 })
    expect(listAssetRefs(ctx.db, asset.assetId)).toHaveLength(1)
  })

  it('列引用 + 按实体反查都能看到这条引用', async () => {
    const asset = await uploadAsset()
    await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: 'n1' },
    })

    const list = await ctx.app.inject({
      method: 'GET',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
    })
    expect(list.statusCode).toBe(200)
    const listed = list.json<{ refCount: number; refs: readonly Record<string, string>[] }>()
    expect(listed.refCount).toBe(1)
    expect(listed.refs[0]).toMatchObject({ assetId: asset.assetId, entityType: 'note', entityId: 'n1' })

    const byEntity = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.workspaceId}/asset-refs?entityType=note&entityId=n1`,
      headers: bearer(ctx.token),
    })
    expect(byEntity.statusCode).toBe(200)
    expect(byEntity.json<{ assetIds: readonly string[]; refCount: number }>()).toMatchObject({
      assetIds: [asset.assetId],
      refCount: 1,
    })
  })

  it('entityType 形状非法 → 400 VALIDATION_FAILED，entityId 不是 well-formed id → 400', async () => {
    const asset = await uploadAsset()
    const badType = await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: '9bad', entityId: 'n1' },
    })
    expect(badType.statusCode).toBe(400)
    expect(badType.json<{ code: string; detail: Record<string, unknown> }>().code).toBe('VALIDATION_FAILED')

    const badId = await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: '..' },
    })
    expect(badId.statusCode).toBe(400)
    expect(badId.json<{ code: string }>().code).toBe('VALIDATION_MALFORMED_ID')
    expect(listAssetRefs(ctx.db, asset.assetId)).toHaveLength(0)
  })
})

describe('软删与引用锁', () => {
  it('有引用时 DELETE → 409 RESOURCE_LOCKED 且 detail 给出引用列表；解引用后可删', async () => {
    const asset = await uploadAsset()
    const ref = { entityType: 'note', entityId: 'n1' }
    await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: ref,
    })

    const locked = await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(locked.statusCode).toBe(409)
    const lockedBody = locked.json<{ code: string; detail: Record<string, unknown> }>()
    expect(lockedBody.code).toBe('RESOURCE_LOCKED')
    expect(lockedBody.detail).toMatchObject({ assetId: asset.assetId, refCount: 1 })
    // detail 放不下数组，所以引用列表是 JSON 字符串。
    expect(JSON.parse(String(lockedBody.detail.refs))).toEqual(['note:n1'])
    expect(findAssetById(ctx.db, asset.assetId)?.deleted).toBe(0)

    // 被引用锁挡住时，资产仍然可下载。
    const stillThere = await ctx.app.inject({
      method: 'GET',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(stillThere.statusCode).toBe(200)

    const unref = await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId, '/refs?entityType=note&entityId=n1'),
      headers: bearer(ctx.token),
    })
    expect(unref.statusCode).toBe(200)
    expect(unref.json<Record<string, unknown>>()).toMatchObject({ removed: true, refCount: 0 })

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json<Record<string, unknown>>()).toMatchObject({ deleted: true, refCount: 0 })
    const row = findAssetById(ctx.db, asset.assetId)
    expect(row?.deleted).toBe(1)
    expect(typeof row?.deletedAt).toBe('string')

    // 软删之后：下载 404，字节仍留在盘上。
    const afterDelete = await ctx.app.inject({
      method: 'GET',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(afterDelete.statusCode).toBe(404)
    expect(afterDelete.json<{ code: string }>().code).toBe('NOT_FOUND_ATTACHMENT')
    expect(existsSync(objectPath(asset.storageKey))).toBe(true)
  })

  it('无引用时直接软删，重复 DELETE 幂等', async () => {
    const asset = await uploadAsset()
    const first = await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(first.statusCode).toBe(200)
    expect(first.json<Record<string, unknown>>()).toMatchObject({ deleted: true })

    const second = await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    expect(second.statusCode).toBe(200)
    expect(second.json<Record<string, unknown>>()).toMatchObject({ deleted: true, idempotent: true })
  })

  it('已软删的资产不能新增引用 → 409 STATE_INVALID_TRANSITION', async () => {
    const asset = await uploadAsset()
    await ctx.app.inject({
      method: 'DELETE',
      url: assetsUrl(asset.assetId),
      headers: bearer(ctx.token),
    })
    const res = await ctx.app.inject({
      method: 'POST',
      url: assetsUrl(asset.assetId, '/refs'),
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: 'n1' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('STATE_INVALID_TRANSITION')
  })

  it('非法 assetId → 400 VALIDATION_MALFORMED_ID', async () => {
    // ⚠️ 不能用 `'..'` 当"非法 ID"探针：URL 规范化会把 `/assets/..` 折成 `/assets/`，
    // 路由根本匹配不上，于是拿到的是路由层 404 `NOT_FOUND`（`detail.route === null`），
    // 而不是参数校验的 400。这里要的是**能被路由匹配、但不满足 ID_PATTERN** 的段。
    const res = await ctx.app.inject({
      method: 'GET',
      url: assetsUrl('-bad-id'),
      headers: bearer(ctx.token),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_MALFORMED_ID')
  })
})

describe('鉴权（资产链路）', () => {
  it('未认证 → 401 AUTH_REQUIRED', async () => {
    const asset = await uploadAsset()
    for (const [method, url] of [
      ['GET', assetsUrl(asset.assetId)],
      ['DELETE', assetsUrl(asset.assetId)],
      ['GET', assetsUrl(asset.assetId, '/refs')],
      ['POST', assetsUrl(asset.assetId, '/refs')],
      ['GET', `/api/v1/workspaces/${ctx.workspaceId}/asset-refs?entityType=note&entityId=n1`],
    ] as const) {
      const res = await ctx.app.inject({ method, url, payload: method === 'POST' ? { entityType: 'note', entityId: 'n1' } : undefined })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
      expect(res.json<{ code: string }>().code, `${method} ${url}`).toBe('AUTH_REQUIRED')
    }
  })

  it('跨工作区 → 403 PERMISSION_DENIED', async () => {
    const asset = await uploadAsset()
    const foreign = `/api/v1/workspaces/${ctx.otherWorkspaceId}/assets/${asset.assetId}`

    const read = await ctx.app.inject({ method: 'GET', url: foreign, headers: bearer(ctx.token) })
    expect(read.statusCode).toBe(403)
    expect(read.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

    const remove = await ctx.app.inject({ method: 'DELETE', url: foreign, headers: bearer(ctx.token) })
    expect(remove.statusCode).toBe(403)

    const createRef = await ctx.app.inject({
      method: 'POST',
      url: `${foreign}/refs`,
      headers: bearer(ctx.token),
      payload: { entityType: 'note', entityId: 'n1' },
    })
    expect(createRef.statusCode).toBe(403)

    const byEntity = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${ctx.otherWorkspaceId}/asset-refs?entityType=note&entityId=n1`,
      headers: bearer(ctx.token),
    })
    expect(byEntity.statusCode).toBe(403)
    expect(findAssetById(ctx.db, asset.assetId)?.deleted).toBe(0)
  })
})
