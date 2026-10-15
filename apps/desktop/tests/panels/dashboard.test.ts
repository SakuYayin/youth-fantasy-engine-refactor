import { describe, expect, it } from 'vitest'

import type { DocumentId, DocumentSummary, ProjectId, Revision, UtcTimestamp } from '@yfe/contracts'

import type { AppSnapshot } from '../../src/renderer/app-state.js'

import {
  DEFAULT_DAILY_GOAL,
  DASHBOARD_COPY,
  DASHBOARD_TOP_LIMIT,
  computeDashboardStats,
  countChapters,
  countProjects,
  formatChars,
  formatUpdatedAt,
  goalSaveStatus,
  isAliveChapter,
  lastUpdatedAt,
  parseGoalInput,
  progressLine,
  progressOf,
  readDocuments,
  sumChars,
  topByChars,
} from '../../src/renderer/panels/dashboard-model.js'

const AT = '2026-01-01T00:00:00.000Z'
const AT_LATER = '2026-01-02T12:30:00.000Z'

function ts(value: string): UtcTimestamp {
  return value as UtcTimestamp
}

interface SummaryInput {
  readonly id: string
  readonly title: string
  readonly kind?: DocumentSummary['kind']
  readonly projectId?: string
  readonly orderKey?: string
  readonly charCount?: number
  readonly deleted?: number
  readonly updatedAt?: string
}

function summary(input: SummaryInput): DocumentSummary {
  return {
    id: input.id as DocumentId,
    projectId: (input.projectId ?? 'prj_1') as ProjectId,
    kind: input.kind ?? 'chapter',
    parentId: null,
    orderKey: input.orderKey ?? 'A1',
    title: input.title,
    revision: 'rev_1' as Revision,
    deleted: input.deleted ?? 0,
    createdAt: ts(AT),
    updatedAt: ts(input.updatedAt ?? AT),
    charCount: input.charCount ?? 0,
    hasChildren: false,
  }
}

describe('常量', () => {
  it('默认目标 2000、榜单 5 条', () => {
    expect(DEFAULT_DAILY_GOAL).toBe(2000)
    expect(DASHBOARD_TOP_LIMIT).toBe(5)
  })
})

describe('isAliveChapter', () => {
  it('只认未删的章节文档（DeletedFlag 数值语义）', () => {
    expect(isAliveChapter(summary({ id: 'doc_1', title: '第一章' }))).toBe(true)
    expect(isAliveChapter(summary({ id: 'doc_2', title: '第一卷', kind: 'volume' }))).toBe(false)
    expect(isAliveChapter(summary({ id: 'doc_3', title: '草稿', kind: 'note' }))).toBe(false)
    expect(isAliveChapter(summary({ id: 'doc_4', title: '大纲', kind: 'outline' }))).toBe(false)
    expect(isAliveChapter(summary({ id: 'doc_5', title: '已删章节', deleted: 1 }))).toBe(false)
  })
})

describe('countProjects', () => {
  it('按 projectId 去重', () => {
    const documents = [
      summary({ id: 'doc_1', title: '第一章', projectId: 'prj_1' }),
      summary({ id: 'doc_2', title: '第二章', projectId: 'prj_1' }),
      summary({ id: 'doc_3', title: '另一本', projectId: 'prj_2' }),
    ]
    expect(countProjects(documents)).toBe(2)
  })

  it('空列表为 0', () => {
    expect(countProjects([])).toBe(0)
  })
})

describe('countChapters', () => {
  it('只数未删章节，卷/笔记与已删不计', () => {
    const documents = [
      summary({ id: 'doc_1', title: '第一章', charCount: 100 }),
      summary({ id: 'doc_2', title: '第一卷', kind: 'volume', charCount: 999 }),
      summary({ id: 'doc_3', title: '笔记', kind: 'note', charCount: 50 }),
      summary({ id: 'doc_4', title: '已删', deleted: 1, charCount: 70 }),
    ]
    expect(countChapters(documents)).toBe(1)
  })

  it('空列表为 0', () => {
    expect(countChapters([])).toBe(0)
  })
})

describe('sumChars', () => {
  it('只求未删章节的 charCount 之和（卷汇总不双算）', () => {
    const documents = [
      summary({ id: 'doc_1', title: '第一章', charCount: 1200 }),
      summary({ id: 'doc_2', title: '第二章', charCount: 800 }),
      summary({ id: 'doc_3', title: '第一卷', kind: 'volume', charCount: 2000 }),
      summary({ id: 'doc_4', title: '已删', deleted: 1, charCount: 500 }),
    ]
    expect(sumChars(documents)).toBe(2000)
  })

  it('空列表为 0', () => {
    expect(sumChars([])).toBe(0)
  })
})

