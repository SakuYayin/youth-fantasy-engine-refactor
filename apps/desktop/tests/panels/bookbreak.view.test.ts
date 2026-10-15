// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import type {
  AppSnapshot,
  AppState,
  SettingsEntityQuery,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../../src/renderer/app-state.js'
import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import { BOOKBREAK_PANEL_TEXT } from '../../src/renderer/panels/bookbreak-model.js'
import BookBreak from '../../src/renderer/panels/bookbreak.vue'
import type { PanelProps } from '../../src/renderer/panels/types.js'
import type { TabDef } from '@yfe/schema-tabs'
import { getTab } from '@yfe/schema-tabs'

const TEXT = BOOKBREAK_PANEL_TEXT

function bookbreakTab(): TabDef {
  const tab = getTab('bookbreak')
  if (tab === undefined) throw new Error('schema-tabs 缺少 bookbreak 页签定义')
  return tab
}

const TAB: TabDef = bookbreakTab()

const FULL_REPORT = [
  '【一句话故事核】',
  '废柴少年逆袭成为最强剑修。',
  '【主线梗概】',
  '开局被退婚，随后觉醒金手指。',
  '【人物卡】',
  '林尘：主角，性格坚韧。',
  '【爽点清单】',
  '当众打脸退婚的未婚妻。',
  '【章节要点】',
  '第1章：立主角与金手指。',
].join('\n')

interface AiHarness {
  port: AiPort
  calls: AiRequest[]
  /** 可变持有器：逐用例切换 complete 的行为。 */
  holder: {
    configured: boolean
    next: AiResult | null
    throwNext: Error | null
    /** true = complete 挂起，resolve 存进 holder 供测试手动放行。 */
    deferred: boolean
    resolve: ((result: AiResult) => void) | null
  }
}

function aiHarness(configured = true): AiHarness {
  const calls: AiRequest[] = []
  const holder: {
    configured: boolean
    next: AiResult | null
    throwNext: Error | null
    deferred: boolean
    resolve: ((result: AiResult) => void) | null
  } = { configured, next: null, throwNext: null, deferred: false, resolve: null }
  const port: AiPort = {
    getConfig: () => null,
    configured: () => holder.configured,
    reload: () => Promise.resolve(holder.configured),
    saveConfig: () => Promise.resolve(true),
    complete: (request: AiRequest) => {
      calls.push(request)
      if (holder.throwNext !== null) return Promise.reject(holder.throwNext)
      if (holder.deferred) {
        return new Promise<AiResult>((resolve) => {
          holder.resolve = resolve
        })
      }
      if (holder.next !== null) return Promise.resolve(holder.next)
      return Promise.resolve<AiResult>({
        ok: false,
        code: 'AI_NOT_CONFIGURED',
        message: '尚未配置可用模型',
      })
    },
  }
  return { port, calls, holder }
}

function snapshotFixture(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ready: true,
    loading: false,
    appVersion: '0.1.0',
    databasePath: null,
    databaseSchemaVersion: 1,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'proj-1',
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
    ...overrides,
  }
}

interface StateHarness {
  state: AppState
  loadEntitiesCalls: SettingsEntityQuery[]
  submitCalls: SettingsEntitySubmit[]
  /** 可变持有器：逐用例切换 submitSettingsEntity 的行为。 */
  submitHolder: {
    result: SettingsEntitySubmitResult | null
    throwNext: Error | null
  }
  publish: (next: AppSnapshot) => void
}

function stateHarness(ai: AiPort, snapshot: AppSnapshot = snapshotFixture()): StateHarness {
  const snapshotHolder: { value: AppSnapshot } = { value: snapshot }
  const listeners = new Set<(next: AppSnapshot) => void>()
  const loadEntitiesCalls: SettingsEntityQuery[] = []
  const submitCalls: SettingsEntitySubmit[] = []
  const submitHolder: { result: SettingsEntitySubmitResult | null; throwNext: Error | null } = {
    result: null,
    throwNext: null,
  }
  const state: AppState = {
    getSnapshot: () => snapshotHolder.value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    createProject: () => Promise.resolve(true),
    createChapter: () => Promise.resolve(true),
    selectDocument: () => Promise.resolve(true),
    edit: () => undefined,
    flush: () => Promise.resolve(true),
    applyExternalUpdate: () => false,
    retrySave: () => undefined,
    resolveConflict: () => undefined,
    toggleExpanded: () => undefined,
    setNavigationGuard: () => undefined,
    dispose: () => undefined,
    loadSettingsEntities: (options?: SettingsEntityQuery) => {
      loadEntitiesCalls.push(options ?? {})
      return Promise.resolve(true)
    },
    selectSettingsEntity: () => Promise.resolve(true),
    refreshSettingsEntity: () => Promise.resolve(true),
    submitSettingsEntity: (submit: SettingsEntitySubmit) => {
      submitCalls.push(submit)
      if (submitHolder.throwNext !== null) return Promise.reject(submitHolder.throwNext)
      if (submitHolder.result !== null) return Promise.resolve(submitHolder.result)
      return Promise.resolve<SettingsEntitySubmitResult>({
        ok: true,
        entityId: 'entity-bookbreak-1',
        revision: 'rev-2',
        orderKey: '0',
      })
    },
    ai,
  }
  const publish = (next: AppSnapshot): void => {
    snapshotHolder.value = next
    for (const listener of listeners) listener(next)
  }
  return { state, loadEntitiesCalls, submitCalls, submitHolder, publish }
}

