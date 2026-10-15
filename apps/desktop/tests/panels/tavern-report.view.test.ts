// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * tavern-report 面板视图单测（happy-dom，真实 @yfe/ui 组件 + createPanelStore + AppState 桩）。
 *
 * 覆盖：挂载加载（模板查询 + 载入态 + 失败态）、空态与导语、列表渲染、
 * 新建/编辑保存（标题必填校验 + 提交载荷 + 保存失败不丢数据）、
 * 删除（YfeDialog 确认/取消）、AI 生成（未配置引导 / 空源 / 成功回填表单不落库 /
 * 解析失败不落库 / 失败码 / 生成中）、复制全文（剪贴板 + execCommand 兜底）、
 * 文案契约（页签元数据 + 根节点 data-tab-id）与卸载不保存。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { getTab } from '@yfe/schema-tabs'

import type {
  AppSnapshot,
  AppState,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import {
  TAVERN_REPORT_PANEL_TEXT,
} from '../../src/renderer/panels/tavern-report-model.js'
import TavernReport from '../../src/renderer/panels/tavern-report.vue'
import type { TavernReportRecord } from '../../src/renderer/tavern/types.js'

const tavernReportTab = getTab('tavern-report')
if (tavernReportTab === undefined) throw new Error('页签 tavern-report 未注册（@yfe/schema-tabs）')

/** TavernReportRecord 夹具。 */
function reportRecord(input: Partial<TavernReportRecord> = {}): TavernReportRecord {
  return {
    id: input.id ?? 'report_fixture1',
    title: input.title ?? '第一章对话摘要',
    body: input.body ?? '林晚与苏橙在图书馆发现了怀表的秘密，约定午夜再会。',
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
  }
}

/** 面板状态行夹具：与 SettingsEntityView 同构，values 里放已持久化的报告列表。 */
function panelRow(values: Record<string, unknown>): SettingsEntityView {
  return {
    id: 'entity-panel-tavern-report',
    projectId: 'project_1',
    schemaTemplateId: 'panel:tavern-report',
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
    selectedDocumentId: 'doc_1', title: '第一章', body: '原始正文', charCount: 4, revision: 'r1',
    saveStatus: 'saved', saveDetail: null, conflict: null, lastError: null, expandedIds: [],
    settingsEntities: entities, settingsLoading: false, selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
}

interface HarnessOptions {
  loadOk?: boolean
  loadGate?: Promise<void>
  /** 传入则 loadSettingsEntities 抛错（panel-store 只在抛错时置 error）。 */
  loadThrows?: string
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
  const submitCalls: Array<Parameters<AppState['submitSettingsEntity']>> = []
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
      if (options.loadThrows !== undefined) throw new Error(options.loadThrows)
      return loadOk
    },
    selectSettingsEntity: async () => true, refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => { submitCalls.push(submit); return submitResult },
    setNavigationGuard: () => {}, dispose: () => {},
    ai,
  }
  const wrapper = mount(TavernReport, { props: { state, tab: tavernReportTab } })
  return {
    wrapper,
    state,
    complete,
    submitCalls,
    loadQueries,
    setAiConfigured: (next: boolean) => { aiConfigured = next },
  }
}

/** 桩 navigator.clipboard（可覆盖，happy-dom 实例允许 defineProperty）。 */
function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
  })
}

/** 桩 document.execCommand（控制 execCommand 兜底路径的返回值）。 */
function stubExecCommand(impl: () => boolean): void {
  Object.defineProperty(document, 'execCommand', {
    value: vi.fn(impl),
    configurable: true,
  })
}

