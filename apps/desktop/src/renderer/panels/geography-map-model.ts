/**
 * 地图编辑面板（geography-map）的纯逻辑层。
 *
 * 面板本期做两层（完整画布编辑器/绘制/标记/底图全部留待后续批次，见 `SKETCH_PREVIEW_NOTICE`）：
 * ① 数据层 —— 《地图》（`GEO_MAPS_TAB`，id `geomaps`）的地图清单表，走 AppState 的
 *    `settingsEntities` 通道：挂载时 `loadSettingsEntities`，新建/更新走
 *    `submitSettingsEntity`；删除/重排应用层还没有对应用例，只显回执不假装成功。
 * ② 可视化层 —— 每张地图一条「名称 + 每格公里」色块条示意。
 *
 * 行 → 示意数据的映射、提示文案、常量都在这里（纯函数，无 Vue、无 DOM ⇒ 可无头单测），
 * `.vue` 只做渲染与调用（接口冻结 §2：组件内不写死大段静态文案）。
 */

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'

import type { SettingsEntityView } from '../app-state.js'
import { sortRows } from '../schema/index.js'

// ==================== 面板常量（可见文本 ⊆ 页签文案 ∪ 这里的常量） ====================

/** 可视化层的标题。 */
export const SKETCH_TITLE = '地图示意'

/** 显式标注：本期是简化示意，完整画布编辑器后续批次落地。 */
export const SKETCH_PREVIEW_NOTICE = '预览版简化视图（完整画布编辑器后续批次）'

/** 示意图空态：一张地图都没有时（引导去下方的清单表新建）。 */
export const SKETCH_EMPTY_NOTICE = '还没有地图：在下方表格点「+」新建一张。'

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

// ==================== 「每格公里」与示意映射 ====================

/** 「每格公里」缺省档（GEO_MAPS_TAB 的选项是 '1'/'10'；空值/解析失败按 1，与旧版一致）。 */
export const DEFAULT_KM_PER_CELL = 1

/** 精细档（每格 1 公里）示意条的格子数：更长，视觉上更细。 */
export const SKETCH_CELLS_FINE = 12

/** 粗略档（每格 10 公里）示意条的格子数。 */
export const SKETCH_CELLS_COARSE = 6

/** 示意色块的饱和度/亮度（色相由地图名稳定散列；数据可视化用色，非界面 chrome）。 */
const SKETCH_SATURATION = 45
const SKETCH_LIGHTNESS = 52

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

/** 每格公里 → 示意条格子数：精细档（≤1）更长，粗略档更短。 */
export function cellsForScale(kmPerCell: number): number {
  return kmPerCell <= 1 ? SKETCH_CELLS_FINE : SKETCH_CELLS_COARSE
}

/** 地图名 → 稳定色相（同一名字永远同色，跨会话一致）。 */
function hueOf(name: string): number {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 360
  }
  return hash
}

/** 地图名 → 示意色块填充色（hsl 字符串）。 */
export function sketchColor(name: string): string {
  return `hsl(${hueOf(name)}, ${SKETCH_SATURATION}%, ${SKETCH_LIGHTNESS}%)`
}

/**
 * 示意映射只认这三样：`id` / `name` / `values`。
 *
 * 故意收窄：`SettingsEntityView`（AppState 快照行）与 `EntityRow`（表格视图行）都满足它，
 * 两边不用互转。
 */
export interface SketchSourceRow {
  readonly id: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  /** 可选：快照行带 `deleted`（boolean），清单表行没有。示意映射只用来防御性过滤。 */
  readonly deleted?: unknown
}

/** 示意条显示的名称：取 `displayCol`（与清单表同源）；空值退回实体名。 */
function sketchNameOf(row: SketchSourceRow): string {
  const displayCol = GEO_MAPS_TAB.displayCol
  if (displayCol !== undefined) {
    const value = row.values[displayCol]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return row.name
}

/** 公里数 → 展示文本（Number 转字符串：1 → '1'，1.5 → '1.5'）。 */
function formatKm(kmPerCell: number): string {
  return String(kmPerCell)
}

/** 一张地图的示意数据（可视化层直接渲染，不再解释行数据）。 */
export interface MapSketch {
  readonly id: string
  readonly name: string
  readonly kmPerCell: number
  readonly cells: number
  readonly color: string
  readonly kmLabel: string
}

/** 行 → 示意数据：名称取「名称」列（空值退回实体名），色相由名称稳定散列。 */
export function rowToSketch(row: SketchSourceRow): MapSketch {
  const name = sketchNameOf(row)
  const km = kmPerCellOf(row.values[kmColumnName()])
  return {
    id: row.id,
    name,
    kmPerCell: km,
    cells: cellsForScale(km),
    color: sketchColor(name),
    kmLabel: `${kmColumnName()}：${formatKm(km)}`,
  }
}

/**
 * 行列表 → 示意数据列表。
 *
 * 顺序与清单表一致（`sortRows`：orderKey 码点升序）；`deleted` 行防御性过滤
 * （默认载入本就不含 deleted，这里兜一道）。
 */
export function rowsToSketches(rows: readonly SketchSourceRow[]): readonly MapSketch[] {
  const ordered = sortRows(GEO_MAPS_TAB, rows.filter((row) => row.deleted !== true))
  return ordered.map(rowToSketch)
}

/** 快照行 → 面板行：只取《地图》模板的未删行（快照里的 `settingsEntities` 是外壳全局的，防御性过滤）。 */
export function mapRowsOf(rows: readonly SettingsEntityView[]): readonly SettingsEntityView[] {
  return rows.filter((row) => row.schemaTemplateId === GEO_MAPS_TAB.id && row.deleted !== true)
}

// ==================== 新建行 ====================

/**
 * 新地图的初始 values：名称预填建议名（表格按「名称」列显示，不预填会显示成空）、
 * 每格公里按旧版默认 '1'。编号/说明留空（编号走存储层编号规则，说明作者自己填）。
 */
export function initialValuesForCreate(name: string): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const displayCol = GEO_MAPS_TAB.displayCol
  if (displayCol !== undefined) values[displayCol] = name
  const kmCol = GEO_MAPS_TAB.subtitleCol
  if (kmCol !== undefined) values[kmCol] = String(DEFAULT_KM_PER_CELL)
  return values
}
