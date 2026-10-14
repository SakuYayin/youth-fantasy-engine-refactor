/**
 * `@yfe/persistence-sqlite` —— SQLite 持久化层索引。
 *
 * 分层（**上层只依赖下层，反向依赖一律禁止**）：
 * 1. {@link ./schema/index.js} —— 打开连接、DDL 与迁移、写入前的版本闸门。
 * 2. {@link ./saveDraft/index.js} —— 本地保存用例（一次写事务）与草稿水位线。
 * 3. {@link ./repositories/index.js} —— 实体读写（P1-A3，见 `docs/项目台账.md`，已落地）。
 * 4. {@link ./export/index.js} —— 恢复点与导出（P1-B3）：一致快照、清单、校验、恢复。
 *
 * 🔴 关键纪律（设计文档 `06-数据与本地存储.md`）：
 * - DB 执行器**独占写连接**；写事务内不得等待网络。
 * - 正文、revision 与 outbox 必须在**同一事务**保存。
 * - 新列必须走新迁移，不得改已发布迁移或 `SCHEMA_DDL`。
 *
 * 🔴 本包不得被 `packages/domain` 反向依赖，也不得 import Electron / Fastify / DOM：
 *    它要在桌面（better-sqlite3）与移动端（原生 SQLite）之间共享同样的用例语义。
 *
 * ⚠️ `./repositories/index.js` 只写实体表，**不写 `revisions` / `operations` / `outbox`**；
 *    同步可见性由 `@yfe/application` 的用例层保证（实体变更必须与 outbox 同事务）。
 */

export * from './schema/index.js'
export * from './saveDraft/index.js'
export * from './repositories/index.js'
export * from './export/index.js'
