/**
 * 后端服务专属表的 DDL 基线（schema 版本 1）。
 *
 * 设计依据：`06-数据与本地存储.md`「逻辑数据表」（末段："后端另有 users、sessions、
 * devices、workspace_members、pairing_codes、remote_commands、sync_receipts、
 * change_feed、upload_sessions 和 audit_events。数据库内部任务、令牌和审计不作为
 * 普通作品变更同步。"）与 `04-后端与安全.md`。
 *
 * 🔴 三条不可让步的规则：
 * 1. **新列只能走新迁移**：已发布的 `SCHEMA_DDL` 一个字都不能改，只能在
 *    `MIGRATIONS` 里追加新版本（见 `./migrator.ts`）。
 * 2. **秘密只存摘要**：`users.password_hash`、`devices.token_hash`、
 *    `pairing_codes.code_hash`、`sessions.access_token_hash`、`refresh_tokens.token_hash`
 *    都是单向摘要列。明文凭据只在生成它的那一次响应里出现，之后任何读路径都拿不到。
 * 3. **权重内容不落库**：正文、附件字节、模型密钥都不在这些表里。
 *
 * 本轮（P3-A1）只实现身份/设备/权限骨架/审计，但表要按设计文档**留好后续任务的位**：
 * `remote_commands`、`sync_receipts`、`change_feed`、`upload_sessions` 建表但不实现业务，
 * 这样 P3-A2/A3 加接口时不需要改已发布的 DDL。
 */

/**
 * 本 DDL 集对应的 schema 版本。`server_schema_migrations` 的版本号与它比对。
 *
 * 版本 1 = 基线（`SCHEMA_DDL`）；版本 2 = `syncDdl.ts` 的 `SYNC_DDL_V2`
 * （工作区元数据 / 实体投影 / 冲突留痕 / change_feed 的 batch_id+op_id）。
 * 加迁移时必须同步 +1：`migrateServerDatabase` 用它判断"库比程序新"，
 * 忘了改会让刚加的迁移被判定为"库过新"而拒绝打开。
 */
export const SERVER_SCHEMA_VERSION = 3

/**
 * 表名常量。
 *
 * 用常量而不是散落的字符串字面量：迁移、Repository 与测试断言共用同一份名单，
 * 改名字时不会有一处漏改而静默查空表。
 */
export const SERVER_TABLES = {
  /** 单行表：serverId、初始化状态与所有者。一次性初始化的幂等开关就是它。 */
  serverState: 'server_state',
  users: 'users',
  sessions: 'sessions',
  refreshTokens: 'refresh_tokens',
  devices: 'devices',
  workspaceMembers: 'workspace_members',
  pairingCodes: 'pairing_codes',
  remoteCommands: 'remote_commands',
  syncReceipts: 'sync_receipts',
  changeFeed: 'change_feed',
  uploadSessions: 'upload_sessions',
  auditEvents: 'audit_events',
  /** schema 版本 2 起（`./syncDdl.ts`）：工作区元数据、实体投影、冲突留痕。 */
  workspaces: 'workspaces',
  syncEntities: 'sync_entities',
  syncConflicts: 'sync_conflicts',
  /**
   * schema 版本 3 起（`./assetJobDdl.ts`）：附件分片对账、资产登记与引用、
   * 任务与任务事件日志。
   */
  uploadParts: 'upload_parts',
  assets: 'assets',
  assetRefs: 'asset_refs',
  jobs: 'jobs',
  jobOutputs: 'job_outputs',
} as const

export type ServerTableName = (typeof SERVER_TABLES)[keyof typeof SERVER_TABLES]

/**
 * 工作区角色枚举。
 *
 * 与 `@yfe/contracts` 的 `WorkspaceRole` 必须逐字一致，否则服务端会话算出的角色
 * 会被 `canWrite()` 判成不可写。`WORKSPACE_ROLES` 是契约的权威来源，这里只是
 * 把它落成 SQL 的 `CHECK` 列表（SQL 里没法引用 TS 常量）。
 */
