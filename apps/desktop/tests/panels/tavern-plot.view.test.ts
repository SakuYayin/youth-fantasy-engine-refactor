// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 剧情推演面板（tavern-plot）视图测试（happy-dom 挂载）。
 *
 * 覆盖：挂载文案/空态、新建（标题必填→落库）、编辑回灌、删除（YfeDialog 确认/取消）、
 * 上移/下移（order 归一化）、AI 续写（未配置模型引导 / 成功解析→确认追加 /
 * 解析失败不落库 / 上游失败）、载入失败与保存失败错误态。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import type { SettingsEntitySubmit, SettingsEntitySubmitResult } from '../../src/renderer/app-state.js'
import type { AppState } from '../../src/renderer/app-state.js'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'
import TavernPlotPanel from '../../src/renderer/panels/tavern-plot.vue'
import type { TavernPlotSceneRecord } from '../../src/renderer/panels/tavern-plot-model.js'

const tab: TabDef = getTab('tavern-plot')!
if (tab === undefined) throw new Error('页签 tavern-plot 未注册（schema-tabs）')

const SCENE_TITLE_REQUIRED = '标题不能为空。'
const AI_PARSE_FAILED = 'AI 返回的内容无法解析成剧情 JSON，本次结果未落库。'

interface PanelTestProps extends PanelProps {
  readonly [key: string]: unknown
}

interface StoreRow {
  schemaTemplateId: string
  deleted: boolean
  entityId: string
  revision: string
  values: Record<string, unknown>
}

