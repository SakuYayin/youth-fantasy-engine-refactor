// @vitest-environment happy-dom
/**
 * 「设置」面板视图测试（真实挂载 + `@vue/test-utils`）—— W8-C。
 *
 * 覆盖的是**接线**：点击是否真的调了 `settings.save(...)` 且参数正确、
 * emit 是否带着端口返回的视图、禁用态是否落在原生 `disabled` 上、拖动滑块是否逐帧保存。
 * 纯逻辑的边界（80/90/…/160、钳制、回落）在 `settings-panel.test.ts` 里，这里不重复。
 *
 * 环境差异处理（VTU 2.5.1）：
 * - `get(...)` 的返回值**没有** `.exists()`：存在性用 `get(...).element` 佐证，
 *   缺失性一律走 `find(...).exists()`；
 * - 原生属性统一 `.element as HTMLButtonElement/HTMLInputElement/HTMLSelectElement`；
 * - checkbox / range / select 用 `.setValue(...)`（它会依次触发 input + change）；
 * - `YfeButton` 把 `data-testid` 透传到内部 `<button>`（Vue 的属性透传），
 *   禁用断言就落在那个 `<button>` 的 `.disabled` 上。
 *
 * `createSettingsStub()` 用一个**可变对象**模拟 `localStorage` 的读写：
 * `save` 合并补丁后返回**新快照**；`failWrites` 为真时返回未变更的视图 ——
 * 这正是 `SettingsPort` 表达"写失败（隐私模式）"的唯一方式，组件必须据此提示「未生效」。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SettingsPanel from '../../src/renderer/features/settings-panel.vue'
import type { AppSettingsView, SettingsPort } from '../../src/renderer/features/types.js'
import type { ThemeOption } from '../../src/renderer/features/settings-panel-model.js'
import {
  CHANGE_PREFIX_FAILED,
  CHANGE_PREFIX_OK,
  DEFAULT_FONT_CHOICE_LABEL,
  DEFAULT_FONT_CHOICE_VALUE,
  FONT_CHOICES,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  RESET_DONE_TEXT,
  SAVE_FAILED_HINT,
  THEME_DISABLED_NOTE,
  THEMES_EMPTY,
  ZOOM_AUTO_HINT,
  ZOOM_AUTO_LABEL,
} from '../../src/renderer/features/settings-panel-model.js'

// ==================== 夹具 ====================

/** 主题选项：形状即 Lead 从 `theme/palettes.ts` 生成的那一份（顺序与展示顺序一致）。 */
const THEMES: readonly ThemeOption[] = Object.freeze([
  { id: 'dark', name: '暗夜', desc: '深色', swatch: '#121218' },
  { id: 'eye-care', name: '护眼', desc: '浅绿·默认·护眼', swatch: '#cfe3c4' },
  { id: 'midnight', name: '午夜蓝', desc: '冷蓝·深色', swatch: '#1a2740' },
  { id: 'sepia', name: '羊皮卷', desc: '暖棕·浅色', swatch: '#e3d4b8' },
  { id: 'dusk-violet', name: '暮山紫', desc: '紫罗兰·深色', swatch: '#100d1a' },
  { id: 'porcelain', name: '青花', desc: '青白瓷·浅色', swatch: '#e4ecf4' },
  { id: 'pine-ink', name: '松烟墨', desc: '墨绿松烟·深色', swatch: '#0a1212' },
  { id: 'peach-note', name: '桃笺', desc: '暖粉胭脂·浅色', swatch: '#faecee' },
  { id: 'custom', name: '自定义', desc: '母版派生 · 可调色', swatch: 'conic-gradient(#e88, #8c8)' },
])

interface SettingsStub {
  readonly port: SettingsPort
  /** 每次 `save` 的入参（按调用顺序）。 */
  readonly saves: Partial<AppSettingsView>[]
  /** 每次 `load` / `reset` 的调用次数。 */
  readonly calls: { load: number; reset: number }
  /** 设为 true 后 `save` 不落盘，返回未变更的视图（模拟隐私模式写失败）。 */
  failWrites: boolean
  /** 当前"存储"里的视图（外部可直接改，用于构造脏存储场景）。 */
  readonly state: AppSettingsView
}

const INITIAL: AppSettingsView = Object.freeze({
  themeId: 'eye-care',
  fontFamily: null,
  fontSize: '16px',
  zoomPercent: 100,
  zoomManual: true,
  sidebarWidth: 224,
  collapsedGroups: Object.freeze([]),
})

