/**
 * 酒馆内核移植 · 端口契约（**冻结接口**）
 *
 * 【这是什么】上游 22 个酒馆文件（`_upstream_tmp/youth-fantasy-engine-main/src/lib/tavern/*.ts`）
 * 的**全部宿主依赖面**，收敛成 14 个端口 + 1 个聚合接口 `TavernPorts`。
 * 之后 6–8 个子智能体按本文件逐字依赖，**任何成员改名 / 改参数顺序 / 改返回类型都会让迁移批红**。
 *
 * 【冻结纪律】
 *   1. 本文件**不是**适配器，只声明形状；宿主实现留在宿主侧（`apps/` / `packages/application`）。
 *   2. 端口一律「**作为末尾参数追加**」，不做 `createXxx(deps)` 工厂 —— 与 `settings.ts:11-26`
 *      的既有范式一致：本包导出全是无状态纯函数，工厂只多一层闭包。
 *   3. 全文件禁 `any`、禁 `as`；不给上游字段加 `readonly`（上游没有，加了会让宿主直传报错）。
 *   4. `settings.ts` 的 `TavernMetaPort` / `TavernProviderRecord` / `TavernProviderPort` /
 *      `TavernTuningAdvice` / `TavernCapacityAdvice` / `TavernCapacityPort` 已冻结，
 *      本文件**只再导出、不重新定义**（重新定义会让两份声明漂移）。
 *   5. 🔴 `packages/tavern/src/index.ts` **目前不存在**（`package.json` 的 `exports["."]` 指向它）。
 *      本文件**不**通过它导出；该缺口由 Lead 在收口批次统一处理。
 *
 * 【14 个端口 · 逐条替掉的上游符号与宿主实现代价】
 *
 * | 端口 | 替掉的上游符号（`文件:行号`） | 宿主能否零适配直传 |
 * |---|---|---|
 * | `TavernMetaPort` | `@/lib/db/meta.ts:7,11`（已冻结，本文件只再导出） | `import * as db from '@/lib/db'` 后直传（多余成员无妨） |
 * | `TavernStorePort` | `db/core.ts:39` `getCurrentProjectId`；`db/meta.ts:37,41` `getSetting/setSetting`；`db/tabs.ts:17,34` `getTableRows/getCardRecords`；`db/tavernReports.ts:9,14,18,22` `getReport/listProjectReports/saveReport/deleteReport`；`db/projects.ts:120` `deleteProject`；并 `extends TavernMetaPort`（`db/meta.ts:7,11`） | 可用 `import * as db from '@/lib/db'` 的**命名空间对象**整个直传（多余导出如 `currentProjectId` 是额外属性，不算错） |
 * | `TavernChatPort` | `@/lib/aiCore/chat.ts:114` `chat`；`aiCore/transport.ts:45` `isCancelled`；`aiCore/core.ts:118` `JSON_TASK_TEMPERATURE` | 直传 `{ chat, isCancelled, JSON_TASK_TEMPERATURE }`（三个符号来自两个模块，需组一个对象，**无需写包装函数**） |
 * | `TavernModelPort` | `@/lib/aiCore/session.ts:120,161,138,181` `loadProviders/requireActiveProvider/isProviderUsable/typeLabel` | 直传 `{ loadProviders, requireActiveProvider, isProviderUsable, typeLabel }` |
 * | `TavernProviderPort` | `@/lib/aiCore/session.ts:120,129`（已冻结子集，本文件只再导出） | 直传 |
 * | `TavernCapacityPort` | `@/lib/ai/modelCapacity` 三个纯函数（已冻结，本文件只再导出） | 直传该模块 |
 * | `TavernContextPort` | `@/lib/ai/aiContext.ts:924` `buildProjectContext` | 直传 `{ buildProjectContext }` 或该模块 |
 * | `TavernSemanticPort` | `semantic/indexDoc.ts:35` `indexOneDoc`；`semantic/store.ts:236` `removeByRef`；`semantic/recall.ts:136` `recallRelevant`；`semantic/inject.ts:60` `renderRecallHits`；`semantic/settings.ts:72` `resolveEmbedConfig` | 从 4 个模块各取 1–2 个导出组一个 5 成员对象，**无需写包装函数**（签名逐字对齐） |
 * | `TavernSearchPort` | `@/lib/ai/webSearch.ts:277` `webSearch` | 直传 `{ webSearch }`（注入点 `deps.transport` 上游早已设计好） |
 * | `TavernDraftMaterialPort` | `@/lib/editor/draftMaterial.ts:122` `prepareDraftMaterial` | 直传 `{ prepareDraftMaterial }` 或该模块 |
 * | `TavernPlatformPort` | `@/lib/app/desktop.ts:135,387` `DESKTOP/getDesktopState`；`@/lib/sync/desktopCloudSync.ts:90` `isDesktopCloudUnavailable` | 直传 `{ DESKTOP, getDesktopState, isDesktopCloudUnavailable }`（`getDesktopState` 上游返回 11 字段，多返回的字段不影响结构兼容） |
 * | `TavernUtilPort` | `@/lib/app/id.ts:9` `uid` | 直传 `{ uid }`。🔴 **不抄进包**：上游 `uid` 带模块级 `uidSeq` 计数器，抄一份会出现两套计数器 |
 * | `TavernInterviewPort` | `@/lib/tavern/interview.ts:161-175` `tavernCallChat` 的闭包 + `aiCore/transport.ts:45` `isCancelled` + `tavern/settings.ts:796-798` `timeoutMsOf` + `tavern/provider.ts:21-46` `resolveTavernProvider` | **需 4 行适配器**（见该接口注释里的宿主参考实现） |
 * | `TavernStyleStoragePort` | `@/lib/tavern/companionStyle.ts:97,100,111` 的 `localStorage` 直读直写 | **需 ~5 行适配器**（包 `localStorage`，键名 `novel-companion-dims` 由宿主决定） |
 *
 * 【聚合】`TavernPorts` 14 个成员：`meta` / `store` / `chat` / `model` / `providers` / `capacity` /
 * `context` / `semantic` / `search` / `draftMaterial` / `platform` / `util` / `interview` / `styleStorage`。
 * `store` 已 `extends meta`；`meta` **单独留一份**是给只碰全局 meta 的调用点（`presets` / `script` /
 * `story` / `world` 只读写 `getMeta/setMeta`），免得它们被迫实现整个存储面。
 */

