// @vitest-environment happy-dom
/// <reference path="../src/renderer/vue-shims.d.ts" />
/**
 * W8 外壳接线验收测试（App 级）。
 *
 * 这里测的**不是**四个功能屏自己的行为（那在 `tests/features/*.view.test.ts` 里各测过），
 * 而是 `App.vue` 把它们**接起来**之后才成立的那几条不变量：
 *
 * 1. `ports` 缺省时顶栏不出现外壳导航（15 个面板夹具 + app-view 夹具都靠这条不破）；
 * 2. 顶栏按钮能切到对应屏，且切屏用 `v-if`（列表是磁盘状态，留 DOM 会显示过期数据）；
 * 3. **写作页是 `v-show`**：切到设置再切回来，编辑器宿主 DOM 必须是**同一个节点**
 *    （卸载会丢 CodeMirror 实例，`adapter` 变量还指着旧 DOM）；
 * 4. 设置落到**根节点**：`documentElement` 上出现 `--yfe-*` 变量、`data-theme`、`--ui-zoom`；
 *    换主题时上一套的变量要被清掉（浅色主题不能残留深色 ink 刻度）；
 * 5. 侧栏宽度跟着设置走（`clampSidebarWidth` 到 [200,560]）；
 * 6. 设置面板 `emit('change')` 之后，**外壳自己的**字体/缩放也要跟着走（否则改了字号只有面板知道）；
 * 7. 首启判定：`welcome.seen()` 为假 → 进向导；为真 → 直接写作页；端口抛异常 → 也进写作页（不白屏）。
 *
 * 环境差异（happy-dom + VTU 2.5.1）：
 * - `get(...)` 没有 `.exists()`，缺失性用 `find(...).exists()`；
 * - `document.documentElement` 上的 CSS 变量用 `style.getPropertyValue('--x')` 读；
 * - `applyZoom` 写的是 `style.zoom`，happy-dom 对该属性的支持不稳定，故缩放只断言 `--ui-zoom`。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import App from '../src/renderer/App.vue'
import { clampSidebarWidth } from '../src/renderer/features/settings-store.js'
import type { AppSettingsView, FeaturePorts, ProjectHubSnapshot } from '../src/renderer/features/types.js'
import type { AppSnapshot, AppState } from '../src/renderer/app-state.js'
import SidebarResizer from '../src/renderer/schema/SidebarResizer.vue'

// 与 `app-view.test.ts` 同款：编辑器适配器要打桩，否则 happy-dom 里 CodeMirror 起不来。
const editor = vi.hoisted(() => ({
  documentId: null as string | null,
  body: '',
  isComposing: false,
  readOnly: false,
  open: vi.fn(),
  setReadOnly: vi.fn(),
  change: null as ((body: string) => void) | null,
}))

vi.mock('../src/renderer/editor/codemirror-adapter.js', () => ({
  createCodeMirrorAdapter: () => ({
    open: editor.open,
    getBody: () => editor.body,
    get isComposing() {
      return editor.isComposing
    },
    setReadOnly: editor.setReadOnly,
    registerCommand: () => () => {},
    onChange: (handler: (body: string) => void) => {
      editor.change = handler
      return () => {}
    },
    dispose: () => {},
  }),
}))

// ==================== 夹具 ====================

const BASE_SETTINGS: AppSettingsView = {
  themeId: 'eye-care',
  fontFamily: null,
  fontSize: '16px',
  zoomPercent: 100,
  zoomManual: false,
  sidebarWidth: 224,
  collapsedGroups: [],
}

function makeSnapshot(patch: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ready: true,
    loading: false,
    appVersion: 'test',
    databasePath: null,
    databaseSchemaVersion: 1,
    readOnly: false,
    pendingOutboxCount: 0,
    lastSavedAt: null,
    projectId: 'project_1',
    tree: [],
    documents: [],
    selectedDocumentId: 'doc_1',
    title: '第一章',
    body: '原始正文',
    charCount: 4,
    revision: 'r1',
    saveStatus: 'saved',
    saveDetail: null,
    conflict: null,
    lastError: null,
    expandedIds: [],
    settingsEntities: [],
    settingsLoading: false,
    selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
    ...patch,
  }
}

interface HarnessOptions {
  /** `welcome.seen()` 的返回值（缺省 false ⇒ 首启进向导）。 */
  readonly seen?: boolean
  /** `welcome.seen()` 是否抛异常（验证不白屏）。 */
  readonly seenThrows?: boolean
  /** `ports.settings.load()` 的初值。 */
  readonly settings?: Partial<AppSettingsView>
  /** `state.openProject()` 的返回值。 */
  readonly openProjectResult?: boolean
  /** 完全不传 ports（验证外壳导航消失）。 */
  readonly noPorts?: boolean
  /** 初始快照里有没有打开的作品（缺省 `'project_1'`）；传 `null` 模拟空态。 */
  readonly projectId?: string | null
}

