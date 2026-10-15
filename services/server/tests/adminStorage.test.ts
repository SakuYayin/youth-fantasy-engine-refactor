/**
 * 管理面存储路由（`src/routes/adminStorage.ts`）—— 汇编层（HTTP）行为。
 *
 * ## 为什么每个用例都用**真实文件库**
 *
 * 备份走 SQLite 在线备份 API、WAL 是同目录的 `-wal` 文件、恢复靠"复制 + 原子换名"。
 * 这些行为在 `:memory:` 上**根本不存在**（内存库没有文件、没有 WAL、没有换名），
 * 用内存库跑这套用例会全绿却什么都没验证到（R-25 的教训：`db/open.ts` 的 pragma
 * 少写 `{simple:true}`，真实文件库 100% 启动失败，而内存库的用例全绿）。
 * 所以本文件自己组装 `openServerDatabase(真实路径)` + `migrateServerDatabase` +
 * `markServerInitialized` 的夹具，不复用 `makeHarness`（它用的是 `:memory:`）。
 *
 * ## 本文件盯住的三条纪律
 *
 * 1. **权限**：非系统管理员一个字节都不给（`server_state.owner_user_id` 是唯一判据）；
 * 2. **恢复的三道闸门**：维护模式 → 二次认证（当前管理员密码）→ 目标已存在需显式覆盖；
 * 3. **恢复不留坏库**：恢复中途任何一步失败，目标库要么保持原样，要么不存在，
 *    绝不会"改写了一半的库被当成好库继续跑"。
 *
 * 路由由 `registerRoutes()` 统一登记（`src/routes/index.ts`），`createServer()` 的
 * 全表装配就会带上它们；因此夹具**不再**自行 `registerAdminStorageRoutes`——
 * 重复注册同一 method+url 会让 Fastify 抛 `FST_ERR_ROUTE_ALREADY_DECLARED`（R-39）。
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { RequestId, UserId } from '@yfe/contracts'

import { DEFAULT_SESSION_POLICY, issueSession } from '../src/auth/session.js'
import { queryAuditEvents, recordAuditEvent } from '../src/db/audit.js'
import { SERVER_SCHEMA_VERSION, SERVER_TABLES } from '../src/db/ddl.js'
import { SERVER_MIGRATIONS_TABLE, migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, hasTable, openServerDatabase, type ServerDb } from '../src/db/open.js'
import { ensureServerState, markServerInitialized } from '../src/db/serverState.js'
import { defaultServerConfig } from '../src/http/config.js'
import { createServer } from '../src/http/server.js'
import { STORAGE_AUDIT_ACTIONS } from '../src/routes/adminStorage.js'
import {
  BACKUP_FILE_SUFFIX,
  BACKUP_RESTORE_TEMP_SUFFIX,
  createStorageBackup,
  manifestPathFor,
  restoreStorageBackup,
  type CreatedStorageBackup,
} from '../src/storage/backup.js'
import { sha256OfFile } from '../src/storage/localFs.js'
import { storageRootFromDataDir } from '../src/storage/paths.js'
import { bearer, cleanupTempDirs, makeTempDir, seedOwner, testClock, type TestClock } from './helpers.js'

const SERVER_ID = 'srv_admin_storage_test'
const REQUEST_ID = 'req_admin_storage_test' as RequestId
const ADMIN_STORAGE_URL = '/api/v1/admin/storage'
const PROBE_URL = `${ADMIN_STORAGE_URL}/probe`
const BACKUPS_URL = `${ADMIN_STORAGE_URL}/backups`
const VERIFY_URL = `${BACKUPS_URL}/verify`
const RESTORE_URL = `${BACKUPS_URL}/restore`

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

interface StorageFixture {
  readonly base: string
  readonly dataDir: string
  readonly databasePath: string
  readonly assetRoot: string
  readonly backupRoot: string
  readonly externalDir: string
  readonly db: ServerDb
  readonly clock: TestClock
  readonly app: FastifyInstance
  readonly ownerUserId: UserId
  readonly ownerToken: string
  readonly memberToken: string
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close()
  }
})

afterAll(() => {
  cleanupTempDirs()
})

async function makeStorageFixture(): Promise<StorageFixture> {
  const base = makeTempDir()
  const dataDir = join(base, 'data')
  const assetRoot = storageRootFromDataDir(dataDir)
  const backupRoot = join(dataDir, 'backups')
  const externalDir = join(base, 'external-nas')
  for (const dir of [assetRoot, backupRoot, join(dataDir, 'db'), externalDir]) {
    mkdirSync(dir, { recursive: true })
  }

  const databasePath = join(dataDir, 'db', 'server.db')
  const clock = testClock()
  const db = openServerDatabase(databasePath)
  migrateServerDatabase(db)
  const owner = await seedOwner(db, clock.now())
  const member = await seedOwner(db, clock.now(), { username: 'member', role: 'viewer' })
  ensureServerState(db, SERVER_ID, null)
  markServerInitialized(db, owner.userId, clock.now())

  const config = defaultServerConfig({
    dataDir,
    databasePath,
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
  })
  const app = createServer({
    config,
    db,
    serverId: SERVER_ID,
    clock,
    logger: false,
    storageRoot: assetRoot,
  })
  await app.ready()

  closers.push(async () => {
    await app.close()
    closeServerDatabase(db)
  })

  return {
    base,
    dataDir,
    databasePath,
    assetRoot,
    backupRoot,
    externalDir,
    db,
    clock,
    app,
    ownerUserId: owner.userId,
    ownerToken: issueSession(db, {
      userId: owner.userId,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      policy: config.sessionPolicy,
    }).accessToken,
    memberToken: issueSession(db, {
      userId: member.userId,
      at: clock.now(),
      userAgent: null,
      clientIp: null,
      policy: config.sessionPolicy,
    }).accessToken,
  }
}

async function createBackup(fixture: StorageFixture, fileName?: string): Promise<CreatedStorageBackup> {
  return createStorageBackup(fixture.db, {
    backupRoot: fixture.backupRoot,
    createdAt: fixture.clock.now(),
    requestId: REQUEST_ID,
    ...(fileName === undefined ? {} : { fileName }),
  })
}

/** 改一个字节但**不改字节数**：这样只有 sha256 会失败，能精确验证校验和这一层。 */
function flipOneByte(filePath: string): void {
  const bytes = readFileSync(filePath)
  bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff
  writeFileSync(filePath, bytes)
}

