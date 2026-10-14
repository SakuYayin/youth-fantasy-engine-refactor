/**
 * 健康检查：`GET /health/live` 与 `GET /health/ready`。
 *
 * 设计依据（`07-同步协议与API.md`）："GET /health/live、/health/ready ——
 * **路径在 API 前缀之外**，最小公开状态，详细诊断需管理员"；
 * `09-部署与运维.md` 的 healthcheck 直接 `fetch('http://127.0.0.1:8787/health/ready')`。
 *
 * ## 为什么两个端点必须存在（而且必须真的不同）
 *
 * - **live**：只回答"进程还活着吗"。它**绝不碰数据库**。如果 live 也去查库，
 *   一次数据库抖动会让编排器杀掉并重启**本来健康**的进程——重启解决不了
 *   磁盘满或库锁，只会让正在进行的写事务被迫中断，把可恢复故障变成数据风险。
 * - **ready**：回答"现在能不能接流量"。它**必须真的探测依赖**，否则它就是
 *   一个恒返回 200 的摆设，代理会把请求持续引到一台连库都打不开的进程上。
 *
 * ## 为什么 ready 的响应体既像健康报告又像错误载荷
 *
 * 因为调用方是两类：编排器只需要状态码，而**运维需要知道是哪一项挂了**。
 * 503 的响应体因此同时带契约错误字段（`code`/`message`/`requestId`/`retryable`，
 * 与其他所有接口一致，可直接被客户端统一处理）与结构化的
 * `database` / `migrations` 明细。两者共存的代价是体略大，
 * 收益是"挂了"这件事有一份稳定的、可被日志串联的证据。
 *
 * 🔴 明细里**没有**数据库路径、没有 SQLite 驱动原文、没有 SQL：
 * 失败原因被折叠成有限的枚举值（`closed` / `query_failed` / `schema_too_new` …）。
 * 健康接口是最容易被放到公网探针上的接口，它是最不该泄漏内部结构的地方。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UtcTimestamp } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { SERVER_SCHEMA_VERSION, SERVER_TABLES } from '../db/ddl.js'
import { currentServerSchemaVersion, missingServerTables } from '../db/migrator.js'
import { isServerDatabaseOpen, serverDatabasePragmaState } from '../db/open.js'
import type { ServerDb, ServerDatabasePragmaState } from '../db/open.js'
import { isServerInitialized } from '../db/serverState.js'
import { errorResponseBody } from './errors.js'

/** 数据库探测失败的原因枚举。**不允许写自由文本**（理由见文件头）。 */
export type DatabaseFailureReason = 'closed' | 'query_failed' | 'pragma_unreadable'

export type DatabaseHealth =
  | {
      readonly ok: true
      readonly journalMode: string
      readonly synchronous: string
      readonly foreignKeys: boolean
      readonly busyTimeoutMs: number
    }
  | {
      readonly ok: false
      readonly reason: DatabaseFailureReason
    }

export type MigrationsHealth =
  | {
      readonly ok: true
      readonly current: number
      readonly expected: number
    }
  | {
      readonly ok: false
      readonly reason: 'schema_too_new' | 'missing_tables' | 'unreadable'
      readonly current: number | null
      readonly expected: number
      readonly missingTables: readonly string[]
    }

export interface ReadinessReport {
  readonly ok: boolean
  readonly database: DatabaseHealth
  readonly migrations: MigrationsHealth
  readonly initialized: boolean
}

export interface HealthDeps {
  readonly db: ServerDb
  /** 进程启动时刻，用于计算 uptime。 */
  readonly startedAt: UtcTimestamp
  /** 进程启动时刻的毫秒时间戳（注入以便测试）。 */
  readonly startedAtMs: number
  /** 当前毫秒时间（注入以便测试）。 */
  readonly nowMs: () => number
}

function pragmaFields(state: ServerDatabasePragmaState): DatabaseHealth {
  return {
    ok: true,
    journalMode: state.journalMode,
    synchronous: state.synchronous,
    foreignKeys: state.foreignKeys,
    busyTimeoutMs: state.busyTimeoutMs,
  }
}

