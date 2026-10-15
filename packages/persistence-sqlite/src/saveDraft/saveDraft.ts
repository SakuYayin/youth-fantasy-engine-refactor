/**
 * `saveDraft` —— 本地保存的**单一写事务**（P1-A2）。
 *
 * 设计依据（权威文档，逐字为凭；实现不得偏离）：
 * - `06-数据与本地存储.md`：「一次 SaveDraft 用例执行：校验主体和 ProjectContext →
 *   比较 expectedRevision → 写正文和 newRevision → 写版本记录 → 写 operation 与 outbox →
 *   提交 → 返回本地保存成功。发布 UI 事件在事务提交后进行。**写入失败不能消耗 outbox，
 *   也不能提前显示成功。**」
 * - 同文：「一次跨实体改动使用同一 batchId，在一个本地事务提交；**网络传输不在事务内等待**。」
 * - `02-桌面与界面.md`：「保存结果**只确认对应草稿序号**，迟到结果不得覆盖新稿。」
 *
 * 🔴 六条不可动摇的约束：
 * 1. **顺序不可换**。`revisions` / `operations` / `outbox` 的插入都在 `documents` 更新**之后**，
 *    且全部在同一个事务里。中止点无论落在哪一步，库内要么全是旧值、要么全是新值。
 * 2. **乐观锁是 CAS，不是先读后写**。`UPDATE ... WHERE id = ? AND revision = ?`，
 *    `changes !== 1` 即 `REVISION_CONFLICT`。先 `SELECT` 判断再无条件 `UPDATE`，
 *    在「同一个库有两个写连接」的现实里必然产生丢失更新。
 * 3. **新 revision 序号 = 实体行自己的 `revision_seq + 1`**（Lead 架构裁决）。
 *    绝不用 `SELECT COUNT(*) FROM revisions`：修订历史会被保留期/GC 裁剪，`COUNT` 会**倒退**，
 *    导致同一个 revision 字符串被重复使用，破坏 outbox 幂等与 baseRevision 校验——
 *    这是**静默数据损坏**，不是风格问题。
 * 4. **事务内不等待网络**。事务体里只有 SQLite 语句与纯计算；任何网络/文件 IO 都在事务外。
 * 5. **提交之后才构造成功结果**。事务回调返回的是内部记录，`{ ok: true, value }` 在
 *    `tx.immediate()` 正常返回之后才组装——否则"提交失败但对象已建好"会被上层误判为成功。
 * 6. **草稿水位线与正文同事务**。「确认后不删行、只清 body 并写 confirmed_revision」与
 *    「写新草稿必须把 confirmed_revision 置 NULL」都在 {@link ./drafts.js} 里，语义见该文件。
 *
 * 🔴 事务类型用 `immediate()`（BEGIN IMMEDIATE）而不是默认的 deferred：
 *    deferred 事务在第一条**写**语句才升级取锁，升级失败时已经读过数据，
 *    在忙等超时后以 `SQLITE_BUSY` 失败；immediate 一开始就取写锁，
 *    把"库被占用"暴露在第一句，失败语义干净（映射为 `STORAGE_UNAVAILABLE`）。
 */

import {
  ContractError,
  newRevision,
  errOf,
  isWellFormedId,
  newIds,
  ok,
  systemClock,
  toErrorPayload,
  type Clock,
  type DocumentId,
  type RequestId,
  type Result,
  type Revision,
  type SaveDraftInput,
  type SaveDraftOutput,
  type UtcTimestamp,
} from '@yfe/contracts'
import { countChars } from '@yfe/domain/text'

import {
  assertSchemaAcceptsWrites,
  sqliteErrorPayload,
  type SqliteDatabase,
} from '../schema/index.js'
import {
  checkDraftSequence,
  confirmLocalDraft,
  putPendingDraft,
  readLocalDraft,
  type DraftSequenceCheck,
} from './drafts.js'

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

/**
 * 新 revision 字符串的生成器。
 *
 * 形状由 Lead 定为 `{ next(seq) }`：序号是输入，字符串是输出，
 * 这样"序号从哪里来"（实体行的 `revision_seq`）与"字符串怎么编码"解耦。
 * 默认实现用 `@yfe/contracts` 的 {@link newRevision}，避免离线副本的同序号碰撞。
 */
