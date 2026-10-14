/**
 * 隔离与软删的 Repository 测试。
 *
 * 覆盖任务书要求的 2 条：
 * 2. 跨 workspace 查询被**拒绝**（返回错误，而不是静默返回空）；
 * 3. 软删后默认查不到、显式 `includeDeleted: true` 才返回。
 */

import { afterAll, describe, expect, it } from 'vitest'

import { encodeRevision, type DocumentId } from '@yfe/contracts'

import {
  createCharacter,
  createDocument,
  createSettingsEntity,
  getCharacter,
  getDocument,
  getProject,
  getSettingsEntity,
  listDocumentTree,
  listProjects,
  renameProject,
  reorderDocument,
  softDeleteDocument,
  softDeleteProject,
  updateDocumentTitle,
} from '../../src/repositories/index.js'
import {
  cleanupTempDirs,
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

const db = openMigratedDatabase('isolation')
const deps = makeRepoDeps()

afterAll(() => {
  cleanupTempDirs()
})

describe('workspace 隔离', () => {
  it('跨 workspace 的读取与写入都被拒绝，且不静默返回空', () => {
    const workspaceA = seedWorkspace(db, { id: 'ws_iso_a' })
    const workspaceB = seedWorkspace(db, { id: 'ws_iso_b' })
    const projectA = seedProject(db, { workspaceId: workspaceA, id: 'prj_iso_a' })
    const projectB = seedProject(db, { workspaceId: workspaceB, id: 'prj_iso_b' })

    const volumeA = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceA, { projectId: projectA }),
          projectId: projectA,
          kind: 'volume',
          parentId: null,
          title: 'A 卷',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument(volume)',
    )
    const chapterA = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceA, { projectId: projectA }),
          projectId: projectA,
          kind: 'chapter',
          parentId: volumeA.documentId,
          title: 'A 章',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument(chapter)',
    )
    const entityA = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceA, { projectId: projectA }),
          projectId: projectA,
          schemaTemplateId: 'worldbase',
          name: 'A 设定',
        },
        deps,
      ),
      'createSettingsEntity',
    )
    const characterA = unwrap(
      createCharacter(
        db,
        {
          context: writeContext(workspaceA, { projectId: projectA }),
          projectId: projectA,
          name: 'A 人物',
        },
        deps,
      ),
      'createCharacter',
    )

    // ---- 读：B 的工作区上下文去读 A 的实体，全部越界 ----
    const readB = readContext(workspaceB)
    expectErrCode(getProject(db, readB, projectA), 'PERMISSION_WORKSPACE_MISMATCH', 'getProject')
    expectErrCode(
      listDocumentTree(db, { context: readB, projectId: projectA }),
      'PERMISSION_WORKSPACE_MISMATCH',
      'listDocumentTree',
    )
    expectErrCode(
      getDocument(db, { context: readB, documentId: chapterA.documentId }),
      'PERMISSION_WORKSPACE_MISMATCH',
      'getDocument',
    )
    expectErrCode(getSettingsEntity(db, readB, entityA.entityId), 'PERMISSION_WORKSPACE_MISMATCH', 'getSettingsEntity')
    expectErrCode(getCharacter(db, readB, characterA.characterId), 'PERMISSION_WORKSPACE_MISMATCH', 'getCharacter')

    // ---- 写：同样越界，且不能改动数据 ----
    const writeB = writeContext(workspaceB, { projectId: projectB })
    expectErrCode(renameProject(db, writeB, projectA, '被越权改名', deps), 'PERMISSION_WORKSPACE_MISMATCH', 'renameProject')
    expectErrCode(
      updateDocumentTitle(db, writeB, chapterA.documentId, '被越权改名', deps),
      'PERMISSION_WORKSPACE_MISMATCH',
      'updateDocumentTitle',
    )
    expectErrCode(
      reorderDocument(db, writeB, chapterA.documentId, { mode: 'end' }, deps),
      'PERMISSION_WORKSPACE_MISMATCH',
      'reorderDocument',
    )
    expectErrCode(softDeleteProject(db, writeB, projectA, deps), 'PERMISSION_WORKSPACE_MISMATCH', 'softDeleteProject')

    // 越界请求没有造成任何副作用
    const projectRow = readProjectRow(db, projectA)
    expect(projectRow.name).toBe('测试作品')
    expect(projectRow.deleted).toBe(0)
    expect(projectRow.revision).toBe(encodeRevision(1))
    const documentRow = readDocumentRow(db, chapterA.documentId)
    expect(documentRow.title).toBe('A 章')
    expect(documentRow.deleted).toBe(0)

    // ---- 列表是"按工作区过滤"而不是报错：它只能看到自己的作品 ----
    expect(unwrap(listProjects(db, readB), 'listProjects(B)').map((project) => project.id)).toEqual([
      'prj_iso_b',
    ])
    expect(unwrap(listProjects(db, readContext(workspaceA)), 'listProjects(A)').map((project) => project.id)).toEqual([
      'prj_iso_a',
    ])

    // ---- 「越界」与「不存在」是两种错误，不能混为一谈 ----
    expectErrCode(getProject(db, readB, 'prj_not_exist_0001'), 'NOT_FOUND_PROJECT', 'getProject(不存在)')
    expectErrCode(
      getDocument(db, { context: readB, documentId: 'doc_not_exist_0001' as DocumentId }),
      'NOT_FOUND_DOCUMENT',
      'getDocument(不存在)',
    )
  })
})

