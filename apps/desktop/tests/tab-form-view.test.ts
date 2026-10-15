// @vitest-environment happy-dom
/**
 * W2 · `TabFormView.vue` 渲染测试（happy-dom 挂载，风格参考 `tests/editor-adapter.test.ts`）。
 *
 * 断言的是**契约**而不是实现细节：分组标题 / 标签 / 说明 / 占位一律来自 `TabDef`，
 * 数字字段走数字输入，所有交互元素有 `data-testid`，值经 `update:value` 出、保存经 `save` 出，
 * 只读 / 忙 / 空三态各有显式标记，题材包 getter 在重渲染时现读。
 */
import type { FormField, FormModule, TabDef } from '@yfe/schema-tabs'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TabFormView from '../src/renderer/schema/TabFormView.vue'

const nameField: FormField = { name: '名称', desc: '名称说明', example: '例如：青云门' }
const ageField: FormField = { name: '寿元', desc: '', example: '1000', kind: 'numeric' }
const noteField: FormField = { name: '备注', desc: '备注说明', example: '补充说明' }

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
  tips: ['提示一：名称要唯一', '提示二：寿元只填数字'],
}

/** 组件自带的中文只允许是这几个控件字样（字段级文案必须来自 TabDef）。 */
const CHROME_TEXT = ['保存', '保存中…', '只读', '本页暂无可填写的字段']

function fieldOf(name: string, kind?: 'numeric'): FormField {
  return kind === undefined
    ? { name, desc: '', example: '' }
    : { name, desc: '', example: '', kind }
}

function mountForm(overrides: Partial<{
  tab: TabDef
  value: Record<string, unknown>
  readonly: boolean
  busy: boolean
}> = {}) {
  return mount(TabFormView, {
    props: {
      tab: overrides.tab ?? demoTab,
      value: overrides.value ?? {},
      readonly: overrides.readonly ?? false,
      busy: overrides.busy ?? false,
    },
  })
}

/** `TabDef` 里所有可见文案（模块名 / 字段名 / 说明 / 示例 / 提示 / 页签名与描述）。 */
function tabTexts(tab: TabDef): Set<string> {
  const texts = new Set<string>()
  const add = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed !== '') texts.add(trimmed)
  }
  add(tab.name)
  add(tab.description)
  for (const tip of tab.tips ?? []) add(tip)
  for (const module of tab.modules ?? []) {
    add(module.name)
    for (const field of module.fields) {
      add(field.name)
      add(field.desc)
      add(field.example)
    }
  }
  return texts
}

/**
 * 绕过 DOM 对 `type="number"` 的值净化，把「脏值」直接装到事件目标上。
 * 真实浏览器/ happy-dom 在键入或赋值时就会吞掉非数字（值变 `''`），所以只有
 * paste / 程序化赋值这类路径才会让非数字到达 `target.value` —— 也正是组件里
 * `applyFieldInput` 的过滤要兜住的情形（纯函数层另有更全的用例）。
 */
function setRawValue(input: { element: Element }, raw: string): void {
  Object.defineProperty(input.element, 'value', { value: raw, configurable: true, writable: true })
}

/** 收集元素下所有非空文本节点（用来反查「组件有没有自己写中文」）。 */
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

describe('TabFormView · 渲染', () => {
  it('按 modules 分组渲染组标题，并按字段顺序渲染标签与说明', () => {
    const wrapper = mountForm()

    expect(wrapper.findAll('.tab-form__module-name').map((node) => node.text())).toEqual(['第一组', '第二组'])
    expect(wrapper.find('[data-testid="form-module-第一组"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="form-module-第二组"]').exists()).toBe(true)
    expect(wrapper.findAll('.tab-form__field-name').map((node) => node.text())).toEqual(['名称', '寿元', '备注'])
    // 空说明不渲染空段落
    expect(wrapper.findAll('.tab-form__field-desc').map((node) => node.text())).toEqual(['名称说明', '备注说明'])
  })

  it('每个字段的 example 进 placeholder', () => {
    const wrapper = mountForm()
    expect(wrapper.get('[data-testid="field-名称"]').attributes('placeholder')).toBe('例如：青云门')
    expect(wrapper.get('[data-testid="field-寿元"]').attributes('placeholder')).toBe('1000')
    expect(wrapper.get('[data-testid="field-备注"]').attributes('placeholder')).toBe('补充说明')
  })

  it("kind:'numeric' 走数字输入，其余走多行文本", () => {
    const wrapper = mountForm()
    const numeric = wrapper.get('[data-testid="field-寿元"]')
    expect(numeric.element.tagName).toBe('INPUT')
    expect(numeric.attributes('type')).toBe('number')
    expect(numeric.attributes('inputmode')).toBe('numeric')

    const text = wrapper.get('[data-testid="field-名称"]')
    expect(text.element.tagName).toBe('TEXTAREA')
  })

  it('tips 渲染在底部', () => {
    const wrapper = mountForm()
    expect(wrapper.get('[data-testid="form-tips"]').findAll('li').map((node) => node.text())).toEqual([
      '提示一：名称要唯一',
      '提示二：寿元只填数字',
    ])
  })

  it('所有交互元素都带 data-testid', () => {
    const wrapper = mountForm()
    const interactive = wrapper.findAll('input, textarea, button')
    expect(interactive.length).toBe(4) // 3 个字段 + 1 个保存按钮
    for (const element of interactive) {
      expect(element.attributes('data-testid')).toBeTruthy()
    }
  })

  it('可见中文只来自 TabDef 与控件字样（组件不另写一份标签）', () => {
    const wrapper = mountForm()
    const allowed = new Set([...tabTexts(demoTab), ...CHROME_TEXT])
    const foreign = textNodesOf(wrapper.element).filter((text) => !allowed.has(text))
    expect(foreign).toEqual([])
  })
})

