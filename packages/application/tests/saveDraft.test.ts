/**
 * 用例 `saveDraft` 的行为测试（内存 fake，不开数据库）。
 *
 * 覆盖任务要求的 5 条中的 1/2/3/5：
 * 1. 成功路径 + `expectedRevision` 过期 → 冲突错误透传；
 * 2. 跨 project 的 payload 被拒（不信任客户端自报）；
 * 3. 端口抛异常时不泄漏堆栈；
 * 5. 幂等：同一 `idempotencyKey` 重复调用返回同一结果且端口只被调用一次。
 */

import {
  ContractError,
  encodeRevision,
  errOf,
  fixedClock,
  type IdempotencyKey,
  type ProjectId,
  type RequestId,
  type SaveDraftInput,
  type WorkspaceId,
} from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { createMemoryIdempotencyLedger } from '../src/idempotency.js'
import { PROJECT_MISMATCH_MESSAGE, REVISION_CONFLICT_MESSAGE, saveDraft } from '../src/useCases/saveDraft.js'
import { createFakeHarness, makeDocument, TEST_NOW, TEST_PROJECT, TEST_WORKSPACE } from './fakes.js'

const REQ = 'req-1' as RequestId

interface InputPatch {
  readonly context?: Partial<SaveDraftInput['context']>
  readonly documentId?: string
  readonly draftSequence?: number
  readonly body?: string
  readonly sessionId?: string
}

function draftInput(patch: InputPatch = {}): SaveDraftInput {
  const { context: contextPatch, ...rest } = patch
  return {
    context: {
      requestId: REQ,
      workspaceId: TEST_WORKSPACE as WorkspaceId,
      projectId: TEST_PROJECT as ProjectId,
      expectedRevision: null,
      ...contextPatch,
    },
    documentId: 'doc-1',
    draftSequence: 1,
    body: '新稿',
    sessionId: 'sess-1',
    ...rest,
  } as unknown as SaveDraftInput
}

describe('saveDraft 成功路径', () => {
  it('提交成功：返回契约输出，时钟来自注入的 clock', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW) })
    harness.documents.set('doc-1', makeDocument())

    const result = await saveDraft(harness.deps, draftInput({ draftSequence: 1 }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.savedAt).toBe(TEST_NOW)
    expect(result.value.draftSequence).toBe(1)
    expect(result.value.charCount).toBe(2)
    expect(result.value.revision).toBe(encodeRevision(2))
    // 端口调用次数：读一次归属 + 提交一次
    expect(harness.counts.loadDocument).toBe(1)
    expect(harness.counts.commitDraft).toBe(1)
    // 用例不得把 payload 里的字段当成授权依据，也不得改写正文
    expect(harness.commits[0]?.input.body).toBe('新稿')
    expect(harness.commits[0]?.input.context.requestId).toBe(REQ)
  })

  it('expectedRevision 与库内一致时正常提交', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW) })
    harness.documents.set('doc-1', makeDocument({ revisionSeq: 2 }))

    const result = await saveDraft(
      harness.deps,
      draftInput({ context: { expectedRevision: encodeRevision(2) } }),
    )

    expect(result.ok).toBe(true)
    expect(harness.counts.commitDraft).toBe(1)
  })
})