interface MountHarness {
  ai: AiHarness
  state: StateHarness
}

function makeHarness(options: { configured?: boolean; snapshot?: AppSnapshot } = {}): MountHarness {
  const ai = aiHarness(options.configured ?? true)
  const state = stateHarness(ai.port, options.snapshot ?? snapshotFixture())
  return { ai, state }
}

interface BookBreakTestProps extends PanelProps {
  readonly [key: string]: unknown
}

function mountPanel(h: MountHarness) {
  const props: BookBreakTestProps = { state: h.state.state, tab: TAB }
  return mount(BookBreak, { props })
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('bookbreak 面板（挂载与空闲态）', () => {
  it('渲染页签标题、大文本框、开始拆书按钮与隐私提示', () => {
    const h = makeHarness()
    const wrapper = mountPanel(h)
    expect(wrapper.get('[data-testid="bookbreak-panel"]').element).toBeDefined()
    expect(wrapper.text()).toContain(TAB.name)
    expect(wrapper.text()).toContain(TEXT.privacyNote)
    expect(wrapper.get('[data-testid="bookbreak-input"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="bookbreak-start"]').text()).toContain(TEXT.start)
    expect(wrapper.find('[data-testid="bookbreak-report"]').exists()).toBe(false)
  })

  it('textarea 可输入并更新字数', async () => {
    const h = makeHarness()
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('第一章')
    expect(wrapper.get('[data-testid="bookbreak-char-count"]').text()).toContain('3')
  })

  it('空文本时「开始拆书」禁用，不发起 AI 请求', async () => {
    const h = makeHarness()
    const wrapper = mountPanel(h)
    const start = wrapper.get('[data-testid="bookbreak-start"]')
    expect((start.element as HTMLButtonElement).disabled).toBe(true)
    await start.trigger('click')
    await flushPromises()
    expect(h.ai.calls).toHaveLength(0)
  })
})

describe('bookbreak 面板（开始拆书：AI 调用与结果）', () => {
  it('请求只走 state.ai，带 system、maxTokens 4096 与文本；报告五节展示', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: true, text: FULL_REPORT, model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('主角开局被退婚。')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect(h.ai.calls).toHaveLength(1)
    const request = h.ai.calls[0]
    expect(request?.maxTokens).toBe(4096)
    expect(request?.system).toContain('网文拆书助手')
    expect(request?.messages).toHaveLength(1)
    expect(request?.messages[0]?.role).toBe('user')
    expect(request?.messages[0]?.content).toContain('主角开局被退婚。')
    expect(wrapper.get('[data-testid="bookbreak-report"]').element).toBeDefined()
    expect(wrapper.get('[data-testid="bookbreak-section-core"]').text()).toContain('一句话故事核')
    expect(wrapper.get('[data-testid="bookbreak-section-core"]').text()).toContain('废柴少年')
    expect(wrapper.get('[data-testid="bookbreak-section-outline"]').text()).toContain('金手指')
    expect(wrapper.get('[data-testid="bookbreak-section-characters"]').text()).toContain('林尘')
    expect(wrapper.get('[data-testid="bookbreak-section-hooks"]').text()).toContain('打脸')
    expect(wrapper.get('[data-testid="bookbreak-section-chapters"]').text()).toContain('第1章')
    expect(wrapper.get('[data-testid="bookbreak-copy"]').text()).toContain(TEXT.copy)
    expect(wrapper.get('[data-testid="bookbreak-save"]').text()).toContain(TEXT.save)
  })

  it('未配置模型 → 引导到模型设置，不发起请求，面板不禁用', async () => {
    const h = makeHarness({ configured: false })
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect(h.ai.calls).toHaveLength(0)
    expect(wrapper.get('[data-testid="bookbreak-unconfigured"]').text()).toBe(TEXT.notConfigured)
    expect(
      (wrapper.get('[data-testid="bookbreak-input"]').element as HTMLTextAreaElement).disabled,
    ).toBe(false)
  })

  it('complete 返回 AI_NOT_CONFIGURED → 同样引导配置', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: false, code: 'AI_NOT_CONFIGURED', message: '尚未配置可用模型' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect(h.ai.calls).toHaveLength(1)
    expect(wrapper.get('[data-testid="bookbreak-unconfigured"]').text()).toBe(TEXT.notConfigured)
  })

  it('失败：AI_TIMEOUT → 拆书失败提示带服务端 message', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: false, code: 'AI_TIMEOUT', message: '请求超时' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="bookbreak-message"]').text()).toBe('拆书失败：请求超时')
  })

  it('请求中可取消；取消后迟到结果被丢弃（取消仅忽略结果）', async () => {
    const h = makeHarness()
    h.ai.holder.deferred = true
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-testid="bookbreak-start"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.get('[data-testid="bookbreak-cancel"]').text()).toContain(TEXT.cancel)
    expect(wrapper.get('[data-testid="bookbreak-cancel-hint"]').text()).toContain('取消仅忽略结果')
    await wrapper.get('[data-testid="bookbreak-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="bookbreak-message"]').text()).toBe(TEXT.cancelled)
    // 迟到结果：AI 之后成功返回也不显示报告（runSeq 守卫）
    h.ai.holder.deferred = false
    h.ai.holder.resolve?.({ ok: true, text: FULL_REPORT, model: 'deepseek-chat' })
    await flushPromises()
    expect(wrapper.find('[data-testid="bookbreak-report"]').exists()).toBe(false)
  })

  it('AI 返回无标头文本 → raw 兜底提示与原文', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: true, text: '一段没有标头的输出。', model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="bookbreak-section-raw"]').text()).toContain('原始输出')
    expect(wrapper.text()).toContain(TEXT.rawFallbackHint)
    expect(wrapper.get('[data-testid="bookbreak-section-raw"]').text()).toContain('一段没有标头的输出。')
  })

  it('超长文本显示「已截取前 30000 字」显式提示', async () => {
    const h = makeHarness()
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('一'.repeat(30_001))
    await nextTick()
    expect(wrapper.get('[data-testid="bookbreak-truncated"]').text()).toContain('已截取前 30000 字')
    expect(wrapper.get('[data-testid="bookbreak-char-count"]').text()).toContain('30001')
  })
})

