<script setup lang="ts">
/**
 * 通用表格渲染器（W3）：旧版 18 个 `type: 'table'` 页签共用的界面。
 *
 * 契约：`docs/接口冻结-渲染层.md` §3「W3 — 表格渲染器」。本组件是**纯展示 + 事件**：
 * 只认 props、只 emit 意图，不直连 IPC、不 import `@yfe/client-sdk`、不 import `node:*`。
 *
 * ## 三条硬约定（§2）的落点
 *
 * 1. **getter 元数据只能属性读**：`tab.name` / `tab.columns` / `tab.tips` 在六个题材页签上是
 *    getter，切题材包即变。所以下面所有派生值都写成**函数**（`columns()` / `orderedRows()`），
 *    在模板里调用 —— 每次渲染重新读一遍属性；**没有** `computed` 缓存，也不把结果存成字段
 *    （缓存 = 切包后界面还是旧题材的列，且看不出哪里错了）。
 * 2. `hidden` 列由 `visibleColumns` 过滤掉，但数据一字不动。
 * 3. 中文文案**只来自 `TabDef`**：标题取 `tab.name`，空态/说明取 `tab.description`，
 *    编号规则取 `tab.codeRule`，表头取列名（存储键），页脚取 `tab.tips`，控件的
 *    `aria-label` 取列名。所以新增/删除/上移/下移这些**没有**元数据文案的动作，
 *    按钮上只用符号（`+` `×` `↑` `↓`）而不是另写一套中文标签 —— 组件里一旦写中文，
 *    页签改名时就会与元数据对不上。
 * 4. `tableRef` 列永远不手输（旧版 `TableRefSelect` 的口径：手输必然写出「青岚宗 / 青岚派」
 *    这种归属错乱）。它显示引用名 + 一个 `<select>`（选项来自外壳的 `refOptions`），
 *    `refOptions` 缺省时整列退回只读文本。
 */

import { designTokenVariables, YfeButton } from '@yfe/ui'
import type { TabDef, TableColumn } from '@yfe/schema-tabs'
import { ref } from 'vue'

import type { EntityRow } from './entity-row.js'
import {
  cellText,
  editableCell,
  nextRowName,
  sortRows,
  visibleColumns,
  type SettingsEntityId,
} from './schema-table.js'

/** 跨表引用候选：`label` 是引用名（也是落库值，旧版口径），`id` 用于匹配已有值。 */
interface TableRefOption {
  id: string
  label: string
}

/** 单元格控件种类：模板按它分派，避免在模板里堆一长串条件。 */
type CellControl = 'ref' | 'select' | 'textarea' | 'number' | 'date' | 'text'

const props = defineProps<{
  tab: TabDef
  rows: readonly EntityRow[]
  readonly?: boolean
  busy?: boolean
  /**
   * 跨表引用候选（由外壳 W5 提供，见 §3）：给定列返回候选 `{id,label}[]`。
   * **缺省时 `tableRef` 列只读**（只显示引用名，不给选择控件）。
   */
  refOptions?: (column: TableColumn) => readonly TableRefOption[]
}>()

const emit = defineEmits<{
  create: []
  update: [id: SettingsEntityId, values: Record<string, unknown>]
  delete: [id: SettingsEntityId]
  reorder: [id: SettingsEntityId, beforeId: SettingsEntityId | null]
}>()

/** 中文输入法组合中：组合期间的 `input` 事件带着未上屏的拼音，绝不能落库。 */
const composing = ref(false)

/**
 * 最近一次 emit 的单元格文本。
 *
 * 文本框同时听 `input`（逐键）与 `change`（失焦/回车）—— 同一次编辑两个事件会带着**同一个值**
 * 先后到达，不去重就会把同一次修改发两遍（外壳收到两次 update、版本号白涨）。所以记住最近一次
 * `(行, 列, 文本)`，重复的直接丢掉。
 */
let lastEmitted: { rowId: string; column: string; text: string } | null = null

// ==================== 派生值（一律现读，见头注第 1 条） ====================

/** 要渲染的列（过滤 `hidden`）。 */
function columns(): TableColumn[] {
  return visibleColumns(props.tab)
}

/** 排好序的行（`orderKey` 升序，`newestFirst` 取反）。 */
function orderedRows(): EntityRow[] {
  return sortRows(props.tab, props.rows)
}

/** 是否显示上移/下移：只读态不给改；`newestFirst` 表的顺序由创建时间决定，手动重排没有意义。 */
function showReorder(): boolean {
  return props.readonly !== true && props.tab.newestFirst !== true
}

