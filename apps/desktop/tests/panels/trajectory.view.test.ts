// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 创作轨迹面板挂载测试（`trajectory.vue`，tab.id = `trajectory`，分组 = 创作管理）。
 *
 * 验证运行时接线：
 * - 页签元数据（标题=页签名、副标题=页签描述）与统计口径说明正确渲染；
 * - 顶部汇总卡三项 + 按天时间线（日期组倒序、组内条目倒序）渲染的是
 *   `trajectory-model` 对同一份快照的输出（接线正确，不重复断言模型内部）；
 * - 空态 / 数据不可态显式中文引导；
 * - 可见文本 ⊆ 页签文案 ∪ 常量 ∪ 文档数据经模型派生的字符串（接口冻结 §6 验收 2）；
 * - 订阅状态机、卸载时退订。
 *
 * 测试数据用「距现在 N 毫秒前」的相对时间戳构造：视图内部 `new Date()` 只影响
 * recentCount 的 7 天窗口，1h/2h/3d 的偏移恒在窗口内，因此期望值从同一份
 * 快照派生后与运行日期无关（可重复）。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type { DocumentId, DocumentSummary, ProjectId, Revision, UtcTimestamp } from '@yfe/contracts'

import type { AppState } from '../../src/renderer/app-state.js'
import {
  EMPTY_HINT,
  SUMMARY_LABEL_ACTIVE,
  SUMMARY_LABEL_RECENT,
  SUMMARY_LABEL_TOTAL,
  TRAJECTORY_DISCLAIMER,
  UNAVAILABLE_HINT,
  UNIT_CHARS,
  UNIT_DAYS,
  UNIT_DOCS,
  buildTrajectoryView,
  formatCharCount,
  formatGroupCount,
  formatInvalidNote,
  groupByDay,
} from '../../src/renderer/panels/trajectory-model.js'
import Trajectory from '../../src/renderer/panels/trajectory.vue'

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

