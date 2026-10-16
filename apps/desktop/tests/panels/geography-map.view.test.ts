// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * geography-map 面板视图测试（happy-dom）。
 *
 * 覆盖：挂载载入调用、空/有数据的两层渲染（示意图 + 清单表）、
 * 新建/更新的 state 提交（幂等键 / 整行合并 values / 乐观锁 revision）、
 * 删除/重排只显中文回执（不假装成功）、载入失败说明。
 *
 * AppState 桩按结构手写（本面板只触碰 getSnapshot / subscribe /
 * loadSettingsEntities / submitSettingsEntity，其余为 no-op）。
 */

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import { GEO_MAPS_TAB, getTab } from '@yfe/schema-tabs'

import type {
  AppState,
  AppSnapshot,
  SettingsEntityQuery,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiResult } from '../../src/renderer/ai/types.js'
import type { TabDef } from '@yfe/schema-tabs'
import {
  LOAD_FAILED_NOTICE,
  SKETCH_EMPTY_NOTICE,
  SKETCH_PREVIEW_NOTICE,
  SKETCH_TITLE,
  deletePendingNotice,
  reorderPendingNotice,
} from '../../src/renderer/panels/geography-map-model.js'
import GeographyMap from '../../src/renderer/panels/geography-map.vue'

/** 面板自己的页签（geography-map，type=map，分组=世界构建）。 */
const PANEL_TAB = getTab('geography-map')
if (PANEL_TAB === undefined) throw new Error('SIDEBAR_TABS 里找不到 geography-map 页签')

/** 构造一条《地图》行（SettingsEntityView 结构，字段与 app-state 契约一致）。 */
function makeRow(overrides: Partial<SettingsEntityView> = {}): SettingsEntityView {
  return {
    id: 'row-1',
    projectId: 'project-1',
    schemaTemplateId: 'geomaps',
    name: '地图',
    values: {},
    orderKey: 'A01',
    revision: 'r00000001',
    deleted: false,
    ...overrides,
  }
}

const AI_FAILURE: AiResult = { ok: false, code: 'AI_NOT_CONFIGURED', message: '测试桩' }

interface StateHarness {
  readonly state: AppState
  /** 模拟外壳发布快照（订阅者会收到）。 */
  publish(patch: Partial<AppSnapshot>): void
  setLoadResult(ok: boolean): void
  setSubmitResult(result: SettingsEntitySubmitResult): void
  readonly loads: SettingsEntityQuery[]
  readonly submits: SettingsEntitySubmit[]
}

/** 手写 AppState 桩（结构完整，不 as any）。 */
function makeState(initial: Partial<AppSnapshot> = {}): StateHarness {
  const loads: SettingsEntityQuery[] = []
  const submits: SettingsEntitySubmit[] = []
  const listeners = new Set<(snapshot: AppSnapshot) => void>()
  let loadResult = true
  let submitResult: SettingsEntitySubmitResult = {
    ok: true,
    entityId: 'row-new',
    revision: 'r2',
    orderKey: 'A02',
  }
  let snapshot: AppSnapshot = {
    ready: true,
    loading: false,
    appVersion: 'test',
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
    ...initial,
  }
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
    loadSettingsEntities: async (options) => {
      loads.push(options ?? {})
      return loadResult
    },
    selectSettingsEntity: async () => false,
    refreshSettingsEntity: async () => false,
    submitSettingsEntity: async (submit) => {
      submits.push(submit)
      return submitResult
    },
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => AI_FAILURE,
    },
  }
  return {
    state,
    loads,
    submits,
    publish: (patch) => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener(snapshot)
    },
    setLoadResult: (ok) => {
      loadResult = ok
    },
    setSubmitResult: (result) => {
      submitResult = result
    },
  }
}

interface MountProps {
  readonly state: AppState
  readonly tab: TabDef
  readonly [key: string]: unknown
}

function mountPanel(harness: StateHarness) {
  return mount(GeographyMap, {
    props: {
      state: harness.state,
      tab: PANEL_TAB!,
    } satisfies MountProps,
  })
}

