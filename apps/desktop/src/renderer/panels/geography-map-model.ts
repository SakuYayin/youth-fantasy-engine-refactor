/**
 * 地图编辑面板（geography-map）的纯逻辑层。
 *
 * 本批次（W9-4 / C-08）把上游 `src/components/world/GeoMapEditor.tsx` 的**手绘格子画布**
 * 搬过来，完整实现落在两个地方：
 * ① 数据层 —— 《地图》（`GEO_MAPS_TAB`，id `geomaps`）清单表，走 AppState 的
 *    `settingsEntities` 通道：挂载时 `loadSettingsEntities`，新建/更新走
 *    `submitSettingsEntity`；删除/重排应用层还没有对应用例，只显回执不假装成功。
 * ② 手绘格子画布 —— 把一张地图切成 `宽 × 高` 的格子，单击 / 拖拽涂格（本文件下半部分）。
 *
 * 与上游的两处**有意偏差**（交付报告里有完整清单）：
 * - 上游的格子按「范围」存在《地理风物》行的隐藏列 `地图格子` 里（一个范围一串绝对格坐标）；
 *   本仓的《地理风物》还没接这条通道，故本批次把**整张图**的已绘格子存回**该地图行**的
 *   `values`，键名沿用上游的 `地图格子`，序列化格式也逐字沿用
 *   `"gx,gy;gx,gy"`（`geoMapGeometry.ts` 的 `parseCells` / `serializeCells`）。
 * - 上游的「精/粗」是 `cellKm` 步进（1 ↔ 10），这里沿用同一对档位，但直接写到
 *   `GEO_MAPS_TAB.subtitleCol`（「每格公里」列），与旧版写入形状完全一致。
 *
 * 本文件全部是纯函数（无 Vue、无 DOM、无 IPC）⇒ 可无头单测；`.vue` 只做渲染与调用
 * （接口冻结 §2：组件内不写死大段静态文案）。
 */

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'

import type { SettingsEntityView } from '../app-state.js'
import { sortRows } from '../schema/index.js'

// ==================== 面板文案（可见文本 ⊆ 页签文案 ∪ 这里的常量） ====================

/** 面板上所有中文文案的唯一来源（`.vue` 里不再出现裸字面量）。 */
export const MAP_PANEL_TEXT = {
  intro:
    '手绘格子画布：把一张地图切成格子，用「画笔」单击 / 拖拽涂格画出范围。格子数据存在这张地图上，切换地图不会互相干扰。',
  canvasTitle: '手绘格子画布',
  toolGroupLabel: '绘制工具',
  toolSelect: '选择',
  toolBrush: '画笔',
  toolEraser: '橡皮',
  toolSelectHint: '选择：只查看格子字段，不改动画布。',
  toolBrushHint: '画笔：单击涂一格，按住拖动连涂经过的格子。',
  toolEraserHint: '橡皮：单击擦掉一格，按住拖动连续擦除。',
  clear: '清空',
  clearHint: '清空会把当前地图上所有已绘格子去掉，其他字段保持原样。',
  scaleLabel: '每格公里',
  scaleFine: '精',
  scaleCoarse: '粗',
  scaleFineHint: '精：每格 1 公里（城池 / 秘境这类小范围）。',
  scaleCoarseHint: '粗：每格 10 公里（大陆 / 区域这类大范围）。',
  gridSizeLabel: '网格尺寸',
  widthLabel: '宽',
  heightLabel: '高',
  colorLabel: '格子颜色',
  mapPickerLabel: '当前地图',
  canvasLabel: '手绘格子画布：方向键移动光标，空格或回车涂格，Backspace 擦除',
  detailTitle: '选中格子',
  detailCoord: '坐标',
  detailState: '状态',
  detailColor: '颜色',
  detailMap: '所属地图',
  detailCount: '这张图已绘',
  emptyCellDetail: '在画布上点一格，这里显示它的字段。',
  painted: '已绘制',
  unpainted: '未绘制',
  emptyMaps: '还没有地图：在下方表格点「+」新建一张。',
  loadFailedHint: '画布需要先载入地图清单。',
  readonlyNotice: '只读模式：地图只能查看，不能绘制。',
  cursorLabel: '光标',
  cursorNone: '未选中',
  sizeLabel: '画布尺寸',
  countLabel: '已绘格数',
  legendTitle: '颜色计数',
  legendEmpty: '还没有已绘格子：用「画笔」在画布上涂几格。',
  hint:
    '单击涂一格 · 按住拖动连涂经过的格子 · 橡皮 / Backspace 擦除 · 方向键移动光标（空格或回车涂格）',
  savedNotice: '已保存。',
  clearedNotice: '已清空这张地图的格子（其他字段保持原样）。',
} as const

