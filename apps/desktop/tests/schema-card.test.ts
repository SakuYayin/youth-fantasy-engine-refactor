/**
 * W4 纯函数层单测（`schema-card.ts`）。
 *
 * 契约见 `docs/接口冻结-渲染层.md` §3 W4。这里刻意不挂组件：展示名优先级、字段来源
 * （`columns` vs `modules[].fields`）、控件值格式化、栅格列数都是**规则**，
 * 规则坏了要在这一层就红，而不是等挂载测试去猜。
 *
 * fixture 结构照抄真实页签：
 * - `char-main` 一类的角色卡页签：**没有 `columns`**，字段在 `modules[].fields[]`（`FormField`）。
 * - 大纲/自定卡页签：字段在 `columns[]`（`TableColumn`），可能带 `hidden` / `width` / `options`。
 */
import { describe, expect, it } from 'vitest'
import type { SettingsEntity } from '@yfe/contracts'
import type { FormModule, TabDef, TableColumn } from '@yfe/schema-tabs'
import { cardFieldText, cardFields, cardSubtitle, cardTitle, gridColumns } from '../src/renderer/schema/schema-card.js'

/** 真实 card 页签（`char-main`）那一类的字段定义：在 `modules[].fields` 里，没有 `columns`。 */
const CHARACTER_MODULES: FormModule[] = [
  {
    name: '基本',
    fields: [
      { name: '姓名', desc: '角色的正式称呼', example: '云无月' },
      { name: '年龄', desc: '按作品纪年', example: '18', kind: 'numeric' },
    ],
  },
  {
    name: '背景',
    fields: [{ name: '角色简介', desc: '一段话讲清他是谁', example: '出身寒门的剑修。' }],
  },
]

function tab(overrides: Partial<TabDef> = {}): TabDef {
  return {
    id: 'char-main',
    name: '主要角色',
    group: '角色管理',
    type: 'card',
    description: '主角与重要配角的档案，一人一张卡。',
    ...overrides,
  }
}

function column(name: string, overrides: Partial<TableColumn> = {}): TableColumn {
  return { name, ...overrides }
}

function card(values: Record<string, unknown>, overrides: Partial<SettingsEntity> = {}): SettingsEntity {
  return {
    id: 'card-1',
    workspaceId: 'ws-1',
    projectId: 'project-1',
    schemaTemplateId: 'char-main',
    name: '未命名角色',
    values,
    orderKey: 'a1',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deleted: 0,
    ...overrides,
  } as SettingsEntity
}

describe('cardTitle：displayCol → subtitleCol → name', () => {
  it('三列都取得到时用 displayCol 的值', () => {
    const t = tab({ displayCol: '姓名', subtitleCol: '称号' })
    const c = card({ 姓名: '云无月', 称号: '剑首' }, { name: '角色A' })
    expect(cardTitle(t, c)).toBe('云无月')
  })

  it('displayCol 的值缺失或只有空白时落到 subtitleCol', () => {
    const t = tab({ displayCol: '姓名', subtitleCol: '称号' })
    expect(cardTitle(t, card({ 称号: '剑首' }, { name: '角色A' }))).toBe('剑首')
    expect(cardTitle(t, card({ 姓名: '   ', 称号: '剑首' }, { name: '角色A' }))).toBe('剑首')
  })

  it('两个展示列都取不到时用 card.name（真实 card 页签就是这条路径）', () => {
    const t = tab({ modules: CHARACTER_MODULES })
    expect(cardTitle(t, card({ 姓名: '云无月' }, { name: '未命名角色' }))).toBe('未命名角色')
    expect(cardTitle(t, card({ 姓名: '云无月' }, { name: '未命名角色' }))).not.toBe('云无月')
  })

  it('展示值两侧空白被 trim，数字值照显', () => {
    const t = tab({ displayCol: '姓名' })
    expect(cardTitle(t, card({ 姓名: '  云无月  ' }))).toBe('云无月')
    const byNumber = tab({ displayCol: '编号' })
    expect(cardTitle(byNumber, card({ 编号: 7 }))).toBe('7')
  })

  it('legacy 结构化值回退 label → name → id', () => {
    const t = tab({ displayCol: '势力' })
    expect(cardTitle(t, card({ 势力: { id: 'f1', label: '青岚宗' } }))).toBe('青岚宗')
    expect(cardTitle(t, card({ 势力: { id: 'f1', name: '青岚宗' } }))).toBe('青岚宗')
    expect(cardTitle(t, card({ 势力: { id: 'f1' } }))).toBe('f1')
  })
})

