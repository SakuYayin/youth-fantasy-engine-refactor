# 流转文档：Electron 启动阻塞与项目当前进度

> 接手请先读 [全仓修复与 Electron 验收流转文档](F:/youth-fantasy-engine-new/docs/流转文档-全仓修复与Electron验收-2026-10-15.md)，其中汇总本轮累计修改、根因、验收、复现命令与后续任务。本文继续作为历史快照保留。

> **最新状态：Electron 阻塞已解决。** 默认沙箱、中文路径、真实窗口编辑保存与整个应用重启读回通过。根因与复现命令见 [最终验收](Electron启动与正文保存验收-2026-10-15.md)。下面是修复前历史快照。

> 后续更新：2026-10-15 本轮已完成全仓审查与修复，当前结果见 [整体项目检查报告](整体项目检查报告-2026-10-15.md)。以下保留为上一轮的历史快照，版本、测试数和实验退出状态应按报告中的新观测区分。

> 口径说明：本文只写**已执行的操作**、**原始观测结果**与**已核对的事实**。凡未验证因果的内容一律放在「§6 尚未判定的边界」，并明确标注为未验证。本文不含推测性结论。
> 生成时间：2026-10-15 15:20（Asia/Shanghai）｜当前 HEAD：`ff4473a`（工作区另有 5 项未提交改动，见 §4）

---

## 1. 任务范围（用户指令原文）

| 编号 | 用户指令（原文） | 状态 |
| --- | --- | --- |
| m00001 | 「…下载项目，并了解项目，阅读重构项目，规划好开发计划，使用智能体团队，子智能体等多线程开发，管理好开发计划，禁止出现同时编辑一个文件，同时运行一个测试等等，做好项目管理台账，目前先只需要做重构的部分和对应的后端，开始干活」 | 执行中 |
| m00127 | 思考必须中文输出；**每做一件事之前都要先告知用户** | 执行中（本轮因英文开头被纠正 2 次） |
| m00632 | 「先等下，我这个预览版的目的是为了兼容移动端，也要把移动端相关技术栈选型贴上去」 | 已交付 `docs/移动端技术栈选型.md` |
| m03403 | 「继续开发下一批，暂不推送」 | 已执行（本地领先 origin 18 提交，未推送） |
| m04734 | 「1 开工」「2 按照契约来」＝ 渲染层 P1-B1 开工；移动端按既定契约（uni-app x 蒸汽模式 + `MobileDatabase`） | 渲染层已开工 |
| m05344 | 「我要验证，帮我搞定Electron」 | **被本机环境阻塞，见 §5** |

---

## 2. 仓库与环境事实

| 项 | 观测值 |
| --- | --- |
| 工作目录 | `F:\youth-fantasy-engine-new` |
| 仓库 | `https://github.com/SakuYayin/youth-fantasy-engine-refactor` |
| 分支 | `release/alpha-0.1.0`（`git branch -vv`：`[origin/release/alpha-0.1.0: ahead 18]`） |
| HEAD | `ff4473a feat(desktop): 渲染层外壳与编辑器（Vue 3.5 + CodeMirror 6）…` |
| Node / npm | v24.19.0 / 11.17.0 |
| npm 缓存 | 必须设 `$env:npm_config_cache=F:\youth-fantasy-engine-new\.npm-cache`（默认目录 EPERM） |
| 网络 | git/curl 的 schannel TLS 失败（`SEC_E_NO_CREDENTIALS 0x8009030e`）且配置的 7890 代理不可达；**Node 的 fetch 正常**，所有下载均走 `node`+`fetch` |
| 操作系统 | `Microsoft Windows 11 专业版 Insider Preview`，Version `10.0.29639`，BuildNumber `29639`，64 位 |

---

## 3. 已完成交付（截至 `ff4473a`）

### 3.1 全仓门禁（2026-10-15 15:17 于当前工作区复核，已持测试锁 `lead-doc`）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | **87 files / 1409 tests passed**，exit 0，25.96s |
| `npm run typecheck` | exit 0 |
| `npx tsc --noEmit -p tsconfig.tests.json` | exit 0 |
| `npx tsc --noEmit -p apps/desktop/tsconfig.json` | exit 0 |

