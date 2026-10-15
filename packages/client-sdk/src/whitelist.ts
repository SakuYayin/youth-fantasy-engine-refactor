/**
 * 渲染层可调用的 IPC 方法白名单（**客户端侧副本**）。
 *
 * 权威定义：`apps/desktop/src/shared/ipc/channels.ts` 的 `IPC_METHODS`。
 *
 * 为什么这里另存一份常量而不是 import 权威表：
 * `@yfe/client-sdk` 的依赖只有 `@yfe/contracts`（ADR 0006 D2 第 6 条），
 * 反向 import `apps/desktop/**` 会把包依赖弄成环，且让渲染层 SDK 依赖 Electron 工程结构。
 * 代价是两份可能漂移，因此 `tests/whitelist.test.ts` 逐项**且按顺序**断言两份相等，
 * 并同时与 preload 的 `.cjs` 运行时副本对齐（渲染层实际要过的那道闸）。
 *
 * 与 preload 副本一样 `Object.freeze`：白名单在运行时被改写等于绕过全部守卫。
 */
export const IPC_METHODS = Object.freeze([
  'saveDraft',
  'listDocumentTree',
  'getDocument',
  'createProject',
  'createDocument',
  'systemStatus',
  'listSettingsEntities',
  'getSettingsEntity',
  'saveSettingsEntity',
  'aiComplete',
] as const)

export type IpcMethod = (typeof IPC_METHODS)[number]

const METHOD_SET: ReadonlySet<string> = new Set<string>(IPC_METHODS)

/**
 * 白名单判定：只认字符串，且必须逐字命中（大小写、空格、原型链上的名字都不算）。
 *
 * 用 `Set` 而不是 `IPC_METHODS.includes(...)`：避免 `constructor` / `toString`
 * 这类原型链名字被 `in` 之类的检查误放行。
 */
export function isIpcMethod(value: unknown): value is IpcMethod {
  return typeof value === 'string' && METHOD_SET.has(value)
}
