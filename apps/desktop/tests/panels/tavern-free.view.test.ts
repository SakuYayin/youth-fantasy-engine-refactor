// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 自由对话面板（tavern-free.vue）的挂载视图测试：
 * 载入闸门与状态 / 消息列表与 role 分色 / 空态与坏数据 / 未配置模型引导 /
 * 发送流程（请求组装、前提拼 system、回复入库、保存）/ 发送失败 /
 * 生成中禁用 / 新建会话（YfeDialog）/ 会话标题与前提编辑 / 文案契约。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { getTab } from '@yfe/schema-tabs'

import type { TabDef } from '@yfe/schema-tabs'

import type { AiPort } from '../../src/renderer/ai/types.js'
import type { AppSnapshot, AppState, SettingsEntityQuery, SettingsEntitySubmit, SettingsEntitySubmitResult } from '../../src/renderer/app-state.js'
import TavernFree from '../../src/renderer/panels/tavern-free.vue'
import {
  DEFAULT_SESSION_TITLE,
  TAVERN_FREE_PANEL_TEXT,
} from '../../src/renderer/panels/tavern-free-model.js'

const tavernFreeTab: TabDef = getTab('tavern-free')!
if (tavernFreeTab === undefined) {
  throw new Error('schema 缺少 tavern-free 页签：测试无法继续')
}

