/**
 * 导出/恢复层测试辅助。
 *
 * 🔴 与 `tests/repositories/helpers.ts` 同一取向，但本文件自成一份：
 *    - 临时库一律落在 `tests/export/.tmp/`（本机 `os.tmpdir()` 不可写，EPERM）；
 *    - **一律使用真实文件库**，绝不 `:memory:` —— R-25 的教训是"只有落盘路径才走到的分支
 *      会被内存库测试完整漏掉"，而本模块整条链路都是文件路径；
 *    - 每个测试文件用自己的临时子目录，互不干扰。
 */

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  encodeRevision,
  fixedClock,
  type DocumentId,
  type DocumentKind,
  type ErrorCode,
  type ProjectId,
  type Result,
  type UtcTimestamp,
  type WorkspaceId,
} from '@yfe/contracts'

import { closeDatabase, migrate, openDatabase, type SqliteDatabase } from '../../src/schema/index.js'

/** 测试临时根目录（相对本文件）。 */
export const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url))

/** 固化的测试时钟。 */
export const TEST_NOW = '2026-01-01T00:00:00.000Z'

/** 一个"袖珍长篇"正文：250 个汉字，足够验证往返无损。 */
export const CHAPTER_BODY = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'.repeat(10)

/** 打开中的库，带上它的物理路径（导出/恢复测试到处需要路径）。 */
export interface TestDb {
  readonly db: SqliteDatabase
  readonly path: string
}

const created: string[] = []
const opened: SqliteDatabase[] = []

/** 建一个新的临时目录。 */
export function makeTempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`))
  created.push(dir)
  return dir
}

/** 在一个新的临时目录里取一个文件路径（不创建文件）。 */
export function tempFilePath(label: string, fileName = 'app.db'): string {
  return join(makeTempDir(label), fileName)
}

/** 打开并迁移一个全新的库文件（`backupDir: null`：测试不要生产备份）。 */
export function openMigratedDatabase(label = 'db'): TestDb {
  const path = tempFilePath(label)
  const db = openDatabase(path)
  migrate(db, { backupDir: null })
  opened.push(db)
  return { db, path }
}

/**
 * 打开一个已有库文件（测试里用来读回恢复结果）。
 *
 * 🔴 只读 + `fileMustExist`：读回时**绝不允许**"打不开就静默建空库"，
 *    否则"恢复出来的库是空的"会被当成通过。
 */
export function openExistingDatabase(path: string): TestDb {
  const db = openDatabase(path, { readOnly: true, fileMustExist: true })
  opened.push(db)
  return { db, path }
}

/** 关闭所有连接并删除临时目录。测试文件在 `afterAll` 里调用。 */
export function cleanupTempDirs(): void {
  for (const db of opened.splice(0)) {
    try {
      closeDatabase(db)
    } catch {
      /* 关闭失败不影响断言 */
    }
  }
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上偶发文件占用：清理失败不影响断言。
    }
  }
}

/** 只删目录列表里的一个目录（不关连接）。 */
export function removeDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 种子数据（直接写 SQL：夹具不该依赖被测代码）
// ---------------------------------------------------------------------------

export function seedTime(iso = TEST_NOW): UtcTimestamp {
  return iso as UtcTimestamp
}

export function seedWorkspace(
  db: SqliteDatabase,
  options: { readonly id?: string; readonly name?: string; readonly at?: UtcTimestamp } = {},
): WorkspaceId {
  const id = (options.id ?? 'ws_export_000001') as WorkspaceId
  const at = options.at ?? seedTime()
  db.prepare(
    `INSERT INTO workspaces (id, name, schema_version, authority_target_id, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, 1, NULL, ?, 1, 0, ?, ?)`,
  ).run(id, options.name ?? '本地工作区', encodeRevision(1), at, at)
  return id
}

export function seedProject(
  db: SqliteDatabase,
  options: { readonly workspaceId: WorkspaceId; readonly id?: string; readonly name?: string; readonly at?: UtcTimestamp },
): ProjectId {
  const id = (options.id ?? 'prj_export_000001') as ProjectId
  const at = options.at ?? seedTime()
  db.prepare(
    `INSERT INTO projects (id, workspace_id, name, summary, project_type, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, '', 'full', ?, 1, 0, ?, ?)`,
  ).run(id, options.workspaceId, options.name ?? '测试作品', encodeRevision(1), at, at)
  return id
}

export function insertDocumentRowRaw(
  db: SqliteDatabase,
  row: {
    readonly id: string
    readonly workspaceId: string
    readonly projectId: string
    readonly kind?: DocumentKind
    readonly parentId?: string | null
    readonly orderKey: string
    readonly title?: string
    readonly body?: string
    readonly at?: UtcTimestamp
  },
): DocumentId {
  const at = row.at ?? seedTime()
  db.prepare(
    `INSERT INTO documents
       (id, workspace_id, project_id, kind, parent_id, order_key, title, body,
        revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(
    row.id,
    row.workspaceId,
    row.projectId,
    row.kind ?? 'chapter',
    row.parentId ?? null,
    row.orderKey,
    row.title ?? '未命名',
    row.body ?? '',
    encodeRevision(1),
    at,
    at,
  )
  return row.id as DocumentId
}

