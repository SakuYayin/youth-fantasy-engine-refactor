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
  findUserWithCredentialByUsername,
  isUniqueViolation,
  normalizeUsername,
  setUserDisabled,
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
  listMembers,
  listMemberships,
  removeMember,
  upsertMember,
} from './members.js'
export type { WorkspaceMemberRow } from './members.js'

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
