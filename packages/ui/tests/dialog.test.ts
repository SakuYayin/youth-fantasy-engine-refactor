import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { YfeDialog } from '../src/index.js'
import { documentOf, elementOf, focusOf, track } from './support.js'

function mountDialog(props: {
  open: boolean
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'normal' | 'danger'
}) {
  return track(
    mount(YfeDialog, {
      // 必须真的挂进文档：@vue/test-utils 默认挂成游离节点，那样 keydown 冒泡不到
      // document、focus() 也不会成为 document.activeElement——测的就不是真实路径了。
      // 这里用选择器字符串（tests 程序没有 DOM lib，拿不到 HTMLElement 类型名）。
      attachTo: 'body',
      props: {
        open: props.open,
        title: props.title ?? '删除这一章？',
        confirmLabel: props.confirmLabel ?? '删除',
        ...(props.cancelLabel === undefined ? {} : { cancelLabel: props.cancelLabel }),
        ...(props.tone === undefined ? {} : { tone: props.tone }),
      },
    }),
  )
}

describe('YfeDialog：渲染、确认/取消、Esc 与焦点陷阱', () => {
  it('open=false 时整块不渲染（不是 display:none 藏着）', () => {
    const wrapper = mountDialog({ open: false })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('open=true 时渲染标题、aria-modal 与标题关联', () => {
    const wrapper = mountDialog({ open: true })
    const dialog = wrapper.get('[role="dialog"]')

    expect(dialog.attributes('aria-modal')).toBe('true')
    const labelledBy = dialog.attributes('aria-labelledby')
    expect(labelledBy).toBeDefined()
    expect(wrapper.get('.yfe-dialog__title').attributes('id')).toBe(labelledBy)
    expect(wrapper.get('.yfe-dialog__title').text()).toBe('删除这一章？')
  })

  it('同一应用内两个对话框的标题 ID 唯一并各自关联', () => {
    const wrapper = track(mount({
      components: { YfeDialog },
      template: '<div><YfeDialog :open="true" title="第一个" confirm-label="确认" /><YfeDialog :open="true" title="第二个" confirm-label="确认" /></div>',
    }, { attachTo: 'body' }))
    const dialogs = wrapper.findAll('[role="dialog"]')
    const ids = dialogs.map((dialog) => dialog.attributes('aria-labelledby'))
    expect(new Set(ids).size).toBe(2)
    for (const dialog of dialogs) {
      expect(dialog.get('h2').attributes('id')).toBe(dialog.attributes('aria-labelledby'))
    }
  })

  it('确认/取消按钮用传入文案，取消未传时兜底为「取消」', () => {
    const wrapper = mountDialog({ open: true, confirmLabel: '保存并关闭' })
    expect(wrapper.get('[data-role="confirm"]').text()).toBe('保存并关闭')
    expect(wrapper.get('[data-role="cancel"]').text()).toBe('取消')

    const custom = mountDialog({ open: true, cancelLabel: '放弃修改' })
    expect(custom.get('[data-role="cancel"]').text()).toBe('放弃修改')
  })

  it('tone=danger 时确认按钮走危险色', () => {
    expect(mountDialog({ open: true, tone: 'danger' }).get('[data-role="confirm"]').classes()).toContain(
      'yfe-button--danger',
    )
    expect(mountDialog({ open: true }).get('[data-role="confirm"]').classes()).toContain(
      'yfe-button--primary',
    )
  })

  it('点确认 emit confirm，点取消 emit cancel，各一次', async () => {
    const wrapper = mountDialog({ open: true })

    await wrapper.get('[data-role="confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toBeUndefined()

    await wrapper.get('[data-role="cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    // 点取消不该顺带确认。
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('Esc 关闭（等价于 cancel）：监听挂在 document 上，焦点在按钮上也能收到', async () => {
    const wrapper = mountDialog({ open: true })

    // 事件从对话框内的按钮冒泡到 document，测的就是那条真实路径。
    await wrapper.get('[data-role="confirm"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('打开即接管焦点，Tab / Shift+Tab 在取消与确认之间循环（焦点陷阱）', async () => {
    const wrapper = mountDialog({ open: true })
    const document = documentOf(wrapper)

    expect(document.activeElement).toBe(elementOf(wrapper, '[data-role="cancel"]'))

    // 焦点在确认上按 Tab：必须是「下一个」——也就是回到取消，而不是跑出对话框。
    focusOf(wrapper, '[data-role="confirm"]')
    await wrapper.get('[data-role="confirm"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(elementOf(wrapper, '[data-role="cancel"]'))

    // 焦点在取消上按 Shift+Tab：回到确认（反向循环）。
    focusOf(wrapper, '[data-role="cancel"]')
    await wrapper.get('[data-role="cancel"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(elementOf(wrapper, '[data-role="confirm"]'))
  })

  it('关闭或卸载后 Esc 不再生效（document 监听必须摘干净）', async () => {
    const wrapper = mountDialog({ open: true })
    const document = documentOf(wrapper)

    await wrapper.setProps({ open: false })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('cancel')).toBeUndefined()

    wrapper.unmount()
    document.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('cancel')).toBeUndefined()
  })
})
