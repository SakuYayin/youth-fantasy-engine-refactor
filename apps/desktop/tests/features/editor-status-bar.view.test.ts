// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * 编辑器状态栏的视图测试（W9-1 / A-13）。
 *
 * 断的是「用户看得见的东西」：文案、title、aria 状态、disabled、emit 的补丁；
 * 文案期望值逐字来自上游 `NovelEditor.tsx:616-664`。
 * 受控重渲染用宿主探针组件（`tests/schema/tab-sidebar-collapse.test.ts:83-107` 的写法），
 * 因为 `vue-shims.d.ts` 把 `*.vue` 声明成 `DefineComponent<{}, {}, unknown>`，
 * 直接 `setProps({ 具名 prop })` 会 TS2353。
 */

import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { readFileSync } from 'node:fs'

import EditorStatusBar from '../../src/renderer/features/editor-status-bar.vue'

const BASE_TEXT = '一二三。'

function mountBar(props: Record<string, unknown> = {}) {
  return mount(EditorStatusBar, { props: { text: BASE_TEXT, ...props } })
}

type Bar = ReturnType<typeof mountBar>

function el(wrapper: Bar, testId: string) {
  return wrapper.find(`[data-testid="${testId}"]`)
}

/** 取出每次 `change` 事件的补丁参数。 */
function patches(wrapper: Bar): unknown[] {
  return (wrapper.emitted('change') ?? []).map((call) => call[0])
}

function isDisabled(wrapper: Bar, testId: string): boolean {
  return (el(wrapper, testId).element as HTMLButtonElement).disabled
}

/* --------------------------------------- 默认渲染 --------------------------------------- */

describe('默认渲染 —— 只吃 props 也能出一整条栏', () => {
  it('根节点带 testid、分组语义与 aria 名', () => {
    const wrapper = mountBar()
    const root = el(wrapper, 'editor-status-bar')
    expect(root.exists()).toBe(true)
    expect(root.attributes('role')).toBe('group')
    expect(root.attributes('aria-label')).toBe('编辑器状态栏')
  })

  it('本章字数只算汉字口径，默认不加标点且带单位「字」', () => {
    const wrapper = mountBar()
    expect(el(wrapper, 'editor-status-bar-chapter-words').text()).toBe('3 字')
    expect(el(wrapper, 'editor-status-bar-chapter-words').attributes('title')).toBe(
      '本章字数（只算汉字口径）',
    )
  })

  it('今日码字默认（未传入）显示 —，绝不显示 0', () => {
    const wrapper = mountBar()
    const today = el(wrapper, 'editor-status-bar-today-words')
    expect(today.text()).toBe('今日 — 字')
    expect(today.text()).not.toContain('0')
    expect(today.attributes('title')).toContain('暂不可用')
  })

  it('默认铺满、打字机关闭、字号 16、说明不展开', () => {
    const wrapper = mountBar()
    expect(el(wrapper, 'editor-status-bar-page-wide').text()).toBe('铺满')
    expect(el(wrapper, 'editor-status-bar-page-wide').attributes('aria-pressed')).toBe('true')
    expect(el(wrapper, 'editor-status-bar-typewriter').attributes('aria-pressed')).toBe('false')
    expect(el(wrapper, 'editor-status-bar-font-size').text()).toBe('16')
    expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(false)
  })

  it('每个按钮都有 title 与 aria-label（键盘可达）', () => {
    const wrapper = mountBar()
    expect(el(wrapper, 'editor-status-bar-page-wide').attributes('title')).toBe(
      '当前：码字区铺满窗口（点击改为限宽阅读）',
    )
    expect(el(wrapper, 'editor-status-bar-page-wide').attributes('aria-label')).toBe('铺满')
    expect(el(wrapper, 'editor-status-bar-typewriter').attributes('title')).toBe(
      '打字机模式：输入行自动保持在屏幕中部',
    )
    expect(el(wrapper, 'editor-status-bar-typewriter').attributes('aria-label')).toBe('打字机')
    expect(el(wrapper, 'editor-status-bar-font-decrease').attributes('title')).toBe('减小字号')
    expect(el(wrapper, 'editor-status-bar-font-increase').attributes('aria-label')).toBe('增大字号')
    expect(el(wrapper, 'editor-status-bar-help-toggle').attributes('title')).toBe(
      '状态栏 · 码字体验设置（点击查看说明）',
    )
  })
})

