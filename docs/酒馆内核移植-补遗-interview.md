# 酒馆内核移植 · 补遗：`@/lib/creative/interview`

> 补 `docs\酒馆内核移植-端口清单.md` 漏掉的一个模块。
> 侦察日期：2026-10-16。**只读侦察**，未修改上游任何文件。
> 上游根：`F:\youth-fantasy-engine-new\_upstream_tmp\youth-fantasy-engine-main\`

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 两个目标文件是否都存在 | **都存在**，无需 fallback 查找 |
| 核心机制层 | `src\lib\creative\interview.ts`（285 行）—— **纯逻辑，零宿主依赖** |
| 酒馆适配层 | `src\lib\tavern\interview.ts`（207 行）—— 提纲/栏名/标签是纯数据；模型解析与设置读取是宿主 |
| 真正的宿主耦合点 | 只有 3 处：`chat`（发请求）、`resolveTavernProvider`（读 provider 列表 + 酒馆设置）、`getTavernSettings`（读超时秒数） |
| 发请求能不能注入 | **上游早已是端口形状**：核心 `runInterviewTurn` 收 `deps.callChat`，酒馆层只是把它补成具体实现 |
| 建议 | 核心文件 285 行**整体抄进包**（含 `buildSiblingContext`）；酒馆层抄「提纲 + 栏名 + 标签 + 4 个转换器」，只把 `runInterviewTurn`/`tavernCallChat` 改成吃端口 |

---

## 1. 文件 A：核心机制层

### 1.1 基本信息

- **绝对路径**：`F:\youth-fantasy-engine-new\_upstream_tmp\youth-fantasy-engine-main\src\lib\creative\interview.ts`
- **精确行数**：**285**（`(Get-Content <path>).Count`）
- **别名**：`@/lib/creative/interview`

### 1.2 全部 import（逐行，原文）

```ts
import type { ChatMessage } from '@/lib/ai'
import { parsePlainObject, asText } from '@/lib/ai/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
```

三条 import 的宿主性质：

| import | 是什么 | 是否宿主依赖 |
|---|---|---|
| `type { ChatMessage }`（`@/lib/ai`） | 纯类型；定义在 `src\lib\aiCore\core.ts:59-62`：`{ role: 'system' \| 'user' \| 'assistant'; content: string }` | **否**（编译期擦除，包内自带即可） |
| `parsePlainObject, asText`（`@/lib/ai/aiParse`） | 纯字符串/JSON 处理。`parsePlainObject(raw)` 在 `aiParse.ts:51-60`：剥代码块 → 切最外层 `{}` → `JSON.parse` → 兜底接受 `[{...}]` 首元素；`asText(v)` 在 `aiParse.ts:242` 把任意值转文本 | **否**（`aiParse.ts` 顶部无任何 import，零依赖） |
| `newAuthorFence, authorBlock`（`@/lib/ai/promptGuard`） | 防提示注入的边界包裹。`promptGuard.ts:34-37` 的 `newAuthorFence()` 用 `Math.random().toString(36).slice(2,8)` + 模块级 `let seq`(第 27 行) 生成 nonce；`authorBlock(id, text)` 在 `promptGuard.ts:46-52` 原样包裹作者文本 | **否**（53 行，零 import；仅用 `Math.random()`） |

**结论：`creative/interview.ts` 全文不出现** `@/lib/db`、`@/lib/ai`（运行时值）、`@/lib/semantic`、`localStorage`、`fetch`、`window`、`document`、`node:`、`idb`。是干净的纯逻辑模块。

### 1.3 全部 export（逐字签名，含行号）

类型（`export type`）：

```ts
// L32-40
export type InterviewTopic = {
  key: string
  /** 话题名（界面显示进度用） */
  label: string
  /** 这一话题要问出什么（写给模型看的） */
  ask: string
  /** 对应模板里的哪些栏（用于进度统计） */
  fields: string[]
}

// L42
export type InterviewTurn = { role: 'user' | 'ai'; text: string }

// L44-51
export type InterviewState = {
  /** 对话历史（含 AI 的提问） */
  turns: InterviewTurn[]
  /** 到目前为止从对话里提炼出的字段（增量合并） */
  filled: Record<string, string>
  /** 模型认为可以收尾了 */
  done: boolean
}

// L53-59
export type InterviewReply = {
  /** 这一轮结束后累积的字段（已与进来的合并） */
  filled: Record<string, string>
  /** 要问作者的下一句 */
  question: string
  done: boolean
}

// L65-73
export type InterviewSpec = {
  /** 一句话说明在塑形什么（进提示词与标题，例：「一张角色卡」） */
  subject: string
  topics: InterviewTopic[]
  /** 允许的栏名（模型写了别的会被丢掉）；也是进度的分母 */
  allowedKeys: string[]
  /** key → 中文名（界面摊平用） */
  labels?: Record<string, string>
}
```

函数（逐字签名）：

```ts
// L75
export function emptyInterview(): InterviewState

// L80
export function interviewProgress(s: InterviewState, allowedKeys: string[]): { got: number; total: number }

// L92
export function deriveTopics(fields: { key: string; label: string; desc?: string }[], perTopic = 2): InterviewTopic[]

// L109
export function buildInterviewSystem(spec: InterviewSpec): string

// L139
export function buildInterviewUser(s: InterviewState, spec: InterviewSpec, existing?: string, context?: string): string

// L173-177
export function parseInterviewReply(
  raw: string,
  allowedKeys: string[],
  prev: Record<string, string> = {},
): InterviewReply | null

// L197
export function filledToText(filled: Record<string, string>, labels?: Record<string, string>): string

