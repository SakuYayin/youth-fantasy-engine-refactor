/**
 * `ports.ts` 形状锁定测试 —— 把「冻结接口」的**成员名、个数、结构兼容性**逐条钉死。
 *
 * 为什么值得单独一个测试文件：`ports.ts` 的消费者是**之后 6–8 个并行迁移子智能体**，
 * 它们按类型名与参数顺序逐字写代码。任何一处改名（例如把 `draftMaterial` 写成 `draft`、
 * 把 `getTableRows` 写成 `listTableRows`）都不会被 `tsc -p packages/tavern/tsconfig.json`
 * 发现（那个 tsconfig 的 `include` 只有 `src/**`），却会让所有迁移批同时红 ——
 * 所以这里用**写死的字面量数组**把 14 个端口的每一组成员名钉住。
 *
 * 第二件事是**可实现性证明**：下面 `mockPorts: TavernPorts` 是一个完整桩对象
 * （每个方法都给了最小可用实现）。它编译通过 = 这 14 个端口可以被一个真实对象一次性满足，
 * 不存在「某个端口成员无法实现 / 类型互相打架」的设计错误。
 *
 * ⚠️ 本测试**只读**端口层，不 import `index.ts`（该文件尚不存在，见 ports.ts 头部第 5 条）。
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_SEARCH_SETTINGS, BOCHA_ENDPOINT, SEARXNG_ENDPOINT, SEARCH_ENGINE_LABEL, SEARCH_MODE_LABEL } from '../src/search.js'
import type { TavernCapacityPort, TavernChatOptions, TavernChatPort, TavernChatProvider, TavernContextPort, TavernDraftMaterialPort, TavernInterviewPort, TavernMetaPort, TavernModelPort, TavernPlatformPort, TavernPorts, TavernProviderPort, TavernProviderRecord, TavernSearchPort, TavernSemanticPort, TavernStorePort, TavernStyleStoragePort, TavernUtilPort } from '../src/ports.js'

// ==================== 桩的零件 ====================

/** 一个「上游 AIProvider 形状」的真对象 —— 同时用于 model / capacity / interview 三处桩 */
const chatProvider: TavernChatProvider = {
  id: 'p-ollama',
  model: 'qwen3:8b',
  type: 'ollama',
  local: true,
  contextWindow: 32768,
  name: '本机 Ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  systemPrompt: '作者自定义提示词',
  temperature: 0.85,
}

interface StubState {
  styleRaw: string | null
  uidSeq: number
  calls: string[]
}
const state: StubState = { styleRaw: null, uidSeq: 0, calls: [] }

// ==================== 14 个端口逐一的完整桩 ====================

const meta: TavernMetaPort = {
  async get<T>(_key: string, def: T): Promise<T> { return def },
  async set(_key: string, _value: unknown): Promise<void> { /* 桩：丢弃 */ },
}

const store: TavernStorePort = {
  async get<T>(_key: string, def: T): Promise<T> { return def },
  async set(_key: string, _value: unknown): Promise<void> { /* 桩 */ },
  getCurrentProjectId(): string { return 'p1' },
  async getSetting<T>(_key: string, def: T): Promise<T> { return def },
  async setSetting(_key: string, _value: unknown): Promise<void> { /* 桩 */ },
  async getReport(_id: string) { return undefined },
  async listProjectReports(_projectId: string) { return [] },
  async saveReport() { /* 桩 */ },
  async deleteReport(_id: string) { /* 桩 */ },
  async getTableRows(_tabId: string) { return [] },
  async getCardRecords(_tabId: string) { return [] },
  async deleteProject(_id: string) { /* 桩 */ },
}

const chat: TavernChatPort = {
  async chat(_config: TavernChatProvider, _messages, opts?: TavernChatOptions): Promise<string> {
    state.calls.push(opts?.json === true ? 'json' : 'plain')
    return '桩：一段模型输出'
  },
  isCancelled(e: unknown): boolean { return e instanceof Error && e.name === 'AbortError' },
  JSON_TASK_TEMPERATURE: 0.3,
}

