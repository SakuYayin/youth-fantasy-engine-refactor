// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * creative-writing（创意写作）视图测试：渲染、带入章节、生成/取消/复制、未配置引导、持久化。
 */

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DocumentId, DocumentSummary, ProjectId, Revision, UtcTimestamp } from '@yfe/contracts'
import type { TabDef } from '@yfe/schema-tabs'

import type { AppSnapshot, AppState, SettingsEntityView } from '../../src/renderer/app-state.js'
import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import CreativeWriting from '../../src/renderer/panels/creative-writing.vue'
import {
  CONTINUE_MAX_TOKENS,
  MAX_SOURCE_CHARS,
  WRITING_COPY,
  resultCharsLine,
  writingModeById,
  writingModes,
} from '../../src/renderer/panels/creative-writing-model.js'

const AT = '2026-01-01T00:00:00.000Z'

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
    updatedAt: ts(AT),
    charCount: input.charCount ?? 0,
    hasChildren: false,
  }
}

const demoTab: TabDef = {
  id: 'creative-writing',
  name: '创意写作',
  group: '工作面板',
  type: 'creative-writing',
  description: 'AI 续写/改写/润色工作台',
  tips: [],
}

/** 组件与依赖组件内建的中文字样白名单（非本面板文案）。 */
const CHROME_TEXT = ['本地已保存', '有未保存修改', '保存中', '保存失败']

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

interface HarnessOptions {
  readonly documents?: readonly DocumentSummary[]
  readonly selectedDocumentId?: string
  readonly body?: string
  readonly settingsEntities?: readonly SettingsEntityView[]
  readonly configured?: boolean
}

function harness(options: HarnessOptions = {}) {
  const { ai, stub } = makeAiStub()
  if (options.configured !== undefined) {
    stub.configuredFlag = options.configured
  }
  let snapshot: AppSnapshot = baseSnapshot(options.documents ?? [])
  if (options.selectedDocumentId !== undefined) {
    snapshot = { ...snapshot, selectedDocumentId: options.selectedDocumentId as DocumentId }
  }
  if (options.body !== undefined) {
    snapshot = { ...snapshot, body: options.body }
  }
  if (options.settingsEntities !== undefined) {
    snapshot = { ...snapshot, settingsEntities: options.settingsEntities }
  }
  let notify: ((next: AppSnapshot) => void) | undefined
  let unsubscribed = false
  /** selectDocument 切章后各章节的正文（带入来源用）。 */
  const bodies: Record<string, string> = {}
  const submitCalls: Array<Record<string, unknown>> = []
  const selectCalls: string[] = []
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
    selectDocument: async (documentId) => {
      selectCalls.push(documentId)
      snapshot = {
        ...snapshot,
        selectedDocumentId: documentId as DocumentId,
        body: bodies[documentId] ?? '',
      }
      notify?.(snapshot)
      return true
    },
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
      return { ok: true, entityId: 'ent_1', revision: 'rev_1', orderKey: 'A1' }
    },
    ai,
  }
  return {
    state,
    stub,
    submitCalls,
    selectCalls,
    bodies,
    isUnsubscribed: () => unsubscribed,
    async publish(patch: Partial<AppSnapshot>): Promise<void> {
      snapshot = { ...snapshot, ...patch }
      notify?.(snapshot)
      await nextTick()
    },
  }
}

/** mount 用本地 props 接口（带索引签名，匹配 vue-shims 的宽松组件类型）。 */
interface CreativeWritingMountProps extends PanelProps {
  readonly [key: string]: unknown
}

function mountCreativeWriting(state: AppState, tab: TabDef = demoTab) {
  const props: CreativeWritingMountProps = { state, tab }
  return mount(CreativeWriting, { props })
}

