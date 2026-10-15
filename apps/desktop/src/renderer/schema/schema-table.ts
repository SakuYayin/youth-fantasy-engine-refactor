/**
 * 表格渲染器（W3）的**纯函数层** —— 无 DOM、无 IPC、不 import `@yfe/client-sdk`。
 *
 * 契约来源：`docs/接口冻结-渲染层.md` §3「W3 — 表格渲染器」。本文件导出五个纯函数：
 * `visibleColumns` / `cellText` / `editableCell` / `sortRows` / `nextRowName`。
 * 组件 `TabTableView.vue` 只做「把纯函数结果铺成 DOM + 把用户意图 emit 出去」。
 *
 * ## 三条不可忘的前提（同 §1 / §2）
 *
 * 1. `values` 的键就是 `TabDef.columns[].name`（**中文存储键**）：本文件只按该键取值、
 *    绝不改名 / 翻译 / 套英文别名。表头展示的也是这个键。
 * 2. `TableColumn.hidden`（`cH()` 产物）＝**保留数据但不渲染**：只有 `visibleColumns` 负责过滤，
 *    其余函数一律按「调用方已过滤好的列」工作（`cellText` 对隐藏列同样能取到值，不特殊处理）。
 * 3. 六个题材驱动页签的 `tab.modules`/`tab.name` 是 **getter**（切包即变）。所以本层每个函数都
 *    现读 `tab.xxx`，调用方（组件）也**不得把结果缓存成长期快照** —— 组件里用函数调用而非
 *    `computed`，就是为了每次渲染重新读一遍属性。
 */

import type { TabDef, TableColumn } from '@yfe/schema-tabs'

import type { EntityRow } from './entity-row.js'

/**
 * 设定实体 id。
 *
 * `docs/接口冻结-渲染层.md` §3 的 emits 签名写的就是 `SettingsEntityId`，但 `@yfe/contracts`
 * 里没有同名别名（`ids.ts` 只有 `ProjectId` / `DocumentId` 等），故就地取 `EntityRow['id']`
 * —— 结构上就是 `string`，与外壳（W5）传递的裸 id 完全一致。
 *
 * 行类型用 `EntityRow`（见 `entity-row.ts`）而不是契约的 `SettingsEntity`：外壳给的是
 * `app-state` 的 `SettingsEntityView`，它缺 `workspaceId`/`createdAt`/`updatedAt`，
 * 直接依赖契约类型会让 snapshot 传不进来。
 */
export type SettingsEntityId = EntityRow['id']

// ==================== 列 ====================

/**
 * 要渲染的列：过滤掉 `hidden === true` 的列。
 *
 * 只过滤、不排序、不拷贝列对象：`columns` 的顺序就是界面列顺序（与旧版 `tab.columns` 一致）。
 * 返回值是新数组（调用方可以放心 `.map` 而不会改到元数据）。
 */
export function visibleColumns(tab: TabDef): TableColumn[] {
  return (tab.columns ?? []).filter((column) => column.hidden !== true)
}

/**
 * 单元格值：`values` 缺失或不是对象时返回 `undefined`（脏数据不该让整张表崩掉）。
 *
 * 键就是 `TableColumn.name`（中文存储键），**不做任何改名 / 回退别名**。
 */
export function cellValue(row: EntityRow, columnName: string): unknown {
  const values: unknown = row.values
  return isRecord(values) ? values[columnName] : undefined
}

/**
 * 该列是否允许**行内自由编辑**。
 *
 * - `hidden` 列根本不渲染 ⇒ 谈不上编辑（返回 false）。
 * - `tableRef` 列是**跨表引用**：旧版 `TableRefSelect` 只让用户从来源表已有值里挑，
 *   禁止手输（手输就会出现「青岚宗 / 青岚派」这种归属错乱）。所以这里返回 false ——
 *   组件对它渲染「引用名 + 选择控件」，值只能由 `refOptions` 的选项产生。
 * - 其余类型（text / number / date / select / textarea / calendar / character / characters）
 *   都走行内控件。注意 `select` 列若**没有** `options`，旧版退化成可自由输入的下拉，
 *   本层同样返回 true，由组件回退成文本输入。
 */
export function editableCell(column: TableColumn): boolean {
  if (column.hidden === true) return false
  if (column.type === 'tableRef') return false
  return true
}

// ==================== 单元格文本 ====================

/**
 * 单元格的**展示文本**（只读态、文本列、以及任何控件的兜底显示都用它）。
 *
 * 按 `column.type` 格式化：
 * - `number`：数字原样（`7` → `'7'`），字符串 trim；不做千分位 —— 设定表里的数字
 *   （战力 / 年龄 / 编号）要能原样读回，加了分隔符反而认不出。
 * - `date`：ISO 时间戳只显示到日（`'3024-03-01T00:00:00.000Z'` → `'3024-03-01'`）；
 *   旧版作者手写的「3024年3月」这类文本原样保留（历法化之后见 `calendar`）。
 * - `characters`：多值，**顿号连接**（`['甲','乙']` → `'甲、乙'`；字符串里的
 *   `,` / `，` / `;` / `；` 也统一成 `、`，与旧版落库口径一致）。
 * - `tableRef`：展示**引用名**。落库值就是被引用行 `refCol` 列的名字（旧版
 *   `TableRefSelect` 把 `refCol` 的值写进单元格），所以直接取字符串；
 *   若外壳把结构化对象写进来，回退取 `label` → `name` → `id`。
 * - 其它（text / textarea / select / calendar / character）：文本原样。
 */