/* -------------------------------------- props 驱动文案 -------------------------------------- */

describe('props 驱动文案', () => {
  it('wordCountWithPunct 只切显示口径，且 title 跟着换', () => {
    const plain = mountBar({ wordCountWithPunct: false })
    const punct = mountBar({ wordCountWithPunct: true })
    expect(el(plain, 'editor-status-bar-chapter-words').text()).toBe('3 字')
    expect(el(punct, 'editor-status-bar-chapter-words').text()).toBe('4 字')
    expect(el(punct, 'editor-status-bar-chapter-words').attributes('title')).toBe(
      '本章字数（汉字＋标点口径）',
    )
  })

  it('今日码字三态：读不到 / 0 / 有量', () => {
    const unknown = mountBar({ todayChars: null })
    expect(el(unknown, 'editor-status-bar-today-words').text()).toBe('今日 — 字')

    const zero = mountBar({ todayChars: 0 })
    expect(el(zero, 'editor-status-bar-today-words').text()).toBe('今日 0 字')
    expect(el(zero, 'editor-status-bar-today-words').attributes('title')).toContain('按增删自动累计')

    const some = mountBar({ todayChars: 12345 })
    expect(el(some, 'editor-status-bar-today-words').text()).toBe('今日 12,345 字')
  })

  it('负净增量照实显示', () => {
    const wrapper = mountBar({ todayChars: -12 })
    expect(el(wrapper, 'editor-status-bar-today-words').text()).toBe('今日 -12 字')
  })

  it('限宽态与打字机开启态会同时反映在文案与 aria-pressed 上', () => {
    const wrapper = mountBar({ pageWide: false, typewriter: true })
    expect(el(wrapper, 'editor-status-bar-page-wide').text()).toBe('限宽')
    expect(el(wrapper, 'editor-status-bar-page-wide').attributes('title')).toBe(
      '当前：限宽阅读（点击改为铺满窗口）',
    )
    expect(el(wrapper, 'editor-status-bar-page-wide').attributes('aria-pressed')).toBe('false')
    expect(el(wrapper, 'editor-status-bar-typewriter').attributes('aria-pressed')).toBe('true')
  })

  it('脏 fontSize 不白屏：回落上游默认 17', () => {
    const wrapper = mountBar({ fontSize: 'abc' })
    expect(el(wrapper, 'editor-status-bar-font-size').text()).toBe('17')
  })

  it('空稿（正文为空串）显示 0 字，不白屏', () => {
    const wrapper = mountBar({ text: '' })
    expect(el(wrapper, 'editor-status-bar-chapter-words').text()).toBe('0 字')
  })
})

/* ----------------------------------------- 交互与 emit ----------------------------------------- */

