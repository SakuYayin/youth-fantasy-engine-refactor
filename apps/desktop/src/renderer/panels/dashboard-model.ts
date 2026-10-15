/**
 * dashboard（写作面板）纯逻辑：写作统计总览与写作目标进度。
 *
 * 全部函数为纯函数，不触碰状态与 DOM；dashboard.vue 只渲染与调用。
 *
 * 统计口径（界面文案与这里保持一致）：
 * - 作品数：documents 中 `projectId` 去重后的数量；
 * - 章节总数：`kind === 'chapter'` 且未删除（`deleted === 0`，DeletedFlag 是数值不是布尔）；
 * - 总字数：未删章节的 `charCount` 求和（不含卷/大纲/笔记，避免与卷汇总双算）；
 * - 最近更新：未删文档 `updatedAt` 的最大值（ISO 戳同格式逐字符比较即时间序，仅用于展示）；
 * - 写作目标进度：当前作品总字数 vs 每日目标。本版本没有每日历史数据（不记录写作会话），
 *   进度不代表当日产出——口径说明见 `DASHBOARD_COPY.goalNote`。
 */

import type { DocumentSummary } from '@yfe/contracts'

import type { AppSnapshot } from '../app-state.js'

/** 字数最多章节榜单条数（与 `DASHBOARD_COPY.topTitle` 的「前 5」保持一致）。 */
export const DASHBOARD_TOP_LIMIT = 5

/** 每日目标默认值（字）。 */
export const DEFAULT_DAILY_GOAL = 2000

/** 面板文案唯一来源（组件内不写死大段静态文案）。 */
export const DASHBOARD_COPY = {
  subtitle: '数字来自当前作品的文档列表，自动计算，无需手动维护。',
  statProjects: '作品数',
  statChapters: '章节总数',
  statChars: '总字数',
  statUpdated: '最近更新',
  charsUnit: '字',
  topTitle: '字数最多的章节（前 5）',
  topUnit: '字',
  goalTitle: '写作目标',
  goalLabel: '每日目标（字）',
  goalSave: '立即保存',
  goalNote:
    '口径说明：本版本没有每日历史数据（不记录写作会话），进度＝当前作品总字数（未删章节字数之和）÷ 每日目标，不代表当日产出。',
  goalPercentPrefix: '已完成',
  goalRemainingPrefix: '还差',
  goalReached: '已达目标，继续保持！',
  goalNoGoal: '还没设置目标：在上方输入每日目标字数，这里会显示进度。',
  hintInvalidGoal: '请输入不小于 0 的数字；本次输入未保存。',
  loadingWorks: '正在载入作品数据…',
  emptyNoWorks: '还没有作品数据：先在正文编辑器新建作品并写第一章，这里会出现写作统计与目标进度。',
  emptyNoChapters: '还没有章节：先在正文编辑器新建章节，这里会出现字数最多的章节排行。',
  unnamedChapter: '未命名章节',
  noUpdate: '暂无更新',
} as const

/** 榜单条目：标题 + 字数。 */
export interface ChapterCharCount {
  readonly title: string
  readonly charCount: number
}

/** 写作统计总览（一次算全，供渲染层直接消费）。 */
export interface DashboardStats {
  readonly projectCount: number
  readonly chapterCount: number
  readonly totalChars: number
  readonly lastUpdatedAt: string | null
  readonly topChapters: readonly ChapterCharCount[]
}

/** 写作目标进度：`percent` 保留一位小数并夹在 0-100。 */
export interface GoalProgress {
  readonly percent: number
  readonly remaining: number
  readonly reached: boolean
  readonly hasGoal: boolean
}

/** 写作目标的保存态（`YfeStatusPill` 六态的子集）。 */
export type GoalSaveStatus = 'saving' | 'dirty' | 'error' | 'saved'

/** 未删章节：`kind === 'chapter'` 且 `deleted === 0`（DeletedFlag 数值语义）。 */
export function isAliveChapter(document: DocumentSummary): boolean {
  return document.kind === 'chapter' && document.deleted === 0
}

/** 作品数：`projectId` 去重。 */
export function countProjects(documents: readonly DocumentSummary[]): number {
  const projectIds = new Set<string>()
  for (const document of documents) {
    projectIds.add(String(document.projectId))
  }
  return projectIds.size
}

/** 章节总数：未删章节。 */
export function countChapters(documents: readonly DocumentSummary[]): number {
  let count = 0
  for (const document of documents) {
    if (isAliveChapter(document)) {
      count += 1
    }
  }
  return count
}

