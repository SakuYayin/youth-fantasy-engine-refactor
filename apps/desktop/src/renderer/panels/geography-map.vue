<script setup lang="ts">
/**
 * 地图编辑面板（geography-map，世界构建组）。
 *
 * 本批次（W9-4 / C-08）把上游 `src/components/world/GeoMapEditor.tsx` 的**手绘格子画布**搬过来：
 * ① 工具条 —— 选择 / 画笔 / 橡皮 / 清空 + 每格公里（精 / 粗）+ 网格尺寸 + 格子颜色；
 * ② 画布 —— 一块 `宽 × 高` 的格子画布，单击涂一格、按住拖动连涂经过的格子（上游是格子铺贴，
 *    不是自由笔刷），橡皮 / Backspace 擦除；键盘可用（方向键移动光标、空格/回车涂格）；
 * ③ 详情区 —— 选中格子的坐标 / 状态 / 颜色 / 所属地图 / 这张图已绘格数；
 * ④ 状态条 —— 光标坐标 / 画布尺寸 / 已绘格数 + 颜色计数图例 + 操作提示；
 * ⑤ 数据层 —— 还原上游左侧清单：《地图》（`GEO_MAPS_TAB`，id `geomaps`）的清单表
 *    （挂载时 `loadSettingsEntities`，新建/更新走 `submitSettingsEntity`；删除/重排应用层
 *    还没有对应用例，只显回执不假装成功，接口冻结 §2/§3）。
 *
 * 画布数据的落库：整张图的已绘格子写回**该地图行**的 `values`
 * （`地图格子` / `网格宽` / `网格高` / `格子颜色`，见 `./geography-map-model.js`），
 * 走既有 `submitSettingsEntity` 通道 —— 不新增 IPC 方法名、不改契约。
 *
 * 纯逻辑（格子模型、序列化、文案）都在 `./geography-map-model.js`，这里只做渲染与调用。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'
import { YfeButton, YfePanel, designTokenVariables } from '@yfe/ui'

import type { SettingsEntityView } from '../app-state.js'
import { nextRowName, TabTableView } from '../schema/index.js'
import type { SettingsEntityId } from '../schema/index.js'

import {
  CELL_SIZE_PX,
  COARSE_KM_PER_CELL,
  DEFAULT_CELL_COLOR,
  DEFAULT_GRID_HEIGHT,
  DEFAULT_GRID_WIDTH,
  DEFAULT_KM_PER_CELL,
  FINE_KM_PER_CELL,
  GRID_COLORS,
  GRID_MAX_DIM,
  GRID_MIN_DIM,
  GRID_TOOLS,
  LOAD_FAILED_NOTICE,
  MAP_PANEL_TEXT,
  MAP_SAVE_STATE_TEXT,
  cellKey,
  clearGrid,
  createGrid,
  deletePendingNotice,
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
  mapRowsOf,
  mapViewsOf,
  moveCursor,
  newCreateKey,
  normalizeCellColor,
  paintCell,
  paintStroke,
  reorderPendingNotice,
  resizeGrid,
  strokeCells,
  submitFailureNotice,
  updateMissingRowNotice,
  valuesWithGrid,
  colorLabelOf,
  type Grid,
  type GridPoint,
  type GridStats,
  type GridTool,
  type MapCanvasView,
  type MapSaveState,
} from './geography-map-model.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

const TEXT = MAP_PANEL_TEXT

/** 页签标题：页签名为空时回落页签 id。 */
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

/** 外壳快照（唯一数据源；面板只读 + 订阅，不绕过 state）。 */
const snapshot = shallowRef(props.state.getSnapshot())

let unsubscribe: (() => void) | null = null

/** 一次性回执（新建/更新失败、删除/重排未接入、切档/改尺寸/清空）。 */
const notice = ref<string | null>(null)

/** 地图清单载入失败（持续状态，直到面板重挂载重试）。 */
const loadFailed = ref(false)

