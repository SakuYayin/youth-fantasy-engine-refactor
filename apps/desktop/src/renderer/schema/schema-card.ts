/**
 * 卡片渲染器（W4）的**纯函数层** —— 无 DOM、无 IPC、不 import `@yfe/client-sdk`。
 *
 * 契约来源：`docs/接口冻结-渲染层.md` §3「W4 — 卡片渲染器」。按契约导出四个纯函数
 * `cardTitle` / `cardSubtitle` / `cardFields` / `gridColumns`，另加两个给组件与测试共用的小件
 * （`CardField` 类型、`cardFieldText`）。组件 `TabCardView.vue` 只做「把纯函数结果铺成 DOM +
 * 把用户意图 emit 出去」，任何改名 / 排序 / 回退规则都留在本层，这样规则本身可单测。
 *
 * ## 三条不可忘的前提（同 §1 / §2）
 *
 * 1. `values` 的键就是 `TabDef.columns[].name` 或 `TabDef.modules[].fields[].name`
 *    （**中文存储键**）：本层只按该键取值，绝不改名 / 翻译 / 套英文别名。
 * 2. `TableColumn.hidden`（`cH()` 产物）＝**保留数据但不渲染**：只有 `cardFields` 负责过滤，
 *    `cardFieldText` 对隐藏字段同样能取到值（它不判断 `hidden`）。
 * 3. 六个题材驱动页签的 `tab.name`/`tab.modules` 是 **getter**（切包即变），所以本层每个函数都
 *    现读 `tab.xxx`；组件也**不得把结果缓存成长期快照**，一律在渲染时直接调用（见 `TabCardView.vue`）。
 *
 * ## 为什么 `cardFields` 必须认两种字段来源
 *
 * 冻结的 `TableColumn`（`columns`）是**表格型**页签的字段定义；而真实存在的 6 个 card 页签
 * （`char-main` 主要角色 / `char-secondary` 次要角色 / `char-npc` NPC角色 / `misc-settings`
 * 其他设定 / `volume-outline` 分卷大纲 / `chapter-outline` 章节细纲）**没有 `columns`**，
 * 字段在 `modules[].fields[]`（`FormField`：`name`/`desc`/`example`/`kind`）里，且没有
 * `displayCol` / `subtitleCol`。所以：
 *
 * - `cardFields`：有 `columns` 就按 `columns`（过滤 `hidden`），否则展平 `modules[].fields`；
 *   没有这条兜底，6 个真实 card 页签的详情表单会整片空白。
 * - `cardTitle` / `cardSubtitle`：真实 card 页签上两者都回退到 `card.name` / `null`。
 */

import type { FormField, TabDef, TableColumn, TableColumnType } from '@yfe/schema-tabs'

import type { EntityRow } from './entity-row.js'

/**
 * 卡片详情表单里的一个字段（`TableColumn` 与 `FormField` 的**渲染视图**）。
 *
 * 刻意不直接用 `TableColumn`：卡片页签的字段可能来自 `modules[].fields`，那里没有 `type`
 * 只有 `kind`（`'numeric'`），也没有 `options`/`width`。组件只认这个视图，
 * 就不用到处判断「字段是从哪来的」。
 */
export interface CardField {
  /** 存储键：`values` 里的键名（中文），同时就是表单标签。 */
  readonly name: string
  /** 控件类型；来自 `modules[].fields` 时由 `kind` 推导（`'numeric'` → `'number'`，其余 `'text'`）。 */
  readonly type: TableColumnType
  /** `select` 的候选值 —— 文案归 `TabDef` 所有，组件不得另写一份。 */
  readonly options?: readonly string[]
  /** 列宽。只给 `gridColumns` 判断用，不参与布局。 */
  readonly width?: string
  /** 列提示（`TableColumn.tip`）。 */
  readonly tip?: string
  /** 字段说明（`FormField.desc`）。 */
  readonly desc?: string
  /** 字段示例（`FormField.example`）。 */
  readonly example?: string
}

// ==================== 展示名 ====================

/**
 * 卡片的展示名：`displayCol` → `subtitleCol` → `card.name`。
 *
 * §1 规定「`displayCol` 存在时用它的值做展示名」，所以优先级是硬性的；某一级的值缺失或
 * 只有空白就落到下一级。返回前 `trim()`：卡片列表里前导空格的标题看起来像排版错误。
 * 真实 card 页签没有这两个列，结果就是 `card.name`。
 */
export function cardTitle(tab: TabDef, card: EntityRow): string {
  return columnText(card, tab.displayCol) ?? columnText(card, tab.subtitleCol) ?? card.name
}

/**
 * 卡片的副标题：只有 `subtitleCol` 一个来源，取不到就返回 `null`（组件据此不渲染副标题行）。
 *
 * 为什么不继续回退到「第一个非空的字段」：那会让列表第二行的内容随作者填写的先后顺序漂移，
 * 同一个作者两次看到的两行字不一样。没有 `subtitleCol` 就老实显示一行。
 */