async function settle(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function sourceValue(wrapper: ReturnType<typeof mountCreativeWriting>): string {
  return wrapper.get<HTMLTextAreaElement>('[data-testid="creative-writing-source"]').element.value
}

function buttonDisabled(wrapper: ReturnType<typeof mountCreativeWriting>, testId: string): boolean {
  return (wrapper.get(`[data-testid="${testId}"]`).element as HTMLButtonElement).disabled
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('creative-writing（创意写作）渲染', () => {
  const twoChapters = (): HarnessOptions => ({
    documents: [
      summary({ id: 'doc_1', title: '第一章 风起', charCount: 1200, orderKey: 'A1' }),
      summary({ id: 'doc_2', title: '第二章 云涌', charCount: 3400, orderKey: 'A2' }),
      summary({ id: 'doc_3', title: '已删章节', deleted: 1, orderKey: 'A9' }),
      summary({ id: 'doc_4', title: '第一卷', kind: 'volume', orderKey: 'A0' }),
    ],
    selectedDocumentId: 'doc_1',
    configured: true,
  })

  it('渲染页签标题、来源输入框、三种模式与插入提示', async () => {
    const h = harness(twoChapters())
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    expect(
      wrapper.get('[data-testid="creative-writing-panel"] .creative-writing__title').text(),
    ).toBe(demoTab.name)
    expect(
      wrapper.findAll('[data-testid="creative-writing-modes"] input[type="radio"]'),
    ).toHaveLength(3)
    expect(wrapper.get('[data-testid="creative-writing-generate"]').text()).toBe(
      WRITING_COPY.generateLabel,
    )
    expect(wrapper.get('[data-testid="creative-writing-insert-note"]').text()).toBe(
      WRITING_COPY.insertNote,
    )
    expect(wrapper.get('[data-testid="creative-writing-mode-hint"]').text()).toBe(
      writingModeById('continue').hint,
    )
    // 配置了模型时不显示未配置引导
    expect(wrapper.find('[data-testid="creative-writing-not-configured"]').exists()).toBe(false)
  })

  it('章节下拉只列当前作品未删章节，默认选中当前章节', async () => {
    const h = harness(twoChapters())
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    const select = wrapper.get<HTMLSelectElement>(
      '[data-testid="creative-writing-chapter-select"]',
    )
    const options = select.findAll('option')
    expect(options.map((option) => (option.element as HTMLOptionElement).text)).toEqual([
      '第一章 风起',
      '第二章 云涌',
    ])
    expect(options.map((option) => (option.element as HTMLOptionElement).value)).toEqual([
      'doc_1',
      'doc_2',
    ])
    expect(select.element.value).toBe('doc_1')
  })

  it('未配置模型时挂载即显示中文引导，但不禁用面板', async () => {
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      selectedDocumentId: 'doc_1',
      configured: false,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-not-configured"]').text()).toBe(
      WRITING_COPY.notConfiguredGuide,
    )
    // 面板仍可用：来源输入框、章节带入都在；生成按钮只因来源为空而禁用，并给出提示
    expect(wrapper.find('[data-testid="creative-writing-source"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="creative-writing-bring"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="creative-writing-source-hint"]').text()).toBe(
      WRITING_COPY.sourceRequired,
    )
    expect(buttonDisabled(wrapper, 'creative-writing-generate')).toBe(true)
  })

  it('带入当前章节正文：直接读快照，不切章', async () => {
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      selectedDocumentId: 'doc_1',
      body: '林晚推开门。',
      configured: true,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    expect(sourceValue(wrapper)).toBe('')
    await wrapper.get('[data-testid="creative-writing-bring"]').trigger('click')
    await settle()

    expect(sourceValue(wrapper)).toBe('林晚推开门。')
    expect(h.selectCalls).toEqual([])
    expect(wrapper.find('[data-testid="creative-writing-bring-hint"]').exists()).toBe(false)
  })

  it('带入选中章节（非当前）：切章并带入该章正文', async () => {
    const h = harness({
      documents: [
        summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' }),
        summary({ id: 'doc_2', title: '第二章', orderKey: 'A2' }),
      ],
      selectedDocumentId: 'doc_1',
      body: '第一章正文。',
      configured: true,
    })
    h.bodies['doc_2'] = '第二章正文。'
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    await wrapper.get('[data-testid="creative-writing-chapter-select"]').setValue('doc_2')
    await wrapper.get('[data-testid="creative-writing-bring"]').trigger('click')
    await settle()

    expect(h.selectCalls).toEqual(['doc_2'])
    expect(sourceValue(wrapper)).toBe('第二章正文。')
  })

  it('带入空章节：提示且不覆盖来源', async () => {
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      selectedDocumentId: 'doc_1',
      body: '   ',
      configured: true,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    await wrapper.get('[data-testid="creative-writing-bring"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-bring-hint"]').text()).toBe(
      WRITING_COPY.bringEmpty,
    )
    expect(sourceValue(wrapper)).toBe('')
  })

  it('无章节时显示引导且不渲染带入区', async () => {
    const h = harness({ documents: [], configured: true })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-empty-chapters"]').text()).toBe(
      WRITING_COPY.emptyChapters,
    )
    expect(wrapper.find('[data-testid="creative-writing-chapter-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="creative-writing-bring"]').exists()).toBe(false)
  })

  it('可见中文文案只来自面板常量、页签文案、组件字样与纯数据', async () => {
    const documents = [
      summary({ id: 'doc_1', title: '第一章 风起', orderKey: 'A1' }),
      summary({ id: 'doc_2', title: '第二章 云涌', orderKey: 'A2' }),
    ]
    const allowed = new Set<string>([
      demoTab.name,
      demoTab.description,
      ...Object.values(WRITING_COPY),
      ...writingModes.map((mode) => mode.label),
      ...writingModes.map((mode) => mode.hint),
      ...CHROME_TEXT,
      ...documents.map((document) => document.title),
    ])
    const h = harness({ documents, selectedDocumentId: 'doc_1', configured: true })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    const foreign = textNodesOf(wrapper.element).filter(
      (text) => !allowed.has(text) && !DATA_TEXT.test(text),
    )
    expect(foreign).toEqual([])
  })
})

