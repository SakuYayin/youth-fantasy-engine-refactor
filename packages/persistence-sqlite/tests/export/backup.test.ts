/**
 * 创建恢复点：一致快照 + 清单。
 *
 * 重点断言：
 * - **活动 WAL 不丢**（R-25 教训：只有落盘路径才走到的分支，内存库测试永远看不见）；
 * - 快照与清单**成对存在或成对不存在**，任何一步失败都清理干净；
 * - 目标已存在时拒绝覆盖（备份绝不能被"顺手"覆盖掉）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { RequestId, UtcTimestamp } from '@yfe/contracts'

import {
  createBackup,
  defaultManifestPath,
  readBackupManifestFile,
  verifyBackup,
} from '../../src/export/index.js'
import {
  CHAPTER_BODY,
  TEST_NOW,
  cleanupTempDirs,
  expectErrCode,
  fileSize,
  insertDocumentRowRaw,
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
  return `req_backup_${label}_${seq}` as RequestId
}

const clock = { now: () => TEST_NOW as UtcTimestamp }

/** 灌一份带一章正文的库。 */
function seedNovel(label: string) {
  const env = openMigratedDatabase(label)
  const workspaceId = seedWorkspace(env.db)
  const projectId = seedProject(env.db, { workspaceId, name: '长夜将明' })
  insertDocumentRowRaw(env.db, {
    id: 'doc_backup_000001',
    workspaceId,
    projectId,
    orderKey: 'A0000000000000000000000001',
    title: '第 1 章',
    body: CHAPTER_BODY,
  })
  return env
}

describe('创建备份', () => {
  it('写出快照 + 清单，并可通过校验', () => {
    const env = seedNovel('backup-ok')
    const destinationPath = join(tempFilePath('backup-ok-out'), 'app.db')

    const output = unwrap(
      createBackup(env.db, { requestId: rid('ok'), destinationPath }, { clock }),
      '创建备份',
    )

    expect(existsSync(destinationPath)).toBe(true)
    expect(existsSync(output.manifestPath)).toBe(true)
    expect(output.manifestPath).toBe(defaultManifestPath(destinationPath))
    expect(output.manifest.databaseFile.fileName).toBe('app.db')
    expect(output.manifest.databaseFile.byteSize).toBe(fileSize(destinationPath))
    expect(output.manifest.createdAt).toBe(TEST_NOW)
    expect(output.manifest.entityCounts.documents).toBe(1)

    const verified = unwrap(verifyBackup({ requestId: rid('verify'), backupPath: destinationPath }))
    expect(verified.entityCounts.documents).toBe(1)
    expect(verified.integrity).toBe('ok')
    expect(verified.compat).toBe('ok')
    expect(verified.needsMigration).toBe(false)

    // 清单文件也必须能独立读回（恢复端只拿得到两个文件，没有内存状态）。
    const manifest = unwrap(readBackupManifestFile(output.manifestPath, rid('read')))
    expect(manifest.databaseFile.sha256).toBe(output.manifest.databaseFile.sha256)
  })

  it('🔴 活动 WAL 里的最新写入必须进快照（不能只复制主文件）', () => {
    const env = seedNovel('backup-wal')
    const walPath = `${env.path}-wal`

    // 前提：写入确实还留在 WAL 里（未 checkpoint），否则这条测试就退化成"复制主文件也能过"。
    expect(existsSync(walPath)).toBe(true)
    expect(fileSize(walPath)).toBeGreaterThan(0)

    const destinationPath = join(tempFilePath('backup-wal-out'), 'snapshot.db')
    unwrap(
      createBackup(env.db, { requestId: rid('wal'), destinationPath }, { clock }),
      '创建备份',
    )

    const snapshot = openExistingDatabase(destinationPath)
    const body = snapshot.db.prepare(`SELECT body FROM documents WHERE id = ?`).get('doc_backup_000001') as
      | { body: string }
      | undefined
    expect(body?.body).toBe(CHAPTER_BODY)
    // 快照自己也应该是 WAL 之外的独立文件：不带 -wal 兄弟文件也能读到全部数据。
    expect(existsSync(`${destinationPath}-wal`)).toBe(false)
  })

  it('空库（0 实体）也能备份：计数全 0、工作区列表为空', () => {
    const env = openMigratedDatabase('backup-empty')
    const destinationPath = join(tempFilePath('backup-empty-out'), 'app.db')
    const output = unwrap(createBackup(env.db, { requestId: rid('empty'), destinationPath }, { clock }))
    expect(output.manifest.entityCounts).toEqual({
      projects: 0,
      documents: 0,
      settingsEntities: 0,
      assets: 0,
      revisions: 0,
      pluginData: 0,
      localDrafts: 0,
    })
    expect(output.manifest.workspaces).toEqual([])
    expect(output.manifest.assets).toEqual([])
  })

  it('嵌套目标目录会被创建（不要求用户先建好）', () => {
    const env = seedNovel('backup-nested')
    const destinationPath = join(tempFilePath('backup-nested-out'), 'a', 'b', 'c', 'app.db')
    unwrap(createBackup(env.db, { requestId: rid('nested'), destinationPath }, { clock }))
    expect(existsSync(destinationPath)).toBe(true)
  })
})

