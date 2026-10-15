// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * 背景设定面板（tavern-world）挂载视图测试（happy-dom）。
 *
 * 覆盖：渲染结构、空态/载入态、新建/编辑/删除（确认弹窗）/启用开关、
 * AI 扩写全路径（成功待确认→确认替换→保存、取消、解析失败、接口失败、
 * 未配置模型引导、未选中条目提示）、保存失败错误显示、卸载取消订阅、可见文案审计。
 */
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TabDef } from '@yfe/schema-tabs'
import { getTab } from '@yfe/schema-tabs'

import type {
  AppSnapshot,
  AppState,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import type { TavernWorldEntry } from '../../src/renderer/tavern/types.js'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import TavernWorld from '../../src/renderer/panels/tavern-world.vue'
import {
  TAVERN_WORLD_PANEL_TEXT as TEXT,
  briefContent,
  overviewLine,
} from '../../src/renderer/panels/tavern-world-model.js'

/** 真实页签元数据（packages/schema-tabs，getTab 命名导出）。 */
function demoTab(): TabDef {
  const tab = getTab('tavern-world')
  if (tab === undefined) throw new Error('schema-tabs 缺少 tavern-world 页签')
  return tab
}

const TAB: TabDef = demoTab()

/** YfeStatusPill 六态中文文案（组件内映射，审计白名单要带上）。 */
const CHROME_TEXT = ['本地已保存', '有未保存修改', '保存中', '保存失败', '冲突', '离线（本地已保存）']

/** 纯数据文本（数字/千分位/百分比/序号/单位）不算文案。 */
const DATA_TEXT = /^(?:[\d,.]+\s*(?:字|%)?|\d+)$/

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

function baseSnapshot(): AppSnapshot {
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
  }
}

interface AiStub {
  readonly calls: AiRequest[]
  configuredFlag: boolean
  responder: ((request: AiRequest) => Promise<AiResult>) | null
}

function makeAiStub(): { ai: AiPort; stub: AiStub } {
  const stub: AiStub = {
    calls: [],
    configuredFlag: false,
    responder: null,
  }
  const ai: AiPort = {
    getConfig: () => null,
    configured: () => stub.configuredFlag,
    reload: async () => false,
    saveConfig: async () => false,
    complete: async (request) => {
      stub.calls.push(request)
      if (stub.responder !== null) {
        return stub.responder(request)
      }
      return { ok: false, code: 'AI_NOT_CONFIGURED', message: '测试桩：未配置模型' }
    },
  }
  return { ai, stub }
}

const ENTRY_A: TavernWorldEntry = {
  id: 'world_aaaaaaaaaaaa',
  keywords: '魔法学院,灵脉',
  content: '一座漂浮在云海上的魔法学院，灵脉贯穿主塔。',
  enabled: true,
  order: 0,
}

const ENTRY_B: TavernWorldEntry = {
  id: 'world_bbbbbbbbbbbb',
  keywords: '星陨节',
  content: '每百年一次的节日，陨石坠落之夜许愿会成真。',
  enabled: false,
  order: 1,
}

/** 库里已有的面板状态（settings_entities 通道，模板 panel:tavern-world）。 */
function storedEntity(values: { items: TavernWorldEntry[]; updatedAt?: string }): SettingsEntityView {
  return {
    id: 'ent_tw_1',
    projectId: 'prj_1',
    schemaTemplateId: 'panel:tavern-world',
    name: '面板状态',
    values,
    orderKey: 'A1',
    revision: 'rev_1',
    deleted: false,
  }
}

interface HarnessOptions {
  readonly projectId?: string | null
  readonly settingsEntities?: readonly SettingsEntityView[]
  readonly configured?: boolean
  readonly submitResult?: SettingsEntitySubmitResult
  readonly loadSettingsEntities?: () => Promise<boolean>
}