describe('TabFormView · 值进出', () => {
  it('输入即 emit update:value：补默认值、单字段更新、遗留键一起带出', async () => {
    const wrapper = mountForm({ value: { 作者遗留键: '保留' } })

    await wrapper.get('[data-testid="field-名称"]').setValue('青云门')

    expect(wrapper.emitted('update:value')).toHaveLength(1)
    expect(wrapper.emitted('update:value')?.[0]?.[0]).toEqual({
      名称: '青云门',
      寿元: '',
      备注: '',
      作者遗留键: '保留',
    })
  })

  it("numeric 字段只留数字：非数字字符进不来（'寿元 1200 岁' → '1200'）", async () => {
    const wrapper = mountForm()
    const numeric = wrapper.get('[data-testid="field-寿元"]')

    // 真实浏览器（happy-dom 同）对 `type="number"` 在键入/赋值时就把非数字吞掉，值变成 ''；
    // 这里绕过该净化，直接给事件目标塞脏值，覆盖 paste / 程序化赋值等会带脏值进 `target.value` 的路径。
    setRawValue(numeric, '寿元 1200 岁')
    await numeric.trigger('input')
    expect((wrapper.emitted('update:value')?.[0]?.[0] as Record<string, unknown>)['寿元']).toBe('1200')

    // 常规路径：合法数字原样往返
    await numeric.setValue('1200')
    expect((wrapper.emitted('update:value')?.[1]?.[0] as Record<string, unknown>)['寿元']).toBe('1200')
  })

  it('点保存 emit save：带的是补过默认值的整份值（含遗留键）', async () => {
    const wrapper = mountForm({ value: { 名称: '青云门', 作者遗留键: '保留' } })

    await wrapper.get('[data-testid="form-save"]').trigger('click')

    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
      名称: '青云门',
      寿元: '',
      备注: '',
      作者遗留键: '保留',
    })
  })
})

describe('TabFormView · 只读 / 忙 / 空态', () => {
  it('只读态：有只读标记、字段禁用、没有保存按钮、任何输入都不 emit', async () => {
    const wrapper = mountForm({ value: { 名称: '青云门' }, readonly: true })

    // `get()` 找不到就抛错 ⇒ 断言「取到了元素」比 `.exists()` 更贴切；
    // 本仓库 VTU 的 `get` 返回类型刻意 Omit 掉了 `exists`（只有 `find` 有）。
    expect(wrapper.get('[data-testid="form-readonly"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="form-root"]').attributes('data-readonly')).toBe('true')
    expect(wrapper.find('[data-testid="form-save"]').exists()).toBe(false)

    const input = wrapper.get('[data-testid="field-名称"]')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('readonly')).toBeDefined()
    expect((input.element as HTMLTextAreaElement).value).toBe('青云门')

    await input.setValue('不该写进去')
    expect(wrapper.emitted('update:value')).toBeUndefined()
  })

  it('忙态：保存按钮 loading + disabled 且不 emit save，字段也不接受输入', async () => {
    const wrapper = mountForm({ busy: true })

    expect(wrapper.get('[data-testid="form-busy"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="form-root"]').attributes('aria-busy')).toBe('true')

    const save = wrapper.get('[data-testid="form-save"]')
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    expect(wrapper.emitted('save')).toBeUndefined()

    await wrapper.get('[data-testid="field-名称"]').setValue('忙时输入')
    expect(wrapper.emitted('update:value')).toBeUndefined()
  })

  it('空态：无 modules 时显示空态、没有字段也没有保存按钮', () => {
    const wrapper = mountForm({ tab: { ...demoTab, modules: [] } })

    expect(wrapper.get('[data-testid="form-empty"]').text()).toBe('本页暂无可填写的字段')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-save"]').exists()).toBe(false)
  })
})

describe('TabFormView · 题材包联动', () => {
  it('modules 是 getter 时每次重渲染都现读（组件不缓存 TabDef）', async () => {
    let pack: FormModule[] = [{ name: '甲题材组', fields: [fieldOf('甲字段')] }]
    const liveTab: TabDef = {
      id: 'live-form',
      name: '联动页签',
      group: 'world',
      type: 'form',
      description: '',
      get modules(): FormModule[] {
        return pack
      },
    }
    const wrapper = mountForm({ tab: liveTab })

    expect(wrapper.find('[data-testid="form-module-甲题材组"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="field-甲字段"]').exists()).toBe(true)

    pack = [{ name: '乙题材组', fields: [fieldOf('乙字段', 'numeric')] }]
    await wrapper.setProps({ value: { 乙字段: '7' } })

    expect(wrapper.find('[data-testid="form-module-甲题材组"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="form-module-乙题材组"]').exists()).toBe(true)
    const numeric = wrapper.get('[data-testid="field-乙字段"]')
    expect(numeric.attributes('type')).toBe('number')
    expect((numeric.element as HTMLInputElement).value).toBe('7')
  })
})