/**
 * 可变对象模拟的设置端口。
 *
 * `save` 用 `{ ...state, ...patch }` 合并而不是逐字段分支：设置存储的真实语义
 * 就是"补丁覆盖"，而**补丁里没出现的键必须保持原样**（`buildZoomAutoPatch` 正是
 * 靠这一点做到"只切模式"）。合并不了的字段（缩放钳制、侧栏钳制）在这里简化处理，
 * 因为那部分规则已经由 model 与 `settings-store` 各自测过。
 */
function createSettingsStub(initial: Partial<AppSettingsView> = {}): SettingsStub {
  let state: AppSettingsView = Object.freeze({ ...INITIAL, ...initial })
  const saves: Partial<AppSettingsView>[] = []
  const calls = { load: 0, reset: 0 }
  const stub: SettingsStub = {
    failWrites: false,
    saves,
    calls,
    get state(): AppSettingsView {
      return state
    },
    port: {
      load(): AppSettingsView {
        calls.load += 1
        return state
      },
      save(patch: Partial<AppSettingsView>): AppSettingsView {
        saves.push(patch)
        if (stub.failWrites) return state
        state = Object.freeze({ ...state, ...patch })
        return state
      },
      reset(): AppSettingsView {
        calls.reset += 1
        state = Object.freeze({ ...INITIAL })
        return state
      },
    },
  }
  return stub
}

function mountPanel(stub: SettingsStub, themes: readonly ThemeOption[] = THEMES) {
  return mount(SettingsPanel, { props: { settings: stub.port, themes } })
}

/** 取内部 `@yfe/ui` 按钮（`data-testid` 透传到了原生 `<button>`）。 */
function button(wrapper: ReturnType<typeof mountPanel>, testid: string): HTMLButtonElement {
  return wrapper.get(`[data-testid="${testid}"]`).element as HTMLButtonElement
}

/** emit('change', view) 收到的视图列表。 */
function changes(wrapper: ReturnType<typeof mountPanel>): AppSettingsView[] {
  return wrapper.emitted('change')?.map((args) => args[0] as AppSettingsView) ?? []
}

// ==================== 渲染 ====================

describe('设置面板：渲染', () => {
  it('渲染出全部主题选项（色块 + 名称 + 说明），当前主题带「当前」标记', () => {
    const wrapper = mountPanel(createSettingsStub())
    for (const option of THEMES) {
      const el = wrapper.get(`[data-testid="theme-option-${option.id}"]`)
      expect(el.text()).toContain(option.name)
      const swatch = el.get('.settings-panel__swatch')
      expect((swatch.element as HTMLElement).style.background).not.toBe('')
    }
    // 九项一个不多一个不少（契约要求 9 个色块）
    expect(wrapper.findAll('[data-testid^="theme-option-"]')).toHaveLength(9)
    expect(wrapper.get('[data-testid="theme-current-eye-care"]').text()).toBe('当前')
    expect(wrapper.find('[data-testid="theme-current-dark"]').exists()).toBe(false)
  })

  it('加载初值：显示百分比、侧栏宽度、字体与字号的下拉当前项', () => {
    const wrapper = mountPanel(
      createSettingsStub({ zoomPercent: 130, sidebarWidth: 320, fontSize: '18px' }),
    )
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('130%')
    expect(wrapper.get('[data-testid="sidebar-value"]').text()).toBe('320px')
    expect((wrapper.get('[data-testid="font-size"]').element as HTMLSelectElement).value).toBe('18px')
    // fontFamily 为 null → 下拉停在「跟随默认」
    expect((wrapper.get('[data-testid="font-family"]').element as HTMLSelectElement).value).toBe(
      DEFAULT_FONT_CHOICE_VALUE,
    )
    expect(wrapper.get('[data-testid="font-current"]').text()).toContain(DEFAULT_FONT_CHOICE_LABEL)
    // 滑块带上了 min/max
    const range = wrapper.get('[data-testid="sidebar-width"]').element as HTMLInputElement
    expect(range.getAttribute('min')).toBe(String(MIN_SIDEBAR_WIDTH))
    expect(range.getAttribute('max')).toBe(String(MAX_SIDEBAR_WIDTH))
  })

  it('主题列表为空时显示明确说明，不白屏', () => {
    const wrapper = mountPanel(createSettingsStub(), [])
    expect(wrapper.get('[data-testid="themes-empty"]').text()).toBe(THEMES_EMPTY)
    expect(wrapper.findAll('[data-testid^="theme-option-"]')).toHaveLength(0)
    // 其余三块仍然可用：空主题表不该让整个面板瘫掉
    expect(wrapper.get('[data-testid="zoom-percent"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="settings-reset"]').element).toBeDefined()
  })
})

