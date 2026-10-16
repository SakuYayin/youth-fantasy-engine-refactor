/**
 * 「设置」面板纯逻辑测试（`features/settings-panel-model.ts`）—— W8-C。
 *
 * 这一层不挂载 DOM、不碰 `localStorage`：所有边界值都靠 `clampZoom` /
 * `clampSidebarWidth` 的既有口径驱动，所以断言写的是**具体数字**，
 * 而不是"调用了某个函数"。缩放的 80/90/…/160 九档逐值过一遍 ——
 * 步进逻辑最容易出的错是 160 变 170、80 变 70，只有逐档断言能抓住。
 */
import { describe, expect, it } from 'vitest'

import type { AppSettingsView } from '../../src/renderer/features/types.js'
import type { ThemeOption } from '../../src/renderer/features/settings-panel-model.js'
import {
  CHANGE_NO_PATCH,
  CURRENT_THEME_NOTE,
  CUSTOM_THEME_ID,
  DEFAULT_FONT_CHOICE_LABEL,
  DEFAULT_FONT_CHOICE_VALUE,
  FONT_CHOICES,
  FONT_SIZE_CHOICES,
  MAX_SIDEBAR_WIDTH,
  MAX_ZOOM,
  MIN_SIDEBAR_WIDTH,
  MIN_ZOOM,
  THEME_DISABLED_NOTE,
  ZOOM_AUTO_LABEL,
  ZOOM_STEP,
  buildFontPatch,
  buildFontSizePatch,
  buildSidebarPatch,
  buildZoomAutoPatch,
  buildZoomPercentPatch,
  buildZoomStepPatch,
  canStepZoom,
  changeSummary,
  clampSidebarValue,
  findThemeOption,
  fontChoiceLabel,
  fontChoiceValue,
  fontSizeChoice,
  isPatchApplied,
  isThemeOptionCurrent,
  isThemeOptionDisabled,
  sidebarDisplayText,
  stepZoomPercent,
  themeOptionTitle,
  zoomDisplayText,
} from '../../src/renderer/features/settings-panel-model.js'

// ==================== 夹具 ====================

/** 主题选项夹具：形状即 Lead 从 `theme/palettes.ts` 生成的那一份（含禁用项 custom）。 */
const THEMES: readonly ThemeOption[] = Object.freeze([
  { id: 'dark', name: '暗夜', desc: '深色', swatch: '#121218' },
  { id: 'eye-care', name: '护眼', desc: '浅绿·默认·护眼', swatch: '#cfe3c4' },
  { id: 'peach-note', name: '桃笺', desc: '暖粉胭脂·浅色', swatch: '#faecee' },
  { id: CUSTOM_THEME_ID, name: '自定义', desc: '母版派生 · 可调色', swatch: 'conic-gradient(#e88, #8c8)' },
])

/** 一个完整的设置视图（九字段齐全，避免局部对象被误当成完整视图）。 */
function makeView(patch: Partial<AppSettingsView> = {}): AppSettingsView {
  return Object.freeze({
    themeId: 'eye-care',
    fontFamily: null,
    fontSize: '16px',
    zoomPercent: 100,
    zoomManual: true,
    sidebarWidth: 224,
    collapsedGroups: Object.freeze([]),
    pageWide: true,
    typewriter: false,
    ...patch,
  })
}

// ==================== 缩放：步进与钳制 ====================

