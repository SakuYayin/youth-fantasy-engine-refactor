/**
 * 「设置」面板（`features/settings-panel.vue`）的纯逻辑层 —— W8-C · 差距报告 H 项。
 *
 * 为什么把逻辑抽出来：设置面板的每一处交互都是「**读当前视图 → 构造补丁 → 交给端口**」，
 * 而端口只保证「返回写入后的完整视图」，不保证「你传进去的值原样生效」
 * （`settings-store.ts` 会收敛主题 id、钳制缩放与侧栏宽度、清洗字号）。
 * 把这些构造规则放在这里，组件就只剩接线，测试也不必挂载 DOM 就能逐值驱动边界。
 *
 * 三条边界（与 `docs/接口冻结-W8外壳.md` §0 对齐）：
 * 1. **本文件不碰 `localStorage`、不碰 `document`**：一切存储都经 `SettingsPort`。
 * 2. **补丁只含被改的键**：多带一个键就会顺带重置别的字段
 *    （`saveAppSettings` 的 `patch.zoomPercent !== undefined` 分支会把缩放切成手动）。
 * 3. **失败不静默**：`SettingsPort` 不返回 `FeatureResult`，写失败（隐私模式）时
 *    端口"返回未变更的视图"，所以判定失败的唯一办法是**比对返回值**——
 *    见 `isPatchApplied`，组件据此给出「未生效」文案而不是假装保存成功。
 *
 * 只读依赖：`settings-store.ts`（键名常量 / 预设字体 / 字号档 / 钳制函数）与
 * `theme/zoom.ts`（缩放步进与上下限）。这两个模块归 Lead 独占，本文件只消费不改。
 */

import type { AppSettingsView } from './types.js'

import {
  DEFAULT_EDITOR_FONT_SIZE,
  FONT_SIZE_OPTIONS,
  PRESET_FONTS,
  SIDEBAR_WIDTH,
  clampSidebarWidth,
} from './settings-store.js'
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  ZOOM_STEP_PERCENT,
  clampZoom,
  isZoomAtMax,
  isZoomAtMin,
  zoomIn,
  zoomOut,
} from '../theme/zoom.js'

// ==================== 主题 ====================

/**
 * 设置面板消费的主题选项。
 *
 * 形状与 `theme/palettes.ts` 的 `ThemePalette` 的公共子集一致，但**不在本文件里
 * 从配色表取值**：选项由 Lead 通过 prop 传进来（`App.vue` 生成），面板只认这个结构。
 * 这样配色表加减主题时设置面板一行都不用改，测试也能塞任意数量的假主题。
 */
export interface ThemeOption {
  readonly id: string
  readonly name: string
  readonly desc: string
  /** 色卡底色，直接写进 `background`（`custom` 是渐变串，同样合法）。 */
  readonly swatch: string
}

/** 派生主题（母版 + 色相微调）的 id。旧版 `THEMES` 的最后一项，本批未实现（台账 R-80）。 */
export const CUSTOM_THEME_ID = 'custom'

/** 未实现功能的标注（契约 §1.3 要求逐字显示这句）。 */
export const THEME_DISABLED_NOTE = '暂未实现'

/** 当前生效主题的标记文字（`aria-pressed` 之外的第二重可见标记）。 */
export const CURRENT_THEME_NOTE = '当前'

/** `themes` 为空时的说明（不能白屏，也不能静默少一块）。 */
export const THEMES_EMPTY = '没有可用的主题选项（主题表为空），请检查应用资源是否完整。'

/**
 * 该主题选项是否禁用。
 *
 * 只禁用 `custom`：它需要用户在弹窗里先配一套参数（母版 + 强调色 + 色相偏移），
 * 本批没有那个弹窗，点了只会静默切回默认主题（`normalizeThemeId` 不认 `custom`）——
 * 那比禁用更糟，用户会以为自己点错了。
 */
export function isThemeOptionDisabled(option: ThemeOption): boolean {
  return option.id === CUSTOM_THEME_ID
}

/** 该选项是否是「当前主题」。禁用项永远不算当前（它不可能被写进设置）。 */
export function isThemeOptionCurrent(option: ThemeOption, themeId: string): boolean {
  return !isThemeOptionDisabled(option) && option.id === themeId
}

/** 按 id 取选项；未知 id 返回 `null`（调用方决定回落文案）。 */
export function findThemeOption(
  options: readonly ThemeOption[],
  themeId: string,
): ThemeOption | null {
  return options.find((option) => option.id === themeId) ?? null
}