function harness(options: HarnessOptions = {}) {
  editor.open.mockClear()
  editor.setReadOnly.mockClear()

  let notify: ((snapshot: AppSnapshot) => void) | null = null
  let snapshot = makeSnapshot(options.projectId === undefined ? {} : { projectId: options.projectId })

  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener: (snapshot: AppSnapshot) => void) => {
      notify = listener
      return () => {
        notify = null
      }
    },
    start: async () => true,
    refresh: async () => true,
    createProject: async () => true,
    openProject: async () => options.openProjectResult ?? true,
    createChapter: async () => true,
    selectDocument: async () => true,
    edit: () => {},
    flush: async () => true,
    applyExternalUpdate: async () => true,
    retrySave: async () => true,
    resolveConflict: async () => true,
    toggleExpanded: () => {},
    loadSettingsEntities: async () => true,
    selectSettingsEntity: async () => true,
    refreshSettingsEntity: async () => true,
    submitSettingsEntity: async () => true,
    setNavigationGuard: () => {},
    dispose: () => {},
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: () => {},
      saveConfig: () => {},
      complete: async () => ({ ok: false, error: { code: 'AI_NOT_CONFIGURED', message: '未配置' } }),
    },
  } as unknown as AppState

  // ---- 端口桩：只记录调用，返回可控结果 ----
  let settingsView: AppSettingsView = { ...BASE_SETTINGS, ...options.settings }
  const settingsSaves: Partial<AppSettingsView>[] = []
  const hubSnapshot: ProjectHubSnapshot = {
    projects: [],
    loading: false,
    lastError: null,
    currentProjectId: 'project_1',
  }
  const markSeen = vi.fn()
  const createDemoProject = vi.fn(async () => ({ ok: true as const, value: { projectId: 'demo_1' } }))

  const ports = {
    hub: {
      list: async () => ({ ok: true as const, value: [] }),
      create: async () => ({ ok: true as const, value: { projectId: 'p_new' } }),
      rename: async () => ({ ok: true as const, value: { projectId: 'p_new' } }),
      remove: async () => ({ ok: true as const, value: { projectId: 'p_new' } }),
      open: async () => ({ ok: true as const, value: { projectId: 'p_new' } }),
      close: async () => ({ ok: true as const, value: { projectId: null } }),
      getSnapshot: () => hubSnapshot,
      subscribe: () => () => {},
      refresh: async () => ({ ok: true as const, value: [] }),
      dispose: () => {},
    },
    backup: {
      list: async () => ({ ok: true as const, value: [] }),
      create: async () => ({
        ok: false as const,
        code: 'STORAGE_UNAVAILABLE',
        message: '存储不可用',
      }),
      verify: async () => ({ ok: false as const, code: 'NOT_FOUND_SNAPSHOT', message: '找不到快照' }),
      restore: async () => ({ ok: false as const, code: 'NOT_FOUND_SNAPSHOT', message: '找不到快照' }),
    },
    settings: {
      load: () => settingsView,
      save: (patch: Partial<AppSettingsView>) => {
        settingsSaves.push(patch)
        const merged = { ...settingsView, ...patch }
        // 真实端口 `saveAppSettings` 会先把侧栏宽度钳进 [200,560] 再返回持久化后的视图；
        // 夹具照做，才能验证外壳用的是"端口返回的值"而不是它自己 emit 的原始值。
        settingsView = { ...merged, sidebarWidth: clampSidebarWidth(merged.sidebarWidth) }
        return settingsView
      },
      reset: () => {
        settingsView = { ...BASE_SETTINGS }
        return settingsView
      },
    },
    welcome: {
      seen: () => {
        if (options.seenThrows === true) throw new Error('localStorage 不可用')
        return options.seen ?? false
      },
      markSeen,
      createDemoProject,
    },
  } as unknown as FeaturePorts

  const wrapper = mount(App, {
    props: options.noPorts === true ? { state } : { state, ports },
  })

  return {
    wrapper,
    state,
    ports,
    settingsSaves,
    markSeen,
    async publish(patch: Partial<AppSnapshot>) {
      snapshot = { ...snapshot, ...patch }
      notify?.(snapshot)
      await nextTick()
    },
  }
}

