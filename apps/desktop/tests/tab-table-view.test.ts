// @vitest-environment happy-dom
/**
 * W3 表格组件的挂载测试（`TabTableView.vue`）。
 *
 * 只验证「props 进 → 界面出 → 事件出」这一条链：组件不得自己存状态、不得直连 IPC，
 * 所以每个用例都能靠 `mount` + `emitted()` 断言清楚。元素定位一律走 `data-testid`
 * （§3 的共同要求，也是真窗口 `--gui-check` 用的同一套钩子）。
 *
 * 夹具用**中文存储键**：§1 规定 `values` 的键就是 `TableColumn.name`，
 * 用英文键写用例会掩盖「键被翻译」这类事故。
 */
import type { ProjectId, Revision, SettingsEntity, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { TabDef, TableColumn } from '@yfe/schema-tabs'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TabTableView from '../src/renderer/schema/TabTableView.vue'

function makeRow(input: {
  id: string
  name?: string
  values?: Record<string, unknown>
  orderKey?: string
  createdAt?: string
}): SettingsEntity {
  return {
    id: input.id,
    workspaceId: 'ws_0000000000000000000000000' as WorkspaceId,
    projectId: 'prj_00000000000000000000000' as ProjectId,
    schemaTemplateId: 'tpl',
    name: input.name ?? '',
    values: input.values ?? {},
    orderKey: input.orderKey ?? 'a0',
    revision: 'r00000001' as Revision,
    deleted: 0,
    createdAt: (input.createdAt ?? '2026-01-01T00:00:00.000Z') as UtcTimestamp,
    updatedAt: (input.createdAt ?? '2026-01-01T00:00:00.000Z') as UtcTimestamp,
  }
}

function makeTab(input: Partial<TabDef> & Pick<TabDef, 'id' | 'name'>): TabDef {
  return {
    group: '世界构建',
    type: 'table',
    description: `${input.name}的说明`,
    ...input,
  }
}

const geoColumns: TableColumn[] = [
  { name: '名称' },
  { name: '类型', type: 'select', options: ['城', '镇', '山'] },
  { name: '地图X', hidden: true },
]

function geoRows(): SettingsEntity[] {
  return [
    makeRow({ id: 'r1', values: { 名称: '青岚城', 类型: '城', 地图X: '10' }, orderKey: 'a1' }),
    makeRow({ id: 'r2', values: { 名称: '白水镇', 类型: '镇', 地图X: '20' }, orderKey: 'a2' }),
  ]
}

describe('TabTableView — 表头与空态', () => {
  it('标题、说明、编号规则、页脚提示都取 TabDef（组件不另写中文）', () => {
    const tab = makeTab({
      id: 'geo',
      name: '地理风物',
      description: '山川城镇与秘境',
      codeRule: '编号形如 DL-001',
      tips: ['名称不要带标点'],
      columns: geoColumns,
    })

    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    expect(wrapper.find('[data-testid="tab-table-title"]').text()).toBe('地理风物')
    expect(wrapper.find('[data-testid="tab-table-description"]').text()).toBe('山川城镇与秘境')
    expect(wrapper.find('[data-testid="tab-table-code-rule"]').text()).toBe('编号形如 DL-001')
    expect(wrapper.find('[data-testid="tab-table-tip"]').text()).toBe('名称不要带标点')
    expect(wrapper.find('[data-testid="tab-table-geo"]').exists()).toBe(true)
  })

  it('表头用列名（中文存储键），hidden 列不渲染', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })

    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    expect(wrapper.find('[data-testid="table-th-名称"]').text()).toBe('名称')
    expect(wrapper.find('[data-testid="table-th-类型"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="table-th-地图X"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-cell-地图X"]').exists()).toBe(false)
  })

  it('没有行时给空态（文案来自 TabDef.description），不渲染表格', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', description: '还没有地理条目', columns: geoColumns })

    const wrapper = mount(TabTableView, { props: { tab, rows: [] } })

    expect(wrapper.find('[data-testid="tab-table-empty"]').text()).toBe('还没有地理条目')
    expect(wrapper.find('[data-testid="table-grid"]').exists()).toBe(false)
  })

  it('一列都没有（或全是 hidden）时同样走空态', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', description: '无列', columns: [{ name: '地图X', hidden: true }] })

    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    expect(wrapper.find('[data-testid="tab-table-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="table-grid"]').exists()).toBe(false)
  })
})

