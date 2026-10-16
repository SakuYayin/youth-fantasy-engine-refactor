// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 世界引擎面板（worlds.vue）的视图测试：挂载加载 / 空态 / 失败 / 卡片 / 订阅同步 / 排序。
 *
 * AppState 桩与快照夹具取自 apps/desktop/tests/app-view.test.ts 的 harness（28-55 行），
 * 字段逐一对应当前 AppSnapshot/AppState 契约（app-state.ts）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { getTab } from '@yfe/schema-tabs'

import type {
  AppSnapshot,
  AppState,
  SettingsEntityQuery,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import { WORLDS_PANEL_TEXT } from '../../src/renderer/panels/worlds-model.js'
import Worlds from '../../src/renderer/panels/worlds.vue'

const worldsTab = getTab('worlds')
if (worldsTab === undefined) throw new Error('页签 worlds 未注册（@yfe/schema-tabs）')

/** 设定实体夹具：与 SettingsEntityView 同构（updatedAt 是模型层的可选扩展，视图无此字段）。 */
function entity(input: {
  schemaTemplateId: string
  deleted?: boolean
  updatedAt?: string
}): SettingsEntityView {
  return {
    id: `id-${input.schemaTemplateId}-${input.updatedAt ?? 'none'}`,
    projectId: 'project_1',
    schemaTemplateId: input.schemaTemplateId,
    name: `${input.schemaTemplateId} 条目`,
    values: {},
    orderKey: 'k',
    revision: 'r1',
    deleted: input.deleted ?? false,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  }
}

/** 完整 AppSnapshot 夹具（与 app-view.test.ts 的 harness 同一口径）。 */
function snapshotWith(entities: AppSnapshot['settingsEntities']): AppSnapshot {
  return {
    ready: true, loading: false, appVersion: 'test', databasePath: null, databaseSchemaVersion: 1,
    readOnly: false, pendingOutboxCount: 0, lastSavedAt: null, projectId: 'project_1', tree: [],
    documents: [],
    selectedDocumentId: 'doc_1', title: '第一章', body: '原始正文', charCount: 4, revision: 'r1',
    saveStatus: 'saved', saveDetail: null, conflict: null, lastError: null, expandedIds: [],
    settingsEntities: entities, settingsLoading: false, selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
}

function harness(
  entities: AppSnapshot['settingsEntities'],
  options?: { loadOk?: boolean; loadGate?: Promise<void> },
) {
  const loadOk = options?.loadOk ?? true
  let snapshot = snapshotWith(entities)
  let notify: ((snapshot: AppSnapshot) => void) | undefined
  const unsubscribe = vi.fn()
  const loadQueries: Array<SettingsEntityQuery | undefined> = []
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { notify = listener; return unsubscribe },
    start: async () => {}, refresh: async () => {}, createProject: async () => true,
    openProject: async () => true,
    createChapter: async () => true, selectDocument: async () => true,
    edit: vi.fn(), flush: async () => true, applyExternalUpdate: () => true,
    retrySave: () => {}, resolveConflict: () => {}, toggleExpanded: () => {},
    loadSettingsEntities: async (query) => {
      loadQueries.push(query)
      if (options?.loadGate) await options.loadGate
      return loadOk
    },
    selectSettingsEntity: async () => true, refreshSettingsEntity: async () => true,
    submitSettingsEntity: async () => ({ ok: false, code: 'NOT_IMPLEMENTED', message: '测试桩' }),
    setNavigationGuard: () => {}, dispose: () => {},
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => ({ ok: false as const, code: 'AI_NOT_CONFIGURED' as const, message: '测试桩' }),
    },
  }
  const wrapper = mount(Worlds, { props: { state, tab: worldsTab } })
  return {
    wrapper, state, unsubscribe, loadQueries,
    async publish(patch: Partial<AppSnapshot>) { snapshot = { ...snapshot, ...patch }; notify?.(snapshot); await nextTick() },
  }
}

