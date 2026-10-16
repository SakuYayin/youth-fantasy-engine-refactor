/**
 * 界面设置存储（W8 · 外壳设置通道）—— **Lead 独占，其他智能体只读**。
 *
 * 存储媒介是 **`localStorage`**，不是 `settings_entities`：主题、缩放、字体、
 * 侧栏宽度这些是「这台机器上这个人的界面习惯」，跟人不跟作品 —— 上游
 * `src/lib/settings/{theme,fontPrefs,uiPrefs}.ts` 也是这么放的，键名**逐字照抄**：
 *
 * | 键 | 内容 | 上游出处 |
 * | --- | --- | --- |
 * | `yfe-theme` | 主题 id（含 `custom`） | `theme.ts:45` |
 * | `yfe-ui-zoom` | 缩放百分比字符串 | `theme.ts:46` |
 * | `yfe-ui-zoom-manual` | `'1'`=手动，`'0'`=跟随窗口 | `theme.ts:48` |
 * | `yfe-font-prefs` | `{editor,ui}` 字体栈段 JSON | `fontPrefs.ts:25` |
 * | `yfe-sidebar-w` | 侧栏宽度 px | `Sidebar.tsx:96` |
 * | `yfe-ui:sidebar-collapsed-groups` | 折叠分组 id 数组 JSON | `uiPrefs.ts:23,57` |
 * | `yfe-ui:dock-collapsed` | 左下角工具栏是否收起 | `Sidebar.tsx:65` |
 *
 * 照抄键名有两个实打实的好处：老用户的数据能直接续用（迁移只用换壳），
 * 出问题时可以拿旧版行为逐字对拍。代价是这些名字不符合我们的命名习惯，认了。
 *
 * 🔴 **一条铁律：读存储绝不抛异常。** 便携版是 `file://` 打开的单文件，
 * 某些浏览器/隐私模式下 `localStorage` 一读就抛 `SecurityError`；上游为此专门
 * 写了 `safeGet`。这里所有读取都走 `safeRead`，异常一律当"没有存过"。
 *
 * 纯逻辑与 IO 分开：所有函数收一个 `SettingsStorage` 接口，测试用内存实现，
 * 不必依赖 happy-dom 的 localStorage（虽然它也满足该接口）。
 */

import type { AppSettingsView } from './types.js'

import { DEFAULT_THEME_ID, normalizeThemeId } from '../theme/palettes.js'
import {
  autoZoomForWidth,
  clampZoom,
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
} from '../theme/zoom.js'

/** `localStorage` 的最小可用接口（`window.localStorage` 与测试假实现都满足）。 */
export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 存储键（**逐字**，勿"整理"）：见文件头表格。 */
export const SETTINGS_KEYS = Object.freeze({
  theme: 'yfe-theme',
  zoom: 'yfe-ui-zoom',
  zoomManual: 'yfe-ui-zoom-manual',
  fontPrefs: 'yfe-font-prefs',
  sidebarWidth: 'yfe-sidebar-w',
  collapsedGroups: 'yfe-ui:sidebar-collapsed-groups',
  dockCollapsed: 'yfe-ui:dock-collapsed',
})

/** 侧栏宽度：上游 `useResizable({initial:224, initialWide:300, min:200, max:560})`。 */
export const SIDEBAR_WIDTH = Object.freeze({ initial: 224, wide: 300, min: 200, max: 560 })
/** 屏宽达到该值视为大屏，默认用 `SIDEBAR_WIDTH.wide`。上游 `useResizable.ts:16`。 */
export const WIDE_SCREEN_THRESHOLD = 2000

/** 正文字号可选档（设置面板的下拉项）。上游正文用 `font-serif` 栈 + 独立字号控件。 */
export const FONT_SIZE_OPTIONS: readonly string[] = Object.freeze([
  '14px',
  '15px',
  '16px',
  '17px',
  '18px',
  '20px',
  '22px',
])

/** 字号范围（防止脏存储把正文撑爆布局）。 */
const MIN_FONT_SIZE_PX = 12
const MAX_FONT_SIZE_PX = 32