import type { SearchOutcome, SearchSettings, SearchTransport } from './search.js'
import type { TavernReport } from './types.js'
import type {
  TavernCapacityPort,
  TavernMetaPort,
  TavernProviderPort,
  TavernProviderRecord,
} from './settings.js'

// 已冻结的 6 个符号在这里**再导出**（绝不重新定义）：迁移批可以直接从 `ports.js`（或 `settings.js`）取。
export type {
  TavernCapacityAdvice,
  TavernCapacityPort,
  TavernMetaPort,
  TavernProviderPort,
  TavernProviderRecord,
  TavernTuningAdvice,
} from './settings.js'

// ==================== ① 全局 meta（已冻结，见 packages/tavern/src/settings.ts:88） ====================

/**
 * `TavernMetaPort` 本体在 `./settings.js`，本文件**只再导出**。
 * 替掉上游 `@/lib/db` 的 `getMeta<T>(key, def)` / `setMeta(key, value)`
 * （`src/lib/db/meta.ts:7,11`），参数顺序、默认值语义、异常语义与上游一致（异常由调用方 try/catch 兜底）。
 *
 * 宿主怎么实现：`const meta: TavernMetaPort = db`（`import * as db from '@/lib/db'`）即可，零适配。
 * 测试替身怎么桩：内存 `Map`，`get` 直接返回 `def`、`set` 记进 Map —— 只碰全局 meta 的调用点
 * （`presets` / `script` / `story` / `world`）用这一个替身就够。
 */

// ==================== ② 模型清单（加宽版）与模型解析 ====================

/**
 * 上游 `AIProvider`（`src/lib/aiCore/core.ts:13`）中**酒馆真正要用到的字段**；
 * `TavernProviderRecord`（`settings.ts:97`）是它的最小子集，**两者刻意并存**：
 *   · `TavernProviderRecord` 只服务 `settings.ts` 的额度推算（已在 13 个既有文件的测试夹具里），
 *     加字段会打红它们 ⇒ 冻结不动；
 *   · 本类型给 `provider.ts` 这类要把整个 provider 交给 `chat()` 的调用点用。
 * 两者并存不是冗余：`TavernChatProvider` 是 `TavernProviderRecord` 的**超集**，
 * 因此「上游 `AIProvider` 对象」可以直接当 `TavernChatProvider` 用（`AIProvider` 结构上满足本类型）。
 *
 * 未收进来的上游字段（`local?` / `contextWindow?` / `sampling?`）属于「模型配置」与「额度换算」，
 * 分别由 `TavernProviderRecord`（已带 `local?` / `contextWindow?`）与 `TavernCapacityPort` 承担；
 * `sampling?` 22 个文件**没有任何一处读取**（侦察报告 §1.1 结论），故不声明。
 */
export interface TavernChatProvider extends TavernProviderRecord {
  /** 用户自定义显示名 */
  name: string
  /** Ollama 默认 http://localhost:11434；OpenAI 兼容填到 …/v1 之类前缀 */
  baseUrl: string
  apiKey: string
  /** 用户自定义系统提示词：追加到各功能自带系统提示词之后，不覆盖 */
  systemPrompt?: string
  /** 该模型的**生成温度**（选填）。留空时回落到 DEFAULT_TEMPERATURE */
  temperature?: number
}

/**
 * 模型解析与就绪判定 —— 替掉上游 `provider.ts` 用到的
 * `@/lib/aiCore/session.ts` 四个导出：`loadProviders`(:120) / `requireActiveProvider`(:181) /
 * `isProviderUsable`(:161) / `typeLabel`(:138)。
 *
 * 为什么与 `TavernProviderPort`（已冻结）并存：后者只服务 `settings.ts` 的额度推算，返回的是
 * **最小子集** `TavernProviderRecord[]`；本端口返回 `TavernChatProvider[]`，并额外带就绪判定。
 * 合并会让 15 个调用点的测试桩都变重（一个桩返回文本、一个桩返回 provider 列表，替身差别极大）。
 *
 * 宿主怎么实现：`const model: TavernModelPort = { loadProviders, requireActiveProvider,
 *   isProviderUsable, typeLabel }`（全部来自 `@/lib/aiCore/session`）；上游 `AIProvider` 结构上
 * 满足 `TavernChatProvider`，故 `loadProviders` / `requireActiveProvider` 可直接赋给本端口成员，
 * 无需包装函数。
 * 测试替身怎么桩：`loadProviders` 返回固定两条（一条本地 ollama、一条云端 openai），
 * `requireActiveProvider` 返回其中一条或抛（要测「未配置时抛」那条路径就抛）；
 * `isProviderUsable` 桩成「baseUrl 非空 && model 非空」，`typeLabel` 桩成 `'本地' / '联网'`。
 */
export interface TavernModelPort {
  /** 取全部已配置模型（上游 `aiCore/session.ts:120`） */
  loadProviders(): Promise<TavernChatProvider[]>
  /**
   * 取当前模型；没有就抛。
   * 上游抛的原话：'尚未配置可用的 AI 模型，请先到「模型设置 → 模型配置」添加并设为当前。'
   */
  requireActiveProvider(): Promise<TavernChatProvider>
  /** 配置是否填全（能真正发起调用）。上游：`p.type === 'ollama' || p.local ? '本地' : '联网'` 的同族判定 */
  isProviderUsable(p: TavernChatProvider): boolean
  /** `'本地'` / `'联网'`（上游 `aiCore/session.ts:138`） */
  typeLabel(p: TavernChatProvider): string
}

