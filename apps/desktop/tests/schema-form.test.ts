/**
 * W2 · `schema-form.ts` 纯函数层测试（无 DOM：跟着 desktop 项目的默认 node 环境跑）。
 *
 * 覆盖契约里的四条语义：字段顺序（`modules[].fields[]`）、值归一（缺省补 `''` + 遗留键保留）、
 * 单字段输入（`kind:'numeric'` 只留数字）、脏比较（`null`/`''`/`'5'` 归一后不误判为改动）。
 * 最后一组用 W1 真实元数据（`getTab('worldbase')`）反查「值键＝字段 name」这条硬约定。
 */
import { getTab, TABS } from '@yfe/schema-tabs'
import type { FormField, FormModule, TabDef } from '@yfe/schema-tabs'
import { describe, expect, it } from 'vitest'

import {
  applyFieldInput,
  formDirtyState,
  orderedFields,
  readFormValues,
} from '../src/renderer/schema/schema-form.js'

const nameField: FormField = { name: '名称', desc: '名称说明', example: '例如：青云门' }
const ageField: FormField = { name: '寿元', desc: '', example: '1000', kind: 'numeric' }
const noteField: FormField = { name: '备注', desc: '备注说明', example: '' }

const demoTab: TabDef = {
  id: 'demo-form',
  name: '示例页签',
  group: 'world',
  type: 'form',
  description: '示例说明',
  modules: [
    { name: '第一组', fields: [nameField, ageField] },
    { name: '第二组', fields: [noteField] },
  ],
  tips: ['提示一'],
}

/** 构造一个「modules 是 getter」的页签：模拟 worldbase / power / 制度四页签的题材包联动。 */
function liveTabOf(pack: () => FormModule[]): TabDef {
  return {
    id: 'live-form',
    name: '联动页签',
    group: 'world',
    type: 'form',
    description: '',
    get modules(): FormModule[] {
      return pack()
    },
  }
}

function fieldOf(name: string, kind?: 'numeric'): FormField {
  return kind === undefined
    ? { name, desc: '', example: '' }
    : { name, desc: '', example: '', kind }
}

describe('orderedFields', () => {
  it('按 modules 顺序 → 模块内 fields 顺序展平', () => {
    expect(orderedFields(demoTab).map((field) => field.name)).toEqual(['名称', '寿元', '备注'])
  })

  it('无 modules（非 form 页签）与空分组都返回空数组，不抛错', () => {
    expect(orderedFields({ ...demoTab, modules: undefined })).toEqual([])
    expect(orderedFields({ ...demoTab, modules: [{ name: '空组', fields: [] }] })).toEqual([])
  })

  it('每次都现读 getter：切题材包后字段集合随之改变（不缓存 TabDef）', () => {
    let pack: FormModule[] = [{ name: '甲组', fields: [fieldOf('甲字段')] }]
    const liveTab = liveTabOf(() => pack)

    expect(orderedFields(liveTab).map((field) => field.name)).toEqual(['甲字段'])

    pack = [{ name: '乙组', fields: [fieldOf('乙字段'), fieldOf('乙字段二', 'numeric')] }]

    expect(orderedFields(liveTab).map((field) => field.name)).toEqual(['乙字段', '乙字段二'])
    // 值键跟着新题材包走：上一包的键不会残留（没有快照/缓存）
    expect(readFormValues(liveTab, {})).toEqual({ 乙字段: '', 乙字段二: '' })
  })
})

describe('readFormValues', () => {
  it('按字段顺序补默认值，值键＝字段 name（中文键、扁平无模块前缀）', () => {
    const values = readFormValues(demoTab, {})
    expect(Object.keys(values)).toEqual(['名称', '寿元', '备注'])
    expect(values).toEqual({ 名称: '', 寿元: '', 备注: '' })
  })

  it('已有值保留；null / undefined 归一到空串', () => {
    expect(readFormValues(demoTab, { 名称: '青云门', 寿元: null, 备注: undefined })).toEqual({
      名称: '青云门',
      寿元: '',
      备注: '',
    })
  })

  it('非字符串标量转文本（数字 5 与 \'5\' 在表单里等价）', () => {
    expect(readFormValues(demoTab, { 寿元: 5 })).toEqual({ 名称: '', 寿元: '5', 备注: '' })
  })

  it('未声明的遗留键原样保留（引用不变，不做 JSON 序列化）', () => {
    const legacyList = ['旧版字段一', '旧版字段二']
    const legacy = { 名称: '甲', 旧版字段: legacyList, portrait: true }
    const values = readFormValues(demoTab, legacy)

    expect(Object.keys(values)).toEqual(['名称', '寿元', '备注', '旧版字段', 'portrait'])
    expect(values['旧版字段']).toBe(legacyList)
    expect(values.portrait).toBe(true)
  })

  it('不改入参（冻结对象也能安全传入）', () => {
    const frozen = Object.freeze({ 名称: '甲' })
    const values = readFormValues(demoTab, frozen)
    expect(values).not.toBe(frozen)
    expect(frozen).toEqual({ 名称: '甲' })
  })
})

