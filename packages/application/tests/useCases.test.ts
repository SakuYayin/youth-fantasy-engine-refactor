/**
 * 其余四个用例的行为测试（内存 fake）：`createProject` / `createDocument` /
 * `getDocument` / `listDocumentTree`。
 *
 * 重点不是"happy path 能跑"，而是把三条架构约束钉成断言：
 * - 用例只经端口读写（调用次数可断言）；
 * - ID 与时钟来自注入，不由用例自己产生；
 * - 授权只用库内事实，`payload` 自报的归属一律不做依据。
 */

import {
  encodeRevision,
  fixedClock,
  type DocumentCreateInput,
  type DocumentId,
  type DocumentTreeInput,
  type DocumentGetInput,
  type IdempotencyKey,
  type ProjectCreateInput,
  type ProjectId,
  type RequestId,
  type ReadContext,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { createMemoryIdempotencyLedger } from '../src/idempotency.js'
import { createDocument } from '../src/useCases/createDocument.js'
import { createProject } from '../src/useCases/createProject.js'
import { getDocument } from '../src/useCases/getDocument.js'
import { listDocumentTree } from '../src/useCases/listDocumentTree.js'
import {
  createFakeHarness,
  makeDocument,
  sequentialIds,
  TEST_NOW,
  TEST_PROJECT,
  TEST_WORKSPACE,
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

function readContext(): ReadContext {
  return { requestId: REQ, workspaceId: TEST_WORKSPACE as WorkspaceId }
}

function projectInput(patch: Partial<ProjectCreateInput> & { name?: string } = {}): ProjectCreateInput {
  return { context: writeContext({ projectId: null }), name: '剑起少年时', ...patch } as ProjectCreateInput
}

function documentInput(
  patch: Partial<DocumentCreateInput> & { projectIdOverride?: unknown } = {},
): DocumentCreateInput {
  const { projectIdOverride, ...rest } = patch
  return {
    context: writeContext(),
    projectId: (projectIdOverride ?? TEST_PROJECT) as ProjectId,
    kind: 'chapter',
    parentId: null,
    title: '第一章',
    placement: { mode: 'end' },
    ...rest,
  } as unknown as DocumentCreateInput
}

function getInput(documentId: string): DocumentGetInput {
  return { context: readContext(), documentId: documentId as DocumentId }
}

function treeInput(projectId: string): DocumentTreeInput {
  return { context: readContext(), projectId: projectId as ProjectId }
}

describe('createProject', () => {
  it('成功：projectId 由注入的 ids 生成并回传 revision', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), ids: sequentialIds() })

    const result = await createProject(harness.deps, projectInput({ seedFirstChapter: true, templateId: 'tpl-basic' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.projectId).toBe('prj-0001')
    expect(result.value.revision).toBe(encodeRevision(1))
    expect(harness.counts.createProject).toBe(1)
    expect(harness.lastCreateProject?.occurredAt).toBe(TEST_NOW)
    expect(harness.lastCreateProject?.seedFirstChapter).toBe(true)
    expect(harness.lastCreateProject?.templateId).toBe('tpl-basic')
    expect(harness.lastCreateProject?.context.workspaceId).toBe(TEST_WORKSPACE)
  })

  it('入参校验：缺 name / 超长 name / 非法 workspaceId', async () => {
    const harness = createFakeHarness()

    const missing = await createProject(harness.deps, projectInput({ name: '' }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('VALIDATION_MISSING_FIELD')

    const tooLong = await createProject(harness.deps, projectInput({ name: 'x'.repeat(101) }))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.error.code).toBe('VALIDATION_OUT_OF_RANGE')

    const badWorkspace = await createProject(harness.deps, {
      context: writeContext({ workspaceId: 'ws..bad' as WorkspaceId, projectId: null }),
      name: 'ok',
    })
    expect(badWorkspace.ok).toBe(false)
    if (!badWorkspace.ok) expect(badWorkspace.error.code).toBe('VALIDATION_MALFORMED_ID')

    expect(harness.counts.createProject).toBe(0)
  })

  it('幂等：同一键重放不会建出第二个作品', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const ids = sequentialIds()
    const harness = createFakeHarness({
      clock: fixedClock(TEST_NOW),
      ids,
      idempotency: ledger.port,
    })
    const input = projectInput({ context: writeContext({ projectId: null, idempotencyKey: 'k-1' as IdempotencyKey }) })

    const first = await createProject(harness.deps, input)
    const second = await createProject(harness.deps, input)

    expect(second).toEqual(first)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.value.projectId).toBe('prj-0001')
    expect(harness.counts.createProject).toBe(1)
    expect(harness.projects.size).toBe(1)
    // 重放不得消耗 ID：下一个 ID 仍是 prj-0002
    expect(ids.project() as string).toBe('prj-0002')
  })
})