/** 插一条附件行（导出清单里的 `assets` 来自这张表）。 */
export function seedAssetRow(
  db: SqliteDatabase,
  row: {
    readonly id: string
    readonly workspaceId: string
    readonly storageKey: string
    readonly sha256: string
    readonly byteSize: number
    readonly localState?: 'staged' | 'present' | 'missing' | 'corrupt'
    readonly at?: UtcTimestamp
  },
): void {
  const at = row.at ?? seedTime()
  db.prepare(
    `INSERT INTO assets
       (id, workspace_id, attachment_id, storage_key, hash_algorithm, sha256, byte_size,
        mime_type, original_name, local_state, deleted, created_at)
     VALUES (?, ?, ?, ?, 'sha256', ?, ?, 'text/plain', 'note.txt', ?, 0, ?)`,
  ).run(
    row.id,
    row.workspaceId,
    `${row.id}:att`,
    row.storageKey,
    row.sha256,
    row.byteSize,
    row.localState ?? 'present',
    at,
  )
}

/** 单表行数。 */
export function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

/** 读一行的某一列（断言恢复结果用；行不存在即测试失败）。 */
export function readTextColumn(db: SqliteDatabase, table: string, column: string, id: string): string {
  const row = db.prepare(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id) as
    | { value: unknown }
    | undefined
  if (!row) throw new Error(`${table} 行不存在：${id}`)
  return String(row.value)
}

/** 文件字节数。 */
export function fileSize(path: string): number {
  return statSync(path).size
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 取出成功值；失败时抛出带错误码的信息。 */
export function unwrap<T>(result: Result<T>, label = '操作'): T {
  if (!result.ok) {
    throw new Error(`${label} 失败：${result.error.code} ${result.error.message}`)
  }
  return result.value
}

/** 断言失败且错误码恰好是 `code`。 */
export function expectErrCode<T>(result: Result<T>, code: ErrorCode, label = '操作'): void {
  if (result.ok) {
    throw new Error(`${label}：预期失败（${code}），实际成功了`)
  }
  if (result.error.code !== code) {
    throw new Error(`${label}：预期错误码 ${code}，实际 ${result.error.code}（${result.error.message}）`)
  }
}

/** 失败结果的 `detail`（断言"错误里带上了哪个字段"用）。 */
export function errorDetail<T>(result: Result<T>): Record<string, unknown> {
  if (result.ok) throw new Error('预期失败，实际成功了')
  return (result.error.detail ?? {}) as Record<string, unknown>
}

/** `noUncheckedIndexedAccess` 下的取下标辅助。 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`下标越界：${index}（长度 ${items.length}）`)
  return value
}

/** 固定时钟（导出清单的 `createdAt` 可断言）。 */
export function exportClock(iso = TEST_NOW) {
  return fixedClock(iso)
}
