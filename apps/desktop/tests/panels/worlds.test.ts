/**
 * 世界引擎面板纯逻辑（worlds-model）的测试：分组 / 汇总 / 排序 / 文案。
 *
 * node 环境（纯函数，无 DOM）。
 */
import { describe, expect, it } from 'vitest'

import { getTab } from '@yfe/schema-tabs'

import {
  WORLDS_PANEL_TEXT,
  WORLD_TEMPLATE_META,
  formatUpdatedAt,
  groupEntitiesByTemplate,
  overviewLine,
  summarizeTemplate,
  type WorldEntityInput,
} from '../../src/renderer/panels/worlds-model.js'

/** 构造最小实体（与视图契约 SettingsEntityView 结构兼容：额外字段原样接受）。 */
function entity(input: {
  schemaTemplateId: string
  deleted?: boolean
  updatedAt?: string
}): WorldEntityInput {
  // 先推断出全量实体再返回：额外字段是 SettingsEntityView 的字段，
  // 结构子类型化后证明视图实体可直接传入（字面量直返会触发多余属性检查）。
  const viewEntity = {
    id: `id-${input.schemaTemplateId}-${input.updatedAt ?? 'none'}`,
    projectId: 'project_1',
    revision: 'r1',
    values: {},
    orderKey: 'k',
    schemaTemplateId: input.schemaTemplateId,
    deleted: input.deleted ?? false,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  }
  return viewEntity
}

describe('groupEntitiesByTemplate：分组与计数', () => {
  it('空列表返回空数组', () => {
    expect(groupEntitiesByTemplate([])).toEqual([])
  })

  it('已删除条目被过滤，未删条目按模板分组计数', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'worldbase', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'worldbase', deleted: true }),
      entity({ schemaTemplateId: 'nations' }),
    ])
    expect(groups.map((group) => group.templateId)).toEqual(['worldbase', 'nations'])
    expect(groups[0]?.summary.count).toBe(2)
    expect(groups[1]?.summary.count).toBe(1)
  })

  it('同一模板只出一张卡：条目列表挂在分组上', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'worldbase' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.entities).toHaveLength(3)
    expect(groups[0]?.summary.count).toBe(3)
  })

  it('已知模板显示中文页签名与侧栏分组', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'politics' }),
      entity({ schemaTemplateId: 'misc-settings' }),
    ])
    const byId = new Map(groups.map((group) => [group.templateId, group]))
    expect(byId.get('worldbase')?.templateName).toBe('世界设定')
    expect(byId.get('worldbase')?.group).toBe('开书定位')
    expect(byId.get('worldbase')?.known).toBe(true)
    expect(byId.get('politics')?.templateName).toBe('政治架构')
    expect(byId.get('politics')?.group).toBe('开书定位')
    expect(byId.get('misc-settings')?.templateName).toBe('其他设定')
    expect(byId.get('misc-settings')?.group).toBe('世界构建')
  })

  it('未知模板不丢弃：排在世界相关模板之后，显示模板 id 本身并标「未知模板」', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'custom-thing' }),
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'another-one' }),
    ])
    expect(groups.map((group) => group.templateId)).toEqual([
      'worldbase',
      'another-one',
      'custom-thing',
    ])
    const unknown = groups[1]
    expect(unknown?.known).toBe(false)
    expect(unknown?.templateName).toBe('another-one')
    expect(unknown?.group).toBe(WORLDS_PANEL_TEXT.unknownGroup)
  })

  it('最近更新时间取 updatedAt 最大值并透传到汇总', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'worldbase', updatedAt: '2026-01-02T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'worldbase', updatedAt: '2026-03-04T00:00:00.000Z' }),
    ])
    expect(groups[0]?.summary.latestUpdatedAt).toBe('2026-03-04T00:00:00.000Z')
  })

  it('视图实体没有 updatedAt 时汇总得 null', () => {
    const groups = groupEntitiesByTemplate([entity({ schemaTemplateId: 'worldbase' })])
    expect(groups[0]?.summary.latestUpdatedAt).toBeNull()
  })
})

