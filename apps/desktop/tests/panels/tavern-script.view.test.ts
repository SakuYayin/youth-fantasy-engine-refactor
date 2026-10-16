// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 故事剧本面板（tavern-script.vue）的视图测试：
 * 挂载加载 / 列表 / 空态 / 选中与表单回灌 / 保存（成功与失败）/ 启用开关 /
 * 删除确认（YfeDialog）/ AI 写脚本（未配置引导 + 成功回填不落库 + 解析失败不落库）。
 *
 * AppState 桩取自 tavern-card.view.test.ts 的 harness 口径，额外补 `ai`（AiPort 桩）；
 * 面板数据经 createPanelStore → loadSettingsEntities / submitSettingsEntity（模板
 * `panel:tavern-script`），桩的快照里放一条面板状态行来模拟已持久化的脚本。
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
import { TAVERN_SCRIPT_PANEL_TEXT as TEXT } from '../../src/renderer/panels/tavern-script-model.js'
import TavernScript from '../../src/renderer/panels/tavern-script.vue'
import type { TavernScriptRecord } from '../../src/renderer/tavern/types.js'

const tavernScriptTab = getTab('tavern-script')
if (tavernScriptTab === undefined) throw new Error('页签 tavern-script 未注册（@yfe/schema-tabs）')

/** TavernScriptRecord 夹具。 */
function scriptRecord(input: Partial<TavernScriptRecord> = {}): TavernScriptRecord {
  return {
    id: input.id ?? 'script_fixture1',
    name: input.name ?? '开场脚本',
    code: input.code ?? '第一幕：主角进场',
    enabled: input.enabled ?? true,
    note: input.note ?? '用于开场',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  }
}

/** 面板状态行夹具：与 SettingsEntityView 同构，values 里放已持久化的脚本列表。 */
function panelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-script',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-script',
    name: '面板状态',
    values,
    orderKey: 'k',
    revision: 'r1',
    deleted: false,
  }
}

/** 完整 AppSnapshot 夹具（与 tavern-card.view.test.ts 同一口径）。 */
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
  const snapshot = snapshotWith(entities)
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
  const wrapper = mount(TavernScript, { props: { state, tab: tavernScriptTab } })
  return { wrapper, state, complete, submitCalls, loadQueries, setAiConfigured: (next: boolean) => { aiConfigured = next } }
}

describe('tavern-script 面板：挂载与加载', () => {
  it('挂载即按模板查询面板状态（loadSettingsEntities 带 schemaTemplateId=panel:tavern-script）', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper, loadQueries } = harness([panelRow({ items: [scriptRecord()] })], { loadGate })
    // Vue 3.5 的 mount 把 onMounted 排进下一次 flush：载入中的重渲染落在首个微任务；
    // stub 停在受控闸门 → 载入态持续可见。
    await nextTick()
    expect(wrapper.get('[data-testid="tavern-script-loading"]').text()).toBe(TEXT.loading)
    openGate()
    // 放行后要经过 stub 续体 → load 续体 → 重渲染两次微任务跳转，nextTick 会抢跑；
    // 用宏任务级 flushPromises 等整条链结算。
    await flushPromises()
    expect(loadQueries).toEqual([{ schemaTemplateId: 'panel:tavern-script' }])
    expect(wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').element).toBeDefined()
  })

  it('加载后渲染脚本列表：名称 / 备注摘要 / 启用文案与概览行', async () => {
    const { wrapper } = harness([
      panelRow({ items: [scriptRecord(), scriptRecord({ id: 'script_two', name: '第二场', enabled: false, note: '打斗戏' })] }),
    ])
    await flushPromises()
    expect(wrapper.findAll('.tavern-script__item')).toHaveLength(2)
    const first = wrapper.get('[data-testid="tavern-script-item-script_fixture1"]')
    expect(first.text()).toContain('开场脚本')
    expect(first.text()).toContain('用于开场')
    expect(first.text()).toContain(TEXT.enabledLabel)
    const second = wrapper.get('[data-testid="tavern-script-item-script_two"]')
    expect(second.text()).toContain('第二场')
    expect(second.text()).toContain('打斗戏')
    expect(second.text()).toContain(TEXT.disabledLabel)
    expect(wrapper.get('[data-testid="tavern-script-overview"]').text()).toBe('共 2 条脚本')
  })

  it('备注超长时截断（列表里不展示全文）', async () => {
    const long = '长'.repeat(100)
    const { wrapper } = harness([panelRow({ items: [scriptRecord({ note: long })] })])
    await flushPromises()
    const item = wrapper.get('[data-testid="tavern-script-item-script_fixture1"]')
    expect(item.text()).toContain('…')
    expect(item.text()).not.toContain(long)
  })

  it('无备注的脚本不渲染备注摘要段', async () => {
    const { wrapper } = harness([panelRow({ items: [scriptRecord({ note: '' })] })])
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tavern-script-item-note"]')).toHaveLength(0)
  })

  it('库里没有面板状态行时显示显式中文空态', async () => {
    const { wrapper } = harness([])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-empty"]').text()).toBe(TEXT.empty)
    expect(wrapper.get('[data-testid="tavern-script-overview"]').text()).toBe('共 0 条脚本')
  })

  it('坏数据（items 不是数组）不白屏，按空列表处理', async () => {
    const { wrapper } = harness([panelRow({ items: '不是数组' })])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-empty"]').element).toBeDefined()
  })
})