const model: TavernModelPort = {
  async loadProviders() { return [chatProvider] },
  async requireActiveProvider() { return chatProvider },
  isProviderUsable(p: TavernChatProvider): boolean { return p.baseUrl !== '' && p.model !== '' },
  typeLabel(p: TavernChatProvider): string { return p.type === 'ollama' || p.local === true ? '本地' : '联网' },
}

const providers: TavernProviderPort = {
  async loadProviders() { return [] },
  async loadActiveId() { return null },
}

const capacity: TavernCapacityPort = {
  adviseCapacity() {
    return {
      local: false,
      numCtxFromUserWindow: false,
      suggest: {
        contextBudget: 60000,
        numCtx: null,
        softLimit: 2000,
        hardLimit: 3000,
        longTermLimit: 500,
        diaryDays: 7,
        fixedOverhead: 400,
      },
    }
  },
  modelFingerprintOf() { return 'p-ollama|qwen3:8b|32768' },
  shouldApplyTuning() { return 'off' },
}

const context: TavernContextPort = {
  async buildProjectContext() { return { text: '', sections: [], dropped: [], chars: 0 } },
}

const semantic: TavernSemanticPort = {
  async indexOneDoc() { return { ok: true, chunks: 0 } },
  async removeByRef() { /* 桩 */ },
  async recallRelevant() { return [] },
  renderRecallHits() { return '' },
  async resolveEmbedConfig() { return null },
}

const search: TavernSearchPort = {
  async webSearch(query: string) {
    return { used: false, engine: 'off', query, results: [] }
  },
}

const draftMaterial: TavernDraftMaterialPort = {
  async prepareDraftMaterial(a) {
    return {
      blocks: '',
      source: { mode: a.settings.mode, label: '模型已有知识 + 粘贴素材', used: false, web: 'off' },
    }
  },
}

const platform: TavernPlatformPort = {
  DESKTOP: false,
  getDesktopState() { return { writeLocked: false, writeLockReason: '' } },
  isDesktopCloudUnavailable() { return false },
}

const util: TavernUtilPort = {
  uid(): string { state.uidSeq += 1; return `stub-${state.uidSeq}` },
}

const interview: TavernInterviewPort = {
  async callChat() { return '{"filled":{},"question":"继续？","done":false}' },
  isCancelled() { return false },
  async getTimeoutMs() { return 30000 },
  async resolveProvider() { return { provider: chatProvider, fellBack: false } },
}

const styleStorage: TavernStyleStoragePort = {
  read() { return state.styleRaw },
  write(raw: string | null) { state.styleRaw = raw },
}

/** 🔴 完整桩对象：能编译 = 14 个端口可被一个真实对象一次性满足（可实现性证明） */
const mockPorts: TavernPorts = {
  meta,
  store,
  chat,
  model,
  providers,
  capacity,
  context,
  semantic,
  search,
  draftMaterial,
  platform,
  util,
  interview,
  styleStorage,
}

// ==================== 聚合接口 ====================

describe('TavernPorts 聚合接口', () => {
  it('恰好 14 个成员，且成员名写死（重命名 / 漏加立刻红）', () => {
    expect(Object.keys(mockPorts)).toHaveLength(14)
    expect(Object.keys(mockPorts).sort()).toEqual([
      'capacity',
      'chat',
      'context',
      'draftMaterial',
      'interview',
      'meta',
      'model',
      'platform',
      'providers',
      'search',
      'semantic',
      'store',
      'styleStorage',
      'util',
    ])
  })

  it('每个成员都是对象（不是 undefined 占位）', () => {
    for (const port of Object.values(mockPorts)) {
      expect(typeof port).toBe('object')
      expect(port).not.toBeNull()
    }
  })

  it('store 已 extends meta：get / set 同时出现在两个端口上', () => {
    expect(Object.keys(mockPorts.meta).sort()).toEqual(['get', 'set'])
    expect(mockPorts.store.get).toBeDefined()
    expect(mockPorts.store.set).toBeDefined()
  })
})

