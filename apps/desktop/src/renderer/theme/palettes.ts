/**
 * 主题配色表（W8 · 外壳设置通道）—— **Lead 独占，其他智能体只读**。
 *
 * 数据来源：旧版 `src/index.css` 的 `[data-theme='…']` 段（第 92–283 行）与
 * `src/lib/settings/theme.ts` 的 `THEMES` 表（第 30–40 行）。数值**逐行照抄**，
 * 不做"美化"：还原原版的第一原则是同一个主题在两版里看起来一样。
 *
 * 为什么不复用 `packages/ui/src/tokens.ts` 的 `designTokens` 当主题：
 * 那是**一套**令牌（深色），而主题是**多套**同构令牌；`tokensToCssVariables()`
 * 已经把「令牌 → CSS 变量」这步做成通用函数，这里只负责产出令牌本身
 * （见 `./index.ts` 的 `paletteToDesignTokens`）。
 *
 * 色标方向（务必记住，否则浅色主题会整体反相）：
 * 每个主题都是 12 级 `ink` 刻度，**950 最深、50 最浅**是暗色系的直觉；
 * 浅色主题里这组刻度整体反过来用（950 最浅当底色、50 最深当文字），
 * 所以映射关系（底色←950、文字←50）在两类主题里都成立，无需分支。
 */

/** 主题 id。`custom` 是派生主题（母版 + 色相微调），本批未实现（见台账 R-80）。 */
export type ThemeId =
  | 'dark'
  | 'eye-care'
  | 'midnight'
  | 'sepia'
  | 'dusk-violet'
  | 'porcelain'
  | 'pine-ink'
  | 'peach-note'
  | 'custom'

/** 实色主题 id（`custom` 除外，它没有固定配色表）。 */
export type ConcreteThemeId = Exclude<ThemeId, 'custom'>

/** 一个 RGB 三元组，分量 0–255。CSS 里写作 `rgb(r g b)`。 */
export type RgbTriple = readonly [number, number, number]

/** 12 级墨色刻度（`ink-950` 到 `ink-50`）。 */
export interface InkScale {
  readonly ink950: RgbTriple
  readonly ink900: RgbTriple
  readonly ink850: RgbTriple
  readonly ink800: RgbTriple
  readonly ink700: RgbTriple
  readonly ink600: RgbTriple
  readonly ink500: RgbTriple
  readonly ink400: RgbTriple
  readonly ink300: RgbTriple
  readonly ink200: RgbTriple
  readonly ink100: RgbTriple
  readonly ink50: RgbTriple
}

/** 一套主题配色。 */
export interface ThemePalette {
  readonly id: ConcreteThemeId
  /** 中文名（设置面板的按钮文案）。 */
  readonly name: string
  /** 一句话说明（`暗夜` / `护眼` 这种短标签）。 */
  readonly desc: string
  /** 色卡底色，给设置面板画小方块用（`custom` 除外，故实色主题才有）。 */
  readonly swatch: string
  readonly colorScheme: 'dark' | 'light'
  readonly ink: InkScale
  /** 强调色（旧版的 `--amber`）。 */
  readonly accent: RgbTriple
  /** 强调色柔化版（旧版的 `--amber-soft`）。 */
  readonly accentSoft: RgbTriple
  /** 语义色（旧版按主题给的是 tailwind 300 级 / 700 级）。 */
  readonly danger: RgbTriple
  readonly success: RgbTriple
  readonly info: RgbTriple
  /** 图谱/画布专用界面色（旧版 `--graph-*`，SVG 里必须走 style 而不是表现属性）。 */
  readonly graph: {
    readonly grid: RgbTriple
    readonly node: RgbTriple
    readonly nodeText: RgbTriple
    readonly label: RgbTriple
    readonly edgeLabel: RgbTriple
    readonly halo: RgbTriple
    readonly accent: RgbTriple
    readonly accentStrong: RgbTriple
    readonly accentText: RgbTriple
  }
}

/** 暗色主题的语义色（旧版 `index.css` 各暗色段逐字相同）。 */
const DARK_SEMANTIC = { danger: [252, 165, 165], success: [110, 231, 183], info: [125, 211, 252] } as const
/** 浅色主题的语义色（旧版用 700 级保对比度）。 */
const LIGHT_SEMANTIC = { danger: [185, 28, 28], success: [21, 128, 61], info: [7, 89, 133] } as const

/**
 * 暗色系的图谱界面色。
 *
 * 旧版在 `:root`（= `[data-theme='dark']`）里写死一组暖褐色，四个浅色主题
 * 另有一段覆盖把它们改成**引用该主题自身的墨色刻度**——因为暖褐在浅底上
 * 对比度几乎为零（标签与网格会看不见）。这里两种都照抄。
 */
