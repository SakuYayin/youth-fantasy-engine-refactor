/**
 * 主题 → CSS 变量（W8 · 外壳设置通道）—— **Lead 独占，其他智能体只读**。
 *
 * 职责链：`ThemePalette`（配色）→ `DesignTokens`（`@yfe/ui` 的令牌形状）→
 * CSS 变量表 → `document.documentElement` 上的内联变量。
 *
 * 为什么要绕 `DesignTokens` 而不是直接产 CSS 变量：`@yfe/ui` 的组件
 * （`YfeButton` / `YfePanel` / `YfeDialog` …）消费的是**令牌形状**，
 * 用 `tokensToCssVariables()` 产出变量能让主题与组件库共用一套键名，
 * 以后加令牌只改一处。键名是公共契约（`packages/ui/src/tokens.ts` 头部注释）。
 *
 * ## 别名（务必读）
 *
 * 实测全仓 `var(--yfe-*)` 引用后发现两类名字：
 *   · **规范名**：`tokensToCssVariables()` 产出的 `--yfe-color-background` 这种；
 *   · **历史名**：`--yfe-color-bg`（`App.vue` / `tavern-plot.vue`）、
 *     `--yfe-text-primary/secondary/tertiary`（`bookbreak.vue`）、
 *     `--yfe-bg-surface` / `--yfe-bg-muted` / `--yfe-border-color`（`bookbreak.vue`）、
 *     `--yfe-font-size-xs`（12 处）、`--yfe-space-1..4`、`--yfe-panel-padding`…
 *
 * 这些历史名此前**没有任何地方定义**，全部走各自 `var()` 的硬编码兜底
 * （例如 `--yfe-color-bg` 恒等于 `#111318`）⇒ 换肤时它们是唯一不跟着变的一批，
 * 就像贴纸一样留在界面上。这里把它们**显式映射**到规范令牌，一处修好全仓。
 *
 * 另一条路是把各组件里的历史名改成规范名，但那要动 20+ 个已验收面板文件，
 * 且每改一处都要重跑该面板的测试；别名表的代价是 30 行常量，且被
 * `tests/theme-variables.test.ts` 钉住「每个被引用的 `--yfe-*` 都有定义」。
 */

import { designTokens, tokensToCssVariables, type DesignTokens } from '@yfe/ui'

import {
  DEFAULT_THEME_ID,
  findPalette,
  normalizeThemeId,
  type ConcreteThemeId,
  type RgbTriple,
  type ThemePalette,
} from './palettes.js'

/** CSS 变量前缀，与 `packages/ui/src/tokens.ts` 的 `DESIGN_TOKEN_VARIABLE_PREFIX` 一致。 */
const PREFIX = '--yfe-'

/** RGB 三元组 → `rgb(r g b)`（空格分隔，CSS Color 4 写法，可被 `color-mix()` 消费）。 */
export function rgbTripleToCss(triple: RgbTriple): string {
  return `rgb(${triple[0]} ${triple[1]} ${triple[2]})`
}

/**
 * 配色 → 令牌。
 *
 * 映射规则（两类主题共用，因为墨色刻度在浅色主题里本来就是反的）：
 * `background←ink950`（最深/最浅的底色）、`surface←ink900`、`surfaceRaised←ink850`、
 * `border←ink700`、`borderStrong←ink600`、`text←ink50`、`textMuted←ink300`。
 *
 * 间距/圆角/字体/层级/尺寸五组**沿用 `designTokens` 的默认值**：主题只换色，
 * 不换排版（旧版也是这样——`index.css` 的主题段只定义颜色变量）。
 */
