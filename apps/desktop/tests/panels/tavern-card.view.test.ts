// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 角色卡片面板（tavern-card.vue）的视图测试：
 * 挂载加载 / 列表 / 空态 / 选中与表单回灌 / 保存（成功与失败） /
 * 删除确认（YfeDialog）/ AI 生成（未配置引导 + 成功入库 + 解析失败不落库）。
 *
 * AppState 桩取自 worlds.view.test.ts 的 harness 口径，额外补 `ai`（AiPort 桩）；
 * 面板数据经 createPanelStore → loadSettingsEntities / submitSettingsEntity（模板
 * `panel:tavern-card`），桩的快照里放一条面板状态行来模拟已持久化的卡片。
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
import { TAVERN_CARD_PANEL_TEXT } from '../../src/renderer/panels/tavern-card-model.js'
import TavernCard from '../../src/renderer/panels/tavern-card.vue'
import type { TavernCardRecord } from '../../src/renderer/tavern/types.js'

const tavernCardTab = getTab('tavern-card')
if (tavernCardTab === undefined) throw new Error('页签 tavern-card 未注册（@yfe/schema-tabs）')

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

/** 面板状态行夹具：与 SettingsEntityView 同构，values 里放已持久化的卡片列表。 */
function panelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-card',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-card',
    name: '面板状态',
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 完整 AppSnapshot 夹具（与 worlds.view.test.ts 同一口径）。 */
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
  const submitCalls: SettingsEntitySubmit[] = []
  const submitResult: SettingsEntitySubmitResult =
    options.submitResult ?? { ok: true, entityId: 'entity-panel-1', revision: 'r2', orderKey: 'k' }
  const loadQueries: Array<Parameters<AppState['loadSettingsEntities']>[0]> = []
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {}, refresh: async () => {}, createProject: async () => true,
    openProject: async () => true,
    createChapter: async () => true, selectDocument: async () => true,
    edit: vi.fn(), flush: async () => true, applyExternalUpdate: () => true,
    retrySave: () => {}, resolveConflict: () => {}, toggleExpanded: () => {},
    loadSettingsEntities: async (query) => {
      loadQueries.push(query)
      if (options.loadGate !== undefined) await options.loadGate
      return loadOk
    },
    selectSettingsEntity: async () => true, refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => { submitCalls.push(submit); return submitResult },
    setNavigationGuard: () => {}, dispose: () => {},
    ai,
  }
  const wrapper = mount(TavernCard, { props: { state, tab: tavernCardTab } })
  return { wrapper, state, complete, submitCalls, loadQueries, setAiConfigured: (next: boolean) => { aiConfigured = next } }
}

describe('tavern-card 面板：挂载与加载', () => {
  it('挂载即按模板查询面板状态（loadSettingsEntities 带 schemaTemplateId=panel:tavern-card）', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper, loadQueries } = harness([panelRow({ items: [cardRecord()] })], { loadGate })
    // Vue 3.5 的 mount（flushOnAppMount）把 onMounted 排进下一次 flush：
    // 载入中的重渲染落在首个微任务；stub 停在受控闸门 → 载入态持续可见。
    await nextTick()
    expect(wrapper.get('[data-testid="tavern-card-loading"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.loading)
    openGate()
    // 放行后要经过 stub 续体 → load 续体 → 重渲染两次微任务跳转，nextTick 会抢跑；
    // 用宏任务级 flushPromises 等整条链结算。
    await flushPromises()
    expect(loadQueries).toEqual([{ schemaTemplateId: 'panel:tavern-card' }])
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').element).toBeDefined()
  })

  it('加载后渲染卡片列表：名称 / 标签 / 简述与概览行', async () => {
    const { wrapper } = harness([panelRow({ items: [cardRecord(), cardRecord({ id: 'card_two', name: '苏橙', tags: ['旅人'] })] })])
    await flushPromises()
    const items = wrapper.findAll('.tavern-card__item')
    expect(items).toHaveLength(2)
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).toContain('林晚')
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).toContain('魔法')
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).toContain('魔法学院二年级学生')
    expect(wrapper.get('[data-testid="tavern-card-item-card_two"]').text()).toContain('苏橙')
    expect(wrapper.get('[data-testid="tavern-card-item-card_two"]').text()).toContain('旅人')
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 2 张角色卡')
    // 无标签的卡显示「无标签」徽标。
    expect(wrapper.get('[data-testid="tavern-card-item-card_two"]').text()).not.toContain(TAVERN_CARD_PANEL_TEXT.noTags)
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).not.toContain(TAVERN_CARD_PANEL_TEXT.noTags)
  })

  it('简述超长时截断（列表里不展示全文，全文在开场白预览）', async () => {
    const long = '长'.repeat(100)
    const { wrapper } = harness([panelRow({ items: [cardRecord({ description: long })] })])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).toContain('…')
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').text()).not.toContain(long)
  })

  it('库里没有面板状态行时显示显式中文空态', async () => {
    const { wrapper } = harness([])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-empty"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.empty)
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 0 张角色卡')
  })

  it('坏数据（items 不是数组）不白屏，按空列表处理', async () => {
    const { wrapper } = harness([panelRow({ items: '不是数组' })])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-empty"]').element).toBeDefined()
  })
})

