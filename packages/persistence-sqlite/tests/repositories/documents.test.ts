/**
 * `documents.ts` 的 Repository 测试。
 *
 * 覆盖任务书要求的 4 条：
 * 1. 1000 章规模下 `listDocumentTree` 的每个元素**不含 `body`**（`Object.keys` 断言）+ 真实耗时；
 * 4. `createDocument` 的 `end` / `after` 两种 placement 生成的 `orderKey` 严格递增；
 * 5. `reorderDocument` 在中间插入 1000 次后顺序仍正确；
 * 6. 新建文档的 `revision` 非空且 === `encodeRevision(1)`（`revision_seq` 同步为 1）。
 */

import { afterAll, describe, expect, it } from 'vitest'

import { encodeRevision, type DocumentId } from '@yfe/contracts'
import { countChars } from '@yfe/domain/text'

import {
  createDocument,
  getDocument,
  listDocumentTree,
  reorderDocument,
  updateDocumentTitle,
  type DocumentPlacement,
} from '../../src/repositories/index.js'
import {
  CHAPTER_BODY,
  at,
  bulkSeedChapters,
  cleanupTempDirs,
  insertDocumentRowRaw,
  makeRepoDeps,
  openMigratedDatabase,
  readContext,
  readDocumentRow,
  seedProject,
  seedWorkspace,
  unwrap,
  writeContext,
  expectErrCode,
} from './helpers.js'

const db = openMigratedDatabase('documents')

afterAll(() => {
  cleanupTempDirs()
})

/** `DocumentSummary` 契约里恰好这 12 个键（**没有** body / workspaceId）。 */
const SUMMARY_KEYS = [
  'id',
  'projectId',
  'kind',
  'parentId',
  'orderKey',
  'title',
  'revision',
  'deleted',
  'createdAt',
  'updatedAt',
  'charCount',
  'hasChildren',
] as const

describe('listDocumentTree：1000 章规模', () => {
  it(
    '返回平铺摘要，每个元素用 Object.keys 断言都不含 body，并打印真实耗时',
    () => {
      const workspaceId = seedWorkspace(db, { id: 'ws_tree' })
      const projectId = seedProject(db, { workspaceId, id: 'prj_tree' })
      const deps = makeRepoDeps()

      // 夹具直接用 SQL 灌 1000 章：这条用例测的是**读取路径**的规模表现，
      // 用 createDocument 逐条建会变成 1000 次 BEGIN IMMEDIATE，测到的是写入而不是读取。
      const volumeKey = 'a0'
      const volumeId = insertDocumentRowRaw(db, {
        id: 'doc_tree_vol',
        workspaceId,
        projectId,
        kind: 'volume',
        parentId: null,
        orderKey: volumeKey,
        title: '第一卷',
        body: '',
      })
      const chapterIds = bulkSeedChapters(db, {
        workspaceId,
        projectId,
        parentId: volumeId,
        count: 1000,
        body: CHAPTER_BODY,
        startAfter: volumeKey,
      })
      expect(chapterIds.length).toBe(1000)

      const startedAt = performance.now()
      const result = listDocumentTree(db, { context: readContext(workspaceId), projectId })
      const elapsedMs = performance.now() - startedAt
      // 任务要求"打印真实耗时"：正文 700 字 × 1000 章（含逐篇 countChars）。
      console.log(
        `[task-7] listDocumentTree：1000 章 × ${CHAPTER_BODY.length} 字正文，真实耗时 ${elapsedMs.toFixed(1)} ms`,
      )

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(`listDocumentTree 失败：${result.error.code} ${result.error.message}`)
      const documents = result.value.documents
      expect(documents.length).toBe(1001)

      for (const summary of documents) {
        const keys = Object.keys(summary)
        expect(keys).not.toContain('body')
        expect(keys).not.toContain('workspaceId')
        expect('body' in summary).toBe(false)
        // 平铺：没有嵌套子节点字段
        expect('children' in summary).toBe(false)
        expect([...keys].sort()).toEqual([...SUMMARY_KEYS].sort())
      }

      // 顺序：卷在最前（键最小），其后是按 order_key 递增的 1000 章
      const first = at(documents, 0)
      expect(first.id).toBe('doc_tree_vol')
      expect(first.kind).toBe('volume')
      expect(first.hasChildren).toBe(true)
      expect(first.charCount).toBe(0)
      expect(at(documents, 1).id).toBe('doc_bulk_0001')
      expect(at(documents, documents.length - 1).id).toBe('doc_bulk_1000')
      expect(documents.filter((summary) => summary.hasChildren).length).toBe(1)

      // charCount 是现场按契约的 countChars（字素簇）算的，不是缓存字段
      const chapter = documents.find((summary) => summary.id === 'doc_bulk_0001')
      expect(chapter?.charCount).toBe(countChars(CHAPTER_BODY))
      expect(chapter?.hasChildren).toBe(false)

      console.log(
        `[task-7] 摘要键（共 ${Object.keys(first).length} 个）：${Object.keys(first).join(', ')}`,
      )
    },
    120_000,
  )
})

