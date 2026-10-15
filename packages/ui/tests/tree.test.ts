import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { YfeTree } from '../src/index.js'
import type { YfeTreeNode } from '../src/index.js'
import { track } from './support.js'

const NODES: readonly YfeTreeNode[] = [
  { id: 'ch1', label: '第一章', depth: 0, hasChildren: true },
  { id: 'ch1-s1', label: '第一节', depth: 1, hasChildren: false },
  { id: 'ch1-s2', label: '第二节', depth: 1, hasChildren: false, current: true },
  { id: 'ch2', label: '第二章', depth: 0, hasChildren: true, deleted: true },
  { id: 'ch2-s1', label: '第三章草稿', depth: 1, hasChildren: false },
]

function mountTree(options: {
  nodes?: readonly YfeTreeNode[]
  selectedId?: string | null
  expandedIds?: readonly string[]
}) {
  return track(
    mount(YfeTree, {
      props: {
        nodes: options.nodes ?? NODES,
        selectedId: options.selectedId ?? null,
        expandedIds: options.expandedIds ?? [],
      },
    }),
  )
}

describe('YfeTree：渲染、折叠与事件分流', () => {
  it('按传入顺序渲染节点文案，并按 depth 缩进', () => {
    const wrapper = mountTree({ expandedIds: ['ch1'] })

    expect(wrapper.findAll('[role="treeitem"]').map((row) => row.get('[data-label-id]').text())).toEqual([
      '第一章',
      '第一节',
      '第二节',
      '第二章',
    ])
    // 缩进步长来自 designTokens.size.treeIndent（18px），不是写死的数字。
    expect(wrapper.get('[data-node-id="ch1"]').attributes('style')).toMatch(/padding-left:\s*0px/)
    expect(wrapper.get('[data-node-id="ch1-s1"]').attributes('style')).toMatch(/padding-left:\s*18px/)
  })

  it('未展开的节点不渲染子节点，展开后才出现（aria-expanded 同步）', () => {
    const collapsed = mountTree({ expandedIds: [] })
    expect(collapsed.find('[data-node-id="ch1-s1"]').exists()).toBe(false)
    expect(collapsed.get('[data-node-id="ch1"]').attributes('aria-expanded')).toBe('false')
    // 折叠只影响子树：兄弟节点还在。
    expect(collapsed.find('[data-node-id="ch2"]').exists()).toBe(true)

    const expanded = mountTree({ expandedIds: ['ch1'] })
    expect(expanded.find('[data-node-id="ch1-s1"]').exists()).toBe(true)
    expect(expanded.get('[data-node-id="ch1"]').attributes('aria-expanded')).toBe('true')
    // ch2 仍未展开，它的子节点不能被 ch1 的展开带出来。
    expect(expanded.find('[data-node-id="ch2-s1"]').exists()).toBe(false)
  })

  it('叶子节点没有展开箭头，也没有 aria-expanded', () => {
    // 先展开父节点，否则叶子根本不渲染（折叠 = 不渲染，不是 display:none）。
    const wrapper = mountTree({ expandedIds: ['ch1'] })
    expect(wrapper.find('[data-toggle-id="ch1-s1"]').exists()).toBe(false)
    expect(wrapper.get('[data-node-id="ch1-s1"]').attributes('aria-expanded')).toBeUndefined()
  })

  it('点标题只 select、点箭头只 toggle（互不串台）', async () => {
    const wrapper = mountTree({ expandedIds: [] })

    await wrapper.get('[data-label-id="ch1"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['ch1']])
    expect(wrapper.emitted('toggle')).toBeUndefined()

    const toggled = mountTree({ expandedIds: [] })
    await toggled.get('[data-toggle-id="ch1"]').trigger('click')
    expect(toggled.emitted('toggle')).toEqual([['ch1']])
    expect(toggled.emitted('select')).toBeUndefined()
  })

  it('selected 高亮、deleted 删除线、current 标记各自生效', () => {
    const wrapper = mountTree({ selectedId: 'ch1', expandedIds: ['ch1'] })

    expect(wrapper.get('[data-label-id="ch1"]').classes()).toContain('yfe-tree__label--selected')
    expect(wrapper.get('[data-node-id="ch1"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[data-label-id="ch2"]').classes()).toContain('yfe-tree__label--deleted')
    // current 是「当前打开的文档」，与 selected 是两件事：这里 selected=ch1，标记在 ch1-s2。
    const markers = wrapper.findAll('[data-current-marker]')
    expect(markers).toHaveLength(1)
    expect(wrapper.get('[data-label-id="ch1-s2"]').find('[data-current-marker]').exists()).toBe(true)
  })

  it('键盘 ←/→ 等价于点箭头（键盘用户点不到小三角）', async () => {
    const wrapper = mountTree({ expandedIds: [] })

    await wrapper.get('[data-label-id="ch1"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('toggle')).toEqual([['ch1']])

    const expanded = mountTree({ expandedIds: ['ch1'] })
    await expanded.get('[data-label-id="ch1"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(expanded.emitted('toggle')).toEqual([['ch1']])

    // 已经展开还按 →、叶子节点按 → 都不该产生 toggle 噪音。
    const again = mountTree({ expandedIds: ['ch1'] })
    await again.get('[data-label-id="ch1"]').trigger('keydown', { key: 'ArrowRight' })
    await again.get('[data-label-id="ch1-s1"]').trigger('keydown', { key: 'ArrowRight' })
    expect(again.emitted('toggle')).toBeUndefined()
  })

  it('空列表照常渲染（打开空项目时不该炸）', () => {
    const wrapper = mountTree({ nodes: [], expandedIds: [] })
    expect(wrapper.find('[role="tree"]').exists()).toBe(true)
    expect(wrapper.findAll('[role="treeitem"]')).toHaveLength(0)
  })
})