describe('tavern-script 面板：选中与表单回灌', () => {
  it('点击脚本条目：选中高亮 + 表单回灌为编辑态（名称 / 代码 / 备注）', async () => {
    const { wrapper } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').trigger('click')
    // 选中高亮。
    expect(wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').classes()).toContain('tavern-script__item--selected')
    // 表单回灌：编辑态标题 + 各字段值。
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.editTitle)
    expect((wrapper.get('[data-testid="tavern-script-name"]').element as HTMLInputElement).value).toBe('开场脚本')
    expect((wrapper.get('[data-testid="tavern-script-code"]').element as HTMLTextAreaElement).value).toBe('第一幕：主角进场')
    expect((wrapper.get('[data-testid="tavern-script-note"]').element as HTMLTextAreaElement).value).toBe('用于开场')
  })

  it('「新建脚本」按钮：清空表单回到新建态', async () => {
    const { wrapper } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.editTitle)
    await wrapper.get('[data-testid="tavern-script-new"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.formTitle)
    expect((wrapper.get('[data-testid="tavern-script-name"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-testid="tavern-script-code"]').element as HTMLTextAreaElement).value).toBe('')
  })

  it('「取消编辑」按钮：放弃回灌值回到新建态', async () => {
    const { wrapper } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-script-cancel-edit"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.formTitle)
    expect((wrapper.get('[data-testid="tavern-script-name"]').element as HTMLInputElement).value).toBe('')
  })
})

