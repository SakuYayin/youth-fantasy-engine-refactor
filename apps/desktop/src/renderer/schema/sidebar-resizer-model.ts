/**
 * A-10 侧栏宽度拖拽手柄 —— **纯逻辑**（零 DOM、零 localStorage、零 IPC、零 store 依赖）。
 *
 * 上游真源：`U\src\lib\app\useResizable.ts:23-65`（拖拽换算）+ `U\src\components\app\Sidebar.tsx:96,154-159`
 * （参数 `{key:'yfe-sidebar-w', initial:224, initialWide:300, min:200, max:560, side:'right'}` 与手柄 DOM）。
 *
 * 为什么换算要单独成文件：
 * 1. `useResizable` 里那段 `Math.min(max, Math.max(min, startSize + delta))` 是**唯一**有行为的算式，
 *    留在 `.vue` 里就只能靠指针事件测；抽出来后可对边界（NaN / ±Infinity / 浮点 / zoom）逐条钉死。
 * 2. 组件只 emit，不落库：`yfe-sidebar-w` 的读写仍在 `features/settings-store.ts`（Lead 独占），
 *    所以这里**刻意不 import** 它 —— 用同值的本地常量，由 `sidebar-resizer-model.test.ts` 断言两者相等防漂移。
 *
 * 与上游的三处**有意差异**（都在下面的常量/函数注释里标注了原因）：
 * - 上游 `setSize` 收浮点宽度；这里一律 `Math.round`，与 `settings-store.ts:215 clampSidebarWidth` 的取整同口径。
 * - 上游 `useResizable` 没有键盘、没有双击复位（见文件末尾说明）；键盘/复位是本实现的**新增契约**。
 * - 上游 `onDragStart` 直接 `e.preventDefault()`；这里只调 `preventDefault`，不引入 React 事件对象。
 */

/** 上游 `yfe-sidebar-w` 的三档数值：`Sidebar.tsx:96` 的 `initial/initialWide/min/max`。
 *  与 `features/settings-store.ts:58 SIDEBAR_WIDTH` 同值（测试里有相等断言，改一边就会红）。 */
export const SIDEBAR_RESIZER_DEFAULTS = Object.freeze({ initial: 224, wide: 300, min: 200, max: 560 })

/** 屏宽达到该值视为大屏（上游 `useResizable.ts:16 WIDE_THRESHOLD`）。
 *  仅作说明用：**大屏默认宽走 `readSidebarWidth`**（`settings-store.ts:196-205`），
 *  手柄本身不猜窗口宽度 —— 组件的 `initial` prop 由父层传入，缺省时回落到 224。 */
export const RESIZER_WIDE_SCREEN_THRESHOLD = 2000

/** 键盘步进（像素）。上游 `useResizable.ts` **没有任何键盘支持**（全文只有 mousemove/mouseup），
 *  所以这个值是本实现选的：10px ≈ 手感上「按一下动一格」，且能被 `max-min=360` 整除。 */
export const RESIZER_KEYBOARD_STEP = 10

/** 拖拽边：`'right'` = 向右拖增大（侧栏在左时的手柄在右边），`'left'` = 向左拖增大。 */
export type ResizerSide = 'left' | 'right'

/** 收敛后的合法区间（`min <= max`，都是有限数）。 */
export interface ResizerLimits {
  readonly min: number
  readonly max: number
}

/** 手柄提示文案，**逐字**照抄上游 `Sidebar.tsx:158 title="拖拽调整侧栏宽度"`。 */
export const RESIZER_TITLE = '拖拽调整侧栏宽度'

/** 无障碍名：比 `title` 多说明键盘与双击（上游没有这两条能力，属于新增交互，必须在名字里讲清楚）。 */
export const RESIZER_ARIA_LABEL = '拖拽调整侧栏宽度（方向键微调，Home 最小，End 最大，双击复位）'

/** 拖拽输入。`zoom` 对应上游从 `<html>` 读到的界面缩放（`useResizable.ts:53`）。 */
export interface ResizerDragInput {
  /** 按下时侧栏的宽度（上游 `startSize.current`）。 */
  readonly startWidth: number
  /** 按下时的指针横坐标（上游 `startX.current`）。 */
  readonly startX: number
  /** 当前帧的指针横坐标。 */
  readonly clientX: number
  readonly min?: number
  readonly max?: number
  readonly side?: ResizerSide
  /** 界面缩放倍率（`<html>` 的 zoom）。上游用 `Number(style.zoom) || 1` 兜脏值。 */
  readonly zoom?: number
  readonly disabled?: boolean
}

/** 键盘输入。 */
export interface ResizerKeyboardOptions {
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly disabled?: boolean
}

/** 纯区间输入（复位 / aria 用）。 */
export interface ResizerRangeOptions {
  readonly min?: number
  readonly max?: number
}

/**
 * 把可选参数收敛成合法区间。
 *
 * 三件脏事都必须吞掉而不是抛：缺省、非有限数、`min > max` 写反。
 * 写反时**交换**而不是丢弃 —— 丢弃会让 `Math.max(min, ...)` 得到 NaN 宽度，侧栏直接塌成 0。
 */
