// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * tavern-control（酒馆模式 · 控制面板）视图测试：
 * 挂载加载（载入中/空态/载入失败/库值回显与越界提示）/ 表单联动与自动保存 /
 * 立即保存（非法值不落库）/ 保存失败不丢数据 / 高级参数键值行 /
 * AI 联动（未配置引导、结果展示、确认对话框、解析失败、请求载荷）/ 文案与可见性。
 *
 * AppState 桩取自 tavern-card.view.test.ts 的 harness 口径，额外补 `ai`（AiPort 桩）；
 * 面板数据经 createPanelStore → loadSettingsEntities / submitSettingsEntity（模板
 * `panel:tavern-control`），桩的快照里放一条面板状态行来模拟已持久化的设置。
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
import {
  TAVERN_CONTROL_PANEL_TEXT as TEXT,
  TAVERN_MODES,
} from '../../src/renderer/panels/tavern-control-model.js'
import TavernControl from '../../src/renderer/panels/tavern-control.vue'
import type { TavernSettingsRecord } from '../../src/renderer/tavern/types.js'

const tavernControlTab = getTab('tavern-control')
if (tavernControlTab === undefined) throw new Error('页签 tavern-control 未注册（@yfe/schema-tabs）')

/** TavernSettingsRecord 夹具。 */
function settingsRecord(input: Partial<TavernSettingsRecord> = {}): TavernSettingsRecord {
  return {
    mode: input.mode ?? 'normal',
    temperature: input.temperature ?? 0.7,
    maxTokens: input.maxTokens ?? 2048,
    contextMessages: input.contextMessages ?? 20,
    advanced: input.advanced ?? {},
  }
}

/** 面板状态行夹具：与 SettingsEntityView 同构，values 里放已持久化的设置。 */
function panelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-control',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-control',
    name: '面板状态',
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 完整 AppSnapshot 夹具（与 tavern-card.view.test.ts 同一口径，补 documents）。 */
function snapshotWith(entities: AppSnapshot['settingsEntities']): AppSnapshot {
  return {
    ready: true, loading: false, appVersion: 'test', databasePath: null, databaseSchemaVersion: 1,
    readOnly: false, pendingOutboxCount: 0, lastSavedAt: null, projectId: 'project_1', tree: [],
    documents: [], selectedDocumentId: 'doc_1', title: '第一章', body: '原始正文', charCount: 4,
    revision: 'r1', saveStatus: 'saved', saveDetail: null, conflict: null, lastError: null,
    expandedIds: [], settingsEntities: entities, settingsLoading: false,
    selectedSettingsEntityId: null, selectedSettingsEntity: null,
  }
}

interface HarnessOptions {
  loadOk?: boolean
  loadGate?: Promise<void>
  loadError?: string
  aiConfigured?: boolean
  completeImpl?: (request: AiRequest) => Promise<AiResult>
  submitResult?: SettingsEntitySubmitResult
}

