/**
 * 服务端启动配置：环境变量契约 + 启动时校验。
 *
 * 设计依据（`09-部署与运维.md`）：
 * "监听参数、公开 URL、数据目录、日志、主密钥文件、允许代理、上传上限、存储驱动与任务
 *  并发均在启动时校验。**未知关键变量或路径错误要报告，不能静默忽略**"；
 * "配置路径必须可写性检查通过，**启动失败不能创建另一个临时空库继续运行**"；
 * "主密钥格式固定为密码学随机生成的 32 字节、Base64 编码文本，启动时严格校验"。
 *
 * ## 三条刻意的选择
 *
 * 1. **已知变量的非法值 → 抛错，服务起不来。** `YFE_LISTEN_PORT=八七八七` 这种
 *    写法如果被静默降级成默认端口，运维会以为配置生效了，实际监听在别处——
 *    排查成本远高于一次启动失败。
 * 2. **未知的 `YFE_*` 变量 → 收集成 warning 并打日志，不阻塞启动。**
 *    文档要求"报告，不能静默忽略"，而 compose 里多一个变量是常态（例如给
 *    别的服务用的、或刚删掉功能的残留）。硬失败会让升级因为一行无关变量中断，
 *    所以这里选择**大声报告但继续**，并把 warning 挂在 config 上由启动日志打印。
 * 3. **不在启动时创建"备用空库"。** 数据目录不存在时只做 `mkdir`（那是配置里
 *    写明的路径），**绝不**在找不到配置路径时改用一个临时路径继续跑。
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DEFAULT_SESSION_POLICY } from '../auth/session.js'
import { inspectSecretFile } from '../auth/secretFile.js'
import type { SessionPolicy } from '../auth/session.js'

/** 启动配置错误。**只在启动路径上抛出**，永远不会穿过 HTTP 边界。 */
export class ServerConfigError extends Error {
  override readonly name = 'ServerConfigError'

  constructor(message: string) {
    super(message)
  }
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

/** 请求体上限的默认值：与设计文档 07 的"4 MiB 批次"对齐。 */
export const DEFAULT_BODY_LIMIT_BYTES = 4 * 1024 * 1024

/** 请求体上限的硬上限。再大就不是"批次"，该走上传会话（upload_sessions）。 */
export const MAX_BODY_LIMIT_BYTES = 64 * 1024 * 1024

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']

/** 主密钥文件必须恰好是 32 字节（Base64 文本解码后）。 */
export const MASTER_KEY_BYTES = 32

export interface ServerConfig {
  readonly listenHost: string
  readonly listenPort: number
  /** 对外可访问的基准 URL。`NODE_ENV=production` 时必填。 */
  readonly publicUrl: string | null
  readonly dataDir: string
  readonly databasePath: string
  readonly logLevel: LogLevel
  /**
   * 受信任的代理层（IP 或 CIDR 列表）。
   *
   * 🔴 空数组表示"**不信任任何** `X-Forwarded-*`"，此时 `request.ip` 取的是
   * 直连对端的地址。设计文档 04 要求"仅信任配置过的代理层，不能盲目信任所有
   * X-Forwarded-*"——把这个列表透传给 Fastify 的 `trustProxy` 就是那条纪律的落点。
   */
  readonly trustedProxies: readonly string[]
  readonly bodyLimitBytes: number
  readonly sessionPolicy: SessionPolicy
  readonly masterKeyFile: string | null
  readonly bootstrapSecretFile: string | null
  /** 启动时发现的可疑配置（未知 `YFE_*` 变量等）。由启动日志打印。 */
  readonly warnings: readonly string[]
}

/** 测试与嵌入场景用的安全默认值。 */
export function defaultServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? resolve(process.cwd(), 'data')
  const base: ServerConfig = {
    listenHost: '127.0.0.1',
    listenPort: 8787,
    publicUrl: null,
    dataDir,
    databasePath: join(dataDir, 'db', 'yfe.db'),
    logLevel: 'info',
    trustedProxies: [],
    bodyLimitBytes: DEFAULT_BODY_LIMIT_BYTES,
    sessionPolicy: DEFAULT_SESSION_POLICY,
    masterKeyFile: null,
    bootstrapSecretFile: null,
    warnings: [],
  }
  return {
    ...base,
    ...overrides,
    dataDir,
    // databasePath 依赖 dataDir：只覆盖 dataDir 时必须重算，否则两个字段互相矛盾。
    databasePath: overrides.databasePath ?? join(dataDir, 'db', 'yfe.db'),
  }
}

/** 文档 09 中列出的环境变量 + 本任务新增的两个（代理与引导秘密文件）。 */
export const KNOWN_ENV_KEYS: readonly string[] = [
  'NODE_ENV',
  'YFE_LISTEN_HOST',
  'YFE_LISTEN_PORT',
  'YFE_PUBLIC_URL',
  'YFE_DATA_DIR',
  'YFE_DATABASE_PATH',
  'YFE_LOG_LEVEL',
  'YFE_MASTER_KEY_FILE',
  'YFE_BOOTSTRAP_SECRET_FILE',
  'YFE_TRUSTED_PROXY',
  'YFE_BODY_LIMIT_BYTES',
  'YFE_COOKIE_SECURE',
]