describe('creative-writing（创意写作）生成', () => {
  function readyHarness(): { h: ReturnType<typeof harness>; wrapper: ReturnType<typeof mountCreativeWriting> } {
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      selectedDocumentId: 'doc_1',
      configured: true,
    })
    return { h, wrapper: mountCreativeWriting(h.state) }
  }

  it('生成成功：状态已完成、结果原样展示、字数与复制可用', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('林晚推开门。')
    h.stub.responder = async () => ({ ok: true, text: '  她看见了那道光。  ' })

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateDone,
    )
    expect(
      wrapper.get<HTMLTextAreaElement>('[data-testid="creative-writing-result"]').element.value,
    ).toBe('她看见了那道光。')
    expect(wrapper.get('[data-testid="creative-writing-result-chars"]').text()).toBe(
      resultCharsLine(8),
    )
    expect(buttonDisabled(wrapper, 'creative-writing-copy')).toBe(false)
    expect(wrapper.find('[data-testid="creative-writing-error"]').exists()).toBe(false)
  })

  it('续写请求：system 按模式切换，maxTokens 默认 4096，正文与写要求进消息', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('林晚推开门。')
    await wrapper.get('[data-testid="creative-writing-instruction"]').setValue('打斗写细一点')
    h.stub.responder = async () => ({ ok: true, text: '续写内容' })

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(h.stub.calls).toHaveLength(1)
    const request = h.stub.calls[0]
    expect(request?.system).toBe(writingModeById('continue').system)
    expect(request?.maxTokens).toBe(CONTINUE_MAX_TOKENS)
    expect('temperature' in request).toBe(false)
    const message = request?.messages[0]
    expect(message?.role).toBe('user')
    expect(message?.content).toContain('【正文】\n林晚推开门。')
    expect(message?.content).toContain('【写作要求】\n打斗写细一点')
  })

  it('改写模式与会话参数：不传 maxTokens 时改由会话参数透传，模式选中态回显', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-mode-rewrite"]').setValue()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('原文')
    await wrapper.get('[data-testid="creative-writing-temperature"]').setValue('0.7')
    await wrapper.get('[data-testid="creative-writing-max-tokens"]').setValue('2048')
    h.stub.responder = async () => ({ ok: true, text: '改写结果' })

    expect(
      (
        wrapper.get('[data-testid="creative-writing-mode-rewrite"]')
          .element as HTMLInputElement
      ).checked,
    ).toBe(true)

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    const request = h.stub.calls[0]
    expect(request?.system).toBe(writingModeById('rewrite').system)
    expect(request?.temperature).toBe(0.7)
    expect(request?.maxTokens).toBe(2048)
  })

  it('未配置 complete 返回 AI_NOT_CONFIGURED：显示引导与失败状态，不禁用面板', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    // 默认桩 complete 返回 AI_NOT_CONFIGURED

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateFailed,
    )
    expect(wrapper.get('[data-testid="creative-writing-not-configured"]').text()).toBe(
      WRITING_COPY.notConfiguredGuide,
    )
    expect(wrapper.get('[data-testid="creative-writing-error"]').text()).toBe(
      'AI_NOT_CONFIGURED：测试桩：未配置模型',
    )
    expect(wrapper.find('[data-testid="creative-writing-source"]').exists()).toBe(true)
  })

  it('complete 失败（AI_TIMEOUT）：失败状态与错误文案，不显示结果框', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    h.stub.responder = async () => ({ ok: false, code: 'AI_TIMEOUT', message: '测试桩：超时' })

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateFailed,
    )
    expect(wrapper.get('[data-testid="creative-writing-error"]').text()).toBe(
      'AI_TIMEOUT：测试桩：超时',
    )
    expect(wrapper.find('[data-testid="creative-writing-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="creative-writing-not-configured"]').exists()).toBe(false)
  })

  it('生成中可取消：按钮 loading、状态回空闲，迟到结果被丢弃（取消仅忽略结果）', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    let resolvePending: ((result: AiResult) => void) | null = null
    h.stub.responder = async () =>
      new Promise<AiResult>((resolve) => {
        resolvePending = resolve
      })

    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateGenerating,
    )
    expect(buttonDisabled(wrapper, 'creative-writing-generate')).toBe(true)
    expect(wrapper.get('[data-testid="creative-writing-cancel"]').text()).toBe(
      WRITING_COPY.cancelLabel,
    )

    await wrapper.get('[data-testid="creative-writing-cancel"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateIdle,
    )
    expect(wrapper.get('[data-testid="creative-writing-cancel-note"]').text()).toBe(
      WRITING_COPY.cancelNote,
    )
    expect(buttonDisabled(wrapper, 'creative-writing-generate')).toBe(false)

    // pending 的 AiResult 结算后被丢弃：不显示结果，状态仍是空闲
    resolvePending?.({ ok: true, text: '迟到的结果' })
    await settle()
    expect(wrapper.find('[data-testid="creative-writing-result"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateIdle,
    )

    // 取消后可再次生成
    h.stub.responder = async () => ({ ok: true, text: '第二次结果' })
    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()
    expect(wrapper.get('[data-testid="creative-writing-state"]').text()).toBe(
      WRITING_COPY.stateDone,
    )
  })

  it('复制成功：结果文本写进剪贴板', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    h.stub.responder = async () => ({ ok: true, text: '结果文本' })
    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text)
        },
      },
    })

    await wrapper.get('[data-testid="creative-writing-copy"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-copy-state"]').text()).toBe(
      WRITING_COPY.copied,
    )
    expect(written).toEqual(['结果文本'])
  })

  it('复制失败（剪贴板拒绝且 execCommand 失败）：提示手动复制', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    h.stub.responder = async () => ({ ok: true, text: '结果文本' })
    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('测试桩：剪贴板拒绝')
        },
      },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    })

    await wrapper.get('[data-testid="creative-writing-copy"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-copy-state"]').text()).toBe(
      WRITING_COPY.copyFailed,
    )
  })

  it('会话参数非法时不发送并提示，修正后可发送', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    await wrapper.get('[data-testid="creative-writing-source"]').setValue('正文')
    await wrapper.get('[data-testid="creative-writing-temperature"]').setValue('abc')
    h.stub.responder = async () => ({ ok: true, text: '不应到达' })

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-param-hint"]').text()).toBe(
      WRITING_COPY.paramInvalid,
    )
    expect(h.stub.calls).toHaveLength(0)

    await wrapper.get('[data-testid="creative-writing-temperature"]').setValue('0.7')
    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(h.stub.calls).toHaveLength(1)
    expect(wrapper.find('[data-testid="creative-writing-param-hint"]').exists()).toBe(false)
  })

  it('超长来源：先提示将截取，生成时显式标注已截取前 30000 字且只发开头', async () => {
    const { h, wrapper } = readyHarness()
    await settle()
    const tail = '结尾标记'
    await wrapper
      .get('[data-testid="creative-writing-source"]')
      .setValue('长'.repeat(MAX_SOURCE_CHARS) + tail)
    expect(wrapper.get('[data-testid="creative-writing-source-overlimit"]').text()).toBe(
      WRITING_COPY.sourceOverLimit,
    )
    h.stub.responder = async () => ({ ok: true, text: '结果' })

    await wrapper.get('[data-testid="creative-writing-generate"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="creative-writing-truncated"]').text()).toBe(
      WRITING_COPY.truncatedNotice,
    )
    const request = h.stub.calls[0]
    const message = request?.messages[0]
    expect(message?.content).not.toContain(tail)
    expect(message?.content).toContain('长'.repeat(MAX_SOURCE_CHARS))
  })
})