/** 主题按钮的 `title`：名字 + 说明，禁用项额外说明原因。 */
export function themeOptionTitle(option: ThemeOption): string {
  const base = `${option.name}（${option.desc}）`
  return isThemeOptionDisabled(option) ? `${base} —— 自定义主题暂未实现，不可选` : base
}

// ==================== 界面缩放 ====================

/** 步进（10%）。 */
export const ZOOM_STEP = ZOOM_STEP_PERCENT
/** 下限 80%。 */
export const MIN_ZOOM = MIN_ZOOM_PERCENT
/** 上限 160%。 */
export const MAX_ZOOM = MAX_ZOOM_PERCENT
/** 「自动（跟随窗口）」复选框标签。 */
export const ZOOM_AUTO_LABEL = '自动（跟随窗口）'

/**
 * 自动模式下按钮禁用时的提示。
 *
 * 光禁用不说原因是最常见的一种"静默"：用户会以为按钮坏了。
 */
export const ZOOM_AUTO_HINT = '当前为自动缩放，勾掉「自动」后可手动调整'

/** 缩放百分比显示（`120` → `'120%'`）。 */
export function zoomDisplayText(percent: number): string {
  return `${clampZoom(percent)}%`
}

/** 「−」/「+」的目标值：direction `-1` 缩小、`1` 放大（都不越界）。 */
export function stepZoomPercent(current: number, direction: 1 | -1): number {
  return direction === 1 ? zoomIn(current) : zoomOut(current)
}

/**
 * 两个步进按钮的禁用态。
 *
 * 自动模式下**两个都禁用**（值是按窗口宽度算出来的，手改没有意义），
 * 手动模式下才按上下限判定。
 */
export function canStepZoom(
  view: Pick<AppSettingsView, 'zoomPercent' | 'zoomManual'>,
): { readonly decrease: boolean; readonly increase: boolean } {
  if (!view.zoomManual) return { decrease: false, increase: false }
  return {
    decrease: !isZoomAtMin(view.zoomPercent),
    increase: !isZoomAtMax(view.zoomPercent),
  }
}

/**
 * 点「−」/「+」的补丁。
 *
 * 🔴 必须带 `zoomManual: true`：`saveAppSettings` 在 `zoomPercent` 分支里用
 * `patch.zoomManual ?? true`，显式传 true 与省略等价，但**写明意图**才不会在
 * 将来 store 改默认值时悄悄变成"只改值不改模式"。
 */
export function buildZoomStepPatch(
  view: Pick<AppSettingsView, 'zoomPercent' | 'zoomManual'>,
  direction: 1 | -1,
): Partial<AppSettingsView> {
  return { zoomPercent: stepZoomPercent(view.zoomPercent, direction), zoomManual: true }
}

/** 直接指定百分比（脏值由 `clampZoom` 收敛，且视为手动）。 */
export function buildZoomPercentPatch(percent: number): Partial<AppSettingsView> {
  return { zoomPercent: clampZoom(percent), zoomManual: true }
}

/**
 * 「自动（跟随窗口）」开关的补丁。
 *
 * - `enabled: true`（勾上「自动」）：只传 `{ zoomManual: false }`。store 会把
 *   当前生效值写一份并把模式切成跟随窗口，**返回值里的 `zoomPercent` 是按窗口
 *   宽度重算出来的**——这正是"自动"该显示的数值，所以调用方必须用返回值刷新显示。
 * - `enabled: false`（勾掉「自动」）：把眼前这个（自动算出的）百分比**钉住**成手动值。
 *   只传 `{ zoomManual: true }` 是不够的：store 的 `saveAppSettings` 在既没有
 *   `zoomPercent` 也不是 `zoomManual === false` 时**什么都不写**，视图不会变，
 *   界面会看起来"勾了没反应"。
 */
export function buildZoomAutoPatch(
  view: Pick<AppSettingsView, 'zoomPercent' | 'zoomManual'>,
  enabled: boolean,
): Partial<AppSettingsView> {
  if (enabled) return { zoomManual: false }
  return { zoomPercent: clampZoom(view.zoomPercent), zoomManual: true }
}

// ==================== 字体 ====================

/** 字体下拉的一项。 */
export interface FontChoice {
  /** `select` 的 value；空串 = 跟随默认。 */
  readonly value: string
  /** 用户可见文案。 */
  readonly label: string
}

