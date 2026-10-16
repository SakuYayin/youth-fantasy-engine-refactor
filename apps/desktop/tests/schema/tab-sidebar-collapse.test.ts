// @vitest-environment happy-dom
/**
 * A-09 · `TabSidebar.vue` 分组折叠测试（happy-dom 挂载，风格参考 `tests/tab-form-view.test.ts`）。
 *
 * 断言的是**契约**而不是实现细节：
 * 1. 缺省 `collapsedGroups` ＝ 全部展开（A-09 之前的调用方行为不变）；
 * 2. 折叠＝**整组内容不渲染**（组标题仍在），不是 `display:none`；
 * 3. 点击组头只 emit `toggle-group(group)` —— 组件**自己不改状态、不落库**（父层是真相源）；
 * 4. 组头是 `<button type="button">` ＋ `aria-expanded`，图标随状态切换；
 * 5. `select` 的旧契约（载荷、去重、disabled 门）一字未动。
 */
import type { TabDef } from '@yfe/schema-tabs'
import { mount } from '@vue/test-utils'
import { defineComponent, h, type PropType } from 'vue'
import { describe, expect, it } from 'vitest'

import TabSidebar from '../../src/renderer/schema/TabSidebar.vue'
import type { TabGroupView } from '../../src/renderer/schema/tab-registry.js'

// ==================== 夹具 ====================

function tab(id: string, group: string, name: string): TabDef {
  return { id, name, group, type: 'form', description: '' }
}

/** 四个组：正文写作 / 世界构建 / 酒馆模式 / 运营维护（顺序即 `groups` 顺序）。 */
const GROUPS: readonly TabGroupView[] = [
  { group: '正文写作', tabs: [tab('editor', '正文写作', '正文编辑')] },
  { group: '世界构建', tabs: [tab('worldbase', '世界构建', '世界观'), tab('power', '世界构建', '力量体系')] },
  { group: '酒馆模式', tabs: [tab('tavern-plot', '酒馆模式', '剧情推演')] },
  { group: '运营维护', tabs: [tab('about', '运营维护', '关于')] },
]

/**
 * 组件可传的四个 prop。
 *
 * 写成**具名接口**而不是 `Record<string, unknown>`：本仓库 `vue-shims.d.ts` 把 `*.vue` 声明成
 * `DefineComponent<{}, {}, unknown>`，VTU 的 `mount()` 靠推断出的 props 类型给 `setProps()` 定键；
 * 传一个索引签名类型会退回默认值，`setProps({ collapsedGroups })` 就报 TS2353。
 */
type SidebarProps = {
  groups: readonly TabGroupView[]
  activeId: string | null
  disabled?: boolean
  collapsedGroups?: readonly string[]
}

function mountSidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    groups: overrides.groups ?? GROUPS,
    activeId: overrides.activeId ?? 'editor',
  }
  if (overrides.disabled !== undefined) props.disabled = overrides.disabled
  // 关键：**不传** `collapsedGroups` 时不带该 prop（不是传 `[]`），验证「缺省＝全部展开」。
  if (overrides.collapsedGroups !== undefined) props.collapsedGroups = overrides.collapsedGroups
  return mount(TabSidebar, { props })
}

const toggle = (wrapper: ReturnType<typeof mountSidebar>, group: string) =>
  wrapper.get(`[data-testid="sidebar-group-toggle-${group}"]`)

function bodyExists(wrapper: ReturnType<typeof mountSidebar>, group: string): boolean {
  return wrapper.find(`[data-testid="sidebar-group-body-${group}"]`).exists()
}

/** 收集元素下所有非空文本节点（用来反查「组件有没有自己写文案」）。 */
function textNodesOf(element: Element): string[] {
  const texts: string[] = []
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = (child.textContent ?? '').trim()
        if (text !== '') texts.push(text)
      } else if (child.nodeType === 1) {
        walk(child)
      }
    }
  }
  walk(element)
  return texts
}

/**
 * 受控重渲染用的**宿主**：只把父层 props 原样转给 `TabSidebar`，自己不记状态。
 *
 * 为什么需要它：本仓库 `vue-shims.d.ts` 把 `*.vue` 声明成 `DefineComponent<{}, {}, unknown>`，
 * 于是 `mount(TabSidebar).setProps({ collapsedGroups })` 在普通 `tsc` 下必然 TS2353
 * （`ComponentProps` 丢掉具名 prop）。宿主的 props 是 `defineComponent` 里**真声明**的，
 * `setProps` 就能收窄到 `collapsedGroups` —— 而且这正好就是 Lead 在 `App.vue` 里的接法：
 * 父层持状态、子组件只收 props。
 */
