/**
 * 面板注册表的**契约测试**（Lead 独占，钉死 registry.ts 的键与侧栏 id 逐字一致）。
 *
 * 为什么需要这个文件：`registry.ts` 的键是 `TabDef.id`，而 id 是**带连字符或驼峰的混合形态**
 * （`plot-canvas`、`geography-map`、`tavern-card`、`material-library`…）。
 * 曾把 `plot-canvas` 误写成 `plotCanvas`（驼峰）——TypeScript 完全看不出问题
 * （`Record<string, PanelComponent>` 的键是任意 string），构建也通过，
 * 但运行时该面板**永远匹配不上**，静默回落到「尚未接入」占位。
 *
 * 本文件把两边对齐关系写死，任何一边改了 id 而另一边没跟上都会立刻红。
 */

import { describe, expect, it } from 'vitest'

import { EDITOR_TAB, TABS } from '@yfe/schema-tabs'

import {
  PANEL_COMPONENTS,
  registeredPanelIds,
  resolvePanelComponent,
} from '../../src/renderer/panels/registry.js'
import { isDataDrivenTab, panelTabs, SIDEBAR_TABS } from '../../src/renderer/schema/tab-registry.js'

/** 全部可出现在侧栏的 id（55 个：54 页签 + 编辑器）。 */
const ALL_SIDEBAR_IDS: readonly string[] = SIDEBAR_TABS.map((tab) => tab.id)

/** 专属面板 id（非 form/card/table 的那些）。 */
const PANEL_IDS: readonly string[] = panelTabs({ type: 'full', features: [] }).map((tab) => tab.id)

describe('PANEL_COMPONENTS 的键', () => {
  it('每一个键都必须是一个真实存在的侧栏页签 id', () => {
    const unknown = registeredPanelIds().filter((id) => !ALL_SIDEBAR_IDS.includes(id))
    expect(unknown).toEqual([])
  })

  it('数据驱动页签（form/card/table）不得登记专属面板组件', () => {
    const byId = new Map(TABS.map((tab) => [tab.id, tab]))
    const wrong = registeredPanelIds().filter((id) => {
      const tab = byId.get(id)
      return tab !== undefined && isDataDrivenTab(tab)
    })
    expect(wrong).toEqual([])
  })

  it('登记的每个 id 都能解析出非占位组件（不回落占位）', () => {
    for (const id of registeredPanelIds()) {
      expect(resolvePanelComponent(id)).toBe(PANEL_COMPONENTS[id])
    }
  })

  it('未登记的 id 一律回落占位组件（不允许静默空白）', () => {
    const unregistered = PANEL_IDS.filter((id) => !registeredPanelIds().includes(id))
    for (const id of unregistered) {
      expect(resolvePanelComponent(id)).not.toBeUndefined()
    }
    // 完全不存在的 id 也必须给组件，而不是 undefined（外壳直接 <component :is>）
    expect(resolvePanelComponent('definitely-not-a-tab')).not.toBeUndefined()
  })

  it('editor 页签由外壳单独处理，不进 PANEL_COMPONENTS', () => {
    expect(registeredPanelIds()).not.toContain(EDITOR_TAB.id)
  })

  it('已登记 id 列表是排序且无重复的', () => {
    const ids = registeredPanelIds()
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('W7 面板覆盖度', () => {
  /** W7 交付的 21 个专属面板（不含 editor，它由外壳的编辑器宿主实现）。 */
  const W7_PANEL_IDS: readonly string[] = [
    'about',
    'bookbreak',
    'check-tools',
    'creative-writing',
    'dashboard',
    'geography-map',
    'guide',
    'inspire-tools',
    'material-library',
    'model-settings',
    'plot-canvas',
    'tavern-card',
    'tavern-control',
    'tavern-free',
    'tavern-plot',
    'tavern-report',
    'tavern-run',
    'tavern-script',
    'tavern-world',
    'trajectory',
    'worlds',
  ]

  it('W7 的 21 个面板全部已登记', () => {
    const missing = W7_PANEL_IDS.filter((id) => !registeredPanelIds().includes(id))
    expect(missing).toEqual([])
  })

  it('W7 面板 id 与侧栏专属面板 id 集合一致（不多不少）', () => {
    // 侧栏里的专属面板 id 去掉 editor 后，应当与 W7 清单完全相等。
    // 若上游新增了专属页签而没人实现，这里会红——提醒「有新页签但没有面板」。
    const sidebarPanelIds = PANEL_IDS.filter((id) => id !== EDITOR_TAB.id).sort()
    expect(sidebarPanelIds).toEqual([...W7_PANEL_IDS].sort())
  })
})