/** 与 SettingsEntityView 同构的面板状态行夹具。 */
function panelRow(values: Record<string, unknown>): {
  id: string
  projectId: string
  schemaTemplateId: string
  name: string
  values: Record<string, unknown>
  orderKey: string
  revision: string
  deleted: boolean
} {
  return {
    id: 'entity-panel-tavern-free',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-free',
    name: '面板状态',
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 完整 AppSnapshot 夹具（无作品：projectId=null）。 */
function snapshotWith(entities: Array<ReturnType<typeof panelRow>>, projectId: string | null = 'project_1'): AppSnapshot {
  return {
    ready: true,
    loading: false,
    appVersion: 'test',
    databasePath: 'test.db',
    databaseSchemaVersion: 'test',
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId,
    tree: [],
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
    settingsEntities: entities,
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  } as unknown as AppSnapshot
}

/** 挂载用 props：带索引签名，运行时多余字段不炸。 */
interface PanelMountProps {
  readonly state: AppState
  readonly tab: TabDef
  readonly [key: string]: unknown
}

interface HarnessOptions {
  readonly aiConfigured?: boolean
  readonly completeImpl?: (request: unknown) => Promise<unknown>
  readonly entities?: Array<ReturnType<typeof panelRow>>
  readonly projectId?: string | null
  readonly submitResult?: SettingsEntitySubmitResult
}

/** 构建 AppState 桩 + AiPort 桩 + 挂载工具，记录 load/submit/complete 调用。 */
function makeHarness(options: HarnessOptions = {}) {
  const aiConfigured = options.aiConfigured ?? false
  const entities = options.entities ?? []
  const submitCalls: SettingsEntitySubmit[] = []
  const loadCalls: Array<SettingsEntityQuery | undefined> = []
  const completeCalls: unknown[] = []
  let loadGate: Promise<void> | null = null
  let releaseLoad: (() => void) | null = null

  const complete = vi.fn(
    options.completeImpl ??
      (async () => ({ ok: true as const, text: '收到，我们继续头脑风暴。' })),
  )

  const ai: AiPort = {
    getConfig: () => null,
    configured: () => aiConfigured,
    reload: async () => true,
    saveConfig: async () => true,
    complete: complete as unknown as AiPort['complete'],
  }

  const state: AppState = {
    getSnapshot: () => snapshotWith(entities, options.projectId ?? 'project_1') as unknown as ReturnType<AppState['getSnapshot']>,
    subscribe: () => () => undefined,
    start: async () => undefined,
    refresh: async () => undefined,
    createProject: async () => undefined,
    openProject: async () => true,
    createChapter: async () => undefined,
    selectDocument: () => undefined,
    edit: () => undefined,
    flush: async () => undefined,
    applyExternalUpdate: () => undefined,
    retrySave: async () => undefined,
    resolveConflict: () => undefined,
    toggleExpanded: () => undefined,
    setNavigationGuard: () => undefined,
    dispose: () => undefined,
    loadSettingsEntities: async (query?: SettingsEntityQuery) => {
      loadCalls.push(query)
      if (loadGate !== null) await loadGate
      return true
    },
    selectSettingsEntity: () => undefined,
    refreshSettingsEntity: async () => undefined,
    submitSettingsEntity: async (submit: SettingsEntitySubmit) => {
      submitCalls.push(submit)
      return (
        options.submitResult ?? {
          ok: true as const,
          entityId: 'entity-panel-tavern-free',
          revision: 'r2',
          orderKey: 'k',
        }
      )
    },
    ai,
  } as unknown as AppState

  const props: PanelMountProps = { state, tab: tavernFreeTab }
  const wrapper = mount(TavernFree, { props })

  return {
    wrapper,
    ai,
    complete,
    submitCalls,
    loadCalls,
    aiConfigured: () => aiConfigured,
    gateLoad(): void {
      loadGate = new Promise<void>((resolve) => {
        releaseLoad = resolve
      })
    },
    releaseLoadGate(): void {
      if (releaseLoad !== null) releaseLoad()
      loadGate = null
      releaseLoad = null
    },
  }
}

const DEFAULT_VALUES: Record<string, unknown> = {
  messages: [],
  sessionTitle: DEFAULT_SESSION_TITLE,
  premise: '',
  settings: {
    mode: 'free',
    temperature: 0.9,
    maxTokens: 2048,
    contextMessages: 20,
    advanced: {},
  },
}

function messageRow(
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Record<string, unknown> {
  return { id, role, content, createdAt: '2026-06-01T08:05:00.000Z' }
}

describe('tavern-free 视图：载入与文案', () => {
  it('挂载即按模板 panel:tavern-free 查询面板状态；载入中显示载入态', async () => {
    const harness = makeHarness()
    harness.gateLoad()
    await nextTick() // onMounted 异步刷新：先渲染 loading
    expect(harness.wrapper.find('[data-testid="tavern-free-loading"]').element).toBeDefined()
    expect(harness.loadCalls).toHaveLength(1)
    expect(harness.loadCalls[0]?.schemaTemplateId).toBe('panel:tavern-free')
    harness.releaseLoadGate()
    await flushPromises()
    expect(harness.wrapper.find('[data-testid="tavern-free-loading"]').exists()).toBe(false)
  })

  it('文案契约：标题=页签名、描述=页签 description、导语=常量、根节点带 tab id', () => {
    const harness = makeHarness({ entities: [panelRow(DEFAULT_VALUES)] })
    const root = harness.wrapper.get('[data-testid="tavern-free-panel"]')
    expect(root.attributes('data-tab-id')).toBe('tavern-free')
    expect(harness.wrapper.get('.tavern-free__title').text()).toBe('自由对话')
    expect(harness.wrapper.get('.tavern-free__desc').text()).toBe(tavernFreeTab.description)
    expect(harness.wrapper.get('[data-testid="tavern-free-intro"]').text()).toBe(
      TAVERN_FREE_PANEL_TEXT.intro,
    )
  })

  it('空态：无消息时显示空态文案', () => {
    const harness = makeHarness({ entities: [panelRow(DEFAULT_VALUES)] })
    expect(harness.wrapper.find('[data-testid="tavern-free-empty"]').element).toBeDefined()
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(0)
  })

  it('坏数据（messages 非数组）：按空列表处理，不白屏', () => {
    const harness = makeHarness({ entities: [panelRow({ ...DEFAULT_VALUES, messages: '垃圾' })] })
    expect(harness.wrapper.find('[data-testid="tavern-free-empty"]').element).toBeDefined()
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(0)
  })
})

describe('tavern-free 视图：消息列表', () => {
  it('渲染消息：role 分色类、时间戳、内容', async () => {
    const harness = makeHarness({
      entities: [
        panelRow({
          ...DEFAULT_VALUES,
          messages: [
            messageRow('msg_1', 'user', '帮我头脑风暴'),
            messageRow('msg_2', 'assistant', '好啊，先从世界观开始'),
          ],
        }),
      ],
    })
    await flushPromises()
    const items = harness.wrapper.findAll('[data-testid="tavern-free-message"]')
    expect(items).toHaveLength(2)
    expect(items[0]!.classes()).toContain('tavern-free__msg--user')
    expect(items[1]!.classes()).toContain('tavern-free__msg--assistant')
    expect(items[0]!.get('[data-testid="tavern-free-content"]').text()).toBe('帮我头脑风暴')
    expect(items[0]!.get('[data-testid="tavern-free-time"]').text()).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(items[1]!.get('[data-testid="tavern-free-role"]').text()).toBe(TAVERN_FREE_PANEL_TEXT.roleAssistant)
  })

  it('概览行与设置摘要行来自 store 数据', async () => {
    const harness = makeHarness({
      entities: [
        panelRow({
          ...DEFAULT_VALUES,
          messages: [messageRow('msg_1', 'user', '一'), messageRow('msg_2', 'assistant', '二')],
        }),
      ],
    })
    await flushPromises()
    expect(harness.wrapper.get('[data-testid="tavern-free-overview"]').text()).toBe('共 2 条消息')
    expect(harness.wrapper.get('[data-testid="tavern-free-settings-line"]').text()).toBe(
      '上下文：最近 20 条 · 温度：0.9 · 最大输出：2048',
    )
  })
})

describe('tavern-free 视图：未配置模型', () => {
  it('未配置：显示引导、点击发送后如实提示、不发 AI 请求', async () => {
    const harness = makeHarness({ aiConfigured: false, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    expect(harness.wrapper.find('[data-testid="tavern-free-unconfigured"]').element).toBeDefined()
    expect(harness.wrapper.find('[data-testid="tavern-free-unconfigured"]').text()).toContain('模型设置')
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    expect(harness.complete).not.toHaveBeenCalled()
    expect(harness.wrapper.get('[data-testid="tavern-free-error"]').text()).toBe(
      TAVERN_FREE_PANEL_TEXT.notConfigured,
    )
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(0)
  })

  it('未配置时 Enter 发送同样只提示不发请求', async () => {
    const harness = makeHarness({ aiConfigured: false, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    const input = harness.wrapper.get('[data-testid="tavern-free-input"]')
    await input.setValue('你好')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(harness.complete).not.toHaveBeenCalled()
    expect(harness.wrapper.find('[data-testid="tavern-free-error"]').text()).toBe(
      TAVERN_FREE_PANEL_TEXT.notConfigured,
    )
  })
})

describe('tavern-free 视图：发送流程', () => {
  it('发送成功：请求带前提 system 与上下文窗口；用户消息与回复入库；输入框清空；保存带模板', async () => {
    const stored = panelRow({
      ...DEFAULT_VALUES,
      premise: '你是一名编辑，帮我审稿',
      sessionTitle: '审稿讨论',
      messages: [messageRow('msg_0', 'assistant', '先把稿子发我')],
    })
    const harness = makeHarness({ aiConfigured: true, entities: [stored] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('第一段写得太平了')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()

    expect(harness.complete).toHaveBeenCalledTimes(1)
    const request = harness.complete.mock.calls[0]![0] as {
      system?: string
      messages: Array<{ role: string; content: string }>
      temperature?: number
      maxTokens?: number
    }
    expect(request.system).toBeDefined()
    expect(request.system).toContain('你是一名编辑，帮我审稿')
    // 库里已有的 assistant 历史 + 本条用户消息都会进请求（recentMessages 窗口内）
    expect(request.messages).toEqual([
      { role: 'assistant', content: '先把稿子发我' },
      { role: 'user', content: '第一段写得太平了' },
    ])
    expect(request.temperature).toBe(0.9)
    expect(request.maxTokens).toBe(2048)

    const items = harness.wrapper.findAll('[data-testid="tavern-free-message"]')
    expect(items).toHaveLength(3)
    expect(items[1]!.get('[data-testid="tavern-free-content"]').text()).toBe('第一段写得太平了')
    expect(items[2]!.get('[data-testid="tavern-free-content"]').text()).toBe('收到，我们继续头脑风暴。')
    expect((harness.wrapper.get('[data-testid="tavern-free-input"]').element as HTMLInputElement).value).toBe('')

    expect(harness.submitCalls.length).toBeGreaterThan(0)
    expect(harness.submitCalls[0]!.schemaTemplateId).toBe('panel:tavern-free')
    const lastSubmit = harness.submitCalls[harness.submitCalls.length - 1]!
    expect((lastSubmit.values as Record<string, unknown>).premise).toBe('你是一名编辑，帮我审稿')
    expect(((lastSubmit.values as Record<string, unknown>).messages as unknown[]).length).toBe(3)
  })

  it('留空前提：请求不带 system 字段', async () => {
    const harness = makeHarness({ aiConfigured: true, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('随便聊聊')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    const request = harness.complete.mock.calls[0]![0] as { system?: string }
    expect(request.system).toBeUndefined()
  })

  it('AI 失败（超时）：如实提示「错误码：消息」，用户消息保留', async () => {
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      completeImpl: async () => ({ ok: false as const, code: 'AI_TIMEOUT', message: '请求超时' }),
    })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    expect(harness.wrapper.get('[data-testid="tavern-free-error"]').text()).toBe(
      'AI_TIMEOUT：请求超时',
    )
    const items = harness.wrapper.findAll('[data-testid="tavern-free-message"]')
    expect(items).toHaveLength(1)
    expect(items[0]!.get('[data-testid="tavern-free-content"]').text()).toBe('你好')
    expect(items[0]!.classes()).toContain('tavern-free__msg--user')
  })

  it('AI 返回未配置错误：重新显示引导', async () => {
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      completeImpl: async () => ({
        ok: false as const,
        code: 'AI_NOT_CONFIGURED',
        message: '接口未配置',
      }),
    })
    await flushPromises()
    expect(harness.wrapper.find('[data-testid="tavern-free-unconfigured"]').exists()).toBe(false)
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    expect(harness.wrapper.find('[data-testid="tavern-free-unconfigured"]').element).toBeDefined()
  })

  it('complete 抛异常：按上游错误如实提示', async () => {
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      completeImpl: async () => {
        throw new Error('网络断了')
      },
    })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    expect(harness.wrapper.get('[data-testid="tavern-free-error"]').text()).toBe(
      'AI_UPSTREAM_ERROR：网络断了',
    )
  })
})

describe('tavern-free 视图：生成中状态', () => {
  it('生成中：输入禁用、按钮 loading、生成指示可见；回复到达后恢复', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      completeImpl: async () => {
        await gate
        return { ok: true as const, text: '迟到的回复' }
      },
    })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()

    expect(harness.wrapper.find('[data-testid="tavern-free-generating"]').element).toBeDefined()
    const input = harness.wrapper.get('[data-testid="tavern-free-input"]').element as HTMLTextAreaElement
    expect(input.disabled).toBe(true)
    const send = harness.wrapper.get('[data-testid="tavern-free-send"]')
    expect(send.attributes('disabled')).toBeDefined()
    expect(send.classes()).toContain('yfe-button--loading')

    release()
    await flushPromises()
    expect(harness.wrapper.find('[data-testid="tavern-free-generating"]').exists()).toBe(false)
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(2)
    expect((harness.wrapper.get('[data-testid="tavern-free-input"]').element as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('生成中输入为空时发送按钮被原生禁用（守卫不触发）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      completeImpl: async () => {
        await gate
        return { ok: true as const, text: '回复' }
      },
    })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-input"]').setValue('你好')
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-send"]').trigger('click')
    expect(harness.complete).toHaveBeenCalledTimes(1)
    release()
    await flushPromises()
  })
})

describe('tavern-free 视图：新建会话', () => {
  it('确认新建：清空消息、标题回默认、前提保留；保存请求发出', async () => {
    const stored = panelRow({
      ...DEFAULT_VALUES,
      premise: '你是一名编辑',
      sessionTitle: '审稿讨论',
      messages: [messageRow('msg_1', 'user', '一'), messageRow('msg_2', 'assistant', '二')],
    })
    const harness = makeHarness({ aiConfigured: true, entities: [stored] })
    await flushPromises()
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(2)

    await harness.wrapper.get('[data-testid="tavern-free-new-session"]').trigger('click')
    expect(harness.wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    await harness.wrapper.get('[data-role="confirm"]').trigger('click')
    await flushPromises()

    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(0)
    expect(harness.wrapper.find('[data-testid="tavern-free-empty"]').element).toBeDefined()
    expect((harness.wrapper.get('[data-testid="tavern-free-title-input"]').element as HTMLInputElement).value).toBe(
      DEFAULT_SESSION_TITLE,
    )
    expect((harness.wrapper.get('[data-testid="tavern-free-premise"]').element as HTMLTextAreaElement).value).toBe(
      '你是一名编辑',
    )
    expect(harness.submitCalls.length).toBeGreaterThan(0)
    const lastSubmit = harness.submitCalls[harness.submitCalls.length - 1]!
    expect((lastSubmit.values as Record<string, unknown>).sessionTitle).toBe(DEFAULT_SESSION_TITLE)
    expect(((lastSubmit.values as Record<string, unknown>).messages as unknown[]).length).toBe(0)
  })

  it('取消新建：对话保持不变、不发保存请求', async () => {
    const stored = panelRow({
      ...DEFAULT_VALUES,
      messages: [messageRow('msg_1', 'user', '一')],
    })
    const harness = makeHarness({ aiConfigured: true, entities: [stored] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-new-session"]').trigger('click')
    await harness.wrapper.get('[data-role="cancel"]').trigger('click')
    expect(harness.wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(harness.wrapper.findAll('[data-testid="tavern-free-message"]')).toHaveLength(1)
    expect(harness.submitCalls).toHaveLength(0)
  })
})

describe('tavern-free 视图：编辑与保存', () => {
  it('会话标题输入 → 提交的 values.sessionTitle 更新；失焦保存', async () => {
    const harness = makeHarness({ aiConfigured: true, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').setValue('头脑风暴专场')
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').trigger('blur')
    await flushPromises()
    expect(harness.submitCalls.length).toBeGreaterThan(0)
    const lastSubmit = harness.submitCalls[harness.submitCalls.length - 1]!
    expect(lastSubmit.schemaTemplateId).toBe('panel:tavern-free')
    expect((lastSubmit.values as Record<string, unknown>).sessionTitle).toBe('头脑风暴专场')
  })

  it('对话前提输入 → 提交的 values.premise 更新', async () => {
    const harness = makeHarness({ aiConfigured: true, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-premise"]').setValue('你是一名编辑，帮我审稿')
    await harness.wrapper.get('[data-testid="tavern-free-premise"]').trigger('blur')
    await flushPromises()
    const lastSubmit = harness.submitCalls[harness.submitCalls.length - 1]!
    expect((lastSubmit.values as Record<string, unknown>).premise).toBe('你是一名编辑，帮我审稿')
  })

  it('保存失败：显示 store 错误（码：消息），本地数据不丢', async () => {
    const harness = makeHarness({
      aiConfigured: true,
      entities: [panelRow(DEFAULT_VALUES)],
      projectId: null, // 无作品 → 保存失败
      submitResult: {
        ok: false as const,
        code: 'VALIDATION_MISSING_FIELD',
        message: '还没有作品，先新建作品再保存设定。',
      },
    })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').setValue('新标题')
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').trigger('blur')
    await flushPromises()
    expect(harness.wrapper.get('[data-testid="tavern-free-error"]').text()).toBe(
      'VALIDATION_MISSING_FIELD：还没有作品，先新建作品再保存设定。',
    )
    expect(harness.wrapper.get('[data-testid="tavern-free-save-status"]').text()).toContain('保存失败')
    // 本地数据不丢
    expect((harness.wrapper.get('[data-testid="tavern-free-title-input"]').element as HTMLInputElement).value).toBe(
      '新标题',
    )
  })

  it('保存成功：状态药丸显示「本地已保存」', async () => {
    const harness = makeHarness({ aiConfigured: true, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').setValue('新标题')
    await harness.wrapper.get('[data-testid="tavern-free-title-input"]').trigger('blur')
    await flushPromises()
    expect(harness.wrapper.get('[data-testid="tavern-free-save-status"]').text()).toContain('本地已保存')
  })

  it('卸载后不再发起保存', async () => {
    const harness = makeHarness({ aiConfigured: true, entities: [panelRow(DEFAULT_VALUES)] })
    await flushPromises()
    harness.wrapper.unmount()
    await flushPromises()
    expect(harness.submitCalls).toHaveLength(0)
  })
})
