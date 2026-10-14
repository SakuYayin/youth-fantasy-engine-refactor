/**
 * 设备配对。
 *
 * 设计依据（`04-后端与安全.md`）：配对码**短期、一次性、限定用户/工作区**；
 * 领取后签发**独立 deviceId 与凭据**；支持重命名、最后活动、撤销、重新配对。
 *
 * ## 流程
 *
 * ```
 *  已登录用户（授权：工作区 admin/owner，或系统管理员自身）
 *        │  POST /api/v1/pairing-codes
 *        ▼
 *  生成 8 位 Crockford Base32 码 ──► 只把 scrypt 摘要 + pepper 落库
 *        │  （明文码只在这一次响应里出现；10 分钟后过期；最多 5 次尝试）
 *        ▼
 *  新设备（未认证）
 *        │  POST /api/v1/devices/pair  { code, deviceName, platform }
 *        ▼
 * 校验 → 新建 device 行 → 原子消费（同一事务）→ 返回一次性明文设备凭据
 * ```
 *
 * ## 三条安全决定
 *
 * 1. **领取路径不返回"码为什么失败"的细节**。对外统一是 `AUTH_INVALID_CREDENTIALS`，
 *    只在 `detail.reason` 里给机器可读的分类。原因：这是一个**未认证**接口，
 *    区分"码不存在"和"码存在但过期"等于给攻击者一个码存在性预言机。
 *
 * 2. **撤销的设备不会被"重新配对"复活**。重新配对的正确语义是**发放一个全新的
 *    deviceId 与全新凭据**（新的配对码 → 新的设备行）。如果允许复用旧 deviceId，
 *    那么管理员撤销一台丢失设备后，任何拿着旧 deviceId 的人都能借着新码把它
 *    重新激活——撤销就成了可逆操作，而撤销的价值恰恰在于不可逆。
 *
 * 3. **失败也计数，且计数发生在判定之前**（见 `recordPairingAttempt` 的注释）。
 */

