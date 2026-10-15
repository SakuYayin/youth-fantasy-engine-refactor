# ADR 0003：preload 采用 CommonJS，以保住 renderer 的 `sandbox: true`

- 状态：已采纳（2026-10-15）
- 相关：重构开发文档 `02-桌面与界面.md`（安全设置）、`04-后端与安全.md`、`docs/adr/0001-sqlite-native-driver.md`
- 决策者：Lead

> 2026-10-15 审查校正：沙箱 preload 的 `require` 同样不能加载本地 CJS 文件。现改为自包含白名单，仅 `require('electron')`；main 仍使用 CJS 副本。`preload.test.ts` 在只允许 Electron 的受限加载环境中执行真实 preload，并与 TS 白名单比对。下方原决策中“preload require 白名单副本”与“否决内联白名单”的部分已由本校正取代。依据：[Electron 沙箱文档](https://www.electronjs.org/docs/latest/tutorial/sandbox)。

## 背景

设计文档 02 要求 renderer 的安全三元组逐项写死：

```
nodeIntegration: false
contextIsolation: true
sandbox: true
```

同时重构工程决定「源码直发、不设构建步骤」（`.ts`/`.mjs` 直接运行，靠 `module.registerHooks`
把包内 `./x.js` 解析到 `./x.ts`），因此最初把 preload 写成了 ESM：`src/preload/preload.mjs`。

## 问题

Electron 对 preload 的加载方式有硬约束：**沙箱化（`sandbox: true`）的 preload 脚本不能使用 ESM**。
`.mjs` preload 只在 `sandbox: false` 下可用。也就是说：

- 保留 `preload.mjs` → 必须把 `sandbox` 放宽为 `false`；
- 保留 `sandbox: true` → preload 必须是 CommonJS。

这两个安全属性不是同一量级：`sandbox: false` 会让 renderer 拿到完整的 Node 能力面，
而 `contextIsolation: true` 只能隔离 JS 上下文，挡不住 preload 主动把危险能力挂到 `window` 上。
设计文档 02 把 `sandbox: true` 列为硬要求，不应为了「少一个后缀」而放弃它。

## 决策

1. **preload 与它的白名单副本一律用 `.cjs`（CommonJS）**，以保住 `sandbox: true` 与
   `nodeIntegration: false` / `contextIsolation: true`：
   - `apps/desktop/src/preload/preload.cjs` —— `require('electron')` + `contextBridge`
   - `apps/desktop/src/preload/ipc-methods.cjs` —— 白名单的纯 JS 副本
2. **权威白名单仍在 TypeScript 侧**：`apps/desktop/src/shared/ipc/channels.ts` 的 `IPC_METHODS`。
   `.cjs` 里只有运行时副本，一致性由 `apps/desktop/tests/ipc-methods.test.ts` 逐项（含顺序）断言。
3. **ESM 与 CJS 的边界只允许出现在这一个位置**。main 进程（`main.mjs`）通过
   `import ipcMethodsModule from '../preload/ipc-methods.cjs'` 取默认导出，其余代码保持 ESM。
4. 新增 IPC 方法的流程固定为：先改 `channels.ts` → 再同步 `ipc-methods.cjs` → 跑一致性测试。

## 后果

- ✅ renderer 安全三元组三条全部保住，`sandbox: true` 没有被降级。
- ✅ preload 体积与攻击面都很小：不 `require` 除 `electron` 与白名单副本之外的任何模块。
- ⚠️ 白名单存在两份（`.ts` 权威 + `.cjs` 运行副本）。这是**已被测试锁定**的重复，
  不是「忘了合并」；改动遗漏时测试会红。
- ⚠️ 后来者若把 `preload.cjs` 改回 `.mjs`，应用会在启动时静默失去 preload 桥
  （renderer 里 `window.yfe` 为 `undefined`）。`src/renderer/renderer.js` 首行就会报出这一点。

## 备选方案与否决理由

| 方案 | 否决理由 |
| --- | --- |
| `preload.mjs` + `sandbox: false` | 为省一个后缀放弃沙箱，攻击面显著变大；设计文档 02 明确要求 `sandbox: true`。 |
| 给 preload 加构建步骤（打成 CJS bundle） | 与「源码直发、无构建」的工程基线冲突，且为单个文件引入构建链不划算。 |
| preload 内联白名单、不共享副本 | 失去单一定义点，两处字符串会静默漂移；现有方案有测试锁定。 |