describe('topByChars', () => {
  it('按字数降序取前 N，只统计未删章节', () => {
    const documents = [
      summary({ id: 'doc_1', title: '甲', charCount: 300, orderKey: 'A1' }),
      summary({ id: 'doc_2', title: '乙', charCount: 900, orderKey: 'A2' }),
      summary({ id: 'doc_3', title: '丙', charCount: 600, orderKey: 'A3' }),
      summary({ id: 'doc_4', title: '丁', charCount: 100, orderKey: 'A4' }),
      summary({ id: 'doc_5', title: '戊', charCount: 800, orderKey: 'A5' }),
      summary({ id: 'doc_6', title: '已删', charCount: 9900, deleted: 1, orderKey: 'A6' }),
      summary({ id: 'doc_7', title: '卷', kind: 'volume', charCount: 9800, orderKey: 'A7' }),
    ]
    expect(topByChars(documents, 3)).toEqual([
      { title: '乙', charCount: 900 },
      { title: '戊', charCount: 800 },
      { title: '丙', charCount: 600 },
    ])
  })

  it('limit 大于数量返回全部，limit 为 0 返回空', () => {
    const documents = [
      summary({ id: 'doc_1', title: '甲', charCount: 1 }),
      summary({ id: 'doc_2', title: '乙', charCount: 2 }),
    ]
    expect(topByChars(documents, 10)).toHaveLength(2)
    expect(topByChars(documents, 0)).toEqual([])
  })

  it('并列时按 orderKey 稳定排序，空标题回退为未命名章节', () => {
    const documents = [
      summary({ id: 'doc_2', title: '', charCount: 100, orderKey: 'B1' }),
      summary({ id: 'doc_1', title: '甲', charCount: 100, orderKey: 'A1' }),
    ]
    const top = topByChars(documents, DASHBOARD_TOP_LIMIT)
    expect(top[0]?.title).toBe('甲')
    expect(top[1]?.title).toBe(DASHBOARD_COPY.unnamedChapter)
  })

  it('不修改入参数组顺序', () => {
    const documents = [
      summary({ id: 'doc_1', title: '甲', charCount: 1, orderKey: 'A1' }),
      summary({ id: 'doc_2', title: '乙', charCount: 9, orderKey: 'A2' }),
    ]
    topByChars(documents, 2)
    expect(String(documents[0]?.id)).toBe('doc_1')
    expect(String(documents[1]?.id)).toBe('doc_2')
  })
})