function harness(entities: AppSnapshot['settingsEntities'] = [], options: HarnessOptions = {}) {
  const loadOk = options.loadOk ?? true
  let aiConfigured = options.aiConfigured ?? false
  const completeCalls: AiRequest[] = []
  const complete = vi.fn(async (request: AiRequest): Promise<AiResult> => {
    completeCalls.push(request)
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
  const snapshot = snapshotWith(entities)
  const submitCalls: SettingsEntitySubmit[] = []
  const submitResult: SettingsEntitySubmitResult =
    options.submitResult ?? { ok: true, entityId: 'entity-panel-1', revision: 'r2', orderKey: 'k' }
  const loadQueries: Array<Parameters<AppState['loadSettingsEntities']>> = []
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {}, refresh: async () => {}, createProject: async () => true,
    createChapter: async () => true, selectDocument: async () => true,
    edit: vi.fn(), flush: async () => true, applyExternalUpdate: () => true,
    retrySave: () => {}, resolveConflict: () => {}, toggleExpanded: () => {},
    loadSettingsEntities: async (query) => {
      loadQueries.push(query)
      if (options.loadGate !== undefined) await options.loadGate
      if (options.loadError !== undefined) throw new Error(options.loadError)
      return loadOk
    },
    selectSettingsEntity: async () => true, refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => { submitCalls.push(submit); return submitResult },
    setNavigationGuard: () => {}, dispose: () => {},
    ai,
  }
  const wrapper = mount(TavernControl, { props: { state, tab: tavernControlTab } })
  return { wrapper, complete, completeCalls, submitCalls, loadQueries }
}

/** 取第 n 次提交的 settings（values 里只应有 settings 一把钥匙）。 */
function submittedSettings(submitCalls: ReadonlyArray<SettingsEntitySubmit>, index = 0): TavernSettingsRecord {
  const submit = submitCalls[index]
  expect(submit).toBeDefined()
  if (submit === undefined) throw new Error('没有这次提交')
  return (submit.values as { settings: TavernSettingsRecord }).settings
}

function inputValue(wrapper: ReturnType<typeof mount>, testId: string): string {
  return (wrapper.get(`[data-testid="${testId}"]`).element as HTMLInputElement).value
}

describe('tavern-control 面板：挂载与加载', () => {
  it('挂载即按模板查询面板状态（loadSettingsEntities 带 schemaTemplateId=panel:tavern-control）', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper, loadQueries } = harness([panelRow({ settings: settingsRecord() })], { loadGate })
    // Vue 3.5 的 mount（flushOnAppMount）把 onMounted 排进下一次 flush：
    // 载入中的重渲染落在首个微任务；stub 停在受控闸门 → 载入态持续可见。
    await nextTick()
    expect(wrapper.get('[data-testid="tavern-control-loading"]').text()).toBe(TEXT.loadingDetail)
    openGate()
    // 放行后要经过 stub 续体 → load 续体 → 重渲染两次微任务跳转，nextTick 会抢跑；
    // 用宏任务级 flushPromises 等整条链结算。
    await flushPromises()
    expect(loadQueries).toEqual([{ schemaTemplateId: 'panel:tavern-control' }])
    expect(wrapper.find('[data-testid="tavern-control-loading"]').exists()).toBe(false)
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('0.7')
  })

  it('载入后回显库值：模式/温度/上限/携带条数/高级键值行与开关', async () => {
    const { wrapper } = harness(
      [panelRow({ settings: settingsRecord({ mode: 'story', temperature: 1.2, maxTokens: 4096, contextMessages: 30, advanced: { style: '轻小说' } }) })],
      {},
    )
    await flushPromises()
    expect((wrapper.get('[data-testid="tavern-control-mode"]').element as HTMLSelectElement).value).toBe('story')
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('1.2')
    expect(inputValue(wrapper, 'tavern-control-max-tokens')).toBe('4096')
    expect(inputValue(wrapper, 'tavern-control-context-messages')).toBe('30')
    expect((wrapper.get('[data-testid="tavern-control-advanced"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('[data-testid="tavern-control-advanced-area"]').element).toBeDefined()
    expect(inputValue(wrapper, 'tavern-control-advanced-key-0')).toBe('style')
    expect(inputValue(wrapper, 'tavern-control-advanced-value-0')).toBe('轻小说')
    expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('saved')
  })

  it('无库值：出厂默认值 + 「尚未保存」 + 无高级说明区 + 无错误', async () => {
    const { wrapper } = harness([], {})
    await flushPromises()
    expect((wrapper.get('[data-testid="tavern-control-mode"]').element as HTMLSelectElement).value).toBe('normal')
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('0.7')
    expect(inputValue(wrapper, 'tavern-control-max-tokens')).toBe('2048')
    expect(inputValue(wrapper, 'tavern-control-context-messages')).toBe('20')
    expect(wrapper.get('[data-testid="tavern-control-saved-at"]').text()).toBe(TEXT.notSavedYet)
    expect(wrapper.find('[data-testid="tavern-control-advanced-area"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tavern-control-store-error"]').exists()).toBe(false)
  })

  it('载入失败：显示错误并回退出厂默认值（不白屏）', async () => {
    const { wrapper } = harness([], { loadError: '库打不开' })
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-control-store-error"]').text()).toBe('库打不开')
    expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('error')
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('0.7')
  })

  it('库值越界：显式提示但不静默改写库值（原样回显）', async () => {
    const { wrapper } = harness([panelRow({ settings: settingsRecord({ maxTokens: 0 }) })], {})
    await flushPromises()
    expect(inputValue(wrapper, 'tavern-control-max-tokens')).toBe('0')
    expect(wrapper.get('[data-testid="tavern-control-form-error"]').text()).toBe(TEXT.maxTokensRange)
  })
})

describe('tavern-control 面板：表单联动与保存', () => {
  it('合法修改 → 标脏 → 1500ms 防抖后自动保存，values 只带 settings，之后回到已保存', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, submitCalls } = harness([], {})
      await nextTick()
      await vi.advanceTimersByTimeAsync(50) // 载入链微任务结算
      expect(submitCalls).toHaveLength(0)
      await wrapper.get('[data-testid="tavern-control-temperature"]').setValue('0.9')
      expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('dirty')
      await vi.advanceTimersByTimeAsync(1500)
      expect(submitCalls).toHaveLength(1)
      expect(Object.keys(submitCalls[0]?.values ?? {})).toEqual(['settings'])
      expect(submittedSettings(submitCalls)).toEqual(settingsRecord({ temperature: 0.9 }))
      await vi.advanceTimersByTimeAsync(50)
      expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('saved')
      expect(wrapper.get('[data-testid="tavern-control-saved-at"]').text()).toContain(TEXT.lastSavedPrefix)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('非法输入：本地中文报错、不落库（1500ms 后也没有自动保存）', async () => {
    vi.useFakeTimers()
    try {
      const { wrapper, submitCalls } = harness([], {})
      await nextTick()
      await vi.advanceTimersByTimeAsync(50)
      await wrapper.get('[data-testid="tavern-control-temperature"]').setValue('9')
      expect(wrapper.get('[data-testid="tavern-control-form-error"]').text()).toBe(TEXT.temperatureRange)
      await vi.advanceTimersByTimeAsync(1500)
      expect(submitCalls).toHaveLength(0)
      expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('saved')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('「立即保存」：非法值报错不落库，修正后直接落库', async () => {
    const { wrapper, submitCalls } = harness([], {})
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-temperature"]').setValue('9')
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(0)
    expect(wrapper.get('[data-testid="tavern-control-form-error"]').text()).toBe(TEXT.temperatureRange)
    await wrapper.get('[data-testid="tavern-control-temperature"]').setValue('0.9')
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    expect(submittedSettings(submitCalls)).toEqual(settingsRecord({ temperature: 0.9 }))
    wrapper.unmount()
  })

  it('保存失败：错误态 + 本地数据保留（不丢用户改动）', async () => {
    const { wrapper, submitCalls } = harness([], {
      submitResult: { ok: false, code: 'STORAGE_CONFLICT', message: '已被其它窗口修改' },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-temperature"]').setValue('0.9')
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    expect(wrapper.get('[data-testid="tavern-control-store-error"]').text()).toBe('STORAGE_CONFLICT：已被其它窗口修改')
    expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('error')
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('0.9')
    wrapper.unmount()
  })

  it('模式切换 → 落库新模式', async () => {
    const { wrapper, submitCalls } = harness([], {})
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-mode"]').setValue('story')
    expect((wrapper.get('[data-testid="tavern-control-mode"]').element as HTMLSelectElement).value).toBe('story')
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    expect(submittedSettings(submitCalls).mode).toBe('story')
    wrapper.unmount()
  })

  it('高级参数：开启显示说明区与空态，键值对落库，关闭只隐藏不丢数据', async () => {
    const { wrapper, submitCalls } = harness([], {})
    await flushPromises()
    expect(wrapper.find('[data-testid="tavern-control-advanced-area"]').exists()).toBe(false)
    await wrapper.get('[data-testid="tavern-control-advanced"]').setValue(true)
    expect(wrapper.get('[data-testid="tavern-control-advanced-area"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-control-advanced-empty"]').text()).toBe(TEXT.advancedEmpty)
    // 空行（还没起名）不落库、不标脏（submitCalls 不增）
    const before = submitCalls.length
    await wrapper.get('[data-testid="tavern-control-advanced-add"]').trigger('click')
    expect(submitCalls).toHaveLength(before)
    // 填上键值 → 落库
    await wrapper.get('[data-testid="tavern-control-advanced-key-0"]').setValue('style')
    await wrapper.get('[data-testid="tavern-control-advanced-value-0"]').setValue('轻小说')
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(before + 1)
    expect(submittedSettings(submitCalls, before).advanced).toEqual({ style: '轻小说' })
    // 关闭开关：说明区隐藏；再开回来键值行还在（数据不丢）
    await wrapper.get('[data-testid="tavern-control-advanced"]').setValue(false)
    expect(wrapper.find('[data-testid="tavern-control-advanced-area"]').exists()).toBe(false)
    await wrapper.get('[data-testid="tavern-control-advanced"]').setValue(true)
    expect(inputValue(wrapper, 'tavern-control-advanced-key-0')).toBe('style')
    wrapper.unmount()
  })
})

describe('tavern-control 面板：AI 联动', () => {
  it('未配置模型：显示引导、按钮不禁用、点击不发起请求', async () => {
    const { wrapper, complete, completeCalls } = harness([], { aiConfigured: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-control-not-configured"]').text()).toBe(TEXT.notConfigured)
    const button = wrapper.get('[data-testid="tavern-control-ai-button"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(complete).not.toHaveBeenCalled()
    expect(completeCalls).toHaveLength(0)
  })

  it('AI 推荐：结果展示在面板里 → 确认对话框 → 应用到表单并落库', async () => {
    const { wrapper, completeCalls, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({
        ok: true,
        text: '```json\n{"temperature":1.1,"maxTokens":1024,"contextMessages":12}\n```',
      }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-button"]').trigger('click')
    await flushPromises()
    expect(completeCalls).toHaveLength(1)
    // 结果展示（不在遮罩后面，先看得见再确认）
    expect(wrapper.get('[data-testid="tavern-control-recommend"]').text()).toContain(TEXT.aiRecommendation)
    expect(wrapper.get('[data-testid="tavern-control-recommend"]').text()).toContain('温度 1.1')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    // 「应用此推荐」→ 对话框 → 确认
    await wrapper.get('[data-testid="tavern-control-ai-apply"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain(TEXT.applyDialogTitle)
    await wrapper.get('[data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('1.1')
    expect(inputValue(wrapper, 'tavern-control-max-tokens')).toBe('1024')
    expect(inputValue(wrapper, 'tavern-control-context-messages')).toBe('12')
    // 应用后落库
    await wrapper.get('[data-testid="tavern-control-save-now"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    expect(submittedSettings(submitCalls)).toEqual(
      settingsRecord({ temperature: 1.1, maxTokens: 1024, contextMessages: 12 }),
    )
    wrapper.unmount()
  })

  it('AI 推荐：对话框取消不应用（表单保持原值），之后仍可再应用', async () => {
    const { wrapper, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '{"temperature":1.1,"maxTokens":1024,"contextMessages":12}' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-button"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-apply"]').trigger('click')
    await wrapper.get('[data-role="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('0.7')
    expect(submitCalls).toHaveLength(0)
    // 结果还在，可再开对话框应用
    await wrapper.get('[data-testid="tavern-control-ai-apply"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').element).toBeDefined()
    await wrapper.get('[data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(inputValue(wrapper, 'tavern-control-temperature')).toBe('1.1')
    wrapper.unmount()
  })

  it('AI 返回无法解析：显示错误、不打开对话框、不落库', async () => {
    const { wrapper, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '我建议温度 1.1，其余自己看着办' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-control-ai-error"]').text()).toBe(TEXT.aiParseFailed)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tavern-control-recommend"]').exists()).toBe(false)
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 请求失败（非未配置）：显示「推荐失败：{message}」', async () => {
    const { wrapper } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_TIMEOUT', message: '上游超时' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-control-ai-error"]').text()).toBe('推荐失败：上游超时')
    expect(wrapper.find('[data-testid="tavern-control-recommend"]').exists()).toBe(false)
  })

  it('AI 请求把当前模式与用途交给 complete，maxTokens 传 1024', async () => {
    const { wrapper, completeCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '{"temperature":1,"maxTokens":100,"contextMessages":10}' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-control-ai-purpose"]').setValue('轻松闲聊')
    await wrapper.get('[data-testid="tavern-control-ai-button"]').trigger('click')
    await flushPromises()
    expect(completeCalls).toHaveLength(1)
    expect(completeCalls[0]?.maxTokens).toBe(1024)
    expect(completeCalls[0]?.messages[0]?.role).toBe('user')
    expect(completeCalls[0]?.messages[0]?.content).toContain('当前模式：正常')
    expect(completeCalls[0]?.messages[0]?.content).toContain('用途：轻松闲聊')
  })
})

describe('tavern-control 面板：文案与可见性', () => {
  it('页签标题/描述与说明区文案（TabDef + 面板常量），data-tab-id 正确', async () => {
    const { wrapper } = harness([], {})
    await flushPromises()
    const panel = wrapper.get('[data-testid="tavern-control-panel"]')
    expect(panel.attributes('data-tab-id')).toBe('tavern-control')
    expect(panel.text()).toContain(tavernControlTab.name)
    expect(wrapper.text()).toContain(tavernControlTab.description)
    const intro = wrapper.get('[data-testid="tavern-control-intro"]').text()
    expect(intro).toContain(TEXT.introLine1)
    expect(intro).toContain(TEXT.introLine2)
  })

  it('可见文本 ⊆ 页签文案 ∪ 面板常量 ∪ 状态徽章内置文案', async () => {
    const { wrapper } = harness(
      [panelRow({ settings: settingsRecord({ mode: 'story', advanced: { style: '轻小说' } }) })],
      { aiConfigured: false },
    )
    await flushPromises()
    const allowed = new Set<string>([
      tavernControlTab.name,
      tavernControlTab.description,
      ...Object.values(TEXT),
      ...TAVERN_MODES.map((option) => option.label),
      // YfeStatusPill 六态内置文案（唯一来源在组件里）
      '本地已保存', '有未保存修改', '保存中', '保存失败', '冲突', '离线（本地已保存）', '未知状态',
    ])
    const leaves: string[] = []
    for (const element of wrapper.findAll('*')) {
      for (const node of element.element.childNodes) {
        if (node.nodeType === 3) {
          const text = (node.textContent ?? '').trim()
          if (text !== '') leaves.push(text)
        }
      }
    }
    expect(leaves.length).toBeGreaterThan(0)
    for (const leaf of leaves) {
      expect(allowed.has(leaf)).toBe(true)
    }
  })
})
