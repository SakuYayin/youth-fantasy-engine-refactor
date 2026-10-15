/**
 * 用户仓储。
 *
 * 职责边界：只做持久化与"读失败不掩盖"，不做密码校验（那是 `../auth/password.js`）
 * 也不做会话判定（那是 `../auth/session.js`）。
 *
 * 🔴 授权主体只能从服务端会话推出，所以这里的每个读函数都返回**数据库里的角色**，
 * 绝不接受调用方传入的角色参数。
 */

import { ContractError, newIds } from '@yfe/contracts'
import type { UserId, UtcTimestamp, WorkspaceId, WorkspaceRole } from '@yfe/contracts'

import { SERVER_TABLES } from './ddl.js'
import type { ServerDb } from './open.js'

export interface UserRow {
  readonly id: UserId
  readonly username: string
  readonly displayName: string
  readonly disabled: boolean
  readonly createdAt: UtcTimestamp
  readonly updatedAt: UtcTimestamp
  readonly disabledAt: UtcTimestamp | null
}

/** 仅认证路径使用：带密码摘要。**不要**把这个结构体返回给 HTTP 层。 */
export interface UserWithCredential extends UserRow {
  readonly passwordHash: string
}

interface RawUserRow {
  readonly id: string
  readonly username: string
  readonly normalized_username: string
  readonly display_name: string
  readonly disabled: number
  readonly created_at: string
  readonly updated_at: string
  readonly disabled_at: string | null
}

interface RawCredentialRow extends RawUserRow {
  readonly password_hash: string
}

function toUser(raw: RawUserRow): UserRow {
  return {
    id: raw.id as UserId,
    username: raw.username,
    displayName: raw.display_name,
    disabled: raw.disabled !== 0,
    createdAt: raw.created_at as UtcTimestamp,
    updatedAt: raw.updated_at as UtcTimestamp,
    disabledAt: raw.disabled_at as UtcTimestamp | null,
  }
}

/**
 * 用户名归一化键。
 *
 * 用 `toLowerCase()` + `trim()` 而不是 `toLocaleLowerCase()`：后者在土耳其语环境会把
 * `I` 映射成 `ı`，同一账号在不同 locale 的服务器上会归一到不同键，表现为"密码对但登不上"。
 * 用户名字符集在路由层已限制为 ASCII，所以 ASCII 小写折叠是确定性的。
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

const USER_COLUMNS = `id, username, normalized_username, display_name, disabled, created_at, updated_at, disabled_at`

export function findUserById(db: ServerDb, id: UserId): UserRow | null {
  const raw = db
    .prepare(`SELECT ${USER_COLUMNS} FROM ${SERVER_TABLES.users} WHERE id = ?`)
    .get(id) as RawUserRow | undefined
  return raw === undefined ? null : toUser(raw)
}

/** 认证路径使用：带摘要。调用方必须立刻用完就丢，不得进日志或响应体。 */
export function findUserWithCredentialByUsername(
  db: ServerDb,
  username: string,
): UserWithCredential | null {
  const raw = db
    .prepare(
      `SELECT ${USER_COLUMNS}, password_hash FROM ${SERVER_TABLES.users} WHERE normalized_username = ?`,
    )
    .get(normalizeUsername(username)) as RawCredentialRow | undefined
  if (raw === undefined) return null
  return { ...toUser(raw), passwordHash: raw.password_hash }
}

/** 会话续期时按 userId 取回密码参数之外的一切；不需要摘要，所以不查它。 */
export function userExists(db: ServerDb, id: UserId): boolean {
  return findUserById(db, id) !== null
}

export interface CreateUserInput {
  readonly id: UserId
  readonly username: string
  readonly displayName: string
  /** 自描述的密码摘要串，由 `hashPassword()` 产出。 */
  readonly passwordHash: string
  readonly at: UtcTimestamp
}

/**
 * 创建用户。
 *
 * 用户名重复由 `normalized_username` 的 UNIQUE 约束兜底（而不是先查后插）：
 * 先查后插在并发下会同时通过检查，然后其中一个插入失败——那时错误已经发生在
 * 事务深处，回滚路径更难推理。
 */