export const ROLE_CHECK_SQL = "'admin', 'owner', 'editor', 'viewer'"

/**
 * `server_state` 是**单行表**：用 `CHECK (id = 1)` 把"只能有一行"写成数据库约束，
 * 而不是靠代码自觉。新库建表后由 `db/index.ts` 插入 serverId 行。
 */
const SERVER_STATE_DDL = `
CREATE TABLE IF NOT EXISTS server_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  initialized_at TEXT,
  owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  bootstrap_secret_file TEXT,
  -- 初始化时间与所有者必须同时存在或同时缺失：防止出现"已初始化但没有所有者"
  -- 这种既不能再 setup、又没人能登录的死状态。
  CHECK ((initialized_at IS NULL) = (owner_user_id IS NULL))
)`

/**
 * 用户表。
 *
 * `password_hash` 是自描述的模块化字符串（见 `../auth/password.js`），
 * 参数随部署硬件基准调整并记录在串里，换参数不需要改表。
 * `disabled` 用 INTEGER 0/1：SQLite 没有 boolean，用 TEXT 会带来比较陷阱。
 */
const USERS_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  CHECK (length(username) > 0),
  CHECK (length(password_hash) > 0)
)`

/**
 * Web 管理端会话。
 *
 * `chain_id` 是**会话链**标识：刷新轮换中每一次轮换都产生新 session 行但沿用同一
 * chain_id，因此"检测到旧刷新凭据被复用 → 撤销整条链、用户必须重新登录"这条
 * 规则可以用一条 `UPDATE sessions SET revoked_at = ? WHERE chain_id = ?` 表达。
 *
 * 🔴 `access_token_hash` 存的是访问令牌的 SHA-256 摘要，不是明文令牌。
 * 🔴 `csrf_secret` 不是凭据，是 CSRF 校验的签名材料；它不能替代会话认证。
 */
const SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  user_agent TEXT,
  client_ip TEXT
)`

const SESSIONS_CHAIN_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sessions_chain ON sessions(chain_id)`

const SESSIONS_USER_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at)`

/**
 * 刷新凭据表（**只存摘要**）。
 *
 * 轮换过程必须在一个事务里完成，且有三种可区分的结果：
 * - 正常轮换：旧行 `consumed_at` 置位、`replaced_by_hash` 指向新行，插入新行；
 * - 幂等重放（同一凭据、极短窗口内重复到达）：返回同一新凭据，不再插行；
 * - **复用检测**：旧行 `consumed_at` 已置位且超出宽限窗口 → `reused_detected_at` 置位，
 *   调用方据此撤销整个 chain。
 *
 * `token_hash` 做主键而不是 `id`：凭据本身不可枚举，主键即摘要，省一次索引查找，
 * 也天然阻止同摘要重复插入。
 */
const REFRESH_TOKENS_DDL = `
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chain_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  replaced_by_hash TEXT,
  reused_detected_at TEXT,
  CHECK (consumed_at IS NULL OR replaced_by_hash IS NOT NULL)
)`

const REFRESH_TOKENS_CHAIN_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_chain ON refresh_tokens(chain_id, expires_at)`

/**
 * 已配对设备。
 *
 * `token_hash` 是设备凭据摘要；`revoked_at` 一置位，该设备的所有请求都必须失败
 * （设计文档 04："撤销的设备不能继续上传"）。`last_seen_at` 只用于展示与审计，
 * **不参与任何冲突裁决**（契约 ids.ts 明文）。
 *
 * `pairing_code_id` 刻意**不加外键**：它指向 `pairing_codes`，而 `pairing_codes`
 * 又引用 `devices.consumed_device_id`，两表互引会让建表顺序与删除语义都变复杂。
 * 配对码的消费关系以 `pairing_codes.consumed_device_id`（有外键）为准。
 */
const DEVICES_DDL = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT,
  name TEXT NOT NULL,
  platform TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  pairing_code_id TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT,
  CHECK (length(name) > 0)
)`

