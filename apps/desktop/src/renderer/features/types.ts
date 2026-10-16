/**
 * 外壳层功能（W8）的数据通道契约 —— **Lead 独占，子智能体只消费不修改**。
 *
 * 为什么要有这一层：外壳功能（作品中心 / 备份恢复 / 设置 / 首启向导）都需要读写
 * 后端，但它们的组件不该直接摸 `AppState` 的内部状态机，也不该各自去 `window.yfe`
 * 发 IPC。这里把「外壳需要的能力」抽成**端口**，由 `features/ports.ts`（Lead 实现）
 * 把端口接到 `AppState` 与 IPC 上。
 *
 * 三条硬规则：
 * 1. **端口方法不抛异常**：一律返回 `FeatureResult<T>`，失败带脱敏后的 `code`/`message`。
 *    界面的职责是显示，不是捕获 —— 让异常穿过组件边界是最容易泄漏内部细节的写法。
 * 2. **组件不 import `node:`、不 import `@yfe/contracts`**：端口返回的视图类型
 *    （`ProjectSummaryView` 等）已把品牌类型收敛成 `string`，组件只认这些。
 * 3. **端口实现归 Lead**（`features/ports.ts` + `App.vue`）。功能智能体只写
 *    `<name>.vue` / `<name>-model.ts` / `tests/features/<name>*.test.ts`。
 */

/**
 * 端口统一返回值。
 *
 * `code` 用契约里的 `ErrorCode` 字符串（不 import `@yfe/contracts`，保持组件目录零契约依赖），
 * `message` 是**已经脱敏**的中文可读文案（剥掉 `cause`，见 ADR 0006 D2）。
 */
export type FeatureResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** 作品卡片要显示的一份摘要（契约 `Project` 的视图投影）。 */
export interface ProjectSummaryView {
  readonly id: string
  readonly name: string
  readonly summary: string
  /** 「完整 / 自定义」等形态标识；旧版叫项目形态。 */
  readonly projectType: string
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly revision: string
}

/** 新建作品的输入（对应契约 `ProjectCreateInput` 的可用子集）。 */
export interface ProjectCreateRequest {
  readonly name: string
  readonly summary?: string
  /** true = 顺带建第一章，让用户建完就能直接写（预览版默认）。 */
  readonly seedFirstChapter?: boolean
  /**
   * 项目形态：`'full'`（完整项目）/ `'custom'`（自定义项目）。
   *
   * 旧版表单上有这个二选一。落库时它进 `projects.project_type` 一列
   * （契约 `ProjectCreateInput.templateId`，见 `repositories/projects.ts` 的注释：
   * 该字段没有独立列，实现把它当 `project_type` 用）。缺省 = 服务端默认 `'full'`。
   */
  readonly projectType?: string
  /**
   * 幂等键：同一次「新建」被重复提交（双击、重试）时只有第一次落库。
   * 省略 = 不做幂等保护。格式受全仓 ID 规则约束（`ID_PATTERN` 不允许冒号）。
   */
  readonly idempotencyKey?: string
}

/**
 * 作品中心端口。
 *
 * `open` 与 `close` 切换的是**当前作品**（会冲刷未保存草稿并换掉章节树与设定实体），
 * `list` 只读列表。四者都不抛。
 */
export interface ProjectHubPort {
  list(): Promise<FeatureResult<readonly ProjectSummaryView[]>>
  create(request: ProjectCreateRequest): Promise<FeatureResult<{ readonly projectId: string }>>
  rename(projectId: string, name: string): Promise<FeatureResult<null>>
  /** 软删：只标记作品行，不级联删章节；重复删除返回 `NOT_FOUND_PROJECT`。 */
  remove(projectId: string): Promise<FeatureResult<null>>
  open(projectId: string): Promise<FeatureResult<null>>
  /** 回到作品中心（当前作品置空），会先冲刷草稿。 */
  close(): Promise<FeatureResult<null>>
}

/** 备份目录里的一条快照。 */
export interface BackupEntryView {
  readonly backupPath: string
  readonly label: string
  /** 清单缺时间戳时为 `null`（**不是** 0，也不是空串）。 */
  readonly createdAt: string | null
  readonly byteSize: number
  /**
   * 清单是否可解析。
   *
   * `false` = 只能列出、不能恢复（典型来源：迁移器自动留下的迁移前快照，
   * 它是合法 SQLite 库但没有配套清单）。界面必须把这类项显示成**不可恢复**，
   * 而不是隐藏它们 —— 用户有权知道自己磁盘上有什么。
   */
  readonly readable: boolean
}

export interface BackupVerifyReport {
  readonly backupPath: string
  readonly integrity: 'ok'
  readonly databaseSchemaVersion: number
  /** true = 这份备份比当前代码旧，恢复后需要迁移。 */
  readonly needsMigration: boolean
  readonly byteSize: number
  readonly createdAt: string | null
}

export interface BackupCreateReport {
  readonly backupPath: string
  readonly byteSize: number
  readonly createdAt: string
  readonly durationMs: number
}

/**
 * 备份/恢复端口。
 *
 * 🔴 `restore` **绝不覆盖在用的库**：它写「恢复预览」目录并返回目标路径，
 * 用户确认后再由人替换（设计文档 06/09）。`overwrite` 只影响**同名预览文件**。
 */