// L210-222
export async function runInterviewTurn(
  spec: InterviewSpec,
  s: InterviewState,
  answer: string | null,
  deps: {
    callChat: (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>
    signal?: AbortSignal
    /** 补完模式：已有内容的摊平文本 */
    existing?: string
    /** 额外背景（如本项目世界观）—— 让追问与既有设定保持一致 */
    context?: string
  },
): Promise<{ state: InterviewState; reply: InterviewReply }>

// L256-259
export function buildSiblingContext(
  entries: { name: string; data: Record<string, string> }[],
  opts?: { itemLabel?: string; perEntryLines?: number; totalLines?: number },
): string
```

> ⚠️ 任务里点名的 7 个符号之外，本文件**还有 3 个 export**：`deriveTopics`（L92）、`buildSiblingContext`（L256），以及 6 个类型中的 `InterviewTopic`/`InterviewTurn`/`InterviewReply` 三件套被酒馆层 re-export。`buildSiblingContext` 是任务清单里没提到的隐藏出口（见 5.6）。

### 1.4 逐函数说明

| 函数 | 参数含义 | 返回值结构 | async | 抛异常 | 读外部状态 |
|---|---|---|---|---|---|
| `emptyInterview()` | 无 | `{ turns: [], filled: {}, done: false }` | 否 | 否 | 否 |
| `interviewProgress(s, allowedKeys)` | `allowedKeys` = 分母白名单 | `{ got, total }`；`got` = `allowedKeys` 中 `filled` 非空白的个数 | 否 | 否 | 否 |
| `deriveTopics(fields, perTopic=2)` | `fields` = `{key,label,desc?}[]`；`perTopic` 默认 2 | `InterviewTopic[]`；`key` 形如 `t1`,`t2`…；`label` 用 ` · ` 连接；`ask` 把 `desc` 以全角括号附在 label 后 | 否 | 否 | 否 |
| `buildInterviewSystem(spec)` | 一份 `InterviewSpec` | 整段 system 提示词（`\n` join 的模板数组）。含：提纲编号列表、**两条硬规则**（一次只问 1–3 个相关问题 / 按提纲顺序推进）、字段白名单行、强制 JSON 输出格式 `{"filled":{"字段名":"内容"},"question":"…","done":false}` | 否 | 否 | 否 |
| `buildInterviewUser(s, spec, existing?, context?)` | `s` = 当前状态；`existing` = 补完模式的已有内容；`context` = 额外背景 | user 提示词。段落：`〖作者已有的内容〗`、`〖既有设定〗`、`〖提纲进度〗`、`〖目前已提炼的字段〗`、`〖对话到这儿〗` | 否 | 否 | **是**（调 `newAuthorFence()` → `Math.random()`；生成 nonce 本身不改全局状） |
| `parseInterviewReply(raw, allowedKeys, prev={})` | `raw` = 模型原文；`allowedKeys` = 白名单；`prev` = 上一轮已合并字段 | `InterviewReply \| null`。**白名单过滤**：`allowed.has(k)` 不通过直接 continue；`done` 接受 `true` 或 `'true'`；**`question` 与 `done` 双空时返回 null** | 否 | 否 | 否 |
| `filledToText(filled, labels?)` | `labels` 可选，缺省用 key 本身 | `【中文名】内容` 逐行 `\n` 连接；空白值被过滤 | 否 | 否 | 否 |
| `runInterviewTurn(spec, s, answer, deps)` | `answer` 为空/null = 开场轮（只让 AI 先问）；`deps.callChat` = 发请求（**由调用方注入，上游刻意不在这里解析模型配置**，见 L206-208 注释） | `{ state: InterviewState; reply: InterviewReply }`；`state.turns` 在 `reply.question` 非空时追加 `{role:'ai'}` | **是** | **是**：`if (!reply) throw new Error('引导模型没有按格式回应（没输出 JSON）—— 再发一次试试')`（L233） | **是**：调 `deps.callChat`（真正的 IO 在注入实现里）；`deps.signal` 透传 |
| `buildSiblingContext(entries, opts?)` | `entries` = 兄弟条目（调用方须先滤掉当前编辑的那条）；`itemLabel` 默认 `'条目'`；`perEntryLines` 默认 14；`totalLines` 默认 56 | 多块文本，每块 `【{itemLabel}·{name}】` + 前 N 行；超总行数时写「（另有 N 个{itemLabel}未列入）」；键含 `::` 时只取尾段 | 否 | 否 | 否 |

### 1.5 纯逻辑 vs 需宿主

**纯逻辑**（除 `runInterviewTurn` 的 `deps.callChat` 外全部）。唯一需要注意的非确定性是 `newAuthorFence()` 的随机 nonce —— 那是**有意的**（防注入边界不可预测，`promptGuard.ts:12-15` 有设计说明），不是宿主依赖。

---

## 2. 文件 B：酒馆适配层

### 2.1 基本信息

- **绝对路径**：`F:\youth-fantasy-engine-new\_upstream_tmp\youth-fantasy-engine-main\src\lib\tavern\interview.ts`
- **精确行数**：**207**（`(Get-Content <path>).Count`）
- **别名**：`@/lib/tavern/interview`

### 2.2 全部 import（逐行，原文）

```ts
import { chat, isCancelled, type ChatMessage } from '@/lib/ai'
import { resolveTavernProvider, type ChatFn } from '@/lib/tavern/provider'
import { getTavernSettings, timeoutMsOf } from '@/lib/tavern/settings'
import {
  emptyInterview as emptyInterviewCore,
  interviewProgress as interviewProgressCore,
  buildInterviewSystem as buildInterviewSystemCore,
  buildInterviewUser as buildInterviewUserCore,
  parseInterviewReply as parseInterviewReplyCore,
  runInterviewTurn as runInterviewTurnCore,
  filledToText as filledToTextCore,
  type InterviewSpec, type InterviewState as CoreState, type InterviewTopic,
  type InterviewTurn, type InterviewReply,
} from '@/lib/creative/interview'
import { EMPTY_CARD_DRAFT, type CardDraft } from '@/lib/tavern/draft'
import { EMPTY_SCRIPT_FIELDS, type ScriptDraftFields } from '@/lib/tavern/script'
import { EMPTY_STORY_FIELDS, type StoryDraftFields } from '@/lib/tavern/story'
```

### 2.3 这些 import 各自牵出多少宿主

| import | 上游文件 | 牵出的宿主依赖 |
|---|---|---|
| `chat, isCancelled, type ChatMessage`（`@/lib/ai`） | `src\lib\ai.ts`（显式再导出，禁 `export *`） | **重**。`ai.ts:50` → `@/lib/aiCore/chat`，`chat.ts:8-16` 再引 `transport`（`fetch`/SSE）、`usage`、`core`、`modelSampling`；`ai.ts:27` 有副作用 import `@/lib/aiCore/prompts`，`ai.ts:31` 引 `aiAssistPrompt`。`ai.ts:58/67` 还再导出 session（`aiCore/session.ts:8` `import * as db from '@/lib/db'`）。**这条链必须挡在包外。** |
| `resolveTavernProvider, type ChatFn`（`@/lib/tavern/provider`） | `provider.ts`（115 行） | **是**。`provider.ts:10` 引 `chat, isProviderUsable, typeLabel, loadProviders, requireActiveProvider, type AIProvider`；`provider.ts:11` 引 `getTavernSettings`。`loadProviders`/`requireActiveProvider` 落 `@/lib/db`。`resolveTavernProvider(ref?, fallbackProviderId?)` 的三层兜底：会话 `providerId` → 面板 `(await getTavernSettings()).common.defaultProviderId` → `requireActiveProvider()`（全局活动模型），返回 `{ provider: AIProvider; fellBack: boolean }`。`export type ChatFn = typeof chat` |
| `getTavernSettings, timeoutMsOf`（`@/lib/tavern/settings`） | `settings.ts`（808 行） | **是**。`settings.ts:23` `import * as db from '@/lib/db'`，`:44` 引 `loadProviders, loadActiveId`。用到的两个符号签名：`export async function getTavernSettings(): Promise<TavernSettings>`（L542）；`export function timeoutMsOf(s: TavernSettings): number { return Math.max(5, s.common.timeoutSec) * 1000 }`（L796-798） |
| `EMPTY_CARD_DRAFT, type CardDraft`（`@/lib/tavern/draft`） | `draft.ts`（202 行） | **是**。`draft.ts:23-31` 引 `@/lib/ai`、`@/lib/ai/aiParse`、`@/lib/ai/promptGuard`、`@/lib/tavern/provider`、`@/lib/tavern/settings`、`@/lib/ai/webSearch`、`@/lib/editor/draftMaterial`、`@/lib/tavern/cardFields`。**但 `CardDraft` 这个类型本身只是扁平 13 栏字面量（`draft.ts:36-55`），可无损抄进包。** |
| `EMPTY_SCRIPT_FIELDS, type ScriptDraftFields`（`@/lib/tavern/script`） | `script.ts`（368 行） | **是**。`script.ts:29` `import * as db from '@/lib/db'`（L81 起大量 `db.getMeta`）。**但六栏常量本身纯字面量（`script.ts:51-53, 69-71`）。** |
| `EMPTY_STORY_FIELDS, type StoryDraftFields`（`@/lib/tavern/story`） | `story.ts`（363 行） | **是**。`story.ts:20` `import * as db from '@/lib/db'`。**两栏常量本身纯字面量（`story.ts:248-250`）。** |

**结论：这个文件是「纯数据 + 一个宿主绑定层」的混合体。**
- 纯的部分：`CARD_TOPICS`、`SCRIPT_TOPICS`、`STORY_TOPICS`（未导出）、`KIND_NAME`、`CARD_LABELS`、`SCRIPT_LABELS`、`STORY_LABELS`、`fieldKeysOf`、`specOf`、`emptyInterview`、`interviewProgress`、`buildInterviewSystem`、`buildInterviewUser`、`parseInterviewReply`、`interviewToCard`、`interviewToScript`、`interviewToStory`、`filledToText`。
- 宿主的部分：`tavernCallChat`（模型解析 + 设置读取）、`runInterviewTurn` 的酒馆包装、`export { isCancelled }`。

### 2.4 全部 export（逐字签名，含行号）

```ts
// L32 —— 只是 re-export 核心层的三个类型（注意：InterviewSpec 没在这里导出）
export type { InterviewTopic, InterviewTurn, InterviewReply }

// L34
export type InterviewKind = 'card' | 'script' | 'story'

// L37-48  —— 纯数据，8 个话题
export const CARD_TOPICS: InterviewTopic[]

// L51-57 —— 纯数据，5 个话题
export const SCRIPT_TOPICS: InterviewTopic[]

// L79-83
export function fieldKeysOf(kind: InterviewKind): string[]

// L108-110
export function specOf(kind: InterviewKind): InterviewSpec

// L113
export type InterviewState = CoreState & { kind: InterviewKind }

// L115-117
export function emptyInterview(kind: InterviewKind): InterviewState

// L120-122
export function interviewProgress(s: InterviewState): { got: number; total: number }

// L124-126
export function buildInterviewSystem(kind: InterviewKind): string

// L128-130
export function buildInterviewUser(s: InterviewState, existing?: string): string

// L133-139
export function parseInterviewReply(raw: string, prev: Record<string, string> = {}): InterviewReply | null

// L142-146
export async function runInterviewTurn(
  s: InterviewState,
  answer: string | null,
  deps: { providerId?: string; chatFn?: ChatFn; signal?: AbortSignal; existing?: string; context?: string } = {},
): Promise<{ state: InterviewState; reply: InterviewReply }>

// L161-164
export function tavernCallChat(
  providerId?: string,
  chatFn?: ChatFn,
): (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>

// L178
export function interviewToCard(filled: Record<string, string>): CardDraft

// L186
export function interviewToScript(filled: Record<string, string>): ScriptDraftFields

// L194
export function interviewToStory(filled: Record<string, string>): StoryDraftFields

// L203-205
export function filledToText(filled: Record<string, string>, kind: InterviewKind): string

// L207
export { isCancelled }
```

**未导出（模块私有）**：`topicsOf(kind)`（L73-77）、`STORY_TOPICS`（L63-71）、`CARD_LABELS`（L86-90）、`SCRIPT_LABELS`（L91-93）、`STORY_LABELS`（L95-97）、`KIND_NAME`（L99）、`labelsOf(kind)`（L101-105）。

### 2.5 逐函数说明

| 函数 | 参数含义 | 返回值结构 | async | 抛异常 | 读外部状态 |
|---|---|---|---|---|---|
| `fieldKeysOf(kind)` | `'card'\|'script'\|'story'` | **对象 key 顺序**：card 用 `Object.keys(EMPTY_CARD_DRAFT)`；story 用 `Object.keys(EMPTY_STORY_FIELDS)`；script 用 `Object.keys(EMPTY_SCRIPT_FIELDS)` | 否 | 否 | 否（但 key 集合来源是三个宿主模块的常量，需在包内复制） |
| `specOf(kind)` | 同上 | `{ subject: KIND_NAME[kind], topics: topicsOf(kind), allowedKeys: fieldKeysOf(kind), labels: labelsOf(kind) }`；`subject` = `'角色卡'` / `'剧本'` / `'故事'` | 否 | 否 | 否 |
| `emptyInterview(kind)` | 同上 | `{ ...emptyInterviewCore(), kind }` = `{ turns: [], filled: {}, done: false, kind }` | 否 | 否 | 否 |
| `interviewProgress(s)` | 只用 `s.kind` + `s.filled` | `{ got, total }`，`total` 由该 kind 的栏数决定（**card 13 / script 6 / story 2**） | 否 | 否 | 否 |
| `buildInterviewSystem(kind)` | 同上 | 转发核心层，system 提示词全文 | 否 | 否 | 否 |
| `buildInterviewUser(s, existing?)` | **注意：没有 `context` 参数**（核心层有第四参 `context`，酒馆包装层没暴露） | 转发核心层，`spec` 由 `s.kind` 推 | 否 | 否 | 是（随机 nonce） |
| `parseInterviewReply(raw, prev={})` | **不收 kind，白名单是三类字段名的并集**：`[...new Set([...fieldKeysOf('card'), ...fieldKeysOf('script'), ...fieldKeysOf('story')])]`（L136） | `InterviewReply \| null` | 否 | 否 | 否 |
| `runInterviewTurn(s, answer, deps={})` | `deps.providerId` 指定模型；`deps.chatFn` 注入桩模型（单测用）；`deps.signal`；`deps.existing`；`deps.context`。全部可选（默认 `{}`） | `{ state: { ...res.state, kind: s.kind }, reply }` —— **回填 kind**，因为核心层不认 kind | **是** | **间接抛**：核心层在格式错时 `throw new Error('引导模型没有按格式回应（没输出 JSON）—— 再发一次试试')`；`resolveTavernProvider` 在全局活动模型也没配时抛（`requireActiveProvider`） | **是**：`tavernCallChat` → `resolveTavernProvider`（读 db + 设置）→ `getTavernSettings()`（读 db）→ `chat`（fetch） |
| `tavernCallChat(providerId?, chatFn?)` | `chatFn` 缺省时回落真 `chat`（`const runChat = chatFn ?? chat`，L165） | 闭包 `(msgs, opts) => Promise<string>`；内部固定传 `timeoutMs: timeoutMsOf(await getTavernSettings())`、`json: true`、`think: false`，并透传 `signal` | **是** | 是（模型解析失败 / 请求失败） | **是**（db + fetch） |
| `interviewToCard(filled)` | 扁平字段表 | `CardDraft`：`{ ...EMPTY_CARD_DRAFT }` 后逐 key `String(filled[k] ?? '').trim()`（**缺栏留空串，不抛**） | 否 | 否 | 否 |
| `interviewToScript(filled)` | 同上 | `ScriptDraftFields`，同上逻辑 | 否 | 否 | 否 |
| `interviewToStory(filled)` | 同上 | `StoryDraftFields`，同上逻辑 | 否 | 否 | 否 |
| `filledToText(filled, kind)` | **`kind` 必填**（核心层是可选 `labels`） | 转发核心层 `filledToTextCore(filled, labelsOf(kind))` | 否 | 否 | 否 |
| `isCancelled` | **纯 re-export**，本文件内无其它使用；实现在 `src\lib\aiCore\transport.ts:45` | `boolean` | 否 | 否 | 取决于实现（判 AbortError/取消标记） |

### 2.6 两份提纲的逐字内容（移植必须逐字保留）

`CARD_TOPICS`（8 个话题，顺序即设计）：

| # | key | label | fields | ask |
|---|---|---|---|---|
| 1 | `basic` | 名字与处境 | `['name','world']` | Ta 叫什么、在这个世界里处在什么位置（身份、常在什么地方、与「我」是什么关系） |
| 2 | `look` | 外在 | `['externals']` | 长什么样、多大、穿什么、身上常带着什么 —— 能让读者一眼认出 Ta 的细节 |
| 3 | `core` | 内核 | `['core']` | 什么性子、在乎什么、怕什么、眼下想要什么 |
| 4 | `speech` | 说话方式 | `['speech']` | 怎么说话（句子长短、口头禅、怎么称呼别人） |
| 5 | `relations` | 关系 | `['relations']` | 跟谁有牵扯、什么关系（有具体名字更好） |
| 6 | `limits` | 底线与边界 | `['cannot','knowledge']` | Ta 绝不会做什么、做不到什么；以及 Ta 知道什么、不知道什么 |
| 7 | `conduct` | 扮演规范 | `['perspective','bottomLine','paceLock','rating']` | 以谁的视角看（描写人称固定第三人称）、关系推进的节奏该怎么把握、适合什么尺度 |
| 8 | `examples` | 示例对话 | `['examples']` | 写一段小小的示范对话（能定住 Ta 的语气） |

L38-39 的注释解释了为什么只问「Ta 与这个世界的关系」：世界本身写在「故事」层，重复问 = 与故事层重复占额度。

`SCRIPT_TOPICS`（5 个话题）：

| # | key | label | fields | ask |
|---|---|---|---|---|
| 1 | `stage` | 这一场在哪 | `['name','situation']` | 先给这场戏起个短名（列表里认得出的那种），再说清此刻在哪、什么时候、两个人为什么在这儿、刚发生了什么 |
| 2 | `who` | 你是谁 | `['playerRole']` | 作者在这一场里演谁、跟对面什么关系、此刻想做什么 |
| 3 | `goal` | 这一场要什么 | `['goal']` | 这一场要推进到什么（一个主要目标就够，要可推进） |
| 4 | `taboo` | 不要发生 | `['taboo']` | 这一场不该出现什么（2–4 条具体的禁区） |
| 5 | `opening` | 开场白 | `['opening']` | 对面开口说的第一句（一两句即可，它是整场戏的语气锚点） |

`STORY_TOPICS`（**未导出**，L63-71；2 个话题，`fieldKeysOf` 与 labels 都有 story 分支，说明它是一等公民，只是忘了 export）：

| # | key | label | fields | ask |
|---|---|---|---|---|
| 1 | `name` | 故事名 | `['name']` | 先给这个世界起个短名（列表里认得出的那种） |
| 2 | `setting` | 这个世界 | `['setting']` | 把这个世界的骨架说清：发生在什么时候、什么地方（现实还是架空、城市还是乡野）；这里的规矩是什么 —— 有没有超自然或科技底色、有哪些势力、普通人怎么过日子。一次问完，别挤牙膏；作者答不完就先把答到的写进设定，下一轮再补。 |

三组标签表（逐字）：

```ts
// CARD_LABELS (L86-90)
name: '名字', world: '角色与设定的关系', externals: '外在', core: '内核', speech: '语言特征', relations: '关系',
cannot: '做不到的事', knowledge: '知识边界', perspective: '视角与人称', bottomLine: '底线清单',
paceLock: '进度锁', rating: '尺度', examples: '示例对话'
// SCRIPT_LABELS (L91-93)
name: '名称', situation: '情境', opening: '开场白', playerRole: '你的位置', goal: '这一场的目标', taboo: '不要发生'
// STORY_LABELS (L95-97)
name: '故事名', setting: '世界设定'
// KIND_NAME (L99)
{ card: '角色卡', script: '剧本', story: '故事' }
```

### 2.7 栏位清单（`fieldKeysOf` 的实际 key 集合，移植必须在包内重新声明）

这三个常量目前住在宿主模块里，**不能直接 import**（会拖 db 进来），必须在包内复制：

```ts
// 来自 lib/tavern/draft.ts:36-55 —— 13 栏，扁平
export type CardDraft = {
  name: string; world: string; externals: string; core: string; speech: string; relations: string
  cannot: string; knowledge: string; perspective: string; bottomLine: string; paceLock: string; rating: string
  examples: string
}
export const EMPTY_CARD_DRAFT: CardDraft = {
  name: '', world: '', externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '',
  perspective: '', bottomLine: '', paceLock: '', rating: '', examples: '',
}

// 来自 lib/tavern/script.ts:51-71 —— 6 栏（Pick<TavernScript, ...>）
export type ScriptDraftFields = Pick<TavernScript, 'name' | 'situation' | 'opening' | 'playerRole' | 'goal' | 'taboo'>
export const EMPTY_SCRIPT_FIELDS: ScriptDraftFields = {
  name: '', situation: '', opening: '', playerRole: '', goal: '', taboo: '',
}

// 来自 lib/tavern/story.ts:248-250 —— 2 栏
export type StoryDraftFields = Pick<TavernStory, 'name' | 'setting'>
export const EMPTY_STORY_FIELDS: StoryDraftFields = { name: '', setting: '' }
```

> `ScriptDraftFields` / `StoryDraftFields` 是对 `TavernScript` / `TavernStory` 的 `Pick`；包内若不带这两个实体类型，可直接展平成字面量类型（`{ name: string; situation: string; ... }`），**key 名与顺序不可变**（`Object.keys()` 的结果进 `fieldKeysOf`，而它又是进度条分母）。

### 2.8 纯逻辑 vs 需宿主

- ✅ **纯逻辑（可直接抄进包）**：`InterviewKind`、两个导出的提寻常量、三张标签表、`KIND_NAME`、`topicsOf`、`labelsOf`、`fieldKeysOf`、`specOf`、`emptyInterview`、`interviewProgress`、`buildInterviewSystem`、`buildInterviewUser`、`parseInterviewReply`、`interviewToCard`、`interviewToScript`、`interviewToStory`、`filledToText`。
- ❌ **需宿主（改造为端口）**：
  1. `tavernCallChat` —— 需要「解析模型」+「读超时秒数」+「发请求」三种能力。
  2. `runInterviewTurn`（酒馆版）—— 只是把 `tavernCallChat` 塞进核心层的 `deps.callChat`，本身没有额外逻辑，改造后几乎可以原样保留。
  3. `isCancelled` re-export —— 取决于宿主错误类型，包内应改成端口方法（或干脆不导出，让宿主自己包）。

---

## 3. 宿主依赖清单（汇总）

两个文件（及其直接 import）触达的宿主能力：

| 宿主物 | 出现在哪 | 用途 | 移植处置 |
|---|---|---|---|
| `@/lib/db`（IndexedDB） | `provider.ts:10`→`loadProviders`/`requireActiveProvider`；`settings.ts:23`；`script.ts:29`；`story.ts:20`；`draft.ts` 间接 | 读 provider 列表、酒馆设置、栏位常量所在模块的其它导出 | **端口**：`resolveProvider` + `getTimeoutMs`；栏位常量改为包内字面量 |
| `chat`（`@/lib/aiCore/chat.ts`）→ `fetch` / SSE / 用量上报 | `tavern/interview.ts:14, 165` | 真正发一轮对话 | **端口**：`callChat`（核心层已经就是这么设计的） |
| `isCancelled`（`@/lib/aiCore/transport.ts:45`） | `tavern/interview.ts:14, 207` | 纯 re-export 给界面判取消 | **端口**：`isCancelled?(e)` |
| `getTavernSettings()` → `TavernSettings.common.timeoutSec` | `tavern/interview.ts:16, 169`；`provider.ts:34, 62` | 请求超时毫秒；`common.defaultProviderId`、`common.injectSystemPrompt` | **端口**：`getTimeoutMs()`（可选，缺省给常量 30000） |
| `loadProviders` / `requireActiveProvider`（`@/lib/db`） | `provider.ts:41, 45` | 三层模型兜底链 | **端口**：`resolveProvider(providerId?)` |
| `@/lib/ai/webSearch`、`@/lib/editor/draftMaterial`、`@/lib/tavern/cardFields` | 仅经 `draft.ts` 被牵连 | 与访谈本身无关，只是同模块 | 不进包（复制常量即可） |
| `@/lib/semantic` | **不涉及** | — | — |
| `localStorage` / `window` / `document` / `node:` | **两个文件内均未出现** | — | — |

**注意**：两个 interview 文件里**没有**任何 `localStorage` / `fetch` / `window` / `document` / `node:` 的字面使用；所有宿主能力都是经上面的 import 间接来的。核心文件（A）**一个都没有**。

---

## 4. 消费者（改动时不能漏）

| 消费者 | 路径 | 用了什么 |
|---|---|---|
| `InterviewChat.tsx` | `src\components\creative\InterviewChat.tsx`（L22, L51, L62, L86, L183） | **直接用核心层**：`runInterviewTurn(spec, state, text, { callChat, existing, context })`、`emptyInterview()`、`interviewProgress(state, spec.allowedKeys)`、`filledToText(state.filled, spec.labels)` |
| `AITemplateFill.tsx` | `src\components\ai\AITemplateFill.tsx`（L32, L234） | `deriveTopics`、`filledToText`、`type InterviewSpec` |
| `creativeSeed.ts` | `src\lib\creative\creativeSeed.ts`（L18, L70） | `filledToText`、`type InterviewSpec` |

> `InterviewChat.tsx` 的存在是**强证据**：核心层的 `deps.callChat` 是「调用方按需注入模型」的设计，换言之**上游已经把核心层做成端口形状**，包化只需要把 `ChatMessage` 的类型搬进包、并把「谁发请求」留给宿主。

---

## 5. 端口接口草案

设计原则（照任务要求）：**端口作末尾参数追加，不用工厂函数**。

```ts
// ===================== 包内自带（零宿主依赖） =====================
// relay of: src/lib/aiCore/core.ts:59-62
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 访谈内核的全部宿主能力。
 * 不含任何存储/网络/环境访问 —— 实现方在宿主侧组装。
 * 约定：不实现的可选方法，包内走静态兜底（见注释）。
 */
export interface TavernInterviewPort {
  /**
   * 【必需】发一轮对话。实现方自己解决「发给哪个模型、超时多少、要不要 json 模式」。
   * 上游等价物：`tavernCallChat` 返回的那个闭包（interview.ts:161-175），
   * 内部固定 `json: true, think: false, timeoutMs: timeoutMsOf(await getTavernSettings())`。
   * 抛出的异常原样向上传播（核心层只在「没解析出 JSON」时抛自己的错）。
   */
  callChat: (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>

  /**
   * 【可选】取消判定。上游 = `isCancelled`（aiCore/transport.ts:45）的 re-export。
   * 不实现时包内给 `(e) => e instanceof Error && e.name === 'AbortError' || e === 'cancelled'` 之类兜底。
   */
  isCancelled?: (e: unknown) => boolean

  /**
   * 【可选】请求超时（毫秒）。上游 = `timeoutMsOf(await getTavernSettings())`
   *   = `Math.max(5, s.common.timeoutSec) * 1000`（settings.ts:796-798）。
   * 只在调用方选择「让包内代管超时」时使用；若 callChat 实现自己管超时，可省略。
   */
  getTimeoutMs?: () => Promise<number>

  /**
   * 【可选】模型解析（会话 providerId → 面板默认 → 全局活动模型）。
   * 上游 = `resolveTavernProvider(ref?, fallbackProviderId?)`（provider.ts:21-46），
   * 返回 `{ provider: AIProvider; fellBack: boolean }`。
   * 仅当希望包内保留「空 providerId = 跟随默认模型」这条三层兜底链时才需要；
   * 否则宿主在 callChat 里自己做。
   */
  resolveProvider?: (providerId?: string) => Promise<{ provider: unknown; fellBack: boolean }>

  /** 【可选】测试注入桩：等价上游 `ChatFn`（`typeof chat`，provider.ts:14）。由 callChat 实现方自行处理。 */
}
```

### 5.1 包内方法签名（端口一律追加为末尾参数）

**基础层**（原样抄，零依赖，**不需要端口**）：

```ts
export type InterviewTopic = { key: string; label: string; ask: string; fields: string[] }
export type InterviewTurn = { role: 'user' | 'ai'; text: string }
export type InterviewState = { turns: InterviewTurn[]; filled: Record<string, string>; done: boolean }
export type InterviewReply = { filled: Record<string, string>; question: string; done: boolean }
export type InterviewSpec = { subject: string; topics: InterviewTopic[]; allowedKeys: string[]; labels?: Record<string, string> }

export function emptyInterview(): InterviewState
export function interviewProgress(s: InterviewState, allowedKeys: string[]): { got: number; total: number }
export function deriveTopics(fields: { key: string; label: string; desc?: string }[], perTopic?: number): InterviewTopic[]
export function buildInterviewSystem(spec: InterviewSpec): string
export function buildInterviewUser(s: InterviewState, spec: InterviewSpec, existing?: string, context?: string): string
export function parseInterviewReply(raw: string, allowedKeys: string[], prev?: Record<string, string>): InterviewReply | null
export function filledToText(filled: Record<string, string>, labels?: Record<string, string>): string
export async function runInterviewTurn(
  spec: InterviewSpec, s: InterviewState, answer: string | null,
  deps: {
    callChat: (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>
    signal?: AbortSignal; existing?: string; context?: string
  },
): Promise<{ state: InterviewState; reply: InterviewReply }>
export function buildSiblingContext(
  entries: { name: string; data: Record<string, string> }[],
  opts?: { itemLabel?: string; perEntryLines?: number; totalLines?: number },
): string

// 包内自带的、从宿主模块抄过来的字面量（第 2.7 节）
export type CardDraft = { name: string; world: string; externals: string; core: string; speech: string; relations: string; cannot: string; knowledge: string; perspective: string; bottomLine: string; paceLock: string; rating: string; examples: string }
export type ScriptDraftFields = { name: string; situation: string; opening: string; playerRole: string; goal: string; taboo: string }
export type StoryDraftFields = { name: string; setting: string }
export const EMPTY_CARD_DRAFT: CardDraft
export const EMPTY_SCRIPT_FIELDS: ScriptDraftFields
export const EMPTY_STORY_FIELDS: StoryDraftFields
```

**提纳层**（纯数据 + 转发，**不需要端口**）：

```ts
export type InterviewKind = 'card' | 'script' | 'story'
export type InterviewState = CoreState & { kind: InterviewKind }
export const CARD_TOPICS: InterviewTopic[]
export const SCRIPT_TOPICS: InterviewTopic[]
export const STORY_TOPICS: InterviewTopic[]   // 🔴 上游未导出，建议包内补上（见 6.1）
export function fieldKeysOf(kind: InterviewKind): string[]
export function specOf(kind: InterviewKind): InterviewSpec
export function emptyInterview(kind: InterviewKind): InterviewState        // 注意与基础层同名 —— 见 6.3
export function interviewProgress(s: InterviewState): { got: number; total: number }
export function buildInterviewSystem(kind: InterviewKind): string
export function buildInterviewUser(s: InterviewState, existing?: string, context?: string): string  // 建议补回 context
export function parseInterviewReply(raw: string, prev?: Record<string, string>): InterviewReply | null
export function interviewToCard(filled: Record<string, string>): CardDraft
export function interviewToScript(filled: Record<string, string>): ScriptDraftFields
export function interviewToStory(filled: Record<string, string>): StoryDraftFields
export function filledToText(filled: Record<string, string>, kind: InterviewKind): string
```

**需端口（改造后的签名，端口是末尾参数）**：

```ts
/**
 * 酒馆侧一轮访谈 —— 端口追加为第 4 参。
 * 与上游 `tavern/interview.ts:142` 的差别：第 3 参 deps 里去掉 providerId/chatFn（那是宿主实现细节，
 * 应封在 port.callChat 里），只留 signal/existing/context；port 追加在末尾。
 */
export async function runTavernInterviewTurn(
  s: InterviewState,
  answer: string | null,
  deps: { signal?: AbortSignal; existing?: string; context?: string },
  port: TavernInterviewPort,
): Promise<{ state: InterviewState; reply: InterviewReply }>

/**
 * 上游 `tavernCallChat(providerId?, chatFn?)` 的端口化对应物 —— 默认实现的参考实现。
 * 包内只在「宿主没提供现成 callChat」时用它；它自己只做「解析超时 + 透传 signal」，
 * 发请求与模型解析全部走 port。
 */
export function makeTavernCallChat(
  port: TavernInterviewPort,
  opts?: { providerId?: string },
): (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>

/** 取消判定的端口化入口（上游是 re-export 的 isCancelled）。 */
export function isCancelled(e: unknown, port?: TavernInterviewPort): boolean
```

### 5.2 宿主侧参考实现（示意，不进包）

```ts
const port: TavernInterviewPort = {
  callChat: async (msgs, opts) => {
    const { provider } = await resolveTavernProvider(providerId ? { providerId } : undefined)
    return chat(provider, msgs, {
      timeoutMs: timeoutMsOf(await getTavernSettings()),
      signal: opts.signal,
      json: true,      // 🔴 上游 interview.ts:171 —— JSON 任务，强制低温 0.3
      think: false,    // 🔴 上游 interview.ts:172
    })
  },
  isCancelled,                                   // 来自 @/lib/ai
  getTimeoutMs: async () => timeoutMsOf(await getTavernSettings()),
  resolveProvider: (providerId) => resolveTavernProvider(providerId ? { providerId } : undefined),
}
```

> `json: true` 与 `think: false` **必须逐字保留**：`ChatOptions.json`（`aiCore/chat.ts:32`）会在未显式给 `temperature` 时切到 `JSON_TASK_TEMPERATURE`（0.3），上游注释明说是「解析稳定性红线」；`think: false` 是酒馆侧关闭思考链的口径。这两个不属于端口语义，应写进宿主实现的文档注释，别让新宿主漏传。

---

## 6. 建议整体抄进包的部分

### 6.1 文件 A 全量抄（285 行，一字不改）

`src\lib\creative\interview.ts` 整体进包。它是**唯一真源**（文件头 L24-25 明确写：「别在业务侧再写一份访谈逻辑：提问规则、字段白名单、增量合并这三件事一旦有两份实现，就一定会漂移」）。只需把三条 import 换成包内实现：

- `type { ChatMessage }` → 包内自带 `ChatMessage`（3 行接口）。
- `parsePlainObject`/`asText` → 从 `aiParse.ts` 抄这两个函数（`aiParse.ts` 零 import，`parsePlainObject` 依赖内部 `sliceJSON`/`stripCodeFence`/`tryParse`，`asText` 是独立的，总共约 50 行）。
- `newAuthorFence`/`authorBlock` → 从 `promptGuard.ts` 抄（53 行全文，零依赖）。🔴 必须连 `let seq = 0`（模块级计数器）一起抄，否则 nonce 唯一性减弱。

### 6.2 文件 B 抄「数据 + 转换器」，抛掉「模型解析」

抄进包：`InterviewKind`、`CARD_TOPICS`、`SCRIPT_TOPICS`、`STORY_TOPICS`（建议补 export）、`CARD_LABELS`、`SCRIPT_LABELS`、`STORY_LABELS`、`KIND_NAME`、`topicsOf`、`labelsOf`、`fieldKeysOf`、`specOf`、三个 `interviewTo*`、`filledToText`、以及 2.7 节的三组 `EMPTY_*` 字面量。

重写成端口调用：`runTavernInterviewTurn`、`makeTavernCallChat`、`isCancelled(e, port?)`。

### 6.3 移植时的三个坑（务必留意）

1. **同名函数两套签名并存**：基础层 `emptyInterview(): InterviewState` 与提纳层 `emptyInterview(kind: InterviewKind): InterviewState`；`interviewProgress(s, allowedKeys)` 与 `(s)`；`buildInterviewSystem(spec)` 与 `(kind)`；`filledToText(filled, labels?)` 与 `(filled, kind)`。上游靠**模块路径**区分（`@/lib/creative/interview` vs `@/lib/tavern/interview`），包里必须落成两个不同模块（例：`port/interview-core.ts` + `port/interview-tavern.ts`），或用 `Core` 后缀重命名。**不要**合并成一个带默认参数的重载。
2. **`parseInterviewReply` 的白名单范围不同**：核心层按 `spec.allowedKeys` 严格；酒馆层是三类并集（`interview.ts:136`）——这是**兼容旧调用的有意设计**，不是 bug，别「顺手统一」。
3. **`buildInterviewUser` 酒馆版丢了 `context`**：核心层支持第 4 参 `context`（`InterviewSpec` 之外的额外背景），但酒馆包装层（L128-130）没暴露；而同一文件的 `runInterviewTurn`（L145）**有** `context`。属上游遗漏，包内建议补回（各 6.3 节表格已标）。

### 6.4 不抄的部分（与访谈无关，别被牵连）

`draft.ts` 的起草提示词与 `draftCard`、`script.ts`/`story.ts` 的 db 读写、`webSearch`、`draftMaterial`、`cardFields` —— 这些与访谈只共享「栏位常量」这一层关系。

---

## 7. 不确定处（逐条）

1. **`STORY_TOPICS` 未导出**。L63 是 `const STORY_TOPICS`（无 `export`），但 `topicsOf`/`specOf`/`fieldKeysOf`/labels 全都有 story 分支，说明 story 是完整支持的一等 kind。无法从代码判断这是「有意私有」还是「漏写 export」。移植建议：包内**导出**它，并注明是从上游推导补上的。
2. **`InterviewSpec` 未被酒馆层 re-export**。L32 只 `export type { InterviewTopic, InterviewTurn, InterviewReply }`，但导出的 `specOf(kind): InterviewSpec` 返回这个类型。上游能编译可能是 `isolatedDeclarations` 未开或声明产物里内联了。移植时建议显式导出 `InterviewSpec`，否则包的使用方拿不到 `specOf` 的返回类型。
3. **`lib\ai\index.ts` 不存在**。`@/lib/ai` 解析到 `src\lib\ai.ts`（我按 `ai.ts` 读取并核对 re-export 行）。若上游 tsconfig 另有 `paths` 映射到别的文件，我的结论（`chat` 链拖 fetch/db）需要重新核对 —— 但 `ai.ts:50` 的 `export { chat, ... } from '@/lib/aiCore/chat'` 与 `aiCore/chat.ts:8` 的 transport import 是直接的证据，风险低。
4. **`isCancelled` 的具体判据未读**。我只确认了它定义在 `src\lib\aiCore\transport.ts:45`，没读函数体。端口草案里的兜底实现（判 `AbortError`）是**推测**，落地时应读 `transport.ts:45` 附近确认真实判据。
5. **`tavernCallChat` 的 `think: false` 是否有条件**。上游此处**硬编码** `think: false`；而同目录 `run/turn.ts` 用的是 `thinkOptOf(s)`（`settings.ts:806`，按 `common.disableThink` 决定传 `false` 还是 `undefined`）。`interview.ts` 的硬编码可能是有意（访谈是结构化任务）也可能是遗漏。移植时建议先照原样硬编码，并标 TODO。
6. **`filledToText` 的 labels 缺省口径**。酒馆版**必须**传 `kind`，调用方拿不到「用 key 本身当标签」的行为；若有别的历史调用点依赖这个差异，未在本次侦察范围内核对（我只覆盖了任务点名的两个文件 + 其直接 import）。
7. **`CARD_TOPICS`/`SCRIPT_TOPICS` 是 `const` 数组而非 `as const`/frozen**。导出的是可变数组引用，任何消费者都能 `push` 进去并污染全局提纲。包内可考虑冻结，但这会改变上游的可变契约（有极小概率有人靠它改提纲），需产品决策。
8. **`provider.ts` 的 `applyUserSystemPolicy`**（L59-67）会在模型带自定义 `systemPrompt` 且酒馆开关关闭时剥掉 `systemPrompt`。这条策略挂在 `resolveTavernProvider` 上，因此 `interview` 也受影响。端口草案把整个 `resolveProvider` 当黑盒，**没有**在包内复现这条策略 —— 宿主如果自己实现 `callChat` 而不复用 `resolveTavernProvider`，会丢掉这个行为。建议宿主侧文档显式提醒。
9. **未核对 `components\creative\InterviewChat.tsx` 之外的 UI 调用点**（例如是否有「补完已有」入口传 `existing`/`context`）。我按 grep 命中的 3 个消费者列出；这是本任务范围内 `filledToText`/`InterviewSpec`/`runInterviewTurn` 的全部命中。
10. **行数用 `(Get-Content).Count` 测得：285 / 207**，与你给的口径一致。若上游文件在本次侦察后被改动，两个数字都会变。

---

## 8. 一句话交给移植者

核心 285 行是**纯的**，抄进去就行；酒馆那 207 行里，只有 `tavernCallChat`（模型解析 + 超时 + 发请求）和 `isCancelled` 是宿主的，其余全是**逐字必须保留的中文提纲/标签数据**——那 8 + 5 + 2 个话题的顺序与措辞就是产品设计本身，别改写、别「优化」。