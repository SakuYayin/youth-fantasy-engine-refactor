<script setup lang="ts">
/**
 * A-10 侧栏宽度拖拽手柄（新文件；**接线由 Lead 在 `App.vue` 完成**）。
 *
 * 还原对象：上游 `Sidebar.tsx:148-159`（`<aside>` 右缘那条 `w-1 cursor-col-resize` 的透明细条，
 * `onMouseDown={sidebar.onDragStart}`、`title="拖拽调整侧栏宽度"`）+ `useResizable.ts:42-65` 的拖拽换算。
 *
 * 契约（照 `A-10` 冻结，别改签名）：
 * - props `{ width, min?, max?, initial?, disabled? }`；emits `{ resize:[width], reset:[width] }`。
 * - **拖拽期间只 emit `resize`**，不落库：`yfe-sidebar-w` 的写入是父层的事
 *   （Lead 在 `App.vue` 里调 `saveAppSettings`），组件内**不碰 localStorage**（接口冻结 §0 铁律 5）。
 * - 键盘/双击/指针收尾是本版**明确要求**的能力（上游只有鼠标拖拽）。
 *
 * 三条测试用心的实现细节：
 * 1. `pointermove/up/cancel` 挂在 `window` 上（上游也是 window），因为指针常常移出手柄；
 *    `pointerup`/`pointercancel`/**组件卸载**三条路径都必须摘掉监听，否则 happy-dom 里
 *    「卸载后 pointermove」会打到已销毁的组件上。
 * 2. `setPointerCapture` 走 `typeof === 'function'` + `try/catch` 双守卫：happy-dom 有这个方法但
 *    并非所有 DOM 实现都完整（真的浏览器里指针已失效时也会抛 `NotFoundError`）。
 *    这是**刻意的可测性妥协** —— 抓取失败只是失去「指针移出窗口仍收事件」的便利，拖拽照常工作。
 * 3. `pointerdown` 里 `preventDefault()`：上游同款（`useResizable.ts:43`），用来压掉浏览器默认的
 *    文本选中/原生拖拽。按 Pointer Events 规范 §11.2，被取消的 `pointerdown` 只抑制
 *    `mousedown/mousemove/mouseup/dragstart` 这些**兼容鼠标事件**，`click`/`dblclick` 不受影响 ——
 *    所以双击复位不会被这一行按死。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import {
  ariaValueNow,
  dragWidth,
  isResizeEnabled,
  keyboardWidth,
  resetWidth,
  resolveLimits,
  RESIZER_ARIA_LABEL,
  RESIZER_TITLE,
  type ResizerSide,
} from './sidebar-resizer-model.js'

const props = defineProps<{
  /** 当前宽度（px）。父层是唯一真相源，拖拽时每帧回写。 */
  readonly width: number
  readonly min?: number
  readonly max?: number
  /** 双击复位目标；缺省 224（上游 `Sidebar.tsx:96` 的 `initial`）。 */
  readonly initial?: number
  readonly disabled?: boolean
}>()

const emit = defineEmits<{
  readonly resize: [width: number]
  readonly reset: [width: number]
}>()

/** 手柄在侧栏**右**缘：向右拖 = 变宽（上游 `Sidebar.tsx:96 side:'right'`）。 */
const SIDE: ResizerSide = 'right'

const limits = computed(() => resolveLimits(props.min, props.max))
const valueNow = computed(() => ariaValueNow(props.width, { min: props.min, max: props.max }))

/** 手柄元素：`setPointerCapture` 与 `releasePointerCapture` 都需要真实 DOM 节点。 */
const handle = ref<HTMLElement | null>(null)

/** 拖拽起点（`null` = 未在拖）。对应上游的两个 `useRef`：`startX` / `startSize`。 */
const dragStartX = ref<number | null>(null)
const dragStartWidth = ref(0)

/** 活动指针 id；`null` 表示当前环境没给出 id（happy-dom 之外的某些实现）。 */
let activePointerId: number | null = null

