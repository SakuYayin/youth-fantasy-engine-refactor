/**
 * 跑团互动面板（tavern-run）纯逻辑层单测：
 * 常量与文案 / 默认值 / 消息组装 / 时间戳 / 角色标签 / AI 请求组装 /
 * 选中卡解析 / 库值防御解析 / 设置与标题兜底 / 文案行 / 保存状态。
 */
import { describe, expect, it } from 'vitest'

import type {
  TavernCardRecord,
  TavernMessage,
  TavernSettingsRecord,
  TavernWorldEntry,
} from '../../src/renderer/tavern/types.js'
import {
  AI_RUN_CONTEXT_MESSAGES,
  AI_RUN_MAX_TOKENS,
  AI_RUN_TEMPERATURE,
  DEFAULT_SESSION_TITLE,
  TAVERN_RUN_PANEL_TEXT,
  appendMessage,
  buildChatRequest,
  createDefaultPanelValues,
  failureNotice,
  formatMessageTime,
  makeMessage,
  messageCountLine,
  panelSaveStatus,
  parseCards,
  parseWorldEntries,
  resolveSelectedCard,
  resolveSessionTitle,
  resolveSettings,
  roleLabel,
  settingsLine,
  toAiMessages,
} from '../../src/renderer/panels/tavern-run-model.js'

/** TavernCardRecord 夹具。 */
function cardRecord(input: Partial<TavernCardRecord> = {}): TavernCardRecord {
  return {
    id: input.id ?? 'card_fixture1',
    name: input.name ?? '林晚',
    description: input.description ?? '魔法学院二年级学生，随身带着会说话的旧怀表。',
    personality: input.personality ?? '沉静、好奇',
    firstMessage: input.firstMessage ?? '你在图书馆做什么？',
    tags: input.tags ?? ['魔法', '少女'],
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  }
}

/** TavernWorldEntry 夹具。 */
function worldEntry(input: Partial<TavernWorldEntry> = {}): TavernWorldEntry {
  return {
    id: input.id ?? 'world_1',
    keywords: input.keywords ?? '图书馆、怀表',
    content: input.content ?? '图书馆的旧怀表会在午夜报出真实时间。',
    enabled: input.enabled ?? true,
    order: input.order ?? 0,
  }
}

/** TavernMessage 夹具。 */
function message(input: Partial<TavernMessage> = {}): TavernMessage {
  return {
    id: input.id ?? 'msg_fixture1',
    role: input.role ?? 'user',
    content: input.content ?? '我推开了图书馆的门。',
    createdAt: input.createdAt ?? '2026-06-01T10:00:00.000Z',
  }
}

/** TavernSettingsRecord 夹具（默认值基础上覆盖）。 */
function settingsRecord(input: Partial<TavernSettingsRecord> = {}): TavernSettingsRecord {
  return { ...createDefaultPanelValues().settings, ...input }
}

