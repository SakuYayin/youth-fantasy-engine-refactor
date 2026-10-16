// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 「使用指南」面板（W9-2 · C-01）视图测试：真实 `mount`（happy-dom）。
 *
 * 与上游 `_upstream_tmp/youth-fantasy-engine-main/src/components/app/GuidePage.tsx` 对齐的三节行为：
 * ① 推荐填写顺序的 10 个可点击按钮；② 全部功能页签按分组一览、可跳转、未启用灰显；
 * ③ 12 条创作方法论；④ 4 处帮助气泡；⑤ 页签跳转通道（`emit('navigate', tabId)`，
 *    外壳未接线时兜底派发 `yfe:navigate`）。
 *
 * 桩：手写完整 `AppState`（只用 `getSnapshot` / `subscribe`，其余 no-op，不 `as any`），
 * 结构照 `apps/desktop/tests/panels/about.view.test.ts:94-170`。
 */
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { EDITOR_TAB, GROUPS, TABS, getTab, type TabDef } from '@yfe/schema-tabs'

import type { AppSnapshot, AppState } from '../../src/renderer/app-state.js'
import {
  DISABLED_BADGE,
  EDITOR_DESC,
  FILL_ORDER,
  FILL_ORDER_NOTE,
  GUIDE_DISABLED_NOTE,
  GUIDE_HELP,
  TIPS,
  helpLines,
} from '../../src/renderer/panels/guide-model.js'
import GuidePanel from '../../src/renderer/panels/guide.vue'

/** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
interface ViewProps {
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

/** 快照基线（字段与 `AppSnapshot` 冻结定义逐字对齐）。 */
const SNAPSHOT_BASE: AppSnapshot = {
  ready: true,
  loading: false,
  appVersion: '0.1.0',
  databasePath: null,
  databaseSchemaVersion: null,
  readOnly: false,
  pendingOutboxCount: 0,
  lastSavedAt: null,
  projectId: 'project-1',
  tree: [],
  documents: [],
  selectedDocumentId: null,
  title: '',
  body: '',
  charCount: 0,
  revision: null,
  saveStatus: 'saved',
  saveDetail: null,
  conflict: null,
  lastError: null,
  expandedIds: [],
  settingsEntities: [],
  settingsLoading: false,
  selectedSettingsEntityId: null,
  selectedSettingsEntity: null,
}

/** 快照上「契约已冻结、尚未落地」的项目形态字段（见 `guide-model.ts` 的 `resolveVisCtx`）。 */
interface SnapshotExtras {
  readonly projectType?: unknown
  readonly features?: unknown
}

interface StateHarness {
  readonly state: AppState
  /** 模拟外壳发布快照（面板订阅后会重渲染）。 */
  publish(patch: Partial<AppSnapshot> & SnapshotExtras): void
}

/** 手写 AppState 桩（结构完整，不 as any）。 */
function makeState(initial: Partial<AppSnapshot> & SnapshotExtras = {}): StateHarness {
  const listeners = new Set<(snapshot: AppSnapshot) => void>()
  let snapshot: AppSnapshot = Object.assign({}, SNAPSHOT_BASE, initial)
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: async () => {},
    refresh: async () => {},
    createProject: async () => false,
    openProject: async () => true,
    createChapter: async () => false,
    selectDocument: async () => false,
    edit: () => {},
    flush: async () => false,
    applyExternalUpdate: () => false,
    retrySave: () => {},
    resolveConflict: () => {},
    toggleExpanded: () => {},
    setNavigationGuard: () => {},
    dispose: () => {},
    loadSettingsEntities: async () => false,
    selectSettingsEntity: async () => false,
    refreshSettingsEntity: async () => false,
    submitSettingsEntity: async () => ({
      ok: true,
      entityId: 'row-new',
      revision: 'r2',
      orderKey: 'A02',
    }),
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => ({
        ok: false as const,
        code: 'AI_NOT_CONFIGURED' as const,
        message: '测试桩',
      }),
    },
  }
  return {
    state,
    publish: (patch) => {
      snapshot = Object.assign({}, snapshot, patch)
      for (const listener of listeners) listener(snapshot)
    },
  }
}

