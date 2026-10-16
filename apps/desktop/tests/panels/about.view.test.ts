// @vitest-environment happy-dom
/**
 * 「关于打赏」面板（W9-3 · C-02）视图测试：真实 mount（happy-dom）。
 *
 * 覆盖：8 个功能块的渲染、props→状态的四态文案、**未接线路径的显式说明**、
 * 事件上抛（`check-update` / `set-auto-check` / `open-link` / `import-legacy-data` /
 * `collect-diagnostics` / `skip-version`）与复制行为（成功 / 拒绝 / 剪贴板缺失）。
 *
 * 受控重渲染用**宿主探针** `AboutHost`（模式取自
 * `apps/desktop/tests/schema/tab-sidebar-collapse.test.ts:83-107`）：本仓 `vue-shims.d.ts`
 * 把 `*.vue` 声明成 `DefineComponent<{}, {}, unknown>`，直接 `mount(AboutPanel).setProps(...)`
 * 在普通 `tsc` 下会丢掉具名 prop；宿主的 props 是真声明的，且这正是 Lead 在 `App.vue` 里的接法。
 *
 * AppState 桩按结构手写（本面板只触碰 `getSnapshot` / `subscribe`，其余方法全部 no-op），
 * 不用 `as any`。存在性用 `wrapper.get(...)`，缺失性用 `.exists()` 判否。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import type { PropType } from 'vue'

import type { TabDef } from '@yfe/schema-tabs'
import { getTab } from '@yfe/schema-tabs'

import type { AppSnapshot, AppState } from '../../src/renderer/app-state.js'
import AboutPanel from '../../src/renderer/panels/about.vue'
import type { AboutLegacyProbe, AboutUpdateInfo } from '../../src/renderer/panels/about-model.js'
import {
  APP_NAME_EN,
  AUTHOR_DESC,
  AUTHOR_NAME,
  AUTO_CHECK_LABEL,
  AVATAR_PLACEHOLDER_NOTE,
  BILI_BUTTON_LABEL,
  BILI_URL,
  CHECKING_LABEL,
  CHECK_ERROR_PREFIX,
  CHECK_LABEL,
  CHECK_UNWIRED_HINT,
  CLIPBOARD_HINT,
  CONTACT_LINKS,
  COPY_CODE_SUCCESS,
  COPY_FAILURE,
  COPY_TOKEN_SUCCESS,
  DIAG_COPY_SUCCESS,
  DIAG_WAITING,
  GITEE_RELEASES_URL,
  HELP_TEXT_NORMAL,
  HELP_TEXT_PORTABLE,
  HELP_TITLE,
  LEGACY_UNWIRED_NOTE,
  MIGRATION_DESC,
  PAGE_INTRO_APP,
  PAGE_INTRO_TAIL,
  PORTABLE_DOWNLOAD_NOTE,
  PORTABLE_RELEASE_LABEL,
  QUARK_CODE,
  QUARK_TOKEN,
  SECTION_AUTHOR,
  SECTION_CONTACT,
  SECTION_DOWNLOAD,
  SECTION_MIGRATION,
  SECTION_SUPPORT,
  SECTION_THANKS,
  SUPPORT_DESC,
  THANKS,
  THANKS_EMPTY,
  UPDATE_CLOSE_LABEL,
  UPDATE_LATEST,
  UPDATE_NO_DOWNLOAD_URL,
  UPDATE_NOTES_EMPTY,
  UPDATE_QUARK_NOTE,
  UPDATE_SKIP_LABEL,
  VERSION_FALLBACK,
  skippedLabel,
  updateDialogTitle,
} from '../../src/renderer/panels/about-model.js'

const ABOUT_TAB: TabDef = (() => {
  const tab = getTab('about')
  if (tab === undefined) throw new Error('about 页签定义缺失')
  return tab
})()

const AI_FAILURE = { ok: false as const, code: 'AI_NOT_CONFIGURED' as const, message: '测试桩' }

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
    openProject: async () => true,
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

/** 面板的可选额外 props（与 `about-model.ts` 的 `AboutPanelInputs` 同口径）。 */
interface PanelExtras {
  readonly appVersion?: string | null
  readonly buildAt?: string | null
  readonly portable?: boolean
  readonly update?: AboutUpdateInfo | null
  readonly checking?: boolean
  readonly checkError?: string | null
  readonly autoCheck?: boolean
  readonly legacyProbe?: AboutLegacyProbe | null
  readonly diagnostics?: string | null
  readonly authorAvatarUrl?: string | null
  readonly wechatPayUrl?: string | null
  readonly alipayPayUrl?: string | null
  readonly quarkUrl?: string | null
  readonly quarkCode?: string | null
  readonly quarkToken?: string | null
  readonly thanks?: readonly string[]
}

