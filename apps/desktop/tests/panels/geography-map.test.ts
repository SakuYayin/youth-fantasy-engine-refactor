/**
 * geography-map 面板纯逻辑单测（node 环境，无 DOM）。
 *
 * 覆盖：GEO_MAPS_TAB 数据表契约核实、行 → 示意映射、「每格公里」解析、
 * 新建初始 values、提示文案与常量。
 */

import { describe, expect, it, vi } from 'vitest'

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'

import type { SettingsEntityView } from '../../src/renderer/app-state.js'
import {
  DEFAULT_KM_PER_CELL,
  LOAD_FAILED_NOTICE,
  SKETCH_CELLS_COARSE,
  SKETCH_CELLS_FINE,
  SKETCH_EMPTY_NOTICE,
  SKETCH_PREVIEW_NOTICE,
  SKETCH_TITLE,
  cellsForScale,
  deletePendingNotice,
  initialValuesForCreate,
  kmPerCellOf,
  mapRowsOf,
  newCreateKey,
  reorderPendingNotice,
  rowToSketch,
  rowsToSketches,
  sketchColor,
  submitFailureNotice,
  updateMissingRowNotice,
} from '../../src/renderer/panels/geography-map-model.js'

/** 构造一条《地图》行（SettingsEntityView 结构，字段与 app-state 契约一致）。 */
function makeRow(overrides: Partial<SettingsEntityView> = {}): SettingsEntityView {
  return {
    id: 'row-1',
    projectId: 'project-1',
    schemaTemplateId: 'geomaps',
    name: '地图',
    values: {},
    orderKey: 'A01',
    revision: 'r00000001',
    deleted: false,
    ...overrides,
  }
}

describe('GEO_MAPS_TAB 数据表契约核实', () => {
  it('id=geomaps、type=table、分组=世界构建、名称=地图', () => {
    expect(GEO_MAPS_TAB.id).toBe('geomaps')
    expect(GEO_MAPS_TAB.type).toBe('table')
    expect(GEO_MAPS_TAB.group).toBe('世界构建')
    expect(GEO_MAPS_TAB.name).toBe('地图')
  })

  it('列顺序 = 编号/名称/每格公里/说明/底图模式/底图；每格公里档位 1/10；底图两列 hidden', () => {
    const columns = GEO_MAPS_TAB.columns
    if (columns === undefined) throw new Error('GEO_MAPS_TAB 缺 columns（数据表必须有列）')
    expect(columns.map((column) => column.name)).toEqual([
      '编号',
      '名称',
      '每格公里',
      '说明',
      '底图模式',
      '底图',
    ])
    const km = columns.find((column) => column.name === '每格公里')
    expect(km?.options).toEqual(['1', '10'])
    expect(
      columns
        .filter((column) => column.hidden === true)
        .map((column) => column.name),
    ).toEqual(['底图模式', '底图'])
    expect(GEO_MAPS_TAB.displayCol).toBe('名称')
    expect(GEO_MAPS_TAB.subtitleCol).toBe('每格公里')
  })
})

describe('「每格公里」解析（kmPerCellOf）', () => {
  it('档位字符串与数字照常解析', () => {
    expect(kmPerCellOf('1')).toBe(1)
    expect(kmPerCellOf('10')).toBe(10)
    expect(kmPerCellOf(' 10 ')).toBe(10)
    expect(kmPerCellOf('1.5')).toBe(1.5)
    expect(kmPerCellOf(10)).toBe(10)
    expect(kmPerCellOf(2.5)).toBe(2.5)
  })

  it('空值/非数/非正数兜底为默认档', () => {
    expect(DEFAULT_KM_PER_CELL).toBe(1)
    expect(kmPerCellOf('')).toBe(1)
    expect(kmPerCellOf('abc')).toBe(1)
    expect(kmPerCellOf('0')).toBe(1)
    expect(kmPerCellOf(0)).toBe(1)
    expect(kmPerCellOf(-5)).toBe(1)
    expect(kmPerCellOf(null)).toBe(1)
    expect(kmPerCellOf(undefined)).toBe(1)
  })
})