describe('创建备份：参数与冲突', () => {
  it('目标已存在 → ALREADY_EXISTS（备份绝不被顺手覆盖）', () => {
    const env = seedNovel('backup-exists')
    const dir = tempFilePath('backup-exists-out')
    mkdirSync(dir, { recursive: true })
    const destinationPath = join(dir, 'app.db')
    writeFileSync(destinationPath, 'not a database', 'utf8')

    const result = createBackup(env.db, { requestId: rid('exists'), destinationPath }, { clock })
    expectErrCode(result, 'ALREADY_EXISTS')
    // 原有文件必须原封不动。
    expect(fileSize(destinationPath)).toBe('not a database'.length)
  })

  it('清单已存在 → ALREADY_EXISTS', () => {
    const env = seedNovel('backup-manifest-exists')
    const dir = tempFilePath('backup-manifest-exists-out')
    mkdirSync(dir, { recursive: true })
    const destinationPath = join(dir, 'app.db')
    writeFileSync(defaultManifestPath(destinationPath), '{}', 'utf8')

    expectErrCode(createBackup(env.db, { requestId: rid('mexists'), destinationPath }, { clock }), 'ALREADY_EXISTS')
    expect(existsSync(destinationPath)).toBe(false)
  })

  it('空路径 → VALIDATION_MISSING_FIELD；内存库路径 → VALIDATION_FAILED', () => {
    const env = seedNovel('backup-invalid')
    expectErrCode(
      createBackup(env.db, { requestId: rid('empty-path'), destinationPath: '   ' }, { clock }),
      'VALIDATION_MISSING_FIELD',
    )
    expectErrCode(
      createBackup(env.db, { requestId: rid('memory'), destinationPath: ':memory:' }, { clock }),
      'VALIDATION_FAILED',
    )
  })

  it('清单路径与快照路径相同 → VALIDATION_FAILED', () => {
    const env = seedNovel('backup-same-path')
    const destinationPath = join(tempFilePath('backup-same-path-out'), 'app.db')
    expectErrCode(
      createBackup(env.db, { requestId: rid('same'), destinationPath, manifestPath: destinationPath }, { clock }),
      'VALIDATION_FAILED',
    )
  })
})

describe('创建备份：失败注入', () => {
  it('目标父路径是文件 → 失败且不留下任何半成品', () => {
    const env = seedNovel('backup-badparent')
    const dir = tempFilePath('backup-badparent-out')
    mkdirSync(dir, { recursive: true })
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'file, not a directory', 'utf8')
    const destinationPath = join(blocker, 'app.db')

    const result = createBackup(env.db, { requestId: rid('badparent'), destinationPath }, { clock })
    expect(result.ok).toBe(false)
    expect(existsSync(destinationPath)).toBe(false)
    expect(existsSync(defaultManifestPath(destinationPath))).toBe(false)
  })

  it('清单目录不存在 → 失败且**快照也被清理**（成对存在）', () => {
    const env = seedNovel('backup-badmanifest')
    const destinationPath = join(tempFilePath('backup-badmanifest-out'), 'app.db')
    const missingDir = join(tempFilePath('backup-badmanifest-manifest'), 'not-created')
    const manifestPath = join(missingDir, 'app.db.manifest.json')

    const result = createBackup(env.db, { requestId: rid('badmanifest'), destinationPath, manifestPath }, { clock })
    expectErrCode(result, 'STORAGE_UNAVAILABLE')
    expect(existsSync(destinationPath)).toBe(false)
    expect(existsSync(manifestPath)).toBe(false)
  })

  it('连接已关闭 → 失败且不留半成品', () => {
    const env = seedNovel('backup-closed')
    const destinationPath = join(tempFilePath('backup-closed-out'), 'app.db')
    env.db.close()

    const result = createBackup(env.db, { requestId: rid('closed'), destinationPath }, { clock })
    expect(result.ok).toBe(false)
    expect(existsSync(destinationPath)).toBe(false)
    expect(existsSync(defaultManifestPath(destinationPath))).toBe(false)
  })
})