export function cardSubtitle(tab: TabDef, card: EntityRow): string | null {
  return columnText(card, tab.subtitleCol)
}

/** 取某列的展示文本；列没声明 / 值缺失 / 只有空白一律 `null`（交给调用方回退）。 */
function columnText(card: EntityRow, columnName: string | undefined): string | null {
  if (columnName === undefined || columnName === '') return null
  const text = valueText(valuesOf(card)[columnName]).trim()
  return text === '' ? null : text
}

// ==================== 字段 ====================

/**
 * 卡片详情要渲染的字段（顺序就是界面顺序：`columns` 顺序，或「模块顺序 → 模块内字段顺序」）。
 *
 * `hidden === true` 的列被过滤掉（数据保留、只是不渲染，见本文件头部第 2 条约定）；
 * 返回值是新数组，调用方 `.map` 不会改到元数据。
 */
export function cardFields(tab: TabDef): CardField[] {
  const columns = tab.columns
  if (columns !== undefined && columns.length > 0) {
    return columns.filter((column) => column.hidden !== true).map(fromColumn)
  }
  return (tab.modules ?? []).flatMap((module) => module.fields.map(fromFormField))
}

function fromColumn(column: TableColumn): CardField {
  return {
    name: column.name,
    type: column.type ?? 'text',
    options: column.options,
    width: column.width,
    tip: column.tip,
  }
}

function fromFormField(field: FormField): CardField {
  return {
    name: field.name,
    type: field.kind === 'numeric' ? 'number' : 'text',
    desc: field.desc,
    example: field.example,
  }
}

/**
 * 某字段在卡片上的**控件文本值**。
 *
 * - `date` / `calendar`：截到日（`'3024-03-01T00:00:00.000Z'` → `'3024-03-01'`）。
 *   `<input type="date">` 只认 `YYYY-MM-DD`，不截就会渲染成空控件，作者会以为数据丢了。
 *   （旧版作者手写的「3024年3月」这类文本原样保留，历法化是后续 `calendar` 类型的事。）
 * - 其余按 `valueText` 的降级口径。
 *
 * `card` 允许为 `null`（未选中卡片）：返回空串，省得组件在模板里写非空断言。
 */
export function cardFieldText(card: EntityRow | null, field: CardField): string {
  if (card === null) return ''
  const text = valueText(valuesOf(card)[field.name])
  if (field.type === 'date' || field.type === 'calendar') return datePart(text)
  return text
}

// ==================== 栅格列数 ====================

/**
 * 详情表单的列数：**2–4 列自适应**，依据 `columns[].width` 是否缺失（§3 W4）。
 *
 * 规则：字段 ≤ 2 个恒为 2 列；否则按缺 `width` 的字段数递减 —— 0 个缺 → 4 列、
 * 1 个缺 → 3 列、≥2 个缺 → 2 列，再按字段总数收窄（3 个字段不可能排 4 列）。
 *
 * 为什么「缺 `width`」要减列：`width` 是作者对「这一列要多宽」的声明（旧版表格里
 * 那些 `'120px'`、`'20%'`）。声明越少说明这些字段越可能是长文本 —— 挤成 4 列就会出现
 * 每格只有几十像素、内容全靠横向滚动才能读完的表单。真实 6 个 card 页签没有 `width`，
 * 于是稳定落在 2 列。
 */
export function gridColumns(tab: TabDef): number {
  const fields = cardFields(tab)
  if (fields.length <= 2) return 2
  const missing = fields.filter((field) => field.width === undefined || field.width === '').length
  const adaptive = missing === 0 ? 4 : missing === 1 ? 3 : 2
  return Math.min(adaptive, fields.length)
}

// ==================== 内部工具 ====================

function valuesOf(card: EntityRow): Readonly<Record<string, unknown>> {
  const values: unknown = card.values
  return isRecord(values) ? values : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 任意值 → 文本。
 *
 * 标量 `String()`；数组按**顿号**连接、对象回退 `label` → `name` → `id` —— 与 W3 的
 * `cellText` 降级口径一致（跨表引用 / 选项对象两种情况都能显示），`null` / `undefined` /
 * 不认识的类型一律空串（空态由组件负责，不在这里编占位文案）。数字只留有限值，
 * `NaN` / `Infinity` 落成空串而不是 `'NaN'` 这种会写进界面的字样。
 */
function valueText(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : ''
  if (typeof raw === 'boolean') return String(raw)
  if (Array.isArray(raw)) {
    return raw
      .map(valueText)
      .filter((text) => text.trim() !== '')
      .join('、')
  }
  if (isRecord(raw)) return valueText(raw['label'] ?? raw['name'] ?? raw['id'])
  return ''
}

/** ISO 时间戳截到日；不是时间戳的文本原样返回。 */
function datePart(text: string): string {
  const trimmed = text.trim()
  const iso = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(trimmed)
  return iso?.[1] ?? trimmed
}