describe('createDocument：placement', () => {
  it('end / after 两种 placement 生成的 orderKey 严格递增，且树顺序正确', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_place' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_place' })
    const deps = makeRepoDeps()
    const tree = (): readonly { id: string; title: string; orderKey: string }[] =>
      unwrap(listDocumentTree(db, { context: readContext(workspaceId), projectId })).documents

    const create = (title: string, placement: DocumentPlacement): { id: DocumentId; orderKey: string } => {
      const created = unwrap(
        createDocument(
          db,
          {
            context: writeContext(workspaceId, { projectId }),
            projectId,
            kind: 'chapter',
            parentId: null,
            title,
            placement,
          },
          deps,
        ),
        `createDocument(${title}, ${placement.mode})`,
      )
      return { id: created.documentId, orderKey: created.orderKey }
    }

    // ① 连续三次 end：键必须严格递增
    const a = create('A', { mode: 'end' })
    const b = create('B', { mode: 'end' })
    const c = create('C', { mode: 'end' })
    expect(a.orderKey < b.orderKey).toBe(true)
    expect(b.orderKey < c.orderKey).toBe(true)
    expect(tree().map((item) => item.title)).toEqual(['A', 'B', 'C'])

    // ② after A：新键落在 A 与 B 之间
    const d = create('D', { mode: 'after', afterId: a.id })
    expect(a.orderKey < d.orderKey).toBe(true)
    expect(d.orderKey < b.orderKey).toBe(true)
    expect(tree().map((item) => item.title)).toEqual(['A', 'D', 'B', 'C'])

    // ③ after 最后一章：追加到末尾
    const e = create('E', { mode: 'after', afterId: c.id })
    expect(c.orderKey < e.orderKey).toBe(true)
    expect(tree().map((item) => item.title)).toEqual(['A', 'D', 'B', 'C', 'E'])

    // ④ 锚点不存在 → NOT_FOUND_DOCUMENT（不是静默排到某处）
    expectErrCode(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          kind: 'chapter',
          parentId: null,
          title: 'F',
          placement: { mode: 'after', afterId: 'doc_not_there' as DocumentId },
        },
        deps,
      ),
      'NOT_FOUND_DOCUMENT',
      'after 不存在的锚点',
    )

    // ⑤ 标题与位置互不干扰：改标题不动键
    const before = tree().find((item) => item.id === b.id)?.orderKey
    unwrap(
      updateDocumentTitle(db, writeContext(workspaceId, { projectId }), b.id, 'B 改', deps),
      'updateDocumentTitle',
    )
    expect(tree().find((item) => item.id === b.id)?.orderKey).toBe(before)
  })
})