// ==================== 主题 ====================

describe('设置面板：主题', () => {
  it('点击某主题 → save({themeId}) + emit change（用返回值）', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)

    await wrapper.get('[data-testid="theme-option-dark"]').trigger('click')

    expect(stub.saves).toEqual([{ themeId: 'dark' }])
    expect(changes(wrapper)).toHaveLength(1)
    expect(changes(wrapper)[0]?.themeId).toBe('dark')
    // 本地视图也跟着返回值刷新
    expect(wrapper.get('[data-testid="theme-current-dark"]').text()).toBe('当前')
    expect(wrapper.find('[data-testid="theme-current-eye-care"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="settings-notice"]').text()).toContain('暗夜')
    expect(wrapper.get('[data-testid="settings-notice"]').text()).toContain(CHANGE_PREFIX_OK)
  })

  it('点击已是当前的主题不重复保存（避免无谓写入）', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    await wrapper.get('[data-testid="theme-option-eye-care"]').trigger('click')
    expect(stub.saves).toHaveLength(0)
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('custom 选项 disabled 且标注「暂未实现」，点击不保存', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)

    expect(button(wrapper, 'theme-option-custom').disabled).toBe(true)
    expect(wrapper.get('[data-testid="theme-disabled-custom"]').text()).toBe(THEME_DISABLED_NOTE)
    // 其余八项都不禁用
    for (const option of THEMES.filter((item) => item.id !== 'custom')) {
      expect(button(wrapper, `theme-option-${option.id}`).disabled).toBe(false)
    }

    // 原生 disabled 之后仍强推一次 click：组件内部还有第二道闸（不能只靠 DOM）
    await wrapper.get('[data-testid="theme-option-custom"]').trigger('click')
    expect(stub.saves).toHaveLength(0)
    expect(wrapper.emitted('change')).toBeUndefined()
  })
})

// ==================== 缩放 ====================

