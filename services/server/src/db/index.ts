/**
 * `@yfe/server/db` 公开面：后端库的连接、迁移与仓储。
 *
 * 🔴 使用顺序（`../index.ts` 的启动流程）：
 * ```
 * openServerDatabase(path)            // 打开 + pragma（WAL/foreign_keys/busy_timeout）
 *   → migrateServerDatabase(db)       // 建表；版本过新则抛 STORAGE_SCHEMA_TOO_NEW
 *   → ensureServerState(db, serverId) // 插入单行服务状态
 * ```
 *
 * 🔴 **单实例约束**：`openServerDatabase` 会拒绝同一库文件的第二个存活写连接
 * （设计文档 04："单实例 SQLite 不能启动多个独立 writer 服务副本"）。
 * 进程内需要读连接时用 `{ readOnly: true }`。
 */

// --- 连接 ---
export {
  DEFAULT_BUSY_TIMEOUT_MS,
  closeServerDatabase,
  hasTable,
  isMemoryDatabasePath,
  isServerDatabaseOpen,
  listUserTables,
  openServerDatabase,
  readPragma,
  resolveServerOpenOptions,
  serverDatabasePragmaState,
  tx,
} from './open.js'
export type {
  JournalMode,
  OpenServerDatabaseOptions,
  ResolvedServerOpenOptions,
  ServerDatabasePragmaState,
  ServerDb,
  SynchronousMode,
} from './open.js'

// --- DDL / 表名 ---
export { ROLE_CHECK_SQL, SCHEMA_DDL, SERVER_SCHEMA_VERSION, SERVER_TABLES } from './ddl.js'
export type { ServerTableName } from './ddl.js'

// --- 同步 schema（版本 2） ---
export { SYNC_DDL_V2, SYNC_SCHEMA_VERSION, SYNC_TABLES } from './syncDdl.js'

// --- 规范化与摘要（幂等键的"同一份载荷"由此定义） ---
export { canonicalByteLength, canonicalJson, digestOf } from './canonical.js'

// --- 工作区元数据 ---
export {
  countWorkspacesForUser,
  findWorkspace,
  insertWorkspace,
  listWorkspacesForUser,
} from './workspaces.js'
export type { WorkspaceMembershipSummary, WorkspaceRow } from './workspaces.js'

// --- 同步状态：变更流 / 实体投影 / 回执 / 冲突 ---
export {
  appendChange,
  findEntityState,
  findFeedEntryByOpId,
  findReceipt,
  insertReceipt,
  listChanges,
  listConflictsForBatch,
  listEntityVersions,
  listLiveEntities,
  readHeadSeq,
  recordConflicts,
  upsertEntity,
} from './sync.js'
export type {
  AppendChangeInput,
  ConflictReason,
  EntityState,
  FeedEntry,
  InsertReceiptInput,
  ReceiptRow,
  RecordConflictInput,
  UpsertEntityInput,
} from './sync.js'

// --- 迁移 ---
export {
  MIGRATIONS,
  SERVER_MIGRATIONS_TABLE,
  appliedServerMigrations,
  backupServerDatabase,
  checksumOf,
  currentServerSchemaVersion,
  migrateServerDatabase,
  missingServerTables,
  tryMigrateServerDatabase,
  validateMigrationList,
} from './migrator.js'
export type {
  AppliedMigration,
  MigrateServerOptions,
  MigrateServerResult,
  ServerMigration,
} from './migrator.js'

// --- 服务状态（一次性初始化的幂等开关） ---
export {
  ensureServerState,
  isServerInitialized,
  markServerInitialized,
  readServerState,
} from './serverState.js'
export type { ServerStateRow } from './serverState.js'

// --- 用户 ---
export {
  countUsers,
  createUser,
  createUserWithMembership,
  findUserById,
  findUserByUsername,
  findUserWithCredentialByUsername,
  isUniqueViolation,
  listUsers,
  normalizeUsername,
  setUserDisabled,
  setUserDisplayName,
  setUserPasswordHash,
  userExists,
} from './users.js'
export type {
  CreateUserInput,
  CreateUserWithMembershipInput,
  UserRow,
  UserWithCredential,
} from './users.js'

// --- 成员与角色 ---
export {
  countOwners,
  findMember,
  listMemberViews,
  listMembers,
  listMemberships,
  removeMember,
  upsertMember,
} from './members.js'
export type { WorkspaceMemberRow, WorkspaceMemberView } from './members.js'

// --- 系统管理面（系统管理员 = `server_state.owner_user_id`） ---
export {
  countEnabledSystemAdminsAfterChange,
  isSystemAdmin,
  requireSystemAdmin,
  systemAdminUserId,
} from './admin.js'