// ==================== ③ 额度推算（已冻结，见 packages/tavern/src/settings.ts:113,127,141） ====================

/**
 * `TavernTuningAdvice` / `TavernCapacityAdvice` / `TavernCapacityPort` 本体在 `./settings.js`，
 * 本文件**只再导出**。替掉上游 `@/lib/ai/modelCapacity` 的三个纯函数，**名字与参数顺序逐一对照**。
 * 宿主直接传该模块即可（`{ adviseCapacity, modelFingerprintOf, shouldApplyTuning }`）。
 */

// ==================== ④ 对话 ====================

/** 与上游 `ChatMessage`（`src/lib/aiCore/core.ts:59`）逐字同形 */
export interface TavernChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 与上游 `ChatOptions`（`src/lib/aiCore/chat.ts:18-40`）逐字同形 —— **八个可选字段一个不落**。
 * `skipUserSystem` 也在内：`provider.ts:59-67` 的 `applyUserSystemPolicy` 靠「剥掉
 * `provider.systemPrompt`」实现「酒馆不接作者自定义提示词」这条默认，改口径时可能换成显式传它。
 */
export interface TavernChatOptions {
  /** 超时毫秒，默认 CHAT_TIMEOUT_MS */
  timeoutMs?: number
  /** 标记本次调用是结构化 JSON 任务（未显式指定 temperature 时自动采用 JSON_TASK_TEMPERATURE = 0.3） */
  json?: boolean
  /** 采样温度，默认按 DEFAULT_TEMPERATURE（0.85）；json:true 且未显式给值时改用 JSON_TASK_TEMPERATURE（0.3） */
  temperature?: number
  /** 额外采样参数（键名用**目标接口的原生名字**，值必须是数字）。openaiChat 只转发白名单内的键 */
  extraOptions?: Record<string, number>
  /**
   * 是否关闭思考型模型的思维链输出：
   * - false：关闭（仅用于连通性测试等需要极速反馈的场景）
   * - true / undefined：不传该字段，交给模型/平台默认
   */
  think?: boolean
  /** 外部取消信号（对话面板的「停止」按钮） */
  signal?: AbortSignal
  /** 流式输出回调：提供时开启 SSE 流式，逐块收到模型输出（已剥离思考块）。不提供则走普通一次性返回 */
  onToken?: (delta: string) => void
  /** 跳过「作者自定义系统提示词」的兜底注入（默认 false = 注入） */
  skipUserSystem?: boolean
}

/**
 * 发一次对话 —— 替掉上游 `@/lib/ai` 的 `chat`(`aiCore/chat.ts:114`) /
 * `isCancelled`(`aiCore/transport.ts:45`) / `JSON_TASK_TEMPERATURE`(`aiCore/core.ts:118`)。
 *
 * 宿主怎么实现：`const chat Port: TavernChatPort = { chat, isCancelled, JSON_TASK_TEMPERATURE }`
 * —— 三个符号来自两个上游模块，组一个对象即可，**不需要写包装函数**（上游 `chat` 的
 * `AIProvider` 参数接受 `TavernChatProvider`，`ChatOptions` 与 `TavernChatOptions` 逐字同形）。
 * 测试替身怎么桩：`chat` 返回固定文本（要测流式就顺手调 `opts.onToken`）；
 * `isCancelled` 桩成 `e instanceof Error && e.name === 'AbortError'`；
 * `JSON_TASK_TEMPERATURE` 直接给 `0.3`（`summarize.ts` 会读它）。
 */
export interface TavernChatPort {
  chat(config: TavernChatProvider, messages: TavernChatMessage[], opts?: TavernChatOptions): Promise<string>
  /** 与 `chat()` 的取消语义必须**同源**：抄一份会出现「`chat` 抛的取消异常认不出」的漂移 */
  isCancelled(e: unknown): boolean
  /** 结构化 JSON 任务专用低温（上游 0.3）。`summarize.ts` 直接读它 */
  JSON_TASK_TEMPERATURE: number
}

// ==================== ⑤ 宿主存储（`@/lib/db` 全量） ====================

/**
 * 替掉上游 `@/lib/db` 的全部被用符号，并涵盖已冻结的 `TavernMetaPort`
 * （上游把 `@/lib/db` 当**命名空间**用，`getMeta` / `getSetting` 是同一门面的两个层级：
 * 前者落全局 meta、后者落 `${currentProjectId}::${key}`）。
 *
 * 宿主怎么实现：`import * as db from '@/lib/db'` 后 `const store: TavernStorePort = db` ——
 * 命名空间对象带 `getMeta` / `setMeta` / `getSetting` / `setSetting` / `getCurrentProjectId` /
 * `getTableRows` / `getCardRecords` / `getReport` / `listProjectReports` / `saveReport` /
 * `deleteReport` / `deleteProject` 全部 12 个成员，多余导出（`currentProjectId` 等）是额外属性，
 * **不算结构错误**，故宿主零适配。
 * 测试替身怎么桩：一个内存 `Map`（全局键 与 `${projectId}::${key}` 两个命名空间分开存）
 * ＋ 数组存 report / cardRecord / tableRow；`getCurrentProjectId` 返回固定 `'p1'`。
 */