describe('软删', () => {
  it('默认过滤 deleted <> 0，只有显式 includeDeleted 才返回已删记录', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_soft_cascade' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_soft_cascade' })
    const create = (kind: 'volume' | 'chapter', parentId: DocumentId | null, title: string): DocumentId =>
      unwrap(
        createDocument(
          db,
          {
            context: writeContext(workspaceId, { projectId }),
            projectId,
            kind,
            parentId,
            title,
            placement: { mode: 'end' },
          },
          deps,
        ),
        `createDocument(${title})`,
      ).documentId

    const volumeId = create('volume', null, '第一卷')
    const chapter1 = create('chapter', volumeId, '第 1 章')
    const chapter2 = create('chapter', volumeId, '第 2 章')
    const readAll = (includeDeleted = false): readonly string[] =>
      unwrap(
        listDocumentTree(db, {
          context: readContext(workspaceId),
          projectId,
          ...(includeDeleted ? { includeDeleted: true } : {}),
        }),
        'listDocumentTree',
      ).documents.map((document) => document.id)

    expect(readAll().length).toBe(3)

    // 级联软删：卷 + 两个子章一起进回收站，且**各自**推进 revision_seq
    const deleted = unwrap(
      softDeleteDocument(db, writeContext(workspaceId, { projectId }), volumeId, deps),
      'softDeleteDocument',
    )
    expect(deleted.deletedCount).toBe(3)
    for (const id of [volumeId, chapter1, chapter2]) {
      const row = readDocumentRow(db, id)
      expect(row.deleted).toBe(1)
      expect(row.revisionSeq).toBe(2)
      expect(row.revision).toBe(encodeRevision(2))
    }
    expect(deleted.revision).toBe(encodeRevision(2))

    // 默认查不到
    expect(readAll()).toEqual([])
    expectErrCode(
      getDocument(db, { context: readContext(workspaceId), documentId: chapter1 }),
      'NOT_FOUND_DOCUMENT',
      'getDocument(已删)',
    )
    // 再删一次 → 不存在
    expectErrCode(
      softDeleteDocument(db, writeContext(workspaceId, { projectId }), volumeId, deps),
      'NOT_FOUND_DOCUMENT',
      'softDeleteDocument(重复)',
    )

    // 显式包含才返回，且 deleted 字段可区分
    const withDeleted = unwrap(
      listDocumentTree(db, { context: readContext(workspaceId), projectId, includeDeleted: true }),
      'listDocumentTree(includeDeleted)',
    ).documents
    expect(withDeleted.map((document) => document.id).sort()).toEqual([volumeId, chapter1, chapter2].sort())
    expect(withDeleted.every((document) => document.deleted !== 0)).toBe(true)
  })

  it('cascade: false 只删自己，子树留在可见集合里', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_soft_nocascade' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_soft_nocascade' })
    const volumeId = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          kind: 'volume',
          parentId: null,
          title: '第一卷',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument(volume)',
    ).documentId
    const chapterId = unwrap(
      createDocument(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          kind: 'chapter',
          parentId: volumeId,
          title: '第 1 章',
          placement: { mode: 'end' },
        },
        deps,
      ),
      'createDocument(chapter)',
    ).documentId

    const deleted = unwrap(
      softDeleteDocument(db, writeContext(workspaceId, { projectId }), volumeId, deps, { cascade: false }),
      'softDeleteDocument(cascade:false)',
    )
    expect(deleted.deletedCount).toBe(1)
    expect(readDocumentRow(db, volumeId).deleted).toBe(1)
    expect(readDocumentRow(db, chapterId).deleted).toBe(0)

    const remaining = unwrap(
      listDocumentTree(db, { context: readContext(workspaceId), projectId }),
      'listDocumentTree',
    ).documents
    expect(remaining.map((document) => document.id)).toEqual([chapterId])
  })

  it('作品软删：默认查不到，includeDeleted 才返回；不级联删除文档行', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_soft_project' })
    const projectId = seedProject(db, { workspaceId, id: 'prj_soft_project' })
    const documentId = unwrap(
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
    ).documentId

    const deleted = unwrap(
      softDeleteProject(db, writeContext(workspaceId, { projectId }), projectId, deps),
      'softDeleteProject',
    )
    expect(deleted.revision).toBe(encodeRevision(2))
    expect(readProjectRow(db, projectId).deleted).toBe(1)
    expect(readProjectRow(db, projectId).revisionSeq).toBe(2)

    expectErrCode(getProject(db, readContext(workspaceId), projectId), 'NOT_FOUND_PROJECT', 'getProject(已删)')
    const withDeleted = unwrap(
      getProject(db, readContext(workspaceId), projectId, { includeDeleted: true }),
      'getProject(includeDeleted)',
    )
    expect(withDeleted.deleted).not.toBe(0)
    expect(withDeleted.id).toBe(projectId)

    expect(unwrap(listProjects(db, readContext(workspaceId)), 'listProjects').length).toBe(0)
    expect(
      unwrap(listProjects(db, readContext(workspaceId), { includeDeleted: true }), 'listProjects(includeDeleted)').map(
        (project) => project.id,
      ),
    ).toEqual([projectId])

    // 作品软删**不**级联文档：文档行仍是未删状态（可见性由作品决定，恢复才可能）
    expect(readDocumentRow(db, documentId).deleted).toBe(0)
    expectErrCode(
      softDeleteProject(db, writeContext(workspaceId, { projectId }), projectId, deps),
      'NOT_FOUND_PROJECT',
      'softDeleteProject(重复)',
    )
  })
})
