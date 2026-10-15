/**
 * 侧栏与页签路由的**纯逻辑**（W5，Lead 独占）。
 *
 * 旧版把 56 个页签定义（`TABS` 54 ＋ 编辑器 ＋ 内部数据表《地图》）的导航写死在 React 组件树里；
 * 这里改成「元数据 → 视图」的纯函数，好处有三：① 34 个数据驱动页签与 22 个专属面板共用同一套侧栏；
 * ② 能在 Node 环境下单测（不需要真实窗口）；③ 以后加页签只改 `@yfe/schema-tabs`。
 *
 * ## 纪律
 *
 * - 只依赖 `@yfe/schema-tabs`：不 import Vue / DOM / Node / IPC / `@yfe/client-sdk`。
 * - **不读也不缓存 `tab.modules`**：`worldbase`/`power` 与四个制度页签的 `modules` 是 getter
 *   （随题材包变化，见 `docs/接口冻结-渲染层.md` §2）。本模块只搬运 `TabDef` 引用。
 * - 《地图》（`GEO_MAPS_TAB`）是**内部数据表**，不是页签 ⇒ 不进侧栏（增删改都在「地图编辑」页里）。
 */

import { EDITOR_TAB, GROUPS, TABS, getTab, tabVisible } from '@yfe/schema-tabs'
import type { TabDef, TabType, VisCtx } from '@yfe/schema-tabs'

/** 数据驱动的页签类型：这三种由通用渲染器点亮（form 9 / card 6 / table 18＋1）。 */
export const DATA_DRIVEN_TYPES: readonly TabType[] = ['form', 'card', 'table']

export function isDataDrivenTab(tab: TabDef): boolean {
  return DATA_DRIVEN_TYPES.includes(tab.type)
}

/** 侧栏页签全集：`TABS`（54 个）＋ 编辑器页签（《地图》不进侧栏）。 */
export const SIDEBAR_TABS: readonly TabDef[] = [...TABS, EDITOR_TAB]

/** 按 id 查页签（`getTab` 不认编辑器，这里补上；《地图》由 `getTab` 自己认）。 */
export function findTab(tabId: string): TabDef | undefined {
  if (tabId === EDITOR_TAB.id) return EDITOR_TAB
  return getTab(tabId)
}

/** 当前可见性上下文下，侧栏应显示的页签（顺序＝`TABS` 顺序，编辑器在最后）。 */
export function visibleTabs(ctx: VisCtx): TabDef[] {
  return SIDEBAR_TABS.filter((tab) => tabVisible(tab.id, ctx))
}

export interface TabGroupView {
  readonly group: string
  readonly tabs: readonly TabDef[]
}

/**
 * 按 `group` 分桶并**按 `GROUPS` 的顺序**排列。
 *
 * `GROUPS` 之外的组追加在末尾而不是被丢弃 —— W1 以后新增分组时，页签不会静默消失
 * （静默丢页签是这类导航最容易出的错，且没人会发现）。
 */
export function groupTabs(tabs: readonly TabDef[]): TabGroupView[] {
  const byGroup = new Map<string, TabDef[]>()
  for (const tab of tabs) {
    const bucket = byGroup.get(tab.group)
    if (bucket === undefined) byGroup.set(tab.group, [tab])
    else bucket.push(tab)
  }
  const out: TabGroupView[] = []
  for (const group of GROUPS) {
    const bucket = byGroup.get(group)
    if (bucket !== undefined && bucket.length > 0) {
      out.push({ group, tabs: bucket })
      byGroup.delete(group)
    }
  }
  for (const [group, bucket] of byGroup) out.push({ group, tabs: bucket })
  return out
}

export function sidebarGroups(ctx: VisCtx): TabGroupView[] {
  return groupTabs(visibleTabs(ctx))
}

/**
 * 打开应用时的默认页签：**正文编辑**（写作动线的第一站，也是预览版最有用的入口）；
 * 它不可见时退回侧栏第一个可见页签；一个都没有则返回 `null`。
 */
export function defaultTabId(ctx: VisCtx): string | null {
  const tabs = visibleTabs(ctx)
  if (tabs.some((tab) => tab.id === EDITOR_TAB.id)) return EDITOR_TAB.id
  return tabs[0]?.id ?? null
}

/** 专属面板（22 个，W7 逐个实现）——通用渲染器不认的那些类型。 */
export function panelTabs(ctx: VisCtx): TabDef[] {
  return visibleTabs(ctx).filter((tab) => !isDataDrivenTab(tab))
}

export function countByType(tabs: readonly TabDef[], type: TabType): number {
  return tabs.filter((tab) => tab.type === type).length
}