### 3.2 模块清单

| 层 | 内容 |
| --- | --- |
| `packages/contracts` | 契约单一事实源（错误码闭集/严重度、`Result`、ID 品牌类型、commands/entities/sync/jobs/mobile 类型、版本常量 `4.0.0-dev.0`、`checkSchemaCompat`） |
| `packages/domain` | 文本字素簇计数 `countChars`、`orderKeyBetween`/`spreadOrderKeys`、三路合并 `resolveConflict`（含单测） |
| `packages/persistence-sqlite` | 17 张本地表 DDL + 迁移器 + `saveDraft`（事务/幂等/乐观锁）+ repositories + **导出/恢复**（`VACUUM INTO` 快照、清单、校验、原子恢复） |
| `packages/application` | 端口定义 + 用例（`saveDraft`/`createProject`/`createDocument`/`getDocument`/`listDocumentTree`/`systemStatus`），幂等重放不产生分叉 ID |
| `packages/plugin-sdk` / `plugin-host` | 插件契约与宿主（Cordis 适配，`docs/adr/0002-cordis-lifecycle.md`） |
| `packages/legacy-import` | 旧数据只读导入 + 报告 + 7 个真实读取器（`./readers` 子路径导出） |
| `packages/client-sdk` | `createClient(transport)`、六方法白名单与 `apps/desktop` 逐字一致、超时覆盖 `transport.call` 本身、失败载荷剥 `cause` |
| `packages/ui` | 6 个 Vue 组件 + 设计令牌（深色默认） |
| `apps/desktop` | `main.mjs`（含 `--self-check`、`--gui-check`）、`preload.cjs`（sandbox 下必须是 CJS）、`db-worker.mjs`、`service-host.mjs`、`application-adapter.mjs`、渲染层 `src/renderer/**`（Vue 3.5 + CodeMirror 6 + `state/draft-session.ts`） |
| `services/server` | Fastify 5：身份/会话/配对/权限、工作区/同步批次原子提交、附件上传与资产、任务队列与 SSE 事件流、设备令牌与远程命令、管理面（系统管理员/成员）、运维面（存储探针/备份/校验/恢复）；服务端 schema 迁移 1→3（20 张表） |
| 部署 | `docs/adr/0005-backend-runtime-and-deployment.md`、`deploy/Dockerfile`、`deploy/compose.yaml` |
| 台账 | `docs/项目台账.md`（§1 成员 / §2 任务 / §3 测试令牌 / §4 风险 R-1…R-53 / §5 变更记录） |
| 迁移矩阵 | `docs/旧功能迁移矩阵.md`（26 功能域 + 附录 A/B/C） |

### 3.3 渲染层构建事实

| 项 | 观测值 |
| --- | --- |
| `npx vite build --config apps/desktop/vite.config.ts` | exit 0，68 模块，`dist/renderer/index.html` 1.18 kB、`assets/index.css` 8.43 kB、`assets/index.js` 382.83 kB（gzip 130.89） |
| `apps/desktop` 测试 | 8 files / 73 tests passed |
| 生产 HTML 资源标签 | `<script type="module" src="./assets/index.js">`、`<link rel="stylesheet" href="./assets/index.css">`（**无 `crossorigin`**，由 `stripCrossorigin` 插件保证，`tests/renderer-build.test.ts` 钉住） |
| 生产 CSP | 仍为 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'`（未放宽） |

---

## 4. 当前未提交改动（`git status --short`，共 5 项）

```
 M apps/desktop/package.json
 M apps/desktop/src/main/main.mjs
 M package-lock.json
 M package.json
?? apps/desktop/bin/
```

内容：Electron 启动器与 `--gui-check` 相关改动（`apps/desktop/bin/dev-desktop.mjs`、`main.mjs` 增 `--gui-check`、根/包脚本 `gui-check:desktop` 等）。这些改动**不影响**上述门禁结果（15:17 门禁即在该工作区状态下跑的）。

---

## 5. 阻塞问题：Electron 无法在本机启动（m05344）

### 5.1 现象（原始观测）