export interface TavernStorePort extends TavernMetaPort {
  /** 上游 `db/core.ts:39` */
  getCurrentProjectId(): string
  /** 项目级 settingsKV（键由实现侧拼 `${projectId}::${key}`，上游 `db/meta.ts:37`） */
  getSetting<T>(key: string, def: T): Promise<T>
  /** 上游 `db/meta.ts:41` */
  setSetting(key: string, value: unknown): Promise<void>
  /** 推演报告（项目级数据，走 projectId 索引）。上游 `db/tavernReports.ts:9` */
  getReport(id: string): Promise<TavernReport | undefined>
  /** 上游 `db/tavernReports.ts:14`（走 projectId 索引） */
  listProjectReports(projectId: string): Promise<TavernReport[]>
  /** 上游 `db/tavernReports.ts:18` */
  saveReport(r: TavernReport): Promise<void>
  /** 上游 `db/tavernReports.ts:22` */
  deleteReport(id: string): Promise<void>
  /** 报告定位用：按 label 回表里查真实记录 id。上游 `db/tabs.ts:17`（按 tabId 走索引 → projectId 过滤 → order 升序） */
  getTableRows(tabId: string): Promise<TavernTableRow[]>
  /** 上游 `db/tabs.ts:34`（全表读 cardRecords → projectId + tabId 过滤 → order 升序） */
  getCardRecords(tabId: string): Promise<TavernCardRecord[]>
  /** 上游 `db/projects.ts:120`（删项目有级联，会一并清 tavernReports） */
  deleteProject(id: string): Promise<void>
}

/**
 * 只声明被消费的字段（侦察报告 §1.9）。
 * 🔴 `portrait` / `portrait2` 是上游 `src/lib/types.ts:194-220` 的**顶层字段**，
 *    草案漏了它们会**静默丢立绘**（台账迁移矩阵附录 C-3），故必须写全。
 */
export interface TavernCardRecord {
  id: string
  projectId: string
  tabId: string
  name: string
  /** fieldPath -> value */
  data: Record<string, string>
  order: number
  createdAt?: number
  /** 立绘（上游顶层字段，缺了会在角色卡回显 / 导出时丢图） */
  portrait?: string
  /** 第二立绘 */
  portrait2?: string
}

/** 只声明被消费的字段（侦察报告 §1.9）。`updatedAt?` / `createdAt?` 都保留 */
export interface TavernTableRow {
  id: string
  projectId: string
  tabId: string
  data: Record<string, string>
  order: number
  /** 最后编辑时间 */
  updatedAt?: number
  /** 创建时间 */
  createdAt?: number
}

// ==================== ⑥ 项目上下文 ====================

/**
 * 与上游 `ProjectContextOptions`（`src/lib/ai/aiContext.ts:31-109`）逐字同形。
 * `engine.ts` 实际只用到其中一部分（`budget` / `skeletonOnly` / `focusChapterId` /
 * `viewMode` / `anchorChapterId` / `knowerName` / `inlineDropNote`），但**全量声明**：
 * 宿主直传上游 `buildProjectContext` 时参数类型必须两边匹配，裁字段会让直传报错。
 */
export interface TavernProjectContextOptions {
  /** 总字符预算。不传则按项目规模取档（小项目 = 12000）。本地小模型建议显式传 6000~8000 */
  budget?: number
  /** 只包含这些页签（不传则按默认优先级全量） */
  onlyTabIds?: string[]
  /** 排除这些页签（例如「AI 整理」时正在整理的那张表另行单独完整给出） */
  excludeTabIds?: string[]
  /** 是否附带章节清单（卷 / 章标题 / 字数 / 摘要），默认 true */
  includeChapterList?: boolean
  /** 只出「骨架」：作品概览 + 章节清单，不带任何页签资料、也不做相关章节召回 */
  skeletonOnly?: boolean
  /** 焦点章节 id。指定后优先带入与它相关的章节 */
  focusChapterId?: string
  /** 相关章节召回条数上限，默认 8 */
  relatedChapterLimit?: number
  /** 语义召回：在「相关章节召回」之后再补一段〖语义召回〗 */
  semantic?: boolean
  /** 语义召回条数上限，默认 6 */
  semanticLimit?: number
  /** 知识库：在〖语义召回〗之后再补一段〖参考资料〗。**不传也算开** */
  kb?: boolean
  /** 参考资料召回条数上限，默认 4 */
  kbLimit?: number
  /** 〖参考资料〗段的总长上限，默认 2400 */
  kbMaxChars?: number
  /** 是否在正文尾部附一段「（注：以下资料因长度预算未带入…）」。默认 true；酒馆传 false */
  inlineDropNote?: boolean
  /** 视角档位。'character-view' 排除作者侧资料并隐藏常识表内的作者侧字段 */
  viewMode?: 'character-view' | 'director-view'
  /** 叙事锚点（章节 id）。章节清单与相关章节召回只保留锚点章及之前的 */
  anchorChapterId?: string
  /** 知情者过滤：只带入「该角色是知情者」的条目 */
  knowerName?: string
}

/** 与上游 `ProjectContextResult`（`src/lib/ai/aiContext.ts:111-119`）逐字同形 */
export interface TavernProjectContextResult {
  /** 拼好的上下文文本（可能为空串，表示项目还没填任何资料） */
  text: string
  /** 实际带入的段落名，供 UI 展示「已带入：世界设定 / 主要角色 …」 */
  sections: string[]
  /** 因预算不足被丢弃的段落名 */
  dropped: string[]
  chars: number
}

/**
 * 项目上下文 —— 替掉上游 `@/lib/ai/aiContext.ts:924` 的 `buildProjectContext`
 * （**1 个调用点**：`engine.ts`）。该函数内部经 `import * as db from '@/lib/db'` 读项目资料、
 * 经 semantic 做召回，**整条宿主面都封在它内部**，故本端口只有一个成员。
 *
 * 宿主怎么实现：`const context: TavernContextPort = { buildProjectContext }` 或直接传该模块。
 * 测试替身怎么桩：返回 `{ text: '', sections: [], dropped: [], chars: 0 }`（engine 测试只关心
 * 「有没有接上」），要测 dropped 分支就返回带 `dropped: ['世界设定']` 的一份。
 */