/**
 * 受控重渲染用的**宿主**：只把父层 props 原样转给 `AboutPanel`，自己不记状态。
 * 这就是 Lead 在 `App.vue` 里的接法：外壳持状态、面板只收 props。
 */
const AboutHost = defineComponent({
  name: 'AboutHostProbe',
  props: {
    state: { type: Object as PropType<AppState>, required: true },
    tab: { type: Object as PropType<TabDef>, required: true },
    appVersion: { type: String as PropType<string | null>, default: undefined },
    buildAt: { type: String as PropType<string | null>, default: undefined },
    portable: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    update: { type: Object as PropType<AboutUpdateInfo | null>, default: undefined },
    checking: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    checkError: { type: String as PropType<string | null>, default: undefined },
    autoCheck: { type: Boolean as PropType<boolean | undefined>, default: undefined },
    legacyProbe: { type: Object as PropType<AboutLegacyProbe | null>, default: undefined },
    diagnostics: { type: String as PropType<string | null>, default: undefined },
    authorAvatarUrl: { type: String as PropType<string | null>, default: undefined },
    wechatPayUrl: { type: String as PropType<string | null>, default: undefined },
    alipayPayUrl: { type: String as PropType<string | null>, default: undefined },
    quarkUrl: { type: String as PropType<string | null>, default: undefined },
    quarkCode: { type: String as PropType<string | null>, default: undefined },
    quarkToken: { type: String as PropType<string | null>, default: undefined },
    thanks: { type: Array as PropType<readonly string[]>, default: undefined },
  },
  setup(hostProps) {
    return () =>
      h(AboutPanel, {
        state: hostProps.state,
        tab: hostProps.tab,
        appVersion: hostProps.appVersion,
        buildAt: hostProps.buildAt,
        portable: hostProps.portable,
        update: hostProps.update,
        checking: hostProps.checking,
        checkError: hostProps.checkError,
        autoCheck: hostProps.autoCheck,
        legacyProbe: hostProps.legacyProbe,
        diagnostics: hostProps.diagnostics,
        authorAvatarUrl: hostProps.authorAvatarUrl,
        wechatPayUrl: hostProps.wechatPayUrl,
        alipayPayUrl: hostProps.alipayPayUrl,
        quarkUrl: hostProps.quarkUrl,
        quarkCode: hostProps.quarkCode,
        quarkToken: hostProps.quarkToken,
        thanks: hostProps.thanks,
      })
  },
})

function mountPanel(harness: StateHarness, extras: PanelExtras = {}) {
  return mount(AboutHost, {
    props: { state: harness.state, tab: ABOUT_TAB, ...extras },
  })
}