/** 「跟随默认」的 value（空串 = 不写 `--font-editor` 变量）。 */
export const DEFAULT_FONT_CHOICE_VALUE = ''
/** 「跟随默认」的文案。默认正文栈是思源宋体（见 `PRESET_FONTS[0]`）。 */
export const DEFAULT_FONT_CHOICE_LABEL = '跟随默认（思源宋体）'

/**
 * 正文字体选项：`PRESET_FONTS`（只读导入）+ 开头一个「跟随默认」。
 *
 * value 用**字体栈段本身**而不是下标/名字：栈段才是真正写进 CSS 变量的值，
 * 用它的好处是「存储里的值与下拉项比对」不需要任何额外映射表，
 * 老数据（旧版 `yfe-font-prefs` 存的就是栈段）能直接命中。
 */
export const FONT_CHOICES: readonly FontChoice[] = Object.freeze([
  Object.freeze({ value: DEFAULT_FONT_CHOICE_VALUE, label: DEFAULT_FONT_CHOICE_LABEL }),
  ...PRESET_FONTS.map((preset) => Object.freeze({ value: preset.stack, label: preset.name })),
])

/** 字号档（`FONT_SIZE_OPTIONS` 的只读投影，逐字来自设置存储）。 */
export const FONT_SIZE_CHOICES: readonly string[] = Object.freeze([...FONT_SIZE_OPTIONS])

/**
 * 当前字体族落在下拉的哪一项。
 *
 * 未知栈段（手改过存储 / 装了别的工具写的值）回落到「跟随默认」而不是新造一项：
 * 下拉里没有的选项在浏览器里会显示成空白，比显示"跟随默认"更容易让人误判。
 */
export function fontChoiceValue(fontFamily: string | null): string {
  if (fontFamily === null || fontFamily === '') return DEFAULT_FONT_CHOICE_VALUE
  return FONT_CHOICES.some((choice) => choice.value === fontFamily)
    ? fontFamily
    : DEFAULT_FONT_CHOICE_VALUE
}

/** 当前字体族的展示名（提示行 / 变更文案用）。 */
export function fontChoiceLabel(fontFamily: string | null): string {
  const value = fontChoiceValue(fontFamily)
  return FONT_CHOICES.find((choice) => choice.value === value)?.label ?? DEFAULT_FONT_CHOICE_LABEL
}

/**
 * 下拉选择 → 补丁。
 *
 * `''` → `fontFamily: null`（设置层据此清空 `--font-editor`，跟随默认）。
 * 非选项内的字符串同样回落 `null`：本面板没有"自定义字体名"输入口（见交付报告），
 * 与其把未经清洗的串写进 CSS 变量，不如当作用户选了「跟随默认」。
 */
export function buildFontPatch(choice: string): Partial<AppSettingsView> {
  const value = fontChoiceValue(choice === '' ? null : choice)
  return { fontFamily: value === DEFAULT_FONT_CHOICE_VALUE ? null : value }
}

/**
 * 当前字号落在哪一档。
 *
 * 非法 / 不在档位内的值回落到 `DEFAULT_EDITOR_FONT_SIZE`（`'16px'`，且它本身
 * 就在 `FONT_SIZE_OPTIONS` 里，所以下拉永远有这一项，不会出现"选中项不存在"）。
 */
export function fontSizeChoice(fontSize: string): string {
  return FONT_SIZE_CHOICES.includes(fontSize) ? fontSize : DEFAULT_EDITOR_FONT_SIZE
}

/** 字号选择 → 补丁（先收敛到合法档位，脏值不会被写进存储）。 */
export function buildFontSizePatch(fontSize: string): Partial<AppSettingsView> {
  return { fontSize: fontSizeChoice(fontSize) }
}

// ==================== 侧栏宽度 ====================

/** 侧栏宽度下限 200px（上游 `useResizable` 的 `min`）。 */
export const MIN_SIDEBAR_WIDTH = SIDEBAR_WIDTH.min
/** 侧栏宽度上限 560px。 */
export const MAX_SIDEBAR_WIDTH = SIDEBAR_WIDTH.max
/** 滑块的 `step`（1px；上游是拖拽，没有档位）。 */
export const SIDEBAR_WIDTH_STEP = 1
/** 滑块说明（顺带把范围写给用户看）。 */
export const SIDEBAR_HINT = `拖动滑块调整左侧栏宽度（${MIN_SIDEBAR_WIDTH}–${MAX_SIDEBAR_WIDTH}px），改完立即生效。`

