/**
 * A-10 侧栏宽度拖拽手柄 —— **纯逻辑**测试（node 环境，不需要 DOM）。
 *
 * 上游对照点（`U\src\lib\app\useResizable.ts`）：
 * - 位移换算 `useResizable.ts:53-56`：`dx = (clientX - startX) / zoom`、`delta = side==='right'?dx:-dx`、
 *   `Math.min(max, Math.max(min, startSize + delta))`；
 * - `side:'right'` 来自 `Sidebar.tsx:96`（`key:'yfe-sidebar-w', initial:224, initialWide:300, min:200, max:560`）；
 * - 大屏阈值 `WIDE_THRESHOLD = 2000`（`useResizable.ts:16`）。
 *
 * 上游**没有**的能力（本实现新增，契约要求）：键盘步进、双击复位、`disabled` 冻结、
 * 以及对 `NaN`/`±Infinity` 的显式兜底（上游把浮点直接 `setSize`，从不取整）。
 * 新增项的取值都在 `sidebar-resizer-model.ts` 里写明，这里只钉行为。
 */
import { describe, expect, it } from 'vitest'

import {
  ariaValueNow,
  clampWidth,
  dragWidth,
  isResizeEnabled,
  keyboardWidth,
  resetWidth,
  resolveLimits,
  RESIZER_KEYBOARD_STEP,
  RESIZER_TITLE,
  RESIZER_WIDE_SCREEN_THRESHOLD,
  SIDEBAR_RESIZER_DEFAULTS,
} from '../../src/renderer/schema/sidebar-resizer-model.js'
import { SIDEBAR_WIDTH, WIDE_SCREEN_THRESHOLD } from '../../src/renderer/features/settings-store.js'

/** 默认区间（等价于上游 `min:200, max:560`）。 */
const LIMITS = resolveLimits()

// ==================== 常量防漂移 ====================

describe('常量与上游 / settings-store 同值', () => {
  it('三档宽度与 settings-store 的 SIDEBAR_WIDTH 逐值相等（两处规则不许漂移）', () => {
    expect(SIDEBAR_RESIZER_DEFAULTS.initial).toBe(SIDEBAR_WIDTH.initial)
    expect(SIDEBAR_RESIZER_DEFAULTS.wide).toBe(SIDEBAR_WIDTH.wide)
    expect(SIDEBAR_RESIZER_DEFAULTS.min).toBe(SIDEBAR_WIDTH.min)
    expect(SIDEBAR_RESIZER_DEFAULTS.max).toBe(SIDEBAR_WIDTH.max)
    expect(SIDEBAR_RESIZER_DEFAULTS).toEqual({ initial: 224, wide: 300, min: 200, max: 560 })
  })

  it('大屏阈值与上游 2000 一致，标题逐字照抄上游 title', () => {
    expect(RESIZER_WIDE_SCREEN_THRESHOLD).toBe(WIDE_SCREEN_THRESHOLD)
    expect(RESIZER_WIDE_SCREEN_THRESHOLD).toBe(2000)
    expect(RESIZER_TITLE).toBe('拖拽调整侧栏宽度')
    expect(RESIZER_KEYBOARD_STEP).toBe(10)
  })
})

// ==================== resolveLimits ====================

describe('resolveLimits', () => {
  it('缺省时用上游的 200/560', () => {
    expect(resolveLimits()).toEqual({ min: 200, max: 560 })
  })

  it('min > max 写反时交换成合法区间（不抛、不产出 NaN 宽度）', () => {
    expect(resolveLimits(560, 200)).toEqual({ min: 200, max: 560 })
  })

  it('非有限数的 min/max 回落到上游缺省值', () => {
    expect(resolveLimits(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ min: 200, max: 560 })
    expect(resolveLimits(undefined, 400)).toEqual({ min: 200, max: 400 })
  })
})

// ==================== clampWidth ====================