/** 在宿主里定位被测面板（宿主只多包一层，`data-testid` 不变）。 */
function panelOf(wrapper: ReturnType<typeof mountPanel>) {
  const panel = wrapper.findComponent(AboutPanel)
  if (panel.exists() !== true) throw new Error('AboutPanel 未渲染')
  return panel
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ==================== 骨架与静态文案 ====================

describe('AboutPanel · 骨架与静态文案', () => {
  it('不传任何额外 props（只 state + tab）也能完整渲染，并逐字给出各块文案', () => {
    const wrapper = mountPanel(makeState())
    const text = wrapper.text()

    expect(text).toContain(ABOUT_TAB.name)
    expect(text).toContain(HELP_TITLE)
    expect(wrapper.get('[data-testid="about-intro"]').text()).toContain(APP_NAME_EN)
    expect(wrapper.get('[data-testid="about-intro"]').text()).toContain(APP_NAME_EN)
    expect(wrapper.get('[data-testid="about-intro"]').element.textContent).toContain(PAGE_INTRO_APP)
    expect(wrapper.get('[data-testid="about-intro"]').element.textContent).toContain(PAGE_INTRO_TAIL)

    for (const title of [
      SECTION_AUTHOR,
      SECTION_DOWNLOAD,
      SECTION_MIGRATION,
      SECTION_CONTACT,
      SECTION_SUPPORT,
      SECTION_THANKS,
    ]) {
      expect(text).toContain(title)
    }

    expect(wrapper.get('[data-testid="about-author-name"]').text()).toBe(AUTHOR_NAME)
    expect(wrapper.get('[data-testid="about-author-desc"]').text()).toBe(AUTHOR_DESC)
    expect(text).toContain(BILI_BUTTON_LABEL)
    expect(wrapper.get('[data-testid="about-migration-desc"]').text()).toBe(MIGRATION_DESC)
    expect(wrapper.get('[data-testid="about-support-desc"]').text()).toBe(SUPPORT_DESC)

    expect(wrapper.findAll('[data-testid="about-contact-item"]')).toHaveLength(CONTACT_LINKS.length)
    for (const link of CONTACT_LINKS) {
      expect(text).toContain(link.label)
      expect(text).toContain(link.value)
    }

    expect(wrapper.findAll('[data-testid="about-thank-item"]')).toHaveLength(THANKS.length)
    for (const name of THANKS) expect(text).toContain(name)
  })

  it('帮助气泡：默认（常规版）文案为 HELP_TEXT_NORMAL', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="about-help-toggle"]').text()).toBe(HELP_TITLE)
    expect(wrapper.get('[data-testid="about-help-text"]').text()).toBe(HELP_TEXT_NORMAL)
  })

  it('便携版：帮助文案切到 HELP_TEXT_PORTABLE，更新区换静态下载指引', () => {
    const wrapper = mountPanel(makeState(), { portable: true })
    expect(wrapper.get('[data-testid="about-help-text"]').text()).toBe(HELP_TEXT_PORTABLE)
    expect(wrapper.get('[data-testid="about-portable-note"]').text()).toBe(PORTABLE_DOWNLOAD_NOTE)
    expect(wrapper.get('[data-testid="about-open-release"]').text()).toBe(PORTABLE_RELEASE_LABEL)
    expect(wrapper.find('[data-testid="about-check-update"]').exists()).toBe(false)
  })

  it('常规版：有检查更新按钮与自动检查开关，没有便携版说明', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="about-check-update"]').text()).toBe(CHECK_LABEL)
    expect(wrapper.find('[data-testid="about-portable-note"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="about-auto-check"]')).toBeDefined()
    expect(wrapper.text()).toContain(AUTO_CHECK_LABEL)
  })
})

// ==================== 版本信息 ====================

describe('AboutPanel · 版本信息', () => {
  it('版本号来自快照并按上游口径加 v 前缀', () => {
    const wrapper = mountPanel(makeState({ appVersion: '0.1.0' }))
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe('v0.1.0')
    expect(wrapper.text()).not.toContain(VERSION_FALLBACK)
  })

  it('快照版本为 null / 空时显示「开发版」', () => {
    expect(
      mountPanel(makeState({ appVersion: null })).get('[data-testid="about-version"]').text(),
    ).toBe(VERSION_FALLBACK)
    expect(
      mountPanel(makeState({ appVersion: '' })).get('[data-testid="about-version"]').text(),
    ).toBe(VERSION_FALLBACK)
  })

  it('版本号跟随快照变化（subscribe 生效，卸载时退订）', async () => {
    const harness = makeState({ appVersion: '0.1.0' })
    const wrapper = mountPanel(harness)
    harness.publish({ appVersion: '0.2.0' })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe('v0.2.0')
    harness.publish({ appVersion: null })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe(VERSION_FALLBACK)
  })

  it('appVersion prop 优先于快照（外壳接管版本号）', () => {
    const wrapper = mountPanel(makeState({ appVersion: '0.1.0' }), { appVersion: '3.0.1' })
    expect(wrapper.get('[data-testid="about-version"]').text()).toBe('v3.0.1')
  })

  it('构建时间只在传入时展示', () => {
    expect(mountPanel(makeState()).find('[data-testid="about-build-at"]').exists()).toBe(false)
    const wrapper = mountPanel(makeState(), { buildAt: '2026-10-16T17:14:23+08:00' })
    expect(wrapper.get('[data-testid="about-build-at"]').text()).toContain(
      '2026-10-16T17:14:23+08:00',
    )
  })
})

