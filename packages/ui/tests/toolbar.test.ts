import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'

import { YfeButton, YfeToolbar } from '../src/index.js'
import { track } from './support.js'

describe('YfeToolbar：无 props、纯插槽容器', () => {
  it('渲染默认插槽里的全部子项，并保持顺序', () => {
    const wrapper = track(
      mount(YfeToolbar, {
        slots: {
          default: () => [
            h(YfeButton, { label: '撤销', key: 'undo' }),
            h(YfeButton, { label: '重做', key: 'redo' }),
          ],
        },
      }),
    )

    expect(wrapper.findAll('button').map((button) => button.text())).toEqual(['撤销', '重做'])
    expect(wrapper.classes()).toContain('yfe-toolbar')
  })

  it('没有 props 也照常挂载（具名导出必须能直接 mount）', () => {
    const wrapper = track(mount(YfeToolbar))
    expect(wrapper.classes()).toContain('yfe-toolbar')
    expect(wrapper.text()).toBe('')
  })

  it('插槽内容可以放非按钮元素（AI 入口不一定是个 button）', () => {
    const wrapper = track(
      mount(YfeToolbar, {
        slots: { default: () => h('span', { class: 'ai-entry' }, 'AI') },
      }),
    )
    expect(wrapper.get('.ai-entry').text()).toBe('AI')
  })
})
