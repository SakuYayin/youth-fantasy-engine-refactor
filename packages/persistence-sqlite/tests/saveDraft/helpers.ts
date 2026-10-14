/**
 * SaveDraft 测试辅助：临时库、种子数据、可注入依赖。
 *
 * 🔴 本机用户临时目录（`os.tmpdir()`）**不可写**（EPERM，已由 schema 测试实测确认），
 *    所以临时库一律落在工作目录内的 `tests/saveDraft/.tmp/`，并在 `afterAll` 清理。
 *
 * 🔴 每个测试用**独立库文件**而不是 `:memory:`：`openDatabase` 的独占写连接登记表
 *    按**规范化路径**去重，而所有 `:memory:` 库的规范化路径是同一个字符串，
 *    在同一进程里开第二个内存库会被误判成"重复写连接"而抛 `RESOURCE_LOCKED`。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  encodeRevision,
  fixedClock,
  type Clock,
  type DocumentId,
  type DocumentKind,
  type ProjectId,
  type RandomSource,
  type Revision,
  type UtcTimestamp,
  type WorkspaceId,
  newIds,
} from '@yfe/contracts'

import { closeDatabase, migrate, openDatabase, type SqliteDatabase } from '../../src/schema/index.js'
import type { IdGenerator, RevisionGenerator, SaveDraftDeps } from '../../src/saveDraft/index.js'

/** 测试临时根目录（相对本文件）。 */
export const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url))

const created: string[] = []
const opened: SqliteDatabase[] = []