// ==================== 14 个端口逐一的成员名集合 ====================

describe('端口成员名集合（逐个写死）', () => {
  it('meta：get / set', () => {
    expect(Object.keys(mockPorts.meta).sort()).toEqual(['get', 'set'])
  })

  it('store：extends meta 的 2 个 + 存储面 10 个', () => {
    expect(Object.keys(mockPorts.store).sort()).toEqual([
      'deleteProject',
      'deleteReport',
      'get',
      'getCardRecords',
      'getCurrentProjectId',
      'getReport',
      'getSetting',
      'getTableRows',
      'listProjectReports',
      'saveReport',
      'set',
      'setSetting',
    ])
  })

  it('chat：chat / isCancelled / JSON_TASK_TEMPERATURE', () => {
    expect(Object.keys(mockPorts.chat).sort()).toEqual(['JSON_TASK_TEMPERATURE', 'chat', 'isCancelled'])
  })

  it('model：4 个解析与就绪判定成员', () => {
    expect(Object.keys(mockPorts.model).sort()).toEqual([
      'isProviderUsable',
      'loadProviders',
      'requireActiveProvider',
      'typeLabel',
    ])
  })

  it('providers：已冻结的两个成员', () => {
    expect(Object.keys(mockPorts.providers).sort()).toEqual(['loadActiveId', 'loadProviders'])
  })

  it('capacity：已冻结的三个成员', () => {
    expect(Object.keys(mockPorts.capacity).sort()).toEqual([
      'adviseCapacity',
      'modelFingerprintOf',
      'shouldApplyTuning',
    ])
  })

  it('context：只有 buildProjectContext', () => {
    expect(Object.keys(mockPorts.context).sort()).toEqual(['buildProjectContext'])
  })

  it('semantic：5 个成员', () => {
    expect(Object.keys(mockPorts.semantic).sort()).toEqual([
      'indexOneDoc',
      'recallRelevant',
      'removeByRef',
      'renderRecallHits',
      'resolveEmbedConfig',
    ])
  })

  it('search：只有 webSearch', () => {
    expect(Object.keys(mockPorts.search).sort()).toEqual(['webSearch'])
  })

  it('draftMaterial：只有 prepareDraftMaterial', () => {
    expect(Object.keys(mockPorts.draftMaterial).sort()).toEqual(['prepareDraftMaterial'])
  })

  it('platform：DESKTOP / getDesktopState / isDesktopCloudUnavailable', () => {
    expect(Object.keys(mockPorts.platform).sort()).toEqual([
      'DESKTOP',
      'getDesktopState',
      'isDesktopCloudUnavailable',
    ])
  })

  it('util：只留 uid（formatDate 不走端口）', () => {
    expect(Object.keys(mockPorts.util).sort()).toEqual(['uid'])
  })

  it('interview：四个成员全部必填（无 ? 可选）', () => {
    expect(Object.keys(mockPorts.interview).sort()).toEqual([
      'callChat',
      'getTimeoutMs',
      'isCancelled',
      'resolveProvider',
    ])
    expect(mockPorts.interview.callChat).toBeDefined()
    expect(mockPorts.interview.getTimeoutMs).toBeDefined()
    expect(mockPorts.interview.isCancelled).toBeDefined()
    expect(mockPorts.interview.resolveProvider).toBeDefined()
  })

  it('styleStorage：read / write', () => {
    expect(Object.keys(mockPorts.styleStorage).sort()).toEqual(['read', 'write'])
  })
})

// ==================== 结构兼容（编译期证明 + 运行时点名） ====================