/** 面板行：只取《地图》模板的未删行（快照里的 settingsEntities 是外壳全局的，防御性过滤）。 */
const rows = computed<readonly SettingsEntityView[]>(() => mapRowsOf(snapshot.value.settingsEntities))

/** 行 → 画布视图（顺序与清单表一致：orderKey 升序）。 */
const views = computed<readonly MapCanvasView[]>(() => mapViewsOf(rows.value))

/** 设定通道读/写在途（载入期间表格进 busy 态，丢编辑事件）。 */
const busy = computed<boolean>(() => snapshot.value.settingsLoading)

/** 只读模式（外壳快照说了算；只读时画布不出笔）。 */
const readonly = computed<boolean>(() => snapshot.value.readOnly === true)

/** 明确选中的地图 id（null = 跟随清单第一张）。 */
const selectedId = ref<string | null>(null)

/** 当前画布对应的地图；一张都没有时为 null（画布区给中文空态）。 */
const activeView = computed<MapCanvasView | null>(() => {
  const list = views.value
  const found = selectedId.value === null ? undefined : list.find((view) => view.id === selectedId.value)
  return found ?? list[0] ?? null
})

const tool = ref<GridTool>('select')
const brushColor = ref<string>(DEFAULT_CELL_COLOR)
const grid = ref<Grid>(createGrid(DEFAULT_GRID_WIDTH, DEFAULT_GRID_HEIGHT))

/** 选中的格子（键盘光标与鼠标点击共用同一个焦点）。 */
const focus = ref<GridPoint | null>(null)

/**
 * 本地「每格公里」覆盖值。
 *
 * 为什么不全靠行数据：提交成功要等一个来回，快照合并前工具条的档位会弹回旧值
 * （用户会以为没点上）。这里先本地生效，行数据回来后 `watch` 复位。
 */
const kmOverride = ref<number | null>(null)

/** 当前生效的每格公里（本地覆盖优先，其次行数据，最后缺省档）。 */
const kmPerCell = computed<number>(() => kmOverride.value ?? activeView.value?.kmPerCell ?? DEFAULT_KM_PER_CELL)

/** 保存状态（面板自己的三态；画布改动走既有设定通道落库）。 */
const saveState = ref<MapSaveState>('saved')

const canPaint = computed<boolean>(() => activeView.value !== null && readonly.value === false)

/** 切换地图时重整画布：本地镜像换成该行落库的格子（旧数据回落缺省网格）。 */
watch(
  () => activeView.value?.id ?? null,
  () => {
    const view = activeView.value
    grid.value = view === null ? createGrid(DEFAULT_GRID_WIDTH, DEFAULT_GRID_HEIGHT) : view.grid
    focus.value = null
    kmOverride.value = null
  },
  { immediate: true },
)

/** 画布上的一格（已绘格子的颜色来自网格；未绘格子给缺省色，只用于 aria 文案）。 */
interface CanvasCell {
  readonly x: number
  readonly y: number
  readonly key: string
  readonly domId: string
  readonly painted: boolean
  readonly color: string
  readonly label: string
}

const cells = computed<readonly CanvasCell[]>(() => {
  const current = grid.value
  const list: CanvasCell[] = []
  for (let y = 0; y < current.height; y += 1) {
    for (let x = 0; x < current.width; x += 1) {
      const key = cellKey(x, y)
      const fill = current.cells.get(key)
      const painted = fill !== undefined
      const cellColor = fill ?? DEFAULT_CELL_COLOR
      list.push({
        x,
        y,
        key,
        domId: `geography-map-cell-${x}-${y}`,
        painted,
        color: cellColor,
        label: formatCellAriaLabel({ x, y }, painted, cellColor),
      })
    }
  }
  return list
})

const stats = computed<GridStats>(() => gridStats(grid.value))

