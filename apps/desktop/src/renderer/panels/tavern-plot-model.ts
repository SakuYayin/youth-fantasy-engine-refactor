/**
 * 剧情推演面板（`tavern-plot`）的纯逻辑层。
 *
 * 职责（接口冻结-面板层.md §4）：场景数据的增删改/顺序归一化、AI 请求拼装与
 * 响应解析、保存状态机、面板文案——全部是可单测的纯函数；
 * `tavern-plot.vue` 只做渲染与调用。
 *
 * 纪律：绝不 import 'node:*'、绝不 fetch/WebSocket；AI 只走 `state.ai.complete`
 * （AiPort），本文件只负责拼请求与解析响应；持久化模板 `panel:tavern-plot`
 * 由 Lead 的 `createPanelStore` 自动生成，这里不手拼 orderKey / IPC 方法名。
 */
import type { AiRequest } from '../ai/types.js'

import type { TavernPlotScene } from '../tavern/types.js'
import { newTavernId, tavernNow } from '../tavern/types.js'

/**
 * 面板行：在共享 `TavernPlotScene` 上补面板自己的时间戳（共享类型不改动——
 * 本文件不得改 `renderer/tavern/types.ts`）。多出来的字段对下游结构兼容：
 * `TavernPlotSceneRecord[]` 可直接当 `TavernPlotScene[]` 用。
 */
export interface TavernPlotSceneRecord extends TavernPlotScene {
  /** 创建时间（ISO 字符串，`tavernNow()`）。 */
  createdAt: string
  /** 最近一次编辑时间（ISO 字符串，`tavernNow()`）。 */
  updatedAt: string
}

/**
 * 面板持久化的 values（存 `panel:tavern-plot` 模板，由 `createPanelStore` 生成）。
 *
 * 显式 extends `Record<string, unknown>`：`createPanelStore` 的泛型约束要求
 * 索引签名（与 creative-writing 同口径）。
 */
export interface TavernPlotPanelValues extends Record<string, unknown> {
  items: TavernPlotSceneRecord[]
}

export function createDefaultPanelValues(): TavernPlotPanelValues {
  return { items: [] }
}

/** AI 续写请求的 maxTokens（传给 `state.ai.complete`）。 */
export const AI_PLOT_MAX_TOKENS = 2048

/** 列表里剧情简述的摘要宽度（超出按码点截断加省略号）。 */
export const BRIEF_MAX_CHARS = 40

/**
 * 面板文案的唯一来源（接口冻结 §6：可见文本 ⊆ 页签文案 ∪ 这里的常量）。
 * 全中文；带 {name}/{message} 占位符的由 `fillTemplate` 替换。
 */
export const TAVERN_PLOT_PANEL_TEXT = Object.freeze({
  /** 顶部说明。 */
  intro: '场景按顺序拼进酒馆对话的系统提示词：先在这里规划剧情走向，再由对话页签按顺序引用。',
  listTitle: '场景列表',
  listHint: '点击场景回灌表单编辑；上移/下移调整顺序（顺序即数组下标）。',
  empty: '还没有场景。填写右侧表单后点击「保存场景」创建第一场。',
  formTitleNew: '新建场景',
  formTitleEdit: '编辑场景',
  fieldTitle: '标题',
  fieldBrief: '剧情简述',
  titlePlaceholder: '场景标题（必填）',
  briefPlaceholder: '这一场讲什么（可留空）',
  titleRequired: '标题不能为空。',
  newScene: '新建场景',
  saveScene: '保存场景',
  cancelEdit: '取消编辑',
  delete: '删除',
  deleteTitle: '确定删除「{name}」吗？删除后无法恢复。',
  confirmDelete: '确认删除',
  cancelDelete: '取消',
  moveUp: '上移',
  moveDown: '下移',
  loading: '正在载入场景…',
  resultTitle: 'AI 续写结果',
  resultEmpty: '点击「AI 续写剧情线」后，推演结果会显示在这里。',
  aiGenerate: 'AI 续写剧情线',
  aiGenerating: '推演中…',
  notConfigured: '尚未配置模型：请到「模型设置」页签填写接口地址、模型名与 API Key，再回来使用 AI 续写。',
  aiParseFailed: 'AI 返回的内容无法解析成剧情 JSON，本次结果未落库。',
  aiDone: '已把「{name}」追加为新场景。',
  aiFailure: '续写失败：{message}',
  appendScene: '追加为新场景',
  appendTitle: '确定把 AI 续写的剧情追加为新场景「{name}」吗？',
} as const)

