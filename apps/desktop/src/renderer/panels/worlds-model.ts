/**
 * 世界引擎面板（worlds）的纯逻辑与文案：世界观数据总览的分组、汇总与排序。
 *
 * 权威文档：`docs/接口冻结-面板层.md`（§2 PanelProps / §5 文件所有权 / §6 验收）。
 *
 * 面板本身没有「切页签」能力（外壳未提供 onSelectTab 回调），所以这里只做统计与
 * 引导，不做任何编辑动作；条目的增删改都由各设定页签自己的人机回路完成。
 *
 * 数据链说明（2026-10 核实）：存储层与 IPC 线上的设定实体带 `createdAt`/`updatedAt`
 * （`@yfe/persistence-sqlite` 的 `settingsEntities` 行映射），但渲染层视图契约
 * `SettingsEntityView`（app-state.ts 的 `toSettingsEntityView`）没有透传这两个字段。
 * 所以本模块把实体输入定义成**最小结构**：`updatedAt` 是可选字段——今天拿到的是
 * `null`（界面显示「暂无更新时间」），Lead 之后在视图契约里透传 `updatedAt` 时，
 * 本面板无需改动即可显示真实时间。`revision` 是不透明修订号（契约禁止排序、
 * 禁止算术、禁止用时间戳推断新旧），本模块绝不使用它。
 */

import type { SettingsEntityView } from '../app-state.js'

/** 面板文案（全中文；§2：组件内不写死大段静态文案，放同级 .ts 便于测试与替换）。 */
export const WORLDS_PANEL_TEXT = {
  /** 面板引言（`tab.description` 之外的补充说明）。 */
  intro: '本页汇总各设定页签的世界观数据量；条目内容请到侧栏对应页签编辑。',
  /** 每张卡片上的固定引导（面板没有「切页签」能力，onSelectTab 回调未接入）。 */
  editHint: '请到侧栏对应页签编辑',
  /** 空态引导（显式中文，不给静默空白）。 */
  emptyGuide:
    '还没有世界观数据：请先到各设定页签建立世界观数据（如「世界设定」「力量体系」「国家势力」等页签），保存后这里会显示各模板的条数与最近更新时间。',
  /** 加载中的说明。 */
  loading: '正在加载世界观数据…',
  /** 加载失败的说明（失败不假装成功）。 */
  loadFailed: '世界观数据加载失败：请稍后点「刷新」重试，或检查数据库连接。',
  /** 无更新时间数据时的占位（视图契约未透传 updatedAt）。 */
  missingUpdatedAt: '暂无更新时间',
  /** 未知模板徽标（不在世界相关页签清单里的模板也显示，不丢弃）。 */
  unknownBadge: '未知模板',
  /** 未知模板在卡片上的分组显示。 */
  unknownGroup: '未知模板',
  /** 条数单位。 */
  entryUnit: '条',
  /** 最近更新时间标签。 */
  latestUpdatedAtLabel: '最近更新',
  /** 排序切换按钮：当前按条数排序时显示（点击切到按更新时间）。 */
  sortByRecent: '按更新时间排序',
  /** 排序切换按钮：当前按更新时间排序时显示（点击切回按条数）。 */
  sortByCount: '按条数排序',
  /** 刷新按钮。 */
  refresh: '刷新',
  /** 刷新中的按钮文案。 */
  refreshing: '刷新中…',
} as const

/** 世界相关页签的元数据（id 与分组已逐一核实自 `@yfe/schema-tabs`）。 */
export interface WorldTemplateMeta {
  readonly id: string
  readonly name: string
  readonly group: string
}

/**
 * 世界相关页签清单（核实自 `packages/schema-tabs/src/schemaTabs/part1.ts`、
 * `schemaTemplates/institutions.ts`、`schemaTabs/part2.ts`）：
 *
 * - 「开书定位」组的 6 个世界观基础页签。`worldbase`/`power` 的显示名会随题材包
 *   变化（getter），这里记默认兜底名；分组与排序都用稳定 id，不受改名影响；
 * - 「世界构建」组的 9 个数据页签（含 `faction-rels`、`geography-map`）。
 *
 * `worlds` 本页不是数据页签，不在清单里。
 */