/** 字体预置清单，**逐字**照抄上游 `fontPrefs.ts:36-45`（含显示名与栈段）。 */
export const PRESET_FONTS: readonly { readonly name: string; readonly stack: string }[] =
  Object.freeze([
    { name: '思源宋体（默认正文）', stack: '"思源宋体", "Noto Serif SC", "Source Han Serif SC"' },
    { name: '思源黑体（默认界面）', stack: '"思源黑体", "Noto Sans SC", "Source Han Sans SC"' },
    { name: '宋体', stack: '"宋体", SimSun, NSimSun' },
    { name: '楷体', stack: '"楷体", "KaiTi", STKaiti' },
    { name: '仿宋', stack: '"仿宋", "FangSong", STFangsong' },
    { name: '黑体', stack: '"黑体", SimHei' },
    { name: '微软雅黑', stack: '"微软雅黑", "Microsoft YaHei"' },
    { name: '霞鹜文楷', stack: '"霞鹜文楷", "LXGW WenKai"' },
  ])

/**
 * 清洗用户自定义输入的字体栈。
 *
 * 🔴 这是 **CSS 注入面**：`setProperty('--font-editor', value)` 的值里一个 `;`
 * 就能截断成另一条声明（`"楷体"; background: url(...)`）。上游
 * `fontPrefs.ts:52-55` 只保留家族名合法字符，这里逐字照抄同一张白名单
 * （中英文、数字、空白、逗号、引号、连字符、下划线、点，以及全角标点）。
 *
 * 洗完为空 = 无效输入，调用方按「跟随默认」处理（写空串 = 不写变量）。
 */
export function sanitizeFontStack(input: string): string {
  const cleaned = (input ?? '').replace(
    /[^0-9A-Za-z\u4e00-\u9fff\u3000-\u303f，。、""''\s,.\-_'"-]/g,
    '',
  )
  return cleaned.trim()
}

/** 从字体栈段提取展示名：`'"楷体", KaiTi'` → `'楷体'`。 */
export function fontStackLabel(stack: string): string {
  const first = (stack ?? '').split(',')[0]?.trim() ?? ''
  return first.replace(/^["']|["']$/g, '')
}

/** 安全读；任何异常（隐私模式 `SecurityError`、配额）都当"没存过"。 */
export function safeRead(storage: SettingsStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/** 安全写；失败静默（记不住习惯不该打断写作）。返回是否写入成功。 */
export function safeWrite(storage: SettingsStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemove(storage: SettingsStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // 同上：删不掉不影响正确性（下次读到脏值会被收窄）。
  }
}

/** 读主题（未知/脏值回落 `eye-care`，与上游 `getStoredTheme()` 同口径）。 */
export function readThemeId(storage: SettingsStorage): string {
  return normalizeThemeId(safeRead(storage, SETTINGS_KEYS.theme))
}

/** 写主题。`custom` 也允许写入（派生主题的参数另有键，见台账 R-80）。 */
export function writeThemeId(storage: SettingsStorage, themeId: string): boolean {
  return safeWrite(storage, SETTINGS_KEYS.theme, themeId)
}

/**
 * 缩放是否「跟随窗口」。
 *
 * 上游语义（`upstream/src/lib/settings/theme.ts:173-175`）：
 * `isZoomAuto() { return safeGet(ZOOM_MANUAL_KEY) !== '1' }` —— **缺省即自动**，
 * 只有用户真的手动调过（键值为 `'1'`）才算手动。
 *
 * 🔴 这里曾经写成 `=== '0'`（缺省 = 手动），与上游**正好相反**：新用户首启时
 * 「跟随窗口」复选框不被勾选、`resetAppSettings()` 之后也被推回手动模式，
 * 而按窗口宽度自适应的 132% 之类舒适值从来不会生效。
 * 上游测试可作证：`upstream/tests/themeZoom.test.ts:43` 断言未手动指定时
 * `getStoredZoom() === 132`（走 `autoZoom()`）。
 */
export function isZoomAuto(storage: SettingsStorage): boolean {
  return safeRead(storage, SETTINGS_KEYS.zoomManual) !== '1'
}

/** 读手动缩放值；无值/脏值/超界都回落 `null`（调用方改用自动值）。 */
export function readManualZoom(storage: SettingsStorage): number | null {
  const raw = safeRead(storage, SETTINGS_KEYS.zoom)
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  if (value < MIN_ZOOM_PERCENT || value > MAX_ZOOM_PERCENT) return null
  return Math.round(value)
}

/**
 * 写缩放。`manual: true` 表示用户手动调过（此后不再自动适配），
 * `false` 表示切回「跟随窗口」；`undefined` 只改值不动模式（启动时用）。
 */
export function writeZoom(storage: SettingsStorage, percent: number, manual?: boolean): number {
  const zoomPercent = clampZoom(percent)
  safeWrite(storage, SETTINGS_KEYS.zoom, String(zoomPercent))
  if (manual !== undefined) safeWrite(storage, SETTINGS_KEYS.zoomManual, manual ? '1' : '0')
  return zoomPercent
}

/** 取当前应生效的缩放：手动值优先，否则按窗口宽度自动适配。 */
export function resolveZoom(storage: SettingsStorage, windowWidth: number): number {
  if (isZoomAuto(storage)) return autoZoomForWidth(windowWidth)
  return readManualZoom(storage) ?? autoZoomForWidth(windowWidth)
}

/** 读侧栏宽度；脏值/超界回落「大屏 300 / 否则 224」。 */
export function readSidebarWidth(storage: SettingsStorage, windowWidth: number): number {
  const fallback =
    windowWidth >= WIDE_SCREEN_THRESHOLD ? SIDEBAR_WIDTH.wide : SIDEBAR_WIDTH.initial
  const raw = safeRead(storage, SETTINGS_KEYS.sidebarWidth)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  if (value < SIDEBAR_WIDTH.min || value > SIDEBAR_WIDTH.max) return fallback
  return Math.round(value)
}

/** 写侧栏宽度（先收敛到 [200,560]）。 */
export function writeSidebarWidth(storage: SettingsStorage, width: number): number {
  const clamped = clampSidebarWidth(width)
  safeWrite(storage, SETTINGS_KEYS.sidebarWidth, String(clamped))
  return clamped
}

/** 侧栏宽度收敛（拖拽时每帧调用，必须是纯函数）。 */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.initial
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)))
}

