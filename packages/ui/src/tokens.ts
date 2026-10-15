/**
 * `@yfe/ui` 设计令牌（ADR 0006 D3）。
 *
 * 规则：**组件里不得出现魔法值**——颜色、间距、圆角、字体、层级、尺寸全部来自
 * 这里的 `designTokens`，组件只通过 CSS 变量（`tokensToCssVariables`）消费。
 * 深色为默认主题（`name: 'dark'`），与 `apps/desktop/src/renderer/index.html`
 * 的占位页配色保持一致，避免渲染层与组件库两套色板。
 *
 * 主题化路径（`05-插件内核与SDK.md`：主题以设计令牌为主）：外部主题只需产出
 * 同构的 `DesignTokens`，用 `tokensToCssVariables(theme)` 得到同名 CSS 变量即可
 * 覆盖，不需要改组件。因此令牌**键名是公共契约**（见 `tests/tokens.test.ts`
 * 的键集合断言），值可以换。
 */

/** 颜色令牌。深色默认值取自 `apps/desktop/src/renderer/index.html` 的占位页。 */
export type YfeColorTokens = {
  /** 应用底色 `#111318`。 */
  readonly background: string
  /** 面板底色 `#1a1d25`。 */
  readonly surface: string
  /** 浮起面（对话框、悬停态）底色。 */
  readonly surfaceRaised: string
  /** 常规边框 `#2a2f3a`。 */
  readonly border: string
  /** 强调边框（悬停、选中态）。 */
  readonly borderStrong: string
  /** 正文色 `#e6e8ee`。 */
  readonly text: string
  /** 次级文字 `#8b93a7`。 */
  readonly textMuted: string
  /** 实心主按钮上的文字色。 */
  readonly textOnAccent: string
  /** 主操作色（工具条/主按钮）。 */
  readonly accent: string
  /** 主操作悬停色。 */
  readonly accentHover: string
  /** 成功 `#5ddc9a`（保存完成）。 */
  readonly success: string
  /** 警告（冲突、离线提示）。 */
  readonly warning: string
  /** 危险 `#ff7b72`（保存失败、破坏性操作）。 */
  readonly danger: string
  /** 危险悬停色。 */
  readonly dangerHover: string
  /** 键盘焦点外圈色（无障碍底线的可见焦点）。 */
  readonly focusRing: string
  /** 模态遮罩色。 */
  readonly overlay: string
}

/** 间距令牌（4 的倍数，便于对齐）。 */
export type YfeSpaceTokens = {
  readonly none: string
  readonly xs: string
  readonly sm: string
  readonly md: string
  readonly lg: string
  readonly xl: string
  readonly xxl: string
}

/** 圆角令牌。 */
export type YfeRadiusTokens = {
  readonly none: string
  readonly sm: string
  readonly md: string
  readonly lg: string
  /** 胶囊（状态标签）。 */
  readonly pill: string
}

/** 字体令牌。 */
export type YfeFontTokens = {
  readonly family: string
  readonly familyMono: string
  readonly sizeSm: string
  readonly sizeMd: string
  readonly sizeLg: string
  readonly weightRegular: string
  readonly weightMedium: string
  readonly weightBold: string
  readonly lineHeight: string
}

/** 层级令牌（z-index）。 */
export type YfeLayerTokens = {
  readonly content: number
  readonly sticky: number
  readonly dialog: number
  readonly toast: number
}

/**
 * 尺寸令牌。
 *
 * ADR 0006 D3 只列了「颜色 / 间距 / 圆角 / 字体 / 层级」五组；`size` 是补齐：
 * 控件高度、边框宽度、章节树缩进步长、状态点直径这些值无处可放，
 * 散到组件里就正好是 ADR 要禁的「魔法值」。
 */
export type YfeSizeTokens = {
  readonly borderWidth: string
  readonly focusWidth: string
  readonly controlHeightSm: string
  readonly controlHeight: string
  /** 章节树每一层 `depth` 的缩进步长，`YfeTree` 直接读它换算 px。 */
  readonly treeIndent: string
  /** `YfeStatusPill` 的圆点直径。 */
  readonly statusDot: string
}

/** 完整设计令牌。 */
export interface DesignTokens {
  /** 主题名。深色为默认。 */
  readonly name: string
  readonly color: YfeColorTokens
  readonly space: YfeSpaceTokens
  readonly radius: YfeRadiusTokens
  readonly font: YfeFontTokens
  readonly layer: YfeLayerTokens
  readonly size: YfeSizeTokens
}