const focusedDomId = computed<string | null>(() =>
  focus.value === null ? null : `geography-map-cell-${focus.value.x}-${focus.value.y}`,
)

/** 详情区数据（没选中格子时为 null ⇒ 显式中文说明，不留空白）。 */
interface FocusedCellInfo {
  readonly point: GridPoint
  readonly painted: boolean
  readonly color: string
}

const focusedInfo = computed<FocusedCellInfo | null>(() => {
  const point = focus.value
  if (point === null) return null
  const fill = grid.value.cells.get(cellKey(point.x, point.y))
  return { point, painted: fill !== undefined, color: fill ?? DEFAULT_CELL_COLOR }
})

const sizeLabel = computed<string>(() => formatGridSize(grid.value.width, grid.value.height))

/**
 * 详情区字段文案。
 *
 * 故意在脚本里算好（而不是模板里 `focusedInfo.point`）：模板的 `v-if/v-else` 不做
 * 跨分支类型收窄，`focusedInfo === null` 的可空性只能在脚本里处理干净。
 */
const detailCoord = computed<string>(() =>
  focusedInfo.value === null ? '' : formatCellCoord(focusedInfo.value.point),
)
const detailState = computed<string>(() =>
  focusedInfo.value === null ? '' : formatCellState(focusedInfo.value.painted),
)
const detailColor = computed<string>(() =>
  focusedInfo.value === null ? '' : colorLabelOf(focusedInfo.value.color),
)

const cursorLabel = computed<string>(() => formatCursor(focus.value))

const statsLabel = computed<string>(() => formatStatsText(stats.value))

const scaleOptions = [
  { km: FINE_KM_PER_CELL, label: TEXT.scaleFine, hint: TEXT.scaleFineHint, testId: 'geography-map-scale-fine' },
  { km: COARSE_KM_PER_CELL, label: TEXT.scaleCoarse, hint: TEXT.scaleCoarseHint, testId: 'geography-map-scale-coarse' },
] as const

// ---------- ① 数据层：载入 / 新建 / 更新 / 删除 / 重排 ----------

async function loadRows(): Promise<void> {
  const ok = await props.state.loadSettingsEntities({ schemaTemplateId: GEO_MAPS_TAB.id })
  loadFailed.value = !ok
}

onMounted(() => {
  // 先订阅再 await 载入：载入完成的 emit 一定被捕获（接口冻结 §3 持久化契约）。
  unsubscribe = props.state.subscribe((next) => {
    snapshot.value = next
  })
  // 拖拽在画布外放开也要收尾（上游「拖动涂/擦」同一语义：抬手即结束一笔）。
  window.addEventListener('pointerup', onPointerUp)
  void loadRows()
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
  window.removeEventListener('pointerup', onPointerUp)
})

/** 新建会话的幂等键：一次「+」一个稳定键（失败重试不会建出两张图）。 */
let createKey: string | null = null

async function onCreate(): Promise<void> {
  const suggested = nextRowName(GEO_MAPS_TAB, rows.value)
  createKey ??= newCreateKey(GEO_MAPS_TAB.id)
  const result = await props.state.submitSettingsEntity({
    entityId: null,
    schemaTemplateId: GEO_MAPS_TAB.id,
    name: suggested,
    values: initialValuesForCreate(suggested),
    expectedRevision: null,
    idempotencyKey: createKey,
  })
  if (result.ok) {
    // submitSettingsEntity 成功时已自行合并进快照并选中，这里不重复 reload/select。
    createKey = null
    return
  }
  notice.value = submitFailureNotice(result.code, result.message)
}

/**
 * 更新串行链：设定通道不串行写入，连打两键并发提交会拿同一个旧 revision 互撞乐观锁；
 * 串行 + 执行时重读 revision 消除该竞态（busy 期间 TabTableView 本就丢事件，链是兜底）。
 */
let updateChain: Promise<void> = Promise.resolve()