describe('TabTableView — 行序', () => {
  it('rows 按 orderKey 升序渲染', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })

    const wrapper = mount(TabTableView, { props: { tab, rows: [geoRows()[1] as SettingsEntity, geoRows()[0] as SettingsEntity] } })

    expect(wrapper.findAll('[data-row-id]').map((row) => row.attributes('data-row-id'))).toEqual(['r1', 'r2'])
  })

  it('newestFirst 页签按创建时间倒序（越新越靠上）', () => {
    const tab = makeTab({ id: 'chapters', name: '章节总表', newestFirst: true, columns: [{ name: '标题' }] })
    const rows = [
      makeRow({ id: 'old', values: { 标题: '第一章' }, orderKey: 'a1', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeRow({ id: 'new', values: { 标题: '第二章' }, orderKey: 'a2', createdAt: '2026-06-01T00:00:00.000Z' }),
    ]

    const wrapper = mount(TabTableView, { props: { tab, rows } })

    expect(wrapper.findAll('[data-row-id]').map((row) => row.attributes('data-row-id'))).toEqual(['new', 'old'])
  })
})

describe('TabTableView — 行内编辑', () => {
  it('文本列渲染 input，输入后 emit update（交回整行 values）', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: [geoRows()[0] as SettingsEntity] } })

    const input = wrapper.find('[data-testid="table-cell-input-名称"]')
    expect(input.attributes('type')).toBe('text')
    await input.setValue('青岚城（旧）')

    const updates = wrapper.emitted('update')
    expect(updates).toHaveLength(1)
    expect(updates?.[0]?.[0]).toBe('r1')
    expect(updates?.[0]?.[1]).toEqual({ 名称: '青岚城（旧）', 类型: '城', 地图X: '10' })
  })

  it('同一次编辑的 input + change 只 emit 一次', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: [geoRows()[0] as SettingsEntity] } })

    const input = wrapper.find('[data-testid="table-cell-input-名称"]')
    const element = input.element as HTMLInputElement
    element.value = '青岚城'
    await input.trigger('input')
    await input.trigger('change')

    expect(wrapper.emitted('update')).toHaveLength(1)
  })

  it('中文输入法组合期间不落库，组合结束才 emit', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: [geoRows()[0] as SettingsEntity] } })

    const input = wrapper.find('[data-testid="table-cell-input-名称"]')
    await input.trigger('compositionstart')
    const element = input.element as HTMLInputElement
    element.value = 'qing'
    await input.trigger('input')
    expect(wrapper.emitted('update')).toBeUndefined()

    await input.trigger('compositionend')
    expect(wrapper.emitted('update')).toHaveLength(1)
    expect(wrapper.emitted('update')?.[0]?.[1]).toEqual({ 名称: 'qing', 类型: '城', 地图X: '10' })
  })

  it('number 列渲染数字输入框，只留数字后 emit', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '人口' }, { name: '面积', type: 'number' }] })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 人口: '1万', 面积: '12' } })] } })

    const input = wrapper.find('[data-testid="table-cell-input-面积"]')
    expect(input.attributes('type')).toBe('number')
    expect((input.element as HTMLInputElement).value).toBe('12')

    await input.setValue('34.5')
    expect(wrapper.emitted('update')?.[0]?.[1]).toEqual({ 人口: '1万', 面积: '34.5' })
  })

  it('textarea 列渲染 textarea（长文本不被压成单行输入）', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '备注', type: 'textarea' }] })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 备注: '第一行\n第二行' } })] } })

    const control = wrapper.find('[data-testid="table-cell-input-备注"]')
    expect(control.element.tagName).toBe('TEXTAREA')
    expect((control.element as HTMLTextAreaElement).value).toBe('第一行\n第二行')
  })

  it('select 列渲染下拉，选中即 emit 选项字面值', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: [geoRows()[0] as SettingsEntity] } })

    const select = wrapper.find('[data-testid="table-cell-select-类型"]')
    expect(select.element.tagName).toBe('SELECT')
    expect(select.findAll('option').map((option) => option.attributes('value'))).toEqual(['', '城', '镇', '山'])

    await select.setValue('山')
    expect(wrapper.emitted('update')?.[0]?.[1]).toEqual({ 名称: '青岚城', 类型: '山', 地图X: '10' })
  })

  it('fixedOptions 列不把未声明的当前值补成选项（封闭枚举不许自造值）', () => {
    const tab = makeTab({
      id: 'geo',
      name: '地理风物',
      columns: [{ name: '保密等级', type: 'select', options: ['公开', '机密'], fixedOptions: true }],
    })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 保密等级: '自造值' } })] } })

    expect(wrapper.find('[data-testid="table-cell-select-保密等级"]').findAll('option').map((option) => option.attributes('value'))).toEqual(['', '公开', '机密'])
  })

  it('非 fixedOptions 列保留作者已有的自定义值（改别的列不会把它冲掉）', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 名称: '青岚城', 类型: '自造值', 地图X: '' } })] } })

    expect(wrapper.find('[data-testid="table-cell-select-类型"]').findAll('option').map((option) => option.attributes('value'))).toEqual(['', '城', '镇', '山', '自造值'])
  })
})

