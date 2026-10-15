/**
 * `remote_commands` 仓储 —— 远程命令的落库、领取（租约）与回执（幂等）。
 *
 * ## 为什么把这三件事放在一个模块里
 *
 * 「领取」与「回执」不是普通的 CRUD，而是两个**状态机跃迁**：
 *
 * - 领取：`pending → claimed`，同时写 `claimed_by_device_id` / `lease_expires_at`。
 *   领取**不是删除**：设备领完崩溃，租约到期后必须能重新领取（契约
 *   `CommandClaimOutput.leaseExpiresAt` 的注释写明了这个动机）。
 * - 回执：`claimed → acked | failed`，并且**天然幂等**：设备重连后会重复上报
 *   同一次执行，服务端必须只返回原结果、不再写第二次。
 *
 * 把跃迁条件写在 SQL 的 `WHERE` 里（而不是先读后写的两步判断），再整体包一个
 * `tx()`，是为了让"谁先到"由数据库裁决；进程内的读-判-写在并发下会漏。
 *
 * ## 时间纪律
 *
 * 🔴 一律用**注入时钟**（调用方传入的 `UtcTimestamp`），SQL 里**绝不**出现
 * `datetime('now')` / `strftime`：命令的过期与租约必须能被测试与运维时钟控制，
 * 而且把过期判定藏在 SQLite 里会让"同一份数据在不同方言下结果不同"。
 * 时间比较在 JS 里用 `Date.parse` 做（写入与读取的格式都由本模块的
 * `toISOString()` 保证），因此不受 SQLite 字符串比较规则影响。
 *
 * ## 过期
 *
 * `expires_at <= now` 的**非终态**命令（`pending` / `claimed`）在领取路径上被置为
 * `expired`（`expired` 是终态，不会被回执改写）。注意命令的 `expires_at`（命令
 * 总存活期）与租约的 `lease_expires_at`（单次领取的占用期）是**两个**时间：
 * 租约过期但命令未过期 → 可被重新领取；命令过期 → 直接死掉。
 */

import { newIds } from '@yfe/contracts'
import type {
  DeviceId,
  RemoteCommand,
  RemoteCommandStatus,
  RemoteCommandType,
  UtcTimestamp,
  WorkspaceId,
} from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import { tx } from './open.js'
import type { ServerDb } from './open.js'

const TABLE = SERVER_TABLES.remoteCommands

/**
 * 默认租约时长。
 *
 * 60 秒是"设备崩溃到命令可被重领"的最坏等待时间：太长会让命令卡死，太短会让
 * 一个慢命令在自己还在跑的时候被别人抢走（同一设备重领本身是幂等的，所以风险
 * 主要是重复执行）。命令侧另有 `expiresAt` 兜底。
 */
export const DEFAULT_COMMAND_LEASE_MS = 60_000

/** 契约 `RemoteCommandType` 的运行时白名单（schema 层已挡一次，这里是第二道）。 */
const COMMAND_TYPES: readonly string[] = ['workflow.run', 'job.cancel', 'sync.trigger']

/** 契约 `RemoteCommandStatus` 的运行时白名单。 */
const COMMAND_STATUSES: readonly string[] = ['pending', 'claimed', 'acked', 'expired', 'failed']

/** 非终态状态集（可被领取、可被置为 `expired`）。 */
const OPEN_STATUS_SQL = `('pending','claimed')`

const COLUMNS = [
  'command_id',
  'workspace_id',
  'target_device_id',
  'command_type',
  'args_json',
  'issuer',
  'status',
  'created_at',
  'expires_at',
  'claimed_by_device_id',
  'lease_expires_at',
  'execution_id',
  'result_json',
  'error_code',
  'acked_at',
].join(', ')

/** 仓储层返回的行（`args` / `result` 已解析成对象）。 */
export interface RemoteCommandRow {
  readonly commandId: string
  readonly workspaceId: WorkspaceId
  readonly targetDeviceId: DeviceId
  readonly commandType: RemoteCommandType
  readonly args: Readonly<Record<string, unknown>>
  readonly issuer: string
  readonly status: RemoteCommandStatus
  readonly createdAt: UtcTimestamp
  readonly expiresAt: UtcTimestamp
  readonly claimedByDeviceId: DeviceId | null
  readonly leaseExpiresAt: UtcTimestamp | null
  readonly executionId: string | null
  readonly result: Readonly<Record<string, unknown>> | null
  readonly errorCode: string | null
  readonly ackedAt: UtcTimestamp | null
}

