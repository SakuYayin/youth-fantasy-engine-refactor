/**
 * `local_drafts` —— **草稿序号水位线**（保存事务的幂等与迟到回包防线）。
 *
 * 设计依据（逐字引用权威文档，勿凭印象改语义）：
 * - `06-数据与本地存储.md`：「local_drafts 用于**确认前恢复**；编辑器序号与数据库修订
 *   分别表达 UI 和持久状态。**已确认更高草稿序号后，旧回执只可被忽略，不能回写旧正文**。
 *   切章等待冲刷或保留待恢复状态，不静默丢草稿。」
 * - `02-桌面与界面.md`：「保存结果**只确认对应草稿序号**，迟到结果不得覆盖新稿。」
 * - `src/schema/ddl.ts`（`local_drafts` 表上方的注释）：「每个 (document_id, session_id)
 *   **只有一行**，是'当前未确认草稿'的水位线，不保留历史行。确认后**不删行**，只写
 *   confirmed_revision 并清空 body——删行会让'同序号重试'被误判为新草稿，产生重复 operation。」
 *
 * 🔴 三条不可动摇的约束（每一条都对应一次静默数据丢失）：
 * 1. **确认后不删行**。删掉水位线，客户端用同一序号重试就会被当成新草稿，
 *    再写一条 operation/revision——同一次编辑在网络层变成两次变更。
 * 2. **写新草稿必须把 `confirmed_revision` 置 NULL**。否则新序号的新正文会被
 *    第 3 条规则误判成"幂等重放"，直接返回旧 revision 并把**新正文丢掉**。
 * 3. **更小的序号必须拒绝**（{@link checkDraftSequence} 的 `stale` 分支）。
 *    这正是"迟到保存结果不得覆盖新稿"在写侧的落点。
 *
 * ⚠️ 本模块的函数**不自己开事务**：它们只发单条语句，必须由 `saveDraft` 的写事务调用，
 *    与正文、revisions、operations、outbox 同生共死。单独调用会破坏原子性。
 *
 * 序号（UI 维度）与 revision（持久化维度）是**两套独立状态**：
 * `sequence` 由编辑器单调递增，`confirmed_revision` 是它被确认时对应的库内修订。
 * 永远不要用其中一个推导另一个。
 */

import {
  errOf,
  newIds,
  ok,
  type DocumentId,
  type LocalDraft,
  type RequestId,
  type Result,
  type Revision,
  type UtcTimestamp,
} from '@yfe/contracts'

import type { SqliteDatabase } from '../schema/index.js'

// ---------------------------------------------------------------------------
// 序号判定（纯函数，零依赖，可独立穷举测试）
// ---------------------------------------------------------------------------

/**
 * 水位线判定的三种**可继续**状态。
 *
 * `stale`（更小序号）刻意不在这个联合里：它是**拒绝**，由 {@link checkDraftSequence}
 * 以 `Err` 表达，避免调用方"顺手把 stale 也当成一种正常状态"继续往下写。
 */
export type DraftSequenceCheck =
  | {
      /** 没有水位线，或入参序号更高：正常写入。 */
      readonly state: 'new'
      /** 已记录的水位线（没有记录时为 `null`），仅供诊断与日志。 */
      readonly storedSequence: number | null
    }
  | {
      /** 同一序号但**尚未确认**：上一次尝试没走完（崩溃/失败/迟到），按原样重走。 */
      readonly state: 'pending-retry'
      readonly storedSequence: number
    }
  | {
      /** 同一序号且**已确认**：幂等重放，直接返回当时确认的 revision，不再写库。 */
      readonly state: 'confirmed-replay'
      readonly storedSequence: number
      readonly confirmedRevision: Revision
      /** 当时确认时写入的时间戳：重放要返回与首次**完全相同**的 savedAt。 */
      readonly savedAt: UtcTimestamp
    }

