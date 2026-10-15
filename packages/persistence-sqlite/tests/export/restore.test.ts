/**
 * 恢复：校验 + 原子落位。
 *
 * 重点断言（对应 `06-数据与本地存储.md:73`、`11-测试验收与迁移.md:48`）：
 * - 往返无损：恢复后的库能读回原正文与全部行；
 * - **校验失败绝不当空库**：篡改、截断、缺清单、缺表、版本过高都必须失败；
 * - **失败不留损坏目标**：任何一步失败，目标位置要么不存在、要么保持原样。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const originalFs = await vi.importActual<typeof import('node:fs')>('node:fs')
afterEach(() => { vi.mocked(renameSync).mockReset().mockImplementation(originalFs.renameSync) })

import type { RequestId, UtcTimestamp } from '@yfe/contracts'

import { closeDatabase, openDatabase } from '../../src/schema/index.js'
import {
  buildBackupManifest,
  createBackup,
  defaultManifestPath,
  readBackupManifestFile,
  restoreBackup,
  serializeBackupManifest,
  sha256OfFile,
  verifyBackup,
  type BackupManifest,
} from '../../src/export/index.js'
import {
  CHAPTER_BODY,
  TEST_NOW,
  cleanupTempDirs,
  countRows,
  errorDetail,
  expectErrCode,
  fileSize,
  insertDocumentRowRaw,
  makeTempDir,
  openExistingDatabase,
  openMigratedDatabase,
  seedProject,
  seedWorkspace,
  tempFilePath,
  unwrap,
} from './helpers.js'

afterAll(() => {
  cleanupTempDirs()
})

let seq = 0
function rid(label: string): RequestId {
  seq += 1
  return `req_restore_${label}_${seq}` as RequestId
}

const clock = { now: () => TEST_NOW as UtcTimestamp }
const DOC_ID = 'doc_restore_000001'

/** 灌一份带一章正文的库（并写出它的备份），返回快照与清单路径。 */
function seedBackup(label: string): { backupPath: string; manifestPath: string } {
  const env = openMigratedDatabase(label)
  const workspaceId = seedWorkspace(env.db)
  const projectId = seedProject(env.db, { workspaceId, name: '长夜将明' })
  insertDocumentRowRaw(env.db, {
    id: DOC_ID,
    workspaceId,
    projectId,
    orderKey: 'A0000000000000000000000001',
    title: '第 1 章',
    body: CHAPTER_BODY,
  })

  const backupPath = join(tempFilePath(`${label}-backup`), 'app.db')
  unwrap(createBackup(env.db, { requestId: rid(label), destinationPath: backupPath }, { clock }))
  return { backupPath, manifestPath: defaultManifestPath(backupPath) }
}

function bodyOf(path: string): string {
  const opened = openExistingDatabase(path)
  const row = opened.db.prepare('SELECT body FROM documents WHERE id = ?').get(DOC_ID) as
    | { body: string }
    | undefined
  if (!row) throw new Error(`恢复后的库里没有文档 ${DOC_ID}`)
  return row.body
}

/** 读回备份清单，便于"重建一个仍然自洽的清单"来单独触发某条校验。 */
function readManifest(manifestPath: string): BackupManifest {
  return unwrap(readBackupManifestFile(manifestPath, rid('read-manifest')))
}

/** 用快照**当前**的字节重建清单（保持自洽，从而让后续某条校验成为唯一失败点）。 */
function refreshManifestHashes(backupPath: string, manifestPath: string): void {
  const manifest = readManifest(manifestPath)
  const updated: BackupManifest = {
    ...manifest,
    databaseFile: {
      fileName: manifest.databaseFile.fileName,
      sha256: sha256OfFile(backupPath),
      byteSize: fileSize(backupPath),
    },
  }
  writeFileSync(manifestPath, serializeBackupManifest(updated), 'utf8')
}

