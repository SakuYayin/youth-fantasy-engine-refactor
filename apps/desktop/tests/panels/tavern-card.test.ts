/**
 * 角色卡片面板（tavern-card-model.ts）纯逻辑测试：文案常量 / 表单校验 /
 * 标签解析 / 记录增删改 / 保存状态推导 / AI 请求组装与结果解析。
 *
 * 纯 node 环境：被测模块无 Vue、无 DOM、无 node:*（newTavernId 走 globalThis.crypto）。
 */
import { describe, expect, it } from 'vitest'

import {
  AI_CARD_MAX_TOKENS,
  BRIEF_MAX_CHARS,
  TAVERN_CARD_PANEL_TEXT,
  briefDescription,
  buildAiCardRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findCardById,
  formatTags,
  makeCard,
  overviewLine,
  panelSaveStatus,
  parseAiCard,
  parseTags,
  removeCard,
  upsertCard,
  validateCardForm,
} from '../../src/renderer/panels/tavern-card-model.js'
import type { TavernCardRecord } from '../../src/renderer/tavern/types.js'

/** 记录夹具：与 TavernCardRecord 同构（可整体传入 makeCard 的 existing）。 */
function card(input: Partial<TavernCardRecord> = {}): TavernCardRecord {
  return {
    id: input.id ?? 'card_fixture1',
    name: input.name ?? '林晚',
    description: input.description ?? '魔法学院二年级学生',
    personality: input.personality ?? '沉静、好奇',
    firstMessage: input.firstMessage ?? '你在图书馆做什么？',
    tags: input.tags ?? ['魔法', '少女'],
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-06-01T00:00:00.000Z',
  }
}

