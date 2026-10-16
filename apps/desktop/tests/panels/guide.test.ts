// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 「使用指南」面板（W9-2 · C-01）纯逻辑单测：`renderer/panels/guide-model.ts`。
 * 不挂载组件（视图行为在 `guide.view.test.ts`）。
 *
 * 覆盖四件事：
 * 1. **逐字保真**：`FILL_ORDER` / `FILL_ORDER_NOTE` / `EDITOR_DESC` / 12 条 `TIPS` /
 *    4 段 `GUIDE_HELP` 与上游 `_upstream_tmp/youth-fantasy-engine-main/src/components/app/GuidePage.tsx`
 *    一致（本文件自带字面量副本，故能兜住 guide-model.ts 被改错）；
 * 2. **反 R-75**：`FILL_ORDER` 的 10 个 id 必须逐字能在本仓 `TABS` 里解析出页签名
 *    （键名驼峰 vs kebab 写错会静默不渲染，这条断言是唯一的报红点）；
 * 3. **模型装配**：分组顺序＝本仓 `GROUPS`、页签零丢失、`dashboard`/`guide` 不自我重复、
 *    正文编辑单独成条、自定义项目下未启用条目灰显、未知分组兜底、空注入不出现空白页；
 * 4. **可见性口径**：外壳快照还没有 `projectType` / `features` 时按完整项目处理。
 */
import { describe, expect, it } from 'vitest'

import {
  EDITOR_TAB,
  GROUPS,
  TABS,
  getTab,
  tabVisible,
  type TabDef,
  type VisCtx,
} from '@yfe/schema-tabs'

import type { AppSnapshot } from '../../src/renderer/app-state.js'
import {
  DISABLED_BADGE,
  EDITOR_DESC,
  FILL_ORDER,
  FILL_ORDER_NOTE,
  GUIDE_DISABLED_NOTE,
  GUIDE_EMPTY_NOTE,
  GUIDE_HELP,
  TIPS,
  buildGuideModel,
  helpLines,
  resolveVisCtx,
} from '../../src/renderer/panels/guide-model.js'

/** 快照基线（字段与 `AppSnapshot` 冻结定义逐字对齐；运行期新字段由 `snapshotWith` 追加）。 */
const SNAPSHOT_BASE: AppSnapshot = {
  ready: true,
  loading: false,
  appVersion: '0.1.0',
  databasePath: null,
  databaseSchemaVersion: null,
  readOnly: false,
  pendingOutboxCount: 0,
  lastSavedAt: null,
  projectId: 'project-1',
  tree: [],
  documents: [],
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
}

/** 造一个快照：`projectType` / `features` 属于「契约已冻结、A-01/A-19 尚未落地」的字段。 */
function snapshotWith(
  extras: { readonly projectType?: unknown; readonly features?: unknown } = {},
): AppSnapshot {
  return Object.assign({}, SNAPSHOT_BASE, extras)
}

/** 完整项目（可见性全放行），与外壳默认口径一致。 */
const FULL_CTX: VisCtx = { type: 'full', features: [] }

/** 「全部功能页签」不该出现的两个页签 id（上游 `GuidePage.tsx:100` 逐字排除）。 */
const SELF_IDS = ['dashboard', 'guide'] as const

/** 真实 `TABS` 里应当出现在本页列表中的页签（排除工作面板自身与使用指南）。 */
const LISTABLE_TABS: readonly TabDef[] = TABS.filter(
  (tab) => tab.type !== 'dashboard' && tab.type !== 'guide',
)

