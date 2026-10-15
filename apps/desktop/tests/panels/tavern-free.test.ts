/**
 * 自由对话面板（tavern-free-model.ts）的纯逻辑测试：
 * 常量与文案 / 默认值 / 消息组装与防御解析 / 输入校验与 system 组装 /
 * AI 请求组装（前提拼 system、recentMessages 上下文窗口）/ 新建会话 /
 * 时间戳与角色标签 / 库值兜底 / 状态推导与失败文案。
 */
import { describe, expect, it } from 'vitest'

import type { TavernMessage } from '../../src/renderer/tavern/types.js'
import {
  AI_FREE_CONTEXT_MESSAGES,
  AI_FREE_MAX_TOKENS,
  AI_FREE_TEMPERATURE,
  DEFAULT_SESSION_TITLE,
  PREMISE_PROMPT_PREFIX,
  TAVERN_FREE_PANEL_TEXT,
  appendMessage,
  buildFreeChatRequest,
  buildSystemPrompt,
  createDefaultPanelValues,
  failureNotice,
  formatMessageTime,
  makeMessage,
  messageCountLine,
  newSessionValues,
  panelSaveStatus,
  parseMessages,
  resolvePremise,
  resolveSessionTitle,
  resolveSettings,
  roleLabel,
  settingsLine,
  toAiMessages,
  validateDraft,
} from '../../src/renderer/panels/tavern-free-model.js'

/** TavernMessage 夹具。 */
function message(input: Partial<TavernMessage> = {}): TavernMessage {
  return {
    id: input.id ?? 'msg_fixture1',
    role: input.role ?? 'user',
    content: input.content ?? '你好',
    createdAt: input.createdAt ?? '2026-06-01T08:05:00.000Z',
  }
}

