import { describe, expect, it } from 'vitest'

import type { ChapterNodeView } from '../../src/renderer/app-state.js'
import {
  NODE_STATUS_LABELS,
  NODE_STATUS_ORDER,
  PLOT_PANEL_TEXT,
  buildSummaryRequest,
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
  collectChapters,
  createDefaultPanelData,
  createNode,
  failureNotice,
  formatNodeCount,
  groupNodesByChapter,
  isPlotNodeStatus,
  newPlotId,
  nodesForSummary,
  normalizeNodes,
  plotSaveStatus,
  type PlotNode,
} from '../../src/renderer/panels/plot-canvas-model.js'

/** 章节树节点夹具（ChapterNodeView 完整字段）。 */
function chapterNode(patch: Partial<ChapterNodeView> = {}): ChapterNodeView {
  return {
    id: 'ch_1',
    label: '第一章 试炼开始',
    depth: 1,
    kind: 'chapter',
    hasChildren: false,
    deleted: false,
    current: false,
    ...patch,
  }
}

/** 剧情节点夹具（PlotNode 完整字段）。 */
function plotNode(patch: Partial<PlotNode> = {}): PlotNode {
  return {
    id: 'node_1',
    title: '觉醒',
    summary: '主角在试炼中觉醒灵纹',
    status: 'todo',
    chapterId: null,
    ...patch,
  }
}

/** 章节选项夹具（结构满足 PlotChapterOption）。 */
const chapters = [
  { id: 'ch_1', label: '第一章 试炼开始' },
  { id: 'ch_2', label: '第二章 禁地夜行' },
]

describe('节点状态常量', () => {
  it('状态顺序为 未写 → 草稿 → 完成，文案一一对应', () => {
    expect([...NODE_STATUS_ORDER]).toEqual(['todo', 'draft', 'done'])
    expect(NODE_STATUS_LABELS.todo).toBe('未写')
    expect(NODE_STATUS_LABELS.draft).toBe('草稿')
    expect(NODE_STATUS_LABELS.done).toBe('完成')
  })

  it('isPlotNodeStatus 只接受三个合法取值', () => {
    expect(isPlotNodeStatus('todo')).toBe(true)
    expect(isPlotNodeStatus('draft')).toBe(true)
    expect(isPlotNodeStatus('done')).toBe(true)
    expect(isPlotNodeStatus('Todo')).toBe(false)
    expect(isPlotNodeStatus('')).toBe(false)
    expect(isPlotNodeStatus('已写')).toBe(false)
    expect(isPlotNodeStatus(null)).toBe(false)
    expect(isPlotNodeStatus(undefined)).toBe(false)
    expect(isPlotNodeStatus(1)).toBe(false)
  })
})

describe('节点 id 工厂', () => {
  it('newPlotId 带前缀，200 个同毫秒 id 互不碰撞', () => {
    const ids = Array.from({ length: 200 }, () => newPlotId('node'))
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id.startsWith('node_')).toBe(true)
      expect(id.length).toBeGreaterThan('node_'.length)
    }
  })

  it('id 序号单调递增（同毫秒调用也不重复）', () => {
    const first = newPlotId('node')
    const second = newPlotId('node')
    const firstSeq = /^node_([0-9a-z]+)_/.exec(first)
    const secondSeq = /^node_([0-9a-z]+)_/.exec(second)
    expect(firstSeq).not.toBeNull()
    expect(secondSeq).not.toBeNull()
    expect(
      Number.parseInt(secondSeq![1] ?? '0', 36),
    ).toBeGreaterThan(Number.parseInt(firstSeq![1] ?? '0', 36))
  })

  it('createNode 保留标题、要点、状态与归属章节，id 由工厂生成', () => {
    const node = createNode('夜探禁地', '与同门发现密道', 'draft', 'ch_2')
    expect(node.title).toBe('夜探禁地')
    expect(node.summary).toBe('与同门发现密道')
    expect(node.status).toBe('draft')
    expect(node.chapterId).toBe('ch_2')
    expect(node.id.startsWith('node_')).toBe(true)
  })

  it('createDefaultPanelData 返回空节点数组', () => {
    expect(createDefaultPanelData()).toEqual({ nodes: [] })
  })
})