/** 侧栏宽度收敛到 [200, 560] 的整数（复用设置存储的同一份实现，避免两处规则漂移）。 */
export function clampSidebarValue(width: number): number {
  return clampSidebarWidth(width)
}

/** 侧栏宽度显示（`320` → `'320px'`）。 */
export function sidebarDisplayText(width: number): string {
  return `${clampSidebarValue(width)}px`
}

/**
 * 滑块 → 补丁。拖动过程中每帧都会调（`input` 事件），所以必须是纯函数，
 * 且**先钳制再入补丁**：滑块本身受 min/max 约束，但键盘/脚本能塞进任意值。
 */
export function buildSidebarPatch(width: number): Partial<AppSettingsView> {
  return { sidebarWidth: clampSidebarValue(width) }
}

// ==================== 回执文案与失败判定 ====================

/** 成功回执前缀。 */
export const CHANGE_PREFIX_OK = '已保存：'
/** 失败回执前缀（端口返回的视图与补丁不符 = 没写进去）。 */
export const CHANGE_PREFIX_FAILED = '未生效：'
/** 空补丁的文案。 */
export const CHANGE_NO_PATCH = '设置未变更'
/** 「恢复默认」成功文案。 */
export const RESET_DONE_TEXT = '已恢复默认设置。'
/** 写失败说明（补充原因与后果，不只是一句"失败"）。 */
export const SAVE_FAILED_HINT =
  '设置未能写入本机存储（可能处于隐私模式或被系统限制），本次改动不会保留。'

/**
 * 补丁的人话摘要（回执行）。
 *
 * `themes` 可选：传了就把主题 id 翻成主题名，没传就用 id 本身——面板一定有这个 prop，
 * 但纯逻辑测试不该被迫构造一份主题表。
 */
export function changeSummary(
  patch: Partial<AppSettingsView>,
  themes: readonly ThemeOption[] = [],
): string {
  const parts: string[] = []

  if (patch.themeId !== undefined) {
    const name = findThemeOption(themes, patch.themeId)?.name ?? patch.themeId
    parts.push(`主题已切换为「${name}」`)
  }

  if (patch.zoomPercent !== undefined) {
    parts.push(
      patch.zoomManual === true
        ? `界面缩放已设为 ${patch.zoomPercent}%（手动）`
        : `界面缩放已设为 ${patch.zoomPercent}%`,
    )
  } else if (patch.zoomManual !== undefined) {
    parts.push(
      patch.zoomManual ? '界面缩放已改为手动' : `界面缩放已改为「${ZOOM_AUTO_LABEL}」`,
    )
  }

  if (patch.fontFamily !== undefined) {
    parts.push(
      patch.fontFamily === null
        ? '正文字体已跟随默认'
        : `正文字体已设为${fontChoiceLabel(patch.fontFamily)}`,
    )
  }
  if (patch.fontSize !== undefined) parts.push(`正文字号已设为 ${patch.fontSize}`)
  if (patch.sidebarWidth !== undefined) parts.push(`侧栏宽度已设为 ${patch.sidebarWidth}px`)
  if (patch.collapsedGroups !== undefined) parts.push('侧栏折叠分组已更新')

  return parts.length === 0 ? CHANGE_NO_PATCH : parts.join('；')
}

/**
 * 补丁是否真的生效 —— 逐字段比对端口返回的视图。
 *
 * 为什么需要它：`SettingsPort.save()` 在写失败时**返回未变更的视图**（不抛异常、
 * 也不返回 `FeatureResult`），这是本端口唯一能表达失败的方式。契约 §0.2 要求
 * "组件必须处理失败并把 message 显示给用户"，在这个端口上的等价物就是：
 * 返回值与补丁不一致 ⇒ 显示「未生效」而不是显示一个假的成功回执。
 */
export function isPatchApplied(view: AppSettingsView, patch: Partial<AppSettingsView>): boolean {
  if (patch.themeId !== undefined && view.themeId !== patch.themeId) return false
  if (patch.zoomPercent !== undefined && view.zoomPercent !== patch.zoomPercent) return false
  if (patch.zoomManual !== undefined && view.zoomManual !== patch.zoomManual) return false
  if (patch.sidebarWidth !== undefined && view.sidebarWidth !== patch.sidebarWidth) return false
  if (patch.fontSize !== undefined && view.fontSize !== patch.fontSize) return false
  if (patch.fontFamily !== undefined && view.fontFamily !== patch.fontFamily) return false
  if (patch.collapsedGroups !== undefined && view.collapsedGroups !== patch.collapsedGroups) {
    return false
  }
  return true
}
