/**
 * `projects.ts` 的 Repository 测试：创建 / 读取 / 列表 / 重命名 / 软删，
 * 以及"新建实体必须把 revision 与 revision_seq 一起初始化为 1"这条硬约束。
 */

import { afterAll, describe, expect, it } from 'vitest'

import { encodeRevision, type WorkspaceId } from '@yfe/contracts'

import {
  createProject,
  getProject,
  listDocumentTree,
  listProjects,
  renameProject,
} from '../../src/repositories/index.js'
import {
  cleanupTempDirs,
  expectErrCode,
  makeRepoDeps,
  openMigratedDatabase,
  readContext,
  readProjectRow,
  seedWorkspace,
  unwrap,
  writeContext,
} from './helpers.js'

const db = openMigratedDatabase('projects')
const deps = makeRepoDeps()

afterAll(() => {
  cleanupTempDirs()
})

describe('createProject', () => {
  it('名称去空白、templateId 落到 project_type、revision 与 revision_seq 都从 1 起', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_create' })
    const created = unwrap(
      createProject(
        db,
        {
          context: writeContext(workspaceId),
          name: '  青春幻想  ',
          summary: '简介',
          templateId: 'xuanhuan',
        },
        deps,
      ),
      'createProject',
    )

    expect(created.revision).toBe(encodeRevision(1))
    const row = readProjectRow(db, created.projectId)
    expect(row.name).toBe('青春幻想')
    expect(row.summary).toBe('简介')
    expect(row.projectType).toBe('xuanhuan')
    // 🔴 与 documents 同样的基线要求：revision 不能是空串 / NULL，seq 必须同时初始化为 1
    expect(row.revision).toBe(encodeRevision(1))
    expect(row.revisionSeq).toBe(1)
    expect(row.deleted).toBe(0)

    const project = unwrap(getProject(db, readContext(workspaceId), created.projectId), 'getProject')
    expect(project.name).toBe('青春幻想')
    expect(project.workspaceId).toBe(workspaceId)
    expect(project.revision).toBe(encodeRevision(1))
  })

  it('未传 templateId 时用 DDL 默认的作品类型 full', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_default_type' })
    const created = unwrap(createProject(db, { context: writeContext(workspaceId), name: '默认类型' }, deps))
    const row = readProjectRow(db, created.projectId)
    expect(row.projectType).toBe('full')
    expect(row.summary).toBe('')
  })

  it('seedFirstChapter：同一事务里播种「第一卷 + 第 1 章」，两者 revision_seq 都是 1', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_seed' })
    const created = unwrap(
      createProject(
        db,
        { context: writeContext(workspaceId), name: '播种作品', seedFirstChapter: true },
        deps,
      ),
      'createProject(seedFirstChapter)',
    )

    const documents = unwrap(
      listDocumentTree(db, { context: readContext(workspaceId), projectId: created.projectId }),
      'listDocumentTree',
    ).documents
    expect(documents.map((document) => document.title)).toEqual(['第一卷', '第 1 章'])
    const volume = documents[0]
    const chapter = documents[1]
    expect(volume?.kind).toBe('volume')
    expect(volume?.parentId).toBeNull()
    expect(chapter?.kind).toBe('chapter')
    expect(chapter?.parentId).toBe(volume?.id)
    for (const document of documents) {
      expect(document.revision).toBe(encodeRevision(1))
    }
  })

  it('拒绝：expectedRevision 非 null、空名称、超长名称', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_invalid' })
    expectErrCode(
      createProject(
        db,
        {
          context: writeContext(workspaceId, { expectedRevision: encodeRevision(1) }),
          name: '带期望版本号的新建',
        },
        deps,
      ),
      'VALIDATION_FAILED',
      '新建时带 expectedRevision',
    )
    expectErrCode(
      createProject(db, { context: writeContext(workspaceId), name: '   ' }, deps),
      'VALIDATION_MISSING_FIELD',
      '空名称',
    )
    expectErrCode(
      createProject(db, { context: writeContext(workspaceId), name: '名'.repeat(201) }, deps),
      'VALIDATION_OUT_OF_RANGE',
      '超长名称',
    )
    // 工作区不存在 → 报错（不是静默新建孤儿作品）
    const missingWorkspace = 'ws_never_created_0001' as WorkspaceId
    expectErrCode(
      createProject(db, { context: writeContext(missingWorkspace), name: '孤儿作品' }, deps),
      'NOT_FOUND',
      '工作区不存在',
    )
  })
})

describe('getProject / listProjects', () => {
  it('列表按工作区过滤，且不返回已软删作品', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_list' })
    const other = seedWorkspace(db, { id: 'ws_prj_list_other' })
    const first = unwrap(createProject(db, { context: writeContext(workspaceId), name: '甲' }, deps))
    const second = unwrap(createProject(db, { context: writeContext(workspaceId), name: '乙' }, deps))
    unwrap(createProject(db, { context: writeContext(other), name: '丙' }, deps))

    const list = unwrap(listProjects(db, readContext(workspaceId)), 'listProjects')
    expect(list.map((project) => project.id).sort()).toEqual([first.projectId, second.projectId].sort())
    expect(unwrap(listProjects(db, readContext(other))).length).toBe(1)

    // 不存在 / 已软删都走 NOT_FOUND_PROJECT
    expectErrCode(getProject(db, readContext(workspaceId), 'prj_missing_0001'), 'NOT_FOUND_PROJECT', 'getProject')
  })
})

describe('renameProject', () => {
  it('CAS 推进 revision；同名不推进；过期 expectedRevision → REVISION_CONFLICT', () => {
    const workspaceId = seedWorkspace(db, { id: 'ws_prj_rename' })
    const created = unwrap(createProject(db, { context: writeContext(workspaceId), name: '旧名' }, deps))

    const renamed = unwrap(
      renameProject(db, writeContext(workspaceId), created.projectId, '新名', deps),
      'renameProject',
    )
    expect(renamed.revision).toBe(encodeRevision(2))
    const row = readProjectRow(db, created.projectId)
    expect(row.name).toBe('新名')
    expect(row.revisionSeq).toBe(2)

    // 同名（含只有空白的差异被 trim 掉）→ 不推进 revision
    const noop = unwrap(
      renameProject(db, writeContext(workspaceId), created.projectId, '  新名  ', deps),
      'renameProject(同名)',
    )
    expect(noop.revision).toBe(encodeRevision(2))
    expect(readProjectRow(db, created.projectId).revisionSeq).toBe(2)

    // 用过期版本号写 → 冲突
    expectErrCode(
      renameProject(
        db,
        writeContext(workspaceId, { expectedRevision: encodeRevision(1) }),
        created.projectId,
        '再改一次',
        deps,
      ),
      'REVISION_CONFLICT',
      '过期 expectedRevision',
    )
    expect(readProjectRow(db, created.projectId).name).toBe('新名')
  })
})