describe('worlds 面板：挂载与加载', () => {
  it('挂载即 await loadSettingsEntities()，且不传参数（列当前作品/无作品时全工作区）', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper, loadQueries } = harness([entity({ schemaTemplateId: 'worldbase' })], { loadGate })
    await nextTick()
    await nextTick()
    // onMounted 已运行：同步置 loading=true 并发起加载，stub 停在受控闸门 → 加载中状态可见。
    expect(wrapper.get('[data-testid="worlds-loading"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="worlds-loading"]').text()).toBe(WORLDS_PANEL_TEXT.loading)
    openGate()
    await flushPromises()
    expect(loadQueries).toEqual([undefined])
    expect(wrapper.get('[data-testid="worlds-card-worldbase"]').element).toBeDefined()
  })

  it('加载后按模板渲染卡片：模板名 / 条数 / 最近更新（视图无 updatedAt → 占位文案）', async () => {
    const { wrapper } = harness([
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'nations' }),
      entity({ schemaTemplateId: 'nations' }),
    ])
    await nextTick()
    await nextTick()
    const cards = wrapper.findAll('.worlds__card')
    expect(cards).toHaveLength(2)
    expect(wrapper.get('[data-testid="worlds-card-worldbase"]').text()).toContain('世界设定')
    expect(wrapper.get('[data-testid="worlds-card-nations"]').text()).toContain('国家势力')
    expect(wrapper.get('[data-testid="worlds-card-nations"]').text()).toContain(
      `2 ${WORLDS_PANEL_TEXT.entryUnit}`,
    )
    expect(wrapper.get('[data-testid="worlds-card-time"]').text()).toContain(
      `${WORLDS_PANEL_TEXT.latestUpdatedAtLabel}：${WORLDS_PANEL_TEXT.missingUpdatedAt}`,
    )
    // 总览行 + 每张卡上的固定引导。
    expect(wrapper.get('[data-testid="worlds-overview"]').text()).toBe(
      `共 3 条设定，覆盖 2 个模板`,
    )
    expect(wrapper.get('[data-testid="worlds-card-hint"]').text()).toBe(WORLDS_PANEL_TEXT.editHint)
  })

  it('已删除条目不计入卡片条数', async () => {
    const { wrapper } = harness([
      entity({ schemaTemplateId: 'worldbase' }),
      entity({ schemaTemplateId: 'worldbase', deleted: true }),
    ])
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="worlds-card-worldbase"]').text()).toContain(
      `1 ${WORLDS_PANEL_TEXT.entryUnit}`,
    )
    expect(wrapper.get('[data-testid="worlds-overview"]').text()).toBe('共 1 条设定，覆盖 1 个模板')
  })

  it('未知模板也渲染卡片：显示模板 id 本身并标「未知模板」徽标', async () => {
    const { wrapper } = harness([entity({ schemaTemplateId: 'custom-template' })])
    await nextTick()
    await nextTick()
    const card = wrapper.get('[data-testid="worlds-card-custom-template"]')
    expect(card.text()).toContain('custom-template')
    expect(card.text()).toContain(WORLDS_PANEL_TEXT.unknownBadge)
  })
})

describe('worlds 面板：空态与失败', () => {
  it('加载成功但无数据时显示显式中文空态引导', async () => {
    const { wrapper } = harness([])
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="worlds-empty"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="worlds-empty"]').text()).toBe(WORLDS_PANEL_TEXT.emptyGuide)
  })

  it('加载失败且无数据时显示失败文案（不假装成功）', async () => {
    const { wrapper } = harness([], { loadOk: false })
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="worlds-error"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="worlds-error"]').text()).toBe(WORLDS_PANEL_TEXT.loadFailed)
  })

  it('加载失败但已有数据时保留卡片并提示失败', async () => {
    const { wrapper } = harness([entity({ schemaTemplateId: 'worldbase' })], { loadOk: false })
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="worlds-error"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="worlds-cards"]').element).toBeDefined()
  })
})

describe('worlds 面板：订阅同步与排序', () => {
  it('状态机推送新实体后卡片实时更新（subscribe 回调接线）', async () => {
    const { wrapper, publish } = harness([])
    await nextTick()
    await nextTick()
    expect(wrapper.get('[data-testid="worlds-empty"]').element).toBeDefined()
    await publish({ settingsEntities: [entity({ schemaTemplateId: 'terms' })] })
    expect(wrapper.get('[data-testid="worlds-card-terms"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="worlds-overview"]').text()).toBe('共 1 条设定，覆盖 1 个模板')
  })

  it('卸载时取消订阅', async () => {
    const { wrapper, unsubscribe } = harness([])
    await nextTick()
    expect(unsubscribe).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('排序按钮默认按条数，点击切到按更新时间并改变卡片顺序', async () => {
    const { wrapper } = harness([
      entity({ schemaTemplateId: 'nations', updatedAt: '2026-06-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'power', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'power', updatedAt: '2026-01-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
      entity({ schemaTemplateId: 'justice', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ])
    await nextTick()
    await nextTick()
    const cardIds = (): string[] =>
      wrapper.findAll('.worlds__card').map((card) => String(card.attributes('data-testid')))
    // 默认按条数：justice(2) → power(2，时间更晚) → nations(1)。
    expect(cardIds()).toEqual(['worlds-card-justice', 'worlds-card-power', 'worlds-card-nations'])
    expect(wrapper.get('[data-testid="worlds-sort-toggle"]').text()).toBe(
      WORLDS_PANEL_TEXT.sortByRecent,
    )
    await wrapper.get('[data-testid="worlds-sort-toggle"]').trigger('click')
    await nextTick()
    // 按更新时间：nations(2026-06) → justice(2026-02) → power(2026-01)。
    expect(cardIds()).toEqual(['worlds-card-nations', 'worlds-card-justice', 'worlds-card-power'])
    expect(wrapper.get('[data-testid="worlds-sort-toggle"]').text()).toBe(
      WORLDS_PANEL_TEXT.sortByCount,
    )
  })

  it('刷新按钮可重拉数据', async () => {
    const { wrapper, loadQueries } = harness([])
    await nextTick()
    await nextTick()
    expect(loadQueries).toEqual([undefined])
    await wrapper.get('[data-testid="worlds-refresh"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(loadQueries).toHaveLength(2)
  })
})

describe('worlds 面板：文案与契约', () => {
  it('渲染页签元数据（标题用页签名，描述用页签 description）', () => {
    const { wrapper } = harness([])
    expect(wrapper.get('.worlds__title').text()).toBe(worldsTab.name)
    expect(wrapper.get('[data-testid="worlds-intro"]').text()).toBe(WORLDS_PANEL_TEXT.intro)
  })

  it('面板根节点带 data-testid 与 data-tab-id（用户统一验收用）', () => {
    const { wrapper } = harness([])
    const root = wrapper.get('[data-testid="worlds-panel"]')
    expect(root.attributes('data-tab-id')).toBe('worlds')
  })
})