describe('tavern-script 面板：保存', () => {
  it('名称必填：空名称点击保存显示错误、不发提交请求', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-form-error"]').text()).toBe(TEXT.nameRequired)
    expect(submitCalls).toHaveLength(0)
  })

  it('新建保存成功：submitSettingsEntity 带 panel:tavern-script 模板与面板状态名，values.items 含新脚本', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-name"]').setValue('开场脚本')
    await wrapper.get('[data-testid="tavern-script-code"]').setValue('第一幕：主角进场')
    await wrapper.get('[data-testid="tavern-script-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const submit = submitCalls[0]!
    expect(submit.schemaTemplateId).toBe('panel:tavern-script')
    expect(submit.name).toBe('面板状态')
    const items = (submit.values as { items: TavernScriptRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.name).toBe('开场脚本')
    expect(items[0]!.code).toBe('第一幕：主角进场')
    expect(items[0]!.id.startsWith('script_')).toBe(true)
    expect(items[0]!.enabled).toBe(true)
    // 保存成功后列表出现新脚本、保存状态为「本地已保存」。
    expect(wrapper.get('[data-testid="tavern-script-overview"]').text()).toBe('共 1 条脚本')
    expect(wrapper.get('[data-testid="tavern-script-save-status"]').text()).toContain('本地已保存')
    // 面板改进：新建保存成功后切到编辑态，再点「保存脚本」是更新、不重复建一条。
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.editTitle)
    const firstId = items[0]!.id
    await wrapper.get('[data-testid="tavern-script-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(2)
    const again = (submitCalls[1]!.values as { items: TavernScriptRecord[] }).items
    expect(again).toHaveLength(1)
    expect(again[0]!.id).toBe(firstId)
  })

  it('编辑保存：保留原 id（原位更新，不新增一条）', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-script-name"]').setValue('开场脚本（改）')
    await wrapper.get('[data-testid="tavern-script-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const items = (submitCalls[0]!.values as { items: TavernScriptRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('script_fixture1')
    expect(items[0]!.name).toBe('开场脚本（改）')
  })

  it('保存失败：显示错误（不丢本地数据），状态为「保存失败」', async () => {
    const { wrapper } = harness([], {
      submitResult: { ok: false, code: 'VALIDATION_FAILED', message: 'values 不合法' },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-name"]').setValue('开场脚本')
    await wrapper.get('[data-testid="tavern-script-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-error"]').text()).toContain('VALIDATION_FAILED')
    expect(wrapper.get('[data-testid="tavern-script-save-status"]').text()).toContain('保存失败')
    // 本地数据不丢：列表仍显示这条脚本。
    expect(wrapper.get('[data-testid="tavern-script-overview"]').text()).toBe('共 1 条脚本')
  })
})

describe('tavern-script 面板：启用开关', () => {
  it('切换开关：整体替换 items 并立即保存（enabled 落库、状态文案与时间戳刷新）', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-item-state"]').text()).toBe(TEXT.enabledLabel)
    await wrapper.get('[data-testid="tavern-script-item-toggle-script_fixture1"]').setValue(false)
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-item-state"]').text()).toBe(TEXT.disabledLabel)
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.schemaTemplateId).toBe('panel:tavern-script')
    const items = (submitCalls[0]!.values as { items: TavernScriptRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.enabled).toBe(false)
    expect(items[0]!.updatedAt).not.toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('tavern-script 面板：删除（YfeDialog 确认）', () => {
  it('点删除先弹确认对话框（含脚本名），取消不删除', async () => {
    const { wrapper, submitCalls } = harness([
      panelRow({ items: [scriptRecord(), scriptRecord({ id: 'script_two', name: '第二场' })] }),
    ])
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    await wrapper
      .get('[data-testid="tavern-script-item-script_fixture1"] [data-testid="tavern-script-item-delete"]')
      .trigger('click')
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tavern-script-delete-dialog"]').text()).toContain('开场脚本')
    expect(wrapper.get('[data-testid="tavern-script-delete-dialog"]').text()).toContain('删除后无法恢复')
    await wrapper.get('[data-testid="tavern-script-delete-dialog"] [data-role="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.findAll('.tavern-script__item')).toHaveLength(2)
    expect(submitCalls).toHaveLength(0)
  })

  it('确认删除：脚本从列表移除并保存；删的是编辑中的脚本时表单重置回新建态', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [scriptRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-item-script_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.editTitle)
    await wrapper
      .get('[data-testid="tavern-script-item-script_fixture1"] [data-testid="tavern-script-item-delete"]')
      .trigger('click')
    await wrapper.get('[data-testid="tavern-script-delete-dialog"] [data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.tavern-script__item')).toHaveLength(0)
    expect(wrapper.get('[data-testid="tavern-script-empty"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-script-overview"]').text()).toBe('共 0 条脚本')
    // 删除的是正在编辑的脚本：表单重置回新建态。
    expect(wrapper.get('[data-testid="tavern-script-form-title"]').text()).toBe(TEXT.formTitle)
    expect((wrapper.get('[data-testid="tavern-script-name"]').element as HTMLInputElement).value).toBe('')
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.schemaTemplateId).toBe('panel:tavern-script')
  })
})

describe('tavern-script 面板：AI 写脚本', () => {
  const DRAFT = '第一幕：主角进场\n第二幕：剑光划破夜色'

  it('未配置模型：显示引导、按钮不禁用、不发请求', async () => {
    const { wrapper, complete } = harness([panelRow({ items: [scriptRecord()] })], { aiConfigured: false })
    await flushPromises()
    const button = wrapper.get('[data-testid="tavern-script-ai-generate"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-unconfigured"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-script-ai-message"]').text()).toBe(TEXT.notConfigured)
    expect(complete).not.toHaveBeenCalled()
  })

  it('需求描述为空：提示先填、不发请求', async () => {
    const { wrapper, complete } = harness([panelRow({ items: [scriptRecord()] })], { aiConfigured: true })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-ai-message"]').text()).toBe(TEXT.aiRequirementRequired)
    expect(complete).not.toHaveBeenCalled()
  })

  it('配置后生成成功：只回填代码编辑区 + 成功提示，不落库（预览版 AI 不替用户保存）', async () => {
    const { wrapper, complete, submitCalls } = harness([panelRow({ items: [scriptRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: DRAFT }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-ai-requirement"]').setValue('主角捡起一把发光的剑')
    await wrapper.get('[data-testid="tavern-script-ai-generate"]').trigger('click')
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    // 请求组装：system 要求只返回脚本正文、单条 user 消息、maxTokens 2048。
    const request = complete.mock.calls[0]![0]
    expect(request.system).toContain('脚本正文')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    expect(request.messages[0]!.content).toContain('主角捡起一把发光的剑')
    expect(request.maxTokens).toBe(2048)
    // 生成的草稿回填代码编辑区，等用户确认后手动保存。
    expect((wrapper.get('[data-testid="tavern-script-code"]').element as HTMLTextAreaElement).value).toBe(DRAFT)
    expect(wrapper.get('[data-testid="tavern-script-ai-message"]').text()).toBe(TEXT.aiDone)
    // AI 不落库：没有提交请求，由用户点「保存脚本」才保存。
    expect(submitCalls).toHaveLength(0)
  })

  it('解析失败：显示错误、不回填、不落库', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [scriptRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '```\n```' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-ai-requirement"]').setValue('第一场相遇')
    await wrapper.get('[data-testid="tavern-script-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-ai-message"]').text()).toBe(TEXT.aiParseFailed)
    expect((wrapper.get('[data-testid="tavern-script-code"]').element as HTMLTextAreaElement).value).toBe('')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 失败（非未配置错误码）：统一「生成失败：…」文案', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [scriptRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_TIMEOUT', message: '请求超时' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-ai-requirement"]').setValue('第一场相遇')
    await wrapper.get('[data-testid="tavern-script-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-ai-message"]').text()).toBe('生成失败：请求超时')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 返回未配置错误：同样显示引导', async () => {
    const { wrapper } = harness([panelRow({ items: [scriptRecord()] })], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_NOT_CONFIGURED', message: '配置被清空' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-script-ai-requirement"]').setValue('第一场相遇')
    await wrapper.get('[data-testid="tavern-script-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-script-unconfigured"]').element).toBeDefined()
  })
})

describe('tavern-script 面板：文案与契约', () => {
  it('渲染页签元数据（标题=页签名，描述=页签 description，导语与预览说明=面板常量）', () => {
    const { wrapper } = harness([])
    expect(wrapper.get('.tavern-script__title').text()).toBe(tavernScriptTab.name)
    expect(wrapper.get('.tavern-script__desc').text()).toBe(tavernScriptTab.description)
    expect(wrapper.get('[data-testid="tavern-script-intro"]').text()).toBe(TEXT.intro)
    expect(wrapper.get('[data-testid="tavern-script-preview-notice"]').text()).toBe(TEXT.previewNotice)
  })

  it('面板根节点带 data-testid 与 data-tab-id（用户统一验收用）', () => {
    const { wrapper } = harness([])
    const root = wrapper.get('[data-testid="tavern-script-panel"]')
    expect(root.attributes('data-tab-id')).toBe('tavern-script')
  })

  it('代码编辑区用等宽字体类展示脚本代码', () => {
    const { wrapper } = harness([])
    const code = wrapper.get('[data-testid="tavern-script-code"]')
    expect(code.classes()).toContain('tavern-script__input--code')
  })

  it('卸载后不再发起保存（store.dispose 断开自动保存）', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    wrapper.unmount()
    await flushPromises()
    expect(submitCalls).toHaveLength(0)
  })
})