describe('界面缩放：步进与钳制', () => {
  it('从 80% 起逐档 +10 走到 160%，共九档且不越界', () => {
    const seen: number[] = []
    let current = MIN_ZOOM // 80
    seen.push(current)
    for (let i = 0; i < 20; i += 1) {
      current = stepZoomPercent(current, 1)
      seen.push(current)
    }
    expect(seen.slice(0, 9)).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 160])
    // 继续按不越界：160 之后一直是 160
    expect(seen[9]).toBe(MAX_ZOOM)
    expect(seen[20]).toBe(MAX_ZOOM)
  })

  it('从 160% 起逐档 −10 走到 80%，且 80 之后一直是 80', () => {
    const seen: number[] = []
    let current = MAX_ZOOM
    seen.push(current)
    for (let i = 0; i < 20; i += 1) {
      current = stepZoomPercent(current, -1)
      seen.push(current)
    }
    expect(seen.slice(0, 9)).toEqual([160, 150, 140, 130, 120, 110, 100, 90, 80])
    expect(seen[20]).toBe(MIN_ZOOM)
  })

  it('步进常量就是 10，且区间是 [80,160]', () => {
    expect(ZOOM_STEP).toBe(10)
    expect(MIN_ZOOM).toBe(80)
    expect(MAX_ZOOM).toBe(160)
  })

  it('脏值（87 / NaN / 超界）先被收敛再步进', () => {
    // 存储里的脏值可能是 87（不是 10 的倍数）：clampZoom 只钳范围+取整，不吸附档位，
    // 所以 87 + 10 = 97 —— 这与旧版逐字一致（下一档由用户继续点出来）。
    expect(stepZoomPercent(87, 1)).toBe(97)
    expect(stepZoomPercent(87, -1)).toBe(80)
    expect(stepZoomPercent(Number.NaN, 1)).toBe(110) // NaN → 100 → 110
    expect(stepZoomPercent(999, 1)).toBe(MAX_ZOOM)
    expect(stepZoomPercent(-999, -1)).toBe(MIN_ZOOM)
    expect(stepZoomPercent(84.6, 1)).toBe(95) // round(84.6)=85 → 95
  })

  it('buildZoomStepPatch 同时写 zoomPercent 与 zoomManual:true（只改值会留下自动模式）', () => {
    const patch = buildZoomStepPatch(makeView({ zoomPercent: 120, zoomManual: false }), 1)
    expect(patch).toEqual({ zoomPercent: 130, zoomManual: true })
  })

  it('buildZoomPercentPatch 把任意值钳到 [80,160] 并标记手动', () => {
    expect(buildZoomPercentPatch(999)).toEqual({ zoomPercent: 160, zoomManual: true })
    expect(buildZoomPercentPatch(0)).toEqual({ zoomPercent: 80, zoomManual: true })
    expect(buildZoomPercentPatch(Number.NaN)).toEqual({ zoomPercent: 100, zoomManual: true })
    expect(buildZoomPercentPatch(133.4)).toEqual({ zoomPercent: 133, zoomManual: true })
  })
})

// ==================== 缩放：zoomManual 语义 ====================

describe('界面缩放：zoomManual 语义', () => {
  it('自动模式：两个步进按钮都禁用', () => {
    expect(canStepZoom(makeView({ zoomPercent: 100, zoomManual: false }))).toEqual({
      decrease: false,
      increase: false,
    })
  })

  it('手动模式 + 到下限 80：只禁用「−」', () => {
    expect(canStepZoom(makeView({ zoomPercent: 80, zoomManual: true }))).toEqual({
      decrease: false,
      increase: true,
    })
  })

  it('手动模式 + 到上限 160：只禁用「+」', () => {
    expect(canStepZoom(makeView({ zoomPercent: 160, zoomManual: true }))).toEqual({
      decrease: true,
      increase: false,
    })
  })

  it('手动模式 + 中间值：两个都可用', () => {
    expect(canStepZoom(makeView({ zoomPercent: 110, zoomManual: true }))).toEqual({
      decrease: true,
      increase: true,
    })
  })

  it('勾上「自动」：只切模式，不钉死百分比（值由窗口宽度重算）', () => {
    expect(buildZoomAutoPatch(makeView({ zoomPercent: 140, zoomManual: true }), true)).toEqual({
      zoomManual: false,
    })
  })

  it('勾掉「自动」：把眼前这个（自动算出的）百分比钉成手动值', () => {
    // 只传 zoomManual:true 时 saveAppSettings 什么都不写（视图不变），界面会像"卡住"
    expect(buildZoomAutoPatch(makeView({ zoomPercent: 132, zoomManual: false }), false)).toEqual({
      zoomPercent: 132,
      zoomManual: true,
    })
  })

  it('显示文案：整数百分比 + 「自动」标签', () => {
    expect(zoomDisplayText(120)).toBe('120%')
    expect(zoomDisplayText(84.6)).toBe('85%')
    expect(zoomDisplayText(Number.NaN)).toBe('100%')
    expect(zoomDisplayText(999)).toBe('160%')
    expect(ZOOM_AUTO_LABEL).toBe('自动（跟随窗口）')
  })
})

// ==================== 字体 ====================

