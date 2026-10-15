/**
 * 创作轨迹面板（type=trajectory，分组=创作管理）的纯逻辑层。
 *
 * 权威文档：`docs/接口冻结-面板层.md`（§2 PanelProps / §3 持久化 / §5 文件所有权 / §6 验收）。
 *
 * 【它回答什么问题】作者要投稿、要跟编辑解释时，需要按天回看
 * 「每一章是什么时候改出来的」。旧版有写作会话历史（逐次快照 / 每日字数），
 * 本项目没有——轨迹只能从文档的更新时间戳推导，面板顶部用
 * `TRAJECTORY_DISCLAIMER` 显式写明这一口径，绝不假装有逐次记录。
 *
 * 三条纪律（与旧版 TrajectoryPanel 一致）：
 * 1. 只如实呈现：缺数据就写「没有」，不补全、不推测、不美化；
 * 2. 不采集输入：数据全部来自 `props.state.getSnapshot().documents`（未删的），
 *    无键盘记录、无网络请求；
 * 3. 无副作用：本文件只有纯函数与常量，不碰 state 之外的任何入口。
 *
 * 时间口径：分组与展示统一用 UTC（日期 `YYYY-MM-DD`、时间 `HH:mm`），
 * 与「按天分组」自洽——混用本地时区会出现条目时间不属于所在组日期的错位。
 */
import type { DocumentSummary } from '@yfe/contracts'

import type { AppSnapshot } from '../app-state.js'

// ---------------------------------------------------------------------------
// 文案常量（面板可见文本的唯一来源）
// ---------------------------------------------------------------------------

/** 统计口径说明：本项目没有逐次写作会话记录，轨迹按章节更新时间推导。 */
export const TRAJECTORY_DISCLAIMER = '轨迹按章节更新时间统计（暂无逐次会话记录）'

/** 非法时间戳条目归入的组（排在所有日期组之后）。 */
export const UNKNOWN_DAY_KEY = 'unknown'
/** 「未知」组的显示名。 */
export const UNKNOWN_DAY_LABEL = '未知'

/** 「最近 N 天更新数」的窗口（天）。 */
export const RECENT_WINDOW_DAYS = 7

/** 汇总卡三项的标签。 */
export const SUMMARY_LABEL_ACTIVE = '活跃天数'
export const SUMMARY_LABEL_RECENT = `最近 ${RECENT_WINDOW_DAYS} 天更新数`
export const SUMMARY_LABEL_TOTAL = '累计字数'

/** 汇总卡数值的单位。 */
export const UNIT_DAYS = '天'
export const UNIT_DOCS = '篇'
export const UNIT_CHARS = '字'

/** 条目没有合法时间戳时显示的时间占位。 */
export const NO_TIME_LABEL = '—'
/** 标题为空（或全是空白）时的显示名。 */
export const EMPTY_TITLE_LABEL = '（未命名）'

/** 空态引导：可见记录为空时告诉用户怎么让轨迹出现。 */
export const EMPTY_HINT = '还没有章节更新记录。新建或编辑一章后，这里会按天列出创作轨迹。'
/** 数据不可用引导：快照里读不到章节列表时如实说明。 */
export const UNAVAILABLE_HINT = '暂无法读取章节列表，轨迹暂不可用。请先在写作页创建作品后再回到本页查看。'

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/** 时间线上的一个条目（一条未删文档）。 */
export interface TrajectoryEntry {
  readonly id: string
  /** 显示标题；空标题回落到 `EMPTY_TITLE_LABEL`。 */
  readonly title: string
  readonly charCount: number
  /** `HH:mm`（UTC）；无合法时间戳时为 `NO_TIME_LABEL`。 */
  readonly timeLabel: string
  /** 解析出的毫秒时间戳；无合法时间戳时为 null（排序时保持输入顺序）。 */
  readonly updatedAtMs: number | null
}

/** 一天的分组。 */
export interface TrajectoryGroup {
  /** `YYYY-MM-DD`（UTC），或 `UNKNOWN_DAY_KEY`。 */
  readonly dayKey: string
  /** 显示名：`dayKey` 或 `UNKNOWN_DAY_LABEL`。 */
  readonly label: string
  /** 组内条目，按更新时间倒序（「未知」组保持输入顺序）。 */
  readonly entries: readonly TrajectoryEntry[]
}

/** 汇总卡三项。 */
export interface TrajectorySummary {
  /** 活跃天数：有更新记录的日期数（「未知」组不计入）。 */
  readonly activeDayCount: number
  /** 最近 `RECENT_WINDOW_DAYS` 天内有更新的文档数。 */
  readonly recentCount: number
  /** 未删文档的累计字数。 */
  readonly totalCharCount: number
}

