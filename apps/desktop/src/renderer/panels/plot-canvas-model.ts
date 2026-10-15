/**
 * 情节画布面板（tab.id = `plot-canvas`）的纯逻辑与文案。
 *
 * 契约见 `docs/接口冻结-面板层.md`（§2 PanelProps、§3 持久化契约、§4 AI 契约、§5 文件所有权）。
 *
 * 职责边界：节点 id 工厂、存储值归一化、章节分组、摘要请求拼装、失败提示、
 * 保存态优先级等纯函数全部收在这里；`plot-canvas.vue` 只做渲染与调用。
 * AI 调用只走 `props.state.ai.complete(request)`（渲染层 CSP 禁网，模型请求由
 * main 进程代理发出）；本模块不 import 'node:*'、不 fetch、不直连模型服务商，
 * 情节摘要走默认 maxTokens（构造请求时不传该字段）。
 *
 * 旧版参考（只读，仅学功能结构与文案）：
 * `_upstream_tmp/youth-fantasy-engine-main/src/components/outline/PlotCanvas.tsx`
 * —— 旧版是「多选章节 → 逐章 AI 推演 → 结构化卡片拖拽连线」的完整画布；
 * 本版按当前任务书收敛为「按章节编排剧情节点（标题+要点+状态）+ 节点列表 +
 * 按章节分组的色块条简化画布 + 可选 AI 情节摘要」，拖拽连线留待后续批次。
 */

import type { AiErrorCode, AiRequest } from '../ai/types.js'

import type { ChapterNodeView } from '../app-state.js'

/** 节点状态取值与展示顺序（未写 → 草稿 → 完成）。 */
export const NODE_STATUS_ORDER = ['todo', 'draft', 'done'] as const

/** 节点状态（与 `NODE_STATUS_ORDER` 一一对应）。 */
export type PlotNodeStatus = (typeof NODE_STATUS_ORDER)[number]

/** 节点状态中文文案（画布色块图例与节点编辑共用）。 */
export const NODE_STATUS_LABELS: Readonly<Record<PlotNodeStatus, string>> = Object.freeze({
  todo: '未写',
  draft: '草稿',
  done: '完成',
})

/** 判断存储值里的状态是否合法；非法值归一化为 `todo`。 */
export function isPlotNodeStatus(value: unknown): value is PlotNodeStatus {
  return value === 'todo' || value === 'draft' || value === 'done'
}

/** 剧情节点：标题 + 剧情要点 + 状态 + 归属章节。 */
export interface PlotNode {
  id: string
  title: string
  /** 剧情要点（这一段剧情的关键冲突与走向）。 */
  summary: string
  status: PlotNodeStatus
  /** 归属章节（章节树节点 id）；null = 未归属章节。 */
  chapterId: string | null
}

/** 面板状态 values（模板 `panel:plot-canvas`，按作品存）。 */
export type PlotPanelData = {
  nodes: PlotNode[]
}

/** 面板状态默认值。 */
export function createDefaultPanelData(): PlotPanelData {
  return { nodes: [] }
}

/** 面板内节点 id 序号：加单调后缀，避免同毫秒 / 弱随机碰撞。 */
let plotIdSeq = 0

/**
 * 节点 id 工厂：仅用于 values JSON 内部引用，绝不冒充实体的数据库 ID。
 * 实现思路参考 `tavern/types.ts` 的 `newTavernId`（本面板不 import 该文件）：
 * 优先 `crypto.randomUUID`，不可用时回退时间戳 + 随机串；另加单调序号后缀。
 */
