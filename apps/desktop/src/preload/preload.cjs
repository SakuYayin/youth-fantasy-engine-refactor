'use strict';
/**
 * Electron preload：renderer 与 main 之间唯一的桥。
 *
 * 安全铁律（重构文档 02/04）：
 * - 只暴露 `IPC_METHODS` 白名单里的方法，**绝不暴露 `ipcRenderer` 本体**。
 * - **绝不暴露** `node:fs` / `node:path` / `process` / 任何 Node 能力。
 * - 通道名固定为 `yfe:invoke`；被调方法名走 payload，main 侧会再校验一次白名单
 *   （桥这一层拒绝是为了缩小攻击面，main 那一层拒绝才是安全边界——两层都要有）。
 *
 * 🔴 为什么是 `.cjs`：preload 在 `sandbox: true` 下运行，Electron 不允许沙箱化
 *   preload 使用 ESM。见 docs/adr/0003-preload-sandbox-cjs.md。
 */
const { contextBridge, ipcRenderer } = require('electron');
const { IPC_METHODS } = require('./ipc-methods.cjs');

const IPC_CHANNEL = 'yfe:invoke';

/**
 * 失败信封的本地构造（不依赖 @yfe/contracts：preload 不能 import TypeScript）。
 * 形状必须与 main 侧一致：`{ kind:'response', requestId, ok, method, value|error }`。
 *
 * @param {string} method
 * @param {string} code
 * @param {string} message
 * @returns {{kind: 'response', requestId: string, ok: false, method: string, error: object}}
 */
function localFailure(method, code, message) {
  return {
    kind: 'response',
    requestId: 'local',
    ok: false,
    method: String(method),
    error: {
      code,
      message,
      requestId: 'local',
      severity: 'warn',
      retryable: false,
    },
  };
}

/**
 * @param {unknown} method
 * @param {unknown} payload
 * @returns {Promise<unknown>} IPC 响应信封
 */
function invoke(method, payload) {
  if (typeof method !== 'string' || !IPC_METHODS.includes(method)) {
    // 白名单外的调用**不发往 main**：在桥这一层就拒绝。
    return Promise.resolve(localFailure(method, 'PERMISSION_METHOD_NOT_ALLOWED', `IPC 方法不在白名单: ${String(method)}`));
  }
  return ipcRenderer.invoke(IPC_CHANNEL, { method, payload: payload ?? null });
}

contextBridge.exposeInMainWorld('yfe', Object.freeze({
  call: invoke,
  methods: IPC_METHODS,
  protocolVersion: 1,
}));