/** 保存状态（面板自己的三态；与 `YfeStatusPill` 的六态无关，故不借用它的文案）。 */
export type MapSaveState = 'saved' | 'saving' | 'error'

/** 保存状态文案（唯一来源）。 */
export const MAP_SAVE_STATE_TEXT: Readonly<Record<MapSaveState, string>> = Object.freeze({
  saved: '已保存',
  saving: '保存中',
  error: '保存失败',
})

/** 地图清单载入失败（`loadSettingsEntities` 返回 false）时的说明。 */
export const LOAD_FAILED_NOTICE = '地图清单载入失败：请重试，或检查数据库连接。'

/** 更新时那一行已不在清单里（被别处删除/换了过滤条件）的回执。 */
export function updateMissingRowNotice(entityId: string): string {
  return `这一行已经不在当前地图清单里（${entityId}）：请刷新页签后重试。`
}

/** 删除只显回执：应用层的删除用例（P1-B6 仓储删除通道）还没接入，不许假装成功。 */
export function deletePendingNotice(entityId: string): string {
  return `「删除地图」还没接入（应用层仓储删除通道）：${entityId} 保持原样。`
}

/** 重排只显回执：orderKey 是 BINARY 逐字符比较，由应用层生成（R-66/R-69），面板不自己拼。 */
export function reorderPendingNotice(entityId: string, beforeId: string | null): string {
  return `「调整顺序」还没接入（需要应用层生成 orderKey）：${entityId} → ${beforeId ?? '末尾'}。`
}

/** 新建/更新失败的回执：错误码 + 脱敏原因（与外壳同款格式）。 */
export function submitFailureNotice(code: string, message: string): string {
  return `${code}：${message}`
}

/** 新建会话序号：同一毫秒内的两次新建也能拿到不同键（Date.now() 只有毫秒分辨率）。 */
let createKeySequence = 0

/** 新建会话的幂等键：一次「+」一个稳定键（双击/失败重试不会建出两张图）。 */
export function newCreateKey(tabId: string): string {
  createKeySequence += 1
  return `panel:${tabId}:${Date.now().toString(36)}:${createKeySequence}`
}

// ==================== 「每格公里」 ====================

/** 「每格公里」缺省档（GEO_MAPS_TAB 的选项是 '1'/'10'；空值/解析失败按 1，与旧版一致）。 */
export const DEFAULT_KM_PER_CELL = 1

/** 精细档：每格 1 公里。 */
export const FINE_KM_PER_CELL = 1

/** 粗略档：每格 10 公里（上游 `geoMapGeometry.ts` 的 `CELL_KM_STEPS = [1, 10]`）。 */
export const COARSE_KM_PER_CELL = 10

/** 「每格公里」列名（单一源：`GEO_MAPS_TAB.subtitleCol`；类型可选，缺省兜底旧版同款文案）。 */
function kmColumnName(): string {
  return GEO_MAPS_TAB.subtitleCol ?? '每格公里'
}

/** 「每格公里」单元格的原始值 → 正数：'1'/'10' 之外的文本兜底为默认档。 */
export function kmPerCellOf(raw: unknown): number {
  const text =
    typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  const value = Number(text)
  return text !== '' && Number.isFinite(value) && value > 0 ? value : DEFAULT_KM_PER_CELL
}

/** 公里数 → 展示文本（Number 转字符串：1 → '1'，1.5 → '1.5'）。 */
export function formatKm(kmPerCell: number): string {
  return String(kmPerCell)
}

/** 每格公里 → 面板文案（上游状态条的「每格 1 公里」同款）。 */
export function formatKmPerCell(kmPerCell: number): string {
  return `每格 ${formatKm(kmPerCell)} 公里`
}

/** 切档回执。 */
export function formatScaleChangedNotice(kmPerCell: number): string {
  return `每格公里已切到 ${formatKm(kmPerCell)}。`
}

/** 改尺寸回执。 */
export function formatSizeChangedNotice(width: number, height: number): string {
  return `画布尺寸已改为 ${formatGridSize(width, height)}。`
}

