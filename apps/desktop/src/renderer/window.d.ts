/**
 * preload 注入到渲染进程的桥（`apps/desktop/src/preload/preload.cjs`）。
 *
 * 只声明 `call`/`methods`/`protocolVersion` 三个字段，**刻意不声明** `ipcRenderer`、
 * `require`、`process` 之类：渲染层代码只允许通过它调用白名单方法。
 *
 * 注意 `unknown` 而不是泛型：信封校验属于 `@yfe/client-sdk` 的职责，
 * 渲染层不该也不能在这里"相信"载荷形状。
 */

export interface YfeBridge {
  readonly call: (method: string, payload: unknown) => Promise<unknown>
  readonly methods: readonly string[]
  readonly protocolVersion: number
}

declare global {
  interface Window {
    /** Electron 宿主里存在；纯浏览器/测试环境下为 undefined（必须有兜底）。 */
    readonly yfe?: YfeBridge
  }
}

export {}