export function paletteToDesignTokens(palette: ThemePalette): DesignTokens {
  const ink = palette.ink
  return Object.freeze({
    name: palette.id,
    color: Object.freeze({
      background: rgbTripleToCss(ink.ink950),
      surface: rgbTripleToCss(ink.ink900),
      surfaceRaised: rgbTripleToCss(ink.ink850),
      border: rgbTripleToCss(ink.ink700),
      borderStrong: rgbTripleToCss(ink.ink600),
      text: rgbTripleToCss(ink.ink50),
      textMuted: rgbTripleToCss(ink.ink300),
      // 实心主按钮上的文字：暗色主题的强调色偏亮，用最深墨色压住；浅色主题同理。
      textOnAccent: rgbTripleToCss(ink.ink950),
      accent: rgbTripleToCss(palette.accent),
      accentHover: rgbTripleToCss(palette.accentSoft),
      success: rgbTripleToCss(palette.success),
      warning: rgbTripleToCss(palette.accentSoft),
      danger: rgbTripleToCss(palette.danger),
      dangerHover: rgbTripleToCss(palette.danger),
      focusRing: rgbTripleToCss(palette.accent),
      overlay:
        palette.colorScheme === 'dark' ? 'rgba(6, 8, 12, 0.62)' : 'rgba(20, 24, 30, 0.35)',
    }),
    space: designTokens.space,
    radius: designTokens.radius,
    font: designTokens.font,
    layer: designTokens.layer,
    size: designTokens.size,
  })
}

/**
 * 历史变量名 → 规范变量名。
 *
 * 只映射**确实被引用过**的名字（不是穷举猜测）：来源是全仓 `var(--yfe-*)` 扫描
 * （`--yfe-color-bg` 2 处、`--yfe-text-primary` 3 处、`--yfe-font-size-xs` 12 处…）。
 * 新增组件请直接用规范名（`packages/ui/src/tokens.ts` 的键），不要再往这张表里加。
 */
export const LEGACY_VARIABLE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '--yfe-color-bg': `${PREFIX}color-background`,
  '--yfe-color-text-dim': `${PREFIX}color-text-muted`,
  '--yfe-color-primary': `${PREFIX}color-accent`,
  '--yfe-color-warning-bg': `${PREFIX}color-surface-raised`,
  '--yfe-color-warning-text': `${PREFIX}color-warning`,
  '--yfe-bg-surface': `${PREFIX}color-surface`,
  '--yfe-bg-muted': `${PREFIX}color-surface-raised`,
  '--yfe-border-color': `${PREFIX}color-border`,
  '--yfe-text-primary': `${PREFIX}color-text`,
  '--yfe-text-secondary': `${PREFIX}color-text-muted`,
  '--yfe-text-tertiary': `${PREFIX}color-text-muted`,
  '--yfe-font-ui': `${PREFIX}font-family`,
  '--yfe-font-size-xs': `${PREFIX}font-size-sm`,
  '--yfe-panel-padding': `${PREFIX}space-md`,
  '--yfe-space-1': `${PREFIX}space-xs`,
  '--yfe-space-2': `${PREFIX}space-sm`,
  '--yfe-space-3': `${PREFIX}space-md`,
  '--yfe-space-4': `${PREFIX}space-lg`,
  '--yfe-layer-dialog': `${PREFIX}layer-dialog`,
  '--yfe-layer-sticky': `${PREFIX}layer-sticky`,
})

/**
 * 主题变量表：规范变量 + 别名变量 + 图谱变量 + `color-scheme`。
 *
 * `color-scheme` 不是 `--yfe-` 变量，但它是浅色/暗色主题的**开关**：
 * 原生滚动条、`<input>` 的默认配色、`prefers-color-scheme` 媒体查询都看它。
 * 旧版写在 CSS 的每个 `[data-theme]` 段里，这里随主题一起产出。
 */
