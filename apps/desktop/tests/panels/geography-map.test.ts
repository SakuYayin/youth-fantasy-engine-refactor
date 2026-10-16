/**
 * 地图编辑面板 · 纯逻辑单测（W9-4 / C-08 手绘格子画布）。
 *
 * 覆盖 `apps/desktop/src/renderer/panels/geography-map-model.ts`：格子模型（涂 / 擦 / 清空 /
 * 缩放保留重叠区 / 拖拽直线补格 / 键盘光标）、序列化与**默认值容错反序列化**（旧数据回落）、
 * 统计量、行 → 画布视图映射、面板文案与回执。
 *
 * 无 DOM（node 环境）：本文件只测纯函数；组件接线在 `geography-map.view.test.ts`。
 */

import { describe, expect, it } from 'vitest'

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'

import type { SettingsEntityView } from '../../src/renderer/app-state.js'
import {
  CELL_SIZE_PX,
  COARSE_KM_PER_CELL,
  DEFAULT_CELL_COLOR,
  DEFAULT_GRID_HEIGHT,
  DEFAULT_GRID_WIDTH,
  DEFAULT_KM_PER_CELL,
  FINE_KM_PER_CELL,
  GRID_CELLS_KEY,
  GRID_COLORS,
  GRID_COLORS_KEY,
  GRID_HEIGHT_KEY,
  GRID_MAX_DIM,
  GRID_TOOLS,
  GRID_WIDTH_KEY,
  LOAD_FAILED_NOTICE,
  MAP_PANEL_TEXT,
  MAP_SAVE_STATE_TEXT,
  cellKey,
  clearGrid,
  colorLabelOf,
  createGrid,
  deletePendingNotice,
  deserializeGrid,
  eraseCell,
  eraseStroke,
  formatCellAriaLabel,
  formatCellCount,
  formatCellCoord,
  formatCellState,
  formatColorCount,
  formatCursor,
  formatGridSize,
  formatKmPerCell,
  formatMapCount,
  formatScaleChangedNotice,
  formatSizeChangedNotice,
  formatStatsText,
  gridStats,
  initialValuesForCreate,
  isInside,
  kmPerCellOf,
  mapColor,
  mapRowsOf,
  mapViewsOf,
  moveCursor,
  newCreateKey,
  normalizeCellColor,
  paintCell,
  paintStroke,
  pointOfKey,
  reorderPendingNotice,
  resizeGrid,
  serializeGrid,
  strokeCells,
  submitFailureNotice,
  updateMissingRowNotice,
  valuesWithGrid,
} from '../../src/renderer/panels/geography-map-model.js'

/** 设定实体行夹具（AppState 快照行）。 */
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

/** 涂过的缺省网格（3 × 3，含两种颜色）。 */
function paintedGrid() {
  let grid = createGrid(3, 3)
  grid = paintCell(grid, { x: 0, y: 0 })
  grid = paintCell(grid, { x: 1, y: 1 }, '#f0a4a4')
  grid = paintCell(grid, { x: 2, y: 2 }, '#f0a4a4')
  return grid
}

// ==================== 文案与回执 ====================

