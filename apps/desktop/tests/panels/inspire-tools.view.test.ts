// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * 面板：灵感启发（inspire-tools）—— 视图单测（happy-dom）。
 *
 * 口径：随机确定性由 `vi.spyOn(Math, 'random').mockReturnValue(0)` 在 mount 前
 * 安装（组件与期望用同一 rng 值分别计算）；AI 行为通过注入 state.ai 桩观察——
 * 断言「组件渲染的 == 模型对同一输入的输出」，不重复实现组件内部逻辑。
 * 可见文本审计：渲染文本 ⊆ 页签文案 ∪ 常量 ∪ 模型输出（验收 2）。
 */

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type { AiPort, AiRequest, AiResult } from '../../src/renderer/ai/types.js'
import type { AppState } from '../../src/renderer/app-state.js'
import InspireTools from '../../src/renderer/panels/inspire-tools.vue'
import {
  BUTTON_ANOTHER,
  BUTTON_CLEAR_HISTORY,
  BUTTON_IDEA_GO,
  BUTTON_IDEA_RUNNING,
  BUTTON_ROLL_NAMES,
  CARD_HISTORY_TITLE,
  CARD_IDEA_TITLE,
  CARD_INSPIRE_TITLE,
  CARD_NAME_TITLE,
  HISTORY_EMPTY_HINT,
  IDEA_EMPTY_RESULT,
  IDEA_FAILED,
  IDEA_INPUT_HINT,
  IDEA_INPUT_PLACEHOLDER,
  IDEA_KEYWORD_HINTS,
  IDEA_SYSTEM_PROMPT,
  NAMES_EMPTY_HINT,
  NAME_KIND_LABEL,
  NAME_KIND_OPTIONS,
  NO_MODEL_HINT,
  NO_PERSIST_NOTE,
  INSPIRATION_EMPTY_HINT,
  formatIdeaKeywords,
  parseIdeaList,
  rollInspiration,
  rollNames,
} from '../../src/renderer/panels/inspire-tools-model.js'

/* --- 桩 --- */

interface StubOptions {
  readonly configured?: boolean
  readonly complete?: (request: AiRequest) => Promise<AiResult>
}

function aiStub(options: StubOptions = {}): AiPort {
  return {
    getConfig: () => null,
    configured: () => options.configured ?? true,
    reload: async () => true,
    saveConfig: async () => true,
    complete:
      options.complete ??
      (async () => {
        throw new Error('complete 不应被调用')
      }),
  }
}

function stateStub(ai: AiPort): AppState {
  return {
    getSnapshot(): Record<string, unknown> {
      return {}
    },
    subscribe(): () => void {
      return () => {}
    },
    ai,
  } as unknown as AppState
}