describe('TabTableView — tableRef 列', () => {
  const refColumn: TableColumn = { name: '所属势力', type: 'tableRef', refTab: 'nations', refCol: '名称' }

  function refTab(): TabDef {
    return makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '名称' }, refColumn] })
  }

  it('没有 refOptions 时只读展示引用名（不出现输入框/下拉）', () => {
    const wrapper = mount(TabTableView, {
      props: { tab: refTab(), rows: [makeRow({ id: 'r1', values: { 名称: '青岚城', 所属势力: '青岚宗' } })] },
    })

    expect(wrapper.find('[data-testid="table-cell-text-所属势力"]').text()).toBe('青岚宗')
    expect(wrapper.find('[data-testid="table-ref-所属势力"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-cell-input-所属势力"]').exists()).toBe(false)
  })

  it('给了 refOptions 后出现选择控件与「选择」按钮，选中 emit 引用名', async () => {
    const wrapper = mount(TabTableView, {
      props: {
        tab: refTab(),
        rows: [makeRow({ id: 'r1', values: { 名称: '青岚城', 所属势力: '青岚宗' } })],
        refOptions: () => [
          { id: 'n1', label: '青岚宗' },
          { id: 'n2', label: '赤炎门' },
        ],
      },
    })

    const select = wrapper.find('[data-testid="table-ref-所属势力"]')
    expect(select.findAll('option').map((option) => option.attributes('value'))).toEqual(['', '青岚宗', '赤炎门'])
    expect(wrapper.find('[data-testid="table-ref-button-所属势力"]').exists()).toBe(true)

    await select.setValue('赤炎门')
    expect(wrapper.emitted('update')?.[0]?.[0]).toBe('r1')
    expect(wrapper.emitted('update')?.[0]?.[1]).toEqual({ 名称: '青岚城', 所属势力: '赤炎门' })
  })

  it('引用名不在候选里也照常显示（旧数据不因来源表被删而消失）', () => {
    const wrapper = mount(TabTableView, {
      props: {
        tab: refTab(),
        rows: [makeRow({ id: 'r1', values: { 名称: '青岚城', 所属势力: '已删除的宗门' } })],
        refOptions: () => [{ id: 'n1', label: '青岚宗' }],
      },
    })

    expect(wrapper.find('[data-testid="table-cell-text-所属势力"]').text()).toBe('已删除的宗门')
  })

  it('refOptions 按列传入（外壳可以只为某几列提供候选）', () => {
    const seen: string[] = []
    const wrapper = mount(TabTableView, {
      props: {
        tab: refTab(),
        rows: [makeRow({ id: 'r1', values: { 名称: '青岚城', 所属势力: '青岚宗' } })],
        refOptions: (column: TableColumn) => {
          seen.push(column.name)
          return [{ id: 'n1', label: '青岚宗' }]
        },
      },
    })

    expect(seen).toContain('所属势力')
    expect(wrapper.find('[data-testid="table-ref-所属势力"]').exists()).toBe(true)
  })
})