/** 完整 AppSnapshot 夹具（与 app-state.ts 快照字段一一对应）。 */
function makeSnapshot(entities: StoreRow[]): Record<string, unknown> {
  return {
    ready: true,
    loading: false,
    appVersion: 'test',
    databasePath: null,
    databaseSchemaVersion: 1,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'project_1',
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
    settingsEntities: entities.map((row, index) => ({
      id: row.entityId,
      projectId: 'project_1',
      schemaTemplateId: row.schemaTemplateId,
      name: '面板状态',
      values: row.values,
      orderKey: `plot_${String(index).padStart(4, '0')}`,
      revision: row.revision,
      deleted: row.deleted,
    })),
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
}

interface AiStub {
  calls: AiRequest[]
  configuredFlag: boolean
  responder: ((request: AiRequest) => Promise<AiResult>) | null
}

function makeAiStub(): { stub: Record<string, unknown>; ai: AiStub } {
  const ai: AiStub = { calls: [], configuredFlag: true, responder: null }
  const stub: Record<string, unknown> = {
    getConfig: vi.fn(() => null),
    configured: vi.fn(() => ai.configuredFlag),
    reload: vi.fn(async () => true),
    saveConfig: vi.fn(async () => true),
    complete: vi.fn(async (request: AiRequest) => {
      ai.calls.push(request)
      if (ai.responder === null) {
        return { ok: false, code: 'AI_NOT_CONFIGURED', message: '测试桩：未配置模型' } satisfies AiResult
      }
      return ai.responder(request)
    }),
  }
  return { stub, ai }
}

/** 场景行夹具（已存 values.items 的元素）。 */
function sceneRow(input: Partial<TavernPlotSceneRecord> & { id: string }): TavernPlotSceneRecord {
  return {
    title: '场景',
    brief: '',
    messages: [],
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  }
}

function plotEntities(items: TavernPlotSceneRecord[]): StoreRow[] {
  return [
    {
      schemaTemplateId: 'panel:tavern-plot',
      deleted: false,
      entityId: 'ent_plot_1',
      revision: 'rev_1',
      values: { items },
    },
  ]
}

interface Harness {
  wrapper: ReturnType<typeof mount>
  submitCalls: SettingsEntitySubmit[]
  loadQueries: Array<Record<string, unknown> | undefined>
  ai: AiStub
}

function mountPanel(
  options: {
    entities?: StoreRow[]
    aiConfigured?: boolean
    loadShouldThrow?: boolean
    submitFailure?: { code: string; message: string }
  } = {},
): Harness {
  const entities = options.entities ?? []
  const { stub, ai } = makeAiStub()
  if (options.aiConfigured !== undefined) ai.configuredFlag = options.aiConfigured
  const submitCalls: SettingsEntitySubmit[] = []
  const loadQueries: Array<Record<string, unknown> | undefined> = []
  const snapshot = makeSnapshot(entities)

  const stateStub: Record<string, unknown> = {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn(() => () => undefined),
    start: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    createProject: vi.fn(async () => undefined),
    createChapter: vi.fn(async () => undefined),
    selectDocument: vi.fn(async () => undefined),
    edit: vi.fn(),
    flush: vi.fn(async () => undefined),
    applyExternalUpdate: vi.fn(async () => undefined),
    retrySave: vi.fn(async () => undefined),
    resolveConflict: vi.fn(),
    toggleExpanded: vi.fn(),
    setNavigationGuard: vi.fn(),
    dispose: vi.fn(),
    loadSettingsEntities: vi.fn(async (query?: Record<string, unknown>) => {
      loadQueries.push(query)
      if (options.loadShouldThrow === true) throw new Error('测试桩：载入失败')
      return true
    }),
    selectSettingsEntity: vi.fn(),
    refreshSettingsEntity: vi.fn(),
    submitSettingsEntity: vi.fn(async (submit: SettingsEntitySubmit) => {
      submitCalls.push(submit)
      if (options.submitFailure !== undefined) {
        return {
          ok: false,
          code: options.submitFailure.code,
          message: options.submitFailure.message,
        } satisfies SettingsEntitySubmitResult
      }
      return {
        ok: true,
        entityId: entities[0]?.entityId ?? 'ent_plot_new',
        revision: 'rev_next',
        orderKey: 'A1',
      } satisfies SettingsEntitySubmitResult
    }),
    ai: stub,
  }

  const wrapper = mount(TavernPlotPanel as unknown as PanelTestProps, {
    props: { state: stateStub as unknown as AppState, tab } satisfies PanelTestProps,
  })
  return { wrapper, submitCalls, loadQueries, ai }
}

/** 等微任务与渲染稳定（与其它面板视图测试同口径）。 */
async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function panelText(harness: Harness): string {
  return harness.wrapper.get('[data-testid="tavern-plot-panel"]').text()
}

/** 点击对话框动作区里文本匹配的按钮（YfeDialog 按钮无 testid，落在 .yfe-dialog__actions）。 */
async function clickDialogButton(harness: Harness, label: string): Promise<void> {
  const actions = harness.wrapper.get('.yfe-dialog__actions')
  const button = actions.findAll('button').find((candidate) => candidate.text() === label)
  if (button === undefined) throw new Error(`对话框按钮「${label}」不存在`)
  await button.trigger('click')
}

function submittedItems(harness: Harness, index: number): TavernPlotSceneRecord[] {
  const values = harness.submitCalls[index]?.values as { items?: TavernPlotSceneRecord[] }
  return values.items ?? []
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tavern-plot 面板挂载与静态文案', () => {
  it('标题用页签名，说明含「场景按顺序拼进酒馆对话的系统提示词」，空态给引导', async () => {
    const harness = mountPanel()
    await settle()
    expect(harness.wrapper.get('h1').text()).toBe('剧情推演')
    expect(panelText(harness)).toContain('场景按顺序拼进酒馆对话的系统提示词')
    expect(harness.wrapper.get('[data-testid="tavern-plot-empty"]').text()).toContain('还没有场景')
    expect(harness.wrapper.get('[data-testid="tavern-plot-overview"]').text()).toBe('共 0 个场景')
    expect(harness.loadQueries[0]).toMatchObject({ schemaTemplateId: 'panel:tavern-plot' })
    expect(harness.ai.calls).toHaveLength(0)
    expect(harness.submitCalls).toHaveLength(0)
  })

  it('已存场景按 order 渲染（序号/标题/摘要），操作按钮齐全', async () => {
    const harness = mountPanel({
      entities: plotEntities([
        sceneRow({ id: 'plot_a', title: '第一幕', brief: '少年捡到徽章', order: 0 }),
        sceneRow({ id: 'plot_b', title: '第二幕', brief: '', order: 1 }),
      ]),
    })
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-item-plot_a"]').text()).toContain('第一幕')
    expect(harness.wrapper.get('[data-testid="tavern-plot-item-plot_b"]').text()).toContain('第二幕')
    expect(harness.wrapper.get('[data-testid="tavern-plot-overview"]').text()).toBe('共 2 个场景')
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-up-plot_a"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-down-plot_b"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-up-plot_b"]').element as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(harness.wrapper.get('[data-testid="tavern-plot-delete-plot_a"]').element).toBeDefined()
  })
})