/** 侧栏 `TABS` 里真实的 guide 页签（单一来源），缺失即抛错。 */
function requireTab(id: string): TabDef {
  const tab = getTab(id)
  if (tab === undefined) throw new Error(`侧栏 TABS 里没有 ${id} 页签（schema-tabs 缺口）`)
  return tab
}

const GUIDE_TAB: TabDef = requireTab('guide')

/** 「全部功能页签」里应当出现的分组（顺序＝本仓 `GROUPS`）。 */
const EXPECTED_GROUPS: readonly string[] = GROUPS.filter(
  (name) =>
    name === EDITOR_TAB.group ||
    TABS.some((tab) => tab.group === name && tab.type !== 'dashboard' && tab.type !== 'guide'),
)

function mountPanel(
  harness: StateHarness = makeState(),
  attrs: Readonly<Record<string, unknown>> = {},
) {
  const props: ViewProps = { state: harness.state, tab: GUIDE_TAB, ...attrs }
  return mount(GuidePanel, { props })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('「使用指南」面板 · 壳', () => {
  it('标题与说明取自页签元数据，三段结构齐全', () => {
    const wrapper = mountPanel()
    const root = wrapper.get('[data-testid="guide-panel"]')
    expect(root.attributes('data-tab-id')).toBe('guide')
    expect(wrapper.get('[data-testid="guide-title"]').text()).toBe(GUIDE_TAB.name)
    expect(wrapper.get('[data-testid="guide-desc"]').text()).toBe(GUIDE_TAB.description)
    expect(wrapper.find('[data-testid="guide-fill-order"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="guide-all-tabs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="guide-tips"]').exists()).toBe(true)
  })

  it('12 条创作方法论逐条渲染（标题 + 正文），顺序与上游一致', () => {
    const wrapper = mountPanel()
    const cards = wrapper.findAll('.guide__tip')
    expect(cards).toHaveLength(12)
    expect(cards.map((card) => card.get('.guide__tiptitle').text())).toEqual(
      TIPS.map((tip) => tip.title),
    )
    expect(cards.map((card) => card.get('.guide__tipbody').text())).toEqual(
      TIPS.map((tip) => tip.body),
    )
    expect(wrapper.get('[data-testid="guide-tip-0"]').text()).toContain('先定位再动笔')
    expect(wrapper.get('[data-testid="guide-tip-11"]').text()).toContain('灵感即时入库')
  })

  it('正常渲染不出现兜底空态（空态只作静默空白页的最后一道护栏）', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="guide-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="guide-fill-order-empty"]').exists()).toBe(false)
  })
})

describe('「使用指南」面板 · 推荐填写顺序', () => {
  it('渲染 10 个按钮，文案＝「序号. 页签名」，末尾是倒推法提示', () => {
    const wrapper = mountPanel()
    const steps = wrapper.findAll('.guide__step')
    expect(steps).toHaveLength(FILL_ORDER.length)
    FILL_ORDER.forEach((id, index) => {
      const step = steps[index]
      expect(step?.attributes('data-testid')).toBe(`guide-fill-step-${id}`)
      expect(step?.text()).toBe(`${index + 1}. ${requireTab(id).name}`)
    })
    expect(wrapper.get('[data-testid="guide-fill-order-note"]').text()).toBe(FILL_ORDER_NOTE)
  })

  it('点击任意一步上抛 navigate(tabId)，且每个 id 都能在 TABS 里解析（反 R-75）', async () => {
    const wrapper = mountPanel()
    const clicked: string[] = []
    for (const id of FILL_ORDER) {
      const button = wrapper.get(`[data-testid="guide-fill-step-${id}"]`)
      await button.trigger('click')
      clicked.push(id)
      expect(button.element.tagName).toBe('BUTTON')
    }
    const emitted = wrapper.emitted('navigate') ?? []
    expect(emitted.map((args) => args[0])).toEqual(clicked)
    for (const id of clicked) {
      expect(getTab(id), `跳转载荷 ${id} 不是本仓真实页签 id`).toBeDefined()
    }
  })
})

