/**
 * 运维存储面路由（task-16 / P3-C5）：`/api/v1/admin/storage`。
 *
 * ## 权限模型
 *
 * 这五个端点全部是**系统管理员（`server_state.owner_user_id`）专属**，
 * 每个路由挂 `deps.guards.requireSession`（建立身份），进 handler 第一件事是
 * `requireSystemAdmin`（判定"是不是这台实例的所有者"）。
 *
 * 「会话有效」不等于「是管理员」：任何登录用户都有有效会话。后端实例只有一个
 * 所有者（初始化时写入 `server_state.owner_user_id`），换人的唯一途径是重新初始化，
 * 所以这里直接与这个字段比对，而不是看角色——`users.role` 是**工作区**角色，
 * 跟"能不能恢复整库"没有关系。
 *
 * ## 为什么恢复要三道闸门
 *
 * 恢复会**销毁当前库**。所以：① 系统管理员；② `maintenance: true`（运维语义的
 * 自我确认，防止误点）；③ 重新输入当前管理员密码（二次认证，防止"浏览器会话被
 * 别人短暂拿到"就换库）。少任何一道都拒绝。
 *
 * ## 响应体
 *
 * 不回传堆栈、不回传秘密、不回传绝对路径——**唯一例外**是：
 * - `GET /api/v1/admin/storage` 回的 `dataDir`/`databasePath`/根路径（这个端点的
 *   存在意义就是让管理员看清路径，且仅管理员可见）；
 * - `POST /probe` 回的 `resolvedPath`/`realPath`（管理员自己传来的路径，
 *   他本来就知道）。
 * 备份列表**只回文件名**。
 */

import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { RequestId, UserId, UtcTimestamp } from '@yfe/contracts'

import { verifyPassword } from '../auth/password.js'
import type { Principal } from '../auth/permission.js'
import { requireSystemAdmin } from '../db/admin.js'
import { recordAuditEvent } from '../db/audit.js'
import { SERVER_SCHEMA_VERSION } from '../db/ddl.js'
import { appliedServerMigrations, SERVER_MIGRATIONS_TABLE } from '../db/migrator.js'
import { hasTable } from '../db/open.js'
import type { ServerDb } from '../db/open.js'
import { findUserById, findUserWithCredentialByUsername, normalizeUsername } from '../db/users.js'
import { currentPrincipal, type PermissionGuards } from '../permission/index.js'
import {
  BACKUP_MANIFEST_VERSION,
  createStorageBackup,
  listStorageBackups,
  restoreStorageBackup,
  verifyCopiedDatabaseFile,
  verifyStorageBackup,
} from '../storage/backup.js'
import { fileSizeOrNull, pathExists } from '../storage/localFs.js'
import { createAssetStorage } from '../storage/index.js'
import {
  diskSpaceOf,
  fail,
  probeRootsFromDataDir,
  probeStorageTarget,
  resolveAdminStoragePath,
  STORAGE_PROBE_KINDS,
  type StorageProbeKind,
  type StorageProbeRoots,
} from '../storage/probe.js'

/** 存储审计动作名。审计表用自由字符串，这里集中定义避免手打错字。 */
export const STORAGE_AUDIT_ACTIONS = {
  probe: 'storage.probe',
  backupCreated: 'storage.backup.create',
  backupVerified: 'storage.backup.verify',
  backupRestored: 'storage.backup.restore',
} as const