/** 重新算字节数与 sha256 写回清单（可选再补几个字段），把"内容被改过"这件事藏起来。 */
async function resyncManifest(databasePath: string, patch: Record<string, unknown> = {}): Promise<void> {
  const manifestPath = manifestPathFor(databasePath)
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const database = raw['database'] as Record<string, unknown>
  database['bytes'] = statSync(databasePath).size
  database['sha256'] = await sha256OfFile(databasePath)
  Object.assign(raw, patch)
  writeFileSync(manifestPath, JSON.stringify(raw, null, 2))
}

function removeWalSidecars(databasePath: string): void {
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    rmSync(sidecar, { force: true })
  }
}

describe('GET /api/v1/admin/storage（存储概览）', () => {
  it('未认证 → 401 AUTH_REQUIRED', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({ method: 'GET', url: ADMIN_STORAGE_URL })
    expect(response.statusCode).toBe(401)
    expect(response.json<ErrorBody>().code).toBe('AUTH_REQUIRED')
  })

  it('非系统管理员 → 403，且响应体不泄露任何路径', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'GET',
      url: ADMIN_STORAGE_URL,
      headers: bearer(fixture.memberToken),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
    expect(response.body).not.toContain(fixture.dataDir)
  })

  it('系统管理员 → 200：库文件/WAL/资产/备份/版本/磁盘空间，cache-control 禁止缓存', async () => {
    const fixture = await makeStorageFixture()
    const walPath = `${fixture.databasePath}-wal`
    const response = await fixture.app.inject({
      method: 'GET',
      url: ADMIN_STORAGE_URL,
      headers: bearer(fixture.ownerToken),
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = response.json<{
      dataDir: string
      databasePath: string
      database: {
        bytes: number | null
        walBytes: number | null
        shmBytes: number | null
        schemaVersion: number
        expectedSchemaVersion: number
        migrationsApplied: number
      }
      assets: { root: string; objectCount: number; objectBytes: number }
      backups: { root: string; count: number; totalBytes: number }
      disk: { freeBytes: number | null; totalBytes: number | null }
      warnings: readonly string[]
    }>()

    expect(body.dataDir).toBe(fixture.dataDir)
    expect(body.databasePath).toBe(fixture.databasePath)
    expect(body.database.bytes).toBe(statSync(fixture.databasePath).size)
    // WAL 字节数必须"如实"：文件在就是它的真实大小，不在就是 null（不能编 0）。
    const walExists = existsOf(walPath)
    expect(body.database.walBytes).toBe(walExists ? statSync(walPath).size : null)
    expect(body.database.expectedSchemaVersion).toBe(SERVER_SCHEMA_VERSION)
    expect(body.database.schemaVersion).toBe(SERVER_SCHEMA_VERSION)
    expect(body.database.migrationsApplied).toBeGreaterThan(0)
    expect(body.assets.root).toBe(fixture.assetRoot)
    expect(body.assets.objectCount).toBe(0)
    expect(body.assets.objectBytes).toBe(0)
    expect(body.backups.root).toBe(fixture.backupRoot)
    expect(body.backups.count).toBe(0)
    expect(body.backups.totalBytes).toBe(0)
    expect(body.disk.freeBytes === null || typeof body.disk.freeBytes === 'number').toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(response.body).not.toContain('stack')
  })

  it('备份目录里的备份会计入 count/totalBytes 与资产统计', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'GET',
      url: ADMIN_STORAGE_URL,
      headers: bearer(fixture.ownerToken),
    })
    const body = response.json<{ backups: { count: number; totalBytes: number } }>()
    expect(body.backups.count).toBe(1)
    expect(body.backups.totalBytes).toBe(created.bytes)
  })
})

