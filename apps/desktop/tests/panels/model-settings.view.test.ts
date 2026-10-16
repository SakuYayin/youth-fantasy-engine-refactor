// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 模型设置面板（model-settings.vue）的视图测试：挂载加载 / 状态区脱敏 /
 * 保存三路径（成功、校验失败、未作品引导）/ 重载按钮 / 文案契约。
 *
 * AiPort 与 AppState 桩为结构桩（ai-port.ts / app-state.ts 的契约逐一对齐）；
 * 表单装配/校验编排在 model-settings-model.ts 纯函数里，另见 model-settings.test.ts。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { getTab } from '@yfe/schema-tabs'

import type { AppSnapshot, AppState } from '../../src/renderer/app-state.js'
import type { AiModelConfig, AiPort, AiResult } from '../../src/renderer/ai/types.js'
import { MODEL_SETTINGS_PANEL_TEXT } from '../../src/renderer/panels/model-settings-model.js'
import ModelSettings from '../../src/renderer/panels/model-settings.vue'

const modelSettingsTab = getTab('model-settings')
if (modelSettingsTab === undefined) throw new Error('页签 model-settings 未注册（@yfe/schema-tabs）')

const TEXT = MODEL_SETTINGS_PANEL_TEXT

/** 已配置好的配置夹具（含明文 Key——只在模型层流转，视图测试断言它绝不回显）。 */
function configFixture(): AiModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-secret-key',
    temperature: 0.7,
    maxTokens: 2048,
    timeoutMs: 180000,
  }
}

/** 完整 AppSnapshot 夹具（与 app-view.test.ts 的 harness 同一口径）。 */
function snapshotWith(projectId: string | null): AppSnapshot {
  return {
    ready: true, loading: false, appVersion: 'test', databasePath: null, databaseSchemaVersion: 1,
    readOnly: false, pendingOutboxCount: 0, lastSavedAt: null, projectId, tree: [], documents: [],
    selectedDocumentId: null, title: '', body: '', charCount: 0, revision: null,
    saveStatus: 'saved', saveDetail: null, conflict: null, lastError: null, expandedIds: [],
    settingsEntities: [], settingsLoading: false, selectedSettingsEntityId: null,
    selectedSettingsEntity: null,
  }
}

interface HarnessOptions {
  /** getConfig 的返回（未配置传 null）；缺省 = 已配置的夹具。 */
  config?: AiModelConfig | null
  configured?: boolean
  /** saveConfig 的返回；缺省 true。桩镜像 ai-port 的真实行为：无作品时直接 false。 */
  saveOk?: boolean
  /** 快照里的当前作品；缺省 'project_1'（null = 尚无作品）。 */
  projectId?: string | null
  /** createProject 的返回；缺省 true（成功后桩会更新快照的 projectId）。 */
  createProjectOk?: boolean
}

function harness(options: HarnessOptions = {}) {
  const config = options.config === undefined ? configFixture() : options.config
  const configured = options.configured ?? config !== null
  let snapshot = snapshotWith(options.projectId === undefined ? 'project_1' : options.projectId)
  // 桩内记录「当前作品」：createProject 成功后更新（与 app-state 的行为一致）。
  let currentProjectId = snapshot.projectId
  const reload = vi.fn(async () => true)
  const saveConfig = vi.fn(
    async (_next: AiModelConfig) => currentProjectId !== null && (options.saveOk ?? true),
  )
  const createProject = vi.fn(async (_name: string) => {
    if (options.createProjectOk === false) return false
    currentProjectId = 'project_new'
    snapshot = { ...snapshot, projectId: currentProjectId }
    return true
  })
  const ai: AiPort = {
    getConfig: vi.fn(() => config),
    configured: vi.fn(() => configured),
    reload,
    saveConfig,
    complete: vi.fn(async (): Promise<AiResult> => ({
      ok: false,
      code: 'AI_NOT_CONFIGURED',
      message: '测试桩',
    })),
  }
  const state: AppState = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    start: async () => {}, refresh: async () => {}, createProject,
    openProject: async () => true,
    createChapter: async () => true, selectDocument: async () => true,
    edit: () => {}, flush: async () => true, applyExternalUpdate: () => true,
    retrySave: () => {}, resolveConflict: () => {}, toggleExpanded: () => {},
    loadSettingsEntities: async () => true,
    selectSettingsEntity: async () => true, refreshSettingsEntity: async () => true,
    submitSettingsEntity: async () => ({ ok: false, code: 'NOT_IMPLEMENTED', message: '测试桩' }),
    setNavigationGuard: () => {}, dispose: () => {},
    ai,
  }
  const wrapper = mount(ModelSettings, { props: { state, tab: modelSettingsTab } })
  return { wrapper, ai, reload, saveConfig, createProject }
}

