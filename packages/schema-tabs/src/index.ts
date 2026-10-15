/**
 * `@yfe/schema-tabs` —— 旧版页签元数据的移植包（骨架由 Lead 建立，实现见本目录其余文件）。
 *
 * ## 这一包存在的理由
 *
 * 旧版 50 个 `TABS`（+ 隐藏的 `editor` / `geomaps`，共 52 个页签）**不是 52 个手写界面**，
 * 而是「元数据 + 通用渲染器」：29 个页签（5 `form` / 6 `card` / 18 `table`）完全由数据描述，
 * 只有 23 个是专属面板。把元数据搬过来，渲染层就能一次点亮 29 个页签。
 *
 * ⚠️ W1 实测修正（tab-data-bot，2026-10-15）：上一段的「50 / 52」是**制度四页签落地之前**的口径，
 *    不要拿它当断言依据。运行期实测：`TABS.length === 54`（50 个手写字面量 + 4 个由 `part1.ts` 的
 *    `...INSTITUTION_TABS.map(institutionTab)` 展开的制度页签），页签 id 总数 = **56**
 *    （54 + `editor` + `geomaps`）；`form` 也是 **9** 个（5 手写 + 4 制度），不是 5 个。
 *    权威数字与断言见 `packages/schema-tabs/tests/schema-tabs.test.ts` 头部说明。
 *
 * 移植来源（只读参考，禁止在本包内 import 它们）：
 * - `upstream/src/lib/schema.ts`（拼装 TABS / EDITOR_TAB / GROUPS / GEO_MAPS_TAB / tabVisible）
 * - `upstream/src/lib/schemaTabs/part{1,2,3}.ts`（50 个页签定义）
 * - `upstream/src/lib/schemaShared.ts`（字段构造器 `c`/`cH`、`INSTITUTION_TABS`、卷台账工具）
 * - `upstream/src/lib/schemaTemplates/**`（题材包；`modules` 一律是 getter）
 * - `upstream/src/lib/types.ts`（`TabDef` 等类型的权威定义）
 *
 * ## 硬约束
 *
 * 1. 只依赖 `@yfe/contracts`、`@yfe/domain`；**禁止** Electron / Node `fs`/`path` / DOM / Fastify / better-sqlite3。
 * 2. 元数据必须是**静态可枚举**的：`TABS` 是数组，`getTab(id)` 能查；不要用运行期副作用拼装。
 * 3. 旧版的兼容性陷阱必须原样保留：制度四页签 `politics`/`economy`/`belief`/`justice` 是并列结构、
 *    由 `part1.ts:92` 的 `...INSTITUTION_TABS.map(...)` 展开（静态 grep 数不到）；
 *    `worldbase`/`power` 的 `modules` 与 `INSTITUTION_TABS` 的 `modules` 是 getter（读当前题材包）；
 *    卷台账页签 id 是运行期合成的 `chapter-vol-<volumeId>`。
 *
 * ## 本文件（包入口）
 *
 * 只做**桶式再导出**（按依赖方向自上而下排列）：`types`（零依赖类型层）→ `schemaShared`
 * （构造器 / 制度页签 / 卷台账）→ `schema`（门面：TABS / getTab / tabVisible）→
 * `schemaTemplates`（题材模板）。渲染层 import 这一个入口即可拿到全部契约。
 *
 * 🔴 `types.ts` 里的中文文案字段（`desc` / `example` / 选项标签）与 upstream **逐字一致**，
 *    改它们＝改作者看到的说明，请走评审而不是顺手改。
 *
 * TODO(W1/tab-data-bot)：已按 `docs/开发计划-全功能预览版.md` §5 W1 落地；后续若还要加题材包内容，
 * 只动 `schemaTemplates/**`，不要动门面与类型层。
 */

/** 包名自述常量（保留自骨架：便于消费方在运行时断言拿到的确实是本包） */
export const SCHEMA_TABS_PACKAGE = '@yfe/schema-tabs'

// ① 类型层：零依赖单一源（TabDef / 字段列定义 / TabGroup+GROUPS / GenrePack+GENRE_PACKS / VisCtx）
export * from './types.js'
// ② 共享声明层：字段构造器 f/c/cFixed/cd/cc/ch/chs/ca/cr/cH、SABC*、制度页签工厂、卷台账工具
export * from './schemaShared.js'
// ③ 门面：TABS / EDITOR_TAB / GEO_MAPS_TAB / getTab / tabVisible / FEATURE_TIER / 依赖表
export * from './schema.js'
// ④ 题材模板：GENRE_PACKS / DEFAULT_PACK / getActivePack / setActivePack / normalizeGenrePack
//    / worldbaseModules / powerModules / institutionMeta / worldbaseDesc(_TIPS) / powerDesc(_TIPS)
export * from './schemaTemplates/index.js'