export function createUser(db: ServerDb, input: CreateUserInput): UserRow {
  const normalized = normalizeUsername(input.username)
  if (normalized.length === 0) {
    throw new ContractError({
      code: 'VALIDATION_MISSING_FIELD',
      message: '用户名不能为空。',
      requestId: newIds.request(),
      detail: { field: 'username' },
    })
  }

  try {
    db.prepare(
      `INSERT INTO ${SERVER_TABLES.users}
         (id, username, normalized_username, display_name, password_hash, disabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(input.id, input.username, normalized, input.displayName, input.passwordHash, input.at, input.at)
  } catch (thrown) {
    if (isUniqueViolation(thrown)) {
      throw new ContractError({
        code: 'ALREADY_EXISTS',
        message: '该用户名已被占用。',
        requestId: newIds.request(),
        detail: { field: 'username' },
      })
    }
    throw thrown
  }

  const created = findUserById(db, input.id)
  if (created === null) {
    throw new ContractError({
      code: 'STORAGE_UNAVAILABLE',
      message: '用户创建后无法读回，数据库可能不可用。',
      requestId: newIds.request(),
    })
  }
  return created
}

export interface CreateUserWithMembershipInput extends CreateUserInput {
  readonly workspaceId: WorkspaceId
  readonly role: WorkspaceRole
}

/**
 * 一次性初始化专用：**在同一事务里**创建所有者并写入工作区成员关系。
 *
 * 🔴 为什么要合在一个事务：如果用户建好了但成员关系写失败，系统会处于
 * "已有一个不能管理任何工作区的所有者"的状态，而初始化只能执行一次，
 * 结果是这台服务器再也无法正常使用（只能手工改库）。事务让两者要么都在、要么都不在。
 *
 * 🔴 角色**由调用方显式指定为 owner**，不从请求体读：设计文档 04 要求
 * "不接受客户端自报角色"。
 */
export function createUserWithMembership(
  db: ServerDb,
  input: CreateUserWithMembershipInput,
): UserRow {
  return db.transaction(() => {
    const user = createUser(db, input)
    db.prepare(
      `INSERT INTO ${SERVER_TABLES.workspaceMembers} (workspace_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(input.workspaceId, input.id, input.role, input.at)
    return user
  })()
}

/** 停用/启用用户。停用不删除：审计与版本记录仍要能指向这个主体。 */
export function setUserDisabled(
  db: ServerDb,
  id: UserId,
  disabled: boolean,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.users}
          SET disabled = ?, disabled_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(disabled ? 1 : 0, disabled ? at : null, at, id)
  return info.changes === 1
}

export function countUsers(db: ServerDb): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${SERVER_TABLES.users}`)
    .get() as { count: number }
  return row.count
}

// ---------------------------------------------------------------------------
// 管理面（task-15 / P3-C4）追加：列表、按用户名查、改名、换摘要
//
// 这四个函数是**纯追加**：既有导出（含上面的私有 `USER_COLUMNS` / `toUser`）的签名与
// 语义都没有变。新增的读函数同样**不带 `password_hash`**——管理端看到的用户对象里
// 永远没有摘要，从类型上就写不出"把摘要放进响应"的代码。
// ---------------------------------------------------------------------------

/**
 * 列出全部用户（按创建时间、ID 稳定排序）。
 *
 * 用途：`GET /api/v1/admin/users`。**"谁是系统管理员"的判定不在这一层**：
 * 它来自 `server_state.owner_user_id`（见 `./admin.js`），仓储层不做权限判断——
 * 否则"谁能读用户表"会散落成第二份真相源。
 */
export function listUsers(db: ServerDb): readonly UserRow[] {
  const rows = db
    .prepare(`SELECT ${USER_COLUMNS} FROM ${SERVER_TABLES.users} ORDER BY created_at, id`)
    .all() as RawUserRow[]
  return rows.map(toUser)
}

/**
 * 按用户名（归一化后）查用户，**不带密码摘要**。
 *
 * 与 `findUserWithCredentialByUsername` 只差一件事：返回值里没有 `password_hash`。
 * 加工作区成员时要按用户名定位目标用户，这条路径不需要、也不应该拿到摘要。
 */
export function findUserByUsername(db: ServerDb, username: string): UserRow | null {
  const raw = db
    .prepare(`SELECT ${USER_COLUMNS} FROM ${SERVER_TABLES.users} WHERE normalized_username = ?`)
    .get(normalizeUsername(username)) as RawUserRow | undefined
  return raw === undefined ? null : toUser(raw)
}

/**
 * 改显示名。返回是否命中一行（`false` = 用户不存在，调用方按 404 处理）。
 *
 * 用户名（`username` / `normalized_username`）**不可改**：它是唯一约束的承载者，
 * 也是审计与日志里指认主体的稳定键，改名会让历史记录失去指向。
 */
export function setUserDisplayName(
  db: ServerDb,
  id: UserId,
  displayName: string,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.users}
          SET display_name = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(displayName, at, id)
  return info.changes === 1
}

/**
 * 换密码摘要（管理端重置密码的**唯一**落库路径）。
 *
 * 🔴 入参是**已经算好的摘要**（`hashPassword()` 的输出），不是明文。
 * 仓储层接触不到明文，也就不可能在日志、审计或错误信息里泄露它。
 */
export function setUserPasswordHash(
  db: ServerDb,
  id: UserId,
  passwordHash: string,
  at: UtcTimestamp,
): boolean {
  const info = db
    .prepare(
      `UPDATE ${SERVER_TABLES.users}
          SET password_hash = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(passwordHash, at, id)
  return info.changes === 1
}

/** 驱动唯一约束冲突判定。只看主码，不做文案匹配。 */
export function isUniqueViolation(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null) return false
  const code = (thrown as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')
}