export const WORLD_TEMPLATE_META: readonly WorldTemplateMeta[] = [
  { id: 'worldbase', name: '世界设定', group: '开书定位' },
  { id: 'power', name: '力量体系', group: '开书定位' },
  { id: 'politics', name: '政治架构', group: '开书定位' },
  { id: 'economy', name: '经济基础', group: '开书定位' },
  { id: 'belief', name: '宗教信仰', group: '开书定位' },
  { id: 'justice', name: '司法制度', group: '开书定位' },
  { id: 'nations', name: '国家势力', group: '世界构建' },
  { id: 'faction-rels', name: '势力关系', group: '世界构建' },
  { id: 'geography', name: '地理风物', group: '世界构建' },
  { id: 'geography-map', name: '地图编辑', group: '世界构建' },
  { id: 'races', name: '种族生物', group: '世界构建' },
  { id: 'items', name: '物品资源', group: '世界构建' },
  { id: 'history', name: '历史事件', group: '世界构建' },
  { id: 'terms', name: '名词术语', group: '世界构建' },
  { id: 'misc-settings', name: '其他设定', group: '世界构建' },
]

/** 世界观数据实体的最小结构：`SettingsEntityView` 天然满足。 */
export interface WorldEntityInput {
  readonly schemaTemplateId: string
  readonly deleted: boolean
  /**
   * 视图契约未透传（可选）：今天恒为缺失 → 汇总得 `null`；Lead 透传后自动生效。
   * ISO 8601 字符串（存储层 `UtcTimestamp`），同格式按字典序即按时间序。
   */
  readonly updatedAt?: string
}

/** 卡片排序键：`count` = 条数多在前（默认）；`recent` = 最近更新在前（无时间数据回退条数）。 */
export type WorldSortKey = 'count' | 'recent'

/** 单个模板的汇总卡片。 */
export interface WorldTemplateSummary {
  readonly templateId: string
  /** 模板名：世界相关页签用中文名；未知模板用模板 id 本身（不丢弃）。 */
  readonly templateName: string
  /** 侧栏分组；未知模板显示「未知模板」。 */
  readonly group: string
  /** 是否在世界相关页签清单里。 */
  readonly known: boolean
  /** 未删除条数。 */
  readonly count: number
  /** 最近更新时间（ISO 字符串原值）；视图契约未透传 updatedAt 时为 null。 */
  readonly latestUpdatedAt: string | null
}

/** 分组结果：一个模板的实体列表 + 它的汇总卡片。 */
export interface WorldTemplateGroup {
  readonly templateId: string
  readonly templateName: string
  readonly group: string
  readonly known: boolean
  readonly entities: readonly WorldEntityInput[]
  readonly summary: WorldTemplateSummary
}

/** 世界相关页签的元数据；未知模板返回 null。 */
export function templateMetaFor(templateId: string): WorldTemplateMeta | null {
  return WORLD_TEMPLATE_META.find((meta) => meta.id === templateId) ?? null
}

/** 未删过滤（`groupEntitiesByTemplate` 与 `summarizeTemplate` 各做一遍，幂等）。 */
function aliveEntities(entities: readonly WorldEntityInput[]): readonly WorldEntityInput[] {
  return entities.filter((entity) => entity.deleted !== true)
}

/** 最近更新时间：取 updatedAt 的最大值（ISO 字符串），无数据返回 null。 */
function latestUpdatedAtOf(entities: readonly WorldEntityInput[]): string | null {
  let latest: string | null = null
  for (const entity of entities) {
    const updatedAt = entity.updatedAt
    if (updatedAt === undefined || updatedAt === '') continue
    if (latest === null || updatedAt > latest) latest = updatedAt
  }
  return latest
}

/**
 * 单个模板的汇总：未删过滤 + 条数 + 最近更新时间。
 *
 * 调用方应传**同一模板**的实体（`groupEntitiesByTemplate` 已按模板分桶）；
 * 空列表返回空模板 id 的占位汇总。
 */