/** 表单输入（标题必填、剧情简述可留空）。 */
export interface SceneFormInput {
  readonly title: string
  readonly brief: string
}

/** AI 续写解析出的下一段剧情草稿（确认后才落库为新场景）。 */
export interface PlotDraft {
  readonly title: string
  readonly brief: string
}

/** AI 续写的面板内状态机。 */
export type PlotAiState = 'idle' | 'generating' | 'done' | 'failed'

/** 面板保存状态（六态与 `YfeStatusPill` 对齐；conflict/offline 由上层给出，面板不产生）。 */
export type PanelSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'

/** 保存状态机：saving > error > dirty > saved。 */
export function panelSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): PanelSaveStatus {
  if (saving) return 'saving'
  if (hasError) return 'error'
  if (dirty) return 'dirty'
  return 'saved'
}

/** 把模板里的 {key} 占位符替换成 values[key]；没有对应值的占位符原样保留。 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, key: string) => {
    const value = values[key]
    return value === undefined ? match : value
  })
}

/** 列表里的剧情简述摘要：trim 后按码点截断加省略号。 */
export function briefDescription(text: string, limit: number = BRIEF_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit)}…`
}

/** 工具栏概览行：`共 N 个场景`。 */
export function overviewLine(count: number): string {
  return `共 ${count} 个场景`
}

/** 列表顺序标签：`n` 是 1 起的位置（界面显示「第 n 场」）。 */
export function orderLabel(n: number): string {
  return `第 ${n} 场`
}

/** 表单校验：标题必填。返回错误文案（中文），通过返回 null。 */
export function validateSceneForm(input: SceneFormInput): string | null {
  if (input.title.trim() === '') return TAVERN_PLOT_PANEL_TEXT.titleRequired
  return null
}

/** 按 id 找场景；找不到返回 null。 */
export function findSceneById(
  items: readonly TavernPlotSceneRecord[],
  id: string,
): TavernPlotSceneRecord | null {
  return items.find((item) => item.id === id) ?? null
}

/**
 * 从表单输入造场景记录：新建时 `newTavernId('plot')` 生成 id、`tavernNow()` 打时间戳、
 * messages 留空（本面板只管大纲，消息归对话页签）；编辑时保留 id/createdAt/order、
 * 刷新 updatedAt。title/brief 都 trim。不改传入的 existing。
 */
export function makeScene(
  input: SceneFormInput,
  existing?: TavernPlotSceneRecord | null,
): TavernPlotSceneRecord {
  const now = tavernNow()
  if (existing === null || existing === undefined) {
    return {
      id: newTavernId('plot'),
      title: input.title.trim(),
      brief: input.brief.trim(),
      messages: [],
      order: 0,
      createdAt: now,
      updatedAt: now,
    }
  }
  return {
    id: existing.id,
    title: input.title.trim(),
    brief: input.brief.trim(),
    messages: [...existing.messages],
    order: existing.order,
    createdAt: existing.createdAt,
    updatedAt: now,
  }
}

/**
 * 显示顺序：按 `order` 升序（稳定排序，并列保持数组先后），并把 `order`
 * 归一化为数组下标（「顺序用数组下标」）。防御性：外部改库或旧数据乱序也能显示对。
 * 不改传入数组；顺序已正确的元素原样返回（不复制）。
 */
export function orderedScenes(
  items: readonly TavernPlotSceneRecord[],
): TavernPlotSceneRecord[] {
  const indexed = items.map((item, index) => ({ item, index }))
  indexed.sort((left, right) => {
    if (left.item.order !== right.item.order) {
      return left.item.order < right.item.order ? -1 : 1
    }
    return left.index - right.index
  })
  return indexed.map((entry, position) =>
    entry.item.order === position ? entry.item : { ...entry.item, order: position },
  )
}

/**
 * 新场景追加到末尾（order = 追加后的下标）；已有场景原位替换（order = 所在下标）。
 * 不改传入数组。
 */
export function upsertScene(
  items: readonly TavernPlotSceneRecord[],
  next: TavernPlotSceneRecord,
): TavernPlotSceneRecord[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) {
    return [...items, { ...next, order: items.length }]
  }
  const copy = items.slice()
  copy[index] = { ...next, order: index }
  return copy
}

/** 删除场景并把剩余场景的 order 归一化为数组下标。不改传入数组。 */
export function removeScene(
  items: readonly TavernPlotSceneRecord[],
  id: string,
): TavernPlotSceneRecord[] {
  return items
    .filter((item) => item.id !== id)
    .map((item, index) => (item.order === index ? item : { ...item, order: index }))
}

/**
 * 上移/下移：与相邻场景交换位置，order 归一化为数组下标。
 * 越界（第一个上移/最后一个下移）或找不到 id 返回 null（不改动）。不改传入数组。
 */
export function moveScene(
  items: readonly TavernPlotSceneRecord[],
  id: string,
  delta: -1 | 1,
): TavernPlotSceneRecord[] | null {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return null
  const target = index + delta
  if (target < 0 || target >= items.length) return null
  const copy = items.slice()
  const moving = copy[index]
  const other = copy[target]
  if (moving === undefined || other === undefined) return null
  copy[index] = other
  copy[target] = moving
  return copy.map((item, position) => (item.order === position ? item : { ...item, order: position }))
}

/** 把场景列表拼成大纲文本（编号 + 标题 + 简述，空简述写「（无简述）」）。 */
export function outlineText(scenes: readonly TavernPlotScene[]): string {
  if (scenes.length === 0) {
    return '（目前还没有场景，请直接构思第一场。）'
  }
  return scenes
    .map((scene, index) => {
      const brief = scene.brief.trim()
      const briefPart = brief === '' ? '（无简述）' : brief
      return `${index + 1}. ${scene.title}：${briefPart}`
    })
    .join('\n')
}

/** AI 续写请求：系统提示词要求只返回一个 JSON 对象；maxTokens = 2048。 */
export function buildAiContinueRequest(scenes: readonly TavernPlotScene[]): AiRequest {
  const system =
    '你是「青春幻想引擎」酒馆模式的剧情策划。根据已有剧情大纲推演下一段剧情：' +
    '只返回一个 JSON 对象 {"title": "场景标题", "brief": "剧情简述"}，不要解释，不要返回数组。'
  const user = `已有剧情大纲：\n${outlineText(scenes)}\n\n请推演下一段剧情，返回一个 JSON 对象。`
  return {
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: AI_PLOT_MAX_TOKENS,
  }
}

/**
 * 剥掉 ```json 围栏，截取首个 open 到最后一个 close 之间的内容；截不到返回 ''。
 * 默认截取对象（'{' ～ '}'）；AI 返回数组时传 '[' 与 ']' 截取数组整体。
 */