describe('tavern-free 常量与文案', () => {
  it('默认采样参数与任务书一致（temperature=0.9 / maxTokens=2048 / contextMessages=20）', () => {
    expect(AI_FREE_TEMPERATURE).toBe(0.9)
    expect(AI_FREE_MAX_TOKENS).toBe(2048)
    expect(AI_FREE_CONTEXT_MESSAGES).toBe(20)
    expect(DEFAULT_SESSION_TITLE).toBe('新会话')
  })

  it('文案常量每一条都是非空字符串', () => {
    for (const [key, value] of Object.entries(TAVERN_FREE_PANEL_TEXT)) {
      expect(key.length).toBeGreaterThan(0)
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('顶部说明条为任务书指定文案', () => {
    expect(TAVERN_FREE_PANEL_TEXT.intro).toBe('自由对话不绑定角色卡，预览版无流式输出与自动记忆')
  })
})

describe('tavern-free 默认值', () => {
  it('createDefaultPanelValues：mode=free、advanced 空对象（Record<string,string> 不接受 false）', () => {
    const values = createDefaultPanelValues()
    expect(values.messages).toEqual([])
    expect(values.sessionTitle).toBe(DEFAULT_SESSION_TITLE)
    expect(values.premise).toBe('')
    expect(values.settings).toEqual({
      mode: 'free',
      temperature: 0.9,
      maxTokens: 2048,
      contextMessages: 20,
      advanced: {},
    })
  })
})

describe('tavern-free 消息组装', () => {
  it('makeMessage：id 用 msg_ 前缀、createdAt 可解析、两次调用 id 不重复', () => {
    const first = makeMessage('user', '你好')
    const second = makeMessage('assistant', '你好呀')
    expect(first.id.startsWith('msg_')).toBe(true)
    expect(second.id.startsWith('msg_')).toBe(true)
    expect(first.id).not.toBe(second.id)
    expect(first.role).toBe('user')
    expect(second.role).toBe('assistant')
    expect(Number.isNaN(new Date(first.createdAt).getTime())).toBe(false)
  })

  it('appendMessage：追加不改传入数组', () => {
    const base = [message()]
    const next = appendMessage(base, message({ id: 'msg_two', content: '第二条' }))
    expect(base).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next[1]!.content).toBe('第二条')
  })

  it('parseMessages：非数组按空列表处理', () => {
    expect(parseMessages('不是数组')).toEqual([])
    expect(parseMessages(undefined)).toEqual([])
    expect(parseMessages(null)).toEqual([])
  })

  it('parseMessages：缺 id / 缺 content / role 非法的条目整条丢弃', () => {
    const parsed = parseMessages([
      { id: 'msg_a', role: 'user', content: '好', createdAt: '2026-06-01T00:00:00.000Z' },
      { role: 'user', content: '缺 id', createdAt: '' },
      { id: 'msg_b', role: 'user', createdAt: '' },
      { id: 'msg_c', role: '旁白', content: 'role 非法', createdAt: '' },
      '不是对象',
      null,
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.id).toBe('msg_a')
    expect(parsed[0]!.role).toBe('user')
    expect(parsed[0]!.content).toBe('好')
  })
})

describe('tavern-free 输入校验与 system 组装', () => {
  it('validateDraft：空 / 纯空白 → 提示文案；非空白 → null', () => {
    expect(validateDraft('')).toBe(TAVERN_FREE_PANEL_TEXT.inputRequired)
    expect(validateDraft('   ')).toBe(TAVERN_FREE_PANEL_TEXT.inputRequired)
    expect(validateDraft('帮我头脑风暴')).toBeNull()
  })

  it('buildSystemPrompt：留空 / 纯空白 → undefined（不带 system）', () => {
    expect(buildSystemPrompt('')).toBeUndefined()
    expect(buildSystemPrompt('   ')).toBeUndefined()
  })

  it('buildSystemPrompt：有内容 → 前缀 + trim 后的前提', () => {
    expect(buildSystemPrompt('  你是一名编辑，帮我审稿  ')).toBe(
      `${PREMISE_PROMPT_PREFIX}你是一名编辑，帮我审稿`,
    )
  })
})

describe('tavern-free AI 请求组装', () => {
  it('留空前提：请求不带 system 字段；采样参数来自 settings', () => {
    const request = buildFreeChatRequest('', [message()], createDefaultPanelValues().settings)
    expect(request.system).toBeUndefined()
    expect(request.temperature).toBe(0.9)
    expect(request.maxTokens).toBe(2048)
    expect(request.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('有前提：system 含前提文本', () => {
    const request = buildFreeChatRequest(
      '你是一名编辑，帮我审稿',
      [message()],
      createDefaultPanelValues().settings,
    )
    expect(request.system).toBeDefined()
    expect(request.system).toContain('你是一名编辑，帮我审稿')
    expect(request.system).toContain('前提设定')
  })

  it('上下文窗口：只发送最近 contextMessages 条且保持时间顺序；system 角色被剔除', () => {
    const settings = { ...createDefaultPanelValues().settings, contextMessages: 4 }
    const history = [
      message({ id: 'msg_1', role: 'user', content: '一' }),
      message({ id: 'msg_2', role: 'system', content: '系统提示不该进请求' }),
      message({ id: 'msg_3', role: 'assistant', content: '二' }),
      message({ id: 'msg_4', role: 'user', content: '三' }),
      message({ id: 'msg_5', role: 'assistant', content: '四' }),
    ]
    const request = buildFreeChatRequest('', history, settings)
    expect(request.messages).toEqual([
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' },
      { role: 'assistant', content: '四' },
    ])
  })

  it('toAiMessages：limit<=0 返回空数组（recentMessages 口径）', () => {
    expect(toAiMessages([message()], 0)).toEqual([])
    expect(toAiMessages([message()], -1)).toEqual([])
  })
})

describe('tavern-free 新建会话', () => {
  it('newSessionValues：清空消息、标题回默认；前提与设置保留；不改传入对象', () => {
    const previous = createDefaultPanelValues()
    previous.messages = [message()]
    previous.sessionTitle = '审稿讨论'
    previous.premise = '你是一名编辑'
    const next = newSessionValues(previous)
    expect(next.messages).toEqual([])
    expect(next.sessionTitle).toBe(DEFAULT_SESSION_TITLE)
    expect(next.premise).toBe('你是一名编辑')
    expect(next.settings).toEqual(previous.settings)
    expect(previous.messages).toHaveLength(1)
    expect(previous.sessionTitle).toBe('审稿讨论')
  })
})

describe('tavern-free 时间戳与角色标签', () => {
  it('formatMessageTime：MM-dd HH:mm（本地时区，与 Date 本地字段一致）', () => {
    const iso = '2026-06-01T08:05:00.000Z'
    const date = new Date(iso)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    expect(formatMessageTime(iso)).toBe(expected)
  })

  it('formatMessageTime：无效时间返回空串', () => {
    expect(formatMessageTime('not-a-date')).toBe('')
    expect(formatMessageTime('')).toBe('')
  })

  it('roleLabel：user→我、assistant→AI、system→系统', () => {
    expect(roleLabel('user')).toBe(TAVERN_FREE_PANEL_TEXT.roleUser)
    expect(roleLabel('assistant')).toBe(TAVERN_FREE_PANEL_TEXT.roleAssistant)
    expect(roleLabel('system')).toBe(TAVERN_FREE_PANEL_TEXT.roleSystem)
  })
})

describe('tavern-free 库值兜底', () => {
  it('resolveSettings：垃圾值整体回默认；部分字段非法逐字段兜底', () => {
    const defaults = createDefaultPanelValues().settings
    expect(resolveSettings(undefined)).toEqual(defaults)
    expect(resolveSettings('垃圾')).toEqual(defaults)
    const partial = resolveSettings({ temperature: '高', maxTokens: 4096, contextMessages: -1 })
    expect(partial.temperature).toBe(0.9)
    expect(partial.maxTokens).toBe(4096)
    expect(partial.contextMessages).toBe(20)
    expect(partial.mode).toBe('free')
    expect(partial.advanced).toEqual({})
  })

  it('resolveSessionTitle：非字符串 / 空白回默认标题', () => {
    expect(resolveSessionTitle(undefined)).toBe(DEFAULT_SESSION_TITLE)
    expect(resolveSessionTitle(42)).toBe(DEFAULT_SESSION_TITLE)
    expect(resolveSessionTitle('   ')).toBe(DEFAULT_SESSION_TITLE)
    expect(resolveSessionTitle('审稿讨论')).toBe('审稿讨论')
  })

  it('resolvePremise：非字符串回空串，字符串原样（含空串）', () => {
    expect(resolvePremise(undefined)).toBe('')
    expect(resolvePremise(42)).toBe('')
    expect(resolvePremise('')).toBe('')
    expect(resolvePremise('你是一名编辑')).toBe('你是一名编辑')
  })
})

describe('tavern-free 状态与文案函数', () => {
  it('panelSaveStatus：saving → error → dirty → saved', () => {
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(false, false, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
    expect(panelSaveStatus(true, true, true)).toBe('saving')
  })

  it('messageCountLine：概览行', () => {
    expect(messageCountLine(0)).toBe('共 0 条消息')
    expect(messageCountLine(3)).toBe('共 3 条消息')
  })

  it('settingsLine：设置摘要行', () => {
    expect(
      settingsLine({ mode: 'free', temperature: 0.9, maxTokens: 2048, contextMessages: 20, advanced: {} }),
    ).toBe('上下文：最近 20 条 · 温度：0.9 · 最大输出：2048')
  })

  it('failureNotice：未配置 → 引导文案；其它如实「错误码：消息」', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '测试桩')).toBe(TAVERN_FREE_PANEL_TEXT.notConfigured)
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('AI_TIMEOUT：请求超时')
    expect(failureNotice('AI_UPSTREAM_ERROR', '网络断了')).toBe('AI_UPSTREAM_ERROR：网络断了')
  })
})
