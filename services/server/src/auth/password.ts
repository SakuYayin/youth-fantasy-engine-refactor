/**
 * 密码摘要。
 *
 * ## 选型与理由（设计文档 04 要求"成熟实现 + 记录参数 + 禁止自制密码学"）
 *
 * 用 **`node:crypto` 的 `scrypt`**，不引入 `argon2` 包：
 * - 它是运行时内置的成熟实现（RFC 7914，OpenSSL 提供），零新增依赖、无原生编译链；
 * - scrypt 与 Argon2id 同属**内存硬** KDF，不是自制密码学；
 * - 引入 `argon2` 需要预编译二进制或构建工具链，而设计文档 09 要求
 *   "不在运行时要求用户自行安装编译器"，一个装不上原生模块的后端会直接起不来。
 *
 * 🔴 **摘要串是自描述的**（算法 + 参数 + 盐 + 摘要），所以将来换成 Argon2id
 * **不需要改表**：老行按串里声明的算法校验，登录成功后用 `needsRehash()` 判定
 * 是否要用新算法重写该行。参数"随部署硬件基准调整并记录"就是靠串里的 `N/r/p` 落地的。
 *
 * 串格式：`scrypt$N=<n>,r=<r>,p=<p>$<salt-base64url>$<hash-base64url>`
 *
 * 🔴 禁止事项（写在这里防止后人"优化"）：
 * - 不得把明文密码、摘要或盐写进日志、错误响应、审计明细；
 * - 不得用 `===` 比较摘要（见 `verifyPassword` 的 `timingSafeEqual`）；
 * - 不得为了"登录快一点"把 `N` 降到 2^14 以下。
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** 算法标识。放在串首，是将来平滑迁移到 `argon2id` 的锚点。 */
export const PASSWORD_ALGORITHM = 'scrypt'

/**
 * 默认成本参数（对齐 OWASP 对 scrypt 的建议下限 N=2^17 与 r=8,p=1 之间的折中）。
 *
 * `N=2^15`（32768）、`r=8`、`p=1` 在普通 VPS 上约 100ms/次，
 * 内存约 `128 * N * r = 32 MiB`。`maxmem` 必须显式给足：Node 默认 32 MiB，
 * 恰好卡在边界上会抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
 */
export interface ScryptParams {
  readonly N: number
  readonly r: number
  readonly p: number
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 }

/** 盐长度（字节）。16 字节 = 128 bit，足够避免跨用户盐碰撞。 */
export const SALT_BYTES = 16

/** 摘要长度（字节）。 */
export const KEY_BYTES = 32

