/**
 * 侧栏注册表与页签分组的单元测试（W5，Lead）。
 *
 * 这一层是「52 个页签能不能都在侧栏出现、顺序对不对」的唯一把关点 ——
 * 真窗口 `--gui-check` 只能看到当前那一个页签，盖不住漏页签。
 */
import { describe, expect, it } from 'vitest'

import { EDITOR_TAB, GEO_MAPS_TAB, GROUPS, TABS, tabVisible } from '@yfe/schema-tabs'
import type { VisCtx } from '@yfe/schema-tabs'

import {
  DATA_DRIVEN_TYPES,
  SIDEBAR_TABS,
  countByType,
  defaultTabId,
  findTab,
  groupTabs,
  isDataDrivenTab,
  panelTabs,
  sidebarGroups,
  visibleTabs,
} from '../src/renderer/schema/tab-registry.js'

const FULL: VisCtx = { type: 'full', features: [] }
const CUSTOM_EMPTY: VisCtx = { type: 'custom', features: [] }

describe('侧栏页签注册表', () => {
  it('侧栏＝TABS ＋ 编辑器，且《地图》不进侧栏', () => {
    expect(SIDEBAR_TABS.length).toBe(TABS.length + 1)
    expect(SIDEBAR_TABS.filter((tab) => tab.id === EDITOR_TAB.id)).toHaveLength(1)
    expect(SIDEBAR_TABS.some((tab) => tab.id === GEO_MAPS_TAB.id)).toBe(false)
    // 《地图》仍是可路由的页签（由地图编辑入口打开），只是不在侧栏
    expect(findTab(GEO_MAPS_TAB.id)?.id).toBe(GEO_MAPS_TAB.id)
  })

  it('页签 id 全局唯一', () => {
    const ids = SIDEBAR_TABS.map((tab) => tab.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('完整项目下全部页签可见', () => {
    expect(visibleTabs(FULL)).toHaveLength(SIDEBAR_TABS.length)
  })

  it('TABS＝54：上游 schemaTabs 的 50 个静态项 + 4 个制度页签（运行时展开）', () => {
    // 上游 part1 里 `...INSTITUTION_TABS.map(institutionTab)` 展开出 politics/economy/belief/justice，
    // 所以「静态 grep 数 type: 'form' 得到 5」是错的 —— 实际 9 个 form 页签。
    expect(TABS).toHaveLength(54)
  })

  it('数据驱动页签 34 个（含不进侧栏的《地图》）：form 9 / card 6 / table 18+1', () => {
    const visible = visibleTabs(FULL)
    const mapsExtra = isDataDrivenTab(GEO_MAPS_TAB) ? 1 : 0
    expect(visible.filter(isDataDrivenTab).length + mapsExtra).toBe(34)
    expect(countByType(visible, 'form')).toBe(9)
    expect(countByType(visible, 'card')).toBe(6)
    expect(countByType(visible, 'table')).toBe(18)
    expect(GEO_MAPS_TAB.type).toBe('table')
    expect(DATA_DRIVEN_TYPES).toEqual(['form', 'card', 'table'])
  })

  it('分组顺序＝GROUPS 顺序，且不漏页签', () => {
    const groups = sidebarGroups(FULL)
    expect(groups.length).toBeGreaterThan(5)
    expect(groups.every((view) => GROUPS.includes(view.group))).toBe(true)
    const positions = groups.map((view) => GROUPS.indexOf(view.group))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(groups.flatMap((view) => view.tabs)).toHaveLength(SIDEBAR_TABS.length)
  })

  it('未登记在 GROUPS 里的分组追加在末尾，而不是被丢掉', () => {
    const groups = groupTabs([{ ...EDITOR_TAB, group: '未来分组' }])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.group).toBe('未来分组')
    expect(groups[0]?.tabs).toHaveLength(1)
  })

  it('正文编辑在「正文写作」组，且是默认页签', () => {
    const editorGroup = sidebarGroups(FULL).find((view) => view.tabs.some((tab) => tab.id === EDITOR_TAB.id))
    expect(editorGroup?.group).toBe('正文写作')
    expect(defaultTabId(FULL)).toBe(EDITOR_TAB.id)
  })

  it('自定义项目只显示锁定项：8 个可见、比完整项目少、编辑器仍在', () => {
    const visible = visibleTabs(CUSTOM_EMPTY).map((tab) => tab.id)
    expect(visible).toHaveLength(8)
    expect(visible.length).toBeLessThan(SIDEBAR_TABS.length)
    expect(visible.every((id) => tabVisible(id, CUSTOM_EMPTY))).toBe(true)
    expect(visible).toContain(EDITOR_TAB.id)
    expect(defaultTabId(CUSTOM_EMPTY)).toBe(EDITOR_TAB.id)
  })

  it('专属面板 22 个，与数据驱动页签互补（合计 56＝54 TABS ＋ 编辑器 ＋《地图》）', () => {
    const visible = visibleTabs(FULL)
    const driven = visible.filter(isDataDrivenTab).length
    expect(driven).toBe(33)
    expect(panelTabs(FULL)).toHaveLength(22)
    expect(driven + panelTabs(FULL).length).toBe(SIDEBAR_TABS.length)
    expect(driven + (isDataDrivenTab(GEO_MAPS_TAB) ? 1 : 0) + panelTabs(FULL).length).toBe(56)
  })

  it('未知页签 id 返回 undefined，不抛错', () => {
    expect(findTab('不存在的页签')).toBeUndefined()
    expect(findTab('')).toBeUndefined()
  })
})