describe('saveDraft 冲突与授权', () => {
  it('expectedRevision 过期：由事务端口判定后透传 REVISION_CONFLICT', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument({ revisionSeq: 2 }))

    const result = await saveDraft(
      harness.deps,
      draftInput({ context: { expectedRevision: encodeRevision(1) } }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('REVISION_CONFLICT')
    expect(result.error.message).toBe(REVISION_CONFLICT_MESSAGE)
    expect(result.error.detail?.expectedRevision).toBe(encodeRevision(1))
    expect(result.error.detail?.currentRevision).toBe(encodeRevision(2))
    expect(result.error.severity).toBe('info')
    expect(result.error.retryable).toBe(true)
    expect(harness.counts.commitDraft).toBe(1)
  })

  it('跨 project 的 payload 被拒：只信库内归属，不信 context 自报', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument({ projectId: TEST_PROJECT }))

    const result = await saveDraft(
      harness.deps,
      draftInput({ context: { projectId: 'prj-b' as ProjectId } }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(result.error.message).toBe(PROJECT_MISMATCH_MESSAGE)
    expect(result.error.detail?.field).toBe('projectId')
    expect(harness.counts.commitDraft).toBe(0)
  })

  it('context.projectId 为 null（未声明作品）时不比对作品归属', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW) })
    harness.documents.set('doc-1', makeDocument({ projectId: 'prj-other' }))

    const result = await saveDraft(harness.deps, draftInput({ context: { projectId: null } }))

    expect(result.ok).toBe(true)
  })

  it('库内工作区与 context 不符：PERMISSION_WORKSPACE_MISMATCH（field=workspaceId）', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument({ workspaceId: 'ws-other' }))

    const result = await saveDraft(harness.deps, draftInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(result.error.detail?.field).toBe('workspaceId')
    expect(harness.counts.commitDraft).toBe(0)
  })

  it('文档不存在 / 已软删：NOT_FOUND_DOCUMENT', async () => {
    const missing = createFakeHarness()
    const missingResult = await saveDraft(missing.deps, draftInput())
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.error.code).toBe('NOT_FOUND_DOCUMENT')

    const deleted = createFakeHarness()
    deleted.documents.set('doc-1', makeDocument({ deleted: -1 }))
    const deletedResult = await saveDraft(deleted.deps, draftInput())
    expect(deletedResult.ok).toBe(false)
    if (!deletedResult.ok) expect(deletedResult.error.code).toBe('NOT_FOUND_DOCUMENT')
  })
})

describe('saveDraft 失败不吞掉、不泄漏', () => {
  it('适配器抛 ContractError：保留契约错误码，剥离 cause 与堆栈', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument())
    harness.throwOn.commitDraft = new ContractError({
      code: 'STORAGE_DISK_FULL',
      message: '磁盘空间不足\n    at C:\\Users\\alice\\app\\node_modules\\better-sqlite3\\lib\\index.js:1:1',
      requestId: REQ,
      cause: 'SQLITE_FULL: C:\\Users\\alice\\yfe.db',
    })

    const result = await saveDraft(harness.deps, draftInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('STORAGE_DISK_FULL')
    expect(result.error.severity).toBe('critical')
    expect(result.error.message).toBe('磁盘空间不足')
    const json = JSON.stringify(result.error)
    expect(json).not.toContain('at C:')
    expect(json).not.toContain('stack')
    expect(json).not.toContain('cause')
    expect(json).not.toContain('alice')
  })

  it('端口抛普通异常：INTERNAL_ERROR + 兜底文案，且 JSON 里没有堆栈/本地路径', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument())
    const boom = new Error('SQLITE_CANTOPEN: unable to open database file C:\\Users\\alice\\yfe.db')
    boom.stack =
      'Error: SQLITE_CANTOPEN: unable to open database file C:\\Users\\alice\\yfe.db\n' +
      '    at C:\\Users\\alice\\app\\node_modules\\better-sqlite3\\lib\\index.js:1:1'
    harness.throwOn.loadDocument = boom

    const result = await saveDraft(harness.deps, draftInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
    expect(result.error.message).toBe('读取文档归属失败')
    const json = JSON.stringify(result.error)
    expect(json).not.toContain('at C:')
    expect(json).not.toContain('stack')
    expect(json).not.toContain('alice')
    expect(json).not.toContain('better-sqlite3')
    expect(json).not.toContain('SQLITE_CANTOPEN')
    expect(Object.keys(result.error).sort()).toEqual(
      ['code', 'message', 'requestId', 'retryable', 'severity'].sort(),
    )
  })

  it('端口返回 Err：原样透传，绝不翻译成 ok', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument())
    harness.commitOverride = () =>
      Promise.resolve(errOf('STATE_INVALID_TRANSITION', '当前状态不允许保存', REQ, { field: 'documentId' }))

    const result = await saveDraft(harness.deps, draftInput())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('STATE_INVALID_TRANSITION')
    expect(result.error.detail?.field).toBe('documentId')
    expect(harness.counts.commitDraft).toBe(1)
  })

  it('迟到的更小 draftSequence：端口判定后原样透传 VALIDATION_OUT_OF_RANGE', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW) })
    harness.documents.set('doc-1', makeDocument())
    harness.watermarks.set('doc-1', 5)

    const stale = await saveDraft(harness.deps, draftInput({ draftSequence: 3 }))

    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error.code).toBe('VALIDATION_OUT_OF_RANGE')
  })

  it('入参校验失败：ID 形状、空 sessionId、非字符串正文、负序号、缺 context', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument())

    const cases: ReadonlyArray<readonly [string, SaveDraftInput, string]> = [
      ['路径穿越形态的 documentId', draftInput({ documentId: '../etc/passwd' }), 'VALIDATION_MALFORMED_ID'],
      ['空 sessionId', draftInput({ sessionId: '' }), 'VALIDATION_MISSING_FIELD'],
      ['非字符串正文', draftInput({ body: 42 as unknown as string }), 'VALIDATION_FAILED'],
      ['负 draftSequence', draftInput({ draftSequence: -1 }), 'VALIDATION_OUT_OF_RANGE'],
      ['缺 context', { documentId: 'doc-1', draftSequence: 1, body: 'x', sessionId: 's' } as unknown as SaveDraftInput, 'VALIDATION_FAILED'],
      ['非对象入参', null as unknown as SaveDraftInput, 'VALIDATION_FAILED'],
    ]

    for (const [name, input, code] of cases) {
      const result = await saveDraft(harness.deps, input)
      expect(result.ok, name).toBe(false)
      if (result.ok) continue
      expect(result.error.code, name).toBe(code)
    }
    // 校验失败发生在打开任何写事务之前
    expect(harness.counts.commitDraft).toBe(0)
  })
})

