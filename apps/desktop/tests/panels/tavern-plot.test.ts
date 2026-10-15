/**
 * 剧情推演面板（tavern-plot）纯逻辑单测。
 *
 * 覆盖：常量与文案、场景增删改/顺序归一化（不可变）、AI 请求拼装、AI 响应解析
 * （围栏/杂讯/数组容错）、保存状态机、模板填充与摘要截断。
 *
 * 纪律：纯 node 测试；tests/panels/ 子目录导入 src 必须上跳两级。
 */
import { describe, expect, it } from 'vitest'

import {
  AI_PLOT_MAX_TOKENS,
  BRIEF_MAX_CHARS,
  TAVERN_PLOT_PANEL_TEXT,
  briefDescription,
  buildAiContinueRequest,
  createDefaultPanelValues,
  extractJson,
  failureNotice,
  fillTemplate,
  findSceneById,
  makeScene,
  moveScene,
  orderedScenes,
  orderLabel,
  outlineText,
  overviewLine,
  parseAiPlot,
  panelSaveStatus,
  removeScene,
  upsertScene,
  validateSceneForm,
} from '../../src/renderer/panels/tavern-plot-model.js'
import type { TavernPlotSceneRecord } from '../../src/renderer/panels/tavern-plot-model.js'

/** 场景夹具工厂：默认 order = index。 */
function scene(input: Partial<TavernPlotSceneRecord> = {}, index = 0): TavernPlotSceneRecord {
  return {
    id: input.id ?? `plot_fix${String(index).padStart(2, '0')}`,
    title: input.title ?? `场景${index + 1}`,
    brief: input.brief ?? '',
    messages: input.messages ?? [],
    order: input.order ?? index,
    createdAt: input.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-01-01T00:00:00.000Z',
  }
}

