/**
 * Repository 层测试辅助：临时库、种子数据、确定性依赖、上下文工厂、断言辅助。
 *
 * 🔴 本机 `os.tmpdir()` 不可写（EPERM），临时库一律落在 `tests/repositories/.tmp/`，
 *    由 `afterAll` 清理（参考 `tests/schema/helpers.ts` 的做法，但本文件自成一份：
 *    Repository 测试**不依赖** `tests/saveDraft/helpers.ts`，避免踩到别人正在改的文件）。
 *
 * 🔴 每个测试文件用一个**独立的库文件**，绝不使用 `:memory:`：
 *    `openDatabase` 的独占写连接登记表按规范化路径去重（`schema/open.ts:98 openWriters`），
 *    所有内存库的规范化路径是同一个字符串，同进程内第二个内存库会被误判成重复写连接
 *    而抛 `RESOURCE_LOCKED`（`schema/open.ts:106 claimExclusiveWriter`）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  encodeRevision,
  fixedClock,
  type DocumentId,
  type DocumentKind,
  type ErrorCode,
  type ProjectId,
  type RandomSource,
  type ReadContext,
  type Result,
  type UtcTimestamp,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'
import { orderKeyAfter } from '@yfe/domain/orderKey'

import type { RepositoryDeps } from '../../src/repositories/internal.js'
import { closeDatabase, migrate, openDatabase, type SqliteDatabase } from '../../src/schema/index.js'

/** 测试临时根目录（相对本文件）。 */
export const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url))

/** 固化的测试时钟。 */
export const TEST_NOW = '2026-01-01T00:00:00.000Z'

/** 1000 章用例的章节正文（700 个汉字，让 charCount 有实际计算量）。 */
export const CHAPTER_BODY = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'.repeat(25)

const created: string[] = []
const opened: SqliteDatabase[] = []

function makeTempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`))
  created.push(dir)
  return dir
}

/** 打开并迁移一个全新的库文件（`backupDir: null`：测试只要结构，不要生产备份）。 */
export function openMigratedDatabase(label = 'db'): SqliteDatabase {
  const dir = makeTempDir(label)
  const db = openDatabase(join(dir, 'app.db'))
  migrate(db, { backupDir: null })
  opened.push(db)
  return db
}

/** 关闭所有连接并删除临时目录。测试文件在 `afterAll` 里调用。 */
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
// 依赖与上下文
// ---------------------------------------------------------------------------

/**
 * 连续的假 UUID 源：形态与 `crypto.randomUUID()` 一致，但值可预测。
 * `makeId` 会去掉连字符并截取前 26 个字符，因此要保证前 26 字符唯一。
 *
 * 计数器是**模块级**的：每个 `makeRepoDeps()` 都会新建一个源，若计数器跟着实例走，
 * 同一测试文件里两次 `makeRepoDeps()` 会生成同一批主键 → 撞 PRIMARY KEY（ALREADY_EXISTS）。
 */
let uuidCounter = 0

export function countingRandomSource(label = 'x'): RandomSource {
  return {
    uuid: () => {
      uuidCounter += 1
      const head = uuidCounter.toString(16).padStart(8, '0')
      return `${head}-0000-4000-8000-${label.padEnd(12, '0').slice(0, 12)}`
    },
  }
}

/** 确定性 Repository 依赖：固定时钟 + 递增 ID + 契约的 `encodeRevision`。 */
export function makeRepoDeps(iso = TEST_NOW): RepositoryDeps {
  return {
    clock: fixedClock(iso),
    rng: countingRandomSource('repo'),
    revisionGenerator: { next: encodeRevision },
  }
}

let requestCounter = 0

/** 可读且合法的 requestId（`isWellFormedId` 允许字母/数字/下划线）。 */
function nextRequestId(): ReadContext['requestId'] {
  requestCounter += 1
  return `req_test_${requestCounter.toString().padStart(6, '0')}` as ReadContext['requestId']
}

/** 读上下文：只带 workspaceId。 */
export function readContext(workspaceId: WorkspaceId): ReadContext {
  return { requestId: nextRequestId(), workspaceId }
}

/** 写上下文：显式声明 workspaceId / projectId / expectedRevision，绝不隐式继承。 */
export function writeContext(
  workspaceId: WorkspaceId,
  options: {
    readonly projectId?: ProjectId | null
    readonly expectedRevision?: string | null
  } = {},
): WriteContext {
  return {
    requestId: nextRequestId(),
    workspaceId,
    projectId: options.projectId ?? null,
    expectedRevision: (options.expectedRevision ?? null) as WriteContext['expectedRevision'],
  }
}

// ---------------------------------------------------------------------------
// 种子数据（直接写 SQL：测试夹具不该依赖被测的 Repository 函数）
// ---------------------------------------------------------------------------

/** 固定时间戳。 */
export function seedTime(iso = TEST_NOW): UtcTimestamp {
  return iso as UtcTimestamp
}

/** 建一个工作区（`workspaces` 是 projects 的外键父表）。 */
export function seedWorkspace(
  db: SqliteDatabase,
  options: { readonly id?: string; readonly at?: UtcTimestamp } = {},
): WorkspaceId {
  const id = (options.id ?? 'ws_test_000001') as WorkspaceId
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
  options: { readonly workspaceId: WorkspaceId; readonly id?: string; readonly at?: UtcTimestamp },
): ProjectId {
  const id = (options.id ?? 'prj_test_000001') as ProjectId
  const at = options.at ?? seedTime()
  db.prepare(
    `INSERT INTO projects (id, workspace_id, name, summary, project_type, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, '', 'full', ?, 1, 0, ?, ?)`,
  ).run(id, options.workspaceId, '测试作品', encodeRevision(1), at, at)
  return id
}

/** 直接插一条 documents 行（`revision` 与 `revision_seq` 一起初始化为 1）。 */
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

/**
 * 批量灌 `count` 章（单事务 + 复用 prepared statement）。
 *
 * 排序键用 `orderKeyAfter` 逐条追加：这是"顺序追加"的设计用途，键长保持常数级；
 * 若改成在同一缝隙里反复 `orderKeyBetween`，约 480 次就会顶到 `MAX_KEY_LENGTH=512`。
 */
export function bulkSeedChapters(
  db: SqliteDatabase,
  options: {
    readonly workspaceId: WorkspaceId
    readonly projectId: ProjectId
    readonly parentId: string | null
    readonly count: number
    readonly body?: string
    readonly idPrefix?: string
    /** 第一个章节键从这个键之后开始（通常传卷的键，保证章排在卷之后）。 */
    readonly startAfter?: string | null
  },
): DocumentId[] {
  const ids: DocumentId[] = []
  const at = seedTime()
  const insert = db.prepare(
    `INSERT INTO documents
       (id, workspace_id, project_id, kind, parent_id, order_key, title, body,
        revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, ?, 'chapter', ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
  const run = db.transaction((): void => {
    let key: string | null = options.startAfter ?? null
    for (let i = 0; i < options.count; i += 1) {
      const id = `${options.idPrefix ?? 'doc_bulk_'}${(i + 1).toString().padStart(4, '0')}`
      key = orderKeyAfter(key)
      insert.run(
        id,
        options.workspaceId,
        options.projectId,
        options.parentId,
        key,
        `第 ${i + 1} 章`,
        options.body ?? '',
        encodeRevision(1),
        at,
        at,
      )
      ids.push(id as DocumentId)
    }
  })
  run()
  return ids
}

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** 读 `documents` 行（正文、键、revision、序号、删除标记）。 */
export function readDocumentRow(
  db: SqliteDatabase,
  documentId: DocumentId | string,
): {
  body: string
  title: string
  orderKey: string
  parentId: string | null
  revision: string
  revisionSeq: number
  deleted: number
} {
  const row = db
    .prepare(
      `SELECT body, title, order_key, parent_id, revision, revision_seq, deleted
         FROM documents WHERE id = ?`,
    )
    .get(documentId) as
    | {
        body: string
        title: string
        order_key: string
        parent_id: string | null
        revision: string
        revision_seq: number
        deleted: number
      }
    | undefined
  if (!row) throw new Error(`documents 行不存在：${documentId}`)
  return {
    body: row.body,
    title: row.title,
    orderKey: row.order_key,
    parentId: row.parent_id,
    revision: row.revision,
    revisionSeq: row.revision_seq,
    deleted: row.deleted,
  }
}