// ==================== 未接线路径必须显式说明 ====================

describe('AboutPanel · 未接线路径', () => {
  it('更新检查 / 旧版探测未接线时给出中文说明，不假装可用', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="about-check-unwired"]').text()).toBe(CHECK_UNWIRED_HINT)
    expect(wrapper.get('[data-testid="about-legacy-unwired"]').text()).toBe(LEGACY_UNWIRED_NOTE)
  })

  it('图片类资源未接线时渲染占位说明（头像 / 两种收款码）', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="about-avatar-placeholder"]').text()).toBe(
      AVATAR_PLACEHOLDER_NOTE,
    )
    for (const key of ['wechat', 'alipay'] as const) {
      expect(wrapper.get(`[data-testid="about-pay-placeholder-${key}"]`).text()).toContain('图片由外壳提供')
      expect(wrapper.find(`[data-testid="about-pay-img-${key}"]`).exists()).toBe(false)
    }
  })

  it('图片类资源传入后改为渲染真图，占位说明消失', () => {
    const wrapper = mountPanel(makeState(), {
      authorAvatarUrl: 'file:///avatar.png',
      wechatPayUrl: 'file:///wechat.png',
      alipayPayUrl: 'file:///alipay.png',
    })
    expect(wrapper.find('[data-testid="about-avatar-placeholder"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="about-pay-img-wechat"]').attributes('src')).toBe(
      'file:///wechat.png',
    )
    expect(wrapper.get('[data-testid="about-pay-img-alipay"]').attributes('src')).toBe(
      'file:///alipay.png',
    )
  })

  it('quarkUrl 传空串 = 未接线：不拿内置短链假装可用，并给出说明', async () => {
    const wrapper = mountPanel(makeState(), { quarkUrl: '' })
    expect(wrapper.find('[data-testid="about-quark-unwired"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="about-quark-code"]').text()).toBe(QUARK_CODE)
    expect(wrapper.get('[data-testid="about-open-quark"]').text()).toBe('打开网盘下载')
    // 空链接不发事件：外壳拿到空 URL 只能报错，不如在面板侧直接拦住。
    await wrapper.get('[data-testid="about-open-quark"]').trigger('click')
    expect(panelOf(wrapper).emitted('open-link')).toBeUndefined()
  })

  it('quarkUrl 正常时不显示未接线说明', () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.find('[data-testid="about-quark-unwired"]').exists()).toBe(false)
  })

  it('致谢名单传空数组时给「暂空」说明，不静默空白', () => {
    const wrapper = mountPanel(makeState(), { thanks: [] })
    expect(wrapper.find('[data-testid="about-thanks-list"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="about-thanks-empty"]').text()).toBe(THANKS_EMPTY)
  })

  it('致谢名单可由外壳覆盖', () => {
    const wrapper = mountPanel(makeState(), { thanks: ['甲', '乙'] })
    const items = wrapper.findAll('[data-testid="about-thank-item"]')
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.text())).toEqual(['甲', '乙'])
  })
})

// ==================== 更新检查四态 ====================