/**
 * 深色默认令牌。
 *
 * 其中 `background` / `surface` / `border` / `text` / `textMuted` / `success` /
 * `danger` 七个值与 `apps/desktop/src/renderer/index.html` 的深色配色逐字一致；
 * 其余（`surfaceRaised` / `borderStrong` / `accent` / `warning` / `overlay` …）
 * 是占位页没有的语义位，按同一明度带推导，等设计稿到位后只改这里。
 */
export const designTokens: DesignTokens = Object.freeze({
  name: 'dark',
  color: Object.freeze({
    background: '#111318',
    surface: '#1a1d25',
    surfaceRaised: '#20242e',
    border: '#2a2f3a',
    borderStrong: '#3a4152',
    text: '#e6e8ee',
    textMuted: '#8b93a7',
    textOnAccent: '#0b1016',
    accent: '#5b8cff',
    accentHover: '#7aa3ff',
    success: '#5ddc9a',
    warning: '#e8b96b',
    danger: '#ff7b72',
    dangerHover: '#ff9a92',
    focusRing: '#5b8cff',
    overlay: 'rgba(6, 8, 12, 0.62)',
  }),
  space: Object.freeze({
    none: '0',
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    xxl: '32px',
  }),
  radius: Object.freeze({
    none: '0',
    sm: '4px',
    md: '6px',
    lg: '10px',
    pill: '999px',
  }),
  font: Object.freeze({
    family: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
    familyMono: 'Consolas, "Cascadia Mono", monospace',
    sizeSm: '12px',
    sizeMd: '14px',
    sizeLg: '16px',
    weightRegular: '400',
    weightMedium: '500',
    weightBold: '600',
    lineHeight: '1.7',
  }),
  layer: Object.freeze({
    content: 0,
    sticky: 10,
    dialog: 40,
    toast: 60,
  }),
  size: Object.freeze({
    borderWidth: '1px',
    focusWidth: '2px',
    controlHeightSm: '24px',
    controlHeight: '32px',
    treeIndent: '18px',
    statusDot: '8px',
  }),
})

/** 组件 `:style` 绑定的 CSS 变量表。 */
export type DesignTokenVariables = Readonly<Record<string, string>>

/** 变量前缀，测试与主题包都依赖它。 */
export const DESIGN_TOKEN_VARIABLE_PREFIX = '--yfe-'

function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}

function assignGroup(
  target: Record<string, string>,
  group: string,
  values: Readonly<Record<string, string | number>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    target[`${DESIGN_TOKEN_VARIABLE_PREFIX}${group}-${kebabCase(key)}`] = String(value)
  }
}

/**
 * 把令牌摊平成 CSS 变量（`--yfe-color-background` 这种形态）。
 *
 * 传自定义令牌即可得到一套主题变量；键名与默认令牌完全同构，所以组件不用感知主题。
 */
export function tokensToCssVariables(tokens: DesignTokens = designTokens): DesignTokenVariables {
  const variables: Record<string, string> = {}
  assignGroup(variables, 'color', tokens.color)
  assignGroup(variables, 'space', tokens.space)
  assignGroup(variables, 'radius', tokens.radius)
  assignGroup(variables, 'font', tokens.font)
  assignGroup(variables, 'layer', tokens.layer)
  assignGroup(variables, 'size', tokens.size)
  return Object.freeze(variables)
}

/** 默认主题的 CSS 变量，组件直接 `:style` 绑它（模块级常量，不随渲染重建）。 */
export const designTokenVariables: DesignTokenVariables = tokensToCssVariables(designTokens)

/**
 * 把 `px` 长度令牌还原成数字，供需要参与计算的组件使用（例如 `YfeTree` 按 `depth` 缩进）。
 *
 * 只接受纯 `px`：`rem` / `em` 的换算依赖根字号，猜一个值会让「按 depth 缩进」
 * 变成静默错误，所以这里直接抛错，让写错令牌的人当场炸掉而不是布局慢慢歪。
 */
export function parsePx(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim())
  const digits = match?.[1]
  if (digits === undefined) {
    throw new RangeError(`设计令牌长度必须是 px 值，收到：${value}`)
  }
  return Number(digits)
}