interface RawRemoteCommandRow {
  readonly command_id: string
  readonly workspace_id: string
  readonly target_device_id: string
  readonly command_type: string
  readonly args_json: string
  readonly issuer: string
  readonly status: string
  readonly created_at: string
  readonly expires_at: string
  readonly claimed_by_device_id: string | null
  readonly lease_expires_at: string | null
  readonly execution_id: string | null
  readonly result_json: string | null
  readonly error_code: string | null
  readonly acked_at: string | null
}

/**
 * JSON 列解析。
 *
 * 这里的抛错是**故意**的：`args_json` / `result_json` 只由本模块写入，出现非对象
 * JSON 说明数据被外部改写过。悄悄退化成 `{}` 会让一条来源不明的命令被当成
 * "无参数命令"执行 —— 那比 500 危险得多（错误只进日志的 `cause`，见
 * `http/errors.ts` 的错误边界）。
 */
function parseJsonObject(raw: string | null, column: string): Readonly<Record<string, unknown>> | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`remote_commands.${column} 不是合法 JSON，数据可能被外部改写。`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`remote_commands.${column} 必须是 JSON 对象，数据可能被外部改写。`)
  }
  return parsed as Readonly<Record<string, unknown>>
}

function mapRow(raw: RawRemoteCommandRow): RemoteCommandRow {
  if (!COMMAND_TYPES.includes(raw.command_type)) {
    throw new Error(`remote_commands.command_type 取值非法（${raw.command_type}），数据可能被外部改写。`)
  }
  if (!COMMAND_STATUSES.includes(raw.status)) {
    throw new Error(`remote_commands.status 取值非法（${raw.status}），数据可能被外部改写。`)
  }
  return {
    commandId: raw.command_id,
    workspaceId: raw.workspace_id as WorkspaceId,
    targetDeviceId: raw.target_device_id as DeviceId,
    commandType: raw.command_type as RemoteCommandType,
    args: parseJsonObject(raw.args_json, 'args_json') ?? {},
    issuer: raw.issuer,
    status: raw.status as RemoteCommandStatus,
    createdAt: raw.created_at as UtcTimestamp,
    expiresAt: raw.expires_at as UtcTimestamp,
    claimedByDeviceId: raw.claimed_by_device_id as DeviceId | null,
    leaseExpiresAt: raw.lease_expires_at as UtcTimestamp | null,
    executionId: raw.execution_id,
    result: parseJsonObject(raw.result_json, 'result_json'),
    errorCode: raw.error_code,
    ackedAt: raw.acked_at as UtcTimestamp | null,
  }
}

/**
 * 转成**契约**形状。
 *
 * 只列契约里的字段：`claimed_by_device_id` / `lease_expires_at` / `execution_id`
 * 等内部列**绝不出现在响应里**（`execution_id` 是幂等键，泄露出去等于让别人
 * 能替设备回执）。
 */
export function toRemoteCommand(row: RemoteCommandRow): RemoteCommand {
  return {
    commandId: row.commandId,
    workspaceId: row.workspaceId,
    targetDeviceId: row.targetDeviceId,
    commandType: row.commandType,
    args: row.args,
    expiresAt: row.expiresAt,
    issuer: row.issuer,
    status: row.status,
    createdAt: row.createdAt,
  }
}

export interface InsertRemoteCommandInput {
  readonly commandId: string
  readonly workspaceId: WorkspaceId
  readonly targetDeviceId: DeviceId
  readonly commandType: RemoteCommandType
  readonly args: Readonly<Record<string, unknown>>
  readonly issuer: string
  readonly at: UtcTimestamp
  readonly expiresAt: UtcTimestamp
}

