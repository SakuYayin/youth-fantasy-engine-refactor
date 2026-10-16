/**
 * 侧栏分组折叠的**纯逻辑**（A-09）。
 *
 * ## 为什么记忆的是「已折叠」而不是「已展开」
 *
 * 逐字照抄上游 `_upstream_tmp/youth-fantasy-engine-main/src/components/app/Sidebar.tsx:53-57` 的判断：
 * 以后新增分组时，老用户记录里没有它 → 落回默认值（展开）；反之（记「已展开」）新分组一上来就是收起的，很别扭。
 * 首次安装（无记录）＝空集合＝全部分组展开。
 *
 * ## 职责边界
 *
 * 只做集合运算：不碰 `localStorage`、不 import Vue / DOM / Node / IPC。
 * 持久化由父层负责（`features/settings-store.ts:226-243`，键 `yfe-ui:sidebar-collapsed-groups`），
 * 组件只经 props 收、经 emit 报（`docs/接口冻结-W8外壳.md` §0.5）。
 */

/**
 * 折叠图标字符（上游用 lucide `ChevronDown`，折叠时加 `-rotate-90`；
 * 这里用纯文本等价物：展开 ▾ / 折叠 ▸，无需新增依赖）。
 */
export const SIDEBAR_GROUP_ICON = Object.freeze({ expanded: '▾', collapsed: '▸' })

/** 该折叠态对应的组头图标字符。 */
export function sidebarGroupIcon(collapsed: boolean): string {
  return collapsed ? SIDEBAR_GROUP_ICON.collapsed : SIDEBAR_GROUP_ICON.expanded
}

/**
 * 把 props 传进来的折叠集合收敛成查表用的 `Set`。
 *
 * 脏数据**逐项过滤**（非字符串、空串）而不是整表丢弃 —— 与持久化层
 * `settings-store.ts:236` 的 `readCollapsedGroups` 同口径：一个脏元素不该
 * 让用户其他分组的折叠状态一起失效。缺省（`undefined`）＝ 空集合 ＝ 全部展开。
 */
export function collapsedGroupSet(collapsedGroups?: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>()
  if (collapsedGroups === undefined) return out
  for (const group of collapsedGroups) {
    if (typeof group === 'string' && group.length > 0) out.add(group)
  }
  return out
}

/** 某个分组是否处于折叠态（缺省 props ＝ 未折叠）。 */
export function isGroupCollapsed(collapsedGroups: readonly string[] | undefined, group: string): boolean {
  return collapsedGroupSet(collapsedGroups).has(group)
}

/**
 * 折叠状态取反后的**新数组**（供父层写回设置用）。
 *
 * - 原本已折叠 → 从集合移除；原本展开 → 追加。
 * - 顺序：保留原顺序，新增项追加在末尾（与上游 `Sidebar.tsx:140-146` 用 `Set` 的迭代序一致）。
 * - 已存在/不存在都**不会**产生重复项。
 * - 空串 key 是非法分组名（`collapsedGroupSet` 会过滤掉），因此对其取反是 no-op。
 */
export function toggleCollapsedGroup(
  collapsedGroups: readonly string[] | undefined,
  group: string,
): string[] {
  const next = [...collapsedGroupSet(collapsedGroups)]
  // 非法分组名（空串）：直接原样返回，不往设置里塞垃圾。
  if (group.length === 0) return next
  const index = next.indexOf(group)
  if (index >= 0) next.splice(index, 1)
  else next.push(group)
  return next
}