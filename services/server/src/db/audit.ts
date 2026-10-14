/**
 * 审计事件仓储。
 *
 * 设计依据（`04-后端与安全.md`）：审计记录登录、设备撤销、权限修改、插件授权、
 * 远程命令与恢复操作，**不默认收集正文**。
 *
 * 🔴 这张表**只增不改**：本文件刻意不提供 UPDATE / DELETE 路径。
 * 一条可以被事后修改的审计记录在事故复盘中没有价值——它会首先被怀疑是伪造的。
 * 清理策略（按保留期归档）属于运维操作，必须走独立的、可审计的路径，
 * 而不是在应用代码里留一个 `deleteAuditEvent` 让人顺手调用。
 *
 * 🔴 `detail_json` 只放**结构化动作参数**：字段名、目标 ID、变更前后的角色。
 * 绝不放稿件正文、密码、配对码明文、令牌（哪怕是摘要）与绝对路径。
 * 这些内容是"正文与秘密"，会让审计表本身变成泄露源。
 */

import { newIds } from '@yfe/contracts'
import type { DeviceId, RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

/**
 * 审计动作名。
 *
 * 用集中常量而不是散落的字符串：`audit_events.action` 会被运维查询与告警规则引用，
 * 拼错一个字母不会报错，只会让审计面板上少一类事件——这种缺陷在事故前不会被发现。
 */
export const AUDIT_ACTIONS = {
  setupCompleted: 'setup.completed',
  loginSucceeded: 'auth.login.succeeded',
  loginFailed: 'auth.login.failed',
  logout: 'auth.logout',
  refreshRotated: 'auth.refresh.rotated',
  refreshReuseDetected: 'auth.refresh.reuse_detected',
  sessionRevoked: 'auth.session.revoked',
  devicePaired: 'device.paired',
  deviceRevoked: 'device.revoked',
  deviceRenamed: 'device.renamed',
  pairingCodeIssued: 'pairing_code.issued',
  pairingCodeFailed: 'pairing_code.failed',
  memberAdded: 'member.added',
  memberRoleChanged: 'member.role_changed',
  memberRemoved: 'member.removed',
  userCreated: 'user.created',
  userDisabled: 'user.disabled',
  userEnabled: 'user.enabled',
  passwordReset: 'user.password_reset',
  // 同步批次：接受与"整批拒绝"都要留痕。"拒绝"不是错误日志的噪声，
  // 而是"谁在什么时候基于过期基线提交过什么"的唯一线索（冲突排查靠它）。
  syncBatchAccepted: 'sync.batch.accepted',
  syncBatchRejected: 'sync.batch.rejected',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

/** 结果语义与表上的 CHECK 一致。`denied` 专指权限拒绝（与"业务失败"区分）。 */
export type AuditOutcome = 'success' | 'failure' | 'denied'

export interface AuditEventRow {
  readonly id: string
  readonly at: UtcTimestamp
  readonly action: string
  readonly actorUserId: UserId | null
  readonly actorDeviceId: DeviceId | null
  readonly targetType: string | null
  readonly targetId: string | null
  readonly workspaceId: WorkspaceId | null
  readonly requestId: RequestId | null
  readonly outcome: AuditOutcome
  readonly detail: Readonly<Record<string, string | number | boolean | null>> | null
  readonly clientIp: string | null
}

interface RawAuditRow {
  readonly id: string
  readonly at: string
  readonly action: string
  readonly actor_user_id: string | null
  readonly actor_device_id: string | null
  readonly target_type: string | null
  readonly target_id: string | null
  readonly workspace_id: string | null
  readonly request_id: string | null
  readonly outcome: string
  readonly detail_json: string | null
  readonly client_ip: string | null
}

const AUDIT_COLUMNS = `id, at, action, actor_user_id, actor_device_id, target_type, target_id,
  workspace_id, request_id, outcome, detail_json, client_ip`

/**
 * `detail_json` 的解析。
 *
 * 解析失败**不抛异常**，而是降级为 `null`：
 * 审计读取路径（运维面板）不应该因为一条历史记录格式损坏就整体 500。
 * 但也不静默丢失——`AuditEventRow.detail` 为 `null` 时调用方能看到"这条没有明细"。
 */
function parseDetail(raw: string | null): Readonly<Record<string, string | number | boolean | null>> | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, string | number | boolean | null>
  } catch {
    return null
  }
}

