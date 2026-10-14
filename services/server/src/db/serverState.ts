/**
 * `server_state` —— 单行服务状态表。
 *
 * 一次性初始化（`POST /api/v1/setup`）的幂等开关就是这张表：
 * `initialized_at IS NULL` 才允许 setup，置位后永久禁用引导路径
 * （设计文档 04："初始化仅可执行一次，创建所有者后立即禁用引导路径"）。
 *
 * 🔴 这个开关必须是**数据库行**而不是进程内布尔量：
 * 多副本/重启后进程内状态会丢，一个已经初始化过的服务可能再次接受 setup，
 * 那等于任何人可以重置管理员。表上的 `CHECK (id = 1)` 与
 * `CHECK ((initialized_at IS NULL) = (owner_user_id IS NULL))` 把两条不变量
 * 交给数据库强制。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { UserId, UtcTimestamp } from '@yfe/contracts'

import type { ServerDb } from './open.js'

/** 单行表固定主键。 */
const SINGLETON_ID = 1

export interface ServerStateRow {
  readonly serverId: string
  readonly initializedAt: UtcTimestamp | null
  readonly ownerUserId: UserId | null
  readonly bootstrapSecretFile: string | null
}

interface RawServerStateRow {
  readonly server_id: string
  readonly initialized_at: string | null
  readonly owner_user_id: string | null
  readonly bootstrap_secret_file: string | null
}

function toRow(raw: RawServerStateRow): ServerStateRow {
  return {
    serverId: raw.server_id,
    initializedAt: raw.initialized_at as UtcTimestamp | null,
    ownerUserId: raw.owner_user_id as UserId | null,
    bootstrapSecretFile: raw.bootstrap_secret_file,
  }
}

/**
 * 读取服务状态。新库（还没插行）返回 `null`。
 *
 * 🔴 返回 `null` 表示"确实没有这一行"，**不表示**"读失败了"。
 * 读失败会抛异常，调用方必须让异常冒泡成 5xx，绝不能把读失败当成未初始化
 * ——那会让 setup 接口在数据库故障时重新开放，等于把所有权拱手让人。
 */
export function readServerState(db: ServerDb): ServerStateRow | null {
  const raw = db
    .prepare(
      `SELECT server_id, initialized_at, owner_user_id, bootstrap_secret_file
         FROM server_state WHERE id = ?`,
    )
    .get(SINGLETON_ID) as RawServerStateRow | undefined
  return raw === undefined ? null : toRow(raw)
}

/** 初次建库时插入 server 行（幂等）。返回当前状态。 */
export function ensureServerState(
  db: ServerDb,
  serverId: string,
  bootstrapSecretFile: string | null = null,
): ServerStateRow {
  db.prepare(
    `INSERT INTO server_state (id, server_id, bootstrap_secret_file)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(SINGLETON_ID, serverId, bootstrapSecretFile)

  const state = readServerState(db)
  if (state === null) {
    // 上面刚插过还读不到，只能是并发删行或库损坏，不能静默继续。
    throw new ContractError({
      code: 'STORAGE_CORRUPT',
      message: '服务状态表缺少唯一行，数据库可能已损坏。',
      requestId: newIds.request(),
    })
  }
  return state
}

/** 服务是否已完成一次性初始化。 */
export function isServerInitialized(db: ServerDb): boolean {
  const state = readServerState(db)
  return state !== null && state.initializedAt !== null
}

/**
 * 标记初始化完成（**幂等且不可逆**）。
 *
 * 返回 `false` 表示之前已经初始化过——调用方据此返回 409/403，
 * **不能**覆盖已有所有者。所有权转移属于显式运维操作，不走这条路径。
 *
 * 用 `WHERE initialized_at IS NULL` 做条件更新而不是"先查后写"：
 * 两个并发的 setup 请求里只有一个能把 `changes` 变成 1，
 * 另一个必然拿到 0。这是原子性由数据库保证，而不是靠单线程假设。
 */
export function markServerInitialized(
  db: ServerDb,
  ownerUserId: UserId,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE server_state
          SET initialized_at = ?, owner_user_id = ?
        WHERE id = ? AND initialized_at IS NULL`,
    )
    .run(at, ownerUserId, SINGLETON_ID)
  return info.changes === 1
}