describe("applyFieldInput（kind:'numeric' 只留数字）", () => {
  it('文本字段原样保留用户输入（含前后空格与换行）', () => {
    expect(applyFieldInput({}, nameField, '  青云门\n甲级  ')).toEqual({ 名称: '  青云门\n甲级  ' })
  })

  it('数字字段：单位 / 空格 / 中文 / 千分位一律去掉，只留数字', () => {
    const cases: Array<[string, string]> = [
      ['a1b2c', '12'],
      ['寿元 1200 岁', '1200'],
      ['1,200', '1200'],
      ['壹仟', ''],
      ['12.5', '12.5'],
      ['1.2.3', '1.23'],
      ['.', '.'],
      ['', ''],
      ['007', '007'],
    ]
    for (const [raw, expected] of cases) {
      expect(applyFieldInput({}, ageField, raw)).toEqual({ 寿元: expected })
    }
  })

  it('返回新对象、不改入参；未声明字段也能写入（点选新增字段）', () => {
    const before = { 名称: '甲' }
    const next = applyFieldInput(before, noteField, '备注内容')
    expect(next).not.toBe(before)
    expect(before).toEqual({ 名称: '甲' })
    expect(next).toEqual({ 名称: '甲', 备注: '备注内容' })
  })

  it('没有 kind 的字段按文本处理（Pick<FormField, \'name\'|\'kind\'> 放宽形态）', () => {
    expect(applyFieldInput({}, { name: '自定义' }, '12 岁')).toEqual({ 自定义: '12 岁' })
  })
})

describe('formDirtyState', () => {
  it('同一份值、以及 null / undefined / \'\' 之间都不算脏', () => {
    const saved = { 名称: '甲', 寿元: '', 备注: '' }
    expect(formDirtyState({ ...saved }, saved)).toBe(false)
    expect(formDirtyState({ 名称: '甲', 寿元: null }, { 名称: '甲', 寿元: '' })).toBe(false)
    expect(formDirtyState({ 名称: undefined }, { 名称: '' })).toBe(false)
    expect(formDirtyState({ 寿元: 5 }, { 寿元: '5' })).toBe(false)
    expect(formDirtyState({}, {})).toBe(false)
  })

  it('值变化、新增键、删除键都算脏', () => {
    const saved = { 名称: '甲', 寿元: '100' }
    expect(formDirtyState({ 名称: '乙', 寿元: '100' }, saved)).toBe(true)
    expect(formDirtyState({ ...saved, 备注: '多写的' }, saved)).toBe(true)
    expect(formDirtyState({ 名称: '甲' }, saved)).toBe(true)
  })

  it('归一后的输入往返（applyFieldInput 再比较）不产生假脏', () => {
    const saved = readFormValues(demoTab, { 名称: '青云门', 寿元: '1000' })
    const typed = applyFieldInput(saved, ageField, '1000')
    expect(formDirtyState(typed, saved)).toBe(false)
    const edited = applyFieldInput(saved, ageField, '1200 年')
    expect(formDirtyState(edited, saved)).toBe(true)
  })
})

describe('与 W1 真实元数据对齐', () => {
  it('所有 form 页签内字段名唯一（值键＝字段 name；重名会互相覆盖）', () => {
    const duplicates = TABS.filter((tab) => tab.type === 'form').map((tab) => {
      const names = orderedFields(tab).map((field) => field.name)
      return { id: tab.id, repeated: names.filter((name, index) => names.indexOf(name) !== index) }
    })
    expect(duplicates.filter((entry) => entry.repeated.length > 0)).toEqual([])
  })

  it('worldbase：值键与字段展平顺序一一对应', () => {
    const tab = getTab('worldbase')
    if (tab === undefined) throw new Error('W1 元数据缺失：getTab("worldbase") 返回 undefined')

    const fields = orderedFields(tab)
    expect(tab.type).toBe('form')
    expect(fields.length).toBeGreaterThan(0)
    expect(Object.keys(readFormValues(tab, {}))).toEqual(fields.map((field) => field.name))
    expect(fields.every((field) => field.name !== '' && field.desc !== undefined)).toBe(true)
  })

  it('worldbase：每个字段都能无损往返（写入当次值后不脏）', () => {
    const tab = getTab('worldbase')
    if (tab === undefined) throw new Error('W1 元数据缺失：getTab("worldbase") 返回 undefined')

    const saved = readFormValues(tab, { 作者遗留键: '保留' })
    for (const field of orderedFields(tab)) {
      const current = String(saved[field.name] ?? '')
      const next = applyFieldInput(saved, field, current)
      expect(next[field.name]).toBe(current)
      expect(formDirtyState(next, saved)).toBe(false)
      expect(next['作者遗留键']).toBe('保留')
    }
  })
})
