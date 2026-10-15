import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { YfeStatusPill } from '../src/index.js'
import type { YfeSaveStatus } from '../src/index.js'
import { track } from './support.js'

/** ADR 0006 D5 的六态文案，逐个钉死：文案只允许在 YfeStatusPill 内部定义一次。 */
const STATUS_CASES: readonly (readonly [YfeSaveStatus, string])[] = [
  ['saved', '本地已保存'],
  ['dirty', '有未保存修改'],
  ['saving', '保存中'],
  ['error', '保存失败'],
  ['conflict', '冲突'],
  ['offline', '离线（本地已保存）'],
]

describe('YfeStatusPill：六态文案与未知兜底', () => {
  for (const [status, label] of STATUS_CASES) {
    it(`${status} 显示「${label}」`, () => {
      const wrapper = track(mount(YfeStatusPill, { props: { status } }))
      expect(wrapper.text()).toContain(label)
      expect(wrapper.attributes('data-status')).toBe(status)
      expect(wrapper.attributes('data-status-key')).toBe(status)
      expect(wrapper.classes()).toContain(`yfe-status-pill--${status}`)
    })
  }

  it('未知状态不抛错：显示「未知状态」并保留原始值', () => {
    // 后端加了新枚举、旧前端先上线：界面必须还能显示，而不是整块白屏。
    const wrapper = track(mount(YfeStatusPill, { props: { status: 'mystery' as YfeSaveStatus } }))

    expect(wrapper.text()).toContain('未知状态')
    expect(wrapper.attributes('data-status')).toBe('mystery')
    expect(wrapper.attributes('data-status-key')).toBe('unknown')
    expect(wrapper.classes()).toContain('yfe-status-pill--unknown')
  })

  it('detail 作为补充说明渲染，未传时不占位', () => {
    const withDetail = track(
      mount(YfeStatusPill, { props: { status: 'error', detail: '磁盘只读' } }),
    )
    expect(withDetail.get('.yfe-status-pill__detail').text()).toBe('磁盘只读')

    const withoutDetail = track(mount(YfeStatusPill, { props: { status: 'saved' } }))
    expect(withoutDetail.find('.yfe-status-pill__detail').exists()).toBe(false)
  })

  it('是 live region：状态异步变化时屏幕阅读器要被通知', () => {
    const wrapper = track(mount(YfeStatusPill, { props: { status: 'saving' } }))
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
  })
})
