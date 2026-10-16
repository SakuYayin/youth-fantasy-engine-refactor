// @vitest-environment happy-dom
/// <reference path="../src/renderer/vue-shims.d.ts" />
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, AppState } from '../src/renderer/app-state.js'
import App from '../src/renderer/App.vue'

const editor = vi.hoisted(() => ({
  body: '', documentId: null as string | null, isComposing: false, readOnly: false,
  open: vi.fn(), setReadOnly: vi.fn(),
  change: null as ((body: string) => void) | null,
}))
vi.mock('../src/renderer/editor/codemirror-adapter.js', () => ({
  createCodeMirrorAdapter: () => ({
    open: (target: { body: string; documentId: string; readOnly: boolean }) => {
      editor.open(target); editor.body = target.body; editor.documentId = target.documentId; editor.readOnly = target.readOnly
    },
    getBody: () => editor.body,
    get isComposing() { return editor.isComposing },
    setReadOnly: (value: boolean) => { editor.setReadOnly(value); editor.readOnly = value },
    registerCommand: () => () => {},
    onChange: (handler: (body: string) => void) => { editor.change = handler; return () => {} },
    dispose: () => {},
  }),
}))

function harness() {
  editor.open.mockClear(); editor.setReadOnly.mockClear(); editor.isComposing = false
  let snapshot: AppSnapshot = {
    ready: true, loading: false, appVersion: 'test', databasePath: null, databaseSchemaVersion: 1,
    readOnly: false, pendingOutboxCount: 0, lastSavedAt: null, projectId: 'project_1', tree: [],
    // 作品中心的列表来自快照的 documents（章节树之外的平铺摘要）；本文件只测编辑器接线，
    // 给空数组即可，避免把「作品列表」的渲染断言混进来。
    documents: [],
    selectedDocumentId: 'doc_1', title: '第一章', body: '原始正文', charCount: 4, revision: 'r1',
    saveStatus: 'saved', saveDetail: null, conflict: null, lastError: null, expandedIds: [],
    settingsEntities: [], settingsLoading: false, selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
  let notify: ((snapshot: AppSnapshot) => void) | undefined
  let guard: (() => boolean) | null = null
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { notify = listener; return () => {} },
    start: async () => {}, refresh: async () => {}, createProject: async () => true,
    openProject: async () => true,
    createChapter: async () => true, selectDocument: async () => true,
    edit: vi.fn(), flush: async () => true, applyExternalUpdate: () => true,
    retrySave: () => {}, resolveConflict: () => {}, toggleExpanded: () => {},
    loadSettingsEntities: async () => true, selectSettingsEntity: async () => true,
    refreshSettingsEntity: async () => true,
    submitSettingsEntity: async () => ({ ok: false, code: 'NOT_IMPLEMENTED', message: '测试桩' }),
    setNavigationGuard: (value) => { guard = value }, dispose: () => {},
    // 面板经 `state.ai` 拿配置并发请求；App.vue 本身不直接驱动 AI，故桩只满足形状。
    ai: {
      getConfig: () => null,
      configured: () => false,
      reload: async () => false,
      saveConfig: async () => false,
      complete: async () => ({ ok: false as const, code: 'AI_NOT_CONFIGURED' as const, message: '测试桩' }),
    },
  }
  const wrapper = mount(App, { props: { state } })
  return { wrapper, state, canNavigate: () => guard?.(),
    async publish(patch: Partial<AppSnapshot>) { snapshot = { ...snapshot, ...patch }; notify?.(snapshot); await nextTick() } }
}

describe('写作界面与编辑器接线', () => {
  it('本地键入和保存回执不重建编辑器，同章外部更新会实际显示', async () => {
    const h = harness()
    await nextTick()
    editor.open.mockClear()
    editor.body = '用户正在输入'
    editor.change?.(editor.body)
    expect(h.state.edit).toHaveBeenCalledWith('用户正在输入')
    await h.publish({ body: editor.body, saveStatus: 'dirty' })
    await h.publish({ revision: 'r2', saveStatus: 'saved' })
    expect(editor.open).not.toHaveBeenCalled()
    await h.publish({ body: '远端的新正文', revision: 'r3' })
    expect(editor.body).toBe('远端的新正文')
    expect(editor.open).toHaveBeenCalledTimes(1)
    h.wrapper.unmount()
  })
  it('导航锁只切换可编辑性，组合态禁止切章', async () => {
    const h = harness()
    await nextTick()
    editor.open.mockClear()
    editor.isComposing = true
    expect(h.canNavigate()).toBe(false)
    editor.isComposing = false
    expect(h.canNavigate()).toBe(true)
    await h.publish({ loading: true })
    expect(editor.readOnly).toBe(true)
    expect(editor.open).not.toHaveBeenCalled()
    await h.publish({ loading: false })
    expect(editor.readOnly).toBe(false)
    h.wrapper.unmount()
  })
})