describe('bookbreak 面板（保存：按作品存 panel-store）', () => {
  it('无当前作品 → 提示先建作品，不发提交', async () => {
    const h = makeHarness({ snapshot: snapshotFixture({ projectId: null }) })
    h.ai.holder.next = { ok: true, text: FULL_REPORT, model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="bookbreak-save"]').trigger('click')
    await flushPromises()
    expect(h.state.submitCalls).toHaveLength(0)
    expect(wrapper.get('[data-testid="bookbreak-save-hint"]').text()).toBe(TEXT.noProject)
  })

  it('有当前作品 → 提交 panel:bookbreak 与报告值，提示已保存', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: true, text: FULL_REPORT, model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="bookbreak-save"]').trigger('click')
    await flushPromises()
    expect(h.state.submitCalls).toHaveLength(1)
    const submit = h.state.submitCalls[0]
    expect(submit?.schemaTemplateId).toBe('panel:bookbreak')
    expect(submit?.name).toBe('面板状态')
    expect(submit?.values).toEqual({ report: FULL_REPORT, model: 'deepseek-chat' })
    expect(wrapper.get('[data-testid="bookbreak-save-hint"]').text()).toBe(TEXT.saved)
  })

  it('保存失败 → 显示 error 且报告仍在（本地数据不丢）', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: true, text: FULL_REPORT, model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    h.state.submitHolder.result = { ok: false, code: 'SERVICE_UNAVAILABLE', message: '存储暂不可用' }
    await wrapper.get('[data-testid="bookbreak-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="bookbreak-save-error"]').text()).toBe(
      'SERVICE_UNAVAILABLE：存储暂不可用',
    )
    expect(wrapper.get('[data-testid="bookbreak-section-core"]').element).toBeDefined()
  })

  it('挂载时 load() 载入当前作品已保存的拆书报告', async () => {
    const savedEntity: SettingsEntityView = {
      id: 'entity-bookbreak-1',
      projectId: 'proj-1',
      schemaTemplateId: 'panel:bookbreak',
      name: '面板状态',
      values: { report: FULL_REPORT, model: 'deepseek-chat' },
      orderKey: '0',
      revision: 'rev-1',
      deleted: false,
    }
    const h = makeHarness({ snapshot: snapshotFixture({ settingsEntities: [savedEntity] }) })
    const wrapper = mountPanel(h)
    await flushPromises()
    expect(h.state.loadEntitiesCalls).toHaveLength(1)
    expect(h.state.loadEntitiesCalls[0]?.schemaTemplateId).toBe('panel:bookbreak')
    expect(wrapper.get('[data-testid="bookbreak-section-core"]').element).toBeDefined()
    expect(wrapper.text()).toContain('废柴少年')
  })

  it('复制报告：点击后给出已复制或失败提示（不抛错）', async () => {
    const h = makeHarness()
    h.ai.holder.next = { ok: true, text: FULL_REPORT, model: 'deepseek-chat' }
    const wrapper = mountPanel(h)
    await wrapper.get('textarea').setValue('正文')
    await wrapper.get('[data-testid="bookbreak-start"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="bookbreak-copy"]').trigger('click')
    await flushPromises()
    const copied = wrapper.find('[data-testid="bookbreak-copied"]')
    const failed = wrapper.find('[data-testid="bookbreak-copy-failed"]')
    expect(copied.exists() || failed.exists()).toBe(true)
  })
})