function input(wrapper: ReturnType<typeof harness>['wrapper'], testId: string): HTMLInputElement {
  return wrapper.get(`[data-testid="${testId}"]`).element as HTMLInputElement
}

describe('model-settings 面板：挂载与加载', () => {
  it('挂载即 await ai.reload()，getConfig 灌进表单（apiKey 不回显明文）', async () => {
    const { wrapper, reload } = harness()
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(input(wrapper, 'model-settings-base-url').value).toBe('https://api.example.com/v1')
    expect(input(wrapper, 'model-settings-model').value).toBe('deepseek-chat')
    expect(input(wrapper, 'model-settings-api-key').value).toBe('')
    expect(input(wrapper, 'model-settings-temperature').value).toBe('0.7')
    expect(input(wrapper, 'model-settings-max-tokens').value).toBe('2048')
    expect(input(wrapper, 'model-settings-timeout-ms').value).toBe('180000')
    // 明文 Key 绝不进 DOM。
    expect(wrapper.text()).not.toContain('sk-secret-key')
  })

  it('未配置（getConfig 为 null）→ DEFAULT_AI_MODEL_CONFIG 起底 + 未配置状态 + 无摘要', async () => {
    const { wrapper } = harness({ config: null })
    await flushPromises()
    expect(input(wrapper, 'model-settings-base-url').value).toBe('')
    expect(input(wrapper, 'model-settings-model').value).toBe('')
    expect(input(wrapper, 'model-settings-temperature').value).toBe('0.7')
    expect(wrapper.get('[data-testid="model-settings-status-text"]').text()).toBe(TEXT.statusNotConfigured)
    expect(wrapper.find('[data-testid="model-settings-summary"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="model-settings-api-key"]').attributes('placeholder')).toBe(
      TEXT.fieldApiKeyPlaceholderEmpty,
    )
  })

  it('apiKey 输入框是 password 型且占位按「是否已配置」切换', async () => {
    const { wrapper } = harness()
    await flushPromises()
    const key = wrapper.get('[data-testid="model-settings-api-key"]')
    expect(key.attributes('type')).toBe('password')
    expect(key.attributes('placeholder')).toBe(TEXT.fieldApiKeyPlaceholderConfigured)
  })
})

describe('model-settings 面板：状态区与脱敏', () => {
  it('已配置 → 绿点 + 已配置 + redact 后的非敏感字段摘要', async () => {
    const { wrapper } = harness()
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-status-text"]').text()).toBe(TEXT.statusConfigured)
    expect(wrapper.get('[data-testid="model-settings-status-dot"]').attributes('class')).toContain(
      'model-settings__dot--ok',
    )
    const items = wrapper.findAll('.model-settings__summary-item').map((item) => item.text().trim())
    expect(items).toEqual([
      '接口地址：https://api.example.com/v1',
      '模型名：deepseek-chat',
      'API Key：已配置',
      'temperature：0.7',
      'maxTokens：2048',
      '超时时间（毫秒）：180000',
    ])
    expect(wrapper.text()).not.toContain('sk-secret-key')
  })

  it('未配置 → 灰点 + 未配置状态', async () => {
    const { wrapper } = harness({ config: null })
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-status-dot"]').attributes('class')).toContain(
      'model-settings__dot--off',
    )
  })
})

describe('model-settings 面板：保存成功路径', () => {
  it('合法表单 → saveConfig 收到归一化配置 + 成功文案 + 保存后重读配置', async () => {
    const { wrapper, saveConfig, reload } = harness()
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-base-url"]').setValue('https://new.example.com/v1')
    await wrapper.get('[data-testid="model-settings-model"]').setValue('new-model')
    await wrapper.get('[data-testid="model-settings-api-key"]').setValue('  sk-typed  ')
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        baseUrl: 'https://new.example.com/v1',
        model: 'new-model',
        apiKey: 'sk-typed',
        temperature: 0.7,
        maxTokens: 2048,
        timeoutMs: 180000,
      }),
    )
    expect(wrapper.get('[data-testid="model-settings-save-message"]').text()).toBe(TEXT.saveOk)
    // 保存成功后重读配置（挂载 + 保存后 = 2 次），输入框回到空 + 明文不回显。
    expect(reload).toHaveBeenCalledTimes(2)
    expect(input(wrapper, 'model-settings-api-key').value).toBe('')
  })
})

