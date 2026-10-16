// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * geography-map 面板视图测试（happy-dom，W9-4 / C-08 手绘格子画布）。
 *
 * 覆盖：挂载载入调用 · 空态与只读态的中文说明 · 旧数据（只有色块没有尺寸）回落合法网格 ·
 * 单击涂格与拖拽连涂（一笔一次落库）· 橡皮 / 清空 · 精粗切档 · 改画布尺寸保留重叠区 ·
 * 键盘（方向键 / 空格 / Backspace）· 颜色计数图例 · 详情区 · 多地图切换 ·
 * 清单表更新不冲掉画布键 · 删除只显中文回执。
 *
 * 纯逻辑在 `geography-map.test.ts`；这里只测组件接线。
 * AppState 桩按结构手写（本面板只触碰 getSnapshot / subscribe / loadSettingsEntities /
 * submitSettingsEntity，其余为 no-op）。指针事件手工派发：happy-dom 没有 PointerEvent，
 * 而组件监听的是原生事件名（不看事件类），所以派发同名普通事件即可。
 */

import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { GEO_MAPS_TAB, getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type {
  AppState,
  AppSnapshot,
  SettingsEntityQuery,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiResult } from '../../src/renderer/ai/types.js'
import {
  COARSE_KM_PER_CELL,
  DEFAULT_CELL_COLOR,
  DEFAULT_GRID_HEIGHT,
  DEFAULT_GRID_WIDTH,
  FINE_KM_PER_CELL,
  GRID_CELLS_KEY,
  GRID_COLORS,
  GRID_COLORS_KEY,
  GRID_HEIGHT_KEY,
  GRID_WIDTH_KEY,
  LOAD_FAILED_NOTICE,
  MAP_PANEL_TEXT,
  MAP_SAVE_STATE_TEXT,
  colorLabelOf,
  createGrid,
  deletePendingNotice,
  formatCellCoord,
  formatCellCount,
  formatCellState,
  formatCursor,
  formatGridSize,
  formatKmPerCell,
  formatMapCount,
  formatScaleChangedNotice,
  formatStatsText,
  paintCell,
  serializeGrid,
} from '../../src/renderer/panels/geography-map-model.js'
import GeographyMap from '../../src/renderer/panels/geography-map.vue'

/** 面板自己的页签（geography-map，type=map，分组=世界构建）。 */
const PANEL_TAB = getTab('geography-map')
if (PANEL_TAB === undefined) throw new Error('SIDEBAR_TABS 里找不到 geography-map 页签')

/** 调色板里的「伏笔」色：差异色用例要一个稳定色值，不靠下标取色。 */
const FORESHADOW = GRID_COLORS.find((option) => option.id === 'foreshadow')
if (FORESHADOW === undefined) throw new Error('调色板里找不到 foreshadow（geography-map-model）')
const FORESHADOW_COLOR = FORESHADOW.color

// ==================== 夹具 ====================

/** 一张**旧版**地图行：只有名称 / 每格公里（没有画布尺寸、没有格子键）。 */
function legacyRow(overrides: Partial<SettingsEntityView> = {}): SettingsEntityView {
  return {
    id: 'row-1',
    projectId: 'project-1',
    schemaTemplateId: 'geomaps',
    name: '云梦泽',
    values: { 编号: 'MAP0001', 名称: '云梦泽', 每格公里: '1', 说明: '旧数据' },
    orderKey: 'A01',
    revision: 'r00000001',
    deleted: false,
    ...overrides,
  }
}

/** 一张已经存过格子的地图行：3 × 3，(0,0) 缺省色、(1,2) 与 (2,2) 伏笔色。 */
function paintedRow(overrides: Partial<SettingsEntityView> = {}): SettingsEntityView {
  let grid = createGrid(3, 3)
  grid = paintCell(grid, { x: 0, y: 0 })
  grid = paintCell(grid, { x: 1, y: 2 }, FORESHADOW_COLOR)
  grid = paintCell(grid, { x: 2, y: 2 }, FORESHADOW_COLOR)
  return legacyRow({
    id: 'row-2',
    name: '归墟',
    orderKey: 'A02',
    values: { 编号: 'MAP0002', 名称: '归墟', 每格公里: '10', ...serializeGrid(grid) },
    ...overrides,
  })
}

const AI_FAILURE: AiResult = { ok: false, code: 'AI_NOT_CONFIGURED', message: '测试桩' }

// ==================== AppState 桩 ====================

interface StateHarness {
  readonly state: AppState
  /** 模拟外壳发布快照（订阅者会收到）。 */
  publish(patch: Partial<AppSnapshot>): void
  setLoadResult(ok: boolean): void
  setSubmitResult(result: SettingsEntitySubmitResult): void
  readonly loads: SettingsEntityQuery[]
  readonly submits: SettingsEntitySubmit[]
}

/** 手写 AppState 桩（结构完整，不 as any）。 */
function makeState(initial: Partial<AppSnapshot> = {}): StateHarness {
  const loads: SettingsEntityQuery[] = []
  const submits: SettingsEntitySubmit[] = []
  const listeners = new Set<(snapshot: AppSnapshot) => void>()
  let loadResult = true
  let submitResult: SettingsEntitySubmitResult = {
    ok: true,
    entityId: 'row-new',
    revision: 'r2',
    orderKey: 'A02',
  }
  let snapshot: AppSnapshot = {
    ready: true,
    loading: false,
    appVersion: 'test',
    databasePath: null,
    databaseSchemaVersion: null,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'project-1',
    tree: [],
    documents: [],
    selectedDocumentId: null,
    title: '',
    body: '',
    charCount: 0,
    revision: null,
    saveStatus: 'saved',
    saveDetail: null,
    conflict: null,
    lastError: null,
    expandedIds: [],
    settingsEntities: [],
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
    ...initial,
  }
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: async () => {},
    refresh: async () => {},
    createProject: async () => false,
    openProject: async () => true,
    createChapter: async () => false,
    selectDocument: async () => false,
    edit: () => {},
    flush: async () => false,
    applyExternalUpdate: () => false,
    retrySave: () => {},
    resolveConflict: () => {},
    toggleExpanded: () => {},
    setNavigationGuard: () => {},
    dispose: () => {},
    loadSettingsEntities: async (options) => {
      loads.push(options ?? {})
      return loadResult
    },
    selectSettingsEntity: async () => false,
    refreshSettingsEntity: async () => false,
    submitSettingsEntity: async (submit) => {
      submits.push(submit)
      return submitResult
    },
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => AI_FAILURE,
    },
  }
  return {
    state,
    loads,
    submits,
    publish: (patch) => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener(snapshot)
    },
    setLoadResult: (ok) => {
      loadResult = ok
    },
    setSubmitResult: (result) => {
      submitResult = result
    },
  }
}