/** 真实探测数据库：连接状态 + 一条最小查询 + pragma 读取。 */
export function probeDatabase(db: ServerDb): DatabaseHealth {
  if (!isServerDatabaseOpen(db)) return { ok: false, reason: 'closed' }
  try {
    // `SELECT 1` 走完整的 prepare→step 路径：库被锁死、文件被删、
    // 句柄被关闭都会在这里暴露（而 `db.open` 为 true 时它仍可能是坏的）。
    db.prepare('SELECT 1 AS ok').get()
  } catch {
    return { ok: false, reason: 'query_failed' }
  }
  try {
    return pragmaFields(serverDatabasePragmaState(db))
  } catch {
    return { ok: false, reason: 'pragma_unreadable' }
  }
}

/**
 * 迁移状态探测。
 *
 * 三种失败分别对应三种运维动作：
 * - `schema_too_new`：库比代码新（回滚过版本）→ **不能**自动降级，要换回新版本镜像；
 * - `missing_tables`：迁移没跑完 → 重跑迁移；
 * - `unreadable`：连迁移表都读不到 → 库坏了。
 */
export function probeMigrations(db: ServerDb): MigrationsHealth {
  const expected = SERVER_SCHEMA_VERSION
  let current: number
  try {
    current = currentServerSchemaVersion(db)
  } catch {
    return { ok: false, reason: 'unreadable', current: null, expected, missingTables: [] }
  }
  if (current > expected) {
    return { ok: false, reason: 'schema_too_new', current, expected, missingTables: [] }
  }
  let missing: readonly string[]
  try {
    missing = missingServerTables(db, Object.values(SERVER_TABLES))
  } catch {
    return { ok: false, reason: 'unreadable', current, expected, missingTables: [] }
  }
  if (missing.length > 0) {
    return { ok: false, reason: 'missing_tables', current, expected, missingTables: missing }
  }
  if (current < expected) {
    // 表齐了但版本落后：迁移尚未记完账，仍是未就绪。
    return { ok: false, reason: 'missing_tables', current, expected, missingTables: [] }
  }
  return { ok: true, current, expected }
}

export function buildReadinessReport(db: ServerDb): ReadinessReport {
  const database = probeDatabase(db)
  const migrations = database.ok ? probeMigrations(db) : { ok: false as const, reason: 'unreadable' as const, current: null, expected: SERVER_SCHEMA_VERSION, missingTables: [] }
  let initialized = false
  if (database.ok && migrations.ok) {
    try {
      initialized = isServerInitialized(db)
    } catch {
      // 状态表读失败不影响"能否接流量"的判断：它只影响 setup 端点。
      initialized = false
    }
  }
  return { ok: database.ok && migrations.ok, database, migrations, initialized }
}

/**
 * 注册健康检查路由。
 *
 * 🔴 路由路径**不带** `/api/v1` 前缀（设计文档 07 明文要求）。
 * 这里用绝对路径注册，避免将来有人把整个插件挂到前缀下时悄悄改变对外契约。
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health/live', async (_request, reply) => {
    // 只依赖进程内状态：不查库、不读磁盘、不拿锁。
    const body = {
      status: 'ok' as const,
      uptimeMs: Math.max(0, deps.nowMs() - deps.startedAtMs),
      startedAt: deps.startedAt,
    }
    return reply.status(200).header('cache-control', 'no-store').send(body)
  })

  app.get('/health/ready', async (request, reply) => {
    const report = buildReadinessReport(deps.db)
    const uptimeMs = Math.max(0, deps.nowMs() - deps.startedAtMs)
    if (report.ok) {
      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .send({
          status: 'ok' as const,
          uptimeMs,
          initialized: report.initialized,
          database: report.database,
          migrations: report.migrations,
        })
    }

    const requestId = request.id as RequestId
    const payload = new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '服务依赖的数据库当前不可用，暂时无法处理请求。',
      requestId,
      detail: {
        database: report.database.ok ? 'ok' : report.database.reason,
        migrations: report.migrations.ok ? 'ok' : report.migrations.reason,
      },
    }).toPayload()

    return reply
      .status(503)
      .header('cache-control', 'no-store')
      .header('retry-after', '5')
      .send({
        ...errorResponseBody(payload, requestId),
        status: 'unavailable' as const,
        uptimeMs,
        initialized: report.initialized,
        database: report.database,
        migrations: report.migrations,
      })
  })
}
