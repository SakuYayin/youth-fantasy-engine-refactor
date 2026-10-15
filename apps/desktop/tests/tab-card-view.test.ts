// @vitest-environment happy-dom
/// <reference path="../src/renderer/vue-shims.d.ts" />
/**
 * W4 卡片渲染器挂载测试（`TabCardView.vue`）。
 *
 * 契约见 `docs/接口冻结-渲染层.md` §3 W4：左侧卡片列表 + 右侧详情表单，
 * `select` / `create` / `update` / `delete` 四个事件，空态 / 只读态 / 未选中态都要处理。
 *
 * 这里测的是**组件与外壳之间的接缝**：DOM 结构（testid）、事件的载荷形状、
 * 以及「只读 / busy 时哪些动作被冻结」。纯函数规则（展示名优先级、字段来源、列数、
 * 日期截断）在 `schema-card.test.ts` 里测，不在这里重复。
 *
 * 关键一条：`update` 的载荷必须是**整份合并后的 `values`**（含未展示的 `hidden` 列与未知键），
 * 因为 `saveSettingsEntity` 收的就是完整 `values`；只发单键补丁会把作者其它字段抹掉。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ProjectId, Revision, SettingsEntity, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { TabDef } from '@yfe/schema-tabs'
import TabCardView from '../src/renderer/schema/TabCardView.vue'

/** 真实 card 页签（`char-main`）那一类：字段在 `modules[].fields`，没有 `columns`。 */
const CHARACTER_TAB: TabDef = {
  id: 'char-main',
  name: '主要角色',
  group: '角色管理',
  type: 'card',
  description: '主角与重要配角的档案，一人一张卡。',
  tips: ['先写主角，配角放到次要角色页签。'],
  modules: [
    {
      name: '基本',
      fields: [
        { name: '姓名', desc: '角色的正式称呼', example: '云无月' },
        { name: '年龄', desc: '按作品纪年', example: '18', kind: 'numeric' },
        { name: '角色简介', desc: '一段话讲清他是谁', example: '出身寒门的剑修。' },
      ],
    },
  ],
}

/** 表格型字段定义走 `columns[]`：覆盖每种控件的分派、`hidden` 列与列宽自适应。 */
const OUTLINE_TAB: TabDef = {
  id: 'volume-outline',
  name: '分卷大纲',
  group: '大纲规划',
  type: 'card',
  description: '每一卷一张卡。',
  codeRule: '卷名建议用「第N卷 名称」。',
  columns: [
    { name: '卷名', tip: '作者自己看得懂就行' },
    { name: '状态', type: 'select', options: ['构思', '写作中', '已完成'], width: '120px' },
    { name: '简介', type: 'textarea', width: '240px' },
    { name: '起始日期', type: 'date', width: '120px' },
    { name: '章数', type: 'number', width: '80px' },
    { name: '内部备注', hidden: true, width: '80px' },
  ],
}

function card(id: string, name: string, values: Record<string, unknown>): SettingsEntity {
  // 品牌类型必须显式标注（与 `tab-table-view.test.ts` 的夹具同一口径），
  // 否则 `as SettingsEntity` 会因 `projectId: string` 不可比而被 TS2352 挡下。
  return {
    id,
    workspaceId: 'ws_0000000000000000000000000' as WorkspaceId,
    projectId: 'prj_00000000000000000000000' as ProjectId,
    schemaTemplateId: 'volume-outline',
    name,
    values,
    orderKey: `order-${id}`,
    revision: 'r00000001' as Revision,
    createdAt: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
    updatedAt: '2026-01-01T00:00:00.000Z' as UtcTimestamp,
    deleted: 0,
  }
}

const FIRST_VALUES: Record<string, unknown> = {
  卷名: '剑起微末',
  状态: '写作中',
  简介: '少年入山。',
  起始日期: '3024-03-01T00:00:00.000Z',
  章数: '007',
  内部备注: '别删这张',
}

