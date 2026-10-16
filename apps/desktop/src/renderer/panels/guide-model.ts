/**
 * 「使用指南」面板（`tab.id = 'guide'`，分组 = 工作面板）的纯逻辑模型。
 *
 * 上游依据（只读参考，禁止 import）：`_upstream_tmp/youth-fantasy-engine-main/src/components/app/GuidePage.tsx`
 * （154 行）第 12-43 行的 `FILL_ORDER` / `GROUP_ORDER` / `EDITOR_DESC` / `TIPS`，第 51-141 行的四段
 * HelpPopover 正文，第 57-151 行的三节结构。
 *
 * 硬约束（`docs/接口冻结-面板层.md`）：
 * - 本文件只依赖 `@yfe/schema-tabs`（页签元数据的单一来源）与**类型**；
 *   不 import `node:*`、不 import `@yfe/contracts`、不碰 `window` / `localStorage` / `document`。
 * - 组件侧只读 `props.state` / `props.tab`，不新增 `AppState` / `AppSnapshot` / `RendererClientPort` 成员。
 * - 全部中文文案；数据一律从 `TABS` / `GROUPS` 派生，**不手抄一份页签清单**。
 *
 * 🔴 反 R-75（键名驼峰 vs kebab 静默不渲染）：`FILL_ORDER` 的 10 个 id 只在这里出现一次，
 *    页面渲染时逐个 `tabs.find()` 解析；解析不到的 id 静默跳过，由单测的
 *    「10 个 id 全部能在 `TABS` 里解析」兜底报红（见 `tests/panels/guide.test.ts`）。
 *
 * 🔴 反上游「漏一个分组整组消失」的坑：上游 `GuidePage.tsx:21-25` 手抄了一份 `GROUP_ORDER`
 *    并要求它与 `schema.ts` 的 `GROUPS` 覆盖一致（注释自认曾因此漏掉整个酒馆模式）。
 *    本移植**不再另立清单**：分组顺序直接取本仓 `GROUPS`（侧栏顺序＝单一源），
 *    再追加「`TABS` 里有、`GROUPS` 里没有」的未知分组，从结构上消灭这类静默丢失。
 */

import {
  EDITOR_TAB,
  GROUPS,
  TABS,
  tabVisible,
  type ProjectType,
  type TabDef,
  type VisCtx,
} from '@yfe/schema-tabs'

import type { AppSnapshot } from '../app-state.js'

// ==================== 上游逐字常量 ====================

/**
 * 推荐填写顺序（上游 `GuidePage.tsx:12-15` 逐字）：
 * 作品信息 → 世界设定 → 力量体系 → 主要角色 → 次要角色 → 历史事件
 * → 全书总纲 → 分卷大纲 → 章节总表 → 章节细纲。
 */
export const FILL_ORDER: readonly string[] = [
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
]

/** 「推荐填写顺序」节底部的补充说明（上游 `GuidePage.tsx:81` 逐字）。 */
export const FILL_ORDER_NOTE =
  '历史事件用倒推法（从大结局倒推到开篇）；写作期间持续维护伏笔、时间脉络与设定变更。'

/**
 * 正文编辑不在 `TABS` 里（是 `EDITOR_TAB` 常量），故在「全部功能页签」列表里单独成条，
 * 说明文案取上游 `GuidePage.tsx:28` 的 `EDITOR_DESC`（逐字）——`EDITOR_TAB.description` 是空串。
 */
export const EDITOR_DESC = '真正码字的地方：左侧带设定检索栏，可边写边查。'

/** 一条创作方法论（上游 `GuidePage.tsx:30-43`）。 */
export interface GuideTip {
  readonly title: string
  readonly body: string
}

