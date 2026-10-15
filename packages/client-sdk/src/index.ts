/**
 * `@yfe/client-sdk` 公共入口（ADR 0006 D2 第 6 条：渲染层只能依赖 `@yfe/contracts` 与本包）。
 *
 * 分三层，边界清晰：
 * - `createClient`  渲染层唯一入口：六个方法 + `Result` + 白名单 + 超时；
 * - 信封/错误适配   `parseResponseEnvelope` / `sanitizeErrorPayload` / `errorResponseBody`
 *                   —— 给未来的 Node/HTTP 适配层复用同一套脱敏与串号检测；
 * - 白名单副本      `IPC_METHODS` / `isIpcMethod` —— 与 channels.ts 一致性由测试锁定。
 */
export { createClient, createRawInvoke, DEFAULT_TIMEOUT_MS, normalizeTimeout } from './client.js'
export type { RawInvoke } from './client.js'
export { MALFORMED_MESSAGE, parseResponseEnvelope } from './envelope.js'
export type { EnvelopeMalformedReason } from './envelope.js'
export {
  BRIDGE_LEGACY_ERROR_CODES,
  FALLBACK_MESSAGE,
  clientError,
  describeThrown,
  errorResponseBody,
  fromThrown,
  isBridgeLegacyErrorCode,
  looksLikeStorageInternals,
  sanitizeDetail,
  sanitizeErrorPayload,
  sanitizeMessage,
  scrubText,
} from './errors.js'
export type { BridgeLegacyErrorCode, ErrorDetail, ErrorResponseBody } from './errors.js'
export { newRequestId } from './request-id.js'
export { IPC_METHODS, isIpcMethod } from './whitelist.js'
export type { IpcMethod } from './whitelist.js'
export type {
  ClientContract,
  ClientMethod,
  ClientTransport,
  CreateClientOptions,
  RendererClient,
} from './types.js'