describe('tavern-run 常量与默认值', () => {
  it('默认采样参数符合任务书（temperature=0.7 / maxTokens=2048 / contextMessages=20）', () => {
    expect(AI_RUN_TEMPERATURE).toBe(0.7)
    expect(AI_RUN_MAX_TOKENS).toBe(2048)
    expect(AI_RUN_CONTEXT_MESSAGES).toBe(20)
  })

  it('createDefaultPanelValues 返回空会话与默认设置', () => {
    const values = createDefaultPanelValues()
    expect(values.messages).toEqual([])
    expect(values.sessionTitle).toBe(DEFAULT_SESSION_TITLE)
    expect(values.sessionTitle).toBe('新会话')
    expect(values.cardId).toBeNull()
    expect(values.settings).toEqual({
      mode: 'chat',
      temperature: 0.7,
      maxTokens: 2048,
      contextMessages: 20,
      advanced: {},
    })
  })

  it('每次调用返回独立对象（互不影响）', () => {
    const first = createDefaultPanelValues()
    const second = createDefaultPanelValues()
    first.messages.push(message())
    first.settings.temperature = 1.5
    expect(second.messages).toEqual([])
    expect(second.settings.temperature).toBe(0.7)
  })

  it('文案常量全为非空字符串', () => {
    for (const value of Object.values(TAVERN_RUN_PANEL_TEXT)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('未配置与无卡引导文案符合任务书口径', () => {
    expect(TAVERN_RUN_PANEL_TEXT.noCards).toBe('先到『酒馆卡片』页签创建角色卡')
    expect(TAVERN_RUN_PANEL_TEXT.notConfigured).toContain('模型设置')
    expect(TAVERN_RUN_PANEL_TEXT.intro).toBe('预览版简化实现：单会话、无流式输出、无自动摘要记忆')
  })
})

describe('tavern-run 消息组装', () => {
  it('makeMessage 生成 msg_ 前缀 id 与 ISO 时间戳', () => {
    const record = makeMessage('user', '  推门而入。  ')
    expect(record.id.startsWith('msg_')).toBe(true)
    expect(record.role).toBe('user')
    expect(record.content).toBe('  推门而入。  ')
    expect(Number.isNaN(new Date(record.createdAt).getTime())).toBe(false)
  })

  it('appendMessage 追加不改传入数组', () => {
    const base = [message()]
    const added = makeMessage('assistant', '回应')
    const next = appendMessage(base, added)
    expect(base).toHaveLength(1)
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(base[0])
    expect(next[1]).toBe(added)
  })

  it('formatMessageTime 输出 MM-dd HH:mm（按本地时区计算期望值）', () => {
    const iso = '2026-06-01T08:05:00.000Z'
    const date = new Date(iso)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    expect(formatMessageTime(iso)).toBe(expected)
  })

  it('formatMessageTime 无效时间返回空串', () => {
    expect(formatMessageTime('不是时间')).toBe('')
    expect(formatMessageTime('')).toBe('')
  })

  it('roleLabel：user→你、assistant→卡名（缺省「角色」）、system→系统', () => {
    expect(roleLabel('user', null)).toBe('你')
    expect(roleLabel('assistant', '林晚')).toBe('林晚')
    expect(roleLabel('assistant', null)).toBe('角色')
    expect(roleLabel('assistant', '')).toBe('角色')
    expect(roleLabel('system', '林晚')).toBe('系统')
  })
})

describe('tavern-run AI 请求组装', () => {
  it('toAiMessages 截取最近 N 条、剔除 system、收敛为 {role, content}', () => {
    const list = [
      message({ id: 'msg_a', role: 'user', content: '一' }),
      message({ id: 'msg_b', role: 'assistant', content: '二' }),
      message({ id: 'msg_c', role: 'system', content: '系统' }),
      message({ id: 'msg_d', role: 'user', content: '三' }),
    ]
    const result = toAiMessages(list, 3)
    expect(result).toEqual([
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' },
    ])
  })

  it('toAiMessages limit<=0 返回空数组', () => {
    expect(toAiMessages([message()], 0)).toEqual([])
    expect(toAiMessages([message()], -1)).toEqual([])
  })

  it('toAiMessages 不改传入数组', () => {
    const list = [message(), message({ id: 'msg_b', role: 'assistant' })]
    const snapshot = [...list]
    toAiMessages(list, 1)
    expect(list).toEqual(snapshot)
  })

  it('buildChatRequest 组装系统提示、上下文与采样参数', () => {
    const request = buildChatRequest(
      cardRecord(),
      [worldEntry()],
      [
        message({ id: 'msg_a', role: 'user', content: '行动一' }),
        message({ id: 'msg_b', role: 'assistant', content: '回应一' }),
        message({ id: 'msg_c', role: 'system', content: '系统旁白' }),
      ],
      settingsRecord(),
    )
    expect(request.system).toContain('林晚')
    expect(request.system).toContain('魔法学院二年级学生')
    expect(request.system).toContain('沉静、好奇')
    expect(request.system).toContain('始终以角色身份回复')
    expect(request.system).toContain('世界书设定')
    expect(request.system).toContain('图书馆的旧怀表会在午夜报出真实时间。')
    expect(request.messages).toEqual([
      { role: 'user', content: '行动一' },
      { role: 'assistant', content: '回应一' },
    ])
    expect(request.maxTokens).toBe(2048)
    expect(request.temperature).toBe(0.7)
  })

  it('buildChatRequest 无卡且无世界书时不发 system 字段', () => {
    const request = buildChatRequest(null, [], [message()], settingsRecord())
    expect('system' in request).toBe(false)
    expect(request.messages).toEqual([{ role: 'user', content: '我推开了图书馆的门。' }])
  })

  it('buildChatRequest 尊重 settings 的采样参数与上下文窗口', () => {
    const list = Array.from({ length: 30 }, (_, index) =>
      message({ id: `msg_${String(index).padStart(2, '0')}`, content: `第${index}条` }),
    )
    const request = buildChatRequest(
      cardRecord(),
      [worldEntry()],
      list,
      settingsRecord({ temperature: 1.1, maxTokens: 512, contextMessages: 5 }),
    )
    expect(request.temperature).toBe(1.1)
    expect(request.maxTokens).toBe(512)
    expect(request.messages).toHaveLength(5)
    expect(request.messages[0].content).toBe('第25条')
    expect(request.messages[4].content).toBe('第29条')
  })
})

describe('tavern-run 选中卡解析', () => {
  const first = cardRecord({ id: 'card_a', name: '林晚' })
  const second = cardRecord({ id: 'card_b', name: '苏橙' })

  it('cardId 命中返回该卡', () => {
    expect(resolveSelectedCard([first, second], 'card_b')).toBe(second)
  })

  it('cardId 未命中或为 null 回落第一张', () => {
    expect(resolveSelectedCard([first, second], '不存在')).toBe(first)
    expect(resolveSelectedCard([first, second], null)).toBe(first)
  })

  it('空列表返回 null', () => {
    expect(resolveSelectedCard([], 'card_a')).toBeNull()
    expect(resolveSelectedCard([], null)).toBeNull()
  })
})

describe('tavern-run 库值防御解析', () => {
  it('parseCards 解析合法条目', () => {
    const result = parseCards([cardRecord()])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(cardRecord())
  })

  it('parseCards 丢弃坏数据、补齐缺失字段', () => {
    const result = parseCards([
      null,
      '字符串',
      42,
      {},
      { id: '', name: '无名' },
      { id: 'card_x' },
      { id: 'card_y', name: '只有名字' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('card_y')
    expect(result[0].name).toBe('只有名字')
    expect(result[0].description).toBe('')
    expect(result[0].personality).toBe('')
    expect(result[0].firstMessage).toBe('')
    expect(result[0].tags).toEqual([])
  })

  it('parseCards 非数组返回空', () => {
    expect(parseCards(undefined)).toEqual([])
    expect(parseCards(null)).toEqual([])
    expect(parseCards('items')).toEqual([])
    expect(parseCards({ items: [] })).toEqual([])
  })

  it('parseWorldEntries 解析合法条目', () => {
    const result = parseWorldEntries([worldEntry()])
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('图书馆的旧怀表会在午夜报出真实时间。')
    expect(result[0].enabled).toBe(true)
  })

  it('parseWorldEntries 丢弃坏数据、enabled 严格布尔、补齐默认值', () => {
    const result = parseWorldEntries([
      null,
      { id: 'w_x', content: '缺 enabled' },
      { id: 'w_y', content: 'enabled 是数字', enabled: 1 },
      { id: 'w_z', content: '合法', enabled: true, keywords: '关键词', order: 3 },
    ])
    // 只有非对象/缺 id/缺 content 的条目整条丢弃；enabled 非 true 一律收敛为禁用但保留条目。
    expect(result).toHaveLength(3)
    expect(result[0].id).toBe('w_x')
    expect(result[0].enabled).toBe(false)
    expect(result[1].id).toBe('w_y')
    expect(result[1].enabled).toBe(false)
    expect(result[2].id).toBe('w_z')
    expect(result[2].enabled).toBe(true)
    expect(result[2].keywords).toBe('关键词')
    expect(result[2].order).toBe(3)
  })

  it('parseWorldEntries 非数组返回空', () => {
    expect(parseWorldEntries('坏')).toEqual([])
    expect(parseWorldEntries(undefined)).toEqual([])
  })
})

describe('tavern-run 设置与标题兜底', () => {
  it('resolveSettings 缺字段/坏类型回落默认值', () => {
    const defaults = createDefaultPanelValues().settings
    expect(resolveSettings(undefined)).toEqual(defaults)
    expect(resolveSettings(null)).toEqual(defaults)
    expect(resolveSettings('坏')).toEqual(defaults)
    expect(resolveSettings({ temperature: '高温', maxTokens: Number.NaN, contextMessages: 0 })).toEqual(defaults)
  })

  it('resolveSettings 库值覆盖默认值', () => {
    const result = resolveSettings({ temperature: 0.9, maxTokens: 512, mode: 'story' })
    expect(result.temperature).toBe(0.9)
    expect(result.maxTokens).toBe(512)
    expect(result.mode).toBe('story')
    expect(result.contextMessages).toBe(20)
    expect(result.advanced).toEqual({})
  })

  it('resolveSettings advanced 只保留字符串值', () => {
    expect(resolveSettings({ advanced: { a: 'x', b: 2 } }).advanced).toEqual({ a: 'x' })
    expect(resolveSettings({ advanced: null }).advanced).toEqual({})
    expect(resolveSettings({ advanced: [1] }).advanced).toEqual({})
  })

  it('resolveSessionTitle 非空字符串才采用，否则默认标题', () => {
    expect(resolveSessionTitle('决战魔塔')).toBe('决战魔塔')
    expect(resolveSessionTitle('   ')).toBe('新会话')
    expect(resolveSessionTitle('')).toBe('新会话')
    expect(resolveSessionTitle(42)).toBe('新会话')
    expect(resolveSessionTitle(null)).toBe('新会话')
  })
})

describe('tavern-run 文案行与提示', () => {
  it('messageCountLine / settingsLine', () => {
    expect(messageCountLine(3)).toBe('共 3 条消息')
    expect(messageCountLine(0)).toBe('共 0 条消息')
    expect(settingsLine(settingsRecord())).toBe('上下文：最近 20 条 · 温度：0.7 · 最大输出：2048')
  })

  it('failureNotice：未配置走引导文案，其它如实显示「错误码：消息」', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '任意')).toBe(TAVERN_RUN_PANEL_TEXT.notConfigured)
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('AI_TIMEOUT：请求超时')
    expect(failureNotice('AI_RATE_LIMITED', '太快了')).toBe('AI_RATE_LIMITED：太快了')
  })
})

describe('tavern-run 保存状态', () => {
  it('saving → error → dirty → saved', () => {
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })
})