/** 新建行的建议名字（`tab.name` + 最小空号），同时作为「+」按钮的提示。 */
function createName(): string {
  return nextRowName(props.tab, props.rows)
}

// ==================== 单元格 ====================

/** 展示文本（只读态、`tableRef` 引用名都用它）。 */
function displayText(column: TableColumn, row: EntityRow): string {
  if (column.type === 'tableRef') return refLabel(column, row)
  return cellText(column, row)
}

/** 空值占位。用长破折号而不是中文「无」：组件里不另写中文文案。 */
function emptyMark(text: string): string {
  return text === '' ? '—' : text
}

/** 超长内容截断后，`title` 里给出全文（CSS 只负责视觉截断）。 */
function hint(text: string): string | undefined {
  return text === '' ? undefined : text
}

/** 控件类型分派。 */
function controlOf(column: TableColumn, row: EntityRow): CellControl {
  if (column.type === 'tableRef') return 'ref'
  if ((column.type === 'select' || column.calendar === true) && hasDeclaredOptions(column)) return 'select'
  if (column.type === 'textarea') return 'textarea'
  if (column.type === 'number') return 'number'
  // `date` 列**刻意**用文本输入：旧版这一列是故事内时间（「3024年3月」这类作者手写文本），
  // 原生 `<input type="date">` 解析不了这种值，会把**已有的数据在界面上显示成空**。
  // 真实日历日期走 `calendar: true`（下拉）/ 后续专属控件。
  if (column.type === 'date') return 'date'
  return 'text'
}

function hasDeclaredOptions(column: TableColumn): boolean {
  return (column.options ?? []).some((option) => option !== '')
}

/**
 * `<select>` 的候选值：声明选项（去掉空串）＋（非 `fixedOptions` 时）当前值。
 *
 * `fixedOptions === true` ＝ 封闭枚举：值不在选项里就不认（不给它补一个选项，
 * 免得看起来「合法」）；否则把作者已有的自定义值保留成可选项，不然改一下别的列
 * 就会把这一格的自定义值静默丢掉。
 */
function selectOptions(column: TableColumn, row: EntityRow): string[] {
  const declared = (column.options ?? []).filter((option) => option !== '')
  if (column.fixedOptions === true) return declared
  const current = cellText(column, row)
  if (current === '' || declared.includes(current)) return declared
  return [...declared, current]
}

// ==================== 跨表引用 ====================

function refOptionsFor(column: TableColumn): readonly TableRefOption[] {
  const provider = props.refOptions
  if (typeof provider !== 'function') return []
  const list = provider(column)
  return Array.isArray(list) ? list : []
}

/** 引用名：落库值就是被引用行的名字；外壳给了候选表就按 id/label 再翻译一次。 */
function refLabel(column: TableColumn, row: EntityRow): string {
  const stored = cellText(column, row)
  if (stored === '') return ''
  const matched = refOptionsFor(column).find((option) => option.label === stored || option.id === stored)
  return matched ? matched.label : stored
}

/** 能不能给这一格选项：外壳提供了 `refOptions` 且不是只读态。 */
function canPickRef(column: TableColumn): boolean {
  return props.readonly !== true && typeof props.refOptions === 'function'
}

/** 选项的落库值：引用名（label），label 为空时退回 id。 */
function refOptionValue(option: TableRefOption): string {
  return option.label !== '' ? option.label : option.id
}

/**
 * 「选择」按钮：把焦点/原生下拉交给同一格里的 `<select>`。
 *
 * 选择器本身仍由外壳的候选（`refOptions`）提供，这里只是给鼠标一个显式的「选择」入口。
 * `showPicker()` 并非所有环境都实现（happy-dom 早期版本没有），检测不到就退回 `focus()`。
 */
function openRefPicker(event: MouseEvent): void {
  if (props.readonly === true || props.busy === true) return
  const trigger = event.currentTarget
  if (!(trigger instanceof HTMLElement)) return
  const picker = trigger.closest('td')?.querySelector('select')
  if (picker === null || picker === undefined) return
  const maybeShowPicker: { showPicker?: () => void } = picker
  if (typeof maybeShowPicker.showPicker === 'function') maybeShowPicker.showPicker()
  else picker.focus()
}

// ==================== 事件 → emit ====================

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 该行的 values 副本（update 交回**整行**，外壳可直接落库，不必自己合并）。 */
function valuesOf(row: EntityRow): Record<string, unknown> {
  const values: unknown = row.values
  return isPlainRecord(values) ? { ...values } : {}
}

