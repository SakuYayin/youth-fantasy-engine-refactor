/**
 * schema 版本 3：附件与任务。
 *
 * 🔴 规则（与 `syncDdl.ts` 完全一致）：**只追加，不改**。
 * `ddl.ts` 的 `SCHEMA_DDL` 是已发布的版本 1 基线，`syncDdl.ts` 是已发布的版本 2，
 * 二者一个字都不能动——已经升级过的库只会按 `server_schema_migrations` 里记下的
 * 校验和校验，改字面量会让老库与新库结构分叉，而症状只是"迁移失败"。
 *
 * 本迁移解决的两组缺口：
 *
 * 1. **附件**：版本 1 只建了 `upload_sessions`（会话），没有"分片对账"、"资产登记"
 *    与"引用表"。断点续传的对账依据必须是**服务端确认的分片状态**（设计文档 07），
 *    所以分片必须一行一片地落库，不能只靠 `received_parts` 计数——计数无法回答
 *    "第 7 片到底收到了没有"。
 * 2. **任务**：版本 1 完全没有任务表。`jobs` 的状态取值与
 *    `@yfe/contracts` 的 `JobStatus` **逐字一致**（9 个值），因为
 *    `waiting_network` / `waiting_confirmation` / `paused` 是**持久等待态**：
 *    进程重启后必须能恢复到这些状态，而不是被当成失败重跑。若这里少写一个值，
 *    应用层写进去就会被 CHECK 拒绝，且症状是"任务莫名失败"。
 *
 * 设计取舍：
 * - `assets.storage_key` 是**逻辑键**（如 `sha256/ab/cd/<hex>`），绝不写绝对路径：
 *   路径随设备与部署变化，落进同步数据就会在另一端失效（设计文档 06）。
 * - 唯一约束建在 `(workspace_id, storage_key)` 上而不是 `(workspace_id, sha256)`：
 *   内容寻址下二者等价，但按 storage_key 建唯一索引同时保证了"同一份内容在
 *   同一工作区只有一份实体"，而**跨工作区不设全局唯一**——否则一个用户的上传
 *   会因为"别人也传过同一文件"而暴露他人持有情况（设计文档 04）。
 * - `jobs.idempotency_key` 用**部分唯一索引**（`WHERE idempotency_key IS NOT NULL`）：
 *   SQLite 的唯一索引把多个 NULL 视为互不相同，但显式写成部分索引更直白，
 *   也避免将来有人误以为"NULL 会互相冲突"。
 * - `job_outputs` 是**追加型事件日志**（`(job_id, seq)` 复合主键），同时服务
 *   两条路径：SSE 用 `seq` 当 `Last-Event-ID` 续传，轮询退路用 `seq > since`。
 *   复杂任务的事件**刻意不塞进 `change_feed`**（设计文档 07）：change_feed 是
 *   文档同步的游标来源，混入任务日志会让客户端把任务事件当成文档变更。
 */

/**
 * 分片接收对账。
 *
 * 一行 = 服务端**已确认收到**的一个分片。`sha256` 允许为空（分片级校验是可选的
 * 加强项，整对象摘要在 complete 阶段必须校验），但 `byte_size` 必须落库，
 * 否则无法在 resume 时回答"已收多少字节"。
 */
const UPLOAD_PARTS_DDL = `
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number >= 0),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
)`

/**
 * 资产登记（服务端侧的内容寻址存储索引）。
 *
 * `state` 的状态机刻意与桌面端 `assets.local_state` 同名同值，便于跨端对账；
 * 但服务端多了 `deleted`（软删）而没有 `local_state` 的本地语义。
 * 只有 `state = 'present'` 且校验通过的资产才允许被引用（设计文档 04：
 * "只发布已校验且有权限的对象"）。
 */
const ASSETS_DDL = `
CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  attachment_id TEXT,
  storage_key TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL DEFAULT 'sha256' CHECK (hash_algorithm IN ('sha256')),
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  mime_type TEXT,
  original_name TEXT,
  state TEXT NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged', 'present', 'missing', 'corrupt')),
  uploaded_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  deleted_at TEXT
)`

const ASSETS_STORAGE_KEY_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_workspace_storage_key
  ON assets(workspace_id, storage_key)`

const ASSETS_SHA256_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_assets_workspace_sha256 ON assets(workspace_id, sha256)`

/**
 * 资产引用。
 *
 * 删除资产前必须先处理引用，否则产生悬空引用；`PRIMARY KEY (asset_id, entity_type, entity_id)`
 * 让"同一实体重复引用同一资产"幂等，不需要应用层去重。
 * 外键 `ON DELETE CASCADE`：资产真被删掉时引用必须一起消失，不能留悬空行。
 */