// ==================== 计数与坐标文案 ====================

/** 地图张数文案。 */
export function formatMapCount(count: number): string {
  return `共 ${count} 张地图`
}

/** 已绘格数文案。 */
export function formatCellCount(count: number): string {
  return `已绘制 ${count} 格`
}

/** 画布尺寸文案（'16 × 10'）。 */
export function formatGridSize(width: number, height: number): string {
  return `${width} × ${height}`
}

/** 格坐标文案（存储键是 0 起的 `x,y`，界面显示 1 起更顺眼）。 */
export function formatCellCoord(point: GridPoint): string {
  return `第 ${point.x + 1} 列 第 ${point.y + 1} 行`
}

/** 光标文案；没选中时显式说明（不留空白）。 */
export function formatCursor(point: GridPoint | null): string {
  return `${MAP_PANEL_TEXT.cursorLabel}：${point === null ? MAP_PANEL_TEXT.cursorNone : formatCellCoord(point)}`
}

/** 状态条计数文案。 */
export function formatStatsText(stats: GridStats): string {
  return `${MAP_PANEL_TEXT.countLabel}：${stats.painted} / ${stats.total} 格`
}

/** 「颜色计数」一条的文案。 */
export function formatColorCount(color: string, count: number): string {
  return `${colorLabelOf(color)} ${count} 格`
}

/** 颜色 → 中文名（调色板里的颜色取标签；调色板之外的颜色直接显色值，不臆造名字）。 */
export function colorLabelOf(color: string): string {
  const normalized = color.trim().toLowerCase()
  const found = GRID_COLORS.find((option) => option.color.toLowerCase() === normalized)
  return found === undefined ? color : found.label
}

/** 格子状态文案。 */
export function formatCellState(painted: boolean): string {
  return painted ? MAP_PANEL_TEXT.painted : MAP_PANEL_TEXT.unpainted
}

/** 格子的无障碍标签（读屏用；坐标 + 状态 + 颜色）。 */
export function formatCellAriaLabel(point: GridPoint, painted: boolean, color: string): string {
  const state = formatCellState(painted)
  const suffix = painted ? `（${colorLabelOf(color)}）` : ''
  return `${formatCellCoord(point)} · ${state}${suffix}`
}

// ==================== 格子模型（手绘格子画布的核心） ====================

/** 格坐标（0 起，单位是「格」而不是像素）。 */
export interface GridPoint {
  readonly x: number
  readonly y: number
}

/**
 * 一块手绘网格。
 *
 * `cells` 的键是 `x,y`（`cellKey`），值是颜色（`#rrggbb`）；只在 `[0,width) × [0,height)`
 * 之内。不可变：所有改动函数都返回新对象（Vue 靠引用变化触发重渲染）。
 */
export interface Grid {
  readonly width: number
  readonly height: number
  readonly cells: ReadonlyMap<string, string>
}

/** 画布每格的边长（SVG 用户单位；与上游 `geoMapGeometry.ts` 的 `G = 36` 逐字一致）。 */
export const CELL_SIZE_PX = 36

/** 网格尺寸下限。 */
export const GRID_MIN_DIM = 1

/**
 * 网格尺寸上限。
 *
 * 上限不是为了「规则」，而是为了**脏数据不把界面拖死**：画布对每格渲染一个 `<rect>`，
 * 60 × 60 = 3600 已是可接受的极端值；再大的声明一律夹到 60。
 */
export const GRID_MAX_DIM = 60

/** 缺省网格尺寸（旧数据只有色块没有尺寸时的回落值；16 × 10 也正好是缺省画布）。 */
export const DEFAULT_GRID_WIDTH = 16
export const DEFAULT_GRID_HEIGHT = 10

/** 调色板：三种叠加层色 + 范围兜底色，色值逐字取自上游 `src/lib/settings/palette.ts`。 */
export interface GridColorOption {
  readonly id: string
  readonly label: string
  readonly color: string
}

/** 格子颜色（上游 `MAP_SPACE_FALLBACK` + `MAP_LAYER_COLORS` 的同一批色值）。 */
export const GRID_COLORS: readonly GridColorOption[] = Object.freeze([
  { id: 'space', label: '范围', color: '#8fb4e8' },
  { id: 'foreshadow', label: '伏笔', color: '#f0a4a4' },
  { id: 'character', label: '角色', color: '#8fd0c4' },
  { id: 'timeline', label: '时间脉络', color: '#e8b36a' },
])

