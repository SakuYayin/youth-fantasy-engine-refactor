/**
 * 桌面端 SQLite Schema 的唯一权威定义（DDL 与迁移清单）。
 *
 * 设计依据：
 * - `06-数据与本地存储.md`「逻辑数据表」给出 17 张桌面表；
 * - `docs/契约速查.md` 给出实体字段的**权威形状**（列名是其 snake_case 投影）；
 * - 契约里的 `revision` 是 `Brand<string>` 且明令禁止算术/比较，因此所有需要推进
 *   版本的实体表都额外带一列 `revision_seq INTEGER`：新 revision 的唯一来源。
 *   `revision` 字符串由 `encodeRevision(revision_seq)` 生成，UI 只看字符串；
 *   `revision_seq` 是**持久化层内部列**，不进 DTO、不进 IPC/HTTP payload。
 *
 * 🔴 不可变性：已发布的迁移（{@link SCHEMA_MIGRATIONS} 中 version 已存在的条目）**绝不允许
 *    修改其 ddl 文本**。migrator 会把每条迁移的 sha256 记进 `schema_migrations`，
 *    再次启动时校验；改动已发布迁移会导致校验和不匹配并被拒绝打开。
 *    新增列/表/索引只能追加新的迁移条目。
 *
 * 🔴 版本号规划（task-2 要求的「schema_migrations 之外的版本号规划」）：
 *    - `1 .. 999`    桌面端本地库独占（本包 {@link DESKTOP_MIGRATION_VERSION_MAX} 封顶）；
 *    - `1000 +`      后端服务端库独占（{@link BACKEND_MIGRATION_VERSION_BASE}）。
 *    两端各持自己的 `schema_migrations` 表；即使将来合并进同一个库文件，
 *    版本区间也不重叠，因此「某版本号属于谁」始终可判定。
 *
 * 🔴 后端专用表（users / sessions / devices / workspace_members / pairing_codes /
 *    remote_commands / sync_receipts / change_feed / upload_sessions / audit_events）
 *    **不在本模块创建**：它们由后端包负责建表。这里只导出它们的名字用于测试断言——
 *    桌面 Schema 里出现这些表意味着越权建表，必须被测试拦住。
 */

// ---------------------------------------------------------------------------
// 版本区间与保留表名
// ---------------------------------------------------------------------------

/** 桌面端本地库占用的迁移版本下界。 */
export const DESKTOP_MIGRATION_VERSION_MIN = 1

/** 桌面端本地库占用的迁移版本上界（含）。`1000 +` 留给后端。 */
export const DESKTOP_MIGRATION_VERSION_MAX = 999

/**
 * 后端服务端库迁移版本的起点。
 *
 * 取值刻意远离桌面区间：后端表结构与桌面演进节奏完全不同，
 * 混用同一段版本号会让「这个版本是谁迁的」无法判定。
 */
export const BACKEND_MIGRATION_VERSION_BASE = 1000

/**
 * 由后端包负责建的表：桌面 Schema 只**预留在版本区间上**，不建表。
 *
 * 用途：测试断言桌面 DDL 不得创建这些表；诊断工具区分"表缺失"是预期还是异常。
 */
export const RESERVED_BACKEND_TABLE_NAMES = [
  'users',
  'sessions',
  'devices',
  'workspace_members',
  'pairing_codes',
  'remote_commands',
  'sync_receipts',
  'change_feed',
  'upload_sessions',
  'audit_events',
] as const

export type ReservedBackendTableName = (typeof RESERVED_BACKEND_TABLE_NAMES)[number]

export function isReservedBackendTable(name: string): name is ReservedBackendTableName {
  return (RESERVED_BACKEND_TABLE_NAMES as readonly string[]).includes(name)
}

/** 版本号是否落在桌面端区间。 */
export function isDesktopMigrationVersion(version: number): boolean {
  return (
    Number.isSafeInteger(version) &&
    version >= DESKTOP_MIGRATION_VERSION_MIN &&
    version <= DESKTOP_MIGRATION_VERSION_MAX
  )
}

// ---------------------------------------------------------------------------
// 迁移描述
// ---------------------------------------------------------------------------

