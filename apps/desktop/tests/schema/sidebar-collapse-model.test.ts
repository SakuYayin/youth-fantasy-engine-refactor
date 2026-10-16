/**
 * A-09 · `sidebar-collapse-model.ts` 纯逻辑测试（Node 环境，不挂 DOM）。
 *
 * 覆盖三件事：① 缺省/脏数据的收敛口径（与 `settings-store.ts::readCollapsedGroups` 一致）；
 * ② `toggleCollapsedGroup` 的取反语义（父层写回设置用，必须保序、去重、不改入参）；
 * ③ 图标字符映射（上游 `ChevronDown` + `-rotate-90` 的文本等价物）。
 */
import { describe, expect, it } from 'vitest'

import {
  SIDEBAR_GROUP_ICON,
  collapsedGroupSet,
  isGroupCollapsed,
  sidebarGroupIcon,
  toggleCollapsedGroup,
} from '../../src/renderer/schema/sidebar-collapse-model.js'

describe('sidebar-collapse-model · 折叠集合收敛', () => {
  it('缺省（undefined）＝ 空集合 ＝ 全部展开', () => {
    expect([...collapsedGroupSet(undefined)]).toEqual([])
    expect(isGroupCollapsed(undefined, '世界构建')).toBe(false)
  })

  it('脏数据逐项过滤：非字符串与空串丢弃，好数据保留', () => {
    const dirty = ['世界构建', '', 42, null, undefined, '酒馆模式'] as unknown as readonly string[]
    expect([...collapsedGroupSet(dirty)]).toEqual(['世界构建', '酒馆模式'])
    expect(isGroupCollapsed(dirty, '世界构建')).toBe(true)
    expect(isGroupCollapsed(dirty, '')).toBe(false)
  })

  it('重复项收敛为一项（Set 语义）', () => {
    expect([...collapsedGroupSet(['世界构建', '世界构建', '世界构建'])]).toEqual(['世界构建'])
  })

  it('组名精确匹配：a/b 不会牵连 a 或 a/b/c（无前缀匹配）', () => {
    const collapsed = ['a/b']
    expect(isGroupCollapsed(collapsed, 'a')).toBe(false)
    expect(isGroupCollapsed(collapsed, 'a/b')).toBe(true)
    expect(isGroupCollapsed(collapsed, 'a/b/c')).toBe(false)
  })
})

describe('sidebar-collapse-model · toggleCollapsedGroup', () => {
  it('展开的组 → 追加在末尾折叠', () => {
    expect(toggleCollapsedGroup(['世界构建'], '酒馆模式')).toEqual(['世界构建', '酒馆模式'])
    expect(toggleCollapsedGroup(undefined, '酒馆模式')).toEqual(['酒馆模式'])
  })

  it('已折叠的组 → 移除且保持其余顺序', () => {
    expect(toggleCollapsedGroup(['正文写作', '世界构建', '酒馆模式'], '世界构建')).toEqual([
      '正文写作',
      '酒馆模式',
    ])
  })

  it('反复取反不产生重复项', () => {
    const once = toggleCollapsedGroup([], '世界构建')
    const twice = toggleCollapsedGroup(once, '世界构建')
    expect(twice).toEqual([])
  })

  it('纯函数：不改入参（父层可以把 props 数组直接传进来）', () => {
    const input = ['世界构建']
    toggleCollapsedGroup(input, '酒馆模式')
    expect(input).toEqual(['世界构建'])
  })

  it('空串 key 是非法组名：取反是 no-op', () => {
    expect(toggleCollapsedGroup(['世界构建'], '')).toEqual(['世界构建'])
  })
})

describe('sidebar-collapse-model · 图标', () => {
  it('展开 ▾ / 折叠 ▸（上游 ChevronDown 旋转的文本等价物）', () => {
    expect(SIDEBAR_GROUP_ICON).toEqual({ expanded: '▾', collapsed: '▸' })
    expect(sidebarGroupIcon(false)).toBe('▾')
    expect(sidebarGroupIcon(true)).toBe('▸')
  })
})