/**
 * 判定入参草稿序号与水位的相对关系。**纯函数**：不读库、不写库、不看时间。
 *
 * 判定矩阵（`stored` 为 `(documentId, sessionId)` 上的唯一一行）：
 *
 * | 情况 | 结果 |
 * | --- | --- |
 * | 无记录 | `new` |
 * | 入参 > 水位线 | `new`（编辑器推进到下一篇草稿） |
 * | 入参 == 水位线 且 confirmed_revision 非空 | `confirmed-replay`（返回旧 revision，不写库） |
 * | 入参 == 水位线 且 未确认 | `pending-retry`（重走保存） |
 * | 入参 <  水位线 | `Err(VALIDATION_OUT_OF_RANGE)` —— **拒绝**，迟到保存不得回写旧正文 |
 *
 * `confirmed_revision` 为空串也按"未确认"处理：`DDL` 允许空串落库（列可空且无 CHECK），
 * 但空串不是 revision，把它当已确认会返回一个空 revision 给 UI。
 *
 * @param incomingSequence 客户端本次携带的草稿序号（编辑器单调递增，允许不是连续整数）
 * @param stored 现存的 `local_drafts` 行；没有则传 `null`
 * @param requestId 贯通错误载荷；纯函数场景可省略
 */
export function checkDraftSequence(
  incomingSequence: number,
  stored: LocalDraft | null,
  requestId: RequestId = newIds.request(),
): Result<DraftSequenceCheck> {
  if (!Number.isSafeInteger(incomingSequence) || incomingSequence < 0) {
    return errOf(
      'VALIDATION_OUT_OF_RANGE',
      `草稿序号必须是 >=0 的安全整数，收到 ${String(incomingSequence)}`,
      requestId,
      // NaN/Infinity 不能进 detail（不可 JSON 序列化），退化成 null。
      { draftSequence: Number.isFinite(incomingSequence) ? incomingSequence : null },
    )
  }

  if (stored === null) {
    return ok({ state: 'new', storedSequence: null })
  }

  const storedSequence = stored.sequence

  if (incomingSequence < storedSequence) {
    return errOf(
      'VALIDATION_OUT_OF_RANGE',
      `草稿序号 ${incomingSequence} 早于已记录的水位线 ${storedSequence}，已拒绝：迟到的保存不能覆盖更新的草稿`,
      requestId,
      { draftSequence: incomingSequence, storedSequence },
    )
  }

  if (incomingSequence === storedSequence) {
    const confirmed = stored.confirmedRevision
    if (typeof confirmed === 'string' && confirmed.length > 0) {
      return ok({
        state: 'confirmed-replay',
        storedSequence,
        confirmedRevision: confirmed,
        // 确认时把同一个时间戳写进了 updated_at，所以重放能返回与首发一致的 savedAt。
        savedAt: stored.updatedAt,
      })
    }
    return ok({ state: 'pending-retry', storedSequence })
  }

  return ok({ state: 'new', storedSequence })
}

// ---------------------------------------------------------------------------
// 行读写（由 saveDraft 的写事务驱动）
// ---------------------------------------------------------------------------

/** `local_drafts` 的列清单，与 `ddl.ts` 里的定义一一对应（改名即破坏持久化格式）。 */
export const LOCAL_DRAFT_COLUMNS =
  'document_id, session_id, sequence, body, base_revision, confirmed_revision, updated_at'

interface LocalDraftRow {
  readonly document_id: string
  readonly session_id: string
  readonly sequence: number
  readonly body: string
  readonly base_revision: string | null
  readonly confirmed_revision: string | null
  readonly updated_at: string
}

function toLocalDraft(row: LocalDraftRow): LocalDraft {
  return {
    documentId: row.document_id as DocumentId,
    sessionId: row.session_id,
    sequence: row.sequence,
    body: row.body,
    baseRevision: (row.base_revision ?? null) as Revision | null,
    confirmedRevision: (row.confirmed_revision ?? null) as Revision | null,
    updatedAt: row.updated_at as UtcTimestamp,
  }
}