describe('字体：选项构造与回落', () => {
  it('字体选项 = 「跟随默认」+ 全部预设（8 项 → 共 9 项）', () => {
    expect(FONT_CHOICES).toHaveLength(9)
    expect(FONT_CHOICES[0]).toEqual({
      value: DEFAULT_FONT_CHOICE_VALUE,
      label: DEFAULT_FONT_CHOICE_LABEL,
    })
    expect(FONT_CHOICES[0]?.value).toBe('')
    expect(FONT_CHOICES.map((choice) => choice.label)).toContain('楷体')
    expect(FONT_CHOICES.map((choice) => choice.label)).toContain('霞鹜文楷')
  })

  it('字号选项逐字来自 FONT_SIZE_OPTIONS（10 档，含默认 16px）', () => {
    expect(FONT_SIZE_CHOICES).toEqual([
      '14px',
      '15px',
      '16px',
      '17px',
      '18px',
      '20px',
      '22px',
      '24px',
      '26px',
      '28px',
    ])
    expect(FONT_SIZE_CHOICES).toContain('16px')
  })

  it('fontChoiceValue：null / 空串 / 未知栈段一律回「跟随默认」，已知栈段回自身', () => {
    expect(fontChoiceValue(null)).toBe(DEFAULT_FONT_CHOICE_VALUE)
    expect(fontChoiceValue('')).toBe(DEFAULT_FONT_CHOICE_VALUE)
    expect(fontChoiceValue('"Comic Sans MS"')).toBe(DEFAULT_FONT_CHOICE_VALUE)
    expect(fontChoiceValue('"楷体", "KaiTi", STKaiti')).toBe('"楷体", "KaiTi", STKaiti')
  })

  it('buildFontPatch：跟随默认 → null（清掉 --font-editor），选预设 → 写栈段', () => {
    expect(buildFontPatch('')).toEqual({ fontFamily: null })
    expect(buildFontPatch('"楷体", "KaiTi", STKaiti')).toEqual({
      fontFamily: '"楷体", "KaiTi", STKaiti',
    })
    // 不在选项里的串同样回落 null：本面板没有自定义输入口，不把未清洗的值写进变量
    expect(buildFontPatch('evil; background: url(x)')).toEqual({ fontFamily: null })
  })

  it('fontChoiceLabel：默认与预设各有中文名', () => {
    expect(fontChoiceLabel(null)).toBe(DEFAULT_FONT_CHOICE_LABEL)
    expect(fontChoiceLabel('"霞鹜文楷", "LXGW WenKai"')).toBe('霞鹜文楷')
  })

  it('fontSizeChoice：非法字号回落 16px，合法档位原样保留', () => {
    expect(fontSizeChoice('18px')).toBe('18px')
    expect(fontSizeChoice('19px')).toBe('16px') // 不在档位内
    expect(fontSizeChoice('')).toBe('16px')
    expect(fontSizeChoice('200px')).toBe('16px')
    expect(buildFontSizePatch('19px')).toEqual({ fontSize: '16px' })
    expect(buildFontSizePatch('22px')).toEqual({ fontSize: '22px' })
  })
})

// ==================== 侧栏宽度 ====================

describe('侧栏宽度：范围与显示', () => {
  it('范围常量是 200 / 560（与设置存储同源）', () => {
    expect(MIN_SIDEBAR_WIDTH).toBe(200)
    expect(MAX_SIDEBAR_WIDTH).toBe(560)
  })

  it('clampSidebarValue：越界夹到边界、小数取整、NaN 回默认宽度', () => {
    expect(clampSidebarValue(199)).toBe(200)
    expect(clampSidebarValue(561)).toBe(560)
    expect(clampSidebarValue(320.4)).toBe(320)
    expect(clampSidebarValue(Number.NaN)).toBe(224) // 设置存储的 initial
  })

  it('buildSidebarPatch / sidebarDisplayText 都走同一个钳制口径', () => {
    expect(buildSidebarPatch(120)).toEqual({ sidebarWidth: 200 })
    expect(buildSidebarPatch(999)).toEqual({ sidebarWidth: 560 })
    expect(buildSidebarPatch(301.6)).toEqual({ sidebarWidth: 302 })
    expect(sidebarDisplayText(320)).toBe('320px')
    expect(sidebarDisplayText(999)).toBe('560px')
  })
})

// ==================== 主题选项 ====================

