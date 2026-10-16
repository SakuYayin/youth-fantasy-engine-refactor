// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentId, DocumentSummary, ProjectId, Revision, UtcTimestamp } from '@yfe/contracts'
import type { TabDef } from '@yfe/schema-tabs'

import type { AppSnapshot, AppState, SettingsEntityView } from '../../src/renderer/app-state.js'
import type { AiPort } from '../../src/renderer/ai/types.js'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import Dashboard from '../../src/renderer/panels/dashboard.vue'
import {
  DEFAULT_DAILY_GOAL,
  DASHBOARD_COPY,
  computeDashboardStats,
  progressLine,
  progressOf,
} from '../../src/renderer/panels/dashboard-model.js'

const AT = '2026-01-01T00:00:00.000Z'
const AT_LATER = '2026-01-02T12:30:00.000Z'

function ts(value: string): UtcTimestamp {
  return value as UtcTimestamp
}

interface SummaryInput {
  readonly id: string
  readonly title: string
  readonly kind?: DocumentSummary['kind']
  readonly projectId?: string
  readonly orderKey?: string
  readonly charCount?: number
  readonly deleted?: number
  readonly updatedAt?: string
}

function summary(input: SummaryInput): DocumentSummary {
  return {
    id: input.id as DocumentId,
    projectId: (input.projectId ?? 'prj_1') as ProjectId,
    kind: input.kind ?? 'chapter',
    parentId: null,
    orderKey: input.orderKey ?? 'A1',
    title: input.title,
    revision: 'rev_1' as Revision,
    deleted: input.deleted ?? 0,
    createdAt: ts(AT),
    updatedAt: ts(input.updatedAt ?? AT),
    charCount: input.charCount ?? 0,
    hasChildren: false,
  }
}

const demoTab: TabDef = {
  id: 'dashboard',
  name: '写作面板',
  group: '工作面板',
  type: 'dashboard',
  description: '写作统计总览与写作目标',
  tips: [],
}

/** 组件与依赖组件内建的中文字样白名单（非本面板文案）。 */
const CHROME_TEXT = ['本地已保存', '有未保存修改', '保存中', '保存失败']

/** 纯数据文本（数字/千分位/百分比/序号/单位/UTC 时间）不算文案。 */
const DATA_TEXT = /^(?:[\d,.]+\s*(?:字|%)?|\d{4}-\d{2}-\d{2} \d{2}:\d{2}（UTC）|\d+)$/

function textNodesOf(element: Element): string[] {
  const texts: string[] = []
  for (const node of element.childNodes) {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').trim()
      if (text !== '') {
        texts.push(text)
      }
    } else if (node.nodeType === 1) {
      texts.push(...textNodesOf(node as Element))
    }
  }
  return texts
}

function baseSnapshot(documents: readonly DocumentSummary[]): AppSnapshot {
  return {
    ready: true,
    loading: false,
    appVersion: 'test',
    databasePath: null,
    databaseSchemaVersion: 1,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'prj_1',
    tree: [],
    documents,
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
}

function stubAi(): AiPort {
  return {
    getConfig: () => null,
    configured: () => false,
    reload: async () => false,
    saveConfig: async () => false,
    complete: async () => ({
      ok: false,
      code: 'AI_NOT_CONFIGURED',
      message: '测试桩：未配置模型',
    }),
  }
}

interface HarnessOptions {
  readonly documents?: readonly DocumentSummary[]
  readonly settingsEntities?: readonly SettingsEntityView[]
  readonly submitOk?: boolean
}

function harness(options: HarnessOptions = {}) {
  let snapshot: AppSnapshot = baseSnapshot(options.documents ?? [])
  if (options.settingsEntities !== undefined) {
    snapshot = { ...snapshot, settingsEntities: options.settingsEntities }
  }
  let notify: ((next: AppSnapshot) => void) | undefined
  let unsubscribed = false
  const submitCalls: Array<Record<string, unknown>> = []
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      notify = listener
      return () => {
        unsubscribed = true
      }
    },
    start: async () => undefined,
    refresh: async () => undefined,
    createProject: async () => true,
    openProject: async () => true,
    createChapter: async () => true,
    selectDocument: async () => true,
    edit: () => undefined,
    flush: async () => true,
    applyExternalUpdate: () => true,
    retrySave: () => undefined,
    resolveConflict: () => undefined,
    toggleExpanded: () => undefined,
    setNavigationGuard: () => undefined,
    dispose: () => undefined,
    loadSettingsEntities: async () => true,
    selectSettingsEntity: async () => true,
    refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => {
      submitCalls.push({ ...submit })
      return options.submitOk === false
        ? { ok: false, code: 'NOT_IMPLEMENTED', message: '测试桩：保存失败' }
        : { ok: true, entityId: 'ent_1', revision: 'rev_1', orderKey: 'A1' }
    },
    ai: stubAi(),
  }
  return {
    state,
    submitCalls,
    isUnsubscribed: () => unsubscribed,
    async publish(patch: Partial<AppSnapshot>): Promise<void> {
      snapshot = { ...snapshot, ...patch }
      notify?.(snapshot)
      await nextTick()
    },
  }
}