export interface TavernContextPort {
  buildProjectContext(opts?: TavernProjectContextOptions): Promise<TavernProjectContextResult>
}

// ==================== ⑦ 语义检索（`@/lib/semantic/*`） ====================

// ---- 从 §1.10 逐字抄进来的 6 个类型（宿主直传上游模块必需） ----
// 真源：`semantic/store.ts:30,32,71`（VecKind / VecRow / VecIndex）、
//       `semantic/embed.ts:18`（EmbedConfig）、`semantic/settings.ts:25`（EmbeddingSettings）、
//       `semantic/recall.ts:20,32`（RecallHit / RecallOptions）、`semantic/indexDoc.ts:19`（IndexDoc）。
// 抄全不裁：`RecallOptions` 引用 `VecRow` / `VecIndex`，`IndexDoc` 引用 `VecKind`，
// `EmbeddingSettings` 是 `resolveEmbedConfig` 的入参 —— 任何一个用近似类型都会让宿主直传报错。

/** 向量行的来源类别（上游 `semantic/store.ts:30`）。`'tavern'` 是唯一不随项目走的类别 */
export type VecKind = 'chapter' | 'summary' | 'setting' | 'kb' | 'tavern'

/** 上游 `semantic/store.ts:32-55`，逐字同形 */
export interface VecRow {
  /** `${projectId}::${kind}::${refId}::${chunkIdx}`（见 chunk.vectorRowId） */
  id: string
  projectId: string
  /** 索引键 = `${projectId}::${refId}` —— 供 `delByRef` 走索引，不必全表扫 */
  refKey: string
  kind: VecKind
  refId: string
  chunkIdx: number
  /** 原文片段：召回后**直接注入**，省掉二次读库 */
  text: string
  /** 来源标题（章节名 / 条目名）—— 渲染召回段时标注"这条来自哪儿" */
  title: string
  /** 内容哈希（增量判据，见 chunk.hashOf） */
  hash: string
  /** Float32Array 的 buffer（IndexedDB 原生支持，比 number[] 省 4~8 倍空间） */
  vec: ArrayBuffer
  dim: number
  /** 嵌入模型名 —— 换模型必须整库重建（维度多半也不一样） */
  model: string
  /** 来源行在表格里被标为 S 级（绝密）：角色视角召回时必须整行剔除 */
  secret: boolean
  updatedAt: number
}

/** 索引导读（不读 `vec` —— 大库下省掉十几 MB 的内存与拷贝）。上游 `semantic/store.ts:71-76` */
export interface VecIndex {
  /** `chunkKey → hash`：块级增量判据 */
  hashes: Map<string, string>
  /** 现有来源键集合（`kind::refId`）：用来找出"本次不再存在"的来源并清理孤儿 */
  refs: Set<string>
}

/** 上游 `semantic/embed.ts:18-24`，逐字同形 */
export interface EmbedConfig {
  type: 'ollama' | 'openai'
  /** Ollama 默认 http://localhost:11434；OpenAI 兼容填到 …/v1 之类前缀 */
  baseUrl: string
  apiKey?: string
  model: string
}

/** 上游 `semantic/settings.ts:25-32`，逐字同形 */
export interface EmbeddingSettings {
  /** 用的哪个已配置模型（`providers` 里的 id）；空串 = 未配置 ⇒ 语义检索整体关闭 */
  providerId: string
  /** 嵌入模型名；留空则用 provider 自己的 model 名 */
  model: string
  /** 章节保存后自动索引本章（默认关 —— 每次保存都花嵌入额度，得作者自己点头） */
  autoIndexOnSave: boolean
}

/** 上游 `semantic/store.ts` 的 `RecallHit`（`recall.ts:20-30`），逐字同形 */
export interface RecallHit {
  kind: VecKind
  refId: string
  chunkIdx: number
  text: string
  /** 来源标题（章节名 / 条目名） */
  title: string
  score: number
  /** 该块来源被标为 S 级（绝密）—— 调用方可据此再作判断 */
  secret: boolean
}

/** 上游 `semantic/recall.ts:32-68`，逐字同形（含三个单测注入点） */
export interface RecallOptions {
  projectId: string
  cfg: EmbedConfig
  /** 最多返回多少条，默认 6 */
  topK?: number
  /** 只在这些类别里找（不传 = 全部） */
  kinds?: VecKind[]
  /** 余弦阈值，默认 0.35（低于它的多半只是"用词像"，不是"意思近"） */
  minScore?: number
  /** 角色视角：剔除 S 级来源块 */
  hideSecretRows?: boolean
  /** 叙事锚点白名单（章节 id 集合）。**只对 `kind === 'chapter'` 的命中生效**。传 null / 不传 = 不裁剪 */
  allowChapterIds?: Set<string> | null
  /** 排除这些来源（如焦点章自己）。对所有类别生效 */
  excludeRefIds?: Set<string> | null
  /** **只**在这些来源里找（`excludeRefIds` 的对称能力）。对所有类别生效 */
  allowRefIds?: Set<string> | null
  signal?: AbortSignal
  /** 同一个来源最多保留几块，默认 2 */
  perRefCap?: number
  /** 候选超过这个数才启用关键词粗筛，默认 1200 */
  prefilterAt?: number
  /** 单测注入点（生产不传） */
  embedFn?: (text: string, cfg: EmbedConfig, signal?: AbortSignal) => Promise<number[] | null>
  loadFn?: (projectId: string) => Promise<VecRow[]>
  indexFn?: (projectId: string) => Promise<VecIndex>
}