describe('挂载与载入（settingsEntities 通道）', () => {
  it('挂载时按《地图》模板载入设定实体（schemaTemplateId=geomaps）', async () => {
    const harness = makeState()
    mountPanel(harness)
    await flushPromises()
    expect(harness.loads).toEqual([{ schemaTemplateId: 'geomaps' }])
  })

  it('载入失败：示意图显式说明，不静默空白', async () => {
    const harness = makeState()
    harness.setLoadResult(false)
    const wrapper = mountPanel(harness)
    await flushPromises()
    expect(wrapper.find('[data-testid="geography-map-load-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="geography-map-load-notice"]').text()).toContain(
      LOAD_FAILED_NOTICE,
    )
  })
})

describe('两层渲染（可视化示意 + 数据表）', () => {
  it('空数据：示意图空态与表格空态都有明确说明，预览标注可见', () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    expect(wrapper.find('[data-testid="geography-map-sketch-title"]').text()).toContain(SKETCH_TITLE)
    expect(wrapper.find('[data-testid="geography-map-sketch-preview"]').text()).toContain(
      SKETCH_PREVIEW_NOTICE,
    )
    expect(wrapper.find('[data-testid="geography-map-sketch-empty"]').text()).toContain(
      SKETCH_EMPTY_NOTICE,
    )
    expect(wrapper.find('[data-testid="tab-table-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tab-table-empty"]').text()).toContain(GEO_MAPS_TAB.description)
  })

  it('有数据：示意图每行一条「名称 + 每格公里」色块条（档位定格子数），表格渲染行', () => {
    const harness = makeState({
      settingsEntities: [
        makeRow({
          id: 'row-a',
          orderKey: 'A01',
          values: { 编号: 'MAP0001', 名称: '东海', 每格公里: '1' },
        }),
        makeRow({
          id: 'row-b',
          orderKey: 'A02',
          values: { 编号: 'MAP0002', 名称: '西荒', 每格公里: '10' },
        }),
      ],
    })
    const wrapper = mountPanel(harness)
    // 示意图：顺序与清单表一致（orderKey 升序）
    const items = wrapper.findAll('[data-testid^="geography-map-sketch-item-"]')
    expect(items.map((item) => item.attributes('data-testid'))).toEqual([
      'geography-map-sketch-item-row-a',
      'geography-map-sketch-item-row-b',
    ])
    const first = wrapper.get('[data-testid="geography-map-sketch-item-row-a"]')
    expect(first.find('[data-testid="geography-map-sketch-name"]').text()).toContain('东海')
    expect(first.find('[data-testid="geography-map-sketch-scale"]').text()).toContain('每格公里：1')
    expect(first.findAll('.geography-map__sketch-cell')).toHaveLength(12)
    const second = wrapper.get('[data-testid="geography-map-sketch-item-row-b"]')
    expect(second.find('[data-testid="geography-map-sketch-scale"]').text()).toContain('每格公里：10')
    expect(second.findAll('.geography-map__sketch-cell')).toHaveLength(6)
    // 数据表：GEO_MAPS_TAB（id geomaps）行渲染
    expect(wrapper.find('[data-testid="tab-table-title"]').text()).toContain(GEO_MAPS_TAB.name)
    expect(wrapper.find('[data-testid="table-row-row-a"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="table-row-row-b"]').exists()).toBe(true)
  })

  it('订阅：挂载后外壳发布的新行进入示意图', async () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    await flushPromises()
    harness.publish({
      settingsEntities: [makeRow({ id: 'row-a', values: { 名称: '东海', 每格公里: '1' } })],
    })
    await nextTick()
    expect(wrapper.find('[data-testid="geography-map-sketch-item-row-a"]').exists()).toBe(true)
  })
})