describe('tavern-report 面板：挂载与加载', () => {
  it('挂载即按模板查询面板状态（loadSettingsEntities 带 schemaTemplateId=panel:tavern-report）', async () => {
    let openGate!: () => void
    const loadGate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper, loadQueries } = harness([panelRow({ items: [reportRecord()] })], { loadGate })
    // onMounted 排进下一次 flush：stub 停在受控闸门 → 载入态持续可见。
    await nextTick()
    expect(wrapper.get('[data-testid="tavern-report-loading"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.loading,
    )
    openGate()
    // 放行后经过 stub 续体 → load 续体 → 重渲染：用宏任务级 flushPromises 等整条链结算。
    await flushPromises()
    expect(loadQueries).toEqual([{ schemaTemplateId: 'panel:tavern-report' }])
    expect(wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').element).toBeDefined()
  })

  it('空态与导语：没有面板状态行时显示空态 + 手动生成入口说明', async () => {
    const { wrapper } = harness([])
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-empty"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.empty,
    )
    expect(wrapper.get('[data-testid="tavern-report-intro"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.intro,
    )
    expect(wrapper.get('[data-testid="tavern-report-manual-entry"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.manualEntry,
    )
  })

  it('加载后渲染报告列表：标题 + 创建时间 + 正文摘要 + 概览行', async () => {
    const { wrapper } = harness([
      panelRow({ items: [reportRecord(), reportRecord({ id: 'report_two', title: '第二章摘要' })] }),
    ])
    await flushPromises()
    const items = wrapper.findAll('.tavern-report__item')
    expect(items).toHaveLength(2)
    expect(
      wrapper
        .get('[data-testid="tavern-report-item-report_fixture1"] [data-testid="tavern-report-item-name"]')
        .text(),
    ).toBe('第一章对话摘要')
    expect(
      wrapper
        .get('[data-testid="tavern-report-item-report_fixture1"] [data-testid="tavern-report-item-time"]')
        .text(),
    ).toContain(`${TAVERN_REPORT_PANEL_TEXT.createdLabel}：`)
    // 列表摘要按码点截断到 60 字符（夹具正文不足 60 字，原样展示）。
    expect(
      wrapper
        .get('[data-testid="tavern-report-item-report_fixture1"] [data-testid="tavern-report-item-brief"]')
        .text(),
    ).toContain('怀表的秘密')
    expect(wrapper.get('[data-testid="tavern-report-overview"]').text()).toBe('共 2 篇报告')
  })

  it('加载失败：显示错误态（panel-store 只在查询抛错时置 error）', async () => {
    const { wrapper } = harness([], { loadThrows: '数据库不可用' })
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-error"]').text()).toContain('数据库不可用')
    // 抛错后 data 保持默认 values（items 空）→ 空态仍可见。
    expect(wrapper.find('[data-testid="tavern-report-empty"]').exists()).toBe(true)
  })
})

describe('tavern-report 面板：保存（新建 / 编辑 / 失败）', () => {
  it('标题为空保存：显示校验文案，不发提交请求', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-form-error"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.titleRequired,
    )
    expect(submitCalls).toHaveLength(0)
  })

  it('新建保存：标题必填、id 以 report_ 开头、提交载荷带模板与面板状态名', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-title"]').setValue('第一幕摘要')
    await wrapper.get('[data-testid="tavern-report-body"]').setValue('关键剧情梳理。')
    await wrapper.get('[data-testid="tavern-report-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const submit = submitCalls[0]!
    expect(submit.schemaTemplateId).toBe('panel:tavern-report')
    expect(submit.name).toBe('面板状态')
    const items = (submit.values as { items: TavernReportRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('第一幕摘要')
    expect(items[0]!.body).toBe('关键剧情梳理。')
    expect(items[0]!.id.startsWith('report_')).toBe(true)
    // 保存成功后列表出现新报告、概览行更新、保存状态为「本地已保存」。
    expect(wrapper.get('[data-testid="tavern-report-overview"]').text()).toBe('共 1 篇报告')
    expect(wrapper.get('[data-testid="tavern-report-save-status"]').text()).toContain('本地已保存')
    // 新报告的 id 是随机生成的（非夹具 id）：夹具条目不应出现。
    expect(wrapper.find('[data-testid="tavern-report-item-report_fixture1"]').exists()).toBe(false)
  })

  it('编辑保存：点列表报告回灌表单，保留原 id（原位更新，不新增一条）', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    // 选中后：全文预览可见 + 表单进入编辑态。
    expect(wrapper.get('[data-testid="tavern-report-preview-body"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="tavern-report-form-title"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.editTitle,
    )
    await wrapper.get('[data-testid="tavern-report-title"]').setValue('第一章（改）')
    await wrapper.get('[data-testid="tavern-report-save"]').trigger('click')
    await flushPromises()
    expect(submitCalls).toHaveLength(1)
    const items = (submitCalls[0]!.values as { items: TavernReportRecord[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('report_fixture1')
    expect(items[0]!.title).toBe('第一章（改）')
  })

  it('取消编辑：表单回到新建态并清空', async () => {
    const { wrapper, submitCalls } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-report-cancel-edit"]').element).toBeDefined()
    await wrapper.get('[data-testid="tavern-report-cancel-edit"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-report-form-title"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.formTitle,
    )
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe('')
    expect(submitCalls).toHaveLength(0)
  })

  it('保存失败：显示错误（不丢本地数据），状态为「保存失败」', async () => {
    const { wrapper } = harness([], {
      submitResult: { ok: false, code: 'VALIDATION_FAILED', message: 'values 不合法' },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-title"]').setValue('第一幕摘要')
    await wrapper.get('[data-testid="tavern-report-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-error"]').text()).toContain('VALIDATION_FAILED')
    expect(wrapper.get('[data-testid="tavern-report-save-status"]').text()).toContain('保存失败')
    // 本地数据不丢：列表仍显示这篇报告。
    expect(wrapper.get('[data-testid="tavern-report-overview"]').text()).toBe('共 1 篇报告')
  })

  it('「新建报告」按钮：清空表单回到新建态', async () => {
    const { wrapper } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe(
      '第一章对话摘要',
    )
    await wrapper.get('[data-testid="tavern-report-new"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-report-form-title"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.formTitle,
    )
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe('')
  })
})

describe('tavern-report 面板：删除（YfeDialog 确认）', () => {
  it('点删除先弹确认对话框（含报告名），取消不删除', async () => {
    const { wrapper, submitCalls } = harness([
      panelRow({ items: [reportRecord(), reportRecord({ id: 'report_two', title: '第二章摘要' })] }),
    ])
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    await wrapper
      .get('[data-testid="tavern-report-item-report_fixture1"] [data-testid="tavern-report-item-delete"]')
      .trigger('click')
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tavern-report-delete-dialog"]').text()).toContain('第一章对话摘要')
    expect(wrapper.get('[data-testid="tavern-report-delete-dialog"]').text()).toContain('删除后无法恢复')
    await wrapper.get('[data-testid="tavern-report-delete-dialog"] [data-role="cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.findAll('.tavern-report__item')).toHaveLength(2)
    expect(submitCalls).toHaveLength(0)
  })

  it('确认删除：报告从列表移除并保存；删除选中的报告后预览回到空态', async () => {
    const { wrapper, submitCalls } = harness([
      panelRow({ items: [reportRecord(), reportRecord({ id: 'report_two', title: '第二章摘要' })] }),
    ])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    expect(wrapper.get('[data-testid="tavern-report-preview-body"]').element).toBeDefined()
    await wrapper
      .get('[data-testid="tavern-report-item-report_fixture1"] [data-testid="tavern-report-item-delete"]')
      .trigger('click')
    await wrapper.get('[data-testid="tavern-report-delete-dialog"] [data-role="confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.tavern-report__item')).toHaveLength(1)
    expect(wrapper.get('[data-testid="tavern-report-item-report_two"]').text()).toContain('第二章摘要')
    expect(wrapper.get('[data-testid="tavern-report-overview"]').text()).toBe('共 1 篇报告')
    expect(wrapper.get('[data-testid="tavern-report-preview-empty"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.previewEmpty,
    )
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]!.schemaTemplateId).toBe('panel:tavern-report')
  })
})

describe('tavern-report 面板：AI 生成报告', () => {
  const VALID_JSON = JSON.stringify({ title: '第一幕', body: '林晚与苏橙在图书馆相遇。' })
  const AI_SOURCE = '林晚：你醒了？\n苏橙：怀表在响，午夜见。'

  it('未配置模型：显示引导、按钮不禁用、不发请求', async () => {
    const { wrapper, complete } = harness([panelRow({ items: [reportRecord()] })], { aiConfigured: false })
    await flushPromises()
    const button = wrapper.get('[data-testid="tavern-report-ai-generate"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await button.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-unconfigured"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.notConfigured,
    )
    expect(complete).not.toHaveBeenCalled()
  })

  it('已配置但对话内容为空：提示先粘贴，不发请求', async () => {
    const { wrapper, complete } = harness([], { aiConfigured: true })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-ai-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.aiEmptySource,
    )
    expect(complete).not.toHaveBeenCalled()
  })

  it('生成成功：草稿只回填表单（不落库），请求带对话原文且 maxTokens=2048', async () => {
    const { wrapper, complete, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: VALID_JSON }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    expect(request.system).toContain('JSON')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    expect(request.messages[0]!.content).toContain(AI_SOURCE)
    expect(request.maxTokens).toBe(2048)
    // 草稿回填标题 + 正文表单，等待用户确认后手动保存。
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe('第一幕')
    expect(
      (wrapper.get('[data-testid="tavern-report-body"]').element as HTMLTextAreaElement).value,
    ).toBe('林晚与苏橙在图书馆相遇。')
    expect(wrapper.get('[data-testid="tavern-report-ai-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.aiDone,
    )
    // 不落库：没有提交请求，列表仍是空态。
    expect(submitCalls).toHaveLength(0)
    expect(wrapper.get('[data-testid="tavern-report-overview"]').text()).toBe('共 0 篇报告')
  })

  it('解析失败：显示错误、表单不回填、不落库', async () => {
    const { wrapper, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: true, text: '完全不是 JSON 的回复' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-ai-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.aiParseFailed,
    )
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe('')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 失败（非未配置错误码）：统一「生成失败：…」文案，不落库', async () => {
    const { wrapper, submitCalls } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_TIMEOUT', message: '请求超时' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-ai-message"]').text()).toBe('生成失败：请求超时')
    expect(submitCalls).toHaveLength(0)
  })

  it('AI 返回未配置错误：同样显示引导', async () => {
    const { wrapper } = harness([], {
      aiConfigured: true,
      completeImpl: async () => ({ ok: false, code: 'AI_NOT_CONFIGURED', message: '配置被清空' }),
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-unconfigured"]').element).toBeDefined()
  })

  it('生成中：按钮禁用并显示「生成中…」，完成后草稿回填', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const { wrapper } = harness([], {
      aiConfigured: true,
      completeImpl: async () => {
        await gate
        return { ok: true, text: VALID_JSON }
      },
    })
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-ai-source"]').setValue(AI_SOURCE)
    await wrapper.get('[data-testid="tavern-report-ai-generate"]').trigger('click')
    await flushPromises()
    const button = wrapper.get('[data-testid="tavern-report-ai-generate"]')
    expect(button.text()).toContain(TAVERN_REPORT_PANEL_TEXT.aiGenerating)
    expect(button.attributes('disabled')).toBeDefined()
    openGate()
    await flushPromises()
    expect((wrapper.get('[data-testid="tavern-report-title"]').element as HTMLInputElement).value).toBe('第一幕')
  })
})

describe('tavern-report 面板：复制全文', () => {
  it('剪贴板可用：复制成功提示，writeText 收到正文全文', async () => {
    stubClipboard(async () => {})
    const { wrapper } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-report-copy"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-copy-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.copyDone,
    )
    const writeText = (navigator.clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText
    expect(writeText).toHaveBeenCalledWith('林晚与苏橙在图书馆发现了怀表的秘密，约定午夜再会。')
  })

  it('剪贴板写入失败：execCommand 兜底成功时同样提示复制成功', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError')
    })
    stubExecCommand(() => true)
    const { wrapper } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-report-copy"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-copy-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.copyDone,
    )
  })

  it('剪贴板与 execCommand 都失败：如实提示复制失败', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError')
    })
    stubExecCommand(() => false)
    const { wrapper } = harness([panelRow({ items: [reportRecord()] })])
    await flushPromises()
    await wrapper.get('[data-testid="tavern-report-item-report_fixture1"]').trigger('click')
    await wrapper.get('[data-testid="tavern-report-copy"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="tavern-report-copy-message"]').text()).toBe(
      TAVERN_REPORT_PANEL_TEXT.copyFailed,
    )
  })
})

describe('tavern-report 面板：文案与契约', () => {
  it('渲染页签元数据（标题=页签名，描述=页签 description）与根节点 data-tab-id', () => {
    const { wrapper } = harness([])
    expect(wrapper.get('.tavern-report__title').text()).toBe(tavernReportTab.name)
    expect(wrapper.get('.tavern-report__desc').text()).toBe(tavernReportTab.description)
    const root = wrapper.get('[data-testid="tavern-report-panel"]')
    expect(root.attributes('data-tab-id')).toBe('tavern-report')
  })

  it('卸载后不再发起保存（store.dispose 断开自动保存）', async () => {
    const { wrapper, submitCalls } = harness([])
    await flushPromises()
    wrapper.unmount()
    await flushPromises()
    expect(submitCalls).toHaveLength(0)
  })
})
