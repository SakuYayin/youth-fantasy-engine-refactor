# 青春幻想引擎 · 预览版

> 小说创作管理应用的重构工程。原版仓库：[tgxy2026/youth-fantasy-engine](https://github.com/tgxy2026/youth-fantasy-engine)
>
> **本仓库是预览版开发仓库**，从零按设计基线重写，**以兼容移动端为目标**。原版（React 18 + Electron + IndexedDB）继续可用，新版独立入口与数据位置。

当前分支：`release/alpha-0.1.0` · 版本：`4.0.0-dev.0`

---

## 这是什么

开发交接入口：[全仓修复与 Electron 验收流转文档](F:/youth-fantasy-engine-new/docs/流转文档-全仓修复与Electron验收-2026-10-15.md)。

《青春幻想引擎》是一个面向网文作者的**本地优先**创作管理应用：世界观设定、人物关系、大纲、正文编辑、AI 辅助（酒馆/角色推演）、快照与回收站、导入导出、以及 NAS 同步。

原版是 Windows 桌面单体应用（122,414 行 TypeScript / 496 个源文件）。本仓库按重构设计基线重写为 **核心 + 多端** 架构。

### 与原版的关系

| | 原版 | 本预览版 |
| --- | --- | --- |
| 仓库 | [tgxy2026/youth-fantasy-engine](https://github.com/tgxy2026/youth-fantasy-engine) | 本仓库 |
| 前端 | React 18 | **Vue 3** |
| 存储 | IndexedDB | **SQLite**（better-sqlite3，WAL） |
| 运行形态 | 单体 Electron | **核心 + 桌面 + 后端 + 移动端** |
| 编辑 | 自研编辑器 | CodeMirror 6 |
| 插件 | 无 | **Cordis 插件内核** |
| 同步 | 私有网盘目录 | **后端同步协议**（批次/游标/冲突） |

原版功能**全部保留**为目标，按迁移矩阵分批落地；新版未支持的数据保留旧版入口，不自行宣布功能等价。

---

## 技术选型

**端与运行时**

| 端 | 选型 | 说明 |
| --- | --- | --- |
| 桌面 | **Electron 44** + **Vue 3.5** + Vite | DB 由独立 worker 持有（当前使用 child_process，兼容 utilityProcess 通信）；主线程不承担耗时工作 |
| 后端 | **Node.js 24 LTS** + **Fastify 5** + OpenAPI/JSON Schema | 模块化单体，一个服务含 API + Web 管理端 + SQLite + 内部队列；不拆微服务、不要求 Redis |
| **移动端** | **uni-app x**（原生渲染，蒸汽模式）+ UTS | **仅 Android 首发，不做 iOS**；与桌面共用同一套 `@yfe/contracts` 与后端 API |

**核心与数据**

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | **TypeScript 5.9（strict）** | `noUncheckedIndexedAccess` / `verbatimModuleSyntax` 开启 |
| 业务核心 | 可移植 TypeScript 应用服务 | 桌面与后端**共用同一份业务规则**，不各写一套 |
| 桌面/后端存储 | **SQLite + better-sqlite3 13** | WAL；数据库执行器独占写连接，业务版本与正文同事务 |
| **移动端存储** | **Android SQLite / Room**（UTS/Kotlin 封装） | 🔴 手机**不加载 better-sqlite3**；单实例 SQLite 不允许启动多个独立 writer |
| 插件 | **Cordis** + 自有 SDK/权限层 | 固定来源、生命周期 API 经适配层隔离，**不向第三方暴露 Cordis 类型** |
| 编辑 | 桌面 **CodeMirror 6** + 自有 Editor Adapter；移动端原生编辑控件 | 正文以纯文本为兼容基础；桌面 Vue 组件与 CodeMirror **不直接运行在手机原生控件中** |
| 测试 | **Vitest 4**（按包分 project）+ Playwright + Android 真机 | 逻辑测试不依赖 GUI；保存/同步/迁移/权限/恢复必须有行为测试 |
| 分发 | 桌面分平台安装包；后端官方镜像 + Compose（linux/amd64、linux/arm64） | 首版桌面**离线可用**，无需 Node/Docker/数据库 |

---

## 为什么桌面端要为移动端让路

本轮只交付「重构部分 + 对应后端」，但**移动端（uni-app x）是既定目标**，架构从第一天起就必须为它留出接口。以下三条是硬约束，不是建议：

| # | 约束 | 原因 |
| --- | --- | --- |
| 1 | **业务规则不依赖任何桌面专属 API** | `packages/domain`、`packages/application`、`packages/contracts` 不得 import Electron / Node fs / better-sqlite3 / DOM。这三层必须能在手机原生运行时里跑 |
| 2 | **持久化按接口分层，驱动可替换** | 桌面用 better-sqlite3，手机用 UTS/Kotlin 的 Android SQLite 或 Room。同一套 Repository 用例、同一套迁移语义，只换驱动 |
| 3 | **同步协议与移动端共用** | 前端触发与后台同步共用 `workspaceId` / `deviceId` / `opId` / `cursor`；手机默认接入同一 HTTPS 后端，后台任务用 WorkManager 每工作区唯一任务 |

配套的移动端原生模块接口（P4 由 UTS/Kotlin 实现，**P0 先定义契约**）：

| 能力 | 接口职责 | 平台实现 |
| --- | --- | --- |
| `database` | 事务化命令、查询、迁移与恢复 | UTS/Kotlin SQLite 适配 |
| `secureStore` | 密钥、设备凭据引用、撤销清理 | Android Keystore 与受保护存储 |
| `fileAccess` | 用户选文件、导入导出、持久 URI 授权 | 系统文件选择器，不要求全盘权限 |
| `backgroundSync` | 唯一同步任务、网络约束、重试与取消 | WorkManager |
| `editor` | 基础输入、选区、撤销与组合态 | 内置原生编辑控件，必要时封装 `EditText` |

> 移动端页面范围：作品（绑定工作区、章节概要、下载选择）、基础编辑（正文/选区/撤销/字数/冲突提示）、配置、任务、同步（配对/待上传/诊断）、设备控制。**桌面端的复杂资料编排与插件开发不移植到手机。**

---

## 仓库结构

```
packages/
  contracts/            跨端契约：ID、错误码、实体、命令、同步协议（唯一出口，冻结后走 ADR）
  domain/               纯领域逻辑：无 IO、无框架依赖（桌面/后端/移动端共用）
  persistence-sqlite/   SQLite Schema、迁移、事务用例（SaveDraft 等）
  application/          应用服务：串联领域与持久化，供 IPC / HTTP / 移动端共用
  plugin-sdk/           插件开发接口
  plugin-host/          Cordis 适配层与生命周期
  legacy-import/        旧版数据只读导入与差异报告
  plugins/              内置插件（主题、字数…）
services/
  server/               后端：身份、权限、同步、附件、任务
apps/
  desktop/              Electron 桌面端（main / preload / renderer）
  mobile/               uni-app x 移动端（P4；接口契约 P0 先定）
deploy/                 镜像与 Compose
docs/                   开发计划、ADR、迁移矩阵
重构相关文档/            设计基线（13 份设计文档）
```

---

## 开发进度

路线：**P0 → P1 → P3**（本轮范围：重构部分 + 对应后端；移动端 P4 不在本轮）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0-1 | 工程骨架与工具链 | ✅ 完成 |
| P0-2 | 契约包（ID / 错误码 / 版本协商） | ✅ 已实现并回归 |
| P0-3 | 旧功能迁移矩阵（496 文件盘点） | 🔄 矩阵已建立，完整等价验收待完成 |
| P0-4 | Cordis 生命周期验证 | ✅ 已验证并补齐清理隔离回归 |
| P0-5 | DB worker 最小链路 | ✅ 默认沙箱真窗口、中文目录、编辑保存及重启恢复通过 |
| P1-A | SQLite Schema、SaveDraft 事务、恢复、导出 | ✅ 核心能力已有行为测试 |
| P1-B | Vue 工作区、CodeMirror 编辑器、内置插件 | 🔄 工作区/编辑器已实现；插件接线与真窗口验收待完成 |
| P3-A | 身份/设备/权限、Fastify 路由、附件 | 🔄 主要 API 已实现；设备凭据到同步链路尚未贯通 |
| P3-B | 同步协议、远程命令、镜像与部署 | 🔄 服务端协议/命令已有测试；镜像实际构建待验证 |

详见 [`docs/开发计划.md`](docs/开发计划.md)。

2026-10-15 全仓审查及 Electron 修复：**94 个测试文件 / 1485 条测试通过**，Lint、源码/模板/测试类型检查与生产构建通过。默认沙箱下真实窗口编辑、保存、中文路径和重启恢复通过，见 [`docs/Electron启动与正文保存验收-2026-10-15.md`](docs/Electron启动与正文保存验收-2026-10-15.md)。完整审查及阶段性边界见 [`docs/整体项目检查报告-2026-10-15.md`](docs/整体项目检查报告-2026-10-15.md)。

2026-10-16 暂停归档快照：**192 个测试文件 / 4110 条测试通过**，源码/模板/测试类型检查 0 error，渲染层生产构建 229 modules，Electron 真窗口自检 16/16。旧版功能还原共 72 个工作项，已完成 10、进行中 5；完整进度与后续顺序见 [`docs/进度汇总-2026-10-16.md`](docs/进度汇总-2026-10-16.md)。

---

## 关键设计约束

来自设计基线，实现时不得违反：

1. **revision 是不透明字符串**——禁止比较大小、禁止算术、禁止用时间戳判定冲突胜者。
2. **游标是不透明字符串**——可能超出 JS 安全整数，禁止转 number。
3. **乐观锁写入**——`UPDATE ... WHERE id=? AND revision=?`，`changes !== 1` 即为冲突。
4. **生成不直接覆盖正文**——AI 建议稿需用户采用，采用时重新校验 `expectedRevision`。
5. **不每 Token 写事务**——输出按检查点分批持久化。
6. **单实例 SQLite 单 writer**——禁止启动多个独立写副本。
7. **日志与错误不携带正文与凭据**——错误以稳定 `code` 跨边界，异常文本不外泄。
8. **库比程序新则拒绝写入**（`STORAGE_SCHEMA_TOO_NEW`），绝不静默降级。

---

## 快速开始

```bash
# 环境要求：Node >= 24
npm install

# 类型检查
npm run typecheck

# 完整门禁（先按下文纪律持有测试锁）
node tools/test-lock.mjs acquire lead
npm run verify:new
node tools/test-lock.mjs release lead

# 全量测试（同一时刻只允许一人运行，见并发纪律）
npm test

# 包级测试（并行开发时使用）
npx vitest run --project contracts
```

---

## 已验证的技术前提

**SQLite 原生模块可用性（P0 阻断项，已解除）**

在 Electron 44.6 内嵌 Node（`ELECTRON_RUN_AS_NODE`，与 `utilityProcess` 同 ABI）中实测：

| 项 | 结果 |
| --- | --- |
| 驱动加载 | ✅ better-sqlite3 13.0.3，ABI 149（N-API prebuild，无需 C++ 工具链） |
| SQLite 版本 / WAL | ✅ 3.53.4 / WAL 生效 |
| 中文与 emoji 往返 | ✅ 无损 |
| 乐观锁 CAS | ✅ 命中 `changes=1`，过期写 `changes=0` |
| 中文路径 | ✅ 正常 |

详见 [`docs/adr/0001-sqlite-native-driver.md`](docs/adr/0001-sqlite-native-driver.md)。

---

## 更新记录

- 提交级更新记录：[`CHANGELOG.md`](CHANGELOG.md)
- 阶段进度快照与还原路线图：[`docs/进度汇总-2026-10-16.md`](docs/进度汇总-2026-10-16.md)
- 风险与决策台账：[`docs/项目台账.md`](docs/项目台账.md)

---

## 许可证

沿用原版仓库的许可条款。原版代码与文档版权归原作者所有；本仓库为重构实现。