interface MountProps {
  readonly state: AppState
  readonly tab: TabDef
  readonly [key: string]: unknown
}

function mountPanel(harness: StateHarness) {
  return mount(GeographyMap, {
    props: {
      state: harness.state,
      tab: PANEL_TAB!,
    } satisfies MountProps,
  })
}

// ==================== 断言辅助 ====================

/** 取一格（testid 就是 `geography-map-cell-<x>-<y>`）。 */
function cell(wrapper: VueWrapper, x: number, y: number) {
  return wrapper.get(`[data-testid="geography-map-cell-${x}-${y}"]`)
}

/** 画布上的格子总数（画布只画格子，没有别的矩形）。 */
function cellCount(wrapper: VueWrapper): number {
  return wrapper.element.querySelectorAll('rect').length
}

function statusText(wrapper: VueWrapper, testid: string): string {
  return wrapper.get(`[data-testid="${testid}"]`).text()
}

/** 派发一个同名普通事件（happy-dom 无 PointerEvent；组件按事件名监听）。 */
function pointer(target: EventTarget, type: 'pointerdown' | 'pointerenter' | 'pointerup'): void {
  target.dispatchEvent(new Event(type, { bubbles: true }))
}

/** 取最后一条提交（没有就抛，省掉每处 noUncheckedIndexedAccess 的空值判断）。 */
function latestSubmit(harness: StateHarness): SettingsEntitySubmit {
  const submit = harness.submits[harness.submits.length - 1]
  if (submit === undefined) throw new Error('面板没有提交任何设定实体')
  return submit
}