interface ViewProps {
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

function inspireToolsTab(): TabDef {
  const tab = getTab('inspire-tools')
  if (tab === undefined) {
    throw new Error('schema-tabs 缺少 inspire-tools 页签')
  }
  return tab
}

const TAB = inspireToolsTab()

interface MountOptions {
  readonly configured?: boolean
  readonly complete?: (request: AiRequest) => Promise<AiResult>
}

async function mountView(options: MountOptions = {}) {
  const props: ViewProps = { state: stateStub(aiStub(options)), tab: TAB }
  const wrapper = mount(InspireTools, { props })
  // onMounted 的初始抽取 / 提示经 Vue 调度器批量刷新；await 一次让 DOM 落到已挂载状态。
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('渲染与初始状态', () => {
  it('渲染页签元数据与初始状态（固定随机种子）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView()

    const panel = wrapper.get('[data-testid=inspire-tools-panel]')
    expect(panel.attributes('data-tab-id')).toBe('inspire-tools')
    expect(wrapper.get('.inspire-tools__title').text()).toBe(TAB.name)
    expect(wrapper.get('.inspire-tools__description').text()).toBe(TAB.description)
    expect(wrapper.get('.inspire-tools__note').text()).toBe(NO_PERSIST_NOTE)

    // 四张卡按 随机灵感 / 名字生成 / 点子组合 / 抽中历史 排列。
    expect(wrapper.findAll('.yfe-panel__title').map((title) => title.text())).toEqual([
      CARD_INSPIRE_TITLE,
      CARD_NAME_TITLE,
      CARD_IDEA_TITLE,
      CARD_HISTORY_TITLE,
    ])

    // 挂载即抽一次灵感与一批名字：渲染值 == 模型对同一 rng 的输出。
    expect(wrapper.get('[data-testid=inspire-inspiration-text]').text()).toBe(rollInspiration(() => 0).text)
    const nameItems = wrapper.findAll('[data-testid=inspire-name-item]')
    expect(nameItems.map((item) => item.text())).toEqual([...rollNames('person', () => 0)])

    // 已配置 → 初始提示；历史为空态。
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(IDEA_INPUT_HINT)
    expect(wrapper.get('[data-testid=inspire-history-empty]').text()).toBe(HISTORY_EMPTY_HINT)
    expect(wrapper.find('[data-testid=inspire-history-list]').exists()).toBe(false)

    // 类型下拉四个选项。
    expect(wrapper.findAll('option').map((option) => option.text())).toEqual(
      NAME_KIND_OPTIONS.map((option) => option.label),
    )

    // 占位符接常量。
    expect(wrapper.get('[data-testid=inspire-idea-input]').attributes('placeholder')).toBe(IDEA_INPUT_PLACEHOLDER)

    // 清空历史按钮在无历史时不渲染。
    expect(wrapper.find('[data-testid=inspire-history-clear]').exists()).toBe(false)

    // 灵感卡初始有内容：空态提示不渲染。
    expect(wrapper.find('[data-testid=inspire-inspiration-empty]').exists()).toBe(false)
  })

  it('「换一个」：替换灵感并记入抽中历史（新条目在前）', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView()

    await wrapper.get('[data-testid=inspire-another]').trigger('click')
    let items = wrapper.findAll('[data-testid=inspire-history-item]')
    expect(items.length).toBe(1)
    expect(items[0]?.find('[data-testid=inspire-history-source]').text()).toBe(CARD_INSPIRE_TITLE)
    expect(items[0]?.find('[data-testid=inspire-history-text]').text()).toBe(rollInspiration(() => 0).text)
    expect(wrapper.find('[data-testid=inspire-history-empty]').exists()).toBe(false)

    // 换一个随机源，再抽一次：新条目在最前，旧条目保留。
    spy.mockReturnValue(0.5)
    await wrapper.get('[data-testid=inspire-another]').trigger('click')
    items = wrapper.findAll('[data-testid=inspire-history-item]')
    expect(items.length).toBe(2)
    expect(items[0]?.find('[data-testid=inspire-history-text]').text()).toBe(rollInspiration(() => 0.5).text)
    expect(items[1]?.find('[data-testid=inspire-history-text]').text()).toBe(rollInspiration(() => 0).text)

    // 灵感卡同步替换为最新抽取。
    expect(wrapper.get('[data-testid=inspire-inspiration-text]').text()).toBe(rollInspiration(() => 0.5).text)
  })

  it('名字生成：切换类型清空旧名单，「生成名字」抽新一批并记入历史', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView()

    // 切类型 → 清空旧名单并显示空态提示。
    await wrapper.get('[data-testid=inspire-kind]').setValue('sect')
    expect(wrapper.find('[data-testid=inspire-names-list]').exists()).toBe(false)
    expect(wrapper.get('[data-testid=inspire-names-empty]').text()).toBe(NAMES_EMPTY_HINT)

    // 生成名字 → 新一批（模型对同一 rng 的输出）+ 一条历史。
    await wrapper.get('[data-testid=inspire-roll-names]').trigger('click')
    const items = wrapper.findAll('[data-testid=inspire-name-item]')
    expect(items.map((item) => item.text())).toEqual([...rollNames('sect', () => 0)])
    const historyItems = wrapper.findAll('[data-testid=inspire-history-item]')
    expect(historyItems.length).toBe(1)
    expect(historyItems[0]?.find('[data-testid=inspire-history-source]').text()).toBe(CARD_NAME_TITLE)
    expect(historyItems[0]?.find('[data-testid=inspire-history-text]').text()).toBe(
      rollNames('sect', () => 0).join('、'),
    )
  })

  it('「清空历史」：清空后回到空态提示，按钮消失', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView()

    await wrapper.get('[data-testid=inspire-another]').trigger('click')
    expect(wrapper.find('[data-testid=inspire-history-clear]').exists()).toBe(true)

    await wrapper.get('[data-testid=inspire-history-clear]').trigger('click')
    expect(wrapper.find('[data-testid=inspire-history-list]').exists()).toBe(false)
    expect(wrapper.get('[data-testid=inspire-history-empty]').text()).toBe(HISTORY_EMPTY_HINT)
    expect(wrapper.find('[data-testid=inspire-history-clear]').exists()).toBe(false)
  })

  it('历史条目上限 10 条（点 12 次只保留最近 10 条）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView()

    for (let i = 0; i < 12; i += 1) {
      await wrapper.get('[data-testid=inspire-another]').trigger('click')
    }
    expect(wrapper.findAll('[data-testid=inspire-history-item]').length).toBe(10)
  })
})