export interface AdminStorageRouteDeps {
  readonly db: ServerDb
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  /** `config.dataDir`：探测的"内部"边界。 */
  readonly dataDir: string
  /** `config.databasePath`：概览要看的库文件。 */
  readonly databasePath: string
  /** 附件存储根（`storageRootFromDataDir(config.dataDir)`）。 */
  readonly storageRoot: string
  /** 备份根，默认 `<dataDir>/backups`。 */
  readonly backupRoot?: string
  /** 写进备份清单的应用版本，默认取契约里的 `APP_VERSION`。 */
  readonly appVersion?: string
  readonly log?: (line: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// 鉴权 / 审计 / 小工具
// ---------------------------------------------------------------------------

/**
 * 系统管理员判定只走 `db/admin.ts`（唯一真相源：`server_state.owner_user_id`）。
 * 请求体/查询串里的任何 `role` / `isAdmin` 都不参与判定。
 */
function requireAdmin(db: ServerDb, request: FastifyRequest, requestId: RequestId): Principal {
  const principal = currentPrincipal(request)
  requireSystemAdmin(db, principal.userId, requestId)
  return principal
}

interface AuditInput {
  readonly action: string
  readonly outcome: 'success' | 'failure' | 'denied'
  readonly at: UtcTimestamp
  readonly requestId: RequestId
  readonly actorUserId: UserId
  readonly targetType?: string
  readonly targetId?: string | null
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * 审计是**旁路**：写不进去（表缺失/磁盘满）不能把已经成功的运维操作变成 500，
 * 否则管理员会重试一次已经生效的恢复。失败只落日志。
 */
function audit(deps: AdminStorageRouteDeps, input: AuditInput): void {
  try {
    recordAuditEvent(deps.db, {
      action: input.action,
      outcome: input.outcome,
      at: input.at,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      detail: input.detail ?? null,
    })
  } catch (thrown) {
    deps.log?.({ level: 'warn', event: 'admin_storage.audit_failed', action: input.action, reason: String(thrown) })
  }
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
  return body as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, field: string, requestId: RequestId): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    fail('VALIDATION_MISSING_FIELD', `缺少必填字段：${field}`, requestId, { field })
  }
  return value
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean {
  return body[field] === true
}

function parseProbeKind(value: unknown, requestId: RequestId): StorageProbeKind {
  if (typeof value === 'string' && (STORAGE_PROBE_KINDS as readonly string[]).includes(value)) {
    return value as StorageProbeKind
  }
  fail('VALIDATION_FAILED', 'kind 必须是 data / backup / asset 之一。', requestId, {
    field: 'kind',
    reason: 'unknown_kind',
  })
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store')
}

// ---------------------------------------------------------------------------
// 请求体 Schema
// ---------------------------------------------------------------------------

const PROBE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetPath', 'kind'],
  properties: {
    targetPath: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: [...STORAGE_PROBE_KINDS] },
    acknowledgeExternal: { type: 'boolean' },
  },
} as const

const BACKUP_CREATE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { fileName: { type: 'string', minLength: 1, maxLength: 200 } },
} as const

const BACKUP_PATH_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['backupPath'],
  properties: {
    backupPath: { type: 'string', minLength: 1 },
    acknowledgeExternal: { type: 'boolean' },
  },
} as const