describe('POST /api/v1/admin/storage/probe（路径探测）', () => {
  it('非系统管理员 → 403', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.memberToken),
      payload: { targetPath: fixture.assetRoot, kind: 'asset' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
  })

  it('非绝对路径 → 400 VALIDATION_FAILED（detail.reason = not_absolute）', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: 'assets/objects', kind: 'asset' },
    })
    expect(response.statusCode).toBe(400)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.detail?.['reason']).toBe('not_absolute')
  })

  it('越出该 kind 的受管根 → 403 PERMISSION_DENIED（批准也不放行）', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: join(fixture.dataDir, 'db'), kind: 'asset', acknowledgeExternal: true },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().detail?.['reason']).toBe('path_escape')
  })

  it('符号链接逃逸 → 403（detail.reason = symlink_escape）', async () => {
    const fixture = await makeStorageFixture()
    const link = join(fixture.assetRoot, 'escape-link')
    symlinkSync(join(fixture.dataDir, 'db'), link, 'junction')
    const response = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: link, kind: 'asset' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().detail?.['reason']).toBe('symlink_escape')
  })

  it('acknowledgeExternal 开关：外部分区默认拒绝，显式批准后放行并留痕', async () => {
    const fixture = await makeStorageFixture()
    const denied = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: fixture.externalDir, kind: 'backup' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json<ErrorBody>().detail?.['reason']).toBe('external_target_requires_acknowledge')

    const allowed = await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: fixture.externalDir, kind: 'backup', acknowledgeExternal: true },
    })
    expect(allowed.statusCode).toBe(200)
    const body = allowed.json<{
      resolvedPath: string
      exists: boolean
      isDirectory: boolean
      readable: boolean
      writable: boolean
      insideDataDir: boolean
      isSymlink: boolean
      realPath: string
      warnings: readonly string[]
    }>()
    expect(body.resolvedPath).toBe(fixture.externalDir)
    expect(body.insideDataDir).toBe(false)
    expect(body.warnings).toContain('external_target_acknowledged')
    // 探测结果里只出现"管理员自己传来的路径"，没有别的绝对路径。
    expect(Object.keys(body).sort()).toEqual([
      'exists',
      'insideDataDir',
      'isDirectory',
      'isSymlink',
      'readable',
      'realPath',
      'resolvedPath',
      'warnings',
      'writable',
    ])
    expect(body.realPath).toBe(fixture.externalDir)
  })

  it('每次探测都写审计（只记决策与 kind，不记路径内容）', async () => {
    const fixture = await makeStorageFixture()
    await fixture.app.inject({
      method: 'POST',
      url: PROBE_URL,
      headers: bearer(fixture.ownerToken),
      payload: { targetPath: fixture.assetRoot, kind: 'asset' },
    })
    const events = queryAuditEvents(fixture.db, { action: STORAGE_AUDIT_ACTIONS.probe })
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.outcome).toBe('success')
    expect(JSON.stringify(events[0]?.detail ?? {})).not.toContain(fixture.dataDir)
  })
})

