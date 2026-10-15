/**
 * W3 纯函数层单测（`schema-table.ts`）。
 *
 * 这些函数没有 DOM、没有 IPC —— 全部是「元数据 + 行 ⇒ 展示结果」的纯计算，
 * 所以本文件跑在默认的 node 环境里（不需要 happy-dom）。组件行为见
 * `tab-table-view.test.ts`。
 *
 * 夹具刻意用**中文存储键**（`名称` / `编号` / `所属势力`）：§1 规定 `values` 的键就是
 * `TabColumn.name`，用例里写英文键会掩盖「键被改名 / 被翻译」这类事故。
 */
import type { ProjectId, Revision, SettingsEntity, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { TabDef, TableColumn } from '@yfe/schema-tabs'
import { describe, expect, it } from 'vitest'

import {
  cellText,
  editableCell,
  nextRowName,
  sortRows,
  visibleColumns,
} from '../src/renderer/schema/schema-table.js'

function makeRow(input: {
  id: string
  name?: string
  values?: Record<string, unknown>
  orderKey?: string
  createdAt?: string
}): SettingsEntity {
  return {
    id: input.id,
    workspaceId: 'ws_0000000000000000000000000' as WorkspaceId,
    projectId: 'prj_00000000000000000000000' as ProjectId,
    schemaTemplateId: 'tpl',
    name: input.name ?? '',
    values: input.values ?? {},
    orderKey: input.orderKey ?? 'a0',
    revision: 'r00000001' as Revision,
    deleted: 0,
    createdAt: (input.createdAt ?? '2026-01-01T00:00:00.000Z') as UtcTimestamp,
    updatedAt: (input.createdAt ?? '2026-01-01T00:00:00.000Z') as UtcTimestamp,
  }
}

function makeTab(input: Partial<TabDef> & Pick<TabDef, 'id' | 'name'>): TabDef {
  return {
    group: '世界构建',
    type: 'table',
    description: `${input.name}的说明`,
    ...input,
  }
}

describe('visibleColumns', () => {
  it('过滤 hidden 列并保持原有列顺序', () => {
    const columns: TableColumn[] = [
      { name: '名称' },
      { name: '地图X', hidden: true },
      { name: '所属势力', type: 'tableRef' },
      { name: '备注', type: 'textarea' },
    ]
    const tab = makeTab({ id: 'geo', name: '地理风物', columns })

    expect(visibleColumns(tab).map((column) => column.name)).toEqual(['名称', '所属势力', '备注'])
  })

  it('不改动元数据本身（hidden 列仍在 tab.columns 里，数据不丢）', () => {
    const columns: TableColumn[] = [{ name: '名称' }, { name: '地图Y', hidden: true }]
    const tab = makeTab({ id: 'geo', name: '地理风物', columns })

    visibleColumns(tab)

    expect(tab.columns).toHaveLength(2)
    expect(tab.columns?.[1]?.hidden).toBe(true)
  })

  it('hidden === false 的列照常渲染', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '名称', hidden: false }] })

    expect(visibleColumns(tab).map((column) => column.name)).toEqual(['名称'])
  })

  it('没有 columns 的页签返回空数组', () => {
    const tab = makeTab({ id: 'none', name: '空表' })

    expect(visibleColumns(tab)).toEqual([])
  })
})

describe('cellText', () => {
  const text = (column: TableColumn, values: Record<string, unknown>): string =>
    cellText(column, makeRow({ id: 'r1', values }))

  it('按列名（中文存储键）取值，不做别名回退', () => {
    expect(text({ name: '名称' }, { 名称: '青岚宗', name: 'ignored' })).toBe('青岚宗')
    expect(text({ name: '名称' }, { name: 'ignored' })).toBe('')
  })

  it('text / textarea / select / calendar 原样返回', () => {
    expect(text({ name: '备注', type: 'textarea' }, { 备注: '多行\n文本' })).toBe('多行\n文本')
    expect(text({ name: '类型', type: 'select', options: ['甲', '乙'] }, { 类型: '甲' })).toBe('甲')
    expect(text({ name: '历法', type: 'calendar', calendar: true }, { 历法: '灵历' })).toBe('灵历')
  })

  it('数字列：数字与字符串都原样显示，不做千分位', () => {
    expect(text({ name: '战力', type: 'number' }, { 战力: 1000000 })).toBe('1000000')
    expect(text({ name: '战力', type: 'number' }, { 战力: ' 7 ' })).toBe('7')
    expect(text({ name: '战力', type: 'number' }, { 战力: Number.NaN })).toBe('')
  })

  it('日期列：ISO 时间戳只显示到日，旧版手写的中文日期原样保留', () => {
    expect(text({ name: '发生时间', type: 'date' }, { 发生时间: '3024-03-01T10:20:30.000Z' })).toBe('3024-03-01')
    expect(text({ name: '发生时间', type: 'date' }, { 发生时间: '3024-03-01 10:20' })).toBe('3024-03-01')
    expect(text({ name: '发生时间', type: 'date' }, { 发生时间: '3024年3月' })).toBe('3024年3月')
  })

  it('characters 列：数组与多种分隔符都统一成顿号连接', () => {
    expect(text({ name: '涉及角色', type: 'characters' }, { 涉及角色: ['甲', '乙', '丙'] })).toBe('甲、乙、丙')
    expect(text({ name: '涉及角色', type: 'characters' }, { 涉及角色: '甲,乙，丙;丁' })).toBe('甲、乙、丙、丁')
    expect(text({ name: '涉及角色', type: 'characters' }, { 涉及角色: ['甲', '', '  '] })).toBe('甲')
    expect(text({ name: '涉及角色', type: 'characters' }, {})).toBe('')
  })

  it('tableRef 列显示引用名（字符串 / 对象 / 数组三种落库形态）', () => {
    const column: TableColumn = { name: '所属势力', type: 'tableRef', refTab: 'nations', refCol: '名称' }
    expect(text(column, { 所属势力: '青岚宗' })).toBe('青岚宗')
    expect(text(column, { 所属势力: { id: 'n1', label: '青岚宗' } })).toBe('青岚宗')
    expect(text(column, { 所属势力: ['青岚宗', '赤炎门'] })).toBe('青岚宗、赤炎门')
  })

  it('null / undefined / 未知键都归一到空串', () => {
    expect(text({ name: '名称' }, { 名称: null })).toBe('')
    expect(text({ name: '名称' }, {})).toBe('')
  })

  it('values 缺失（脏数据）时不抛异常', () => {
    const broken = { ...makeRow({ id: 'r1' }), values: undefined } as unknown as SettingsEntity

    expect(cellText({ name: '名称' }, broken)).toBe('')
  })
})

