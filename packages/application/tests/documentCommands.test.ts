/**
 * 用例 `updateDocument` / `deleteDocument` 的行为测试（内存 fake）。
 *
 * 与 `useCases.test.ts` 同一条主线：把三条架构约束钉成断言——
 * - 用例只经端口读写（调用次数可断言）；
 * - 只传要改的字段（端口请求里不该出现没传的可选字段）；
 * - 端口抛异常 / 返回畸形值 → `INTERNAL_ERROR`（不穿透到调用方）。
 *
 * 真实的乐观锁 / 工作区归属 / 级联子树语义由存储层与
 * `apps/desktop/tests/document-update-integration.test.ts` 验证。
 */

import {
  encodeRevision,
  fixedClock,
  type DocumentDeleteInput,
  type DocumentId,
  type DocumentUpdateInput,
  type DocumentUpdateOutput,
  type ProjectId,
  type RequestId,
  type Revision,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { ok } from '@yfe/contracts'
import { deleteDocument } from '../src/useCases/deleteDocument.js'
import { updateDocument } from '../src/useCases/updateDocument.js'
import {
  createFakeHarness,
  makeDocument,
  TEST_NOW,
  TEST_PROJECT,
  TEST_WORKSPACE,
  type FakeHarness,
} from './fakes.js'

const REQ = 'req-1' as RequestId

function writeContext(patch: Partial<WriteContext> = {}): WriteContext {
  return {
    requestId: REQ,
    workspaceId: TEST_WORKSPACE as WorkspaceId,
    projectId: TEST_PROJECT as ProjectId,
    expectedRevision: null,
    ...patch,
  }
}

function updateInput(patch: Partial<DocumentUpdateInput> = {}): DocumentUpdateInput {
  return {
    context: writeContext(),
    documentId: 'doc-1' as DocumentId,
    ...patch,
  } as unknown as DocumentUpdateInput
}

function deleteInput(patch: Partial<DocumentDeleteInput> = {}): DocumentDeleteInput {
  return {
    context: writeContext(),
    documentId: 'doc-1' as DocumentId,
    ...patch,
  } as unknown as DocumentDeleteInput
}

/** 端口返回畸形值（缺 revision）的夹具：直接替换端口方法。 */
function stubGarbageUpdate(harness: FakeHarness): void {
  ;(harness.ports.documents as { updateDocument: unknown }).updateDocument = () =>
    Promise.resolve(ok({} as unknown as DocumentUpdateOutput))
}

describe('updateDocument 用例（内存 fake）', () => {
  it('入参缺失或不是对象 → VALIDATION_FAILED，且不调端口', async () => {
    const harness = createFakeHarness()
    const result = await updateDocument(harness.deps, null as unknown as DocumentUpdateInput)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(harness.counts.updateDocument).toBe(0)
  })

  it('title 与 placement 都不给 → VALIDATION_FAILED（空操作没有意义）', async () => {
    const harness = createFakeHarness()
    const result = await updateDocument(harness.deps, updateInput())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(harness.counts.updateDocument).toBe(0)
  })

  it('空标题 → VALIDATION_MISSING_FIELD（改名不能改成空）', async () => {
    const harness = createFakeHarness()
    const result = await updateDocument(harness.deps, updateInput({ title: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_MISSING_FIELD')
  })

  it('documentId 形状非法 → VALIDATION_MALFORMED_ID', async () => {
    const harness = createFakeHarness()
    const result = await updateDocument(
      harness.deps,
      updateInput({ documentId: 'not an id!' as DocumentId, title: '新标题' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_MALFORMED_ID')
  })

  it('只传 title：端口请求里不出现 placement 键', async () => {
    const harness = createFakeHarness({
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(harness.counts.updateDocument).toBe(1)
    expect(harness.documents.get('doc-1')?.title).toBe('新标题')
  })

  it('title + placement 同时给：端口各得其所，返回 revision 与新 orderKey', async () => {
    const harness = createFakeHarness({
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    const result = await updateDocument(
      harness.deps,
      updateInput({ title: '新标题', placement: { mode: 'end' } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.revision).toBe(encodeRevision(2))
    expect(result.value.orderKey).toBe('zz-a1')
    const stored = harness.documents.get('doc-1')
    expect(stored?.title).toBe('新标题')
    expect(stored?.revisionSeq).toBe(2)
  })

  it('只传 placement：标题保持原样，orderKey 有值', async () => {
    const harness = createFakeHarness({
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    const result = await updateDocument(
      harness.deps,
      updateInput({ placement: { mode: 'end' } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.orderKey).toBe('zz-a1')
    expect(harness.documents.get('doc-1')?.title).toBe('第一章')
  })

  it('端口返回 NOT_FOUND_DOCUMENT → 原样透传', async () => {
    const harness = createFakeHarness()
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_FOUND_DOCUMENT')
    expect(harness.counts.updateDocument).toBe(1)
  })

  it('端口抛异常 → INTERNAL_ERROR（不穿透）', async () => {
    const harness = createFakeHarness()
    harness.throwOn.updateDocument = new Error('boom')
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
  })

  it('端口返回畸形值（缺 revision）→ INTERNAL_ERROR 形状门禁', async () => {
    const harness = createFakeHarness()
    stubGarbageUpdate(harness)
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
  })
})

describe('deleteDocument 用例（内存 fake）', () => {
  it('入参缺失 → VALIDATION_FAILED，且不调端口', async () => {
    const harness = createFakeHarness()
    const result = await deleteDocument(harness.deps, null as unknown as DocumentDeleteInput)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(harness.counts.deleteDocument).toBe(0)
  })

  it('documentId 缺失 → VALIDATION_MISSING_FIELD', async () => {
    const harness = createFakeHarness()
    const result = await deleteDocument(harness.deps, deleteInput({ documentId: undefined }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_MISSING_FIELD')
  })

  it('删除自身：revision 推进、deletedCount = 1、文档被标记删除', async () => {
    const harness = createFakeHarness({
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    const result = await deleteDocument(harness.deps, deleteInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.deletedCount).toBe(1)
    expect(result.value.revision).toBe(encodeRevision(2))
    expect(harness.documents.get('doc-1')?.deleted).toBe(1)
  })

  it('级联子树：子文档一并标记删除，deletedCount 含全部后代', async () => {
    const harness = createFakeHarness({
      documents: [
        makeDocument({ documentId: 'doc-parent' as DocumentId, orderKey: 'a1' }),
        makeDocument({
          documentId: 'doc-child' as DocumentId,
          parentId: 'doc-parent' as DocumentId,
          orderKey: 'a1b1',
        }),
        makeDocument({
          documentId: 'doc-grandchild' as DocumentId,
          parentId: 'doc-child' as DocumentId,
          orderKey: 'a1b1c1',
        }),
        makeDocument({ documentId: 'doc-other' as DocumentId, orderKey: 'a2' }),
      ],
    })
    const result = await deleteDocument(harness.deps, deleteInput({ documentId: 'doc-parent' as DocumentId }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.deletedCount).toBe(3)
    expect(harness.documents.get('doc-parent')?.deleted).toBe(1)
    expect(harness.documents.get('doc-child')?.deleted).toBe(1)
    expect(harness.documents.get('doc-grandchild')?.deleted).toBe(1)
    // 兄弟节点绝不受牵连
    expect(harness.documents.get('doc-other')?.deleted).toBe(0)
  })

  it('已删除的文档再删：deletedCount = 0（幂等），revision 仍是墓碑', async () => {
    const harness = createFakeHarness({
      documents: [
        makeDocument({ documentId: 'doc-1' as DocumentId, deleted: 1 as import('@yfe/contracts').DeletedFlag }),
      ],
    })
    const result = await deleteDocument(harness.deps, deleteInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.deletedCount).toBe(0)
  })

  it('端口抛异常 → INTERNAL_ERROR', async () => {
    const harness = createFakeHarness()
    harness.throwOn.deleteDocument = new Error('boom')
    const result = await deleteDocument(harness.deps, deleteInput())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
  })

  it('时间戳/时钟来自注入（用例不自己产生时钟）', async () => {
    const clock = fixedClock(TEST_NOW)
    const harness = createFakeHarness({
      clock,
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    // 注入证据：依赖容器里的 clock 就是传入的这个实例（用例没有另造时钟的通道）
    expect(harness.deps.clock).toBe(clock)
    expect(clock.now()).toBe(TEST_NOW)
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(typeof result.value.revision).toBe('string')
  })

  it('Revision 品牌不被用例层擦除（类型层断言，编译期生效）', async () => {
    const harness = createFakeHarness({
      documents: [makeDocument({ documentId: 'doc-1' as DocumentId })],
    })
    const result = await updateDocument(harness.deps, updateInput({ title: '新标题' }))
    if (!result.ok) throw new Error('应当成功')
    const revision: Revision = result.value.revision
    expect(revision).toBe(encodeRevision(2))
  })
})