describe('地理面板 · 文案与回执', () => {
  it('面板文案齐全、非空且都是中文（可见文本的唯一来源）', () => {
    const entries = Object.entries(MAP_PANEL_TEXT)
    expect(entries.length).toBeGreaterThan(20)
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe('string')
      expect(value.length, key).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fff]/u.test(value), key).toBe(true)
    }
    expect(MAP_PANEL_TEXT.toolSelect).toBe('选择')
    expect(MAP_PANEL_TEXT.toolBrush).toBe('画笔')
    expect(MAP_PANEL_TEXT.toolEraser).toBe('橡皮')
    expect(MAP_PANEL_TEXT.clear).toBe('清空')
    expect(MAP_PANEL_TEXT.scaleFine).toBe('精')
    expect(MAP_PANEL_TEXT.scaleCoarse).toBe('粗')
  })

  it('保存状态文案三态齐全；工具条三件套带中文提示', () => {
    expect(MAP_SAVE_STATE_TEXT.saved).toBe('已保存')
    expect(MAP_SAVE_STATE_TEXT.saving).toBe('保存中')
    expect(MAP_SAVE_STATE_TEXT.error).toBe('保存失败')
    expect(GRID_TOOLS.map((option) => option.id)).toEqual(['select', 'brush', 'eraser'])
    for (const option of GRID_TOOLS) {
      expect(option.hint.length).toBeGreaterThan(0)
    }
  })

  it('载入失败与提交失败回执：中文说明 + 错误码原因', () => {
    expect(LOAD_FAILED_NOTICE).toContain('载入失败')
    expect(submitFailureNotice('REVISION_CONFLICT', '版本过期')).toBe('REVISION_CONFLICT：版本过期')
  })

  it('删除 / 重排 / 更新缺失回执都点名具体 id，且不假装成功', () => {
    expect(deletePendingNotice('row-1')).toContain('row-1')
    expect(deletePendingNotice('row-1')).toContain('还没接入')
    expect(reorderPendingNotice('row-1', 'row-2')).toContain('row-1 → row-2')
    expect(reorderPendingNotice('row-1', null)).toContain('末尾')
    expect(updateMissingRowNotice('row-9')).toContain('row-9')
  })

  it('新建幂等键：每次不同、含页签 id（双击不会建出两张图）', () => {
    const first = newCreateKey(GEO_MAPS_TAB.id)
    const second = newCreateKey(GEO_MAPS_TAB.id)
    expect(first).toContain(GEO_MAPS_TAB.id)
    expect(first).not.toBe(second)
  })
})

// ==================== 每格公里与计数文案 ====================