describe('交互 —— 只 emit change(补丁)，不落盘', () => {
  it('点铺满切成限宽（补丁是 pageWide:false）', async () => {
    const wrapper = mountBar({ pageWide: true })
    await el(wrapper, 'editor-status-bar-page-wide').trigger('click')
    expect(patches(wrapper)).toEqual([{ pageWide: false }])
  })

  it('点限宽切回铺满', async () => {
    const wrapper = mountBar({ pageWide: false })
    await el(wrapper, 'editor-status-bar-page-wide').trigger('click')
    expect(patches(wrapper)).toEqual([{ pageWide: true }])
  })

  it('打字机开关双向都发补丁', async () => {
    const off = mountBar({ typewriter: false })
    await el(off, 'editor-status-bar-typewriter').trigger('click')
    expect(patches(off)).toEqual([{ typewriter: true }])

    const on = mountBar({ typewriter: true })
    await el(on, 'editor-status-bar-typewriter').trigger('click')
    expect(patches(on)).toEqual([{ typewriter: false }])
  })

  it('字号 ± 各走 1px，补丁用 \'17px\' 形态', async () => {
    const up = mountBar({ fontSize: '16px' })
    await el(up, 'editor-status-bar-font-increase').trigger('click')
    expect(patches(up)).toEqual([{ fontSize: '17px' }])

    const down = mountBar({ fontSize: '16px' })
    await el(down, 'editor-status-bar-font-decrease').trigger('click')
    expect(patches(down)).toEqual([{ fontSize: '15px' }])
  })

  it('字号到底 14px：减号禁用且点了也不发补丁，加号仍可用', async () => {
    const wrapper = mountBar({ fontSize: '14px' })
    expect(isDisabled(wrapper, 'editor-status-bar-font-decrease')).toBe(true)
    expect(isDisabled(wrapper, 'editor-status-bar-font-increase')).toBe(false)
    await el(wrapper, 'editor-status-bar-font-decrease').trigger('click')
    expect(patches(wrapper)).toEqual([])
    await el(wrapper, 'editor-status-bar-font-increase').trigger('click')
    expect(patches(wrapper)).toEqual([{ fontSize: '15px' }])
  })

  it('字号到顶 28px：加号禁用且点了也不发补丁，减号仍可用', async () => {
    const wrapper = mountBar({ fontSize: '28px' })
    expect(isDisabled(wrapper, 'editor-status-bar-font-increase')).toBe(true)
    expect(isDisabled(wrapper, 'editor-status-bar-font-decrease')).toBe(false)
    await el(wrapper, 'editor-status-bar-font-increase').trigger('click')
    expect(patches(wrapper)).toEqual([])
    await el(wrapper, 'editor-status-bar-font-decrease').trigger('click')
    expect(patches(wrapper)).toEqual([{ fontSize: '27px' }])
  })

  it('一次点击只发一个补丁（不一次性灌整份设置）', async () => {
    const wrapper = mountBar()
    await el(wrapper, 'editor-status-bar-page-wide').trigger('click')
    await el(wrapper, 'editor-status-bar-typewriter').trigger('click')
    expect(patches(wrapper)).toEqual([{ pageWide: false }, { typewriter: true }])
  })
})

/* ------------------------------------------ readOnly ------------------------------------------ */

describe('readOnly —— 禁用三个设置项，不静默失败', () => {
  it('铺满 / 打字机 / 字号 ± 全部禁用，点击不发补丁', async () => {
    const wrapper = mountBar({ readOnly: true })
    for (const testId of [
      'editor-status-bar-page-wide',
      'editor-status-bar-typewriter',
      'editor-status-bar-font-decrease',
      'editor-status-bar-font-increase',
      'editor-status-bar-help-toggle',
    ]) {
      expect(isDisabled(wrapper, testId), testId).toBe(true)
    }
    await el(wrapper, 'editor-status-bar-page-wide').trigger('click')
    await el(wrapper, 'editor-status-bar-typewriter').trigger('click')
    await el(wrapper, 'editor-status-bar-font-increase').trigger('click')
    expect(patches(wrapper)).toEqual([])
  })

  it('只读时实时字数照常显示（读不影响看）', () => {
    const wrapper = mountBar({ readOnly: true, todayChars: 88 })
    expect(el(wrapper, 'editor-status-bar-chapter-words').text()).toBe('3 字')
    expect(el(wrapper, 'editor-status-bar-today-words').text()).toBe('今日 88 字')
  })
})

/* ----------------------------------------- 说明气泡 ----------------------------------------- */