export function resolveLimits(min?: number, max?: number): ResizerLimits {
  const lo = typeof min === 'number' && Number.isFinite(min) ? min : SIDEBAR_RESIZER_DEFAULTS.min
  const hi = typeof max === 'number' && Number.isFinite(max) ? max : SIDEBAR_RESIZER_DEFAULTS.max
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo }
}

/**
 * 宽度收敛到 `[min,max]` 的**整数**像素。
 *
 * - `NaN` → `fallback`（`fallback` 本身也不可用时回落 224）。这是「不产生新宽度」的唯一表达：
 *   调用方拿到的一定是能直接设进 `style.width` 的数。
 * - `±Infinity` → 自然落到 `max` / `min`（`Math.round(Infinity)` 仍是 Infinity，夹取生效），不抛。
 * - 取整：上游拖拽把浮点宽度直接塞进 state（`useResizable.ts:56`），这里与
 *   `settings-store.ts:215 clampSidebarWidth` 的 `Math.round` 对齐 —— 一个 223.99999 写进
 *   `yfe-sidebar-w` 再读回来会被判定超界而回落默认值，风格不统一会很难查。
 */
export function clampWidth(value: number, limits: ResizerLimits, fallback: number): number {
  const { min, max } = resolveLimits(limits.min, limits.max)
  const safe = Number.isNaN(value)
    ? Number.isFinite(fallback)
      ? fallback
      : SIDEBAR_RESIZER_DEFAULTS.initial
    : value
  return Math.min(max, Math.max(min, Math.round(safe)))
}

/**
 * 指针位移 → 新宽度。**这是上游 `useResizable.ts:52-57` 的等价物**：
 *
 * ```ts
 * const z = Number(document.documentElement.style.zoom) || 1
 * const dx = (ev.clientX - startX.current) / z
 * const delta = side === 'right' ? dx : -dx
 * setSize(Math.min(max, Math.max(min, startSize.current + delta)))
 * ```
 *
 * 返回 `null` 表示「本次不产生新宽度」（`disabled`，或算不出可用值）——
 * 组件据此跳过 emit，父层就不会把脏值写进 `yfe-sidebar-w`。
 */
export function dragWidth(input: ResizerDragInput): number | null {
  if (input.disabled === true) return null
  const limits = resolveLimits(input.min, input.max)
  // 上游 `Number(...) || 1`：0 / NaN / 负数一律当 1，否则位移会被除成 Infinity 或反向。
  const zoom =
    typeof input.zoom === 'number' && Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1
  const dx = (input.clientX - input.startX) / zoom
  const delta = input.side === 'left' ? -dx : dx
  const fallback = clampWidth(input.startWidth, limits, SIDEBAR_RESIZER_DEFAULTS.initial)
  return clampWidth(input.startWidth + delta, limits, fallback)
}

/**
 * 键盘 → 新宽度（**上游没有对应实现**，属新增契约）。
 *
 * `ArrowLeft` 减 10、`ArrowRight` 加 10（`role="separator"` 的惯例：左小右大），
 * `Home` 直接到 `min`、`End` 到 `max`；其它键返回 `null`（不拦截，让事件继续冒泡）。
 * 只看左右不含 `side` —— 手柄在自己的坐标系里，「左=变小」对用户才是直觉的。
 */
export function keyboardWidth(
  current: number,
  key: string,
  options: ResizerKeyboardOptions = {},
): number | null {
  if (options.disabled === true) return null
  const limits = resolveLimits(options.min, options.max)
  const step =
    typeof options.step === 'number' && Number.isFinite(options.step) && options.step > 0
      ? options.step
      : RESIZER_KEYBOARD_STEP
  const base = clampWidth(current, limits, SIDEBAR_RESIZER_DEFAULTS.initial)
  switch (key) {
    case 'ArrowLeft':
      return clampWidth(base - step, limits, base)
    case 'ArrowRight':
      return clampWidth(base + step, limits, base)
    case 'Home':
      return limits.min
    case 'End':
      return limits.max
    default:
      return null
  }
}

/**
 * 双击复位的目标宽度：`initial`（缺省 224，上游 `yfe-sidebar-w` 的 initial）。
 *
 * 上游**没有双击复位**（`Sidebar.tsx:154-159` 的手柄只绑了 `onMouseDown`）；
 * 这里仍按 `initial` 夹进区间，避免父层传入的 `initial` 落在 `[min,max]` 之外时把侧栏设成非法宽度。
 */
export function resetWidth(initial?: number, options: ResizerRangeOptions = {}): number {
  const limits = resolveLimits(options.min, options.max)
  const raw =
    typeof initial === 'number' && Number.isFinite(initial) ? initial : SIDEBAR_RESIZER_DEFAULTS.initial
  return clampWidth(raw, limits, SIDEBAR_RESIZER_DEFAULTS.initial)
}

/** `aria-valuenow`：把 `width` prop 收敛成区间内的整数（脏 props 不能在无障碍树里报出超界值）。 */
export function ariaValueNow(width: number, options: ResizerRangeOptions = {}): number {
  return clampWidth(width, resolveLimits(options.min, options.max), SIDEBAR_RESIZER_DEFAULTS.initial)
}

/** 是否允许交互（`disabled` 为 `true` 时才冻结；`undefined` 视为可用）。 */
export function isResizeEnabled(disabled?: boolean): boolean {
  return disabled !== true
}