describe('TabTableView — 只读态与忙态', () => {
  it('readonly 不渲染任何输入控件与增删按钮，只显示文本', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows(), readonly: true } })

    expect(wrapper.find('[data-testid="tab-table-geo"]').attributes('data-readonly')).toBe('true')
    expect(wrapper.find('[data-testid="table-create-geo"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-delete-r1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-reorder-up-r1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-cell-input-名称"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-cell-select-类型"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-cell-text-名称"]').text()).toBe('青岚城')
    expect(wrapper.find('[data-testid="table-cell-text-类型"]').text()).toBe('城')
  })

  it('busy 把所有控件置为 disabled，且点新建不发事件', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows(), busy: true } })

    const create = wrapper.find<HTMLButtonElement>('[data-testid="table-create-geo"]')
    expect(create.element.disabled).toBe(true)
    expect((wrapper.find('[data-testid="table-cell-input-名称"]').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="table-cell-select-类型"]').element as HTMLSelectElement).disabled).toBe(true)
    expect((wrapper.find<HTMLButtonElement>('[data-testid="table-delete-r1"]').element).disabled).toBe(true)

    await create.trigger('click')
    expect(wrapper.emitted('create')).toBeUndefined()
  })
})

describe('TabTableView — 事件', () => {
  it('点「+」emit create（不带参数，行内容由外壳决定）', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    await wrapper.find('[data-testid="table-create-geo"]').trigger('click')

    expect(wrapper.emitted('create')).toHaveLength(1)
    expect(wrapper.emitted('create')?.[0]).toEqual([])
  })

  it('新建按钮的 title 是 TabDef 派生的建议名', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    expect(wrapper.find('[data-testid="table-create-geo"]').attributes('title')).toBe('地理风物')
  })

  it('点「×」emit delete + 该行 id', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    await wrapper.find('[data-testid="table-delete-r2"]').trigger('click')

    expect(wrapper.emitted('delete')?.[0]).toEqual(['r2'])
  })

  it('上移 emit reorder(行, 前一行)；第一行的上移按钮禁用', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: geoColumns })
    const wrapper = mount(TabTableView, { props: { tab, rows: geoRows() } })

    expect(wrapper.find<HTMLButtonElement>('[data-testid="table-reorder-up-r1"]').element.disabled).toBe(true)
    await wrapper.find('[data-testid="table-reorder-up-r2"]').trigger('click')

    expect(wrapper.emitted('reorder')?.[0]).toEqual(['r2', 'r1'])
  })

  it('下移 emit reorder(行, 下一行的后一行)；挪到末尾时第二位是 null', async () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '名称' }] })
    const rows = [
      makeRow({ id: 'r1', values: { 名称: '甲' }, orderKey: 'a1' }),
      makeRow({ id: 'r2', values: { 名称: '乙' }, orderKey: 'a2' }),
      makeRow({ id: 'r3', values: { 名称: '丙' }, orderKey: 'a3' }),
    ]
    const wrapper = mount(TabTableView, { props: { tab, rows } })

    await wrapper.find('[data-testid="table-reorder-down-r1"]').trigger('click')
    expect(wrapper.emitted('reorder')?.[0]).toEqual(['r1', 'r3'])

    // 最后一行的下移按钮禁用：没有「再往下一格」的空间
    expect(wrapper.find<HTMLButtonElement>('[data-testid="table-reorder-down-r3"]').element.disabled).toBe(true)

    await wrapper.find('[data-testid="table-reorder-down-r2"]').trigger('click')
    expect(wrapper.emitted('reorder')?.[1]).toEqual(['r2', null])
  })

  it('newestFirst 页签不给手动重排（顺序由创建时间决定）', () => {
    const tab = makeTab({ id: 'chapters', name: '章节总表', newestFirst: true, columns: [{ name: '标题' }] })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 标题: '第一章' } })] } })

    expect(wrapper.find('[data-testid="table-reorder-up-r1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-reorder-down-r1"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="table-delete-r1"]').exists()).toBe(true)
  })
})

