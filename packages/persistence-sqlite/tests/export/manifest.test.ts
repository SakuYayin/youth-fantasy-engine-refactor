/**
 * 备份清单：构建、序列化、**严格**解析。
 *
 * 重点断言：
 * - 清单必须真实描述那个文件（SHA-256 / 字节数 / 实体计数 / 工作区归属 / 附件声明）；
 * - 缺字段、错类型、违约定一律 `STORAGE_CORRUPT`，**绝不补默认值**；
 * - 清单版本高于程序 → `STORAGE_SCHEMA_TOO_NEW`（不猜字段语义）。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { APP_VERSION, DB_SCHEMA_VERSION, type RequestId, type UtcTimestamp } from '@yfe/contracts'

import {
  BACKUP_MANIFEST_VERSION,
  MANIFEST_EXTENSION,
  buildBackupManifest,
  defaultManifestPath,
  parseBackupManifest,
  readBackupManifestFile,
  serializeBackupManifest,
  sha256OfFile,
  type BackupManifest,
} from '../../src/export/index.js'
import {
  CHAPTER_BODY,
  TEST_NOW,
  at,
  cleanupTempDirs,
  errorDetail,
  expectErrCode,
  fileSize,
  insertDocumentRowRaw,
  makeTempDir,
  openMigratedDatabase,
  seedAssetRow,
  seedProject,
  seedWorkspace,
  unwrap,
} from './helpers.js'

afterAll(() => {
  cleanupTempDirs()
})

let seq = 0
function rid(label: string): RequestId {
  seq += 1
  return `req_manifest_${label}_${seq}` as RequestId
}

/** 灌一份"有作品、有章节、有附件"的库，返回清单。 */
function seededManifest(): { manifest: BackupManifest; dbPath: string } {
  const env = openMigratedDatabase('manifest')
  const workspaceId = seedWorkspace(env.db, { name: '本地工作区' })
  const projectId = seedProject(env.db, { workspaceId, name: '长夜将明' })
  insertDocumentRowRaw(env.db, {
    id: 'doc_manifest_000001',
    workspaceId,
    projectId,
    orderKey: 'A0000000000000000000000001',
    title: '第 1 章',
    body: CHAPTER_BODY,
  })
  seedAssetRow(env.db, {
    id: 'asset_manifest_000001',
    workspaceId,
    storageKey: 'blobs/aa/bb/abcdef',
    sha256: 'a'.repeat(64),
    byteSize: 2048,
  })

  const manifest = unwrap(
    buildBackupManifest(env.db, {
      requestId: rid('build'),
      snapshotPath: env.path,
      createdAt: TEST_NOW as UtcTimestamp,
    }),
    '构建清单',
  )
  return { manifest, dbPath: env.path }
}

describe('构建清单', () => {
  it('逐字段描述快照：版本、协议、摘要、计数、工作区归属、附件声明', () => {
    const { manifest, dbPath } = seededManifest()

    expect(manifest.manifestVersion).toBe(BACKUP_MANIFEST_VERSION)
    expect(manifest.appVersion).toBe(APP_VERSION)
    expect(manifest.databaseSchemaVersion).toBe(DB_SCHEMA_VERSION)
    expect(manifest.syncProtocolVersion).toEqual({ major: 1, minor: 0 })
    expect(manifest.createdAt).toBe(TEST_NOW)

    expect(manifest.databaseFile.fileName).toBe('app.db')
    expect(manifest.databaseFile.byteSize).toBe(fileSize(dbPath))
    expect(manifest.databaseFile.sha256).toBe(sha256OfFile(dbPath))
    expect(manifest.databaseFile.sha256).toMatch(/^[0-9a-f]{64}$/)

    expect(manifest.entityCounts).toEqual({
      projects: 1,
      documents: 1,
      settingsEntities: 0,
      assets: 1,
      revisions: 0,
      pluginData: 0,
      localDrafts: 0,
    })

    const workspace = at(manifest.workspaces, 0)
    expect(workspace.workspaceId).toBe('ws_export_000001')
    expect(workspace.name).toBe('本地工作区')
    expect(workspace.deleted).toBe(false)
    expect(workspace.projectCount).toBe(1)
    expect(workspace.documentCount).toBe(1)
    expect(workspace.assetCount).toBe(1)
    expect(workspace.revisionCount).toBe(0)

    const asset = at(manifest.assets, 0)
    expect(asset.assetId).toBe('asset_manifest_000001')
    expect(asset.storageKey).toBe('blobs/aa/bb/abcdef')
    expect(asset.localState).toBe('present')
    expect(asset.deleted).toBe(false)

    expect(manifest.migrationLedger.length).toBeGreaterThan(0)
    expect(at(manifest.migrationLedger, 0).version).toBe(1)
    expect(at(manifest.migrationLedger, 0).checksum.length).toBeGreaterThan(0)
  })

  it('清单不含秘密、不声明搬运附件二进制（契约字段恒为 false）', () => {
    const { manifest } = seededManifest()
    expect(manifest.containsSecrets).toBe(false)
    expect(manifest.attachmentFilesIncluded).toBe(false)
    // 清单里不该出现任何绝对路径：只允许 fileName。
    expect(JSON.stringify(manifest)).not.toMatch(/[A-Za-z]:\\\\/)
  })

  it('序列化 → 解析往返完全相等', () => {
    const { manifest } = seededManifest()
    const roundTripped = unwrap(parseBackupManifest(serializeBackupManifest(manifest), rid('roundtrip')))
    expect(roundTripped).toEqual(manifest)
  })

  it('清单文件默认路径是同名并列的 .manifest.json', () => {
    expect(defaultManifestPath('C:/data/app.db')).toBe(`C:/data/app.db${MANIFEST_EXTENSION}`)
  })

  it('清单文件不存在 → NOT_FOUND_SNAPSHOT（不当成空清单）', () => {
    const missing = join(makeTempDir('manifest-missing'), 'nope.manifest.json')
    expectErrCode(readBackupManifestFile(missing, rid('missing')), 'NOT_FOUND_SNAPSHOT')
  })

  it('清单文件存在 → 能读回（写盘/读盘往返）', () => {
    const { manifest } = seededManifest()
    const path = join(makeTempDir('manifest-write'), 'app.db.manifest.json')
    writeFileSync(path, serializeBackupManifest(manifest), 'utf8')
    const readBack = unwrap(readBackupManifestFile(path, rid('write')))
    expect(readBack).toEqual(manifest)
  })
})