describe('存储值归一化 normalizeNodes', () => {
  it('非数组输入一律返回空数组（绝不抛错）', () => {
    expect(normalizeNodes(null)).toEqual([])
    expect(normalizeNodes(undefined)).toEqual([])
    expect(normalizeNodes('nodes')).toEqual([])
    expect(normalizeNodes(42)).toEqual([])
    expect(normalizeNodes({ 0: {} })).toEqual([])
  })

  it('跳过非对象行，保留合法行', () => {
    const result = normalizeNodes([null, 42, 'x', plotNode({ id: 'a1' })])
    expect(result.length).toBe(1)
    expect(result[0]?.id).toBe('a1')
  })

  it('缺省字段回落默认值：标题/要点空串、状态 todo、章节 null', () => {
    const result = normalizeNodes([{ id: 'a1' }])
    expect(result[0]?.title).toBe('')
    expect(result[0]?.summary).toBe('')
    expect(result[0]?.status).toBe('todo')
    expect(result[0]?.chapterId).toBeNull()
  })

  it('非法状态回落 todo，合法状态原样保留', () => {
    const result = normalizeNodes([
      { id: 'a1', status: '已写' },
      { id: 'a2', status: 'done' },
      { id: 'a3', status: 1 },
    ])
    expect(result[0]?.status).toBe('todo')
    expect(result[1]?.status).toBe('done')
    expect(result[2]?.status).toBe('todo')
  })

  it('空串 chapterId 按未归属处理；缺失 id 补生成 id', () => {
    const result = normalizeNodes([
      { id: 'a1', chapterId: '' },
      { title: '补 id' },
    ])
    expect(result[0]?.chapterId).toBeNull()
    expect(result[1]?.id.startsWith('node_')).toBe(true)
    expect(result[1]?.title).toBe('补 id')
  })
})

describe('章节选项 collectChapters', () => {
  it('只取未删章节，过滤卷/大纲/便签，保持树的顺序', () => {
    const tree = [
      chapterNode({ id: 'v1', kind: 'volume', label: '第一卷' }),
      chapterNode({ id: 'ch_2', label: '第二章 禁地夜行' }),
      chapterNode({ id: 'ch_d', label: '已删章节', deleted: true }),
      chapterNode({ id: 'o1', kind: 'outline', label: '总大纲' }),
      chapterNode({ id: 'n1', kind: 'note', label: '便签' }),
    ]
    const options = collectChapters(tree)
    expect(options.map((option) => option.id)).toEqual(['ch_2'])
    expect(options[0]?.label).toBe('第二章 禁地夜行')
  })

  it('空标题回落「未命名章节」；空树返回空选项', () => {
    expect(collectChapters([chapterNode({ id: 'ch_e', label: '' })])[0]?.label).toBe(
      PLOT_PANEL_TEXT.unnamedChapter,
    )
    expect(collectChapters([])).toEqual([])
  })
})

describe('画布分组 groupNodesByChapter', () => {
  it('分组顺序跟章节选项一致，节点落入对应章节组', () => {
    const input = [
      plotNode({ id: 'b1', chapterId: 'ch_2' }),
      plotNode({ id: 'a1', chapterId: 'ch_1' }),
      plotNode({ id: 'a2', chapterId: 'ch_1' }),
    ]
    const groups = groupNodesByChapter(input, chapters)
    expect(groups.length).toBe(2)
    expect(groups[0]?.chapterId).toBe('ch_1')
    expect(groups[0]?.label).toBe('第一章 试炼开始')
    expect(groups[0]?.nodes.map((node) => node.id)).toEqual(['a1', 'a2'])
    expect(groups[1]?.chapterId).toBe('ch_2')
    expect(groups[1]?.nodes.map((node) => node.id)).toEqual(['b1'])
  })

  it('未归属/未知/已删章节的节点统一落进末尾「未归属章节」组', () => {
    const tree = [chapterNode()]
    const input = [
      plotNode({ id: 'n1', chapterId: null }),
      plotNode({ id: 'n2', chapterId: 'ch_9' }),
      plotNode({ id: 'n3', chapterId: 'ch_1' }),
      plotNode({ id: 'n4', chapterId: 'ch_d' }),
    ]
    const groups = groupNodesByChapter(input, collectChapters(tree))
    expect(groups.length).toBe(2)
    expect(groups[0]?.chapterId).toBe('ch_1')
    expect(groups[1]?.chapterId).toBeNull()
    expect(groups[1]?.label).toBe(PLOT_PANEL_TEXT.unassigned)
    expect(groups[1]?.nodes.map((node) => node.id)).toEqual(['n1', 'n2', 'n4'])
  })

  it('没有节点的章节不出现分组；不修改入参数组顺序', () => {
    const input = [plotNode({ id: 'b1', chapterId: 'ch_2' }), plotNode({ id: 'a1', chapterId: 'ch_1' })]
    const before = input.map((node) => node.id)
    const groups = groupNodesByChapter(input, chapters)
    expect(groups.length).toBe(2)
    expect(input.map((node) => node.id)).toEqual(before)
    expect(groupNodesByChapter([], chapters)).toEqual([])
  })
})

