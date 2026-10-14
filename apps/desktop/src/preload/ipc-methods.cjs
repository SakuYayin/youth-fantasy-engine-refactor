'use strict';
/**
 * IPC 方法白名单（纯 JS 副本）。
 *
 * 🔴 为什么是 `.cjs` 而不是 `.mjs`：
 *   设计文档 02 要求 renderer 安全三元组含 `sandbox: true`，而 **Electron 的沙箱化
 *   preload 脚本不能加载 ESM**（`.mjs` preload 仅在 `sandbox: false` 下可用）。
 *   于是 preload 必须是 CommonJS，它 `require` 的白名单副本也必须是 CJS。
 *   详见 docs/adr/0003-preload-sandbox-cjs.md。
 *
 * 🔴 权威定义在 `../shared/ipc/channels.ts`（TypeScript）。这里只是运行时可用的副本，
 *   一致性由 `apps/desktop/tests/ipc-methods.test.ts` 逐项（含顺序）断言锁定。
 */
const IPC_METHODS = Object.freeze([
  'saveDraft',
  'listDocumentTree',
  'getDocument',
  'createProject',
  'createDocument',
  'systemStatus',
]);

module.exports = { IPC_METHODS };