export function summarizeTemplate(entities: readonly WorldEntityInput[]): WorldTemplateSummary {
  const alive = aliveEntities(entities)
  const templateId = alive[0]?.schemaTemplateId ?? entities[0]?.schemaTemplateId ?? ''
  const meta = templateMetaFor(templateId)
  return {
    templateId,
    templateName: meta !== null ? meta.name : templateId,
    group: meta !== null ? meta.group : WORLDS_PANEL_TEXT.unknownGroup,
    known: meta !== null,
    count: alive.length,
    latestUpdatedAt: latestUpdatedAtOf(alive),
  }
}

/** 无时间数据的组排最后；ISO 字符串同格式（UTC）按字典序即按时间序。 */
function compareUpdatedAtDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (a > b) return -1
  if (a < b) return 1
  return 0
}

function compareTemplateId(a: WorldTemplateGroup, b: WorldTemplateGroup): number {
  if (a.templateId < b.templateId) return -1
  if (a.templateId > b.templateId) return 1
  return 0
}

function compareGroups(a: WorldTemplateGroup, b: WorldTemplateGroup, sortBy: WorldSortKey): number {
  if (sortBy === 'recent') {
    const byTime = compareUpdatedAtDesc(a.summary.latestUpdatedAt, b.summary.latestUpdatedAt)
    if (byTime !== 0) return byTime
  }
  const byCount = b.summary.count - a.summary.count
  if (byCount !== 0) return byCount
  if (sortBy === 'count') {
    const byTime = compareUpdatedAtDesc(a.summary.latestUpdatedAt, b.summary.latestUpdatedAt)
    if (byTime !== 0) return byTime
  }
  return compareTemplateId(a, b)
}

/**
 * 把世界观数据实体按 `schemaTemplateId` 分组统计：
 *
 * - 未删过滤（`deleted !== true` 才计入）；
 * - 已知模板在前（按排序键），未知模板在后（按模板 id 字典序，稳定）——未知模板
 *   **不丢弃**，显示名 = 模板 id 本身；
 * - 排序键：`count`（默认）= 条数多在前，并列时更新时间新在前，再并列按模板 id；
 *   `recent` = 更新时间新在前（无时间数据排最后），并列时条数多在前。
 */
export function groupEntitiesByTemplate(
  entities: readonly WorldEntityInput[],
  options?: { readonly sortBy?: WorldSortKey },
): readonly WorldTemplateGroup[] {
  const sortBy = options?.sortBy ?? 'count'
  const buckets = new Map<string, WorldEntityInput[]>()
  for (const entity of aliveEntities(entities)) {
    const bucket = buckets.get(entity.schemaTemplateId)
    if (bucket === undefined) buckets.set(entity.schemaTemplateId, [entity])
    else bucket.push(entity)
  }
  const groups: WorldTemplateGroup[] = []
  for (const bucket of buckets.values()) {
    const summary = summarizeTemplate(bucket)
    groups.push({
      templateId: summary.templateId,
      templateName: summary.templateName,
      group: summary.group,
      known: summary.known,
      entities: bucket,
      summary,
    })
  }
  const known = groups.filter((group) => group.known).sort((a, b) => compareGroups(a, b, sortBy))
  const unknown = groups
    .filter((group) => !group.known)
    .sort((a, b) => compareTemplateId(a, b))
  return [...known, ...unknown]
}

/**
 * 「最近更新时间」的显示：ISO → `YYYY-MM-DD HH:mm`（本地时区）；
 * 无数据 / 不可解析 → 占位文案。
 */
export function formatUpdatedAt(iso: string | null): string {
  if (iso === null || iso === '') return WORLDS_PANEL_TEXT.missingUpdatedAt
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return WORLDS_PANEL_TEXT.missingUpdatedAt
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 总览行：`共 N 条设定，覆盖 M 个模板`。 */
export function overviewLine(totalEntries: number, templateCount: number): string {
  return `共 ${totalEntries} 条设定，覆盖 ${templateCount} 个模板`
}

/** 供调用方做结构兼容参考：视图契约满足本模块的实体输入（仅类型层面）。 */
export type WorldSettingsEntityView = SettingsEntityView
