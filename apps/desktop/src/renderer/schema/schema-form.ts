/**
 * W2 通用表单渲染器的**纯函数层**（无 Vue、无 DOM、无 IPC、无副作用）。
 *
 * 契约见 `docs/接口冻结-渲染层.md` §3 的 W2 小节：本文件导出
 * `orderedFields` / `readFormValues` / `applyFieldInput` / `formDirtyState`，供
 * `TabFormView.vue`（渲染）与页签外壳（脏标记 / 保存）共用。写在这里而不是组件里，
 * 是因为这些规则的测试价值远高于渲染本身：数值过滤、默认值补齐、脏比较都属于数据语义。
 *
 * ## 三条硬约定（§2）
 *
 * 1. **只走属性读**：受题材驱动的六个页签（`worldbase` / `power` / `politics` / `economy` /
 *    `belief` / `justice`）的 `modules` 是 **getter**，切题材包即变。本文件每次调用都现读
 *    `tab.modules`，绝不缓存 `TabDef`、绝不 `JSON.parse(JSON.stringify(tab))` 长期持有。
 * 2. **值的键＝`FormField.name`（中文存储键，扁平、无模块前缀）**；返回**新对象**，不改入参。
 * 3. **未知键（旧版遗留字段 / 未来字段）原样保留** —— 开发计划 §4 硬规则 3
 *    「旧 ID 与未知字段必须保留」，渲染器不得因为本轮没声明该字段就把作者填过的数据抹掉。
 *
 * ## `kind: 'numeric'` 的语义
 *
 * `FormField.kind === 'numeric'` 是「数值型字段」的显式声明（旧版靠 `POWER_NUMERIC_HINTS`
 * 关键字猜）。渲染层只负责**输入侧**的收敛：`applyFieldInput` 只留数字字符（最多一个小数点），
 * 不做 `Number()` 归一化 —— 要保留用户正在输入的中间态（`''` / `'1.'` / `'007'`），
 * 也避免把「约三千」这类非数字历史值当成 `NaN` 丢掉（历史值在 `readFormValues` 里原样透传）。
 */
import type { FormField, TabDef } from '@yfe/schema-tabs'

/** 表单值对象：键＝字段 `name`，值＝可 JSON 落库的标量。 */
type FormValues = Readonly<Record<string, unknown>>

/**
 * `applyFieldInput` 只用到字段的这两个属性，放宽到 `Pick` 以便单测直接构造字段，
 * 同时不切断与冻结类型 `FormField` 的关系（真 `FormField` 可直接传入）。
 */
type InputField = Pick<FormField, 'name' | 'kind'>

/** 值 → 文本：`null` / `undefined` → `''`，其余 `String()`（数字 `5` 与 `'5'` 在表单里等价）。 */
function toText(raw: unknown): string {
  return raw === null || raw === undefined ? '' : String(raw)
}

/**
 * `kind: 'numeric'` 的输入收敛：只留数字字符，且最多保留一个小数点。
 *
 * - `'战力 12 岁'` → `'12'`（单位、空格、中文一律去掉）
 * - `'1,200'` → `'1200'`；`'-3'` → `'3'`（这些字段都是非负量级）
 * - `'1.5'` → `'1.5'`（**保留小数**：倍率/比例类字段不能被截成 `'15'`）
 * - `'1.2.3'` → `'1.23'`、`'.'` → `'.'`（中间态不报错，交给后续校验）
 */
function numericText(raw: string): string {
  const digits = raw.replace(/[^0-9.]/g, '')
  const dot = digits.indexOf('.')
  if (dot === -1) return digits
  return `${digits.slice(0, dot + 1)}${digits.slice(dot + 1).replace(/\./g, '')}`
}

/**
 * 按 `TabDef.modules[].fields[]` 的顺序展平所有字段。
 *
 * 顺序就是界面顺序：模块顺序 → 模块内字段顺序。渲染、默认值补齐、脏比较都依赖它，
 * 所以只在这里定义一次顺序来源。空 `modules`（非 form 页签 / 未选题材包）返回 `[]`。
 */
export function orderedFields(tab: TabDef): FormField[] {
  const fields: FormField[] = []
  for (const module of tab.modules ?? []) {
    for (const field of module.fields) {
      fields.push(field)
    }
  }
  return fields
}

/**
 * `value` → 渲染用值：声明字段按 `orderedFields` 顺序补默认值 `''`（`null` / `undefined` → `''`），
 * 非字符串标量转文本；**未声明的键追加在末尾且值原样保留**（旧字段不得静默丢弃）。
 *
 * 返回新对象；不改入参。页面切换/题材包切换后重新调用即拿到新的键集合（不缓存）。
 */
export function readFormValues(tab: TabDef, value: FormValues): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of orderedFields(tab)) {
    values[field.name] = toText(value[field.name])
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = value[key]
    }
  }
  return values
}

/**
 * 单字段输入 → 新值对象（不可变更新；`field.name` 不在 `value` 里也能写入）。
 *
 * `kind: 'numeric'` 只留数字（见 `numericText`）；其它字段**原样保留用户输入**（含空白与换行，
 * 由外壳决定何时 `trim`，渲染器不替作者改字）。
 */
export function applyFieldInput(value: FormValues, field: InputField, raw: string): Record<string, unknown> {
  const text = toText(raw)
  return {
    ...value,
    [field.name]: field.kind === 'numeric' ? numericText(text) : text,
  }
}

/**
 * 当前值 vs 已保存值：有差异＝脏（外壳据此启用保存按钮 / 拦截关闭）。
 *
 * 比较前两边都做 `toText` 归一，所以 `null` / `undefined` / `''` 视为同一个「空」，
 * 数字 `5` 与字符串 `'5'` 也不算改动（避免刚打开页面就被标脏）。
 * 键集合取并集：新增键、删除键都算脏。
 */
export function formDirtyState(value: FormValues, saved: FormValues): boolean {
  const keys = new Set([...Object.keys(value), ...Object.keys(saved)])
  for (const key of keys) {
    if (toText(value[key]) !== toText(saved[key])) return true
  }
  return false
}
