/**
 * 背景设定面板（tavern-world）纯逻辑单测（node 环境，不挂载组件）。
 *
 * 覆盖：常量、关键词解析、内容摘要、条目构造/校验、列表操作、库值兜底、
 * 总览行/保存状态、AI 扩写请求拼装与响应解析。
 */
import { describe, expect, it } from 'vitest'

import type { TavernWorldEntry } from '../../src/renderer/tavern/types.js'
import {
  AI_EXPAND_MAX_TOKENS,
  BRIEF_MAX_CHARS,
  CONTENT_REQUIRED,
  KEYWORDS_REQUIRED,
  TAVERN_WORLD_PANEL_TEXT,
  briefContent,
  buildAiExpandRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findEntryById,
  formatKeywords,
  makeEntry,
  normalizeEntries,
  overviewLine,
  panelSaveStatus,
  parseAiExpanded,
  parseKeywords,
  reindexEntries,
  removeEntry,
  toggleEntryEnabled,
  upsertEntry,
  validateEntryForm,
} from '../../src/renderer/panels/tavern-world-model.js'

function seedEntry(overrides: Partial<TavernWorldEntry> = {}): TavernWorldEntry {
  return {
    id: 'world_aaaaaaaaaaaa',
    keywords: '魔法学院,灵脉',
    content: '一座漂浮在云海上的魔法学院，灵脉贯穿主塔。',
    enabled: true,
    order: 0,
    ...overrides,
  }
}

describe('常量与默认值', () => {
  it('AI 扩写 maxTokens 写死 2048', () => {
    expect(AI_EXPAND_MAX_TOKENS).toBe(2048)
  })

  it('内容摘要截断长度是 40', () => {
    expect(BRIEF_MAX_CHARS).toBe(40)
  })

  it('顶部说明条是任务契约要求的固定文案', () => {
    expect(TAVERN_WORLD_PANEL_TEXT.intro).toBe('启用条目的关键词会注入酒馆对话的系统提示词。')
  })

  it('默认面板数据是空列表 + 空时间戳', () => {
    expect(createDefaultPanelValues()).toEqual({ items: [], updatedAt: '' })
  })
})

describe('关键词解析与回显', () => {
  it('按英文逗号切分', () => {
    expect(parseKeywords('魔法学院,灵脉,星陨节')).toEqual(['魔法学院', '灵脉', '星陨节'])
  })

  it('按中文逗号与顿号混着切', () => {
    expect(parseKeywords('魔法学院，灵脉、星陨节')).toEqual(['魔法学院', '灵脉', '星陨节'])
  })

  it('trim 去空去重保序', () => {
    expect(parseKeywords(' a , , b ,a ')).toEqual(['a', 'b'])
  })

  it('空输入得到空数组', () => {
    expect(parseKeywords('')).toEqual([])
    expect(parseKeywords('，，、')).toEqual([])
  })

  it('回显用中文逗号连接', () => {
    expect(formatKeywords(['魔法学院', '灵脉'])).toBe('魔法学院，灵脉')
    expect(formatKeywords([])).toBe('')
  })
})

describe('内容摘要', () => {
  it('短内容原样返回（去首尾空白）', () => {
    expect(briefContent('  一座学院  ')).toBe('一座学院')
  })

  it('超长按 40 个码点截断并补省略号', () => {
    expect(briefContent('a'.repeat(45))).toBe(`${'a'.repeat(40)}…`)
  })

  it('截断不劈开代理对', () => {
    const result = briefContent('𠮷'.repeat(45))
    expect([...result].length).toBe(BRIEF_MAX_CHARS + 1)
    expect(result.endsWith('…')).toBe(true)
  })

  it('恰好等于上限时不补省略号', () => {
    expect(briefContent('a'.repeat(BRIEF_MAX_CHARS))).toBe('a'.repeat(BRIEF_MAX_CHARS))
  })
})