describe('排序键', () => {
  it('count 主键（默认）：条数多在前，并列时更新时间新在前，再并列按模板 id', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'nations', updatedAt: '2026-06-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'power', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'power', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ])
    expect(groups.map((group) => group.templateId)).toEqual(['justice', 'power', 'nations'])
  })

  it('count 并列且都无时间数据时按模板 id 字典序', () => {
    const groups = groupEntitiesByTemplate([
      entity({ schemaTemplateId: 'terms' }),
      entity({ schemaTemplateId: 'items' }),
      entity({ schemaTemplateId: 'history' }),
    ])
    expect(groups.map((group) => group.templateId)).toEqual(['history', 'items', 'terms'])
  })

  it('recent：更新时间新在前，无时间数据的组排最后（并列回退条数）', () => {
    const groups = groupEntitiesByTemplate(
      [
        entity({ schemaTemplateId: 'power' }),
        entity({ schemaTemplateId: 'power' }),
        entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
        entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
        entity({ schemaTemplateId: 'nations', updatedAt: '2026-06-01T00:00:00.000Z' }),
      ],
      { sortBy: 'recent' },
    )
    expect(groups.map((group) => group.templateId)).toEqual(['nations', 'justice', 'power'])
  })
})

describe('summarizeTemplate：单模板汇总', () => {
  it('未删条数 + 最近更新时间（已删除条目不计入）', () => {
    const summary = summarizeTemplate([
      entity({ schemaTemplateId: 'worldbase', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'worldbase', updatedAt: '2026-05-06T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'worldbase', deleted: true, updatedAt: '2026-09-09T00:00:00.000Z' }),
    ])
    expect(summary.templateId).toBe('worldbase')
    expect(summary.count).toBe(2)
    expect(summary.latestUpdatedAt).toBe('2026-05-06T00:00:00.000Z')
  })

  it('空列表返回空模板 id 的占位汇总', () => {
    const summary = summarizeTemplate([])
    expect(summary.templateId).toBe('')
    expect(summary.templateName).toBe('')
    expect(summary.known).toBe(false)
    expect(summary.count).toBe(0)
    expect(summary.latestUpdatedAt).toBeNull()
  })
})

describe('formatUpdatedAt 与文案', () => {
  it('ISO 时间格式化为 YYYY-MM-DD HH:mm（本地时区）', () => {
    const iso = '2026-03-04T05:06:00.000Z'
    const date = new Date(iso)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    expect(formatUpdatedAt(iso)).toBe(expected)
  })

  it('无数据 / 空串 / 非法时间都显示占位文案', () => {
    expect(formatUpdatedAt(null)).toBe(WORLDS_PANEL_TEXT.missingUpdatedAt)
    expect(formatUpdatedAt('')).toBe(WORLDS_PANEL_TEXT.missingUpdatedAt)
    expect(formatUpdatedAt('not-a-date')).toBe(WORLDS_PANEL_TEXT.missingUpdatedAt)
  })

  it('总览行拼接条数与模板数', () => {
    expect(overviewLine(7, 3)).toBe('共 7 条设定，覆盖 3 个模板')
  })

  it('卡片编辑引导是固定文案（面板没有切页签能力）', () => {
    expect(WORLDS_PANEL_TEXT.editHint).toBe('请到侧栏对应页签编辑')
  })
})

describe('WORLD_TEMPLATE_META：与真实页签注册表一致', () => {
  it('每个已知模板都能在 @yfe/schema-tabs 解析，且分组一致', () => {
    expect(WORLD_TEMPLATE_META).toHaveLength(15)
    for (const meta of WORLD_TEMPLATE_META) {
      const tab = getTab(meta.id)
      expect(tab, `页签 ${meta.id} 应存在于 @yfe/schema-tabs`).toBeDefined()
      expect(tab?.group, `页签 ${meta.id} 的分组`).toBe(meta.group)
    }
  })

  it('开书定位 6 页签与 世界构建 数据页签都在清单里；本页 worlds 不在', () => {
    const ids = WORLD_TEMPLATE_META.map((meta) => meta.id)
    for (const id of ['worldbase', 'power', 'politics', 'economy', 'belief', 'justice']) {
      expect(ids).toContain(id)
    }
    for (const id of ['nations', 'faction-rels', 'geography', 'geography-map', 'races', 'items', 'history', 'terms', 'misc-settings']) {
      expect(ids).toContain(id)
    }
    expect(ids).not.toContain('worlds')
  })
})
