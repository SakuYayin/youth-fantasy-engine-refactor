// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 「使用指南」面板挂载测试（`guide.vue`，tab.id = `guide`，分组 = 工作面板）。
 *
 * guide 是静态指南页：全部文案来自 `guide-content.ts` 常量，没有数据依赖。
 * 这里验证运行时接线：
 * - 页签元数据（标题=页签名、副标题=页签描述）正确渲染；
 * - 每节一个 `YfePanel` 小节，标题与条目逐条来自常量且顺序一致；
 * - 组件不读 `state`（挂载用的桩会在被读取时抛错）；
 * - 可见文本 ⊆ 页签文案 ∪ guide-content.ts 常量（接口冻结 §6 验收 2）。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type { AppState } from '../../src/renderer/app-state.js'
import { GUIDE_INTRO, GUIDE_SECTIONS } from '../../src/renderer/panels/guide-content.js'
import Guide from '../../src/renderer/panels/guide.vue'

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

/**
 * guide 面板是静态指南页，不读 `state`：`getSnapshot` 被调用就抛错，
 * 挂载一旦失败测试即红。用最小桩而非真客户端（不需要起 RendererClientPort）。
 */
const STATE_STUB = {
  getSnapshot(): never {
    throw new Error('guide 面板是静态指南页，不得读取 state')
  },
  subscribe(): () => void {
    return () => {}
  },
} as unknown as AppState

/** 侧栏 `TABS` 里真实的 guide 页签（单一来源），缺失即抛错。 */
function guideTab(): TabDef {
  const tab = getTab('guide')
  if (tab === undefined) {
    throw new Error('侧栏 TABS 里没有 guide 页签（schema-tabs 缺口）')
  }
  return tab
}

const GUIDE_TAB: TabDef = guideTab()

function mountView(overrides: Partial<ViewProps> = {}) {
  const props: ViewProps = { state: STATE_STUB, tab: GUIDE_TAB, ...overrides }
  return mount(Guide, { props })
}

describe('「使用指南」面板', () => {
  it('渲染页签元数据：标题=页签名、副标题=页签描述、data-tab-id=页签 id', () => {
    const wrapper = mountView()
    const root = wrapper.get('[data-testid="guide-panel"]')
    expect(root.element).toBeDefined()
    expect(root.attributes('data-tab-id')).toBe('guide')
    expect(wrapper.get('.guide__title').text()).toBe(GUIDE_TAB.name)
    expect(wrapper.get('.guide__desc').text()).toBe(GUIDE_TAB.description)
  })

  it('每节一个 YfePanel 小节，标题与条目逐条来自常量且顺序一致', () => {
    const wrapper = mountView()
    for (const section of GUIDE_SECTIONS) {
      const sectionEl = wrapper.get(`[data-testid="guide-section-${section.id}"]`)
      expect(sectionEl.element).toBeDefined()
      expect(sectionEl.get('.yfe-panel__title').text()).toBe(section.title)
      const items = sectionEl.findAll('[data-testid^="guide-item-"]')
      expect(items).toHaveLength(section.items.length)
      expect(items.map((item) => item.text())).toEqual([...section.items])
    }
  })

  it('页首引言逐行来自 GUIDE_INTRO', () => {
    const wrapper = mountView()
    const intros = wrapper.findAll('[data-testid="guide-intro"]')
    expect(intros).toHaveLength(GUIDE_INTRO.length)
    expect(intros.map((intro) => intro.text())).toEqual([...GUIDE_INTRO])
  })

  it('不读 state：挂载即成功（getSnapshot 被调用会抛错）', () => {
    expect(() => mountView()).not.toThrow()
  })

  it('可见文本 ⊆ 页签文案 ∪ guide-content.ts 常量', () => {
    const wrapper = mountView()
    const rendered = [
      wrapper.get('.guide__title').text(),
      wrapper.get('.guide__desc').text(),
      ...wrapper.findAll('[data-testid="guide-intro"]').map((intro) => intro.text()),
      ...wrapper.findAll('.guide__section .yfe-panel__title').map((title) => title.text()),
      ...wrapper.findAll('[data-testid^="guide-item-"]').map((item) => item.text()),
    ]
    const allowed = new Set<string>([
      GUIDE_TAB.name,
      GUIDE_TAB.description,
      ...GUIDE_INTRO,
      ...GUIDE_SECTIONS.flatMap((section) => [section.title, ...section.items]),
    ])
    for (const text of rendered) {
      expect(allowed.has(text), `渲染了未知文本：${text}`).toBe(true)
    }
  })
})