const DEVICES_USER_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, revoked_at)`

/**
 * 工作区成员与角色。
 *
 * 🔴 授权主体**只能**从服务端会话 + 这张表推出，绝不接受客户端自报角色
 * （设计文档 04："客户端不能提交自报 issuer；服务端从会话产生"）。
 * 复合主键 (workspace_id, user_id) 让"同一用户在同一工作区只有一个角色"成为约束。
 */
const WORKSPACE_MEMBERS_DDL = `
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN (${ROLE_CHECK_SQL})),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
)`

const WORKSPACE_MEMBERS_USER_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id)`

/**
 * 配对码。
 *
 * 一次性 + 短期 + 限定用户/工作区 + 尝试次数上限，四条都在数据库里可判定：
 * - 一次性：`consumed_at` 置位后 `UPDATE ... WHERE consumed_at IS NULL` 影响行数为 0；
 * - 短期：`expires_at` 与注入时钟比较（**不**用 SQLite 的 `datetime('now')`，
 *   否则测试无法用固定时钟复现过期路径）；
 * - 次数上限：`attempts` / `max_attempts`，失败一次就自增；
 * - 限定范围：`user_id` / `workspace_id` 与请求上下文比对。
 *
 * `code_hash` 唯一：相同配对码不可能同时存在两份活动记录。
 */
const PAIRING_CODES_DDL = `
CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TEXT,
  consumed_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  revoked_at TEXT
)`

const PAIRING_CODES_USER_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pairing_codes_user ON pairing_codes(user_id, expires_at)`

/**
 * 远程命令（本轮**只建表**，接口在后续任务）。
 *
 * 状态机 `pending → claimed → acked | expired | failed` 用 CHECK 固定；
 * `issuer` 由服务端会话写入，不接受客户端提交（设计文档 04）。
 * 租约字段（`lease_expires_at`）是"设备领取后崩溃，命令必须能在租约失效后重新被领取"
 * 的实现基础——领取即删除会让命令永久卡死。
 */
const REMOTE_COMMANDS_DDL = `
CREATE TABLE IF NOT EXISTS remote_commands (
  command_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('workflow.run', 'job.cancel', 'sync.trigger')),
  args_json TEXT NOT NULL DEFAULT '{}',
  issuer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'acked', 'expired', 'failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_by_device_id TEXT,
  lease_expires_at TEXT,
  execution_id TEXT,
  result_json TEXT,
  error_code TEXT,
  acked_at TEXT
)`

const REMOTE_COMMANDS_CLAIM_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_remote_commands_claimable
  ON remote_commands(target_device_id, status, expires_at)`

/**
 * 批次幂等回执。
 *
 * 主键是 `batch_id`：同一批次重复提交必须拿回**原来的结果**。`payload_digest`
 * 把"重试"和"篡改"区分开——同一 batchId 配不同摘要 → `IDEMPOTENCY_KEY_REUSED`。
 * `response_json` 保存原始响应体，重放时逐字节返回，避免"重新计算出一个略有差异的结果"。
 */
const SYNC_RECEIPTS_DDL = `
CREATE TABLE IF NOT EXISTS sync_receipts (
  batch_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK (operation_count >= 0),
  accepted_at TEXT NOT NULL,
  cursor TEXT NOT NULL,
  response_json TEXT NOT NULL
)`

const SYNC_RECEIPTS_WORKSPACE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sync_receipts_workspace ON sync_receipts(workspace_id, accepted_at)`

/**
 * 变更流（change feed）。
 *
 * `server_seq INTEGER PRIMARY KEY AUTOINCREMENT` 是**游标序号的唯一来源**：
 * 递增语义属于存储层，客户端拿到的只是不透明字符串（`encodeCursor`）。
 * AUTOINCREMENT 刻意保留：普通 rowid 在删除最大值后会复用序号，复用的序号会让
 * "已推进游标的设备漏掉变更"，这是数据丢失级故障。
 */
const CHANGE_FEED_DDL = `
CREATE TABLE IF NOT EXISTS change_feed (
  server_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  revision TEXT NOT NULL,
  base_revision TEXT,
  payload_json TEXT NOT NULL,
  actor_device_id TEXT,
  actor_user_id TEXT,
  committed_at TEXT NOT NULL
)`

const CHANGE_FEED_WORKSPACE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_change_feed_workspace_seq ON change_feed(workspace_id, server_seq)`