/** 一笔绘制：按下 → 抬手（抬手在 window 上，覆盖「拖到画布外放开」）。 */
async function stroke(wrapper: VueWrapper, cells: readonly (readonly [number, number])[]): Promise<void> {
  const first = cells[0]
  if (first === undefined) return
  pointer(cell(wrapper, first[0], first[1]).element, 'pointerdown')
  for (const point of cells.slice(1)) {
    pointer(cell(wrapper, point[0], point[1]).element, 'pointerenter')
  }
  await nextTick()
  pointer(window, 'pointerup')
  await flushPromises()
}

async function chooseTool(wrapper: VueWrapper, tool: 'select' | 'brush' | 'eraser'): Promise<void> {
  await wrapper.get(`[data-testid="geography-map-tool-${tool}"]`).trigger('click')
}

// ==================== 挂载 · 载入 · 空态 ====================

describe('地理面板 · 挂载与空态', () => {
  it('挂载时按《地图》模板载入设定实体（schemaTemplateId=geomaps）', async () => {
    const harness = makeState()
    mountPanel(harness)
    await flushPromises()
    expect(harness.loads).toEqual([{ schemaTemplateId: 'geomaps' }])
    expect(harness.submits).toEqual([])
  })

  it('空数据：标题 / 简介 / 计数 / 画布空态 / 详情空态 / 图例空态都是中文说明，不留空白', async () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(wrapper.find('[data-testid="geography-map-panel"]').exists()).toBe(true)
    expect(statusText(wrapper, 'geography-map-title')).toBe(PANEL_TAB!.name)
    expect(statusText(wrapper, 'geography-map-intro')).toBe(MAP_PANEL_TEXT.intro)
    expect(statusText(wrapper, 'geography-map-map-count')).toBe(formatMapCount(0))
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(0))
    const saveStatus = wrapper.get('[data-testid="geography-map-save-status"]')
    expect(saveStatus.attributes('data-status')).toBe('saved')
    expect(saveStatus.text()).toBe(MAP_SAVE_STATE_TEXT.saved)
    // 画布区：没有地图时给中文空态，不渲染半张画布
    expect(statusText(wrapper, 'geography-map-canvas-empty')).toContain(MAP_PANEL_TEXT.emptyMaps)
    expect(wrapper.find('[data-testid="geography-map-canvas"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="geography-map-picker"]').exists()).toBe(false)
    // 详情区与图例：同样不留空白
    expect(statusText(wrapper, 'geography-map-detail-empty')).toBe(MAP_PANEL_TEXT.emptyCellDetail)
    expect(statusText(wrapper, 'geography-map-legend-empty')).toBe(MAP_PANEL_TEXT.legendEmpty)
    // 数据层：清单表在，且给了自己的空态说明
    expect(wrapper.find('[data-testid="tab-table-geomaps"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tab-table-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tab-table-title"]').text()).toContain(GEO_MAPS_TAB.name)
  })

  it('载入失败：显式说明 + 清单空态旁给出重试 / 数据库提示，不静默空白', async () => {
    const harness = makeState()
    harness.setLoadResult(false)
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(wrapper.get('[data-testid="geography-map-load-notice"]').text()).toContain(LOAD_FAILED_NOTICE)
    expect(statusText(wrapper, 'geography-map-canvas-empty')).toContain(MAP_PANEL_TEXT.loadFailedHint)
  })

  it('订阅：挂载后外壳发布的新行进入画布与清单', async () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(wrapper.find('[data-testid="geography-map-canvas"]').exists()).toBe(false)
    harness.publish({ settingsEntities: [legacyRow()] })
    await nextTick()
    expect(wrapper.find('[data-testid="geography-map-canvas"]').exists()).toBe(true)
    expect(cellCount(wrapper)).toBe(DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT)
    expect(wrapper.find('[data-testid="table-row-row-1"]').exists()).toBe(true)
  })

  it('只读态：显式中文说明 + 工具条与色板禁用 + 画布不可聚焦 + 点格子不落库', async () => {
    const harness = makeState({ readOnly: true, settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(wrapper.get('[data-testid="geography-map-readonly"]').text()).toBe(MAP_PANEL_TEXT.readonlyNotice)
    expect(wrapper.get('[data-testid="geography-map-tool-brush"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="geography-map-color-foreshadow"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="geography-map-clear"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="geography-map-canvas"]').attributes('tabindex')).toBe('-1')
    pointer(cell(wrapper, 0, 0).element, 'pointerdown')
    await nextTick()
    pointer(window, 'pointerup')
    await flushPromises()
    expect(harness.submits).toEqual([])
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe('transparent')
  })
})