describe('tavern-card 面板：选中与表单回灌', () => {
  it('点击卡片：选中高亮 + 开场白预览全文 + 表单回灌为编辑态', async () => {
    const { wrapper } = harness([panelRow({ items: [cardRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').trigger('click')
    // 选中高亮。
    expect(wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').classes()).toContain('tavern-card__item--selected')
    // 开场白预览全文。
    expect(wrapper.get('[data-testid="tavern-card-preview-body"]').text()).toBe('你在图书馆做什么？')
    // 表单回灌：编辑态标题 + 各字段值 + 标签用中文逗号回显。
    expect(wrapper.get('[data-testid="tavern-card-form-title"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.editTitle)
    expect((wrapper.get('[data-testid="tavern-card-name"]').element as HTMLInputElement).value).toBe('林晚')
    expect((wrapper.get('[data-testid="tavern-card-description"]').element as HTMLInputElement).value).toBe('魔法学院二年级学生，随身带着会说话的旧怀表。')
    expect((wrapper.get('[data-testid="tavern-card-personality"]').element as HTMLInputElement).value).toBe('沉静、好奇')
    expect((wrapper.get('[data-testid="tavern-card-first-message"]').element as HTMLInputElement).value).toBe('你在图书馆做什么？')
    expect((wrapper.get('[data-testid="tavern-card-tags"]').element as HTMLInputElement).value).toBe('魔法，少女')
  })

  it('「新建卡片」按钮：清空表单回到新建态', async () => {
    const { wrapper } = harness([panelRow({ items: [cardRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-card-form-title"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.editTitle)
    await wrapper.get('[data-testid="tavern-card-new"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-card-form-title"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.formTitle)
    expect((wrapper.get('[data-testid="tavern-card-name"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-testid="tavern-card-tags"]').element as HTMLInputElement).value).toBe('')
  })
})

describe('tavern-card 面板：保存', () => {
  it('名称必填：空名称点击保存显示错误、不发提交请求', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-form-error"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.nameRequired)
    expect(submitCalls).toHaveLength(0)
  })

  it('新建保存成功：submitSettingsEntity 带 panel:tavern-card 模板与面板状态名，values.items 含新卡', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-name"]').setValue('林晚')
    await wrapper.get('[data-testid="tavern-card-first-message"]').setValue('你醒了？')
    await wrapper.get('[data-testid="tavern-card-tags"]').setValue('魔法, 少女')
    await wrapper.get('[data-testid="tavern-card-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const submit = submitCalls[0]!
    expect(submit.schemaTemplateId).toBe('panel:tavern-card')
    expect(submit.name).toBe('面板状态')
    const items = (submit.values as { items: TavernCardRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('林晚')
    expect(items[0]!.id.startsWith('card_')).toBe(true)
    expect(items[0]!.tags).toEqual(['魔法', '少女'])
    // 保存成功后列表出现新卡、保存状态为「本地已保存」。
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 1 张角色卡')
    expect(wrapper.get('[data-testid="tavern-card-save-status"]').text()).toContain('本地已保存')
  })

  it('编辑保存：保留原 id（原位更新，不新增一条）', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [cardRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-card-name"]').setValue('林晚（改）')
    await wrapper.get('[data-testid="tavern-card-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const items = (submitCalls[0]!.values as { items: TavernCardRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('card_fixture1')
    expect(items[0]!.name).toBe('林晚（改）')
  })

  it('保存失败：显示错误（不丢本地数据），状态为「保存失败」', async () => {
    const { wrapper } = harness([], {
      submitResult: { ok: false, code: 'VALIDATION_FAILED', message: 'values 不合法' },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-name"]').setValue('林晚')
    await wrapper.get('[data-testid="tavern-card-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-error"]').text()).toContain('VALIDATION_FAILED')
    expect(wrapper.get('[data-testid="tavern-card-save-status"]').text()).toContain('保存失败')
    // 本地数据不丢：列表仍显示这张卡。
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 1 张角色卡')
  })
})

describe('tavern-card 面板：删除（YfeDialog 确认）', () => {
  it('点删除先弹确认对话框（含卡片名），取消不删除', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [cardRecord(), cardRecord({ id: 'card_two', name: '苏橙' })] })])
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    await wrapper
      .get('[data-testid="tavern-card-item-card_fixture1"] [data-testid="tavern-card-item-delete"]')
      .trigger('click')
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tavern-card-delete-dialog"]').text()).toContain('林晚')
    expect(wrapper.get('[data-testid="tavern-card-delete-dialog"]').text()).toContain('删除后无法恢复')
    await wrapper.get('[data-testid="tavern-card-delete-dialog"] [data-role="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.findAll('.tavern-card__item')).toHaveLength(2)
    expect(submitCalls).toHaveLength(0)
  })

  it('确认删除：卡片从列表移除并保存；删除选中的卡后预览回到空态', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [cardRecord(), cardRecord({ id: 'card_two', name: '苏橙' })] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-item-card_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-card-preview-body"]').element).toBeDefined()
    await wrapper
      .get('[data-testid="tavern-card-item-card_fixture1"] [data-testid="tavern-card-item-delete"]')
      .trigger('click')
    await wrapper.get('[data-testid="tavern-card-delete-dialog"] [data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.tavern-card__item')).toHaveLength(1)
    expect(wrapper.get('[data-testid="tavern-card-item-card_two"]').text()).toContain('苏橙')
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 1 张角色卡')
    expect(wrapper.get('[data-testid="tavern-card-preview-empty"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.previewEmpty)
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.schemaTemplateId).toBe('panel:tavern-card')
  })
})

describe('tavern-card 面板：AI 生成', () => {
  const VALID_JSON = JSON.stringify({
    name: '唐野',
    description: '游历四方的剑客',
    personality: '豪爽',
    firstMessage: '你醒了？',
    tags: ['剑客', '旅人'],
  })

  it('未配置模型：显示引导、按钮不禁用、不发请求', async () => {
    const { wrapper, complete } = harness([panelRow({ items: [cardRecord()] })], { aiConfigured: false })
    await flushPromises()
    const button = wrapper.get('[data-testid="tavern-card-ai-generate"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-unconfigured"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.notConfigured)
    expect(complete).not.toHaveBeenCalled()
  })

  it('配置后生成成功：入库 + 表单回灌 + 成功提示 + 保存', async () => {
    const { wrapper, complete, submitCalls } = harness([panelRow({ items: [cardRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: VALID_JSON }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-ai-generate"]').trigger('click')
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    // 请求组装：system 要求 JSON、单条 user 消息、maxTokens 2048。
    const request = complete.mock.calls[0]![0]
    expect(request.system).toContain('JSON')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    expect(request.maxTokens).toBe(2048)
    // 新卡入库 + 保存。
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 2 张角色卡')
    expect(wrapper.get('[data-testid="tavern-card-ai-message"]').text()).toBe('已生成角色卡「唐野」并加入列表。')
    expect((wrapper.get('[data-testid="tavern-card-name"]').element as HTMLInputElement).value).toBe('唐野')
    expect(submitCalls).toHaveLength(1)
  })

  it('解析失败：显示错误、不落库、不发保存请求', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [cardRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '完全不是 JSON 的回复' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-ai-message"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.aiParseFailed)
    expect(wrapper.get('[data-testid="tavern-card-overview"]').text()).toBe('共 1 张角色卡')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 失败（非未配置错误码）：统一「生成失败：…」文案', async () => {
    const { wrapper, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_TIMEOUT', message: '请求超时' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-ai-message"]').text()).toBe('生成失败：请求超时')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 返回未配置错误：同样显示引导', async () => {
    const { wrapper } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_NOT_CONFIGURED', message: '配置被清空' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-card-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-card-unconfigured"]').element).toBeDefined()
  })
})

describe('tavern-card 面板：文案与契约', () => {
  it('渲染页签元数据（标题=页签名，描述=页签 description，导语=面板常量）', () => {
    const { wrapper } = harness([])
    expect(wrapper.get('.tavern-card__title').text()).toBe(tavernCardTab.name)
    expect(wrapper.get('.tavern-card__desc').text()).toBe(tavernCardTab.description)
    expect(wrapper.get('[data-testid="tavern-card-intro"]').text()).toBe(TAVERN_CARD_PANEL_TEXT.intro)
  })

  it('面板根节点带 data-testid 与 data-tab-id（用户统一验收用）', () => {
    const { wrapper } = harness([])
    const root = wrapper.get('[data-testid="tavern-card-panel"]')
    expect(root.attributes('data-tab-id')).toBe('tavern-card')
  })

  it('卸载后不再发起保存（store.dispose 断开自动保存）', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    wrapper.unmount()
    await flushPromises()
    expect(submitCalls).toHaveLength(0)
  })
})
