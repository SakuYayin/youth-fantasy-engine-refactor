/**
 * 服务端秘密材料的生成、摘要与常数时间比较。
 *
 * 本文件是"**不要自制密码学**"（设计文档 04 原文）的落点：所有原语都来自
 * `node:crypto`（SHA-256 / HMAC-SHA256 / scrypt / `randomBytes` / `timingSafeEqual`），
 * 这里只做**参数选择与使用姿势**，不实现任何算法本身。
 *
 * ## 两类秘密，两种摘要策略（刻意的差别）
 *
 * 1. **高熵凭据**（访问令牌、刷新凭据、设备凭据、CSRF 秘密、引导凭据）：
 *    由 `randomBytes(32)` 生成，熵 256 bit。这类值**不可能被枚举**，
 *    所以用裸 SHA-256 摘要就足够——它的用途只是"让库文件泄漏时拿不到可用凭据"，
 *    而不是抗暴力破解（抗暴力破解靠的是熵）。
 *    对它们跑慢哈希只会让每个 HTTP 请求都多花 100ms，是纯粹的性能损失。
 *
 * 2. **低熵凭据**（人工输入的配对码）：码空间只有 2^40 左右，且用户会输入
 *    "看起来好记"的码。这类值必须用慢哈希 + **服务端密钥（pepper）**，
 *    否则拿到库文件的人可以用一台机器在几分钟内枚举出所有码。
 *    pepper 来自主密钥文件（`09-部署与运维.md`：32 字节随机、Base64、启动时严格校验），
 *    所以即使库文件泄漏，没有主密钥文件也算不出码。
 *
 * 🔴 配对码用固定 pepper 作盐（而不是每行随机盐）：因为登录时**只知道码**，
 * 必须能用一次索引查询把它找出来。随机盐会让查表退化成"遍历所有行逐个校验"。
 * 这是有意的取舍：pepper 是服务端秘密，等价于"每个码都有同一个秘密盐"，
 * 在 pepper 不泄漏的前提下与随机盐等效。
 */

import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** 高熵凭据长度（字节）。32 字节 = 256 bit，任何在线爆破都不成立。 */
export const TOKEN_BYTES = 32

/** 配对码字符集：Crockford Base32（去掉 I/L/O/U，避免手抄/口述歧义）。 */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 配对码长度。
 *
 * 8 个字符 → 32^8 ≈ 1.1e12 ≈ 2^40 种组合。配合"10 分钟过期 + 最多 5 次尝试"，
 * 在线爆破成功概率约为 5/2^40，可以忽略。
 * 🔴 不要为了"好输"降到 6 位：6 位只有 2^30，配合 5 次尝试仍有 5e-9 的单码
 * 命中率，但在高价值目标 + 大量有效码并存的场景下会变得可观。
 */
export const PAIRING_CODE_LENGTH = 8

/**
 * 配对码哈希参数。比密码参数低一档（N=2^14 约 40ms）：
 * 配对是低频操作，但仍然要抗"拿到库之后离线枚举"。
 */
export const PAIRING_CODE_SCRYPT = { N: 2 ** 14, r: 8, p: 1 } as const

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2
}

/** 生成高熵随机凭据（URL 安全 Base64，无填充）。 */
export function generateToken(byteLength: number = TOKEN_BYTES): string {
  return randomBytes(byteLength).toString('base64url')
}