const CARDS: SettingsEntity[] = [
  card('vol-1', '第一卷 剑起微末', FIRST_VALUES),
  card('vol-2', '第二卷 山雨欲来', { 卷名: '山雨欲来' }),
]

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  tab: TabDef
  cards: readonly SettingsEntity[]
  selectedId?: string | null
  readonly?: boolean
  busy?: boolean
}

function mountView(overrides: Partial<ViewProps> = {}) {
  const props: ViewProps = { tab: OUTLINE_TAB, cards: CARDS, ...overrides }
  return mount(TabCardView, { props })
}

describe('卡片列表', () => {
  it('每张卡一个列表项，标题与 id 都来自数据，页签名来自 TabDef', () => {
    const wrapper = mountView()
    const items = wrapper.findAll('[data-testid="card-item"]')
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.attributes('data-card-id'))).toEqual(['vol-1', 'vol-2'])
    // 没有 displayCol / subtitleCol 的页签：标题回退到 card.name，且不渲染副标题行。
    expect(items.map((item) => item.get('[data-testid="card-item-title"]').text())).toEqual([
      '第一卷 剑起微末',
      '第二卷 山雨欲来',
    ])
    expect(wrapper.findAll('[data-testid="card-item-subtitle"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="card-tab-name"]').text()).toBe('分卷大纲')
    expect(wrapper.get('[data-testid="card-view"]').attributes('data-tab-id')).toBe('volume-outline')
  })

  it('选中态高亮（class + aria-selected），点击别的卡 emit select，点已选中的不再 emit', async () => {
    const wrapper = mountView({ selectedId: 'vol-1' })
    const items = wrapper.findAll('[data-testid="card-item"]')
    expect(items[0]!.classes()).toContain('card-view__item--selected')
    expect(items[0]!.attributes('aria-selected')).toBe('true')
    expect(items[1]!.classes()).not.toContain('card-view__item--selected')
    expect(items[1]!.attributes('aria-selected')).toBe('false')

    await items[1]!.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('select')?.[0]).toEqual(['vol-2'])

    await items[0]!.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })

  it('displayCol / subtitleCol 生效时标题与副标题各走一边', () => {
    const tab: TabDef = {
      ...OUTLINE_TAB,
      id: 'volume-outline-2',
      displayCol: '卷名',
      subtitleCol: '状态',
    }
    const wrapper = mountView({ tab, selectedId: 'vol-1' })
    const item = wrapper.get('[data-testid="card-item"][data-card-id="vol-1"]')
    expect(item.get('[data-testid="card-item-title"]').text()).toBe('剑起微末')
    expect(item.get('[data-testid="card-item-subtitle"]').text()).toBe('写作中')
  })
})