/** mount 用本地 props 接口（带索引签名，匹配 vue-shims 的宽松组件类型）。 */
interface DashboardMountProps extends PanelProps {
  readonly [key: string]: unknown
}

function mountDashboard(state: AppState, tab: TabDef = demoTab) {
  const props: DashboardMountProps = { state, tab }
  return mount(Dashboard, { props })
}

async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('dashboard（写作面板）渲染', () => {
  it('渲染页签标题、四张统计卡与 Top5 列表', async () => {
    const documents = [
      summary({
        id: 'doc_1',
        title: '第一章 风起',
        charCount: 1200,
        orderKey: 'A1',
        updatedAt: AT,
      }),
      summary({
        id: 'doc_2',
        title: '第二章 云涌',
        charCount: 3400,
        orderKey: 'A2',
        updatedAt: AT_LATER,
      }),
      summary({
        id: 'doc_3',
        title: '另一本·第一章',
        charCount: 2600,
        projectId: 'prj_2',
        orderKey: 'A1',
      }),
      summary({ id: 'doc_4', title: '已删章节', charCount: 9999, deleted: 1, orderKey: 'A9' }),
      summary({ id: 'doc_5', title: '第一卷', kind: 'volume', charCount: 8888, orderKey: 'A0' }),
    ]
    const h = harness({ documents })
    const wrapper = mountDashboard(h.state)
    await settle()

    expect(wrapper.get('[data-testid="dashboard-panel"] .dashboard-panel__title').text()).toBe(
      demoTab.name,
    )
    const statValue = (testId: string): string => wrapper.get(`[data-testid="${testId}"] dd`).text()
    expect(statValue('dashboard-stat-projects')).toBe('2')
    expect(statValue('dashboard-stat-chapters')).toBe('3')
    expect(statValue('dashboard-stat-chars')).toBe('7,200')
    expect(statValue('dashboard-stat-updated')).toBe('2026-01-02 12:30（UTC）')

    const titles = wrapper
      .findAll('[data-testid="dashboard-top-list"] .dashboard-top__title')
      .map((node) => node.text())
    expect(titles).toEqual(['第二章 云涌', '另一本·第一章', '第一章 风起'])
    const chars = wrapper
      .findAll('[data-testid="dashboard-top-list"] .dashboard-top__chars')
      .map((node) => node.text())
    expect(chars).toEqual(['3,400 字', '2,600 字', '1,200 字'])
  })

  it('无作品时渲染中文引导而非统计卡', async () => {
    const h = harness({ documents: [] })
    const wrapper = mountDashboard(h.state)
    await settle()

    expect(wrapper.get('[data-testid="dashboard-empty"]').text()).toBe(DASHBOARD_COPY.emptyNoWorks)
    expect(wrapper.find('[data-testid="dashboard-stat-projects"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="dashboard-goal-input"]').exists()).toBe(false)
  })

  it('载入中先显示载入提示', async () => {
    const h = harness({ documents: [] })
    const wrapper = mountDashboard(h.state)
    await h.publish({ loading: true })
    expect(wrapper.get('[data-testid="dashboard-loading"]').text()).toBe(
      DASHBOARD_COPY.loadingWorks,
    )
    await h.publish({ loading: false })
    expect(wrapper.get('[data-testid="dashboard-empty"]').text()).toBe(DASHBOARD_COPY.emptyNoWorks)
  })

  it('有作品但无章节时显示空章节引导', async () => {
    const documents = [summary({ id: 'doc_1', title: '第一卷', kind: 'volume', orderKey: 'A0' })]
    const h = harness({ documents })
    const wrapper = mountDashboard(h.state)
    await settle()

    expect(wrapper.get('[data-testid="dashboard-top-empty"]').text()).toBe(
      DASHBOARD_COPY.emptyNoChapters,
    )
    expect(wrapper.get('[data-testid="dashboard-stat-chapters"] dd').text()).toBe('0')
  })

  it('订阅到新快照后统计自动刷新', async () => {
    const documents = [summary({ id: 'doc_1', title: '第一章', charCount: 1000, orderKey: 'A1' })]
    const h = harness({ documents })
    const wrapper = mountDashboard(h.state)
    await settle()
    expect(wrapper.get('[data-testid="dashboard-stat-chars"] dd').text()).toBe('1,000')

    await h.publish({
      documents: [
        summary({ id: 'doc_1', title: '第一章', charCount: 1000, orderKey: 'A1' }),
        summary({ id: 'doc_2', title: '第二章', charCount: 2500, orderKey: 'A2' }),
      ],
    })
    expect(wrapper.get('[data-testid="dashboard-stat-chars"] dd').text()).toBe('3,500')
    expect(wrapper.findAll('[data-testid="dashboard-top-list"] li')).toHaveLength(2)
  })

  it('可见中文文案只来自面板常量、页签文案、组件字样与纯数据', async () => {
    const documents = [
      summary({ id: 'doc_1', title: '第一章 风起', charCount: 1200, orderKey: 'A1', updatedAt: AT }),
      summary({
        id: 'doc_2',
        title: '第二章 云涌',
        charCount: 700,
        orderKey: 'A2',
        updatedAt: AT_LATER,
      }),
    ]
    const stats = computeDashboardStats(documents)
    const progress = progressOf(stats.totalChars, DEFAULT_DAILY_GOAL)
    const allowed = new Set<string>([
      demoTab.name,
      demoTab.description,
      ...Object.values(DASHBOARD_COPY),
      progressLine(progress),
      ...CHROME_TEXT,
      ...documents.map((document) => document.title),
    ])
    const h = harness({ documents })
    const wrapper = mountDashboard(h.state)
    await settle()

    const foreign = textNodesOf(wrapper.element).filter(
      (text) => !allowed.has(text) && !DATA_TEXT.test(text),
    )
    expect(foreign).toEqual([])
  })
})