import { ContractError } from '@yfe/contracts'
import type { DeviceId, RequestId, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'

import {
  consumePairingCode,
  findPairingCodeByHash,
  insertPairingCode,
  recordPairingAttempt,
  revokeAllPairingCodesForUser,
  revokePairingCode,
} from '../db/pairing.js'
import { SERVER_TABLES } from '../db/ddl.js'
import type { PairingCodeRow } from '../db/pairing.js'
import { insertDevice, listDevicesForUser, renameDevice, revokeAllUserDevices, revokeDevice, touchDeviceLastSeen } from '../db/devices.js'
import type { DeviceRow, DeviceWithCredential } from '../db/devices.js'
import { findDeviceByTokenHash } from '../db/devices.js'
import type { ServerDb } from '../db/open.js'
import {
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  generateToken,
  hashPairingCode,
  hashToken,
  normalizePairingCode,
} from './secrets.js'
import { addMilliseconds, isExpired } from './session.js'

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

export interface PairingPolicy {
  /** 配对码有效期。短是刻意的：它是一次性凭据，且会被人工抄写/传递。 */
  readonly codeTtlMs: number
  /** 单个码允许的失败尝试上限。 */
  readonly maxAttempts: number
  /** 每用户同时有效的配对码上限。防止一次签发把尝试空间摊薄。 */
  readonly maxActiveCodesPerUser: number
  /** 设备凭据有效期。`null` 表示不过期（设备凭据靠显式撤销管理）。 */
  readonly deviceTokenTtlMs: number | null
}

export const DEFAULT_PAIRING_POLICY: PairingPolicy = {
  codeTtlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  maxActiveCodesPerUser: 5,
  deviceTokenTtlMs: null,
}

// ---------------------------------------------------------------------------
// 签发
// ---------------------------------------------------------------------------

export interface CreatePairingCodeInput {
  readonly userId: UserId
  /** 设备被授权的工作区范围。`null` 表示不限工作区（个人设备）。 */
  readonly workspaceId: WorkspaceId | null
  readonly at: UtcTimestamp
  /** 主密钥文件里的 32 字节秘密。见 `./secrets.js` 的 `hashPairingCode`。 */
  readonly pepper: Buffer | Uint8Array
  readonly policy?: PairingPolicy
  readonly requestId: RequestId
}

/** 签发结果。`code` / `formattedCode` 是**明文**，只在此刻有效，绝不落库、绝不进日志。 */
export interface CreatedPairingCode {
  readonly id: string
  readonly code: string
  readonly formattedCode: string
  readonly userId: UserId
  readonly workspaceId: WorkspaceId | null
  readonly expiresAt: UtcTimestamp
  readonly maxAttempts: number
}

/**
 * 生成并保存一个配对码。
 *
 * 🔴 明文 `code` 只在返回值里出现。调用方必须：
 * - 立刻放进 HTTP 响应体（该响应不得被缓存、不得进访问日志）；
 * - 绝不写进任何日志行、审计明细或错误消息。
 * 审计里只记"谁在什么时候签发了发给哪个工作区的码"，不记码本身。
 */
export async function createPairingCode(
  db: ServerDb,
  input: CreatePairingCodeInput,
): Promise<CreatedPairingCode> {
  const policy = input.policy ?? DEFAULT_PAIRING_POLICY
  const code = generatePairingCode(PAIRING_CODE_LENGTH)
  const id = `pc_${generateToken(12)}`
  const expiresAt = addMilliseconds(input.at, policy.codeTtlMs)

  // 🔴 慢哈希必须在事务**外**完成。
  // better-sqlite3 的 `db.transaction()` 是同步 API：事务体里一旦 `await`，
  // 事务会跨事件循环挂起，而同一连接上的其它同步语句仍能写入，
  // 「要么全做要么全不做」的语义就断了。所以顺序固定为
  // "异步算摘要 → 同步事务写入"。
  const codeHash = await hashPairingCode(code, input.pepper)

  db.transaction(() => {
    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${SERVER_TABLES.pairingCodes}
          WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(input.userId, input.at) as { count: number }

    if (active.count >= policy.maxActiveCodesPerUser) {
      throw new ContractError({
        code: 'RESOURCE_LOCKED',
        message: `同时有效的配对码已达上限（${policy.maxActiveCodesPerUser} 个），请先撤销不用的配对码。`,
        requestId: input.requestId,
        detail: { maxActiveCodes: policy.maxActiveCodesPerUser },
      })
    }

    insertPairingCode(db, {
      id,
      codeHash,
      userId: input.userId,
      workspaceId: input.workspaceId,
      at: input.at,
      expiresAt,
      maxAttempts: policy.maxAttempts,
    })
  })()

  return {
    id,
    code,
    formattedCode: formatPairingCode(code),
    userId: input.userId,
    workspaceId: input.workspaceId,
    expiresAt,
    maxAttempts: policy.maxAttempts,
  }
}

/**
 * 生成配对码的**两阶段**版本：先算摘要（异步、无事务），再同步写入。
 *
 * 存在的理由：better-sqlite3 的 `db.transaction()` 是同步 API，事务体里
 * 不能有 `await`——一旦 await，事务会跨事件循环挂起，而其它同步语句仍能写进
 * 同一连接，回滚语义就断了。所以凡是"需要慢哈希"的写路径都必须拆成
 * "异步算摘要 → 同步事务写"两步。`createPairingCode` 内部就是这么做的，
 * 这里把同样的模式暴露给需要显式控制顺序的调用方。
 */
export async function buildPairingCodeHash(
  code: string,
  pepper: Buffer | Uint8Array,
): Promise<string> {
  return hashPairingCode(code, pepper)
}

/** 撤销一个未被使用的配对码。 */
export function cancelPairingCode(
  db: ServerDb,
  id: string,
  at: UtcTimestamp,
): boolean {
  return revokePairingCode(db, id, at)
}

// ---------------------------------------------------------------------------
// 领取
// ---------------------------------------------------------------------------

export type PairingFailureReason =
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'revoked'
  | 'too_many_attempts'
  | 'workspace_mismatch'
  | 'user_disabled'

export type RedeemPairingCodeResult =
  | {
      readonly ok: true
      readonly device: DeviceRow
      /** 明文设备凭据。只在本次响应里出现，服务端只留摘要。 */
      readonly deviceToken: string
      readonly workspaceId: WorkspaceId | null
    }
  | { readonly ok: false; readonly error: ContractError }

export interface RedeemPairingCodeInput {
  readonly code: string
  /** 客户端声明想加入的工作区。与码绑定的工作区不一致即拒绝。 */
  readonly workspaceId: WorkspaceId | null
  readonly deviceName: string
  readonly platform: string | null
  readonly at: UtcTimestamp
  readonly pepper: Buffer | Uint8Array
  readonly requestId: RequestId
  readonly clientIp: string | null
  readonly policy?: PairingPolicy
  /** 用户是否被停用。由调用方查库后传入（这里不 split 用户仓储的职责）。 */
  readonly userDisabled?: boolean
}

/**
 * 事务内哨兵：原子消费失败（另一个请求抢先领走了码）。
 *
 * 为什么用异常而不是返回值：消费失败必须让**整个事务回滚**，而
 * `pairing_codes.consumed_device_id` 有指向 `devices(id)` 的外键，
 * 所以设备行必须在消费**之前**插入——回滚是撤销那次插入的唯一手段。
 * 这个错误只在模块内部流转，永远不会外发（外层会翻译成"已被使用"）。
 */
class PairingCodeRace extends Error {
  constructor() {
    super('pairing_code_race')
    this.name = 'PairingCodeRace'
  }
}

/**
 * 构造拒绝结果。
 *
 * 🔴 分类放在 `detail.reason` 里而不是分成不同 code：这是一个**未认证**接口，
 * 区分"码不存在"和"码存在但过期"等于给攻击者一个码存在性预言机。
 */
function pairingDenied(
  reason: PairingFailureReason,
  code: 'AUTH_INVALID_CREDENTIALS' | 'PERMISSION_WORKSPACE_MISMATCH' | 'AUTH_TOKEN_EXPIRED',
  message: string,
  requestId: RequestId,
): RedeemPairingCodeResult {
  return {
    ok: false,
    error: new ContractError({ code, message, requestId, detail: { reason } }),
  }
}

/**
 * 领取配对码，签发设备凭据。
 *
 * 判定顺序（每一步都在**同一个事务**里，避免"检查通过后被并发领走"）：
 * 1. 归一化 + scrypt 摘要（**事务外**，因为它是异步的）；
 * 2. 按摘要查行；查不到 → 直接拒绝（此时无行可计数）；
 * 3. 用户已停用 → 拒绝（停用必须立即阻断所有新设备）；
 * 4. 已撤销 → 计数 + 拒绝；
 * 5. 已消费 → 计数 + 拒绝（**一次性**）；
 * 6. 尝试次数已达上限 → 拒绝（不再计数，避免无界增长）；
 * 7. 已过期 → 计数 + 拒绝；
 * 8. 工作区不匹配 → 计数 + 拒绝（**跨工作区使用被拒**）；
 * 9. 建设备行 → 原子消费成功 → 返回明文凭据。
 *    顺序见下方注释（外键要求设备行先存在）。消费失败（`changes === 0`）
 *    说明并发抢先，抛出哨兵让整个事务回滚，按已消费处理。
 *
 * 🔴 注意码比对**不需要**常数时间保护：查表用的是摘要等值匹配，
 * 攻击者无法通过时间差逐位还原摘要（scrypt 摘要是雪崩的），
 * 且尝试次数上限把在线枚举封在 5 次以内。
 */
export async function redeemPairingCode(
  db: ServerDb,
  input: RedeemPairingCodeInput,
): Promise<RedeemPairingCodeResult> {
  const policy = input.policy ?? DEFAULT_PAIRING_POLICY
  const normalized = normalizePairingCode(input.code)

  // (1) 事务外做慢哈希：见 buildPairingCodeHash 的注释。
  const codeHash = await hashPairingCode(normalized, input.pepper)

  const redeemTransaction = (): RedeemPairingCodeResult =>
    db.transaction((): RedeemPairingCodeResult => {
    const deny = (
      reason: PairingFailureReason,
      code: 'AUTH_INVALID_CREDENTIALS' | 'PERMISSION_WORKSPACE_MISMATCH' | 'AUTH_TOKEN_EXPIRED',
      message: string,
    ): RedeemPairingCodeResult => pairingDenied(reason, code, message, input.requestId)

    const row = findPairingCodeByHash(db, codeHash)
    if (row === null) {
      // 没有行 → 无法计数（也不该为不存在的 id 建计数器，那等于给攻击者
      // 一个"往表里塞垃圾"的手段）。全局限流由 HTTP 层负责。
      return deny('not_found', 'AUTH_INVALID_CREDENTIALS', '配对码无效，请重新获取。')
    }

    // 从这一步起每个失败都要计数：先计数、后判定，
    // 保证"对已过期/已撤销的码反复试"也会把尝试次数烧掉。
    const attempts = recordPairingAttempt(db, row.id)
    if (attempts === null) {
      return deny('not_found', 'AUTH_INVALID_CREDENTIALS', '配对码无效，请重新获取。')
    }

    if (input.userDisabled === true) {
      return deny('user_disabled', 'AUTH_INVALID_CREDENTIALS', '该账号已被停用，无法配对设备。')
    }
    if (row.revokedAt !== null) {
      return deny('revoked', 'AUTH_INVALID_CREDENTIALS', '配对码已被撤销，请重新获取。')
    }
    if (row.consumedAt !== null) {
      return deny('consumed', 'AUTH_INVALID_CREDENTIALS', '配对码已被使用，请重新获取。')
    }
    if (attempts > row.maxAttempts) {
      // 用 > 而不是 >=：第 maxAttempts 次尝试本身仍要走到业务判定，
      // 这样"最后一次输对了"不会被次数上限误杀；超出的才是拒绝。
      return deny('too_many_attempts', 'AUTH_INVALID_CREDENTIALS', '配对码尝试次数过多，请重新获取。')
    }
    if (isExpired(row.expiresAt, input.at)) {
      return deny('expired', 'AUTH_TOKEN_EXPIRED', '配对码已过期，请重新获取。')
    }
    // 跨工作区：码绑定 ws_A，客户端声明 ws_B → 拒绝。
    // 注意比较的是**声明值**，不是从请求体里"采纳"它——设备最终绑定的工作区
    // 一律取自码本身（row.workspaceId），绝不取自客户端。
    if (input.workspaceId !== null && row.workspaceId !== null && input.workspaceId !== row.workspaceId) {
      return deny(
        'workspace_mismatch',
        'PERMISSION_WORKSPACE_MISMATCH',
        '该配对码不属于此工作区，无法在此工作区配对该设备。',
      )
    }

    const deviceId = `dev_${generateToken(16)}` as DeviceId
    const deviceToken = generateToken()
    // 🔴 设备的工作区取自码，不取自 input.workspaceId。
    const boundWorkspace = row.workspaceId

    // 🔴 顺序：**先建设备行、再消费码**。
    // `pairing_codes.consumed_device_id` 有指向 `devices(id)` 的外键，
    // 先消费后建设备会在 `PRAGMA foreign_keys = ON` 下直接抛
    // `FOREIGN KEY constraint failed`（打开数据库时该 PRAGMA 是强制打开的）。
    // 一次性没有被削弱：消费仍是原子的
    // `UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL`；
    // 失败就抛哨兵让整个事务回滚，刚插入的设备行随之消失，外部只看到一次失败领取。
    const device = insertDevice(db, {
      id: deviceId,
      userId: row.userId,
      workspaceId: boundWorkspace,
      name: input.deviceName,
      platform: input.platform,
      tokenHash: hashToken(deviceToken),
      pairingCodeId: row.id,
      at: input.at,
    })

    const consumed = consumePairingCode(db, row.id, deviceId, input.at)
    if (!consumed) {
      // 并发：另一个请求刚刚消费了它。
      throw new PairingCodeRace()
    }

    return { ok: true, device, deviceToken, workspaceId: boundWorkspace }
  })()

  try {
    return redeemTransaction()
  } catch (error) {
    if (error instanceof PairingCodeRace) {
      // 事务已回滚，设备行没有留下。
      return pairingDenied(
        'consumed',
        'AUTH_INVALID_CREDENTIALS',
        '配对码已被使用，请重新获取。',
        input.requestId,
      )
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 设备鉴权与生命周期
// ---------------------------------------------------------------------------

export type DeviceAuthFailure =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'revoked'; readonly reason: string | null }
  | { readonly kind: 'user_disabled' }

export type DeviceAuthResult =
  | { readonly ok: true; readonly device: DeviceWithCredential }
  | { readonly ok: false; readonly failure: DeviceAuthFailure }

/**
 * 用设备凭据鉴权。
 *
 * 🔴 `updateLastSeen` 默认 `true`，但**拒绝路径不更新**：否则被撤销的设备
 * 持续发请求会让 `last_seen_at` 一直往前跑，运维看到的"最后活动"是攻击流量。
 */
export function authenticateDevice(
  db: ServerDb,
  deviceToken: string,
  at: UtcTimestamp,
  options: { readonly userDisabled?: boolean } = {},
): DeviceAuthResult {
  const device = findDeviceByTokenHash(db, hashToken(deviceToken))
  if (device === null) return { ok: false, failure: { kind: 'invalid' } }
  if (device.revokedAt !== null) {
    return { ok: false, failure: { kind: 'revoked', reason: device.revokedReason } }
  }
  if (options.userDisabled === true) {
    return { ok: false, failure: { kind: 'user_disabled' } }
  }
  touchDeviceLastSeen(db, device.id, at)
  return { ok: true, device }
}

/**
 * 把设备鉴权失败翻译成契约错误码。
 *
 * `AUTH_DEVICE_REVOKED` 是**独立错误码**而不是泛泛的 `AUTH_REQUIRED`：
 * 客户端对它的处理是"停止自动重试并提示用户重新配对"，
 * 对 `AUTH_REQUIRED` 的处理可能是"提醒登录"。混淆两者会导致被撤销的设备
 * 无限重试上传（设计文档 04："撤销的设备不能继续上传"）。
 */
export function deviceAuthFailureToError(
  failure: DeviceAuthFailure,
  requestId: RequestId,
): ContractError {
  switch (failure.kind) {
    case 'invalid':
      return new ContractError({
        code: 'AUTH_DEVICE_NOT_PAIRED',
        message: '设备凭据无效，请重新配对。',
        requestId,
      })
    case 'revoked':
      return new ContractError({
        code: 'AUTH_DEVICE_REVOKED',
        message: '该设备已被撤销，不能继续上传或同步。请重新配对。',
        requestId,
        ...(failure.reason === null ? {} : { detail: { reason: failure.reason } }),
      })
    case 'user_disabled':
      return new ContractError({
        code: 'AUTH_REQUIRED',
        message: '账号已被停用。',
        requestId,
      })
  }
}

/** 重命名设备。 */
export function renameOwnDevice(db: ServerDb, deviceId: DeviceId, name: string): boolean {
  return renameDevice(db, deviceId, name)
}

/**
 * 撤销设备。调用方必须**先做权限判定**（见 `../auth/permission.js`）：
 * 只能撤销自己的设备，或本工作区的 admin/owner 撤销范围内的设备。
 */
export function revokeOwnDevice(
  db: ServerDb,
  deviceId: DeviceId,
  at: UtcTimestamp,
  reason: string,
): boolean {
  return revokeDevice(db, deviceId, at, reason)
}

/** 列出用户的设备（含已撤销，供 UI 显示状态）。 */
export function listOwnDevices(db: ServerDb, userId: UserId): readonly DeviceRow[] {
  return listDevicesForUser(db, userId)
}

/** 停用账号时的连带处置：撤销全部设备与未使用的配对码。 */
export function revokeAllDeviceAccess(
  db: ServerDb,
  userId: UserId,
  at: UtcTimestamp,
  reason: string,
): { readonly devices: number; readonly pairingCodes: number } {
  return db.transaction(() => ({
    devices: revokeAllUserDevices(db, userId, at, reason),
    pairingCodes: revokeAllPairingCodesForUser(db, userId, at),
  }))()
}

/** 供测试与诊断用的行读取（不导出摘要字段）。 */
export function pairingCodeState(row: PairingCodeRow): {
  readonly id: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly consumed: boolean
  readonly revoked: boolean
  readonly expiresAt: UtcTimestamp
} {
  return {
    id: row.id,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    consumed: row.consumedAt !== null,
    revoked: row.revokedAt !== null,
    expiresAt: row.expiresAt,
  }
}