- 任何 Electron 应用（包括**不调用任何 Electron API**、只留一个定时器的应用）都会在进程启动后约 1–2.5 秒内死亡。
- `app.whenReady()` **从未 resolve**（自检日志停在第一行，永远没有 "app ready"）。
- 进程退出码只有两种，与是否传 `--no-sandbox` 强相关：

| 启动方式 | 退出码（十进制） | 退出码（十六进制） | `app.whenReady()` |
| --- | --- | --- | --- |
| 默认（沙箱开启） | `-2147483645` | `0x80000003` STATUS_BREAKPOINT | 未到达 |
| `--no-sandbox` | `-1073741819` | `0xC0000005` STATUS_ACCESS_VIOLATION | 未到达 |

- 只打印版本号后 `app.quit()` 的应用：JS 日志正常写出 `exit 0`，但**进程最终退出码仍为 `0xC0000005`**。
- `--enable-logging=stderr --log-level=0` 输出的 `chromium.log` **为 0 行**（Chromium 自身日志未及初始化）。

### 5.2 复现方式

最小宿主（`_scratch/electron-bisect/main4.cjs`，全部代码见该文件）：

```js
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
});
```

```powershell
& "F:\youth-fantasy-engine-new\node_modules\electron\dist\electron.exe" `
  "F:\youth-fantasy-engine-new\_scratch\electron-bisect" --no-sandbox