describe('dashboard（写作面板）写作目标', () => {
  const oneChapter = (): HarnessOptions => ({
    documents: [summary({ id: 'doc_1', title: '第一章', charCount: 1000, orderKey: 'A1' })],
  })

  it('默认目标 2000，总字数 1000 时进度 50%', async () => {
    const h = harness(oneChapter())
    const wrapper = mountDashboard(h.state)
    await settle()

    expect(DEFAULT_DAILY_GOAL).toBe(2000)
    expect(wrapper.get<HTMLInputElement>('[data-testid="dashboard-goal-input"]').element.value).toBe(
      '2000',
    )
    expect(wrapper.get('[data-testid="dashboard-goal-bar"]').attributes('aria-valuenow')).toBe('50')
    expect(
      (wrapper.get('[data-testid="dashboard-goal-fill"]').element as HTMLElement).style.width,
    ).toBe('50%')
    expect(wrapper.get('[data-testid="dashboard-goal-progress"]').text()).toBe(
      '已完成 50%，还差 1,000 字',
    )
    expect(wrapper.get('[data-testid="dashboard-goal-note"]').text()).toBe(DASHBOARD_COPY.goalNote)
  })

  it('改目标输入框会更新进度并标脏，点立即保存后落库', async () => {
    const h = harness(oneChapter())
    const wrapper = mountDashboard(h.state)
    await settle()

    await wrapper.get('[data-testid="dashboard-goal-input"]').setValue('3500')
    await nextTick()
    expect(wrapper.get('[data-testid="dashboard-goal-bar"]').attributes('aria-valuenow')).toBe(
      '28.6',
    )
    expect(wrapper.get('[data-testid="dashboard-goal-progress"]').text()).toBe(
      '已完成 28.6%，还差 2,500 字',
    )
    expect(wrapper.get('[data-testid="dashboard-goal-status"]').text()).toContain('有未保存修改')

    await wrapper.get('[data-testid="dashboard-goal-save"]').trigger('click')
    await settle()

    expect(h.submitCalls).toHaveLength(1)
    const submit = h.submitCalls[0]!
    expect(submit['schemaTemplateId']).toBe('panel:dashboard')
    expect(submit['values']).toEqual({ dailyGoal: 3500 })
    expect(wrapper.get('[data-testid="dashboard-goal-status"]').text()).toContain('本地已保存')
  })

  it('改目标后 1.5 秒自动保存（防抖）', async () => {
    vi.useFakeTimers()
    const h = harness(oneChapter())
    const wrapper = mountDashboard(h.state)
    await settle()

    await wrapper.get('[data-testid="dashboard-goal-input"]').setValue('3000')
    expect(h.submitCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1600)
    expect(h.submitCalls).toHaveLength(1)
    expect(h.submitCalls[0]?.['values']).toEqual({ dailyGoal: 3000 })
  })

  it('无效目标输入不落库并给出提示，有效输入后提示消失', async () => {
    const h = harness(oneChapter())
    const wrapper = mountDashboard(h.state)
    await settle()

    const input = wrapper.get('[data-testid="dashboard-goal-input"]')
    await input.setValue('abc')
    await nextTick()
    expect(wrapper.get('[data-testid="dashboard-goal-hint"]').text()).toBe(
      DASHBOARD_COPY.hintInvalidGoal,
    )
    expect(h.submitCalls).toHaveLength(0)

    await input.setValue('-5')
    await nextTick()
    expect(wrapper.get('[data-testid="dashboard-goal-hint"]').text()).toBe(
      DASHBOARD_COPY.hintInvalidGoal,
    )

    await input.setValue('3000')
    await nextTick()
    expect(wrapper.find('[data-testid="dashboard-goal-hint"]').exists()).toBe(false)
  })

  it('保存失败时显示错误且保留本地目标', async () => {
    const h = harness({ ...oneChapter(), submitOk: false })
    const wrapper = mountDashboard(h.state)
    await settle()

    await wrapper.get('[data-testid="dashboard-goal-input"]').setValue('3500')
    await wrapper.get('[data-testid="dashboard-goal-save"]').trigger('click')
    await settle()

    expect(h.submitCalls).toHaveLength(1)
    expect(wrapper.get('[data-testid="dashboard-goal-error"]').text()).toContain('NOT_IMPLEMENTED')
    expect(wrapper.get('[data-testid="dashboard-goal-status"]').text()).toContain('保存失败')
    expect(
      wrapper.get<HTMLInputElement>('[data-testid="dashboard-goal-input"]').element.value,
    ).toBe('3500')
  })

  it('载入已保存的面板状态后回显目标', async () => {
    const stored: SettingsEntityView = {
      id: 'ent_9',
      projectId: 'prj_1',
      schemaTemplateId: 'panel:dashboard',
      name: '面板状态',
      values: { dailyGoal: 3500 },
      orderKey: 'A1',
      revision: 'rev_9',
      deleted: false,
    }
    const h = harness({ ...oneChapter(), settingsEntities: [stored] })
    const wrapper = mountDashboard(h.state)
    await settle()

    expect(
      wrapper.get<HTMLInputElement>('[data-testid="dashboard-goal-input"]').element.value,
    ).toBe('3500')
    expect(wrapper.get('[data-testid="dashboard-goal-bar"]').attributes('aria-valuenow')).toBe(
      '28.6',
    )
  })

  it('卸载时解订阅，且 dispose 后不再自动保存', async () => {
    vi.useFakeTimers()
    const h = harness(oneChapter())
    const wrapper = mountDashboard(h.state)
    await settle()
    expect(h.isUnsubscribed()).toBe(false)

    await wrapper.get('[data-testid="dashboard-goal-input"]').setValue('3000')
    wrapper.unmount()
    expect(h.isUnsubscribed()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.submitCalls).toHaveLength(0)
    await expect(h.publish({ documents: [] })).resolves.toBeUndefined()
  })
})
