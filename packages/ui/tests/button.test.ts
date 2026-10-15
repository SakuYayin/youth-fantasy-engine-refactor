import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { YfeButton } from '../src/index.js'
import { tagNameOf, track } from './support.js'

describe('YfeButton：渲染与点击语义', () => {
  it('渲染 label，并按 variant 切换类名（默认 ghost）', () => {
    const ghost = track(mount(YfeButton, { props: { label: '保存' } }))
    expect(ghost.text()).toContain('保存')
    expect(ghost.classes()).toContain('yfe-button--ghost')

    const primary = track(mount(YfeButton, { props: { label: '保存', variant: 'primary' } }))
    expect(primary.classes()).toContain('yfe-button--primary')

    const danger = track(mount(YfeButton, { props: { label: '删除', variant: 'danger' } }))
    expect(danger.classes()).toContain('yfe-button--danger')
  })

  it('是真 <button type="button">：键盘与表单语义不能靠 div 假装', () => {
    const wrapper = track(mount(YfeButton, { props: { label: '保存' } }))
    expect(tagNameOf(wrapper, 'button')).toBe('BUTTON')
    expect(wrapper.attributes('type')).toBe('button')
  })

  it('可点击时 emit click，并转交原生事件', () => {
    const wrapper = track(mount(YfeButton, { props: { label: '保存' } }))

    return wrapper.get('button').trigger('click').then(() => {
      const emitted = wrapper.emitted('click')
      expect(emitted).toHaveLength(1)
      expect((emitted?.[0]?.[0] as { type?: string } | undefined)?.type).toBe('click')
    })
  })

  it('disabled 时不 emit click，且原生 disabled 生效', () => {
    const wrapper = track(mount(YfeButton, { props: { label: '保存', disabled: true } }))

    // trigger 会绕过原生 disabled 直接派发事件，所以这条测的是组件里的第二道闸。
    return wrapper
      .get('button')
      .trigger('click')
      .then(() => {
        expect(wrapper.emitted('click')).toBeUndefined()
        expect(wrapper.attributes('disabled')).toBeDefined()
      })
  })

  it('loading 时既不 emit click 也不可再点，但 label 仍在（不能让按钮变空白）', () => {
    const wrapper = track(mount(YfeButton, { props: { label: '保存中…', loading: true } }))

    return wrapper
      .get('button')
      .trigger('click')
      .then(() => {
        expect(wrapper.emitted('click')).toBeUndefined()
        expect(wrapper.attributes('disabled')).toBeDefined()
        expect(wrapper.attributes('aria-busy')).toBe('true')
        expect(wrapper.text()).toContain('保存中…')
      })
  })

  it('不加载时 aria-busy 不出现（不要留一个恒为 false 的噪音属性）', () => {
    const wrapper = track(mount(YfeButton, { props: { label: '保存' } }))
    expect(wrapper.attributes('aria-busy')).toBeUndefined()
  })
})