describe('详情表单', () => {
  it('字段来自 TabDef 的 columns，hidden 列不渲染，控件按类型分派', () => {
    const wrapper = mountView({ selectedId: 'vol-1' })
    expect(wrapper.findAll('[data-testid="card-field-label"]').map((label) => label.text())).toEqual([
      '卷名',
      '状态',
      '简介',
      '起始日期',
      '章数',
    ])
    // hidden：数据保留（update 里仍带得走），但不渲染。
    expect(wrapper.find('[data-field-name="内部备注"]').exists()).toBe(false)

    expect(wrapper.get('[data-field-name="卷名"]').attributes('data-field-control')).toBe('text')
    expect(wrapper.find('[data-field-name="卷名"] [data-testid="card-field-input"]').exists()).toBe(true)
    expect(wrapper.get('[data-field-name="状态"]').attributes('data-field-control')).toBe('select')
    expect(wrapper.get('[data-field-name="状态"] [data-testid="card-field-select"]').findAll('option').map((option) => option.text())).toEqual([
      '',
      '构思',
      '写作中',
      '已完成',
    ])
    expect(wrapper.find('[data-field-name="简介"] [data-testid="card-field-textarea"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-name="起始日期"] [data-testid="card-field-date"]').exists()).toBe(true)
    expect(wrapper.find('[data-field-name="章数"] [data-testid="card-field-number"]').exists()).toBe(true)

    // 列宽缺 1 个（卷名）→ 3 列自适应。
    expect(wrapper.get('[data-testid="card-detail-grid"]').attributes('style')).toContain('repeat(3,')
    expect(wrapper.get('[data-testid="card-detail-title"]').text()).toBe('第一卷 剑起微末')
    expect(wrapper.get('[data-testid="card-field-tip"]').text()).toBe('作者自己看得懂就行')
    expect(wrapper.get('[data-testid="card-code-rule"]').text()).toBe('卷名建议用「第N卷 名称」。')
  })

  it('modules[].fields 的页签：字段名即标签，desc / example 照 TabDef 显示', () => {
    const wrapper = mount(TabCardView, {
      props: {
        tab: CHARACTER_TAB,
        cards: [card('char-1', '云无月', { 姓名: '云无月', 年龄: '22' })],
        selectedId: 'char-1',
      },
    })
    expect(wrapper.findAll('[data-testid="card-field-label"]').map((label) => label.text())).toEqual([
      '姓名',
      '年龄',
      '角色简介',
    ])
    expect(wrapper.findAll('[data-testid="card-field-desc"]').map((line) => line.text())).toEqual([
      '角色的正式称呼',
      '按作品纪年',
      '一段话讲清他是谁',
    ])
    expect(wrapper.get('[data-field-name="姓名"] [data-testid="card-field-example"]').text()).toBe('示例：云无月')
    // kind: 'numeric' → 数字控件；没有 width 的页签稳定落在 2 列。
    expect(wrapper.find('[data-field-name="年龄"] [data-testid="card-field-number"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="card-detail-grid"]').attributes('style')).toContain('repeat(2,')
    // 表单预填的是作者已经写过的值。
    expect((wrapper.get('[data-field-name="姓名"] input').element as HTMLInputElement).value).toBe('云无月')
    expect((wrapper.get('[data-field-name="年龄"] input').element as HTMLInputElement).value).toBe('22')
  })

  it('改文本字段 emit update，载荷是整份合并后的 values（隐藏列与未填字段都不丢）', async () => {
    const wrapper = mountView({ selectedId: 'vol-1' })
    await wrapper.get('[data-field-name="卷名"] [data-testid="card-field-input"]').setValue('剑起微末·改')
    const updates = wrapper.emitted('update')
    expect(updates).toHaveLength(1)
    expect(updates?.[0]?.[0]).toBe('vol-1')
    expect(updates?.[0]?.[1]).toEqual({
      卷名: '剑起微末·改',
      状态: '写作中',
      简介: '少年入山。',
      起始日期: '3024-03-01T00:00:00.000Z',
      章数: '007',
      内部备注: '别删这张',
    })
  })

  it('下拉、多行、数字、日期控件都能回写，值一律按字符串走', async () => {
    const wrapper = mountView({ selectedId: 'vol-1' })
    await wrapper.get('[data-field-name="状态"] [data-testid="card-field-select"]').setValue('已完成')
    await wrapper.get('[data-field-name="简介"] [data-testid="card-field-textarea"]').setValue('少年入山，遇雨。')
    await wrapper.get('[data-field-name="章数"] [data-testid="card-field-number"]').setValue('12')
    await wrapper.get('[data-field-name="起始日期"] [data-testid="card-field-date"]').setValue('3024-03-05')

    const updates = wrapper.emitted('update')
    expect(updates).toHaveLength(4)
    expect(updates?.[0]?.[1]).toMatchObject({ 状态: '已完成' })
    expect(updates?.[1]?.[1]).toMatchObject({ 简介: '少年入山，遇雨。' })
    expect(updates?.[2]?.[1]).toMatchObject({ 章数: '12' })
    expect(updates?.[3]?.[1]).toMatchObject({ 起始日期: '3024-03-05' })
    // 每次都是完整 values，而不是单键补丁。
    const expectedKeys = ['卷名', '状态', '简介', '起始日期', '章数', '内部备注'].sort()
    for (const update of updates ?? []) {
      expect(Object.keys(update[1] as Record<string, unknown>).sort()).toEqual(expectedKeys)
    }
  })

  it('日期控件把 ISO 时间戳截到日显示（不截就会是空控件）', () => {
    const wrapper = mountView({ selectedId: 'vol-1' })
    const value = (wrapper.get('[data-field-name="起始日期"] [data-testid="card-field-date"]').element as HTMLInputElement).value
    expect(value.startsWith('3024-03-01')).toBe(true)
  })
})

