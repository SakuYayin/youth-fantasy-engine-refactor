/**
 * 凭据输入策略（用户名 / 密码 / 显示名）。
 *
 * 放在 `auth/` 而不是 `http/`：它是**领域规则**，HTTP 只是它的一个调用方
 * （将来设备配对、管理端改密、CLI 初始化都会复用同一套）。唯一的 HTTP 痕迹
 * 是它抛的是 `ContractError`——而那也已经是契约层类型，不是框架类型。
 *
 * ## 为什么下限是 12 位
 *
 * 设计文档 04 只写了"密码成熟 Argon2id"（本仓为 scrypt）而没有给长度。
 * 12 位是"人类可记"与"离线爆破成本"的折中：在 N=2^15 的 scrypt 面前，
 * 12 位随机口令的在线爆破已经不可行，而离线爆破的成本由 KDF 参数兜底。
 * 真正让下限生效的是**拒绝明显可猜的形态**（见 `assertNotTrivial`）。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 64
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256
export const DISPLAY_NAME_MAX_LENGTH = 64

/**
 * 用户名字符集。
 *
 * 首字符必须是字母或数字（避免 `-` 开头的名字在某些客户端被当成参数），
 * 其余允许 `A-Za-z0-9._-`。**只允许 ASCII**：`db/users.ts` 的
 * `normalizeUsername` 用 ASCII 小写折叠来保证确定性（注释解释了土耳其语
 * `toLocaleLowerCase` 的坑），所以非 ASCII 字符会破坏"归一化后唯一"这条不变量。
 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function invalid(code: 'VALIDATION_MISSING_FIELD' | 'VALIDATION_OUT_OF_RANGE' | 'VALIDATION_FAILED', message: string, requestId: RequestId, detail: Record<string, string | number | boolean | null>): never {
  throw new ContractError({ code, message, requestId, detail })
}

export function validateUsername(raw: unknown, requestId: RequestId): string {
  if (raw === undefined || raw === null) {
    invalid('VALIDATION_MISSING_FIELD', '缺少用户名。', requestId, { field: 'username' })
  }
  if (typeof raw !== 'string') {
    invalid('VALIDATION_FAILED', '用户名必须是字符串。', requestId, { field: 'username' })
  }
  const username = raw.trim()
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    invalid('VALIDATION_OUT_OF_RANGE', `用户名长度必须在 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 之间。`, requestId, {
      field: 'username',
      min: USERNAME_MIN_LENGTH,
      max: USERNAME_MAX_LENGTH,
    })
  }
  if (!USERNAME_PATTERN.test(username)) {
    invalid('VALIDATION_FAILED', '用户名只能包含字母、数字、点、下划线和短横线，且必须以字母或数字开头。', requestId, {
      field: 'username',
    })
  }
  return username
}

export function validatePassword(raw: unknown, requestId: RequestId): string {
  if (raw === undefined || raw === null) {
    invalid('VALIDATION_MISSING_FIELD', '缺少密码。', requestId, { field: 'password' })
  }
  if (typeof raw !== 'string') {
    invalid('VALIDATION_FAILED', '密码必须是字符串。', requestId, { field: 'password' })
  }
  if (raw.length < PASSWORD_MIN_LENGTH || raw.length > PASSWORD_MAX_LENGTH) {
    invalid('VALIDATION_OUT_OF_RANGE', `密码长度必须在 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 之间。`, requestId, {
      field: 'password',
      min: PASSWORD_MIN_LENGTH,
      max: PASSWORD_MAX_LENGTH,
    })
  }
  // 🔴 密码值绝不进 detail，也绝不进日志——只报"违反了哪条规则"。
  if (/^(.)\1*$/.test(raw)) {
    invalid('VALIDATION_FAILED', '密码不能是同一个字符的重复。', requestId, { field: 'password', rule: 'no_repeats' })
  }
  return raw
}

export function validateDisplayName(raw: unknown, username: string, requestId: RequestId): string {
  if (raw === undefined || raw === null) return username
  if (typeof raw !== 'string') {
    invalid('VALIDATION_FAILED', '显示名必须是字符串。', requestId, { field: 'displayName' })
  }
  const displayName = raw.trim()
  if (displayName.length === 0) return username
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    invalid('VALIDATION_OUT_OF_RANGE', `显示名不能超过 ${DISPLAY_NAME_MAX_LENGTH} 个字符。`, requestId, {
      field: 'displayName',
      max: DISPLAY_NAME_MAX_LENGTH,
    })
  }
  return displayName
}

/**
 * 口令与用户名不能相同（忽略大小写）。
 *
 * 这是**唯一**一条跨字段规则：`alice` / `alice` 这种组合在任何字典攻击下
 * 都是第一顺位，而它在真实部署里出现率高得惊人（初始化时的"先跑起来"心态）。
 */
export function assertPasswordDiffersFromUsername(
  password: string,
  username: string,
  requestId: RequestId,
): void {
  if (password.toLowerCase() === username.toLowerCase()) {
    invalid('VALIDATION_FAILED', '密码不能与用户名相同。', requestId, { field: 'password', rule: 'not_username' })
  }
}
