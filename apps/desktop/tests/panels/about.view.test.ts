// @vitest-environment happy-dom
/**
 * 「关于打赏」面板视图测试：真实 mount（happy-dom），验证四块内容的渲染与复制行为。
 *
 * 环境差异处理：存在性用 `(wrapper.get(...).element).toBeDefined()`；缺失性用
 * `expect(wrapper.find(...).exists()).toBe(false)`（dashboard.view.test.ts 的既有模式）。
 * AppState 桩按结构手写（本面板只触碰 getSnapshot / subscribe，其余方法全部 no-op），
 * 模式取自 apps/desktop/tests/panels/geography-map.view.test.ts，不用 `as any`。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppSnapshot, AppState } from '../../src/renderer/app-state.js'
import type { TabDef } from '@yfe/schema-tabs'
import { getTab } from '@yfe/schema-tabs'
import AboutPanel from '../../src/renderer/panels/about.vue'
import {
  APP_INTRO,
  APP_NAME,
  APP_SECTION_TITLE,
  CLIPBOARD_HINT,
  COPY_BUTTON_LABEL,
  COPY_FAILURE,
  COPY_SUCCESS,
  REBUILD_NOTES,
  REBUILD_TITLE,
  SUPPORT_LINK,
  SUPPORT_TITLE,
  VERSION_FALLBACK,
  VERSION_LABEL,
} from '../../src/renderer/panels/about-content.js'

const ABOUT_TAB: TabDef = (() => {
  const tab = getTab('about')
  if (tab === undefined) throw new Error('about 页签定义缺失')
  return tab
})()

const AI_FAILURE = { ok: false as const, code: 'AI_NOT_CONFIGURED', message: '测试桩' }

interface StateHarness {
  readonly state: AppState
  /** 模拟外壳发布快照（订阅者会收到，用于验证版本号跟随快照变化）。 */
  publish(patch: Partial<AppSnapshot>): void
}

/** 手写 AppState 桩（结构完整，不 as any）。 */
function makeState(initial: Partial<AppSnapshot> = {}): StateHarness {
  const listeners = new Set<(snapshot: AppSnapshot) => void>()
  let snapshot: AppSnapshot = {
    ready: true,
    loading: false,
    appVersion: '0.1.0',
    databasePath: null,
    databaseSchemaVersion: null,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'project-1',
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
    ...initial,
  }
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: async () => {},
    refresh: async () => {},
    createProject: async () => false,
    createChapter: async () => false,
    selectDocument: async () => false,
    edit: () => {},
    flush: async () => false,
    applyExternalUpdate: () => false,
    retrySave: () => {},
    resolveConflict: () => {},
    toggleExpanded: () => {},
    setNavigationGuard: () => {},
    dispose: () => {},
    loadSettingsEntities: async () => false,
    selectSettingsEntity: async () => false,
    refreshSettingsEntity: async () => false,
    submitSettingsEntity: async () => ({
      ok: true,
      entityId: 'row-new',
      revision: 'r2',
      orderKey: 'A02',
    }),
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => AI_FAILURE,
    },
  }
  return {
    state,
    publish: (patch) => {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener(snapshot)
    },
  }
}

interface MountProps {
  readonly state: AppState
  readonly tab: TabDef
  readonly [key: string]: unknown
}

function mountPanel(harness: StateHarness) {
  return mount(AboutPanel, {
    props: {
      state: harness.state,
      tab: ABOUT_TAB,
    } satisfies MountProps,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ==================== 渲染 ====================

describe('AboutPanel 渲染', () => {
  it('有版本号时显示版本号，不显示「开发版」', () => {
    const wrapper = mountPanel(makeState({ appVersion: '0.1.0' }))
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe('0.1.0')
    expect(wrapper.text()).not.toContain(VERSION_FALLBACK)
  })

  it('版本号为 null / 空时显示「开发版」', () => {
    expect(mountPanel(makeState({ appVersion: null })).get('[data-testid="about-version"]').text()).toBe(
      VERSION_FALLBACK,
    )
    expect(mountPanel(makeState({ appVersion: '' })).get('[data-testid="about-version"]').text()).toBe(
      VERSION_FALLBACK,
    )
  })

  it('版本号跟随快照变化（subscribe 生效，发布后重算）', async () => {
    const harness = makeState({ appVersion: '0.1.0' })
    const wrapper = mountPanel(harness)
    harness.publish({ appVersion: '0.2.0' })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe('0.2.0')
    harness.publish({ appVersion: null })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe(VERSION_FALLBACK)
  })

  it('四块内容完整渲染：应用信息 / 重构说明 / 打赏支持 / 简介', () => {
    const wrapper = mountPanel(makeState())
    const text = wrapper.text()
    expect(text).toContain(ABOUT_TAB.name)
    expect(text).toContain(APP_SECTION_TITLE)
    expect(text).toContain(APP_NAME)
    expect(text).toContain(VERSION_LABEL)
    expect(text).toContain(APP_INTRO)
    expect(text).toContain(REBUILD_TITLE)
    for (const note of REBUILD_NOTES) {
      expect(text).toContain(note)
    }
    expect(text).toContain(SUPPORT_TITLE)
    expect(text).toContain(SUPPORT_LINK)
  })

  it('剪贴板可用时不显示前置提示', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.find('[data-testid="clipboard-hint"]').exists()).toBe(false)
    expect(wrapper.get('button').text()).toBe(COPY_BUTTON_LABEL)
  })
})

// ==================== 复制支持链接 ====================

describe('AboutPanel 复制支持链接', () => {
  it('剪贴板可用：点击复制成功并显示成功提示', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(SUPPORT_LINK)
    expect(wrapper.get('[data-testid="copy-result"]').text()).toBe(COPY_SUCCESS)
  })

  it('writeText 拒绝：显示「请手动选择复制」', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="copy-result"]').text()).toBe(COPY_FAILURE)
  })

  it('剪贴板不可用：按钮不禁用，显示前置提示，点击显示失败提示', async () => {
    vi.stubGlobal('navigator', {})
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="clipboard-hint"]').text()).toBe(CLIPBOARD_HINT)

    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="copy-result"]').text()).toBe(COPY_FAILURE)
  })
})
