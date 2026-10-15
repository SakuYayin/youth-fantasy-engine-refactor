/**
 * `@yfe/schema-tabs` 的**类型层** —— 页签元数据 / 字段定义 / 侧栏分组 / 题材包 / 可见性上下文的权威定义。
 *
 * ## 为什么单独一个零依赖文件
 *
 * 52 个页签的元数据由三个渲染层（W2 sheets / W3 table / W4 card）与外壳（W5 shell）共用，
 * 它们必须先拿到**一份冻结的接口**才能开工 —— 本文件就是那份接口：只放类型与枚举常量，
 * **不 import 任何模块**（包内最底层，出现任何环都会在模块初始化期炸 TDZ）。
 *
 * ## 移植来源（`upstream/**` 是只读参考，本包不 import）
 *
 * - `upstream/src/lib/types.ts:4,20,57,78,106` —— `FormField` / `FormModule` / `TableColumn` /
 *   `TabType` / `TabDef`（逐字保留字段名、可选性与注释语义）。
 * - `upstream/src/lib/schema.ts:41` —— `GROUPS`（顺序即侧栏顺序）。
 * - `upstream/src/lib/schema.ts:133,141,151` —— `ProjectType` / `VisCtx` / `FeatureTier`。
 * - `upstream/src/lib/schemaTemplates/packs.ts:20,25` —— `GENRE_PACKS` / `GenrePack`
 *   （🔴 值即包名、发布后冻结；改名只能走 `packs.ts` 的 `PACK_ALIASES`）。
 *
 * 🔴 **字段名 = 存储键**：`FormField.name` / `TableColumn.name` 就是落库的 key，
 *    改一个字已经填过的数据就读不到了。给作者改名请走显示名，别动这里。
 * 🔴 本文件里所有面向用户的中文文案（字段 `desc` / `example`、列 `options` 选项标签）
 *    必须与 upstream **逐字一致**，不许改写。
 */

// ==================== 字段 / 列定义 ====================

/** 表单字段 */
export interface FormField {
  name: string
  desc: string
  example: string
  /**
   * 字段类型标记（2.7.1 · 题材模板化）。
   *
   * 目前只有 `'numeric'`：**数值型字段** —— AI 补全时锁死，不让模型凭空编数字。
   * 改造前这一步靠「字段名包含 境界/等级/战力…」的关键字猜（见 schema.POWER_NUMERIC_HINTS），
   * 模板化后新题材的字段未必含这些字（如「段位」「品级与阶序」）⇒ 会失锁。故升级为
   * **显式声明**，关键字判据退化为兜底。
   */
  kind?: 'numeric'
}

/** 表单模块（分组） */
export interface FormModule {
  name: string
  fields: FormField[]
}

/** 表格列的取值类型（`upstream/src/lib/types.ts:59` 的内联联合，此处提为具名别名，值集逐字不变） */
export type TableColumnType =
  | 'text'
  | 'select'
  | 'date'
  | 'number'
  | 'textarea'
  | 'calendar'
  | 'character'
  | 'characters'
  | 'tableRef'

/** 表格列 */
export interface TableColumn {
  name: string
  type?: TableColumnType
  options?: string[]
  width?: string
  tip?: string
  /** 标记为历法列：选项来自项目级历法配置（多历法数值体系），而非 schema 静态 options */
  calendar?: boolean
  /** tableRef 类型：选项来自另一张设定表的指定列（跨表引用，禁止手动输入）。refTab=来源表 tabId，refCol=取名列名 */
  refTab?: string
  refCol?: string
  /** 隐藏列：在表格视图中不显示，但数据仍保留（例如地图 X/Y 坐标只由地图编辑维护，地理表里隐藏） */
  hidden?: boolean
  /**
   * 选项固定：不提供增 / 改 / 删 / 移除入口（保密等级这类被机器逻辑读取的封闭枚举）。
   * 由 `schemaShared.ts` 的 `cFixed()` 设置。
   */
  fixedOptions?: boolean
}

// ==================== 页签 ====================

/** 页签类型 */
export type TabType =
  | 'dashboard'    // 工作面板
  | 'model-settings' // 模型设置（模型配置 / 正文写作额度 / 联网检索 / AI 提示词）
  | 'guide'        // 使用说明
  | 'editor'       // 正文编辑
  | 'form'         // 表单型（单份）
  | 'table'        // 表格型（多行）
  | 'card'         // 卡片型（角色卡，多条记录）
  | 'about'        // 关于/打赏页（自定义布局）
  | 'map'          // 地图编辑（架在地理风物之上，SVG 画布可视化）
  | 'canvas'       // 画布型（情节推演画布，结构化卡片 + 连线）
  | 'inspire'      // 灵感启发（随机取名生成器 + AI 辅助规划）
  | 'check'        // 检查工具（敏感词检测 + AI 一致性深度自查 + 数据体检）
  | 'material'     // 素材资料（内置只读写作参考库）
  | 'trajectory'   // 创作轨迹（按章回看创作过程 + 导出证据包）
  | 'tavern-plot'   // 酒馆模式 · 剧情推演（角色扮演诊断台）
  | 'tavern-report' // 酒馆模式 · 推演报告（合理性报告列表与详情）
  | 'tavern-card'   // 酒馆模式 · 角色卡（自由模式角色卡管理）
  | 'tavern-free'   // 酒馆模式 · 自由对话（自由模式会话）
  | 'tavern-control' // 酒馆模式 · 控制面板（AI 参数与提示词集中调节）
  | 'tavern-script'  // 酒馆模式 · 剧本编辑（故事 / 剧本 / 角色三层，2026-09-16 起已实现）
  | 'tavern-run'     // 酒馆模式 · 跑团（AI KP 主持：检定 / 线索 / 同伴 / 秘密与结局，3.0 · W4-3）
  | 'bookbreak'         // 一键拆书（外部文本 → 项目设定表：抽取、判重、草稿审阅、勾选落库）
  | 'creative-writing'  // 创意写作（全自动创作工作流：想法 → 设定 → 大纲 → 逐章成稿）
  | 'tavern-world'   // 酒馆模式 · 背景设定（提炼过的世界资料，按关键词注入）
  | 'worlds'         // 世界引擎（世界引擎：抽取 / 封存版本 / 跨作品引用，3.0 · W4-1）

