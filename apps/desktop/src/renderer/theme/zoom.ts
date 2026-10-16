/**
 * 界面缩放（W8 · 外壳设置通道）—— **Lead 独占，其他智能体只读**。
 *
 * 照抄旧版 `src/lib/settings/theme.ts:166-216` 的语义，一个细节都不省：
 *
 * 1. **范围 [80,160]，四舍五入到整数**（`Math.round`，不是 `trunc`）——
 *    旧版设置面板的「− / +」按 10 步进，但存储里的脏值可能是 87；
 *    `round` 让 87.4 与 87.5 落到不同格，与旧版逐字一致。
 * 2. **`<html>` 上写 `zoom`**（不是 `transform: scale`）：`zoom` 会真正改变
 *    布局尺寸，`transform` 只做视觉缩放、鼠标命中位置会错位。
 * 3. 🔴 **必须同时写 `--ui-zoom` CSS 变量**：`zoom` **不缩放 `vh`/`vw`**。
 *    旧版 `index.css` 的 `.h-screen{height:calc(100vh/var(--ui-zoom))}` 靠它把
 *    视口单位折回来；少了这一步，缩放 132% 时主容器比窗口高、底部被裁掉。
 *    我们的 `App.vue` 也用 `calc(100vh / var(--ui-zoom, 1))`。
 * 4. **自动适配**（跟随窗口）与「手动值」是两个存储键：`autoZoom()` 在有手动值时
 *    不参与（`isZoomAuto()` 读 `yfe-ui-zoom-manual`）。设置面板显示「跟随窗口」时
 *    用户看到的数字是自动算出来的，不是存下来的。
 *
 * 纯函数与副作用分开：`clampZoom` / `autoZoomForWidth` 可在 node 环境测试，
 * `applyZoom` 才碰 `document`。这条分界让缩放逻辑不必依赖 happy-dom 才能验证。
 */

import type { AppSettingsView } from '../features/types.js'

/** 缩放下限（百分比）。旧版 `applyZoom` 的 `Math.max(80, …)`。 */
export const MIN_ZOOM_PERCENT = 80
/** 缩放上限（百分比）。旧版 `applyZoom` 的 `Math.min(160, …)`。 */
export const MAX_ZOOM_PERCENT = 160
/** 设置面板「− / +」的步进。 */
export const ZOOM_STEP_PERCENT = 10
/** 自动适配的基准宽度：1280px 时 100%。 */
const AUTO_BASE_WIDTH = 1280
/** 自动适配每宽 40px 加 1%。 */
const AUTO_WIDTH_PER_PERCENT = 40
/** 自动适配的上限（比手动上限低：自动只为了「宽屏不浪费」，不该缩得比 140% 更狠）。 */
const AUTO_MAX_PERCENT = 140

/**
 * 把任意数值收敛到 [80,160] 的整数。
 *
 * `NaN`/`Infinity` 回落到 100：脏存储里 `Number('')` = 0 或 `Number('abc')` = NaN
 * 都会走到这里，回落到 100 比回落到下限 80 更符合"看不出问题"的预期。
 */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return 100
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(percent)))
}

/**
 * 按窗口宽度算自动缩放：1280 宽 = 100%，更宽则每 40px 加 1%，上限 140%。
 *
 * 宽度异常（0 / NaN，例如在未布局的窗口里调用）按 1280 处理 ⇒ 100%。
 */
export function autoZoomForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 100
  const raw = Math.round(100 + (width - AUTO_BASE_WIDTH) / AUTO_WIDTH_PER_PERCENT)
  return Math.min(AUTO_MAX_PERCENT, Math.max(100, raw))
}

/** 「−」按钮：不许越过下限（返回同一个值而不是 80 以外的数）。 */
export function zoomOut(current: number): number {
  return clampZoom(clampZoom(current) - ZOOM_STEP_PERCENT)
}

/** 「+」按钮。 */
export function zoomIn(current: number): number {
  return clampZoom(clampZoom(current) + ZOOM_STEP_PERCENT)
}

/** 缩放是否已在上/下限（设置面板据此禁用按钮）。 */
export function isZoomAtMin(current: number): boolean {
  return clampZoom(current) <= MIN_ZOOM_PERCENT
}

export function isZoomAtMax(current: number): boolean {
  return clampZoom(current) >= MAX_ZOOM_PERCENT
}

/** 能被 `applyZoom` 写入的最小宿主接口。 */
export interface ZoomHost {
  readonly style: { zoom: string; setProperty(name: string, value: string): void }
}

/**
 * 把缩放写进 DOM。
 *
 * 返回实际写入的整数百分比 —— 调用方必须用**返回值**更新自己的显示状态，
 * 不能拿自己传进来的那个数当结果（`clampZoom` 可能改过它；旧版 `applyZoom`
 * 同样返回收敛后的值，设置面板显示的正是返回值）。
 */
export function applyZoom(host: ZoomHost, percent: number): number {
  const zoomPercent = clampZoom(percent)
  const factor = String(zoomPercent / 100)
  host.style.zoom = factor
  // 见文件头第 3 条：vh/vw 不随 zoom 缩放，靠这个变量折回来。
  host.style.setProperty('--ui-zoom', factor)
  return zoomPercent
}

/**
 * 当前生效的界面缩放系数（1 = 100%）。
 *
 * 旧版从 CSS 变量读（"避免与 localStorage 不同步"）；我们同样以 DOM 为准：
 * 设置面板在缩放被自动重算后要显示新数字，若各自读存储就会显示旧值。
 * 宿主没有该变量时按 1 处理。
 */
export function currentZoomFactor(host: { readonly style: { getPropertyValue(name: string): string } }): number {
  const raw = host.style.getPropertyValue('--ui-zoom')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/** 把主题/设置里的缩放字段与 DOM 对齐（启动时调用一次）。 */
export function zoomPercentOf(settings: Pick<AppSettingsView, 'zoomPercent'>): number {
  return clampZoom(settings.zoomPercent)
}