const DARK_GRAPH = {
  grid: [87, 83, 78],
  node: [28, 25, 22],
  nodeText: [231, 229, 228],
  label: [214, 199, 161],
  edgeLabel: [168, 155, 140],
  halo: [21, 18, 14],
  accent: [251, 191, 36],
  accentStrong: [245, 158, 11],
  accentText: [244, 194, 102],
} as const

/**
 * 浅色主题的图谱界面色：`--ink-600/800/50/200/300/900` + `--amber` 的引用。
 *
 * 旧版写的是 `var(--ink-600)` 这种引用；浅色主题里 ink 刻度是反的，于是
 * 「node→ink-800、文字→ink-50」自动翻成「浅底 + 深字」。这里在 JS 侧解析成实色，
 * 效果等价且不依赖 CSS 变量解析顺序。
 */
function lightGraph(ink: InkScale, accent: RgbTriple, accentSoft: RgbTriple): ThemePalette['graph'] {
  return {
    grid: ink.ink600,
    node: ink.ink800,
    nodeText: ink.ink50,
    label: ink.ink200,
    edgeLabel: ink.ink300,
    halo: ink.ink900,
    accent,
    accentStrong: accent,
    accentText: accentSoft,
  }
}

const DARK_THEMES: readonly ThemePalette[] = [
  {
    id: 'dark',
    name: '暗夜',
    desc: '深色',
    swatch: '#121218',
    colorScheme: 'dark',
    ink: {
      ink950: [12, 12, 15],
      ink900: [18, 18, 24],
      ink850: [23, 23, 34],
      ink800: [29, 29, 41],
      ink700: [50, 50, 72],
      ink600: [74, 74, 106],
      ink500: [98, 98, 134],
      ink400: [121, 121, 163],
      ink300: [142, 142, 181],
      ink200: [181, 181, 212],
      ink100: [216, 216, 234],
      ink50: [238, 238, 248],
    },
    accent: [217, 160, 74],
    accentSoft: [232, 184, 109],
    ...DARK_SEMANTIC,
    graph: DARK_GRAPH,
  },
  {
    id: 'midnight',
    name: '午夜蓝',
    desc: '冷蓝·深色',
    swatch: '#1a2740',
    colorScheme: 'dark',
    ink: {
      ink950: [10, 14, 26],
      ink900: [15, 22, 38],
      ink850: [20, 29, 48],
      ink800: [26, 39, 64],
      ink700: [39, 54, 84],
      ink600: [58, 79, 120],
      ink500: [83, 108, 152],
      ink400: [125, 151, 194],
      ink300: [169, 192, 224],
      ink200: [206, 221, 242],
      ink100: [230, 238, 251],
      ink50: [243, 247, 255],
    },
    accent: [90, 169, 214],
    accentSoft: [140, 200, 235],
    ...DARK_SEMANTIC,
    graph: DARK_GRAPH,
  },
  {
    id: 'dusk-violet',
    name: '暮山紫',
    desc: '紫罗兰·深色',
    swatch: '#100d1a',
    colorScheme: 'dark',
    ink: {
      ink950: [16, 13, 26],
      ink900: [24, 19, 38],
      ink850: [32, 25, 50],
      ink800: [41, 32, 63],
      ink700: [59, 47, 88],
      ink600: [87, 69, 127],
      ink500: [116, 93, 164],
      ink400: [142, 118, 191],
      ink300: [164, 145, 204],
      ink200: [198, 185, 228],
      ink100: [224, 217, 244],
      ink50: [241, 238, 252],
    },
    accent: [167, 139, 250],
    accentSoft: [196, 175, 255],
    ...DARK_SEMANTIC,
    graph: DARK_GRAPH,
  },
  {
    id: 'pine-ink',
    name: '松烟墨',
    desc: '墨绿松烟·深色',
    swatch: '#0a1212',
    colorScheme: 'dark',
    ink: {
      ink950: [10, 18, 18],
      ink900: [15, 26, 26],
      ink850: [20, 34, 34],
      ink800: [26, 44, 43],
      ink700: [35, 60, 58],
      ink600: [51, 87, 84],
      ink500: [73, 117, 113],
      ink400: [98, 143, 138],
      ink300: [128, 170, 165],
      ink200: [172, 205, 200],
      ink100: [210, 232, 228],
      ink50: [235, 246, 244],
    },
    accent: [94, 214, 190],
    accentSoft: [134, 230, 212],
    ...DARK_SEMANTIC,
    graph: DARK_GRAPH,
  },
]