/** 内存上限：留 2 倍余量，避免恰好等于 `128*N*r` 时被 Node 拒绝。 */
function maxmemFor(params: ScryptParams): number {
  return 128 * params.N * params.r * 2
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/**
 * 生成密码摘要。
 *
 * 🔴 **每次调用都用新的随机盐**，所以同一个密码两次 hash 结果必然不同。
 * 这不是浪费：相同摘要意味着"这两个用户密码一样"这件事在库里可被直接看出来，
 * 而且彩虹表可以一次命中所有人。
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    // 空密码不是"弱密码"，是调用方 bug：必须在进入 KDF 前拦住。
    throw new TypeError('密码不能为空')
  }
  const salt = randomBytes(SALT_BYTES)
  const derived = await scrypt(password, salt, KEY_BYTES, { ...params, maxmem: maxmemFor(params) })
  return [
    PASSWORD_ALGORITHM,
    `N=${params.N},r=${params.r},p=${params.p}`,
    toBase64Url(salt),
    toBase64Url(derived),
  ].join('$')
}

/** 已解析的摘要串。解析失败返回 `null`，**不抛异常**（畸形输入会被当成校验失败）。 */
export interface ParsedPasswordHash {
  readonly algorithm: string
  readonly params: ScryptParams
  readonly salt: Buffer
  readonly digest: Buffer
}

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split('$')
  if (parts.length !== 4) return null
  const [algorithm, paramText, saltText, digestText] = parts as [string, string, string, string]
  if (algorithm !== PASSWORD_ALGORITHM) return null

  // 🔴 这里**不能**用 `Partial<ScryptParams>`：`Partial<>` 只去掉可选性，不去掉
  // `readonly`，因此下面三处赋值会直接撞上
  // `TS2540: Cannot assign to 'N' because it is a read-only property`。
  // 用一个显式的可变局部记录来解析，最后再断言回只读的 `ScryptParams`——
  // 只读是给**调用方**的约束，解析过程中我们必须能填字段。
  const params: { N?: number; r?: number; p?: number } = {}
  for (const pair of paramText.split(',')) {
    const [key, value] = pair.split('=')
    if (key === undefined || value === undefined) return null
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
    if (key === 'N') params.N = parsed
    else if (key === 'r') params.r = parsed
    else if (key === 'p') params.p = parsed
    else return null
  }
  if (params.N === undefined || params.r === undefined || params.p === undefined) return null
  // N 必须是 2 的幂：否则 scrypt 会抛错，而抛错点在"校验密码"路径上，
  // 变成 500 会掩盖真实原因（库被改坏 / 旧格式残留）。
  if ((params.N & (params.N - 1)) !== 0) return null

  const salt = fromBase64Url(saltText)
  const digest = fromBase64Url(digestText)
  if (salt.length !== SALT_BYTES || digest.length !== KEY_BYTES) return null

  return { algorithm, params: params as ScryptParams, salt, digest }
}

/**
 * 校验密码。
 *
 * 🔴 **常数时间比较**：用 `timingSafeEqual` 而不是 `===`。
 * 逐字节短路比较会让攻击者通过响应时间差异逐位推断摘要，
 * 而摘要一旦被本地推断出来（例如拿到了库文件副本），暴力破解就只剩一次比较。
 *
 * 返回值语义：
 * - `true`  密码正确；
 * - `false` 密码错误**或**摘要串畸形。两种情况对调用方等价：
 *   都必须按"凭据无效"处理，且对外不能区分（否则就成了账号探测接口）。
 *
 * ⚠️ 时间侧信道还有一层：密码错误时不做 KDF 会快很多，攻击者可据此判断用户名是否存在。
 * 调用方应在用户名不存在时也跑一次 `burnPasswordCheck()`（见该函数）。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored)
  if (parsed === null) return false

  let candidate: Buffer
  try {
    candidate = await scrypt(password, parsed.salt, parsed.digest.length, {
      ...parsed.params,
      maxmem: maxmemFor(parsed.params),
    })
  } catch {
    // 参数被改坏（例如 N 巨大）导致 KDF 无法执行 → 视为校验失败，不把内部错误外发。
    return false
  }

  if (candidate.length !== parsed.digest.length) return false
  return timingSafeEqual(candidate, parsed.digest)
}

/** 摘要是否落后于当前默认参数（登录成功后据此静默重写，用户无感）。 */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): boolean {
  const parsed = parsePasswordHash(stored)
  if (parsed === null) return true
  return (
    parsed.algorithm !== PASSWORD_ALGORITHM ||
    parsed.params.N < params.N ||
    parsed.params.r < params.r ||
    parsed.params.p < params.p
  )
}

/** 把已校验的旧摘要升级为当前参数的新摘要。密码正确时才允许调用。 */
export async function rehashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  return hashPassword(password, params)
}

/**
 * 用户名不存在时消耗等量 CPU。
 *
 * 没有这一步，"用户名不存在"会在 1ms 内返回而"密码错误"要 100ms，
 * 攻击者不需要看响应体就能枚举出系统里有哪些账号。
 * 用固定假摘要（每次进程启动时生成一次）执行一次真实 KDF。
 */
const decoyHashPromise: Promise<string> = hashPassword('decoy-password-for-timing-equalization')

export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(password, await decoyHashPromise)
}