function harness(options: HarnessOptions = {}) {
  const { ai, stub } = makeAiStub()
  if (options.configured !== undefined) {
    stub.configuredFlag = options.configured
  }
  let snapshot: AppSnapshot = baseSnapshot()
  if (options.projectId !== undefined) {
    snapshot = { ...snapshot, projectId: options.projectId }
  }
  if (options.settingsEntities !== undefined) {
    snapshot = { ...snapshot, settingsEntities: options.settingsEntities }
  }
  let notify: ((next: AppSnapshot) => void) | undefined
  let unsubscribed = false
  const submitCalls: SettingsEntitySubmit[] = []
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
    loadSettingsEntities: options.loadSettingsEntities ?? (async () => true),
    selectSettingsEntity: async () => true,
    refreshSettingsEntity: async () => true,
    submitSettingsEntity: async (submit) => {
      submitCalls.push({ ...submit })
      return (
        options.submitResult ?? { ok: true, entityId: 'ent_tw_1', revision: 'rev_2', orderKey: 'A1' }
      )
    },
    ai,
  }
  return {
    state,
    stub,
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
interface TavernWorldMountProps extends PanelProps {
  readonly [key: string]: unknown
}

function mountTavernWorld(state: AppState, tab: TabDef = TAB) {
  const props: TavernWorldMountProps = { state, tab }
  return mount(TavernWorld, { props })
}

/** 微任务冲刷：load/complete 都是 async，挂载后要等 store 读到库值再断言。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await nextTick()
    await Promise.resolve()
  }
  await nextTick()
}

function itemSelector(entry: TavernWorldEntry): string {
  return `[data-testid="tavern-world-item-${entry.id}"]`
}

async function selectEntry(wrapper: ReturnType<typeof mountTavernWorld>, entry: TavernWorldEntry): Promise<void> {
  await wrapper.get(itemSelector(entry)).trigger('click')
  await settle()
}

async function saveEntry(
  wrapper: ReturnType<typeof mountTavernWorld>,
  keywords: string,
  content: string,
): Promise<void> {
  await wrapper.get<HTMLInputElement>('[data-testid="tavern-world-keywords"]').setValue(keywords)
  await wrapper.get<HTMLTextAreaElement>('[data-testid="tavern-world-content"]').setValue(content)
  await wrapper.get('[data-testid="tavern-world-save"]').trigger('click')
  await settle()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('背景设定面板 tavern-world：渲染结构', () => {
  it('渲染页签标题、说明条、工具条与空态', async () => {
    const h = harness()
    const wrapper = mountTavernWorld(h.state)
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-panel"]').exists()).toBe(true)
    expect(wrapper.get('h1').text()).toBe(TAB.name)
    expect(wrapper.get('[data-testid="tavern-world-intro"]').text()).toBe(TEXT.intro)
    expect(wrapper.get('[data-testid="tavern-world-overview"]').text()).toBe(overviewLine([]))
    expect(wrapper.find('[data-testid="tavern-world-empty"]').exists()).toBe(true)
    expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('saved')
    expect(wrapper.find('[data-testid="tavern-world-new"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tavern-world-form-title"]').text()).toBe(TEXT.formTitle)

    wrapper.unmount()
  })

  it('载入中显示载入态，载入完成后渲染条目', async () => {
    let resolveLoad: ((value: boolean) => void) | undefined
    const h = harness({
      settingsEntities: [storedEntity({ items: [ENTRY_A] })],
      loadSettingsEntities: () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve
        }),
    })
    const wrapper = mountTavernWorld(h.state)
    await nextTick()

    expect(wrapper.find('[data-testid="tavern-world-loading"]').exists()).toBe(true)

    resolveLoad?.(true)
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tavern-world-empty"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(1)
    expect(wrapper.get('[data-testid="tavern-world-item-keywords"]').text()).toContain('魔法学院')
    expect(wrapper.get('[data-testid="tavern-world-item-brief"]').text()).toBe(
      briefContent(ENTRY_A.content),
    )

    wrapper.unmount()
  })

  it('无作品时显示保存引导', async () => {
    const h = harness({ projectId: null })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-no-project"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tavern-world-no-project"]').text()).toBe(TEXT.noProject)

    wrapper.unmount()
  })

  it('库值缺 updatedAt 字段时用默认值补齐，不报错', async () => {
    const entity = storedEntity({ items: [ENTRY_A] })
    const h = harness({ settingsEntities: [{ ...entity, values: { items: entity.values.items } }] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(1)

    wrapper.unmount()
  })
})

describe('背景设定面板 tavern-world：新建与校验', () => {
  it('关键词必填：留空不落库', async () => {
    const h = harness()
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await saveEntry(wrapper, '，，', '内容')

    expect(wrapper.get('[data-testid="tavern-world-form-error"]').text()).toBe(TEXT.keywordsRequired)
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('内容必填：留空不落库', async () => {
    const h = harness()
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await saveEntry(wrapper, '魔法学院', '   ')

    expect(wrapper.get('[data-testid="tavern-world-form-error"]').text()).toBe(TEXT.contentRequired)
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('新建成功：写入 panel:tavern-world 模板并保存，表单切到编辑态', async () => {
    const h = harness()
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await saveEntry(wrapper, '魔法学院,灵脉', '一座漂浮在云海上的学院。')

    expect(h.submitCalls.length).toBe(1)
    const first = h.submitCalls[0]
    expect(first?.schemaTemplateId).toBe('panel:tavern-world')
    const values = first?.values as { items: TavernWorldEntry[]; updatedAt: string }
    expect(values.items.length).toBe(1)
    expect(values.items[0]?.keywords).toBe('魔法学院,灵脉')
    expect(values.items[0]?.content).toBe('一座漂浮在云海上的学院。')
    expect(values.items[0]?.enabled).toBe(true)
    expect(values.items[0]?.order).toBe(0)
    expect(values.items[0]?.id.startsWith('world_')).toBe(true)

    expect(wrapper.get('[data-testid="tavern-world-form-title"]').text()).toBe(TEXT.editFormTitle)
    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(1)
    expect(wrapper.get<HTMLInputElement>('[data-testid="tavern-world-keywords"]').element.value).toBe(
      '魔法学院,灵脉',
    )

    wrapper.unmount()
  })
})

describe('背景设定面板 tavern-world：编辑与启用开关', () => {
  it('点条目回灌表单，改内容保存后按原 id 更新', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await selectEntry(wrapper, ENTRY_A)

    expect(wrapper.get('[data-testid="tavern-world-form-title"]').text()).toBe(TEXT.editFormTitle)
    expect(wrapper.get<HTMLInputElement>('[data-testid="tavern-world-keywords"]').element.value).toBe(
      ENTRY_A.keywords,
    )
    expect(
      wrapper.get<HTMLTextAreaElement>('[data-testid="tavern-world-content"]').element.value,
    ).toBe(ENTRY_A.content)
    expect(
      (wrapper.get<HTMLInputElement>(`[data-testid="tavern-world-item-toggle-${ENTRY_A.id}"]`).element)
        .checked,
    ).toBe(true)
    expect(wrapper.get('[data-testid="tavern-world-preview-body"]').text()).toBe(ENTRY_A.content)

    await saveEntry(wrapper, ENTRY_A.keywords, '修改后的内容。')

    expect(h.submitCalls.length).toBe(1)
    const values = h.submitCalls[0]?.values as { items: TavernWorldEntry[] }
    expect(values.items.length).toBe(2)
    expect(values.items[0]?.id).toBe(ENTRY_A.id)
    expect(values.items[0]?.content).toBe('修改后的内容。')
    expect(values.items[1]?.id).toBe(ENTRY_B.id)

    wrapper.unmount()
  })

  it('「取消编辑」放弃未保存的表单修改', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await selectEntry(wrapper, ENTRY_A)
    await wrapper.get<HTMLInputElement>('[data-testid="tavern-world-keywords"]').setValue('被丢弃的关键词')
    await wrapper.get('[data-testid="tavern-world-cancel-edit"]').trigger('click')
    await settle()

    expect(wrapper.get<HTMLInputElement>('[data-testid="tavern-world-keywords"]').element.value).toBe(
      ENTRY_A.keywords,
    )
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('列表里的启用开关：整体替换 items 并保存，表单镜像同步', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await selectEntry(wrapper, ENTRY_B)
    await wrapper
      .get<HTMLInputElement>(`[data-testid="tavern-world-item-toggle-${ENTRY_B.id}"]`)
      .setValue(true)
    await settle()

    expect(h.submitCalls.length).toBe(1)
    const values = h.submitCalls[0]?.values as { items: TavernWorldEntry[] }
    expect(values.items[1]?.id).toBe(ENTRY_B.id)
    expect(values.items[1]?.enabled).toBe(true)
    expect(values.items[0]?.enabled).toBe(true)
    expect(values.items[0]?.order).toBe(0)
    expect(values.items[1]?.order).toBe(1)
    expect(
      (wrapper.get<HTMLInputElement>(`[data-testid="tavern-world-item-toggle-${ENTRY_B.id}"]`).element)
        .checked,
    ).toBe(true)

    wrapper.unmount()
  })
})

describe('背景设定面板 tavern-world：删除（YfeDialog 确认）', () => {
  it('删除前弹确认框，取消不动数据', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await wrapper
      .get(`[data-testid="tavern-world-item-delete-${ENTRY_A.id}"]`)
      .trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-delete-dialog"]').exists()).toBe(true)
    expect(wrapper.get('.yfe-dialog__title').text()).toContain(ENTRY_A.keywords)

    await wrapper.get('[data-role="cancel"]').trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-delete-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(2)
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('确认删除后移除条目并重排 order', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await wrapper
      .get(`[data-testid="tavern-world-item-delete-${ENTRY_A.id}"]`)
      .trigger('click')
    await settle()
    await wrapper.get('[data-role="confirm"]').trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-delete-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(1)
    expect(h.submitCalls.length).toBe(1)
    const values = h.submitCalls[0]?.values as { items: TavernWorldEntry[] }
    expect(values.items.length).toBe(1)
    expect(values.items[0]?.id).toBe(ENTRY_B.id)
    expect(values.items[0]?.order).toBe(0)

    wrapper.unmount()
  })
})

describe('背景设定面板 tavern-world：AI 扩写', () => {
  const EXPANDED = '扩写后的完整世界设定：云海学院的灵脉自星陨之夜起改道。'

  function aiHarness(): ReturnType<typeof harness> {
    return harness({
      configured: true,
      settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })],
    })
  }

  it('未配置模型：显示引导、不发请求、按钮不禁用', async () => {
    const h = harness({ configured: false, settingsEntities: [storedEntity({ items: [ENTRY_A] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)

    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="tavern-world-unconfigured"]').text()).toBe(TEXT.notConfigured)
    expect(h.stub.calls.length).toBe(0)
    expect(
      (wrapper.get('[data-testid="tavern-world-ai-expand"]').element as HTMLButtonElement).disabled,
    ).toBe(false)

    wrapper.unmount()
  })

  it('未选中条目：提示先选中，不发请求', async () => {
    const h = harness({ configured: true })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="tavern-world-ai-message"]').text()).toBe(TEXT.aiNeedSelected)
    expect(h.stub.calls.length).toBe(0)

    wrapper.unmount()
  })

  it('成功：请求带关键词+内容+maxTokens 2048，待确认弹窗展示扩写结果', async () => {
    const h = aiHarness()
    h.stub.responder = async () => ({ ok: true, text: EXPANDED })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)

    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    expect(h.stub.calls.length).toBe(1)
    expect(h.stub.calls[0]?.maxTokens).toBe(2048)
    expect(h.stub.calls[0]?.messages[0]?.content).toContain(ENTRY_A.keywords)
    expect(h.stub.calls[0]?.messages[0]?.content).toContain(ENTRY_A.content)

    expect(wrapper.get('[data-testid="tavern-world-ai-preview-body"]').text()).toBe(EXPANDED)
    expect(wrapper.find('[data-testid="tavern-world-expand-dialog"]').exists()).toBe(true)
    // 确认前不落库
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('确认替换：content 换成扩写结果并保存，关键词保持不变', async () => {
    const h = aiHarness()
    h.stub.responder = async () => ({ ok: true, text: EXPANDED })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)
    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    await wrapper.get('[data-role="confirm"]').trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-expand-dialog"]').exists()).toBe(false)
    expect(h.submitCalls.length).toBe(1)
    const values = h.submitCalls[0]?.values as { items: TavernWorldEntry[] }
    expect(values.items[0]?.id).toBe(ENTRY_A.id)
    expect(values.items[0]?.content).toBe(EXPANDED)
    expect(values.items[0]?.keywords).toBe(ENTRY_A.keywords)
    expect(values.items[0]?.enabled).toBe(true)
    expect(wrapper.get('[data-testid="tavern-world-preview-body"]').text()).toBe(EXPANDED)
    expect(wrapper.get('[data-testid="tavern-world-ai-message"]').text()).toBe(
      `已用 AI 扩写条目「${ENTRY_A.keywords}」，下一轮对话生效。`,
    )

    wrapper.unmount()
  })

  it('取消替换：丢弃扩写结果，原内容保持不变', async () => {
    const h = aiHarness()
    h.stub.responder = async () => ({ ok: true, text: EXPANDED })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)
    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    await wrapper.get('[data-role="cancel"]').trigger('click')
    await settle()

    expect(wrapper.find('[data-testid="tavern-world-expand-dialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="tavern-world-preview-body"]').text()).toBe(ENTRY_A.content)
    expect(h.submitCalls.length).toBe(0)
    expect(wrapper.get('[data-testid="tavern-world-ai-message"]').text()).toBe(TEXT.aiCancelled)

    wrapper.unmount()
  })

  it('解析失败：空结果显示错误、不落库、不弹窗', async () => {
    const h = aiHarness()
    h.stub.responder = async () => ({ ok: true, text: '   ' })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)

    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="tavern-world-ai-message"]').text()).toBe(TEXT.aiParseFailed)
    expect(wrapper.find('[data-testid="tavern-world-expand-dialog"]').exists()).toBe(false)
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })

  it('接口失败：显示失败文案、不落库', async () => {
    const h = aiHarness()
    h.stub.responder = async () => ({ ok: false, code: 'AI_TIMEOUT', message: '请求超时' })
    const wrapper = mountTavernWorld(h.state)
    await settle()
    await selectEntry(wrapper, ENTRY_A)

    await wrapper.get('[data-testid="tavern-world-ai-expand"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="tavern-world-ai-message"]').text()).toBe('扩写失败：请求超时')
    expect(h.submitCalls.length).toBe(0)

    wrapper.unmount()
  })
})

describe('背景设定面板 tavern-world：保存失败与生命周期', () => {
  it('保存失败：显示错误码与文案，数据保留', async () => {
    const h = harness({
      submitResult: { ok: false, code: 'VALIDATION_MISSING_FIELD', message: '还没有作品，先新建作品再保存设定。' },
    })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    await saveEntry(wrapper, '魔法学院', '内容')

    expect(wrapper.get('[data-testid="tavern-world-error"]').text()).toBe(
      'VALIDATION_MISSING_FIELD：还没有作品，先新建作品再保存设定。',
    )
    expect(wrapper.get('.yfe-status-pill').attributes('data-status')).toBe('error')
    // 失败不清空内存数据
    expect(wrapper.findAll('[data-testid="tavern-world-list"] > li').length).toBe(1)

    wrapper.unmount()
  })

  it('卸载后取消订阅', async () => {
    const h = harness()
    const wrapper = mountTavernWorld(h.state)
    await settle()

    wrapper.unmount()

    expect(h.isUnsubscribed()).toBe(true)
  })
})

describe('背景设定面板 tavern-world：可见文案审计', () => {
  it('可见文本 ⊆ 页签文案 ∪ 面板常量 ∪ 状态条文案 ∪ 数据文本', async () => {
    const h = harness({ settingsEntities: [storedEntity({ items: [ENTRY_A, ENTRY_B] })] })
    const wrapper = mountTavernWorld(h.state)
    await settle()

    const allowed = new Set<string>([
      TAB.name,
      TAB.description,
      ...Object.values(TEXT),
      ...CHROME_TEXT,
      overviewLine([ENTRY_A, ENTRY_B]),
      ENTRY_A.keywords,
      ENTRY_B.keywords,
      briefContent(ENTRY_A.content),
      briefContent(ENTRY_B.content),
    ])
    const foreign = textNodesOf(wrapper.element).filter(
      (text) => !allowed.has(text) && !DATA_TEXT.test(text),
    )
    expect(foreign).toEqual([])

    wrapper.unmount()
  })
})