describe('角色卡片：常量与文案', () => {
  it('AI 输出上限固定 2048（任务书约定）', () => {
    expect(AI_CARD_MAX_TOKENS).toBe(2048)
  })

  it('列表简述截断长度为 40 字', () => {
    expect(BRIEF_MAX_CHARS).toBe(40)
  })

  it('面板文案全部非空字符串（可见文本 ⊆ 常量）', () => {
    for (const [key, value] of Object.entries(TAVERN_CARD_PANEL_TEXT)) {
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('默认面板数据：空 items 数组', () => {
    expect(createDefaultPanelValues()).toEqual({ items: [] })
  })

  it('概览行文案', () => {
    expect(overviewLine(0)).toBe('共 0 张角色卡')
    expect(overviewLine(3)).toBe('共 3 张角色卡')
  })
})

describe('角色卡片：标签解析与回显', () => {
  it('parseTags：英文逗号 / 中文逗号 / 顿号都算分隔符', () => {
    expect(parseTags('魔法,少女')).toEqual(['魔法', '少女'])
    expect(parseTags('魔法，少女')).toEqual(['魔法', '少女'])
    expect(parseTags('魔法、少女')).toEqual(['魔法', '少女'])
    expect(parseTags('魔法,少女、学姐')).toEqual(['魔法', '少女', '学姐'])
  })

  it('parseTags：去首尾空白、去空段、去重（保留首次出现顺序）', () => {
    expect(parseTags(' 魔法 ,  少女 ,,、')).toEqual(['魔法', '少女'])
    expect(parseTags('魔法,魔法,少女,魔法')).toEqual(['魔法', '少女'])
  })

  it('parseTags：空输入返回空数组', () => {
    expect(parseTags('')).toEqual([])
    expect(parseTags('  ,,、')).toEqual([])
  })

  it('formatTags：中文逗号连接，与 parseTags 可往返', () => {
    const tags = ['魔法', '少女', '学姐']
    expect(formatTags(tags)).toBe('魔法，少女，学姐')
    expect(parseTags(formatTags(tags))).toEqual(tags)
  })

  it('formatTags：空数组返回空串', () => {
    expect(formatTags([])).toBe('')
  })
})

describe('角色卡片：列表简述', () => {
  it('不足上限时原样（trim 后）返回', () => {
    expect(briefDescription('  短描述  ')).toBe('短描述')
    expect(briefDescription('一'.repeat(BRIEF_MAX_CHARS))).toBe('一'.repeat(BRIEF_MAX_CHARS))
  })

  it('超上限时按码点截断并加省略号', () => {
    const long = '林'.repeat(BRIEF_MAX_CHARS + 10)
    expect(briefDescription(long)).toBe('林'.repeat(BRIEF_MAX_CHARS) + '…')
    // 代理对（emoji）按码点截取，不产生半个字符；用码点数断言（.length 是 UTF-16 单元数）。
    expect([...briefDescription('🐉'.repeat(BRIEF_MAX_CHARS + 3))].length).toBe(BRIEF_MAX_CHARS + 1)
  })
})

describe('角色卡片：表单校验', () => {
  it('名称为空（含纯空白）返回「名称不能为空。」', () => {
    expect(validateCardForm({ name: '' })).toBe(TAVERN_CARD_PANEL_TEXT.nameRequired)
    expect(validateCardForm({ name: '   ' })).toBe(TAVERN_CARD_PANEL_TEXT.nameRequired)
  })

  it('名称非空返回 null（通过）', () => {
    expect(validateCardForm({ name: ' 林晚 ' })).toBeNull()
  })
})

describe('角色卡片：记录组装 makeCard', () => {
  it('新建：id 用 newTavernId("card")（card_ 前缀）、createdAt/updatedAt 用 tavernNow()、文本 trim、tags 拷贝', () => {
    const tags = ['魔法', '少女']
    const made = makeCard(
      { name: ' 林晚 ', description: ' 描述 ', personality: ' 性格 ', firstMessage: ' 开场白 ', tags },
      null,
    )
    expect(made.id.startsWith('card_')).toBe(true)
    expect(made.name).toBe('林晚')
    expect(made.description).toBe('描述')
    expect(made.personality).toBe('性格')
    expect(made.firstMessage).toBe('开场白')
    expect(made.tags).toEqual(tags)
    expect(made.tags).not.toBe(tags)
    expect(made.createdAt).toBe(made.updatedAt)
    // ISO 时间戳（与契约 UtcTimestamp 同形）。
    expect(Number.isNaN(Date.parse(made.createdAt))).toBe(false)
  })

  it('编辑：保留 id 与 createdAt、刷新 updatedAt', () => {
    const existing = card()
    const made = makeCard(
      { name: '新名', description: '', personality: '', firstMessage: '', tags: [] },
      existing,
    )
    expect(made.id).toBe(existing.id)
    expect(made.createdAt).toBe(existing.createdAt)
    expect(made.updatedAt).not.toBe(existing.updatedAt)
  })

  it('undefined 与 null 同样按新建处理', () => {
    const byUndefined = makeCard({ name: '甲', description: '', personality: '', firstMessage: '', tags: [] })
    const byNull = makeCard({ name: '乙', description: '', personality: '', firstMessage: '', tags: [] }, null)
    expect(byUndefined.id.startsWith('card_')).toBe(true)
    expect(byNull.id.startsWith('card_')).toBe(true)
    expect(byUndefined.id).not.toBe(byNull.id)
  })
})

describe('角色卡片：列表增删改（不改传入数组）', () => {
  it('findCardById：命中返回卡片，未命中返回 null', () => {
    const items = [card(), card({ id: 'card_two', name: '苏橙' })]
    expect(findCardById(items, 'card_two')?.name).toBe('苏橙')
    expect(findCardById(items, 'card_missing')).toBeNull()
    expect(findCardById([], 'card_two')).toBeNull()
  })

  it('upsertCard：新卡追加到末尾，已有卡原位替换，传入数组不被改', () => {
    const first = card()
    const second = card({ id: 'card_two', name: '苏橙' })
    const items = [first, second]
    const added = card({ id: 'card_three', name: '唐野' })
    const afterAdd = upsertCard(items, added)
    expect(afterAdd).toHaveLength(3)
    expect(afterAdd[2]?.name).toBe('唐野')
    expect(items).toHaveLength(2)

    const replaced = card({ id: 'card_two', name: '苏橙（改）' })
    const afterReplace = upsertCard(items, replaced)
    expect(afterReplace).toHaveLength(2)
    expect(afterReplace[1]?.name).toBe('苏橙（改）')
    expect(afterReplace[0]?.name).toBe('林晚')
    expect(items[1]?.name).toBe('苏橙')
  })

  it('removeCard：按 id 删除，传入数组不被改；无命中时内容不变', () => {
    const first = card()
    const second = card({ id: 'card_two', name: '苏橙' })
    const items = [first, second]
    const after = removeCard(items, first.id)
    expect(after).toEqual([second])
    expect(items).toHaveLength(2)
    expect(removeCard(items, 'card_missing')).toHaveLength(2)
  })
})

describe('角色卡片：保存状态推导', () => {
  it('saving 优先，其次 error，再次 dirty，否则 saved', () => {
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })
})

describe('角色卡片：文案占位符', () => {
  it('fillTemplate：{key} 替换、无对应值原样保留', () => {
    expect(fillTemplate('确定删除「{name}」吗？', { name: '林晚' })).toBe('确定删除「林晚」吗？')
    expect(fillTemplate('确定删除「{name}」吗？', {})).toBe('确定删除「{name}」吗？')
    expect(fillTemplate('生成失败：{message}', { message: '网络超时' })).toBe('生成失败：网络超时')
  })
})

describe('角色卡片：AI 请求组装', () => {
  it('system 要求只返回一个 JSON 对象，且列出五个字段', () => {
    const request = buildAiCardRequest([])
    expect(request.system).toBeDefined()
    expect(request.system).toContain('JSON')
    for (const field of ['name', 'description', 'personality', 'firstMessage', 'tags']) {
      expect(request.system).toContain(field)
    }
  })

  it('messages 为单条 user 消息，maxTokens 固定 2048', () => {
    const request = buildAiCardRequest(['林晚'])
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.maxTokens).toBe(AI_CARD_MAX_TOKENS)
  })

  it('已有卡名作为「避免重复」上下文；没有卡时允许任意题材', () => {
    expect(buildAiCardRequest(['林晚', '苏橙']).messages[0]?.content).toContain('林晚、苏橙')
    expect(buildAiCardRequest([]).messages[0]?.content).toContain('任意题材')
  })
})

describe('角色卡片：AI 结果解析', () => {
  const VALID = JSON.stringify({
    name: '唐野',
    description: '游历四方的剑客',
    personality: '豪爽',
    firstMessage: '你醒了？',
    tags: ['剑客', '旅人'],
  })

  it('合法 JSON 解析出五个字段（缺失字段宽松兜底空值）', () => {
    expect(parseAiCard(VALID)).toEqual({
      name: '唐野',
      description: '游历四方的剑客',
      personality: '豪爽',
      firstMessage: '你醒了？',
      tags: ['剑客', '旅人'],
    })
    expect(parseAiCard('{"name":"唐野"}')).toEqual({
      name: '唐野',
      description: '',
      personality: '',
      firstMessage: '',
      tags: [],
    })
  })

  it('容忍代码块标记与前后缀文字', () => {
    const fenced = '```json\n' + VALID + '\n```'
    expect(parseAiCard(fenced)).toEqual({
      name: '唐野',
      description: '游历四方的剑客',
      personality: '豪爽',
      firstMessage: '你醒了？',
      tags: ['剑客', '旅人'],
    })
    expect(parseAiCard(`好的，这是角色卡：${VALID} 请查收。`)?.name).toBe('唐野')
  })

  it('标签：字符串走逗号解析，数组逐项取字符串并去空去重', () => {
    expect(parseAiCard('{"name":"甲","tags":"魔法, 少女"}')?.tags).toEqual(['魔法', '少女'])
    expect(parseAiCard('{"name":"甲","tags":["魔法","",2,"魔法","少女"]}')?.tags).toEqual(['魔法', '2', '少女'])
    expect(parseAiCard('{"name":"甲","tags":42}')?.tags).toEqual([])
  })

  it('name 缺失 / 空白 / 非字符串 → null（调用方不落库）', () => {
    expect(parseAiCard('{"description":"没有名字"}')).toBeNull()
    expect(parseAiCard('{"name":"   "}')).toBeNull()
    expect(parseAiCard('{"name":[]}')).toBeNull()
  })

  it('整体不是 JSON / 不是对象 → null', () => {
    expect(parseAiCard('完全不是 JSON 的文本')).toBeNull()
    expect(parseAiCard('{"name":"断掉的 JSON"')).toBeNull()
    expect(parseAiCard('[1,2,3]')).toBeNull()
    expect(parseAiCard('null')).toBeNull()
  })
})

describe('角色卡片：AI 失败文案', () => {
  it('未配置 → 引导到「模型设置」页签', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '忽略细节')).toBe(TAVERN_CARD_PANEL_TEXT.notConfigured)
  })

  it('其它错误码 → 「生成失败：…」统一格式', () => {
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('生成失败：请求超时')
    expect(failureNotice('AI_RATE_LIMITED', '限流')).toBe('生成失败：限流')
  })
})