// 动态 import 会与 `vi.mock` 的 hoisting 打架，故 `App` 在模块顶层静态引入（见上方 import）。

/** 顶栏里的外壳导航按钮（用 `data-testid` 不行，YfeButton 不透传；改用精确文案 + 限定在 header 内）。 */
function navButton(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper
    .findAll('header button')
    .find((node) => node.text().trim() === label)
}

async function clickNav(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const button = navButton(wrapper, label)
  if (button === undefined) throw new Error(`顶栏里没有「${label}」按钮`)
  await button.trigger('click')
  await flushPromises()
  await nextTick()
}

// ==================== 用例 ====================

describe('App 外壳：ports 缺省时不出现', () => {
  it('不传 ports 时顶栏没有外壳导航，也不渲染任何功能屏', async () => {
    const h = harness({ noPorts: true })
    await flushPromises()

    expect(navButton(h.wrapper, '作品中心')).toBeUndefined()
    expect(navButton(h.wrapper, '设置')).toBeUndefined()
    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(false)
    expect(h.wrapper.find('.app__screen').exists()).toBe(false)

    h.wrapper.unmount()
  })

  it('不传 ports 时不会去读设置（根节点保持干净）', async () => {
    document.documentElement.removeAttribute('data-theme')
    const h = harness({ noPorts: true })
    await flushPromises()

    expect(document.documentElement.getAttribute('data-theme')).toBeNull()

    h.wrapper.unmount()
  })
})

describe('App 外壳：导航', () => {
  it('点「作品中心」切到 hub 屏，点「返回写作」回写作页', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    await clickNav(h.wrapper, '作品中心')
    expect(h.wrapper.find('[data-testid="project-hub"]').exists()).toBe(true)

    await clickNav(h.wrapper, '返回写作')
    expect(h.wrapper.find('[data-testid="project-hub"]').exists()).toBe(false)

    h.wrapper.unmount()
  })

  it('点「备份与恢复」切到备份屏，点「设置」切到设置屏', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    await clickNav(h.wrapper, '备份与恢复')
    expect(h.wrapper.find('[data-testid="backup-manager"]').exists()).toBe(true)

    await clickNav(h.wrapper, '设置')
    expect(h.wrapper.find('[data-testid="settings-panel"]').exists()).toBe(true)
    expect(h.wrapper.find('[data-testid="backup-manager"]').exists()).toBe(false)

    h.wrapper.unmount()
  })

  it('切到功能屏时写作页被 v-show 藏起来，但编辑器宿主节点仍是同一个', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    const before = h.wrapper.find('.app__editor').element
    const bodyBefore = h.wrapper.find('.app__body').element

    await clickNav(h.wrapper, '设置')

    // v-show：节点还在 DOM 里（只是 display:none），实例没被销毁。
    // 藏起来的是写作页外壳 `.app__body`；`.app__editor` 自己的 v-show 绑的是「当前页签是不是编辑器」。
    const after = h.wrapper.find('.app__editor')
    expect(after.exists()).toBe(true)
    expect(after.element).toBe(before)
    expect(h.wrapper.find('.app__body').element).toBe(bodyBefore)
    expect(h.wrapper.find('.app__body').attributes('style')).toContain('display: none')

    h.wrapper.unmount()
  })
})