/** 上游 `useResizable.ts:53`：`Number(document.documentElement.style.zoom) || 1`（脏值一律当 1）。 */
function readHtmlZoom(): number {
  const raw = Number(document.documentElement.style.zoom)
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

/** 拖拽中：位移 → 新宽度 → emit `resize`（每帧一次；换算与夹取都在 model 里）。 */
function onPointerMove(event: PointerEvent): void {
  const startX = dragStartX.value
  if (startX === null) return
  const next = dragWidth({
    startWidth: dragStartWidth.value,
    startX,
    clientX: event.clientX,
    min: props.min,
    max: props.max,
    side: SIDE,
    zoom: readHtmlZoom(),
    disabled: props.disabled,
  })
  if (next === null) return
  emit('resize', next)
}

/**
 * 收尾：摘监听 + 释放指针抓取 + 清拖拽态。
 * 同时充当 `pointerup` / `pointercancel` 的处理器与卸载清理函数（幂等，重复调用无副作用）。
 */
function stopDrag(): void {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
  const el = handle.value
  if (el !== null && activePointerId !== null && typeof el.hasPointerCapture === 'function') {
    try {
      if (el.hasPointerCapture(activePointerId)) el.releasePointerCapture(activePointerId)
    } catch {
      /* 指针已失效：忽略，拖拽态照样清 */
    }
  }
  activePointerId = null
  dragStartX.value = null
}

function onPointerDown(event: PointerEvent): void {
  if (!isResizeEnabled(props.disabled)) return
  // 只响应主键（触摸/笔的 `button` 也是 0）；右键/中键不应开始拖拽。
  if (typeof event.button === 'number' && event.button !== 0) return
  event.preventDefault()
  if (typeof event.pointerId === 'number') activePointerId = event.pointerId
  dragStartX.value = event.clientX
  dragStartWidth.value = props.width
  const el = handle.value
  if (el !== null && activePointerId !== null && typeof el.setPointerCapture === 'function') {
    try {
      el.setPointerCapture(activePointerId)
    } catch {
      /* 抓取失败不影响拖拽（监听在 window 上） */
    }
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
}

/** 键盘微调（上游没有）：左右 ±10px，`Home`/`End` 到两端，其它键不拦。 */
function onKeyDown(event: KeyboardEvent): void {
  const next = keyboardWidth(props.width, event.key, {
    min: props.min,
    max: props.max,
    disabled: props.disabled,
  })
  if (next === null) return
  event.preventDefault() // Home/End 默认会滚动容器
  emit('resize', next)
}

/** 双击复位：emit `reset` 并带上 `initial`（上游没有这个交互，是契约新增项）。 */
function onDoubleClick(): void {
  if (!isResizeEnabled(props.disabled)) return
  emit('reset', resetWidth(props.initial, { min: props.min, max: props.max }))
}

// 卸载即收尾：否则窗口监听会留在 happy-dom 里，下一次 pointermove 打到已销毁的组件上。
onBeforeUnmount(stopDrag)
</script>

<template>
  <div
    ref="handle"
    class="sidebar-resizer"
    role="separator"
    aria-orientation="vertical"
    :aria-label="RESIZER_ARIA_LABEL"
    :title="RESIZER_TITLE"
    :aria-valuenow="valueNow"
    :aria-valuemin="limits.min"
    :aria-valuemax="limits.max"
    :aria-disabled="props.disabled === true ? 'true' : undefined"
    :tabindex="props.disabled === true ? -1 : 0"
    data-testid="sidebar-resizer"
    @pointerdown="onPointerDown"
    @dblclick="onDoubleClick"
    @keydown="onKeyDown"
  />
</template>

<style scoped>
/*
 * 自成一格的**分隔条**：作为 `.app__body`（`display:flex`）的 flex 项插在 `<aside class="app__side">` 右边。
 * 这样接线**不需要改 `App.vue` 的样式**，也不必依赖 `<aside>` 是不是 `position: relative`。
 * 上游那条手柄是 `absolute` 叠在侧栏右缘的透明条（`Sidebar.tsx:154-157`）；这里花 6px 版面换「零耦合」。
 */
.sidebar-resizer {
  /*
   * 触摸必须由拖拽接管：不加这条，移动端/触控板的滚动手势会抢走 pointermove。
   * （上游是纯鼠标手柄，没有这条；`role="separator"` 的可拖拽惯例也要求它。）
   */
  touch-action: none;
  flex: 0 0 auto;
  align-self: stretch;
  width: 6px;
  cursor: col-resize;
  background: var(--yfe-color-border, #262a33);
  /* 压在选择区之上，避免被正文的 hover 盖住 */
  z-index: 1;
  transition: background-color 120ms ease;
}

.sidebar-resizer:hover {
  background: var(--yfe-color-accent, #5aa9ff);
}

.sidebar-resizer:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
  outline-offset: -1px;
}

.sidebar-resizer[aria-disabled='true'] {
  cursor: not-allowed;
  background: var(--yfe-color-border, #262a33);
}
</style>