/** 创建一个本次测试独占的临时目录。 */
export function makeTempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`))
  created.push(dir)
  return dir
}

/** 打开并迁移一个全新的库文件（跳过备份：备份是生产路径的保证，这里只要结构）。 */
export function openMigratedDatabase(label = 'db'): SqliteDatabase {
  const dir = makeTempDir(label)
  const db = openDatabase(join(dir, 'app.db'))
  migrate(db, { backupDir: null })
  opened.push(db)
  return db
}

/** 关闭连接并删除临时目录。测试文件在 `afterAll` 里调用。 */
export function cleanupTempDirs(): void {
  for (const db of opened.splice(0)) {
    try {
      closeDatabase(db)
    } catch {
      /* 关闭失败不影响断言结果 */
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

// ---------------------------------------------------------------------------
// 确定性 ID 源
// ---------------------------------------------------------------------------

/**
 * 连续的假 UUID 源：形态与 `crypto.randomUUID()` 一致，但值可预测。
 * `makeId` 会去掉连字符并截取前 26 个字符，因此这里要保证前 26 字符唯一。
 */
export function countingRandomSource(label = 'x'): RandomSource {
  let n = 0
  return {
    uuid: () => {
      n += 1
      const head = n.toString(16).padStart(8, '0')
      return `${head}-0000-4000-8000-${label.padEnd(12, '0').slice(0, 12)}`
    },
  }
}

/** 可注入的 SaveDraft 依赖：时钟固定、ID 递增、revision 用契约的 `encodeRevision`。 */
export interface TestDeps extends SaveDraftDeps {
  /** 让下一次 `revisionGenerator.next()` 抛错（故障注入）。 */
  failNextRevision(): void
  /** 让下一次 `ids.batch()` 抛错（故障注入：正文已 UPDATE 之后再失败，验证回滚）。 */
  failNextBatch(): void
  /** 让下一次 `ids.operation()` 抛错。 */
  failNextOperation(): void
}

/** 造一份确定性依赖。默认时钟固定为 `2026-01-01T00:00:00.000Z`。 */
export function makeTestDeps(iso = '2026-01-01T00:00:00.000Z'): TestDeps {
  const clock: Clock = fixedClock(iso)
  const revisionGenerator: RevisionGenerator = { next: encodeRevision }
  let revisionFailure: Error | null = null
  let batchFailure: Error | null = null
  let operationFailure: Error | null = null
  let counter = 0

  const ids: IdGenerator = {
    revisionRow: () => `rev_${(counter += 1).toString().padStart(6, '0')}`,
    operation: () => {
      if (operationFailure) {
        const thrown = operationFailure
        operationFailure = null
        throw thrown
      }
      return `op_${(counter += 1).toString().padStart(6, '0')}`
    },
    batch: () => {
      if (batchFailure) {
        const thrown = batchFailure
        batchFailure = null
        throw thrown
      }
      return `bat_${(counter += 1).toString().padStart(6, '0')}`
    },
  }

  return {
    clock,
    ids,
    revisionGenerator: {
      next: (seq: number): Revision => {
        if (revisionFailure) {
          const thrown = revisionFailure
          revisionFailure = null
          throw thrown
        }
        return revisionGenerator.next(seq)
      },
    },
    failNextRevision: () => {
      revisionFailure = new Error('注入故障：revision 生成器失败')
    },
    failNextBatch: () => {
      batchFailure = new Error('注入故障：batch ID 生成失败')
    },
    failNextOperation: () => {
      operationFailure = new Error('注入故障：operation ID 生成失败')
    },
  }
}

/** 固定时钟派生出的 UTC 时间戳，用于种子数据。 */
export function seedTime(iso = '2026-01-01T00:00:00.000Z'): UtcTimestamp {
  return iso as UtcTimestamp
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

/** 建一个工作区（`workspaces` 是 projects/documents 的外键父表）。 */
export function seedWorkspace(
  db: SqliteDatabase,
  options: { readonly id?: WorkspaceId; readonly at?: UtcTimestamp } = {},
): WorkspaceId {
  const id = (options.id ?? newIds.workspace(countingRandomSource('ws'))) as WorkspaceId
  const at = options.at ?? seedTime()
  db.prepare(
    `INSERT INTO workspaces (id, name, schema_version, authority_target_id, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, 1, NULL, ?, 1, 0, ?, ?)`,
  ).run(id, '本地工作区', encodeRevision(1), at, at)
  return id
}

/** 建一个作品。 */
export function seedProject(
  db: SqliteDatabase,
  options: { readonly workspaceId: WorkspaceId; readonly id?: ProjectId; readonly at?: UtcTimestamp },
): ProjectId {
  const id = (options.id ?? newIds.project(countingRandomSource('pr'))) as ProjectId
  const at = options.at ?? seedTime()
  db.prepare(
    `INSERT INTO projects (id, workspace_id, name, summary, project_type, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, '', 'full', ?, 1, 0, ?, ?)`,
  ).run(id, options.workspaceId, '测试作品', encodeRevision(1), at, at)
  return id
}

/** 建一篇文档（默认 `revision_seq = 1`：新建实体必须与 `revision` 一起初始化）。 */
export function seedDocument(
  db: SqliteDatabase,
  options: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly id?: DocumentId
    readonly kind?: DocumentKind
    readonly title?: string
    readonly body?: string
    /** 与 `revision` 必须一致：`revision = encodeRevision(revisionSeq)`。 */
    readonly revisionSeq?: number
    readonly deleted?: number
    readonly orderKey?: string
    readonly at?: UtcTimestamp
  },
): DocumentId {
  const id = (options.id ?? newIds.document(countingRandomSource('dc'))) as DocumentId
  const at = options.at ?? seedTime()
  const seq = options.revisionSeq ?? 1
  db.prepare(
    `INSERT INTO documents (id, workspace_id, project_id, kind, parent_id, order_key, title, body, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.workspaceId,
    options.projectId,
    options.kind ?? 'chapter',
    options.orderKey ?? 'a0',
    options.title ?? '第一章',
    options.body ?? '',
    encodeRevision(seq),
    seq,
    options.deleted ?? 0,
    at,
    at,
  )
  return id
}