const LIGHT_THEMES: readonly ThemePalette[] = [
  {
    id: 'eye-care',
    name: '护眼',
    desc: '浅绿·默认·护眼',
    swatch: '#cfe3c4',
    colorScheme: 'light',
    ink: {
      ink950: [230, 240, 224],
      ink900: [241, 246, 236],
      ink850: [233, 241, 226],
      ink800: [238, 244, 233],
      ink700: [196, 205, 189],
      ink600: [158, 170, 149],
      ink500: [122, 142, 110],
      ink400: [91, 114, 79],
      ink300: [86, 112, 73],
      ink200: [60, 82, 48],
      ink100: [43, 58, 34],
      ink50: [28, 39, 22],
    },
    accent: [68, 118, 78],
    accentSoft: [99, 140, 91],
    ...LIGHT_SEMANTIC,
    graph: undefined as never,
  },
  {
    id: 'sepia',
    name: '羊皮卷',
    desc: '暖棕·浅色',
    swatch: '#e3d4b8',
    colorScheme: 'light',
    ink: {
      ink950: [239, 230, 214],
      ink900: [246, 239, 226],
      ink850: [240, 231, 214],
      ink800: [243, 236, 222],
      ink700: [208, 196, 175],
      ink600: [177, 161, 134],
      ink500: [150, 131, 99],
      ink400: [121, 101, 70],
      ink300: [111, 90, 60],
      ink200: [79, 63, 40],
      ink100: [58, 46, 28],
      ink50: [39, 29, 16],
    },
    accent: [142, 93, 49],
    accentSoft: [157, 120, 80],
    ...LIGHT_SEMANTIC,
    graph: undefined as never,
  },
  {
    id: 'porcelain',
    name: '青花',
    desc: '青白瓷·浅色',
    swatch: '#e4ecf4',
    colorScheme: 'light',
    ink: {
      ink950: [228, 236, 244],
      ink900: [242, 247, 252],
      ink850: [234, 241, 248],
      ink800: [238, 244, 250],
      ink700: [194, 205, 217],
      ink600: [154, 170, 188],
      ink500: [120, 140, 163],
      ink400: [87, 108, 134],
      ink300: [74, 99, 128],
      ink200: [52, 74, 99],
      ink100: [34, 52, 74],
      ink50: [20, 33, 50],
    },
    accent: [45, 100, 165],
    accentSoft: [80, 135, 195],
    ...LIGHT_SEMANTIC,
    graph: undefined as never,
  },
  {
    id: 'peach-note',
    name: '桃笺',
    desc: '暖粉胭脂·浅色',
    swatch: '#faecee',
    colorScheme: 'light',
    ink: {
      ink950: [250, 238, 238],
      ink900: [253, 245, 245],
      ink850: [250, 240, 241],
      ink800: [252, 246, 245],
      ink700: [218, 199, 200],
      ink600: [190, 161, 164],
      ink500: [165, 129, 134],
      ink400: [141, 98, 105],
      ink300: [140, 88, 96],
      ink200: [110, 66, 74],
      ink100: [84, 47, 55],
      ink50: [60, 32, 39],
    },
    accent: [178, 63, 93],
    accentSoft: [205, 100, 127],
    ...LIGHT_SEMANTIC,
    graph: undefined as never,
  },
]

/** 八个实色主题，**顺序即设置面板里的展示顺序**（照抄旧版 `THEMES`）。 */
export const THEME_PALETTES: readonly ThemePalette[] = Object.freeze([
  ...DARK_THEMES,
  ...LIGHT_THEMES,
].map((palette) =>
  Object.freeze({
    ...palette,
    graph: palette.colorScheme === 'light' ? lightGraph(palette.ink, palette.accent, palette.accentSoft) : palette.graph,
  }),
))

/** 旧版 `getStoredTheme()` 的兜底值：存储被清 / 值非法时回**护眼**而不是黑屏。 */
export const DEFAULT_THEME_ID: ConcreteThemeId = 'eye-care'

/** 按 id 取配色；未知 id 返回 `null`（调用方决定回落策略）。 */
export function findPalette(id: string): ThemePalette | null {
  return THEME_PALETTES.find((palette) => palette.id === id) ?? null
}

/**
 * 把任意存储值收敛成合法主题 id。
 *
 * 脏 localStorage 可能存任何东西（`null` / 数字 / 别的软件留下的键），
 * 这里一律回落到默认主题，绝不抛错——一个配色问题不该让界面起不来。
 */
export function normalizeThemeId(value: unknown): ConcreteThemeId {
  if (typeof value !== 'string') return DEFAULT_THEME_ID
  return findPalette(value)?.id ?? DEFAULT_THEME_ID
}