export function themeCssVariables(palette: ThemePalette): Readonly<Record<string, string>> {
  const canonical = tokensToCssVariables(paletteToDesignTokens(palette))
  const variables: Record<string, string> = { ...canonical }

  // 别名指向规范变量的**值**而不是 `var()` 引用：内联变量一旦取值就固定下来，
  // 少一层间接，也避免"别名变量被后来者覆盖成 var(自己)"这种循环。
  for (const [legacy, canonicalName] of Object.entries(LEGACY_VARIABLE_ALIASES)) {
    const value = canonical[canonicalName]
    if (value !== undefined) variables[legacy] = value
  }

  // 图谱/画布变量：SVG 的表现属性（fill=/stroke=）不解析 var()，
  // 所以组件必须写 style={{ fill: 'var(--yfe-graph-node)' }}。
  for (const [key, value] of Object.entries(palette.graph)) {
    variables[`${PREFIX}graph-${kebab(key)}`] = rgbTripleToCss(value as RgbTriple)
  }

  // 墨色刻度本身也导出：面板里的图表/画布会按需取第 5、6 级做渐变，
  // 只给语义色（background/border/text）不够用；旧版同样是全刻度可见的 CSS 变量。
  for (const [key, value] of Object.entries(palette.ink)) {
    variables[`${PREFIX}ink-${kebab(key)}`] = rgbTripleToCss(value as RgbTriple)
  }

  variables[`${PREFIX}accent`] = rgbTripleToCss(palette.accent)
  variables[`${PREFIX}accent-soft`] = rgbTripleToCss(palette.accentSoft)
  variables[`${PREFIX}success`] = rgbTripleToCss(palette.success)
  variables[`${PREFIX}danger`] = rgbTripleToCss(palette.danger)
  variables[`${PREFIX}info`] = rgbTripleToCss(palette.info)
  variables['color-scheme'] = palette.colorScheme
  return Object.freeze(variables)
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}

/** 按主题 id 取变量表；未知 id 回落默认主题（与 `normalizeThemeId` 同口径）。 */
export function themeCssVariablesById(themeId: string): Readonly<Record<string, string>> {
  const id = normalizeThemeId(themeId)
  const palette = findPalette(id) ?? findPalette(DEFAULT_THEME_ID)
  if (palette === null) {
    // 不可能发生：DEFAULT_THEME_ID 一定是表里的成员。留这条是为了让类型收敛，
    // 而不是为了吞错——真走到这里说明配色表被改坏了，返回空表至少不崩。
    return Object.freeze({})
  }
  return themeCssVariables(palette)
}

/** 能被写入内联样式的最小元素接口（`document.documentElement` 满足它）。 */
export interface ThemeHost {
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): void }
  readonly dataset: Record<string, string | undefined>
}

/**
 * 把主题变量写到根节点。
 *
 * 🔴 **必须先清掉上一次写的变量**再写新的：清浅色主题时，若直接覆盖，
 * 上一套主题里存在、新主题里不存在的变量（例如自定义主题派生的色）会留下来，
 * 造成"换到浅色主题但某个边框还是暗色"的鬼影。
 *
 * 只删自己写过的名字（`appliedVariables` 传入上次的返回值），不遍历 `style`
 * ——遍历会把 React/Vue 或宿主自己写的内联变量一起清掉。
 */
export function applyThemeVariables(
  host: ThemeHost,
  variables: Readonly<Record<string, string>>,
  previous: readonly string[] = [],
): readonly string[] {
  for (const name of previous) {
    if (!(name in variables)) host.style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(variables)) {
    host.style.setProperty(name, value)
  }
  return Object.keys(variables)
}

/**
 * `data-theme` 属性与旧版逐字一致。
 *
 * 我们换肤靠内联变量，不靠 CSS 选择器；仍然写这个属性有两个理由：
 * ① 旧版有依赖它的 CSS（滚动条、图谱段），将来迁进来时不用再改结构；
 * ② 调试与自动化测试可以直接读 `<html data-theme>` 判断当前主题，
 *    不必去解析几十个内联变量。
 */
export function applyThemeAttribute(host: ThemeHost, themeId: ConcreteThemeId): void {
  host.dataset['theme'] = themeId
}

/** 可被 `applyThemeAttribute` 接受的 id 集合（`custom` 无配色表，故不在内）。 */
export function isConcreteThemeId(value: string): value is ConcreteThemeId {
  return findPalette(value) !== null
}