const RESTORE_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['backupPath', 'targetPath', 'confirmPassword', 'maintenance'],
  properties: {
    backupPath: { type: 'string', minLength: 1 },
    targetPath: { type: 'string', minLength: 1 },
    confirmPassword: { type: 'string', minLength: 1 },
    maintenance: { type: 'boolean' },
    overwrite: { type: 'boolean' },
    acknowledgeExternal: { type: 'boolean' },
  },
} as const

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export function registerAdminStorageRoutes(app: FastifyInstance, deps: AdminStorageRouteDeps): void {
  const rootsOf = (requestId: RequestId): StorageProbeRoots =>
    probeRootsFromDataDir(deps.dataDir, requestId, {
      storageRoot: deps.storageRoot,
      ...(deps.backupRoot === undefined ? {} : { backupRoot: deps.backupRoot }),
    })

  // -------------------------------------------------------------------------
  // 1. 概览
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/admin/storage',
    { preHandler: deps.guards.requireSession },
    async (request, reply) => {
      const requestId = request.id as RequestId
      requireAdmin(deps.db, request, requestId)
      const roots = rootsOf(requestId)
      const warnings: string[] = []

      const databaseBytes = fileSizeOrNull(deps.databasePath)
      if (databaseBytes === null) warnings.push('database_file_missing')
      const walBytes = fileSizeOrNull(`${deps.databasePath}-wal`)
      const shmBytes = fileSizeOrNull(`${deps.databasePath}-shm`)

      const migrationsApplied = hasTable(deps.db, SERVER_MIGRATIONS_TABLE)
        ? appliedServerMigrations(deps.db).length
        : 0

      // 附件对象统计：走 `createAssetStorage`（唯一通道），不自己拼 objects 路径。
      let objectCount = 0
      let objectBytes = 0
      try {
        const storage = createAssetStorage(roots.assetRoot)
        for (const storageKey of storage.listObjectFiles()) {
          objectCount += 1
          objectBytes += storage.objectSizeOrNull(storageKey) ?? 0
        }
      } catch (thrown) {
        // 附件根还不存在是"没上传过任何东西"的正常状态，不是错误。
        warnings.push('asset_root_unreadable')
        deps.log?.({ level: 'warn', event: 'admin_storage.asset_scan_failed', reason: String(thrown) })
      }

      const backups = listStorageBackups(roots.backupRoot, requestId)
      const backupBytes = backups.reduce((sum, entry) => sum + entry.bytes, 0)

      // 磁盘空间：取不到就是 null。编一个 0 = "磁盘满了"，会引发一次假故障。
      const disk = diskSpaceOf(roots.dataDir)

      return noStore(reply)
        .status(200)
        .send({
          dataDir: roots.dataDir,
          databasePath: deps.databasePath,
          database: {
            bytes: databaseBytes,
            walBytes,
            shmBytes,
            schemaVersion: hasTable(deps.db, SERVER_MIGRATIONS_TABLE)
              ? migrationsApplied === 0
                ? 0
                : maxVersion(deps.db)
              : 0,
            expectedSchemaVersion: SERVER_SCHEMA_VERSION,
            migrationsApplied,
          },
          assets: { root: roots.assetRoot, objectCount, objectBytes },
          backups: { root: roots.backupRoot, count: backups.length, totalBytes: backupBytes },
          disk: { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes },
          warnings,
        })
    },
  )

  // -------------------------------------------------------------------------
  // 2. 探测目标路径
  // -------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    '/api/v1/admin/storage/probe',
    { preHandler: deps.guards.requireSession, schema: { body: PROBE_BODY_SCHEMA } },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const principal = requireAdmin(deps.db, request, requestId)
      const body = bodyOf(request)
      const targetPath = requiredString(body, 'targetPath', requestId)
      const kind = parseProbeKind(body['kind'], requestId)
      const acknowledgeExternal = optionalBoolean(body, 'acknowledgeExternal')

      const result = probeStorageTarget(
        rootsOf(requestId),
        { targetPath, kind, acknowledgeExternal },
        requestId,
      )

      // 只审计"决策"，不审计路径内容（审计表会被导出分享）。
      audit(deps, {
        action: STORAGE_AUDIT_ACTIONS.probe,
        outcome: 'success',
        at: deps.now(),
        requestId,
        actorUserId: principal.userId,
        targetType: 'storage_path',
        targetId: kind,
        detail: { kind, exists: result.exists, writable: result.writable, external: !result.insideDataDir },
      })

      return noStore(reply).status(200).send({
        resolvedPath: result.resolvedPath,
        exists: result.exists,
        isDirectory: result.isDirectory,
        readable: result.readable,
        writable: result.writable,
        insideDataDir: result.insideDataDir,
        isSymlink: result.isSymlink,
        realPath: result.realPath,
        warnings: result.warnings,
      })
    },
  )

  // -------------------------------------------------------------------------
  // 3. 创建备份
  // -------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    '/api/v1/admin/storage/backups',
    { preHandler: deps.guards.requireSession, schema: { body: BACKUP_CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const principal = requireAdmin(deps.db, request, requestId)
      const body = bodyOf(request)
      const roots = rootsOf(requestId)
      const createdAt = deps.now()

      const requested = body['fileName']
      if (requested !== undefined && typeof requested !== 'string') {
        fail('VALIDATION_FAILED', 'fileName 必须是字符串。', requestId, { field: 'fileName' })
      }

      const created = await createStorageBackup(deps.db, {
        backupRoot: roots.backupRoot,
        createdAt,
        requestId,
        ...(deps.appVersion === undefined ? {} : { appVersion: deps.appVersion }),
        ...(typeof requested === 'string' ? { fileName: requested } : {}),
      })

      audit(deps, {
        action: STORAGE_AUDIT_ACTIONS.backupCreated,
        outcome: 'success',
        at: createdAt,
        requestId,
        actorUserId: principal.userId,
        targetType: 'storage_backup',
        targetId: created.fileName,
        detail: {
          bytes: created.bytes,
          tableCount: created.manifest.tableCount,
          totalRows: created.manifest.totalRows,
          manifestVersion: BACKUP_MANIFEST_VERSION,
        },
      })

      return noStore(reply)
        .status(201)
        .send({
          fileName: created.fileName,
          bytes: created.bytes,
          sha256: created.sha256,
          databaseSchemaVersion: created.manifest.databaseSchemaVersion,
          tableCount: created.manifest.tableCount,
          totalRows: created.manifest.totalRows,
          createdAt,
          containsSecrets: created.manifest.containsSecrets,
          attachmentsIncluded: created.manifest.attachmentsIncluded,
        })
    },
  )

  // -------------------------------------------------------------------------
  // 4. 列出备份
  // -------------------------------------------------------------------------
  app.get(
    '/api/v1/admin/storage/backups',
    { preHandler: deps.guards.requireSession },
    async (request, reply) => {
      const requestId = request.id as RequestId
      requireAdmin(deps.db, request, requestId)
      const roots = rootsOf(requestId)
      const backups = listStorageBackups(roots.backupRoot, requestId)
      // 🔴 只回文件名：绝对路径会带出操作系统用户名。
      return noStore(reply).status(200).send({
        backups: backups.map((entry) => ({
          fileName: entry.fileName,
          bytes: entry.bytes,
          modifiedAt: entry.modifiedAt,
          hasManifest: entry.hasManifest,
        })),
      })
    },
  )

  // -------------------------------------------------------------------------
  // 5. 校验备份
  // -------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    '/api/v1/admin/storage/backups/verify',
    { preHandler: deps.guards.requireSession, schema: { body: BACKUP_PATH_BODY_SCHEMA } },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const principal = requireAdmin(deps.db, request, requestId)
      const body = bodyOf(request)
      const backupPath = requiredString(body, 'backupPath', requestId)
      const roots = rootsOf(requestId)

      // 先过探针的路径规则（绝对路径 / 无 NUL / 保留名 / 符号链接边界 / 外部批准），
      // 再校验内容。否则这个端点会变成"读任意文件"的预言机。
      const target = resolveAdminStoragePath(
        roots,
        { targetPath: backupPath, kind: 'backup', acknowledgeExternal: optionalBoolean(body, 'acknowledgeExternal') },
        requestId,
        'backupPath',
      )

      try {
        const verified = await verifyStorageBackup({
          databasePath: target.absolutePath,
          backupRoot: roots.backupRoot,
          requestId,
          allowExternal: target.external,
        })
        audit(deps, {
          action: STORAGE_AUDIT_ACTIONS.backupVerified,
          outcome: 'success',
          at: deps.now(),
          requestId,
          actorUserId: principal.userId,
          targetType: 'storage_backup',
          targetId: verified.fileName,
          detail: { bytes: verified.bytes, databaseSchemaVersion: verified.databaseSchemaVersion },
        })
        return noStore(reply).status(200).send({
          fileName: verified.fileName,
          bytes: verified.bytes,
          sha256: verified.sha256,
          integrityCheck: verified.integrityCheck,
          databaseSchemaVersion: verified.databaseSchemaVersion,
          expectedSchemaVersion: SERVER_SCHEMA_VERSION,
          migrations: verified.migrations.map((migration) => ({
            version: migration.version,
            checksum: migration.checksum,
            success: migration.success,
          })),
          tables: verified.tables,
          checks: verified.checks,
        })
      } catch (thrown) {
        audit(deps, {
          action: STORAGE_AUDIT_ACTIONS.backupVerified,
          outcome: 'failure',
          at: deps.now(),
          requestId,
          actorUserId: principal.userId,
          targetType: 'storage_backup',
          targetId: target.absolutePath === '' ? null : basename(target.absolutePath),
          detail: { reason: 'verify_failed' },
        })
        throw thrown
      }
    },
  )

  // -------------------------------------------------------------------------
  // 6. 恢复（管理员 + 维护模式 + 二次认证）
  // -------------------------------------------------------------------------
  app.post<{ Body: unknown }>(
    '/api/v1/admin/storage/backups/restore',
    { preHandler: deps.guards.requireSession, schema: { body: RESTORE_BODY_SCHEMA } },
    async (request, reply) => {
      const requestId = request.id as RequestId
      const principal = requireAdmin(deps.db, request, requestId)
      const body = bodyOf(request)
      const backupPath = requiredString(body, 'backupPath', requestId)
      const targetPath = requiredString(body, 'targetPath', requestId)
      const confirmPassword = requiredString(body, 'confirmPassword', requestId)
      const at = deps.now()

      // ① 维护模式：恢复期间必须停机，否则正在跑的写入会立刻污染刚恢复的库。
      if (body['maintenance'] !== true) {
        audit(deps, {
          action: STORAGE_AUDIT_ACTIONS.backupRestored,
          outcome: 'denied',
          at,
          requestId,
          actorUserId: principal.userId,
          targetType: 'storage_backup',
          targetId: basename(backupPath),
          detail: { reason: 'maintenance_required' },
        })
        fail('STATE_INVALID_TRANSITION', '恢复必须在维护模式下执行（maintenance: true）。', requestId, {
          reason: 'maintenance_required',
        })
      }

      // ② 二次认证：用**当前管理员自己的密码**再确认一次。
      // 与登录失败一样，错误消息不区分"用户不存在"和"密码错误"。
      const user = findUserById(deps.db, principal.userId)
      const credential =
        user === null ? null : findUserWithCredentialByUsername(deps.db, normalizeUsername(user.username))
      const passwordOk =
        credential !== null && (await verifyPassword(confirmPassword, credential.passwordHash))
      if (!passwordOk) {
        audit(deps, {
          action: STORAGE_AUDIT_ACTIONS.backupRestored,
          outcome: 'denied',
          at,
          requestId,
          actorUserId: principal.userId,
          targetType: 'storage_backup',
          targetId: basename(backupPath),
          detail: { reason: 'confirm_password_invalid' },
        })
        fail('AUTH_INVALID_CREDENTIALS', '密码不正确。', requestId, {
          reason: 'confirm_password_invalid',
        })
      }

      const roots = rootsOf(requestId)
      const acknowledgeExternal = optionalBoolean(body, 'acknowledgeExternal')
      const source = resolveAdminStoragePath(
        roots,
        { targetPath: backupPath, kind: 'backup', acknowledgeExternal },
        requestId,
        'backupPath',
      )
      const target = resolveAdminStoragePath(
        roots,
        { targetPath, kind: 'data', acknowledgeExternal },
        requestId,
        'targetPath',
      )

      // HTTP 服务仍持有写连接，maintenance 字段只是用户确认，不能关闭 SQLite。
      // 在线覆盖主库或 WAL/SHM 会让连接继续写旧 inode 或污染恢复文件。
      const canonicalPath = (path: string): string => {
        let absolute = resolve(path)
        try { absolute = realpathSync(absolute) } catch { /* 不存在的旁挂文件按绝对路径比较 */ }
        return process.platform === 'win32' ? absolute.toLowerCase() : absolute
      }
      const protectedPaths = ['', '-wal', '-shm'].map((suffix) => canonicalPath(`${deps.databasePath}${suffix}`))
      if (protectedPaths.includes(canonicalPath(target.absolutePath))) {
        fail('RESOURCE_LOCKED', '当前主库仍在使用，请恢复到新路径，停机后再切换数据库。', requestId, {
          reason: 'active_database_target',
        })
      }

      // 源必须是一份**校验通过**的备份：恢复前的这次校验就是"最后一道防线"。
      const sourceVerified = await verifyStorageBackup({
        databasePath: source.absolutePath,
        backupRoot: roots.backupRoot,
        requestId,
        allowExternal: source.external || target.external,
      })

      request.yfeNow = deps.now()
      await deps.guards.requireSession(request, reply)
      requireAdmin(deps.db, request, requestId)

      const restored = await restoreStorageBackup({
        requestId,
        sourcePath: source.absolutePath,
        targetPath: target.absolutePath,
        overwrite: optionalBoolean(body, 'overwrite'),
        verifyDatabase: (databasePath) => {
          verifyCopiedDatabaseFile(databasePath, { requestId, expectedBytes: sourceVerified.bytes })
        },
        onCleanupFailure: (message) => {
          deps.log?.({ level: 'error', event: 'admin_storage.cleanup_failed', reason: message })
        },
      })

      audit(deps, {
        action: STORAGE_AUDIT_ACTIONS.backupRestored,
        outcome: 'success',
        at: deps.now(),
        requestId,
        actorUserId: principal.userId,
        targetType: 'storage_backup',
        targetId: restored.backupFileName,
        detail: { bytes: restored.bytes, targetFileName: basename(restored.targetPath) },
      })

      return noStore(reply).status(200).send({
        restored: true,
        sourceFileName: restored.backupFileName,
        targetFileName: basename(restored.targetPath),
        bytes: restored.bytes,
        sha256: restored.sha256,
      })
    },
  )
}

/** 迁移台账里的最高成功版本（`currentServerSchemaVersion` 的等价物，避免重复查表）。 */
function maxVersion(db: ServerDb): number {
  const rows = appliedServerMigrations(db)
  let max = 0
  for (const row of rows) {
    if (row.success && row.version > max) max = row.version
  }
  return max
}