/**
 * 读折叠分组。
 *
 * 上游把无效项**逐项过滤**而不是整表丢弃（`uiPrefs.ts:30-32`），这里同口径：
 * 一个脏元素不该让用户其他分组的折叠状态一起丢。
 */
export function readCollapsedGroups(storage: SettingsStorage): readonly string[] {
  const raw = safeRead(storage, SETTINGS_KEYS.collapsedGroups)
  if (raw === null) return Object.freeze([])
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Object.freeze([])
  }
  if (!Array.isArray(parsed)) return Object.freeze([])
  const ids = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return Object.freeze([...new Set(ids)])
}

/** 写折叠分组（数组 JSON，与上游 `uiPrefs` 的序列化形式一致）。 */
export function writeCollapsedGroups(storage: SettingsStorage, groupIds: readonly string[]): boolean {
  return safeWrite(storage, SETTINGS_KEYS.collapsedGroups, JSON.stringify([...new Set(groupIds)]))
}

/** 左下角工具栏是否收起（默认展开）。 */
export function readDockCollapsed(storage: SettingsStorage): boolean {
  return safeRead(storage, SETTINGS_KEYS.dockCollapsed) === '1'
}

export function writeDockCollapsed(storage: SettingsStorage, collapsed: boolean): boolean {
  return safeWrite(storage, SETTINGS_KEYS.dockCollapsed, collapsed ? '1' : '0')
}

/** 读字体偏好；脏数据逐字段收窄（非字符串/超长一律回默认，上游 `fontPrefs.ts:69`）。 */
export function readFontPrefs(storage: SettingsStorage): { editor: string; ui: string } {
  const raw = safeRead(storage, SETTINGS_KEYS.fontPrefs)
  if (raw === null) return Object.freeze({ editor: '', ui: '' })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return Object.freeze({ editor: '', ui: '' })
  }
  if (typeof parsed !== 'object' || parsed === null) return Object.freeze({ editor: '', ui: '' })
  const record = parsed as Record<string, unknown>
  return Object.freeze({
    editor: narrowFontStack(record['editor']),
    ui: narrowFontStack(record['ui']),
  })
}

function narrowFontStack(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (value.length > 200) return ''
  return sanitizeFontStack(value)
}

/** 写字体偏好（写入前清洗，避免脏串进 CSS 变量）。 */
export function writeFontPrefs(
  storage: SettingsStorage,
  prefs: { editor: string; ui: string },
): boolean {
  return safeWrite(
    storage,
    SETTINGS_KEYS.fontPrefs,
    JSON.stringify({ editor: sanitizeFontStack(prefs.editor), ui: sanitizeFontStack(prefs.ui) }),
  )
}