/**
 * 一条迁移。
 *
 * `ddl` 是**一个或多个 SQL 语句**的完整文本，由 migrator 在**单个事务**内 `exec`。
 * 事务内不允许出现 `PRAGMA journal_mode`（在事务中静默无效）或 `VACUUM`。
 */
export interface SchemaMigration {
  /** 单调递增的迁移版本，落在桌面区间内。 */
  readonly version: number
  /** 人类可读名称，进 `schema_migrations.name`。改名会改校验和，发布后禁止改。 */
  readonly name: string
  readonly ddl: string
}

// ---------------------------------------------------------------------------
// schema_migrations（bootstrap，由 migrator 在应用任何迁移前创建）
// ---------------------------------------------------------------------------

/**
 * 迁移台账表。
 *
 * 结构取舍：
 * - **主键是自增 id，不是 version**：迁移失败要留审计行（`success = 0`），
 *   同一版本可能有多条失败行 + 一条成功行，version 不能当主键。
 * - `success = 1` 的行由**部分唯一索引**保证一个版本最多一条；
 * - "当前版本"只由 `success = 1` 计算（{@link file://./version.ts} 的 `readSchemaVersion`），
 *   所以失败行**不推进版本**。
 * - `error_code` 只放契约错误码，不放 SQL 文本与正文。
 */
export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  version      INTEGER NOT NULL CHECK (version > 0),
  name         TEXT    NOT NULL,
  checksum     TEXT    NOT NULL,
  applied_at   TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  success      INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
  error_code   TEXT
);

-- 一个版本最多一条成功记录；失败记录可以有任意多条（重试审计）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_schema_migrations_applied
  ON schema_migrations (version) WHERE success = 1;

CREATE INDEX IF NOT EXISTS idx_schema_migrations_version
  ON schema_migrations (version);
`

/** 迁移台账表名。migrator 与诊断工具共用，避免字面量散落。 */
export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations'

// ---------------------------------------------------------------------------
// 桌面端表名清单（供测试与诊断断言）
// ---------------------------------------------------------------------------

/** 桌面端逻辑表：与 `06-数据与本地存储.md` 的表清单一一对应（17 张）。 */
export const DESKTOP_TABLE_NAMES = [
  'workspaces',
  'projects',
  'documents',
  'settings_entities',
  'relations',
  'assets',
  'asset_refs',
  'revisions',
  'operations',
  'outbox',
  'sync_checkpoints',
  'conflicts',
  'jobs',
  'job_outputs',
  'plugin_data',
  'config_values',
  'local_drafts',
] as const

export type DesktopTableName = (typeof DESKTOP_TABLE_NAMES)[number]

export function isDesktopTable(name: string): name is DesktopTableName {
  return (DESKTOP_TABLE_NAMES as readonly string[]).includes(name)
}

// ---------------------------------------------------------------------------
// v1 DDL
// ---------------------------------------------------------------------------

/**
 * v1 桌面 Schema 全量 DDL。
 *
 * 命名约定（与 SaveDraft / Repository 层约定，不得改名）：
 * - 列名一律 **snake_case**；表名沿用设计文档的 snake_case 复数形式。
 * - `*_json` 后缀的列存 JSON 文本，全部带 `json_valid()` CHECK，避免写入非法 JSON
 *   之后在读取端才炸。
 * - 时间列存 **UTC ISO-8601 字符串**，仅用于展示与审计，**不用于冲突裁决**。
 * - `deleted` 用 `CHECK (deleted >= 0)` 而不是 `IN (0, 1)`：契约注释明确历史数据可能
 *   存在非 0/1 的脏值，判定语义是「非 0 即删除」。用 `IN (0,1)` 会让导入旧库直接失败。
 *
 * 外键取向：
 * - **实体表**建完整外键 + `ON DELETE CASCADE`（workspaces → projects → documents）；
 * - **日志表**（revisions / operations / outbox / asset_refs 之外）刻意不建
 *   workspace/entity 外键：它们是同步的事实来源，任何级联删除都可能造成
 *   "用户改动永久丢失"，违反 `06-数据与本地存储.md` 的离线优先约束；
 * - `local_drafts.document_id` 也**不建外键**：草稿是"确认前的输入缓冲"，
 *   属于崩溃恢复资产，宁可留一条孤儿草稿也不能让一次外键失败丢掉用户刚敲的字。
 *
 * 幂等性：全部使用 `IF NOT EXISTS`。迁移的推进由 `schema_migrations` 决定，
 * 这里的幂等只是防御性兜底——让「表已存在但没有台账记录」的半成品库仍能迁移成功，
 * 而不是把用户永久锁在库外。
 */
export const SCHEMA_DDL = `
-- ###########################################################################
-- # workspaces：本地权限上下文
-- ###########################################################################
CREATE TABLE IF NOT EXISTS workspaces (
  id                  TEXT    PRIMARY KEY NOT NULL,
  name                TEXT    NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  authority_target_id TEXT,
  revision            TEXT    NOT NULL,
  revision_seq        INTEGER NOT NULL DEFAULT 0,
  deleted             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  CHECK (deleted >= 0),
  CHECK (revision_seq >= 0),
  CHECK (length(id) BETWEEN 1 AND 128)
);

