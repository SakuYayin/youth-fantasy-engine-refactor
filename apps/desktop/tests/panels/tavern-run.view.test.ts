// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 跑团互动面板（tavern-run.vue）的视图测试：
 * 挂载加载（三模板查询）/ 卡片选择 / 消息渲染（分色+时间戳）/
 * 发送成功（AI 请求组装 + 回复入库 + 持久化）/ 未配置与无卡守卫 /
 * Enter 发送 / 生成中禁用 / AI 失败错误码 / 新建会话（YfeDialog）/ 标题失焦保存 / 滚动到底。
 *
 * AppState 桩取自 tavern-card.view.test.ts 的 harness 口径；面板数据经
 * createPanelStore（模板 panel:tavern-run），快照里同时放 tavern-run 与 tavern-card 行。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { getTab } from '@yfe/schema-tabs'

import type {
  AppSnapshot,
  AppState,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import { PANEL_STATE_NAME } from '../../src/renderer/panels/panel-store.js'
import { createDefaultPanelValues, TAVERN_RUN_PANEL_TEXT } from '../../src/renderer/panels/tavern-run-model.js'
import type { TavernRunPanelValues } from '../../src/renderer/panels/tavern-run-model.js'
import TavernRun from '../../src/renderer/panels/tavern-run.vue'
import type { TavernCardRecord, TavernMessage } from '../../src/renderer/tavern/types.js'

const tavernRunTab = getTab('tavern-run')
if (tavernRunTab === undefined) throw new Error('页签 tavern-run 未注册（@yfe/schema-tabs）')

/** TavernCardRecord 夹具。 */
function cardRecord(input: Partial<TavernCardRecord> = {}): TavernCardRecord {
  return {
    id: input.id ?? 'card_fixture1',
    name: input.name ?? '林晚',
    description: input.description ?? '魔法学院二年级学生，随身带着会说话的旧怀表。',
    personality: input.personality ?? '沉静、好奇',
    firstMessage: input.firstMessage ?? '你在图书馆做什么？',
    tags: input.tags ?? ['魔法', '少女'],
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  }
}

/** TavernMessage 夹具。 */
function messageRecord(input: Partial<TavernMessage> = {}): TavernMessage {
  return {
    id: input.id ?? 'msg_fixture1',
    role: input.role ?? 'user',
    content: input.content ?? '我推开了图书馆的门。',
    createdAt: input.createdAt ?? '2026-06-01T10:00:00.000Z',
  }
}

/** 面板状态行夹具（tavern-run 自己的 values）。 */
function runPanelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-run',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-run',
    name: PANEL_STATE_NAME,
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 面板状态行夹具（tavern-card 的 values，供角色选择读取）。 */
function cardPanelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-card',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-card',
    name: PANEL_STATE_NAME,
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 世界书面板行夹具（panel:tavern-world 的 values 顶层即 items）。 */
function worldPanelRow(items: unknown): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-world',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-world',
    name: PANEL_STATE_NAME,
    values: { items, updatedAt: '2026-06-01T00:00:00.000Z' },
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** tavern-run 面板默认 values 夹具。 */
function runValues(input: Partial<TavernRunPanelValues> = {}): Record<string, unknown> {
  const defaults = createDefaultPanelValues()
  return {
    messages: input.messages ?? defaults.messages,
    sessionTitle: input.sessionTitle ?? defaults.sessionTitle,
    cardId: input.cardId ?? defaults.cardId,
    settings: input.settings ?? defaults.settings,
  }
}

function snapshotWith(entities: AppSnapshot['settingsEntities']): AppSnapshot {
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
    selectedDocumentId: 'doc_1',
    title: '第一章',
    body: '原始正文',
    charCount: 4,
    revision: 'r1',
    saveStatus: 'saved',
    saveDetail: null,
    conflict: null,
    lastError: null,
    expandedIds: [],
    settingsEntities: entities,
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
}

interface HarnessOptions {
  loadOk?: boolean
  loadGate?: Promise<void>
  aiConfigured?: boolean
  completeImpl?: (request: AiRequest) => Promise<AiResult>
  submitResult?: SettingsEntitySubmitResult
}

function harness(entities: AppSnapshot['settingsEntities'], options: HarnessOptions = {}) {
  const loadOk = options.loadOk ?? true
  let aiConfigured = options.aiConfigured ?? false
  const complete = vi.fn(async (request: AiRequest): Promise<AiResult> => {
    if (options.completeImpl !== undefined) return options.completeImpl(request)
    return { ok: false, code: 'AI_NOT_CONFIGURED', message: '测试桩' }
  })
  const ai: AiPort = {
    getConfig: () => null,
    configured: () => aiConfigured,
    reload: async () => true,
    saveConfig: async () => true,
    complete,
  }
  let snapshot = snapshotWith(entities)
  const loadQueries: Array<Parameters<AppState['loadSettingsEntities']>[0]> = []
  const submitCalls: SettingsEntitySubmit[] = []
  const submitResult: SettingsEntitySubmitResult =
    options.submitResult ?? { ok: true, entityId: 'entity-panel-1', revision: 'r2', orderKey: 'k' }
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {},
    refresh: async () => {},
    createProject: async () => true,
    openProject: async () => true,
    createChapter: async () => true,
    selectDocument: async () => true,
    edit: vi.fn(),
    flush: async () => true,
    applyExternalUpdate: () => true,
    retrySave: () => {},
    resolveConflict: () => {},
    toggleExpanded: () => {},
    setNavigationGuard: () => {},
    dispose: () => {},
    loadSettingsEntities: async (query) => {
      loadQueries.push(query)
      if (options.loadGate !== undefined) await options.loadGate
      return loadOk
    },
    selectSettingsEntity: async () => true,
    refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => {
      submitCalls.push(submit)
      return submitResult
    },
    ai,
  }
  const wrapper = mount(TavernRun, { props: { state, tab: tavernRunTab } })
  return {
    wrapper,
    state,
    complete,
    loadQueries,
    submitCalls,
    setAiConfigured: (next: boolean): void => {
      aiConfigured = next
    },
  }
}