// ==================== 旧数据兼容 ====================

describe('地理面板 · 旧数据兼容（只有色块没有尺寸）', () => {
  it('旧行没有尺寸 / 没有格子键：回落 16 × 10 空网格，不抛异常也不臆造已绘格', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(cellCount(wrapper)).toBe(DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT)
    expect(statusText(wrapper, 'geography-map-status-size')).toContain(
      formatGridSize(DEFAULT_GRID_WIDTH, DEFAULT_GRID_HEIGHT),
    )
    expect(statusText(wrapper, 'geography-map-status-count')).toBe(
      formatStatsText({ painted: 0, total: DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT, colors: [] }),
    )
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(0))
    expect(
      wrapper
        .find(`[data-testid="geography-map-cell-${DEFAULT_GRID_WIDTH - 1}-${DEFAULT_GRID_HEIGHT - 1}"]`)
        .exists(),
    ).toBe(true)
    expect(wrapper.find(`[data-testid="geography-map-cell-${DEFAULT_GRID_WIDTH}-0"]`).exists()).toBe(false)
    expect(wrapper.find('[data-testid="geography-map-legend-empty"]').exists()).toBe(true)
  })

  it('已存盘的行：格子按「网格宽 / 网格高」渲染，已绘格子带颜色，图例给颜色计数', async () => {
    const harness = makeState({ settingsEntities: [paintedRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(cellCount(wrapper)).toBe(9)
    expect(statusText(wrapper, 'geography-map-status-size')).toContain(formatGridSize(3, 3))
    expect(statusText(wrapper, 'geography-map-status-count')).toBe(
      formatStatsText({
        painted: 3,
        total: 9,
        colors: [
          { color: FORESHADOW_COLOR, count: 2 },
          { color: DEFAULT_CELL_COLOR, count: 1 },
        ],
      }),
    )
    // 已绘：填色 + 高不透明度；未绘：透明 + 低不透明度（视觉上仍是「格子铺贴」）
    expect(cell(wrapper, 1, 2).attributes('fill')).toBe(FORESHADOW_COLOR)
    expect(cell(wrapper, 1, 2).attributes('fill-opacity')).toBe('0.42')
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe(DEFAULT_CELL_COLOR)
    expect(cell(wrapper, 0, 1).attributes('fill')).toBe('transparent')
    expect(cell(wrapper, 0, 1).attributes('fill-opacity')).toBe('0.06')
    // 图例：按数量从多到少，文案是中文
    const legend = wrapper.findAll('[data-testid="geography-map-legend-item"]')
    expect(legend.map((item) => item.attributes('data-color'))).toEqual([
      FORESHADOW_COLOR,
      DEFAULT_CELL_COLOR,
    ])
    expect(legend[0]?.text()).toContain(colorLabelOf(FORESHADOW_COLOR))
  })
})

// ==================== 绘制 ====================

describe('地理面板 · 单击与拖拽绘制', () => {
  it('画笔单击一格：本地立刻上色，抬手一次落库（四个画布键写回该地图行）', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[1, 1]])
    expect(harness.submits).toHaveLength(1)
    const submit = latestSubmit(harness)
    expect(submit.entityId).toBe('row-1')
    expect(submit.schemaTemplateId).toBe('geomaps')
    expect(submit.name).toBe('云梦泽')
    expect(submit.expectedRevision).toBe('r00000001')
    expect(submit.values['名称']).toBe('云梦泽')
    expect(submit.values['说明']).toBe('旧数据')
    expect(submit.values[GRID_WIDTH_KEY]).toBe(String(DEFAULT_GRID_WIDTH))
    expect(submit.values[GRID_HEIGHT_KEY]).toBe(String(DEFAULT_GRID_HEIGHT))
    expect(submit.values[GRID_CELLS_KEY]).toBe('1,1')
    expect(submit.values[GRID_COLORS_KEY]).toBe('')
    expect(submit.values['每格公里']).toBe('1')
    expect(cell(wrapper, 1, 1).attributes('fill')).toBe(DEFAULT_CELL_COLOR)
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(1))
    expect(wrapper.get('[data-testid="geography-map-save-status"]').attributes('data-status')).toBe('saved')
  })

  it('拖拽连涂：经过的格子全涂上（快速拖动不漏格），抬手只落库一次', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    // 只经过 (0,0) 与 (3,0)，中间两格由「补格」逻辑补齐
    await stroke(wrapper, [
      [0, 0],
      [3, 0],
    ])
    expect(harness.submits).toHaveLength(1)
    expect(latestSubmit(harness).values[GRID_CELLS_KEY]).toBe('0,0;1,0;2,0;3,0')
    for (const x of [0, 1, 2, 3]) {
      expect(cell(wrapper, x, 0).attributes('fill')).toBe(DEFAULT_CELL_COLOR)
    }
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(4))
  })

  it('重复涂同色：画布没变化就不写库（不产生无谓提交）', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[0, 0]])
    expect(harness.submits).toHaveLength(1)
    await stroke(wrapper, [[0, 0]])
    expect(harness.submits).toHaveLength(1)
  })

  it('橡皮：点已绘格子擦掉并落库；点未绘格子不提交', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[0, 0]])
    await chooseTool(wrapper, 'eraser')
    await stroke(wrapper, [[0, 0]])
    expect(harness.submits).toHaveLength(2)
    expect(latestSubmit(harness).values[GRID_CELLS_KEY]).toBe('')
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe('transparent')
    await stroke(wrapper, [[2, 2]])
    expect(harness.submits).toHaveLength(2)
  })

  it('清空：清光已绘格子并落库，随后清空按钮禁用（没有可清的东西就不骗人）', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[0, 0]])
    await stroke(wrapper, [[1, 1]])
    expect(harness.submits).toHaveLength(2)
    await wrapper.get('[data-testid="geography-map-clear"]').trigger('click')
    await flushPromises()
    expect(harness.submits).toHaveLength(3)
    expect(latestSubmit(harness).values[GRID_CELLS_KEY]).toBe('')
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(0))
    expect(wrapper.get('[data-testid="geography-map-clear"]').attributes('disabled')).toBeDefined()
    expect(statusText(wrapper, 'geography-map-notice')).toContain(MAP_PANEL_TEXT.clearedNotice)
  })

  it('每格公里切到「粗」：即时显示新档位并落库新的「每格公里」', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="geography-map-scale-coarse"]').trigger('click')
    await flushPromises()
    expect(harness.submits).toHaveLength(1)
    expect(latestSubmit(harness).values['每格公里']).toBe(String(COARSE_KM_PER_CELL))
    const coarse = wrapper.get('[data-testid="geography-map-scale-coarse"]')
    expect(coarse.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-testid="geography-map-scale-fine"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).toContain(formatKmPerCell(COARSE_KM_PER_CELL))
    expect(statusText(wrapper, 'geography-map-notice')).toContain(
      formatScaleChangedNotice(COARSE_KM_PER_CELL),
    )
    // 再点同一档：没有变化就不重复提交
    await coarse.trigger('click')
    await flushPromises()
    expect(harness.submits).toHaveLength(1)
  })

  it('改画布尺寸：缩小时保留重叠区，再放大时原有格子仍在（界外格子不复活）', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[0, 0]])
    await stroke(wrapper, [[5, 5]])
    expect(harness.submits).toHaveLength(2)

    const width = wrapper.get('[data-testid="geography-map-grid-width"]')
    await width.setValue('4')
    await width.trigger('change')
    await flushPromises()
    expect(cellCount(wrapper)).toBe(4 * DEFAULT_GRID_HEIGHT)
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe(DEFAULT_CELL_COLOR)
    expect(wrapper.find('[data-testid="geography-map-cell-5-5"]').exists()).toBe(false)
    expect(latestSubmit(harness).values[GRID_WIDTH_KEY]).toBe('4')

    await width.setValue(String(DEFAULT_GRID_WIDTH))
    await width.trigger('change')
    await flushPromises()
    expect(cellCount(wrapper)).toBe(DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT)
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe(DEFAULT_CELL_COLOR)
    // 界外格子不复活：放大后那一格照旧存在（画布铺满），但仍是未绘状态
    expect(cell(wrapper, 5, 5).attributes('fill')).toBe('transparent')
  })

  it('非法尺寸（0）：回落当前尺寸、输入框复原、不提交', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    const width = wrapper.get('[data-testid="geography-map-grid-width"]')
    await width.setValue('0')
    await width.trigger('change')
    await flushPromises()
    expect(cellCount(wrapper)).toBe(DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT)
    expect((width.element as HTMLInputElement).value).toBe(String(DEFAULT_GRID_WIDTH))
    expect(harness.submits).toEqual([])
  })
})