describe('clampWidth', () => {
  it('低于 min 夹到 min，高于 max 夹到 max', () => {
    expect(clampWidth(120, LIMITS, 224)).toBe(200)
    expect(clampWidth(9999, LIMITS, 224)).toBe(560)
  })

  it('NaN 回落到 fallback；fallback 也不可用时回落 224', () => {
    expect(clampWidth(Number.NaN, LIMITS, 337)).toBe(337)
    expect(clampWidth(Number.NaN, LIMITS, Number.NaN)).toBe(224)
    expect(clampWidth(Number.NaN, LIMITS, Number.POSITIVE_INFINITY)).toBe(224)
  })

  it('±Infinity 自然落到 max / min，不抛', () => {
    expect(clampWidth(Number.POSITIVE_INFINITY, LIMITS, 224)).toBe(560)
    expect(clampWidth(Number.NEGATIVE_INFINITY, LIMITS, 224)).toBe(200)
  })

  it('浮点像素四舍五入（与 settings-store.clampSidebarWidth 同口径）', () => {
    expect(clampWidth(224.4, LIMITS, 224)).toBe(224)
    expect(clampWidth(224.6, LIMITS, 224)).toBe(225)
    expect(clampWidth(223.99999, LIMITS, 224)).toBe(224)
  })
})

// ==================== dragWidth ====================

describe('dragWidth：指针位移 → 宽度', () => {
  it('向右拖（位移 +50）增大到 274', () => {
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350 })).toBe(274)
  })

  it('向左拖（位移 -40）减小：300 → 260', () => {
    expect(dragWidth({ startWidth: 300, startX: 300, clientX: 260 })).toBe(260)
  })

  it('低于 min 夹到 200，高于 max 夹到 560', () => {
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 60 })).toBe(200)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 900 })).toBe(560)
  })

  it("side='left' 时方向反转（向左拖反而增大）", () => {
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 260, side: 'left' })).toBe(264)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350, side: 'left' })).toBe(200)
  })

  it('界面缩放下把视觉位移换算回布局像素（上游 useResizable.ts:53-54）', () => {
    // zoom=2：视觉上走 100px = 布局 50px
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 400, zoom: 2 })).toBe(274)
    // 脏 zoom（0 / NaN / 负数）一律当 1
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350, zoom: 0 })).toBe(274)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350, zoom: Number.NaN })).toBe(274)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350, zoom: -3 })).toBe(274)
  })

  it('非有限的 clientX 不抛：NaN 回落到当前宽度，±Infinity 落到 max/min', () => {
    expect(() => dragWidth({ startWidth: 224, startX: 300, clientX: Number.NaN })).not.toThrow()
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: Number.NaN })).toBe(224)
    expect(dragWidth({ startWidth: 400, startX: 300, clientX: Number.NaN })).toBe(400)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: Number.POSITIVE_INFINITY })).toBe(560)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: Number.NEGATIVE_INFINITY })).toBe(200)
  })

  it('非有限的 startWidth / startX 也不抛：回落到 224 或区间端点', () => {
    expect(dragWidth({ startWidth: Number.NaN, startX: 300, clientX: 350 })).toBe(224)
    // startX 为 NaN 时位移算不出来，回落到「当前宽度」而不是 min/max
    expect(dragWidth({ startWidth: 224, startX: Number.NaN, clientX: 350 })).toBe(224)
    expect(dragWidth({ startWidth: 500, startX: Number.NaN, clientX: 350 })).toBe(500)
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 350, min: Number.NaN, max: Number.NaN })).toBe(274)
  })

  it('取整：位移 0.4px 不动，0.6px 进一位', () => {
    expect(dragWidth({ startWidth: 224, startX: 0, clientX: 0.4 })).toBe(224)
    expect(dragWidth({ startWidth: 224, startX: 0, clientX: 0.6 })).toBe(225)
    expect(dragWidth({ startWidth: 224.4, startX: 0, clientX: 0 })).toBe(224)
  })

  it('disabled 时不产生新宽度（返回 null，父层据此跳过落库）', () => {
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 400, disabled: true })).toBeNull()
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 400, disabled: undefined })).toBe(324)
  })

  it('min/max 写反时用交换后的区间夹取', () => {
    expect(dragWidth({ startWidth: 224, startX: 300, clientX: 900, min: 560, max: 200 })).toBe(560)
  })
})

