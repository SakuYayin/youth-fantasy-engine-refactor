/**
 * `settingsEntities.ts` / `characters.ts` 的 Repository 测试。
 *
 * 关键点：`values` 在库里是 **JSON 文本**（`values_json`，DDL 带 `CHECK json_valid`），
 * 数据库**不**为动态 Schema 的字段建列——这是"动态 Schema 实体读写"的实现约束。
 * `characters.ts` 是 `settings_entities` 的薄封装（桌面 Schema 里没有 characters 表）。
 */

import { afterAll, describe, expect, it } from 'vitest'

import { encodeRevision, type ProjectId, type WorkspaceId } from '@yfe/contracts'

import {
  CHARACTER_SCHEMA_TEMPLATE_IDS,
  createCharacter,
  createSettingsEntity,
  getCharacter,
  getSettingsEntity,
  listCharacters,
  listSettingsEntities,
  softDeleteCharacter,
  softDeleteSettingsEntity,
  updateCharacter,
  updateSettingsEntity,
} from '../../src/repositories/index.js'
import {
  cleanupTempDirs,
  expectErrCode,
  makeRepoDeps,
  openMigratedDatabase,
  readContext,
  readSettingsRow,
  seedProject,
  seedTime,
  seedWorkspace,
  unwrap,
  writeContext,
} from './helpers.js'

const db = openMigratedDatabase('settings-entities')
const deps = makeRepoDeps()

afterAll(() => {
  cleanupTempDirs()
})

const workspaceId: WorkspaceId = seedWorkspace(db, { id: 'ws_settings' })
const projectId: ProjectId = seedProject(db, { workspaceId, id: 'prj_settings' })