// ==================== 键盘可达 ====================

describe('地理面板 · 键盘可达', () => {
  it('方向键移动光标：状态条与 aria-activedescendant 同步（不改画布）', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await chooseTool(wrapper, 'select')
    pointer(cell(wrapper, 0, 0).element, 'pointerdown')
    await nextTick()
    expect(statusText(wrapper, 'geography-map-status-cursor')).toBe(formatCursor({ x: 0, y: 0 }))
    expect(harness.submits).toEqual([])

    const canvas = wrapper.get('[data-testid="geography-map-canvas"]')
    await canvas.trigger('keydown', { key: 'ArrowRight' })
    expect(statusText(wrapper, 'geography-map-status-cursor')).toBe(formatCursor({ x: 1, y: 0 }))
    expect(canvas.attributes('aria-activedescendant')).toBe('geography-map-cell-1-0')
    expect(harness.submits).toEqual([])
  })

  it('空格涂格 / Backspace 擦除：都走落库通道，详情区同步', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    const canvas = wrapper.get('[data-testid="geography-map-canvas"]')
    await canvas.trigger('keydown', { key: ' ' })
    await flushPromises()
    expect(harness.submits).toHaveLength(1)
    expect(latestSubmit(harness).values[GRID_CELLS_KEY]).toBe('0,0')
    expect(statusText(wrapper, 'geography-map-detail-coord')).toBe(formatCellCoord({ x: 0, y: 0 }))
    expect(statusText(wrapper, 'geography-map-detail-state')).toBe(formatCellState(true))
    expect(statusText(wrapper, 'geography-map-status-count')).toContain(
      formatStatsText({
        painted: 1,
        total: DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT,
        colors: [{ color: DEFAULT_CELL_COLOR, count: 1 }],
      }),
    )
    await canvas.trigger('keydown', { key: 'Backspace' })
    await flushPromises()
    expect(harness.submits).toHaveLength(2)
    expect(latestSubmit(harness).values[GRID_CELLS_KEY]).toBe('')
    expect(statusText(wrapper, 'geography-map-detail-state')).toBe(formatCellState(false))
  })
})