describe('点子组合：AI 流', () => {
  const IDEA_TEXT = '1. 废柴觉醒（神格来历成谜）\n- 宗门养猪流（主角是幕后黑手）\n\n双生花（善恶同体）'

  it('已配置：走 state.ai.complete，渲染解析后的点子与关键词行', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const requests: AiRequest[] = []
    const wrapper = await mountView({
      configured: true,
      complete: async (request) => {
        requests.push(request)
        return { ok: true, text: IDEA_TEXT }
      },
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    expect(requests.length).toBe(1)
    const request = requests[0]
    if (request === undefined) {
      throw new Error('complete 应收到请求')
    }
    expect(request.system).toBe(IDEA_SYSTEM_PROMPT)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toContain('剑修')
    expect(request.messages[0]?.content).toContain('道心')
    expect('maxTokens' in request).toBe(false)
    expect('temperature' in request).toBe(false)

    // 点子列表 == parseIdeaList 对同一文本的输出；关键词行 == formatIdeaKeywords。
    expect(
      wrapper.findAll('[data-testid=inspire-idea-item]').map((item) => item.text()),
    ).toEqual([...parseIdeaList(IDEA_TEXT)])
    expect(wrapper.get('[data-testid=inspire-idea-keywords]').text()).toBe(formatIdeaKeywords(['剑修', '道心']))
    expect(wrapper.find('[data-testid=inspire-idea-message]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=inspire-ideas-empty]').exists()).toBe(false)
  })

  it('AI 返回失败结果：显示失败提示与错误样式，不渲染点子', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView({
      configured: true,
      complete: async () => ({ ok: false, code: 'AI_UPSTREAM_ERROR', message: '上游炸了' }),
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    const message = wrapper.get('[data-testid=inspire-idea-message]')
    expect(message.text()).toBe('模型服务异常（AI_UPSTREAM_ERROR：上游炸了）。随机灵感与名字生成不受影响，可先用本地工具。')
    expect(message.classes()).toContain('inspire-tools__idea-message--error')
    expect(wrapper.find('[data-testid=inspire-ideas-list]').exists()).toBe(false)
  })

  it('AI 返回空点子：显示空结果提示，不渲染列表', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView({
      configured: true,
      complete: async () => ({ ok: true, text: '   \n\n  ' }),
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid=inspire-ideas-empty]').text()).toBe(IDEA_EMPTY_RESULT)
    expect(wrapper.find('[data-testid=inspire-ideas-list]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=inspire-idea-keywords]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=inspire-idea-message]').exists()).toBe(false)
  })

  it('AI 抛异常（而非失败结果）：显示失败前缀与异常信息', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = await mountView({
      configured: true,
      complete: async () => {
        throw new Error('网络炸了')
      },
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    const message = wrapper.get('[data-testid=inspire-idea-message]')
    expect(message.text()).toBe(`${IDEA_FAILED}：网络炸了`)
    expect(message.classes()).toContain('inspire-tools__idea-message--error')
  })

  it('生成中：按钮 label 切换并禁点，running 中不再发起', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let calls = 0
    const wrapper = await mountView({
      configured: true,
      complete: async () => {
        calls += 1
        return new Promise<AiResult>(() => {})
      },
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    const button = wrapper.get('[data-testid=inspire-idea-go]')
    expect(button.text()).toBe(BUTTON_IDEA_RUNNING)
    expect(button.attributes('disabled')).toBeDefined()

    // running 中再点不重复发起。
    await button.trigger('click')
    await flushPromises()
    expect(calls).toBe(1)

    wrapper.unmount()
  })

  it('未配置模型：不发起请求、显示引导、按钮不禁用、随机类不受影响', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let calls = 0
    const wrapper = await mountView({
      configured: false,
      complete: async () => {
        calls += 1
        return { ok: true, text: '不应被调用' }
      },
    })

    // 挂载即显示「未配置模型」引导。
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(NO_MODEL_HINT)

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    expect(calls).toBe(0)
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(NO_MODEL_HINT)
    // 按钮不禁用（disabled 属性不出现）。
    expect(wrapper.get('[data-testid=inspire-idea-go]').attributes('disabled')).toBeUndefined()

    // 随机类本地工具不受影响。
    await wrapper.get('[data-testid=inspire-another]').trigger('click')
    expect(wrapper.find('[data-testid=inspire-history-list]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=inspire-history-empty]').exists()).toBe(false)
  })

  it('关键词非法（blank / tooFew / tooMany）：各自提示且不发起请求', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let calls = 0
    const wrapper = await mountView({
      configured: true,
      complete: async () => {
        calls += 1
        return { ok: true, text: '不应被调用' }
      },
    })

    // blank：没输入。
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(IDEA_KEYWORD_HINTS.blank)

    // tooFew：只有 1 个关键词。
    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(IDEA_KEYWORD_HINTS.tooFew)

    // tooMany：4 个关键词。
    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑 道 心 天')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid=inspire-idea-message]').text()).toBe(IDEA_KEYWORD_HINTS.tooMany)

    expect(calls).toBe(0)
  })

  it('再次发散：替换旧点子与关键词行', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let call = 0
    const wrapper = await mountView({
      configured: true,
      complete: async () => {
        call += 1
        return { ok: true, text: call === 1 ? '1. 点子甲（第一轮）' : '2. 点子乙（第二轮）' }
      },
    })

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid=inspire-idea-item]').map((item) => item.text())).toEqual(['点子甲（第一轮）'])

    await wrapper.get('[data-testid=inspire-idea-input]').setValue('天命 三重')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid=inspire-idea-item]').map((item) => item.text())).toEqual(['点子乙（第二轮）'])
    expect(wrapper.get('[data-testid=inspire-idea-keywords]').text()).toBe(formatIdeaKeywords(['天命', '三重']))
  })
})