/** 一个「来源」：一章正文 / 一条设定行 / 一张角色卡 / 一篇参考资料。上游 `semantic/indexDoc.ts:19-27` */
export interface IndexDoc {
  kind: VecKind
  refId: string
  /** 展示用标题（UI 里说"正在索引哪一条"） */
  title: string
  text: string
  /** 来源行被标为 S 级（绝密）—— 角色视角召回时整条剔除 */
  secret: boolean
}

/**
 * 语义检索 —— 替掉上游 `@/lib/semantic/*` 被 `recall.ts`（酒馆侧）用到的 5 个符号：
 *   `indexDoc.ts:35` `indexOneDoc` / `store.ts:236` `removeByRef` / `recall.ts:136` `recallRelevant` /
 *   `inject.ts:60` `renderRecallHits` / `settings.ts:72` `resolveEmbedConfig`。
 *
 * 🔴 不抄 `chunk` / `recall` / `inject` / `embed` / `settings` 的实现：抄一份会产生
 * **双份实现漂移**（侦察报告 §3.1 自己也承认这个风险）。宿主直接把上游各导出组成本对象。
 *
 * 宿主怎么实现：从 4 个模块各取 1–2 个导出，组一个 5 成员对象，**无需写包装函数** ——
 *   签名逐字对齐；`resolveEmbedConfig` 的 `providers?: AIProvider[]` 与这里的
 *   `TavernChatProvider[]` 结构兼容（`TavernChatProvider` 是 `AIProvider` 的子类型，
 *   形参逆变方向正确），故 `{ indexOneDoc, removeByRef, recallRelevant, renderRecallHits,
 *   resolveEmbedConfig }` 可以直接赋给本端口。
 * 测试替身怎么桩：`indexOneDoc` → `{ ok: true, chunks: 1 }`；`removeByRef` → 空 Promise；
 * `recallRelevant` → 固定两条 `RecallHit`（一条 `secret: false`、一条 `secret: true`，用来测
 * `hideSecretRows`）；`renderRecallHits` → 把 hits 的 text 拼起来；`resolveEmbedConfig` → 返回
 * `null`（要测「语义关闭」）或 `{ type: 'ollama', baseUrl: 'http://x', model: 'm' }`。
 */
export interface TavernSemanticPort {
  indexOneDoc(
    doc: IndexDoc,
    projectId: string,
    cfg: EmbedConfig,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; chunks: number; error?: string }>
  removeByRef(projectId: string, refId: string): Promise<void>
  recallRelevant(query: string, opts: RecallOptions): Promise<RecallHit[]>
  renderRecallHits(hits: RecallHit[], header?: string): string
  resolveEmbedConfig(s?: EmbeddingSettings, providers?: TavernChatProvider[]): Promise<EmbedConfig | null>
}

// ==================== ⑧ 联网检索 ====================

/**
 * 替掉上游 `@/lib/ai/webSearch.ts:277` 的 `webSearch`（`draft` / `script` / `story` / `world`
 * 四处调用；`draft.ts` 只把它当**类型**用，见侦察报告 §5 第 14 条）。
 *
 * 本类型是**引用**（值签名），不是接口 —— 上游 `webSearch` 本身就能直接当它用；
 * `TavernDraftMaterialPort.prepareDraftMaterial` 由 `draft.ts` 经 `@/lib/tavern/draft` 再导出取。
 *
 * 宿主怎么实现：`const search: TavernSearchPort = { webSearch }`（来自 `@/lib/ai/webSearch`），
 * 零适配 —— 上游早已把唯一宿主面（模块级 `defaultTransport`）设计成可注入的 `deps.transport`。
 * 测试替身怎么桩：返回 `{ used: true, engine: 'bocha', query, results: [{ title, url, snippet }] }`；
 * 要测「查失败照样继续」就给 `{ used: false, engine: '', query, results: [], error: '未配置密钥' }`。
 */
export interface TavernSearchPort {
  webSearch(
    query: string,
    settings: SearchSettings,
    signal?: AbortSignal,
    deps?: { transport?: SearchTransport },
  ): Promise<SearchOutcome>
}

// ==================== ⑨ 起草素材管线 ====================

/** 这次起草的**素材来源**（界面据此告诉作者「本次用的是哪种模式」）。上游 `editor/draftMaterial.ts:25-37` */
export interface DraftSource {
  mode: SearchSettings['mode']
  /** 显示用：模型已有知识 + 粘贴素材 / 模型自带联网 / 搜索接口（<引擎名>） */
  label: string
  /** 我们这边**确实取回了**外部资料（只有「搜索接口」档成功时才为 true） */
  used: boolean
  /** 这次到底有没有真的联上网 */
  web: WebVerdict
  /** 没查成的原因（used=false 时给界面看，绝不静默） */
  error?: string
  /** 附加说明（例如「是否真的联网取决于所选模型」这种无法验证的实情） */
  note?: string
}

/**
 * 「这次联网了吗」——由**产出素材的那一侧**裁决，界面与提示词都不许自己猜。
 * `searched` 确实取回 / `failed` 查了没成 / `delegated` 交给模型自己查（无法验证）/ `off` 按设置没联网。
 * 上游 `editor/draftMaterial.ts:48`
 */
export type WebVerdict = 'searched' | 'failed' | 'delegated' | 'off'

/** 上游 `editor/draftMaterial.ts:87-91` */
export interface DraftMaterial {
  /** 拼好的素材块（空串 = 没有额外素材） */
  blocks: string
  source: DraftSource
}

/**
 * 上游 `editor/draftMaterial.ts:93-104`。
 * `searchFn` 上游写作 `typeof webSearch`；这里写成 `TavernSearchPort['webSearch']` —— 两者
 * **结构等价**（`search.ts` 只放类型与常量、不放函数实现，故不能写 `typeof`）。
 */
