# 青春幻想引擎 · 预览版

> 小说创作管理应用的重构工程。原版仓库：[tgxy2026/youth-fantasy-engine](https://github.com/tgxy2026/youth-fantasy-engine)
>
> **本仓库是重构开发仓库**，从零按设计基线重写。原版（React 18 + Electron + IndexedDB）继续可用，新版独立入口与数据位置。

当前分支：`release/alpha-0.1.0` · 版本：`4.0.0-dev.0`

---

## 这是什么

《青春幻想引擎》是一个面向网文作者的**本地优先**创作管理应用：世界观设定、人物关系、大纲、正文编辑、AI 辅助（酒馆/角色推演）、快照与回收站、导入导出、以及 NAS 同步。

原版是 Windows 桌面单体应用（122,414 行 TypeScript / 496 个源文件）。本仓库按重构设计基线重写为 **核心 + 多端** 架构。

### 与原版的关系

| | 原版 | 重构版 |
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

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript 5.9（strict） | `noUncheckedIndexedAccess` 开启 |
| 桌面 | Electron 44 + Vue 3.5 | utilityProcess 跑 DB，主线程不承担耗时工作 |
| 后端 | Fastify 5 + Node 24 | 模块化单体，不拆微服务 |
| 存储 | SQLite（better-sqlite3 13） | WAL；单实例单 writer |
| 插件 | Cordis | 固定来源 + 自有 SDK + 适配层 |
| 编辑 | CodeMirror 6 | 中文输入法、大文档、协作友好 |
| 测试 | Vitest 4 | 按包分 project，逻辑测试不依赖 GUI |

---

## 仓库结构

```
packages/
  contracts/            跨端契约：ID、错误码、实体、命令、同步协议（唯一出口，冻结后走 ADR）
  domain/               纯领域逻辑：无 IO、无框架依赖
  persistence-sqlite/   SQLite Schema、迁移、事务用例（SaveDraft 等）
  application/          应用服务：串联领域与持久化，供 IPC 与 HTTP 共用
  plugin-sdk/           插件开发接口
  plugin-host/          Cordis 适配层与生命周期
  legacy-import/        旧版数据只读导入与差异报告
  plugins/              内置插件（主题、字数…）
services/
  server/               后端：身份、权限、同步、附件、任务
apps/
  desktop/              Electron 桌面端（main / preload / renderer）
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
| P0-2 | 契约包（ID / 错误码 / 版本协商） | 🔄 进行中 |
| P0-3 | 旧功能迁移矩阵（496 文件盘点） | ⬜ 待开始 |
| P0-4 | Cordis 生命周期验证 | ⬜ 待开始（P0 阻断项） |
| P0-5 | Electron utilityProcess + DB worker 最小链路 | ⬜ 待开始 |
| P1-A | SQLite Schema、SaveDraft 事务、恢复、导出 | ⬜ |
| P1-B | Vue 工作区、CodeMirror 编辑器、内置插件 | ⬜ |
| P3-A | 身份/设备/权限、Fastify 路由、附件 | ⬜ |
| P3-B | 同步协议、远程命令、镜像与部署 | ⬜ |

详见 [`docs/开发计划.md`](docs/开发计划.md)。

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

# 全量测试（同一时刻只允许一人运行，见并发纪律）
npm test

# 包级测试（并行开发时使用）
npx vitest run --project contracts
```

### 并发开发纪律

本项目采用多智能体并行开发，为避免互相覆盖：

- **一人一目录**：每个任务登记独占写入范围，范围不重叠。
- **共享文件独占制**：根配置与 `packages/contracts/**` 只由 Lead 写入。
- **全量测试令牌制**：同一时刻只有一人可跑全量测试。
- **契约冻结**：契约变更走 ADR + 全量回归。

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

## 许可证

沿用原版仓库的许可条款。原版代码与文档版权归原作者所有；本仓库为重构实现。