function fail(message: string): never {
  throw new ServerConfigError(message)
}

function parsePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw.trim())) {
    fail(`YFE_LISTEN_PORT 必须是十进制端口号，收到 ${JSON.stringify(raw)}`)
  }
  const port = Number(raw.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`YFE_LISTEN_PORT 超出 1-65535，收到 ${JSON.stringify(raw)}`)
  }
  return port
}

function parsePublicUrl(raw: string): string {
  const trimmed = raw.trim()
  let url: URL | null = null
  try {
    url = new URL(trimmed)
  } catch {
    url = null
  }
  if (url === null) return fail(`YFE_PUBLIC_URL 不是合法 URL，收到 ${JSON.stringify(raw)}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`YFE_PUBLIC_URL 只支持 http/https，收到 ${url.protocol}`)
  }
  // 末尾斜杠会让后面拼路径时出现 `//api/v1`，统一去掉。
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''))
}

function parseLogLevel(raw: string): LogLevel {
  const value = raw.trim().toLowerCase() as LogLevel
  if (!LOG_LEVELS.includes(value)) {
    fail(`YFE_LOG_LEVEL 必须是 ${LOG_LEVELS.join(' / ')} 之一，收到 ${JSON.stringify(raw)}`)
  }
  return value
}

function parseBodyLimit(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    fail(`YFE_BODY_LIMIT_BYTES 必须是整数字节数，收到 ${JSON.stringify(raw)}`)
  }
  const bytes = Number(raw.trim())
  if (bytes < 1024 || bytes > MAX_BODY_LIMIT_BYTES) {
    fail(`YFE_BODY_LIMIT_BYTES 必须在 1024 - ${MAX_BODY_LIMIT_BYTES} 之间，收到 ${bytes}`)
  }
  return bytes
}

function parseBoolean(raw: string, key: string): boolean {
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  fail(`${key} 必须是 true/false，收到 ${JSON.stringify(raw)}`)
}

/**
 * 校验一条代理条目。
 *
 * 允许 Fastify 支持的三种写法：IP、CIDR、以及内置关键字（`loopback` 等）。
 * 之所以在这里拦一次而不是直接交给 Fastify：写错的网段会被 Fastify 静默忽略，
 * 结果是"以为信任了内网代理，其实一个也不信任"（或反过来），两种都是安全事故。
 */
const PROXY_ENTRY_PATTERN =
  /^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-fA-F:]+)(\/([0-9]|[12][0-9]|3[0-2]))?$|^(loopback|linklocal|uniquelocal)$/

function parseTrustedProxies(raw: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const entry of entries) {
    if (!PROXY_ENTRY_PATTERN.test(entry)) {
      fail(
        `YFE_TRUSTED_PROXY 含有无法识别的条目 ${JSON.stringify(entry)}；` +
          '只接受 IP、CIDR（0-32 前缀）或 loopback/linklocal/uniquelocal',
      )
    }
  }
  return entries
}

/**
 * 从环境变量装载配置。
 *
 * @param env 环境变量（测试可注入）；默认 `process.env`
 * @param cwd 相对路径的基准目录；默认 `process.cwd()`
 */
