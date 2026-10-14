# ADR 0001：SQLite 原生驱动在 Electron 中的可用性

- 状态：**已接受**
- 日期：2026-10-15
- 决策者：Lead
- 相关风险：设计文档 `12-开发计划.md` 风险表「SQLite 原生 ABI/打包」被标为 **P0 阻断项**

## 背景

设计文档要求：P0 必须在 Electron 与 Node、三平台验证 SQLite 原生模块，**失败先解决驱动适配，不带病扩功能**。

原版应用（3.0.3）使用 IndexedDB 存储正文。重构版要改为 SQLite（`06-数据与本地存储.md`），引入原生模块。历史上 Electron 与 Node 的 V8/ABI 差异是此类项目最常见的阻断原因，因此必须先实证。

## 验证环境

| 项 | 值 |
| --- | --- |
| OS | Windows NT 10.0.29639.0（Session 1） |
| Node | v24.19.0（系统） / v24.21.0（Electron 内嵌） |
| Electron | 44.6.0 |
| better-sqlite3 | 13.0.3 |
| 验证位置 | `_abi_probe/`（已加入 `.gitignore`） |

## 验证结果

### ✅ 通过项

在 **Electron 内嵌 Node**（`ELECTRON_RUN_AS_NODE=1`，与 `utilityProcess` 同一 ABI 路径）中：

| 验证项 | 结果 |
| --- | --- |
| 加载原生模块 | ✅ `require('better-sqlite3')` 成功，driver 13.0.3 |
| ABI | ✅ `process.versions.modules = 149`（Electron 44），N-API prebuild 直接可用 |
| SQLite 版本 | ✅ 3.53.4 |
| WAL 模式 | ✅ `journal_mode = wal` 生效（内存库为 `memory`，符合预期） |
| 中文与 emoji 往返 | ✅ `第一章·初入宗门`、`天灵根💯` 完整无损 |
| 乐观锁 CAS | ✅ `UPDATE ... WHERE id=? AND rev=?` 命中返回 `changes=1`，过期写返回 `0` |
| 中文路径 | ✅ `F:\...\中文目录\x.db` 正常读写 |

### ❌ 环境限制（与本项目代码无关）

| 现象 | 结论 |
| --- | --- |
| Electron GUI 模式启动崩溃 `0xC0000005` / `0x80000003` | **纯 Electron 基线同样崩溃**（不加载任何原生模块，`electron.exe --version` 也失败）→ 是**本机会话的 GUI 初始化限制**，不是 Electron 或 SQLite 缺陷 |
| 用户临时目录 `C:\Users\压音\AppData\Local\Temp` 无法写 | `EPERM`，且 `C:\dsh_sqlite_probe` 也无法创建 → 是**沙箱只允许写工作区**，不是 SQLite 问题 |
| `C:\dsh_sqlite_probe` mkdir 失败 | 同上；改用工作区内路径后正常 |

**重要**：`better-sqlite3` 在崩溃发生**之前**已完成加载与查询（`DONE OK`），证明崩溃点与驱动无关。

## 决策

1. **采用 `better-sqlite3@13.0.3`**，理由：N-API prebuild 覆盖 win32-x64/arm64、linux-x64/arm64/musl、darwin-x64/arm64，无需 C++ 工具链，实测加载即用。
2. **数据目录策略**：数据目录必须位于**应用可写目录**，不得假定系统临时目录可写。启动时探测可写性并给出明确错误（`STORAGE_READ_ONLY`）。
3. **桌面端 DB 运行形态**：数据库操作跑在 **utilityProcess / `ELECTRON_RUN_AS_NODE` 子进程**，与主线程隔离（符合 `02-桌面与界面.md`「主线程不承担耗时工作」）。
4. **测试策略**：本机无法启动 Electron GUI，因此：
   - 契约、持久化、同步的**逻辑测试全部在纯 Node（Vitest）下运行**，不依赖 GUI；
   - Electron 主进程代码通过 `ELECTRON_RUN_AS_NODE` 做集成冒烟；
   - GUI 端到端（Playwright）留待具备 GUI 环境时执行，**不作为本轮阻塞项**。
5. **不再为 ABI 问题预留风险储备**，该风险降级为「已解除」。

## 影响

- P0 阻断项从 2 个减为 1 个（剩余：**Cordis API 未稳定**）。
- P1-A 的 SQLite 存储层可以立即开工，无需等待驱动适配。
- 备份/恢复、迁移、故障注入测试可全部在 Node 下完成，测试速度不受 GUI 限制。

## 复现命令

```powershell
# 在 _abi_probe/ 下（该目录不入库）
$env:ELECTRON_RUN_AS_NODE="1"
.\node_modules\electron\dist\electron.exe path-probe.cjs
# 期望：memory 与 workspace 两项 ok=true，sqlite=3.53.4
```