const SidebarHost = defineComponent({
  name: 'SidebarHostProbe',
  props: {
    groups: { type: Array as PropType<readonly TabGroupView[]>, required: true },
    activeId: { type: String as PropType<string | null>, default: null },
    collapsedGroups: { type: Array as PropType<readonly string[]>, default: () => [] },
  },
  setup(hostProps) {
    return () =>
      h(TabSidebar, {
        groups: hostProps.groups,
        activeId: hostProps.activeId,
        collapsedGroups: hostProps.collapsedGroups,
      })
  },
})

/** 在宿主的 DOM 里查某组的 body / 组头（宿主只多包一层，testid 不变）。 */
function hostBodyExists(wrapper: ReturnType<typeof mount>, group: string): boolean {
  return wrapper.find(`[data-testid="sidebar-group-body-${group}"]`).exists()
}

// ==================== 缺省与其他组互不影响 ====================

describe('TabSidebar · 分组折叠 · 缺省展开', () => {
  it('不传 collapsedGroups：所有组的 body 都渲染、aria-expanded 全为 true', () => {
    const wrapper = mountSidebar()

    expect(wrapper.findAll('.sidebar__group').map((node) => node.attributes('data-testid'))).toEqual([
      'sidebar-group-正文写作',
      'sidebar-group-世界构建',
      'sidebar-group-酒馆模式',
      'sidebar-group-运营维护',
    ])
    for (const group of ['正文写作', '世界构建', '酒馆模式', '运营维护']) {
      expect(bodyExists(wrapper, group)).toBe(true)
      expect(toggle(wrapper, group).attributes('aria-expanded')).toBe('true')
    }
    expect(wrapper.findAll('.sidebar__item').map((node) => node.text())).toEqual([
      '正文编辑',
      '世界观',
      '力量体系',
      '剧情推演',
      '关于',
    ])
  })

  it('缺省展开时折叠图标一律是 ▾（与展开态一致）', () => {
    const wrapper = mountSidebar()
    const icons = wrapper.findAll('.sidebar__group-icon').map((node) => node.text())
    expect(icons).toEqual(['▾', '▾', '▾', '▾'])
    for (const icon of wrapper.findAll('.sidebar__group-icon')) {
      expect(icon.attributes('aria-hidden')).toBe('true')
    }
  })

  it('传空数组等价于缺省：全部展开', () => {
    const wrapper = mountSidebar({ collapsedGroups: [] })

    for (const group of ['正文写作', '世界构建', '酒馆模式', '运营维护']) {
      expect(bodyExists(wrapper, group)).toBe(true)
      expect(toggle(wrapper, group).attributes('aria-expanded')).toBe('true')
    }
  })

  it('折叠集合里出现未知组名（遗留记录）时，现有组全部照常展开', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['已经不存在的分组', '酒馆模式2'] })

    for (const group of ['正文写作', '世界构建', '酒馆模式', '运营维护']) {
      expect(bodyExists(wrapper, group)).toBe(true)
    }
  })
})

// ==================== 折叠态渲染 ====================

describe('TabSidebar · 分组折叠 · 折叠态', () => {
  it('传入折叠组时该组 body 不渲染，但组标题与组头仍在', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'] })

    expect(bodyExists(wrapper, '世界构建')).toBe(false)
    expect(wrapper.find('[data-testid="sidebar-group-世界构建"]').exists()).toBe(true)
    expect(toggle(wrapper, '世界构建').text()).toContain('世界构建')
    // 其它组不受影响
    expect(bodyExists(wrapper, '正文写作')).toBe(true)
    expect(bodyExists(wrapper, '酒馆模式')).toBe(true)
  })

  it('折叠是「不渲染」而不是 display:none：被折叠组里的页签按钮不在 DOM', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'] })

    const html = wrapper.html()
    expect(html).toContain('sidebar-group-toggle-世界构建')
    // 该组的两个页签连 testid 带文案整段消失
    expect(html).not.toContain('sidebar-tab-worldbase')
    expect(html).not.toContain('sidebar-tab-power')
    expect(html).not.toContain('世界观')
    expect(html).not.toContain('力量体系')
    // 按钮总数＝4 个组头 ＋ 3 个未折叠组的页签
    expect(wrapper.findAll('button')).toHaveLength(7)
  })

  it('aria-expanded 与折叠状态精确对应（展开 true / 折叠 false）', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建', '运营维护'] })

    expect(toggle(wrapper, '正文写作').attributes('aria-expanded')).toBe('true')
    expect(toggle(wrapper, '世界构建').attributes('aria-expanded')).toBe('false')
    expect(toggle(wrapper, '酒馆模式').attributes('aria-expanded')).toBe('true')
    expect(toggle(wrapper, '运营维护').attributes('aria-expanded')).toBe('false')
  })

  it('折叠图标随状态切换：折叠组是 ▸，展开组仍是 ▾', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'] })

    expect(toggle(wrapper, '世界构建').find('.sidebar__group-icon').text()).toBe('▸')
    expect(toggle(wrapper, '正文写作').find('.sidebar__group-icon').text()).toBe('▾')
    expect(toggle(wrapper, '酒馆模式').find('.sidebar__group-icon').text()).toBe('▾')
  })

  it('组顺序不因折叠改变（折叠组仍留在原位、不是被挪到末尾）', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['正文写作', '酒馆模式'] })

    expect(wrapper.findAll('.sidebar__group').map((node) => node.attributes('data-testid'))).toEqual([
      'sidebar-group-正文写作',
      'sidebar-group-世界构建',
      'sidebar-group-酒馆模式',
      'sidebar-group-运营维护',
    ])
  })

  it('三个 testid 齐全且成对：sidebar-group / -toggle / -body', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['酒馆模式'] })

    expect(wrapper.find('[data-testid="sidebar-group-酒馆模式"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sidebar-group-toggle-酒馆模式"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sidebar-group-body-酒馆模式"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sidebar-group-body-正文写作"]').exists()).toBe(true)
  })
})