/** 控件读出的文本：数字列再兜一道「只留数字」（浏览器 type=number 在部分环境会把原文交给脚本）。 */
function normalizeInput(column: TableColumn, raw: string): string {
  if (column.type !== 'number') return raw
  return raw.replace(/[^0-9.eE+-]/gu, '')
}

/**
 * 提交一次单元格编辑：`update` 携带该行**合并后**的完整 `values`（§3 的签名就是
 * `Record<string, unknown>`，外壳拿到即可落库）。
 */
function emitCell(column: TableColumn, row: EntityRow, text: string): void {
  if (props.readonly === true || props.busy === true) return
  const previous = lastEmitted
  if (previous !== null && previous.rowId === row.id && previous.column === column.name && previous.text === text) {
    return
  }
  lastEmitted = { rowId: row.id, column: column.name, text }
  emit('update', row.id, { ...valuesOf(row), [column.name]: text })
}

function controlValueOf(event: Event): string {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
  return target === null ? '' : target.value
}

/**
 * 文本/数字/多行输入。
 *
 * `input` 逐键到达、`change` 在失焦或回车时到达，两者都接（外壳可自行节流），
 * 重复的同一份文本由 `lastEmitted` 挡掉。中文输入法组合期间不发（见 `composing`）。
 */
function onControlInput(column: TableColumn, row: EntityRow, event: Event, fromComposition = false): void {
  if (composing.value && !fromComposition) return
  if (fromComposition) composing.value = false
  emitCell(column, row, normalizeInput(column, controlValueOf(event)))
}

function onCompositionStart(): void {
  composing.value = true
}

/** `<select>`（普通列选项 与 `tableRef` 引用）都走这里。 */
function onControlChange(column: TableColumn, row: EntityRow, event: Event): void {
  if (column.type === 'tableRef') {
    const value = controlValueOf(event)
    if (value === cellText(column, row)) return
    emitCell(column, row, value)
    return
  }
  emitCell(column, row, normalizeInput(column, controlValueOf(event)))
}

function onCreate(): void {
  if (props.readonly === true || props.busy === true) return
  emit('create')
}

function onDelete(row: EntityRow): void {
  if (props.readonly === true || props.busy === true) return
  emit('delete', row.id)
}

/**
 * 重排：把 `row` 放到 `beforeId` 之前；`beforeId === null` ＝ 挪到末尾。
 *
 * 上移 = 放到「当前显示顺序里它的前一行」之前；下移 = 放到「它的后一行的后一行」之前 ——
 * 这样一次只挪一格，且与 `= null` 的语义（末尾）自然衔接。`beforeId` 始终是**行的 id**，
 * 由外壳（W5）负责换算 `order_key`。
 */
function moveUp(row: EntityRow, index: number): void {
  if (props.readonly === true || props.busy === true || index <= 0) return
  const before = orderedRows()[index - 1]
  if (before === undefined) return
  emit('reorder', row.id, before.id)
}

function moveDown(row: EntityRow, index: number): void {
  if (props.readonly === true || props.busy === true) return
  const list = orderedRows()
  if (index >= list.length - 1) return
  const afterNext = list[index + 2]
  emit('reorder', row.id, afterNext === undefined ? null : afterNext.id)
}
</script>