describe('条目构造与校验', () => {
  it('新建条目用 newTavernId("world") 生成 id、trim 字段、默认顺序', () => {
    const entry = makeEntry({ keywords: ' 魔法学院 ', content: ' 内容 ', enabled: true })
    expect(entry.id.startsWith('world_')).toBe(true)
    expect(entry.id.length).toBeGreaterThan('world_'.length)
    expect(entry.keywords).toBe('魔法学院')
    expect(entry.content).toBe('内容')
    expect(entry.enabled).toBe(true)
    expect(entry.order).toBe(0)
  })

  it('新建条目可以指定 order', () => {
    const entry = makeEntry({ keywords: 'a', content: 'b', enabled: false }, null, 3)
    expect(entry.order).toBe(3)
    expect(entry.enabled).toBe(false)
  })

  it('编辑条目保留 id 与 order，更新字段', () => {
    const existing = seedEntry({ order: 2 })
    const next = makeEntry(
      { keywords: '星陨节', content: '新内容', enabled: false },
      existing,
    )
    expect(next.id).toBe(existing.id)
    expect(next.order).toBe(2)
    expect(next.keywords).toBe('星陨节')
    expect(next.content).toBe('新内容')
    expect(next.enabled).toBe(false)
  })

  it('关键词必填', () => {
    expect(validateEntryForm({ keywords: '', content: '内容', enabled: true })).toBe(
      KEYWORDS_REQUIRED,
    )
    expect(validateEntryForm({ keywords: '，，', content: '内容', enabled: true })).toBe(
      KEYWORDS_REQUIRED,
    )
    expect(KEYWORDS_REQUIRED.length).toBeGreaterThan(0)
  })

  it('内容必填', () => {
    expect(validateEntryForm({ keywords: '魔法学院', content: '', enabled: true })).toBe(
      CONTENT_REQUIRED,
    )
    expect(validateEntryForm({ keywords: '魔法学院', content: '   ', enabled: true })).toBe(
      CONTENT_REQUIRED,
    )
  })

  it('合法输入返回 null', () => {
    expect(validateEntryForm({ keywords: '魔法学院', content: '内容', enabled: true })).toBeNull()
  })
})

describe('列表操作（order = 数组下标）', () => {
  it('reindexEntries 把 order 归一化成下标', () => {
    const items = [seedEntry({ order: 5 }), seedEntry({ id: 'world_bbbbbbbbbbbb', order: 9 })]
    expect(reindexEntries(items).map((entry) => entry.order)).toEqual([0, 1])
  })

  it('upsertEntry 新条目追加到末尾', () => {
    const items = [seedEntry()]
    const added = seedEntry({ id: 'world_bbbbbbbbbbbb', keywords: '星陨节', order: 99 })
    const next = upsertEntry(items, added)
    expect(next.length).toBe(2)
    expect(next[1]?.id).toBe(added.id)
    expect(next.map((entry) => entry.order)).toEqual([0, 1])
  })

  it('upsertEntry 已存在的原位替换', () => {
    const second = seedEntry({ id: 'world_bbbbbbbbbbbb', keywords: '星陨节', order: 1 })
    const items = [seedEntry(), second]
    const replaced = seedEntry({ keywords: '灵脉', content: '替换后的内容' })
    const next = upsertEntry(items, replaced)
    expect(next.length).toBe(2)
    expect(next[0]?.keywords).toBe('灵脉')
    expect(next[1]).toBe(second)
  })

  it('removeEntry 删除并重排 order', () => {
    const second = seedEntry({ id: 'world_bbbbbbbbbbbb', order: 1 })
    const third = seedEntry({ id: 'world_cccccccccccc', order: 2 })
    const next = removeEntry([seedEntry(), second, third], seedEntry().id)
    expect(next.map((entry) => entry.id)).toEqual([second.id, third.id])
    expect(next.map((entry) => entry.order)).toEqual([0, 1])
  })

  it('removeEntry 删不存在的 id 返回等价数组', () => {
    const items = [seedEntry()]
    expect(removeEntry(items, 'world_nopeeeeeeeee').map((entry) => entry.id)).toEqual([items[0]?.id])
  })

  it('toggleEntryEnabled 只翻目标条目', () => {
    const second = seedEntry({ id: 'world_bbbbbbbbbbbb', enabled: false, order: 1 })
    const next = toggleEntryEnabled([seedEntry(), second], second.id, true)
    expect(next[0]?.enabled).toBe(true)
    expect(next[1]?.enabled).toBe(true)
    expect(toggleEntryEnabled([seedEntry()], seedEntry().id, false)[0]?.enabled).toBe(false)
  })

  it('findEntryById 找得到与找不到', () => {
    const entry = seedEntry()
    expect(findEntryById([entry], entry.id)).toBe(entry)
    expect(findEntryById([entry], 'world_nopeeeeeeeee')).toBeNull()
    expect(findEntryById([], 'world_nopeeeeeeeee')).toBeNull()
  })
})