describe('createDocument', () => {
  it('成功：归属校验通过后建章，orderKey 由端口回传', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), ids: sequentialIds() })

    const result = await createDocument(harness.deps, documentInput())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.documentId).toBe('doc-0001')
    expect(result.value.orderKey).toBe('a1')
    expect(harness.counts.createDocument).toBe(1)
    expect(harness.documents.get('doc-0001')?.title).toBe('第一章')
  })

  it('payload 自报的作品与 context 不符：拒绝，且不调用端口', async () => {
    const harness = createFakeHarness()

    const result = await createDocument(harness.deps, documentInput({ projectIdOverride: 'prj-b' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(result.error.detail?.field).toBe('projectId')
    expect(harness.counts.createDocument).toBe(0)
  })

  it('placement 支持 after（引用相邻文档 ID，而非客户端算好的排序键）', async () => {
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), ids: sequentialIds() })
    harness.documents.set('doc-1', makeDocument({ documentId: 'doc-1' as DocumentId }))

    const result = await createDocument(
      harness.deps,
      documentInput({ placement: { mode: 'after', afterId: 'doc-1' as DocumentId } }),
    )

    expect(result.ok).toBe(true)
    expect(harness.lastCreateDocument?.placement).toEqual({ mode: 'after', afterId: 'doc-1' })
  })

  it('幂等：同键重放返回同一 documentId，且不消耗新 ID', async () => {
    const ledger = createMemoryIdempotencyLedger()
    const ids = sequentialIds()
    const harness = createFakeHarness({ clock: fixedClock(TEST_NOW), ids, idempotency: ledger.port })
    const input = documentInput({
      context: writeContext({ idempotencyKey: 'k-doc' as IdempotencyKey }),
    })

    const first = await createDocument(harness.deps, input)
    const second = await createDocument(harness.deps, input)

    expect(second).toEqual(first)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.value.documentId).toBe('doc-0001')
    expect(harness.counts.createDocument).toBe(1)
    expect(harness.documents.size).toBe(1)
    expect(ids.document() as string).toBe('doc-0002')
  })

  it('入参校验：非法 kind / 缺 title / afterId 形状非法', async () => {
    const harness = createFakeHarness()

    const badKind = await createDocument(harness.deps, documentInput({ kind: 'poem' as never }))
    expect(badKind.ok).toBe(false)
    if (!badKind.ok) expect(badKind.error.code).toBe('VALIDATION_FAILED')

    const noTitle = await createDocument(harness.deps, documentInput({ title: '' }))
    expect(noTitle.ok).toBe(false)
    if (!noTitle.ok) expect(noTitle.error.code).toBe('VALIDATION_MISSING_FIELD')

    const badPlacement = await createDocument(
      harness.deps,
      documentInput({ placement: { mode: 'after', afterId: '../x' as DocumentId } }),
    )
    expect(badPlacement.ok).toBe(false)
    if (!badPlacement.ok) expect(badPlacement.error.code).toBe('VALIDATION_MALFORMED_ID')

    expect(harness.counts.createDocument).toBe(0)
  })
})

describe('getDocument / listDocumentTree', () => {
  it('getDocument：成功返回摘要 + 正文', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument({ body: '正文第一段' }))

    const result = await getDocument(harness.deps, getInput('doc-1'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.body).toBe('正文第一段')
    expect(result.value.document.id).toBe('doc-1')
    expect(result.value.document.charCount).toBe(5)
    // 契约摘要刻意不含 workspaceId：工作区过滤必须发生在端口里
    expect('workspaceId' in result.value.document).toBe(false)
    expect(harness.counts.getDocument).toBe(1)
  })

  it('getDocument：不存在 / 非法 ID / 端口异常', async () => {
    const harness = createFakeHarness()

    const missing = await getDocument(harness.deps, getInput('doc-none'))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND_DOCUMENT')

    const malformed = await getDocument(harness.deps, getInput('..\\etc'))
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.code).toBe('VALIDATION_MALFORMED_ID')

    harness.throwOn.getDocument = new Error('boom C:\\Users\\alice\\yfe.db')
    const thrown = await getDocument(harness.deps, getInput('doc-1'))
    expect(thrown.ok).toBe(false)
    if (!thrown.ok) expect(thrown.error.code).toBe('INTERNAL_ERROR')
  })

  it('listDocumentTree：默认不含软删文档，includeDeleted 才返回', async () => {
    const harness = createFakeHarness()
    harness.documents.set('doc-1', makeDocument({ documentId: 'doc-1' as DocumentId, orderKey: 'a1' }))
    harness.documents.set(
      'doc-2',
      makeDocument({ documentId: 'doc-2' as DocumentId, deleted: -1, orderKey: 'a2' }),
    )
    harness.documents.set(
      'doc-3',
      makeDocument({ documentId: 'doc-3' as DocumentId, projectId: 'prj-other', orderKey: 'a1' }),
    )

    const visible = await listDocumentTree(harness.deps, treeInput(TEST_PROJECT))
    expect(visible.ok).toBe(true)
    if (!visible.ok) return
    expect(visible.value.documents.map((d) => d.id)).toEqual(['doc-1'])
    expect(harness.lastListTree?.includeDeleted).toBe(false)

    const withDeleted = await listDocumentTree(harness.deps, {
      ...treeInput(TEST_PROJECT),
      includeDeleted: true,
    })
    expect(withDeleted.ok).toBe(true)
    if (!withDeleted.ok) return
    expect(withDeleted.value.documents.map((d) => d.id)).toEqual(['doc-1', 'doc-2'])
  })

  it('listDocumentTree：端口返回非数组时归一为 INTERNAL_ERROR', async () => {
    const harness = createFakeHarness()
    harness.throwOn.listDocumentTree = undefined
    // 适配器不守契约时不能让 undefined 漏给渲染层
    harness.ports.documents.listDocumentTree = () => Promise.resolve({ ok: true, value: null } as never)

    const result = await listDocumentTree(harness.deps, treeInput(TEST_PROJECT))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
  })
})