describe('主题选项：禁用与当前标记', () => {
  it('只有 custom 被禁用（其余八套都能点）', () => {
    const disabled = THEMES.filter(isThemeOptionDisabled).map((option) => option.id)
    expect(disabled).toEqual([CUSTOM_THEME_ID])
    for (const option of THEMES) {
      expect(isThemeOptionDisabled(option)).toBe(option.id === 'custom')
    }
  })

  it('被禁用的 custom 永远不算「当前」，即使存储里写着 custom', () => {
    const custom = THEMES[3]
    expect(custom).toBeDefined()
    expect(isThemeOptionCurrent(custom as ThemeOption, 'custom')).toBe(false)
    expect(isThemeOptionCurrent(custom as ThemeOption, 'dark')).toBe(false)
  })

  it('当前主题命中且唯一', () => {
    const current = THEMES.filter((option) => isThemeOptionCurrent(option, 'eye-care'))
    expect(current.map((option) => option.id)).toEqual(['eye-care'])
    expect(isThemeOptionCurrent(THEMES[0] as ThemeOption, 'dark')).toBe(true)
  })

  it('findThemeOption：未知 id 返回 null（调用方回落显示 id 本身）', () => {
    expect(findThemeOption(THEMES, 'dark')?.name).toBe('暗夜')
    expect(findThemeOption(THEMES, 'nope')).toBeNull()
    expect(findThemeOption([], 'dark')).toBeNull()
  })

  it('title 文案：普通项是「名（说明）」，禁用项额外说明原因', () => {
    expect(themeOptionTitle(THEMES[0] as ThemeOption)).toBe('暗夜（深色）')
    const customTitle = themeOptionTitle(THEMES[3] as ThemeOption)
    expect(customTitle).toContain('自定义')
    expect(customTitle).toContain('暂未实现')
  })

  it('标记文案是契约要求的中文常量', () => {
    expect(CURRENT_THEME_NOTE).toBe('当前')
    expect(THEME_DISABLED_NOTE).toBe('暂未实现')
  })
})

// ==================== 变更文案 ====================

describe('变更文案', () => {
  it('主题文案用主题名（传了 themes 时）', () => {
    expect(changeSummary({ themeId: 'dark' }, THEMES)).toBe('主题已切换为「暗夜」')
    // 没传 themes 时回落到 id：纯逻辑测试不必构造主题表
    expect(changeSummary({ themeId: 'dark' })).toBe('主题已切换为「dark」')
  })

  it('缩放文案区分手动与「跟随窗口」', () => {
    expect(changeSummary({ zoomPercent: 130, zoomManual: true })).toBe('界面缩放已设为 130%（手动）')
    expect(changeSummary({ zoomManual: false })).toBe(`界面缩放已改为「${ZOOM_AUTO_LABEL}」`)
    expect(changeSummary({ zoomPercent: 120, zoomManual: false })).toBe('界面缩放已设为 120%')
  })

  it('字体 / 字号 / 侧栏各自成句，多键变更用分号连起来', () => {
    expect(changeSummary({ fontFamily: null })).toBe('正文字体已跟随默认')
    expect(changeSummary({ fontFamily: '"楷体", "KaiTi", STKaiti' })).toBe('正文字体已设为楷体')
    expect(changeSummary({ fontSize: '18px' })).toBe('正文字号已设为 18px')
    expect(changeSummary({ sidebarWidth: 320 })).toBe('侧栏宽度已设为 320px')
    expect(changeSummary({ themeId: 'dark', sidebarWidth: 320 }, THEMES)).toBe(
      '主题已切换为「暗夜」；侧栏宽度已设为 320px',
    )
  })

  it('空补丁有专门的文案，不会输出空串', () => {
    expect(changeSummary({})).toBe(CHANGE_NO_PATCH)
    expect(CHANGE_NO_PATCH.length).toBeGreaterThan(0)
  })
})

// ==================== 补丁生效判定 ====================

describe('补丁生效判定（写失败 = 端口返回未变更的视图）', () => {
  it('返回值与补丁一致 → 生效', () => {
    const view = makeView({ themeId: 'dark', zoomPercent: 130, zoomManual: true })
    expect(isPatchApplied(view, { themeId: 'dark' })).toBe(true)
    expect(isPatchApplied(view, { zoomPercent: 130, zoomManual: true })).toBe(true)
    expect(isPatchApplied(view, {})).toBe(true)
  })

  it('返回值与补丁不一致 → 未生效（隐私模式写不进去）', () => {
    const view = makeView({ themeId: 'eye-care', zoomPercent: 100, sidebarWidth: 224 })
    expect(isPatchApplied(view, { themeId: 'dark' })).toBe(false)
    expect(isPatchApplied(view, { zoomPercent: 130, zoomManual: true })).toBe(false)
    expect(isPatchApplied(view, { sidebarWidth: 320 })).toBe(false)
    expect(isPatchApplied(view, { fontSize: '18px' })).toBe(false)
    expect(isPatchApplied(view, { fontFamily: '"楷体"' })).toBe(false)
  })

  it('七字段逐字段比对，只查补丁里出现过的键', () => {
    const view = makeView({ fontFamily: null, fontSize: '16px' })
    // 补丁没提 fontFamily 时，视图里是 null 也照样算生效
    expect(isPatchApplied(view, { fontSize: '16px' })).toBe(true)
    expect(isPatchApplied(view, { fontFamily: null })).toBe(true)
    expect(isPatchApplied(view, { fontFamily: '"楷体"' })).toBe(false)
    expect(isPatchApplied(view, { collapsedGroups: ['a'] })).toBe(false)
  })
})