describe('库值兜底（store.data 是 ShallowRef，库里可能存坏数据）', () => {
  it('非数组返回空列表', () => {
    expect(normalizeEntries(undefined)).toEqual([])
    expect(normalizeEntries(null)).toEqual([])
    expect(normalizeEntries('items')).toEqual([])
    expect(normalizeEntries({ items: [] })).toEqual([])
  })

  it('合法条目原样保留（含 enabled=false）', () => {
    const entry = seedEntry({ enabled: false })
    expect(normalizeEntries([entry])).toEqual([entry])
  })

  it('非条目形状的行丢弃（null/标量/数组）', () => {
    const items = normalizeEntries([seedEntry(), null, 'x', 42, []])
    expect(items.length).toBe(1)
    expect(items[0]?.id).toBe('world_aaaaaaaaaaaa')
  })

  it('非字符串字段补默认值', () => {
    const items = normalizeEntries([{ keywords: 1, content: 2 }])
    expect(items.length).toBe(1)
    expect(items[0]?.keywords).toBe('')
    expect(items[0]?.content).toBe('')
    expect(items[0]?.enabled).toBe(false)
  })

  it('缺字段补齐：缺 id 补新 id、缺文案补空串、enabled 缺省 false、order 归一化', () => {
    const items = normalizeEntries([
      { keywords: 'a', content: 'b', enabled: true },
      { id: 'world_bbbbbbbbbbbb' },
    ])
    expect(items[0]?.id.startsWith('world_')).toBe(true)
    expect(items[0]?.keywords).toBe('a')
    expect(items[0]?.enabled).toBe(true)
    expect(items[1]?.keywords).toBe('')
    expect(items[1]?.content).toBe('')
    expect(items[1]?.enabled).toBe(false)
    expect(items.map((entry) => entry.order)).toEqual([0, 1])
  })
})

describe('总览行与保存状态', () => {
  it('总览行带总数与启用数', () => {
    expect(overviewLine([])).toBe('共 0 条条目，已启用 0 条')
    expect(overviewLine([seedEntry(), seedEntry({ id: 'world_bbbbbbbbbbbb', enabled: false, order: 1 })])).toBe(
      '共 2 条条目，已启用 1 条',
    )
  })

  it('保存状态：saving 优先、其次 error、再次 dirty、否则 saved', () => {
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })

  it('fillTemplate 替换占位符，未知占位符原样保留', () => {
    expect(fillTemplate('删除「{keywords}」吗？', { keywords: '灵脉' })).toBe('删除「灵脉」吗？')
    expect(fillTemplate('删除「{keywords}」吗？', {})).toBe('删除「{keywords}」吗？')
  })
})

describe('AI 扩写：请求拼装', () => {
  it('maxTokens 传 2048，单条 user 消息带关键词与内容', () => {
    const entry = seedEntry()
    const request = buildAiExpandRequest(entry)
    expect(request.maxTokens).toBe(2048)
    expect(request.messages.length).toBe(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toContain('魔法学院,灵脉')
    expect(request.messages[0]?.content).toContain('一座漂浮在云海上的魔法学院，灵脉贯穿主塔。')
    expect(request.system).toContain('世界设定')
  })
})

describe('AI 扩写：响应解析（失败不落库）', () => {
  it('空结果视为解析失败', () => {
    expect(parseAiExpanded(null)).toBeNull()
    expect(parseAiExpanded(undefined)).toBeNull()
    expect(parseAiExpanded('')).toBeNull()
    expect(parseAiExpanded('   ')).toBeNull()
  })

  it('正文 trim 后原样返回', () => {
    expect(parseAiExpanded('  扩写后的设定  ')).toBe('扩写后的设定')
  })

  it('剥掉代码围栏', () => {
    expect(parseAiExpanded('```json\n扩写后的设定\n```')).toBe('扩写后的设定')
    expect(parseAiExpanded('```\n扩写后的设定\n```')).toBe('扩写后的设定')
    expect(parseAiExpanded('```text\n扩写后的设定\n```')).toBe('扩写后的设定')
  })
})

describe('AI 扩写：失败文案', () => {
  it('未配置模型走引导文案', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '测试桩：未配置模型')).toBe(
      TAVERN_WORLD_PANEL_TEXT.notConfigured,
    )
  })

  it('其它错误码带脱敏 message', () => {
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('扩写失败：请求超时')
  })
})