describe('新建（submitSettingsEntity）', () => {
  it('点「+」按幂等键提交：name=nextRowName、expectedRevision=null、初始 values', async () => {
    const harness = makeState()
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-create-geomaps"]').trigger('click')
    await flushPromises()
    expect(harness.submits).toEqual([
      {
        entityId: null,
        schemaTemplateId: 'geomaps',
        name: '地图',
        values: { 名称: '地图', 每格公里: '1' },
        expectedRevision: null,
        idempotencyKey: expect.any(String),
      },
    ])
    // 成功后幂等键清掉：下一次「+」是新的新建会话
    await wrapper.get('[data-testid="table-create-geomaps"]').trigger('click')
    await flushPromises()
    expect(harness.submits).toHaveLength(2)
    expect(harness.submits[1]?.idempotencyKey).not.toBe(harness.submits[0]?.idempotencyKey)
  })

  it('新建失败：显式回执（错误码：脱敏原因），不假装成功', async () => {
    const harness = makeState()
    harness.setSubmitResult({
      ok: false,
      code: 'VALIDATION_MISSING_FIELD',
      message: '还没有作品，先新建作品再保存设定。',
    })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-create-geomaps"]').trigger('click')
    await flushPromises()
    const notice = wrapper.get('[data-testid="geography-map-notice"]')
    expect(notice.text()).toContain('VALIDATION_MISSING_FIELD')
    expect(notice.text()).toContain('还没有作品，先新建作品再保存设定。')
  })
})

describe('更新（submitSettingsEntity）', () => {
  it('表格交回整行合并 values（含隐藏列），按当前 revision 提交', async () => {
    const harness = makeState({
      settingsEntities: [
        makeRow({
          id: 'row-a',
          name: '东海',
          values: {
            编号: 'MAP0001',
            名称: '东海',
            每格公里: '1',
            说明: '',
            底图模式: '格子',
            底图: '',
          },
        }),
      ],
    })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-cell-input-说明"]').setValue('新说明')
    await flushPromises()
    expect(harness.submits).toEqual([
      {
        entityId: 'row-a',
        schemaTemplateId: 'geomaps',
        name: '东海',
        values: {
          编号: 'MAP0001',
          名称: '东海',
          每格公里: '1',
          说明: '新说明',
          底图模式: '格子',
          底图: '',
        },
        expectedRevision: 'r00000001',
      },
    ])
  })

  it('更新失败：显式回执，不假装成功', async () => {
    const harness = makeState({
      settingsEntities: [makeRow({ id: 'row-a', values: { 名称: '东海', 说明: '' } })],
    })
    harness.setSubmitResult({ ok: false, code: 'REVISION_CONFLICT', message: '已被别处修改。' })
    const wrapper = mountPanel(harness)
    await flushPromises()
    await wrapper.get('[data-testid="table-cell-input-说明"]').setValue('新说明')
    await flushPromises()
    const notice = wrapper.get('[data-testid="geography-map-notice"]')
    expect(notice.text()).toContain('REVISION_CONFLICT')
    expect(notice.text()).toContain('已被别处修改。')
  })
})

describe('删除/重排（应用层还没有对应用例，只显回执）', () => {
  it('删除：只显中文回执，不提交、不假装成功', async () => {
    const harness = makeState({
      settingsEntities: [makeRow({ id: 'row-a', values: { 名称: '东海' } })],
    })
    const wrapper = mountPanel(harness)
    await wrapper.get('[data-testid="table-delete-row-a"]').trigger('click')
    expect(wrapper.get('[data-testid="geography-map-notice"]').text()).toContain(
      deletePendingNotice('row-a'),
    )
    expect(harness.submits).toHaveLength(0)
  })

  it('重排：只显中文回执（orderKey 交给应用层生成），不提交', async () => {
    const harness = makeState({
      settingsEntities: [
        makeRow({ id: 'row-a', orderKey: 'A01', values: { 名称: '东海' } }),
        makeRow({ id: 'row-b', orderKey: 'A02', values: { 名称: '西荒' } }),
      ],
    })
    const wrapper = mountPanel(harness)
    await wrapper.get('[data-testid="table-reorder-down-row-a"]').trigger('click')
    expect(wrapper.get('[data-testid="geography-map-notice"]').text()).toContain(
      '「调整顺序」还没接入（需要应用层生成 orderKey）：row-a',
    )
    expect(wrapper.get('[data-testid="geography-map-notice"]').text()).toContain(
      reorderPendingNotice('row-a', null).slice('「调整顺序」还没接入（需要应用层生成 orderKey）：'.length),
    )
    expect(harness.submits).toHaveLength(0)
  })
})