export interface DraftMaterialArgs {
  /** 作者的一句话想法 */
  idea: string
  /** 作者粘贴的参考素材（可空） */
  refs?: string
  /** 补完模式：现有内容的摊平文本（可空） */
  existing?: string
  settings: SearchSettings
  signal?: AbortSignal
  /** 测试用：替换检索实现 */
  searchFn?: TavernSearchPort['webSearch']
}

/**
 * 起草素材管线 —— 替掉上游 `@/lib/editor/draftMaterial.ts:122` 的 `prepareDraftMaterial`
 * （`draft.ts` 调用；`script` / `story` / `world` 经 `@/lib/tavern/draft` 再导出取）。
 *
 * 宿主怎么实现：`const draftMaterial: TavernDraftMaterialPort = { prepareDraftMaterial }`
 * 或直接传该模块（`promptGuard` 已是本包文件，上游模块原样可用），零适配。
 * 测试替身怎么桩：返回 `{ blocks: '素材块', source: { mode: 'off', label: '模型已有知识 + 粘贴素材',
 * used: false, web: 'off' } }`；要测「查失败」把 `source.web` 换成 `'failed'` 并带上 `error`。
 */
export interface TavernDraftMaterialPort {
  prepareDraftMaterial(a: DraftMaterialArgs): Promise<DraftMaterial>
}

// ==================== ⑩ 平台能力探测 ====================

/**
 * 替掉上游 `@/lib/app/desktop.ts:135` `DESKTOP` + `:387` `getDesktopState` +
 * `@/lib/sync/desktopCloudSync.ts:90` `isDesktopCloudUnavailable`（**只有 `store.ts` 一处使用**）。
 *
 * `getDesktopState` 上游返回 11 个字段（`desktop.ts:343-386` 的 `DesktopState`），
 * 本端口**只声明 `store.ts` 真正消费的两个**（`store.ts:1104-1116` 的 `ghostPruneBlockedReason`）。
 * 多返回字段不影响结构兼容，宿主仍是零适配直传；若后续其它文件也要读桌面状态，再放宽本端口。
 *
 * 宿主怎么实现：`const platform: TavernPlatformPort = { DESKTOP, getDesktopState,
 *   isDesktopCloudUnavailable }`，零适配。
 * 测试替身怎么桩：`DESKTOP: false`（非桌面版走不到那两条分支）＋
 * `getDesktopState: () => ({ writeLocked: false, writeLockReason: '' })`。
 */
export interface TavernPlatformPort {
  /** 是否桌面（Electron 安装）版：`typeof window !== 'undefined' && typeof window.electronStore === 'object'` */
  DESKTOP: boolean
  /** 只声明 `store.ts` 消费的两个字段（🔴 写盘已锁定时禁止覆盖真实数据） */
  getDesktopState(): { writeLocked: boolean; writeLockReason: string }
  /** 云同步闩锁期（云端不可用） */
  isDesktopCloudUnavailable(): boolean
}

// ==================== ⑪ 纯工具 ====================

/**
 * 纯工具 —— 替掉上游 `@/lib/app/id.ts:9` 的 `uid`。
 *
 * 🔴 **只留 `uid`（不含 `formatDate`）**：上游 `uid` 带模块级 `uidSeq` 计数器
 * （`app/id.ts:7-12` 的 `let uidSeq = 0`，抄一份会出现**两套计数器**，破坏「全项目唯一实现」这条纪律）；
 * 而 `formatDate` 是纯口径函数，由 Lead 另派任务**直接抄进包**，不走端口。
 *
 * 宿主怎么实现：`const util: TavernUtilPort = { uid }`（来自 `@/lib/app/id`），零适配。
 * 测试替身怎么桩：`let n = 0; uid: () => 'id' + (++n)` —— 断言里只关心「同一个桩内 id 不重复」。
 */
export interface TavernUtilPort {
  /** 生成全局唯一 id */
  uid(): string
}

// ==================== ⑫ 访谈内核 ====================

/**
 * 访谈内核的全部宿主能力（草案见 `docs/酒馆内核移植-补遗-interview.md` §5）。
 * 上游等价物是 `@/lib/tavern/interview.ts:161-175` 的 `tavernCallChat` 闭包及其依赖。
 *
 * 🔴 **四个成员全部必填**：草案里 `isCancelled` / `getTimeoutMs` / `resolveProvider` 是可选的，
 * 但可选成员会迫使**每个调用点**都写一段「缺失时怎么办」的死代码。
 *
 * 🔴 宿主实现的**解析稳定性红线**：`callChat` 内部必须固定传
 * `json: true, think: false`（上游 `interview.ts:171-172`）——
 *   · `json: true` 会在未显式给 `temperature` 时切到 `JSON_TASK_TEMPERATURE`（0.3），上游注释
 *     明说这是「解析稳定性红线」，**新宿主漏传就是静默退回 0.85 创意温度**；
 *   · `think: false` 是酒馆侧关闭思考链的口径。
 * 这两项**不属于端口语义**（它们是实现的义务，不是接口的形状），所以只能写在注释里。
 *
 * 宿主参考实现（约 4 行，示意，不进包）：
 *   callChat: async (msgs, opts) => {
 *     const { provider } = await resolveProvider(providerId)
 *     return chat(provider, msgs, { timeoutMs: await getTimeoutMs(), signal: opts.signal,
 *       json: true, think: false })
 *   }
 * 测试替身怎么桩：`callChat` 返回一段 JSON 文本（如 `'{"filled":{},"question":"继续？","done":false}'`）；
 * `isCancelled` → `() => false`；`getTimeoutMs` → `async () => 30000`；
 * `resolveProvider` → `async () => ({ provider: 假 provider, fellBack: false })`。
 */
