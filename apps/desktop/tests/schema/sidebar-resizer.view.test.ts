// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * A-10 侧栏宽度拖拽手柄 —— **挂载测试**（真实 DOM + `@vue/test-utils`）。
 *
 * 这里测的是**接线**：DOM 契约（`role="separator"` / `aria-*` / `data-testid`）、
 * 事件载荷、以及「什么时候**不该**再 emit」（`disabled`、`pointerup` 之后、组件卸载之后）。
 * 纯算式的边界（NaN / ±Infinity / 浮点 / zoom / 键盘步进）在 `sidebar-resizer-model.test.ts` 里，这里不重复。
 *
 * 环境处理（happy-dom + VTU 2.5.1）：
 * - 指针事件按任务要求显式 `new PointerEvent(...)` 再 `dispatchEvent`（VTU 的 `trigger` 不保证构造出
 *   `PointerEvent`）。`pointerdown` 打在手柄元素上，`pointermove/up/cancel` 打在 `window` 上 ——
 *   组件把这三个监听挂在 window（上游 `useResizable.ts:59-60` 同款）。
 * - happy-dom 有 `setPointerCapture`，但组件仍用 `typeof === 'function'` + `try/catch` 守卫
 *   （可测性妥协，见组件注释）；抓取与否不影响本文件任何断言。
 * - 每个用例结束由 `afterEach` 卸载，确保窗口监听不跨用例泄漏 —— 最后一个用例正是靠这个抓「卸载不清监听」。
 */
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import SidebarResizer from '../../src/renderer/schema/SidebarResizer.vue'
import { RESIZER_ARIA_LABEL, RESIZER_TITLE } from '../../src/renderer/schema/sidebar-resizer-model.js'

/** 手柄选择器（契约里钉死的 testid）。 */
const HANDLE = '[data-testid="sidebar-resizer"]'

/** 已挂载的组件：`afterEach` 统一卸载，避免 window 监听跨用例残留。 */
const tracked: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const wrapper of tracked.splice(0)) {
    try {
      wrapper.unmount()
    } catch {
      /* 用例内已卸载：忽略 */
    }
  }
})

function mountResizer(
  overrides: Partial<{
    width: number
    min: number
    max: number
    initial: number
    disabled: boolean
  }> = {},
) {
  const wrapper = mount(SidebarResizer, {
    props: {
      width: overrides.width ?? 224,
      min: overrides.min ?? 200,
      max: overrides.max ?? 560,
      initial: overrides.initial ?? 224,
      disabled: overrides.disabled ?? false,
    },
  })
  tracked.push(wrapper)
  return wrapper
}

function pointer(
  type: string,
  init: { clientX?: number; pointerId?: number } = {},
): PointerEvent {
  return new PointerEvent(type, {
    clientX: init.clientX ?? 0,
    clientY: 0,
    pointerId: init.pointerId ?? 1,
    button: 0,
    bubbles: true,
    cancelable: true,
  })
}

/** 一次完整的「按下 → 移动」。 */
function drag(wrapper: ReturnType<typeof mountResizer>, fromX: number, toX: number): void {
  wrapper.get(HANDLE).element.dispatchEvent(pointer('pointerdown', { clientX: fromX }))
  window.dispatchEvent(pointer('pointermove', { clientX: toX }))
}

/**
 * 受控重渲染用的**宿主**：只把父层 props 原样转给 `SidebarResizer`，自己不记状态。
 *
 * 为什么需要它：本仓库 `vue-shims.d.ts` 把 `*.vue` 声明成 `DefineComponent<{}, {}, unknown>`，
 * 于是 `mount(SidebarResizer).setProps({ width })` 在普通 `tsc` 下必然 TS2353（具名 prop 被丢掉）。
 * 宿主的 props 是 `defineComponent` 里**真声明**的，`setProps` 就能收窄到 `width` ——
 * 而且这正是 Lead 在 `App.vue` 里的接法：父层持 `sidebarWidth`，手柄只收 props。
 * （同一套写法见 `tests/schema/tab-sidebar-collapse.test.ts:83-107`。）
 */
const ResizerHost = defineComponent({
  name: 'SidebarResizerHostProbe',
  props: {
    width: { type: Number, required: true },
    min: { type: Number, default: 200 },
    max: { type: Number, default: 560 },
    initial: { type: Number, default: 224 },
    disabled: { type: Boolean, default: false },
  },
  setup(hostProps) {
    return () =>
      h(SidebarResizer, {
        width: hostProps.width,
        min: hostProps.min,
        max: hostProps.max,
        initial: hostProps.initial,
        disabled: hostProps.disabled,
      })
  },
})

/** 取 `emitted('resize')` 的载荷序列。 */
function resizePayloads(wrapper: ReturnType<typeof mountResizer>): unknown[] {
  return (wrapper.emitted('resize') ?? []).map((args) => args[0])
}

// ==================== DOM 契约 ====================

describe('DOM 契约', () => {
  it('渲染一个 role="separator" 的竖向分隔条，带 testid、可聚焦、中文标题', () => {
    const wrapper = mountResizer()
    const handle = wrapper.get(HANDLE)
    expect(wrapper.findAll('[role="separator"]')).toHaveLength(1)
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-orientation')).toBe('vertical')
    expect(handle.attributes('title')).toBe(RESIZER_TITLE)
    expect(handle.attributes('aria-label')).toBe(RESIZER_ARIA_LABEL)
    // 键盘要能用，就必须可聚焦
    expect(handle.attributes('tabindex')).toBe('0')
    expect(handle.attributes('aria-disabled')).toBeUndefined()
  })

  it('aria-valuenow 反映 width，valuemin/valuemax 反映 props', () => {
    const wrapper = mountResizer({ width: 320, min: 210, max: 520 })
    const handle = wrapper.get(HANDLE)
    expect(handle.attributes('aria-valuenow')).toBe('320')
    expect(handle.attributes('aria-valuemin')).toBe('210')
    expect(handle.attributes('aria-valuemax')).toBe('520')
  })

  it('父层改 width 后 aria-valuenow 跟着变，且超界值在无障碍树里被收敛', async () => {
    const wrapper = mount(ResizerHost, { props: { width: 224 } })
    tracked.push(wrapper)
    expect(wrapper.get(HANDLE).attributes('aria-valuenow')).toBe('224')
    await wrapper.setProps({ width: 10000 })
    expect(wrapper.get(HANDLE).attributes('aria-valuenow')).toBe('560')
  })
})