/** 构造最小文档摘要（与 trajectory.test.ts 同一构造：固定 id / revision 可重复）。 */
function doc(input: {
  id?: string
  title?: string
  charCount?: number
  deleted?: number
  updatedAt?: string
}): DocumentSummary {
  const updatedAt = (input.updatedAt ?? '2026-10-15T08:00:00.000Z') as UtcTimestamp
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

const HOUR_MS = 60 * 60 * 1000
const NOW_MS = Date.now()

/** 距现在 `ms` 毫秒前的 UTC ISO 时间戳（单一 NOW_MS 基准，保证组内一致性）。 */
function ago(ms: number): string {
  return new Date(NOW_MS - ms).toISOString()
}

/** 主数据集：今天两条 + 3 天前一条 + 软删一条 + 非法时间戳一条。 */
const DOCS: readonly DocumentSummary[] = [
  doc({ id: 'doc-today-1', title: '第一章 觉醒', charCount: 3200, updatedAt: ago(1 * HOUR_MS) }),
  doc({ id: 'doc-today-2', title: '第二章 试炼', charCount: 2800, updatedAt: ago(2 * HOUR_MS) }),
  doc({
    id: 'doc-earlier',
    title: '第三章 回响',
    charCount: 1900,
    updatedAt: ago(3 * 24 * HOUR_MS),
  }),
  doc({ id: 'doc-deleted', title: '已删除的一章', charCount: 999, updatedAt: ago(HOUR_MS), deleted: 1 }),
  doc({ id: 'doc-broken', title: '坏时间戳的一章', charCount: 100, updatedAt: 'not-a-timestamp' }),
]

/** state 桩：getSnapshot 返回带 `documents` 的最小快照（本面板只读这一个字段）。 */
function stateStub(documents: unknown, unsubscribeSpy?: () => void): AppState {
  return {
    getSnapshot(): Record<string, unknown> {
      return { documents }
    },
    subscribe(): () => void {
      return unsubscribeSpy ?? (() => {})
    },
  } as unknown as AppState
}

/** 侧栏 TABS 里真实的 trajectory 页签（单一来源），缺失即抛错。 */
function trajectoryTab(): TabDef {
  const tab = getTab('trajectory')
  if (tab === undefined) {
    throw new Error('侧栏 TABS 里没有 trajectory 页签（schema-tabs 缺口）')
  }
  return tab
}

const TRAJECTORY_TAB: TabDef = trajectoryTab()

function mountView(state: AppState = stateStub(DOCS)) {
  const props: ViewProps = { state, tab: TRAJECTORY_TAB }
  return mount(Trajectory, { props })
}

/** 期望视图：与组件对同一份快照、同一时刻的模型输出（接线断言的基准）。 */
function expectedView(documents: unknown) {
  return buildTrajectoryView({ documents } as unknown as AppState, new Date())
}

describe('「创作轨迹」面板', () => {
  it('渲染页签元数据：标题=页签名、副标题=页签描述、data-tab-id=页签 id', () => {
    const wrapper = mountView()
    const root = wrapper.get('[data-testid="trajectory-panel"]')
    expect(root.element).toBeDefined()
    expect(root.attributes('data-tab-id')).toBe('trajectory')
    expect(wrapper.get('.trajectory__title').text()).toBe(TRAJECTORY_TAB.name)
    expect(wrapper.get('.trajectory__desc').text()).toBe(TRAJECTORY_TAB.description)
  })

  it('页首统计口径说明：显式声明暂无逐次会话记录', () => {
    const wrapper = mountView()
    expect(wrapper.get('[data-testid="trajectory-disclaimer"]').text()).toBe(TRAJECTORY_DISCLAIMER)
  })

  it('汇总卡三项：活跃天数 / 最近 7 天更新数 / 累计字数', () => {
    const wrapper = mountView()
    const expected = expectedView(DOCS)
    const labels = wrapper.findAll('.trajectory__stat-label').map((label) => label.text())
    expect(labels).toEqual([SUMMARY_LABEL_ACTIVE, SUMMARY_LABEL_RECENT, SUMMARY_LABEL_TOTAL])
    const values = wrapper.findAll('.trajectory__stat-value').map((value) => value.text())
    expect(values).toEqual([
      `${expected.summary.activeDayCount} ${UNIT_DAYS}`,
      `${expected.summary.recentCount} ${UNIT_DOCS}`,
      `${formatCharCount(expected.summary.totalCharCount)} ${UNIT_CHARS}`,
    ])
  })

  it('时间线按天分组渲染：日期组倒序、组内条目倒序、与模型输出一致', () => {
    const wrapper = mountView()
    const expected = expectedView(DOCS)
    const dayElements = wrapper.findAll('[data-testid^="trajectory-day-"]')
    expect(dayElements.map((day) => day.get('.trajectory__day-label').text())).toEqual(
      expected.groups.map((group) => group.label),
    )
    expect(dayElements.map((day) => day.get('.trajectory__day-count').text())).toEqual(
      expected.groups.map((group) => formatGroupCount(group.entries.length)),
    )
    // 非法时间戳的说明出现在时间线上方
    expect(wrapper.get('[data-testid="trajectory-invalid-note"]').text()).toBe(
      formatInvalidNote(expected.malformedCount),
    )
    // 第一组（最新一天）条目与模型输出逐条一致：时间 + 标题 + 字数
    const firstDay = dayElements[0]
    const renderedEntries = firstDay.findAll('[data-testid^="trajectory-entry-"]')
    const expectedEntries = expected.groups[0]?.entries ?? []
    expect(renderedEntries.map((entry) => entry.get('.trajectory__entry-time').text())).toEqual(
      expectedEntries.map((entry) => entry.timeLabel),
    )
    expect(renderedEntries.map((entry) => entry.get('.trajectory__entry-title').text())).toEqual(
      expectedEntries.map((entry) => entry.title),
    )
    expect(renderedEntries.map((entry) => entry.get('.trajectory__entry-chars').text().trim())).toEqual(
      expectedEntries.map((entry) => `${formatCharCount(entry.charCount)} ${UNIT_CHARS}`),
    )
    // 软删文档不出现在时间线
    const allTitles = wrapper.findAll('[data-testid^="trajectory-entry-"]').map((entry) => entry.text())
    expect(allTitles.some((text) => text.includes('已删除的一章'))).toBe(false)
  })

  it('空态：显示中文引导，不渲染时间线与非法说明', () => {
    const wrapper = mountView(stateStub([]))
    expect(wrapper.get('[data-testid="trajectory-empty"]').text()).toBe(EMPTY_HINT)
    expect(wrapper.findAll('[data-testid="trajectory-days"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="trajectory-invalid-note"]')).toHaveLength(0)
  })

  it('数据不可用：快照缺 documents / documents 不是数组时显示「暂不可用」', () => {
    for (const bad of [undefined, 'not-an-array']) {
      const wrapper = mountView(stateStub(bad))
      expect(wrapper.get('[data-testid="trajectory-unavailable"]').text()).toBe(UNAVAILABLE_HINT)
      expect(wrapper.findAll('[data-testid="trajectory-days"]')).toHaveLength(0)
    }
  })

  it('订阅状态机、卸载时退订', async () => {
    const unsubscribe = vi.fn()
    const wrapper = mountView(stateStub(DOCS, unsubscribe))
    await nextTick()
    expect(unsubscribe).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('可见文本 ⊆ 页签文案 ∪ 常量 ∪ 文档数据经模型派生的字符串（验收 2）', () => {
    const wrapper = mountView()
    const expected = expectedView(DOCS)
    const rendered = [
      wrapper.get('.trajectory__title').text(),
      wrapper.get('.trajectory__desc').text(),
      wrapper.get('[data-testid="trajectory-disclaimer"]').text(),
      ...wrapper.findAll('.trajectory__stat-label').map((label) => label.text()),
      ...wrapper.findAll('.trajectory__stat-value').map((value) => value.text()),
      wrapper.get('[data-testid="trajectory-invalid-note"]').text(),
      ...wrapper.findAll('.trajectory__day-label').map((label) => label.text()),
      ...wrapper.findAll('.trajectory__day-count').map((count) => count.text()),
      ...wrapper.findAll('.trajectory__entry-time').map((time) => time.text()),
      ...wrapper.findAll('.trajectory__entry-title').map((title) => title.text()),
      ...wrapper
        .findAll('.trajectory__entry-chars')
        .map((chars) => chars.text().replace(/\s+/g, ' ').trim()),
    ]
    const allowed = new Set<string>([
      TRAJECTORY_TAB.name,
      TRAJECTORY_TAB.description,
      TRAJECTORY_DISCLAIMER,
      SUMMARY_LABEL_ACTIVE,
      SUMMARY_LABEL_RECENT,
      SUMMARY_LABEL_TOTAL,
      EMPTY_HINT,
      UNAVAILABLE_HINT,
      formatInvalidNote(expected.malformedCount),
      `${expected.summary.activeDayCount} ${UNIT_DAYS}`,
      `${expected.summary.recentCount} ${UNIT_DOCS}`,
      `${formatCharCount(expected.summary.totalCharCount)} ${UNIT_CHARS}`,
      ...expected.groups.flatMap((group) => [
        group.label,
        formatGroupCount(group.entries.length),
        ...group.entries.map((entry) => entry.timeLabel),
        ...group.entries.map((entry) => entry.title),
        ...group.entries.map((entry) => `${formatCharCount(entry.charCount)} ${UNIT_CHARS}`),
      ]),
    ])
    for (const text of rendered) {
      expect(allowed.has(text), `渲染了未知文本：${text}`).toBe(true)
    }
  })

  it('时间线组序与模型一致：最新日期在前、「未知」组在最后（验收 1 的结构前提）', () => {
    const wrapper = mountView()
    const expected = expectedView(DOCS)
    const dayKeys = expected.groups.map((group) => group.dayKey)
    // 「未知」组（坏时间戳）一定在最后
    expect(dayKeys[dayKeys.length - 1]).toBe('unknown')
    const renderedDayIds = wrapper
      .findAll('[data-testid^="trajectory-day-"]')
      .map((day) => day.attributes('data-testid'))
    expect(renderedDayIds).toEqual(dayKeys.map((key) => `trajectory-day-${key}`))
    // 渲染的日期组与模型对同一份数据的分组一致
    expect(dayKeys.slice(0, -1)).toEqual(groupByDay(DOCS).map((group) => group.dayKey).slice(0, -1))
  })
})