describe('POST /api/v1/admin/storage/backups（创建一致备份）', () => {
  it('非系统管理员 → 403，不产生任何文件', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: BACKUPS_URL,
      headers: bearer(fixture.memberToken),
      payload: {},
    })
    expect(response.statusCode).toBe(403)
    expect(readdirSyncOf(fixture.backupRoot)).toEqual([])
  })

  it('管理员 → 201，且备份 = 一致库文件 + manifest（含校验和、版本、表行数）', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: BACKUPS_URL,
      headers: bearer(fixture.ownerToken),
      payload: { fileName: 'manual.db' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json<{
      fileName: string
      bytes: number
      sha256: string
      databaseSchemaVersion: number
      tableCount: number
      totalRows: number
      containsSecrets: boolean
      attachmentsIncluded: boolean
    }>()
    expect(body.fileName).toBe(`manual.db`)
    expect(body.bytes).toBeGreaterThan(0)
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(body.databaseSchemaVersion).toBe(SERVER_SCHEMA_VERSION)
    expect(body.tableCount).toBeGreaterThan(0)
    expect(body.containsSecrets).toBe(false)
    expect(body.attachmentsIncluded).toBe(false)

    const backupPath = join(fixture.backupRoot, 'manual.db')
    const manifestPath = manifestPathFor(backupPath)
    expect(existsOf(backupPath)).toBe(true)
    expect(existsOf(manifestPath)).toBe(true)
    expect(statSync(backupPath).size).toBe(body.bytes)
    expect(readFileSync(manifestPath, 'utf8')).toContain('"containsSecrets": false')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      manifestVersion: number
      databaseSchemaVersion: number
      database: { sha256: string; bytes: number }
      migrations: readonly { version: number; checksum: string; success: boolean }[]
      tables: readonly { table: string; rows: number }[]
      createdAt: string
    }
    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.database.sha256).toBe(body.sha256)
    expect(manifest.database.bytes).toBe(body.bytes)
    expect(manifest.migrations.length).toBeGreaterThan(0)
    expect(manifest.migrations.every((row) => row.checksum.length > 0 && row.success)).toBe(true)
    expect(manifest.tables.some((row) => row.table === SERVER_TABLES.auditEvents)).toBe(true)
    expect(manifest.createdAt).toBe(fixture.clock.now())

    // 审计：创建备份是运维动作，必须留痕。
    const events = queryAuditEvents(fixture.db, { action: STORAGE_AUDIT_ACTIONS.backupCreated })
    expect(events.length).toBe(1)
  })

  it('活动 WAL 里已提交的数据也会进备份（"只复制主文件"会漏掉它们）', async () => {
    const fixture = await makeStorageFixture()
    // 关掉自动 checkpoint：接下来的提交只写进 `-wal`，主库文件本身不包含这些页面。
    fixture.db.pragma('wal_autocheckpoint = 0')
    const marker = 'storage.backup.wal_marker'
    const rows = 40
    for (let index = 0; index < rows; index += 1) {
      recordAuditEvent(fixture.db, {
        action: marker,
        outcome: 'success',
        at: fixture.clock.now(),
        requestId: REQUEST_ID,
      })
    }
    expect(statSync(`${fixture.databasePath}-wal`).size).toBeGreaterThan(0)

    // 走 SQLite 在线备份 API（`backupServerDatabase`）：-wal 里的已提交数据必须在。
    const created = await createBackup(fixture, 'wal.db')
    const backedUp = openServerDatabase(created.databasePath, { readOnly: true, fileMustExist: true })
    try {
      const counted = backedUp.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?').get(marker) as {
        n: number
      }
      expect(counted.n).toBe(rows)
    } finally {
      closeServerDatabase(backedUp)
    }

    // 反证：只复制主库文件（不含 -wal）拿不到这些行 —— 这就是禁用"只复制主文件"的原因。
    // 实测更狠：此时主库文件里连 `audit_events` 表都还没有（建表语句同样只在 -wal 里），
    // 也就是说"只复制主文件"得到的不是"少几行"，而是一个连结构都没有的库文件。
    const plainCopy = join(fixture.base, 'plain-copy.db')
    copyFileSync(fixture.databasePath, plainCopy)
    const stale = openServerDatabase(plainCopy, { readOnly: true, fileMustExist: true })
    try {
      const counted = hasTable(stale, SERVER_TABLES.auditEvents)
        ? ((stale.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?').get(marker) as { n: number }).n ?? 0)
        : 0
      expect(counted).toBe(0)
    } finally {
      closeServerDatabase(stale)
    }
  })

  it('同名备份已存在 → 409 ALREADY_EXISTS（不覆盖已有备份）', async () => {
    const fixture = await makeStorageFixture()
    await createBackup(fixture, 'dup.db')
    const response = await fixture.app.inject({
      method: 'POST',
      url: BACKUPS_URL,
      headers: bearer(fixture.ownerToken),
      payload: { fileName: 'dup.db' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().code).toBe('ALREADY_EXISTS')
  })

  it('备份目录不可用时不留半截文件（用普通文件冒充目录）', async () => {
    const fixture = await makeStorageFixture()
    const fakeRoot = join(fixture.base, 'not-a-directory')
    writeFileSync(fakeRoot, 'plain file')
    await expect(
      createStorageBackup(fixture.db, {
        backupRoot: fakeRoot,
        createdAt: fixture.clock.now(),
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrowError(/./)
    expect(readdirSyncOf(fixture.backupRoot).filter((name) => name.endsWith(BACKUP_FILE_SUFFIX))).toEqual([])
  })
})

describe('GET /api/v1/admin/storage/backups（列出备份）', () => {
  it('非系统管理员 → 403', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'GET',
      url: BACKUPS_URL,
      headers: bearer(fixture.memberToken),
    })
    expect(response.statusCode).toBe(403)
  })

  it('管理员 → 200：只有文件名/字节数/时间/是否带清单，绝不含绝对路径', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture, 'listed.db')
    // 一个没有清单的孤儿备份文件：列表要如实标 hasManifest=false。
    writeFileSync(join(fixture.backupRoot, 'orphan.db'), 'not a database')

    const response = await fixture.app.inject({
      method: 'GET',
      url: BACKUPS_URL,
      headers: bearer(fixture.ownerToken),
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      backups: readonly { fileName: string; bytes: number; modifiedAt: string; hasManifest: boolean }[]
    }>()
    const listed = body.backups.find((entry) => entry.fileName === 'listed.db')
    expect(listed).toBeDefined()
    expect(listed?.bytes).toBe(created.bytes)
    expect(listed?.hasManifest).toBe(true)
    // 列表里的时间就是磁盘上的 mtime（时钟是注入的，文件系统不喜欢被骗）。
    expect(listed?.modifiedAt).toBe(statSync(join(fixture.backupRoot, 'listed.db')).mtime.toISOString())
    expect(body.backups.find((entry) => entry.fileName === 'orphan.db')?.hasManifest).toBe(false)

    // 🔴 绝对路径会带出操作系统用户名，响应体里一个都不能有。
    expect(response.body).not.toContain(fixture.backupRoot)
    expect(response.body).not.toContain(fixture.base)
    expect(Object.keys(listed ?? {}).sort()).toEqual(['bytes', 'fileName', 'hasManifest', 'modifiedAt'])
    expect(readdirSyncOf(fixture.backupRoot)).toEqual(['listed.db', 'listed.db.manifest.json', 'orphan.db'])
  })
})