// ==================== 交互：emit 契约（组件不自持状态） ====================

describe('TabSidebar · 分组折叠 · 交互', () => {
  it('点击组头 emit toggle-group，载荷是该组名（只发一次）', async () => {
    const wrapper = mountSidebar()
    await toggle(wrapper, '世界构建').trigger('click')

    const events = wrapper.emitted('toggle-group')
    expect(events).toHaveLength(1)
    expect(events?.[0]).toEqual(['世界构建'])
  })

  it('每个组头各发各的 key（互为隔离）', async () => {
    const wrapper = mountSidebar()
    await toggle(wrapper, '正文写作').trigger('click')
    await toggle(wrapper, '世界构建').trigger('click')
    await toggle(wrapper, '酒馆模式').trigger('click')
    await toggle(wrapper, '运营维护').trigger('click')

    expect(wrapper.emitted('toggle-group')).toEqual([
      ['正文写作'],
      ['世界构建'],
      ['酒馆模式'],
      ['运营维护'],
    ])
  })

  it('点击已折叠的组头 emit 同一个 key（取反由父层做），组件自身渲染不变', async () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'] })

    await toggle(wrapper, '世界构建').trigger('click')

    expect(wrapper.emitted('toggle-group')).toEqual([['世界构建']])
    // props 没变 ⇒ 界面仍是折叠的（组件不自己记状态）
    expect(bodyExists(wrapper, '世界构建')).toBe(false)
    expect(toggle(wrapper, '世界构建').attributes('aria-expanded')).toBe('false')
  })

  it('未选中的组也可折叠：activeId 指向别处时点击组头照常 emit', async () => {
    const wrapper = mountSidebar({ activeId: 'editor' })

    // 「运营维护」本来就没选中，也不该影响折叠
    expect(toggle(wrapper, '运营维护').attributes('aria-expanded')).toBe('true')
    await toggle(wrapper, '运营维护').trigger('click')
    expect(wrapper.emitted('toggle-group')).toEqual([['运营维护']])
  })

  it('父层改 collapsedGroups（受控重渲染）后折叠立即生效', async () => {
    const wrapper = mount(SidebarHost, {
      props: { groups: GROUPS, activeId: 'editor', collapsedGroups: [] as readonly string[] },
    })
    expect(hostBodyExists(wrapper, '酒馆模式')).toBe(true)

    await wrapper.setProps({ collapsedGroups: ['酒馆模式'] })

    expect(hostBodyExists(wrapper, '酒馆模式')).toBe(false)
    expect(
      wrapper.get('[data-testid="sidebar-group-toggle-酒馆模式"]').attributes('aria-expanded'),
    ).toBe('false')
    // 其它组不受牵连
    expect(hostBodyExists(wrapper, '正文写作')).toBe(true)

    await wrapper.setProps({ collapsedGroups: [] })
    expect(hostBodyExists(wrapper, '酒馆模式')).toBe(true)
  })

  it('组头是 <button type="button">（键盘可达：原生按钮自带 Enter/Space 激活）', () => {
    const wrapper = mountSidebar()
    for (const group of ['正文写作', '世界构建', '酒馆模式', '运营维护']) {
      const header = toggle(wrapper, group)
      expect(header.element.tagName).toBe('BUTTON')
      expect(header.attributes('type')).toBe('button')
      // 没有 tabindex=-1 之类的「不可聚焦」处理
      expect(header.attributes('tabindex')).toBeUndefined()
    }
  })

  it('disabled（数据加载中）只拦页签切换，不拦折叠：组头照常 emit', async () => {
    const wrapper = mountSidebar({ disabled: true })

    const item = wrapper.get('[data-testid="sidebar-tab-worldbase"]')
    expect(item.attributes('disabled')).toBeDefined()
    await item.trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()

    await toggle(wrapper, '世界构建').trigger('click')
    expect(wrapper.emitted('toggle-group')).toEqual([['世界构建']])
  })
})