function onUpdate(id: SettingsEntityId, values: Record<string, unknown>): void {
  updateChain = updateChain
    .then(() => {
      return submitUpdate(id, values)
    })
    .catch(() => {
      // 契约上 submitSettingsEntity 不抛；这里只保证串行链不断。
    })
}

async function submitUpdate(id: SettingsEntityId, values: Record<string, unknown>): Promise<void> {
  const current = snapshot.value.settingsEntities.find((row) => row.id === id)
  if (current === undefined) {
    notice.value = updateMissingRowNotice(id)
    return
  }
  const result = await props.state.submitSettingsEntity({
    entityId: id,
    schemaTemplateId: GEO_MAPS_TAB.id,
    name: current.name,
    values,
    expectedRevision: current.revision,
  })
  if (result.ok) return
  notice.value = submitFailureNotice(result.code, result.message)
}

/** 删除只显回执：应用层的删除用例还没接入，不许假装成功。 */
function onDelete(id: SettingsEntityId): void {
  notice.value = deletePendingNotice(id)
}

/** 重排只显回执：orderKey 是 BINARY 逐字符比较，由应用层生成，面板不自己拼。 */
function onReorder(id: SettingsEntityId, beforeId: SettingsEntityId | null): void {
  notice.value = reorderPendingNotice(id, beforeId)
}

// ---------- ② 画布：绘制 / 擦除 / 键盘 ----------

function selectTool(next: GridTool): void {
  tool.value = next
}

function selectColor(next: string): void {
  brushColor.value = normalizeCellColor(next)
}

function onPickMap(event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  selectedId.value = target.value === '' ? null : target.value
}

/** 画布改动的落库：串行链 + 执行时重读该行 revision（与清单表更新同一套防撞逻辑）。 */
let saveChain: Promise<void> = Promise.resolve()

function queueSave(km: number = kmPerCell.value): void {
  const view = activeView.value
  if (view === null || readonly.value) return
  const target = view.id
  const pending = grid.value
  saveState.value = 'saving'
  saveChain = saveChain
    .then(() => submitGrid(target, pending, km))
    .catch(() => {
      // 契约上 submitSettingsEntity 不抛；这里只保证串行链不断。
      saveState.value = 'error'
    })
}

async function submitGrid(id: string, pending: Grid, kmPerCell: number): Promise<void> {
  const current = snapshot.value.settingsEntities.find((row) => row.id === id)
  if (current === undefined) {
    notice.value = updateMissingRowNotice(id)
    saveState.value = 'error'
    return
  }
  const result = await props.state.submitSettingsEntity({
    entityId: id,
    schemaTemplateId: GEO_MAPS_TAB.id,
    name: current.name,
    values: valuesWithGrid(current.values, pending, kmPerCell),
    expectedRevision: current.revision,
  })
  if (result.ok) {
    saveState.value = 'saved'
    return
  }
  saveState.value = 'error'
  notice.value = submitFailureNotice(result.code, result.message)
}

let dragging = false
let dragAnchor: GridPoint | null = null
/** 这一笔是否真的改了画布（没改就不提交，避免无谓的写入）。 */
let strokeChanged = false

/** 一笔里的一个线段：上一个格子 → 这一格子（快速拖动也不会漏格）。 */
function strokeThrough(from: GridPoint, to: GridPoint): void {
  const points = strokeCells(from, to)
  const before = grid.value
  grid.value =
    tool.value === 'eraser' ? eraseStroke(before, points) : paintStroke(before, points, brushColor.value)
  if (grid.value !== before) strokeChanged = true
}

function onCellPointerDown(cell: CanvasCell, event: PointerEvent): void {
  event.preventDefault()
  focus.value = { x: cell.x, y: cell.y }
  if (!canPaint.value || tool.value === 'select') return
  dragging = true
  strokeChanged = false
  dragAnchor = { x: cell.x, y: cell.y }
  strokeThrough(dragAnchor, dragAnchor)
}