describe('POST /api/v1/admin/storage/backups/verify（校验备份）', () => {
  it('非系统管理员 → 403', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.memberToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(403)
  })

  it('正常备份 → 200：按顺序走完存在性/清单/字节数/校验和/完整性/表/版本/迁移/行数', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      fileName: string
      bytes: number
      sha256: string
      integrityCheck: string
      databaseSchemaVersion: number
      expectedSchemaVersion: number
      migrations: readonly { version: number; checksum: string; success: boolean }[]
      tables: readonly { table: string; rows: number }[]
      checks: readonly string[]
    }>()
    expect(body.fileName).toBe(created.fileName)
    expect(body.bytes).toBe(created.bytes)
    expect(body.sha256).toBe(created.sha256)
    expect(body.integrityCheck).toBe('ok')
    expect(body.databaseSchemaVersion).toBe(SERVER_SCHEMA_VERSION)
    expect(body.expectedSchemaVersion).toBe(SERVER_SCHEMA_VERSION)
    expect(body.migrations.length).toBeGreaterThan(0)
    expect(body.tables.some((row) => row.table === SERVER_TABLES.auditEvents)).toBe(true)
    expect(body.checks).toEqual([
      'exists',
      'manifest',
      'bytes',
      'sha256',
      'integrity_check',
      'tables_present',
      'schema_version',
      'schema_compatible',
      'migrations',
      'row_counts',
    ])
  })

  it('篡改一个字节 → 503 STORAGE_CORRUPT（detail.reason = sha256_mismatch）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    flipOneByte(created.databasePath)

    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(503)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('STORAGE_CORRUPT')
    expect(error.detail?.['reason']).toBe('sha256_mismatch')
  })

  it('缺表 → 503 STORAGE_CORRUPT，且 detail.missingTable 指向真的缺的那张表', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)

    // 删掉一张必须存在的表，然后把字节数/校验和"对齐"清单（否则会先被 sha256 拦住）。
    const copy = openServerDatabase(created.databasePath)
    copy.exec(`DROP TABLE ${SERVER_TABLES.auditEvents}`)
    closeServerDatabase(copy)
    removeWalSidecars(created.databasePath)
    await resyncManifest(created.databasePath)

    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(503)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('STORAGE_CORRUPT')
    expect(error.detail?.['reason']).toBe('missing_table')
    expect(error.detail?.['missingTable']).toBe(SERVER_TABLES.auditEvents)
  })

  it('库版本比程序新 → 503 STORAGE_SCHEMA_TOO_NEW（必须拒绝，不做"尽力打开"）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)

    const newer = SERVER_SCHEMA_VERSION + 1
    const copy = openServerDatabase(created.databasePath)
    copy
      .prepare(
        `INSERT INTO ${SERVER_MIGRATIONS_TABLE} (version, checksum, applied_at, success) VALUES (?, ?, ?, 1)`,
      )
      .run(newer, 'checksum-from-a-newer-build', fixture.clock.now())
    closeServerDatabase(copy)
    removeWalSidecars(created.databasePath)
    await resyncManifest(created.databasePath, { databaseSchemaVersion: newer })

    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(503)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('STORAGE_SCHEMA_TOO_NEW')
    expect(error.detail?.['reason']).toBe('schema_too_new')
    expect(error.detail?.['databaseSchemaVersion']).toBe(newer)
  })

  it('清单被截断/缺字段 → 503 STORAGE_CORRUPT（不允许"缺了当默认值"）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const manifestPath = manifestPathFor(created.databasePath)
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    delete raw['migrations']
    writeFileSync(manifestPath, JSON.stringify(raw))

    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: created.databasePath },
    })
    expect(response.statusCode).toBe(503)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('STORAGE_CORRUPT')
    expect(error.detail?.['reason']).toBe('manifest_field_invalid')
  })

  it('备份不存在 → 404 NOT_FOUND（不是"空库"）', async () => {
    const fixture = await makeStorageFixture()
    const response = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: join(fixture.backupRoot, 'nope.db') },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().code).toBe('NOT_FOUND')
  })

  it('备份在备份目录之外：未批准拒绝，批准后可用（NAS 副本）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const externalCopy = join(fixture.externalDir, 'nas-copy.db')
    copyFileSync(created.databasePath, externalCopy)
    copyFileSync(manifestPathFor(created.databasePath), manifestPathFor(externalCopy))

    const denied = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: externalCopy },
    })
    expect(denied.statusCode).toBe(403)

    const allowed = await fixture.app.inject({
      method: 'POST',
      url: VERIFY_URL,
      headers: bearer(fixture.ownerToken),
      payload: { backupPath: externalCopy, acknowledgeExternal: true },
    })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json<{ integrityCheck: string }>().integrityCheck).toBe('ok')
  })
})