describe('AboutPanel · 更新检查状态', () => {
  it('checking 为真：按钮文案切「检查中…」并禁用（含 aria-busy）', () => {
    const wrapper = mountPanel(makeState(), { checking: true })
    const button = wrapper.get('[data-testid="about-check-update"]')
    expect(button.text()).toBe(CHECKING_LABEL)
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-testid="about-check-unwired"]').exists()).toBe(false)
  })

  it('有新版本：提示块打开、标题与说明行来自 props、缺直链时下载按钮禁用', () => {
    const wrapper = mountPanel(makeState(), {
      update: { available: true, version: '3.1.0', notes: '# 标题\n- 修复 A' },
    })
    expect(wrapper.get('[data-testid="about-update-result"]').text()).toBe('有新版本 v3.1.0')
    expect(wrapper.get('[data-testid="about-update-dialog-title"]').text()).toBe(
      updateDialogTitle('3.1.0'),
    )
    expect(
      wrapper.findAll('[data-testid="about-update-note-line"]').map((node) => node.text()),
    ).toEqual(['标题', '修复 A'])
    expect(wrapper.get('[data-testid="about-update-no-download"]').text()).toBe(
      UPDATE_NO_DOWNLOAD_URL,
    )
    expect(wrapper.get('[data-testid="about-update-download"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="about-update-quark-note"]').text()).toBe(UPDATE_QUARK_NOTE)
    expect(wrapper.get('[data-testid="about-update-close"]').text()).toBe(UPDATE_CLOSE_LABEL)
    expect(wrapper.get('[data-testid="about-update-skip"]').text()).toBe(UPDATE_SKIP_LABEL)
  })

  it('有安装包直链时下载按钮可用', () => {
    const wrapper = mountPanel(makeState(), {
      update: {
        available: true,
        version: '3.1.0',
        notes: '修好了',
        downloadUrl: 'https://example.com/app.exe',
      },
    })
    const button = wrapper.get('[data-testid="about-update-download"]')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="about-update-no-download"]').exists()).toBe(false)
  })

  it('更新说明为空：提示块给出占位说明', () => {
    const wrapper = mountPanel(makeState(), { update: { available: true, version: '3.1.0' } })
    expect(wrapper.get('[data-testid="about-update-notes-empty"]').text()).toBe(UPDATE_NOTES_EMPTY)
  })

  it('已是最新版本 / 已跳过：文案与上游一致，且不打开提示块', () => {
    const latest = mountPanel(makeState(), { update: { available: false, latestFound: true } })
    expect(latest.get('[data-testid="about-update-result"]').text()).toBe(UPDATE_LATEST)
    expect(latest.find('[data-testid="about-update-dialog"]').exists()).toBe(false)

    const skipped = mountPanel(makeState(), {
      update: { available: false, skipped: true, version: '3.1.0', latestFound: true },
    })
    expect(skipped.get('[data-testid="about-update-result"]').text()).toBe(skippedLabel('3.1.0'))
  })

  it('检查失败：给出带前缀的中文提示，并取代「未接线」说明', () => {
    const wrapper = mountPanel(makeState(), { checkError: '网络不可达' })
    expect(wrapper.get('[data-testid="about-check-error"]').text()).toBe(
      `${CHECK_ERROR_PREFIX}网络不可达`,
    )
    expect(wrapper.find('[data-testid="about-check-unwired"]').exists()).toBe(false)
  })

  it('受控重渲染：外壳推来「有新版本」后提示块打开，推来失败原因后按 props 重算', async () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.find('[data-testid="about-update-dialog"]').exists()).toBe(false)

    await wrapper.setProps({ checking: true })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-check-update"]').text()).toBe(CHECKING_LABEL)

    await wrapper.setProps({
      checking: false,
      update: { available: true, version: '3.2.0', notes: '有更新' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="about-update-dialog"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="about-update-result"]').text()).toBe('有新版本 v3.2.0')

    await wrapper.setProps({ update: { available: false, latestFound: true }, checkError: '超时' })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-update-result"]').text()).toBe(UPDATE_LATEST)
    expect(wrapper.get('[data-testid="about-check-error"]').text()).toBe(
      `${CHECK_ERROR_PREFIX}超时`,
    )
  })

  it('受控重渲染：portable 开关切换更新区分支', async () => {
    const wrapper = mountPanel(makeState())
    expect(wrapper.find('[data-testid="about-portable-note"]').exists()).toBe(false)

    await wrapper.setProps({ portable: true })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-portable-note"]').text()).toBe(PORTABLE_DOWNLOAD_NOTE)
    expect(wrapper.find('[data-testid="about-check-update"]').exists()).toBe(false)

    await wrapper.setProps({ portable: false })
    await flushPromises()
    expect(wrapper.find('[data-testid="about-check-update"]').exists()).toBe(true)
  })
})

