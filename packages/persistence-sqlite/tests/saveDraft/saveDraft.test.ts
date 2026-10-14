/**
 * `saveDraft` 写事务与 `local_drafts` 水位线的验收测试（P1-A2）。
 *
 * 覆盖任务书的 9 类用例：
 * 1. 正常保存：正文 / revision / `revision_seq + 1` / `charCount`（**字素簇**）/ `savedAt`；
 * 2. `expectedRevision` 过期 → `REVISION_CONFLICT`，库内一字未改；
 * 3. 同 `draftSequence` 幂等重放 → 返回同一 revision，`operations` 不新增；
 * 4. 更小的 `draftSequence` → `VALIDATION_OUT_OF_RANGE`，正文未变；
 * 5. 注入抛错的 deps → 整事务回滚（`documents` 回旧值，四张表零新增）；
 * 6. 快速切章：`documents.revision_seq` 与 `revisions.seq` 逐次对应，且**不由 COUNT(*) 推导**；
 * 7. 软删文档（`deleted <> 0`）→ `NOT_FOUND_DOCUMENT`；
 * 8. 跨 project / 跨 workspace 的 context → `PERMISSION_WORKSPACE_MISMATCH`；
 * 9. `local_drafts` 水位线：确认后**不删行**、清 body、写 `confirmed_revision`；
 *    新草稿把 `confirmed_revision` 置回 NULL；同序号未确认走 pending-retry 重走保存。
 *
 * 🔴 每个 `it` 各开一个**独立库文件**：`helpers.ts` 顶部说明 `:memory:` 会被
 *    独占写连接登记表（按规范化路径去重）误判成重复写连接而抛 `RESOURCE_LOCKED`。
 *
 * 🔴 序号断言一律写成 `encodeRevision(n)` 的**具体值**，绝不用 `COUNT(*)` 反推——
 *    否则被测实现与断言犯同一个错，测试会失去甄别力。
 */

import { afterAll, describe, expect, it } from 'vitest'

import {
  encodeRevision,
  type DocumentId,
  type ErrorPayload,
  type LocalDraft,
  type ProjectId,
  type RequestId,
  type Result,
  type Revision,
  type SaveDraftInput,
  type UtcTimestamp,
  type WorkspaceId,
} from '@yfe/contracts'
import { countChars } from '@yfe/domain/text'

import type { SqliteDatabase } from '../../src/schema/index.js'
import {
  DOCUMENT_ENTITY_TYPE,
  LOCAL_SYNC_TARGET_ID,
  checkDraftSequence,
  discardLocalDraft,
  listRecoverableDrafts,
  putPendingDraft,
  readLocalDraft,
  saveDraft,
} from '../../src/saveDraft/index.js'
import {
  cleanupTempDirs,
  countRows,
  makeTestDeps,
  openMigratedDatabase,
  readDocumentRow,
  readDraftRow,
  readOperationRows,
  readOutboxRows,
  readRevisionRows,
  seedProject,
  seedProjectWithDocument,
  seedTime,
  seedWorkspace,
  type TestDeps,
} from './helpers.js'

afterAll(() => {
  cleanupTempDirs()
})

// ---------------------------------------------------------------------------
// 夹具与断言辅助
// ---------------------------------------------------------------------------

const REQUEST = 'req_savedraft_0001' as RequestId
const SESSION = 'sess_editor_a'
const FIXED_ISO = '2026-01-01T00:00:00.000Z' as UtcTimestamp

interface Fixture {
  readonly db: SqliteDatabase
  readonly workspaceId: WorkspaceId
  readonly projectId: ProjectId
  readonly documentId: DocumentId
  readonly deps: TestDeps
}

/** 全新库 + 工作区/作品/文档 + 确定性依赖。全程固定时钟，`savedAt` 可逐字断言。 */
function fixture(
  seed: {
    readonly title?: string
    readonly body?: string
    readonly revisionSeq?: number
    readonly deleted?: number
  } = {},
): Fixture {
  const db = openMigratedDatabase('saveDraft')
  const ids = seedProjectWithDocument(db, seed)
  return { db, ...ids, deps: makeTestDeps(FIXED_ISO) }
}