describe('cardSubtitle：只认 subtitleCol', () => {
  it('声明了 subtitleCol 就取它的值', () => {
    const t = tab({ subtitleCol: '称号' })
    expect(cardSubtitle(t, card({ 称号: '剑首' }))).toBe('剑首')
  })

  it('未声明 subtitleCol 返回 null（真实 card 页签：没有这一列）', () => {
    const t = tab({ modules: CHARACTER_MODULES })
    expect(cardSubtitle(t, card({ 姓名: '云无月' }))).toBeNull()
  })

  it('subtitleCol 的值缺失或只有空白返回 null', () => {
    const t = tab({ subtitleCol: '称号' })
    expect(cardSubtitle(t, card({}))).toBeNull()
    expect(cardSubtitle(t, card({ 称号: '  ' }))).toBeNull()
  })
})

describe('cardFields：columns 优先，modules[].fields 兜底', () => {
  it('columns 存在时按列顺序返回，hidden 列被排除', () => {
    const t = tab({
      columns: [column('卷名'), column('内部备注', { hidden: true }), column('章数', { type: 'number' })],
    })
    expect(cardFields(t).map((field) => field.name)).toEqual(['卷名', '章数'])
  })

  it('type 缺省补 text，options / width / tip 原样透传', () => {
    const t = tab({
      columns: [
        column('状态', { type: 'select', options: ['构思', '写作中'], tip: '不写「已完结」' }),
        column('简介', { type: 'textarea', width: '240px' }),
      ],
    })
    expect(cardFields(t)).toEqual([
      {
        name: '状态',
        type: 'select',
        options: ['构思', '写作中'],
        width: undefined,
        tip: '不写「已完结」',
      },
      { name: '简介', type: 'textarea', options: undefined, width: '240px', tip: undefined },
    ])
  })

  it('没有 columns 时展平 modules[].fields：numeric → number，desc/example 保留', () => {
    const fields = cardFields(tab({ modules: CHARACTER_MODULES }))
    expect(fields.map((field) => field.name)).toEqual(['姓名', '年龄', '角色简介'])
    expect(fields.map((field) => field.type)).toEqual(['text', 'number', 'text'])
    expect(fields[0]).toEqual({
      name: '姓名',
      type: 'text',
      desc: '角色的正式称呼',
      example: '云无月',
    })
    // 真实 6 个 card 页签走的就是这条路径：一条都不能少，否则详情表单整片空白。
    expect(fields.length).toBeGreaterThan(0)
  })

  it('modules 为空、columns 为空数组或全 hidden 时给出空列表而不抛错', () => {
    expect(cardFields(tab({}))).toEqual([])
    expect(cardFields(tab({ columns: [] }))).toEqual([])
    expect(cardFields(tab({ columns: [column('内部备注', { hidden: true })] }))).toEqual([])
    expect(cardFields(tab({ columns: [column('内部备注', { hidden: true })], modules: CHARACTER_MODULES }))).toEqual([])
  })

  it('返回的是新数组，改它不影响元数据', () => {
    const t = tab({ columns: [column('卷名')] })
    const first = cardFields(t)
    first.push({ name: '手滑加的', type: 'text' })
    expect(cardFields(t).map((field) => field.name)).toEqual(['卷名'])
  })
})