describe('POST /api/v1/admin/storage/backups/restore（恢复：管理员 + 维护模式 + 二次认证）', () => {
  it.each(['', '-wal', '-shm'])('拒绝在线覆盖当前主库及旁挂文件 %s，保持数据库可用', async (suffix) => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'POST', url: RESTORE_URL, headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: `${fixture.databasePath}${suffix}`,
        confirmPassword: 'correct-horse-battery', maintenance: true, overwrite: true,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().code).toBe('RESOURCE_LOCKED')
    expect(response.json<ErrorBody>().detail?.reason).toBe('active_database_target')
    expect(fixture.db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('最终目标复核失败时恢复原文件，原文件与备份同长度也不能丢失', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.base, 'rollback-target.db')
    const original = Buffer.alloc(created.bytes, 0x41)
    writeFileSync(target, original)
    let checked = 0
    await expect(restoreStorageBackup({
      requestId: REQUEST_ID, sourcePath: created.databasePath, targetPath: target, overwrite: true,
      verifyDatabase: () => {
        checked += 1
        if (checked === 2) throw new Error('最终目标复核失败')
      },
    })).rejects.toThrow('最终目标复核失败')

    expect(checked).toBe(2)
    expect(readFileSync(target)).toEqual(original)
    expect(existsOf(`${target}${BACKUP_RESTORE_TEMP_SUFFIX}`)).toBe(false)
    expect(readdirSync(fixture.base).filter((name) => name.startsWith('rollback-target.db.previous-'))).toEqual([])
  })

  it('非系统管理员 → 403（密码对、维护模式开着也不行）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.memberToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: join(fixture.dataDir, 'db', 'restored.db'),
        confirmPassword: 'correct-horse-battery',
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().code).toBe('PERMISSION_DENIED')
  })

  it('未开维护模式 → 409 STATE_INVALID_TRANSITION（detail.reason = maintenance_required）并留 denied 审计', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.dataDir, 'db', 'restored.db')
    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'correct-horse-battery',
        maintenance: false,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().detail?.['reason']).toBe('maintenance_required')
    expect(existsOf(target)).toBe(false)

    const events = queryAuditEvents(fixture.db, { action: STORAGE_AUDIT_ACTIONS.backupRestored })
    expect(events[0]?.outcome).toBe('denied')
  })

  it('二次认证失败 → 401 AUTH_INVALID_CREDENTIALS，目标库不被创建', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.dataDir, 'db', 'restored.db')
    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'wrong-password',
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(401)
    const error = response.json<ErrorBody>()
    expect(error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(error.detail?.['reason']).toBe('confirm_password_invalid')
    expect(existsOf(target)).toBe(false)
  })

  it('缺少 confirmPassword → 400（schema 层拒绝，不会走到二次认证）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: join(fixture.dataDir, 'db', 'restored.db'),
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().code).toBe('VALIDATION_FAILED')
  })

  it('目标已存在且未显式覆盖 → 409 ALREADY_EXISTS（先检查，后动手）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.dataDir, 'db', 'existing.db')
    writeFileSync(target, 'existing database placeholder')

    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'correct-horse-battery',
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().code).toBe('ALREADY_EXISTS')
    expect(readFileSync(target, 'utf8')).toBe('existing database placeholder')
  })

  it('成功恢复 → 200，目标库字节数与源一致且能被正常打开', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.dataDir, 'db', 'restored.db')

    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'correct-horse-battery',
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      restored: boolean
      sourceFileName: string
      targetFileName: string
      bytes: number
      sha256: string
    }>()
    expect(body).toMatchObject({
      restored: true,
      sourceFileName: created.fileName,
      targetFileName: 'restored.db',
      bytes: created.bytes,
      sha256: created.sha256,
    })
    expect(existsOf(`${target}${BACKUP_RESTORE_TEMP_SUFFIX}`)).toBe(false)

    // 恢复出来的库是**可用的**：不是"文件存在"就算成功。
    const restored = openServerDatabase(target, { readOnly: true, fileMustExist: true })
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(restored.prepare(`SELECT COUNT(*) AS rows FROM ${SERVER_TABLES.users}`).get()).toMatchObject({
        rows: 2,
      })
    } finally {
      closeServerDatabase(restored)
    }

    const events = queryAuditEvents(fixture.db, { action: STORAGE_AUDIT_ACTIONS.backupRestored })
    expect(events[0]?.outcome).toBe('success')
  })

  it('目标已存在 + overwrite:true → 覆盖成功', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.dataDir, 'db', 'overwrite.db')
    writeFileSync(target, 'existing database placeholder')

    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'correct-horse-battery',
        maintenance: true,
        overwrite: true,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(statSync(target).size).toBe(created.bytes)
  })

  it('恢复中途校验失败 → 不留下损坏的目标库（旧内容原样保留，临时文件被清掉）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.base, 'restore-target.db')
    const original = 'the-old-database-content'
    writeFileSync(target, original)

    await expect(
      restoreStorageBackup({
        requestId: REQUEST_ID,
        sourcePath: created.databasePath,
        targetPath: target,
        overwrite: true,
        // 注入一个"必然失败"的复核：模拟复制被截断 / 副本损坏。
        verifyDatabase: () => {
          throw new Error('副本校验失败')
        },
      }),
    ).rejects.toThrowError('副本校验失败')

    // 第 4 步失败 ⇒ 第 5 步（不可逆的换名）根本没发生，旧库仍在。
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(existsOf(`${target}${BACKUP_RESTORE_TEMP_SUFFIX}`)).toBe(false)
  })

  it('目标不存在时中途失败 → 目标保持不存在（宁可"没有库"也不要坏库）', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    const target = join(fixture.base, 'fresh-target.db')

    await expect(
      restoreStorageBackup({
        requestId: REQUEST_ID,
        sourcePath: created.databasePath,
        targetPath: target,
        overwrite: false,
        verifyDatabase: () => {
          throw new Error('副本校验失败')
        },
      }),
    ).rejects.toThrowError('副本校验失败')

    expect(existsOf(target)).toBe(false)
    expect(existsOf(`${target}${BACKUP_RESTORE_TEMP_SUFFIX}`)).toBe(false)
  })

  it('源备份已损坏 → 恢复在"校验源"这一步就停下，目标库不被创建', async () => {
    const fixture = await makeStorageFixture()
    const created = await createBackup(fixture)
    flipOneByte(created.databasePath)
    const target = join(fixture.dataDir, 'db', 'from-corrupt.db')

    const response = await fixture.app.inject({
      method: 'POST',
      url: RESTORE_URL,
      headers: bearer(fixture.ownerToken),
      payload: {
        backupPath: created.databasePath,
        targetPath: target,
        confirmPassword: 'correct-horse-battery',
        maintenance: true,
      },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().code).toBe('STORAGE_CORRUPT')
    expect(existsOf(target)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 小工具（不引入额外依赖，只用 node:fs）
// ---------------------------------------------------------------------------

function existsOf(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

function readdirSyncOf(dir: string): readonly string[] {
  return readdirSync(dir).sort()
}