export interface BackupPort {
  list(): Promise<FeatureResult<readonly BackupEntryView[]>>
  create(label?: string): Promise<FeatureResult<BackupCreateReport>>
  verify(backupPath: string): Promise<FeatureResult<BackupVerifyReport>>
  restore(backupPath: string, overwrite?: boolean): Promise<FeatureResult<{ readonly targetPath: string; readonly byteSize: number }>>
}

/** 界面设置（对应旧版 `settings` store 的用户可见部分）。 */
export interface AppSettingsView {
  /** 主题 id，必须在 `THEMES` 里有定义；未知值由设置层回落默认主题。 */
  readonly themeId: string
  /** 正文字体族；`null` = 跟随主题/系统默认。 */
  readonly fontFamily: string | null
  /** 正文基准字号（px 数值字符串，例如 `'16px'`）。 */
  readonly fontSize: string
  /** 全局缩放百分比，闭区间 [80, 160]，步进 10。 */
  readonly zoomPercent: number
  /**
   * 缩放是否由用户手动指定。
   *
   * `false` = 「跟随窗口」，此时 `zoomPercent` 是**按窗口宽度算出来的**当前值，
   * 窗口尺寸变了要重算；`true` = 用户拖过滑块，此后不再自动适配。
   * 旧版用独立的 `yfe-ui-zoom-manual` 键表达同一件事（`theme.ts:173`）。
   */
  readonly zoomManual: boolean
  /** 侧栏宽度（px），旧版默认 224、宽屏 300、范围 [200, 560]。 */
  readonly sidebarWidth: number
  /** 已折叠的侧栏分组 id。 */
  readonly collapsedGroups: readonly string[]
}

/**
 * 设置端口：**读写都落 `localStorage`**，不新增后端接口、不写 `settings_entities`。
 *
 * 为什么不用数据库：这些是「这台机器上这个人的界面习惯」，跟人不跟作品，
 * 也不该跟着作品同步到别的设备（旧版 `uiPrefs.ts:15` 有同样的判断）。
 * 键名逐字照抄旧版，老数据能直接续用 —— 见 `settings-store.ts` 头部表格。
 */
export interface SettingsPort {
  /** 读当前设置（无存储值时给默认值，**永不失败**：读 localStorage 不会因为后端没起而失败）。 */
  load(): AppSettingsView
  /** 应用一个补丁；返回写入后的完整视图。写失败（隐私模式）时返回未变更的视图。 */
  save(patch: Partial<AppSettingsView>): AppSettingsView
  /** 恢复默认（清掉全部设置键）。 */
  reset(): AppSettingsView
}

/** 首启向导端口。 */
export interface WelcomePort {
  /** 是否已经走过向导（旧版 `db.setMeta('welcomeDone','1')`）。 */
  seen(): boolean
  markSeen(): void
  /**
   * 建示范项目（旧版 `createDemoProject`）。
   *
   * 返回新作品 id；失败时**不清除** `seen`，让用户能重试而不是被永久跳过。
   */
  createDemoProject(): Promise<FeatureResult<{ readonly projectId: string }>>
}

/**
 * 作品中心的可观察快照。
 *
 * 为什么不放进 `AppSnapshot`：`AppSnapshot` 是「当前打开的作品」的状态机，
 * 而作品列表是**跨作品**的（它必须能在没有当前作品时工作，也就是空态首页）。
 * 塞进去会让 30 多个面板测试的夹具全部要加字段（台账 R-77 记过这个代价），
 * 而它们没有一个需要作品列表。
 */
export interface ProjectHubSnapshot {
  readonly projects: readonly ProjectSummaryView[]
  readonly loading: boolean
  /** 最近一次失败（脱敏后的 code/message）；成功一次后清空。 */
  readonly lastError: { readonly code: string; readonly message: string } | null
  /** 当前打开的作品 id（来自 `AppState`，用来给列表项打「正在编辑」标记）。 */
  readonly currentProjectId: string | null
}

/**
 * 作品中心 store：`ProjectHubPort` + 可观察状态。
 *
 * `refresh()` 与 `list()` 的区别：前者把结果**存进快照**（界面用），后者只请求一次
 * （端口语义，供不关心列表状态的一次性调用）。两者都不抛异常。
 */
export interface ProjectHubStore extends ProjectHubPort {
  getSnapshot(): ProjectHubSnapshot
  subscribe(listener: (snapshot: ProjectHubSnapshot) => void): () => void
  /** 重新读作品列表并更新快照。 */
  refresh(): Promise<FeatureResult<readonly ProjectSummaryView[]>>
  dispose(): void
}

/**
 * 外壳功能端口集合。
 *
 * 由 `features/ports.ts` 的 `createFeaturePorts()`（Lead 实现）产出，
 * `main.ts` 建一次、`App.vue` 收成 prop 后分发给各功能组件。
 * 功能组件**只认这些端口**，不直接摸 `AppState` 的内部状态机、也不自己发 IPC。
 */
export interface FeaturePorts {
  readonly hub: ProjectHubStore
  readonly backup: BackupPort
  readonly settings: SettingsPort
  readonly welcome: WelcomePort
}
