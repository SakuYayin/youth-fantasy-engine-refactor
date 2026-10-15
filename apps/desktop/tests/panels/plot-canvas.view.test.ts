// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { getTab } from '@yfe/schema-tabs'
import { nextTick } from 'vue'

import type { AppSnapshot, AppState, ChapterNodeView } from '../../src/renderer/app-state.js'
import type { AiResult } from '../../src/renderer/ai/types.js'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import { formatNodeCount, PLOT_PANEL_TEXT, type PlotNode } from '../../src/renderer/panels/plot-canvas-model.js'
import PlotCanvas from '../../src/renderer/panels/plot-canvas.vue'

const plotTab = getTab('plot-canvas')
if (plotTab === undefined) {
  throw new Error('页签 plot-canvas 未注册（@yfe/schema-tabs）')
}

/** 微任务冲刷：不依赖宏定时器（fake timers 下也可用），末尾等一帧渲染。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
  await nextTick()
}

/** 章节树节点夹具（ChapterNodeView 完整字段）。 */
function chapterNode(patch: Partial<ChapterNodeView> = {}): ChapterNodeView {
  return {
    id: 'ch_1',
    label: '第一章 试炼开始',
    depth: 1,
    kind: 'chapter',
    hasChildren: false,
    deleted: false,
    current: false,
    ...patch,
  }
}

/** 已保存的 plot-canvas 面板状态实体（settingsEntities 行，schemaTemplateId 对齐模板）。 */
const panelEntity = {
  id: 'entity_plot_1',
  projectId: 'project_1',
  schemaTemplateId: 'panel:plot-canvas',
  name: '面板状态',
  values: {
    nodes: [
      { id: 'node_1', title: '灵纹觉醒', summary: '主角在试炼中觉醒灵纹', status: 'draft', chapterId: 'ch_1' },
      { id: 'node_2', title: '夜探禁地', summary: '与同门夜探禁地发现密道', status: 'todo', chapterId: null },
    ],
  },
  orderKey: '0001',
  revision: 'rev_1',
  deleted: false,
}

/** AppSnapshot 夹具（完整字段；plot-canvas 只消费 projectId/tree/settingsEntities）。 */
function snapshotWith(patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ready: true,
    loading: false,
    appVersion: '0.1.0-test',
    databasePath: null,
    databaseSchemaVersion: 1,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'project_1',
    tree: [chapterNode()],
    documents: [],
    selectedDocumentId: null,
    title: '',
    body: '',
    charCount: 0,
    revision: 'rev_0',
    saveStatus: 'saved',
    saveDetail: null,
    conflict: null,
    lastError: null,
    expandedIds: [],
    settingsEntities: [],
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
    ...patch,
  }
}

interface HarnessOptions {
  readonly snapshot?: AppSnapshot
  readonly aiConfigured?: boolean
  readonly complete?: (request: unknown) => Promise<AiResult>
}

/** AppState 桩（结构满足 AppState；订阅/加载/提交/AI 可观测）。 */
function createHarness(options: HarnessOptions = {}) {
  let snapshot = options.snapshot ?? snapshotWith()
  let notify: ((next: AppSnapshot) => void) | null = null
  const unsubscribe = vi.fn()
  const loadQueries: unknown[] = []
  const submitCalls: unknown[] = []

  const ai = {
    getConfig: () => null,
    configured: () => options.aiConfigured !== false,
    reload: async () => true,
    saveConfig: async () => false,
    complete:
      options.complete ??
      (async () => ({ ok: true, text: '主角在试炼中觉醒灵纹，随后与同门夜探禁地发现密道。' })),
  }

  const state = {
    getSnapshot: () => snapshot,
    subscribe: (listener: (next: AppSnapshot) => void) => {
      notify = listener
      return unsubscribe
    },
    start: () => undefined,
    refresh: () => undefined,
    createProject: async () => false,
    createChapter: async () => false,
    selectDocument: () => undefined,
    edit: () => undefined,
    flush: async () => true,
    applyExternalUpdate: () => false,
    retrySave: () => undefined,
    resolveConflict: () => undefined,
    toggleExpanded: () => undefined,
    setNavigationGuard: () => undefined,
    dispose: () => undefined,
    loadSettingsEntities: async (query?: unknown) => {
      loadQueries.push(query)
      return true
    },
    selectSettingsEntity: () => undefined,
    refreshSettingsEntity: () => undefined,
    submitSettingsEntity: async (submit: unknown) => {
      submitCalls.push(submit)
      return { ok: false, code: 'NOT_IMPLEMENTED', message: '测试桩' }
    },
    ai,
  } as unknown as AppState

  async function publish(patch: Partial<AppSnapshot>): Promise<void> {
    snapshot = { ...snapshot, ...patch }
    notify?.(snapshot)
    await nextTick()
  }

  return { state, unsubscribe, loadQueries, submitCalls, publish }
}