/** 读 `projects` 行。 */
export function readProjectRow(
  db: SqliteDatabase,
  projectId: ProjectId | string,
): { name: string; summary: string; projectType: string; revision: string; revisionSeq: number; deleted: number } {
  const row = db
    .prepare(
      `SELECT name, summary, project_type, revision, revision_seq, deleted FROM projects WHERE id = ?`,
    )
    .get(projectId) as
    | {
        name: string
        summary: string
        project_type: string
        revision: string
        revision_seq: number
        deleted: number
      }
    | undefined
  if (!row) throw new Error(`projects 行不存在：${projectId}`)
  return {
    name: row.name,
    summary: row.summary,
    projectType: row.project_type,
    revision: row.revision,
    revisionSeq: row.revision_seq,
    deleted: row.deleted,
  }
}

/** 读 `settings_entities` 行（含原始 `values_json` 文本）。 */
export function readSettingsRow(
  db: SqliteDatabase,
  entityId: string,
): {
  valuesJson: string
  schemaTemplateId: string
  name: string
  orderKey: string
  revision: string
  revisionSeq: number
  deleted: number
} {
  const row = db
    .prepare(
      `SELECT values_json, schema_template_id, name, order_key, revision, revision_seq, deleted
         FROM settings_entities WHERE id = ?`,
    )
    .get(entityId) as
    | {
        values_json: string
        schema_template_id: string
        name: string
        order_key: string
        revision: string
        revision_seq: number
        deleted: number
      }
    | undefined
  if (!row) throw new Error(`settings_entities 行不存在：${entityId}`)
  return {
    valuesJson: row.values_json,
    schemaTemplateId: row.schema_template_id,
    name: row.name,
    orderKey: row.order_key,
    revision: row.revision,
    revisionSeq: row.revision_seq,
    deleted: row.deleted,
  }
}

/** 单表行数。 */
export function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  return row.c
}

/** 取出成功值；失败时抛出带错误码的信息（比裸 `expect` 更容易定位）。 */
export function unwrap<T>(result: Result<T>, label = '操作'): T {
  if (!result.ok) {
    throw new Error(`${label} 失败：${result.error.code} ${result.error.message}`)
  }
  return result.value
}

/** 断言失败且错误码恰好是 `code`（用于"越界必须报错"这类反向断言）。 */
export function expectErrCode<T>(result: Result<T>, code: ErrorCode, label = '操作'): void {
  if (result.ok) {
    throw new Error(`${label}：预期失败（${code}），实际成功了`)
  }
  if (result.error.code !== code) {
    throw new Error(`${label}：预期错误码 ${code}，实际 ${result.error.code}（${result.error.message}）`)
  }
}

/** `noUncheckedIndexedAccess` 下的取下标辅助：越界即测试失败，而不是悄悄变 undefined。 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) {
    throw new Error(`下标越界：${index}（长度 ${items.length}）`)
  }
  return value
}