/** 12 条创作方法论（上游 `GuidePage.tsx:30-43` 逐字，标题与正文一字不改）。 */
export const TIPS: readonly GuideTip[] = [
  { title: '先定位再动笔', body: '开书前先填作品信息：赛道、平台、读者、卖点没想清楚就动笔，多半会切书。' },
  { title: '全书总纲先行', body: '动笔前总纲必填：主线一句话、大结局、分卷规划一览；每卷结束回看修订一次。' },
  {
    title: '世界观三层填法',
    body: '底层法则（定了不改）→社会文明（前十章展开）→细节（随写随补）。世界观是舞台不是字典。',
  },
  { title: '等级表是宪法', body: '力量体系的等级一旦正文发布尽量不改；定稿前先写三章试水，检验数值是否膨胀。' },
  { title: '角色三档分级', body: '主要角色=核心；次要角色=阶段性宿敌/导师/配角；NPC=功能型。戏份变了及时升降级。' },
  { title: '问答法深挖动机', body: '对着角色卡连问三个「为什么」，问到第三个为什么，动机才立得住。' },
  { title: '随写随登记', body: '正文里每写出一个新设定立刻回表登记，连载百万字后你会感谢这套表。' },
  {
    title: '伏笔与前置条件',
    body: '伏笔登记时同步写清「回收前读者需要知道什么」——前置没铺就强行回收，效果大打折扣。',
  },
  { title: '每章结尾必有钩子', body: '网文和传统文学最大的区别；连载形态下章末平淡=流失读者。' },
  {
    title: '改设定先过设定变更',
    body: '连载中要改设定，先登记旧值新值、影响范围、已发布冲突——冲突未处理前不发布后续章节。',
  },
  { title: '知情权限随时登记', body: '读者对「谁知道什么」记得比你牢；每当有角色知悉秘密当天登记，防泄密穿帮。' },
  { title: '灵感即时入库', body: '灵感出现的当天就登记；写细纲卡壳先翻素材库再硬编。' },
]

// ==================== 帮助气泡（上游 4 处 HelpPopover 正文逐字） ====================

export type GuideHelpKey = 'page' | 'fill-order' | 'all-tabs' | 'tips'

/** 一条帮助气泡：稳定 key + 标题 + 正文（正文用 `\n` 分段，`\n\n` 为空行）。 */
export interface GuideHelpEntry {
  readonly key: GuideHelpKey
  readonly title: string
  readonly body: string
}

/**
 * 四段帮助正文（上游 `GuidePage.tsx:51-53 / 62-64 / 90-92 / 139-141` 逐字）。
 *
 * `@yfe/ui` 没有 `HelpPopover` 组件（`docs/剩余还原工作量清单.md:144` 把它列为 Lead 待建），
 * 故本页在 `guide.vue` 内用 `?` 按钮 + 可折叠面板复刻它的语义（点开看说明、再点收起），
 * 文案一字不改地放在这里。
 */
export const GUIDE_HELP: Readonly<Record<GuideHelpKey, GuideHelpEntry>> = {
  page: {
    key: 'page',
    title: '使用指南怎么看',
    body:
      '这一页是全软件的地图，卡壳时先回这里。\n\n' +
      '· 推荐填写顺序：按 1→10 的顺序点进去填，是一套经过验证的开书流程，点任意按钮可直达该页签；\n' +
      '· 全部功能页签：所有页签的一句话说明，点标题直接跳转；\n' +
      '· 核心创作方法论：12 条网文实操心法，动笔前后各看一遍。\n\n' +
      '任意功能标题旁的 ? 图标都能点开该功能的详细用法说明。',
  },
  'fill-order': {
    key: 'fill-order',
    title: '推荐填写顺序',
    body:
      '这是「从零开书」的标准路径：\n\n' +
      '1-3 先定位与世界底层（赛道/读者/卖点、世界法则、力量体系）；\n' +
      '4-5 立住主角与核心配角；\n' +
      '6 用倒推法把历史事件从结局倒推回开篇；\n' +
      '7-8 写全书总纲与分卷规划；\n' +
      '9-10 落到章节总表与章节细纲，然后就可以动笔了。\n\n' +
      '不必一次填满：每卷开写前补一轮，写完一卷回看修订一轮。',
  },
  'all-tabs': {
    key: 'all-tabs',
    title: '全部功能页签',
    body:
      '软件里每个页签的职责一览，点任意条目直接跳转。\n\n' +
      '· 表单型页签（作品信息、世界设定、全书总纲…）：一栏一栏填，Ctrl+S 保存；\n' +
      '· 表格型页签（伏笔、时间脉络、爽点、设定变更…）：一行一条记录，随写随登记；\n' +
      '· 卡片型页签（角色卡、分卷大纲、章节细纲）：一张卡一个对象，左侧目录切换；\n' +
      '· 正文编辑：真正码字的地方，左侧带设定检索栏可边写边查；\n' +
      '· 颉文姬 · AI 编辑：右下角的 Q 版精灵（或编辑器工具栏魔杖图标）——诊室（校对·文字层 / 校对·逻辑层 / 综合诊断）、编辑（选区润色改稿）、审读（六维打分 / OOC / 续写方向 / 爽点毒点 / 黄金三章）、简报（开写前的本章写作简报）、补登（抽出本章新设定，一键登记进设定表或角色卡），未配置模型时本地功能照常。\n' +
      '· 自定义项目：本页列出全部页签，未启用的功能以灰色显示且不可跳转；要启用请回到项目管理页编辑项目功能清单。',
  },
  tips: {
    key: 'tips',
    title: '核心创作方法论',
    body:
      '12 条从网文实战里提炼的规则，对应软件里的具体动作：\n\n' +
      '· 开书前：先定位 → 再总纲 → 再世界观三层填法；\n' +
      '· 连载中：随写随登记（新设定当天回表）、每章结尾留钩子、伏笔写清前置条件；\n' +
      '· 改设定：必须先过「设定变更」，冲突未处理前不要发布后续章节。\n\n' +
      '卡文时优先翻「灵感素材」而不是硬编。',
  },
}

