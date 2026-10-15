/**
 * `src/cli.ts` 的用例：命令行解析、环境变量与命令行合流、启动前体检、正常启动。
 *
 * 测试取向（沿用本仓纪律）：
 * - 一律用**真实文件库**（R-25 的教训：`:memory:` 会把"仅落盘路径才走到"的分支藏起来）。
 * - 体检失败的用例必须先**真的把库弄坏**（改 schema 版本号），而不是 mock 一个抛错。
 * - 断言只依赖对外可观察的输出（退出码 + JSON 行），不依赖 pino 的日志文本。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseServerArgs, resolveCliConfig, runServerCli, serverCliUsage } from '../src/cli.js'
import type { ServerCliIo } from '../src/cli.js'
import { SERVER_SCHEMA_VERSION, SERVER_TABLES } from '../src/db/ddl.js'
import { closeServerDatabase, openServerDatabase } from '../src/db/open.js'

const tempDirs: string[] = []

function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yfe-cli-${label}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 上文件句柄释放有延迟；残留目录在系统临时区，不影响断言。
    }
  }
})

interface Captured {
  readonly io: ServerCliIo
  readonly out: readonly string[]
  readonly err: readonly string[]
  payloads(): readonly Record<string, unknown>[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      out: (line) => {
        out.push(line)
      },
      err: (line) => {
        err.push(line)
      },
    },
    out,
    err,
    payloads: () => out.flatMap((line) => parseJsonLines(line)),
  }
}

function parseJsonLines(line: string): Record<string, unknown>[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : []
  } catch {
    return []
  }
}

function eventOf(payload: Record<string, unknown>): unknown {
  return payload['event']
}

describe('命令行解析', () => {
  it('--help 与 -h 都打出用法（含环境变量清单）且不解析其它参数', () => {
    for (const flag of ['--help', '-h']) {
      const parsed = parseServerArgs([flag])
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.options.help).toBe(true)
    }
    const usage = serverCliUsage()
    expect(usage).toContain('用法：node bin/serve.mjs')
    expect(usage).toContain('YFE_BOOTSTRAP_SECRET_FILE')
  })

  it('未知参数直接失败（不静默忽略）', () => {
    const parsed = parseServerArgs(['--data-dir=x', '--nope'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('无法识别的参数：--nope')
  })

  it('--port 的非法值被拒绝，且不产生半成品配置', () => {
    for (const bad of ['0', '65536', 'abc', '', '8_0']) {
      const parsed = parseServerArgs([`--port=${bad}`])
      if (bad === '') {
        // `--port=` 是"给了空值"，必须与"没给值"一样被拒。
        expect(parsed.ok).toBe(false)
      } else {
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) expect(parsed.error).toContain('--port 必须是 1-65535')
      }
    }
  })

  it('--port 缺值（后面跟着另一个选项）被拒绝', () => {
    const parsed = parseServerArgs(['--port', '--check'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('需要一个值')
  })

  it('等号与空格两种写法都接受，--check 是开关', () => {
    const parsed = parseServerArgs(['--data-dir=./x', '--host', '0.0.0.0', '--port', '9000', '--check'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.options).toEqual({
      dataDir: './x',
      listenHost: '0.0.0.0',
      listenPort: 9000,
      check: true,
      help: false,
    })
  })
})

describe('环境变量与命令行合流', () => {
  it('覆盖 dataDir 时必须同步重算 databasePath（否则两个字段互相矛盾）', () => {
    const cwd = makeTempDir('cfg')
    const config = resolveCliConfig({ dataDir: 'data-custom', check: true, help: false }, {}, cwd)
    expect(config.dataDir).toBe(join(cwd, 'data-custom'))
    expect(config.databasePath).toBe(join(cwd, 'data-custom', 'db', 'yfe.db'))
  })

  it('显式 YFE_DATABASE_PATH 优先于 dataDir 推导', () => {
    const cwd = makeTempDir('cfg-env')
    const explicit = join(cwd, 'elsewhere', 'other.db')
    const config = resolveCliConfig({ dataDir: 'data-custom', check: true, help: false }, { YFE_DATABASE_PATH: explicit }, cwd)
    expect(config.dataDir).toBe(join(cwd, 'data-custom'))
    expect(config.databasePath).toBe(explicit)
  })

  it('命令行 --host/--port 覆盖环境变量，其余字段沿用环境', () => {
    const cwd = makeTempDir('cfg-override')
    const config = resolveCliConfig({ listenHost: '0.0.0.0', listenPort: 9999, check: true, help: false }, { YFE_LISTEN_HOST: '127.0.0.1', YFE_LISTEN_PORT: '8787', YFE_LOG_LEVEL: 'debug' }, cwd)
    expect(config.listenHost).toBe('0.0.0.0')
    expect(config.listenPort).toBe(9999)
    expect(config.logLevel).toBe('debug')
  })

  it('配置错误返回退出码 2，而不是把它当启动失败', async () => {
    const harness = capture()
    const code = await runServerCli([], {
      io: harness.io,
      env: { YFE_LISTEN_PORT: 'not-a-port' },
      cwd: makeTempDir('cfg-bad'),
    })
    expect(code).toBe(2)
    expect(harness.err.join('\n')).toContain('配置错误')
  })
})

describe('启动前体检（--check）', () => {
  it('空目录：装配 + 迁移全部完成后才 ok，且报出表数量与版本', async () => {
    const dataDir = makeTempDir('check-fresh')
    const harness = capture()
    const code = await runServerCli(['--check'], { io: harness.io, env: {}, cwd: dataDir })
    expect(code).toBe(0)
    const payloads = harness.payloads()
    const preflight = payloads.find((payload) => eventOf(payload) === 'server.preflight')
    expect(preflight).toBeDefined()
    expect(preflight?.['ok']).toBe(true)
    expect(preflight?.['schemaVersion']).toBe(SERVER_SCHEMA_VERSION)
    expect(preflight?.['missingTables']).toEqual([])
    expect(preflight?.['tableCount']).toBe(Object.keys(SERVER_TABLES).length)
    expect(typeof preflight?.['serverId']).toBe('string')
  })

  it('体检是幂等的：同一个库连跑两次都是 0，且不改动版本号', async () => {
    const dataDir = makeTempDir('check-twice')
    const first = capture()
    expect(await runServerCli(['--check'], { io: first.io, env: {}, cwd: dataDir })).toBe(0)
    const second = capture()
    expect(await runServerCli(['--check'], { io: second.io, env: {}, cwd: dataDir })).toBe(0)
    const preflight = second.payloads().find((payload) => eventOf(payload) === 'server.preflight')
    expect(preflight?.['schemaVersion']).toBe(SERVER_SCHEMA_VERSION)
  })

  it('体检输出里不含任何秘密字段（只报路径与可用性）', async () => {
    const dataDir = makeTempDir('check-secrets')
    const harness = capture()
    expect(await runServerCli(['--check'], { io: harness.io, env: {}, cwd: dataDir })).toBe(0)
    const payload = harness.payloads().find((entry) => eventOf(entry) === 'server.preflight')
    expect(payload).toBeDefined()
    expect(payload?.['bootstrapSecret']).toBeUndefined()
    expect(payload?.['masterKey']).toBeUndefined()
    expect(Object.keys(payload ?? {})).not.toContain('secretRef')
  })

  it('🔴 库版本高于程序：体检必须失败（exit 1）并说明拒绝打开，而不是"尽力打开"', async () => {
    const dataDir = makeTempDir('check-too-new')
    const first = capture()
    expect(await runServerCli(['--check'], { io: first.io, env: {}, cwd: dataDir })).toBe(0)

    const dbPath = join(dataDir, 'data', 'db', 'yfe.db')
    const db = openServerDatabase(dbPath)
    try {
      // 只把最新一行改成 99：全表改 99 会撞 `uq_schema_migrations_applied`。
      db.prepare('UPDATE server_schema_migrations SET version = 99 WHERE version = ?').run(SERVER_SCHEMA_VERSION)
    } finally {
      closeServerDatabase(db)
    }

    const second = capture()
    const code = await runServerCli(['--check'], { io: second.io, env: {}, cwd: dataDir })
    expect(code).toBe(1)
    expect(second.err.join('\n')).toContain('高于本程序支持')
    expect(second.err.join('\n')).toContain('拒绝打开')
    expect(second.payloads()).toEqual([])
  })
})

describe('正常启动', () => {
  it('listen:false 时报 ready 而不是 listening（嵌入场景不误导运维）', async () => {
    const dataDir = makeTempDir('ready')
    const harness = capture()
    const code = await runServerCli([], {
      io: harness.io,
      env: {},
      cwd: dataDir,
      listen: false,
    })
    expect(code).toBe(0)
    const events = harness.payloads().map((payload) => eventOf(payload))
    expect(events).toContain('server.ready')
    expect(events).not.toContain('server.listening')
  })

  it('真实监听端口：报 listening 且优雅停止，退出码 0', async () => {
    const dataDir = makeTempDir('listen')
    const harness = capture()
    const port = 18000 + ((process.pid + 11) % 500)
    const code = await runServerCli([`--port=${port}`], {
      io: harness.io,
      env: {},
      cwd: dataDir,
      listen: true,
      waitForShutdown: null,
    })
    expect(code).toBe(0)
    const payloads = harness.payloads()
    const listening = payloads.find((payload) => eventOf(payload) === 'server.listening')
    expect(listening).toBeDefined()
    expect(listening?.['port']).toBe(port)
    expect(listening?.['host']).toBe('127.0.0.1')
    expect(payloads.map((payload) => eventOf(payload))).toContain('server.stopped')
  })
})