describe('TabTableView — 文本展示', () => {
  it('characters 列顿号连接，tableRef 用引用名，空值给占位符', () => {
    const tab = makeTab({
      id: 'geo',
      name: '地理风物',
      columns: [
        { name: '相关角色', type: 'characters' },
        { name: '所属势力', type: 'tableRef', refTab: 'nations', refCol: '名称' },
        { name: '备注' },
      ],
    })
    const wrapper = mount(TabTableView, {
      props: {
        tab,
        rows: [makeRow({ id: 'r1', values: { 相关角色: ['甲', '乙'], 所属势力: '青岚宗', 备注: '' } })],
        readonly: true,
      },
    })

    expect(wrapper.find('[data-testid="table-cell-text-相关角色"]').text()).toBe('甲、乙')
    expect(wrapper.find('[data-testid="table-cell-text-所属势力"]').text()).toBe('青岚宗')
    expect(wrapper.find('[data-testid="table-cell-text-备注"]').text()).toBe('—')
  })

  it('日期列只显示到日；数字列原样显示', () => {
    const tab = makeTab({
      id: 'geo',
      name: '地理风物',
      columns: [
        { name: '发生时间', type: 'date' },
        { name: '人口', type: 'number' },
      ],
    })
    const wrapper = mount(TabTableView, {
      props: {
        tab,
        rows: [makeRow({ id: 'r1', values: { 发生时间: '3024-03-01T10:20:30.000Z', 人口: 120000 } })],
        readonly: true,
      },
    })

    expect(wrapper.find('[data-testid="table-cell-text-发生时间"]').text()).toBe('3024-03-01')
    expect(wrapper.find('[data-testid="table-cell-text-人口"]').text()).toBe('120000')
  })

  it('长文本用 title 给全文（CSS 只负责视觉截断，信息不丢）', () => {
    const long = '这是一段很长很长的备注'.repeat(20)
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '备注', type: 'textarea' }] })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 备注: long } })], readonly: true } })

    const cell = wrapper.find('[data-testid="table-cell-text-备注"]')
    expect(cell.attributes('title')).toBe(long)
    expect(cell.classes()).toContain('tab-table__text--clamp')
  })

  it('列 tip 作为表头 title（悬停提示）', () => {
    const tab = makeTab({ id: 'geo', name: '地理风物', columns: [{ name: '名称', tip: '唯一值' }] })
    const wrapper = mount(TabTableView, { props: { tab, rows: [makeRow({ id: 'r1', values: { 名称: '青岚城' } })] } })

    expect(wrapper.find('[data-testid="table-th-名称"]').attributes('title')).toBe('唯一值')
  })
})

describe('TabTableView — 中文文案纪律', () => {
  it('元数据全 ASCII 时界面不出现任何中文（组件不另写一份文案）', () => {
    const tab = makeTab({
      id: 'ascii',
      name: 'Things',
      description: 'A list of things',
      codeRule: 'TH-001',
      tips: ['Keep it short'],
      columns: [
        { name: 'Title', type: 'text' },
        { name: 'Kind', type: 'select', options: ['a', 'b'] },
        { name: 'Count', type: 'number' },
        { name: 'Note', type: 'textarea' },
      ],
    })
    const wrapper = mount(TabTableView, {
      props: { tab, rows: [makeRow({ id: 'r1', values: { Title: 'Alpha', Kind: 'a', Count: 1, Note: '' } })] },
    })

    expect(wrapper.text()).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})