describe('恢复：往返无损', () => {
  it('恢复后的库能读回原正文、行数与清单归属', () => {
    const { backupPath } = seedBackup('restore-roundtrip')
    const targetPath = join(tempFilePath('restore-roundtrip-target'), 'restored.db')

    const output = unwrap(restoreBackup({ requestId: rid('roundtrip'), backupPath, targetPath }), '恢复')

    expect(output.targetPath).toBe(targetPath)
    expect(output.byteSize).toBe(fileSize(backupPath))
    expect(output.verified.integrity).toBe('ok')
    expect(output.verified.entityCounts.documents).toBe(1)
    expect(output.manifest.databaseFile.sha256).toBe(sha256OfFile(targetPath))

    // 恢复出来的目录必须**自带清单**：只给一个 .db，用户就再也无法校验这份数据。
    expect(output.manifestPath).toBe(defaultManifestPath(targetPath))
    expect(existsSync(output.manifestPath)).toBe(true)
    expect(readManifest(output.manifestPath)).toEqual(output.manifest)

    expect(bodyOf(targetPath)).toBe(CHAPTER_BODY)

    const restored = openExistingDatabase(targetPath)
    expect(countRows(restored.db, 'workspaces')).toBe(1)
    expect(countRows(restored.db, 'projects')).toBe(1)
    expect(countRows(restored.db, 'documents')).toBe(1)
    // 恢复出来的目标库自己也是一份"可校验备份"（摘要是字节级复制）。
    const verified = unwrap(verifyBackup({ requestId: rid('verify-target'), backupPath: targetPath }))
    expect(verified.entityCounts.documents).toBe(1)
  })

  it('目标父目录不存在时自动创建', () => {
    const { backupPath } = seedBackup('restore-mkdir')
    const targetPath = join(tempFilePath('restore-mkdir-target'), 'a', 'b', 'restored.db')
    unwrap(restoreBackup({ requestId: rid('mkdir'), backupPath, targetPath }))
    expect(existsSync(targetPath)).toBe(true)
  })

  it('目标已存在且未声明 overwrite → ALREADY_EXISTS，原文件一字不改', () => {
    const { backupPath } = seedBackup('restore-exists')
    const dir = makeTempDir('restore-exists-target')
    const targetPath = join(dir, 'restored.db')
    writeFileSync(targetPath, 'existing user data', 'utf8')

    expectErrCode(restoreBackup({ requestId: rid('exists'), backupPath, targetPath }), 'ALREADY_EXISTS')
    expect(readFileSync(targetPath, 'utf8')).toBe('existing user data')
    expect(existsSync(`${targetPath}.restoring`)).toBe(false)
  })

  it('显式 overwrite: true 才覆盖，且覆盖后内容正确', () => {
    const { backupPath } = seedBackup('restore-overwrite')
    const dir = makeTempDir('restore-overwrite-target')
    const targetPath = join(dir, 'restored.db')
    writeFileSync(targetPath, 'stale', 'utf8')

    unwrap(restoreBackup({ requestId: rid('overwrite'), backupPath, targetPath, overwrite: true }))
    expect(bodyOf(targetPath)).toBe(CHAPTER_BODY)
    expect(existsSync(`${targetPath}.restoring`)).toBe(false)
    expect(existsSync(defaultManifestPath(targetPath))).toBe(true)
  })

  it('备份路径为空 / 目标是内存库 / 目标等于备份 → VALIDATION_*', () => {
    const { backupPath } = seedBackup('restore-invalid')
    const targetPath = join(tempFilePath('restore-invalid-target'), 'restored.db')

    expectErrCode(
      restoreBackup({ requestId: rid('empty'), backupPath: '   ', targetPath }),
      'VALIDATION_MISSING_FIELD',
    )
    expectErrCode(
      restoreBackup({ requestId: rid('memory'), backupPath, targetPath: ':memory:' }),
      'VALIDATION_FAILED',
    )
    expectErrCode(
      restoreBackup({ requestId: rid('same'), backupPath, targetPath: backupPath }),
      'VALIDATION_FAILED',
    )
  })

  it('目标通过路径别名指向源备份，或直接指向源清单时拒绝且源文件不变', () => {
    const { backupPath, manifestPath } = seedBackup('restore-source-alias')
    const source = readFileSync(backupPath)
    const manifest = readFileSync(manifestPath)
    for (const targetPath of [`${dirname(backupPath)}/./${basename(backupPath)}`, manifestPath]) {
      expectErrCode(restoreBackup({ requestId: rid('alias'), backupPath, targetPath, overwrite: true }), 'VALIDATION_FAILED')
    }
    expect(readFileSync(backupPath)).toEqual(source)
    expect(readFileSync(manifestPath)).toEqual(manifest)
  })

  it('目标清单是目录时拒绝覆盖，原数据库保持原样', () => {
    const { backupPath } = seedBackup('restore-manifest-directory')
    const targetPath = join(makeTempDir('restore-manifest-directory-target'), 'restored.db')
    writeFileSync(targetPath, 'original user data')
    mkdirSync(defaultManifestPath(targetPath))
    expectErrCode(restoreBackup({ requestId: rid('directory'), backupPath, targetPath, overwrite: true }), 'VALIDATION_FAILED')
    expect(readFileSync(targetPath, 'utf8')).toBe('original user data')
  })

  it('新清单落位失败时，原数据库与原清单均回滚', () => {
    const { backupPath } = seedBackup('restore-install-failure')
    const targetPath = join(makeTempDir('restore-install-failure-target'), 'restored.db')
    const targetManifestPath = defaultManifestPath(targetPath)
    writeFileSync(targetPath, 'original database')
    writeFileSync(targetManifestPath, 'original manifest')
    vi.mocked(renameSync).mockImplementation((source, target) => {
      if (basename(String(source)) === 'manifest.json') throw Object.assign(new Error('injected'), { code: 'EACCES' })
      originalFs.renameSync(source, target)
    })
    const result = restoreBackup({ requestId: rid('install-failure'), backupPath, targetPath, overwrite: true })
    expect(result.ok).toBe(false)
    expect(readFileSync(targetPath, 'utf8')).toBe('original database')
    expect(readFileSync(targetManifestPath, 'utf8')).toBe('original manifest')
    expect(verifyBackup({ requestId: rid('source-retained'), backupPath }).ok).toBe(true)
  })

  it('目标留有活动 WAL 时拒绝恢复，避免旧日志混入新库', () => {
    const { backupPath } = seedBackup('restore-active-wal')
    const targetPath = join(makeTempDir('restore-active-wal-target'), 'restored.db')
    writeFileSync(targetPath, 'original database')
    writeFileSync(`${targetPath}-wal`, 'active journal')
    expectErrCode(restoreBackup({ requestId: rid('wal'), backupPath, targetPath, overwrite: true }), 'RESOURCE_LOCKED')
    expect(readFileSync(targetPath, 'utf8')).toBe('original database')
    expect(readFileSync(`${targetPath}-wal`, 'utf8')).toBe('active journal')
  })
})