/** 两卡一世界书的标准快照夹具。 */
function standardEntities(runValuesInput: Partial<TavernRunPanelValues> = {}): AppSnapshot['settingsEntities'] {
  return [
    runPanelRow(runValues(runValuesInput)),
    cardPanelRow({ items: [cardRecord(), cardRecord({ id: 'card_two', name: '苏橙' })] }),
    worldPanelRow([
      { id: 'w1', keywords: '怀表', content: '旧怀表会在午夜报时。', enabled: true, order: 0 },
      { id: 'w2', keywords: '禁地', content: '北塔是禁地。', enabled: false, order: 1 },
    ]),
  ]
}

describe('tavern-run 挂载与加载', () => {
  it('挂载即按三个模板查询：先卡片、再世界书、最后自己的面板状态', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const { wrapper, loadQueries } = harness(standardEntities(), { loadGate })
    expect(loadQueries).toHaveLength(1)
    expect(loadQueries[0]?.schemaTemplateId).toBe('panel:tavern-card')
    // 卡片查询停在闸门 → 初次载入状态可见（initializing 在挂载后才置位，先冲一帧渲染）。
    await nextTick()
    expect(wrapper.get('[data-testid="tavern-run-loading"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.loading)
    openGate()
    await flushPromises()
    expect(loadQueries.map((query) => query?.schemaTemplateId)).toEqual([
      'panel:tavern-card',
      'panel:tavern-world',
      'panel:tavern-run',
    ])
  })

  it('加载后渲染标题/说明条/工具栏与已存消息（分色+时间戳）', async () => {
    const stored: TavernMessage[] = [
      messageRecord({ id: 'msg_a', role: 'user', content: '我推开了图书馆的门。' }),
      messageRecord({ id: 'msg_b', role: 'assistant', content: '（怀表滴答作响）' }),
    ]
    const { wrapper } = harness(standardEntities({ messages: stored, sessionTitle: '深夜调查', cardId: 'card_fixture1' }))
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-run-panel"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-run-intro"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.intro)
    const titleInput = wrapper.get('[data-testid="tavern-run-title-input"]')
    expect((titleInput.element as HTMLInputElement).value).toBe('深夜调查')
    expect(wrapper.get('[data-testid="tavern-run-overview"]').text()).toBe('共 2 条消息')
    const items = wrapper.findAll('[data-testid="tavern-run-message"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toContain('我推开了图书馆的门。')
    expect(items[1]?.text()).toContain('（怀表滴答作响）')
    expect(items[0]?.classes()).toContain('tavern-run__msg--user')
    expect(items[1]?.classes()).toContain('tavern-run__msg--assistant')
    expect(items[0]?.get('[data-testid="tavern-run-role"]').text()).toBe('你')
    expect(items[1]?.get('[data-testid="tavern-run-role"]').text()).toBe('林晚')
    expect(items[0]?.get('[data-testid="tavern-run-time"]').text()).not.toBe('')
  })

  it('卡片选择：从 tavern-card 行读取卡片列表，cardId 未存时回落第一张', async () => {
    const { wrapper } = harness(standardEntities())
    await flushPromises()
    const select = wrapper.get('[data-testid="tavern-run-card-select"]')
    expect((select.element as HTMLSelectElement).value).toBe('card_fixture1')
    const options = select.findAll('option')
    expect(options).toHaveLength(2)
    expect(options[0]?.text()).toBe('林晚')
    expect(options[1]?.text()).toBe('苏橙')
  })

  it('无卡片时显示引导且不渲染选择框', async () => {
    const { wrapper } = harness([runPanelRow(runValues())])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-run-no-cards"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.noCards)
    expect(wrapper.find('[data-testid="tavern-run-card-select"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tavern-run-message"]')).toHaveLength(0)
  })

  it('空会话显示空态文案', async () => {
    const { wrapper } = harness(standardEntities())
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-run-empty"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.empty)
  })

  it('未配置模型时显示引导横幅（「模型设置」页签）', async () => {
    const { wrapper } = harness(standardEntities(), { aiConfigured: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-run-unconfigured"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.notConfigured)
  })

  it('坏数据兜底：库值坏类型不炸面板', async () => {
    const badRow = runPanelRow({ messages: '不是数组', sessionTitle: 42, cardId: 7, settings: '坏' })
    const badCardRow = cardPanelRow({ items: '坏' })
    const { wrapper } = harness([badRow, badCardRow, worldPanelRow('坏')])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-run-no-cards"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.noCards)
    expect(wrapper.get('[data-testid="tavern-run-empty"]').element).toBeDefined()
    expect(wrapper.findAll('[data-testid="tavern-run-message"]')).toHaveLength(0)
    expect((wrapper.get('[data-testid="tavern-run-title-input"]').element as HTMLInputElement).value).toBe('新会话')
  })
})

describe('tavern-run 发送流程', () => {
  it('点发送：用户消息入库 → complete 收到系统提示与上下文 → 回复入库并保存', async () => {
    const { wrapper, complete, submitCalls } = harness(standardEntities(), {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '怀表在午夜停了。' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('我推开了图书馆的门。')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.system).toContain('林晚')
    expect(request.system).toContain('魔法学院二年级学生')
    expect(request.system).toContain('旧怀表会在午夜报时。')
    expect(request.system).not.toContain('北塔是禁地。')
    expect(request.messages).toEqual([{ role: 'user', content: '我推开了图书馆的门。' }])
    expect(request.maxTokens).toBe(2048)
    expect(request.temperature).toBe(0.7)
    // 回复作为 assistant 消息渲染，输入框已清空。
    const items = wrapper.findAll('[data-testid="tavern-run-message"]')
    expect(items).toHaveLength(2)
    expect(items[1]?.classes()).toContain('tavern-run__msg--assistant')
    expect(items[1]?.text()).toContain('怀表在午夜停了。')
    expect((wrapper.get('[data-testid="tavern-run-input"]').element as HTMLTextAreaElement).value).toBe('')
    // 持久化：schemaTemplateId=panel:tavern-run，values 带两条消息。
    expect(submitCalls.length).toBeGreaterThan(0)
    const last = submitCalls[submitCalls.length - 1]!
    expect(last.schemaTemplateId).toBe('panel:tavern-run')
    expect(last.name).toBe(PANEL_STATE_NAME)
    const values = last.values as unknown as TavernRunPanelValues
    expect(values.messages).toHaveLength(2)
    expect(values.messages[0]?.role).toBe('user')
    expect(values.messages[1]?.content).toBe('怀表在午夜停了。')
    expect(values.cardId).toBe('card_fixture1')
  })

  it('Enter 发送，Shift+Enter 不发送', async () => {
    const { wrapper, complete } = harness(standardEntities(), {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '收到' }),
    })
    await flushPromises()
    const input = wrapper.get('[data-testid="tavern-run-input"]')
    await input.setValue('行动一')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    await input.setValue('行动二')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('未配置模型：点发送显示引导且不发请求', async () => {
    const { wrapper, complete } = harness(standardEntities(), {
      aiConfigured: false,
      completeImpl: async () => ({ ok: true, text: '不该发生' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    expect(complete).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="tavern-run-error"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.notConfigured)
    expect(wrapper.findAll('[data-testid="tavern-run-message"]')).toHaveLength(0)
  })

  it('无卡片：点发送显示引导且不发请求', async () => {
    const { wrapper, complete } = harness([runPanelRow(runValues())], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '不该发生' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    expect(complete).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="tavern-run-error"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.noCards)
  })

  it('生成中：输入与发送禁用、显示生成中提示，完成后恢复', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { wrapper, complete } = harness(standardEntities(), {
      aiConfigured: true,
      completeImpl: async () => {
        await gate
        return { ok: true, text: '回复' }
      },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await nextTick()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="tavern-run-generating"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.generating)
    expect(wrapper.get('[data-testid="tavern-run-input"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-run-send"]').attributes('disabled')).toBeDefined()
    release()
    await flushPromises()
    expect(wrapper.find('[data-testid="tavern-run-generating"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="tavern-run-send"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.findAll('[data-testid="tavern-run-message"]')).toHaveLength(2)
  })

  it('AI 失败：如实显示「错误码：消息」，用户消息保留并保存', async () => {
    const { wrapper, complete, submitCalls } = harness(standardEntities(), {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_TIMEOUT', message: '请求超时' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="tavern-run-error"]').text()).toBe('AI_TIMEOUT：请求超时')
    const items = wrapper.findAll('[data-testid="tavern-run-message"]')
    expect(items).toHaveLength(1)
    expect(items[0]?.classes()).toContain('tavern-run__msg--user')
    expect(submitCalls.length).toBeGreaterThan(0)
  })

  it('上下文窗口：26 条里只送最近 contextMessages（默认 20）条', async () => {
    const stored: TavernMessage[] = Array.from({ length: 25 }, (_, index) =>
      messageRecord({
        id: `msg_${String(index).padStart(2, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `第${index}条`,
      }),
    )
    const { wrapper, complete } = harness(standardEntities({ messages: stored }), {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '收到' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('新行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    const request = complete.mock.calls[0]![0]
    expect(request.messages).toHaveLength(20)
    expect(request.messages[0]?.content).toBe('第6条')
    expect(request.messages[19]?.content).toBe('新行动')
  })

  it('滚动到底：新消息后容器 scrollTop 跟随 scrollHeight', async () => {
    const { wrapper } = harness(standardEntities({ messages: [messageRecord()] }), {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '回复' }),
    })
    await flushPromises()
    const list = wrapper.get('[data-testid="tavern-run-message-list"]')
    const el = list.element as HTMLElement
    Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true })
    await wrapper.get('[data-testid="tavern-run-input"]').setValue('行动')
    await wrapper.get('[data-testid="tavern-run-send"]').trigger('click')
    await flushPromises()
    expect(el.scrollTop).toBe(500)
  })
})

describe('tavern-run 新建会话与标题', () => {
  it('新建会话：确认后清空对话、标题回默认并保存', async () => {
    const stored: TavernMessage[] = [messageRecord()]
    const { wrapper, submitCalls } = harness(standardEntities({ messages: stored, sessionTitle: '深夜调查' }), {
      aiConfigured: true,
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-new-session"]').trigger('click')
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    await wrapper.get('[data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tavern-run-message"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="tavern-run-empty"]').text()).toBe(TAVERN_RUN_PANEL_TEXT.empty)
    expect((wrapper.get('[data-testid="tavern-run-title-input"]').element as HTMLInputElement).value).toBe('新会话')
    expect(submitCalls.length).toBeGreaterThan(0)
    const last = submitCalls[submitCalls.length - 1]!
    expect(last.schemaTemplateId).toBe('panel:tavern-run')
    const values = last.values as unknown as TavernRunPanelValues
    expect(values.messages).toHaveLength(0)
    expect(values.sessionTitle).toBe('新会话')
  })

  it('新建会话：取消不清空', async () => {
    const stored: TavernMessage[] = [messageRecord()]
    const { wrapper } = harness(standardEntities({ messages: stored }))
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-new-session"]').trigger('click')
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    await wrapper.get('[data-role="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tavern-run-message"]')).toHaveLength(1)
  })

  it('会话标题：输入入库、失焦保存、保存后徽标「本地已保存」', async () => {
    const { wrapper, submitCalls } = harness(standardEntities(), { aiConfigured: true })
    await flushPromises()
    const title = wrapper.get('[data-testid="tavern-run-title-input"]')
    await title.setValue('决战魔塔')
    expect((title.element as HTMLInputElement).value).toBe('决战魔塔')
    await title.trigger('blur')
    await flushPromises()
    expect(submitCalls.length).toBeGreaterThan(0)
    const last = submitCalls[submitCalls.length - 1]!
    expect(last.schemaTemplateId).toBe('panel:tavern-run')
    const values = last.values as unknown as TavernRunPanelValues
    expect(values.sessionTitle).toBe('决战魔塔')
    expect(wrapper.get('[data-testid="tavern-run-save-status"]').text()).toContain('本地已保存')
  })

  it('切换角色卡：patch cardId 并入库', async () => {
    const { wrapper, submitCalls } = harness(standardEntities(), { aiConfigured: true })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-card-select"]').setValue('card_two')
    await flushPromises()
    const last = submitCalls[submitCalls.length - 1]!
    const values = last.values as unknown as TavernRunPanelValues
    expect(values.cardId).toBe('card_two')
  })

  it('卸载后不再保存（autoSaveMs:0，无显式 save）', async () => {
    const { wrapper, submitCalls } = harness(standardEntities(), { aiConfigured: true })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-run-title-input"]').setValue('改标题')
    wrapper.unmount()
    await flushPromises()
    expect(submitCalls).toHaveLength(0)
  })

  it('保存失败：显示「错误码：消息」、徽标「保存失败」且不丢本地数据', async () => {
    const { wrapper, submitCalls } = harness(standardEntities(), {
      aiConfigured: true,
      submitResult: { ok: false, code: 'VALIDATION_MISSING_FIELD', message: '还没有作品，先新建作品再保存设定。' },
    })
    await flushPromises()
    const title = wrapper.get('[data-testid="tavern-run-title-input"]')
    await title.setValue('改标题')
    await title.trigger('blur')
    await flushPromises()
    expect(submitCalls.length).toBeGreaterThan(0)
    expect(wrapper.get('[data-testid="tavern-run-error"]').text()).toBe(
      'VALIDATION_MISSING_FIELD：还没有作品，先新建作品再保存设定。',
    )
    expect((wrapper.get('[data-testid="tavern-run-title-input"]').element as HTMLInputElement).value).toBe('改标题')
    expect(wrapper.get('[data-testid="tavern-run-save-status"]').text()).toContain('保存失败')
  })
})
