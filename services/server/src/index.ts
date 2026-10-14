/**
 * `@yfe/server` —— 后端服务索引。
 *
 * 负责人：T3（`docs/项目台账.md` 任务 P3-A1 / A2 / A3）
 *
 * 纪律（设计文档 `04-后端与安全.md`）：
 * - 模块化单体，**不拆微服务**；只加载可信内置服务插件。
 * - 授权主体由服务端会话产生，**不接受客户端自报**角色。
 * - 只信任配置过的代理层，不盲目信任所有 `X-Forwarded-*`。
 *
 * 这里只做转发。真正的装配逻辑在 `./http/server.ts`，权限钩子在
 * `./permission/index.ts`，路由在 `./routes/index.ts`——按层放，
 * 调用方按需引入，避免"引一个符号就把整个进程拉起来"。
 */

export {
  assertWritableDirectory,
  defaultServerConfig,
  derivePairingPepper,
  KNOWN_ENV_KEYS,
  loadServerConfig,
  readMasterKey,
  ServerConfigError,
  DEFAULT_BODY_LIMIT_BYTES,
  MAX_BODY_LIMIT_BYTES,
  MASTER_KEY_BYTES,
} from './http/config.js'
export type { LogLevel, ServerConfig } from './http/config.js'

export { bootstrapServer, createServer, defaultRateLimiters, startServer } from './http/server.js'
export type {
  BootstrapResult,
  CreateServerOptions,
  ServerHandle,
  ServerLifecycle,
} from './http/server.js'

export { createRateLimiter, MAX_RATE_LIMIT_ENTRIES, rateLimitedError } from './http/rateLimit.js'
export type { RateLimitPolicy, RateLimitVerdict, RateLimiter } from './http/rateLimit.js'

export {
  ALL_ERROR_CODES,
  ALLOWED_HTTP_STATUSES,
  contractErrorFromFramework,
  errorResponseBody,
  httpStatusFor,
  httpStatusForError,
  statusHintOf,
  toContractError,
  withStatusHint,
} from './http/errors.js'
export type { ErrorResponseBody, FrameworkErrorLike } from './http/errors.js'

export {
  buildReadinessReport,
  probeDatabase,
  probeMigrations,
  registerHealthRoutes,
} from './http/health.js'
export type { DatabaseHealth, HealthDeps, MigrationsHealth, ReadinessReport } from './http/health.js'

export {
  attachRequestContext,
  authorizeWorkspaceAccess,
  bearerTokenOf,
  createPermissionGuards,
  currentAuth,
  currentPrincipal,
  makeRequireSession,
  makeRequireWorkspaceAccess,
} from './permission/index.js'
export type {
  AccessAction,
  AuthContext,
  CredentialSource,
  PermissionDeps,
  PermissionGuards,
  RequireWorkspaceOptions,
} from './permission/index.js'

export { registerAuthRoutes, DEFAULT_LOGIN_RATE_LIMIT } from './routes/auth.js'
export type { AuthRouteDeps } from './routes/auth.js'
export { registerSetupRoute, DEFAULT_SETUP_RATE_LIMIT } from './routes/setup.js'
export type { SetupBody, SetupDeps, SetupResponseBody } from './routes/setup.js'
export { registerCapabilitiesRoute } from './routes/capabilities.js'
export type { CapabilitiesDeps } from './routes/capabilities.js'
export { MAX_WORKSPACES_PER_USER, registerWorkspaceRoutes } from './routes/workspaces.js'
export type { WorkspaceRouteDeps } from './routes/workspaces.js'
export { registerSyncRoutes } from './routes/sync.js'
export type { SyncRouteDeps } from './routes/sync.js'

export {
  CONFIG_ENTITY_TYPE,
  DEFAULT_CHANGES_LIMIT,
  DEFAULT_VERSIONS_LIMIT,
  MAX_CHANGES_LIMIT,
  MAX_OPERATIONS_ACCEPTED_BY_SCHEMA,
  MAX_VERSIONS_LIMIT,
  MIN_CLIENT_MAJOR,
  PLUGIN_STATE_ENTITY_TYPE,
  SNAPSHOT_BUCKETS,
  SUPPORTED_ACTIONS,
  SUPPORTED_COMMANDS,
  SYNC_ASSETS,
  SYNC_ENTITY_TYPES,
  SYNC_LIMITS,
  SYNC_PROTOCOL_MAJOR,
  assertProtocolVersion,
  cursorInvalidError,
  encodeWorkspaceCursor,
  isSyncEntityType,
  parseLimit,
  parseWorkspaceCursor,
  payloadTooLargeError,
  requireWellFormedId,
} from './sync/protocol.js'
export type { SyncEntityType } from './sync/protocol.js'

export { registerRoutes } from './routes/index.js'
export type { RouteDeps } from './routes/index.js'
