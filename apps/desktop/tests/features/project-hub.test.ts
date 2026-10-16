/**
 * 作品中心纯逻辑（`project-hub-model.ts`）单元测试 —— W8-A。
 *
 * 只测纯函数：分组归属、时间文案、名称校验、空态判定、请求构造。
 * 不测 DOM、不测 CSS、不测 `.vue`（那是 `project-hub.view.test.ts` 的事）。
 */
import { describe, expect, it } from 'vitest'
import {
  PROJECT_HUB_TEXT,
  PROJECT_TYPE_OPTIONS,
  buildProjectCreateRequest,
  deleteConfirmMessage,
  formatProjectDate,
  groupProjectsByType,
  projectCountLine,
  projectMetaLine,
  projectSummaryText,
  projectTypeOf,
  resolveProjectHubViewState,
  validateProjectName,
} from '../../src/renderer/features/project-hub-model.js'
import type { ProjectHubSnapshot, ProjectSummaryView } from '../../src/renderer/features/types.js'

/** 造一条作品摘要（默认是「完整项目」，时间给固定值，避免用例之间互相干扰）。 */
function project(
  overrides: Partial<ProjectSummaryView> & { readonly id: string },
): ProjectSummaryView {
  return {
    name: `作品-${overrides.id}`,
    summary: '',
    projectType: 'full',
    createdAt: null,
    updatedAt: null,
    revision: 'rev-1',
    ...overrides,
  }
}

/** 造一份端口快照。 */
function snapshot(overrides: Partial<ProjectHubSnapshot> = {}): ProjectHubSnapshot {
  return {
    projects: [],
    loading: false,
    lastError: null,
    currentProjectId: null,
    ...overrides,
  }
}