type PlotCanvasTab = PanelProps['tab']

interface PlotCanvasMountProps {
  readonly state: AppState
  readonly tab: PlotCanvasTab
  readonly [key: string]: unknown
}

/** 挂载面板（本地 props 接口带索引签名）并等挂载期 load 完成。 */
async function mountPanel(state: AppState) {
  const mountProps: PlotCanvasMountProps = { state, tab: plotTab! }
  const wrapper = mount(PlotCanvas, { props: mountProps })
  await flushPromises()
  return wrapper
}

describe('plot-canvas 视图：初始渲染', () => {
  it('空数据：渲染页签标题、简介、空态、简化画布预览说明与图例，计数为 0', async () => {
    const { state } = createHarness()
    const wrapper = await mountPanel(state)

    expect(wrapper.get('[data-testid="plot-canvas-panel"]').element).toBeDefined()
    const text = wrapper.get('[data-testid="plot-canvas-panel"]').text()
    expect(text).toContain(plotTab.name)
    expect(text).toContain(PLOT_PANEL_TEXT.intro)
    expect(text).toContain(PLOT_PANEL_TEXT.listTitle)
    expect(text).toContain(PLOT_PANEL_TEXT.canvasTitle)
    expect(text).toContain(PLOT_PANEL_TEXT.previewNote)
    expect(text).toContain(PLOT_PANEL_TEXT.emptyNodes)
    expect(text).toContain(PLOT_PANEL_TEXT.idleHint)
    expect(wrapper.get('[data-testid="plot-canvas-node-count"]').text()).toBe(formatNodeCount(0))
    expect(wrapper.findAll('[data-testid="plot-canvas-node"]').length).toBe(0)
    const legend = wrapper.get('[data-testid="plot-canvas-legend"]').text()
    expect(legend).toContain('未写')
    expect(legend).toContain('草稿')
    expect(legend).toContain('完成')
    expect(wrapper.get('[data-testid="plot-canvas-save-status"]').attributes('data-status')).toBe('saved')
    wrapper.unmount()
  })

  it('无当前作品：显示「请先在左侧新建作品」，节点编辑仍可用', async () => {
    const { state } = createHarness({ snapshot: snapshotWith({ projectId: null }) })
    const wrapper = await mountPanel(state)

    expect(wrapper.get('[data-testid="plot-canvas-no-project"]').text()).toBe(PLOT_PANEL_TEXT.noProject)
    await wrapper.get('[data-testid="plot-canvas-add-node"]').trigger('click')
    expect(wrapper.findAll('[data-testid="plot-canvas-node"]').length).toBe(1)
    expect(wrapper.get('[data-testid="plot-canvas-node-count"]').text()).toBe(formatNodeCount(1))
    wrapper.unmount()
  })

  it('载入已保存节点：按章节分组渲染卡片与未归属分组，画布泳道与色块对应', async () => {
    const { state, loadQueries } = createHarness({ snapshot: snapshotWith({ settingsEntities: [panelEntity] }) })
    const wrapper = await mountPanel(state)

    expect(loadQueries.length).toBe(1)
    expect((loadQueries[0] as { schemaTemplateId?: unknown }).schemaTemplateId).toBe('panel:plot-canvas')
    expect(wrapper.get('[data-testid="plot-canvas-node-count"]').text()).toBe(formatNodeCount(2))
    expect(wrapper.get('[data-testid="plot-canvas-message"]').text()).toBe(PLOT_PANEL_TEXT.loadedFromStore)

    const groups = wrapper.findAll('[data-testid="plot-canvas-group"]')
    expect(groups.length).toBe(2)
    expect(groups[0]?.text()).toContain('第一章 试炼开始')
    expect(groups[1]?.text()).toContain(PLOT_PANEL_TEXT.unassigned)

    const titles = wrapper.findAll('[data-testid="plot-canvas-node-title"]')
    expect((titles[0]?.element as HTMLInputElement | undefined)?.value).toBe('灵纹觉醒')
    expect((titles[1]?.element as HTMLInputElement | undefined)?.value).toBe('夜探禁地')

    expect(wrapper.findAll('[data-testid="plot-canvas-lane"]').length).toBe(2)
    expect(wrapper.findAll('[data-testid="plot-canvas-segment"]').length).toBe(2)
    expect(wrapper.get('[data-testid="plot-canvas-save-status"]').attributes('data-status')).toBe('saved')
    wrapper.unmount()
  })

  it('节点状态与画布色块联动：状态切换后色块类名跟随', async () => {
    const { state } = createHarness({ snapshot: snapshotWith({ settingsEntities: [panelEntity] }) })
    const wrapper = await mountPanel(state)

    const segments = wrapper.findAll('[data-testid="plot-canvas-segment"]')
    expect(segments[0]?.classes()).toContain('plot-canvas__fill--draft')
    expect(segments[1]?.classes()).toContain('plot-canvas__fill--todo')

    await wrapper.get('[data-testid="plot-canvas-node-status"]').setValue('done')
    await nextTick()
    const after = wrapper.findAll('[data-testid="plot-canvas-segment"]')
    expect(after[0]?.classes()).toContain('plot-canvas__fill--done')
    wrapper.unmount()
  })
})

