/**
 * `@yfe/server` 的启动入口（`npm run dev -w @yfe/server` / `npm start`）。
 *
 * 为什么需要它（R-27）：后端此前只有库接口，没有任何"把进程跑起来"的路径，
 * 于是「启动失败不能创建另一个临时空库继续运行」「数据目录不可写直接失败」
 * 这些设计文档 `09-部署与运维.md` 的硬要求**没有可执行的验收对象**。
 *
 * 三条纪律：
 * 1. **只提示、不打印秘密**：日志里有文件路径与可用性，绝无秘密内容
 *    （设计文档 `04-后端与安全.md`、`11-测试验收与迁移.md:44`）。
 * 2. **`--check` 是启动前体检**：装配（含迁移）跑完、表齐全检查通过才返回 0，
 *    让部署脚本能在对外监听之前拦住"库比程序新""迁移没跑完"这类问题。
 * 3. 优雅停止：先关闸门、再关 Fastify、最后关数据库（顺序在 `startServer` 内），
 *    本模块只负责把信号译成一次 `close()`。
 */

import { join, resolve } from 'node:path'

import { loadServerConfig, ServerConfigError, type ServerConfig } from './http/config.js'
import { bootstrapServer, type BootstrapResult } from './http/server.js'
import { SERVER_SCHEMA_VERSION, SERVER_TABLES } from './db/ddl.js'
import { currentServerSchemaVersion, missingServerTables } from './db/migrator.js'

/** 解析后的命令行参数。 */
export interface ServerCliOptions {
  /** 数据目录（相对路径按 cwd 解析）；覆盖 `YFE_DATA_DIR`。 */
  readonly dataDir?: string
  readonly listenHost?: string
  readonly listenPort?: number
  /** 只做启动前体检，不改动端口监听。 */
  readonly check: boolean
  readonly help: boolean
}

export type ParsedServerArgs =
  | { readonly ok: true; readonly options: ServerCliOptions }
  | { readonly ok: false; readonly error: string }

export function serverCliUsage(): string {
  return [
    '用法：node bin/serve.mjs [选项]',
    '',
    '选项：',
    '  --data-dir=<路径>   数据目录（覆盖 YFE_DATA_DIR；相对路径按当前目录解析）',
    '  --host=<地址>       监听地址（覆盖 YFE_LISTEN_HOST，默认 127.0.0.1）',
    '  --port=<端口>       监听端口（覆盖 YFE_LISTEN_PORT，默认 8787）',
    '  --check             只做启动前体检：装配 + 迁移 + 表齐全，不监听端口',
    '  --help, -h          显示本帮助',
    '',
    '环境变量：YFE_LISTEN_HOST / YFE_LISTEN_PORT / YFE_PUBLIC_URL / YFE_DATA_DIR /',
    '  YFE_DATABASE_PATH / YFE_LOG_LEVEL / YFE_MASTER_KEY_FILE / YFE_BOOTSTRAP_SECRET_FILE /',
    '  YFE_TRUSTED_PROXY / YFE_BODY_LIMIT_BYTES / YFE_COOKIE_SECURE',
  ].join('\n')
}

function parsePortValue(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

export function parseServerArgs(argv: readonly string[]): ParsedServerArgs {
  const options: {
    dataDir?: string
    listenHost?: string
    listenPort?: number
    check: boolean
    help: boolean
  } = { check: false, help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === undefined) continue
    const arg = raw.trim()
    if (arg.length === 0) continue
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--check') {
      options.check = true
      continue
    }

    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (name !== '--data-dir' && name !== '--host' && name !== '--port') {
      return { ok: false, error: `无法识别的参数：${arg}` }
    }

    let value = equals === -1 ? undefined : arg.slice(equals + 1)
    if (value === undefined) {
      const next = argv[index + 1]
      if (next === undefined || next.trim().startsWith('--')) {
        return { ok: false, error: `${name} 需要一个值` }
      }
      value = next
      index += 1
    }
    if (value.trim().length === 0) {
      return { ok: false, error: `${name} 的值不能为空` }
    }

    if (name === '--data-dir') {
      options.dataDir = value
    } else if (name === '--host') {
      options.listenHost = value
    } else {
      const port = parsePortValue(value)
      if (port === null) {
        return { ok: false, error: `--port 必须是 1-65535 的十进制端口号，收到 ${JSON.stringify(value)}` }
      }
      options.listenPort = port
    }
  }

  return { ok: true, options }
}

/**
 * 环境变量配置 + 命令行覆盖。
 *
 * 🔴 `dataDir` 与 `databasePath` 必须一致：只覆盖 `dataDir` 而沿用旧的
 * `databasePath` 会让服务把库写到另一个目录（运维以为换了盘，其实没换）。
 * 因此覆盖 `dataDir` 时同步重算 `databasePath`——除非调用方显式设了
 * `YFE_DATABASE_PATH`（那时以显式路径为准）。
 */
