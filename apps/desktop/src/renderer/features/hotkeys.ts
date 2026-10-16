/**
 * A-15 全局快捷键（window 级）——对齐上游 `src/lib/app/useSaveHotkey.ts`（46 行）
 * 与 `src/App.tsx:335-345`（Ctrl/Cmd+K 切换全文检索面板）。
 *
 * ## 上游语义（逐字照抄，不许"顺手优化"）
 * · Ctrl/Cmd+S：`!(e.ctrlKey || e.metaKey) || e.altKey` → 忽略；`e.key?.toLowerCase() !== 's'` → 忽略；
 *   命中则 `preventDefault()` 再保存。**shift 不影响**（Ctrl+Shift+S 也算保存意图）。
 * · Ctrl/Cmd+K：`(e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'`（上游**不排除 alt**）→
 *   `preventDefault()` 并切换 `searchOpen`。
 * · 上游只在 `enabled`（通常传 `dirty`）为真时才挂监听——注释原文：「没改动的面板不该吞掉浏览器的『保存网页』」。
 *   故 Ctrl+S 只在有未保存内容时返回动作；Ctrl+K 与改动无关。
 *
 * ## 为什么把判定抽成纯函数
 * 上游是 React hook（自身持 ref + 绑监听）。本仓的窗口监听挂在 `App.vue` 的
 * `onMounted`/`onBeforeUnmount`（与 R-81 的 resize 监听同一处，见 `App.vue:239-247/275-283`），
 * 判定逻辑放这里，测试不必挂组件。
 *
 * ## 🔴 本仓差异（有意，记台账 R-94）
 *   ① 上游 `dirty` 是布尔，本仓保存状态是六态 ⇒ 用 `isSaveHotkeyEnabled()` 折算。
 *   ② 不做输入法合成态判断（上游也不做）。编辑器已聚焦时 `Mod-s` 由 CodeMirror 的
 *      `commandKeys` 先处理并 `preventDefault`，调用方按 `event.defaultPrevented` 跳过，
 *      避免同一次按键存两遍。
 */

/** 快捷键要触发的动作。命名与编辑器命令名（`yfe.draft.flush`）保持一致。 */
export type HotkeyAction = 'draft.flush' | 'search.open'

/**
 * 只取判定需要的四个字段。刻意不写 `KeyboardEvent`：模型要能在无 DOM 的环境里单测，
 * 且 `event.key` 在少数键盘布局下确实是 `undefined`，类型要允许。
 */
export interface HotkeyLike {
  readonly key?: string | undefined
  readonly ctrlKey?: boolean | undefined
  readonly metaKey?: boolean | undefined
  readonly altKey?: boolean | undefined
}

export interface HotkeyContext {
  /** 是否有未保存改动（折算自本仓六态保存状态，见 `isSaveHotkeyEnabled`）。 */
  readonly saveEnabled: boolean
}

/** 本仓六态保存状态（与 `YfeSaveStatus`、`AppSnapshot.saveStatus` 同集）。 */
export type SaveHotkeyStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

export const HOTKEY_SAVE = 'Ctrl / Cmd + S'
export const HOTKEY_SEARCH = 'Ctrl / Cmd + K'

/**
 * 六态 → 「能不能按 Ctrl+S 保存」的折算。
 * · `dirty`：当然算。
 * · `error`：上次保存失败的稿子还在，Ctrl+S 应当**重试**（否则用户只能去点按钮）。
 * · `saving`：已有在途保存，再触发只会被单在途保存挡掉，不拦浏览器默认行为也没意义。
 * · `saved`：无待存内容——上游「没改动的面板不该吞掉保存网页」正是说这一态。
 * · `conflict`：需要用户选边（保留本地 / 采用远端），快捷键不该替他决定。
 * · `offline`：传导层不可达，存了也只会失败报错，留给用户手动重试。
 */
export function isSaveHotkeyEnabled(status: SaveHotkeyStatus): boolean {
  return status === 'dirty' || status === 'error'
}

/** Ctrl 或 Cmd（两者任一即算主修饰键；Alt 单独不算）。 */
export function hasPrimaryModifier(event: HotkeyLike): boolean {
  return event.ctrlKey === true || event.metaKey === true
}

function normalizedKey(event: HotkeyLike): string {
  return typeof event.key === 'string' ? event.key.toLowerCase() : ''
}

/**
 * 判定一次按键要做什么。返回 `null` = 不管（调用方**不得** `preventDefault`，
 * 否则会吞掉浏览器/系统的默认行为，这正是上游注释里那条纪律）。
 */
export function resolveHotkey(event: HotkeyLike, context: HotkeyContext): HotkeyAction | null {
  if (!hasPrimaryModifier(event)) return null
  const key = normalizedKey(event)
  // 上游 Ctrl+K 不看 alt（与 Ctrl+S 的处理不同），照抄。
  if (key === 'k') return 'search.open'
  if (key !== 's') return null
  if (event.altKey === true) return null
  return context.saveEnabled ? 'draft.flush' : null
}

export interface HotkeyEntry {
  readonly action: HotkeyAction
  readonly keys: string
  readonly label: string
  readonly note: string
}

/** 给「设置 / 使用指南 / 关于」页展示的快捷键表（文案中文、与上面判定逐条对应）。 */
export const HOTKEY_ENTRIES: readonly HotkeyEntry[] = Object.freeze([
  Object.freeze({
    action: 'draft.flush' as HotkeyAction,
    keys: HOTKEY_SAVE,
    label: '保存当前草稿',
    note: '仅在确有未保存改动时生效（与「保存」按钮的可用状态同口径）。',
  }),
  Object.freeze({
    action: 'search.open' as HotkeyAction,
    keys: HOTKEY_SEARCH,
    label: '全文检索',
    note: '唤起全文检索面板；再按一次关闭。',
  }),
])

/** 单行展示文案（状态栏 / 提示语用）。 */
export function hotkeySummaryText(): string {
  return HOTKEY_ENTRIES.map((entry) => `${entry.label}：${entry.keys}`).join('　·　')
}