describe('「使用指南」面板 · 全部功能页签', () => {
  it('按分组渲染，分组名、条目计数与顺序来自页签元数据', () => {
    const wrapper = mountPanel()
    expect(wrapper.findAll('.guide__group')).toHaveLength(EXPECTED_GROUPS.length)
    for (const name of EXPECTED_GROUPS) {
      const group = wrapper.get(`[data-testid="guide-group-${name}"]`)
      expect(group.get('.guide__groupname').text()).toBe(name)
      const items = group.findAll('.guide__tab')
      expect(items.length).toBeGreaterThan(0)
      expect(group.get(`[data-testid="guide-group-count-${name}"]`).text()).toBe(
        `${items.length} 项`,
      )
    }
    // 分组出现顺序＝GROUPS 顺序
    expect(wrapper.findAll('.guide__groupname').map((el) => el.text())).toEqual([
      ...EXPECTED_GROUPS,
    ])
  })

  it('条目名称与描述逐字来自页签元数据', () => {
    const wrapper = mountPanel()
    for (const id of ['positioning', 'worldbase', 'chapter-outline', 'about']) {
      const tab = requireTab(id)
      const item = wrapper.get(`[data-testid="guide-tab-${id}"]`)
      expect(item.get('.guide__tabname').text()).toBe(tab.name)
      expect(item.get('.guide__tabdesc').text()).toBe(tab.description)
    }
  })

  it('使用指南与工作面板不自我重复，正文编辑单独成条', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="guide-tab-guide"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="guide-tab-dashboard"]').exists()).toBe(false)
    const editorGroup = wrapper.get(`[data-testid="guide-group-${EDITOR_TAB.group}"]`)
    expect(editorGroup.findAll('.guide__tab')).toHaveLength(1)
    const editor = editorGroup.get(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`)
    expect(editor.get('.guide__tabname').text()).toBe(EDITOR_TAB.name)
    expect(editor.get('.guide__tabdesc').text()).toBe(EDITOR_DESC)
    expect(editor.attributes('disabled')).toBeUndefined()
  })

  it('点击任意页签条目上抛 navigate(tabId)，载荷就是元数据里的 id', async () => {
    const wrapper = mountPanel()
    await wrapper.get('[data-testid="guide-tab-positioning"]').trigger('click')
    await wrapper.get(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`).trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['positioning'], [EDITOR_TAB.id]])
  })

  it('点分组头可收起再展开，aria-expanded 同步', async () => {
    const wrapper = mountPanel()
    const header = wrapper.get(`[data-testid="guide-group-toggle-${EDITOR_TAB.group}"]`)
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`).exists()).toBe(true)

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`).exists()).toBe(false)
    // 收起一组不影响其它组
    expect(wrapper.find('[data-testid="guide-tab-positioning"]').exists()).toBe(true)

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`).exists()).toBe(true)
  })
})

describe('「使用指南」面板 · 帮助气泡', () => {
  it('4 个帮助按钮初始都收起，点开显示上游逐字正文，再点收起', async () => {
    const wrapper = mountPanel()
    const keys = ['page', 'fill-order', 'all-tabs', 'tips'] as const
    for (const key of keys) {
      expect(wrapper.find(`[data-testid="guide-help-toggle-${key}"]`).exists()).toBe(true)
      expect(wrapper.find(`[data-testid="guide-help-body-${key}"]`).exists()).toBe(false)
    }

    const pageToggle = wrapper.get('[data-testid="guide-help-toggle-page"]')
    await pageToggle.trigger('click')
    expect(pageToggle.attributes('aria-expanded')).toBe('true')
    const pageBody = wrapper.get('[data-testid="guide-help-body-page"]')
    expect(pageBody.get('.guide__helptitle').text()).toBe(GUIDE_HELP.page.title)
    expect(pageBody.text()).toContain(helpLines('page')[0])
    expect(pageBody.text()).toContain('12 条网文实操心法')
    expect(pageBody.findAll('.guide__helpline')).toHaveLength(helpLines('page').length)

    await wrapper.get('[data-testid="guide-help-close-page"]').trigger('click')
    expect(wrapper.find('[data-testid="guide-help-body-page"]').exists()).toBe(false)
    expect(pageToggle.attributes('aria-expanded')).toBe('false')
  })

  it('四个帮助气泡互斥（同时只开一个），再点同一个按钮收起', async () => {
    const wrapper = mountPanel()
    await wrapper.get('[data-testid="guide-help-toggle-tips"]').trigger('click')
    expect(wrapper.find('[data-testid="guide-help-body-tips"]').exists()).toBe(true)
    await wrapper.get('[data-testid="guide-help-toggle-fill-order"]').trigger('click')
    expect(wrapper.find('[data-testid="guide-help-body-tips"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="guide-help-body-fill-order"]').exists()).toBe(true)
    await wrapper.get('[data-testid="guide-help-toggle-fill-order"]').trigger('click')
    expect(wrapper.find('[data-testid="guide-help-body-fill-order"]').exists()).toBe(false)
  })
})

describe('「使用指南」面板 · 未启用页签与快照订阅', () => {
  it('自定义项目 + 空功能清单：显示灰显说明，可选项灰显不可点、锁定项照常可跳', async () => {
    const harness = makeState({ projectType: 'custom', features: [] })
    const wrapper = mountPanel(harness)
    expect(wrapper.get('[data-testid="guide-disabled-note"]').text()).toBe(GUIDE_DISABLED_NOTE)

    const positioning = wrapper.get('[data-testid="guide-tab-positioning"]')
    expect(positioning.attributes('disabled')).toBeDefined()
    expect(positioning.get(`[data-testid="guide-tab-badge-positioning"]`).text()).toBe(
      DISABLED_BADGE,
    )
    // 锁定项（正文编辑 / 使用指南同级的必选项）仍可跳
    const editor = wrapper.get(`[data-testid="guide-tab-${EDITOR_TAB.id}"]`)
    expect(editor.attributes('disabled')).toBeUndefined()
    await editor.trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([[EDITOR_TAB.id]])

    // 推荐填写顺序里未启用的整条不出现（上游 `GuidePage.tsx:70` 的 tabVisible 过滤）
    expect(wrapper.find('[data-testid="guide-fill-step-positioning"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="guide-fill-order-empty"]').text().length).toBeGreaterThan(0)
  })

  it('完整项目（快照无 projectType/features）不显示灰显说明', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-testid="guide-disabled-note"]').exists()).toBe(false)
    expect(wrapper.findAll('.guide__tab--off')).toHaveLength(0)
  })

  it('跟随快照重渲染：发布自定义项目快照后出现灰显说明（订阅已接线）', async () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    expect(wrapper.find('[data-testid="guide-disabled-note"]').exists()).toBe(false)

    harness.publish({ projectType: 'custom', features: ['positioning'] })
    await nextTick()

    expect(wrapper.get('[data-testid="guide-disabled-note"]').text()).toBe(GUIDE_DISABLED_NOTE)
    expect(wrapper.get('[data-testid="guide-tab-positioning"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="guide-tab-worldbase"]').attributes('disabled')).toBeDefined()
  })
})

describe('「使用指南」面板 · 跳转通道', () => {
  it('外壳未接线时，点击兜底派发冒泡的 yfe:navigate（detail.tabId）', async () => {
    const seen: Event[] = []
    const listener = (event: Event): void => {
      seen.push(event)
    }
    document.addEventListener('yfe:navigate', listener)
    try {
      const wrapper = mountPanel()
      await wrapper.get('[data-testid="guide-tab-positioning"]').trigger('click')
    } finally {
      document.removeEventListener('yfe:navigate', listener)
    }
    expect(seen).toHaveLength(1)
    const detail = (seen[0] as CustomEvent<{ tabId: string }>).detail
    expect(detail.tabId).toBe('positioning')
    expect(seen[0]?.bubbles).toBe(true)
  })

  it('外壳接住 @navigate 时只走 emit，不再重复派发 DOM 事件', async () => {
    const sink: string[] = []
    const seen: Event[] = []
    const listener = (event: Event): void => {
      seen.push(event)
    }
    document.addEventListener('yfe:navigate', listener)
    let emitted: unknown[] = []
    try {
      const wrapper = mountPanel(makeState(), {
        onNavigate: (tabId: string) => {
          sink.push(tabId)
        },
      })
      await wrapper.get('[data-testid="guide-tab-positioning"]').trigger('click')
      emitted = wrapper.emitted('navigate') ?? []
    } finally {
      document.removeEventListener('yfe:navigate', listener)
    }
    expect(sink).toEqual(['positioning'])
    expect(emitted).toEqual([['positioning']])
    expect(seen).toHaveLength(0)
  })
})