// ==================== 指针拖拽 ====================

describe('指针拖拽', () => {
  it('pointerdown + pointermove 触发一次 resize，载荷是换算后的整数宽度', () => {
    const wrapper = mountResizer({ width: 224 })
    drag(wrapper, 300, 350)
    expect(resizePayloads(wrapper)).toEqual([274])
  })

  it('拖到极右时载荷被夹在 [min,max] 内（= max）', () => {
    const wrapper = mountResizer({ width: 224, min: 200, max: 560 })
    drag(wrapper, 300, 5000)
    const payloads = resizePayloads(wrapper)
    expect(payloads).toEqual([560])
    expect(payloads[0]).toBeGreaterThanOrEqual(200)
    expect(payloads[0]).toBeLessThanOrEqual(560)
  })

  it('没有 pointerdown 时 pointermove 不 emit（未拖拽不产生变更）', () => {
    const wrapper = mountResizer()
    window.dispatchEvent(pointer('pointermove', { clientX: 400 }))
    expect(wrapper.emitted('resize')).toBeUndefined()
  })

  it('pointerup 之后继续 pointermove 不再 emit', () => {
    const wrapper = mountResizer({ width: 224 })
    drag(wrapper, 300, 350)
    window.dispatchEvent(pointer('pointerup', { clientX: 350 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 420 }))
    expect(resizePayloads(wrapper)).toEqual([274])
  })

  it('pointercancel 同样收尾：后续 pointermove 不再 emit', () => {
    const wrapper = mountResizer({ width: 224 })
    drag(wrapper, 300, 330)
    window.dispatchEvent(pointer('pointercancel', { clientX: 330 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 420 }))
    expect(resizePayloads(wrapper)).toEqual([254])
  })

  it('卸载后 pointermove 既不抛也不再 emit（window 监听已摘掉）', () => {
    const wrapper = mountResizer({ width: 224 })
    drag(wrapper, 300, 330)
    const emitted = wrapper.emitted('resize')
    expect(emitted).toHaveLength(1)
    wrapper.unmount()
    expect(() => {
      window.dispatchEvent(pointer('pointermove', { clientX: 420 }))
      window.dispatchEvent(pointer('pointerup', { clientX: 420 }))
    }).not.toThrow()
    expect(emitted).toHaveLength(1)
  })
})

// ==================== 双击复位 ====================

describe('双击复位', () => {
  it('dblclick emit reset，载荷 = initial', async () => {
    const wrapper = mountResizer({ width: 500, initial: 300 })
    await wrapper.get(HANDLE).trigger('dblclick')
    expect(wrapper.emitted('reset')).toHaveLength(1)
    expect(wrapper.emitted('reset')?.[0]?.[0]).toBe(300)
    // 复位不是 resize：拖拽链路不许被双击带出额外的 resize
    expect(wrapper.emitted('resize')).toBeUndefined()
  })

  it('未传 initial 时复位载荷回落到 224（上游 useResizable 的 initial）', async () => {
    const wrapper = mount(SidebarResizer, { props: { width: 480 } })
    tracked.push(wrapper)
    await wrapper.get(HANDLE).trigger('dblclick')
    expect(wrapper.emitted('reset')?.[0]?.[0]).toBe(224)
  })
})

// ==================== disabled ====================

describe('disabled 冻结', () => {
  it('disabled 时 pointerdown 不 emit，且不挂窗口监听', () => {
    const wrapper = mountResizer({ disabled: true })
    const handle = wrapper.get(HANDLE)
    handle.element.dispatchEvent(pointer('pointerdown', { clientX: 300 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 500 }))
    expect(wrapper.emitted('resize')).toBeUndefined()
    expect(handle.attributes('tabindex')).toBe('-1')
    expect(handle.attributes('aria-disabled')).toBe('true')
  })

  it('disabled 时 dblclick 不发 reset', async () => {
    const wrapper = mountResizer({ disabled: true })
    await wrapper.get(HANDLE).trigger('dblclick')
    expect(wrapper.emitted('reset')).toBeUndefined()
  })
})

// ==================== 键盘 ====================

describe('键盘微调', () => {
  it('ArrowRight 按 10px 步进 emit resize', async () => {
    const wrapper = mountResizer({ width: 224 })
    await wrapper.get(HANDLE).trigger('keydown', { key: 'ArrowRight' })
    expect(resizePayloads(wrapper)).toEqual([234])
  })

  it('Home = min、End = max；无关键不 emit', async () => {
    const wrapper = mountResizer({ width: 400, min: 200, max: 560 })
    const handle = wrapper.get(HANDLE)
    await handle.trigger('keydown', { key: 'Home' })
    await handle.trigger('keydown', { key: 'End' })
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(resizePayloads(wrapper)).toEqual([200, 560])
  })

  it('disabled 时键盘不 emit', async () => {
    const wrapper = mountResizer({ width: 224, disabled: true })
    await wrapper.get(HANDLE).trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('resize')).toBeUndefined()
  })
})