/** 面板渲染所需的全部数据。 */
export interface TrajectoryView {
  readonly summary: TrajectorySummary
  /** 日期组，倒序；「未知」组在最后；无可渲染条目时为空数组。 */
  readonly groups: readonly TrajectoryGroup[]
  /** `false` = 快照里读不到章节列表（`documents` 缺失或不是数组）。 */
  readonly available: boolean
  /** 更新时间无法解析的条目数（已归入「未知」组）。 */
  readonly malformedCount: number
  /** 未删文档数（`available` 时才有意义）。 */
  readonly documentCount: number
}

// ---------------------------------------------------------------------------
// 时间解析（容错：非法输入返回 null，不抛错）
// ---------------------------------------------------------------------------

/**
 * 字符串必须长得像 ISO-8601 日期/日期时间才交给 `Date.parse`。
 *
 * V8（Node 24）对非 ISO 字符串回退到极宽松的历史解析器：
 * `Date.parse('garbage-1')` 会得到一个真实日期而不是 NaN，
 * 所以先用格式守卫挡住明显不像时间戳的字符串，再用 NaN 兜底
 * （挡住形状对但数值越界的输入，如 `2000-13-45T99:99:99.999Z`）。
 */
const ISO_LIKE_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** 把任意输入解析成毫秒时间戳；解析不出返回 null。 */
function toTimestampMs(timestamp: unknown): number | null {
  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof timestamp !== 'string' || timestamp.trim() === '') {
    return null
  }
  const text = timestamp.trim()
  if (!ISO_LIKE_DATE.test(text)) {
    return null
  }
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : ms
}

