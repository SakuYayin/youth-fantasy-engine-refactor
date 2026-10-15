/**
 * 创作轨迹面板纯逻辑（trajectory-model）的测试：时间解析 / 分组 / 汇总 / 快照读取 / 文案。
 *
 * node 环境（纯函数，无 DOM）。
 */
import { describe, expect, it } from 'vitest'

import type { DocumentId, DocumentSummary, ProjectId, Revision, UtcTimestamp } from '@yfe/contracts'

import type { AppSnapshot } from '../../src/renderer/app-state.js'
import {
  EMPTY_TITLE_LABEL,
  NO_TIME_LABEL,
  RECENT_WINDOW_DAYS,
  SUMMARY_LABEL_RECENT,
  TRAJECTORY_DISCLAIMER,
  UNKNOWN_DAY_KEY,
  UNKNOWN_DAY_LABEL,
  UNIT_CHARS,
  UNIT_DAYS,
  UNIT_DOCS,
  activeDays,
  buildTrajectoryView,
  formatCharCount,
  formatGroupCount,
  formatInvalidNote,
  groupByDay,
  parseUtcDayKey,
  parseUtcTimeLabel,
  readSnapshotDocuments,
  recentCount,
  totalChars,
  type TrajectoryGroup,
} from '../../src/renderer/panels/trajectory-model.js'

/** 缺省时间戳（固定值，保证测试可重复）。 */
const DEFAULT_TS = '2026-10-15T08:00:00.000Z'

/**
 * 构造最小文档摘要（DocumentSummary 结构）。
 *
 * 固定 id / revision 保证可重复；品牌类型用字面量断言构造（与 `ids.ts` 的
 * 运行时构造等价，品牌只在编译期存在）。非法时间戳是刻意的测试数据——
 * 用来验证容错路径，不进正常数据流。
 */
function doc(input: {
  id?: string
  title?: string
  charCount?: number
  deleted?: number
  updatedAt?: string
}): DocumentSummary {
  const updatedAt = (input.updatedAt ?? DEFAULT_TS) as UtcTimestamp
  return {
    id: (input.id ?? 'doc-1') as DocumentId,
    projectId: 'prj_1' as ProjectId,
    kind: 'chapter',
    parentId: null,
    orderKey: 'k',
    title: input.title ?? '第一章',
    revision: 'r00000001' as Revision,
    createdAt: updatedAt,
    updatedAt,
    deleted: input.deleted ?? 0,
    charCount: input.charCount ?? 0,
    hasChildren: false,
  }
}

/** 构造最小快照（只含本面板读取的 `documents` 字段；其余字段与本面板无关）。 */
function snapshot(documents: unknown): AppSnapshot {
  return { documents } as unknown as AppSnapshot
}

describe('parseUtcDayKey / parseUtcTimeLabel：时间解析与容错', () => {
  it('ISO 时间戳解析成 UTC 日期键与 HH:mm', () => {
    expect(parseUtcDayKey('2026-10-15T08:30:45.123Z')).toBe('2026-10-15')
    expect(parseUtcTimeLabel('2026-10-15T08:30:45.123Z')).toBe('08:30')
  })

  it('分组统一用 UTC：23:30Z 属于当天，跨时区偏移不改组', () => {
    expect(parseUtcDayKey('2026-10-15T23:30:00.000Z')).toBe('2026-10-15')
    expect(parseUtcTimeLabel('2026-10-15T23:30:00.000Z')).toBe('23:30')
    expect(parseUtcDayKey('2026-01-01T00:05:00.000Z')).toBe('2026-01-01')
    expect(parseUtcTimeLabel('2026-01-01T00:05:00.000Z')).toBe('00:05')
  })

  it('毫秒时间戳与 ISO 等价', () => {
    const ms = Date.parse('2026-10-15T08:30:00.000Z')
    expect(parseUtcDayKey(ms)).toBe('2026-10-15')
    expect(parseUtcTimeLabel(ms)).toBe('08:30')
  })

  it('非法时间戳容错：返回 null / NO_TIME_LABEL，不抛错', () => {
    expect(parseUtcDayKey('not-a-date')).toBeNull()
    expect(parseUtcDayKey('')).toBeNull()
    expect(parseUtcDayKey('   ')).toBeNull()
    expect(parseUtcDayKey(null)).toBeNull()
    expect(parseUtcDayKey(undefined)).toBeNull()
    expect(parseUtcDayKey(Number.NaN)).toBeNull()
    expect(parseUtcDayKey(Number.POSITIVE_INFINITY)).toBeNull()
    expect(parseUtcDayKey({})).toBeNull()
    expect(parseUtcTimeLabel('garbage')).toBe(NO_TIME_LABEL)
    expect(parseUtcTimeLabel(Number.NaN)).toBe(NO_TIME_LABEL)
    expect(parseUtcTimeLabel(undefined)).toBe(NO_TIME_LABEL)
  })
})