describe('saveDraft 幂等', () => {
  it('成功回执丢失后，携带原 expectedRevision 重放仍返回首次结果', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), idempotency: ledger.port })
    harness.documents.set('doc-1', makeDocument())
    const input = draftInput({ context: { idempotencyKey: 'lost-response' as IdempotencyKey, expectedRevision: encodeRevision(1) } })
    const first = await saveDraft(harness.deps, input)
    expect(first.ok).toBe(true)
    expect(await saveDraft(harness.deps, input)).toEqual(first)
    expect(harness.counts.commitDraft).toBe(1)
    const reused = await saveDraft(harness.deps, { ...input, body: '完全不同的新正文' })
    expect(reused.ok).toBe(false)
    if (!reused.ok) expect(reused.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(harness.counts.commitDraft).toBe(1)
  })

  it('同一 idempotencyKey 重复调用：端口只提交一次，两次结果完全一致', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), idempotency: ledger.port })
    harness.documents.set('doc-1', makeDocument())
    const input = draftInput({ context: { idempotencyKey: 'key-1' as IdempotencyKey } })

    const first = await saveDraft(harness.deps, input)
    const second = await saveDraft(harness.deps, input)

    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    expect(harness.counts.commitDraft).toBe(1)
    expect(ledger.size()).toBe(1)
  })

  it('同一幂等键跨用例复用：IDEMPOTENCY_KEY_REUSED', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), idempotency: ledger.port })
    harness.documents.set('doc-1', makeDocument())
    await ledger.port.save({
      key: 'key-shared' as IdempotencyKey,
      scope: 'createProject',
      value: JSON.stringify({ projectId: 'prj-x', revision: encodeRevision(1) }),
    })

    const result = await saveDraft(
      harness.deps,
      draftInput({ context: { idempotencyKey: 'key-shared' as IdempotencyKey } }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(harness.counts.commitDraft).toBe(0)
  })

  it('幂等记录损坏：INTERNAL_ERROR，不猜原始结果', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), idempotency: ledger.port })
    harness.documents.set('doc-1', makeDocument())
    await ledger.port.save({
      key: 'key-broken' as IdempotencyKey,
      scope: 'saveDraft',
      value: 'not-json',
    })

    const result = await saveDraft(
      harness.deps,
      draftInput({ context: { idempotencyKey: 'key-broken' as IdempotencyKey } }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
    expect(harness.counts.commitDraft).toBe(0)
  })

  it('失败不缓存：同键重试仍会再次提交', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), idempotency: ledger.port })
    harness.documents.set('doc-1', makeDocument())
    const input = draftInput({ context: { idempotencyKey: 'key-retry' as IdempotencyKey } })

    harness.throwOn.commitDraft = new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '数据库被占用',
      requestId: REQ,
    })
    const failed = await saveDraft(harness.deps, input)
    expect(failed.ok).toBe(false)
    expect(ledger.size()).toBe(0)

    harness.throwOn.commitDraft = undefined
    const retried = await saveDraft(harness.deps, input)
    expect(retried.ok).toBe(true)
    expect(harness.counts.commitDraft).toBe(2)
  })
})