/** 读单个 (documentId, sessionId) 的水位线；没有记录返回 `null`。 */
export function readLocalDraft(
  db: SqliteDatabase,
  documentId: DocumentId,
  sessionId: string,
): LocalDraft | null {
  const row = db
    .prepare(
      `SELECT ${LOCAL_DRAFT_COLUMNS} FROM local_drafts WHERE document_id = ? AND session_id = ?`,
    )
    .get(documentId, sessionId) as LocalDraftRow | undefined
  return row ? toLocalDraft(row) : null
}

/**
 * 列出某个会话（或全部会话）的水位线行，最近更新的在前。
 *
 * 包含已确认的行：它们是"已确认到哪个序号"的水位线，删掉就会让迟到的重试变成新草稿。
 */
export function listLocalDrafts(db: SqliteDatabase, sessionId?: string): LocalDraft[] {
  const rows = (
    sessionId === undefined
      ? db
          .prepare(`SELECT ${LOCAL_DRAFT_COLUMNS} FROM local_drafts ORDER BY updated_at DESC`)
          .all()
      : db
          .prepare(
            `SELECT ${LOCAL_DRAFT_COLUMNS} FROM local_drafts WHERE session_id = ? ORDER BY updated_at DESC`,
          )
          .all(sessionId)
  ) as LocalDraftRow[]
  return rows.map(toLocalDraft)
}

/**
 * 列出**可恢复**的草稿（正文非空），用于启动/切章时的恢复提示。
 *
 * 已确认的行 body 已被清空，天然不会出现在这里——这正是"确认后只清 body 不删行"的收益：
 * 水位线还在，但恢复列表不会把已经保存过的内容再摆给用户。
 */
export function listRecoverableDrafts(db: SqliteDatabase, sessionId?: string): LocalDraft[] {
  const rows = (
    sessionId === undefined
      ? db
          .prepare(
            `SELECT ${LOCAL_DRAFT_COLUMNS} FROM local_drafts WHERE body <> '' ORDER BY updated_at DESC`,
          )
          .all()
      : db
          .prepare(
            `SELECT ${LOCAL_DRAFT_COLUMNS} FROM local_drafts WHERE session_id = ? AND body <> '' ORDER BY updated_at DESC`,
          )
          .all(sessionId)
  ) as LocalDraftRow[]
  return rows.map(toLocalDraft)
}

/**
 * 写入/覆盖**未确认**草稿。
 *
 * 🔴 入参刻意**不含** `confirmedRevision`：新草稿必须把 `confirmed_revision` 置回 NULL，
 *    让"已确认"这件事不可能被误继承。SQL 里也显式写 `NULL`（不依赖 excluded 传值），
 *    两道锁同时存在，防止后人"顺手改成 excluded.confirmed_revision"。
 */
export interface PendingDraftInput {
  readonly documentId: DocumentId
  readonly sessionId: string
  readonly sequence: number
  readonly body: string
  /** 本次保存尝试所基于的 revision（乐观锁基线），可能是 `null`（新实体）。 */
  readonly baseRevision: Revision | null
  readonly updatedAt: UtcTimestamp
}

export function putPendingDraft(db: SqliteDatabase, draft: PendingDraftInput): void {
  db.prepare(
    `INSERT INTO local_drafts (document_id, session_id, sequence, body, base_revision, confirmed_revision, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (document_id, session_id) DO UPDATE SET
       sequence           = excluded.sequence,
       body               = excluded.body,
       base_revision      = excluded.base_revision,
       confirmed_revision = NULL,
       updated_at         = excluded.updated_at`,
  ).run(
    draft.documentId,
    draft.sessionId,
    draft.sequence,
    draft.body,
    draft.baseRevision,
    draft.updatedAt,
  )
}