/** 一次性造出「工作区 + 作品 + 文档」并返回三个 ID。 */
export function seedProjectWithDocument(
  db: SqliteDatabase,
  document: {
    readonly title?: string
    readonly body?: string
    readonly revisionSeq?: number
    readonly deleted?: number
  } = {},
): {
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly documentId: DocumentId
} {
  const workspaceId = seedWorkspace(db)
  const projectId = seedProject(db, { workspaceId })
  const documentId = seedDocument(db, {
    workspaceId,
    projectId,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.body === undefined ? {} : { body: document.body }),
    ...(document.revisionSeq === undefined ? {} : { revisionSeq: document.revisionSeq }),
    ...(document.deleted === undefined ? {} : { deleted: document.deleted }),
  })
  return { workspaceId, projectId, documentId }
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 读 `documents` 行（正文、revision、序号、删除标记）。 */
export function readDocumentRow(
  db: SqliteDatabase,
  documentId: DocumentId,
): { body: string; revision: string; revisionSeq: number; deleted: number; updatedAt: string } {
  const row = db
    .prepare(
      `SELECT body, revision, revision_seq, deleted, updated_at FROM documents WHERE id = ?`,
    )
    .get(documentId) as
    | { body: string; revision: string; revision_seq: number; deleted: number; updated_at: string }
    | undefined
  if (!row) throw new Error(`documents 行不存在：${documentId}`)
  return {
    body: row.body,
    revision: row.revision,
    revisionSeq: row.revision_seq,
    deleted: row.deleted,
    updatedAt: row.updated_at,
  }
}

/** 单表行数。 */
export function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

/** 按实体读 `revisions` 行（按 `seq` 升序）。 */
export function readRevisionRows(
  db: SqliteDatabase,
  entityId: string,
): Array<{ revision: string; seq: number; baseRevision: string | null; bodySnapshot: string | null }> {
  const rows = db
    .prepare(
      `SELECT revision, seq, base_revision, body_snapshot FROM revisions
        WHERE entity_type = 'document' AND entity_id = ? ORDER BY seq`,
    )
    .all(entityId) as Array<{
    revision: string
    seq: number
    base_revision: string | null
    body_snapshot: string | null
  }>
  return rows.map((row) => ({
    revision: row.revision,
    seq: row.seq,
    baseRevision: row.base_revision,
    bodySnapshot: row.body_snapshot,
  }))
}

/** 按实体读 `operations` 行（按创建顺序）。 */
export function readOperationRows(
  db: SqliteDatabase,
  entityId: string,
): Array<{
  opId: string
  batchId: string
  baseRevision: string | null
  newRevision: string
  action: string
  payload: unknown
}> {
  const rows = db
    .prepare(
      `SELECT op_id, batch_id, base_revision, new_revision, action, payload_json
         FROM operations WHERE entity_id = ? ORDER BY created_at, op_id`,
    )
    .all(entityId) as Array<{
    op_id: string
    batch_id: string
    base_revision: string | null
    new_revision: string
    action: string
    payload_json: string
  }>
  return rows.map((row) => ({
    opId: row.op_id,
    batchId: row.batch_id,
    baseRevision: row.base_revision,
    newRevision: row.new_revision,
    action: row.action,
    payload: JSON.parse(row.payload_json) as unknown,
  }))
}

/** 读 `outbox` 行。 */
export function readOutboxRows(
  db: SqliteDatabase,
): Array<{ opId: string; targetId: string; state: string; attemptCount: number }> {
  const rows = db
    .prepare(`SELECT op_id, target_id, state, attempt_count FROM outbox`)
    .all() as Array<{ op_id: string; target_id: string; state: string; attempt_count: number }>
  return rows.map((row) => ({
    opId: row.op_id,
    targetId: row.target_id,
    state: row.state,
    attemptCount: row.attempt_count,
  }))
}

/** 读 `local_drafts` 单行。 */
export function readDraftRow(
  db: SqliteDatabase,
  documentId: DocumentId,
  sessionId: string,
): {
  sequence: number
  body: string
  baseRevision: string | null
  confirmedRevision: string | null
  updatedAt: string
} | null {
  const row = db
    .prepare(
      `SELECT sequence, body, base_revision, confirmed_revision, updated_at
         FROM local_drafts WHERE document_id = ? AND session_id = ?`,
    )
    .get(documentId, sessionId) as
    | {
        sequence: number
        body: string
        base_revision: string | null
        confirmed_revision: string | null
        updated_at: string
      }
    | undefined
  if (!row) return null
  return {
    sequence: row.sequence,
    body: row.body,
    baseRevision: row.base_revision,
    confirmedRevision: row.confirmed_revision,
    updatedAt: row.updated_at,
  }
}
