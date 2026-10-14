/**
 * 字段映射：确定性 ID、卷章层级与 orderKey、正文归一化、未知字段旁存。
 *
 * 夹具全部是 `tests/fixtures.ts` 里的**自造合成数据**，不是真实用户数据。
 */

import { countChars, compareOrderKeys, normalizeBody } from '@yfe/domain'
import { describe, expect, it } from 'vitest'

import type {
  ImportPlan,
  PlannedConfigValue,
  PlannedDocument,
  PlannedPluginData,
  PlannedRelation,
  PlannedRevision,
  PlannedSettingsEntity,
} from '../src/mapping.js'
import { LEGACY_CHARACTER_TEMPLATE_IDS, LEGACY_CONFIG_KEY, LEGACY_PLUGIN_ID, buildImportPlan } from '../src/mapping.js'
import {
  SYNTHETIC_CRLF_CONTENT,
  SYNTHETIC_MAIN,
  SYNTHETIC_NORMALIZED,
  SYNTHETIC_PROJECT_ID,
  syntheticCollection,
  syntheticCollectionWithLocalStorage,
  syntheticCollectionWithVectorIndex,
} from './fixtures.js'

const NOW = '2026-02-01T00:00:00.000Z'

async function plan(overrides: Record<string, readonly unknown[]> = {}, options = {}): Promise<ImportPlan> {
  return buildImportPlan(await syntheticCollection(overrides), { now: NOW, ...options })
}

function documentsOf(input: ImportPlan, kind: string): readonly PlannedDocument[] {
  return input.rows.filter((row): row is PlannedDocument => row.table === 'document' && row.kind === kind)
}

function documentByLegacyId(input: ImportPlan, legacyId: string): PlannedDocument {
  const found = documentsOf(input, 'chapter').find((row) => row.origin.legacyId === legacyId)
  if (found === undefined) throw new Error(`计划里找不到旧章节「${legacyId}」`)
  return found
}

function configValuesOf(input: ImportPlan): readonly PlannedConfigValue[] {
  return input.rows.filter((row): row is PlannedConfigValue => row.table === 'config_value')
}

function pluginDataOf(input: ImportPlan): readonly PlannedPluginData[] {
  return input.rows.filter((row): row is PlannedPluginData => row.table === 'plugin_data')
}

function settingsOf(input: ImportPlan): readonly PlannedSettingsEntity[] {
  return input.rows.filter((row): row is PlannedSettingsEntity => row.table === 'settings_entity')
}

function revisionsOf(input: ImportPlan): readonly PlannedRevision[] {
  return input.rows.filter((row): row is PlannedRevision => row.table === 'revision')
}

describe('M-01 作品字段映射', () => {
  it('旧 ID 被原样保留，name/intro/projectType 落到对应列', async () => {
    const result = await plan()
    const project = result.rows.find((row) => row.table === 'project' && row.id === SYNTHETIC_PROJECT_ID)
    expect(project).toBeDefined()
    expect(project?.table === 'project' && project.name).toBe('合成作品甲')
    expect(project?.table === 'project' && project.summary).toBe('合成简介')
    expect(project?.table === 'project' && project.projectType).toBe('full')
    expect(project?.table === 'project' && project.createdAt).toBe('2024-01-01T00:00:00.000Z')
  })

  it('🔴 未知字段（genre/cover/features）没有被丢弃：进报告 + 旁存进 config_values', async () => {
    const result = await plan()
    const fields = result.unmappedFields.filter((entry) => entry.entityKind === 'project').map((entry) => entry.field)
    expect(fields).toContain('genre')
    expect(fields).toContain('cover')
    expect(fields).toContain('features')
    expect(result.unmappedFields.every((entry) => entry.disposition !== undefined)).toBe(true)

    const carried = configValuesOf(result).find(
      (row) => row.key === LEGACY_CONFIG_KEY.project && row.ownerId === SYNTHETIC_PROJECT_ID,
    )
    expect(carried).toBeDefined()
    expect(carried?.value).toMatchObject({ genre: '奇幻', features: { aiAssist: true } })
  })

  it('旧 ID 也旁存一份，便于人工核对 ID 映射', async () => {
    const result = await plan()
    const remembered = configValuesOf(result).find(
      (row) => row.key === LEGACY_CONFIG_KEY.projectId && row.ownerId === SYNTHETIC_PROJECT_ID,
    )
    expect(remembered?.value).toBe(SYNTHETIC_PROJECT_ID)
  })
})