describe('guide-model · 上游逐字常量', () => {
  it('推荐填写顺序 10 项的 id 与上游逐字一致且无重复', () => {
    expect(FILL_ORDER).toEqual([
      'positioning',
      'worldbase',
      'power',
      'char-main',
      'char-secondary',
      'history',
      'master',
      'volume-outline',
      'chapter-master',
      'chapter-outline',
    ])
    expect(new Set(FILL_ORDER).size).toBe(FILL_ORDER.length)
  })

  it('推荐填写顺序的 10 个 id 全部能在本仓 TABS 里解析出页签名（反 R-75）', () => {
    for (const id of FILL_ORDER) {
      const tab = getTab(id)
      expect(tab, `FILL_ORDER 里的 id 在本仓 TABS 中不存在：${id}`).toBeDefined()
      expect(tab?.name.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('推荐填写顺序的补充说明与上游逐字一致', () => {
    expect(FILL_ORDER_NOTE).toBe(
      '历史事件用倒推法（从大结局倒推到开篇）；写作期间持续维护伏笔、时间脉络与设定变更。',
    )
  })

  it('12 条创作方法论的标题与正文与上游逐字一致', () => {
    expect(TIPS).toHaveLength(12)
    expect(TIPS.map((tip) => tip.title)).toEqual([
      '先定位再动笔',
      '全书总纲先行',
      '世界观三层填法',
      '等级表是宪法',
      '角色三档分级',
      '问答法深挖动机',
      '随写随登记',
      '伏笔与前置条件',
      '每章结尾必有钩子',
      '改设定先过设定变更',
      '知情权限随时登记',
      '灵感即时入库',
    ])
    // 抽查正文（含首条、末条与两条带全角括号/破折号的）
    expect(TIPS[0]?.body).toBe(
      '开书前先填作品信息：赛道、平台、读者、卖点没想清楚就动笔，多半会切书。',
    )
    expect(TIPS[2]?.body).toBe(
      '底层法则（定了不改）→社会文明（前十章展开）→细节（随写随补）。世界观是舞台不是字典。',
    )
    expect(TIPS[9]?.body).toBe(
      '连载中要改设定，先登记旧值新值、影响范围、已发布冲突——冲突未处理前不发布后续章节。',
    )
    expect(TIPS[11]?.body).toBe('灵感出现的当天就登记；写细纲卡壳先翻素材库再硬编。')
    expect(TIPS.every((tip) => tip.title.length > 0 && tip.body.length > 0)).toBe(true)
    expect(new Set(TIPS.map((tip) => tip.title)).size).toBe(12)
  })

  it('正文编辑的说明取上游 EDITOR_DESC（因为 EDITOR_TAB.description 是空串）', () => {
    expect(EDITOR_DESC).toBe('真正码字的地方：左侧带设定检索栏，可边写边查。')
    expect(EDITOR_TAB.id).toBe('editor')
    expect(EDITOR_TAB.group).toBe('正文写作')
    expect(EDITOR_TAB.description).toBe('')
    // 不变量：「正文写作」组在 TABS 里没有成员 ⇒ 该组只渲染 EDITOR_TAB 一条，不吞别的页签。
    // 若将来往该组加了页签，这条断言会报红，提醒改 buildGroup 的取数口径。
    expect(TABS.filter((tab) => tab.group === EDITOR_TAB.group)).toHaveLength(0)
  })

  it('4 段帮助正文与上游逐字一致（标题 + 正文按行展开）', () => {
    expect(GUIDE_HELP.page.title).toBe('使用指南怎么看')
    expect(GUIDE_HELP['fill-order'].title).toBe('推荐填写顺序')
    expect(GUIDE_HELP['all-tabs'].title).toBe('全部功能页签')
    expect(GUIDE_HELP.tips.title).toBe('核心创作方法论')

    expect(helpLines('page')[0]).toBe('这一页是全软件的地图，卡壳时先回这里。')
    expect(helpLines('page')).toContain(
      '· 核心创作方法论：12 条网文实操心法，动笔前后各看一遍。',
    )
    expect(helpLines('page')).toContain('任意功能标题旁的 ? 图标都能点开该功能的详细用法说明。')
    expect(helpLines('fill-order')[0]).toBe('这是「从零开书」的标准路径：')
    expect(helpLines('fill-order')).toContain(
      '不必一次填满：每卷开写前补一轮，写完一卷回看修订一轮。',
    )
    expect(helpLines('all-tabs')).toContain(
      '· 表格型页签（伏笔、时间脉络、爽点、设定变更…）：一行一条记录，随写随登记；',
    )
    expect(helpLines('all-tabs')).toContain(
      '· 自定义项目：本页列出全部页签，未启用的功能以灰色显示且不可跳转；要启用请回到项目管理页编辑项目功能清单。',
    )
    expect(helpLines('tips')).toContain('卡文时优先翻「灵感素材」而不是硬编。')

    // 每段至少两行可见内容，展开后不留空行（空行只作段落分隔）
    for (const key of ['page', 'fill-order', 'all-tabs', 'tips'] as const) {
      const lines = helpLines(key)
      expect(lines.length).toBeGreaterThanOrEqual(2)
      expect(lines.every((line) => line.length > 0)).toBe(true)
      expect(lines.every((line) => line === line.trim())).toBe(true)
    }
  })

  it('空态与灰显说明是中文文案（不允许空白出口）', () => {
    expect(DISABLED_BADGE).toBe('未启用')
    expect(GUIDE_DISABLED_NOTE.length).toBeGreaterThan(0)
    expect(GUIDE_EMPTY_NOTE.length).toBeGreaterThan(0)
  })

  it('guide 页签自身元数据不变（分组=工作面板，type=guide）', () => {
    const tab = getTab('guide')
    expect(tab, '侧栏 TABS 里没有 guide 页签（schema-tabs 缺口）').toBeDefined()
    if (tab !== undefined) {
      expect(tab.name).toBe('使用指南')
      expect(tab.group).toBe('工作面板')
      expect(tab.type).toBe('guide')
    }
  })
})

describe('guide-model · 完整项目', () => {
  const model = buildGuideModel(FULL_CTX)

  it('推荐填写顺序解析成 10 步，序号 1→10，名称取自真实页签', () => {
    expect(model.fillSteps.map((step) => step.id)).toEqual([...FILL_ORDER])
    expect(model.fillSteps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const step of model.fillSteps) {
      expect(step.name).toBe(getTab(step.id)?.name)
    }
    expect(model.fillSteps[0]?.name).toBe('作品信息')
    expect(model.fillSteps[9]?.name).toBe('章节细纲')
  })

  it('分组顺序＝本仓 GROUPS 顺序，且 TABS 里每个可列页签都被列出（零丢失）', () => {
    const listed = new Set(model.groups.flatMap((group) => group.items.map((item) => item.id)))
    for (const tab of LISTABLE_TABS) {
      expect(listed.has(tab.id), `页签 ${tab.id} 未出现在「全部功能页签」里`).toBe(true)
    }
    // 每个在 TABS 里有成员的分组都要出现，顺序与 GROUPS 一致；未知分组追加在末尾
    const expectedGroups = GROUPS.filter((name) =>
      name === EDITOR_TAB.group
        ? true
        : TABS.some(
            (tab) => tab.type !== 'dashboard' && tab.type !== 'guide' && tab.group === name,
          ),
    )
    const expectedUnknown = [
      ...new Set(
        TABS.filter(
          (tab) =>
            tab.type !== 'dashboard' && tab.type !== 'guide' && !GROUPS.includes(tab.group),
        ).map((tab) => tab.group),
      ),
    ]
    expect(model.groups.map((group) => group.name)).toEqual([...expectedGroups, ...expectedUnknown])
    expect(new Set(expectedGroups).size).toBe(expectedGroups.length)
  })

  it('分组内条目计数、描述与启用态来自元数据，且 id 全无重复', () => {
    const items = model.groups.flatMap((group) => group.items)
    for (const group of model.groups) {
      expect(group.items.length).toBeGreaterThan(0)
      expect(group.count).toBe(group.items.length)
      for (const item of group.items) {
        expect(item.name.length).toBeGreaterThan(0)
        expect(item.description.length).toBeGreaterThan(0)
        expect(item.enabled).toBe(true)
        expect(tabVisible(item.id, FULL_CTX)).toBe(true)
      }
    }
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
    // 条目总数 = TABS 里可列出的页签 + 正文编辑单列的一条
    expect(items).toHaveLength(LISTABLE_TABS.length + 1)
    expect(model.hasDisabledItems).toBe(false)
    expect(model.customProject).toBe(false)
  })

  it('使用指南与工作面板不在「全部功能页签」里自我重复', () => {
    const ids = model.groups.flatMap((group) => group.items.map((item) => item.id))
    for (const id of SELF_IDS) {
      expect(ids).not.toContain(id)
    }
  })

  it('正文编辑单独成条：在「正文写作」组，描述取 EDITOR_DESC', () => {
    const group = model.groups.find((candidate) => candidate.name === EDITOR_TAB.group)
    expect(group).toBeDefined()
    expect(group?.items).toHaveLength(1)
    expect(group?.count).toBe(1)
    expect(group?.items[0]?.id).toBe(EDITOR_TAB.id)
    expect(group?.items[0]?.name).toBe(EDITOR_TAB.name)
    expect(group?.items[0]?.description).toBe(EDITOR_DESC)
    expect(group?.items[0]?.enabled).toBe(true)
  })
})

describe('guide-model · 自定义项目（灰显出口）', () => {
  it('功能清单为空时：锁定项仍可跳，可选项灰显但照旧列出', () => {
    const ctx: VisCtx = { type: 'custom', features: [] }
    const model = buildGuideModel(ctx)
    expect(model.customProject).toBe(true)
    expect(model.hasDisabledItems).toBe(true)

    const items = model.groups.flatMap((group) => group.items)
    const editor = items.find((item) => item.id === EDITOR_TAB.id)
    expect(editor?.enabled).toBe(true)
    const positioning = items.find((item) => item.id === 'positioning')
    expect(positioning?.enabled).toBe(false)
    // 灰显条目仍带名称与说明（上游是「灰色显示且不可跳转」，不是消失）
    expect(positioning?.name).toBe(getTab('positioning')?.name)
    expect(positioning?.description.length).toBeGreaterThan(0)
    // 灰显只改 enabled，不改条目数与顺序
    const fullItems = buildGuideModel(FULL_CTX).groups.flatMap((group) => group.items)
    expect(items.map((item) => item.id)).toEqual(fullItems.map((item) => item.id))
  })

  it('推荐填写顺序按 FILL_ORDER 过滤：未启用的整条不出现，顺序不被 features 顺序带偏', () => {
    const ctx: VisCtx = { type: 'custom', features: ['worldbase', 'positioning'] }
    const model = buildGuideModel(ctx)
    expect(model.fillSteps.map((step) => step.id)).toEqual(['positioning', 'worldbase'])
    expect(model.fillSteps.map((step) => step.order)).toEqual([1, 2])
    expect(model.fillSteps.map((step) => step.id)).not.toContain('chapter-outline')
    for (const step of model.fillSteps) {
      expect(tabVisible(step.id, ctx)).toBe(true)
    }
  })

  it('一个功能都没勾时推荐填写顺序为空（由视图渲染中文空态说明）', () => {
    const model = buildGuideModel({ type: 'custom', features: [] })
    // FILL_ORDER 的 10 项全是可选项，锁定项不会漏进来
    expect(model.fillSteps).toHaveLength(0)
    expect(GUIDE_EMPTY_NOTE.length).toBeGreaterThan(0)
  })
})

describe('guide-model · 元数据异常时的兜底', () => {
  it('注入空 tabs：正文编辑单独成条 ⇒ 结构上不可能出现空白页', () => {
    const model = buildGuideModel(FULL_CTX, [])
    expect(model.groups).toHaveLength(1)
    expect(model.groups[0]?.name).toBe(EDITOR_TAB.group)
    expect(model.groups[0]?.items.map((item) => item.id)).toEqual([EDITOR_TAB.id])
    expect(model.fillSteps).toHaveLength(0)
  })

  it('TABS 里有、GROUPS 里没有的分组会追加在末尾，不会整组消失', () => {
    // 把 positioning 挪到一个 GROUPS 里没有的分组（模拟新增分组但忘了登记 GROUPS）
    const relocated: TabDef[] = TABS.map((tab) =>
      tab.id === 'positioning' ? { ...tab, group: '未来新分组' } : tab,
    )
    const model = buildGuideModel(FULL_CTX, relocated)
    const names = model.groups.map((group) => group.name)
    expect(names).toContain('未来新分组')
    const unknownGroup = model.groups.find((group) => group.name === '未来新分组')
    expect(unknownGroup?.items.map((item) => item.id)).toEqual(['positioning'])
    // 原分组里的其余页签不受影响，且 positioning 不再双重出现
    const originGroup = model.groups.find((group) => group.name === '开书定位')
    expect(originGroup?.items.map((item) => item.id)).not.toContain('positioning')
    expect(originGroup?.items.length ?? 0).toBeGreaterThan(0)
  })

  it('FILL_ORDER 里解析不到的 id 静默跳过，不抛异常', () => {
    const onlyWorldbase = TABS.filter((tab) => tab.id === 'worldbase')
    const model = buildGuideModel(FULL_CTX, onlyWorldbase)
    expect(model.fillSteps.map((step) => step.id)).toEqual(['worldbase'])
    // 序号仍取 FILL_ORDER 中的位置（上游 :74 用 index+1）
    expect(model.fillSteps[0]?.order).toBe(2)
  })
})

describe('guide-model · resolveVisCtx', () => {
  it('快照没有 projectType / features 时按完整项目处理（当前外壳的实况）', () => {
    expect(resolveVisCtx(snapshotWith())).toEqual({ type: 'full', features: [] })
  })

  it('读到项目形态时按自定义项目处理', () => {
    expect(
      resolveVisCtx(snapshotWith({ projectType: 'custom', features: ['positioning'] })),
    ).toEqual({ type: 'custom', features: ['positioning'] })
  })

  it('字段非法（非数组 / 混入非字符串 / 未知项目形态）时降级为空清单 + 完整项目', () => {
    expect(resolveVisCtx(snapshotWith({ projectType: 'custom', features: 'positioning' }))).toEqual({
      type: 'custom',
      features: [],
    })
    expect(
      resolveVisCtx(snapshotWith({ projectType: 'custom', features: ['positioning', 7, null] })),
    ).toEqual({ type: 'custom', features: ['positioning'] })
    expect(resolveVisCtx(snapshotWith({ projectType: 'weird' }))).toEqual({
      type: 'full',
      features: [],
    })
  })
})