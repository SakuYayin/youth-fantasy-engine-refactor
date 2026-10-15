// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 「素材资料」面板挂载测试（`material-library.vue`，tab.id = `material-library`，
 * 分组 = 灵感工具）。
 *
 * 验证运行时接线：
 * - 页签元数据（标题=页签名、副标题=页签描述）正确渲染；
 * - 分类筛选 + 关键词搜索 + 条目列表 + 展开 / 收起交互；
 * - 「复制」成功 / 失败（含剪贴板不可用）两条反馈路径；
 * - 组件不读 `state`（挂载桩被读取时抛错）；
 * - 可见文本 ⊆ 页签文案 ∪ material-data.ts 常量（接口冻结 §6 验收 2）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type { AppState } from '../../src/renderer/app-state.js'
import {
  filterMaterial,
  MATERIAL_CATEGORIES,
  MATERIAL_ITEMS,
  MATERIAL_UI_COPY,
} from '../../src/renderer/panels/material-data.js'
import type { MaterialItem } from '../../src/renderer/panels/material-data.js'
import MaterialLibrary from '../../src/renderer/panels/material-library.vue'

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

/**
 * material-library 是静态素材页，不读 `state`：`getSnapshot` 被调用就抛错，
 * 挂载一旦失败测试即红。用最小桩而非真客户端（不需要起 RendererClientPort）。
 */
const STATE_STUB = {
  getSnapshot(): never {
    throw new Error('material-library 面板是静态素材页，不得读取 state')
  },
  subscribe(): () => void {
    return () => {}
  },
} as unknown as AppState

/** 侧栏 `TABS` 里真实的 material-library 页签（单一来源），缺失即抛错。 */
function materialTab(): TabDef {
  const tab = getTab('material-library')
  if (tab === undefined) {
    throw new Error('侧栏 TABS 里没有 material-library 页签（schema-tabs 缺口）')
  }
  return tab
}

const MATERIAL_TAB: TabDef = materialTab()

function mountView(overrides: Partial<ViewProps> = {}) {
  const props: ViewProps = { state: STATE_STUB, tab: MATERIAL_TAB, ...overrides }
  return mount(MaterialLibrary, { props })
}

/** 首个素材条目（测试引用；数组为空即抛错，不依赖索引访问的严格性配置）。 */
function firstItem(): MaterialItem {
  const first = MATERIAL_ITEMS[0]
  if (first === undefined) {
    throw new Error('MATERIAL_ITEMS 为空（数据文件缺口）')
  }
  return first
}