describe('设置面板：界面缩放', () => {
  it('自动模式下加减按钮都禁用，并显示原因', () => {
    const wrapper = mountPanel(createSettingsStub({ zoomManual: false, zoomPercent: 100 }))
    expect(button(wrapper, 'zoom-decrease').disabled).toBe(true)
    expect(button(wrapper, 'zoom-increase').disabled).toBe(true)
    expect(wrapper.get('[data-testid="zoom-auto-hint"]').text()).toBe(ZOOM_AUTO_HINT)
    expect((wrapper.get('[data-testid="zoom-auto"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('手动缩放下点击「+」→ save 收到 zoomPercent 且 zoomManual:true', async () => {
    const stub = createSettingsStub({ zoomPercent: 100, zoomManual: true })
    const wrapper = mountPanel(stub)

    expect(button(wrapper, 'zoom-increase').disabled).toBe(false)
    expect(wrapper.find('[data-testid="zoom-auto-hint"]').exists()).toBe(false)
    await wrapper.get('[data-testid="zoom-increase"]').trigger('click')

    expect(stub.saves).toEqual([{ zoomPercent: 110, zoomManual: true }])
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('110%')
    expect(changes(wrapper)[0]?.zoomPercent).toBe(110)
    expect(changes(wrapper)[0]?.zoomManual).toBe(true)
  })

  it('点击「−」回退 10，并在 80% 时禁用「−」', async () => {
    const stub = createSettingsStub({ zoomPercent: 90, zoomManual: true })
    const wrapper = mountPanel(stub)
    await wrapper.get('[data-testid="zoom-decrease"]').trigger('click')
    expect(stub.saves).toEqual([{ zoomPercent: 80, zoomManual: true }])
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('80%')
    expect(button(wrapper, 'zoom-decrease').disabled).toBe(true)
    expect(button(wrapper, 'zoom-increase').disabled).toBe(false)
  })

  it('160% 时「+」禁用，点击不再保存', async () => {
    const stub = createSettingsStub({ zoomPercent: 160, zoomManual: true })
    const wrapper = mountPanel(stub)
    expect(button(wrapper, 'zoom-increase').disabled).toBe(true)
    await wrapper.get('[data-testid="zoom-increase"]').trigger('click')
    expect(stub.saves).toHaveLength(0)
    expect(wrapper.emitted('change')).toBeUndefined()
  })

  it('取消「自动」→ save 收到当前百分比 + zoomManual:true（钉住自动值）', async () => {
    const stub = createSettingsStub({ zoomManual: false, zoomPercent: 132 })
    const wrapper = mountPanel(stub)
    const auto = wrapper.get('[data-testid="zoom-auto"]')

    await auto.setValue(false)

    expect(stub.saves).toEqual([{ zoomPercent: 132, zoomManual: true }])
    expect(changes(wrapper)[0]?.zoomManual).toBe(true)
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('132%')
    // 切换后按钮解禁，提示消失
    expect(button(wrapper, 'zoom-increase').disabled).toBe(false)
    expect(wrapper.find('[data-testid="zoom-auto-hint"]').exists()).toBe(false)
  })

  it('勾选「自动」→ save 只收到 { zoomManual:false }，显示改用返回值重算的百分比', async () => {
    // 端口模拟"跟随窗口"：切回自动时把值重算成 140（真实实现由窗口宽度决定）
    let state: AppSettingsView = Object.freeze({
      ...INITIAL,
      zoomPercent: 90,
      zoomManual: true,
    })
    const saves: Partial<AppSettingsView>[] = []
    let loadCount = 0
    const port: SettingsPort = {
      load: () => {
        loadCount += 1
        return state
      },
      save: (patch) => {
        saves.push(patch)
        state = Object.freeze({ ...state, zoomManual: false, zoomPercent: 140 })
        return state
      },
      reset: () => state,
    }
    const wrapper = mount(SettingsPanel, { props: { settings: port, themes: THEMES } })
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('90%')

    await wrapper.get('[data-testid="zoom-auto"]').setValue(true)

    expect(saves).toEqual([{ zoomManual: false }])
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('140%')
    expect((wrapper.get('[data-testid="zoom-auto"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('[data-testid="zoom-auto-hint"]').text()).toBe(ZOOM_AUTO_HINT)
    expect(loadCount).toBe(1) // 只在 setup 里 load 一次
  })
})

// ==================== 字体 ====================

describe('设置面板：字体', () => {
  it('字体下拉包含「跟随默认」与全部预设字体', () => {
    const wrapper = mountPanel(createSettingsStub())
    const options = wrapper.get('[data-testid="font-family"]').findAll('option')
    expect(options).toHaveLength(FONT_CHOICES.length)
    expect(options[0]?.text()).toBe(DEFAULT_FONT_CHOICE_LABEL)
    expect(options.map((option) => option.text())).toContain('楷体')
  })

  it('选择预设字体 → save({ fontFamily: 栈段 })；选回「跟随默认」→ null', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    const select = wrapper.get('[data-testid="font-family"]')

    await select.setValue('"楷体", "KaiTi", STKaiti')
    expect(stub.saves).toEqual([{ fontFamily: '"楷体", "KaiTi", STKaiti' }])
    expect(wrapper.get('[data-testid="font-current"]').text()).toContain('楷体')

    await select.setValue(DEFAULT_FONT_CHOICE_VALUE)
    expect(stub.saves[1]).toEqual({ fontFamily: null })
    expect(wrapper.get('[data-testid="font-current"]').text()).toContain(DEFAULT_FONT_CHOICE_LABEL)
    expect(changes(wrapper)).toHaveLength(2)
  })

  it('切换字号 → save({ fontSize }) 并 emit', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    await wrapper.get('[data-testid="font-size"]').setValue('20px')
    expect(stub.saves).toEqual([{ fontSize: '20px' }])
    expect(changes(wrapper)[0]?.fontSize).toBe('20px')
    expect((wrapper.get('[data-testid="font-size"]').element as HTMLSelectElement).value).toBe('20px')
  })
})

// ==================== 侧栏宽度 ====================

describe('设置面板：侧栏宽度', () => {
  it('拖动滑块 → save({ sidebarWidth })，本地显示同步为 Npx', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    const range = wrapper.get('[data-testid="sidebar-width"]')

    await range.setValue('320')

    expect(stub.saves).toEqual([{ sidebarWidth: 320 }])
    expect(wrapper.get('[data-testid="sidebar-value"]').text()).toBe('320px')
    expect(changes(wrapper).at(-1)?.sidebarWidth).toBe(320)
  })

  it('连续拖动每一帧都保存（input 事件），显示跟手', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    const range = wrapper.get('[data-testid="sidebar-width"]')
    await range.setValue('240')
    await range.setValue('260')
    await range.setValue('280')
    expect(stub.saves).toEqual([{ sidebarWidth: 240 }, { sidebarWidth: 260 }, { sidebarWidth: 280 }])
    expect(wrapper.get('[data-testid="sidebar-value"]').text()).toBe('280px')
  })

  it('超出范围的值被钳制后再写入', async () => {
    const stub = createSettingsStub()
    const wrapper = mountPanel(stub)
    await wrapper.get('[data-testid="sidebar-width"]').setValue(String(MAX_SIDEBAR_WIDTH + 100))
    expect(stub.saves).toEqual([{ sidebarWidth: MAX_SIDEBAR_WIDTH }])
    expect(wrapper.get('[data-testid="sidebar-value"]').text()).toBe(`${MAX_SIDEBAR_WIDTH}px`)
  })
})

// ==================== 恢复默认 / 关闭 ====================

describe('设置面板：底部操作', () => {
  it('点「恢复默认」→ 调 reset() 并把返回值 emit 出去', async () => {
    const stub = createSettingsStub({ themeId: 'dark', zoomPercent: 150, sidebarWidth: 400 })
    const wrapper = mountPanel(stub)

    await wrapper.get('[data-testid="settings-reset"]').trigger('click')

    expect(stub.calls.reset).toBe(1)
    expect(wrapper.get('[data-testid="settings-notice"]').text()).toBe(RESET_DONE_TEXT)
    // 默认值 = 夹具的 INITIAL（护眼 / 100% / 224px）
    expect(changes(wrapper).at(-1)?.themeId).toBe('eye-care')
    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('100%')
    expect(wrapper.get('[data-testid="sidebar-value"]').text()).toBe('224px')
    expect(wrapper.get('[data-testid="theme-current-eye-care"]').text()).toBe('当前')
  })

  it('点「关闭」→ emit close', async () => {
    const wrapper = mountPanel(createSettingsStub())
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('[data-testid="settings-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

// ==================== 写失败（隐私模式） ====================

describe('设置面板：保存失败不静默', () => {
  it('save 返回未变更的视图 → 显示「未生效」与原因，界面保持真实状态', async () => {
    const stub = createSettingsStub()
    stub.failWrites = true
    const wrapper = mountPanel(stub)

    await wrapper.get('[data-testid="theme-option-dark"]').trigger('click')

    const notice = wrapper.get('[data-testid="settings-notice"]').text()
    expect(notice).toContain(CHANGE_PREFIX_FAILED)
    expect(notice).toContain(SAVE_FAILED_HINT)
    // 主题没真的切过去：不能显示成已生效（"当前"标记仍在护眼上）
    expect(wrapper.get('[data-testid="theme-current-eye-care"]').text()).toBe('当前')
    expect(wrapper.find('[data-testid="theme-current-dark"]').exists()).toBe(false)
    // 仍然 emit：失败时返回的是真实当前状态，正是外壳该对齐的值
    expect(changes(wrapper)).toHaveLength(1)
    expect(changes(wrapper)[0]?.themeId).toBe('eye-care')
  })

  it('缩放写失败 → 百分比回退到真实值，并给出失败回执', async () => {
    const stub = createSettingsStub({ zoomPercent: 100, zoomManual: true })
    stub.failWrites = true
    const wrapper = mountPanel(stub)

    await wrapper.get('[data-testid="zoom-increase"]').trigger('click')

    expect(wrapper.get('[data-testid="zoom-percent"]').text()).toBe('100%')
    expect(wrapper.get('[data-testid="settings-notice"]').text()).toContain(CHANGE_PREFIX_FAILED)
  })

  it('未改动前不显示回执行（不占版面、不假装有结果）', () => {
    const wrapper = mountPanel(createSettingsStub())
    expect(wrapper.find('[data-testid="settings-notice"]').exists()).toBe(false)
  })
})

// ==================== 文案与结构 ====================

describe('设置面板：结构与文案', () => {
  it('四个分区标题 + 「自动（跟随窗口）」标签齐备', () => {
    const text = mountPanel(createSettingsStub()).text()
    for (const heading of ['主题', '界面缩放', '字体', '侧栏宽度']) {
      expect(text).toContain(heading)
    }
    expect(text).toContain(ZOOM_AUTO_LABEL)
    expect(text).toContain('恢复默认')
    expect(text).toContain('关闭')
  })
})