/** 落一条 `pending` 命令。`command_id` 由调用方用契约生成器生成。 */
export function insertRemoteCommand(db: ServerDb, input: InsertRemoteCommandInput): RemoteCommandRow {
  db.prepare(
    `INSERT INTO ${TABLE} (
       command_id, workspace_id, target_device_id, command_type, args_json, issuer,
       status, created_at, expires_at, claimed_by_device_id, lease_expires_at,
       execution_id, result_json, error_code, acked_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
  ).run(
    input.commandId,
    input.workspaceId,
    input.targetDeviceId,
    input.commandType,
    JSON.stringify(input.args),
    input.issuer,
    input.at,
    input.expiresAt,
  )

  const row = findRemoteCommandById(db, input.commandId)
  if (row === null) {
    throw new Error('远程命令写入后无法读回，数据库可能不可用。')
  }
  return row
}

export function findRemoteCommandById(db: ServerDb, commandId: string): RemoteCommandRow | null {
  const raw = db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE command_id = ?`).get(commandId) as
    | RawRemoteCommandRow
    | undefined
  return raw === undefined ? null : mapRow(raw)
}

/** 某台设备的全部命令（含终态），按创建时间升序。给设备侧诊断与测试用。 */
export function listRemoteCommandsForDevice(db: ServerDb, deviceId: DeviceId): readonly RemoteCommandRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE target_device_id = ? ORDER BY created_at ASC, command_id ASC`)
    .all(deviceId) as RawRemoteCommandRow[]
  return rows.map(mapRow)
}

/**
 * 把 `expires_at <= at` 的非终态命令置为 `expired`，返回被改掉的 commandId。
 *
 * 不做内部的 `tx()`：调用方（领取路径）已经在事务里，嵌套事务会创建 SAVEPOINT
 * 而这里根本没有回滚需求。过期是**单向**的，重复调用天然幂等。
 */
export function expireStaleRemoteCommands(db: ServerDb, at: UtcTimestamp): readonly string[] {
  const atMs = Date.parse(at)
  const rows = db
    .prepare(`SELECT command_id, expires_at FROM ${TABLE} WHERE status IN ${OPEN_STATUS_SQL}`)
    .all() as { readonly command_id: string; readonly expires_at: string }[]

  const stale = rows.filter((row) => Date.parse(row.expires_at) <= atMs).map((row) => row.command_id)
  if (stale.length === 0) return []

  const update = db.prepare(`UPDATE ${TABLE} SET status = 'expired' WHERE command_id = ? AND status IN ${OPEN_STATUS_SQL}`)
  for (const commandId of stale) update.run(commandId)
  return stale
}

export interface ClaimRemoteCommandInput {
  readonly deviceId: DeviceId
  readonly at: UtcTimestamp
  /** 本次领取的租约时长（毫秒）。 */
  readonly leaseTtlMs: number
  /**
   * 设备自带的执行 ID（可选）。
   *
   * 契约的 `CommandClaimOutput` 里**没有** `executionId`，而回执要求"执行 ID 必须与
   * 领取时一致"，所以领取时若带上就绑定下来；没带则由服务端生成一个。绑定只发生在
   * **第一次**领取：重新领取不改写 `execution_id`，否则设备崩溃重领后第一次的
   * 回执会全部变成"执行 ID 不一致"。
   */
  readonly executionId?: string | null
}

export interface ClaimedRemoteCommand {
  readonly command: RemoteCommandRow
  readonly leaseExpiresAt: UtcTimestamp
}

/**
 * 领一条命令：`target_device_id = 自己` 且（`pending`，或租约已过期的 `claimed`），
 * 按 `created_at ASC` 取最早的一条。没有可领的返回 `null`。
 */
export function claimRemoteCommand(db: ServerDb, input: ClaimRemoteCommandInput): ClaimedRemoteCommand | null {
  return tx(db, () => {
    // 先把已经死掉的命令落成 expired，再挑候选：否则一条过期命令会被当成
    // "可领取"发出去，设备执行完才发现服务端根本不认。
    expireStaleRemoteCommands(db, input.at)

    const atMs = Date.parse(input.at)
    const candidates = db
      .prepare(
        `SELECT ${COLUMNS} FROM ${TABLE}
          WHERE target_device_id = ? AND status IN ${OPEN_STATUS_SQL}
          ORDER BY created_at ASC, command_id ASC`,
      )
      .all(input.deviceId) as RawRemoteCommandRow[]

    const pick = candidates
      .map(mapRow)
      .find((row) => {
        if (Date.parse(row.expiresAt) <= atMs) return false
        if (row.status === 'pending') return true
        // 租约已过期（或从未写过租约）→ 上一次领取已经失效，可以重领。
        return row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) <= atMs
      })
    if (pick === undefined) return null

    const leaseExpiresAt = new Date(atMs + input.leaseTtlMs).toISOString() as UtcTimestamp
    const executionId = pick.executionId ?? input.executionId ?? newIds.request()

    // 🔴 跃迁条件写在 WHERE 里：若这期间别人（另一个进程 / 上一次并发请求）把状态
    // 改掉了，`changes` 会是 0，本调用返回 null 而不是覆盖它。
    const changes = db
      .prepare(
        `UPDATE ${TABLE}
            SET status = 'claimed', claimed_by_device_id = ?, lease_expires_at = ?, execution_id = ?
          WHERE command_id = ? AND status IN ${OPEN_STATUS_SQL}`,
      )
      .run(input.deviceId, leaseExpiresAt, executionId, pick.commandId).changes
    if (changes !== 1) return null

    const command = findRemoteCommandById(db, pick.commandId)
    if (command === null) return null
    return { command, leaseExpiresAt }
  })
}

/** 回执失败原因。路由层把它翻成契约错误码（见 `routes/commands.ts`）。 */
export type AckRemoteCommandFailure = 'not_found' | 'not_owned' | 'execution_mismatch' | 'invalid_state'

export interface AckRemoteCommandInput {
  readonly commandId: string
  /** 回执方设备。**必须**是命令的目标设备。 */
  readonly deviceId: DeviceId
  readonly executionId: string
  readonly status: 'succeeded' | 'failed'
  readonly result?: Readonly<Record<string, unknown>> | null
  readonly errorCode?: string | null
  readonly at: UtcTimestamp
}

export type AckRemoteCommandResult =
  | { readonly ok: true; readonly command: RemoteCommandRow; readonly duplicate: boolean }
  | { readonly ok: false; readonly failure: AckRemoteCommandFailure }

/**
 * 回执：`claimed → acked | failed`。
 *
 * **幂等**：已经终态的命令再回执一次，直接返回**库里原来那一行**（`duplicate: true`），
 * 不做任何写操作 —— `acked_at` / `result_json` / `error_code` 都不会被第二次上报覆盖。
 * 设备重连后重复上报是常态，覆盖会丢掉真实的执行结果。
 *
 * 幂等键是 `execution_id`：终态命令遇到不同的 executionId 视为"另一次执行的报告"，
 * 返回 `execution_mismatch`（路由层翻成 409 `STATE_INVALID_TRANSITION`）。
 */
export function ackRemoteCommand(db: ServerDb, input: AckRemoteCommandInput): AckRemoteCommandResult {
  return tx(db, () => {
    const existing = findRemoteCommandById(db, input.commandId)
    if (existing === null) return { ok: false, failure: 'not_found' }
    if (existing.targetDeviceId !== input.deviceId) return { ok: false, failure: 'not_owned' }

    if (existing.status === 'acked' || existing.status === 'failed') {
      if (existing.executionId !== input.executionId) return { ok: false, failure: 'execution_mismatch' }
      return { ok: true, command: existing, duplicate: true }
    }
    // `pending`（没人领过，不可能有匹配的执行 ID）、`expired`（已经死掉）都不接受回执。
    if (existing.status !== 'claimed') return { ok: false, failure: 'invalid_state' }
    if (existing.executionId !== null && existing.executionId !== input.executionId) {
      return { ok: false, failure: 'execution_mismatch' }
    }

    const status: RemoteCommandStatus = input.status === 'succeeded' ? 'acked' : 'failed'
    const resultJson = input.result === undefined || input.result === null ? null : JSON.stringify(input.result)
    // 成功回执里即使带了 errorCode 也不记：成功就是成功，留着会让人以为"成功了但报错"。
    const errorCode = input.status === 'failed' ? (input.errorCode ?? null) : null

    const changes = db
      .prepare(
        `UPDATE ${TABLE}
            SET status = ?, execution_id = ?, result_json = ?, error_code = ?, acked_at = ?
          WHERE command_id = ? AND status = 'claimed'`,
      )
      .run(status, input.executionId, resultJson, errorCode, input.at, input.commandId).changes
    if (changes !== 1) return { ok: false, failure: 'invalid_state' }

    const updated = findRemoteCommandById(db, input.commandId)
    if (updated === null) return { ok: false, failure: 'invalid_state' }
    return { ok: true, command: updated, duplicate: false }
  })
}