/**
 * 页签定义。
 *
 * 🔴 `modules` / `tips` / `name` / `description` 在「受题材驱动」的六个页签
 * （`worldbase` / `power` / `politics` / `economy` / `belief` / `justice`）上是 **getter**：
 * 读的是模块级的当前题材包，切包即变、且**不缓存**。消费方**永远走属性读**（`tab.modules`），
 * 不要把它展开成普通字段，也不要 `JSON.parse(JSON.stringify(tab))` 之后长期持有。
 */
export interface TabDef {
  id: string
  name: string
  group: string
  type: TabType
  description: string
  modules?: FormModule[]    // form / card 用
  columns?: TableColumn[]   // table 用
  tips?: string[]           // 底部提示
  /** 设定检索的主显示列名（表格/卡片用），留空则取第 1 个非空列 */
  displayCol?: string
  /** 设定检索的副标题列名（可选） */
  subtitleCol?: string
  /** 编号规则说明（有「编号」列的表格页签在顶部展示，防止编号混乱） */
  codeRule?: string
  /** 是否按创建时间倒序排列（越新创建的行越靠上）：true = 启用。用于章节总表等"后写的在最前面"的场景 */
  newestFirst?: boolean
}

// ==================== 侧栏分组 ====================

const TAB_GROUP_NAMES = [
  '工作面板', '正文写作', '灵感工具', '开书定位', '角色管理',
  '世界构建', '大纲规划', '酒馆模式', '创作管理', '运营维护',
] as const

/** 侧栏分组名（收敛为封闭集合，便于外壳层穷举） */
export type TabGroup = (typeof TAB_GROUP_NAMES)[number]

/**
 * 🔴 侧栏分组顺序＝本数组顺序（移植自 `upstream/src/lib/schema.ts:41`）。
 *
 * 2026-10-02：把「酒馆模式」从「灵感工具」之后挪到「大纲规划」与「创作管理」之间 ——
 * 酒馆模式是「拿已成型的设定与大纲去推演」，紧挨创作管理更符合使用动线（先定大纲 → 再推演/写作）。
 *
 * 类型保持 `string[]`（与 upstream 一致）：消费方常有 `GROUPS.includes(tab.group)` 这类
 * 以裸 `string` 入参的调用，收紧成联合类型会到处逼出断言。
 */
export const GROUPS: string[] = [...TAB_GROUP_NAMES]

// ==================== 题材包 ====================

/**
 * 十个题材包（🔴 封闭集合，**发布后冻结**；改名走 `packs.ts` 的 `PACK_ALIASES`）。
 *
 * 值即包名（中文），因为 `Project.genre` 会经 AI 上下文直接注入成「类型：东方修真」——
 * 值可读 ⇒ 天然不用额外映射表。
 */
export const GENRE_PACKS = [
  '东方修真', '西方奇幻', '都市异能', '都市现实', '历史古代',
  '科幻末世', '武侠江湖', '悬疑灵异', '游戏竞技', '女频言情',
] as const

export type GenrePack = (typeof GENRE_PACKS)[number]

/** 默认包：老项目 / 未设置 / 无法识别时一律落这里（＝改造前的现状） */
export const DEFAULT_PACK: GenrePack = '东方修真'

// ==================== 项目形态与可见性 ====================

export type ProjectType = 'full' | 'custom'

/**
 * 可见性上下文：完整项目全功能可见；自定义项目携带启用的功能集合（features 为已启用 tab id 列表）。
 *
 * `pack`（2.7.1）：当前项目的**题材包**；2.7.2 起 `tabVisible` 已不再用它决定显隐
 * （完整项目一律全显），保留它是为了给需要按题材解释文案的调用方留一个显式入口。
 */
export interface VisCtx {
  type: ProjectType
  features: string[]
  pack?: GenrePack
}

/** 功能档位：locked=必选不可取消；default=默认勾选但用户可取消；optional=自由勾选 */
export type FeatureTier = 'locked' | 'default' | 'optional'

// ==================== 卷台账 ====================

/**
 * 合成「卷台账」页签所需的最小卷信息（`upstream/src/lib/schemaShared.ts:127` 用的是
 * `types.Volume`；本包不依赖宿主存储层，故只声明结构所需的最小子集）。
 */
export interface VolumeLike {
  id: string
  title: string
}