describe('摘要目标 nodesForSummary', () => {
  it('null = 全部节点；已知章节只取该章节点', () => {
    const input = [
      plotNode({ id: 'a1', chapterId: 'ch_1' }),
      plotNode({ id: 'b1', chapterId: 'ch_2' }),
      plotNode({ id: 'c1', chapterId: null }),
    ]
    expect(nodesForSummary(input, null, chapters).length).toBe(3)
    expect(nodesForSummary(input, 'ch_1', chapters).map((node) => node.id)).toEqual(['a1'])
  })

  it('选了不存在的章节返回空数组（不误发请求）', () => {
    const input = [plotNode({ id: 'a1', chapterId: 'ch_1' })]
    expect(nodesForSummary(input, 'ch_9', chapters)).toEqual([])
  })
})

describe('摘要请求拼装', () => {
  it('system 提示词写明「情节摘要助手」角色', () => {
    const system = buildSummarySystemPrompt()
    expect(system).toContain('情节摘要助手')
    expect(system).toContain('3-8 句')
  })

  it('user 消息含摘要范围与逐节点「【状态】标题：要点」，空标题/空要点有回落', () => {
    const input = [
      plotNode({ title: '觉醒', summary: '主角觉醒灵纹', status: 'draft' }),
      plotNode({ title: '', summary: '', status: 'done' }),
    ]
    const message = buildSummaryUserMessage(input, PLOT_PANEL_TEXT.allChapters)
    expect(message).toContain(`【摘要范围】${PLOT_PANEL_TEXT.allChapters}`)
    expect(message).toContain('【剧情节点】')
    expect(message).toContain('- 【草稿】觉醒：主角觉醒灵纹')
    expect(message).toContain(`- 【完成】${PLOT_PANEL_TEXT.unnamedNode}：${PLOT_PANEL_TEXT.noSummary}`)
  })

  it('请求形状：system + 单条 user 消息，不传 maxTokens / temperature', () => {
    const input = [plotNode({ title: '觉醒', summary: '主角觉醒灵纹' })]
    const request = buildSummaryRequest(input, PLOT_PANEL_TEXT.allChapters)
    expect(request.system).toBe(buildSummarySystemPrompt())
    expect(request.messages.length).toBe(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toBe(buildSummaryUserMessage(input, PLOT_PANEL_TEXT.allChapters))
    expect('maxTokens' in request).toBe(false)
    expect('temperature' in request).toBe(false)
  })
})

describe('失败提示与计数文案', () => {
  it('failureNotice：未配置模型给引导，其余如实带出服务端 message', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '任意')).toBe(PLOT_PANEL_TEXT.notConfigured)
    expect(failureNotice('AI_TIMEOUT', '上游超时')).toBe(`${PLOT_PANEL_TEXT.summaryFailed}：上游超时`)
    expect(failureNotice('AI_UPSTREAM_ERROR', '5xx')).toBe(`${PLOT_PANEL_TEXT.summaryFailed}：5xx`)
  })

  it('formatNodeCount 输出「N 个节点」', () => {
    expect(formatNodeCount(0)).toBe('0 个节点')
    expect(formatNodeCount(12)).toBe('12 个节点')
  })
})

describe('保存态 plotSaveStatus', () => {
  it('优先级 saving > error > dirty > saved', () => {
    expect(plotSaveStatus(true, true, true)).toBe('saving')
    expect(plotSaveStatus(true, false, false)).toBe('saving')
    expect(plotSaveStatus(false, true, true)).toBe('error')
    expect(plotSaveStatus(false, false, true)).toBe('error')
    expect(plotSaveStatus(false, true, false)).toBe('dirty')
    expect(plotSaveStatus(false, false, false)).toBe('saved')
  })
})

describe('面板文案常量', () => {
  it('关键文案存在且为非空中文（可见文本唯一来源）', () => {
    const keys = [
      'intro',
      'listTitle',
      'canvasTitle',
      'previewNote',
      'emptyNodes',
      'noProject',
      'aiButton',
      'notConfigured',
      'summaryFailed',
      'aiEmptyResult',
    ] as const
    for (const key of keys) {
      expect(PLOT_PANEL_TEXT[key].length).toBeGreaterThan(0)
    }
    expect(PLOT_PANEL_TEXT.noProject).toBe('请先在左侧新建作品')
    expect(PLOT_PANEL_TEXT.notConfigured).toContain('模型设置')
    expect(PLOT_PANEL_TEXT.previewNote).toContain('预览版简化视图')
    expect(PLOT_PANEL_TEXT.aiButton).toBe('AI 情节摘要')
  })
})