describe('说明气泡', () => {
  it('点击展开：标题 + 7 行说明，文案与上游一致（去掉未还原入口的指向）', async () => {
    const wrapper = mountBar()
    await el(wrapper, 'editor-status-bar-help-toggle').trigger('click')

    expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(true)
    expect(el(wrapper, 'editor-status-bar-help-title').text()).toBe('状态栏 · 码字体验设置')
    expect(wrapper.findAll('[data-testid^="editor-status-bar-help-line-"]')).toHaveLength(7)

    const text = el(wrapper, 'editor-status-bar-help').text()
    expect(text).toContain('左侧两项是实时状态：')
    expect(text).toContain('今日 xx 字')
    expect(text).toContain('本机记忆，换章不重置')
    expect(text).toContain('正文字号 14–28px')
    expect(text).not.toContain('自动保存')
    expect(text).not.toContain('码字日历')
  })

  it('再点一次收起', async () => {
    const wrapper = mountBar()
    await el(wrapper, 'editor-status-bar-help-toggle').trigger('click')
    expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(true)
    await el(wrapper, 'editor-status-bar-help-toggle').trigger('click')
    expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(false)
  })

  it('Esc 收起', async () => {
    const wrapper = mountBar()
    await el(wrapper, 'editor-status-bar-help-toggle').trigger('click')
    await el(wrapper, 'editor-status-bar').trigger('keydown.esc')
    expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(false)
  })

  it('悬停自动展开，移出宽限 240ms 后收起', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountBar()
      await wrapper.find('.editor-status-bar__help').trigger('mouseenter')
      expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(true)

      await wrapper.find('.editor-status-bar__help').trigger('mouseleave')
      expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(true)

      vi.advanceTimersByTime(300)
      await nextTick()
      expect(el(wrapper, 'editor-status-bar-help').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('说明按钮的 aria-expanded 跟随展开状态', async () => {
    const wrapper = mountBar()
    expect(el(wrapper, 'editor-status-bar-help-toggle').attributes('aria-expanded')).toBe('false')
    await el(wrapper, 'editor-status-bar-help-toggle').trigger('click')
    expect(el(wrapper, 'editor-status-bar-help-toggle').attributes('aria-expanded')).toBe('true')
  })
})

/* -------------------------------------- 受控重渲染（宿主探针） -------------------------------------- */

const Host = defineComponent({
  props: {
    pageWide: { type: Boolean, required: true },
    fontSize: { type: String, required: true },
  },
  setup(hostProps) {
    return () =>
      h(EditorStatusBar, {
        text: BASE_TEXT,
        pageWide: hostProps.pageWide,
        fontSize: hostProps.fontSize,
      })
  },
})

describe('受控重渲染 —— 父层改 props 后 UI 跟着变', () => {
  it('pageWide 换向：文案与 aria-pressed 同步（组件自身不缓存状态）', async () => {
    const wrapper = mount(Host, { props: { pageWide: true, fontSize: '16px' } })
    const target = () => wrapper.find('[data-testid="editor-status-bar-page-wide"]')
    expect(target().text()).toBe('铺满')

    await wrapper.setProps({ pageWide: false })
    expect(target().text()).toBe('限宽')
    expect(target().attributes('aria-pressed')).toBe('false')

    await wrapper.setProps({ pageWide: true })
    expect(target().text()).toBe('铺满')
  })

  it('fontSize 变化后读数与边界禁用同步', async () => {
    const wrapper = mount(Host, { props: { pageWide: true, fontSize: '16px' } })
    const readout = () => wrapper.find('[data-testid="editor-status-bar-font-size"]')
    const decrease = () => wrapper.find('[data-testid="editor-status-bar-font-decrease"]')
    expect(readout().text()).toBe('16')
    expect((decrease().element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.setProps({ fontSize: '14px' })
    expect(readout().text()).toBe('14')
    expect((decrease().element as HTMLButtonElement).disabled).toBe(true)
  })
})

/* --------------------------------------- 渲染层纪律自检 --------------------------------------- */

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** 去掉注释后再自检：说明性文字里提到这些词不算违规，真正的调用才算。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('渲染层纪律（源码自检）', () => {
  const sources: Record<string, string> = {
    'editor-status-bar.vue': stripComments(
      readSource('../../src/renderer/features/editor-status-bar.vue'),
    ),
    'editor-status-bar-model.ts': stripComments(
      readSource('../../src/renderer/features/editor-status-bar-model.ts'),
    ),
  }

  it('不读写 localStorage、不碰 window.yfe / @yfe/contracts / node:', () => {
    for (const [name, source] of Object.entries(sources)) {
      expect(source, name).not.toMatch(/localStorage/)
      expect(source, name).not.toMatch(/window\.yfe/)
      expect(source, name).not.toMatch(/@yfe\/contracts/)
      expect(source, name).not.toMatch(/from ['"]node:/)
    }
  })

  it('字数走 @yfe/domain 的既有实现，渲染层不重写算法', () => {
    expect(sources['editor-status-bar-model.ts']).toMatch(/from '@yfe\/domain'/)
    expect(sources['editor-status-bar-model.ts']).not.toMatch(/function countWords/)
  })
})