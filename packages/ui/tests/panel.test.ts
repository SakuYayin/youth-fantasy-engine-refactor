import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'

import { YfePanel } from '../src/index.js'
import { track } from './support.js'

function mountPanel(props: { title?: string; dense?: boolean }) {
  return track(
    mount(YfePanel, {
      props,
      slots: { default: () => h('p', { class: 'panel-slot' }, '面板内容') },
    }),
  )
}

describe('YfePanel：标题、插槽与密度', () => {
  it('渲染标题并把默认插槽内容放进正文区', () => {
    const wrapper = mountPanel({ title: '资料' })
    expect(wrapper.get('.yfe-panel__title').text()).toBe('资料')
    expect(wrapper.get('.panel-slot').text()).toBe('面板内容')
  })

  it('title 省略或为空串时不渲染标题栏（空标题栏会白占一行高度）', () => {
    expect(mountPanel({}).find('.yfe-panel__header').exists()).toBe(false)
    expect(mountPanel({ title: '' }).find('.yfe-panel__header').exists()).toBe(false)
    // 但正文照样渲染：没有标题的面板仍然是有用的容器。
    expect(mountPanel({}).get('.panel-slot').text()).toBe('面板内容')
  })

  it('dense 通过令牌换内边距，不是写死数字', () => {
    const normal = mountPanel({ title: '资料' })
    const dense = mountPanel({ title: '资料', dense: true })

    expect(normal.classes()).not.toContain('yfe-panel--dense')
    expect(dense.classes()).toContain('yfe-panel--dense')

    // 内侧间距走同一个变量出口，值来自 designTokens.space（md=12px / sm=8px）。
    expect(normal.attributes('style')).toMatch(/--yfe-panel-padding:\s*12px/)
    expect(dense.attributes('style')).toMatch(/--yfe-panel-padding:\s*8px/)
  })
})