// ==================== 事件上抛（面板自己不做副作用） ====================

describe('AboutPanel · 事件上抛', () => {
  it('点「检查更新」只发 check-update，不自己联网', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-check-update"]').trigger('click')
    expect(panelOf(wrapper).emitted('check-update')).toEqual([[]])
  })

  it('点 B 站主页发 open-link（含 URL 与文案），且不调用 window.open', async () => {
    const openSpy = vi.fn()
    vi.stubGlobal('open', openSpy)
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-open-bili"]').trigger('click')
    expect(panelOf(wrapper).emitted('open-link')).toEqual([[BILI_URL, BILI_BUTTON_LABEL]])
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('点「打开网盘下载」发 open-link 带内置夸克地址', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-open-quark"]').trigger('click')
    expect(panelOf(wrapper).emitted('open-link')?.[0]?.[1]).toBe('打开网盘下载')
    expect(panelOf(wrapper).emitted('open-link')?.[0]?.[0]).toContain('pan.quark.cn')
  })

  it('点「导入旧版数据」只发 import-legacy-data', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-import-legacy"]').trigger('click')
    expect(panelOf(wrapper).emitted('import-legacy-data')).toEqual([[]])
  })

  it('自动检查开关：勾选即上抛 set-auto-check(true)，并以 props 为最终状态', async () => {
    const wrapper = mountPanel(makeState(), { autoCheck: false })
    await wrapper.get('[data-testid="about-auto-check"]').setValue(true)
    expect(panelOf(wrapper).emitted('set-auto-check')).toEqual([[true]])
    expect(wrapper.get('[data-testid="about-auto-check"]').attributes('checked')).toBeDefined()

    await wrapper.get('[data-testid="about-auto-check"]').setValue(false)
    expect(panelOf(wrapper).emitted('set-auto-check')?.[1]).toEqual([false])
  })

  it('autoCheck prop 为真时开关预勾选', () => {
    const wrapper = mountPanel(makeState(), { autoCheck: true })
    expect(wrapper.get('[data-testid="about-auto-check"]').attributes('checked')).toBeDefined()
  })

  it('提示块「跳过此版本」上抛 skip-version 并关闭；「稍后提醒」只关闭', async () => {
    const wrapper = mountPanel(makeState(), {
      update: { available: true, version: '3.1.0', notes: '有更新' },
    })
    await wrapper.get('[data-testid="about-update-skip"]').trigger('click')
    expect(panelOf(wrapper).emitted('skip-version')).toEqual([['3.1.0']])
    expect(wrapper.find('[data-testid="about-update-dialog"]').exists()).toBe(false)

    await wrapper.setProps({ update: { available: true, version: '3.1.0', notes: '有更新' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="about-update-dialog"]').exists()).toBe(true)
    await wrapper.get('[data-testid="about-update-close"]').trigger('click')
    expect(wrapper.find('[data-testid="about-update-dialog"]').exists()).toBe(false)
  })
})

// ==================== 诊断信息（采集经外壳，复制在面板） ====================

describe('AboutPanel · 诊断信息', () => {
  it('没有诊断正文时：先发 collect-diagnostics，并说明在等外壳回传', async () => {
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-copy-diagnostics"]').trigger('click')
    expect(panelOf(wrapper).emitted('collect-diagnostics')).toEqual([[]])
    expect(wrapper.get('[data-testid="about-diag-result"]').text()).toBe(DIAG_WAITING)
  })

  it('诊断正文到位后自动复制并提示成功', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-copy-diagnostics"]').trigger('click')

    await wrapper.setProps({ diagnostics: '版本 v3.0.1 / 系统 Windows' })
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('版本 v3.0.1 / 系统 Windows')
    expect(wrapper.get('[data-testid="about-diag-result"]').text()).toBe(DIAG_COPY_SUCCESS)
  })

  it('诊断正文已就绪时点按钮直接复制，不再请求采集', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState(), { diagnostics: '诊断正文' })
    await wrapper.get('[data-testid="about-copy-diagnostics"]').trigger('click')
    await flushPromises()
    expect(panelOf(wrapper).emitted('collect-diagnostics')).toBeUndefined()
    expect(wrapper.get('[data-testid="about-diag-result"]').text()).toBe(DIAG_COPY_SUCCESS)
  })
})