/**
 * 正文字号：存在 `yfe-font-prefs` 的兄弟键里。
 *
 * 上游正文字号是编辑器内部状态（不在 `fontPrefs` 里）；我们把它也做成应用级偏好，
 * 键名沿用同族前缀 `yfe-editor-font-size`，避免和上游的 `yfe-font-prefs` 语义混淆。
 */
export const EDITOR_FONT_SIZE_KEY = 'yfe-editor-font-size'

export function readEditorFontSize(storage: SettingsStorage): string {
  const raw = safeRead(storage, EDITOR_FONT_SIZE_KEY)
  if (raw === null) return DEFAULT_EDITOR_FONT_SIZE
  return normalizeFontSize(raw)
}

export function writeEditorFontSize(storage: SettingsStorage, value: string): string {
  const size = normalizeFontSize(value)
  safeWrite(storage, EDITOR_FONT_SIZE_KEY, size)
  return size
}

export const DEFAULT_EDITOR_FONT_SIZE = '16px'

/** 字号收敛：非法值 → 默认；超界 → 夹到边界（`'200px'` 不该撑爆正文栏）。 */
export function normalizeFontSize(value: string): string {
  const px = Number.parseFloat(value)
  if (!Number.isFinite(px)) return DEFAULT_EDITOR_FONT_SIZE
  const clamped = Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, px))
  return `${Math.round(clamped)}px`
}

/**
 * 一次性读出完整设置视图。
 *
 * `windowWidth` 由调用方传（`window.innerWidth`），不在这里读全局 ——
 * 这样自动缩放与侧栏宽度的"大屏判定"可以在测试里逐值驱动。
 */
export function readAppSettings(storage: SettingsStorage, windowWidth: number): AppSettingsView {
  const fontPrefs = readFontPrefs(storage)
  return Object.freeze({
    themeId: readThemeId(storage),
    fontFamily: fontPrefs.editor === '' ? null : fontPrefs.editor,
    fontSize: readEditorFontSize(storage),
    zoomPercent: resolveZoom(storage, windowWidth),
    zoomManual: !isZoomAuto(storage),
    sidebarWidth: readSidebarWidth(storage, windowWidth),
    collapsedGroups: readCollapsedGroups(storage),
  })
}

/**
 * 应用一个设置补丁并返回新视图。
 *
 * 每个字段走自己的键，**互不影响**：改主题不该顺手把缩放模式重置成手动。
 * 未知字段被忽略（`Partial<AppSettingsView>` 只声明了七个字段，多传的键无对应分支）。
 */
export function saveAppSettings(
  storage: SettingsStorage,
  patch: Partial<AppSettingsView>,
  windowWidth: number,
): AppSettingsView {
  if (patch.themeId !== undefined) writeThemeId(storage, normalizeThemeId(patch.themeId))
  if (patch.zoomPercent !== undefined) {
    const manual = patch.zoomManual ?? true
    writeZoom(storage, patch.zoomPercent, manual)
  } else if (patch.zoomManual === false) {
    // 只切模式（"跟随窗口"）：值仍写一份，免得下次读手动值时拿到陈旧数字。
    const current = resolveZoom(storage, windowWidth)
    writeZoom(storage, current, false)
  }
  if (patch.sidebarWidth !== undefined) writeSidebarWidth(storage, patch.sidebarWidth)
  if (patch.collapsedGroups !== undefined) writeCollapsedGroups(storage, patch.collapsedGroups)
  if (patch.fontFamily !== undefined) {
    const prefs = readFontPrefs(storage)
    writeFontPrefs(storage, {
      editor: patch.fontFamily === null ? '' : patch.fontFamily,
      ui: prefs.ui,
    })
  }
  if (patch.fontSize !== undefined) writeEditorFontSize(storage, patch.fontSize)
  return readAppSettings(storage, windowWidth)
}

/** 清掉全部设置键（设置面板的「恢复默认」）。 */
export function resetAppSettings(storage: SettingsStorage): void {
  for (const key of Object.values(SETTINGS_KEYS)) safeRemove(storage, key)
  safeRemove(storage, EDITOR_FONT_SIZE_KEY)
}

/** 默认主题 id（设置面板在无存储值时高亮的那一个），供测试断言复用。 */
export const DEFAULT_SETTINGS_THEME_ID = DEFAULT_THEME_ID
