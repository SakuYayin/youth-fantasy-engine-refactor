/**
 * 作品中心（project-hub）的纯逻辑与文案 —— W8-A（差距报告 B 项）。
 *
 * 权威契约：`docs/接口冻结-W8外壳.md` §1.1。本模块**不 import vue、不碰 DOM、不发请求**：
 * 分组、时间文案、名称校验、空态判定四条规则都在这里，`.vue` 只负责把结果摆到界面上。
 *
 * 为什么把这些搬出组件：
 * 1. 「完整 / 自定义」两组的**顺序与归属**是稳定契约（未知形态必须落到「完整项目」，
 *    否则老数据会在升级后凭空消失一整组）；
 * 2. 时间是 `string | null`，`null` 的文案（「时间未知」）是产品口径，不是格式化细节；
 * 3. 「空态判定」是**状态机**：加载中不能同时是空态 —— 这条最容易在模板里写成
 *    `v-if="projects.length === 0"` 而漏掉，纯函数 + 单测能钉住它。
 *
 * 🔴 契约缺口（不在本文件修，见交付报告）：
 * - `ProjectCreateRequest`（features/types.ts:41）**没有** `projectType` 字段，界面上的
 *   「项目形态二选一」无处安放。本模块把它作为**扩展字段**随请求一起交给端口
 *   （`ProjectCreateFormRequest`），端口的类型不受影响、Lead 要用时才需要扩契约。
 * - `ProjectSummaryView` 没有「卷 / 章 / 字数」统计，故卡片只显示名称 + 简介 + 时间行。
 */

import type {
  ProjectCreateRequest,
  ProjectHubSnapshot,
  ProjectSummaryView,
} from './types.js'

/** 项目形态：`full` = 完整项目，`custom` = 自定义项目。 */
export type ProjectType = 'full' | 'custom'

/** 完整项目形态标识（旧版 `projectType` 的默认值）。 */
export const PROJECT_TYPE_FULL: ProjectType = 'full'
/** 自定义项目形态标识。 */
export const PROJECT_TYPE_CUSTOM: ProjectType = 'custom'

/** 新建表单里的一选项（形态 + 中文名 + 一句说明）。 */
export interface ProjectTypeOption {
  readonly value: ProjectType
  readonly label: string
  readonly desc: string
}

/** 完整项目选项。 */
export const PROJECT_TYPE_OPTION_FULL: ProjectTypeOption = Object.freeze({
  value: PROJECT_TYPE_FULL,
  label: '完整项目',
  desc: '功能最完整，适合中长篇连载，开箱即用',
})

/** 自定义项目选项。 */
export const PROJECT_TYPE_OPTION_CUSTOM: ProjectTypeOption = Object.freeze({
  value: PROJECT_TYPE_CUSTOM,
  label: '自定义项目',
  desc: '按需启用功能模块，自己挑要用的',
})

/**
 * 形态选项清单 —— **顺序即分组顺序**（完整项目在前、自定义项目在后，照上游）。
 * 两个形态都空时不渲染该组（组头不摆一个光秃秃的「0」）。
 */
export const PROJECT_TYPE_OPTIONS: readonly ProjectTypeOption[] = Object.freeze([
  PROJECT_TYPE_OPTION_FULL,
  PROJECT_TYPE_OPTION_CUSTOM,
])

/**
 * 全部界面文案（中文）。集中放这里有两个原因：测试可以直接断言文案常量而不是
 * 抄一遍中文字符串；Lead 之后要换口径时只改一处。
 */