export function cellText(column: TableColumn, row: EntityRow): string {
  const raw = cellValue(row, column.name)
  switch (column.type) {
    case 'number':
      return numberText(raw)
    case 'date':
      return dateText(raw)
    case 'characters':
      return charactersText(raw)
    case 'tableRef':
      return refNameText(raw)
    default:
      return plainText(raw)
  }
}

// ==================== 排序 ====================

/**
 * 行顺序：按 `orderKey` 升序；`tab.newestFirst === true` 时**取反**（越新创建越靠上）。
 *
 * - `orderKey` 是持久化层生成的不透明「分数索引」字符串，**只做比较、不解析**；
 *   用码点比较（不是 `localeCompare`）—— 它保证与生成顺序一致且与语言环境无关。
 * - `newestFirst` 且 `orderKey` 相同的行（同一批写入）用 `createdAt` 兜底降序，
 *   否则保持入参顺序（`Array.prototype.sort` 稳定），避免"看起来随机"。
 * - **不修改入参**（先 `[...rows]`）；行数 < 2 直接返回副本。
 *
 * 旧版 `useTableSheetModel.sortRows` 里那套「有『编号』列按编号自然排序」没有搬过来：
 * 冻结契约只规定 `newestFirst` 取反，而新库里行序由 `orderKey` 承载；编号自然排序若要回来，
 * 应该在 W5 生成 `orderKey` 时决定，而不是在渲染层二次排序（否则拖拽重排会被排序覆盖）。
 */
export function sortRows(tab: TabDef, rows: readonly EntityRow[]): EntityRow[] {
  const list = [...rows]
  if (list.length < 2) return list
  const newestFirst = tab.newestFirst === true
  list.sort((a, b) => {
    const byKey = compare(orderKeyOf(a), orderKeyOf(b))
    if (byKey !== 0) return newestFirst ? -byKey : byKey
    if (!newestFirst) return 0
    return compare(createdAtOf(b), createdAtOf(a))
  })
  return list
}

// ==================== 新建行命名 ====================

/**
 * 给「新建一行」算一个**未占用**的名字。
 *
 * 名字由 `tab.name`（中文文案唯一来源，组件不得另写一份）+ 序号构成：
 * 首个空位是 `tab.name`，占用后再取 `tab.name 1`、`tab.name 2`…（最小可用序号）。
 * 同时把 `displayCol` 列上的值算作已占用 —— §1 规定「`displayCol` 存在时用它的值做展示名」，
 * 所以两者共用一个命名空间，避免新建行的名字与现有行的展示名撞车。
 *
 * `tab.name` 为空串时退回 `tab.id`（不是 UI 文案，只是保证返回值非空）。
 */
export function nextRowName(tab: TabDef, rows: readonly EntityRow[]): string {
  const base = tab.name.trim() !== '' ? tab.name.trim() : tab.id
  const used = new Set<string>()
  for (const row of rows) {
    const own = ownNameOf(row).trim()
    if (own !== '') used.add(own)
    const displayCol = tab.displayCol
    if (displayCol === undefined || displayCol === '') continue
    const shown = plainText(cellValue(row, displayCol)).trim()
    if (shown !== '') used.add(shown)
  }
  if (!used.has(base)) return base
  for (let index = 1; index <= used.size + 1; index += 1) {
    const candidate = `${base} ${index}`
    if (!used.has(candidate)) return candidate
  }
  // 理论上到不了（used.size + 1 次之内必有空位）；留一条兜底只为不抛异常。
  return `${base} ${used.size + 2}`
}

// ==================== 内部工具 ====================

/** 码点比较（不用 localeCompare：orderKey 是机器生成的 ASCII 不透明串）。 */
function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function orderKeyOf(row: EntityRow): string {
  const key: unknown = row.orderKey
  return typeof key === 'string' ? key : ''
}

function createdAtOf(row: EntityRow): string {
  const created: unknown = row.createdAt
  return typeof created === 'string' ? created : ''
}

function ownNameOf(row: EntityRow): string {
  const name: unknown = row.name
  return typeof name === 'string' ? name : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把任意单元格值降级成文本。
 *
 * 数组按顿号连接、对象回退 `label` → `name` → `id`（跨表引用 / 选项对象两种情况都能显示），
 * `null` / `undefined` 与不认识的类型一律空串（渲染成空态由组件负责）。
 */
function plainText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(plainText).filter((text) => text.trim() !== '').join('、')
  if (isRecord(value)) {
    return plainText(value['label'] ?? value['name'] ?? value['id'])
  }
  return ''
}

function numberText(raw: unknown): string {
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : ''
  return plainText(raw).trim()
}

function dateText(raw: unknown): string {
  const text = plainText(raw).trim()
  const iso = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(text)
  return iso?.[1] ?? text
}

function charactersText(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.map(plainText).map((text) => text.trim()).filter((text) => text !== '').join('、')
  }
  const text = plainText(raw).trim()
  if (text === '') return ''
  return text
    .split(/[、,，;；]/u)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('、')
}

function refNameText(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.map(plainText).map((text) => text.trim()).filter((text) => text !== '').join('、')
  }
  return plainText(raw).trim()
}