describe('reorderDocument', () => {
  it(
    '在中间插入 1000 次后顺序仍正确',
    () => {
      const workspaceId = seedWorkspace(db, { id: 'ws_reorder' })
      const projectId = seedProject(db, { workspaceId, id: 'prj_reorder' })
      const deps = makeRepoDeps()

      const COUNT = 20
      let expected: Array<{ id: DocumentId; title: string }> = []
      for (let i = 0; i < COUNT; i += 1) {
        const title = `第 ${i + 1} 章`
        const created = unwrap(
          createDocument(
            db,
            {
              context: writeContext(workspaceId, { projectId }),
              projectId,
              kind: 'chapter',
              parentId: null,
              title,
              placement: { mode: 'end' },
            },
            deps,
          ),
          `createDocument(${title})`,
        )
        expected.push({ id: created.documentId, title })
      }

      const orderSnapshot = (): readonly string[] =>
        unwrap(listDocumentTree(db, { context: readContext(workspaceId), projectId })).documents.map(
          (item) => item.id,
        )
      expect(orderSnapshot()).toEqual(expected.map((item) => item.id))

      // 每次把**当前最后一位**挪到中间的某个锚点之后。
      // 锚点下标按 (i * 7) % (n - 2) 轮转，让 1000 次插入分散到 18 个不同缝隙：
      // 若固定怼同一个缝隙，`orderKeyBetween` 每插一次加长一个字符，
      // 约 480 次就会顶到 `MAX_KEY_LENGTH = 512`（domain/orderKey 的硬上限）。
      for (let i = 0; i < 1000; i += 1) {
        const source = at(expected, expected.length - 1)
        const anchor = at(expected, (i * 7) % (COUNT - 2))

        // 期望数组同步更新：把 source 从末尾摘掉、插到 anchor 之后
        expected = expected.filter((item) => item.id !== source.id)
        const anchorIndex = expected.findIndex((item) => item.id === anchor.id)
        expected = [
          ...expected.slice(0, anchorIndex + 1),
          source,
          ...expected.slice(anchorIndex + 1),
        ]

        const moved = reorderDocument(
          db,
          writeContext(workspaceId, { projectId }),
          source.id,
          { mode: 'after', afterId: anchor.id },
          deps,
        )
        if (!moved.ok) {
          throw new Error(`第 ${i + 1} 次重排失败：${moved.error.code} ${moved.error.message}`)
        }
      }

      expect(orderSnapshot()).toEqual(expected.map((item) => item.id))
      console.log(`[task-7] reorderDocument：1000 次中间插入后顺序与期望完全一致（${COUNT} 章）`)
    },
    180_000,
  )

  it('重排后新键落在锚点与其后继之间；排到自己后面被拒绝', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_reorder2' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_reorder2' })
    const deps = makeRepoDeps()
    const create = (title: string): DocumentId =>
      unwrap(
        createDocument(
          db,
          {
            context: writeContext(workspaceId, { projectId }),
            projectId,
            kind: 'chapter',
            parentId: null,
            title,
            placement: { mode: 'end' },
          },
          deps,
        ),
        `createDocument(${title})`,
      ).documentId
    const first = create('一')
    const second = create('二')
    const third = create('三')
    const keys = (): readonly { id: string; orderKey: string }[] =>
      unwrap(listDocumentTree(db, { context: readContext(workspaceId), projectId })).documents

    // 把第三章挪到第一章之后
    const moved = unwrap(
      reorderDocument(
        db,
        writeContext(workspaceId, { projectId }),
        third,
        { mode: 'after', afterId: first },
        deps,
      ),
      'reorderDocument',
    )
    const ordered = keys()
    expect(ordered.map((item) => item.id)).toEqual([first, third, second])
    expect((ordered[0]?.orderKey ?? '') < moved.orderKey).toBe(true)
    expect(moved.orderKey < (ordered[2]?.orderKey ?? '')).toBe(true)
    // 位置真的变了 → revision_seq 从 1 推进到 2
    expect(readDocumentRow(db, third).revisionSeq).toBe(2)
    expect(moved.revision).toBe(encodeRevision(2))

    expectErrCode(
      reorderDocument(
        db,
        writeContext(workspaceId, { projectId }),
        third,
        { mode: 'after', afterId: third },
        deps,
      ),
      'VALIDATION_FAILED',
      '排到自己后面',
    )
  })

  it('位置没变时不推进 revision（无变化的写不该让并发编辑器吃 REVISION_CONFLICT）', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_reorder3' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_reorder3' })
    const deps = makeRepoDeps()
    const create = (title: string): { id: DocumentId; orderKey: string } => {
      const created = unwrap(
        createDocument(
          db,
          {
            context: writeContext(workspaceId, { projectId }),
            projectId,
            kind: 'chapter',
            parentId: null,
            title,
            placement: { mode: 'end' },
          },
          deps,
        ),
        `createDocument(${title})`,
      )
      return { id: created.documentId, orderKey: created.orderKey }
    }

    const a = create('甲')
    const b = create('乙')
    // 乙的键就是 orderKeyAfter(甲的键) 的结果；"排到末尾"在只有两个同级节点时
    // 必然算出同一个键 → 不以写代换，revision 保持 1。
    const tail = unwrap(
      reorderDocument(db, writeContext(workspaceId, { projectId }), b.id, { mode: 'end' }, deps),
      'reorderDocument(end)',
    )
    expect(tail.orderKey).toBe(b.orderKey)
    expect(tail.revision).toBe(encodeRevision(1))
    expect(readDocumentRow(db, b.id).revisionSeq).toBe(1)
    expect(a.orderKey < b.orderKey).toBe(true)
  })
})

describe('新建文档的 revision 基线', () => {
  it('revision 非空、等于 encodeRevision(1)，且 revision_seq 同步初始化为 1', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_rev' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_rev' })
    const deps = makeRepoDeps()

    const created = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          kind: 'chapter',
          parentId: null,
          title: '第 1 章',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument',
    )

    expect(created.revision).toBe(encodeRevision(1))
    expect(created.revision.length).toBeGreaterThan(0)

    const row = readDocumentRow(db, created.documentId)
    expect(row.revision).toBe(encodeRevision(1))
    // 🔴 SaveDraft 的乐观锁基线：revision 与 revision_seq 必须一起初始化，不能是空串/NULL/0
    expect(row.revisionSeq).toBe(1)
    expect(row.revision).not.toBe('')
    expect(row.body).toBe('')
    expect(row.deleted).toBe(0)

    // 读取路径也一致（getDocument 是唯一返回 body 的接口）
    const read = unwrap(
      getDocument(db, { context: readContext(workspaceId), documentId: created.documentId }),
      'getDocument',
    )
    expect(read.body).toBe('')
    expect(read.document.revision).toBe(encodeRevision(1))
    expect(read.document.charCount).toBe(0)
    expect('body' in read.document).toBe(false)
  })
})