describe('M-03 章节未知字段', () => {
  it('status / excludeFromNumbering / aiAssist 逐条出现在报告里，并旁存到 legacy.chapter.<旧ID>', async () => {
    const result = await plan()
    const entry = documentByLegacyId(result, 'c-synth-1')
    const fields = result.unmappedFields
      .filter((item) => item.entityKind === 'document' && item.entityId === entry.id)
      .map((item) => item.field)
    expect(fields).toContain('status')
    expect(fields).toContain('excludeFromNumbering')
    expect(fields).toContain('aiAssist')

    const carried = configValuesOf(result).find((row) => row.key === `${LEGACY_CONFIG_KEY.chapter}.c-synth-1`)
    expect(carried?.value).toMatchObject({ status: '草稿', aiAssist: { tone: 'plain' } })
  })
})

describe('M-02 / M-03 卷章层级与 orderKey', () => {
  it('卷是顶层文档（parentId 为空），章挂在所属卷下', async () => {
    const result = await plan()
    const volumes = documentsOf(result, 'volume')
    expect(volumes.map((row) => row.title)).toEqual(['合成第一卷', '合成第二卷'])
    expect(volumes.every((row) => row.parentId === null)).toBe(true)

    const byLegacyTitle = (title: string): PlannedDocument => {
      const found = documentsOf(result, 'chapter').find((row) => row.title === title)
      if (found === undefined) throw new Error(`找不到章节「${title}」`)
      return found
    }
    const firstVolume = volumes.find((row) => row.title === '合成第一卷')
    const secondVolume = volumes.find((row) => row.title === '合成第二卷')

    expect(byLegacyTitle('合成第 1 章').parentId).toBe(firstVolume?.id)
    expect(byLegacyTitle('合成第 2 章').parentId).toBe(firstVolume?.id)
    expect(byLegacyTitle('合成第 3 章').parentId).toBe(secondVolume?.id)
  })

  it('orderKey 按旧 order 升序：同卷内 1 → 2 递增，跨卷的 1 仍排在各自卷里', async () => {
    const result = await plan()
    const firstVolume = documentsOf(result, 'volume').find((row) => row.title === '合成第一卷')
    const chapters = documentsOf(result, 'chapter')
      .filter((row) => row.parentId === firstVolume?.id)
      .sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey))
    expect(chapters.map((row) => row.title)).toEqual(['合成第 1 章', '合成第 2 章'])

    const volumes = [...documentsOf(result, 'volume')].sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey))
    expect(volumes.map((row) => row.title)).toEqual(['合成第一卷', '合成第二卷'])

    // 同一个父级下的键必须唯一；跨父级复用同一个键是**合法且预期**的，
    // 因为索引是 (parent_id, order_key)，而且每个父级都从 `spreadOrderKeys` 的第 0 项开始。
    const keysByParent = new Map<string, string[]>()
    for (const row of result.rows) {
      if (row.table !== 'document') continue
      const parent = row.parentId ?? '<root>'
      const list = keysByParent.get(parent) ?? []
      list.push(row.orderKey)
      keysByParent.set(parent, list)
    }
    expect(keysByParent.size).toBeGreaterThan(1)
    for (const [parent, keys] of keysByParent) {
      expect(new Set(keys).size, parent).toBe(keys.length)
    }
  })
})

describe('正文归一化与字素簇字数', () => {
  it('CRLF 被归一化成 LF，落库正文与 @yfe/domain 的 normalizeBody 一致', async () => {
    const result = await plan()
    const chapter = documentByLegacyId(result, 'c-synth-1')
    expect(SYNTHETIC_CRLF_CONTENT).toContain('\r\n')
    expect(chapter.body).not.toContain('\r')
    expect(chapter.body).toBe(SYNTHETIC_NORMALIZED)
    expect(chapter.body).toBe(normalizeBody(SYNTHETIC_CRLF_CONTENT))
  })

  it('字素簇字数来自 @yfe/domain 的 countChars，不是 String.length', async () => {
    const emoji = '👨‍👩‍👧‍👦'
    const result = await plan({ chapters: [{ ...(SYNTHETIC_MAIN['chapters'] as readonly Record<string, unknown>[])[0], content: emoji }] })
    const chapter = documentByLegacyId(result, 'c-synth-1')
    expect(chapter.charCount).toBe(countChars(emoji))
    expect(chapter.charCount).toBeLessThanOrEqual(emoji.length)
  })
})