export function extractJson(text: string, open: string = '{', close: string = '}'): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const body = fenced === null ? text : (fenced[1] ?? text)
  const start = body.indexOf(open)
  const end = body.lastIndexOf(close)
  if (start < 0 || end < 0 || end <= start) return ''
  return body.slice(start, end + 1)
}

/** 宽松取字符串：string 原样；有限数字转字符串；其余 null。 */
export function coerceString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * 解析 AI 返回的剧情 JSON：`{title, brief}`。
 * 标题缺失/空白/非字符串 → null（不落库）；brief 宽松兜底 ''。
 * 容错：AI 返回数组时取第一个对象元素；围栏/前后缀杂讯都能剥掉。
 * 依次尝试：原文整体 → 对象切片（'{' ～ '}'）→ 数组切片（'[' ～ ']'）。
 */
export function parseAiPlot(text: string): PlotDraft | null {
  const candidates = [text, extractJson(text), extractJson(text, '[', ']')]
  for (const candidate of candidates) {
    const raw = candidate.trim()
    if (raw === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const source = Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
    const record = source as Record<string, unknown>
    const title = coerceString(record.title)
    if (title === null || title.trim() === '') return null
    const brief = coerceString(record.brief)
    return { title: title.trim(), brief: brief === null ? '' : brief.trim() }
  }
  return null
}

/** AI 失败的提示文案：未配置模型回引导文案；其余包「续写失败：」。 */
export function failureNotice(code: string, message: string): string {
  if (code === 'AI_NOT_CONFIGURED') {
    return TAVERN_PLOT_PANEL_TEXT.notConfigured
  }
  return fillTemplate(TAVERN_PLOT_PANEL_TEXT.aiFailure, { message })
}