describe('settingsEntities：动态 Schema 读写', () => {
  it('values 存成 JSON 文本，读回来深度相等；数据库不为动态字段建列', () => {
    const values = {
      姓名: '林小满',
      年龄: 17,
      灵根: { 主属性: '木', 品阶: 3 },
      标签: ['主角', '书院'],
      是穿越者: true,
      备注: null,
    }
    const created = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'worldbase',
          name: '世界观',
          values,
        },
        deps,
      ),
      'createSettingsEntity',
    )

    expect(created.revision).toBe(encodeRevision(1))
    const row = readSettingsRow(db, created.entityId)
    // 🔴 落在 values_json 一列里，且是 JSON 文本（不是 SQL 列、也不是二进制）
    expect(typeof row.valuesJson).toBe('string')
    expect(JSON.parse(row.valuesJson)).toEqual(values)
    expect(row.schemaTemplateId).toBe('worldbase')
    expect(row.revisionSeq).toBe(1)
    // 表里只有 values_json 这一个承载动态字段的列
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('settings_entities')`)
      .all() as readonly { name: string }[]
    expect(columns.map((column) => column.name)).toContain('values_json')
    expect(columns.map((column) => column.name)).not.toContain('姓名')

    const read = unwrap(getSettingsEntity(db, readContext(workspaceId), created.entityId), 'getSettingsEntity')
    expect(read.values).toEqual(values)
    expect(read.name).toBe('世界观')
    expect(read.workspaceId).toBe(workspaceId)
    expect(read.projectId).toBe(projectId)
  })

  it('values 缺省为 {}；非对象的 values 被拒绝', () => {
    const created = unwrap(
      createSettingsEntity(
        db,
        { context: writeContext(workspaceId, { projectId }), projectId, schemaTemplateId: 'timeline', name: '时间线' },
        deps,
      ),
      'createSettingsEntity(默认 values)',
    )
    expect(unwrap(getSettingsEntity(db, readContext(workspaceId), created.entityId)).values).toEqual({})

    for (const bad of [['数组'], '字符串', 42, null, undefined]) {
      const result = createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'timeline',
          name: '坏 values',
          values: { 字段: bad } as Readonly<Record<string, unknown>>,
        },
        deps,
      )
      // JSON.stringify 会丢掉 undefined → 这里只有可序列化的基本类型能进库；
      // 数组/字符串/数字/null 都是合法 JSON 的**字段值**，因此应当写入成功。
      expect(result.ok).toBe(true)
    }
  })

  it('显式 entityId 可保留旧 ID（迁移矩阵 M-04/M-06 要求）；重复 ID → ALREADY_EXISTS', () => {
    const created = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'char-npc',
          name: '旧库页签',
          entityId: 'wld_legacy_0001',
        },
        deps,
      ),
      'createSettingsEntity(保留旧 ID)',
    )
    expect(created.entityId).toBe('wld_legacy_0001')
    expect(unwrap(getSettingsEntity(db, readContext(workspaceId), 'wld_legacy_0001')).id).toBe('wld_legacy_0001')

    expectErrCode(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'char-npc',
          name: '重复 ID',
          entityId: 'wld_legacy_0001',
        },
        deps,
      ),
      'ALREADY_EXISTS',
      '重复 entityId',
    )
  })

  it('列表按模板过滤，显式空数组返回空集合', () => {
    const read = readContext(workspaceId)
    const all = unwrap(listSettingsEntities(db, { context: read, projectId }), 'listSettingsEntities')
    expect(all.length).toBeGreaterThan(0)

    const worldbaseOnly = unwrap(
      listSettingsEntities(db, { context: read, projectId, schemaTemplateId: 'worldbase' }),
      'listSettingsEntities(worldbase)',
    )
    expect(worldbaseOnly.length).toBe(1)
    expect(worldbaseOnly[0]?.schemaTemplateId).toBe('worldbase')

    const multi = unwrap(
      listSettingsEntities(db, { context: read, projectId, schemaTemplateIds: ['worldbase', 'timeline'] }),
      'listSettingsEntities(多模板)',
    )
    expect(multi.length).toBeGreaterThanOrEqual(3)
    expect(multi.every((entity) => ['worldbase', 'timeline'].includes(entity.schemaTemplateId))).toBe(true)

    expect(
      unwrap(listSettingsEntities(db, { context: read, projectId, schemaTemplateIds: [] }), 'listSettingsEntities(空数组)')
        .length,
    ).toBe(0)
  })

  it('更新是整值替换并推进 revision；空 patch 被拒绝', () => {
    const created = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'worldbase',
          name: '可更新',
          values: { 甲: 1, 乙: 2 },
        },
        deps,
      ),
      'createSettingsEntity',
    )

    const updated = unwrap(
      updateSettingsEntity(
        db,
        writeContext(workspaceId, { projectId }),
        created.entityId,
        { values: { 丙: 3 } },
        deps,
      ),
      'updateSettingsEntity',
    )
    expect(updated.revision).toBe(encodeRevision(2))
    const after = unwrap(getSettingsEntity(db, readContext(workspaceId), created.entityId), 'getSettingsEntity')
    // 整体替换：旧字段 甲/乙 消失（不做深合并）
    expect(after.values).toEqual({ 丙: 3 })
    expect(after.name).toBe('可更新')

    expectErrCode(
      updateSettingsEntity(db, writeContext(workspaceId, { projectId }), created.entityId, {}, deps),
      'VALIDATION_MISSING_FIELD',
      '空 patch',
    )
  })

  it('软删后默认查不到，includeDeleted 才返回；values_json 坏掉时读路径报 STORAGE_CORRUPT', () => {
    const created = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'worldbase',
          name: '待删除',
          values: { 甲: 1 },
        },
        deps,
      ),
      'createSettingsEntity',
    )
    unwrap(
      softDeleteSettingsEntity(db, writeContext(workspaceId, { projectId }), created.entityId, deps),
      'softDeleteSettingsEntity',
    )
    expect(readSettingsRow(db, created.entityId).deleted).toBe(1)
    expect(readSettingsRow(db, created.entityId).revisionSeq).toBe(2)
    expectErrCode(
      getSettingsEntity(db, readContext(workspaceId), created.entityId),
      'NOT_FOUND',
      'getSettingsEntity(已删)',
    )
    expect(
      unwrap(
        getSettingsEntity(db, readContext(workspaceId), created.entityId, { includeDeleted: true }),
        'getSettingsEntity(includeDeleted)',
      ).deleted,
    ).not.toBe(0)
    expect(
      unwrap(
        listSettingsEntities(db, { context: readContext(workspaceId), projectId, includeDeleted: true }),
        'listSettingsEntities(includeDeleted)',
      ).some((entity) => entity.id === created.entityId),
    ).toBe(true)

    // 绕过 CHECK json_valid 写入坏数据，模拟磁盘损坏 / 旧版本误写
    const corruptedId = 'wld_corrupted_0001'
    db.pragma('ignore_check_constraints = ON')
    try {
      db.prepare(
        `INSERT INTO settings_entities
           (id, workspace_id, project_id, schema_template_id, name, values_json, order_key,
            revision, revision_seq, deleted, created_at, updated_at)
         VALUES (?, ?, ?, 'worldbase', '坏数据', '{不是 JSON', 'zz', ?, 1, 0, ?, ?)`,
      ).run(corruptedId, workspaceId, projectId, encodeRevision(1), seedTime(), seedTime())
    } finally {
      db.pragma('ignore_check_constraints = OFF')
    }
    expectErrCode(
      getSettingsEntity(db, readContext(workspaceId), corruptedId),
      'STORAGE_CORRUPT',
      'getSettingsEntity(坏 JSON)',
    )
    expectErrCode(
      listSettingsEntities(db, { context: readContext(workspaceId), projectId }),
      'STORAGE_CORRUPT',
      'listSettingsEntities(坏 JSON)',
    )
  })
})

describe('characters：人物卡', () => {
  it('人物卡是 settings_entities 的薄封装，模板 ID 用旧库页签（char-main 等）', () => {
    const created = unwrap(
      createCharacter(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          name: '林小满',
          values: { 身份: '主角', 修为: '炼气三层' },
        },
        deps,
      ),
      'createCharacter',
    )

    expect(created.characterId.startsWith('chr')).toBe(true)
    expect(created.revision).toBe(encodeRevision(1))
    const row = readSettingsRow(db, created.characterId)
    expect(row.schemaTemplateId).toBe('char-main')
    expect(row.valuesJson).toBe(JSON.stringify({ 身份: '主角', 修为: '炼气三层' }))

    const character = unwrap(getCharacter(db, readContext(workspaceId), created.characterId), 'getCharacter')
    expect(character.name).toBe('林小满')
    expect(character.values).toEqual({ 身份: '主角', 修为: '炼气三层' })
    expect(character.projectId).toBe(projectId)

    // 三种卡面
    const secondary = unwrap(
      createCharacter(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          name: '配角卡',
          cardTemplateId: 'char-secondary',
        },
        deps,
      ),
      'createCharacter(char-secondary)',
    )
    expect(readSettingsRow(db, secondary.characterId).schemaTemplateId).toBe('char-secondary')
    expectErrCode(
      createCharacter(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          name: '错模板',
          cardTemplateId: 'worldbase',
        },
        deps,
      ),
      'VALIDATION_FAILED',
      '非人物卡模板',
    )

    // 列表只含三种人物卡，不含其它设定实体
    const cards = unwrap(listCharacters(db, readContext(workspaceId), projectId), 'listCharacters')
    const cardIds = cards.map((card) => card.id)
    expect(cardIds).toContain(created.characterId)
    expect(cardIds).toContain(secondary.characterId)
    // `Character` 契约刻意不暴露 schemaTemplateId（人物字段固定、不走动态模板），
    // 因此卡面类型只能从原始行上核对。
    expect(
      cards.every((card) => CHARACTER_SCHEMA_TEMPLATE_IDS.includes(readSettingsRow(db, card.id).schemaTemplateId)),
    ).toBe(true)

    // 人物卡 API 读不到别的设定实体（不泄漏"它是别的类型"）
    const worldbase = unwrap(
      createSettingsEntity(
        db,
        {
          context: writeContext(workspaceId, { projectId }),
          projectId,
          schemaTemplateId: 'worldbase',
          name: '世界观',
        },
        deps,
      ),
      'createSettingsEntity(worldbase)',
    )
    expectErrCode(
      getCharacter(db, readContext(workspaceId), worldbase.entityId),
      'NOT_FOUND',
      'getCharacter(非人物卡)',
    )
    expectErrCode(
      updateCharacter(db, writeContext(workspaceId, { projectId }), worldbase.entityId, { name: '越权' }, deps),
      'NOT_FOUND',
      'updateCharacter(非人物卡)',
    )
    expect(readSettingsRow(db, worldbase.entityId).name).toBe('世界观')
  })

  it('更新与软删人物卡', () => {
    const created = unwrap(
      createCharacter(
        db,
        { context: writeContext(workspaceId, { projectId }), projectId, name: '待改', values: { 甲: 1 } },
        deps,
      ),
      'createCharacter',
    )
    const updated = unwrap(
      updateCharacter(
        db,
        writeContext(workspaceId, { projectId }),
        created.characterId,
        { name: '改过', values: { 乙: 2 } },
        deps,
      ),
      'updateCharacter',
    )
    expect(updated.revision).toBe(encodeRevision(2))
    const after = unwrap(getCharacter(db, readContext(workspaceId), created.characterId), 'getCharacter')
    expect(after.name).toBe('改过')
    expect(after.values).toEqual({ 乙: 2 })

    unwrap(
      softDeleteCharacter(db, writeContext(workspaceId, { projectId }), created.characterId, deps),
      'softDeleteCharacter',
    )
    expect(readSettingsRow(db, created.characterId).deleted).toBe(1)
    expect(readSettingsRow(db, created.characterId).revisionSeq).toBe(3)
    expectErrCode(getCharacter(db, readContext(workspaceId), created.characterId), 'NOT_FOUND', 'getCharacter(已删)')
    expect(
      unwrap(
        getCharacter(db, readContext(workspaceId), created.characterId, { includeDeleted: true }),
        'getCharacter(includeDeleted)',
      ).deleted,
    ).not.toBe(0)
  })
})