function onCellPointerEnter(cell: CanvasCell): void {
  if (!dragging || !canPaint.value) return
  focus.value = { x: cell.x, y: cell.y }
  const anchor = dragAnchor ?? { x: cell.x, y: cell.y }
  strokeThrough(anchor, { x: cell.x, y: cell.y })
  dragAnchor = { x: cell.x, y: cell.y }
}

/** 抬手 = 一笔结束（一笔只落库一次，不逐格提交）。 */
function onPointerUp(): void {
  if (!dragging) return
  dragging = false
  dragAnchor = null
  if (strokeChanged === false) return
  strokeChanged = false
  queueSave()
}

function onClear(): void {
  if (!canPaint.value || stats.value.painted === 0) return
  grid.value = clearGrid(grid.value)
  notice.value = TEXT.clearedNotice
  queueSave()
}

function onScale(km: number): void {
  if (!canPaint.value || kmPerCell.value === km) return
  kmOverride.value = km
  notice.value = formatScaleChangedNotice(km)
  queueSave(km)
}

function onResize(axis: 'width' | 'height', event: Event): void {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return
  const parsed = Number.parseInt(target.value, 10)
  const currentSize = grid.value
  const next = Number.isFinite(parsed)
    ? axis === 'width'
      ? resizeGrid(currentSize, parsed, currentSize.height)
      : resizeGrid(currentSize, currentSize.width, parsed)
    : currentSize
  target.value = String(axis === 'width' ? next.width : next.height)
  if (next === currentSize) return
  grid.value = next
  if (focus.value !== null && !isInside(next, focus.value)) focus.value = null
  notice.value = formatSizeChangedNotice(next.width, next.height)
  queueSave()
}

/** 键盘：方向键移动光标（不改画布）；空格/回车涂格；Backspace/Delete 擦除。 */
function onCanvasKeydown(event: KeyboardEvent): void {
  if (!canPaint.value) return
  const key = event.key
  if (key === 'Backspace' || key === 'Delete') {
    event.preventDefault()
    if (focus.value === null) return
    grid.value = eraseCell(grid.value, focus.value)
    queueSave()
    return
  }
  if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
    event.preventDefault()
    const point = focus.value ?? { x: 0, y: 0 }
    focus.value = point
    grid.value = paintCell(grid.value, point, brushColor.value)
    queueSave()
    return
  }
  const moved = moveCursor(focus.value ?? { x: 0, y: 0 }, key, grid.value.width, grid.value.height)
  if (moved === null) return
  event.preventDefault()
  focus.value = moved
}
</script>