describe('cardFieldText：控件里显示的文本', () => {
  const t = tab({ columns: [column('卷名'), column('起始日期', { type: 'date' })] })

  it('取 values 里的值', () => {
    expect(cardFieldText(card({ 卷名: '第一卷' }), cardFields(t)[0]!)).toBe('第一卷')
  })

  it('date / calendar 把 ISO 时间戳截到日，手写日期原样保留', () => {
    const fields = cardFields(tab({ columns: [column('起始日期', { type: 'date' }), column('历法', { type: 'calendar' })] }))
    expect(cardFieldText(card({ 起始日期: '3024-03-01T00:00:00.000Z' }), fields[0]!)).toBe('3024-03-01')
    expect(cardFieldText(card({ 历法: '3024年3月' }), fields[1]!)).toBe('3024年3月')
  })

  it('缺失键、null、对象、数组、非有限数字都降级成可读文本', () => {
    const field = cardFields(tab({ columns: [column('卷名')] }))[0]!
    expect(cardFieldText(card({}), field)).toBe('')
    expect(cardFieldText(card({ 卷名: null }), field)).toBe('')
    expect(cardFieldText(card({ 卷名: Number.NaN }), field)).toBe('')
    expect(cardFieldText(card({ 卷名: ['上卷', '下卷'] }), field)).toBe('上卷、下卷')
    expect(cardFieldText(card({ 卷名: { id: 'v1', label: '第一卷' } }), field)).toBe('第一卷')
  })

  it('number 字段保留作者写的原样文本（不归一化 007 / 3月）', () => {
    const field = cardFields(tab({ columns: [column('章数', { type: 'number' })] }))[0]!
    expect(cardFieldText(card({ 章数: '007' }), field)).toBe('007')
    expect(cardFieldText(card({ 章数: 12 }), field)).toBe('12')
  })

  it('未选中卡片（null）返回空串', () => {
    const field = cardFields(tab({ columns: [column('卷名')] }))[0]!
    expect(cardFieldText(null, field)).toBe('')
  })
})

describe('gridColumns：2–4 列自适应', () => {
  it('字段 ≤ 2 个恒为 2 列', () => {
    expect(gridColumns(tab({}))).toBe(2)
    expect(gridColumns(tab({ columns: [column('卷名')] }))).toBe(2)
    expect(gridColumns(tab({ columns: [column('卷名'), column('序号', { width: '80px' })] }))).toBe(2)
  })

  it('全部字段都有 width 时用 4 列', () => {
    const t = tab({
      columns: [
        column('卷名', { width: '200px' }),
        column('状态', { width: '120px' }),
        column('章数', { width: '80px' }),
        column('起始日期', { width: '120px' }),
      ],
    })
    expect(gridColumns(t)).toBe(4)
  })

  it('缺 1 个 width 用 3 列，缺 ≥2 个用 2 列（width: "" 也算缺）', () => {
    const t = tab({
      columns: [
        column('卷名', { width: '200px' }),
        column('状态', { width: '120px' }),
        column('章数', { width: '80px' }),
        column('简介'),
      ],
    })
    expect(gridColumns(t)).toBe(3)
    expect(gridColumns(tab({ columns: [...(t.columns ?? []), column('备注', { width: '' })] }))).toBe(2)
  })

  it('字段数少于目标列数时按字段数收窄（3 个字段排不出 4 列）', () => {
    const t = tab({
      columns: [column('卷名', { width: '200px' }), column('状态', { width: '120px' }), column('章数', { width: '80px' })],
    })
    expect(gridColumns(t)).toBe(3)
  })

  it('hidden 列不参与列数计算', () => {
    const t = tab({
      columns: [
        column('卷名', { width: '200px' }),
        column('内部备注', { hidden: true }),
        column('状态', { width: '120px' }),
      ],
    })
    expect(gridColumns(t)).toBe(2)
  })

  it('真实 card 页签（modules 字段、没有 width）稳定落在 2 列', () => {
    expect(gridColumns(tab({ modules: CHARACTER_MODULES }))).toBe(2)
  })
})