/** 画笔缺省色（上游「范围」兜底色）。 */
export const DEFAULT_CELL_COLOR = '#8fb4e8'

/** 绘制工具（选择 / 画笔 / 橡皮）。 */
export type GridTool = 'select' | 'brush' | 'eraser'

/** 工具条选项（标签与提示文案取自 `MAP_PANEL_TEXT`，不给第二份字面量）。 */
export interface GridToolOption {
  readonly id: GridTool
  readonly label: string
  readonly hint: string
}

export const GRID_TOOLS: readonly GridToolOption[] = Object.freeze([
  { id: 'select', label: MAP_PANEL_TEXT.toolSelect, hint: MAP_PANEL_TEXT.toolSelectHint },
  { id: 'brush', label: MAP_PANEL_TEXT.toolBrush, hint: MAP_PANEL_TEXT.toolBrushHint },
  { id: 'eraser', label: MAP_PANEL_TEXT.toolEraser, hint: MAP_PANEL_TEXT.toolEraserHint },
])

/** 色值形状（只认 #rgb / #rgba / #rrggbb / #rrggbbaa，别的一律回落缺省色）。 */
const HEX_COLOR_PATTERN = /^#[0-9a-f]{3,8}$/u

/** 颜色清洗：非法/脏值回落缺省色（颜色会被写进 SVG 的 `fill`，不能原样透传）。 */
export function normalizeCellColor(raw: unknown): string {
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    if (HEX_COLOR_PATTERN.test(text)) return text
  }
  return DEFAULT_CELL_COLOR
}