/**
 * 附件上传会话（本轮**只建表**）。
 *
 * `received_parts` 是断点续传的对账依据（"断点以服务器确认的 part 状态为准"），
 * `staging_dir` 指向 `/data/assets` 下的相对目录，**不存绝对路径**
 * （设计文档 06："不在同步数据中写 Windows 绝对路径"）。
 */
const UPLOAD_SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT,
  declared_name TEXT,
  declared_mime TEXT,
  declared_size INTEGER NOT NULL CHECK (declared_size >= 0),
  declared_sha256 TEXT,
  part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes > 0),
  total_parts INTEGER NOT NULL CHECK (total_parts >= 0),
  received_parts INTEGER NOT NULL DEFAULT 0 CHECK (received_parts >= 0),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completing', 'completed', 'aborted', 'expired')),
  staging_dir TEXT NOT NULL,
  asset_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
)`

const UPLOAD_SESSIONS_WORKSPACE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_upload_sessions_workspace ON upload_sessions(workspace_id, status)`

/**
 * 审计事件。
 *
 * 覆盖设计文档 04 点名的动作：登录、设备撤销、权限修改、插件授权、远程命令与恢复操作。
 * **不默认收集正文**：`detail_json` 只放结构化的动作参数，绝不放稿件内容或凭据。
 * 这张表只增不改（应用层不提供 UPDATE/DELETE 路径）。
 */
const AUDIT_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_device_id TEXT,
  target_type TEXT,
  target_id TEXT,
  workspace_id TEXT,
  request_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  detail_json TEXT,
  client_ip TEXT
)`

const AUDIT_EVENTS_AT_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at)`

const AUDIT_EVENTS_ACTOR_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, at)`

/**
 * 完整 DDL 基线（版本 1）。
 *
 * 🔴 这是**已发布**的定义：任何改动都必须以"新增迁移"的方式做，
 * 绝不能在这里改字面量——否则已升级过的库与新库结构不一致，而校验和对不上时
 * 只会报迁移失败，排查成本极高。
 *
 * 建表顺序按外键依赖排列（SQLite 允许前向引用，但按依赖顺序建更容易人工核对）。
 */
export const SCHEMA_DDL: readonly string[] = [
  SERVER_STATE_DDL,
  USERS_DDL,
  SESSIONS_DDL,
  SESSIONS_CHAIN_INDEX_DDL,
  SESSIONS_USER_INDEX_DDL,
  REFRESH_TOKENS_DDL,
  REFRESH_TOKENS_CHAIN_INDEX_DDL,
  DEVICES_DDL,
  DEVICES_USER_INDEX_DDL,
  WORKSPACE_MEMBERS_DDL,
  WORKSPACE_MEMBERS_USER_INDEX_DDL,
  PAIRING_CODES_DDL,
  PAIRING_CODES_USER_INDEX_DDL,
  REMOTE_COMMANDS_DDL,
  REMOTE_COMMANDS_CLAIM_INDEX_DDL,
  SYNC_RECEIPTS_DDL,
  SYNC_RECEIPTS_WORKSPACE_INDEX_DDL,
  CHANGE_FEED_DDL,
  CHANGE_FEED_WORKSPACE_INDEX_DDL,
  UPLOAD_SESSIONS_DDL,
  UPLOAD_SESSIONS_WORKSPACE_INDEX_DDL,
  AUDIT_EVENTS_DDL,
  AUDIT_EVENTS_AT_INDEX_DDL,
  AUDIT_EVENTS_ACTOR_INDEX_DDL,
]