describe('恢复：校验失败绝不当成空库', () => {
  it('备份文件不存在 → NOT_FOUND_SNAPSHOT 且目标未被创建', () => {
    const missing = join(tempFilePath('restore-no-source'), 'app.db')
    const targetPath = join(tempFilePath('restore-no-source-target'), 'restored.db')
    expectErrCode(restoreBackup({ requestId: rid('no-source'), backupPath: missing, targetPath }), 'NOT_FOUND_SNAPSHOT')
    expect(existsSync(targetPath)).toBe(false)
  })

  it('清单缺失 → NOT_FOUND_SNAPSHOT（无法确认版本与校验和）', () => {
    const { backupPath, manifestPath } = seedBackup('restore-no-manifest')
    const targetPath = join(tempFilePath('restore-no-manifest-target'), 'restored.db')
    rmSync(manifestPath)

    expectErrCode(
      restoreBackup({ requestId: rid('no-manifest'), backupPath, targetPath }),
      'NOT_FOUND_SNAPSHOT',
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  it('清单被截断成非法 JSON → STORAGE_CORRUPT', () => {
    const { backupPath, manifestPath } = seedBackup('restore-bad-manifest')
    const targetPath = join(tempFilePath('restore-bad-manifest-target'), 'restored.db')
    writeFileSync(manifestPath, '{"manifestVersion":1,', 'utf8')

    expectErrCode(restoreBackup({ requestId: rid('bad-manifest'), backupPath, targetPath }), 'STORAGE_CORRUPT')
    expect(existsSync(targetPath)).toBe(false)
  })

  it('快照被改动一个字节 → STORAGE_CORRUPT，目标未被创建', () => {
    const { backupPath } = seedBackup('restore-tampered')
    const targetPath = join(tempFilePath('restore-tampered-target'), 'restored.db')

    const bytes = readFileSync(backupPath)
    const index = Math.floor(bytes.length / 2)
    bytes[index] = (bytes[index] ?? 0) ^ 0xff
    writeFileSync(backupPath, bytes)

    const expected = unwrap(readBackupManifestFile(defaultManifestPath(backupPath), rid('tamper-read')))
    expect(expected.databaseFile.sha256).not.toBe(sha256OfFile(backupPath))

    expectErrCode(restoreBackup({ requestId: rid('tampered'), backupPath, targetPath }), 'STORAGE_CORRUPT')
    expect(existsSync(targetPath)).toBe(false)
    expect(existsSync(`${targetPath}.restoring`)).toBe(false)
  })

  it('快照被截断 → STORAGE_CORRUPT（按字节数先拦下）', () => {
    const { backupPath } = seedBackup('restore-truncated')
    const targetPath = join(tempFilePath('restore-truncated-target'), 'restored.db')

    const bytes = readFileSync(backupPath)
    writeFileSync(backupPath, bytes.subarray(0, Math.floor(bytes.length / 2)))

    expectErrCode(restoreBackup({ requestId: rid('truncated'), backupPath, targetPath }), 'STORAGE_CORRUPT')
    expect(existsSync(targetPath)).toBe(false)
  })

  it('快照缺一张必需表 → STORAGE_CORRUPT，detail 指出表名', () => {
    const { backupPath, manifestPath } = seedBackup('restore-missing-table')
    const targetPath = join(tempFilePath('restore-missing-table-target'), 'restored.db')

    const admin = openDatabase(backupPath)
    admin.prepare('DROP TABLE local_drafts').run()
    admin.pragma('wal_checkpoint(TRUNCATE)')
    closeDatabase(admin)
    refreshManifestHashes(backupPath, manifestPath)

    const result = restoreBackup({ requestId: rid('missing-table'), backupPath, targetPath })
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).missingTable).toBe('local_drafts')
    expect(existsSync(targetPath)).toBe(false)
  })

  it('备份来自更新版本的程序（库版本 2 > 程序 1）→ STORAGE_SCHEMA_TOO_NEW', () => {
    const { backupPath, manifestPath } = seedBackup('restore-too-new')
    const targetPath = join(tempFilePath('restore-too-new-target'), 'restored.db')

    // 把快照的迁移台账改成"比程序新"，并重建一份**自洽**的清单：
    // 这样版本过高就成为唯一失败点，而不是被摘要/计数不符掩盖。
    const admin = openDatabase(backupPath)
    admin.prepare('UPDATE schema_migrations SET version = 2').run()
    admin.pragma('wal_checkpoint(TRUNCATE)')
    closeDatabase(admin)

    const rebuilt = unwrap(rebuildManifest(backupPath, manifestPath), '重建清单')
    expect(rebuilt.databaseSchemaVersion).toBe(2)

    const result = restoreBackup({ requestId: rid('too-new'), backupPath, targetPath })
    expectErrCode(result, 'STORAGE_SCHEMA_TOO_NEW')
    expect(errorDetail(result).found).toBe(2)
    expect(existsSync(targetPath)).toBe(false)
  })

  it('摘要和行数自洽但文档引用不存在的作品时，不能通过恢复校验', () => {
    const { backupPath, manifestPath } = seedBackup('restore-orphan-reference')
    const admin = openDatabase(backupPath)
    admin.pragma('foreign_keys = OFF')
    admin.prepare("UPDATE documents SET project_id = 'prj_missing_reference'").run()
    admin.pragma('wal_checkpoint(TRUNCATE)')
    closeDatabase(admin)
    refreshManifestHashes(backupPath, manifestPath)
    const result = verifyBackup({ requestId: rid('orphan'), backupPath })
    expectErrCode(result, 'STORAGE_CORRUPT')
    expect(errorDetail(result).field).toBe('foreignKeys')
  })

  it('恢复目标父路径是文件 → 失败且无残留', () => {
    const { backupPath } = seedBackup('restore-bad-target')
    const dir = makeTempDir('restore-bad-target-dir')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file, not a directory', 'utf8')
    const targetPath = join(blocker, 'restored.db')

    const result = restoreBackup({ requestId: rid('bad-target'), backupPath, targetPath })
    expect(result.ok).toBe(false)
    expect(existsSync(targetPath)).toBe(false)
    expect(existsSync(`${targetPath}.restoring`)).toBe(false)
  })
})

/** 用快照当前的库内容与字节重写一份自洽的清单（隔离出"版本过高"这一条校验）。 */
function rebuildManifest(backupPath: string, manifestPath: string) {
  const snapshot = openExistingDatabase(backupPath)
  try {
    const built = buildBackupManifest(snapshot.db, {
      requestId: rid('rebuild'),
      snapshotPath: backupPath,
      createdAt: TEST_NOW as UtcTimestamp,
    })
    if (built.ok) writeFileSync(manifestPath, serializeBackupManifest(built.value), 'utf8')
    return built
  } finally {
    closeDatabase(snapshot.db)
  }
}