describe('示意映射（rowToSketch / rowsToSketches）', () => {
  it('cellsForScale：精细档（≤1 公里）12 格，粗略档 6 格', () => {
    expect(SKETCH_CELLS_FINE).toBe(12)
    expect(SKETCH_CELLS_COARSE).toBe(6)
    expect(cellsForScale(1)).toBe(12)
    expect(cellsForScale(0.5)).toBe(12)
    expect(cellsForScale(1.5)).toBe(6)
    expect(cellsForScale(10)).toBe(6)
  })

  it('rowToSketch：名称取「名称」列，空值退回实体名', () => {
    const sketch = rowToSketch(
      makeRow({ values: { 名称: '东海', 每格公里: '1' } }),
    )
    expect(sketch.id).toBe('row-1')
    expect(sketch.name).toBe('东海')
    expect(sketch.kmPerCell).toBe(1)
    expect(sketch.cells).toBe(12)
    expect(sketch.color).toBe(sketchColor('东海'))
    expect(sketch.kmLabel).toBe('每格公里：1')

    const fallback = rowToSketch(makeRow({ name: '无名之地', values: { 每格公里: '10' } }))
    expect(fallback.name).toBe('无名之地')
    expect(fallback.cells).toBe(6)
    expect(fallback.kmLabel).toBe('每格公里：10')
  })

  it('sketchColor：同名同色、hsl 格式稳定', () => {
    expect(sketchColor('东海')).toBe(sketchColor('东海'))
    expect(sketchColor('东海')).toMatch(/^hsl\(\d+, 45%, 52%\)$/)
  })

  it('rowsToSketches：按 orderKey 升序与清单表同序，过滤 deleted 行', () => {
    const rows = [
      makeRow({ id: 'row-b', orderKey: 'A02', values: { 名称: '西荒', 每格公里: '10' } }),
      makeRow({ id: 'row-a', orderKey: 'A01', values: { 名称: '东海', 每格公里: '1' } }),
      makeRow({ id: 'row-x', orderKey: 'A03', deleted: true, values: { 名称: '已删' } }),
    ]
    const sketches = rowsToSketches(rows)
    expect(sketches.map((sketch) => sketch.id)).toEqual(['row-a', 'row-b'])
    expect(rowsToSketches([])).toEqual([])
  })

  it('mapRowsOf：只取《地图》模板的未删行（快照防御性过滤）', () => {
    const rows = [
      makeRow({ id: 'row-a', schemaTemplateId: 'geomaps' }),
      makeRow({ id: 'row-b', schemaTemplateId: 'geography' }),
      makeRow({ id: 'row-c', schemaTemplateId: 'geomaps', deleted: true }),
    ]
    expect(mapRowsOf(rows).map((row) => row.id)).toEqual(['row-a'])
  })
})

describe('新建行（initialValuesForCreate）', () => {
  it('名称预填建议名，每格公里按旧版默认 1，编号/说明留空', () => {
    expect(initialValuesForCreate('地图')).toEqual({ 名称: '地图', 每格公里: '1' })
  })
})

describe('提示文案与常量（可见文本 ⊆ 页签文案 ∪ 这里）', () => {
  it('示意图文案常量', () => {
    expect(SKETCH_TITLE).toBe('地图示意')
    expect(SKETCH_PREVIEW_NOTICE).toBe('预览版简化视图（完整画布编辑器后续批次）')
    expect(SKETCH_EMPTY_NOTICE).toBe('还没有地图：在下方表格点「+」新建一张。')
    expect(LOAD_FAILED_NOTICE).toBe('地图清单载入失败：请重试，或检查数据库连接。')
  })

  it('删除/重排只显回执，不假装成功', () => {
    expect(deletePendingNotice('row-1')).toBe(
      '「删除地图」还没接入（应用层仓储删除通道）：row-1 保持原样。',
    )
    expect(reorderPendingNotice('row-1', 'row-2')).toBe(
      '「调整顺序」还没接入（需要应用层生成 orderKey）：row-1 → row-2。',
    )
    expect(reorderPendingNotice('row-1', null)).toBe(
      '「调整顺序」还没接入（需要应用层生成 orderKey）：row-1 → 末尾。',
    )
  })

  it('更新缺行/提交失败的回执格式', () => {
    expect(updateMissingRowNotice('row-1')).toBe(
      '这一行已经不在当前地图清单里（row-1）：请刷新页签后重试。',
    )
    expect(submitFailureNotice('VALIDATION_MISSING_FIELD', '还没有作品，先新建作品再保存设定。')).toBe(
      'VALIDATION_MISSING_FIELD：还没有作品，先新建作品再保存设定。',
    )
  })

  it('newCreateKey：面板前缀；时间推进后新键（一次「+」一个键，双击不重复建）', () => {
    vi.useFakeTimers()
    try {
      const first = newCreateKey('geomaps')
      expect(first.startsWith('panel:geomaps:')).toBe(true)
      vi.setSystemTime(new Date(Date.now() + 5))
      expect(newCreateKey('geomaps')).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('newCreateKey：同一毫秒内的两次新建也是不同键（序号兜底时钟分辨率）', () => {
    vi.useFakeTimers()
    try {
      const first = newCreateKey('geomaps')
      const second = newCreateKey('geomaps')
      expect(second).not.toBe(first)
      expect(second.startsWith('panel:geomaps:')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