export const PROJECT_HUB_TEXT = Object.freeze({
  /** 页面标题。 */
  panelTitle: '作品中心',
  /** 标题下的一句说明。 */
  panelIntro: '每本书是一个独立项目 · 打开后进入完整创作面板',
  /** 计数行前缀（后面接全角括号与数字）。 */
  myProjects: '我的作品',
  /** 工具条主按钮：展开新建表单。 */
  newProject: '新建小说项目',
  /** 工具条次按钮：关闭作品中心回到编辑器（`emit('close')`）。 */
  backToEditor: '返回编辑器',

  /** 新建表单标题。 */
  createTitle: '新建小说项目',
  /** 书名字段标签（`*` 表示必填）。 */
  nameLabel: '书名 *',
  /** 书名输入框占位符。 */
  namePlaceholder: '给这本书起个名字，其他信息之后随时可以补',
  /** 项目形态字段标签。 */
  typeLabel: '项目形态',
  /** 简介字段标签。 */
  summaryLabel: '简介（可选）',
  /** 简介输入框占位符。 */
  summaryPlaceholder: '一句话说说这本书讲什么（可留空，之后随时能补）',
  /** 新建表单的提交按钮。 */
  createSubmit: '创建',
  /** 新建表单的取消按钮（也用于行内编辑的取消）。 */
  cancel: '取消',

  /** 空名的统一提示（新建与改名共用）。 */
  emptyName: '请输入书名',
  /** 卡片没有简介时的占位（不显示空白行）。 */
  noSummary: '暂无简介',

  /** 空态主文案。 */
  emptyTitle: '还没有作品，点击右上角「新建小说项目」开启第一本书',
  /** 空态第二行提示（只是文本，不带按钮）。 */
  emptyHint: '第一次使用？试试「创建示范项目」，一键体验全部功能。',
  /** 首屏加载文案。 */
  loading: '加载中…',
  /** 失败后的重试按钮。 */
  retry: '重试',

  /** 卡片操作：打开作品。 */
  open: '打开',
  /** 卡片操作：切到备份与恢复面板。 */
  backups: '备份与恢复',
  /** 卡片操作：进入行内改名。 */
  edit: '编辑',
  /** 卡片操作：删除作品。 */
  remove: '删除',
  /** 行内改名的保存按钮。 */
  save: '保存',
  /** 当前正在编辑的作品徽标。 */
  editingBadge: '正在编辑',

  /** 时间行前缀：创建时间。 */
  createdPrefix: '创建于',
  /** 时间行前缀：最近活动。 */
  updatedPrefix: '最近活动',
  /** 时间戳缺失（`null`）或不可解析时的占位。 */
  timeUnknown: '时间未知',

  /** 删除确认弹窗的标题/正文（YfeDialog 没有内容插槽，见下方 `deleteConfirmMessage`）。 */
  deleteTitle: '删除项目',
  /** 删除确认按钮。 */
  deleteConfirm: '删除',
  /** 删除取消按钮。 */
  deleteCancel: '取消',
} as const)

/**
 * 项目形态的归一：未知 / 空值一律当**完整项目**（照上游 `p.projectType ?? 'full'`）。
 *
 * 为什么不让未知形态单独成组：老数据（或契约之外的取值）落到一个没人认领的第三组里，
 * 用户看到的是「书不见了」；归到完整项目至少它还在列表上。
 */
export function projectTypeOf(project: Pick<ProjectSummaryView, 'projectType'>): ProjectType {
  return project.projectType === PROJECT_TYPE_CUSTOM ? PROJECT_TYPE_CUSTOM : PROJECT_TYPE_FULL
}

/** 取形态对应的选项对象（无下标访问，`noUncheckedIndexedAccess` 下也拿得到非空值）。 */
export function projectTypeOption(type: ProjectType): ProjectTypeOption {
  return type === PROJECT_TYPE_CUSTOM ? PROJECT_TYPE_OPTION_CUSTOM : PROJECT_TYPE_OPTION_FULL
}

/** 一个分组：组头要显示的形态、组内作品（保持端口给的顺序）。 */
export interface ProjectGroup {
  readonly key: ProjectType
  readonly label: string
  /** 组头计数胶囊上的数字。 */
  readonly count: number
  readonly projects: readonly ProjectSummaryView[]
}

/**
 * 按形态分两组；**空组不返回**（组头不显示「0」）。
 *
 * 组内顺序 = 端口给的顺序（列表排序归端口，界面不重排 —— 重排会让「刚建的书」
 * 因为名字排序沉到看不见的地方）。
 */
export function groupProjectsByType(
  projects: readonly ProjectSummaryView[],
): readonly ProjectGroup[] {
  const groups: ProjectGroup[] = []
  for (const option of PROJECT_TYPE_OPTIONS) {
    const items = projects.filter((project) => projectTypeOf(project) === option.value)
    if (items.length === 0) continue
    groups.push({
      key: option.value,
      label: option.label,
      count: items.length,
      projects: items,
    })
  }
  return groups
}

/**
 * 时间显示：`YYYY-MM-DD`（本地时区）。
 *
 * `null` / 空串 / 不可解析的字符串统一显示「时间未知」——契约
 * （features/types.ts:35）明说时间戳可能是 `null`，显示成 1970 或空白都是在骗人。
 */