/** 总字数：未删章节的 `charCount` 求和。 */
export function sumChars(documents: readonly DocumentSummary[]): number {
  let total = 0
  for (const document of documents) {
    if (isAliveChapter(document)) {
      total += document.charCount
    }
  }
  return total
}

/**
 * 字数最多的章节前 N 条（标题 + 字数）。
 *
 * 只统计未删章节；字数并列时按 `orderKey` 再按 id 稳定排序；空标题回退为「未命名章节」。
 * 不修改入参数组顺序。
 */
export function topByChars(
  documents: readonly DocumentSummary[],
  limit: number,
): readonly ChapterCharCount[] {
  const rows = documents.filter(isAliveChapter).map((document) => ({
    id: String(document.id),
    orderKey: document.orderKey,
    title: document.title === '' ? DASHBOARD_COPY.unnamedChapter : document.title,
    charCount: document.charCount,
  }))
  rows.sort((left, right) => {
    if (left.charCount !== right.charCount) {
      return right.charCount - left.charCount
    }
    if (left.orderKey !== right.orderKey) {
      return left.orderKey < right.orderKey ? -1 : 1
    }
    if (left.id !== right.id) {
      return left.id < right.id ? -1 : 1
    }
    return 0
  })
  return rows
    .slice(0, Math.max(0, limit))
    .map((row) => ({ title: row.title, charCount: row.charCount }))
}

/** 最近更新时间：未删文档 `updatedAt` 的最大值；没有文档时为 null。 */
export function lastUpdatedAt(documents: readonly DocumentSummary[]): string | null {
  let latest: string | null = null
  for (const document of documents) {
    if (document.deleted !== 0) {
      continue
    }
    if (latest === null || document.updatedAt > latest) {
      latest = document.updatedAt
    }
  }
  return latest
}

/** 写作目标进度：当前作品总字数 vs 每日目标。目标缺失/非正数时按「无目标」处理。 */
export function progressOf(total: number, goal: number): GoalProgress {
  const hasGoal = Number.isFinite(goal) && goal > 0
  if (!hasGoal) {
    return { percent: 0, remaining: 0, reached: false, hasGoal: false }
  }
  const percent = Math.max(0, Math.min(100, Math.round((total / goal) * 1000) / 10))
  const remaining = Math.max(0, goal - total)
  return { percent, remaining, reached: total >= goal, hasGoal: true }
}

/** 千分位分组（自实现，避免运行环境 ICU 差异影响测试）。 */
export function formatChars(value: number): string {
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 最近更新时间展示：ISO 戳取 UTC 日期时间，不做时区转换；缺失/畸形回退为「暂无更新」。 */
export function formatUpdatedAt(iso: string | null): string {
  if (iso === null || iso === '') {
    return DASHBOARD_COPY.noUpdate
  }
  const date = iso.slice(0, 10)
  const time = iso.slice(11, 16)
  if (date.length < 10 || time.length < 5) {
    return DASHBOARD_COPY.noUpdate
  }
  return `${date} ${time}（UTC）`
}

/** 解析目标输入框：非负数字（可带小数，四舍五入）才接受；负数/非数字/空串返回 null。 */
export function parseGoalInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) {
    return null
  }
  return Math.round(value)
}

/** 保存态优先级：saving > error > dirty > saved（失败也标脏，错误优先展示）。 */
export function goalSaveStatus(saving: boolean, dirty: boolean, hasError: boolean): GoalSaveStatus {
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

/** 进度一句话文案（整句在 model 层拼好，视图只渲染）。 */
export function progressLine(progress: GoalProgress): string {
  if (!progress.hasGoal) {
    return DASHBOARD_COPY.goalNoGoal
  }
  if (progress.reached) {
    return DASHBOARD_COPY.goalReached
  }
  return `${DASHBOARD_COPY.goalPercentPrefix} ${progress.percent}%，${DASHBOARD_COPY.goalRemainingPrefix} ${formatChars(progress.remaining)} ${DASHBOARD_COPY.charsUnit}`
}

/** 聚合写作统计总览。 */
export function computeDashboardStats(documents: readonly DocumentSummary[]): DashboardStats {
  return {
    projectCount: countProjects(documents),
    chapterCount: countChapters(documents),
    totalChars: sumChars(documents),
    lastUpdatedAt: lastUpdatedAt(documents),
    topChapters: topByChars(documents, DASHBOARD_TOP_LIMIT),
  }
}

/** 供面板读取快照里的文档摘要列表（AppSnapshot.documents，`listDocumentTree` 之前为空数组）。 */
export function readDocuments(snapshot: AppSnapshot): readonly DocumentSummary[] {
  return snapshot.documents
}
