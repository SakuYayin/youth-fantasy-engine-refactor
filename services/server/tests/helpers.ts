/**
 * 服务端测试基座。
 *
 * 纪律：
 * - **不监听端口**。全部走 `app.inject()`，避免测试之间抢端口、也避免把
 *   真实网络行为混进断言里。
 * - 每个用例自己开一个**内存库**并跑完整迁移，不复用跨用例状态；
 *   独占写连接登记表按路径登记，内存库路径都是 `:memory:`，所以同一时刻
 *   只允许一个存活连接——用完必须 `close()`（`afterEach` 里统一关）。
 * - 时间来自可注入的 `TestClock`：过期、TTL、绝对过期这些断言不能靠 `sleep`。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newIds } from '@yfe/contracts'
import type { Clock, UserId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import { hashPassword } from '../src/auth/password.js'
import { defaultServerConfig } from '../src/http/config.js'
import type { ServerConfig } from '../src/http/config.js'
import { createRateLimiter } from '../src/http/rateLimit.js'
import type { RateLimiter } from '../src/http/rateLimit.js'
import { createServer } from '../src/http/server.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import { createUserWithMembership } from '../src/db/users.js'

export const TEST_PEPPER = Buffer.alloc(32, 7)
export const TEST_BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-0123456789'
export const TEST_PASSWORD = 'correct-horse-battery'
export const TEST_USERNAME = 'owner'

// ---------------------------------------------------------------------------
// 临时文件
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yfe-server-test-'))
  tempDirs.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上仍被句柄占用的目录会 EPERM。临时目录残留不该把一个
      // 真实断言失败淹没成"套件加载失败"，所以这里只吞掉清理错误。
    }
  }
}

/** 写一个秘密文件（POSIX 上 0600；Windows 上权限位无意义，检查会跳过）。 */
export function writeSecretFile(name: string, value: string): string {
  const file = join(makeTempDir(), name)
  writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 })
  return file
}

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

export interface TestClock extends Clock {
  advance(ms: number): void
  set(iso: string): void
}

export function testClock(startIso = '2026-01-01T00:00:00.000Z'): TestClock {
  let current = Date.parse(startIso)
  return {
    now: () => new Date(current).toISOString() as UtcTimestamp,
    advance(ms: number): void {
      current += ms
    },
    set(iso: string): void {
      current = Date.parse(iso)
    },
  }
}

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

export interface TestHarness {
  readonly app: FastifyInstance
  readonly db: ServerDb
  readonly clock: TestClock
  readonly config: ServerConfig
  readonly serverId: string
  readonly setupLimiter: RateLimiter
  readonly loginLimiter: RateLimiter
  close(): void
}

export interface TestHarnessOptions {
  readonly config?: Partial<ServerConfig>
  readonly bootstrapSecretFile?: string | null
  readonly serverId?: string
  readonly clock?: TestClock
  /** 覆盖默认限流器：限流用例需要很小的窗口，不能把真实阈值跑满。 */
  readonly limiters?: {
    readonly setup?: RateLimiter
    readonly login?: RateLimiter
  }
}

export async function makeHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const db = openServerDatabase(':memory:')
  // 建实例/迁移失败也必须关库：独占写连接按路径登记，漏关一个会让后续
  // 用例全部撞上 RESOURCE_LOCKED，把真正的失败原因掩盖掉。
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  const clock = options.clock ?? testClock()
  const serverId = options.serverId ?? 'srv_test'
  const config: ServerConfig = defaultServerConfig({
    sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure: false },
    ...options.config,
    ...(options.bootstrapSecretFile === undefined
      ? {}
      : { bootstrapSecretFile: options.bootstrapSecretFile }),
  })

  ensureServerState(db, serverId, config.bootstrapSecretFile)

  const setupLimiter =
    options.limiters?.setup ?? createRateLimiter({ windowMs: 60_000, maxAttempts: 1000 })
  const loginLimiter =
    options.limiters?.login ?? createRateLimiter({ windowMs: 60_000, maxAttempts: 1000 })

  const app = createServer({
    config,
    db,
    serverId,
    clock,
    logger: false,
    rateLimiters: { setup: setupLimiter, login: loginLimiter },
  })
  // 让插件（cookie）与路由就绪，后续 `inject()` 才能拿到真实行为。
  try {
    await app.ready()
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }

  return {
    app,
    db,
    clock,
    config,
    serverId,
    setupLimiter,
    loginLimiter,
    close(): void {
      closeServerDatabase(db)
    },
  }
}

/** 直接落一个已初始化 + 可登录的用户，跳过 setup（多数测试只关心登录之后的事）。 */
export async function seedOwner(
  db: ServerDb,
  at: UtcTimestamp,
  overrides: {
    readonly username?: string
    readonly password?: string
    readonly role?: 'owner' | 'admin' | 'editor' | 'viewer'
  } = {},
): Promise<{ readonly userId: UserId; readonly workspaceId: WorkspaceId }> {
  const userId = newIds.user() as UserId
  const workspaceId = newIds.workspace() as WorkspaceId
  const passwordHash = await hashPassword(overrides.password ?? TEST_PASSWORD)
  createUserWithMembership(db, {
    id: userId,
    username: overrides.username ?? TEST_USERNAME,
    displayName: 'Owner',
    passwordHash,
    at,
    workspaceId,
    role: overrides.role ?? 'owner',
  })
  return { userId, workspaceId }
}

// ---------------------------------------------------------------------------
// 响应辅助
// ---------------------------------------------------------------------------

export interface InjectLike {
  readonly headers: Record<string, unknown>
  readonly statusCode: number
  readonly body: string
  json<T = Record<string, unknown>>(): T
}

/** 取 `set-cookie` 的所有取值（Fastify 在多于一个时返回数组）。 */
export function setCookiesOf(response: InjectLike): readonly string[] {
  const raw = response.headers['set-cookie']
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string')
  return []
}

/** 取某个 cookie 的原始 `Set-Cookie` 头（含属性）。 */
export function setCookieHeader(response: InjectLike, name: string): string | undefined {
  const prefix = `${name}=`
  return setCookiesOf(response).find((header) => header.startsWith(prefix))
}

/** 取某个 cookie 的值。 */
export function cookieValue(response: InjectLike, name: string): string | undefined {
  const header = setCookieHeader(response, name)
  if (header === undefined) return undefined
  const prefix = `${name}=`
  const rest = header.slice(prefix.length)
  const end = rest.indexOf(';')
  return end === -1 ? rest : rest.slice(0, end)
}

/** 把若干 cookie 拼成请求头值。 */
export function cookieHeader(pairs: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export const REFRESH_URL = '/api/v1/auth/refresh'
export const LOGIN_URL = '/api/v1/auth/login'
export const LOGOUT_URL = '/api/v1/auth/logout'
export const ME_URL = '/api/v1/users/me'
export const SETUP_URL = '/api/v1/setup'

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