// ==================== 详情区 · 色板 ====================

describe('地理面板 · 详情区与色板', () => {
  it('选择工具点格子：详情列出坐标 / 状态 / 颜色 / 所属地图 / 这张图已绘格数', async () => {
    const harness = makeState({ settingsEntities: [paintedRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    pointer(cell(wrapper, 1, 2).element, 'pointerdown')
    await nextTick()
    expect(wrapper.find('[data-testid="geography-map-detail"]').exists()).toBe(true)
    expect(statusText(wrapper, 'geography-map-detail-coord')).toBe(formatCellCoord({ x: 1, y: 2 }))
    expect(statusText(wrapper, 'geography-map-detail-state')).toBe(formatCellState(true))
    expect(statusText(wrapper, 'geography-map-detail-color')).toBe(colorLabelOf(FORESHADOW_COLOR))
    expect(statusText(wrapper, 'geography-map-detail-map')).toBe('归墟')
    expect(statusText(wrapper, 'geography-map-detail-count')).toBe(formatCellCount(3))
    // 换一格：详情跟着走
    pointer(cell(wrapper, 0, 1).element, 'pointerdown')
    await nextTick()
    expect(statusText(wrapper, 'geography-map-detail-state')).toBe(formatCellState(false))
    expect(statusText(wrapper, 'geography-map-detail-color')).toBe(colorLabelOf(DEFAULT_CELL_COLOR))
    expect(harness.submits).toEqual([])
  })

  it('切色板：选「伏笔」后涂格，落库带上「格子颜色」差异色，图例按该色计数', async () => {
    const harness = makeState({ settingsEntities: [legacyRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="geography-map-color-foreshadow"]').trigger('click')
    await chooseTool(wrapper, 'brush')
    await stroke(wrapper, [[0, 0]])
    expect(harness.submits).toHaveLength(1)
    const submit = latestSubmit(harness)
    expect(submit.values[GRID_CELLS_KEY]).toBe('0,0')
    expect(submit.values[GRID_COLORS_KEY]).toBe(`0,0=${FORESHADOW_COLOR}`)
    expect(cell(wrapper, 0, 0).attributes('fill')).toBe(FORESHADOW_COLOR)
    const legend = wrapper.findAll('[data-testid="geography-map-legend-item"]')
    expect(legend.map((item) => item.attributes('data-color'))).toEqual([FORESHADOW_COLOR])
    expect(legend[0]?.text()).toContain(colorLabelOf(FORESHADOW_COLOR))
  })
})

// ==================== 多地图 · 清单表 ====================

describe('地理面板 · 多地图与清单表', () => {
  it('多张地图：画布默认跟第一张，换选后尺寸与格子都换', async () => {
    const harness = makeState({ settingsEntities: [legacyRow(), paintedRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(statusText(wrapper, 'geography-map-map-count')).toBe(formatMapCount(2))
    const picker = wrapper.get('[data-testid="geography-map-picker"]')
    expect((picker.element as HTMLSelectElement).value).toBe('row-1')
    expect(cellCount(wrapper)).toBe(DEFAULT_GRID_WIDTH * DEFAULT_GRID_HEIGHT)
    await picker.setValue('row-2')
    await flushPromises()
    expect(cellCount(wrapper)).toBe(9)
    expect(statusText(wrapper, 'geography-map-status-size')).toContain(formatGridSize(3, 3))
    expect(cell(wrapper, 1, 2).attributes('fill')).toBe(FORESHADOW_COLOR)
    expect(statusText(wrapper, 'geography-map-cell-count')).toBe(formatCellCount(3))
  })

  it('清单表改「说明」：提交仍是整行合并，画布键不被表格冲掉', async () => {
    const harness = makeState({ settingsEntities: [paintedRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-cell-input-说明"]').setValue('水网密布')
    await flushPromises()
    expect(harness.submits).toHaveLength(1)
    const submit = latestSubmit(harness)
    expect(submit.entityId).toBe('row-2')
    expect(submit.values['说明']).toBe('水网密布')
    expect(submit.values['名称']).toBe('归墟')
    expect(submit.values[GRID_CELLS_KEY]).toBe('0,0;1,2;2,2')
    expect(submit.values[GRID_WIDTH_KEY]).toBe('3')
    expect(submit.values[GRID_COLORS_KEY]).toBe(`1,2=${FORESHADOW_COLOR};2,2=${FORESHADOW_COLOR}`)
  })

  it('删除只显中文回执：不提交、不假装成功', async () => {
    const harness = makeState({ settingsEntities: [paintedRow()] })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-delete-row-2"]').trigger('click')
    expect(statusText(wrapper, 'geography-map-notice')).toBe(deletePendingNotice('row-2'))
    expect(harness.submits).toEqual([])
  })
})