-- ###########################################################################
-- # projects：作品
-- ###########################################################################
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT    PRIMARY KEY NOT NULL,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  summary      TEXT    NOT NULL DEFAULT '',
  project_type TEXT    NOT NULL DEFAULT 'full',
  revision     TEXT    NOT NULL,
  revision_seq INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  CHECK (deleted >= 0),
  CHECK (revision_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects (workspace_id);

-- ###########################################################################
-- # documents：卷 / 章 / 大纲 / 笔记统一表（kind 区分，parent_id 成树）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS documents (
  id           TEXT    PRIMARY KEY NOT NULL,
  workspace_id TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id   TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('volume', 'chapter', 'outline', 'note')),
  parent_id    TEXT             REFERENCES documents (id) ON DELETE CASCADE,
  order_key    TEXT    NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  body         TEXT    NOT NULL DEFAULT '',
  revision     TEXT    NOT NULL,
  revision_seq INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  CHECK (deleted >= 0),
  CHECK (revision_seq >= 0),
  -- 自引用环：SQLite 无法表达"祖先链无环"，至少拦住最直接的自环。
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace     ON documents (workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_project       ON documents (project_id);
-- 树渲染与拖动排序的主查询：同父下按 order_key 取兄弟。
CREATE INDEX IF NOT EXISTS idx_documents_parent_order  ON documents (parent_id, order_key);

-- ###########################################################################
-- # settings_entities：用户可自定义字段的设定实体（字段定义在模板里，值存 JSON）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS settings_entities (
  id                 TEXT    PRIMARY KEY NOT NULL,
  workspace_id       TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id         TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  schema_template_id TEXT    NOT NULL,
  name               TEXT    NOT NULL DEFAULT '',
  values_json        TEXT    NOT NULL DEFAULT '{}',
  order_key          TEXT    NOT NULL,
  revision           TEXT    NOT NULL,
  revision_seq       INTEGER NOT NULL DEFAULT 0,
  deleted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  CHECK (json_valid(values_json)),
  CHECK (deleted >= 0),
  CHECK (revision_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_settings_entities_project  ON settings_entities (project_id);
CREATE INDEX IF NOT EXISTS idx_settings_entities_template ON settings_entities (project_id, schema_template_id);
CREATE INDEX IF NOT EXISTS idx_settings_entities_order    ON settings_entities (project_id, order_key);

-- ###########################################################################
-- # relations：人物关系图 / 实体引用
-- ###########################################################################
CREATE TABLE IF NOT EXISTS relations (
  id             TEXT    PRIMARY KEY NOT NULL,
  workspace_id   TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  project_id     TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('character', 'reference', 'timeline', 'custom')),
  from_entity_id TEXT    NOT NULL,
  to_entity_id   TEXT    NOT NULL,
  label          TEXT    NOT NULL DEFAULT '',
  values_json    TEXT    NOT NULL DEFAULT '{}',
  revision       TEXT    NOT NULL,
  revision_seq   INTEGER NOT NULL DEFAULT 0,
  deleted        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  CHECK (json_valid(values_json)),
  CHECK (deleted >= 0),
  CHECK (revision_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_relations_project ON relations (project_id);
CREATE INDEX IF NOT EXISTS idx_relations_from    ON relations (from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to      ON relations (to_entity_id);

-- ###########################################################################
-- # assets：附件内容元数据（storage_key 是逻辑键，绝不是绝对路径）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS assets (
  id            TEXT    PRIMARY KEY NOT NULL,
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  attachment_id TEXT,
  -- 逻辑存储键：写进同步数据的是它，不是 Windows 绝对路径。
  storage_key   TEXT    NOT NULL,
  hash_algorithm TEXT   NOT NULL DEFAULT 'sha256',
  -- 列名沿用契约的 sha256；hash_algorithm 是给未来换算法留的兼容位。
  sha256        TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type     TEXT    NOT NULL,
  original_name TEXT    NOT NULL DEFAULT '',
  -- 文件与数据库没有一体事务：staged → present 的两阶段状态在此表达。
  local_state   TEXT    NOT NULL DEFAULT 'staged'
                        CHECK (local_state IN ('staged', 'present', 'missing', 'corrupt')),
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  CHECK (deleted >= 0)
);

CREATE INDEX IF NOT EXISTS idx_assets_workspace    ON assets (workspace_id);
-- 按内容摘要去重 / 校验完整性。
CREATE INDEX IF NOT EXISTS idx_assets_sha256       ON assets (sha256);
CREATE INDEX IF NOT EXISTS idx_assets_storage_key  ON assets (storage_key);

-- ###########################################################################
-- # asset_refs：引用完整性 + 工作区访问判定
-- ###########################################################################
CREATE TABLE IF NOT EXISTS asset_refs (
  asset_id     TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- 同一实体重复引用同一附件不产生第二行：删除引用时不会漏删。
  PRIMARY KEY (asset_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_refs_entity    ON asset_refs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_asset_refs_workspace ON asset_refs (workspace_id);

-- ###########################################################################
-- # revisions：修订历史（初期按章存完整文本，不做字符级 CRDT）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS revisions (
  id              TEXT    PRIMARY KEY NOT NULL,
  -- 🔴 不建外键：修订历史是回溯与冲突裁决的依据，任何级联删除都可能毁掉唯一恢复版本。
  workspace_id    TEXT    NOT NULL,
  entity_type     TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  revision        TEXT    NOT NULL,
  -- 🔴 写入当时的 entity.revision_seq（**必须由调用方显式提供**，故无 DEFAULT）。
  --    它是历史排序的真值来源：revision 字符串是 base36 编码的不透明值，禁止拿它排序。
  --    **不是**新 revision 的来源——新 revision 只来自实体行的 revision_seq + 1。
  --
  -- 🔴 绝不要用 "SELECT COUNT(*) FROM revisions WHERE entity_id = ?" 推序号：
  --    一旦 revisions 行被保留期/GC 裁剪，COUNT 会**倒退**，同一个 revision 字符串
  --    将被重复使用，直接破坏 outbox 幂等与 baseRevision 校验，
  --    造成"两端各自认为的同一 revision 内容不同"的静默数据损坏。
  --    这个反模式在此明确否决，防止后人"优化"回去。
  seq             INTEGER NOT NULL CHECK (seq >= 0),
  base_revision   TEXT,
  body_snapshot   TEXT,
  values_snapshot TEXT,
  source_op_id    TEXT,
  created_at      TEXT    NOT NULL,
  -- 同一实体的同一 revision 只能有一份快照（幂等重放不会写重复历史）。
  UNIQUE (entity_type, entity_id, revision),
  -- 同一实体的序号唯一：顺序与去重都由整数序号判定，不看 revision 字符串。
  UNIQUE (entity_type, entity_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_revisions_entity    ON revisions (entity_type, entity_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_workspace ON revisions (workspace_id);
CREATE INDEX IF NOT EXISTS idx_revisions_op        ON revisions (source_op_id);

-- ###########################################################################
-- # operations：同步协议的最小传输单元（append-only）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS operations (
  op_id         TEXT    PRIMARY KEY NOT NULL,
  -- 一次跨实体改动共享同一 batch_id，保证在单事务内提交。
  batch_id      TEXT    NOT NULL,
  workspace_id  TEXT    NOT NULL,
  entity_type   TEXT    NOT NULL,
  entity_id     TEXT    NOT NULL,
  project_id    TEXT,
  base_revision TEXT,
  new_revision  TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('upsert', 'delete')),
  payload_json  TEXT    NOT NULL DEFAULT '{}',
  -- 设备数据：仅本机可解析，不作为普通作品变更同步。
  actor         TEXT,
  created_at    TEXT    NOT NULL,
  CHECK (json_valid(payload_json))
);

CREATE INDEX IF NOT EXISTS idx_operations_batch     ON operations (batch_id);
CREATE INDEX IF NOT EXISTS idx_operations_entity    ON operations (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_operations_workspace ON operations (workspace_id, created_at);

-- ###########################################################################
-- # outbox：已提交但尚未被权威目标确认的操作（离线优先的核心）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS outbox (
  op_id           TEXT    PRIMARY KEY NOT NULL REFERENCES operations (op_id) ON DELETE CASCADE,
  workspace_id    TEXT    NOT NULL,
  batch_id        TEXT    NOT NULL,
  -- 同步目标；本地模式为 'local'。
  target_id       TEXT    NOT NULL DEFAULT 'local',
  state           TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'sending', 'acknowledged', 'failed')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT,
  created_at      TEXT    NOT NULL
);

-- 推送扫描：按目标 + 状态 + 下次尝试时间取批次。
CREATE INDEX IF NOT EXISTS idx_outbox_dispatch ON outbox (target_id, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_batch    ON outbox (batch_id);

-- ###########################################################################
-- # sync_checkpoints：每个同步目标每个工作区的推进水位
-- ###########################################################################
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  target_id         TEXT    NOT NULL,
  workspace_id      TEXT    NOT NULL,
  server_id         TEXT,
  -- 游标是不透明字符串：可能超出 JS 安全整数范围，绝不允许转成 number 存储。
  cursor            TEXT,
  protocol_major    INTEGER NOT NULL DEFAULT 1,
  protocol_minor    INTEGER NOT NULL DEFAULT 0,
  last_full_sync_at TEXT,
  updated_at        TEXT    NOT NULL,
  PRIMARY KEY (target_id, workspace_id)
);

-- ###########################################################################
-- # conflicts：冲突保留双方版本，不自动合并正文
-- ###########################################################################
CREATE TABLE IF NOT EXISTS conflicts (
  id              TEXT    PRIMARY KEY NOT NULL,
  workspace_id    TEXT    NOT NULL,
  entity_type     TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('text-diverged', 'delete-vs-edit', 'schema-drift', 'field-template')),
  -- 共同基线：三方比较的前提，缺失时不允许自动裁决。
  base_revision   TEXT,
  local_revision  TEXT    NOT NULL,
  -- 远端**影子版本**：先存下来，不直接覆盖用户的输入框。
  remote_revision TEXT    NOT NULL,
  local_payload   TEXT,
  remote_payload  TEXT,
  resolution      TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (resolution IN ('local-wins', 'remote-wins', 'merged', 'pending')),
  created_at      TEXT    NOT NULL,
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_conflicts_pending ON conflicts (workspace_id, resolution);
CREATE INDEX IF NOT EXISTS idx_conflicts_entity  ON conflicts (entity_type, entity_id);

-- ###########################################################################
-- # jobs / job_outputs：后台任务与其产物
-- ###########################################################################
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT    PRIMARY KEY NOT NULL,
  workspace_id      TEXT    NOT NULL,
  project_id        TEXT,
  kind              TEXT    NOT NULL,
  executor          TEXT    NOT NULL,
  -- 持久等待态（waiting_* / paused）必须能在重启后恢复，不能被当成失败重跑。
  status            TEXT    NOT NULL CHECK (status IN (
                              'queued', 'running', 'waiting_network', 'waiting_confirmation',
                              'paused', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  -- 不可变输入版本：执行期间输入不得变化，否则结果不可解释。
  input_revision    TEXT,
  config_revision   TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  attempt           INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  progress_json     TEXT,
  -- 租约：执行器崩溃后由租约过期回收，而不是永久卡在 running。
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  checkpoint        TEXT,
  output_ref        TEXT,
  error_code        TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  CHECK (progress_json IS NULL OR json_valid(progress_json))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs (status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs (project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_lease   ON jobs (lease_expires_at);

CREATE TABLE IF NOT EXISTS job_outputs (
  job_id     TEXT    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL CHECK (sequence >= 0),
  output_ref TEXT    NOT NULL,
  byte_size  INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256     TEXT,
  -- 采用状态：落库 ≠ 已采用，用户可能丢弃某次生成。
  adopted    INTEGER NOT NULL DEFAULT 0 CHECK (adopted IN (0, 1)),
  created_at TEXT    NOT NULL,
  PRIMARY KEY (job_id, sequence)
);

-- ###########################################################################
-- # plugin_data：插件私有数据（键值 + 版本化资源）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS plugin_data (
  workspace_id   TEXT    NOT NULL,
  plugin_id      TEXT    NOT NULL,
  key            TEXT    NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision       TEXT    NOT NULL,
  revision_seq   INTEGER NOT NULL DEFAULT 0,
  value_json     TEXT    NOT NULL DEFAULT 'null',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id, key),
  CHECK (json_valid(value_json)),
  CHECK (revision_seq >= 0)
);

-- ###########################################################################
-- # config_values：版本化配置（scope 决定归属与可见性）
-- ###########################################################################
CREATE TABLE IF NOT EXISTS config_values (
  scope          TEXT    NOT NULL CHECK (scope IN ('user', 'workspace', 'project', 'device', 'plugin')),
  owner_id       TEXT    NOT NULL,
  key            TEXT    NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision       TEXT    NOT NULL,
  revision_seq   INTEGER NOT NULL DEFAULT 0,
  value_json     TEXT    NOT NULL DEFAULT 'null',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (scope, owner_id, key),
  CHECK (json_valid(value_json)),
  CHECK (revision_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_config_values_owner ON config_values (scope, owner_id);

-- ###########################################################################
-- # local_drafts：确认前的输入缓冲
-- #
-- # 🔴 列名与 SaveDraft 层的约定（不得改名）：
-- #    document_id / session_id / sequence / body / base_revision /
-- #    confirmed_revision / updated_at，主键 (document_id, session_id)。
-- #
-- # 语义：每个 (document_id, session_id) **只有一行**，是"当前未确认草稿"的水位线，
-- # 不保留历史行。确认后**不删行**，只写 confirmed_revision 并清空 body——
-- # 删行会让"同序号重试"被误判为新草稿，产生重复 operation。
-- # 幂等重放：同序号 + confirmed_revision 非空 → 直接返回原 revision，不再写库。
-- ###########################################################################
CREATE TABLE IF NOT EXISTS local_drafts (
  document_id        TEXT    NOT NULL,
  session_id         TEXT    NOT NULL,
  sequence           INTEGER NOT NULL CHECK (sequence >= 0),
  body               TEXT    NOT NULL DEFAULT '',
  base_revision      TEXT,
  confirmed_revision TEXT,
  updated_at         TEXT    NOT NULL,
  PRIMARY KEY (document_id, session_id)
);

-- 启动恢复：一次会话里可能挂了很多篇待恢复草稿，按会话扫。
CREATE INDEX IF NOT EXISTS idx_local_drafts_session ON local_drafts (session_id, updated_at);
`

// ---------------------------------------------------------------------------
// 迁移清单
// ---------------------------------------------------------------------------

/**
 * 已发布的迁移清单，**按 version 升序**。
 *
 * 🔴 只允许追加。修改已发布条目的 `ddl` 会让 `schema_migrations` 里的校验和不匹配。
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: 'desktop-initial-schema',
    ddl: SCHEMA_DDL,
  },
]

/**
 * 本包支持的最高迁移版本。
 *
 * 必须与 `@yfe/contracts` 的 `DB_SCHEMA_VERSION` 保持一致（测试断言）。
 * 之所以不直接等于它：迁移清单是持久化层的自我描述，契约常量是跨端协商值，
 * 两者相等是**被校验的约束**，而不是靠引用同一常量来"自动成立"。
 */
export const LATEST_SCHEMA_VERSION = 1