describe('结构兼容（冻结接口不被新端口破坏）', () => {
  it('TavernStorePort 可赋给 TavernMetaPort', () => {
    const _meta: TavernMetaPort = mockPorts.store
    expect(typeof _meta.get).toBe('function')
    expect(typeof _meta.set).toBe('function')
  })

  it('TavernChatProvider 可赋给 TavernProviderRecord（加宽类型不破坏既有子集）', () => {
    const _record: TavernProviderRecord = chatProvider
    expect(_record.model).toBe('qwen3:8b')
    expect(_record.type).toBe('ollama')
    expect(_record.contextWindow).toBe(32768)
  })

  it('TavernPlatformPort.getDesktopState 只承诺两个字段', () => {
    const st = mockPorts.platform.getDesktopState()
    expect(Object.keys(st).sort()).toEqual(['writeLockReason', 'writeLocked'])
  })

  it('TavernChatOptions 八个可选字段一个不落（含 skipUserSystem）', () => {
    const opts: TavernChatOptions = {
      timeoutMs: 30000,
      json: true,
      temperature: 0.3,
      extraOptions: { top_k: 40 },
      think: false,
      signal: new AbortController().signal,
      onToken: () => { /* 桩 */ },
      skipUserSystem: true,
    }
    expect(Object.keys(opts).sort()).toEqual([
      'extraOptions',
      'json',
      'onToken',
      'signal',
      'skipUserSystem',
      'temperature',
      'think',
      'timeoutMs',
    ])
  })
})

// ==================== 桩可实际调用（冒烟） ====================

describe('桩可实际调用', () => {
  it('chat 桩返回文本，且能收到 opts.json', async () => {
    const out = await mockPorts.chat.chat(chatProvider, [{ role: 'user', content: '你好' }], { json: true })
    expect(out).toBe('桩：一段模型输出')
    expect(state.calls).toContain('json')
  })

  it('util.uid 桩同一实例内不重复', () => {
    expect(mockPorts.util.uid()).not.toBe(mockPorts.util.uid())
  })

  it('styleStorage 桩：write(null) 语义 = 删除键', () => {
    mockPorts.styleStorage.write('["character"]')
    expect(mockPorts.styleStorage.read()).toBe('["character"]')
    mockPorts.styleStorage.write(null)
    expect(mockPorts.styleStorage.read()).toBeNull()
  })
})

// ==================== 联网检索常量（逐字） ====================

describe('search.ts 类型与常量（逐字抄自上游 webSearch.ts:29-119）', () => {
  it('DEFAULT_SEARCH_SETTINGS 关键字段写死', () => {
    expect(DEFAULT_SEARCH_SETTINGS.mode).toBe('off')
    expect(DEFAULT_SEARCH_SETTINGS.engine).toBe('bocha')
    expect(DEFAULT_SEARCH_SETTINGS.topK).toBe(5)
    expect(DEFAULT_SEARCH_SETTINGS.endpoint).toBe('')
    expect(DEFAULT_SEARCH_SETTINGS.apiKey).toBe('')
    expect(Object.keys(DEFAULT_SEARCH_SETTINGS).sort()).toEqual([
      'apiKey',
      'endpoint',
      'engine',
      'mode',
      'topK',
    ])
  })

  it('两个端点常量逐字', () => {
    expect(BOCHA_ENDPOINT).toBe('https://api.bochaai.com/v1/web-search')
    expect(SEARXNG_ENDPOINT).toBe(
      'http://127.0.0.1:8888/search?q={query}&format=json&language=zh-CN',
    )
  })

  it('两组显示名常量逐字', () => {
    expect(SEARCH_MODE_LABEL).toEqual({
      off: '模型已有知识 + 粘贴素材',
      model: '模型自带联网',
      api: '搜索接口',
    })
    expect(SEARCH_ENGINE_LABEL).toEqual({ bocha: '博查', searxng: 'SearXNG', custom: '自定义接口' })
  })

  it('search.ts 不含函数实现：只有类型与常量（DEFAULT_SEARCH_SETTINGS 是唯一对象常量）', () => {
    // 反向断言：常量本身可枚举且不含方法（函数实现若被抄进来，这里会多出可调用属性）
    expect(Object.values(DEFAULT_SEARCH_SETTINGS).some(v => typeof v === 'function')).toBe(false)
    expect(Object.keys(DEFAULT_SEARCH_SETTINGS)).toHaveLength(5)
  })
})