export interface TavernInterviewPort {
  /**
   * 【必需】发一轮对话。实现方自己解决「发给哪个模型、超时多少、要不要 json 模式」。
   * 上游等价物：`tavern/interview.ts:161-175` 返回的那个闭包（内部固定 `json: true, think: false`）。
   * 抛出的异常原样向上传播（核心层只在「没解析出 JSON」时抛自己的错）。
   */
  callChat: (msgs: TavernChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>
  /**
   * 【必需】取消判定。上游 = `isCancelled`（`aiCore/transport.ts:45`）的 re-export
   * （`tavern/interview.ts:14,207`）。必须与 `chat()` **同源**，别在宿主另写一份。
   */
  isCancelled: (e: unknown) => boolean
  /**
   * 【必需】请求超时（毫秒）。上游 = `timeoutMsOf(await getTavernSettings())`
   * = `Math.max(5, s.common.timeoutSec) * 1000`（`tavern/settings.ts:796-798`）。
   */
  getTimeoutMs: () => Promise<number>
  /**
   * 【必需】模型解析（会话 providerId → 面板默认 → 全局活动模型）。
   * 上游 = `resolveTavernProvider(ref?, fallbackProviderId?)`（`tavern/provider.ts:21-46`）。
   * 返回类型里 `provider` 用 `TavernChatProvider`（上游是 `AIProvider`，结构兼容）。
   */
  resolveProvider: (providerId?: string) => Promise<{ provider: TavernChatProvider; fellBack: boolean }>
}

// ==================== ⑬ 伴写文风存储 ====================

/**
 * 伴写文风勾选维度的存储 —— 替掉上游 `@/lib/tavern/companionStyle.ts:97,100,111,113-115` 的
 * `localStorage` 直读直写（`STORAGE_KEY = 'novel-companion-dims'`）。
 *
 * 🔴 键名 `novel-companion-dims` 由**宿主**决定，本包不写死：包内不该出现浏览器全局，
 * 而「键叫什么都不影响本包逻辑」——上游也只是 `localStorage.getItem/setItem/removeItem` 三个调用。
 *
 * 宿主怎么实现（约 5 行）：`{ read: () => localStorage.getItem('novel-companion-dims'),
 *   write: raw => { if (raw === null) localStorage.removeItem('novel-companion-dims')
 *                   else localStorage.setItem('novel-companion-dims', raw) } }`，
 * 每个方法各自 try/catch（上游注释：**隐私模式下 localStorage 不可写：功能降级，不阻断**）。
 * 测试替身怎么桩：一个 `let raw: string | null = null`，`read` 返回它、`write` 覆盖它。
 */
export interface TavernStyleStoragePort {
  /** 读原始 JSON 串；无键 / 读失败返回 null */
  read(): string | null
  /** 写原始 JSON 串；**空值语义 = 删除键** */
  write(raw: string | null): void
}

// ==================== 聚合接口 ====================

/**
 * 酒馆内核的**全部宿主能力**（14 个成员，成员名与个数被 `tests/ports.test.ts` 写死）。
 *
 * 分组理由（详见 `docs/酒馆内核移植-端口清单.md` §2.1）：
 *   · `chat` / `model` 分开：前者是「发一次请求」，后者是「该用哪个模型 + 就绪判定」，
 *     测试替身差别极大（一个返回文本、一个返回 provider 列表）；
 *   · `capacity`（已冻结）与 `model` 分开：前者实现体是 `@/lib/ai/modelCapacity` 的纯函数；
 *   · `platform` 独立：它是**平台能力探测**，与存储 / 对话都无关，且只有 `store.ts` 一处使用；
 *   · `search` / `draftMaterial` 不合并：它们替掉的是两个不同的上游模块
 *     （`@/lib/ai/webSearch` 与 `@/lib/editor/draftMaterial`），宿主可以只给其中一个。
 *
 * 🔴 `store` 已 `extends TavernMetaPort`（`db.getMeta/setMeta` 与 `db.getSetting/setSetting`
 *    是同一门面的两个层级）；`meta` **仍单独留一份**是给只碰全局 meta 的调用点
 *    （`presets` / `script` / `story` / `world`）：它们只需 2 个成员，不该被迫实现整个存储面。
 *
 * 测试替身怎么桩：写一个 `const mockPorts: TavernPorts = { … }` 完整对象（14 个键，
 * 每个键给上面各接口注释里说的最小实现）—— **它能通过编译本身就是端口可实现性的证明**。
 */
export interface TavernPorts {
  /** 只碰全局 meta 的调用点用（`presets` / `script` / `story` / `world`） */
  meta: TavernMetaPort
  /** 宿主存储全量（`store.ts` / `report.ts` 等）；已含 `meta` 的 get/set */
  store: TavernStorePort
  /** 发一次对话（15 处调用点共用） */
  chat: TavernChatPort
  /** 模型清单 + 就绪判定（`provider.ts` 专用） */
  model: TavernModelPort
  /** 已冻结的最小模型子集（服务 `settings.ts` 的额度推算） */
  providers: TavernProviderPort
  /** 已冻结的额度推算（宿主直传 `@/lib/ai/modelCapacity`） */
  capacity: TavernCapacityPort
  /** 项目上下文（`engine.ts` 专用） */
  context: TavernContextPort
  /** 语义检索（`recall.ts` 专用） */
  semantic: TavernSemanticPort
  /** 联网检索（`draft` / `script` / `story` / `world`） */
  search: TavernSearchPort
  /** 起草素材管线（同上四处） */
  draftMaterial: TavernDraftMaterialPort
  /** 平台能力探测（`store.ts` 专用） */
  platform: TavernPlatformPort
  /** 纯工具：只留 `uid`（`formatDate` 由 Lead 另派任务抄进包） */
  util: TavernUtilPort
  /** 访谈内核（`interview.ts` 专用） */
  interview: TavernInterviewPort
  /** 伴写文风存储（`companionStyle.ts` 专用） */
  styleStorage: TavernStyleStoragePort
}