function toAuditEvent(raw: RawAuditRow): AuditEventRow {
  return {
    id: raw.id,
    at: raw.at as UtcTimestamp,
    action: raw.action,
    actorUserId: raw.actor_user_id as UserId | null,
    actorDeviceId: raw.actor_device_id as DeviceId | null,
    targetType: raw.target_type,
    targetId: raw.target_id,
    workspaceId: raw.workspace_id as WorkspaceId | null,
    requestId: raw.request_id as RequestId | null,
    outcome: (raw.outcome === 'success' || raw.outcome === 'denied' ? raw.outcome : 'failure') as AuditOutcome,
    detail: parseDetail(raw.detail_json),
    clientIp: raw.client_ip,
  }
}

export interface RecordAuditInput {
  readonly action: string
  readonly outcome: AuditOutcome
  readonly at: UtcTimestamp
  readonly actorUserId?: UserId | null
  readonly actorDeviceId?: DeviceId | null
  readonly targetType?: string | null
  readonly targetId?: string | null
  readonly workspaceId?: WorkspaceId | null
  readonly requestId?: RequestId | null
  readonly detail?: Readonly<Record<string, string | number | boolean | null>> | null
  readonly clientIp?: string | null
}

export function generateAuditEventId(): string {
  // 复用契约的随机源，保持 ID 形状统一（`isWellFormedId` 可校验）。
  return newIds.request().replace(/^req_/, 'aud_')
}

/**
 * 写入一条审计记录。
 *
 * 🔴 审计写入失败**不抛出**，只返回 `false`。
 * 理由：审计是旁路，不是主流程的成败条件。如果"登录成功但审计写失败"直接抛异常，
 * 用户会看到登录失败（实际上会话已经建立），而重试又会再建一条会话——
 * 这比丢一条审计记录糟糕得多。调用方应在 `false` 时记一条**结构化告警日志**
 * （进程日志本身也是审计的第二副本），而不是把异常抛给用户。
 */
export function recordAuditEvent(db: ServerDb, input: RecordAuditInput): boolean {
  try {
    db.prepare(
      `INSERT INTO ${SERVER_TABLES.auditEvents}
         (id, at, action, actor_user_id, actor_device_id, target_type, target_id,
          workspace_id, request_id, outcome, detail_json, client_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      generateAuditEventId(),
      input.at,
      input.action,
      input.actorUserId ?? null,
      input.actorDeviceId ?? null,
      input.targetType ?? null,
      input.targetId ?? null,
      input.workspaceId ?? null,
      input.requestId ?? null,
      input.outcome,
      input.detail === undefined || input.detail === null ? null : JSON.stringify(input.detail),
      input.clientIp ?? null,
    )
    return true
  } catch {
    return false
  }
}

export interface AuditQuery {
  readonly action?: string
  readonly actorUserId?: UserId
  readonly workspaceId?: WorkspaceId
  readonly since?: UtcTimestamp
  readonly until?: UtcTimestamp
  /** 上限。默认 100，强制上限 1000：审计查询不能变成全表导出。 */
  readonly limit?: number
}

/** 查询审计记录（按时间倒序）。运维排查与测试断言用。 */
export function queryAuditEvents(db: ServerDb, query: AuditQuery = {}): readonly AuditEventRow[] {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (query.action !== undefined) {
    clauses.push('action = ?')
    params.push(query.action)
  }
  if (query.actorUserId !== undefined) {
    clauses.push('actor_user_id = ?')
    params.push(query.actorUserId)
  }
  if (query.workspaceId !== undefined) {
    clauses.push('workspace_id = ?')
    params.push(query.workspaceId)
  }
  if (query.since !== undefined) {
    clauses.push('at >= ?')
    params.push(query.since)
  }
  if (query.until !== undefined) {
    clauses.push('at <= ?')
    params.push(query.until)
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const rows = db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM ${SERVER_TABLES.auditEvents}${where} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as RawAuditRow[]
  return rows.map(toAuditEvent)
}

export function countAuditEvents(db: ServerDb, action?: string): number {
  const row =
    action === undefined
      ? (db
          .prepare(`SELECT COUNT(*) AS count FROM ${SERVER_TABLES.auditEvents}`)
          .get() as { count: number })
      : (db
          .prepare(`SELECT COUNT(*) AS count FROM ${SERVER_TABLES.auditEvents} WHERE action = ?`)
          .get(action) as { count: number })
  return row.count
}