/** 确认一份草稿所需的全部信息。 */
export interface ConfirmedDraftInput {
  readonly documentId: DocumentId
  readonly sessionId: string
  /** 被确认的草稿序号。 */
  readonly sequence: number
  /** 本次保存**所基于**的 revision（保存前的库内修订），作为水位线的诊断信息保留。 */
  readonly baseRevision: Revision | null
  /** 本次保存产生的新 revision；它就是这个序号被确认的凭证。 */
  readonly confirmedRevision: Revision
  /** 与 `documents.updated_at`、`revisions.created_at` 等**必须同一个值**：重放返回的 savedAt 靠它做到与首发完全一致。 */
  readonly updatedAt: UtcTimestamp
}

/**
 * 确认草稿：**不删行**，只把 body 清空并把该序号钉在 `confirmed_revision` 上。
 *
 * 用 UPSERT 而不是"先 UPDATE 再补 INSERT"：确认必须能同时覆盖三种前置状态
 * （行不存在 = 首次保存；行存在且未确认 = 重走；行存在且序号更小 = 编辑器已推进），
 * 三条语句拼起来会在崩溃点之间留下"正文已写但水位线没动"的窗口。
 *
 * 🔴 `WHERE excluded.sequence >= local_drafts.sequence` 是回退守卫：
 *    如果水位线已经被一个**更高**的序号占据（例如另一次保存抢先提交），
 *    这次确认退化为 no-op，绝不把序号**往回转**——回退水位线会让下一个到达的
 *    中间序号被当成新草稿，等于把已确认的编辑重放一遍。
 *
 * @returns 是否真的推进了水位线。`false` 表示被更高序号挡下（调用方应视为并发异常并复核）
 */
export function confirmLocalDraft(db: SqliteDatabase, input: ConfirmedDraftInput): boolean {
  const info = db
    .prepare(
      `INSERT INTO local_drafts (document_id, session_id, sequence, body, base_revision, confirmed_revision, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?)
       ON CONFLICT (document_id, session_id) DO UPDATE SET
         sequence           = excluded.sequence,
         body               = '',
         base_revision      = excluded.base_revision,
         confirmed_revision = excluded.confirmed_revision,
         updated_at         = excluded.updated_at
       WHERE excluded.sequence >= local_drafts.sequence`,
    )
    .run(
      input.documentId,
      input.sessionId,
      input.sequence,
      input.baseRevision,
      input.confirmedRevision,
      input.updatedAt,
    )
  return info.changes === 1
}

/** {@link discardLocalDraft} 的结果。 */
export type DraftDiscardOutcome =
  /** 未确认：整行删除（没有水位线要保留）。 */
  | 'deleted'
  /** 已确认：只清 body，水位线（序号 + confirmed_revision）保留。 */
  | 'cleared'
  /** 本来就没有这一行。 */
  | 'absent'

/**
 * 丢弃一份本地草稿（用户显式放弃未保存内容、或切章完成后的清理）。
 *
 * 🔴 分两种情形，不能一刀切删行：
 * - **未确认** → 删行。没有东西需要恢复，也没有已确认的序号线。
 * - **已确认** → 只清 body，保留序号与 `confirmed_revision`。这里留着水位线是因为
 *   客户端可能还在重试同一个序号：删了行，重试就会被判成新草稿并再写一条 operation。
 */
export function discardLocalDraft(
  db: SqliteDatabase,
  documentId: DocumentId,
  sessionId: string,
): DraftDiscardOutcome {
  const existing = readLocalDraft(db, documentId, sessionId)
  if (existing === null) return 'absent'

  const confirmed = existing.confirmedRevision
  if (typeof confirmed === 'string' && confirmed.length > 0) {
    db.prepare(
      `UPDATE local_drafts SET body = '' WHERE document_id = ? AND session_id = ?`,
    ).run(documentId, sessionId)
    return 'cleared'
  }

  db.prepare(`DELETE FROM local_drafts WHERE document_id = ? AND session_id = ?`).run(
    documentId,
    sessionId,
  )
  return 'deleted'
}