/** 复制按钮的桩：给 navigator 一个可控 clipboard。 */
const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
})

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('「素材资料」面板', () => {
  it('渲染页签元数据：标题=页签名、副标题=页签描述、data-tab-id=页签 id', () => {
    const wrapper = mountView()
    const root = wrapper.get('[data-testid="material-panel"]')
    expect(root.element).toBeDefined()
    expect(root.attributes('data-tab-id')).toBe('material-library')
    expect(wrapper.get('.material__title').text()).toBe(MATERIAL_TAB.name)
    expect(wrapper.get('.material__desc').text()).toBe(MATERIAL_TAB.description)
  })

  it('分类筛选按钮：「全部」+ 五大分类按顺序渲染', () => {
    const wrapper = mountView()
    const buttons = wrapper.findAll('[data-testid^="material-category-"]')
    expect(buttons.map((button) => button.text())).toEqual([
      MATERIAL_UI_COPY.categoryAllLabel,
      ...MATERIAL_CATEGORIES.map((category) => category.name),
    ])
  })

  it('默认显示全部条目与计数行', () => {
    const wrapper = mountView()
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(MATERIAL_ITEMS.length)
    expect(wrapper.get('[data-testid="material-count"]').text()).toBe(
      MATERIAL_UI_COPY.countLineText(MATERIAL_ITEMS.length, MATERIAL_ITEMS.length),
    )
    const first = firstItem()
    expect(
      wrapper
        .get(`[data-testid="material-item-${first.id}"]`)
        .get('.material__item-title')
        .text(),
    ).toBe(first.title)
  })

  it('分类筛选：点击「人物设计」只显示该分类条目，点击「全部」恢复', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="material-category-character"]').trigger('click')
    const expected = filterMaterial(MATERIAL_ITEMS, { category: 'character', keyword: '' })
    expect(expected.length).toBeGreaterThan(0)
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(expected.length)
    expect(wrapper.get('[data-testid="material-count"]').text()).toBe(
      MATERIAL_UI_COPY.countLineText(MATERIAL_ITEMS.length, expected.length),
    )
    await wrapper.get('[data-testid="material-category-all"]').trigger('click')
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(MATERIAL_ITEMS.length)
  })

  it('关键词搜索：结果与 filterMaterial 一致；无结果时显「没有匹配的素材」', async () => {
    const wrapper = mountView()
    await wrapper.get('[data-testid="material-search"]').setValue('优雅贵气')
    const expected = filterMaterial(MATERIAL_ITEMS, { category: 'all', keyword: '优雅贵气' })
    expect(expected.length).toBeGreaterThan(0)
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(expected.length)
    expect(wrapper.get('[data-testid="material-count"]').text()).toBe(
      MATERIAL_UI_COPY.countLineText(MATERIAL_ITEMS.length, expected.length),
    )
    await wrapper.get('[data-testid="material-search"]').setValue('绝不存在的关键词')
    expect(wrapper.get('[data-testid="material-empty-result"]').text()).toBe(
      MATERIAL_UI_COPY.emptyResultText,
    )
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(0)
    await wrapper.get('[data-testid="material-search"]').setValue('')
    expect(wrapper.findAll('[data-testid^="material-item-"]')).toHaveLength(MATERIAL_ITEMS.length)
  })

  it('正文可展开 / 收起，展开按钮文案随之切换', async () => {
    const wrapper = mountView()
    const first = firstItem()
    const itemEl = wrapper.get(`[data-testid="material-item-${first.id}"]`)
    expect(itemEl.findAll('[data-testid="material-entry-content"]')).toHaveLength(0)
    expect(wrapper.get(`[data-testid="material-expand-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.expandLabel,
    )
    await wrapper.get(`[data-testid="material-expand-${first.id}"]`).trigger('click')
    expect(itemEl.find('[data-testid="material-entry-content"]').element).toBeDefined()
    expect(itemEl.get('[data-testid="material-entry-content"]').text()).toBe(first.content)
    expect(wrapper.get(`[data-testid="material-expand-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.collapseLabel,
    )
    await wrapper.get(`[data-testid="material-expand-${first.id}"]`).trigger('click')
    expect(itemEl.findAll('[data-testid="material-entry-content"]')).toHaveLength(0)
    expect(wrapper.get(`[data-testid="material-expand-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.expandLabel,
    )
  })

  it('复制成功：写入剪贴板并显「已复制」', async () => {
    writeText.mockResolvedValue(undefined)
    const wrapper = mountView()
    const first = firstItem()
    await wrapper.get(`[data-testid="material-copy-${first.id}"]`).trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(`${first.title}\n${first.summary}\n${first.content}`)
    expect(wrapper.get(`[data-testid="material-copy-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.copiedLabel,
    )
  })

  it('复制失败（写入被拒）：显「请手动选择复制」', async () => {
    writeText.mockRejectedValue(new Error('拒绝写入剪贴板'))
    const wrapper = mountView()
    const first = firstItem()
    await wrapper.get(`[data-testid="material-copy-${first.id}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.get(`[data-testid="material-copy-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.copyFailLabel,
    )
  })

  it('剪贴板不可用（无 clipboard API）也显「请手动选择复制」', async () => {
    // 用 value: undefined 的自有属性遮蔽原型上的 clipboard（happy-dom 的
    // Navigator.prototype 自带兜底实现，delete 只删自有属性会退回原型 getter，
    // 反而让 writeText 成功）；此时读 clipboard.writeText 抛 TypeError，被面板捕获。
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const wrapper = mountView()
    const first = firstItem()
    await wrapper.get(`[data-testid="material-copy-${first.id}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.get(`[data-testid="material-copy-${first.id}"]`).text()).toBe(
      MATERIAL_UI_COPY.copyFailLabel,
    )
  })

  it('不读 state：挂载即成功（getSnapshot 被调用会抛错）', () => {
    expect(() => mountView()).not.toThrow()
  })

  it('可见文本 ⊆ 页签文案 ∪ material-data.ts 常量', () => {
    const wrapper = mountView()
    const rendered = [
      wrapper.get('.material__title').text(),
      wrapper.get('.material__desc').text(),
      wrapper.get('[data-testid="material-count"]').text(),
      ...wrapper.findAll('[data-testid^="material-category-"]').map((button) => button.text()),
      ...wrapper.findAll('[data-testid^="material-expand-"]').map((button) => button.text()),
      ...wrapper.findAll('[data-testid^="material-copy-"]').map((button) => button.text()),
      ...wrapper.findAll('[data-testid="material-entry-title"]').map((title) => title.text()),
      ...wrapper.findAll('.material__item-summary').map((summary) => summary.text()),
    ]
    const allowed = new Set<string>([
      MATERIAL_TAB.name,
      MATERIAL_TAB.description,
      MATERIAL_UI_COPY.categoryAllLabel,
      MATERIAL_UI_COPY.expandLabel,
      MATERIAL_UI_COPY.copyLabel,
      MATERIAL_UI_COPY.countLineText(MATERIAL_ITEMS.length, MATERIAL_ITEMS.length),
      ...MATERIAL_CATEGORIES.map((category) => category.name),
      ...MATERIAL_ITEMS.map((item) => item.title),
      ...MATERIAL_ITEMS.map((item) => item.summary),
    ])
    for (const text of rendered) {
      expect(allowed.has(text), `渲染了未知文本：${text}`).toBe(true)
    }
  })
})