/** 构造 `SaveDraftInput`；`overrides` 用来制造跨 project / 跨 workspace 的上下文。 */
function input(
  f: Fixture,
  body: string,
  draftSequence: number,
  expectedRevision: Revision | null,
  overrides: {
    readonly workspaceId?: WorkspaceId
    readonly projectId?: ProjectId | null
    readonly sessionId?: string
  } = {},
): SaveDraftInput {
  return {
    context: {
      requestId: REQUEST,
      workspaceId: overrides.workspaceId ?? f.workspaceId,
      // `undefined` = 沿用夹具的 projectId；显式传 `null` = 宿主未限定作品范围。
      projectId: overrides.projectId === undefined ? f.projectId : overrides.projectId,
      expectedRevision,
    },
    documentId: f.documentId,
    draftSequence,
    body,
    sessionId: overrides.sessionId ?? SESSION,
  }
}

function okValue<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败：${result.error.code} —— ${result.error.message}`)
  }
  return result.value
}

function errPayload<T>(result: Result<T>): ErrorPayload {
  if (result.ok) throw new Error('预期失败，实际成功了')
  return result.error
}

/** `noUncheckedIndexedAccess` 下的取下标：越界即测试失败，而不是悄悄变 undefined。 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) {
    throw new Error(`下标越界：${index}（长度 ${items.length}）`)
  }
  return value
}

/** 断言"这次保存一个字节都没写进去"：文档行仍是种子值，四张写表零新增。 */
function expectNoWrite(f: Fixture, expectedBody: string): void {
  const document = readDocumentRow(f.db, f.documentId)
  expect(document.body).toBe(expectedBody)
  expect(document.revision).toBe(encodeRevision(1))
  expect(document.revisionSeq).toBe(1)
  expect(countRows(f.db, 'revisions')).toBe(0)
  expect(countRows(f.db, 'operations')).toBe(0)
  expect(countRows(f.db, 'outbox')).toBe(0)
  expect(countRows(f.db, 'local_drafts')).toBe(0)
}

/** 注入故障走 `toErrorPayload`：INTERNAL_ERROR + cause 保留原始消息，绝不冒充成功。 */
function expectInternalError(error: ErrorPayload, cause: string): void {
  expect(error.code).toBe('INTERNAL_ERROR')
  expect(error.severity).toBe('error')
  expect(error.retryable).toBe(false)
  expect(error.requestId).toBe(REQUEST)
  expect(error.cause).toBe(cause)
}

/** 手写一条 `local_drafts` 行（模拟"上一次保存留下的水位线"）。 */
function insertDraftRow(
  db: SqliteDatabase,
  row: {
    readonly documentId: DocumentId
    readonly sessionId: string
    readonly sequence: number
    readonly body: string
    readonly baseRevision: Revision | null
    readonly confirmedRevision: Revision | null
    readonly updatedAt: string
  },
): void {
  db.prepare(
    `INSERT INTO local_drafts
       (document_id, session_id, sequence, body, base_revision, confirmed_revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.documentId,
    row.sessionId,
    row.sequence,
    row.body,
    row.baseRevision,
    row.confirmedRevision,
    row.updatedAt,
  )
}

// ---------------------------------------------------------------------------
// 1. 正常保存
// ---------------------------------------------------------------------------