<template>
  <section class="geography-map" :style="designTokenVariables" data-testid="geography-map-panel">
    <header class="geography-map__header">
      <h2 class="geography-map__title" data-testid="geography-map-title">{{ title }}</h2>
      <p class="geography-map__intro" data-testid="geography-map-intro">{{ TEXT.intro }}</p>
      <p class="geography-map__meta">
        <span data-testid="geography-map-map-count">{{ formatMapCount(views.length) }}</span>
        <span data-testid="geography-map-cell-count">{{ formatCellCount(stats.painted) }}</span>
        <span class="geography-map__save" data-testid="geography-map-save-status" :data-status="saveState">
          {{ MAP_SAVE_STATE_TEXT[saveState] }}
        </span>
      </p>
    </header>

    <p v-if="notice !== null" class="geography-map__notice" data-testid="geography-map-notice" role="status">
      {{ notice }}
    </p>
    <p v-if="loadFailed" class="geography-map__notice" data-testid="geography-map-load-notice" role="alert">
      {{ LOAD_FAILED_NOTICE }}
    </p>
    <p v-if="readonly" class="geography-map__notice" data-testid="geography-map-readonly" role="status">
      {{ TEXT.readonlyNotice }}
    </p>

    <YfePanel :title="TEXT.canvasTitle" dense class="geography-map__panel">
      <div class="geography-map__toolbar" data-testid="geography-map-toolbar">
        <div class="geography-map__group">
          <span class="geography-map__group-label">{{ TEXT.toolGroupLabel }}</span>
          <button
            v-for="option in GRID_TOOLS"
            :key="option.id"
            type="button"
            class="geography-map__chip"
            :class="{ 'geography-map__chip--on': tool === option.id }"
            :aria-pressed="tool === option.id ? 'true' : 'false'"
            :title="option.hint"
            :disabled="!canPaint"
            :data-testid="`geography-map-tool-${option.id}`"
            @click="selectTool(option.id)"
          >
            {{ option.label }}
          </button>
        </div>

        <div class="geography-map__group">
          <span class="geography-map__group-label">{{ TEXT.colorLabel }}</span>
          <button
            v-for="option in GRID_COLORS"
            :key="option.id"
            type="button"
            class="geography-map__swatch"
            :class="{ 'geography-map__swatch--on': brushColor === option.color }"
            :style="{ background: option.color }"
            :aria-pressed="brushColor === option.color ? 'true' : 'false'"
            :aria-label="option.label"
            :title="option.label"
            :disabled="!canPaint"
            :data-testid="`geography-map-color-${option.id}`"
            @click="selectColor(option.color)"
          />
        </div>

        <div class="geography-map__group">
          <span class="geography-map__group-label">{{ TEXT.scaleLabel }}</span>
          <button
            v-for="option in scaleOptions"
            :key="option.km"
            type="button"
            class="geography-map__chip"
            :class="{ 'geography-map__chip--on': kmPerCell === option.km }"
            :aria-pressed="kmPerCell === option.km ? 'true' : 'false'"
            :title="option.hint"
            :disabled="!canPaint"
            :data-testid="option.testId"
            @click="onScale(option.km)"
          >
            {{ option.label }}
          </button>
          <span class="geography-map__scale-value">{{ formatKmPerCell(kmPerCell) }}</span>
        </div>

        <div class="geography-map__group">
          <span class="geography-map__group-label">{{ TEXT.gridSizeLabel }}</span>
          <label class="geography-map__field">
            <span class="geography-map__field-label">{{ TEXT.widthLabel }}</span>
            <input
              class="geography-map__number"
              type="number"
              :min="GRID_MIN_DIM"
              :max="GRID_MAX_DIM"
              :value="grid.width"
              :aria-label="TEXT.widthLabel"
              :disabled="!canPaint"
              data-testid="geography-map-grid-width"
              @change="onResize('width', $event)"
            />
          </label>
          <label class="geography-map__field">
            <span class="geography-map__field-label">{{ TEXT.heightLabel }}</span>
            <input
              class="geography-map__number"
              type="number"
              :min="GRID_MIN_DIM"
              :max="GRID_MAX_DIM"
              :value="grid.height"
              :aria-label="TEXT.heightLabel"
              :disabled="!canPaint"
              data-testid="geography-map-grid-height"
              @change="onResize('height', $event)"
            />
          </label>
        </div>

        <div class="geography-map__group">
          <span class="geography-map__group-label">{{ TEXT.clear }}</span>
          <YfeButton
            :label="TEXT.clear"
            variant="danger"
            :disabled="!canPaint || stats.painted === 0"
            data-testid="geography-map-clear"
            :title="TEXT.clearHint"
            @click="onClear"
          />
        </div>

        <label v-if="views.length > 0" class="geography-map__field">
          <span class="geography-map__field-label">{{ TEXT.mapPickerLabel }}</span>
          <select
            class="geography-map__select"
            :aria-label="TEXT.mapPickerLabel"
            :value="activeView?.id ?? ''"
            data-testid="geography-map-picker"
            @change="onPickMap"
          >
            <option v-for="view in views" :key="view.id" :value="view.id">{{ view.name }}</option>
          </select>
        </label>
      </div>

      <p v-if="activeView === null" class="geography-map__canvas-empty" data-testid="geography-map-canvas-empty" role="status">
        {{ TEXT.emptyMaps }}
        <span v-if="loadFailed">{{ TEXT.loadFailedHint }}</span>
      </p>

      <div
        v-else
        class="geography-map__canvas-wrap"
        role="grid"
        :tabindex="canPaint ? 0 : -1"
        :aria-label="TEXT.canvasLabel"
        :aria-rowcount="grid.height"
        :aria-colcount="grid.width"
        :aria-activedescendant="focusedDomId ?? undefined"
        data-testid="geography-map-canvas"
        @keydown="onCanvasKeydown"
      >
        <svg
          class="geography-map__canvas"
          :viewBox="`0 0 ${grid.width * CELL_SIZE_PX} ${grid.height * CELL_SIZE_PX}`"
          :width="grid.width * CELL_SIZE_PX"
          :height="grid.height * CELL_SIZE_PX"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect
            v-for="cell in cells"
            :key="cell.key"
            class="geography-map__cell"
            :class="{
              'geography-map__cell--painted': cell.painted,
              'geography-map__cell--focus': cell.domId === focusedDomId,
            }"
            :id="cell.domId"
            :data-testid="cell.domId"
            role="gridcell"
            :aria-label="cell.label"
            :x="cell.x * CELL_SIZE_PX + 1"
            :y="cell.y * CELL_SIZE_PX + 1"
            :width="CELL_SIZE_PX - 2"
            :height="CELL_SIZE_PX - 2"
            rx="1.5"
            :fill="cell.painted ? cell.color : 'transparent'"
            :fill-opacity="cell.painted ? 0.42 : 0.06"
            @pointerdown="onCellPointerDown(cell, $event)"
            @pointerenter="onCellPointerEnter(cell)"
          />
        </svg>
      </div>

      <div class="geography-map__status" data-testid="geography-map-status" role="status">
        <span data-testid="geography-map-status-cursor">{{ cursorLabel }}</span>
        <span data-testid="geography-map-status-size">{{ TEXT.sizeLabel }}：{{ sizeLabel }}</span>
        <span data-testid="geography-map-status-count">{{ statsLabel }}</span>
        <span class="geography-map__hint" data-testid="geography-map-status-hint">{{ TEXT.hint }}</span>
      </div>

      <div v-if="stats.painted > 0" class="geography-map__legend" data-testid="geography-map-legend">
        <span class="geography-map__group-label">{{ TEXT.legendTitle }}</span>
        <span
          v-for="entry in stats.colors"
          :key="entry.color"
          class="geography-map__legend-item"
          :data-color="entry.color"
          data-testid="geography-map-legend-item"
        >
          <span class="geography-map__legend-dot" :style="{ background: entry.color }" aria-hidden="true" />
          {{ formatColorCount(entry.color, entry.count) }}
        </span>
      </div>
      <p v-else class="geography-map__legend-empty" data-testid="geography-map-legend-empty">
        {{ TEXT.legendEmpty }}
      </p>
    </YfePanel>

    <YfePanel :title="TEXT.detailTitle" dense class="geography-map__panel">
      <p v-if="focusedInfo === null" class="geography-map__detail-empty" data-testid="geography-map-detail-empty">
        {{ TEXT.emptyCellDetail }}
      </p>
      <dl v-else class="geography-map__detail" data-testid="geography-map-detail">
        <dt>{{ TEXT.detailCoord }}</dt>
        <dd data-testid="geography-map-detail-coord">{{ detailCoord }}</dd>
        <dt>{{ TEXT.detailState }}</dt>
        <dd data-testid="geography-map-detail-state">{{ detailState }}</dd>
        <dt>{{ TEXT.detailColor }}</dt>
        <dd data-testid="geography-map-detail-color">{{ detailColor }}</dd>
        <dt>{{ TEXT.detailMap }}</dt>
        <dd data-testid="geography-map-detail-map">{{ activeView?.name }}</dd>
        <dt>{{ TEXT.detailCount }}</dt>
        <dd data-testid="geography-map-detail-count">{{ formatCellCount(stats.painted) }}</dd>
      </dl>
    </YfePanel>

    <section class="geography-map__list" data-testid="geography-map-list">
      <TabTableView
        :tab="GEO_MAPS_TAB"
        :rows="rows"
        :busy="busy"
        @create="onCreate"
        @update="onUpdate"
        @delete="onDelete"
        @reorder="onReorder"
      />
    </section>
  </section>