describe('地理面板 · 每格公里与计数文案', () => {
  it('kmPerCellOf：合法正数照收，空/非法/非正数回落缺省 1', () => {
    expect(kmPerCellOf('1')).toBe(FINE_KM_PER_CELL)
    expect(kmPerCellOf('10')).toBe(COARSE_KM_PER_CELL)
    expect(kmPerCellOf(5)).toBe(5)
    expect(kmPerCellOf(' 2.5 ')).toBe(2.5)
    expect(kmPerCellOf('')).toBe(DEFAULT_KM_PER_CELL)
    expect(kmPerCellOf('abc')).toBe(DEFAULT_KM_PER_CELL)
    expect(kmPerCellOf('-3')).toBe(DEFAULT_KM_PER_CELL)
    expect(kmPerCellOf(undefined)).toBe(DEFAULT_KM_PER_CELL)
    expect(kmPerCellOf({})).toBe(DEFAULT_KM_PER_CELL)
  })

  it('公里 / 尺寸 / 计数文案', () => {
    expect(formatKmPerCell(10)).toBe('每格 10 公里')
    expect(formatScaleChangedNotice(10)).toBe('每格公里已切到 10。')
    expect(formatSizeChangedNotice(8, 6)).toBe('画布尺寸已改为 8 × 6。')
    expect(formatGridSize(16, 10)).toBe('16 × 10')
    expect(formatMapCount(2)).toBe('共 2 张地图')
    expect(formatCellCount(3)).toBe('已绘制 3 格')
    expect(formatCellCoord({ x: 0, y: 1 })).toBe('第 1 列 第 2 行')
    expect(formatCursor(null)).toContain(MAP_PANEL_TEXT.cursorNone)
    expect(formatCursor({ x: 1, y: 1 })).toContain('第 2 列 第 2 行')
  })

  it('颜色文案与格子无障碍标签：调色板内取中文名，调色板外显色值', () => {
    expect(colorLabelOf('#f0a4a4')).toBe('伏笔')
    expect(colorLabelOf('#F0A4A4')).toBe('伏笔')
    expect(colorLabelOf('#123456')).toBe('#123456')
    expect(formatColorCount('#89d0c4'.replace('89', '8f'), 2)).toBe('角色 2 格')
    expect(formatCellState(true)).toBe(MAP_PANEL_TEXT.painted)
    expect(formatCellState(false)).toBe(MAP_PANEL_TEXT.unpainted)
    const aria = formatCellAriaLabel({ x: 2, y: 0 }, true, '#f0a4a4')
    expect(aria).toContain('第 3 列 第 1 行')
    expect(aria).toContain('已绘制')
    expect(aria).toContain('伏笔')
    expect(formatCellAriaLabel({ x: 0, y: 0 }, false, DEFAULT_CELL_COLOR)).toContain('未绘制')
  })

  it('调色板：缺省色在表内，色值都是 #rrggbb', () => {
    expect(GRID_COLORS.length).toBe(4)
    expect(GRID_COLORS.some((option) => option.color === DEFAULT_CELL_COLOR)).toBe(true)
    for (const option of GRID_COLORS) {
      expect(option.color).toMatch(/^#[0-9a-f]{6}$/u)
    }
    expect(CELL_SIZE_PX).toBe(36)
    expect(GRID_MAX_DIM).toBe(60)
  })
})

// ==================== 行 → 画布视图 ====================

describe('地理面板 · 行映射', () => {
  it('mapRowsOf：只留《地图》模板的未删行', () => {
    const rows = [
      makeRow({ id: 'keep' }),
      makeRow({ id: 'other', schemaTemplateId: 'characters' }),
      makeRow({ id: 'gone', deleted: true }),
    ]
    expect(mapRowsOf(rows).map((row) => row.id)).toEqual(['keep'])
  })

  it('mapViewsOf：按 orderKey 升序，名称取「名称」列，旧数据回落缺省网格', () => {
    const views = mapViewsOf([
      makeRow({ id: 'b', orderKey: 'A02', values: { 名称: '北境', 每格公里: '10' } }),
      makeRow({ id: 'a', orderKey: 'A01', values: { 名称: '南陆', 每格公里: '1' } }),
      makeRow({ id: 'c', orderKey: 'A03', deleted: true, values: { 名称: '删掉的' } }),
    ])
    expect(views.map((view) => view.id)).toEqual(['a', 'b'])
    expect(views[0]?.name).toBe('南陆')
    expect(views[0]?.kmPerCell).toBe(FINE_KM_PER_CELL)
    expect(views[1]?.kmPerCell).toBe(COARSE_KM_PER_CELL)
    // 旧数据：只有色块（名称）没有尺寸 ⇒ 缺省 16 × 10 空网格，不抛异常
    expect(views[0]?.grid.width).toBe(DEFAULT_GRID_WIDTH)
    expect(views[0]?.grid.height).toBe(DEFAULT_GRID_HEIGHT)
    expect(views[0]?.grid.cells.size).toBe(0)
    expect(views[0]?.color).toBe(mapColor('南陆'))
  })

  it('mapViewsOf：名称列为空时退回实体名', () => {
    const views = mapViewsOf([makeRow({ id: 'a', name: '实体名', values: {} })])
    expect(views[0]?.name).toBe('实体名')
  })

  it('initialValuesForCreate：预填名称与缺省每格公里，不预填画布尺寸', () => {
    const values = initialValuesForCreate('地图 0001')
    expect(values['名称']).toBe('地图 0001')
    expect(values['每格公里']).toBe('1')
    expect(values[GRID_WIDTH_KEY]).toBeUndefined()
    expect(values[GRID_CELLS_KEY]).toBeUndefined()
  })
})

// ==================== 格子模型：建 / 涂 / 擦 / 清 ====================

describe('格子模型 · createGrid', () => {
  it('正常尺寸照收；非法尺寸（0 / 负 / NaN / 非数）回落缺省', () => {
    expect(createGrid(4, 2)).toMatchObject({ width: 4, height: 2 })
    expect(createGrid(0, 0)).toMatchObject({ width: DEFAULT_GRID_WIDTH, height: DEFAULT_GRID_HEIGHT })
    expect(createGrid(-3, -1)).toMatchObject({ width: DEFAULT_GRID_WIDTH, height: DEFAULT_GRID_HEIGHT })
    expect(createGrid(Number.NaN, 2.7)).toMatchObject({ width: DEFAULT_GRID_WIDTH, height: 2 })
  })

  it('超过上限夹到 60（脏数据不把画布渲染拖死）', () => {
    expect(createGrid(999, 500)).toMatchObject({ width: GRID_MAX_DIM, height: GRID_MAX_DIM })
  })

  it('新建网格是空的，且尺寸合法', () => {
    const grid = createGrid(2, 2)
    expect(grid.cells.size).toBe(0)
    expect(gridStats(grid).total).toBe(4)
  })
})

describe('格子模型 · 涂格与擦格', () => {
  it('paintCell：涂一格并记住颜色；越界原样返回同一个对象', () => {
    const grid = createGrid(2, 2)
    const painted = paintCell(grid, { x: 1, y: 1 }, '#f0a4a4')
    expect(painted.cells.get(cellKey(1, 1))).toBe('#f0a4a4')
    expect(painted).not.toBe(grid)
    expect(grid.cells.size).toBe(0)
    expect(paintCell(grid, { x: 2, y: 0 })).toBe(grid)
    expect(paintCell(grid, { x: -1, y: 0 })).toBe(grid)
    expect(paintCell(grid, { x: 0.5, y: 0 })).toBe(grid)
  })

  it('paintCell：颜色非法回落缺省色；同色重复涂返回同一个对象（不产生无谓提交）', () => {
    const grid = paintCell(createGrid(2, 2), { x: 0, y: 0 }, 'url(javascript:1)')
    expect(grid.cells.get('0,0')).toBe(DEFAULT_CELL_COLOR)
    expect(paintCell(grid, { x: 0, y: 0 })).toBe(grid)
    expect(normalizeCellColor('#F0A4A4')).toBe('#f0a4a4')
    expect(normalizeCellColor(42)).toBe(DEFAULT_CELL_COLOR)
  })

  it('paintStroke：一次涂一串格子（拖拽经过的集合）', () => {
    const grid = paintStroke(createGrid(4, 4), [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ])
    expect(gridStats(grid).painted).toBe(3)
    expect(grid.cells.get('2,0')).toBe(DEFAULT_CELL_COLOR)
  })

  it('eraseCell / eraseStroke：擦掉已绘格子；未绘格子不产生新对象', () => {
    const grid = paintedGrid()
    const erased = eraseCell(grid, { x: 0, y: 0 })
    expect(erased.cells.has('0,0')).toBe(false)
    expect(erased.cells.size).toBe(2)
    expect(eraseCell(grid, { x: 9, y: 9 })).toBe(grid)
    expect(eraseStroke(grid, [{ x: 1, y: 1 }, { x: 2, y: 2 }]).cells.size).toBe(1)
  })

  it('clearGrid：清空格子但保留尺寸', () => {
    const grid = paintedGrid()
    const cleared = clearGrid(grid)
    expect(cleared.cells.size).toBe(0)
    expect(cleared.width).toBe(3)
    expect(cleared.height).toBe(3)
    expect(clearGrid(cleared)).toBe(cleared)
  })

  it('isInside：只认网格内的整数坐标', () => {
    const grid = createGrid(2, 3)
    expect(isInside(grid, { x: 0, y: 0 })).toBe(true)
    expect(isInside(grid, { x: 1, y: 2 })).toBe(true)
    expect(isInside(grid, { x: 2, y: 0 })).toBe(false)
    expect(isInside(grid, { x: 0, y: 3 })).toBe(false)
  })

  it('cellKey / pointOfKey：往返一致，脏键返回 null', () => {
    expect(pointOfKey(cellKey(3, 4))).toEqual({ x: 3, y: 4 })
    expect(pointOfKey('3')).toBeNull()
    expect(pointOfKey('3,4,5')).toBeNull()
    expect(pointOfKey('a,b')).toBeNull()
    expect(pointOfKey('3x,4')).toBeNull()
  })
})

describe('格子模型 · resizeGrid（保留重叠区）', () => {
  it('变大：原有格子原位保留', () => {
    const grid = resizeGrid(paintedGrid(), 6, 6)
    expect(grid.width).toBe(6)
    expect(grid.height).toBe(6)
    expect(grid.cells.size).toBe(3)
    expect(grid.cells.get('2,2')).toBe('#f0a4a4')
  })

  it('变小：界外格子丢掉、界内格子保留', () => {
    const grid = resizeGrid(paintedGrid(), 2, 2)
    expect(grid.cells.has('2,2')).toBe(false)
    expect(grid.cells.has('1,1')).toBe(true)
    expect(grid.cells.has('0,0')).toBe(true)
    expect(grid.cells.size).toBe(2)
  })

  it('尺寸非法时回落当前尺寸（不抛异常）', () => {
    const grid = paintedGrid()
    expect(resizeGrid(grid, 0, 0)).toBe(grid)
    expect(resizeGrid(grid, Number.NaN, 3)).toBe(grid)
    expect(resizeGrid(grid, 999, 3).width).toBe(GRID_MAX_DIM)
  })
})

// ==================== 拖拽补格与键盘光标 ====================

describe('格子模型 · strokeCells（拖拽经过的格子）', () => {
  it('水平 / 垂直：含两端点，逐格连续', () => {
    expect(strokeCells({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ])
    expect(strokeCells({ x: 2, y: 2 }, { x: 2, y: 0 })).toEqual([
      { x: 2, y: 2 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ])
  })

  it('斜线不跳格：相邻两点横纵差都不超过 1（快速拖动不漏格）', () => {
    const points = strokeCells({ x: 0, y: 0 }, { x: 7, y: 3 })
    expect(points[0]).toEqual({ x: 0, y: 0 })
    expect(points[points.length - 1]).toEqual({ x: 7, y: 3 })
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]
      const current = points[index]
      expect(previous).toBeDefined()
      expect(current).toBeDefined()
      expect(Math.abs((current?.x ?? 0) - (previous?.x ?? 0))).toBeLessThanOrEqual(1)
      expect(Math.abs((current?.y ?? 0) - (previous?.y ?? 0))).toBeLessThanOrEqual(1)
    }
    // 反向拖拽同样连续
    expect(strokeCells({ x: 3, y: 3 }, { x: 0, y: 0 })[0]).toEqual({ x: 3, y: 3 })
  })

  it('脏输入（NaN）返回空数组，不挂住界面', () => {
    expect(strokeCells({ x: Number.NaN, y: 0 }, { x: 1, y: 1 })).toEqual([])
  })
})

describe('格子模型 · moveCursor（键盘光标）', () => {
  it('四个方向各走一格', () => {
    const grid = createGrid(4, 4)
    expect(moveCursor({ x: 1, y: 1 }, 'ArrowRight', grid.width, grid.height)).toEqual({ x: 2, y: 1 })
    expect(moveCursor({ x: 1, y: 1 }, 'ArrowLeft', grid.width, grid.height)).toEqual({ x: 0, y: 1 })
    expect(moveCursor({ x: 1, y: 1 }, 'ArrowUp', grid.width, grid.height)).toEqual({ x: 1, y: 0 })
    expect(moveCursor({ x: 1, y: 1 }, 'ArrowDown', grid.width, grid.height)).toEqual({ x: 1, y: 2 })
  })

  it('贴边停在边上（不越界、不抛异常）', () => {
    expect(moveCursor({ x: 0, y: 0 }, 'ArrowLeft', 4, 4)).toEqual({ x: 0, y: 0 })
    expect(moveCursor({ x: 0, y: 0 }, 'ArrowUp', 4, 4)).toEqual({ x: 0, y: 0 })
    expect(moveCursor({ x: 3, y: 3 }, 'ArrowRight', 4, 4)).toEqual({ x: 3, y: 3 })
    expect(moveCursor({ x: 99, y: 99 }, 'ArrowDown', 4, 4)).toEqual({ x: 3, y: 3 })
  })

  it('非方向键返回 null（让事件照常冒泡）', () => {
    expect(moveCursor({ x: 0, y: 0 }, 'a', 4, 4)).toBeNull()
    expect(moveCursor({ x: 0, y: 0 }, 'Tab', 4, 4)).toBeNull()
  })
})

// ==================== 统计量 ====================

describe('格子模型 · gridStats', () => {
  it('已绘计数与颜色计数（多的在前）', () => {
    const stats = gridStats(paintedGrid())
    expect(stats.painted).toBe(3)
    expect(stats.total).toBe(9)
    expect(stats.colors).toEqual([
      { color: '#f0a4a4', count: 2 },
      { color: DEFAULT_CELL_COLOR, count: 1 },
    ])
    expect(formatStatsText(stats)).toBe('已绘格数：3 / 9 格')
  })

  it('空网格：计数全 0，颜色表为空', () => {
    const stats = gridStats(createGrid(2, 4))
    expect(stats).toEqual({ painted: 0, total: 8, colors: [] })
  })
})

// ==================== 序列化 / 反序列化（默认值容错） ====================

describe('持久化 · serializeGrid', () => {
  it('写出四个中文键：尺寸、格子（上游 "gx,gy;gx,gy" 格式）、差异色', () => {
    const values = serializeGrid(paintedGrid())
    expect(values[GRID_WIDTH_KEY]).toBe('3')
    expect(values[GRID_HEIGHT_KEY]).toBe('3')
    expect(values[GRID_CELLS_KEY]).toBe('0,0;1,1;2,2')
    expect(values[GRID_COLORS_KEY]).toBe('1,1=#f0a4a4;2,2=#f0a4a4')
  })

  it('输出稳定：格子按行再按列排序（同一画布永远同一串）', () => {
    let grid = createGrid(4, 4)
    grid = paintCell(grid, { x: 2, y: 1 })
    grid = paintCell(grid, { x: 0, y: 1 })
    grid = paintCell(grid, { x: 1, y: 0 })
    expect(serializeGrid(grid)[GRID_CELLS_KEY]).toBe('1,0;0,1;2,1')
  })

  it('全缺省色时不写「格子颜色」（省一份冗余）', () => {
    const grid = paintCell(createGrid(2, 2), { x: 0, y: 0 })
    expect(serializeGrid(grid)[GRID_COLORS_KEY]).toBe('')
  })

  it('往返一致：序列化 → 反序列化 → 再序列化完全相同', () => {
    const grid = paintedGrid()
    const restored = deserializeGrid(serializeGrid(grid))
    expect(serializeGrid(restored)).toEqual(serializeGrid(grid))
    expect(restored.cells.get('1,1')).toBe('#f0a4a4')
  })
})

describe('持久化 · deserializeGrid（缺字段 / 脏数据 / 尺寸不符都不抛异常）', () => {
  it('null / undefined / 数字 / 布尔 / 空串 ⇒ 缺省 16 × 10 空网格', () => {
    for (const raw of [null, undefined, 42, true, '']) {
      const grid = deserializeGrid(raw)
      expect(grid.width).toBe(DEFAULT_GRID_WIDTH)
      expect(grid.height).toBe(DEFAULT_GRID_HEIGHT)
      expect(grid.cells.size).toBe(0)
    }
  })

  it('缺尺寸字段：回落缺省尺寸，格子照收（0,0 与 5,4 都在 16 × 10 内）', () => {
    const grid = deserializeGrid({ [GRID_CELLS_KEY]: '0,0;5,4' })
    expect(grid.width).toBe(DEFAULT_GRID_WIDTH)
    expect(grid.height).toBe(DEFAULT_GRID_HEIGHT)
    expect(grid.cells.size).toBe(2)
  })

  it('声明尺寸小于格子：扩到刚好装下（尺寸不符不丢数据）', () => {
    const grid = deserializeGrid({ [GRID_WIDTH_KEY]: '4', [GRID_HEIGHT_KEY]: '3', [GRID_CELLS_KEY]: '0,0;5,4' })
    expect(grid.width).toBe(6)
    expect(grid.height).toBe(5)
    expect(grid.cells.has('5,4')).toBe(true)
  })

  it('声明尺寸小于格子：扩到刚好装下', () => {
    const grid = deserializeGrid({ [GRID_WIDTH_KEY]: '4', [GRID_HEIGHT_KEY]: '4', [GRID_CELLS_KEY]: '9,7' })
    expect(grid.width).toBe(10)
    expect(grid.height).toBe(8)
    expect(grid.cells.has('9,7')).toBe(true)
  })

  it('尺寸声明超上限：夹到 60，界外格子丢弃（不抛异常）', () => {
    const grid = deserializeGrid({ [GRID_WIDTH_KEY]: '999', [GRID_HEIGHT_KEY]: '999', [GRID_CELLS_KEY]: '70,70;1,1' })
    expect(grid.width).toBe(GRID_MAX_DIM)
    expect(grid.height).toBe(GRID_MAX_DIM)
    expect(grid.cells.has('70,70')).toBe(false)
    expect(grid.cells.has('1,1')).toBe(true)
  })

  it('脏格子片段逐个丢弃：只留合法坐标，且不是「整串作废」', () => {
    const grid = deserializeGrid({ [GRID_CELLS_KEY]: '1,1;坏;3,;2,2;;x,y' })
    expect(grid.cells.has('1,1')).toBe(true)
    expect(grid.cells.has('2,2')).toBe(true)
    expect(grid.cells.size).toBe(2)
  })

  it('负坐标（上游绝对坐标允许）在本仓网格里丢弃，其余格子照收', () => {
    const grid = deserializeGrid({ [GRID_CELLS_KEY]: '-1,2;-1,-1;0,0' })
    expect(grid.cells.size).toBe(1)
    expect(grid.cells.has('0,0')).toBe(true)
  })

  it('旧版「色块条」形状（只有名称 / 每格公里 / 示意格子数）⇒ 缺省空网格，不臆造已绘格', () => {
    const grid = deserializeGrid({ 名称: '云梦泽', 每格公里: '10', cells: 12, color: 'hsl(200, 45%, 52%)' })
    expect(grid.width).toBe(DEFAULT_GRID_WIDTH)
    expect(grid.height).toBe(DEFAULT_GRID_HEIGHT)
    expect(grid.cells.size).toBe(0)
  })

  it('也认内存网格的英文别名（width / height / cells）', () => {
    const grid = deserializeGrid({ width: 3, height: 2, cells: '0,1' })
    expect(grid).toMatchObject({ width: 3, height: 2 })
    expect(grid.cells.has('0,1')).toBe(true)
  })

  it('数组形状："x,y" 字符串 / {x,y} / [x,y] 都收', () => {
    const grid = deserializeGrid(['1,1', { x: 2, y: 2 }, [3, 0]])
    expect(grid.cells.has('1,1')).toBe(true)
    expect(grid.cells.has('2,2')).toBe(true)
    expect(grid.cells.has('3,0')).toBe(true)
  })

  it('颜色：合法色值照收（统一小写），非法 / 无对应格子的颜色条目忽略', () => {
    const grid = deserializeGrid({ [GRID_CELLS_KEY]: '1,1', [GRID_COLORS_KEY]: '1,1=#F0A4A4;9,9=#123456' })
    expect(grid.cells.get('1,1')).toBe('#f0a4a4')
    expect(grid.cells.has('9,9')).toBe(false)
    const dirty = deserializeGrid({ [GRID_CELLS_KEY]: '1,1', [GRID_COLORS_KEY]: '1,1=url(x)' })
    expect(dirty.cells.get('1,1')).toBe(DEFAULT_CELL_COLOR)
  })

  it('尺寸字段是脏值时回落缺省尺寸', () => {
    const grid = deserializeGrid({ [GRID_WIDTH_KEY]: '宽', [GRID_HEIGHT_KEY]: '-2', [GRID_CELLS_KEY]: '' })
    expect(grid.width).toBe(DEFAULT_GRID_WIDTH)
    expect(grid.height).toBe(DEFAULT_GRID_HEIGHT)
  })
})

describe('持久化 · valuesWithGrid', () => {
  it('保留这一行的其它字段，覆盖四个画布键与「每格公里」', () => {
    const values = valuesWithGrid(
      { 名称: '云梦泽', 说明: '水网密布', 底图模式: '格子' },
      paintedGrid(),
      COARSE_KM_PER_CELL,
    )
    expect(values['名称']).toBe('云梦泽')
    expect(values['说明']).toBe('水网密布')
    expect(values['底图模式']).toBe('格子')
    expect(values['每格公里']).toBe('10')
    expect(values[GRID_WIDTH_KEY]).toBe('3')
    expect(values[GRID_CELLS_KEY]).toBe('0,0;1,1;2,2')
  })

  it('往返：提交载荷能被下一轮反序列化读回（画布能读旧数据、也能读自己的数据）', () => {
    const grid = paintedGrid()
    const values = valuesWithGrid({}, grid, FINE_KM_PER_CELL)
    const restored = deserializeGrid(values)
    expect(restored.cells.size).toBe(3)
    expect(restored.cells.get('2,2')).toBe('#f0a4a4')
    expect(kmPerCellOf(values['每格公里'])).toBe(FINE_KM_PER_CELL)
  })
})