<template>
  <section
    class="tab-table"
    :class="{ 'tab-table--readonly': readonly === true, 'tab-table--busy': busy === true }"
    :style="designTokenVariables"
    :data-testid="`tab-table-${tab.id}`"
    :data-tab-id="tab.id"
    :data-readonly="readonly === true ? 'true' : 'false'"
  >
    <header class="tab-table__head">
      <div class="tab-table__titles">
        <h2 class="tab-table__title" data-testid="tab-table-title">{{ tab.name }}</h2>
        <p v-if="tab.description !== ''" class="tab-table__desc" data-testid="tab-table-description">
          {{ tab.description }}
        </p>
        <p v-if="tab.codeRule !== undefined && tab.codeRule !== ''" class="tab-table__rule" data-testid="tab-table-code-rule">
          {{ tab.codeRule }}
        </p>
      </div>
      <div v-if="readonly !== true" class="tab-table__head-actions">
        <YfeButton
          label="+"
          variant="primary"
          :disabled="busy === true"
          :title="createName()"
          :data-testid="`table-create-${tab.id}`"
          @click="onCreate"
        />
      </div>
    </header>

    <!-- 空态：无可见列，或一行都还没有 —— 文案只能来自 TabDef（description） -->
    <p
      v-if="columns().length === 0 || orderedRows().length === 0"
      class="tab-table__empty"
      data-testid="tab-table-empty"
    >
      {{ tab.description }}
    </p>

    <div v-else class="tab-table__scroll">
      <table class="tab-table__grid" data-testid="table-grid">
        <thead>
          <tr>
            <th class="tab-table__th tab-table__th--index" data-testid="table-th-index">#</th>
            <th
              v-for="column in columns()"
              :key="column.name"
              class="tab-table__th"
              :style="{ width: column.width }"
              :title="column.tip"
              :data-column="column.name"
              :data-testid="`table-th-${column.name}`"
            >
              {{ column.name }}
            </th>
            <th v-if="readonly !== true" class="tab-table__th tab-table__th--actions" data-testid="table-th-actions" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in orderedRows()"
            :key="row.id"
            class="tab-table__tr"
            :data-row-id="row.id"
            :data-testid="`table-row-${row.id}`"
          >
            <td class="tab-table__td tab-table__td--index" data-testid="table-cell-index">{{ index + 1 }}</td>
            <td
              v-for="column in columns()"
              :key="column.name"
              class="tab-table__td"
              :data-column="column.name"
              :data-testid="`table-cell-${column.name}`"
            >
              <!-- ① 跨表引用：只读展示引用名 +（外壳给了候选时）选择控件 -->
              <template v-if="controlOf(column, row) === 'ref'">
                <span
                  class="tab-table__text tab-table__text--ref"
                  :title="hint(displayText(column, row))"
                  :data-testid="`table-cell-text-${column.name}`"
                >
                  {{ emptyMark(displayText(column, row)) }}
                </span>
                <template v-if="canPickRef(column)">
                  <select
                    class="tab-table__control tab-table__control--ref"
                    :value="cellText(column, row)"
                    :disabled="busy === true"
                    :aria-label="column.name"
                    :data-testid="`table-ref-${column.name}`"
                    @change="onControlChange(column, row, $event)"
                  >
                    <option value="" />
                    <option
                      v-for="option in refOptionsFor(column)"
                      :key="option.id"
                      :value="refOptionValue(option)"
                      :data-ref-id="option.id"
                    >
                      {{ refOptionValue(option) }}
                    </option>
                  </select>
                  <YfeButton
                    label="▾"
                    :disabled="busy === true"
                    :title="column.name"
                    :data-testid="`table-ref-button-${column.name}`"
                    @click="openRefPicker"
                  />
                </template>
              </template>

              <!-- ② 行内编辑（只读态不渲染任何控件） -->
              <template v-else-if="readonly !== true && editableCell(column)">
                <select
                  v-if="controlOf(column, row) === 'select'"
                  class="tab-table__control"
                  :value="cellText(column, row)"
                  :disabled="busy === true"
                  :aria-label="column.name"
                  :data-testid="`table-cell-select-${column.name}`"
                  @change="onControlChange(column, row, $event)"
                >
                  <option value="" />
                  <option v-for="option in selectOptions(column, row)" :key="option" :value="option">{{ option }}</option>
                </select>
                <textarea
                  v-else-if="controlOf(column, row) === 'textarea'"
                  class="tab-table__control tab-table__control--multiline"
                  rows="2"
                  :value="cellText(column, row)"
                  :disabled="busy === true"
                  :aria-label="column.name"
                  :data-testid="`table-cell-input-${column.name}`"
                  @input="onControlInput(column, row, $event)"
                  @change="onControlInput(column, row, $event)"
                  @compositionstart="onCompositionStart"
                  @compositionend="onControlInput(column, row, $event, true)"
                />
                <input
                  v-else-if="controlOf(column, row) === 'number'"
                  class="tab-table__control"
                  type="number"
                  step="any"
                  inputmode="decimal"
                  :value="cellText(column, row)"
                  :disabled="busy === true"
                  :aria-label="column.name"
                  :data-testid="`table-cell-input-${column.name}`"
                  @input="onControlInput(column, row, $event)"
                  @change="onControlInput(column, row, $event)"
                  @compositionstart="onCompositionStart"
                  @compositionend="onControlInput(column, row, $event, true)"
                />
                <input
                  v-else
                  class="tab-table__control"
                  type="text"
                  :value="cellText(column, row)"
                  :disabled="busy === true"
                  :aria-label="column.name"
                  :data-testid="`table-cell-input-${column.name}`"
                  @input="onControlInput(column, row, $event)"
                  @change="onControlInput(column, row, $event)"
                  @compositionstart="onCompositionStart"
                  @compositionend="onControlInput(column, row, $event, true)"
                />
              </template>

              <!-- ③ 只读/不可编辑：截断 + title 全文 -->
              <span
                v-else
                class="tab-table__text tab-table__text--clamp"
                :title="hint(displayText(column, row))"
                :data-testid="`table-cell-text-${column.name}`"
              >
                {{ emptyMark(displayText(column, row)) }}
              </span>
            </td>
            <td v-if="readonly !== true" class="tab-table__td tab-table__td--actions" data-testid="table-cell-actions">
              <YfeButton
                v-if="showReorder()"
                label="↑"
                :disabled="busy === true || index === 0"
                :data-testid="`table-reorder-up-${row.id}`"
                @click="moveUp(row, index)"
              />
              <YfeButton
                v-if="showReorder()"
                label="↓"
                :disabled="busy === true || index === orderedRows().length - 1"
                :data-testid="`table-reorder-down-${row.id}`"
                @click="moveDown(row, index)"
              />
              <YfeButton
                label="×"
                variant="danger"
                :disabled="busy === true"
                :data-testid="`table-delete-${row.id}`"
                @click="onDelete(row)"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <ul v-if="tab.tips !== undefined && tab.tips.length > 0" class="tab-table__tips" data-testid="tab-table-tips">
        <li v-for="tip in tab.tips" :key="tip" class="tab-table__tip" data-testid="tab-table-tip">{{ tip }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.tab-table {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
  color: var(--yfe-color-text);
}

.tab-table__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--yfe-space-md);
}