export interface RevisionGenerator {
  next(seq: number): Revision
}

/**
 * ID 生成器。
 *
 * 🔴 不在这里直取 `crypto.randomUUID()`：ID 必须可注入，测试要用确定性源复现
 *    「同一 draftSequence 重放」与「两次连续保存」的字节级差异。
 *
 * ⚠️ 契约缺口（已上报 Lead，不要自行改 contracts）：`newIds` 工厂里**没有** revision 行 ID、
 *    operation opId、batchId 的专用工厂，它们的类型在契约里是裸 `string`。
 *    默认实现只能借用 `newIds.request()` 的形态。
 */
export interface IdGenerator {
  /** `revisions.id`（主键）。 */
  revisionRow(): string
  /** `operations.op_id` / `outbox.op_id`（两表同值，外键指向 operations）。 */
  operation(): string
  /** `operations.batch_id`：一次跨实体改动共享一个批次 ID。 */
  batch(): string
}

/** `saveDraft` 的全部外部依赖。**必须由调用方传入**，包内不持有可变全局。 */
export interface SaveDraftDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly revisionGenerator: RevisionGenerator
}

/** 基于 `@yfe/contracts` 的默认实现：时钟用 `systemClock`，revision 用 `newRevision`。 */
export const defaultSaveDraftDeps: SaveDraftDeps = {
  clock: systemClock,
  ids: {
    revisionRow: () => newIds.request(),
    operation: () => newIds.request(),
    batch: () => newIds.request(),
  },
  revisionGenerator: { next: newRevision },
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * `operations.entity_type` / `revisions.entity_type` 里文档实体的取值。
 *
 * ⚠️ 契约缺口：`RevisionRecord.entityType` / `SyncOperation.entityType` 都是裸 `string`，
 *    没有权威枚举常量，也没有 `isEntityType()` 校验。同步两端一旦拼写漂移就是
 *    "操作被静默丢弃"。这里先固定为 `'document'` 并导出，供 Repository/同步层复用。
 */
export const DOCUMENT_ENTITY_TYPE = 'document'

/** 本地模式下的同步目标 ID（`outbox.target_id`）。多设备时由同步引擎替换为真实目标。 */
export const LOCAL_SYNC_TARGET_ID = 'local'

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

/** `documents` 行里与保存相关的列。**不含 body**：正文由入参提供，不从这里读。 */
interface DocumentRow {
  readonly id: string
  readonly workspace_id: string
  readonly project_id: string
  readonly revision: string
  readonly revision_seq: number
  readonly deleted: number
}

/**
 * 事务已提交后**才**允许构造成功结果的内部记录。
 *
 * 刻意不是 {@link SaveDraftOutput}：`SaveDraftOutput` 只在 `tx.immediate()` 正常返回后组装，
 * 让"事务提交"与"对外宣称成功"在类型上就隔开一层。
 */
interface CommittedSave {
  readonly revision: Revision
  readonly draftSequence: number
  readonly savedAt: UtcTimestamp
}

/** 判定异常是否来自 SQLite 驱动（`SqliteError.code` 形如 `SQLITE_CONSTRAINT_UNIQUE`）。 */
function isSqliteError(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null) return false
  const code = (thrown as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_')
}

// ---------------------------------------------------------------------------
// 主用例
// ---------------------------------------------------------------------------

/**
 * 保存一次草稿。**纯本地写事务**，不触发同步、不发事件。
 *
 * 成功返回新 revision；失败返回契约错误码：
 * - `VALIDATION_*`：入参形状/序号非法（不碰库）；
 * - `NOT_FOUND_DOCUMENT`：文档不存在或**已软删**（软删文档一律不可写入）；
 * - `PERMISSION_WORKSPACE_MISMATCH`：`context.workspaceId` / `context.projectId` 与库内行不符
 *   （**只信库内归属，不信 payload 自报**）；
 * - `REVISION_CONFLICT`：`expectedRevision` 过期，或 CAS 未命中；
 * - `VALIDATION_OUT_OF_RANGE`：`draftSequence` **早于**水位线（迟到保存，拒绝回写旧正文）；
 * - `STORAGE_*`：磁盘满/只读/损坏/被占用等驱动错误，由 `sqliteErrorPayload` 翻译。
 *
 * @param db 写连接。**必须由 DB 执行器独占持有**，本函数不打开也不关闭连接。
 * @param input 契约的 {@link SaveDraftInput}。`body` 视为**已归一化**（`@yfe/domain` 的归一化在边界层做）。
 * @param deps 时钟 / ID / revision 生成器，全部由调用方注入。
 */
export function saveDraft(
  db: SqliteDatabase,
  input: SaveDraftInput,
  deps: SaveDraftDeps,
): Result<SaveDraftOutput> {
  const { context, documentId, draftSequence, body, sessionId } = input
  const requestId: RequestId = context.requestId

  // --- 入参校验（事务外，纯函数） ----------------------------------------
  if (!isWellFormedId(documentId)) {
    return errOf('VALIDATION_MALFORMED_ID', '文档 ID 格式不合法', requestId)
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return errOf('VALIDATION_MISSING_FIELD', 'sessionId 不能为空', requestId, { field: 'sessionId' })
  }
  if (typeof body !== 'string') {
    return errOf('VALIDATION_FAILED', '草稿正文必须是字符串', requestId, { field: 'body' })
  }
  if (!Number.isSafeInteger(draftSequence) || draftSequence < 0) {
    return errOf(
      'VALIDATION_OUT_OF_RANGE',
      `草稿序号必须是 >=0 的安全整数，收到 ${String(draftSequence)}`,
      requestId,
      { field: 'draftSequence' },
    )
  }

  // 🔴 字数在事务**外**算：`countChars` 走 `Intl.Segmenter`，是纯 CPU 但可能很贵
  //    （长章节几十万字符）。把它放进写事务会拉长持锁时间，直接违反"保存 P95 ≤1 秒"。
  //    契约要求"每次重算不读缓存"，所以重放路径同样重算，而不是回查历史。
  const charCount = countChars(body)

  const save = (): Result<CommittedSave> => {
    // ---- 1. 主体与 ProjectContext 校验 ---------------------------------
    const row = db
      .prepare(
        `SELECT id, workspace_id, project_id, revision, revision_seq, deleted
           FROM documents WHERE id = ?`,
      )
      .get(documentId) as DocumentRow | undefined

    if (row === undefined) {
      return errOf('NOT_FOUND_DOCUMENT', '文档不存在', requestId, { field: 'documentId' })
    }
    // 跨工作区：库内归属是唯一真值。
    if (row.workspace_id !== context.workspaceId) {
      return errOf('PERMISSION_WORKSPACE_MISMATCH', '该文档不属于当前工作区', requestId, {
        field: 'workspaceId',
      })
    }
    // 软删文档：`deleted` 类型是 `0 | number`，必须与 0 **比较**而非当布尔用（否则 -1 也被当"已删"）。
    if (row.deleted !== 0) {
      return errOf('NOT_FOUND_DOCUMENT', '文档已删除，无法保存', requestId, {
        field: 'documentId',
        deleted: row.deleted,
      })
    }
    // `context.projectId === null` 表示宿主未限定作品范围；一旦声明就必须与库内一致。
    if (context.projectId !== null && context.projectId !== row.project_id) {
      return errOf('PERMISSION_WORKSPACE_MISMATCH', '该文档不属于 context 声明的作品', requestId, {
        field: 'projectId',
      })
    }

    // ---- 2. 草稿序号水位线（重放先于版本检查：原请求仍携带旧版本） -------
    const stored = readLocalDraft(db, documentId, sessionId)
    const check = checkDraftSequence(draftSequence, stored, requestId)
    if (!check.ok) return check // 更小序号：迟到保存，直接拒绝
    const verdict: DraftSequenceCheck = check.value

    if (verdict.state === 'confirmed-replay') {
      // 序号标识同一份稿子，不允许换正文后误报已保存。历史被裁剪时仍可用
      // 当前实体或待同步 operation 还原原稿；无法还原则拒绝猜测。
      const revision = db.prepare(
        `SELECT body_snapshot AS body FROM revisions
          WHERE entity_type = ? AND entity_id = ? AND revision = ?`,
      ).get(DOCUMENT_ENTITY_TYPE, documentId, verdict.confirmedRevision) as { body: string | null } | undefined
      let confirmedBody = revision?.body
      if (typeof confirmedBody !== 'string' && row.revision === verdict.confirmedRevision) {
        confirmedBody = (db.prepare('SELECT body FROM documents WHERE id = ?').get(documentId) as { body: string }).body
      }
      if (typeof confirmedBody !== 'string') {
        const operation = db.prepare(
          `SELECT json_extract(payload_json, '$.body') AS body FROM operations
            WHERE entity_type = ? AND entity_id = ? AND new_revision = ?`,
        ).get(DOCUMENT_ENTITY_TYPE, documentId, verdict.confirmedRevision) as { body: unknown } | undefined
        if (typeof operation?.body === 'string') confirmedBody = operation.body
      }
      if (typeof confirmedBody !== 'string') {
        return errOf('STORAGE_CORRUPT', '已确认草稿缺少可核对的原始正文，无法安全重放', requestId)
      }
      if (confirmedBody !== body) {
        return errOf('IDEMPOTENCY_KEY_REUSED', '同一草稿序号不能用于不同正文，请推进草稿序号后重试', requestId,
          { field: 'draftSequence', draftSequence })
      }
      // 幂等重放：**不写任何行**（否则同一次编辑会产生第二条 operation）。
      // savedAt 取确认时写入的时间戳，保证同序号重放返回字节一致的结果。
      return ok({
        revision: verdict.confirmedRevision,
        draftSequence: verdict.storedSequence,
        savedAt: verdict.savedAt,
      })
    }

    // ---- 3. 新写入才比较 expectedRevision ------------------------------
    if (context.expectedRevision !== null && context.expectedRevision !== row.revision) {
      return errOf('REVISION_CONFLICT', '文档已被其他改动推进，请基于最新版本重试', requestId,
        { expectedRevision: context.expectedRevision, currentRevision: row.revision })
    }

    // ---- 4. 写正文与新 revision（乐观锁 CAS） ---------------------------
    const newSeq = row.revision_seq + 1
    const newRevision = deps.revisionGenerator.next(newSeq)
    if (typeof newRevision !== 'string' || newRevision.length === 0) {
      throw new ContractError({
        code: 'INTERNAL_ERROR',
        message: 'revision 生成器返回了空值，保存已中止',
        requestId,
      })
    }
    const savedAt = deps.clock.now()

    // base_revision 用**库内当前值**（row.revision），不是 payload 里的 expectedRevision：
    // 后者可能为 null（新实体约定），拿它当基线会让同步端失去冲突判定依据。
    const baseRevision = row.revision as Revision

    const info = db
      .prepare(
        `UPDATE documents
            SET body = ?, revision = ?, revision_seq = revision_seq + 1, updated_at = ?
          WHERE id = ? AND revision = ?`,
      )
      .run(body, newRevision, savedAt, documentId, row.revision)

    if (info.changes !== 1) {
      // 走到这里说明同一事务内读到的 revision 已不再是当前值——正常路径不可达，
      // 但保留这条判定：CAS 未命中必须报冲突，绝不能"当作成功"继续写历史。
      return errOf('REVISION_CONFLICT', '文档已被其他改动推进，请基于最新版本重试', requestId, {
        expectedRevision: row.revision,
      })
    }

    // ---- 5. 写版本记录（revisions） ------------------------------------
    // `seq` 与 `documents.revision_seq` 是**同一个整数**；UNIQUE (entity_type, entity_id, seq)
    // 让"序号被重复使用"这种静默损坏在写入时就直接失败。
    const opId = deps.ids.operation()
    const batchId = deps.ids.batch()
    db.prepare(
      `INSERT INTO revisions
         (id, workspace_id, entity_type, entity_id, revision, seq,
          base_revision, body_snapshot, values_snapshot, source_op_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      deps.ids.revisionRow(),
      row.workspace_id,
      DOCUMENT_ENTITY_TYPE,
      documentId,
      newRevision,
      newSeq,
      baseRevision,
      body,
      opId,
      savedAt,
    )

    // ---- 6. 写 operation 与 outbox -------------------------------------
    // 🔴 先 operations 再 outbox：outbox.op_id 有外键指向 operations(op_id)。
    // 🔴 任一句失败都会让整个事务回滚，因此"写入失败不消耗 outbox"是结构性成立的，
    //    不依赖调用方补偿。
    // payload 存正文：同步对端只能靠它应用变更（见 07-同步协议与API.md 的操作示例
    // `"payload": { "title": "第一章", "body": "正文" }`）。正文另在 body_snapshot 存一份，
    // 磁盘成本翻倍的问题已作为契约缺口上报。
    db.prepare(
      `INSERT INTO operations
         (op_id, batch_id, workspace_id, entity_type, entity_id, project_id,
          base_revision, new_revision, action, payload_json, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upsert', ?, NULL, ?)`,
    ).run(
      opId,
      batchId,
      row.workspace_id,
      DOCUMENT_ENTITY_TYPE,
      documentId,
      row.project_id,
      baseRevision,
      newRevision,
      JSON.stringify({ body, charCount }),
      savedAt,
    )

    db.prepare(
      `INSERT INTO outbox
         (op_id, workspace_id, batch_id, target_id, attempt_count, next_attempt_at, last_error_code, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)`,
    ).run(opId, row.workspace_id, batchId, LOCAL_SYNC_TARGET_ID, savedAt)

    // ---- 7. 草稿水位线随正文一起落库 -----------------------------------
    // 先写"未确认"（confirmed_revision 置 NULL），再确认。
    // 若崩溃发生在两句话之间，水位线停在"同序号未确认"，重试会走 pending-retry 重走保存——
    // 安全方向是"多写一次可重放的保存"，而不是"把新正文误判成已确认而丢掉"。
    putPendingDraft(db, {
      documentId,
      sessionId,
      sequence: draftSequence,
      body,
      baseRevision,
      updatedAt: savedAt,
    })
    const confirmed = confirmLocalDraft(db, {
      documentId,
      sessionId,
      sequence: draftSequence,
      baseRevision,
      confirmedRevision: newRevision,
      updatedAt: savedAt,
    })
    if (!confirmed) {
      // 水位线已被更高的序号占据：本次保存的正文已经写进 documents/revisions，
      // 但"这个序号已确认"这件事无法成立，必须失败重来，不能给 UI 一个假确认。
      return errOf(
        'STATE_INVALID_TRANSITION',
        '草稿水位线已被更新的编号推进，本次保存未确认',
        requestId,
        { draftSequence, storedSequence: readLocalDraft(db, documentId, sessionId)?.sequence ?? null },
      )
    }

    // 注意：这里返回的**不是** SaveDraftOutput，成功结果在提交之后组装。
    return ok({ revision: newRevision, draftSequence, savedAt })
  }
  const run = db.transaction(() => {
    const result = save()
    if (!result.ok) throw new ContractError(result.error)
    return result
  })

  let committed: Result<CommittedSave>
  try {
    // 写入前的版本闸门（`migrator.assertSchemaAcceptsWrites`）：
    // 库结构版本高于程序支持版本时抛 STORAGE_SCHEMA_TOO_NEW（critical，不可重试）。
    // 缺了这道检查，旧程序会拿新结构去写——静默破坏数据，且损坏是延迟发现的。
    assertSchemaAcceptsWrites(db, { requestId })
    // BEGIN IMMEDIATE：事务体抛出即整体回滚（SQLite 的 DDL/DML 都是事务性的）。
    committed = run.immediate()
  } catch (thrown) {
    if (thrown instanceof ContractError) return { ok: false, error: thrown.toPayload() }
    if (isSqliteError(thrown)) return { ok: false, error: sqliteErrorPayload(thrown, requestId) }
    // 注入依赖（时钟/ID 生成器）抛错也走这里：事务已回滚，绝不能对外宣称成功。
    return { ok: false, error: toErrorPayload(thrown, requestId, '保存草稿失败') }
  }

  if (!committed.ok) return committed

  // ---- 8. 提交之后才构造成功结果 --------------------------------------
  // 发布 UI 事件（若有）必须发生在这个 return **之后**，由调用方在事务外做。
  return ok({
    revision: committed.value.revision,
    draftSequence: committed.value.draftSequence,
    charCount,
    savedAt: committed.value.savedAt,
  })
}

/**
 * 语义化别名：`saveDraft` 是全项目唯一的本地保存入口。
 *
 * 保留两个名字是为了让调用点读起来像设计文档的语言（`saveDraft` 是契约里的用例名）。
 */
export const saveDraftUseCase = saveDraft
