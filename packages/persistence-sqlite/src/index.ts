/**
 * `@yfe/persistence-sqlite` —— SQLite 持久化索引。
 *
 * 🔴 本文件是 **P0-1 脚手架占位**，用来保证空包也能通过 `npm run typecheck`。
 * 负责人请用真实实现替换。
 *
 * 负责人：T2（`docs/项目台账.md` 任务 P1-A1 / P1-A2 / P1-A3）
 *
 * 关键纪律（设计文档 `06-数据与本地存储.md`）：
 * - DB 执行器**独占写连接**；写事务内不得等待网络。
 * - 正文、revision 与 outbox 必须在**同一事务**保存。
 * - 新列必须走新迁移，不得改已发布迁移或 `SCHEMA_DDL`。
 */

export {}
