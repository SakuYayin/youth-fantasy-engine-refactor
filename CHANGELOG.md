# 更新记录（CHANGELOG）

《青春幻想引擎》重构工程 · 分支 `release/alpha-0.1.0` · 版本 `4.0.0-dev.0`

本文件记录本仓库相对原版（[tgxy2026/youth-fantasy-engine](https://github.com/tgxy2026/youth-fantasy-engine)）从零重写的每一次交付。
口径：**只记「改了什么 / 关键文件 / 验收数字」**；未做项与已知缺口集中在文末，逐条对应 `docs/项目台账.md` 的 R-1…R-96 风险台账。

---

## 0.1.0-alpha 交付总览

| # | 批次 | 提交 | 一句话 |
| --- | --- | --- | --- |
| 1 | P0 契约包与工程骨架 | `7badda2` `d556a4e` | 契约闭集定稿 + 门禁可用（211 tests） |
| 2 | 领域内核与桌面宿主 | `7fc2442` `2186118` `dff41b0` `bdf69a6` | 草稿会话状态机、SQLite 仓储、DB worker、主进程端到端接线 |
| 3 | 后端 P3（身份/同步/附件/任务/管理/运维） | `750cd3f` `58885b9` `de2eae1` `5c9c6b3` `4cf1442` `2faa730` | Fastify 5 模块化单体，20 表、四角色、批次同步、附件、任务队列、备份恢复 |
| 4 | 备份/恢复与旧数据导入 | `3673798` `c61a03f` `b9dd92c` `ff6e44a` | `VACUUM INTO` 一致快照 + 原子恢复；旧库只读导入与迁移报告 |
| 5 | 渲染层 V1（外壳/编辑器/通用渲染器/22 面板） | `ff4473a` `5880362` `a6cdd9c` `7677fe7` `2468f46` `1bf29df` | Vue 3.5 + CodeMirror 6 工作区、三路渲染器、面板注册表 |
| 6 | 测试类型门禁归零 | `3aaec86` | 158 → 0 条测试类型错，修掉两处静默缺陷 |
| 7 | W8 外壳接线与主题 | `c46ab2b` | 作品中心/备份/设置/欢迎向导四屏、9 套主题、示范项目、tavern 包 |
| 8 | 酒馆端口层与真窗口验收修复 | `8c80b45` | 缩放跟随窗口、真窗口验收断链修复 |
| 9 | 还原波次 W9（A/B/C 组） | `5d31e6f` `d1b9c82` | 启动失败兜底页、侧栏折叠与拖宽、分词字数、快捷键、指南/关于/地图/状态栏 |

---

## 1. P0 契约包与工程骨架

- **`d556a4e`** `test(p0): 契约包验收 211 passed + 修复门禁盲区与两处契约缺陷`
- **`7badda2`** `test(p0): 契约包测试补全（120 passed）+ 修复 severityOf 分类漏项`
- 工程配置：npm workspaces（`packages/*` / `apps/*` / `services/*`）、TypeScript strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`、Vitest 4 projects、ESLint、`tools/test-lock.mjs`（并发测试令牌）。
- 契约闭集：`packages/contracts`（错误码/ID 规则/权限/同步协议/移动端 `MobileDatabase`）。

## 2. 领域内核与桌面宿主

- **`dff41b0`** 领域内核收口 + 桌面端到端接线 + savedraft 测试（当时 6 项目 / **451 tests** 全绿）。
- **`bdf69a6`** 修 **R-18 真缺陷**：幂等重放下仓储层自造 ID 导致「返回给客户端的 ID ≠ 落库 ID」——改为透传调用方 `projectId`/`documentId`，不传才自生成；畸形 ID 报 `VALIDATION_MALFORMED_ID`。
- **`2186118`** 渲染层草稿会话状态机 `apps/desktop/src/renderer/state/draft-session.ts`：单在途保存、迟到结果丢弃（`draftSequence` 判定）、`applyExternalUpdate`/`resolveConflict`、防抖 800ms + 最长等待 5000ms。
- **`7fc2442`** Electron 宿主骨架：`service-host.mjs`（utilityProcess 监督 + 退避重启）、`db-worker.mjs`（`module.registerHooks` 做 `.js→.ts` 映射，无需构建）、preload `.cjs`（`sandbox:true` 不允许 ESM preload，见 ADR 0003）。
- **`1523e75`** 台账第 5 轮更新（团队缺口、11 条风险、3 条决策）。
- 顺带修掉一个真实并发缺陷：`waitForReady` 从单槽等待改为等待者集合（10 个并发首批调用原先会互相覆盖，9 个干等超时）。

## 3. 后端 P3

- **`750cd3f`** Fastify 5 骨架 + 20 张服务端表 + 身份/配对/权限。密码用 **scrypt**（`PASSWORD_ALGORITHM='scrypt'`，N=2^15/r=8/p=1），理由：零新增依赖、无原生编译链、串形自描述可迁移（台账 R-20）。修掉 **R-25**（真文件库 WAL 判定缺 `{simple:true}` 导致 100% 启动失败，`:memory:` 测试全看不见）、**R-26**（logout 未挂会话守卫 ⇒ CSRF 钩子从不执行）。
- **`58885b9`** 工作区/同步路由：批次原子提交（全接受或全拒绝）、`batchId`/`opId` 幂等、基线冲突 409、游标 410、实体类型白名单。
- **`de2eae1`** 附件上传（分片/去重/引用索引）+ 任务队列与 SSE 事件流 + 设备令牌与远程命令 + 迁移 3（`upload_parts`/`assets`/`asset_refs`/`jobs`/`job_outputs`）。
- **`5c9c6b3`** 修 **R-42 真缺陷**：`completeJob`/`failJob` 原先只按 `job_id` 更新，租约过期被他人重领后原 worker 仍能把任务推成 `succeeded`（副作用重复）——新增租约栅栏 `assertLeaseFence`（owner/attempt）+ 自动续租 + 队列循环兜底。
- **`4cf1442`** 管理面：系统管理员唯一真相源是 `server_state.owner_user_id`（users 表刻意无 `is_admin` 列）；末位所有者保护。
- **`2faa730`** 运维存储面：存储探针（防 SSRF/云元数据）、在线备份、13 类损坏校验、恢复需二次认证 + `maintenance:true`。

## 4. 备份/恢复与旧数据导入

- **`3673798`** `VACUUM INTO` 一致快照 + 清单（每文件 sha256 + 实体计数 + 迁移台账）+ 原子恢复（`.restoring` → 换名 → 再校验），ADR 0004。
- **`c61a03f`** `packages/legacy-import`：旧库只读导入、确定性 ID（`legacy-id-sha256-v1`）、未知字段保留、dry-run 零写入；**拒绝把读取失败当空**。
- **`b9dd92c`** `ff6e44a` 台账补验收与 R-29~R-34（含测试锁「写冻结」纪律）。

## 5. 渲染层 V1

- **`ff4473a`** Vue 3.5 + CodeMirror 6 工作区外壳与编辑器；六态保存语义（网络错误绝不覆盖本地保存状态）；`@yfe/client-sdk`（69 tests）与 `@yfe/ui`（44 tests）与旧数据读取器（2095 行）。
- **`a6cdd9c`** 旧版页签元数据 + 三路通用渲染器（form 31 / table 55 / card 40 tests）+ 设定实体通道（IPC 6→9）。
- **`7677fe7`** W7 全部 **22 个专属面板** + AI 契约 + `panel-store` + 酒馆组面板。
- **`2468f46`** `1bf29df` 章节管理链（更新/删除）与作品中心·备份恢复数据通道（IPC 9→19，含集成验收 11 例）。
- **`5880362`** 全仓审查修复 + Electron 真实窗口验收（`--gui-check` 15/15）。

## 6. 测试类型门禁归零

- **`3aaec86`** `fix: 测试类型门禁归零（158→0）并修掉两处静默缺陷`：
  - **R-75**：面板注册表键写成驼峰 `plotCanvas:` 而权威 `TabDef.id` 是 `plot-canvas` ⇒ 永远匹配不上、**静默回落占位组件**；新增交叉断言测试钉住。
  - **R-76**：`vue-shims.d.ts` 把 `*.vue` 声明得过宽，与 `Component<PanelProps>` 不兼容（21 处 TS2322），且该缺陷**只在测试门禁暴露**。

## 7. W8 外壳接线与主题

- **`c46ab2b`**（85 文件，+24237/-6）：
  - 四屏外壳：作品中心 / 备份与恢复 / 设置 / 欢迎向导（`apps/desktop/src/renderer/features/*` 全套 + `ports.ts`）。
  - 主题层 `theme/{palettes,variables,zoom}.ts`：9 套主题、19 条旧变量别名、`applyThemeVariables` 先清后写、`applyZoom`。
  - 设置存储 `features/settings-store.ts`：键名逐字照抄旧版（`yfe-theme`/`yfe-ui-zoom`/`yfe-ui-zoom-manual`/`yfe-font-prefs`/`yfe-sidebar-w`/`yfe-ui:sidebar-collapsed-groups`/`yfe-ui:dock-collapsed`），字体栈走白名单（CSS 注入面）。
  - 示范项目「吞天神脉」：21 章 / 16,535 字（上游全量约九万字，见欠账 A-02）。
  - `packages/tavern` 建包 + 酒馆内核 L0（端口风格：**末尾追加端口参数**，不做 `createXxx(deps)` 工厂）。
  - `docs/移动端技术栈选型.md`：首选 uni-app x 蒸汽模式（按既定契约而非评分）。

## 8. 酒馆端口层与真窗口验收修复

- **`8c80b45`**：
  - **R-81**：自动缩放真正跟随窗口（`App.vue` 挂 resize 监听 + 三条护栏），4 条锁定测试。
  - **R-84 / R-85**：加外壳后真窗口验收静默断链（首启欢迎向导让写作页 `display:none` ⇒ `focus()` 静默失败、字没进编辑器；两段断言共用 `try` 互相连坐）——`gui-editor-check.mjs` 重写为「先过关、断言编辑器**可见**、显式写 `welcomeSeen`」，新增 `ui.welcome.first-run` 断言。
  - 三条旧记录纠偏：R-49 关窗询问**其实已完整实现**；R-51 上游**没有**命令面板（真实缺口是保存快捷键只在编辑器聚焦时生效）；`build:renderer` 必须带 `-w @yfe/desktop`。
  - 新增 `docs/酒馆内核移植-端口清单.md`（1209 行）、`docs/酒馆内核移植-补遗-interview.md`（632 行）、`docs/剩余还原工作量清单.md`（72 项）。

## 9. 还原波次 W9

- **`5d31e6f`**（28 文件，+5881/-72）：
  - 酒馆端口层冻结：`packages/tavern/src/ports.ts`（14 端口）+ `search.ts`（类型/常量，零实现）+ 纯逻辑抄入 `aiParse.ts`/`date.ts`（+ 28 + 95 例）。
  - **A-04** 启动失败兜底页（`features/boot-error.vue`，上游文案逐字）。
  - **A-09** 侧栏分组折叠（`schema/TabSidebar.vue` 125→207 行；折叠＝整组不渲染，只 emit `toggle-group`）。
  - **A-10** 侧栏宽度拖拽（`schema/SidebarResizer.vue`：pointer 事件 + `setPointerCapture`、键盘 `role=separator`、双击复位）。
  - **B-13** 分词与字数：`packages/domain/src/text/{cjk.ts,count.ts}`，`countWords`＝上游口径（U+4E00–9FFF/U+3400–4DBF + 拉丁数字词；`cjk-punct` 再加标点），实现改单次 code-unit 遍历并**穷举 BMP 65536 个 code unit 与上游正则逐值对照**。
- **`d1b9c82`**（28 文件，+8448/-1167）：
  - **C-01** 使用指南 `panels/guide.vue`(692) + 39 例；**C-02** 关于页 `panels/about.vue`(794) + 70 例；**C-08** 手绘格子地图 `panels/geography-map.vue`(1001) + 74 例；**A-13** 编辑器状态栏 `features/editor-status-bar.vue`(473) + 68 例。
  - **A-15** 全局快捷键：`features/hotkeys.ts` + window 级 Ctrl/Cmd+S（先判 `defaultPrevented` 让路给编辑器）、Ctrl/Cmd+K 明确回执。
  - Lead 接线：`AppSettingsView` 增 `pageWide`/`typewriter`；字号档 7→10；footer 改两层；删掉被取代的两个死文件。

---

## 验收门禁（当前）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓测试 | `npx vitest run` | **192 files / 4110 tests passed** |
| 类型（源码） | `npm run typecheck` | 0 error |
| 类型（测试） | `npx tsc --noEmit -p tsconfig.tests.json` | 0 error |
| 渲染层构建 | `npm run build:renderer -w @yfe/desktop` | 229 modules（css 147.10 kB / js 952.01 kB） |
| 真窗口验收 | `npm run gui-check -w @yfe/desktop` | 16/16、`failedCount: 0` |
| Lint | `npm run lint` | 见 CI/本地 |

单机预览版可直接启动：`npm run dev:desktop`（Electron 真窗口）或 `npm run dev:server`（后端）。

---

## 已知欠账（摘要，逐条见 `docs/项目台账.md` 与 `docs/剩余还原工作量清单.md`）

- **还原进度**：还原清单 72 项中已完成 10 项、进行中 5 项（W10 四路 + E-05）。
- **未接线（如实渲染，不假装）**：`about` 的更新检查/旧版探测/诊断/打赏图（R-95）；状态栏「铺满/打字机」的实际效果与「今日码字」（R-96）；`panel:ai-config` 之外的 AI 用途路由与流式（E-05）。
- **数据依赖未做**：按日统计数据（码字日历/今日码字，E-03）、知识库语义索引（E-04）、快照与回收站表（E-06）。
- **架构性缺口**：`packages/tavern/src/index.ts` 缺失而 `exports["."]` 指向它（R-86）；酒馆 6 个模块约 3300 行暂无测试（R-87）；备份集不含附件二进制（R-28/R-46）；维护模式是声明式的（R-45）。
- **环境**：本机 `git` 的 schannel TLS 后端不可用，推送/拉取需 `-c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7890`；npm 需 `npm_config_cache=.npm-cache`；Electron GUI 崩溃的根因是仓库根目录 ACL 降级（已用运行时内容哈希缓存修复）。

---

*本文档由重构工程的 Lead 维护；改动请先读 `docs/项目台账.md` 的并发纪律与写冻结规则。*