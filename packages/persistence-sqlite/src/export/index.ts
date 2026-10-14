/**
 * `@yfe/persistence-sqlite/export` —— 恢复点与导出。
 *
 * 三层：
 * 1. {@link ./manifest.js} —— 清单的构建、序列化与**严格**解析（缺字段即报错，不补默认值）；
 * 2. {@link ./backup.js}   —— `VACUUM INTO` 一致快照 + 清单，成对写出、失败成对清理；
 * 3. {@link ./restore.js}  —— 先校验源、再复制到临时副本并二次校验、最后原子换名。
 *
 * 🔴 判据（设计文档）：
 * - `06-数据与本地存储.md:49`：备份用 SQLite 在线备份机制，**禁止只复制主文件而遗漏活动 WAL**；
 * - `06:73`：恢复点含库版本/同步协议/附件清单与校验，**先在隔离目录验证再切换服务**；
 * - `06:69`：库比程序新时**拒绝写入**（`STORAGE_SCHEMA_TOO_NEW`）并给出兼容导出或恢复指引；
 * - `11-测试验收与迁移.md:48`：恢复必须在新实例完成校验，**不能只验证备份文件存在**。
 *
 * 🔴 本模块只依赖 `node:fs` / `node:crypto` / `node:path` 与 SQLite 驱动，
 *    不 import Electron / Fastify / DOM，与包内其它层保持同一约束。
 */

export * from './manifest.js'
export * from './fsErrors.js'
export * from './backup.js'
export * from './restore.js'