const ASSET_REFS_DDL = `
CREATE TABLE IF NOT EXISTS asset_refs (
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, entity_type, entity_id)
)`

const ASSET_REFS_ENTITY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_asset_refs_entity
  ON asset_refs(workspace_id, entity_type, entity_id)`

/**
 * 任务。
 *
 * 与契约 `Job` / `JobStatus` 的对应关系：
 * - `status` 的 9 个取值 = `JobStatus` 全部取值（少一个就会把正常状态写成约束错误）；
 * - `input_revision` / `config_revision` = 契约的 `inputRevision` / `configRevision`
 *   （不可变输入版本：执行期间输入变化会让结果不可解释）；
 * - `checkpoint` / `output_ref` = 契约同名字段；
 * - `lease_owner` + `lease_expires_at` 是**租约**实现：worker 崩溃后任务必须能在
 *   租约失效后被重新领取，否则永久卡死（与 `remote_commands` 同一套纪律）；
 * - `idempotency_key` 让"提交重试"不产生两个任务（同工作区同键只允许一个）。
 */
const JOBS_DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  executor TEXT NOT NULL CHECK (length(executor) > 0),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'running', 'waiting_network', 'waiting_confirmation', 'paused',
      'cancelling', 'succeeded', 'failed', 'cancelled'
    )),
  payload_json TEXT NOT NULL DEFAULT '{}',
  input_revision TEXT,
  config_revision TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  checkpoint TEXT,
  output_ref TEXT,
  progress_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_by_user_id TEXT NOT NULL,
  submitted_by_device_id TEXT,
  idempotency_key TEXT,
  cancel_requested_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT
)`

/** 领取顺序：先按状态可领取集过滤，再按优先级高、创建早。 */
const JOBS_CLAIMABLE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON jobs(status, priority DESC, created_at)`

/** 列表与 SSE 都按工作区 + 时间倒序读。 */
const JOBS_WORKSPACE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id, created_at DESC)`

/** 租约回收扫描（`lease_expires_at < now` 且非终态）。 */
const JOBS_LEASE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(lease_expires_at)`

const JOBS_IDEMPOTENCY_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency
  ON jobs(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL`

/**
 * 任务事件日志（追加型）。
 *
 * `seq` 由写入方在事务内分配（`MAX(seq)+1`），与 `(job_id, seq)` 主键共同保证
 * "同一任务的事件序号严格递增且不重复"——SSE 客户端断线重连时用 `Last-Event-ID`
 * 带上最后收到的 `seq`，服务端补发 `seq > since` 的记录即可，无需缓存。
 *
 * 🔴 只追加，不更新：`kind = 'progress'` 是**快照式**事件（每次一行），
 * 而不是"改同一行"。这样 poll 与 SSE 走同一条查询路径，也不会出现
 * "客户端断线期间进度被覆盖、重连后看到跳变"。
 */
const JOB_OUTPUTS_DDL = `
CREATE TABLE IF NOT EXISTS job_outputs (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('log', 'progress', 'chunk', 'checkpoint', 'result', 'error', 'status')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
)`

const JOB_OUTPUTS_CREATED_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_job_outputs_created ON job_outputs(created_at)`

/**
 * 迁移 3 的语句全集。
 *
 * 顺序按外键依赖排列：`assets` → `asset_refs`，`jobs` → `job_outputs`，
 * `upload_parts` 依赖版本 1 的 `upload_sessions`。
 */
export const ASSET_JOB_DDL: readonly string[] = [
  UPLOAD_PARTS_DDL,
  ASSETS_DDL,
  ASSETS_STORAGE_KEY_INDEX_DDL,
  ASSETS_SHA256_INDEX_DDL,
  ASSET_REFS_DDL,
  ASSET_REFS_ENTITY_INDEX_DDL,
  JOBS_DDL,
  JOBS_CLAIMABLE_INDEX_DDL,
  JOBS_WORKSPACE_INDEX_DDL,
  JOBS_LEASE_INDEX_DDL,
  JOBS_IDEMPOTENCY_INDEX_DDL,
  JOB_OUTPUTS_DDL,
  JOB_OUTPUTS_CREATED_INDEX_DDL,
]

/** 本迁移新增的表名（供 `SERVER_TABLES` 与"表齐全"检查共用）。 */
export const ASSET_JOB_TABLE_NAMES: readonly string[] = [
  'upload_parts',
  'assets',
  'asset_refs',
  'jobs',
  'job_outputs',
]