describe('严格解析：坏清单必须被拒绝', () => {
  function rawOf(): Record<string, unknown> {
    const { manifest } = seededManifest()
    return JSON.parse(serializeBackupManifest(manifest)) as Record<string, unknown>
  }

  function parseRaw(raw: unknown) {
    return parseBackupManifest(JSON.stringify(raw), rid('parse'))
  }

  it('非法 JSON → STORAGE_CORRUPT', () => {
    expectErrCode(parseBackupManifest('{', rid('bad-json')), 'STORAGE_CORRUPT')
  })

  it('顶层不是对象 → STORAGE_CORRUPT', () => {
    expectErrCode(parseBackupManifest('[]', rid('array')), 'STORAGE_CORRUPT')
  })

  it('缺 manifestVersion → STORAGE_CORRUPT，且 detail 指出字段', () => {
    const raw = rawOf()
    delete raw.manifestVersion
    const result = parseRaw(raw)
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('manifestVersion')
  })

  it('清单版本高于程序 → STORAGE_SCHEMA_TOO_NEW（不猜字段语义）', () => {
    const raw = rawOf()
    raw.manifestVersion = BACKUP_MANIFEST_VERSION + 1
    expectErrCode(parseRaw(raw), 'STORAGE_SCHEMA_TOO_NEW')
  })

  it('sha256 不是 64 位小写十六进制 → STORAGE_CORRUPT', () => {
    const raw = rawOf()
    ;(raw.databaseFile as Record<string, unknown>).sha256 = 'ABC'
    const result = parseRaw(raw)
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('databaseFile.sha256')
  })

  it('entityCounts 少一项 → STORAGE_CORRUPT，detail 指到具体计数', () => {
    const raw = rawOf()
    delete (raw.entityCounts as Record<string, unknown>).documents
    const result = parseRaw(raw)
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('entityCounts.documents')
  })

  it('缺 migrationLedger / workspaces / assets → STORAGE_CORRUPT', () => {
    for (const field of ['migrationLedger', 'workspaces', 'assets']) {
      const raw = rawOf()
      delete raw[field]
      const result = parseRaw(raw)
      expectErrCode(result, 'STORAGE_CORRUPT')
      expect(errorDetail(result).field).toBe(field)
    }
  })

  it('containsSecrets 不是 false → STORAGE_CORRUPT（不把可疑备份当安全备份）', () => {
    const raw = rawOf()
    raw.containsSecrets = true
    const result = parseRaw(raw)
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('containsSecrets')
  })

  it('迁移台账条目缺 checksum → STORAGE_CORRUPT', () => {
    const raw = rawOf()
    const ledger = raw.migrationLedger as Record<string, unknown>[]
    delete at(ledger, 0).checksum
    const result = parseRaw(raw)
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('migrationLedger')
  })
})