describe('App 外壳：设置落到根节点', () => {
  it('挂载后根节点上有主题变量、data-theme 与 --ui-zoom', async () => {
    const h = harness({ seen: true, settings: { themeId: 'sepia', zoomPercent: 120 } })
    await flushPromises()

    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('sepia')
    expect(root.style.getPropertyValue('--yfe-color-background')).not.toBe('')
    expect(root.style.getPropertyValue('--yfe-color-text')).not.toBe('')
    expect(root.style.getPropertyValue('--ui-zoom')).not.toBe('')

    h.wrapper.unmount()
  })

  it('旧别名也被写到根节点（本文件 126 行 scoped 样式仍在用旧名）', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    const root = document.documentElement
    expect(root.style.getPropertyValue('--yfe-color-bg')).not.toBe('')
    expect(root.style.getPropertyValue('--yfe-font-ui')).not.toBe('')
    expect(root.style.getPropertyValue('--yfe-color-text-dim')).not.toBe('')

    h.wrapper.unmount()
  })

  it('切换主题后上一套主题的 ink 刻度被清掉，不残留', async () => {
    const h = harness({ seen: true, settings: { themeId: 'dark' } })
    await flushPromises()

    const root = document.documentElement
    // 深色主题的 ink 刻度与浅色不同；换肤必须清掉旧键（否则浅色主题读出深色描边）。
    const darkBackground = root.style.getPropertyValue('--yfe-color-background')

    await clickNav(h.wrapper, '设置')
    // 主题选项是 `<button>`（settings-panel.vue:171），不是单选 input。
    const option = h.wrapper.find('[data-testid="theme-option-eye-care"]')
    expect(option.exists()).toBe(true)
    await option.trigger('click')
    await flushPromises()
    await nextTick()

    expect(root.getAttribute('data-theme')).toBe('eye-care')
    expect(root.style.getPropertyValue('--yfe-color-background')).not.toBe(darkBackground)

    h.wrapper.unmount()
  })

  it('侧栏宽度跟着设置走', async () => {
    const h = harness({ seen: true, settings: { sidebarWidth: 300 } })
    await flushPromises()

    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 300px')

    h.wrapper.unmount()
  })

  it('设置里的超界侧栏宽度被收敛到 [200,560]', async () => {
    const h = harness({ seen: true, settings: { sidebarWidth: 9999 } })
    await flushPromises()

    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 560px')

    h.wrapper.unmount()
  })

  it('设置面板改动后，外壳自己的编辑器字体也跟着变（不只面板知道）', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    await clickNav(h.wrapper, '设置')
    // `data-testid` 直接挂在 `<select>` 上（settings-panel.vue:242），不是外层容器。
    const fontSelect = h.wrapper.find('select[data-testid="font-family"]')
    expect(fontSelect.exists()).toBe(true)
    // 放开字体：选中第一个具体字体选项（不是「跟随默认」）。
    const options = fontSelect.findAll('option')
    const concrete = options.find((node) => (node.element as HTMLOptionElement).value !== '')
    expect(concrete).toBeDefined()
    await fontSelect.setValue((concrete?.element as HTMLOptionElement).value)
    await flushPromises()
    await nextTick()

    // 面板 save() 的返回值经 emit('change') 回流到外壳 ⇒ 编辑器容器带上 fontFamily。
    const editorStyle = h.wrapper.find('.app__editor').attributes('style') ?? ''
    expect(editorStyle).toContain('font-family')

    h.wrapper.unmount()
  })
})

