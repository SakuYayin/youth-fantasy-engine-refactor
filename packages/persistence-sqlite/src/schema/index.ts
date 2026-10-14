/**
 * `@yfe/persistence-sqlite/schema` —— Schema 层公开出口。
 *
 * 三个模块，职责严格分离：
 * - {@link file://./ddl.ts}      —— **唯一权威**的 DDL 与迁移清单（只追加，不改已发布条目）；
 * - {@link file://./open.ts}     —— 连接打开与连接级参数（WAL / foreign_keys / busy_timeout / synchronous）；
 * - {@link file://./migrator.ts} —— 版本闸门、一致备份、单步事务迁移与台账。
 *
 * 🔴 上层（SaveDraft 事务、Repository、同步引擎）请只通过本入口使用 Schema 层：
 *    直接 import `./ddl.js` 绕过入口会让"哪些表/列是稳定接口"变得不可追踪。
 *
 * 🔴 典型用法（开库 + 迁移，然后交给业务层）：
 * ```ts
 * const db = openDatabase(dbPath)          // 默认 WAL + synchronous=full + foreign_keys=ON
 * try {
 *   migrate(db)                            // 版本过高会抛 STORAGE_SCHEMA_TOO_NEW（critical）
 * } catch (thrown) {
 *   closeDatabase(db)
 *   throw thrown                           // 🔴 绝不在迁移失败后继续用这个连接写用户数据
 * }
 * ```
 */

export * from './ddl.js'
export * from './open.js'
export * from './migrator.js'