.tab-table__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg);
  font-weight: var(--yfe-font-weight-medium);
}

.tab-table__desc,
.tab-table__rule,
.tab-table__empty {
  margin: var(--yfe-space-xs) 0 0;
  color: var(--yfe-color-text-muted);
  font-size: var(--yfe-font-size-sm);
}

.tab-table__empty {
  padding: var(--yfe-space-xl) var(--yfe-space-md);
  border: var(--yfe-size-border-width) dashed var(--yfe-color-border);
  border-radius: var(--yfe-radius-md);
  text-align: center;
}

.tab-table__scroll {
  overflow-x: auto;
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-md);
}

.tab-table__grid {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.tab-table__th,
.tab-table__td {
  padding: var(--yfe-space-xs) var(--yfe-space-sm);
  border-bottom: var(--yfe-size-border-width) solid var(--yfe-color-border);
  text-align: left;
  vertical-align: top;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-table__th {
  position: sticky;
  top: 0;
  z-index: var(--yfe-layer-sticky);
  background: var(--yfe-color-surface-raised);
  color: var(--yfe-color-text-muted);
  font-weight: var(--yfe-font-weight-medium);
  white-space: nowrap;
}

.tab-table__th--index,
.tab-table__td--index {
  width: 40px;
  color: var(--yfe-color-text-muted);
}

.tab-table__th--actions,
.tab-table__td--actions {
  width: 132px;
  white-space: nowrap;
}

.tab-table__td--actions {
  overflow: visible;
}

.tab-table__tr:hover .tab-table__td {
  background: var(--yfe-color-surface);
}

/* 超长内容截断：单行省略号；多行文本行内控件自己滚 */
.tab-table__text--clamp {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-table__text--ref {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.tab-table__control {
  box-sizing: border-box;
  width: 100%;
  height: var(--yfe-size-control-height-sm);
  padding: 0 var(--yfe-space-xs);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-sm);
  background: var(--yfe-color-background);
  color: var(--yfe-color-text);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm);
}

.tab-table__control:focus-visible {
  outline: var(--yfe-size-focus-width) solid var(--yfe-color-focus-ring);
  outline-offset: 1px;
}

.tab-table__control--multiline {
  height: auto;
  padding: var(--yfe-space-xs);
  resize: vertical;
}

.tab-table__control--ref {
  display: inline-block;
  width: auto;
  max-width: 7rem;
  margin-left: var(--yfe-space-xs);
}

.tab-table__tips {
  margin: 0;
  padding: var(--yfe-space-sm) var(--yfe-space-md);
  color: var(--yfe-color-text-muted);
  font-size: var(--yfe-font-size-sm);
  list-style: none;
}

.tab-table__tip::before {
  content: '·';
  margin-right: var(--yfe-space-xs);
}
</style>