describe('lastUpdatedAt', () => {
  it('取未删文档 updatedAt 的最大值（ISO 戳同格式比较即时间序）', () => {
    const documents = [
      summary({ id: 'doc_1', title: '甲', updatedAt: AT }),
      summary({ id: 'doc_2', title: '乙', updatedAt: AT_LATER }),
      summary({ id: 'doc_3', title: '已删', deleted: 1, updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(lastUpdatedAt(documents)).toBe(AT_LATER)
  })

  it('空列表为 null', () => {
    expect(lastUpdatedAt([])).toBeNull()
  })
})

describe('progressOf', () => {
  it('部分完成：百分比保留一位小数、剩余字数、未达标', () => {
    expect(progressOf(1000, 2000)).toEqual({
      percent: 50,
      remaining: 1000,
      reached: false,
      hasGoal: true,
    })
    expect(progressOf(1, 3).percent).toBe(33.3)
  })

  it('达标：percent 100、remaining 0、reached true', () => {
    expect(progressOf(2500, 2000)).toEqual({
      percent: 100,
      remaining: 0,
      reached: true,
      hasGoal: true,
    })
  })

  it('目标为 0 / 负数 / 非有限数：按无目标处理', () => {
    expect(progressOf(500, 0)).toEqual({
      percent: 0,
      remaining: 0,
      reached: false,
      hasGoal: false,
    })
    expect(progressOf(500, -100).hasGoal).toBe(false)
    expect(progressOf(500, Number.NaN).hasGoal).toBe(false)
  })

  it('总字数 0 且有目标：percent 0', () => {
    expect(progressOf(0, 2000).percent).toBe(0)
  })
})

describe('formatChars', () => {
  it('千分位分组（自实现，不依赖 ICU）', () => {
    expect(formatChars(0)).toBe('0')
    expect(formatChars(999)).toBe('999')
    expect(formatChars(12345)).toBe('12,345')
    expect(formatChars(1234567)).toBe('1,234,567')
  })
})

describe('formatUpdatedAt', () => {
  it('null/空串回退为「暂无更新」', () => {
    expect(formatUpdatedAt(null)).toBe(DASHBOARD_COPY.noUpdate)
    expect(formatUpdatedAt('')).toBe(DASHBOARD_COPY.noUpdate)
  })

  it('ISO 戳显示为 UTC 日期时间，不做时区转换', () => {
    expect(formatUpdatedAt('2026-01-02T12:30:00.000Z')).toBe('2026-01-02 12:30（UTC）')
  })

  it('畸形时间戳回退为「暂无更新」', () => {
    expect(formatUpdatedAt('不是时间')).toBe(DASHBOARD_COPY.noUpdate)
  })
})

describe('parseGoalInput', () => {
  it('接受非负数字并四舍五入为整数', () => {
    expect(parseGoalInput('2000')).toBe(2000)
    expect(parseGoalInput(' 3000 ')).toBe(3000)
    expect(parseGoalInput('12.6')).toBe(13)
    expect(parseGoalInput('0')).toBe(0)
  })

  it('拒绝负数、非数字、空串与科学计数法', () => {
    expect(parseGoalInput('-5')).toBeNull()
    expect(parseGoalInput('abc')).toBeNull()
    expect(parseGoalInput('')).toBeNull()
    expect(parseGoalInput('1e3')).toBeNull()
  })
})

describe('goalSaveStatus', () => {
  it('优先级 saving > error > dirty > saved', () => {
    expect(goalSaveStatus(true, false, false)).toBe('saving')
    expect(goalSaveStatus(false, true, true)).toBe('error')
    expect(goalSaveStatus(false, true, false)).toBe('dirty')
    expect(goalSaveStatus(false, false, false)).toBe('saved')
  })
})

describe('progressLine', () => {
  it('部分完成拼完整进度句（整句由 model 拼好）', () => {
    expect(progressLine(progressOf(1000, 2000))).toBe('已完成 50%，还差 1,000 字')
  })

  it('达标与无目标各有固定文案', () => {
    expect(progressLine(progressOf(2500, 2000))).toBe(DASHBOARD_COPY.goalReached)
    expect(progressLine(progressOf(0, 0))).toBe(DASHBOARD_COPY.goalNoGoal)
  })
})

describe('readDocuments', () => {
  it('读快照的 documents 字段，缺省为空数组', () => {
    const snapshot = {
      ready: true,
      loading: false,
      appVersion: null,
      databasePath: null,
      databaseSchemaVersion: null,
      readOnly: false,
      pendingOutboxCount: 0,
      lastSavedAt: null,
      projectId: null,
      tree: [],
      documents: [summary({ id: 'doc_1', title: '甲' })],
      selectedDocumentId: null,
      title: '',
      body: '',
      charCount: 0,
      revision: null,
      saveStatus: 'saved',
      saveDetail: null,
      conflict: null,
      lastError: null,
      expandedIds: [],
      settingsEntities: [],
      settingsLoading: false,
      selectedSettingsEntityId: null,
      selectedSettingsEntity: null,
    } as AppSnapshot
    expect(readDocuments(snapshot)).toEqual([summary({ id: 'doc_1', title: '甲' })])
  })
})

describe('computeDashboardStats', () => {
  it('聚合四个统计与 Top5', () => {
    const documents = [
      summary({
        id: 'doc_1',
        title: '第一章',
        charCount: 1200,
        projectId: 'prj_1',
        orderKey: 'A1',
        updatedAt: AT,
      }),
      summary({
        id: 'doc_2',
        title: '第二章',
        charCount: 800,
        projectId: 'prj_1',
        orderKey: 'A2',
        updatedAt: AT_LATER,
      }),
      summary({
        id: 'doc_3',
        title: '另一本第一章',
        charCount: 2000,
        projectId: 'prj_2',
        orderKey: 'A1',
      }),
    ]
    expect(computeDashboardStats(documents)).toEqual({
      projectCount: 2,
      chapterCount: 3,
      totalChars: 4000,
      lastUpdatedAt: AT_LATER,
      topChapters: [
        { title: '另一本第一章', charCount: 2000 },
        { title: '第一章', charCount: 1200 },
        { title: '第二章', charCount: 800 },
      ],
    })
  })

  it('空列表全为零值', () => {
    expect(computeDashboardStats([])).toEqual({
      projectCount: 0,
      chapterCount: 0,
      totalChars: 0,
      lastUpdatedAt: null,
      topChapters: [],
    })
  })
})