describe('plot-canvas 视图：编辑与自动保存', () => {
  it('编辑节点：本地镜像同步进面板状态并触发自动保存；保存失败不丢本地数据', async () => {
    const { state, submitCalls } = createHarness({ snapshot: snapshotWith({ settingsEntities: [panelEntity] }) })
    const wrapper = await mountPanel(state)

    vi.useFakeTimers()
    try {
      await wrapper.get('[data-testid="plot-canvas-node-title"]').setValue('灵纹觉醒·改')
      await wrapper.get('[data-testid="plot-canvas-node-status"]').setValue('done')
      await wrapper.get('[data-testid="plot-canvas-add-node"]').trigger('click')
      expect(wrapper.get('[data-testid="plot-canvas-node-count"]').text()).toBe(formatNodeCount(3))
      expect(wrapper.get('[data-testid="plot-canvas-save-status"]').attributes('data-status')).toBe('dirty')
      expect(submitCalls.length).toBe(0)

      vi.advanceTimersByTime(1600)
      await settle()
      expect(submitCalls.length).toBe(1)
      const submit = submitCalls[0] as {
        schemaTemplateId: unknown
        name: unknown
        values: { nodes: Array<{ id: string; title: string; status: string }> }
      }
      expect(submit.schemaTemplateId).toBe('panel:plot-canvas')
      expect(submit.name).toBe('面板状态')
      expect(submit.values.nodes.length).toBe(3)
      expect(submit.values.nodes.some((node) => node.title === '灵纹觉醒·改')).toBe(true)
      expect(submit.values.nodes.some((node) => node.status === 'done')).toBe(true)

      // 桩返回保存失败：错误横幅出现，状态徽标转 error，本地节点不丢
      await settle()
      expect(wrapper.get('[data-testid="plot-canvas-store-error"]').text()).toContain('NOT_IMPLEMENTED')
      expect(wrapper.get('[data-testid="plot-canvas-save-status"]').attributes('data-status')).toBe('error')
      expect(wrapper.findAll('[data-testid="plot-canvas-node"]').length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('删除节点：卡片移除并同步进面板状态提交', async () => {
    const { state, submitCalls } = createHarness({ snapshot: snapshotWith({ settingsEntities: [panelEntity] }) })
    const wrapper = await mountPanel(state)

    vi.useFakeTimers()
    try {
      const removeButtons = wrapper.findAll('[data-testid="plot-canvas-remove-node"]')
      await removeButtons[0]?.trigger('click')
      expect(wrapper.findAll('[data-testid="plot-canvas-node"]').length).toBe(1)
      expect(wrapper.get('[data-testid="plot-canvas-node-count"]').text()).toBe(formatNodeCount(1))

      vi.advanceTimersByTime(1600)
      await settle()
      expect(submitCalls.length).toBe(1)
      const submitted = (submitCalls[0] as { values: { nodes: Array<{ id: string }> } }).values.nodes
      expect(submitted.length).toBe(1)
      expect(submitted[0]?.id).toBe('node_2')
    } finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('卸载：取消订阅并释放面板状态，未到期的自动保存不再提交', async () => {
    const { state, submitCalls, unsubscribe } = createHarness()
    const wrapper = await mountPanel(state)
    expect(unsubscribe).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      await wrapper.get('[data-testid="plot-canvas-add-node"]').trigger('click')
      wrapper.unmount()
      expect(unsubscribe).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(5000)
      await settle()
      expect(submitCalls.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('plot-canvas 视图：AI 情节摘要', () => {
  it('摘要成功：请求只发一次且形状正确（无 maxTokens/temperature），完成后展示摘要', async () => {
    const completeCalls: unknown[] = []
    let resolveComplete: ((result: AiResult) => void) | undefined
    const { state } = createHarness({
      snapshot: snapshotWith({ settingsEntities: [panelEntity] }),
      complete: (request) => {
        completeCalls.push(request)
        return new Promise<AiResult>((resolve) => {
          resolveComplete = resolve
        })
      },
    })
    const wrapper = await mountPanel(state)

    await wrapper.get('[data-testid="plot-canvas-ai-summary"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="plot-canvas-ai-summary"]').text()).toContain(PLOT_PANEL_TEXT.aiRunning)
    expect(completeCalls.length).toBe(1)

    const request = completeCalls[0] as {
      system: string
      messages: Array<{ role: string; content: string }>
    }
    expect(request.system).toContain('情节摘要助手')
    expect(request.messages.length).toBe(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toContain(`【摘要范围】${PLOT_PANEL_TEXT.allChapters}`)
    expect(request.messages[0]?.content).toContain('灵纹觉醒')
    expect('maxTokens' in request).toBe(false)
    expect('temperature' in request).toBe(false)

    resolveComplete?.({ ok: true, text: '主角在试炼中觉醒灵纹，随后与同门夜探禁地。' })
    await settle()
    expect(wrapper.get('[data-testid="plot-canvas-ai-result"]').text()).toContain('主角在试炼中觉醒灵纹')
    expect(wrapper.get('[data-testid="plot-canvas-ai-summary"]').text()).toContain(PLOT_PANEL_TEXT.aiButton)
    wrapper.unmount()
  })

  it('未配置模型：点击摘要按钮显示引导文案且不发起请求（按钮不禁用）', async () => {
    const completeCalls: unknown[] = []
    const { state } = createHarness({
      snapshot: snapshotWith({ settingsEntities: [panelEntity] }),
      aiConfigured: false,
      complete: (request) => {
        completeCalls.push(request)
        return Promise.resolve({ ok: true, text: '不应发生' })
      },
    })
    const wrapper = await mountPanel(state)

    const button = wrapper.get('[data-testid="plot-canvas-ai-summary"]').element as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await wrapper.get('[data-testid="plot-canvas-ai-summary"]').trigger('click')
    await settle()
    expect(completeCalls.length).toBe(0)
    expect(wrapper.get('[data-testid="plot-canvas-message"]').text()).toBe(PLOT_PANEL_TEXT.notConfigured)
    wrapper.unmount()
  })

  it('AI 失败：显示「情节摘要失败：原因」错误信息', async () => {
    const { state } = createHarness({
      snapshot: snapshotWith({ settingsEntities: [panelEntity] }),
      complete: async () => ({ ok: false, code: 'AI_UPSTREAM_ERROR', message: '上游超时' }),
    })
    const wrapper = await mountPanel(state)

    await wrapper.get('[data-testid="plot-canvas-ai-summary"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="plot-canvas-message"]').text()).toBe(
      `${PLOT_PANEL_TEXT.summaryFailed}：上游超时`,
    )
    wrapper.unmount()
  })

  it('没有可摘要节点：点击摘要按钮给出提示且不发起请求', async () => {
    const completeCalls: unknown[] = []
    const { state } = createHarness({
      complete: (request) => {
        completeCalls.push(request)
        return Promise.resolve({ ok: true, text: '不应发生' })
      },
    })
    const wrapper = await mountPanel(state)

    await wrapper.get('[data-testid="plot-canvas-ai-summary"]').trigger('click')
    await settle()
    expect(completeCalls.length).toBe(0)
    expect(wrapper.get('[data-testid="plot-canvas-message"]').text()).toBe(PLOT_PANEL_TEXT.aiEmpty)
    wrapper.unmount()
  })
})