describe('App 外壳：首启判定', () => {
  it('welcome.seen() 为假时进向导屏', async () => {
    const h = harness({ seen: false })
    await flushPromises()

    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(true)

    h.wrapper.unmount()
  })

  it('welcome.seen() 为真时直接进写作页', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(false)
    expect(h.wrapper.find('.app__body').exists()).toBe(true)

    h.wrapper.unmount()
  })

  it('welcome.seen() 抛异常时不白屏，退回写作页', async () => {
    const h = harness({ seenThrows: true })
    await flushPromises()

    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(false)
    expect(h.wrapper.find('.app__body').exists()).toBe(true)

    h.wrapper.unmount()
  })

  it('向导里点「新建作品」后离开向导屏，回到写作页', async () => {
    const h = harness({ seen: false })
    await flushPromises()
    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(true)

    await h.wrapper.find('[data-testid="welcome-choice-new"]').trigger('click')
    await flushPromises()
    await nextTick()

    // 端子只带回 `projectId`（没有「走的是哪条路」），外壳无法区分 ① 与 ③，
    // 故与上游 WelcomeWizard.finish(null) 同款：回写作页，由用户在空态里新建。
    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(false)
    expect(h.wrapper.find('.app__body').exists()).toBe(true)

    h.wrapper.unmount()
  })

  it('向导确认创建示范项目后打开带回的 projectId 并记下「不再显示」', async () => {
    const h = harness({ seen: false })
    await flushPromises()

    await h.wrapper.find('[data-testid="welcome-choice-demo"]').trigger('click')
    await nextTick()
    expect(h.wrapper.find('[data-testid="welcome-demo-dialog"]').exists()).toBe(true)

    // YfeDialog 的第一个按钮是「取消」，确认是 `[data-role="confirm"]`（YfeDialog.vue:138）。
    const confirm = h.wrapper.find('[data-testid="welcome-demo-dialog"] [data-role="confirm"]')
    expect(confirm.exists()).toBe(true)
    await confirm.trigger('click')
    await flushPromises()
    await nextTick()

    // 成功路径必须 markSeen（失败路径刻意不记，见 welcome-wizard.vue:139-141）。
    expect(h.markSeen).toHaveBeenCalledTimes(1)
    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(false)

    h.wrapper.unmount()
  })

  it('示范项目创建失败时不记「不再显示」，用户还能重试', async () => {
    const h = harness({ seen: false })
    // 端口桩默认成功；这里改造成失败。
    ;(h.ports.welcome as { createDemoProject: unknown }).createDemoProject = async () => ({
      ok: false as const,
      code: 'NOT_IMPLEMENTED',
      message: '示范项目数据还没接入预览版',
    })
    await flushPromises()

    await h.wrapper.find('[data-testid="welcome-choice-demo"]').trigger('click')
    await nextTick()
    const confirm = h.wrapper.find('[data-testid="welcome-demo-dialog"] [data-role="confirm"]')
    await confirm.trigger('click')
    await flushPromises()
    await nextTick()

    expect(h.markSeen).not.toHaveBeenCalled()
    expect(h.wrapper.find('[data-testid="welcome-wizard"]').exists()).toBe(true)
    expect(h.wrapper.find('[data-testid="welcome-demo-error"]').exists()).toBe(true)

    h.wrapper.unmount()
  })
})

/* ------------------------------------------------------------------ *
 * R-81：自动缩放必须跟随窗口
 *
 * 这三条是回归护栏：`syncAutoZoom()` 存在之前，`--ui-zoom` 只在
 * `load()`/`save()` 两个时刻被写一次，拖大窗口后界面停在旧缩放上
 * —— 设置面板写着「自动（跟随窗口）」而实际不跟随。
 *
 * 断言只读 `--ui-zoom`（`style.zoom` 在 happy-dom 上支持不稳定，见文件头）。
 * ------------------------------------------------------------------ */

/** happy-dom 的 `innerWidth` 可在实例上覆盖。 */
function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true })
}

async function fireResize(width: number): Promise<void> {
  setWindowWidth(width)
  window.dispatchEvent(new Event('resize'))
  await nextTick()
  await nextTick()
}

describe('App 外壳：自动缩放跟随窗口（R-81）', () => {
  it('自动模式下窗口变宽，--ui-zoom 跟着变大（1280=100%，每 40px +1%）', async () => {
    const h = harness({ seen: true, settings: { zoomPercent: 100, zoomManual: false } })
    await flushPromises()
    const root = document.documentElement

    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1')

    // 2000 → round(100 + (2000-1280)/40) = 118
    await fireResize(2000)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.18')

    // 1680 → round(100 + 10) = 110
    await fireResize(1680)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.1')

    h.wrapper.unmount()
  })

  it('窄屏不缩小到 100% 以下（autoZoomForWidth 的下限）', async () => {
    const h = harness({ seen: true, settings: { zoomPercent: 118, zoomManual: false } })
    await flushPromises()
    const root = document.documentElement

    // 拉动中先记下宽屏值，再压窄：800 → round(88) → max(100,…) = 100
    await fireResize(2000)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.18')
    await fireResize(800)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1')

    h.wrapper.unmount()
  })

  it('手动模式下 resize 绝不改动缩放', async () => {
    const h = harness({ seen: true, settings: { zoomPercent: 130, zoomManual: true } })
    await flushPromises()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.3')

    await fireResize(2400)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.3')

    h.wrapper.unmount()
  })

  it('卸载后 resize 不再生效（监听已移除）', async () => {
    const h = harness({ seen: true, settings: { zoomPercent: 100, zoomManual: false } })
    await flushPromises()
    const root = document.documentElement

    await fireResize(2000)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.18')

    h.wrapper.unmount()
    // 卸载后 `settings` 已随组件销毁，但仍残留同一个 DOM 根：值不许再动。
    await fireResize(1200)
    expect(root.style.getPropertyValue('--ui-zoom')).toBe('1.18')
  })
})