export function resolveCliConfig(
  options: ServerCliOptions,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const base = loadServerConfig(env, cwd)
  // 🔴 不能用 `Partial<ServerConfig>`：映射类型会保留 `readonly`，
  // 赋值时报 TS2540（与 `src/auth/password.ts` 同一个坑）。这里用显式可变局部。
  const overrides: {
    dataDir?: string
    databasePath?: string
    listenHost?: string
    listenPort?: number
  } = {}

  if (options.dataDir !== undefined) {
    const dataDir = resolve(cwd, options.dataDir)
    overrides.dataDir = dataDir
    const rawDatabasePath = env['YFE_DATABASE_PATH']
    if (rawDatabasePath === undefined || rawDatabasePath.trim() === '') {
      overrides.databasePath = join(dataDir, 'db', 'yfe.db')
    }
  }
  if (options.listenHost !== undefined) overrides.listenHost = options.listenHost
  if (options.listenPort !== undefined) overrides.listenPort = options.listenPort

  return { ...base, ...overrides }
}

export interface ServerCliIo {
  out(line: string): void
  err(line: string): void
}

export interface RunServerCliDeps {
  readonly io?: ServerCliIo
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** 是否监听端口；默认体检模式不监听、正常运行监听。 */
  readonly listen?: boolean
  /**
   * 等待关闭信号。默认 `null`（不等待，装完就退出）——真实入口由
   * `bin/serve.mjs` 传入"等 SIGINT/SIGTERM"的实现，测试传 null 保持确定性。
   */
  readonly waitForShutdown?: (() => Promise<void>) | null
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof ServerConfigError) return `配置错误：${thrown.message}`
  if (thrown instanceof Error) return `启动失败：${thrown.name}: ${thrown.message}`
  return `启动失败：${String(thrown)}`
}

/**
 * 跑一次服务进程；返回进程退出码。
 *
 * @returns 0 成功 / 1 装配或体检失败 / 2 参数或配置错误
 */
export async function runServerCli(argv: readonly string[], deps: RunServerCliDeps = {}): Promise<number> {
  const io: ServerCliIo =
    deps.io ?? {
      out: (line) => {
        console.log(line)
      },
      err: (line) => {
        console.error(line)
      },
    }

  const parsed = parseServerArgs(argv)
  if (!parsed.ok) {
    io.err(parsed.error)
    io.err('用 --help 查看用法。')
    return 2
  }
  if (parsed.options.help) {
    io.out(serverCliUsage())
    return 0
  }

  let config: ServerConfig
  try {
    config = resolveCliConfig(parsed.options, deps.env ?? process.env, deps.cwd ?? process.cwd())
  } catch (thrown) {
    io.err(describeThrown(thrown))
    return 2
  }

  const listening = deps.listen ?? !parsed.options.check
  let handle: BootstrapResult
  try {
    handle = await bootstrapServer(config, { listen: listening, logger: listening })
  } catch (thrown) {
    io.err(describeThrown(thrown))
    return 1
  }

  try {
    for (const warning of handle.warnings) {
      io.err(JSON.stringify({ level: 'warn', event: 'config.warning', message: warning }))
    }

    const schemaVersion = currentServerSchemaVersion(handle.db)
    const missingTables = missingServerTables(handle.db, Object.values(SERVER_TABLES))

    if (parsed.options.check) {
      const ok = missingTables.length === 0 && schemaVersion === SERVER_SCHEMA_VERSION
      io.out(
        JSON.stringify({
          event: 'server.preflight',
          ok,
          databasePath: config.databasePath,
          schemaVersion,
          expectedSchemaVersion: SERVER_SCHEMA_VERSION,
          tableCount: Object.keys(SERVER_TABLES).length,
          missingTables,
          serverId: handle.serverId,
          warnings: handle.warnings,
        }),
      )
      return ok ? 0 : 1
    }

    io.out(
      JSON.stringify({
        // 只有真的监听了才说 listening：嵌入场景（`listen:false`）说 listening 会误导运维。
        event: listening ? 'server.listening' : 'server.ready',
        host: config.listenHost,
        port: config.listenPort,
        publicUrl: config.publicUrl,
        databasePath: config.databasePath,
        schemaVersion,
        expectedSchemaVersion: SERVER_SCHEMA_VERSION,
        serverId: handle.serverId,
        pid: process.pid,
        trustedProxies: config.trustedProxies,
      }),
    )

    const waitForShutdown = deps.waitForShutdown
    if (waitForShutdown !== undefined && waitForShutdown !== null) {
      await waitForShutdown()
      io.out(JSON.stringify({ event: 'server.shutdown_requested', serverId: handle.serverId }))
    }
    return 0
  } finally {
    await handle.close()
    if (listening) {
      io.out(JSON.stringify({ event: 'server.stopped', serverId: handle.serverId }))
    }
  }
}
