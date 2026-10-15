/**
 * 启动/停止路径测试：配置装载 → 真实文件库装配 → 优雅停止闸门。
 *
 * 为什么单独一个文件：这几条是**部署契约**（`09-部署与运维.md`），
 * 出错的后果不是"某个接口 500"，而是"服务带着错的配置起来了"或者
 * "数据写到了别的地方"。所以这里断言的是"宁可启动失败，也不静默降级"。
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { DEFAULT_SESSION_POLICY } from '../src/auth/session.js'
import {
  MASTER_KEY_BYTES,
  ServerConfigError,
  assertWritableDirectory,
  defaultServerConfig,
  derivePairingPepper,
  loadServerConfig,
  readMasterKey,
} from '../src/http/config.js'
import type { ServerConfig } from '../src/http/config.js'
import { bootstrapServer, createServer } from '../src/http/server.js'
import type { ServerLifecycle } from '../src/http/server.js'
import { migrateServerDatabase } from '../src/db/migrator.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'
import type { ServerDb } from '../src/db/open.js'
import { ensureServerState } from '../src/db/serverState.js'
import {
  SETUP_URL,
  TEST_BOOTSTRAP_SECRET,
  TEST_PASSWORD,
  cleanupTempDirs,
  makeTempDir,
  writeSecretFile,
} from './helpers.js'

const POLICY = { ...DEFAULT_SESSION_POLICY, cookieSecure: false }
const ME_URL = '/api/v1/users/me'

afterAll(() => {
  cleanupTempDirs()
})

// ---------------------------------------------------------------------------
// 配置装载
// ---------------------------------------------------------------------------

describe('配置装载（环境变量契约）', () => {
  it('默认值：只监听回环、8787、info、不信任任何代理', () => {
    const cwd = makeTempDir()
    const config = loadServerConfig({}, cwd)
    expect(config.listenHost).toBe('127.0.0.1')
    expect(config.listenPort).toBe(8787)
    expect(config.logLevel).toBe('info')
    expect(config.trustedProxies).toEqual([])
    expect(config.dataDir).toBe(join(cwd, 'data'))
    expect(config.databasePath).toBe(join(cwd, 'data', 'db', 'yfe.db'))
    expect(config.warnings).toEqual([])
    // 默认必须开 Secure（生产走 https 反代）；测试要关掉得显式写 false。
    expect(config.sessionPolicy.cookieSecure).toBe(true)
  })

  it('生产环境缺少 YFE_PUBLIC_URL 直接启动失败（绝不猜一个地址）', () => {
    const cwd = makeTempDir()
    expect(() => loadServerConfig({ NODE_ENV: 'production' }, cwd)).toThrow(ServerConfigError)
    const ok = loadServerConfig(
      { NODE_ENV: 'production', YFE_PUBLIC_URL: 'https://notes.example.com/' },
      cwd,
    )
    // 末尾斜杠被规范化掉，否则后面拼路径会得到 `//api/v1`。
    expect(ok.publicUrl).toBe('https://notes.example.com')
  })

  it('未知的 YFE_* 变量报告但不阻塞启动', () => {
    const cwd = makeTempDir()
    const config = loadServerConfig({ YFE_DATA_DIR: cwd, YFE_TYPO_HERE: '1' }, cwd)
    expect(config.warnings.join(' ')).toContain('YFE_TYPO_HERE')
    expect(config.dataDir).toBe(cwd)
  })

  it('已知变量的非法值一律失败，不做"取默认值"的静默兜底', () => {
    const cwd = makeTempDir()
    const bad: readonly NodeJS.ProcessEnv[] = [
      { YFE_LISTEN_PORT: '0' },
      { YFE_LISTEN_PORT: '70000' },
      { YFE_LISTEN_PORT: 'abc' },
      { YFE_LOG_LEVEL: 'loud' },
      { YFE_BODY_LIMIT_BYTES: '512' },
      { YFE_BODY_LIMIT_BYTES: '999999999' },
      { YFE_COOKIE_SECURE: 'yes' },
      { YFE_PUBLIC_URL: 'ftp://example.com' },
      { YFE_PUBLIC_URL: '不是 URL' },
    ]
    for (const env of bad) {
      expect(() => loadServerConfig(env, cwd), JSON.stringify(env)).toThrow(ServerConfigError)
    }
  })

  it('可信代理列表逐条校验：写错的网段会被静默忽略，所以必须拦下来', () => {
    const cwd = makeTempDir()
    const ok = loadServerConfig(
      { YFE_TRUSTED_PROXY: '10.0.0.0/8, 127.0.0.1, loopback', YFE_DATA_DIR: cwd },
      cwd,
    )
    expect(ok.trustedProxies).toHaveLength(3)
    for (const bad of ['10.0.0.0/33', 'not-an-ip', '10.0.0.0/8, nope']) {
      expect(() => loadServerConfig({ YFE_TRUSTED_PROXY: bad }, cwd), bad).toThrow(
        ServerConfigError,
      )
    }
  })

  it('YFE_COOKIE_SECURE 接受 true/false/1/0', () => {
    const cwd = makeTempDir()
    expect(loadServerConfig({ YFE_COOKIE_SECURE: 'false' }, cwd).sessionPolicy.cookieSecure).toBe(false)
    expect(loadServerConfig({ YFE_COOKIE_SECURE: '0' }, cwd).sessionPolicy.cookieSecure).toBe(false)
    expect(loadServerConfig({ YFE_COOKIE_SECURE: 'TRUE' }, cwd).sessionPolicy.cookieSecure).toBe(true)
  })

  it('http 公网地址 + Secure Cookie 必须给出启动警告（否则症状是"登录成功却仍未登录"）', () => {
    const cwd = makeTempDir()
    // 默认 cookieSecure=true（config.ts:235），而 YFE_PUBLIC_URL 是 http ⇒ 浏览器
    // 不会回传 Secure Cookie。日志里一切正常，只有用户看到"登录没反应"。
    const warned = loadServerConfig({ YFE_PUBLIC_URL: 'http://nas.local:8787' }, cwd)
    expect(warned.warnings.join(' ')).toContain('YFE_COOKIE_SECURE=false')

    // HTTPS 下没有任何警告：Secure Cookie 与地址匹配。
    expect(loadServerConfig({ YFE_PUBLIC_URL: 'https://nas.local' }, cwd).warnings).toEqual([])

    // 显式降级（仅私网 http）也不该再报警：运维已经做过选择。
    expect(
      loadServerConfig(
        { YFE_PUBLIC_URL: 'http://nas.local:8787', YFE_COOKIE_SECURE: 'false' },
        cwd,
      ).warnings,
    ).toEqual([])
  })

  it('YFE_DATABASE_PATH 覆盖数据目录推断值', () => {
    const cwd = makeTempDir()
    const config = loadServerConfig(
      { YFE_DATA_DIR: 'data-root', YFE_DATABASE_PATH: 'elsewhere/yfe.db' },
      cwd,
    )
    expect(config.dataDir).toBe(join(cwd, 'data-root'))
    expect(config.databasePath).toBe(join(cwd, 'elsewhere', 'yfe.db'))
  })
})

// ---------------------------------------------------------------------------
// 主密钥 / pepper
// ---------------------------------------------------------------------------

describe('主密钥与配对 pepper', () => {
  it('接受 32 字节 Base64 主密钥，返回 32 字节原始密钥', () => {
    const key = Buffer.alloc(MASTER_KEY_BYTES, 9)
    const file = writeSecretFile('master_key', key.toString('base64'))
    const loaded = readMasterKey(file)
    expect(loaded).toHaveLength(MASTER_KEY_BYTES)
    expect(loaded.equals(key)).toBe(true)
  })

  it('长度不对的主密钥失败，且错误消息里不能出现密钥内容', () => {
    const secretText = Buffer.alloc(16, 3).toString('base64')
    const file = writeSecretFile('master_key_short', secretText)
    let message = ''
    try {
      readMasterKey(file)
      throw new Error('应当失败却没有失败')
    } catch (error) {
      expect(error).toBeInstanceOf(ServerConfigError)
      message = (error as Error).message
    }
    expect(message).not.toContain(secretText)
  })

  it('文件不存在或内容不是 Base64 都失败', () => {
    const cwd = makeTempDir()
    expect(() => readMasterKey(join(cwd, 'nope'))).toThrow(ServerConfigError)
    expect(() => readMasterKey(writeSecretFile('master_key_bad', '!!!not base64!!!'))).toThrow(
      ServerConfigError,
    )
  })

  it('配对 pepper 由主密钥做域分离派生：确定、等长、与主密钥不同', () => {
    const key = Buffer.alloc(MASTER_KEY_BYTES, 21)
    const first = derivePairingPepper(key)
    const second = derivePairingPepper(key)
    expect(first).toHaveLength(32)
    expect(first.equals(second)).toBe(true)
    expect(first.equals(key)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 数据目录
// ---------------------------------------------------------------------------

describe('数据目录可写性', () => {
  it('目录不存在时按配置路径创建（含父级）', () => {
    const cwd = makeTempDir()
    const nested = join(cwd, 'deep', 'nested', 'data')
    assertWritableDirectory(nested)
    expect(statSync(nested).isDirectory()).toBe(true)
  })

  it('路径存在但不是目录 → 明确失败，不换临时目录', () => {
    const cwd = makeTempDir()
    const file = join(cwd, 'data')
    writeFileSync(file, 'i am a file', 'utf8')
    expect(() => assertWritableDirectory(file)).toThrow(ServerConfigError)
    expect(existsSync(file)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// bootstrapServer：真实文件库装配
// ---------------------------------------------------------------------------

interface BootedHarness {
  readonly handle: Awaited<ReturnType<typeof bootstrapServer>>
  close(): Promise<void>
}

const booted: BootedHarness[] = []

async function boot(config: ServerConfig): Promise<Awaited<ReturnType<typeof bootstrapServer>>> {
  const handle = await bootstrapServer(config, { listen: false, logger: false })
  booted.push({ handle, close: () => handle.close() })
  return handle
}

afterEach(async () => {
  for (const entry of booted.splice(0)) {
    await entry.close()
  }
})

function bootConfig(cwd: string): ServerConfig {
  return defaultServerConfig({
    dataDir: cwd,
    databasePath: join(cwd, 'db', 'yfe.db'),
    sessionPolicy: POLICY,
    bootstrapSecretFile: writeSecretFile('bootstrap.txt', TEST_BOOTSTRAP_SECRET),
  })
}

describe('bootstrapServer 启动装配', () => {
  it('建库 + 迁移 + 服务状态行，并把健康接口挂起来（未初始化）', async () => {
    const cwd = makeTempDir()
    const handle = await boot(bootConfig(cwd))

    expect(handle.serverId.startsWith('srv_')).toBe(true)
    expect(handle.lifecycle.shuttingDown).toBe(false)
    expect(existsSync(join(cwd, 'db', 'yfe.db'))).toBe(true)

    const ready = await handle.app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json<{ initialized: boolean }>().initialized).toBe(false)

    // setup 还没跑过：初始化入口必须开着。
    const setup = await handle.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: {
        bootstrapSecret: TEST_BOOTSTRAP_SECRET,
        username: 'owner',
        password: TEST_PASSWORD,
      },
    })
    expect(setup.statusCode).toBe(201)
  })

  it('重启后 serverId 与初始化状态都从库里读回（身份不随重启漂移）', async () => {
    const cwd = makeTempDir()
    const config = bootConfig(cwd)

    const first = await boot(config)
    const firstId = first.serverId
    const setup = await first.app.inject({
      method: 'POST',
      url: SETUP_URL,
      payload: {
        bootstrapSecret: TEST_BOOTSTRAP_SECRET,
        username: 'owner',
        password: TEST_PASSWORD,
      },
    })
    expect(setup.statusCode).toBe(201)
    await first.close()

    const second = await boot(config)
    expect(second.serverId).toBe(firstId)
    const ready = await second.app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json<{ initialized: boolean }>().initialized).toBe(true)
  })

  it('装配中途失败也必须关掉已打开的连接（否则修好配置后重启会撞独占写者）', async () => {
    const cwd = makeTempDir()
    const databasePath = join(cwd, 'db', 'yfe.db')
    mkdirSync(join(cwd, 'db'), { recursive: true })

    // 构造一个"schema 比程序新"的真库：迁移会在**建库成功之后**失败，
    // 正好覆盖 bootstrapServer 的 catch 分支（那里必须关连接）。
    const seed = openServerDatabase(databasePath)
    await migrateServerDatabase(seed)
    seed
      .prepare(
        'INSERT INTO server_schema_migrations (version, checksum, applied_at, success) VALUES (?, ?, ?, 1)',
      )
      .run(99, 'future', new Date().toISOString())
    closeServerDatabase(seed)

    const config = defaultServerConfig({ dataDir: cwd, databasePath, sessionPolicy: POLICY })
    await expect(bootstrapServer(config, { listen: false, logger: false })).rejects.toMatchObject({
      code: 'STORAGE_SCHEMA_TOO_NEW',
    })

    // 独占写者登记表按路径登记：连接没关干净的话，这里会抛 RESOURCE_LOCKED，
    // 让"改配置后重启"永远修不好。
    const reopened = openServerDatabase(databasePath)
    closeServerDatabase(reopened)
  })
})

// ---------------------------------------------------------------------------
// 优雅停止闸门
// ---------------------------------------------------------------------------

interface GateHarness {
  readonly app: FastifyInstance
  readonly lifecycle: ServerLifecycle
  close(): void
}

const gates: GateHarness[] = []

async function makeGateHarness(): Promise<GateHarness> {
  const db: ServerDb = openServerDatabase(':memory:')
  try {
    await migrateServerDatabase(db)
  } catch (error) {
    closeServerDatabase(db)
    throw error
  }
  ensureServerState(db, 'srv_gate', null)
  const lifecycle: ServerLifecycle = { shuttingDown: false }
  const app = createServer({
    config: defaultServerConfig({ sessionPolicy: POLICY }),
    db,
    serverId: 'srv_gate',
    logger: false,
    lifecycle,
  })
  await app.ready()
  const harness: GateHarness = { app, lifecycle, close: () => closeServerDatabase(db) }
  gates.push(harness)
  return harness
}

afterEach(() => {
  for (const entry of gates.splice(0)) entry.close()
})

describe('优雅停止闸门', () => {
  it('停止中：业务接口一律 503，但 /health/live 仍然 200（进程还活着）', async () => {
    const harness = await makeGateHarness()

    const before = await harness.app.inject({ method: 'GET', url: ME_URL })
    expect(before.statusCode).toBe(401)

    harness.lifecycle.shuttingDown = true

    const blocked = await harness.app.inject({ method: 'GET', url: ME_URL })
    expect(blocked.statusCode).toBe(503)
    const body = blocked.json<Record<string, unknown>>()
    expect(body['code']).toBe('SERVICE_SHUTTING_DOWN')
    // 结构仍是统一五字段，且 requestId 与响应头一致。
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'requestId', 'retryable'].sort())
    expect(blocked.headers['x-request-id']).toBe(body['requestId'])

    // live 是给编排器判断"要不要重启进程"的，停止过程中不能失败。
    const live = await harness.app.inject({ method: 'GET', url: '/health/live' })
    expect(live.statusCode).toBe(200)

    // ready 表示"能不能接活"，停止中必须为 503。
    const ready = await harness.app.inject({ method: 'GET', url: '/health/ready' })
    expect(ready.statusCode).toBe(503)
  })
})