describe('model-settings 面板：保存校验失败路径', () => {
  it('校验失败显示中文错误、不发保存', async () => {
    const { wrapper, saveConfig } = harness()
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-base-url"]').setValue('ftp://bad')
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-validation-error"]').text()).toBe(
      '接口地址必须以 http(s):// 开头',
    )
    expect(saveConfig).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="model-settings-save-message"]').exists()).toBe(false)
  })

  it('apiKey 全空且未配置过 → 校验报「API Key 不能为空」', async () => {
    const { wrapper, saveConfig } = harness({ config: null })
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-base-url"]').setValue('https://api.example.com/v1')
    await wrapper.get('[data-testid="model-settings-model"]').setValue('deepseek-chat')
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-validation-error"]').text()).toBe('API Key 不能为空')
    expect(saveConfig).not.toHaveBeenCalled()
  })
})

describe('model-settings 面板：未作品引导', () => {
  it('保存失败且无作品 → 显式引导文案 + 新建作品后自动重跑保存', async () => {
    // 桩镜像 ai-port 的真实行为：saveConfig 在没有当前作品时直接 false（saveOk 不用传）。
    const { wrapper, saveConfig, createProject } = harness({ projectId: null })
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-need-project"]').text()).toBe(
      '请先在左侧新建作品再保存配置（模型配置按作品保存）',
    )
    expect(saveConfig).toHaveBeenCalledTimes(1)
    // 引导块：填作品名 → 一键「新建作品并保存」。
    await wrapper.get('[data-testid="model-settings-project-name"]').setValue('我的新书')
    await wrapper.get('[data-testid="model-settings-create-and-save"]').trigger('click')
    await flushPromises()
    expect(createProject).toHaveBeenCalledWith('我的新书')
    expect(saveConfig).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="model-settings-save-message"]').text()).toBe(TEXT.saveOk)
    expect(wrapper.find('[data-testid="model-settings-project-guide"]').exists()).toBe(false)
  })

  it('新建作品失败 → 显示新建失败文案，不重跑保存', async () => {
    const { wrapper, saveConfig, createProject } = harness({
      projectId: null,
      saveOk: false,
      createProjectOk: false,
    })
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-project-name"]').setValue('我的新书')
    await wrapper.get('[data-testid="model-settings-create-and-save"]').trigger('click')
    await flushPromises()
    expect(createProject).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="model-settings-save-message"]').text()).toBe(TEXT.createProjectFailed)
    expect(saveConfig).toHaveBeenCalledTimes(1)
  })

  it('保存失败但有当前作品 → 显示「保存失败，请重试」，不出引导块', async () => {
    const { wrapper, saveConfig } = harness({ projectId: 'project_1', saveOk: false })
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="model-settings-save-message"]').text()).toBe(TEXT.saveFailed)
    expect(wrapper.find('[data-testid="model-settings-project-guide"]').exists()).toBe(false)
  })
})

describe('model-settings 面板：重载按钮', () => {
  it('重载按钮再跑一次 reload + 灌表单（丢弃未保存的改动）', async () => {
    const { wrapper, reload } = harness()
    await flushPromises()
    await wrapper.get('[data-testid="model-settings-base-url"]').setValue('https://changed.example.com/v1')
    await wrapper.get('[data-testid="model-settings-reload"]').trigger('click')
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(input(wrapper, 'model-settings-base-url').value).toBe('https://api.example.com/v1')
  })
})

describe('model-settings 面板：文案与契约', () => {
  it('面板根节点带 data-testid 与 data-tab-id（用户统一验收用）', () => {
    const { wrapper } = harness({ config: null })
    const root = wrapper.get('[data-testid="model-settings-panel"]')
    expect(root.attributes('data-tab-id')).toBe('model-settings')
  })

  it('渲染页签元数据（标题用页签名，描述用页签 description）', () => {
    const { wrapper } = harness({ config: null })
    expect(wrapper.get('.model-settings__title').text()).toBe(modelSettingsTab.name)
    expect(wrapper.get('.model-settings__desc').text()).toBe(modelSettingsTab.description)
    expect(wrapper.get('[data-testid="model-settings-intro"]').text()).toBe(TEXT.intro)
  })

  it('表单区块标题与字段标签来自面板常量', () => {
    const { wrapper } = harness({ config: null })
    expect(wrapper.get('.model-settings__form-title').text()).toBe(TEXT.formTitle)
    const labels = wrapper.findAll('.model-settings__field-label').map((label) => label.text())
    expect(labels).toContain(TEXT.fieldBaseUrl)
    expect(labels).toContain(TEXT.fieldModel)
    expect(labels).toContain(TEXT.fieldApiKey)
    expect(labels).toContain(TEXT.fieldTemperature)
    expect(labels).toContain(TEXT.fieldMaxTokens)
    expect(labels).toContain(TEXT.fieldTimeoutMs)
  })
})