export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const warnings: string[] = []

  for (const key of Object.keys(env)) {
    if (key.startsWith('YFE_') && !KNOWN_ENV_KEYS.includes(key)) {
      warnings.push(`未知的 YFE_ 环境变量：${key}（拼写错误？本版本不识别，已忽略）`)
    }
  }

  const read = (key: string): string | undefined => {
    const value = env[key]
    return value === undefined || value.trim() === '' ? undefined : value
  }

  const listenHost = read('YFE_LISTEN_HOST') ?? '127.0.0.1'
  const rawPort = read('YFE_LISTEN_PORT')
  const listenPort = rawPort === undefined ? 8787 : parsePort(rawPort)
  const rawLogLevel = read('YFE_LOG_LEVEL')
  const logLevel = rawLogLevel === undefined ? 'info' : parseLogLevel(rawLogLevel)
  const rawBodyLimit = read('YFE_BODY_LIMIT_BYTES')
  const bodyLimitBytes = rawBodyLimit === undefined ? DEFAULT_BODY_LIMIT_BYTES : parseBodyLimit(rawBodyLimit)
  const rawTrustedProxy = read('YFE_TRUSTED_PROXY')
  const trustedProxies = rawTrustedProxy === undefined ? [] : parseTrustedProxies(rawTrustedProxy)
  const rawCookieSecure = read('YFE_COOKIE_SECURE')
  const cookieSecure = rawCookieSecure === undefined ? true : parseBoolean(rawCookieSecure, 'YFE_COOKIE_SECURE')

  const rawDataDir = read('YFE_DATA_DIR')
  const dataDir = rawDataDir === undefined ? join(cwd, 'data') : resolve(cwd, rawDataDir)
  const rawDatabasePath = read('YFE_DATABASE_PATH')
  const databasePath =
    rawDatabasePath === undefined ? join(dataDir, 'db', 'yfe.db') : resolve(cwd, rawDatabasePath)

  const rawPublicUrl = read('YFE_PUBLIC_URL')
  if (rawPublicUrl === undefined && env['NODE_ENV'] === 'production') {
    // 生产必填：没有它就无法生成绝对回调地址、签名 URL 与 Cookie 域判断。
    fail('生产环境（NODE_ENV=production）必须设置 YFE_PUBLIC_URL')
  }
  const publicUrl = rawPublicUrl === undefined ? null : parsePublicUrl(rawPublicUrl)

  const rawMasterKeyFile = read('YFE_MASTER_KEY_FILE')
  const masterKeyFile = rawMasterKeyFile === undefined ? null : resolve(cwd, rawMasterKeyFile)
  if (masterKeyFile !== null) {
    // 主密钥在启动时严格校验：它是配对码 pepper 的派生源，格式不对必须立刻失败。
    readMasterKey(masterKeyFile)
  }

  const rawBootstrapSecretFile = read('YFE_BOOTSTRAP_SECRET_FILE')
  const bootstrapSecretFile = rawBootstrapSecretFile === undefined ? null : resolve(cwd, rawBootstrapSecretFile)
  if (bootstrapSecretFile !== null) {
    const inspection = inspectSecretFile(bootstrapSecretFile, { minLength: 32 })
    if (!inspection.ok) {
      // 只警告不失败：运维常常"先起服务、后放秘密文件"，而 setup 端点自己会返回 503。
      warnings.push(`引导凭据文件当前不可用（${inspection.reason}）：${bootstrapSecretFile}`)
    }
  }

  if (cookieSecure && publicUrl !== null && publicUrl.startsWith('http://')) {
    // 这个组合的症状极难自查：浏览器**照收** Set-Cookie 的响应，但之后不再回传
    // Secure Cookie，于是用户表现成"登录成功却仍是未登录"，日志里一切正常。
    // 因此必须在启动时就把它说清楚，而不是等用户来报"登录没反应"。
    warnings.push(
      `YFE_PUBLIC_URL 是 http 而 YFE_COOKIE_SECURE=true：浏览器不会回传 Secure Cookie，` +
        `登录会表现为"成功后仍是未登录"。请在前置层启用 HTTPS，或在仅私网 http 访问时显式设置 YFE_COOKIE_SECURE=false。`,
    )
  }

  return {
    listenHost,
    listenPort,
    publicUrl,
    dataDir,
    databasePath,
    logLevel,
    trustedProxies,
    bodyLimitBytes,
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure },
    masterKeyFile,
    bootstrapSecretFile,
    warnings,
  }
}

/**
 * 读取并校验主密钥（32 字节 Base64）。
 *
 * 🔴 返回的 Buffer **绝不写日志、绝不进响应**；也不需要掩码副本，
 * 因为它的唯一用途是派生 pepper。
 */
export function readMasterKey(filePath: string): Buffer {
  const inspection = inspectSecretFile(filePath, { minLength: 1 })
  if (!inspection.ok) {
    fail(`主密钥文件不可用（${inspection.reason}）：${filePath}`)
  }
  // 严格 Base64（含 base64url 变体）解码；拒绝"看起来像密码"的短文本。
  const normalized = inspection.value.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    fail(`主密钥必须是 Base64 文本（32 字节随机数的编码形式）：${filePath}`)
  }
  const key = Buffer.from(normalized, 'base64')
  if (key.length !== MASTER_KEY_BYTES) {
    fail(
      `主密钥解码后必须是 ${MASTER_KEY_BYTES} 字节，实际 ${key.length} 字节：${filePath}。` +
        '请用 `openssl rand -base64 32 > key.txt` 之类的命令生成。',
    )
  }
  return key
}

/**
 * 由主密钥派生配对码 pepper（域分离）。
 *
 * 为什么不单独存一个 pepper 文件：多一个秘密文件就多一处"没同步更新"的机会，
 * 而两个用途不同的密钥必须有**域分离**才不会互相削弱。用 SHA-256(masterKey || label)
 * 派生是最小可用的构造（这里只需要一个定长、不可逆、与主密钥不同的值）。
 */
export function derivePairingPepper(masterKey: Buffer): Buffer {
  return createHash('sha256')
    .update(masterKey)
    .update('yfe:pairing-pepper:v1', 'utf8')
    .digest()
}

/**
 * 校验目录可写性（"配置路径必须可写性检查通过"）。
 *
 * 目录不存在时**只创建配置里写明的这一条路径**（含父级），
 * 绝不改用临时目录——那条路会让服务"起来了但数据在别处"。
 */
export function assertWritableDirectory(dir: string): void {
  let created = false
  try {
    const stats = statSync(dir)
    if (!stats.isDirectory()) fail(`路径存在但不是目录：${dir}`)
  } catch (error) {
    if (error instanceof ServerConfigError) throw error
    try {
      mkdirSync(dir, { recursive: true })
      created = true
    } catch {
      fail(`数据目录不存在且无法创建：${dir}`)
    }
  }
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    fail(`数据目录不可写：${dir}${created ? '（本进程刚创建它）' : ''}`)
  }
}