// --- 会话与刷新凭据 ---
export {
  consumeRefreshToken,
  findRefreshToken,
  findSessionByAccessTokenHash,
  findSessionById,
  insertRefreshToken,
  insertSession,
  listRefreshTokensForChain,
  listSessionsForUser,
  markRefreshTokenReused,
  purgeExpiredRefreshTokens,
  purgeStaleSessions,
  revokeAllUserSessions,
  revokeSession,
  revokeSessionChain,
  touchSession,
} from './sessions.js'
export type {
  InsertRefreshTokenInput,
  InsertSessionInput,
  RefreshTokenRow,
  SessionRow,
} from './sessions.js'

// --- 设备 ---
export {
  countActiveDevices,
  findDeviceById,
  findDeviceByTokenHash,
  insertDevice,
  listDevicesForUser,
  listDevicesForWorkspace,
  renameDevice,
  revokeAllUserDevices,
  revokeDevice,
  touchDeviceLastSeen,
} from './devices.js'
export type { DeviceRow, DeviceWithCredential, InsertDeviceInput } from './devices.js'

// --- 配对码 ---
export {
  consumePairingCode,
  findPairingCodeByHash,
  findPairingCodeById,
  insertPairingCode,
  listPairingCodesForUser,
  purgeExpiredPairingCodes,
  recordPairingAttempt,
  revokeAllPairingCodesForUser,
  revokePairingCode,
} from './pairing.js'
export type { InsertPairingCodeInput, PairingCodeRow } from './pairing.js'

// --- 审计 ---
export {
  AUDIT_ACTIONS,
  countAuditEvents,
  generateAuditEventId,
  queryAuditEvents,
  recordAuditEvent,
} from './audit.js'
export type { AuditAction, AuditEventRow, AuditOutcome, AuditQuery, RecordAuditInput } from './audit.js'

// --- 附件上传与资产（迁移 3） ---
export {
  abortUploadSession,
  completeUploadSession,
  countAssetRefs,
  countUploadParts,
  deleteAssetRef,
  findAssetById,
  findAssetByStorageKey,
  findUploadSession,
  insertAsset,
  insertAssetRef,
  insertUploadSession,
  listAssetRefs,
  listAssetRefsForEntity,
  listUploadPartNumbers,
  listUploadParts,
  markAssetPresent,
  markUploadSessionCompleting,
  recordUploadPart,
  releaseUploadSessionCompleting,
  softDeleteAsset,
  updateAssetState,
} from './assets.js'
export type {
  AssetRefRow,
  AssetRow,
  AssetState,
  NewAsset,
  NewAssetRef,
  NewUploadSession,
  ReceivedUploadPart,
  RecordedPart,
  UploadPartRow,
  UploadSessionRow,
  UploadStatus,
} from './assets.js'

// --- 任务队列（迁移 3） ---
export {
  CLAIMABLE_JOB_STATUSES,
  DEFAULT_JOB_LEASE_MS,
  DEFAULT_JOB_MAX_ATTEMPTS,
  JOB_OUTPUT_KINDS,
  JOB_STATUSES,
  addMs,
  appendJobOutput,
  cancelJob,
  claimJob,
  completeJob,
  countJobOutputs,
  countJobsByStatus,
  defaultJobIdSource,
  failJob,
  getJob,
  getJobDetail,
  heartbeatJob,
  isJobOutputKind,
  isJobStatus,
  listJobEvents,
  listJobOutputs,
  listJobs,
  submitJob,
} from './jobs.js'
export type {
  AppendJobOutputRequest,
  CancelJobResult,
  CancelJobStatus,
  ClaimJobRequest,
  ClaimJobResult,
  CompleteJobRequest,
  FailJobRequest,
  HeartbeatJobRequest,
  JobDetail,
  JobIdSource,
  JobOutputKind,
  JobOutputRecord,
  JobRepoDeps,
  JobStreamEvent,
  ListJobEventsRequest,
  ListJobOutputsRequest,
  ListJobsRequest,
  SubmitJobRequest,
  SubmitJobResult,
} from './jobs.js'

// --- 远程命令（迁移 3） ---
export {
  DEFAULT_COMMAND_LEASE_MS,
  ackRemoteCommand,
  claimRemoteCommand,
  expireStaleRemoteCommands,
  findRemoteCommandById,
  insertRemoteCommand,
  listRemoteCommandsForDevice,
  toRemoteCommand,
} from './commands.js'
export type {
  AckRemoteCommandInput,
  AckRemoteCommandResult,
  ClaimRemoteCommandInput,
  ClaimedRemoteCommand,
  InsertRemoteCommandInput,
  RemoteCommandRow,
} from './commands.js'

// --- 迁移 3 的 DDL（供体检与迁移清单对齐） ---
export { ASSET_JOB_DDL, ASSET_JOB_TABLE_NAMES } from './assetJobDdl.js'