</template>

<style scoped>
.geography-map {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  min-height: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.geography-map__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.geography-map__title {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-lg, 18px);
  line-height: var(--yfe-font-line-height, 1.5);
}

.geography-map__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.geography-map__meta {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #e8b96b);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-warning, #e8b96b);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__panel {
  min-height: 0;
}

.geography-map__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--yfe-space-md, 12px);
  margin-bottom: var(--yfe-space-md, 12px);
}

.geography-map__group {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.geography-map__group-label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__field {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.geography-map__field-label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__chip {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
  cursor: pointer;
}

.geography-map__chip--on {
  border-color: var(--yfe-color-accent, #5b8cff);
  color: var(--yfe-color-accent, #5b8cff);
}

.geography-map__chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.geography-map__chip:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.geography-map__swatch {
  width: var(--yfe-size-status-dot, 14px);
  height: var(--yfe-size-status-dot, 14px);
  padding: 0;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4152);
  border-radius: var(--yfe-radius-sm, 4px);
  cursor: pointer;
}

.geography-map__swatch--on {
  border-color: var(--yfe-color-text, #e6e8ee);
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-accent, #5b8cff);
  outline-offset: 1px;
}

.geography-map__swatch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.geography-map__scale-value,
.geography-map__hint {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__number {
  width: 4.5rem;
  height: var(--yfe-size-control-height-sm, 26px);
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__select {
  min-width: 9rem;
  height: var(--yfe-size-control-height-sm, 26px);
  padding: 0 var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__canvas-wrap {
  overflow: auto;
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-background, #111318);
}

.geography-map__canvas-wrap:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.geography-map__canvas {
  display: block;
  width: 100%;
  height: auto;
  max-height: 24rem;
  touch-action: none;
}

.geography-map__cell {
  stroke: var(--yfe-color-border, #2a2f3a);
  stroke-width: 1;
  cursor: crosshair;
}

.geography-map__cell--focus {
  stroke: var(--yfe-color-focus-ring, #5b8cff);
  stroke-width: 2;
}

.geography-map__canvas-empty,
.geography-map__legend-empty,
.geography-map__detail-empty {
  margin: 0;
  padding: var(--yfe-space-xl, 24px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__legend-empty {
  padding: var(--yfe-space-sm, 8px) 0;
  border: 0;
}

.geography-map__status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
  margin-top: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-xs, 4px) 0;
  border-top: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
  margin-top: var(--yfe-space-xs, 4px);
}

.geography-map__legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__legend-dot {
  width: var(--yfe-size-status-dot, 8px);
  height: var(--yfe-size-status-dot, 8px);
  border-radius: var(--yfe-radius-pill, 999px);
}

.geography-map__detail {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--yfe-space-xs, 4px) var(--yfe-space-md, 12px);
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__detail dt {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.geography-map__detail dd {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
}

.geography-map__save[data-status='saving'] {
  color: var(--yfe-color-warning, #e8b96b);
}

.geography-map__save[data-status='error'] {
  color: var(--yfe-color-danger, #ff7b72);
}

.geography-map__list {
  min-height: 0;
}
</style>