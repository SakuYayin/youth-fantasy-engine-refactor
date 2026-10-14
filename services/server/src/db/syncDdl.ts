/**
 * 服务器 schema 版本 2 的增量 DDL：工作区元数据 + 服务端实体投影 + 冲突留痕。
 *
 * ## 为什么是"新迁移"而不是改 `ddl.ts`
 *
 * `ddl.ts` 里的 `SCHEMA_DDL` 是**已发布**的版本 1 基线（`docs` 与审计要求"新列只能走
 * 新迁移"）：已经升级过的库与新库必须逐字节一致，任何回改都会让
 * `server_schema_migrations.checksum` 对不上，表现为"迁移失败"，排查成本极高。
 * 所以这里只做**追加**：
 *
 * - 新表 `workspaces` / `sync_entities` / `sync_conflicts`；
 * - `sync_receipts` 加一列 `idempotency_key`（P3-A3 幂等键留痕，便于运维按客户端
 *   的幂等键反查）；
 * - `change_feed` 加两列 `batch_id` / `op_id`（版本历史要能回答"这个 revision 来自
 *   哪一批、哪个操作"，否则冲突排查只能靠猜）；
 * - 一个 `(workspace_id, entity_id, server_seq)` 索引（版本历史按实体查）。
 *
 * ## 版本 1 遗留数据怎么办：`workspaces` 的回填
 *
 * 版本 1 的库里有 `workspace_members` 却没有 `workspaces` 表——工作区 ID 是
 * setup / 设备配对时现生成的，只有成员关系落了库。因此这个迁移**必须回填**，
 * 否则升级后 `GET /api/v1/workspaces` 会把这些工作区全部漏掉（"用户明明是成员，
 * 列表却是空的"，这是最容易被当成鉴权 bug 的一类故障）。
 *
 * 回填的显示名统一是 `默认工作区`：这些工作区都是由 setup / 配对自动创建、
 * 从未被命名过的，用"默认工作区"是**如实描述**，不是占位符糊弄。工作区重命名
 * 不在本轮范围（写入统一走 batches，见 `07-同步协议与API.md`）。
 *
 * ## 为什么 `deleted` 用 INTEGER 而不是布尔
 *
 * 与桌面端 `packages/persistence-sqlite/src/schema/ddl.ts` 保持一致：`deleted`
 * 只约定"非 0 即已删除"，给将来的"软删除原因/代际"留位置，避免再来一次迁移。
 */

/** 本文件对应的 schema 版本。`services/server/src/db/ddl.ts` 的 `SERVER_SCHEMA_VERSION` 与它一致。 */
export const SYNC_SCHEMA_VERSION = 2

/**
 * 版本 2 新增的表名。
 *
 * 和 `ddl.ts` 的 `SERVER_TABLES` 一样用常量而非散落的字符串字面量：
 * `/health/ready` 的"缺表"探针与 Repository 共用同一份名单。
 */
export const SYNC_TABLES = {
  /** 工作区元数据。`workspace_members` 只回答"谁在哪个工作区"，名字存在这里。 */
  workspaces: 'workspaces',
  /** 服务端实体投影：每个 (workspace, entity_type, entity_id) 的当前版本与内容。 */
  syncEntities: 'sync_entities',
  /** 基线冲突留痕：整批拒绝时也必须可追溯（拒绝 ≠ 不记录）。 */
  syncConflicts: 'sync_conflicts',
} as const

const WORKSPACES_DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  authority_target_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

const WORKSPACES_CREATOR_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_workspaces_creator ON workspaces(created_by_user_id, created_at)`

/**
 * 版本 1 → 2 的数据回填（见文件头"版本 1 遗留数据怎么办"）。
 *
 * `WHERE m.created_at = (SELECT MIN(...))` 让"创建者"取最早的成员，并列时按
 * `user_id` 排序取第一个：`insertWorkspace` 的写入路径也遵守同一约定，
 * 回填结果与新建结果因此在结构上一致。
 */
const WORKSPACES_BACKFILL_DDL = `
INSERT OR IGNORE INTO workspaces (id, name, created_by_user_id, authority_target_id, deleted, created_at, updated_at)
SELECT m.workspace_id,
       '默认工作区',
       m.user_id,
       NULL,
       0,
       m.created_at,
       m.created_at
