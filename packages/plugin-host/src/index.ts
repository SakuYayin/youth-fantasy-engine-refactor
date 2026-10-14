/**
 * `@yfe/plugin-host` —— 插件宿主索引。
 *
 * 负责人：T4（`docs/项目台账.md` 任务 P0-4，**P0 阻断项**）
 *
 * ## 分层（唯一允许的依赖方向）
 * ```
 * 上层（application / apps / services）
 *   └── @yfe/plugin-host        ← 本文件：产品语义 API，不暴露任何 upstream 类型
 *         └── src/host/**       ← 生命周期、依赖图、能力、数据、任务、清理
 *               └── src/adapter/cordis.ts ← 🔴 全仓唯一 import 'cordis' 的地方
 * ```
 *
 * 🔴 **绝不在本文件的公开签名里出现 Cordis 类型**：上层一旦拿到 `Context`/`Fiber`，
 * 适配层就形同虚设，上游改 API 会直接穿透到整个产品（ADR 0002 决策 2）。
 *
 * 🔴 安全边界（ADR 008）：「**不能将 Node vm、进程、Worker 当作自动沙箱**；签名也不代表
 * 安全认证」。因此本版本只加载**可信内置插件**（`kind === 'trusted-builtin'` 且在发行清单
 * `trustedPluginIds` 中）；能力声明与 `PERMISSION_PLUGIN_CAPABILITY` 只用于**防误用与降级拒写**，
 * 不构成隔离或恶意代码防护。
 */

export { PluginHost, defineCandidate, DEFAULT_CLEANUP_TIMEOUT_MS } from './host/index.js'
export type {
  DisableReport,
  LoadReport,
  PluginCandidate,
  PluginHostOptions,
  PluginState,
  PluginStatus,
  ResourceSnapshot,
} from './host/index.js'

export { resolveLoadOrder, dependentsOf } from './host/dependency-graph.js'
export type { GraphFailure, GraphResolution } from './host/dependency-graph.js'

export { EffectsScopeImpl, HostContributionTable, HostDataStore, TaskScopeImpl } from './host/plugin-context.js'
export type { PluginContextDeps, PluginRuntime, ServiceTable } from './host/plugin-context.js'

export {
  activationFailedPayload,
  dependencyCyclePayload,
  dependencyMissingPayload,
  dependencyVersionPayload,
  disabledPayload,
  hostApiIncompatiblePayload,
  makePayload,
  manifestInvalidPayload,
  notFoundPayload,
  notTrustedPayload,
  serviceNotFoundPayload,
  throwPayload,
} from './host/errors.js'

/**
 * 上游语义探测结果的能力声明。
 *
 * 🔴 刻意返回 `false`：实测 Cordis 4.0.0-rc.11 的 `isolate` **只隔离服务槽位，不隔离事件**
 * （ADR 0002 结论 1）。宿主因此**不**把插件接到共享事件总线上，事件一律由宿主显式路由。
 * 这个函数存在的意义是让调用方**查询**而不是**假设**——上游一旦修复，这里才可能变 true。
 */
export { cordisEventIsolationSupported } from './adapter/cordis.js'