/** 帮助正文按行拆开（丢掉空行：空行只作段落分隔，渲染时每行一个 `<p>`）。 */
export function helpLines(key: GuideHelpKey): string[] {
  return GUIDE_HELP[key].body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// ==================== 界面文案（空态 / 降级路径） ====================

/** 「未启用」徽标（上游 `GuidePage.tsx:122` 逐字）。 */
export const DISABLED_BADGE = '未启用'

/** 自定义项目里有未启用页签时的说明（跳转不通时的中文出口）。 */
export const GUIDE_DISABLED_NOTE =
  '灰显的页签在当前项目里未启用，点了不会跳转；要启用请回到项目管理页编辑功能清单。'

/**
 * 一个页签都渲染不出来时的兜底说明。
 *
 * 正常不可能出现（`TABS` 是编译期常量，最小长度由单测守住）；保留它是因为
 * 「静默空白页」是这一波明确禁止的失败形态——真出问题时要能一眼看出是元数据没加载。
 */
export const GUIDE_EMPTY_NOTE =
  '没有可展示的页签：页签元数据（TABS）为空。这一页读的是 @yfe/schema-tabs 的编译期常量，正常不会出现；若看到本提示，请检查页签元数据包是否加载成功。'

// ==================== 视图模型 ====================

/** 推荐填写顺序里的一步。 */
export interface GuideFillStep {
  readonly id: string
  readonly order: number
  readonly name: string
}

/** 全部功能页签里的一个条目。 */
export interface GuideTabItem {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
}

/** 一个分组（分组名逐字取 `GROUPS` / `TabDef.group`）。 */
export interface GuideGroup {
  readonly name: string
  readonly count: number
  readonly items: readonly GuideTabItem[]
}

/** 「全部功能页签」一节的完整模型。 */
export interface GuideModel {
  readonly fillSteps: readonly GuideFillStep[]
  readonly groups: readonly GuideGroup[]
  /** 有灰显（未启用）条目 ⇒ 显示 `GUIDE_DISABLED_NOTE`。 */
  readonly hasDisabledItems: boolean
  /** 自定义项目（`VisCtx.type === 'custom'`）——只有它才可能出现未启用条目。 */
  readonly customProject: boolean
}

/** `AppSnapshot` 上「项目形态」字段的运行期形态（A-01/A-07 契约冻结、尚未落地）。 */
interface VisCtxCarrier {
  readonly projectType?: unknown
  readonly features?: unknown
}

/**
 * 从快照里解析可见性上下文。
 *
 * 🔴 为什么用运行期探测而不是直接读字段：`AppSnapshot` 目前**没有** `projectType` / `features`
 *    （`docs/剩余还原工作量清单.md:178` 的契约 7「建项目契约扩字段」已冻结但未实现），而
 *    `panels/types.ts` 的面板 props 由 Lead 独占、本面板不得新增成员。
 *    所以这里只做一次「有的就读、没有就按完整项目」的探测：字段一旦落地即自动生效，
 *    不需要再改本文件；`AppSnapshot` 的冻结定义一个字也不动。
 *    默认 `type: 'full'` ⇒ `tabVisible` 放行全部页签（与 2.7.2 的「完整项目全显」一致）。
 */
export function resolveVisCtx(snapshot: AppSnapshot): VisCtx {
  const carrier: unknown = snapshot
  let raw: VisCtxCarrier = {}
  if (typeof carrier === 'object' && carrier !== null) raw = carrier as VisCtxCarrier
  const features: string[] = Array.isArray(raw.features)
    ? raw.features.filter((id): id is string => typeof id === 'string')
    : []
  const type: ProjectType = raw.projectType === 'custom' ? 'custom' : 'full'
  return { type, features }
}

/**
 * 由页签元数据装配整页模型。
 *
 * `tabs` 可注入只为可测性（默认就是 `TABS`）；组件永远用默认值，不新增 props。
 */
export function buildGuideModel(ctx: VisCtx, tabs: readonly TabDef[] = TABS): GuideModel {
  const groups = buildGroups(ctx, tabs)
  return {
    fillSteps: buildFillSteps(ctx, tabs),
    groups,
    hasDisabledItems: groups.some((group) => group.items.some((item) => !item.enabled)),
    customProject: ctx.type === 'custom',
  }
}

/** 推荐填写顺序：按 `FILL_ORDER` 逐个解析真实页签，不可见（未启用）的整条不出现（同上游 `:70`）。 */
function buildFillSteps(ctx: VisCtx, tabs: readonly TabDef[]): GuideFillStep[] {
  const steps: GuideFillStep[] = []
  FILL_ORDER.forEach((id, index) => {
    const tab = tabs.find((candidate) => candidate.id === id)
    // 解析不到的 id 静默跳过（上游 `:70` 同样 `return null`）：拼错的 id 由单测兜底，不在渲染期抛错。
    if (tab === undefined) return
    if (!tabVisible(tab.id, ctx)) return
    steps.push({ id: tab.id, order: index + 1, name: tab.name })
  })
  return steps
}

/**
 * 全部功能页签：按 `GROUPS` 顺序分组，每组列出该组全部页签（名称 / 描述 / 是否启用）。
 *
 * - 分组顺序＝侧栏 `GROUPS` 顺序（不再手抄 `GROUP_ORDER`，见文件头说明）；
 * - 分组名逐字取元数据；
 * - 「正文写作」组由 `EDITOR_TAB` 单独成条（正文编辑不在 `TABS` 里）；
 * - `dashboard` / `guide` 两个页签不进列表（上游 `:100` 逐字：工作面板与使用指南本身不在这里重复列出）；
 * - 空组不渲染（上游 `:102`）。
 */
function buildGroups(ctx: VisCtx, tabs: readonly TabDef[]): GuideGroup[] {
  const groups: GuideGroup[] = []
  const seen = new Set<string>()
  for (const name of GROUPS) {
    seen.add(name)
    const group = buildGroup(name, ctx, tabs)
    if (group !== null) groups.push(group)
  }
  // 兜底：`TABS` 里有、`GROUPS` 里没有的分组也要出现，否则整组页签从这一页静默消失。
  for (const tab of tabs) {
    if (tab.type === 'dashboard' || tab.type === 'guide') continue
    if (seen.has(tab.group)) continue
    seen.add(tab.group)
    const group = buildGroup(tab.group, ctx, tabs)
    if (group !== null) groups.push(group)
  }
  return groups
}

function buildGroup(name: string, ctx: VisCtx, tabs: readonly TabDef[]): GuideGroup | null {
  const items: GuideTabItem[] =
    name === EDITOR_TAB.group
      ? [toItem(EDITOR_TAB, EDITOR_DESC, ctx)]
      : tabs
          .filter((tab) => tab.type !== 'dashboard' && tab.type !== 'guide' && tab.group === name)
          .map((tab) => toItem(tab, tab.description, ctx))
  if (items.length === 0) return null
  return { name, count: items.length, items }
}

function toItem(tab: TabDef, description: string, ctx: VisCtx): GuideTabItem {
  return { id: tab.id, name: tab.name, description, enabled: tabVisible(tab.id, ctx) }
}