describe('editableCell', () => {
  it('普通列可行内编辑', () => {
    expect(editableCell({ name: '名称' })).toBe(true)
    expect(editableCell({ name: '备注', type: 'textarea' })).toBe(true)
    expect(editableCell({ name: '战力', type: 'number' })).toBe(true)
    expect(editableCell({ name: '类型', type: 'select', options: ['甲'] })).toBe(true)
    expect(editableCell({ name: '涉及角色', type: 'characters' })).toBe(true)
  })

  it('tableRef 列不可自由输入（只能从来源表已有的值里选）', () => {
    expect(editableCell({ name: '所属势力', type: 'tableRef', refTab: 'nations', refCol: '名称' })).toBe(false)
  })

  it('hidden 列不渲染，也就谈不上编辑', () => {
    expect(editableCell({ name: '地图X', hidden: true })).toBe(false)
  })
})

describe('sortRows', () => {
  const rows = [
    makeRow({ id: 'r2', orderKey: 'a2', createdAt: '2026-02-01T00:00:00.000Z' }),
    makeRow({ id: 'r1', orderKey: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }),
    makeRow({ id: 'r3', orderKey: 'a3', createdAt: '2026-03-01T00:00:00.000Z' }),
  ]

  it('默认按 orderKey 升序（持久化层生成的行序）', () => {
    const tab = makeTab({ id: 'nations', name: '国家势力' })

    expect(sortRows(tab, rows).map((row) => row.id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('newestFirst 取反：越新创建越靠上', () => {
    const tab = makeTab({ id: 'chapter-master', name: '章节总表', newestFirst: true })

    expect(sortRows(tab, rows).map((row) => row.id)).toEqual(['r3', 'r2', 'r1'])
  })

  it('不修改入参数组', () => {
    const input = [...rows]
    sortRows(makeTab({ id: 'nations', name: '国家势力' }), input)

    expect(input.map((row) => row.id)).toEqual(['r2', 'r1', 'r3'])
  })

  it('orderKey 相同的行在 newestFirst 下按 createdAt 兜底降序', () => {
    const same = [
      makeRow({ id: 'old', orderKey: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ id: 'new', orderKey: 'a1', createdAt: '2026-05-01T00:00:00.000Z' }),
    ]

    expect(sortRows(makeTab({ id: 'ch', name: '总表', newestFirst: true }), same).map((row) => row.id)).toEqual(['new', 'old'])
  })

  it('空表与单行表原样返回', () => {
    const tab = makeTab({ id: 'nations', name: '国家势力' })

    expect(sortRows(tab, [])).toEqual([])
    expect(sortRows(tab, [rows[0] as SettingsEntity]).map((row) => row.id)).toEqual(['r2'])
  })
})

describe('nextRowName', () => {
  it('没有任何占用时直接用页签名（中文文案来自 TabDef）', () => {
    const tab = makeTab({ id: 'characters', name: '角色卡' })

    expect(nextRowName(tab, [])).toBe('角色卡')
  })

  it('页签名被占用后补最小空号', () => {
    const tab = makeTab({ id: 'characters', name: '角色卡' })
    const rows = [
      makeRow({ id: 'r1', name: '角色卡' }),
      makeRow({ id: 'r2', name: '角色卡 1' }),
    ]

    expect(nextRowName(tab, rows)).toBe('角色卡 2')
  })

  it('displayCol 上的展示名也算占用（§1：展示名与 name 同一命名空间）', () => {
    const tab = makeTab({ id: 'characters', name: '角色卡', displayCol: '名称' })
    const rows = [
      makeRow({ id: 'r1', name: '', values: { 名称: '角色卡' } }),
      makeRow({ id: 'r2', name: '角色卡 2' }),
    ]

    expect(nextRowName(tab, rows)).toBe('角色卡 1')
  })

  it('页签名为空串时退回 tab.id，保证返回值非空', () => {
    const tab = makeTab({ id: 'characters', name: '' })

    expect(nextRowName(tab, [])).toBe('characters')
  })
})