export function formatProjectDate(iso: string | null): string {
  if (iso === null || iso === '') return PROJECT_HUB_TEXT.timeUnknown
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return PROJECT_HUB_TEXT.timeUnknown
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 卡片时间行：`创建于 X · 最近活动 Y`（两项都可能落在「时间未知」）。 */
export function projectMetaLine(
  project: Pick<ProjectSummaryView, 'createdAt' | 'updatedAt'>,
): string {
  return (
    `${PROJECT_HUB_TEXT.createdPrefix} ${formatProjectDate(project.createdAt)}` +
    ` · ${PROJECT_HUB_TEXT.updatedPrefix} ${formatProjectDate(project.updatedAt)}`
  )
}

/** 卡片简介：空简介给占位文案（两行截断的版式不能塌成一条缝）。 */
export function projectSummaryText(project: Pick<ProjectSummaryView, 'summary'>): string {
  const text = project.summary.trim()
  return text === '' ? PROJECT_HUB_TEXT.noSummary : text
}

/** 计数行：`我的作品（N）`。 */
export function projectCountLine(count: number): string {
  return `${PROJECT_HUB_TEXT.myProjects}（${count}）`
}

/**
 * 名称校验：空名 / 纯空白返回提示文案，合法返回 `null`。
 *
 * 界面据此**在发请求之前**拦下空名（契约 §0.2 之外的一条产品要求：空名不该产生一次
 * 注定失败的写操作，也就不会在界面上留下一条无意义的错误）。
 */
export function validateProjectName(name: string): string | null {
  return name.trim() === '' ? PROJECT_HUB_TEXT.emptyName : null
}

/** 新建表单的输入。 */
export interface ProjectCreateFormInput {
  readonly name: string
  readonly summary?: string
  readonly projectType: ProjectType
}

/**
 * 新建请求（端口的 `ProjectCreateRequest` + 形态）。
 *
 * 🔴 `projectType` 是**契约缺口下的扩展字段**：`ProjectCreateRequest` 里没有它，
 *    所以它不会被端口类型检查认识 —— 但结构类型允许把这个对象交给
 *    `hub.create(request: ProjectCreateRequest)`（多余字段在赋值时合法）。
 *    Lead 若要让「自定义项目」真的落库，需要扩 `ProjectCreateRequest`；在那之前
 *    端口可以安全忽略它。**没有把它塞进 `summary`**：用文案字段传结构数据会让
 *    用户在简介里看到一行乱码，也会污染导出。
 */
export interface ProjectCreateFormRequest extends ProjectCreateRequest {
  readonly projectType: ProjectType
}

/** 表单 → 请求：两端 trim；空简介不出现（可选字段不传空串）。 */
export function buildProjectCreateRequest(input: ProjectCreateFormInput): ProjectCreateFormRequest {
  const name = input.name.trim()
  const summary = (input.summary ?? '').trim()
  return {
    name,
    ...(summary === '' ? {} : { summary }),
    // 预览版默认：建完就有第一章，用户点「打开」即可直接写（features/types.ts:43 的口径）。
    seedFirstChapter: true,
    projectType: input.projectType,
  }
}

/**
 * 删除确认文案。
 *
 * YfeDialog 只渲染 `title` + 两个按钮（`packages/ui/src/components/YfeDialog.vue` 没有
 * 内容插槽），所以这句正文只能走 `title`。文案里带上书名：删错书的代价是不可逆的，
 * 让用户在按「删除」前看到自己选中的是哪一本。
 */
export function deleteConfirmMessage(projectName: string): string {
  return `确定删除项目「${projectName}」？其全部设定、大纲与正文将一并删除，不可恢复！建议先导出备份。`
}

/**
 * 主区域要渲染哪一种状态。
 *
 * 优先级：加载中 > 列表 > 失败 > 空态。两条不能破的规矩：
 * 1. **加载中不得同时显示空态**（首屏会先闪一下「还没有作品」，用户会以为书丢了）；
 * 2. 有数据就显示数据 —— 即使上一次刷新失败，也不该把已经拿到的列表换成一块报错。
 *    「失败 + 有列表」的场合由界面在列表**上方**补一条错误条（见 `.vue`）。
 */
export type ProjectHubViewState = 'loading' | 'error' | 'empty' | 'list'

/** 主区域状态判定（纯函数，单测直接钉住上面四条分支的先后）。 */
export function resolveProjectHubViewState(snapshot: ProjectHubSnapshot): ProjectHubViewState {
  if (snapshot.loading) return 'loading'
  if (snapshot.projects.length > 0) return 'list'
  if (snapshot.lastError !== null) return 'error'
  return 'empty'
}