/** 时间戳 → UTC 日期键 `YYYY-MM-DD`；解析不出返回 null。 */
export function parseUtcDayKey(timestamp: unknown): string | null {
  const ms = toTimestampMs(timestamp)
  if (ms === null) return null
  const date = new Date(ms)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 时间戳 → `HH:mm`（UTC）；解析不出返回 `NO_TIME_LABEL`。 */
export function parseUtcTimeLabel(timestamp: unknown): string {
  const ms = toTimestampMs(timestamp)
  if (ms === null) return NO_TIME_LABEL
  const date = new Date(ms)
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// ---------------------------------------------------------------------------
// 文档 → 条目
// ---------------------------------------------------------------------------

function toDisplayTitle(value: unknown): string {
  if (typeof value !== 'string') return EMPTY_TITLE_LABEL
  return value.trim().length > 0 ? value : EMPTY_TITLE_LABEL
}

function toCharCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 一条文档 → 时间线条目（标题/字数归一化，时间容错）。 */
export function toEntry(document: DocumentSummary): TrajectoryEntry {
  const ms = toTimestampMs(document.updatedAt)
  return {
    id: document.id,
    title: toDisplayTitle(document.title),
    charCount: toCharCount(document.charCount),
    timeLabel: ms === null ? NO_TIME_LABEL : parseUtcTimeLabel(document.updatedAt),
    updatedAtMs: ms,
  }
}

/** 软删标志：SQLite 返回整数，历史数据可能有非 0/1 的脏值，比较必须用 `!== 0`。 */
function isDeleted(document: DocumentSummary): boolean {
  return document.deleted !== 0
}

/**
 * 从快照里读章节列表。
 *
 * `AppSnapshot` 当前版本不声明 `documents`（Lead 侧字段）：`in` 收窄对非联合类型
 * 不会补出属性，所以用「结构化子类型」读取——`AppSnapshot` 可赋给
 * `{ readonly documents?: unknown }`，缺失或不是数组时回 `available: false`
 * （面板如实显示「暂不可用」），Lead 透传字段后无需改本文件。
 */
export function readSnapshotDocuments(snapshot: AppSnapshot): {
  readonly available: boolean
  readonly documents: readonly DocumentSummary[]
} {
  const loose: { readonly documents?: unknown } = snapshot
  const raw: unknown = loose.documents
  if (!Array.isArray(raw)) {
    return { available: false, documents: [] }
  }
  return { available: true, documents: raw.filter(isDocumentSummaryLike) }
}

/** 契约之外的防御：非对象条目不进时间线（不计入统计，也不抛错）。 */
function isDocumentSummaryLike(value: unknown): value is DocumentSummary {
  return typeof value === 'object' && value !== null && 'id' in value
}

// ---------------------------------------------------------------------------
// 分组 / 汇总
// ---------------------------------------------------------------------------

/** 组内条目排序：更新时间倒序；同毫秒按 id 升序（稳定确定性）；无时间戳保序。 */
function compareEntriesDesc(a: TrajectoryEntry, b: TrajectoryEntry): number {
  if (a.updatedAtMs === null || b.updatedAtMs === null) return 0
  if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 按天分组：把未删文档按 `updatedAt` 的 UTC 日期倒序分组，
 * 组内按更新时间倒序；非法时间戳归入「未知」组（排在最后，保持输入顺序）。
 */
export function groupByDay(documents: readonly DocumentSummary[]): readonly TrajectoryGroup[] {
  const buckets = new Map<string, TrajectoryEntry[]>()
  for (const document of documents) {
    if (isDeleted(document)) continue
    const dayKey = parseUtcDayKey(document.updatedAt)
    const key = dayKey ?? UNKNOWN_DAY_KEY
    const entry = toEntry(document)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [entry])
    else bucket.push(entry)
  }

  const dayKeys = [...buckets.keys()]
    .filter((key) => key !== UNKNOWN_DAY_KEY)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const orderedKeys = buckets.has(UNKNOWN_DAY_KEY) ? [...dayKeys, UNKNOWN_DAY_KEY] : dayKeys

  return orderedKeys.map((key) => {
    const entries = buckets.get(key) ?? []
    const sorted = key === UNKNOWN_DAY_KEY ? entries : [...entries].sort(compareEntriesDesc)
    return {
      dayKey: key,
      label: key === UNKNOWN_DAY_KEY ? UNKNOWN_DAY_LABEL : key,
      entries: sorted,
    }
  })
}

/** 活跃天数：有更新记录的日期数（「未知」组与空组不计入）。 */
export function activeDays(groups: readonly TrajectoryGroup[]): number {
  return groups.filter((group) => group.dayKey !== UNKNOWN_DAY_KEY && group.entries.length > 0)
    .length
}

/**
 * 最近 `days` 天内有更新的未删文档数。
 *
 * 口径：`0 ≤ now − updatedAt ≤ days × 24h`（未来时间戳是时钟偏差，不计入）；
 * 非法时间戳不计入。`now` 供测试注入固定时钟。
 */
export function recentCount(
  documents: readonly DocumentSummary[],
  days: number,
  now: Date = new Date(),
): number {
  if (!(days > 0)) return 0
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) return 0
  const windowMs = days * 24 * 60 * 60 * 1000
  let count = 0
  for (const document of documents) {
    if (isDeleted(document)) continue
    const ms = toTimestampMs(document.updatedAt)
    if (ms === null) continue
    const age = nowMs - ms
    if (age >= 0 && age <= windowMs) count += 1
  }
  return count
}

/** 未删文档的累计字数（字数缺失/非法按 0 计）。 */
export function totalChars(documents: readonly DocumentSummary[]): number {
  let total = 0
  for (const document of documents) {
    if (isDeleted(document)) continue
    total += toCharCount(document.charCount)
  }
  return total
}

// ---------------------------------------------------------------------------
// 展示格式化
// ---------------------------------------------------------------------------

/** 字数 → 千分位字符串（手写分组，不依赖运行环境的 ICU 差异）。 */
export function formatCharCount(value: number): string {
  const digits = String(Math.trunc(Math.max(0, value)))
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 一天的更新数 → `N 篇更新`。 */
export function formatGroupCount(count: number): string {
  return `${count} 篇更新`
}

/** 非法时间戳条目的汇总说明。 */
export function formatInvalidNote(count: number): string {
  return `有 ${count} 条记录的更新时间无法解析，已归入「未知」组。`
}

// ---------------------------------------------------------------------------
// 组装：快照 → 视图
// ---------------------------------------------------------------------------

/**
 * 快照 → 面板视图。`documents` 读不到时回零值 + `available: false`，
 * 面板据此显示「暂不可用」引导；`now` 供测试注入固定时钟。
 */
export function buildTrajectoryView(snapshot: AppSnapshot, now: Date = new Date()): TrajectoryView {
  const { available, documents } = readSnapshotDocuments(snapshot)
  if (!available) {
    return {
      summary: { activeDayCount: 0, recentCount: 0, totalCharCount: 0 },
      groups: [],
      available: false,
      malformedCount: 0,
      documentCount: 0,
    }
  }

  const active = documents.filter((document) => !isDeleted(document))
  const groups = groupByDay(documents)
  let malformedCount = 0
  for (const document of active) {
    if (parseUtcDayKey(document.updatedAt) === null) malformedCount += 1
  }

  return {
    summary: {
      activeDayCount: activeDays(groups),
      recentCount: recentCount(documents, RECENT_WINDOW_DAYS, now),
      totalCharCount: totalChars(documents),
    },
    groups,
    available: true,
    malformedCount,
    documentCount: active.length,
  }
}