# 观测：exit=-1073741819，日志只有第一行，无 "app ready"
```

### 5.3 版本矩阵（**全部失败**）

| electron.exe 版本 | 来源 | 默认 | `--no-sandbox` |
| --- | --- | --- | --- |
| 38.8.6 | npm dist-tag `38-x-y`（官方 zip 136,432,758 B） | `0x80000003` | `0xC0000005` |
| 41.10.7 | npm dist-tag `41-x-y`（142,914,787 B） | `0x80000003` | `0xC0000005` |
| 43.7.11 | npm dist-tag `43-x-y`（151,150,012 B） | `0x80000003` | `0xC0000005` |
| 44.7.2 | npm `latest` | `0x80000003` | `0xC0000005` |
| 45.0.0-beta.3 | npm `beta`（158,166,888 B） | `0x80000003` | `0xC0000005` |

### 5.4 开关矩阵（**全部失败**，均为 `0xC0000005`、无 "app ready"）

`--disable-gpu`、`--in-process-gpu`、`--headless`、`--use-angle=swiftshader`、`--disable-gpu-compositing`、`--disable-software-rasterizer`、`--js-flags=--jitless`、`--js-flags=--no-turbofan`、`--disable-crash-reporter`、`--no-crashpad`、`--disable-dev-shm-usage`、`--no-zygote`、`--single-process`、`--disable-features=ThirdPartyModulesBlocking`、`--disable-features=RendererCodeIntegrity`、`--disable-features=RendererAppContainer`、`--disable-features=Win32kLockdown`、`--allow-third-party-modules`、`--disable-gpu-sandbox`、`--enable-logging=stderr --log-level=0`

### 5.5 已执行的其它验证（结果均为「同样崩溃」）

| 验证项 | 做法 | 结果 |
| --- | --- | --- |
| 窗口沙箱开关是否相关 | `webPreferences.sandbox` 取 `true` / `false` | 两者退出码与日志完全一致 |
| 是否与 Electron API 调用有关 | 应用**完全不 require('electron')**，仅 `setInterval` | 同样崩溃 |
| 是否与窗口创建有关 | `main3.cjs` 只 `whenReady` 不建窗口 | 同样崩溃 |
| 是否与单实例锁/路径 API 有关 | 分别在 `requestSingleInstanceLock()`、`getPath('userData')` 打点 | 均在打点后立即死亡 |
| 是否与 V8 优化编译有关（upstream #52042 的建议） | `--js-flags=--no-turbofan` / `--jitless` | 无效 |
| 是否与第三方模块注入/代码完整性有关 | 见 §5.4 四个 `--disable-features` | 无效 |
| 兼容模式是否改变行为 | HKCU AppCompatFlags 依次设 `~ WIN8RTM`、`~ WIN7RTM`、`~ WIN8RTM HIGHDPIAWARE` | 六次运行结果与未设时完全一致；注册表项已清理 |

### 5.6 WER 原始记录（连续三次完全一致）

`Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001}`：

```
出错应用程序名称： electron.exe，版本： 44.7.2.0，时间戳： 0x6aceaf18
出错模块名称：     electron.exe，版本： 44.7.2.0，时间戳： 0x6aceaf18
异常代码：         0xc0000005
错误偏移：         0x0000000007c679bb
```

事件 ID 1000 出现于 15:14:08 / 15:14:10 / 15:14:12（三次偏移量相同）；配套事件 ID 1001 `APPCRASH`，故障存储段 `1520213560340159474`。

### 5.7 上游已公开的同类记录（通过 GitHub API 读取，非推测）

| Issue | 状态 | 与本案相关的原文要点 |
| --- | --- | --- |
| [electron#54614](https://github.com/electron/electron/issues/54614) | **open**（2026-10-14 有更新） | Windows 11 26H2（26300.9550）上 Electron 44.4.1 以 STATUS_BREAKPOINT 崩溃；栈指向 V8 `OptimizingCompileTaskExecutor`、renderer 启动失败、约 1 秒即退出；被标注 `blocked/need-repro`。有评论报告在 26200.9457 上「相同退出码、约 1 秒、进程启动极早期断点」，且 VBS/内存完整性开启、WER 无记录 |
| [electron#52042](https://github.com/electron/electron/issues/52042) | closed / not planned | Windows 11 Insider 26200 + Electron 42.4.1，ACCESS_VIOLATION 落在 `v8::internal::compiler::CompilationDependencies::TransitionDependencyOffTheRecord`；建议绕过 `--js-flags="--no-turbofan"`（**本机实测无效**） |
| [electron#54838](https://github.com/electron/electron/issues/54838) | closed / needs-template | `app.enableSandbox()` 与 `--no-sandbox` 同时生效时，创建第一个 BrowserWindow 后主进程以 `0xC0000005` 死亡（Windows 10.0.26200，Electron 44.7.0）；原文明确「不调用 `app.enableSandbox()` 时 `--no-sandbox` 正常」。**本案不同**：我们不调用 `app.enableSandbox()`，且窗口 `sandbox` 取 `true`/`false` 结果一致、崩溃发生在 `whenReady` 之前 |

### 5.8 本机环境已观测到的事实（**未做因果判定**）

| 观测项 | 值 |
| --- | --- |
| 火绒安全软件 | 版本 `6.0.0.0`；进程 `HipsDaemon`(PID 2708)、`HipsTray`(20260) 运行；驱动 `hrdevmon.sys`、`hrwfpdrv.sys` 状态 Running；服务 `HRWSCCtrl`（Huorong Windows Security Center）Running |
| VBS / 内存完整性 | `SecurityServicesRunning = 2`、`VirtualizationBasedSecurityStatus = 2`、`CodeIntegrityPolicyEnforcementStatus = 2` |
| Windows Defender | `Get-MpPreference` 返回错误 `0x800106ba`（查询失败） |
| 全局注入（AppInit_DLLs） | 两个注册表视图下均为空字符串，`LoadAppInit_DLLs = 0` |
| IFEO | `…\Image File Execution Options` 下**无** `electron.exe` 项（共 54 个子项） |
| 模块注入 | `node.exe`、`QQ.exe`、`msedge.exe` 进程内未枚举到火绒目录下的模块 |
| 其它 Chromium 应用 | `msedge` 进程正常运行 |
| 火绒日志 | 在其安装目录与 `C:\ProgramData\Huorong` 下检索 `electron` 字样：**无命中** |

---

## 6. 尚未判定的边界（明确标注：未验证）

1. 崩溃的**因果来源**未确定。已排除的是「Electron 版本差异」「窗口沙箱开关」「Chromium 第三方模块/代码完整性开关」「GPU/合成相关开关」「V8 优化编译（含 upstream 建议的 `--no-turbofan`）」「AppCompat 兼容模式」这些因素；**未排除也未证实**的宿主侧因素包括：操作系统 Insider 构建 29639 本身、VBS/内存完整性、火绒 6.0 的内核驱动与 HIPS、以及它们的任意组合。
2. 上述每一条宿主侧动作（信任/退出火绒、关闭内存完整性、退出 Insider 通道、换机器）**都没有在本会话内执行**，因此其效果无观测数据。
3. 上游 #54614 仍为 open 且 `blocked/need-repro`，没有已发布的修复版本；本机在 38–45-beta 全版本线失败，与「等某个 Electron 版本修好」不相容。

---

## 7. 现场文件索引（可复现）

| 路径 | 内容 |
| --- | --- |
| `_scratch/electron-bisect/main.cjs` / `main2.cjs` / `main3.cjs` / `main4.cjs` / `main6.cjs` | 逐级最小宿主：单实例锁打点 / `getPath` 打点 / 仅 `whenReady` / `whenReady`+窗口（沙箱可切） / **完全不碰 Electron API** |
| `_scratch/electron-bisect/matrix.ps1` | §5.4 中 9 项启动开关的批量跑批脚本 |
| `_scratch/electron-bisect/flags2.ps1` | 第三方模块/代码完整性/AppContainer/Win32kLockdown 开关 + 火绒证据采集 |
| `_scratch/electron-bisect/versions.ps1` / `versions45.ps1` | 38/41/43 与 45-beta 的解压与跑批 |
| `_scratch/electron-bisect/appcompat.ps1` | AppCompat 兼容模式实验（含注册表清理） |
| `_scratch/electron-bisect/fetch-versions.mjs` / `fetch-channels.mjs` | 用 Node `fetch` 下载官方 zip（含 dist-tags 全量输出） |
| `_scratch/electron-bisect/bisect3.log` / `bisect4.log` / `bisect6.log` / `chromium.log` | 各次运行的原始日志（`chromium.log` 为 0 行） |
| `_scratch/electron-versions/*.zip`、`v38.8.6/`…`v45.0.0-beta.3/` | 五个版本线的官方二进制 |
| `apps/desktop/bin/dev-desktop.mjs`、`apps/desktop/src/main/main.mjs`（`--gui-check`） | 本次为验证准备、**尚未提交**的启动器与自检入口 |

---

## 8. 下一步（尚未开始的执行项）

1. 提交 §4 的 5 项未提交改动（启动器 + `--gui-check`），并把 §5 的全部证据登记为台账风险行（当前最新风险编号 R-53）。
2. 在不依赖 Electron 的前提下验证渲染层：用本机浏览器打开渲染层 dev server，经本地回环把 `window.yfe` 契约接到既有后端实现（dev 专用 CSP，生产 CSP 不放宽），并对真实渲染结果截图取证。此项**尚未实现**。
3. 若你希望继续在 Electron 上验证，需要你在宿主侧执行 §6 中列出的动作之一（我无法在本会话内执行），执行后我可以立刻重跑 `_scratch/electron-bisect/matrix.ps1` 与 `apps/desktop --gui-check` 并给出对照数据。

---

## 9. 台账与纪律索引

- 项目管理台账：`docs/项目台账.md`（§1 成员 / §2 任务 / §3 测试令牌登记 / §4 风险 R-1…R-53 / §5 变更记录）
- 并发纪律：`tools/test-lock.mjs`（`acquire <owner> [note]` / `release <owner>` / `status`；exit 2 = 他人持锁且**绝不删锁**；持锁期间为「写冻结」，`node tools/test-lock.mjs` 头部已写明）
- 架构决策记录：`docs/adr/0002-cordis-lifecycle.md`、`docs/adr/0003-preload-sandbox-cjs.md`、`docs/adr/0004-backup-restore.md`、`docs/adr/0005-backend-runtime-and-deployment.md`、`docs/adr/0006-renderer-architecture.md`
- 设计依据：`重构相关文档/02-桌面与界面.md`、`04-后端与安全.md`、`06-数据与本地存储.md`、`07-同步协议与API.md`、`09-部署与运维.md`、`11-测试验收与迁移.md`、`12-开发计划.md`