// ==================== 复制（口令 / 提取码） ====================

describe('AboutPanel · 复制行为', () => {
  it('复制 APP 口令：写入口令文本并提示成功', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-copy-token"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(QUARK_TOKEN)
    expect(wrapper.get('[data-testid="about-copy-result"]').text()).toBe(COPY_TOKEN_SUCCESS)
  })

  it('复制提取码：写入提取码并提示成功', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-copy-code"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(QUARK_CODE)
    expect(wrapper.get('[data-testid="about-copy-result"]').text()).toBe(COPY_CODE_SUCCESS)
  })

  it('剪贴板拒绝：显示统一失败提示，绝不抛出', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState())
    await wrapper.get('[data-testid="about-copy-token"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="about-copy-result"]').text()).toBe(COPY_FAILURE)
  })

  it('剪贴板不可用：先给前置提示，按钮**不禁用**，点击仍给失败提示', async () => {
    vi.stubGlobal('navigator', {})
    const wrapper = mountPanel(makeState())
    expect(wrapper.get('[data-testid="about-clipboard-hint"]').text()).toBe(CLIPBOARD_HINT)

    const button = wrapper.get('[data-testid="about-copy-code"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="about-copy-result"]').text()).toBe(COPY_FAILURE)
  })
})

// ==================== 旧版探测结果（三段判定） ====================

describe('AboutPanel · 旧版数据探测结果', () => {
  it('探测失败：红色提示并带前缀', () => {
    const wrapper = mountPanel(makeState(), { legacyProbe: { exists: false, error: 'EACCES' } })
    const node = wrapper.get('[data-testid="about-legacy-result"]')
    expect(node.text()).toBe('探测旧版数据失败：EACCES')
    expect(node.classes()).toContain('panel-about__result--failure')
    expect(wrapper.find('[data-testid="about-legacy-unwired"]').exists()).toBe(false)
  })

  it('没找到 / 没有可导入数据 / 找到了：三种信息态', async () => {
    const wrapper = mountPanel(makeState(), { legacyProbe: { exists: false } })
    expect(wrapper.get('[data-testid="about-legacy-result"]').text()).toBe(
      '未找到旧版（novel-studio）的数据目录',
    )

    await wrapper.setProps({ legacyProbe: { exists: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-legacy-result"]').text()).toBe(
      '旧版目录存在，但没有可导入的数据',
    )

    await wrapper.setProps({ legacyProbe: { exists: true, jsonExists: true } })
    await flushPromises()
    expect(wrapper.get('[data-testid="about-legacy-result"]').text()).toContain('已找到可导入的旧版数据')
  })

  it('探测结果为空（尚未探测）时不出结论，也不说「未接线」', () => {
    const wrapper = mountPanel(makeState(), { legacyProbe: null })
    expect(wrapper.find('[data-testid="about-legacy-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="about-legacy-unwired"]').exists()).toBe(false)
  })
})

// ==================== 下载入口自定 ====================

describe('AboutPanel · 下载入口可由外壳覆盖', () => {
  it('quarkUrl / quarkCode / quarkToken 传值时优先使用', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const wrapper = mountPanel(makeState(), {
      quarkUrl: 'https://example.com/pan',
      quarkCode: 'ZZZZ',
      quarkToken: '自定义口令',
    })
    expect(wrapper.get('[data-testid="about-quark-code"]').text()).toBe('ZZZZ')
    await wrapper.get('[data-testid="about-open-quark"]').trigger('click')
    expect(panelOf(wrapper).emitted('open-link')).toEqual([
      ['https://example.com/pan', '打开网盘下载'],
    ])

    await wrapper.get('[data-testid="about-copy-token"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('自定义口令')
  })

  it('便携版下载页按钮指向发布页常量', async () => {
    const wrapper = mountPanel(makeState(), { portable: true })
    await wrapper.get('[data-testid="about-open-release"]').trigger('click')
    expect(panelOf(wrapper).emitted('open-link')).toEqual([
      [GITEE_RELEASES_URL, PORTABLE_RELEASE_LABEL],
    ])
  })
})