export function newPlotId(prefix: string): string {
  plotIdSeq += 1
  const scope = globalThis as { crypto?: { randomUUID?: () => string } }
  if (typeof scope.crypto?.randomUUID === 'function') {
    return `${prefix}_${plotIdSeq.toString(36)}_${scope.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  }
  return `${prefix}_${plotIdSeq.toString(36)}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 新建剧情节点（本地工厂；id 由前端生成）。 */
export function createNode(
  title: string,
  summary: string,
  status: PlotNodeStatus,
  chapterId: string | null,
): PlotNode {
  return { id: newPlotId('node'), title, summary, status, chapterId }
}

/**
 * 归一化存储值里的节点数组：库值来自上一版本的 JSON，字段可能缺失或畸形——
 * 只接受对象行，字段逐个校验，状态非法回落 `todo`，章节 id 空串按未归属处理。
 * 绝不抛错（持久化数据畸形不能让面板白屏）。
 */
export function normalizeNodes(raw: unknown): readonly PlotNode[] {
  if (!Array.isArray(raw)) return []
  const nodes: PlotNode[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    nodes.push({
      id: typeof record.id === 'string' && record.id !== '' ? record.id : newPlotId('node'),
      title: typeof record.title === 'string' ? record.title : '',
      summary: typeof record.summary === 'string' ? record.summary : '',
      status: isPlotNodeStatus(record.status) ? record.status : 'todo',
      chapterId: typeof record.chapterId === 'string' && record.chapterId !== '' ? record.chapterId : null,
    })
  }
  return nodes
}

/** 章节选项（章节树 → 下拉选项，供节点归属与摘要范围选择）。 */
export interface PlotChapterOption {
  readonly id: string
  readonly label: string
}

/** 从章节树收章节选项：只取未删章节，保持树的顺序；空标题回落「未命名章节」。 */
export function collectChapters(tree: readonly ChapterNodeView[]): readonly PlotChapterOption[] {
  const options: PlotChapterOption[] = []
  for (const node of tree) {
    if (node.kind === 'chapter' && node.deleted === false) {
      options.push({ id: node.id, label: node.label === '' ? PLOT_PANEL_TEXT.unnamedChapter : node.label })
    }
  }
  return options
}

/** 画布分组：按章节聚合的节点条。 */
export interface PlotChapterGroup {
  /** 章节 id；null = 未归属章节分组（排序固定在最后）。 */
  readonly chapterId: string | null
  readonly label: string
  readonly nodes: readonly PlotNode[]
}

/**
 * 按章节分组剧情节点：分组顺序跟章节选项一致；归属到已删/未知章节或未归属的
 * 节点全部落进末尾的「未归属章节」分组；没有节点的章节不出分组。
 * 不修改入参数组顺序。
 */
export function groupNodesByChapter(
  nodes: readonly PlotNode[],
  chapters: readonly PlotChapterOption[],
): readonly PlotChapterGroup[] {
  const buckets = new Map<string, PlotNode[]>()
  const unassigned: PlotNode[] = []
  for (const node of nodes) {
    const known = node.chapterId !== null && chapters.some((chapter) => chapter.id === node.chapterId)
    if (known) {
      const chapterId = node.chapterId
      if (chapterId === null) continue
      const bucket = buckets.get(chapterId)
      if (bucket === undefined) {
        buckets.set(chapterId, [node])
      } else {
        bucket.push(node)
      }
    } else {
      unassigned.push(node)
    }
  }

  const groups: PlotChapterGroup[] = []
  for (const chapter of chapters) {
    const bucket = buckets.get(chapter.id)
    if (bucket !== undefined) {
      groups.push({ chapterId: chapter.id, label: chapter.label, nodes: bucket })
    }
  }
  if (unassigned.length > 0) {
    groups.push({ chapterId: null, label: PLOT_PANEL_TEXT.unassigned, nodes: unassigned })
  }
  return groups
}

/** 摘要目标节点：null = 全部节点；选了不存在的章节返回空（不误发请求）。 */
export function nodesForSummary(
  nodes: readonly PlotNode[],
  chapterId: string | null,
  chapters: readonly PlotChapterOption[],
): readonly PlotNode[] {
  if (chapterId === null) return nodes
  const known = chapters.some((chapter) => chapter.id === chapterId)
  if (!known) return []
  return nodes.filter((node) => node.chapterId === chapterId)
}

/** system 提示词：写明「情节摘要助手」角色与输出要求。 */
export function buildSummarySystemPrompt(): string {
  return [
    '你是「情节摘要助手」，负责把作者编排的剧情节点整理成一段连贯的情节摘要，供作者检查节奏与因果。',
    '请把要点串成 3-8 句的连贯短文：保持章节顺序与因果链，突出冲突与转折，不要逐条罗列。',
    '只输出摘要正文，不要寒暄，不要标题；节点之外的信息一律不要编造。',
  ].join('\n')
}

/** user 消息：摘要范围 + 逐节点「【状态】标题：要点」。 */
export function buildSummaryUserMessage(
  nodes: readonly PlotNode[],
  scopeLabel: string,
): string {
  const lines = nodes.map((node) => {
    const title = node.title === '' ? PLOT_PANEL_TEXT.unnamedNode : node.title
    const brief = node.summary === '' ? PLOT_PANEL_TEXT.noSummary : node.summary
    return `- 【${NODE_STATUS_LABELS[node.status]}】${title}：${brief}`
  })
  return [`【摘要范围】${scopeLabel}`, `【剧情节点】\n${lines.join('\n')}`].join('\n')
}

/**
 * 构造情节摘要请求：system + 单条 user 消息。
 * 摘要用默认 maxTokens（不传该字段）、不传 temperature。
 */
export function buildSummaryRequest(nodes: readonly PlotNode[], scopeLabel: string): AiRequest {
  const messages: AiRequest['messages'] = [{ role: 'user', content: buildSummaryUserMessage(nodes, scopeLabel) }]
  return { system: buildSummarySystemPrompt(), messages }
}

/** 失败提示：未配置模型给明确引导，其余如实带出服务端 message。 */
export function failureNotice(code: AiErrorCode, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') {
    return PLOT_PANEL_TEXT.notConfigured
  }
  return `${PLOT_PANEL_TEXT.summaryFailed}：${message}`
}

/** 节点数文案（顶栏与分组头共用）。 */
export function formatNodeCount(count: number): string {
  return `${count} ${PLOT_PANEL_TEXT.nodeUnit}`
}

/** 面板保存态（`YfeStatusPill` 六态的子集）。 */
export type PlotSaveStatus = 'saving' | 'dirty' | 'error' | 'saved'

/** 保存态优先级：saving > error > dirty > saved（失败也标脏，错误优先展示）。 */
export function plotSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PlotSaveStatus {
  if (saving) {
    return 'saving'
  }
  if (hasError) {
    return 'error'
  }
  if (dirty) {
    return 'dirty'
  }
  return 'saved'
}

/** 面板文案（全中文；视图可见文本的唯一来源）。 */
export const PLOT_PANEL_TEXT = {
  intro: '按章节编排剧情节点（标题 + 剧情要点 + 状态：未写 / 草稿 / 完成），节点自动保存到当前作品。',
  nodeUnit: '个节点',
  listTitle: '剧情节点',
  canvasTitle: '简化画布',
  previewNote: '预览版简化视图，完整拖拽画布后续批次。',
  chapterLabel: '章节',
  unassigned: '未归属章节',
  allChapters: '全部章节',
  addNode: '新增节点',
  removeNode: '删除',
  titleLabel: '标题',
  summaryLabel: '剧情要点',
  statusLabel: '状态',
  titlePlaceholder: '节点标题…',
  summaryPlaceholder: '这一段剧情的关键冲突与走向…',
  unnamedChapter: '未命名章节',
  unnamedNode: '未命名节点',
  noSummary: '（无剧情要点）',
  emptyNodes: '还没有剧情节点：点「新增节点」开始编排。',
  idleHint: '点「新增节点」开始编排剧情；节点按章节分组展示。',
  loadedFromStore: '已载入当前作品保存的剧情节点。',
  noProject: '请先在左侧新建作品',
  summaryScopeLabel: '摘要范围',
  aiButton: 'AI 情节摘要',
  aiRunning: '生成摘要中…',
  aiSectionTitle: 'AI 情节摘要',
  aiResultTitle: '摘要结果',
  aiEmpty: '没有可摘要的剧情节点：先新增节点，或选择有节点的章节。',
  aiEmptyResult: '模型返回了空摘要，请重试或更换模型',
  notConfigured: '请先到『模型设置』页签配置接口地址、模型名与 API Key',
  summaryFailed: '情节摘要失败',
} as const