describe('tavern-plot 常量与文案', () => {
  it('AI_PLOT_MAX_TOKENS 是 2048（任务要求）', () => {
    expect(AI_PLOT_MAX_TOKENS).toBe(2048)
  })

  it('BRIEF_MAX_CHARS 是 40（列表摘要宽度）', () => {
    expect(BRIEF_MAX_CHARS).toBe(40)
  })

  it('文案常量全非空字符串', () => {
    for (const value of Object.values(TAVERN_PLOT_PANEL_TEXT)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('顶部说明含必写的「场景按顺序拼进酒馆对话的系统提示词」', () => {
    expect(TAVERN_PLOT_PANEL_TEXT.intro).toContain('场景按顺序拼进酒馆对话的系统提示词')
  })

  it('createDefaultPanelValues 返回空 items', () => {
    expect(createDefaultPanelValues()).toEqual({ items: [] })
  })
})

describe('tavern-plot 文案工具', () => {
  it('fillTemplate 替换 {key}，缺值占位符原样保留', () => {
    expect(fillTemplate('已把「{name}」追加为新场景。', { name: '暗巷' })).toBe(
      '已把「暗巷」追加为新场景。',
    )
    expect(fillTemplate('续写失败：{message}', {})).toBe('续写失败：{message}')
    expect(fillTemplate('无占位符', {})).toBe('无占位符')
  })

  it('briefDescription：trim、截断加省略号', () => {
    expect(briefDescription('  少年捡到徽章。 ')).toBe('少年捡到徽章。')
    const long = '一'.repeat(BRIEF_MAX_CHARS + 5)
    expect(briefDescription(long)).toBe(`${'一'.repeat(BRIEF_MAX_CHARS)}…`)
    expect(briefDescription('一'.repeat(BRIEF_MAX_CHARS)).length).toBe(BRIEF_MAX_CHARS)
  })

  it('overviewLine 与 orderLabel（中文）', () => {
    expect(overviewLine(0)).toBe('共 0 个场景')
    expect(overviewLine(3)).toBe('共 3 个场景')
    expect(orderLabel(1)).toBe('第 1 场')
    expect(orderLabel(2)).toBe('第 2 场')
  })
})

describe('tavern-plot 表单校验与场景构造', () => {
  it('validateSceneForm：标题必填（空/空白报错，通过返回 null）', () => {
    expect(validateSceneForm({ title: '', brief: '' })).toBe(TAVERN_PLOT_PANEL_TEXT.titleRequired)
    expect(validateSceneForm({ title: '   ', brief: '' })).toBe(TAVERN_PLOT_PANEL_TEXT.titleRequired)
    expect(validateSceneForm({ title: '第一幕', brief: '' })).toBeNull()
  })

  it('makeScene 新建：newTavernId 前缀 plot_、tavernNow 时间戳、messages 留空、trim', () => {
    const made = makeScene({ title: '  第一幕  ', brief: ' 少年捡到徽章。 ' })
    expect(made.id.startsWith('plot_')).toBe(true)
    expect(made.id.length).toBeGreaterThan('plot_'.length)
    expect(made.title).toBe('第一幕')
    expect(made.brief).toBe('少年捡到徽章。')
    expect(made.messages).toEqual([])
    expect(made.order).toBe(0)
    expect(made.createdAt).not.toBe('')
    expect(made.updatedAt).not.toBe('')
    expect(Number.isNaN(Date.parse(made.createdAt))).toBe(false)
    expect(Number.isNaN(Date.parse(made.updatedAt))).toBe(false)
  })

  it('makeScene 编辑：保留 id/createdAt/order，刷新 updatedAt，messages 复制不共用引用', () => {
    const existing = scene({ id: 'plot_keep', brief: '', createdAt: '2026-01-01T00:00:00.000Z' }, 1)
    const made = makeScene({ title: '改过的标题', brief: '新简述' }, existing)
    expect(made.id).toBe('plot_keep')
    expect(made.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(made.order).toBe(1)
    expect(made.title).toBe('改过的标题')
    expect(made.brief).toBe('新简述')
    expect(made.messages).not.toBe(existing.messages)
    expect(made.messages).toEqual(existing.messages)
    expect(Date.parse(made.updatedAt)).toBeGreaterThanOrEqual(Date.parse(made.createdAt))
  })

  it('findSceneById：找到/找不到返回 null', () => {
    const items = [scene({}, 0), scene({}, 1)]
    expect(findSceneById(items, 'plot_fix00')?.id).toBe('plot_fix00')
    expect(findSceneById(items, 'plot_missing')).toBeNull()
  })
})

describe('tavern-plot 顺序与增删改（不可变）', () => {
  it('orderedScenes：按 order 排序并归一化为数组下标，不改传入数组', () => {
    const scrambled = [
      scene({ id: 'plot_c', order: 2 }, 0),
      scene({ id: 'plot_a', order: 0 }, 1),
      scene({ id: 'plot_b', order: 1 }, 2),
    ]
    const ordered = orderedScenes(scrambled)
    expect(ordered.map((item) => item.id)).toEqual(['plot_a', 'plot_b', 'plot_c'])
    expect(ordered.map((item) => item.order)).toEqual([0, 1, 2])
    // 乱序的 order 值也被归一化
    const weird = [scene({ id: 'plot_x', order: 5 }, 0), scene({ id: 'plot_y', order: 1 }, 1)]
    const fixed = orderedScenes(weird)
    expect(fixed.map((item) => item.id)).toEqual(['plot_y', 'plot_x'])
    expect(fixed.map((item) => item.order)).toEqual([0, 1])
    // 不改传入数组
    expect(scrambled.map((item) => item.id)).toEqual(['plot_c', 'plot_a', 'plot_b'])
    expect(scrambled[0]?.order).toBe(2)
  })

  it('orderedScenes：order 并列时保持数组先后（稳定）', () => {
    const tied = [scene({ id: 'plot_x', order: 0 }, 0), scene({ id: 'plot_y', order: 0 }, 1)]
    const ordered = orderedScenes(tied)
    expect(ordered.map((item) => item.id)).toEqual(['plot_x', 'plot_y'])
    expect(ordered.map((item) => item.order)).toEqual([0, 1])
  })

  it('upsertScene：新场景追加末尾且 order = 下标，不改传入数组', () => {
    const items = [scene({ id: 'plot_a' }, 0)]
    const fresh = scene({ id: 'plot_new', order: 99 }, 0)
    const next = upsertScene(items, fresh)
    expect(next.map((item) => item.id)).toEqual(['plot_a', 'plot_new'])
    expect(next[1]?.order).toBe(1)
    expect(items).toHaveLength(1)
  })

  it('upsertScene：已有场景原位替换，order 归一化，不改传入数组', () => {
    const items = [scene({ id: 'plot_a' }, 0), scene({ id: 'plot_b' }, 1)]
    const edited = scene({ id: 'plot_a', title: '新标题', order: 42 }, 0)
    const next = upsertScene(items, edited)
    expect(next.map((item) => item.id)).toEqual(['plot_a', 'plot_b'])
    expect(next[0]?.title).toBe('新标题')
    expect(next[0]?.order).toBe(0)
    expect(items[0]?.title).toBe('场景1')
  })

  it('removeScene：删除并归一化剩余 order，不改传入数组', () => {
    const items = [scene({ id: 'plot_a' }, 0), scene({ id: 'plot_b' }, 1), scene({ id: 'plot_c' }, 2)]
    const next = removeScene(items, 'plot_b')
    expect(next.map((item) => item.id)).toEqual(['plot_a', 'plot_c'])
    expect(next.map((item) => item.order)).toEqual([0, 1])
    expect(items).toHaveLength(3)
  })

  it('moveScene：下移交换相邻场景，order 归一化，不改传入数组', () => {
    const items = [scene({ id: 'plot_a' }, 0), scene({ id: 'plot_b' }, 1), scene({ id: 'plot_c' }, 2)]
    const moved = moveScene(items, 'plot_a', 1)
    expect(moved?.map((item) => item.id)).toEqual(['plot_b', 'plot_a', 'plot_c'])
    expect(moved?.map((item) => item.order)).toEqual([0, 1, 2])
    expect(items.map((item) => item.id)).toEqual(['plot_a', 'plot_b', 'plot_c'])
  })

  it('moveScene：上移交换相邻场景', () => {
    const items = [scene({ id: 'plot_a' }, 0), scene({ id: 'plot_b' }, 1)]
    const moved = moveScene(items, 'plot_b', -1)
    expect(moved?.map((item) => item.id)).toEqual(['plot_b', 'plot_a'])
  })

  it('moveScene：越界与找不到返回 null（第一个上移/最后一个下移/未知 id）', () => {
    const items = [scene({ id: 'plot_a' }, 0), scene({ id: 'plot_b' }, 1)]
    expect(moveScene(items, 'plot_a', -1)).toBeNull()
    expect(moveScene(items, 'plot_b', 1)).toBeNull()
    expect(moveScene(items, 'plot_missing', 1)).toBeNull()
  })
})

describe('tavern-plot AI 请求拼装', () => {
  it('buildAiContinueRequest：maxTokens 2048、单条 user、system 要求只返回 JSON 对象', () => {
    const request = buildAiContinueRequest([scene({ title: '第一幕', brief: '少年捡到徽章' }, 0)])
    expect(request.maxTokens).toBe(2048)
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.system).toContain('JSON')
    expect(request.system).toContain('"title"')
    expect(request.system).toContain('"brief"')
    expect(request.system).toContain('不要返回数组')
  })

  it('buildAiContinueRequest：场景列表按顺序拼成编号大纲', () => {
    const request = buildAiContinueRequest([
      scene({ title: '第一幕', brief: '少年捡到徽章' }, 0),
      scene({ title: '第二幕', brief: '' }, 1),
    ])
    const user = request.messages[0]?.content ?? ''
    expect(user).toContain('1. 第一幕：少年捡到徽章')
    expect(user).toContain('2. 第二幕：（无简述）')
  })

  it('outlineText：空列表给引导文案', () => {
    expect(outlineText([])).toBe('（目前还没有场景，请直接构思第一场。）')
  })
})

describe('tavern-plot AI 响应解析', () => {
  it('extractJson：剥围栏与前后缀杂讯，截不到返回空串', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}')
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('好的：{"a":1} 希望有帮助')).toBe('{"a":1}')
    expect(extractJson('没有花括号')).toBe('')
  })

  it('parseAiPlot：合法对象', () => {
    expect(parseAiPlot('{"title": "第二幕", "brief": "暗巷追踪"}')).toEqual({
      title: '第二幕',
      brief: '暗巷追踪',
    })
  })

  it('parseAiPlot：围栏与前后缀杂讯', () => {
    expect(parseAiPlot('```json\n{"title": "第二幕", "brief": "暗巷追踪"}\n```')).toEqual({
      title: '第二幕',
      brief: '暗巷追踪',
    })
    expect(parseAiPlot('以下是推演：{"title": "第二幕", "brief": "暗巷追踪"} 请查收')).toEqual({
      title: '第二幕',
      brief: '暗巷追踪',
    })
  })

  it('parseAiPlot：AI 返回数组时取第一个对象元素', () => {
    expect(
      parseAiPlot('[{"title": "第一幕", "brief": "捡到徽章"}, {"title": "第二幕", "brief": "追踪"}]'),
    ).toEqual({ title: '第一幕', brief: '捡到徽章' })
  })

  it('parseAiPlot：brief 缺失兜底空串，数字宽松转字符串', () => {
    expect(parseAiPlot('{"title": "第二幕"}')).toEqual({ title: '第二幕', brief: '' })
    expect(parseAiPlot('{"title": "第二幕", "brief": 42}')).toEqual({ title: '第二幕', brief: '42' })
    expect(parseAiPlot('{"title": 7, "brief": "追踪"}')).toEqual({ title: '7', brief: '追踪' })
  })

  it('parseAiPlot：标题缺失/空白/非对象/非法 JSON 返回 null（不落库）', () => {
    expect(parseAiPlot('{"brief": "没有标题"}')).toBeNull()
    expect(parseAiPlot('{"title": "   ", "brief": "空白标题"}')).toBeNull()
    expect(parseAiPlot('"纯文本回复"')).toBeNull()
    expect(parseAiPlot('{"title": "未闭合')).toBeNull()
    expect(parseAiPlot('抱歉，我推演不出来。')).toBeNull()
  })
})

describe('tavern-plot 保存状态机与失败文案', () => {
  it('panelSaveStatus：saving > error > dirty > saved', () => {
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })

  it('failureNotice：未配置模型回引导文案，其余包「续写失败：」', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '测试桩：未配置模型')).toBe(
      TAVERN_PLOT_PANEL_TEXT.notConfigured,
    )
    expect(failureNotice('AI_TIMEOUT', '上游超时')).toBe('续写失败：上游超时')
  })
})