describe('groupByDay：按天分组', () => {
  it('空列表返回空数组', () => {
    expect(groupByDay([])).toEqual([])
  })

  it('软删文档被过滤（deleted 非零即删，脏值也生效）', () => {
    const groups = groupByDay([
      doc({ id: 'doc-live', updatedAt: '2026-10-15T08:00:00.000Z' }),
      doc({ id: 'doc-deleted', deleted: 1, updatedAt: '2026-10-15T09:00:00.000Z' }),
      doc({ id: 'doc-dirty', deleted: 2, updatedAt: '2026-10-15T10:00:00.000Z' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(['doc-live'])
  })

  it('按 UTC 日期倒序分组，组内按更新时间倒序', () => {
    const groups = groupByDay([
      doc({ id: 'doc-early', updatedAt: '2026-10-15T08:00:00.000Z' }),
      doc({ id: 'doc-late', updatedAt: '2026-10-15T09:00:00.000Z' }),
      doc({ id: 'doc-old', updatedAt: '2026-10-14T23:30:00.000Z' }),
    ])
    expect(groups.map((group) => group.dayKey)).toEqual(['2026-10-15', '2026-10-14'])
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(['doc-late', 'doc-early'])
    expect(groups[0]?.label).toBe('2026-10-15')
    expect(groups[0]?.entries[0]?.timeLabel).toBe('09:00')
    expect(groups[1]?.entries[0]?.timeLabel).toBe('23:30')
  })

  it('非法时间戳归入「未知」组且排最后，保持输入顺序', () => {
    const groups = groupByDay([
      doc({ id: 'doc-bad-1', updatedAt: 'garbage-1' }),
      doc({ id: 'doc-ok', updatedAt: '2026-10-15T08:00:00.000Z' }),
      doc({ id: 'doc-bad-2', updatedAt: 'garbage-2' }),
    ])
    expect(groups.map((group) => group.dayKey)).toEqual(['2026-10-15', UNKNOWN_DAY_KEY])
    const unknown = groups[1]
    expect(unknown?.label).toBe(UNKNOWN_DAY_LABEL)
    expect(unknown?.entries.map((entry) => entry.id)).toEqual(['doc-bad-1', 'doc-bad-2'])
    expect(unknown?.entries[0]?.timeLabel).toBe(NO_TIME_LABEL)
  })

  it('同毫秒并列按 id 升序，输出确定', () => {
    const groups = groupByDay([
      doc({ id: 'doc-b', charCount: 1 }),
      doc({ id: 'doc-a', charCount: 2 }),
    ])
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(['doc-a', 'doc-b'])
  })

  it('空标题与纯空白标题回落「（未命名）」', () => {
    const groups = groupByDay([
      doc({ id: 'doc-empty', title: '' }),
      doc({ id: 'doc-blank', title: '   ' }),
      doc({ id: 'doc-named', title: '第三章' }),
    ])
    expect(groups[0]?.entries.map((entry) => entry.title)).toEqual([
      EMPTY_TITLE_LABEL,
      EMPTY_TITLE_LABEL,
      '第三章',
    ])
  })

  it('非法字数按 0 计', () => {
    const groups = groupByDay([doc({ charCount: -5 })])
    expect(groups[0]?.entries[0]?.charCount).toBe(0)
  })
})

describe('activeDays / recentCount / totalChars：汇总', () => {
  it('活跃天数 = 有更新记录的日期数，「未知」组与空组不计入', () => {
    const groups = groupByDay([
      doc({ id: 'doc-a', updatedAt: '2026-10-15T08:00:00.000Z' }),
      doc({ id: 'doc-b', updatedAt: '2026-10-14T08:00:00.000Z' }),
      doc({ id: 'doc-c', updatedAt: 'garbage' }),
    ])
    expect(activeDays(groups)).toBe(2)
    const emptyGroup: TrajectoryGroup = { dayKey: '2026-10-13', label: '2026-10-13', entries: [] }
    expect(activeDays([emptyGroup])).toBe(0)
  })

  it('最近 7 天更新数：窗口边界含终点，未来时间戳与非法时间戳不计入', () => {
    const now = new Date('2026-10-15T12:00:00.000Z')
    const documents = [
      doc({ id: 'doc-1h', updatedAt: '2026-10-15T11:00:00.000Z' }),
      doc({ id: 'doc-edge', updatedAt: '2026-10-08T12:00:00.000Z' }),
      doc({ id: 'doc-out', updatedAt: '2026-10-08T11:59:59.000Z' }),
      doc({ id: 'doc-future', updatedAt: '2026-10-15T13:00:00.000Z' }),
      doc({ id: 'doc-deleted', deleted: 1, updatedAt: '2026-10-15T11:00:00.000Z' }),
      doc({ id: 'doc-bad', updatedAt: 'garbage' }),
    ]
    expect(recentCount(documents, 7, now)).toBe(2)
    expect(recentCount(documents, 0, now)).toBe(0)
    expect(recentCount(documents, -1, now)).toBe(0)
    expect(recentCount([], 7, now)).toBe(0)
  })

  it('累计字数：未删文档求和，软删与非正字数不计入', () => {
    const documents = [
      doc({ id: 'doc-a', charCount: 1000 }),
      doc({ id: 'doc-b', charCount: 2000 }),
      doc({ id: 'doc-deleted', deleted: 1, charCount: 500 }),
      doc({ id: 'doc-negative', charCount: -5 }),
    ]
    expect(totalChars(documents)).toBe(3000)
    expect(totalChars([])).toBe(0)
  })
})

describe('readSnapshotDocuments：快照读取', () => {
  it('documents 是数组：available=true 且未删过滤前原样返回', () => {
    const documents = [doc({ id: 'doc-a' }), doc({ id: 'doc-b', deleted: 1 })]
    const result = readSnapshotDocuments(snapshot(documents))
    expect(result.available).toBe(true)
    expect(result.documents).toHaveLength(2)
  })

  it('缺 documents 字段：available=false（Lead 侧字段未透传时不抛错）', () => {
    const result = readSnapshotDocuments(snapshot(undefined))
    expect(result.available).toBe(false)
    expect(result.documents).toEqual([])
  })

  it('documents 不是数组：available=false', () => {
    const result = readSnapshotDocuments(snapshot('not-an-array'))
    expect(result.available).toBe(false)
    expect(result.documents).toEqual([])
  })

  it('documents 里非对象条目被过滤，不抛错', () => {
    const result = readSnapshotDocuments(snapshot([doc({ id: 'doc-a' }), 'nope', null, 42]))
    expect(result.available).toBe(true)
    expect(result.documents).toHaveLength(1)
  })
})

describe('buildTrajectoryView：组装', () => {
  it('完整快照：汇总三项 + 分组顺序 + 非法时间戳计数', () => {
    const now = new Date('2026-10-15T12:00:00.000Z')
    const documents = [
      doc({ id: 'doc-a', updatedAt: '2026-10-15T09:00:00.000Z', charCount: 1200 }),
      doc({ id: 'doc-b', updatedAt: '2026-10-14T10:00:00.000Z', charCount: 800 }),
      doc({ id: 'doc-c', updatedAt: 'garbage', charCount: 500 }),
      doc({ id: 'doc-d', deleted: 1, updatedAt: '2026-10-15T10:00:00.000Z', charCount: 999 }),
    ]
    const view = buildTrajectoryView(snapshot(documents), now)
    expect(view.available).toBe(true)
    expect(view.documentCount).toBe(3)
    expect(view.summary.activeDayCount).toBe(2)
    expect(view.summary.recentCount).toBe(2)
    expect(view.summary.totalCharCount).toBe(2500)
    expect(view.groups.map((group) => group.dayKey)).toEqual([
      '2026-10-15',
      '2026-10-14',
      UNKNOWN_DAY_KEY,
    ])
    expect(view.malformedCount).toBe(1)
  })

  it('数据不可用：零值汇总 + available=false + 空分组', () => {
    const view = buildTrajectoryView(snapshot(undefined), new Date())
    expect(view.available).toBe(false)
    expect(view.groups).toEqual([])
    expect(view.summary).toEqual({ activeDayCount: 0, recentCount: 0, totalCharCount: 0 })
    expect(view.malformedCount).toBe(0)
    expect(view.documentCount).toBe(0)
  })
})

describe('文案与格式化常量', () => {
  it('口径说明显式声明暂无逐次会话记录', () => {
    expect(TRAJECTORY_DISCLAIMER).toBe('轨迹按章节更新时间统计（暂无逐次会话记录）')
  })

  it('最近 N 天窗口为 7 天，汇总标签带上窗口', () => {
    expect(RECENT_WINDOW_DAYS).toBe(7)
    expect(SUMMARY_LABEL_RECENT).toBe(`最近 ${RECENT_WINDOW_DAYS} 天更新数`)
  })

  it('「未知」组与占位文案', () => {
    expect(UNKNOWN_DAY_KEY).toBe('unknown')
    expect(UNKNOWN_DAY_LABEL).toBe('未知')
    expect(NO_TIME_LABEL).toBe('—')
    expect(EMPTY_TITLE_LABEL).toBe('（未命名）')
  })

  it('单位与格式化函数', () => {
    expect(UNIT_DAYS).toBe('天')
    expect(UNIT_DOCS).toBe('篇')
    expect(UNIT_CHARS).toBe('字')
    expect(formatGroupCount(3)).toBe('3 篇更新')
    expect(formatInvalidNote(2)).toBe('有 2 条记录的更新时间无法解析，已归入「未知」组。')
    expect(formatCharCount(1234567)).toBe('1,234,567')
    expect(formatCharCount(0)).toBe('0')
    expect(formatCharCount(-1)).toBe('0')
  })
})