/** 生成 CSRF 秘密。与凭据同熵，但它只用于签名，不能当凭据使用。 */
export function generateCsrfSecret(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

// ---------------------------------------------------------------------------
// 高熵凭据的摘要
// ---------------------------------------------------------------------------

/** 摘要前缀。带前缀是为了让"这是摘要不是明文"在库里一眼可见，也便于将来换算法。 */
const DIGEST_PREFIX = 'sha256:'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 计算可入库的凭据摘要。 */
export function hashToken(token: string): string {
  return `${DIGEST_PREFIX}${sha256Hex(token)}`
}

/**
 * 校验一个提交上来的凭据是否匹配已存的摘要。
 *
 * 🔴 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同字符处短路，
 * 响应时间因此泄漏"前缀猜对了多少"。虽然摘要是公开可计算的（SHA-256 无秘密），
 * 攻击者仍可用它做**在线**逐字节验证；更重要的是这类代码很容易被复制到
 * 真正需要常数时间的场景（例如 CSRF 秘密比较），所以统一姿势。
 */
export function verifyToken(token: string, storedDigest: string): boolean {
  return timingSafeEqualString(hashToken(token), storedDigest)
}

/** 常数时间字符串比较。长度不同直接返回 false（长度本身不是秘密）。 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * 由会话秘密派生出 CSRF 令牌（**同步器令牌模式**）。
 *
 * 为什么要绑定会话而不是"双提交 Cookie"（把随机值同时放 Cookie 与请求头）：
 * 双提交依赖"攻击者无法在目标域名下写 Cookie"。当站点有任意一个可控子域
 * （或反向代理路径映射不严）时，攻击者就能用 `Domain=.example.com` 种下
 * 与请求头一致的值，双提交随即失效。绑定到服务端会话秘密后，
 * 攻击者必须同时知道会话秘密才能构造出通过校验的令牌。
 *
 * 用 HMAC 而不是直接返回秘密：秘密本身留在服务端（数据库里），
 * 出网的只有它的派生值；即便派生值泄漏也无法反推秘密。
 */
export function deriveCsrfToken(csrfSecret: string, sessionId: string): string {
  return createHmac('sha256', csrfSecret).update(sessionId, 'utf8').digest('base64url')
}

export function verifyCsrfToken(
  csrfSecret: string,
  sessionId: string,
  presented: string,
): boolean {
  return timingSafeEqualString(deriveCsrfToken(csrfSecret, sessionId), presented)
}

// ---------------------------------------------------------------------------
// 配对码
// ---------------------------------------------------------------------------

/**
 * 生成一个人工可用的配对码。
 *
 * 🔴 用 `randomBytes` 而不是 `Math.random()`：后者是可预测的（V8 的 xorshift128+，
 * 观察到若干输出即可恢复内部状态），而配对码是短期凭据，
 * 可预测等于任何人都能算出别人正在等待的码。
 *
 * 取模偏差说明：256 % 32 === 0，所以 `byte % 32` 是**均匀**的，不存在偏差。
 * 字符集长度一旦不是 2 的幂，这段代码就必须改成拒绝采样——注释在此防止后人改字母表时踩坑。
 */
export function generatePairingCode(length: number = PAIRING_CODE_LENGTH): string {
  const bytes = randomBytes(length)
  let code = ''
  for (let i = 0; i < length; i += 1) {
    // noUncheckedIndexedAccess：逐字节取值必须显式处理 undefined。
    const byte = bytes[i]
    if (byte === undefined) throw new Error('随机字节不足，无法生成配对码')
    code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
  }
  return code
}

/**
 * 归一化用户输入的配对码：去掉分隔符与空白、统一大写、把易混字符映射回字符集。
 *
 * 用户会照着屏幕抄，`O`/`0`、`I`/`1`/`L` 几乎必然混用。把这些映射做在服务端，
 * 比要求用户"请注意区分"要可靠得多。
 */
export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/** 人类可读的展示形式（仅用于响应体与 UI，绝不用于查表）。 */
export function formatPairingCode(code: string): string {
  if (code.length !== PAIRING_CODE_LENGTH) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * 计算配对码摘要（**确定性**，可建唯一索引）。
 *
 * `pepper` 必须是主密钥文件里的 32 字节随机值。函数在这里强制校验长度：
 * 一个空 pepper 会让"加盐"退化成"没加盐"，而调用方不会察觉。
 */
export async function hashPairingCode(code: string, pepper: Buffer | Uint8Array): Promise<string> {
  if (pepper.length < 16) {
    throw new TypeError('配对码哈希需要至少 16 字节的服务端秘密（pepper），拒绝退化为无盐哈希')
  }
  const normalized = normalizePairingCode(code)
  const derived = await scrypt(normalized, Buffer.from(pepper), 32, {
    N: PAIRING_CODE_SCRYPT.N,
    r: PAIRING_CODE_SCRYPT.r,
    p: PAIRING_CODE_SCRYPT.p,
    maxmem: maxmemFor(PAIRING_CODE_SCRYPT.N, PAIRING_CODE_SCRYPT.r),
  })
  return `scrypt-pairing:${derived.toString('hex')}`
}
