/**
 * `@yfe/plugin-sdk` —— 插件 SDK 索引。
 *
 * 本包是**第三方插件唯一允许依赖**的接口面。
 *
 * 🔴 硬性纪律（`05-插件内核与SDK.md` + `docs/adr/0002-cordis-lifecycle.md`）：
 * 1. **不得导出 Cordis 类型**（`Context`/`Fiber`/`FiberState`/`Service`/`CordisError`…），
 *    也不得让插件经本包间接依赖 cordis——`package.json` 的 dependencies 里没有 cordis，
 *    这是一条**可被机械验证**的边界（见 `tests/no-cordis-leak.test.ts`）。
 * 2. **不得导出宿主私有类型**：适配层的真实 fiber 句柄、isolate label、内部状态机数值
 *    一律不出现。
 * 3. 上游 API 不稳定（ADR 004），因此把生命周期语义固化在本包与 `@yfe/plugin-host`
 *    的适配层，插件作者只看到产品语义。
 *
 * 🔴 安全边界（ADR 008 原话）：**不能将 Node vm、进程、Worker 当作自动沙箱；签名也不代表
 * 安全认证**。本包提供的 `capabilities.require()` 只做「未声明即拒绝」的误用防护与降级拒写，
 * **不是安全隔离**，也无法阻止恶意插件绕过 SDK 直接调用 Node API。
 */

export * from './manifest/index.js'
export * from './context/index.js'