describe('tavern-plot 新建/编辑/删除/移动', () => {
  it('新建：空标题报「标题不能为空。」不落库；填写后 set+save 落库、输入清空', async () => {
    const harness = mountPanel()
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-new"]').trigger('click')
    await settle()
    // 空标题提交 → 表单错误、不落库
    await harness.wrapper.get('[data-testid="tavern-plot-save"]').trigger('click')
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-form-error"]').text()).toBe(
      SCENE_TITLE_REQUIRED,
    )
    expect(harness.submitCalls).toHaveLength(0)
    expect(harness.wrapper.find('[data-testid="tavern-plot-store-error"]').exists()).toBe(false)
    // 填标题与简述 → 落库
    harness.wrapper.get('[data-testid="tavern-plot-input-title"]').setValue('第一幕')
    harness.wrapper.get('[data-testid="tavern-plot-input-brief"]').setValue('少年捡到徽章')
    await harness.wrapper.get('[data-testid="tavern-plot-save"]').trigger('click')
    await settle()
    await settle()
    expect(harness.submitCalls).toHaveLength(1)
    expect(harness.submitCalls[0]?.schemaTemplateId).toBe('panel:tavern-plot')
    expect(harness.submitCalls[0]?.name).toBe('面板状态')
    const items = submittedItems(harness, 0)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('第一幕')
    expect(items[0]?.brief).toBe('少年捡到徽章')
    expect(items[0]?.order).toBe(0)
    expect(items[0]?.id.startsWith('plot_')).toBe(true)
    expect(items[0]?.messages).toEqual([])
    // 表单复位：留在新建模式、输入清空、错误消失
    expect((harness.wrapper.get('[data-testid="tavern-plot-input-title"]').element as HTMLInputElement).value).toBe('')
    expect((harness.wrapper.get('[data-testid="tavern-plot-input-brief"]').element as HTMLTextAreaElement).value).toBe('')
    expect(harness.wrapper.find('[data-testid="tavern-plot-form-error"]').exists()).toBe(false)
    expect((harness.wrapper.get('[data-status="saved"]').element)).toBeDefined()
  })

  it('编辑回灌：点场景回填表单，保存后原位替换且保留 id；取消编辑可退出', async () => {
    const harness = mountPanel({
      entities: plotEntities([sceneRow({ id: 'plot_a', title: '第一幕', brief: '', order: 0 })]),
    })
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-item-plot_a"]').trigger('click')
    await settle()
    expect((harness.wrapper.get('[data-testid="tavern-plot-input-title"]').element as HTMLInputElement).value).toBe('第一幕')
    expect(harness.wrapper.find('[data-testid="tavern-plot-cancel-edit"]').exists()).toBe(true)
    harness.wrapper.get('[data-testid="tavern-plot-input-title"]').setValue('第一幕（修订）')
    await harness.wrapper.get('[data-testid="tavern-plot-save"]').trigger('click')
    await settle()
    await settle()
    const items = submittedItems(harness, 0)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe('plot_a')
    expect(items[0]?.title).toBe('第一幕（修订）')
    expect(items[0]?.order).toBe(0)
    // 保存后退出编辑态
    expect(harness.wrapper.find('[data-testid="tavern-plot-cancel-edit"]').exists()).toBe(false)
  })

  it('删除：YfeDialog 确认后 set+save、order 归一化；取消不落库', async () => {
    const harness = mountPanel({
      entities: plotEntities([
        sceneRow({ id: 'plot_a', title: '第一幕', order: 0 }),
        sceneRow({ id: 'plot_b', title: '第二幕', order: 1 }),
      ]),
    })
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-delete-plot_a"]').trigger('click')
    await settle()
    expect(panelText(harness)).toContain('确定删除「第一幕」吗？删除后无法恢复。')
    // 取消：不落库
    await clickDialogButton(harness, '取消')
    await settle()
    expect(harness.submitCalls).toHaveLength(0)
    expect(harness.wrapper.find('[data-testid="tavern-plot-item-plot_a"]').exists()).toBe(true)
    // 确认：落库
    await harness.wrapper.get('[data-testid="tavern-plot-delete-plot_a"]').trigger('click')
    await settle()
    await clickDialogButton(harness, '确认删除')
    await settle()
    await settle()
    expect(harness.submitCalls).toHaveLength(1)
    const items = submittedItems(harness, 0)
    expect(items.map((item) => item.id)).toEqual(['plot_b'])
    expect(items[0]?.order).toBe(0)
    expect(harness.wrapper.find('[data-testid="tavern-plot-item-plot_a"]').exists()).toBe(false)
    expect((harness.wrapper.get('[data-status="saved"]').element)).toBeDefined()
  })

  it('上移/下移：交换相邻位置并保存，首尾边界按钮禁用', async () => {
    const harness = mountPanel({
      entities: plotEntities([
        sceneRow({ id: 'plot_a', title: '第一幕', order: 0 }),
        sceneRow({ id: 'plot_b', title: '第二幕', order: 1 }),
        sceneRow({ id: 'plot_c', title: '第三幕', order: 2 }),
      ]),
    })
    await settle()
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-up-plot_a"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
    // 下移第一场：plot_a 与 plot_b 交换
    await harness.wrapper.get('[data-testid="tavern-plot-down-plot_a"]').trigger('click')
    await settle()
    await settle()
    let items = submittedItems(harness, 0)
    expect(items.map((item) => item.id)).toEqual(['plot_b', 'plot_a', 'plot_c'])
    expect(items.map((item) => item.order)).toEqual([0, 1, 2])
    // 上移最后一场：plot_c 与 plot_a 交换
    await harness.wrapper.get('[data-testid="tavern-plot-up-plot_c"]').trigger('click')
    await settle()
    await settle()
    items = submittedItems(harness, 1)
    expect(items.map((item) => item.id)).toEqual(['plot_b', 'plot_c', 'plot_a'])
    expect(items.map((item) => item.order)).toEqual([0, 1, 2])
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-down-plot_a"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('tavern-plot AI 续写剧情线', () => {
  it('未配置模型：点按钮只显示引导文案，不请求、不落库', async () => {
    const harness = mountPanel({ aiConfigured: false })
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-ai"]').trigger('click')
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-not-configured"]').text()).toContain('尚未配置模型')
    expect(harness.wrapper.get('[data-testid="tavern-plot-ai-message"]').text()).toContain('尚未配置模型')
    expect(harness.ai.calls).toHaveLength(0)
    expect(harness.submitCalls).toHaveLength(0)
  })

  it('成功路径：请求带 2048 与场景大纲；解析后自动弹确认，确认后追加并保存', async () => {
    const harness = mountPanel({
      entities: plotEntities([sceneRow({ id: 'plot_a', title: '第一幕', brief: '捡到徽章', order: 0 })]),
    })
    harness.ai.responder = async () =>
      ({ ok: true, text: '```json\n{"title": "第二幕", "brief": "暗巷追踪"}\n```' }) as AiResult
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-ai"]').trigger('click')
    await settle()
    expect(harness.ai.calls).toHaveLength(1)
    expect(harness.ai.calls[0]?.maxTokens).toBe(2048)
    expect(harness.ai.calls[0]?.messages[0]?.content).toContain('1. 第一幕：捡到徽章')
    // 结果区展示原文 + 自动弹出确认对话框
    expect(harness.wrapper.get('[data-testid="tavern-plot-ai-result"]').text()).toContain('第二幕')
    expect(panelText(harness)).toContain('确定把 AI 续写的剧情追加为新场景「第二幕」吗？')
    expect(harness.submitCalls).toHaveLength(0)
    await clickDialogButton(harness, '追加为新场景')
    await settle()
    await settle()
    expect(harness.submitCalls).toHaveLength(1)
    const items = submittedItems(harness, 0)
    expect(items.map((item) => item.title)).toEqual(['第一幕', '第二幕'])
    expect(items[1]?.brief).toBe('暗巷追踪')
    expect(items[1]?.order).toBe(1)
    expect(items[1]?.id.startsWith('plot_')).toBe(true)
    expect(panelText(harness)).toContain('已把「第二幕」追加为新场景。')
    expect((harness.wrapper.get('[data-status="saved"]').element)).toBeDefined()
  })

  it('解析失败：显示「未落库」错误、结果区留原文、追加按钮禁用、不落库', async () => {
    const harness = mountPanel({ aiConfigured: true })
    harness.ai.responder = async () =>
      ({ ok: true, text: '抱歉，我还推演不出下一段剧情。' }) as AiResult
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-ai"]').trigger('click')
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-ai-message"]').text()).toBe(AI_PARSE_FAILED)
    expect(harness.wrapper.get('[data-testid="tavern-plot-ai-result"]').text()).toContain('抱歉')
    expect(
      (harness.wrapper.get('[data-testid="tavern-plot-append"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(harness.submitCalls).toHaveLength(0)
    expect((harness.wrapper.get('[data-status="saved"]').element)).toBeDefined()
  })

  it('上游失败：显示「续写失败：」文案，不落库', async () => {
    const harness = mountPanel({ aiConfigured: true })
    harness.ai.responder = async () =>
      ({ ok: false, code: 'AI_TIMEOUT', message: '推理超时' }) as AiResult
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-ai"]').trigger('click')
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-ai-message"]').text()).toBe('续写失败：推理超时')
    expect(harness.submitCalls).toHaveLength(0)
  })
})

describe('tavern-plot 载入与保存失败', () => {
  it('载入异常：显示错误态（store-error 通知）', async () => {
    const harness = mountPanel({ loadShouldThrow: true })
    await settle()
    expect(harness.wrapper.get('[data-testid="tavern-plot-store-error"]').text()).toContain('测试桩：载入失败')
  })

  it('保存失败：状态药丸切「保存失败」并显示后端 message，本地数据保留', async () => {
    const harness = mountPanel({
      submitFailure: { code: 'VALIDATION_MISSING_FIELD', message: '还没有作品，先新建作品再保存设定。' },
    })
    await settle()
    await harness.wrapper.get('[data-testid="tavern-plot-new"]').trigger('click')
    await settle()
    harness.wrapper.get('[data-testid="tavern-plot-input-title"]').setValue('第一幕')
    await harness.wrapper.get('[data-testid="tavern-plot-save"]').trigger('click')
    await settle()
    await settle()
    expect(harness.submitCalls).toHaveLength(1)
    expect((harness.wrapper.get('[data-status="error"]').element)).toBeDefined()
    expect(harness.wrapper.get('[data-testid="tavern-plot-store-error"]').text()).toContain(
      '还没有作品，先新建作品再保存设定。',
    )
    // 失败保留本地数据：场景仍在列表
    expect(harness.wrapper.get('[data-testid="tavern-plot-list"]').text()).toContain('第一幕')
  })
})