describe('新建 / 删除', () => {
  it('新建按钮 emit create（不带参数）', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="card-create"]').trigger('click')
    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.emitted('create')?.[0]).toEqual([])
  })

  it('选中后删除 emit delete 带上卡片 id；未选中时删除按钮禁用且不发事件', async () => {
    const selected = mountView({ selectedId: 'vol-2' })
    await selected.get('[data-testid="card-delete"]').trigger('click')
    expect(selected.emitted('delete')).toEqual([['vol-2']])

    const none = mountView({ selectedId: null })
    expect(none.get('[data-testid="card-delete"]').attributes('disabled')).toBeDefined()
    await none.get('[data-testid="card-delete"]').trigger('click')
    expect(none.emitted('delete')).toBeUndefined()
  })
})

describe('空态 / 未选中态 / 只读态 / busy 态', () => {
  it('没有卡片时给引导语：描述与 tips 全部来自 TabDef，且不渲染表单', () => {
    const wrapper = mount(TabCardView, { props: { tab: OUTLINE_TAB, cards: [] } })
    expect(wrapper.find('[data-testid="card-list"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="card-item"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="card-empty-description"]').text()).toBe('每一卷一张卡。')
    expect(wrapper.findAll('[data-testid="card-tip"]').map((tip) => tip.text())).toEqual([])
    expect(wrapper.find('[data-testid="card-unselected"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="card-detail-grid"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="card-delete"]').attributes('disabled')).toBeDefined()

    const withTips = mount(TabCardView, { props: { tab: CHARACTER_TAB, cards: [] } })
    expect(withTips.findAll('[data-testid="card-tip"]').map((tip) => tip.text())).toEqual([
      '先写主角，配角放到次要角色页签。',
    ])
  })

  it('有卡片但未选中：列表在、表单不在', () => {
    const wrapper = mountView({ selectedId: null })
    expect(wrapper.findAll('[data-testid="card-item"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="card-unselected"]').text()).toContain('每一卷一张卡。')
    expect(wrapper.find('[data-testid="card-detail-grid"]').exists()).toBe(false)
  })

  it('selectedId 指向已不存在的卡片时按未选中处理', () => {
    const wrapper = mountView({ selectedId: 'vol-9' })
    expect(wrapper.find('[data-testid="card-unselected"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="card-detail-title"]').exists()).toBe(false)
  })

  it('只读态：显示只读徽标、控件禁用、新建与删除都不生效，但仍可切换卡片', async () => {
    const wrapper = mountView({ selectedId: 'vol-1', readonly: true })
    expect(wrapper.get('[data-testid="card-readonly"]').text()).toBe('只读')
    expect(wrapper.get('[data-field-name="卷名"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="card-create"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="card-delete"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="card-create"]').trigger('click')
    expect(wrapper.emitted('create')).toBeUndefined()
    await wrapper.get('[data-testid="card-delete"]').trigger('click')
    expect(wrapper.emitted('delete')).toBeUndefined()
    // 只读只冻写：浏览别的卡不落库，不该被拦。
    await wrapper.findAll('[data-testid="card-item"]')[1]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['vol-2']])
    expect(wrapper.emitted('update')).toBeUndefined()
  })

  it('busy 态：写操作冻结（marker 用 aria-busy 暴露）但切换卡片照旧', async () => {
    const wrapper = mountView({ selectedId: 'vol-1', busy: true })
    expect(wrapper.get('[data-testid="card-view"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-field-name="卷名"] input').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="card-create"]').attributes('disabled')).toBeDefined()
    await wrapper.findAll('[data-testid="card-item"]')[1]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['vol-2']])
    expect(wrapper.emitted('create')).toBeUndefined()
  })

  it('非只读时没有只读徽标，aria-busy 为 false', () => {
    const wrapper = mountView()
    expect(wrapper.find('[data-testid="card-readonly"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="card-view"]').attributes('aria-busy')).toBe('false')
  })
})