// ==================== keyboardWidth ====================

describe('keyboardWidth：键盘步进（上游无此能力）', () => {
  it('ArrowRight 加 10px、ArrowLeft 减 10px', () => {
    expect(keyboardWidth(224, 'ArrowRight')).toBe(234)
    expect(keyboardWidth(224, 'ArrowLeft')).toBe(214)
  })

  it('两端都夹得住，不会越界', () => {
    expect(keyboardWidth(560, 'ArrowRight')).toBe(560)
    expect(keyboardWidth(200, 'ArrowLeft')).toBe(200)
    expect(keyboardWidth(205, 'ArrowLeft')).toBe(200)
  })

  it('Home = min、End = max', () => {
    expect(keyboardWidth(400, 'Home')).toBe(200)
    expect(keyboardWidth(400, 'End')).toBe(560)
  })

  it('其它键返回 null（不拦截，让事件继续冒泡）', () => {
    expect(keyboardWidth(224, 'ArrowUp')).toBeNull()
    expect(keyboardWidth(224, 'Enter')).toBeNull()
    expect(keyboardWidth(224, 'Tab')).toBeNull()
  })

  it('step 可覆盖；脏 step（0/NaN/负）回落 10', () => {
    expect(keyboardWidth(224, 'ArrowRight', { step: 5 })).toBe(229)
    expect(keyboardWidth(224, 'ArrowRight', { step: 0 })).toBe(234)
    expect(keyboardWidth(224, 'ArrowRight', { step: Number.NaN })).toBe(234)
    expect(keyboardWidth(224, 'ArrowRight', { step: -5 })).toBe(234)
  })

  it('disabled / 脏 current 都不抛', () => {
    expect(keyboardWidth(224, 'ArrowRight', { disabled: true })).toBeNull()
    expect(() => keyboardWidth(Number.NaN, 'ArrowRight')).not.toThrow()
    expect(keyboardWidth(Number.NaN, 'ArrowRight')).toBe(234)
    expect(keyboardWidth(224, 'ArrowRight', { min: 400, max: 200 })).toBe(234)
  })
})

// ==================== resetWidth / ariaValueNow / isResizeEnabled ====================

describe('resetWidth：双击复位值', () => {
  it('缺省 224；显式 initial 优先', () => {
    expect(resetWidth()).toBe(224)
    expect(resetWidth(undefined, { min: 200, max: 560 })).toBe(224)
    expect(resetWidth(300)).toBe(300)
  })

  it('越界 / 非有限的 initial 都收敛回合法区间', () => {
    expect(resetWidth(100)).toBe(200)
    expect(resetWidth(9999)).toBe(560)
    expect(resetWidth(Number.NaN)).toBe(224)
    // initial 是**配置值**不是指针位移：非有限在这里的含义是「没配」，回落到 224，
    // 而不是像 clampWidth 那样把 +Infinity 当极大值夹到 max。
    expect(resetWidth(Number.POSITIVE_INFINITY)).toBe(224)
    expect(resetWidth(Number.NEGATIVE_INFINITY)).toBe(224)
  })
})

describe('ariaValueNow / isResizeEnabled', () => {
  it('反映 width，并把超界值收进 [min,max]', () => {
    expect(ariaValueNow(320, { min: 200, max: 560 })).toBe(320)
    expect(ariaValueNow(10000, { min: 200, max: 560 })).toBe(560)
    expect(ariaValueNow(Number.NaN, { min: 200, max: 560 })).toBe(224)
  })

  it('仅 disabled === true 时冻结', () => {
    expect(isResizeEnabled(undefined)).toBe(true)
    expect(isResizeEnabled(false)).toBe(true)
    expect(isResizeEnabled(true)).toBe(false)
  })
})