describe('确定性 ID 映射', () => {
  it('两次规划同一夹具得到完全相同的 ID 与行集合（重跑不随机）', async () => {
    const first = await plan()
    const second = await plan()
    expect(JSON.stringify(second.rows)).toBe(JSON.stringify(first.rows))
    expect(second.workspaceId).toBe(first.workspaceId)
    expect(second.idStats).toEqual(first.idStats)
    expect(second.collisions).toEqual([])
  })

  it('ID 映射里记下「旧 ID → 新 ID」与所用策略，供幂等重跑核对', async () => {
    const result = await plan()
    const entry = result.idMapping.find((item) => item.legacyId === SYNTHETIC_PROJECT_ID && item.table === 'project')
    expect(entry?.newId).toBe(SYNTHETIC_PROJECT_ID)
    expect(entry?.strategy).toBe('verbatim')
    expect(entry?.canonicalKey).toContain(SYNTHETIC_PROJECT_ID)
    expect(result.idStats.verbatim).toBeGreaterThan(0)
  })

  it('同一个新 ID 被两个不同的旧实体抢占时改成派生 ID，并把冲突写进报告', async () => {
    const volumes = SYNTHETIC_MAIN['volumes'] as readonly Record<string, unknown>[]
    const duplicated = [volumes[0] as Record<string, unknown>, { ...(volumes[0] as Record<string, unknown>) }]
    const result = await plan({ volumes: duplicated })

    expect(result.collisions.length).toBeGreaterThan(0)
    expect(result.collisions[0]?.resolution).toBe('derived')
    const ids = documentsOf(result, 'volume').map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('M-04 / M-05 / M-06 设定与人物卡', () => {
  it('formData 的 tabId 原样成为 schema_template_id，data 整体进 values', async () => {
    const result = await plan()
    const entity = settingsOf(result).find((row) => row.schemaTemplateId === 'worldbase')
    expect(entity?.name).toBe('世界基底')
    expect(entity?.values).toMatchObject({ 名称: '世界基底', 地理: '合成大陆', 未知列: '保留我' })
  })

  it('tableRows 每行一个实体，并派生 relations(kind=reference)', async () => {
    const result = await plan()
    const row = settingsOf(result).find((item) => item.id === 'row-synth-1')
    expect(row?.schemaTemplateId).toBe('power')
    expect(row?.name).toBe('合成火系')

    const target = settingsOf(result).find((item) => item.origin.legacyId === 'row-synth-2')
    const relations = result.rows.filter((item): item is PlannedRelation => item.table === 'relation')
    const derived = relations.find((item) => item.fromEntityId === 'row-synth-1')
    expect(derived?.toEntityId).toBe(target?.id)
    expect(derived?.kind).toBe('reference')
    expect(derived?.label).toBe('引用')
  })

  it('人物卡模板 ID 用迁移矩阵里的 char-main / char-secondary / char-npc', async () => {
    const result = await plan()
    const cards = settingsOf(result).filter((row) => (LEGACY_CHARACTER_TEMPLATE_IDS as readonly string[]).includes(row.schemaTemplateId))
    expect(cards.map((row) => row.schemaTemplateId)).toContain('char-main')
  })

  it('人物卡子项按所选策略落 template id，并在报告里记明这个选择', async () => {
    const suffixed = await plan()
    expect(settingsOf(suffixed).map((row) => row.schemaTemplateId)).toContain('char-main-sub')
    expect(suffixed.notes.join('\n')).toContain('char-main')

    const inValues = await plan({}, { charSubItemMode: 'parent-in-values' as const })
    expect(settingsOf(inValues).map((row) => row.schemaTemplateId)).not.toContain('char-main-sub')
    expect(settingsOf(inValues).map((row) => row.schemaTemplateId)).toContain('char-main')
  })

  it('人物卡头像 dataURL 留在 values 里，并明确报告「资产外部化未做」', async () => {
    const result = await plan()
    const card = settingsOf(result).find((row) => row.origin.legacyId === 'card-synth-main')
    expect(card?.values['portrait']).toBe('data:image/png;base64,PORTRAIT')
    expect(result.warnings.some((warning) => warning.kind === 'not-implemented' && /assets/.test(warning.message))).toBe(true)
  })
})

describe('M-07 / M-08 / M-09 / M-10 / M-22', () => {
  it('settingsKV 剥掉 `<作品ID>::` 前缀，落到 scope=project', async () => {
    const result = await plan()
    const entry = configValuesOf(result).find((row) => row.key === 'checkLog')
    expect(entry?.scope).toBe('project')
    expect(entry?.ownerId).toBe(SYNTHETIC_PROJECT_ID)
  })

  it('🔴 敏感字段不落库：apiKey 在任何值里都找不到，但报告里有它的脱敏记录', async () => {
    const result = await plan()
    const payload = JSON.stringify(result.rows)
    expect(payload).not.toContain('sk-synthetic-must-not-be-written')
    const redacted = result.unmappedFields.find((entry) => entry.field === 'aiProviders')
    expect(redacted?.value).toBe('[redacted]')
    expect(result.warnings.some((warning) => warning.kind === 'redacted-sensitive')).toBe(true)
  })

  it('快照成为 revision：首版 seq=1，历史快照 2、3 递增，且不依赖 COUNT(*)', async () => {
    const result = await plan()
    const chapter = documentByLegacyId(result, 'c-synth-1')
    const seqs = revisionsOf(result)
      .filter((row) => row.entityId === chapter.id)
      .map((row) => row.seq)
      .sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3])

    // 重跑一次：seq 仍是 1,2,3（不是 4,5,6）——COUNT(*) 写法会给出后者。
    const again = await plan()
    const againSeqs = revisionsOf(again)
      .filter((row) => row.entityId === chapter.id)
      .map((row) => row.seq)
      .sort((a, b) => a - b)
    expect(againSeqs).toEqual([1, 2, 3])
  })

  it('回收站条目把对应文档标成 deleted=1，其余仍是 0，并把删除时间旁存', async () => {
    const result = await plan()
    const trashed = documentByLegacyId(result, 'c-synth-3')
    const alive = documentByLegacyId(result, 'c-synth-1')
    expect(trashed.deleted).toBe(1)
    expect(alive.deleted).toBe(0)
    const deletedAt = configValuesOf(result).find((row) => row.key === `${LEGACY_CONFIG_KEY.trash}.c-synth-3`)
    expect(deletedAt?.value).toBe('2024-02-02T00:00:00.000Z')
  })

  it('worlds / tavernReports / dailyStats 落到 plugin_data，而不是 settings_entities', async () => {
    const result = await plan()
    const pluginIds = pluginDataOf(result).map((row) => row.pluginId)
    expect(pluginIds).toContain(LEGACY_PLUGIN_ID.worldPack)
    expect(pluginIds).toContain(LEGACY_PLUGIN_ID.tavern)
    expect(pluginIds).toContain(LEGACY_PLUGIN_ID.stats)
    expect(settingsOf(result).some((row) => row.schemaTemplateId === 'builtin.world-pack')).toBe(false)
  })

  it('localStorage 的同步墓碑单独落键，绝不被丢弃', async () => {
    const result = buildImportPlan(await syntheticCollectionWithLocalStorage(), { now: NOW })
    const tombstone = configValuesOf(result).find((row) => row.key === LEGACY_CONFIG_KEY.syncTombstones)
    expect(tombstone?.scope).toBe('device')
    expect(tombstone?.value).toEqual({ deletedProjects: ['p-gone'] })
    // 普通 localStorage 键也要落库，且键名带前缀以免与 meta 撞名。
    expect(configValuesOf(result).some((row) => row.key === 'legacy.localStorage.yfe-theme')).toBe(true)
  })
})

describe('只登记不导入的部分', () => {
  it('只登记不导入的部分：备份、向量索引、同步文件都进 deferred 并在 notes 里说明原因', async () => {
    const result = buildImportPlan(await syntheticCollectionWithVectorIndex(), { now: NOW })
    const locations = result.deferred.map((entry) => entry.location)
    expect(locations).toContain('legacy-main/main/backups')
    expect(locations).toContain('legacy-main/main/backupPayloads')
    expect(locations).toContain('legacy-vec/vec/embeddings')
    expect(result.deferred.some((entry) => /向量/.test(entry.reason))).toBe(true)
    // M-14 未实现，但**必须有声有色地登记**：静默消失才是真正的 bug。
    expect(locations).toContain('legacy-main/main/aiRuns')
    expect(result.deferred.some((entry) => /M-14/.test(entry.reason))).toBe(true)
    expect(result.warnings.some((warning) => warning.location === 'legacy-main/main/aiRuns')).toBe(true)
    expect(result.notes.join('\n')).toContain('未导入：')
  })
})