// ==================== A-09 / A-10：侧栏折叠与宽度手柄的接线 ====================

/** 从 DOM 里取第一个组头，返回它的组 key（不写死组名：组表来自 `@yfe/schema-tabs`）。 */
function firstGroup(wrapper: ReturnType<typeof mount>): string {
  const node = wrapper.findAll('[data-testid^="sidebar-group-toggle-"]')[0]
  if (node === undefined) throw new Error('侧栏里没有组头按钮')
  return (node.attributes('data-testid') ?? '').replace('sidebar-group-toggle-', '')
}

describe('App 外壳：侧栏分组折叠接线（A-09）', () => {
  it('点组头：该组正文不渲染，并把「已折叠集合」整份写回设置', async () => {
    const h = harness({ seen: true })
    await flushPromises()

    const group = firstGroup(h.wrapper)
    const body = `[data-testid="sidebar-group-body-${group}"]`
    const toggle = `[data-testid="sidebar-group-toggle-${group}"]`
    expect(h.wrapper.find(body).exists()).toBe(true)
    expect(h.wrapper.find(toggle).attributes('aria-expanded')).toBe('true')

    await h.wrapper.find(toggle).trigger('click')
    await flushPromises()

    // 折叠＝整组不渲染（不是 display:none），组头仍在——与上游 Sidebar.tsx:212-213 一致。
    expect(h.wrapper.find(body).exists()).toBe(false)
    expect(h.wrapper.find(toggle).exists()).toBe(true)
    // 组件自己不记状态：唯一的副作用是经设置端口整份写回。
    expect(h.settingsSaves.at(-1)).toEqual({ collapsedGroups: [group] })

    h.wrapper.unmount()
  })

  it('设置里已折叠的组：首次渲染就不展开（设置是唯一真相源）', async () => {
    const probe = harness({ seen: true })
    await flushPromises()
    const group = firstGroup(probe.wrapper)
    probe.wrapper.unmount()

    const h = harness({ seen: true, settings: { collapsedGroups: [group] } })
    await flushPromises()
    expect(h.wrapper.find(`[data-testid="sidebar-group-body-${group}"]`).exists()).toBe(false)
    expect(h.wrapper.find(`[data-testid="sidebar-group-toggle-${group}"]`).attributes('aria-expanded')).toBe('false')

    h.wrapper.unmount()
  })
})

describe('App 外壳：侧栏宽度手柄接线（A-10）', () => {
  it('手柄宽度跟着设置走；拖拽/双击只写设置，界面宽度等于端口返回的持久化值', async () => {
    const h = harness({ seen: true, settings: { sidebarWidth: 260 } })
    await flushPromises()

    const handle = h.wrapper.findComponent(SidebarResizer)
    expect(handle.exists()).toBe(true)
    expect(handle.props('width')).toBe(260)
    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 260px')

    handle.vm.$emit('resize', 300)
    await flushPromises()
    expect(h.settingsSaves.at(-1)).toEqual({ sidebarWidth: 300 })
    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 300px')

    // 超上限：外壳**不自行钳制**，而是照端口返回的视图显示（9999 → 560），
    // 这样"看到的宽度"永远等于"存下去的宽度"，不会静默不一致。
    handle.vm.$emit('resize', 9999)
    await flushPromises()
    expect(h.settingsSaves.at(-1)).toEqual({ sidebarWidth: 9999 })
    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 560px')

    // 双击复位：同一个 handler，走同样的落库路径。
    handle.vm.$emit('reset', 224)
    await flushPromises()
    expect(h.settingsSaves.at(-1)).toEqual({ sidebarWidth: 224 })
    expect(h.wrapper.find('.app__side').attributes('style')).toContain('width: 224px')

    h.wrapper.unmount()
  })

  it('不传 ports 时手柄存在但被禁用（不会把缺省宽度写进磁盘）', async () => {
    const h = harness({ noPorts: true })
    await flushPromises()

    const handle = h.wrapper.findComponent(SidebarResizer)
    expect(handle.exists()).toBe(true)
    expect(handle.props('disabled')).toBe(true)

    h.wrapper.unmount()
  })
})
