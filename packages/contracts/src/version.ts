/**
 * 版本协商常量。
 *
 * 设计约束：
 * - 数据 Schema 版本与**应用版本**分离：前者决定能否打开数据库，后者决定功能。
 * - 「库比程序新」必须**拒绝写入**而不是尝试兼容（`STORAGE_SCHEMA_TOO_NEW`），
 *   否则新版写入的字段会被旧版静默丢弃，造成不可逆数据损失。
 * - 协议版本独立于两者：桌面端与后端可以有版本差，但要能协商出共同能力集。
 */

/** 应用版本（与 package.json 同步维护）。 */
export const APP_VERSION = '4.0.0-dev.0' as const

/**
 * 本地数据库 Schema 版本。
 *
 * 🔴 递增规则：任何会改变**已有表结构或语义**的迁移都必须 +1。
 * 只新增索引、不改语义的优化可不动此值。
 */
export const DB_SCHEMA_VERSION = 1 as const

/**
 * 同步协议版本。
 *
 * 后端与桌面端在握手时交换此值：
 * 主版本不同 → 拒绝同步（`SYNC_PROTOCOL_MISMATCH`）；
 * 次版本不同 → 按较低一方能力集降级运行。
 */
export const SYNC_PROTOCOL_VERSION = { major: 1, minor: 0 } as const

/** IPC 通道协议版本（主进程 ↔ 渲染进程）。 */
export const IPC_PROTOCOL_VERSION = 1 as const

/** 插件 SDK 版本。插件 manifest 声明的 `apiVersion` 必须与本值主版本一致。 */
export const PLUGIN_API_VERSION = '1.0.0' as const

/** 判定期望的 schema 版本是否可被当前程序打开。 */
export type SchemaCompat = 'ok' | 'needs-migration' | 'too-new'

export function checkSchemaCompat(found: number, expected: number = DB_SCHEMA_VERSION): SchemaCompat {
  if (found === expected) return 'ok'
  if (found < expected) return 'needs-migration'
  // found > expected：程序比库旧。必须拒绝，绝不能"尽力打开"。
  return 'too-new'
}

/** 判定协议主版本是否兼容。 */
export function isProtocolCompatible(remote: { major: number; minor: number }): boolean {
  return remote.major === SYNC_PROTOCOL_VERSION.major
}