describe('creative-writing（创意写作）设置持久化', () => {
  it('模式与设置修改 1.5 秒自动保存（模板 panel:creative-writing）', async () => {
    vi.useFakeTimers()
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      configured: true,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    await wrapper.get('[data-testid="creative-writing-mode-rewrite"]').setValue()
    await wrapper.get('[data-testid="creative-writing-instruction"]').setValue('打斗写细一点')
    await wrapper.get('[data-testid="creative-writing-temperature"]').setValue('0.7')
    await wrapper.get('[data-testid="creative-writing-max-tokens"]').setValue('2048')
    expect(h.submitCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1600)

    expect(h.submitCalls).toHaveLength(1)
    const submit = h.submitCalls[0]
    expect(submit?.['schemaTemplateId']).toBe('panel:creative-writing')
    expect(submit?.['name']).toBe('面板状态')
    expect(submit?.['values']).toEqual({
      mode: 'rewrite',
      instruction: '打斗写细一点',
      temperature: '0.7',
      maxTokens: '2048',
    })
  })

  it('载入已保存的面板状态后回显模式与参数', async () => {
    const stored: SettingsEntityView = {
      id: 'ent_9',
      projectId: 'prj_1',
      schemaTemplateId: 'panel:creative-writing',
      name: '面板状态',
      values: { mode: 'rewrite', instruction: '对话再口语些', temperature: '0.9' },
      orderKey: 'A1',
      revision: 'rev_9',
      deleted: false,
    }
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      settingsEntities: [stored],
      configured: true,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()

    expect(
      (wrapper.get('[data-testid="creative-writing-mode-rewrite"]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(
      (
        wrapper.get('[data-testid="creative-writing-mode-continue"]').element as HTMLInputElement
      ).checked,
    ).toBe(false)
    expect(
      wrapper.get<HTMLTextAreaElement>('[data-testid="creative-writing-instruction"]').element
        .value,
    ).toBe('对话再口语些')
    expect(
      wrapper.get<HTMLInputElement>('[data-testid="creative-writing-temperature"]').element.value,
    ).toBe('0.9')
    expect(
      wrapper.get<HTMLInputElement>('[data-testid="creative-writing-max-tokens"]').element.value,
    ).toBe('')
  })

  it('卸载时解订阅，且 dispose 后不再自动保存', async () => {
    vi.useFakeTimers()
    const h = harness({
      documents: [summary({ id: 'doc_1', title: '第一章', orderKey: 'A1' })],
      configured: true,
    })
    const wrapper = mountCreativeWriting(h.state)
    await settle()
    expect(h.isUnsubscribed()).toBe(false)

    await wrapper.get('[data-testid="creative-writing-instruction"]').setValue('草稿')
    wrapper.unmount()
    expect(h.isUnsubscribed()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.submitCalls).toHaveLength(0)
  })
})