FROM workspace_members m
WHERE m.created_at = (SELECT MIN(m2.created_at) FROM workspace_members m2 WHERE m2.workspace_id = m.workspace_id)
ORDER BY m.workspace_id, m.user_id`

/**
 * 服务端实体投影。
 *
 * `revision` **即使 `deleted = 1` 也必填**：墓碑要带上自己的版本号，下一次
 * "在墓碑上重建"才能用 `baseRevision = 墓碑 revision` 通过基线检查（见
 * `src/routes/sync.ts` 的基线规则）。
 *
 * `payload_json` 在墓碑上是 `NULL`：删除后的实体不该再有任何正文留在服务器上
 * （设计文档 06"权重内容不落库"的精神——删除要真的把内容删掉）。
 *
 * `last_server_seq` 是最后一次写入对应的 `change_feed.server_seq`，用于把实体投影
 * 与变更流对齐（快照读到的 `cursor` 就是这个点的 head）。
 */
const SYNC_ENTITIES_DDL = `
CREATE TABLE IF NOT EXISTS sync_entities (
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  revision TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted >= 0),
  payload_json TEXT,
  updated_at TEXT NOT NULL,
  last_server_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_server_seq >= 0),
  PRIMARY KEY (workspace_id, entity_type, entity_id)
)`

const SYNC_ENTITIES_PROJECT_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sync_entities_project ON sync_entities(workspace_id, project_id, entity_type)`

/**
 * 基线冲突留痕。
 *
 * `reason` 的四个取值直接复制契约 `OperationConflict['reason']`，不做二次发明；
 * `resolution` / `resolved_at` 留给后续的"冲突解决"接口（本轮不做，但列先建好，
 * 否则将来又要加迁移）。
 *
 * `(batch_id, op_id)` 唯一：同一批冲突重试时用 `INSERT OR IGNORE`，留痕不会重复膨胀。
 */
const SYNC_CONFLICTS_DDL = `
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  reason TEXT NOT NULL
    CHECK (reason IN ('revision-mismatch', 'entity-deleted', 'permission', 'invalid-payload')),
  expected_base_revision TEXT,
  current_revision TEXT,
  submitted_by_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
    CHECK (resolution IS NULL OR resolution IN ('local-wins', 'remote-wins', 'merged'))
)`

const SYNC_CONFLICTS_BATCH_INDEX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_conflicts_batch_op ON sync_conflicts(batch_id, op_id)`

const SYNC_CONFLICTS_WORKSPACE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_workspace ON sync_conflicts(workspace_id, detected_at)`

const SYNC_RECEIPTS_IDEMPOTENCY_COLUMN_DDL = `
ALTER TABLE sync_receipts ADD COLUMN idempotency_key TEXT`

const CHANGE_FEED_BATCH_COLUMN_DDL = `
ALTER TABLE change_feed ADD COLUMN batch_id TEXT`

const CHANGE_FEED_OP_COLUMN_DDL = `
ALTER TABLE change_feed ADD COLUMN op_id TEXT`

const CHANGE_FEED_ENTITY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_change_feed_workspace_entity ON change_feed(workspace_id, entity_id, server_seq)`

/**
 * `op_id` 索引：幂等检查按 `(workspace_id, op_id)` 查"这个操作是不是已经提交过"。
 * 没有它，每个操作都会退化成一次全表扫描；批次越大越慢，而且慢在写路径上。
 */
const CHANGE_FEED_OP_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_change_feed_workspace_op ON change_feed(workspace_id, op_id)`

/** 版本 2 的完整语句集（顺序即执行顺序；`ALTER TABLE` 必须在建表之后）。 */
export const SYNC_DDL_V2: readonly string[] = [
  WORKSPACES_DDL,
  WORKSPACES_CREATOR_INDEX_DDL,
  WORKSPACES_BACKFILL_DDL,
  SYNC_ENTITIES_DDL,
  SYNC_ENTITIES_PROJECT_INDEX_DDL,
  SYNC_CONFLICTS_DDL,
  SYNC_CONFLICTS_BATCH_INDEX_DDL,
  SYNC_CONFLICTS_WORKSPACE_INDEX_DDL,
  SYNC_RECEIPTS_IDEMPOTENCY_COLUMN_DDL,
  CHANGE_FEED_BATCH_COLUMN_DDL,
  CHANGE_FEED_OP_COLUMN_DDL,
  CHANGE_FEED_ENTITY_INDEX_DDL,
  CHANGE_FEED_OP_INDEX_DDL,
]