describe('可见文本审计（验收 2：渲染文本 ⊆ 页签文案 ∪ 常量 ∪ 模型输出）', () => {
  it('所有渲染文本都在允许集合内', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const ideaText = '1. 废柴觉醒（神格来历成谜）\n- 宗门养猪流（主角是幕后黑手）\n\n双生花（善恶同体）'
    const wrapper = await mountView({
      configured: true,
      complete: async () => ({ ok: true, text: ideaText }),
    })

    // 交互覆盖：换一个 + 生成名字 + AI 发散。
    await wrapper.get('[data-testid=inspire-another]').trigger('click')
    await wrapper.get('[data-testid=inspire-roll-names]').trigger('click')
    await wrapper.get('[data-testid=inspire-idea-input]').setValue('剑修 道心')
    await wrapper.get('[data-testid=inspire-idea-go]').trigger('click')
    await flushPromises()

    const texts: string[] = []
    texts.push(wrapper.get('.inspire-tools__title').text())
    texts.push(wrapper.get('.inspire-tools__description').text())
    texts.push(wrapper.get('.inspire-tools__note').text())
    for (const title of wrapper.findAll('.yfe-panel__title')) {
      texts.push(title.text())
    }
    for (const label of wrapper.findAll('.yfe-button__label')) {
      texts.push(label.text())
    }
    for (const option of wrapper.findAll('option')) {
      texts.push(option.text())
    }
    for (const hint of wrapper.findAll('.inspire-tools__hint')) {
      texts.push(hint.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-inspiration-text]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-name-item]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-idea-keywords]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-idea-message]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-idea-item]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-history-source]')) {
      texts.push(element.text())
    }
    for (const element of wrapper.findAll('[data-testid=inspire-history-text]')) {
      texts.push(element.text())
    }
    const placeholder = wrapper.get('[data-testid=inspire-idea-input]').attributes('placeholder')
    if (placeholder !== undefined) {
      texts.push(placeholder)
    }

    const allowed = new Set<string>([
      TAB.name,
      TAB.description,
      CARD_INSPIRE_TITLE,
      CARD_NAME_TITLE,
      CARD_IDEA_TITLE,
      CARD_HISTORY_TITLE,
      BUTTON_ANOTHER,
      BUTTON_ROLL_NAMES,
      BUTTON_IDEA_GO,
      BUTTON_IDEA_RUNNING,
      BUTTON_CLEAR_HISTORY,
      NAME_KIND_LABEL,
      IDEA_INPUT_PLACEHOLDER,
      IDEA_INPUT_HINT,
      IDEA_EMPTY_RESULT,
      NAMES_EMPTY_HINT,
      INSPIRATION_EMPTY_HINT,
      HISTORY_EMPTY_HINT,
      NO_MODEL_HINT,
      NO_PERSIST_NOTE,
      IDEA_FAILED,
      IDEA_KEYWORD_HINTS.blank,
      IDEA_KEYWORD_HINTS.tooFew,
      IDEA_KEYWORD_HINTS.tooMany,
      ...NAME_KIND_OPTIONS.map((option) => option.label),
      ...parseIdeaList(ideaText),
      formatIdeaKeywords(['剑修', '道心']),
      // 历史抽中文本（rng=0 的本地抽取）与名字条目（join 与逐条两种形态）。
      rollInspiration(() => 0).text,
      rollNames('person', () => 0).join('、'),
      ...rollNames('person', () => 0),
    ])

    for (const text of texts) {
      expect(allowed.has(text), `渲染了未知文本：${text}`).toBe(true)
    }
  })
})