describe('project-hub-model / 分组', () => {
  it('按形态分两组，顺序固定且计数等于组内条数', () => {
    const groups = groupProjectsByType([
      project({ id: 'a', projectType: 'custom' }),
      project({ id: 'b', projectType: 'full' }),
      project({ id: 'c', projectType: 'custom' }),
    ])

    expect(groups.map((group) => group.label)).toEqual(['完整项目', '自定义项目'])
    expect(groups.map((group) => group.count)).toEqual([1, 2])
    expect(groups[0]?.projects.map((item) => item.id)).toEqual(['b'])
    expect(groups[1]?.projects.map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('未知或缺失的 projectType 归入完整项目，不会凭空多出一组', () => {
    const groups = groupProjectsByType([
      project({ id: 'a', projectType: '' }),
      project({ id: 'b', projectType: 'something-else' }),
      project({ id: 'c', projectType: 'custom' }),
    ])

    expect(groups.map((group) => group.key)).toEqual(['full', 'custom'])
    expect(groups[0]?.count).toBe(2)
    expect(groups[1]?.projects.map((item) => item.id)).toEqual(['c'])
  })

  it('空组不返回（不显示一个计数为 0 的组头）', () => {
    const onlyCustom = groupProjectsByType([project({ id: 'a', projectType: 'custom' })])
    expect(onlyCustom).toHaveLength(1)
    expect(onlyCustom[0]?.key).toBe('custom')

    expect(groupProjectsByType([])).toHaveLength(0)
  })

  it('projectTypeOf 把除 custom 之外的一切都归一为 full', () => {
    expect(projectTypeOf({ projectType: 'custom' })).toBe('custom')
    expect(projectTypeOf({ projectType: 'full' })).toBe('full')
    expect(projectTypeOf({ projectType: 'legacy-ish' })).toBe('full')
    expect(projectTypeOf({ projectType: '' })).toBe('full')
  })

  it('形态选项清单与分组标签一致（界面与分组不会各说各话）', () => {
    expect(PROJECT_TYPE_OPTIONS.map((option) => option.value)).toEqual(['full', 'custom'])
    expect(PROJECT_TYPE_OPTIONS.map((option) => option.label)).toEqual(['完整项目', '自定义项目'])
    for (const option of PROJECT_TYPE_OPTIONS) {
      expect(option.desc.trim()).not.toBe('')
    }
  })
})

describe('project-hub-model / 时间与卡片文案', () => {
  it('时间缺失或不可解析统一显示「时间未知」，正常时间显示 YYYY-MM-DD', () => {
    expect(formatProjectDate(null)).toBe(PROJECT_HUB_TEXT.timeUnknown)
    expect(formatProjectDate('')).toBe(PROJECT_HUB_TEXT.timeUnknown)
    expect(formatProjectDate('不是时间')).toBe(PROJECT_HUB_TEXT.timeUnknown)
    expect(formatProjectDate(new Date(2024, 4, 6, 12, 0, 0).toISOString())).toBe('2024-05-06')
    expect(formatProjectDate(new Date(2025, 11, 31, 12, 0, 0).toISOString())).toBe('2025-12-31')
  })

  it('时间行同时给出创建时间与最近活动，两项各自兜底', () => {
    const iso = new Date(2024, 0, 2, 12, 0, 0).toISOString()
    expect(projectMetaLine({ createdAt: iso, updatedAt: iso })).toBe('创建于 2024-01-02 · 最近活动 2024-01-02')
    expect(projectMetaLine({ createdAt: iso, updatedAt: null })).toBe(
      '创建于 2024-01-02 · 最近活动 时间未知',
    )
    expect(projectMetaLine({ createdAt: null, updatedAt: null })).toBe(
      '创建于 时间未知 · 最近活动 时间未知',
    )
  })

  it('空简介给占位文案，非空简介去掉首尾空白后原样显示', () => {
    expect(projectSummaryText({ summary: '' })).toBe(PROJECT_HUB_TEXT.noSummary)
    expect(projectSummaryText({ summary: '   ' })).toBe(PROJECT_HUB_TEXT.noSummary)
    expect(projectSummaryText({ summary: ' 一句话简介 ' })).toBe('一句话简介')
  })

  it('计数行带全角括号与条数', () => {
    expect(projectCountLine(0)).toBe('我的作品（0）')
    expect(projectCountLine(3)).toBe('我的作品（3）')
  })
})

describe('project-hub-model / 名称校验与请求构造', () => {
  it('空名与纯空白都报「请输入书名」，正常名字不报错', () => {
    expect(validateProjectName('')).toBe(PROJECT_HUB_TEXT.emptyName)
    expect(validateProjectName('   ')).toBe(PROJECT_HUB_TEXT.emptyName)
    expect(validateProjectName(' 剑来 ')).toBeNull()
  })

  it('构造创建请求：两端去空白，空简介不出现，形态与建首章标记带上', () => {
    const withSummary = buildProjectCreateRequest({
      name: '  长夜将至  ',
      summary: '  一个关于灯塔的故事  ',
      projectType: 'custom',
    })
    expect(withSummary.name).toBe('长夜将至')
    expect(withSummary.summary).toBe('一个关于灯塔的故事')
    expect(withSummary.projectType).toBe('custom')
    expect(withSummary.seedFirstChapter).toBe(true)

    const withoutSummary = buildProjectCreateRequest({
      name: '长夜将至',
      summary: '   ',
      projectType: 'full',
    })
    expect(withoutSummary.projectType).toBe('full')
    expect('summary' in withoutSummary).toBe(false)
  })

  it('删除确认文案点名书名，并含不可恢复与导出备份的提醒', () => {
    const message = deleteConfirmMessage('长夜将至')
    expect(message).toBe(
      '确定删除项目「长夜将至」？其全部设定、大纲与正文将一并删除，不可恢复！建议先导出备份。',
    )
  })
})

describe('project-hub-model / 主区域状态判定', () => {
  it('加载中优先于空态（首屏不得先闪一下「还没有作品」）', () => {
    expect(resolveProjectHubViewState(snapshot({ loading: true }))).toBe('loading')
    expect(
      resolveProjectHubViewState(snapshot({ loading: true, lastError: { code: 'X', message: '炸了' } })),
    ).toBe('loading')
  })

  it('有数据就显示列表，即使上一次刷新失败也不把列表换成报错', () => {
    expect(
      resolveProjectHubViewState(
        snapshot({
          projects: [project({ id: 'a' })],
          lastError: { code: 'X', message: '炸了' },
        }),
      ),
    ).toBe('list')
  })

  it('无数据时：先报错，再空态', () => {
    expect(resolveProjectHubViewState(snapshot({ lastError: { code: 'X', message: '炸了' } }))).toBe(
      'error',
    )
    expect(resolveProjectHubViewState(snapshot())).toBe('empty')
  })
})