describe('1. 正常保存：正文 / revision / revision_seq / 字数 / savedAt', () => {
  it('写入正文并把 revision_seq 从 1 推进到 2，返回字素簇字数与 savedAt', () => {
    const f = fixture({ body: '起始正文' })
    // 3 个字素簇：'正' / '文' / 'e' + U+0301（组合尖音符）。UTF-16 长度是 4。
    const body = '正文e\u0301'

    const value = okValue(saveDraft(f.db, input(f, body, 1, encodeRevision(1)), f.deps))

    expect(value.revision).toBe(encodeRevision(2))
    expect(value.draftSequence).toBe(1)
    expect(value.savedAt).toBe(FIXED_ISO)
    expect(value.charCount).toBe(3)
    expect(value.charCount).toBe(countChars(body))
    expect(body.length).toBe(4) // 证明不是按 UTF-16 码元计数

    const document = readDocumentRow(f.db, f.documentId)
    expect(document.body).toBe(body)
    expect(document.revision).toBe(encodeRevision(2))
    expect(document.revisionSeq).toBe(2)
    expect(document.updatedAt).toBe(FIXED_ISO)

    // revisions：seq 与 documents.revision_seq 是同一个整数；base 用库内旧值。
    expect(readRevisionRows(f.db, f.documentId)).toEqual([
      {
        revision: encodeRevision(2),
        seq: 2,
        baseRevision: encodeRevision(1),
        bodySnapshot: body,
      },
    ])

    const operations = readOperationRows(f.db, f.documentId)
    expect(operations).toHaveLength(1)
    const op = at(operations, 0)
    expect(op.action).toBe('upsert')
    expect(op.baseRevision).toBe(encodeRevision(1))
    expect(op.newRevision).toBe(encodeRevision(2))
    expect(op.payload).toEqual({ body, charCount: 3 })

    // 实体类型常量必须真的落到库里（拼写漂移会让同步端静默丢弃操作）。
    const opEntityType = f.db
      .prepare(`SELECT entity_type FROM operations WHERE op_id = ?`)
      .get(op.opId) as { entity_type: string }
    const revEntityType = f.db
      .prepare(`SELECT entity_type FROM revisions WHERE entity_id = ?`)
      .get(f.documentId) as { entity_type: string }
    expect(opEntityType.entity_type).toBe(DOCUMENT_ENTITY_TYPE)
    expect(revEntityType.entity_type).toBe(DOCUMENT_ENTITY_TYPE)

    // outbox：与 operation 同 op_id / batch_id，目标 'local'，初始 pending / 0 次尝试。
    expect(readOutboxRows(f.db)).toEqual([
      { opId: op.opId, targetId: LOCAL_SYNC_TARGET_ID, state: 'pending', attemptCount: 0 },
    ])
    expect(LOCAL_SYNC_TARGET_ID).toBe('local')

    // 水位线随正文同事务落库：已确认 → body 清空 + confirmed_revision。
    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 1,
      body: '',
      baseRevision: encodeRevision(1),
      confirmedRevision: encodeRevision(2),
      updatedAt: FIXED_ISO,
    })
  })

  it('正文为空串也允许保存（revision 照常推进，charCount 为 0）', () => {
    const f = fixture({ body: '待清空的正文' })
    const value = okValue(saveDraft(f.db, input(f, '', 1, encodeRevision(1)), f.deps))
    expect(value.charCount).toBe(0)
    expect(value.revision).toBe(encodeRevision(2))
    expect(readDocumentRow(f.db, f.documentId).body).toBe('')
    expect(countRows(f.db, 'operations')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. expectedRevision 过期
// ---------------------------------------------------------------------------

describe('2. expectedRevision 过期', () => {
  it('返回 REVISION_CONFLICT，且正文一字未变、outbox 计数不变', () => {
    const f = fixture({ body: '原始正文' })

    const error = errPayload(saveDraft(f.db, input(f, '新正文', 1, encodeRevision(9)), f.deps))

    expect(error.code).toBe('REVISION_CONFLICT')
    expect(error.severity).toBe('info')
    expect(error.retryable).toBe(true)
    expect(error.requestId).toBe(REQUEST)
    expect(error.detail).toEqual({
      expectedRevision: encodeRevision(9),
      currentRevision: encodeRevision(1),
    })

    expectNoWrite(f, '原始正文')
  })

  it('expectedRevision = null 表示不校验（首次保存/新实体约定），照常写入', () => {
    const f = fixture({ body: '起始正文' })
    const value = okValue(saveDraft(f.db, input(f, '不校验的正文', 1, null), f.deps))
    expect(value.revision).toBe(encodeRevision(2))
    expect(readDocumentRow(f.db, f.documentId).body).toBe('不校验的正文')
  })
})

// ---------------------------------------------------------------------------
// 3. 幂等重放
// ---------------------------------------------------------------------------

describe('3. 同 draftSequence 幂等重放', () => {
  it('返回同一 revision，且 operations / revisions / outbox 不新增第二条', () => {
    const f = fixture({ body: '起始正文' })
    const first = okValue(saveDraft(f.db, input(f, '第一次正文', 1, encodeRevision(1)), f.deps))
    expect(first.revision).toBe(encodeRevision(2))
    expect(countRows(f.db, 'operations')).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(1)
    expect(countRows(f.db, 'outbox')).toBe(1)

    // 重放时正文**刻意不同**：若实现把重放当新草稿，正文与计数都会变。
    const replay = okValue(
      saveDraft(f.db, input(f, '重放时携带的另一份正文', 1, encodeRevision(2)), f.deps),
    )

    expect(replay.revision).toBe(first.revision)
    expect(replay.savedAt).toBe(first.savedAt)
    expect(replay.draftSequence).toBe(first.draftSequence)

    expect(countRows(f.db, 'operations')).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(1)
    expect(countRows(f.db, 'outbox')).toBe(1)

    const document = readDocumentRow(f.db, f.documentId)
    expect(document.body).toBe('第一次正文')
    expect(document.revision).toBe(encodeRevision(2))
    expect(document.revisionSeq).toBe(2)
  })

  it('同序号 + 同正文重放，返回的整个结果对象与首发逐字节一致', () => {
    const f = fixture({ body: '起始正文' })
    const body = '同一份正文'
    const first = okValue(saveDraft(f.db, input(f, body, 1, encodeRevision(1)), f.deps))
    const replay = saveDraft(f.db, input(f, body, 1, encodeRevision(2)), f.deps)

    expect(replay).toEqual({ ok: true, value: first })
    expect(at(readRevisionRows(f.db, f.documentId), 0).seq).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. 更小的 draftSequence
// ---------------------------------------------------------------------------

describe('4. 更小的 draftSequence（迟到保存）', () => {
  it('被拒绝为 VALIDATION_OUT_OF_RANGE，正文、revision 与各表计数均不变', () => {
    const f = fixture({ body: '起始正文' })
    const high = okValue(saveDraft(f.db, input(f, '更新的草稿', 5, encodeRevision(1)), f.deps))

    const error = errPayload(saveDraft(f.db, input(f, '迟到的旧草稿', 3, high.revision), f.deps))

    expect(error.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(error.detail).toEqual({ draftSequence: 3, storedSequence: 5 })

    const document = readDocumentRow(f.db, f.documentId)
    expect(document.body).toBe('更新的草稿')
    expect(document.revision).toBe(high.revision)
    expect(document.revisionSeq).toBe(2)
    expect(countRows(f.db, 'revisions')).toBe(1)
    expect(countRows(f.db, 'operations')).toBe(1)
    expect(countRows(f.db, 'outbox')).toBe(1)

    // 水位线仍是高序号，没有被迟到保存往回拽。
    const draft = readDraftRow(f.db, f.documentId, SESSION)
    expect(draft?.sequence).toBe(5)
    expect(draft?.confirmedRevision).toBe(high.revision)
  })

  it('负数 / 非整数 draftSequence 在事务外就被拦下（不碰库）', () => {
    const f = fixture({ body: '起始正文' })
    expect(errPayload(saveDraft(f.db, input(f, '负序号', -1, encodeRevision(1)), f.deps)).code).toBe(
      'VALIDATION_OUT_OF_RANGE',
    )
    expect(
      errPayload(saveDraft(f.db, input(f, '小数序号', 1.5, encodeRevision(1)), f.deps)).code,
    ).toBe('VALIDATION_OUT_OF_RANGE')
    // 非安全整数在 `saveDraft` 的入参校验里就被拒绝，不会走到 `checkDraftSequence`。
    expectNoWrite(f, '起始正文')
  })
})

// ---------------------------------------------------------------------------
// 5. 事务回滚
// ---------------------------------------------------------------------------

describe('5. 注入抛错的 deps → 整事务回滚', () => {
  it('ids.operation() 抛错（documents 已 UPDATE 之后失败）：正文回滚，四表零新增', () => {
    const f = fixture({ body: '原始正文' })
    f.deps.failNextOperation()

    const error = errPayload(saveDraft(f.db, input(f, '这次保存必须整体失败', 1, encodeRevision(1)), f.deps))

    expectInternalError(error, '注入故障：operation ID 生成失败')
    expectNoWrite(f, '原始正文')
    expect(readDocumentRow(f.db, f.documentId).updatedAt).toBe(FIXED_ISO)
  })

  it('ids.batch() 抛错：同上', () => {
    const f = fixture({ body: '原始正文' })
    f.deps.failNextBatch()

    const error = errPayload(saveDraft(f.db, input(f, '这次保存必须整体失败', 1, encodeRevision(1)), f.deps))

    expectInternalError(error, '注入故障：batch ID 生成失败')
    expectNoWrite(f, '原始正文')
  })

  it('revisionGenerator.next() 抛错（UPDATE 之前失败）：同样零写入', () => {
    const f = fixture({ body: '原始正文' })
    f.deps.failNextRevision()

    const error = errPayload(saveDraft(f.db, input(f, '这次保存必须整体失败', 1, encodeRevision(1)), f.deps))

    expectInternalError(error, '注入故障：revision 生成器失败')
    expectNoWrite(f, '原始正文')
  })

  it('回滚之后仍可用同一依赖正常保存（故障注入只生效一次，库未被污染）', () => {
    const f = fixture({ body: '原始正文' })
    f.deps.failNextOperation()
    errPayload(saveDraft(f.db, input(f, '失败的一次', 1, encodeRevision(1)), f.deps))

    const value = okValue(saveDraft(f.db, input(f, '成功的一次', 1, encodeRevision(1)), f.deps))
    expect(value.revision).toBe(encodeRevision(2))
    expect(readDocumentRow(f.db, f.documentId).revisionSeq).toBe(2)
    expect(countRows(f.db, 'operations')).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(1)
    expect(countRows(f.db, 'outbox')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. 快速切章与序号来源
// ---------------------------------------------------------------------------

describe('6. 快速切章：revision_seq 与 revisions.seq 逐次对应', () => {
  it('连续 3 次保存推进为 2 / 3 / 4（种子水位 1；新实体 revision_seq 从 1 起）', () => {
    const f = fixture({ body: '起始正文' })

    // 种子水位：新实体的 revision_seq 从 1 起（与 repositories 的 createDocument 同约定），
    // 因此首次保存必然推进到 2。这正是"序号来自实体行"的直接证据：
    // 此刻 revisions 表一行都没有，COUNT(*)+1 会得到 1。
    expect(readDocumentRow(f.db, f.documentId).revisionSeq).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(0)

    const saved: Revision[] = []
    let expected: Revision = encodeRevision(1)
    for (const sequence of [1, 2, 3]) {
      const value = okValue(saveDraft(f.db, input(f, `第 ${sequence} 稿`, sequence, expected), f.deps))
      saved.push(value.revision)
      expected = value.revision

      const document = readDocumentRow(f.db, f.documentId)
      const rows = readRevisionRows(f.db, f.documentId)
      expect(document.revision).toBe(value.revision)
      expect(document.revisionSeq).toBe(sequence + 1)
      // 每次保存后，revisions 最新一行的 seq 必须等于 documents.revision_seq。
      expect(at(rows, rows.length - 1).seq).toBe(document.revisionSeq)
      expect(at(rows, rows.length - 1).revision).toBe(value.revision)
      expect(rows.map((row) => row.seq)).toEqual([2, 3, 4].slice(0, sequence))
    }

    expect(saved).toEqual([encodeRevision(2), encodeRevision(3), encodeRevision(4)])
    expect(readDocumentRow(f.db, f.documentId).revisionSeq).toBe(4)
    expect(countRows(f.db, 'operations')).toBe(3)
    expect(countRows(f.db, 'outbox')).toBe(3)
  })

  it('revisions 被保留期 GC 裁剪后，序号仍从 documents.revision_seq 推进（钉死"禁止 COUNT(*)+1"）', () => {
    const f = fixture({ body: '起始正文' })

    let expected: Revision = encodeRevision(1)
    for (const sequence of [1, 2, 3]) {
      expected = okValue(saveDraft(f.db, input(f, `第 ${sequence} 稿`, sequence, expected), f.deps)).revision
    }
    expect(readRevisionRows(f.db, f.documentId).map((row) => row.seq)).toEqual([2, 3, 4])

    // 模拟保留期 GC：裁掉最早的一条修订记录，留下一个"序号空洞"。
    const removed = f.db
      .prepare(`DELETE FROM revisions WHERE entity_id = ? AND seq = ?`)
      .run(f.documentId, 2)
    expect(removed.changes).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(2)

    const afterGc = okValue(saveDraft(f.db, input(f, 'GC 之后的第 4 稿', 4, expected), f.deps))

    // COUNT(*)+1 = 3 的错误实现会退回 encodeRevision(3)，与已存在的 seq 3 撞 UNIQUE。
    expect(afterGc.revision).toBe(encodeRevision(5))
    expect(afterGc.revision).not.toBe(encodeRevision(3))
    expect(readDocumentRow(f.db, f.documentId).revisionSeq).toBe(5)
    expect(readRevisionRows(f.db, f.documentId).map((row) => row.seq)).toEqual([3, 4, 5])
  })
})

// ---------------------------------------------------------------------------
// 7. 软删文档
// ---------------------------------------------------------------------------

describe('7. 软删文档不可保存', () => {
  it('deleted = 1 → NOT_FOUND_DOCUMENT，正文未变', () => {
    const f = fixture({ body: '已删正文', deleted: 1 })

    const error = errPayload(saveDraft(f.db, input(f, '尝试写入已删文档', 1, encodeRevision(1)), f.deps))

    expect(error.code).toBe('NOT_FOUND_DOCUMENT')
    expect(error.detail).toEqual({ field: 'documentId', deleted: 1 })
    expectNoWrite(f, '已删正文')
  })

  it('deleted = 2（非 1 的非零值）同样被拒绝：必须是"与 0 比较"，不是"等于 1"', () => {
    const f = fixture({ body: '已删正文', deleted: 2 })

    const error = errPayload(saveDraft(f.db, input(f, '尝试写入已删文档', 1, encodeRevision(1)), f.deps))

    expect(error.code).toBe('NOT_FOUND_DOCUMENT')
    expect(error.detail).toEqual({ field: 'documentId', deleted: 2 })
    expectNoWrite(f, '已删正文')
  })

  it('文档 ID 不存在 → NOT_FOUND_DOCUMENT（与软删同码，但 detail 不带 deleted）', () => {
    const f = fixture({ body: '起始正文' })
    const error = errPayload(
      saveDraft(
        f.db,
        {
          context: {
            requestId: REQUEST,
            workspaceId: f.workspaceId,
            projectId: f.projectId,
            expectedRevision: encodeRevision(1),
          },
          documentId: 'doc_savedraft_missing' as DocumentId,
          draftSequence: 1,
          body: '写不存在的文档',
          sessionId: SESSION,
        },
        f.deps,
      ),
    )
    expect(error.code).toBe('NOT_FOUND_DOCUMENT')
    expect(error.detail).toEqual({ field: 'documentId' })
    expectNoWrite(f, '起始正文')
  })

  it('文档 ID 格式非法 → VALIDATION_MALFORMED_ID（事务外就拦下）', () => {
    const f = fixture({ body: '起始正文' })
    const error = errPayload(
      saveDraft(
        f.db,
        {
          context: {
            requestId: REQUEST,
            workspaceId: f.workspaceId,
            projectId: f.projectId,
            expectedRevision: encodeRevision(1),
          },
          documentId: 'doc bad id' as DocumentId,
          draftSequence: 1,
          body: '非法文档 ID',
          sessionId: SESSION,
        },
        f.deps,
      ),
    )
    expect(error.code).toBe('VALIDATION_MALFORMED_ID')
    expectNoWrite(f, '起始正文')
  })
})

// ---------------------------------------------------------------------------
// 8. 跨 project / 跨 workspace
// ---------------------------------------------------------------------------

describe('8. context 归属不符 → PERMISSION_WORKSPACE_MISMATCH', () => {
  it('context.projectId 指向别的作品：拒绝且正文未变', () => {
    const f = fixture({ body: '原文' })
    const otherProject = seedProject(f.db, {
      workspaceId: f.workspaceId,
      id: 'prj_savedraft_other' as ProjectId,
    })
    expect(otherProject).not.toBe(f.projectId)

    const error = errPayload(
      saveDraft(f.db, input(f, '越权写入', 1, encodeRevision(1), { projectId: otherProject }), f.deps),
    )

    expect(error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(error.detail).toEqual({ field: 'projectId' })
    expectNoWrite(f, '原文')
  })

  it('context.workspaceId 指向别的工作区：拒绝且正文未变', () => {
    const f = fixture({ body: '原文' })
    const otherWorkspace = seedWorkspace(f.db, { id: 'ws_savedraft_other' as WorkspaceId })
    expect(otherWorkspace).not.toBe(f.workspaceId)

    const error = errPayload(
      saveDraft(f.db, input(f, '越权写入', 1, encodeRevision(1), { workspaceId: otherWorkspace }), f.deps),
    )

    expect(error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(error.detail).toEqual({ field: 'workspaceId' })
    expectNoWrite(f, '原文')
  })

  it('context.projectId = null（宿主未限定作品范围）时允许保存', () => {
    const f = fixture({ body: '原文' })
    const value = okValue(
      saveDraft(f.db, input(f, '不限作品的正文', 1, encodeRevision(1), { projectId: null }), f.deps),
    )
    expect(value.revision).toBe(encodeRevision(2))
    expect(readDocumentRow(f.db, f.documentId).body).toBe('不限作品的正文')
  })
})

// ---------------------------------------------------------------------------
// 9. local_drafts 水位线
// ---------------------------------------------------------------------------

describe('9. local_drafts 水位线（确认后不删行 / 新草稿置 NULL / pending-retry）', () => {
  it('确认后不删行：同一 (document, session) 始终只有一行，body 置空并写 confirmed_revision', () => {
    const f = fixture({ body: '起始正文' })
    const first = okValue(saveDraft(f.db, input(f, '第一稿', 1, encodeRevision(1)), f.deps))

    expect(countRows(f.db, 'local_drafts')).toBe(1)
    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 1,
      body: '',
      baseRevision: encodeRevision(1),
      confirmedRevision: first.revision,
      updatedAt: FIXED_ISO,
    })
    // 已确认的行 body 为空 → 不会出现在"可恢复草稿"列表里，但水位线仍在。
    expect(listRecoverableDrafts(f.db, SESSION)).toEqual([])

    const second = okValue(saveDraft(f.db, input(f, '第二稿', 2, first.revision), f.deps))

    expect(countRows(f.db, 'local_drafts')).toBe(1) // 不追加历史行
    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 2,
      body: '',
      baseRevision: first.revision,
      confirmedRevision: second.revision,
      updatedAt: FIXED_ISO,
    })
    // base_revision 逐次前进：第一稿基于种子 enc(1)，第二稿基于第一稿的 revision。
    expect(readRevisionRows(f.db, f.documentId).map((row) => row.baseRevision)).toEqual([
      encodeRevision(1),
      first.revision,
    ])
  })

  it('写新草稿把 confirmed_revision 置回 NULL：新正文不会被误判成幂等重放', () => {
    const f = fixture({ body: '起始正文' })
    const first = okValue(saveDraft(f.db, input(f, '第一稿', 5, encodeRevision(1)), f.deps))
    expect(readDraftRow(f.db, f.documentId, SESSION)?.confirmedRevision).toBe(first.revision)

    // 这里直接调用 putPendingDraft，正是为了复现"putPendingDraft 之后、confirmLocalDraft 之前崩溃"
    // 的中间态——它只可能由 putPendingDraft 自己产生，saveDraft 无法构造出这个状态。
    putPendingDraft(f.db, {
      documentId: f.documentId,
      sessionId: SESSION,
      sequence: 6,
      body: '崩溃窗口里的新正文',
      baseRevision: first.revision,
      updatedAt: seedTime('2026-01-01T00:00:05.000Z'),
    })

    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 6,
      body: '崩溃窗口里的新正文',
      baseRevision: first.revision,
      confirmedRevision: null,
      updatedAt: '2026-01-01T00:00:05.000Z',
    })
    // 若 confirmed_revision 被旧值继承，这里会判成 confirmed-replay，直接把新正文丢掉。
    expect(okValue(checkDraftSequence(6, readLocalDraft(f.db, f.documentId, SESSION), REQUEST))).toEqual({
      state: 'pending-retry',
      storedSequence: 6,
    })
  })

  it('pending-retry：同序号未确认的水位线让保存重走一遍并真正写库', () => {
    const f = fixture({ body: '原文' })
    insertDraftRow(f.db, {
      documentId: f.documentId,
      sessionId: SESSION,
      sequence: 7,
      body: '崩溃前的草稿正文',
      baseRevision: encodeRevision(1),
      confirmedRevision: null,
      updatedAt: FIXED_ISO,
    })
    expect(listRecoverableDrafts(f.db, SESSION)).toHaveLength(1)

    const value = okValue(saveDraft(f.db, input(f, '重试后的正文', 7, encodeRevision(1)), f.deps))

    expect(value.revision).toBe(encodeRevision(2))
    expect(value.draftSequence).toBe(7)
    expect(readDocumentRow(f.db, f.documentId).body).toBe('重试后的正文')
    expect(countRows(f.db, 'local_drafts')).toBe(1)
    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 7,
      body: '',
      baseRevision: encodeRevision(1),
      confirmedRevision: encodeRevision(2),
      updatedAt: FIXED_ISO,
    })
    expect(countRows(f.db, 'operations')).toBe(1)
    expect(countRows(f.db, 'revisions')).toBe(1)
    expect(countRows(f.db, 'outbox')).toBe(1)
    expect(listRecoverableDrafts(f.db, SESSION)).toEqual([])
  })

  it('不同 sessionId 各自持有独立水位线', () => {
    const f = fixture({ body: '起始正文' })
    const a = okValue(saveDraft(f.db, input(f, 'A 会话的稿子', 1, encodeRevision(1)), f.deps))
    // B 会话从自己的水位线出发，序号 1 在它的维度上是全新的。
    const b = okValue(
      saveDraft(f.db, input(f, 'B 会话的稿子', 1, a.revision, { sessionId: 'sess_editor_b' }), f.deps),
    )

    expect(b.revision).toBe(encodeRevision(3))
    expect(countRows(f.db, 'local_drafts')).toBe(2)
    expect(readDraftRow(f.db, f.documentId, SESSION)?.sequence).toBe(1)
    expect(readDraftRow(f.db, f.documentId, 'sess_editor_b')?.sequence).toBe(1)
    expect(readDraftRow(f.db, f.documentId, 'sess_editor_b')?.confirmedRevision).toBe(b.revision)
    expect(countRows(f.db, 'operations')).toBe(2)
    expect(countRows(f.db, 'revisions')).toBe(2)
  })

  it('discardLocalDraft：未确认删行、已确认只清 body 并保留水位线', () => {
    const f = fixture({ body: '起始正文' })
    expect(discardLocalDraft(f.db, f.documentId, SESSION)).toBe('absent')

    insertDraftRow(f.db, {
      documentId: f.documentId,
      sessionId: SESSION,
      sequence: 3,
      body: '未确认的草稿',
      baseRevision: encodeRevision(1),
      confirmedRevision: null,
      updatedAt: FIXED_ISO,
    })
    expect(discardLocalDraft(f.db, f.documentId, SESSION)).toBe('deleted')
    expect(readDraftRow(f.db, f.documentId, SESSION)).toBeNull()

    const saved = okValue(saveDraft(f.db, input(f, '已保存的正文', 1, encodeRevision(1)), f.deps))
    expect(discardLocalDraft(f.db, f.documentId, SESSION)).toBe('cleared')
    // 行还在：删掉水位线会让同序号重试变成"新草稿"，产生重复 operation。
    expect(readDraftRow(f.db, f.documentId, SESSION)).toEqual({
      sequence: 1,
      body: '',
      baseRevision: encodeRevision(1),
      confirmedRevision: saved.revision,
      updatedAt: FIXED_ISO,
    })
  })

  it('checkDraftSequence 的判定矩阵（纯函数，逐态断言）', () => {
    const stored: LocalDraft = {
      documentId: 'doc_seq_check' as DocumentId,
      sessionId: SESSION,
      sequence: 5,
      body: '未确认正文',
      baseRevision: encodeRevision(1),
      confirmedRevision: null,
      updatedAt: FIXED_ISO,
    }

    // 无记录 → new
    expect(okValue(checkDraftSequence(6, null, REQUEST))).toEqual({ state: 'new', storedSequence: null })
    // 更高的序号 → new
    expect(okValue(checkDraftSequence(6, stored, REQUEST))).toEqual({ state: 'new', storedSequence: 5 })
    // 同序号未确认 → pending-retry
    expect(okValue(checkDraftSequence(5, stored, REQUEST))).toEqual({
      state: 'pending-retry',
      storedSequence: 5,
    })
    // 同序号已确认 → confirmed-replay，savedAt 取确认时的时间戳
    expect(
      okValue(
        checkDraftSequence(5, { ...stored, confirmedRevision: encodeRevision(2) }, REQUEST),
      ),
    ).toEqual({
      state: 'confirmed-replay',
      storedSequence: 5,
      confirmedRevision: encodeRevision(2),
      savedAt: FIXED_ISO,
    })
    // 空串的 confirmed_revision 不是 revision → 仍按未确认处理
    expect(
      okValue(checkDraftSequence(5, { ...stored, confirmedRevision: '' as Revision }, REQUEST)),
    ).toEqual({ state: 'pending-retry', storedSequence: 5 })
    // 更小序号 → 拒绝（迟到保存不得覆盖新稿）
    const stale = errPayload(checkDraftSequence(4, stored, REQUEST))
    expect(stale.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(stale.detail).toEqual({ draftSequence: 4, storedSequence: 5 })
    // 非安全整数 → 拒绝，且 detail 里不回传 NaN/Infinity
    expect(errPayload(checkDraftSequence(Number.NaN, stored, REQUEST)).detail).toEqual({
      draftSequence: null,
    })
    expect(errPayload(checkDraftSequence(-1, stored, REQUEST)).code).toBe('VALIDATION_OUT_OF_RANGE')
  })
})