/** 格子键（`x,y`）。 */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** 只认十进制的严格整数解析（`parseInt('2x')` 会给出 2，这里必须给 null）。 */
function parseIntStrict(text: string): number | null {
  const trimmed = text.trim()
  if (!/^-?\d+$/u.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(value) ? value : null
}

/** 格子键 → 格坐标；不是 `x,y` 形状就返回 null（脏键不抛异常）。 */
export function pointOfKey(key: string): GridPoint | null {
  const parts = key.split(',')
  if (parts.length !== 2) return null
  const x = parseIntStrict(parts[0] ?? '')
  const y = parseIntStrict(parts[1] ?? '')
  if (x === null || y === null) return null
  return { x, y }
}

/** 尺寸归一：非整数 / ≤0 / NaN 一律回落到 `fallback`，超过上限夹到上限。 */
function normalizeDim(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  const integer = Math.trunc(parsed)
  if (integer < GRID_MIN_DIM) return fallback
  return Math.min(integer, GRID_MAX_DIM)
}

/** 网格工厂（尺寸先归一，永远给出合法网格）。 */
export function createGrid(width: number, height: number): Grid {
  return {
    width: normalizeDim(width, DEFAULT_GRID_WIDTH),
    height: normalizeDim(height, DEFAULT_GRID_HEIGHT),
    cells: new Map<string, string>(),
  }
}

/** 同一尺寸、换一份格子表。 */
function withCells(grid: Grid, cells: ReadonlyMap<string, string>): Grid {
  return { width: grid.width, height: grid.height, cells }
}

/** 坐标是否在网格内（非整数/负/越界都算不在）。 */
export function isInside(grid: Grid, point: GridPoint): boolean {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return false
  return point.x >= 0 && point.y >= 0 && point.x < grid.width && point.y < grid.height
}

/** 涂一格；越界或颜色没变则**原样返回同一个对象**（调用方可以据此判断「没变化」）。 */
export function paintCell(grid: Grid, point: GridPoint, color: string = DEFAULT_CELL_COLOR): Grid {
  if (!isInside(grid, point)) return grid
  const key = cellKey(point.x, point.y)
  const normalized = normalizeCellColor(color)
  if (grid.cells.get(key) === normalized) return grid
  const next = new Map<string, string>(grid.cells)
  next.set(key, normalized)
  return withCells(grid, next)
}

/** 涂一串格子（拖拽经过的格子集合；上游「左键涂」的批量形态）。 */
export function paintStroke(
  grid: Grid,
  points: readonly GridPoint[],
  color: string = DEFAULT_CELL_COLOR,
): Grid {
  let next = grid
  for (const point of points) next = paintCell(next, point, color)
  return next
}

/** 擦一格；越界或本来就没画则原样返回同一个对象。 */
export function eraseCell(grid: Grid, point: GridPoint): Grid {
  if (!isInside(grid, point)) return grid
  const key = cellKey(point.x, point.y)
  if (!grid.cells.has(key)) return grid
  const next = new Map<string, string>(grid.cells)
  next.delete(key)
  return withCells(grid, next)
}

/** 擦一串格子（拖拽擦除；上游「Shift = 批量擦」的批量形态）。 */
export function eraseStroke(grid: Grid, points: readonly GridPoint[]): Grid {
  let next = grid
  for (const point of points) next = eraseCell(next, point)
  return next
}

/** 清空所有格子（尺寸保持不变）。 */
export function clearGrid(grid: Grid): Grid {
  return grid.cells.size === 0 ? grid : withCells(grid, new Map<string, string>())
}

/**
 * 改尺寸：**保留重叠区**（新边界之外的格子丢掉，其余原位保留），尺寸非法则回落到当前值。
 *
 * 上游的格子坐标是绝对格坐标、尺寸由内容撑开；本仓的画布尺寸是显式的（可在工具条里改），
 * 所以缩放语义必须是「保留重叠区」而不是「重新换算坐标」。
 */
export function resizeGrid(grid: Grid, width: number, height: number): Grid {
  const nextWidth = normalizeDim(width, grid.width)
  const nextHeight = normalizeDim(height, grid.height)
  if (nextWidth === grid.width && nextHeight === grid.height) return grid
  const cells = new Map<string, string>()
  for (const [key, color] of grid.cells) {
    const point = pointOfKey(key)
    if (point === null) continue
    if (point.x < nextWidth && point.y < nextHeight) cells.set(key, color)
  }
  return { width: nextWidth, height: nextHeight, cells }
}

/** 一种颜色的格子数。 */
export interface GridColorCount {
  readonly color: string
  readonly count: number
}

/** 画布的统计量（状态条与「颜色计数」图例用）。 */
export interface GridStats {
  /** 已绘格数。 */
  readonly painted: number
  /** 总格数（width × height）。 */
  readonly total: number
  /** 按颜色分组计数（多的在前，同数按色值排序 ⇒ 输出稳定可断言）。 */
  readonly colors: readonly GridColorCount[]
}

/** 统计已绘格数与颜色计数。 */
export function gridStats(grid: Grid): GridStats {
  const tally = new Map<string, number>()
  for (const color of grid.cells.values()) {
    tally.set(color, (tally.get(color) ?? 0) + 1)
  }
  const colors = [...tally.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((left, right) => right.count - left.count || (left.color < right.color ? -1 : 1))
  return { painted: grid.cells.size, total: grid.width * grid.height, colors }
}

/**
 * 两点之间拖拽**经过**的格子（Bresenham 取整直线）。
 *
 * 为什么需要它：`pointerenter` 只在鼠标跳进另一格时触发，快速拖动会把中间格子漏掉；
 * 用「上一个格子 → 这一格子」的直线补齐，涂出来的范围才连续（上游拖动框选同理）。
 * 含两端点；输入含 NaN 时返回空数组（不挂住界面）。
 */
export function strokeCells(from: GridPoint, to: GridPoint): readonly GridPoint[] {
  let x = Math.trunc(from.x)
  let y = Math.trunc(from.y)
  const targetX = Math.trunc(to.x)
  const targetY = Math.trunc(to.y)
  if (![x, y, targetX, targetY].every((value) => Number.isFinite(value))) return []
  const dx = Math.abs(targetX - x)
  const dy = Math.abs(targetY - y)
  const stepX = x <= targetX ? 1 : -1
  const stepY = y <= targetY ? 1 : -1
  let error = dx - dy
  const points: GridPoint[] = []
  // 步数上限 = dx + dy + 1：哪怕输入离谱也只是一条直线，绝不无限循环。
  const limit = dx + dy + 1
  for (let step = 0; step < limit; step += 1) {
    points.push({ x, y })
    if (x === targetX && y === targetY) break
    const doubled = error * 2
    if (doubled > -dy) {
      error -= dy
      x += stepX
    }
    if (doubled < dx) {
      error += dx
      y += stepY
    }
  }
  return points
}

/**
 * 键盘光标移动：方向键返回新坐标（贴边时停在边上），其它键返回 null（不处理）。
 *
 * 光标只走「一格」而不是整行 —— 与上游「拖拽框选」不同，这里是逐格涂的键盘形态。
 */
export function moveCursor(
  cursor: GridPoint,
  key: string,
  width: number,
  height: number,
): GridPoint | null {
  const gridWidth = normalizeDim(width, DEFAULT_GRID_WIDTH)
  const gridHeight = normalizeDim(height, DEFAULT_GRID_HEIGHT)
  const maxX = gridWidth - 1
  const maxY = gridHeight - 1
  const x = Number.isInteger(cursor.x) ? Math.min(Math.max(cursor.x, 0), maxX) : 0
  const y = Number.isInteger(cursor.y) ? Math.min(Math.max(cursor.y, 0), maxY) : 0
  switch (key) {
    case 'ArrowLeft':
      return { x: Math.max(x - 1, 0), y }
    case 'ArrowRight':
      return { x: Math.min(x + 1, maxX), y }
    case 'ArrowUp':
      return { x, y: Math.max(y - 1, 0) }
    case 'ArrowDown':
      return { x, y: Math.min(y + 1, maxY) }
    default:
      return null
  }
}

// ==================== 持久化（values 里的四个中文键） ====================

/**
 * 画布数据的存储键（全部中文，与列名同族：R-66 禁止给 values 起英文别名）。
 *
 * - `地图格子`：已绘格坐标，`"gx,gy;gx,gy"` —— 名称与格式**逐字沿用上游**
 *   `geoMapGeometry.ts` 的 `serializeCells` / `parseCells`；
 * - `网格宽` / `网格高`：画布尺寸（十进制字符串，与表里其它单元格同构）；
 * - `格子颜色`：只有**非缺省色**的格子才写（`"gx,gy=#rrggbb;..."`），全缺省时是空串。
 *
 * 旧数据（本批次之前的地图行）这三个键都不存在 ⇒ `deserializeGrid` 回落 16 × 10 空网格。
 */
export const GRID_WIDTH_KEY = '网格宽'
export const GRID_HEIGHT_KEY = '网格高'
export const GRID_CELLS_KEY = '地图格子'
export const GRID_COLORS_KEY = '格子颜色'

/** 序列化结果的形状（值一律是字符串，与《地图》行里其它单元格同构）。 */
export type GridValues = Readonly<Record<string, string>>

/** 格子的分隔符（上游 `serializeCells` 用分号）。 */
const CELL_SEPARATOR = ';'
/** 坐标与颜色的分隔符。 */
const COLOR_SEPARATOR = '='

/** 格子键排序：先按行再按列（输出稳定 ⇒ 同样的画布永远序列化成同一串）。 */
function sortedCellKeys(cells: ReadonlyMap<string, string>): readonly GridPoint[] {
  const points: GridPoint[] = []
  for (const key of cells.keys()) {
    const point = pointOfKey(key)
    if (point !== null) points.push(point)
  }
  points.sort((left, right) => left.y - right.y || left.x - right.x)
  return points
}

/** 网格 → values 片段（直接 spread 进提交载荷）。 */
export function serializeGrid(grid: Grid): GridValues {
  const cells: string[] = []
  const colors: string[] = []
  for (const point of sortedCellKeys(grid.cells)) {
    const key = cellKey(point.x, point.y)
    cells.push(key)
    const color = grid.cells.get(key)
    if (color !== undefined && color !== DEFAULT_CELL_COLOR) {
      colors.push(`${key}${COLOR_SEPARATOR}${color}`)
    }
  }
  return {
    [GRID_WIDTH_KEY]: String(grid.width),
    [GRID_HEIGHT_KEY]: String(grid.height),
    [GRID_CELLS_KEY]: cells.join(CELL_SEPARATOR),
    [GRID_COLORS_KEY]: colors.join(CELL_SEPARATOR),
  }
}

/** 只认「纯对象」（数组/Date/字符串都不是）。 */
function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

/** 单个坐标片段 `"gx,gy"`（允许逗号两侧有空白，与上游正则一致）。 */
const CELL_TEXT_PATTERN = /^(-?\d+)\s*,\s*(-?\d+)$/u

/** 坐标串/数组 → 格坐标列表；脏片段一律丢弃，绝不抛异常。 */
function parseCellText(raw: unknown): readonly GridPoint[] {
  if (typeof raw === 'string') {
    const points: GridPoint[] = []
    for (const part of raw.split(/[;；\s]+/u)) {
      const text = part.trim()
      if (text === '') continue
      const matched = CELL_TEXT_PATTERN.exec(text)
      if (matched === null) continue
      const x = parseIntStrict(matched[1] ?? '')
      const y = parseIntStrict(matched[2] ?? '')
      if (x === null || y === null) continue
      points.push({ x, y })
    }
    return points
  }
  if (Array.isArray(raw)) {
    const points: GridPoint[] = []
    for (const item of raw) {
      if (typeof item === 'string') {
        points.push(...parseCellText(item))
        continue
      }
      if (Array.isArray(item)) {
        const x = parseIntStrict(String(item[0] ?? ''))
        const y = parseIntStrict(String(item[1] ?? ''))
        if (x !== null && y !== null) points.push({ x, y })
        continue
      }
      const record = asRecord(item)
      if (record === null) continue
      const x = parseIntStrict(String(record.x ?? ''))
      const y = parseIntStrict(String(record.y ?? ''))
      if (x !== null && y !== null) points.push({ x, y })
    }
    return points
  }
  return []
}

/** 颜色串 `"gx,gy=#rrggbb;..."` → 键到颜色的表；非法片段丢弃。 */
function parseColorText(raw: unknown): ReadonlyMap<string, string> {
  const colors = new Map<string, string>()
  if (typeof raw !== 'string') return colors
  for (const part of raw.split(/[;；\s]+/u)) {
    const text = part.trim()
    if (text === '') continue
    const index = text.lastIndexOf(COLOR_SEPARATOR)
    if (index <= 0) continue
    const point = pointOfKey(text.slice(0, index))
    if (point === null) continue
    const color = normalizeCellColor(text.slice(index + 1))
    if (HEX_COLOR_PATTERN.test(color) === false) continue
    colors.set(cellKey(point.x, point.y), color)
  }
  return colors
}

/**
 * 解析出的格子 → 合法网格。
 *
 * 「尺寸不符」的两种情形都不抛异常：
 * - 坐标越出声明尺寸 → **扩格**（把宽/高撑到刚好装下，最多 `GRID_MAX_DIM`）；
 * - 负坐标或撑到上限之外 → 丢掉那一格（上游的绝对坐标允许负数，本仓网格以 0 为原点，故不收）。
 */
function withParsedCells(
  base: Grid,
  points: readonly GridPoint[],
  colors?: ReadonlyMap<string, string>,
): Grid {
  if (points.length === 0) return base
  let width = base.width
  let height = base.height
  for (const point of points) {
    if (point.x < 0 || point.y < 0) continue
    width = Math.max(width, Math.min(point.x + 1, GRID_MAX_DIM))
    height = Math.max(height, Math.min(point.y + 1, GRID_MAX_DIM))
  }
  const cells = new Map<string, string>()
  for (const point of points) {
    if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue
    const key = cellKey(point.x, point.y)
    cells.set(key, colors?.get(key) ?? DEFAULT_CELL_COLOR)
  }
  return { width, height, cells }
}

/** 尺寸解析（认中文键，也认内存网格的 `width`/`height`）。 */
function dimsOf(record: Record<string, unknown>): { width: number; height: number } {
  const rawWidth = record[GRID_WIDTH_KEY] ?? record['width']
  const rawHeight = record[GRID_HEIGHT_KEY] ?? record['height']
  return {
    width: normalizeDim(rawWidth, DEFAULT_GRID_WIDTH),
    height: normalizeDim(rawHeight, DEFAULT_GRID_HEIGHT),
  }
}

/**
 * values（或任何脏数据）→ 合法网格。
 *
 * **默认值容错是硬要求**：缺字段 / 尺寸不符 / 完全脏的数据都必须给出一个能用网格，
 * 而不是抛异常或留下 undefined。认得的形状：
 * 1. 本批次的行 values（`网格宽`/`网格高`/`地图格子`/`格子颜色`）；
 * 2. 内存里的 `{ width, height, cells }`（英文别名，便于回调里直接塞网格）；
 * 3. 一串格子文本 / 格子数组 / `{x,y}` 数组；
 * 4. 旧版「色块条」形状（只有名称/每格公里/示意格子数）⇒ 16 × 10 空网格（色块条是**预览示意**，
 *    不是已绘格子，不臆造成已绘格）。
 */
export function deserializeGrid(raw: unknown): Grid {
  const record = asRecord(raw)
  if (record === null) {
    const { width, height } = dimsOf({})
    return withParsedCells({ width, height, cells: new Map<string, string>() }, parseCellText(raw))
  }
  const { width, height } = dimsOf(record)
  const base: Grid = { width, height, cells: new Map<string, string>() }
  const cellsRaw = record[GRID_CELLS_KEY] ?? record['cells']
  const colorsRaw = record[GRID_COLORS_KEY] ?? record['cellColors']
  return withParsedCells(base, parseCellText(cellsRaw), parseColorText(colorsRaw))
}

/** 网格 → 提交载荷：保留这一行的其它字段，覆盖四个画布键与「每格公里」。 */
export function valuesWithGrid(
  current: Readonly<Record<string, unknown>>,
  grid: Grid,
  kmPerCell: number,
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...current, ...serializeGrid(grid) }
  values[kmColumnName()] = formatKm(kmPerCell)
  return values
}

// ==================== 行 → 画布视图 ====================

/**
 * 画布映射只认这几样：`id` / `name` / `values`。
 *
 * 故意收窄：`SettingsEntityView`（AppState 快照行）与 `EntityRow`（表格视图行）都满足它，
 * 两边不用互转。
 */
export interface MapSourceRow {
  readonly id: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  /** 可选：快照行带 `deleted`（boolean），清单表行没有。映射只用来防御性过滤。 */
  readonly deleted?: unknown
}

/** 一张地图的画布视图（画布组件直接渲染，不再解释行数据）。 */
export interface MapCanvasView {
  readonly id: string
  readonly name: string
  readonly kmPerCell: number
  /** 地图名稳定散列的示意色（色块/图例用；与格子自身的颜色不是一回事）。 */
  readonly color: string
  readonly grid: Grid
}

/** 显示名称：取 `displayCol`（与清单表同源）；空值退回实体名。 */
function displayNameOf(row: MapSourceRow): string {
  const displayCol = GEO_MAPS_TAB.displayCol
  if (displayCol !== undefined) {
    const value = row.values[displayCol]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return row.name
}

/** 地图名 → 稳定色相（同一名字永远同色，跨会话一致）。 */
function hueOf(name: string): number {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 360
  }
  return hash
}

/** 地图名 → 示意色（hsl 字符串；数据可视化用色，不是界面 chrome）。 */
export function mapColor(name: string): string {
  return `hsl(${hueOf(name)}, 45%, 52%)`
}

/** 行 → 画布视图：名称取「名称」列，网格从该行 values 里解析（旧数据回落缺省网格）。 */
export function rowToMapView(row: MapSourceRow): MapCanvasView {
  const name = displayNameOf(row)
  return {
    id: row.id,
    name,
    kmPerCell: kmPerCellOf(row.values[kmColumnName()]),
    color: mapColor(name),
    grid: deserializeGrid(row.values),
  }
}

/**
 * 行列表 → 画布视图列表。
 *
 * 顺序与清单表一致（`sortRows`：orderKey 码点升序）；`deleted` 行防御性过滤
 * （默认载入本就不含 deleted，这里兜一道）。
 */
export function mapViewsOf(rows: readonly MapSourceRow[]): readonly MapCanvasView[] {
  const ordered = sortRows(GEO_MAPS_TAB, rows.filter((row) => row.deleted !== true))
  return ordered.map(rowToMapView)
}

/** 快照行 → 面板行：只取《地图》模板的未删行（快照里的 `settingsEntities` 是外壳全局的，防御性过滤）。 */
export function mapRowsOf(rows: readonly SettingsEntityView[]): readonly SettingsEntityView[] {
  return rows.filter((row) => row.schemaTemplateId === GEO_MAPS_TAB.id && row.deleted !== true)
}

// ==================== 新建行 ====================

/**
 * 新地图的初始 values：名称预填建议名（表格按「名称」列显示，不预填会显示成空）、
 * 每格公里按旧版默认 '1'。编号/说明留空（编号走存储层编号规则，说明作者自己填）。
 *
 * 这里**不**预填画布尺寸：空地图本就该按缺省尺寸打开（16 × 10），
 * 尺寸只在作者真改了以后才落库 —— 免得每张新图都多两个字段。
 */
export function initialValuesForCreate(name: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const displayCol = GEO_MAPS_TAB.displayCol
  if (displayCol !== undefined) values[displayCol] = name
  const kmCol = GEO_MAPS_TAB.subtitleCol
  if (kmCol !== undefined) values[kmCol] = String(DEFAULT_KM_PER_CELL)
  return values
}