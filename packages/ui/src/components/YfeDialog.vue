<script setup lang="ts">
/**
 * 确认对话框（ADR 0006 D3）。
 *
 * 必须成立的两条（ADR 写死）：Esc 关闭、焦点陷阱。做法：
 * - 监听挂在 `document` 上而不是对话框根节点：焦点被浏览器挪到别处时 Esc 也得管用；
 * - Tab / Shift+Tab 在对话框内的可聚焦元素间循环，并且**始终** `preventDefault`，
 *   不让焦点跑到背后的编辑器里；
 * - `open=false` 时 `v-if` 整块不渲染，同时摘掉 document 监听。
 *
 * 刻意不用 `Teleport`：渲染层可能在 Electron 窗口里嵌多个根，弹层放在原位、
 * 用 `position: fixed` 覆盖即可，也免得测试与被裁剪的容器斗智。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { designTokenVariables } from '../tokens.js'
import YfeButton from './YfeButton.vue'

const props = defineProps<{
  open: boolean
  title: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'normal' | 'danger'
}>()

const emit = defineEmits<{ confirm: []; cancel: [] }>()

/**
 * `cancelLabel` 未传时的兜底文案。ADR D3 只规定「文案归属」（状态文案归
 * `YfeStatusPill`），没给这个默认值，这里取最短的通用词。
 */
const DEFAULT_CANCEL_LABEL = '取消'

/**
 * 标题关联用的 id：模块级计数器而不是全局 `useId`，免得为一行 id 依赖新 API，
 * 也保证同页两个对话框不会撞 id。
 */
let dialogSeq = 0
const titleId = `yfe-dialog-title-${(dialogSeq += 1)}`

const rootRef = ref<HTMLElement | null>(null)

/** 焦点陷阱的候选：对话框内所有可聚焦控件（取消、确认…）。 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function focusables(): readonly HTMLElement[] {
  const root = rootRef.value
  if (root === null) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

function onKeydown(event: KeyboardEvent): void {
  if (props.open !== true) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return

  const items = focusables()
  if (items.length === 0) return

  const current = items.indexOf(document.activeElement as HTMLElement)
  const step = event.shiftKey ? -1 : 1
  const next =
    current === -1
      ? // 焦点已在对话框外：Tab 从第一个进、Shift+Tab 从最后一个进。
        event.shiftKey
        ? items.length - 1
        : 0
      : (current + step + items.length) % items.length

  event.preventDefault()
  items[next]?.focus()
}

function attach(): void {
  document.addEventListener('keydown', onKeydown)
}

/** 打开即接管焦点：否则后台编辑器还在收键盘输入。 */
function takeFocus(): void {
  focusables()[0]?.focus()
}

function detach(): void {
  document.removeEventListener('keydown', onKeydown)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      attach()
      // flush:'post' 保证这是渲染之后——此刻按钮已经在 DOM 里。
      takeFocus()
    } else {
      detach()
    }
  },
  { immediate: true, flush: 'post' },
)

// 挂载时就是 open 的那条路径：带 immediate 的 watcher 在首次渲染**之前**就跑了，
// 那时 `rootRef` 还是 null、拿不到按钮。mounted 之后（post-flush 队列）再取一次。
onMounted(() => {
  if (props.open) takeFocus()
})

onBeforeUnmount(detach)
</script>

<template>
  <div v-if="open" class="yfe-dialog__overlay" :style="designTokenVariables" data-role="overlay">
    <div
      ref="rootRef"
      class="yfe-dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :data-tone="tone ?? 'normal'"
    >
      <h2 :id="titleId" class="yfe-dialog__title">{{ title }}</h2>
      <div class="yfe-dialog__actions">
        <YfeButton
          :label="cancelLabel ?? DEFAULT_CANCEL_LABEL"
          variant="ghost"
          data-role="cancel"
          @click="emit('cancel')"
        />
        <YfeButton
          :label="confirmLabel"
          :variant="tone === 'danger' ? 'danger' : 'primary'"
          data-role="confirm"
          @click="emit('confirm')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.yfe-dialog__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--yfe-layer-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--yfe-space-xl);
  background: var(--yfe-color-overlay);
}

.yfe-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg);
  min-width: 320px;
  max-width: 480px;
  padding: var(--yfe-space-lg);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border-strong);
  border-radius: var(--yfe-radius-lg);
  background: var(--yfe-color-surface-raised);
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
  /* 这里原本有 box-shadow，但阴影色/模糊半径在令牌里没有位置（ADR 只列到五组，
     我先补的 size 组也放不下颜色），写死就是硬约束里禁的「魔法色值」。
     先靠 border-strong + 遮罩拉开层次；令牌补 shadow 位后再加回来。 */
}

.yfe-dialog__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg);
  font-weight: var(--yfe-font-weight-bold);
}

.yfe-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--yfe-space-sm);
}
</style>
