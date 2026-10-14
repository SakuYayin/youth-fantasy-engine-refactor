/**
 * R-18 锁定测试：Repository 的 `createProject` / `createDocument` 必须**优先采用
 * 调用方（应用用例层）传入的实体 ID**，只有不传时才自生成。
 *
 * 背景：用例层必须先于端口调用生成 ID（幂等重放要回同一个 ID，见
 * `packages/application/src/useCases/createProject.ts`），若 repository 自己再生成一次，
 * 「返回给客户端的 ID」与「落库的 ID」就会分叉，后续 `saveDraft` / `listDocumentTree`
 * 会以 `NOT_FOUND_*` 失败。桌面适配器曾用「钉住随机源」（`pinnedRandomSource`）权宜绕过，
 * 本文件钉死正解：调用方 ID 必须逐字落库。
 */

import { afterAll, describe, expect, it } from 'vitest'

import type { DocumentId, ProjectId } from '@yfe/contracts'

import { createDocument, createProject, getDocument, listDocumentTree } from '../../src/repositories/index.js'
import {
  cleanupTempDirs,
  countRows,
  expectErrCode,
  makeRepoDeps,
  openMigratedDatabase,
  readContext,
  readDocumentRow,
  readProjectRow,
  seedProject,
  seedWorkspace,
  unwrap,
  writeContext,
} from './helpers.js'

const db = openMigratedDatabase('caller-ids')
const deps = makeRepoDeps()

afterAll(() => {
  cleanupTempDirs()
})

describe('Repository 采用调用方传入的实体 ID（R-18）', () => {
  it('createProject：落库 ID 与调用方给的 projectId 逐字相同', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_ids' })
    const projectId = 'prj_caller_000001' as ProjectId
    const before = countRows(db, 'projects')
    const created = unwrap(
      createProject(db, { context: writeContext(workspaceId), name: '调用方 ID', projectId }, deps),
      'createProject',
    )

    expect(created.projectId).toBe(projectId)
    expect(readProjectRow(db, projectId).name).toBe('调用方 ID')
    // 只多一行：调用方 ID 必须**取代**自生成，而不是额外再写一条
    expect(countRows(db, 'projects')).toBe(before + 1)
  })

  it('createProject：不传 projectId 时仍自生成（迁移脚本 / 直连测试的向后兼容）', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_auto' })
    const created = unwrap(
      createProject(db, { context: writeContext(workspaceId), name: '自生成 ID' }, deps),
      'createProject',
    )

    expect(created.projectId.startsWith('prj_')).toBe(true)
    expect(readProjectRow(db, created.projectId).name).toBe('自生成 ID')
  })

  it('createProject：畸形 projectId 报 VALIDATION_FAILED 且一行都不写', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_bad' })
    const before = countRows(db, 'projects')

    expectErrCode(
      createProject(
        db,
        { context: writeContext(workspaceId), name: '畸形 ID', projectId: 'bad id!' as ProjectId },
        deps,
      ),
      'VALIDATION_MALFORMED_ID',
      'createProject',
    )
    expect(countRows(db, 'projects')).toBe(before)
  })

  it('createProject(seedFirstChapter)：作品用调用方 ID，卷/章 ID 仍由 Repository 自生成', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_seed' })
    const projectId = 'prj_caller_seed_001' as ProjectId
    unwrap(
      createProject(
        db,
        { context: writeContext(workspaceId), name: '播种作品', projectId, seedFirstChapter: true },
        deps,
      ),
      'createProject',
    )

    expect(readProjectRow(db, projectId).name).toBe('播种作品')
    const { documents: tree } = unwrap(
      listDocumentTree(db, { context: readContext(workspaceId), projectId, includeDeleted: false }),
      'listDocumentTree',
    )
    // 「第一卷」+「第 1 章」
    expect(tree.length).toBe(2)
    for (const node of tree) {
      expect(node.id).not.toBe(projectId)
      expect(node.id.startsWith('doc_')).toBe(true)
    }
  })

  it('createDocument：落库 ID 与调用方给的 documentId 逐字相同，树查询与读正文都看得到', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_doc' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_caller_doc_001' as ProjectId })
    const documentId = 'doc_caller_000001' as DocumentId
    const created = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          documentId,
          kind: 'chapter',
          parentId: null,
          title: '调用方 ID 的章',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument',
    )

    expect(created.documentId).toBe(documentId)
    expect(readDocumentRow(db, documentId).title).toBe('调用方 ID 的章')

    const { documents: tree } = unwrap(
      listDocumentTree(db, { context: readContext(workspaceId), projectId, includeDeleted: false }),
      'listDocumentTree',
    )
    expect(tree.map((node) => node.id)).toContain(documentId)

    const read = unwrap(
      getDocument(db, { context: readContext(workspaceId), documentId }),
      'getDocument',
    )
    expect(read.document.id).toBe(documentId)
    expect(read.body).toBe('')
  })

  it('createDocument：畸形 documentId 报 VALIDATION_FAILED 且一行都不写', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_caller_bad_doc' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_caller_bad_doc_001' as ProjectId })
    const before = countRows(db, 'documents')

    expectErrCode(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          documentId: 'not a valid id' as DocumentId,
          kind: 'chapter',
          parentId: null,
          title: '畸形 ID',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'VALIDATION_MALFORMED_ID',
      'createDocument',
    )
    expect(countRows(db, 'documents')).toBe(before)
  })
})