// ==================== 旧契约不回归：select 与边界 ====================

describe('TabSidebar · 折叠不影响旧契约', () => {
  it('折叠某一组不影响其它组的 select 行为', async () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'], activeId: 'editor' })

    await wrapper.get('[data-testid="sidebar-tab-tavern-plot"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['tavern-plot']])
    // 折叠本身不会顺带 emit select
    expect(wrapper.emitted('select')).toHaveLength(1)
  })

  it('点当前激活页签仍不 emit select（去重逻辑未动）', async () => {
    const wrapper = mountSidebar({ activeId: 'editor' })
    await wrapper.get('[data-testid="sidebar-tab-editor"]').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('groups 为空数组不崩：只有空 nav，没有组', () => {
    const wrapper = mountSidebar({ groups: [], activeId: null })

    expect(wrapper.get('[data-testid="tab-sidebar"]').element).toBeDefined()
    expect(wrapper.findAll('.sidebar__group')).toHaveLength(0)
    expect(wrapper.findAll('button')).toHaveLength(0)
  })

  it('tabs 为空的分组也能折叠（空节点不崩、组头照常 emit）', async () => {
    const empty: readonly TabGroupView[] = [
      { group: '空分组', tabs: [] },
      { group: '世界构建', tabs: [tab('worldbase', '世界构建', '世界观')] },
    ]
    const wrapper = mountSidebar({ groups: empty })

    expect(bodyExists(wrapper, '空分组')).toBe(true)
    expect(wrapper.get('[data-testid="sidebar-group-body-空分组"]').findAll('li')).toHaveLength(0)

    await toggle(wrapper, '空分组').trigger('click')
    expect(wrapper.emitted('toggle-group')).toEqual([['空分组']])

    // 父层据此改传 collapsedGroups 后，空组同样不渲染 body（组件自己不改状态）
    const collapsed = mountSidebar({ groups: empty, collapsedGroups: ['空分组'] })
    expect(bodyExists(collapsed, '空分组')).toBe(false)
    expect(bodyExists(collapsed, '世界构建')).toBe(true)
  })

  it('深度嵌套/含特殊字符的组 key 稳定：折叠 a/b 不牵连 a 与 a/b/c', async () => {
    const nested: readonly TabGroupView[] = [
      { group: 'a', tabs: [tab('t-a', 'a', '甲')] },
      { group: 'a/b', tabs: [tab('t-ab', 'a/b', '甲乙')] },
      { group: 'a/b/c', tabs: [tab('t-abc', 'a/b/c', '甲乙丙')] },
      { group: '含 空格的组', tabs: [tab('t-space', '含 空格的组', '含空格')] },
    ]
    const wrapper = mountSidebar({ groups: nested, collapsedGroups: ['a/b'] })

    expect(bodyExists(wrapper, 'a')).toBe(true)
    expect(bodyExists(wrapper, 'a/b')).toBe(false)
    expect(bodyExists(wrapper, 'a/b/c')).toBe(true)
    expect(bodyExists(wrapper, '含 空格的组')).toBe(true)

    await toggle(wrapper, 'a/b/c').trigger('click')
    expect(wrapper.emitted('toggle-group')).toEqual([['a/b/c']])
  })

  it('可见文本只来自 props 与图标字符（组件不另写一份文案）', () => {
    const wrapper = mountSidebar({ collapsedGroups: ['世界构建'] })

    const allowed = new Set<string>([
      '正文写作', '正文编辑',
      '世界构建',
      '酒馆模式', '剧情推演',
      '运营维护', '关于',
      '▾', '▸',
    ])
    const foreign = textNodesOf(wrapper.element).filter((text) => !allowed.has(text))
    expect(foreign).toEqual([])
    // 折叠组名仍然可见（标题没被藏起来）
    expect(textNodesOf(wrapper.element)).toContain('世界构建')
  })
})