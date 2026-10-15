/**
 * 存储探针（`src/storage/probe.ts`）—— 路径规则与探测行为。
 *
 * ## 为什么这个文件存在
 *
 * 管理面允许**管理员指定任意绝对路径**（NAS、外置盘、导入目录）。这是一条比其他
 * 端点危险得多的输入通道：一个"看起来能跑"的实现会把整台机器变成"读任意文件 + 写
 * 任意文件"的代理。所以这里的用例几乎都在验证**拒绝**：非绝对路径、NUL/控制字符、
 * Windows 保留名、越出受管根、符号链接逃逸、未批准的外部目标。
 *
 * ## 两件必须被测试盯住的不变量
 *
 * 1. **探测不产生副作用**：目录可写性探测允许写一个空临时文件，但必须自己删掉。
 *    用例在探测前后比较目录内容，确保不留垃圾、也不碰已存在文件的一个字节。
 * 2. **探测不发起任何网络请求**：`probe.ts` 是纯文件系统模块，import 里不允许
 *    出现 `node:net` / `node:http` / `node:dns` 之类的网络能力（最后一条用例直接
 *    检查源码的 import 列表，因为"SSRF 是靠引入一个网络客户端才发生的"）。
 *
 * 探针本身不知道 HTTP：它抛的是契约错误（`ContractError`），状态码由
 * `src/http/errors.ts` 统一映射。所以这里断言的是**错误码 + detail.reason**。
 */

import { readdirSync, readFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { RequestId } from '@yfe/contracts'
import { ContractError } from '@yfe/contracts'

import {
  ADMIN_PATH_MAX_LENGTH,
  STORAGE_PROBE_KINDS,
  backupRootFromDataDir,
  diskSpaceOf,
  probeStorageTarget,
  resolveAdminStoragePath,
  storageProbeRoots,
} from '../src/storage/probe.js'
import { CONTENT_ADDRESS_ALGORITHM, storageRootFromDataDir } from '../src/storage/paths.js'
import { cleanupTempDirs, makeTempDir } from './helpers.js'

const REQUEST_ID = 'req_probe_test' as RequestId

interface ProbeFixture {
  readonly base: string
  readonly dataDir: string
  readonly externalDir: string
  readonly assetRoot: string
  readonly backupRoot: string
  readonly roots: ReturnType<typeof storageProbeRoots>
}

/** 一个真实的目录树：`<base>/data/{assets,db,backups}` 加一个"外部"目录。 */
function makeFixture(): ProbeFixture {
  const base = makeTempDir()
  const dataDir = join(base, 'data')
  const externalDir = join(base, 'external')
  const assetRoot = storageRootFromDataDir(dataDir)
  const backupRoot = backupRootFromDataDir(dataDir)
  for (const dir of [dataDir, externalDir, assetRoot, backupRoot, join(dataDir, 'db')]) {
    mkdirSync(dir, { recursive: true })
  }
  return { base, dataDir, externalDir, assetRoot, backupRoot, roots: storageProbeRoots(dataDir) }
}

/** 捕获契约错误；没抛错本身就是失败。 */
function errorOf(run: () => unknown): ContractError {
  try {
    run()
  } catch (thrown) {
    if (thrown instanceof ContractError) return thrown
    throw thrown
  }
  throw new Error('预期抛契约错误，但调用成功返回了')
}

function reasonOf(error: ContractError): unknown {
  return error.detail?.['reason']
}

describe('存储探针：输入校验', () => {
  it('拒绝非绝对路径（相对路径的"根"取决于工作目录，不能作为存储位置）', () => {
    const { roots } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: 'assets/objects', kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(reasonOf(error)).toBe('not_absolute')
  })

  it('拒绝 NUL 字节（截断路径会让"校验的"与"打开的"不是同一个字符串）', () => {
    const { roots, assetRoot } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: `${assetRoot}\u0000/../etc`, kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(reasonOf(error)).toBe('null_byte')
  })

  it('拒绝控制字符', () => {
    const { roots, assetRoot } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: `${assetRoot}\u0007x`, kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(reasonOf(error)).toBe('control_char')
  })

  it('拒绝 Windows 保留设备名（CON/NUL/COM1 指向的不是文件）', () => {
    const { roots, assetRoot } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: join(assetRoot, 'CON', 'dump.db'), kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(reasonOf(error)).toBe('windows_reserved_name')
  })

  it('拒绝超长路径（挡住"用超长字符串撑爆日志"的输入）', () => {
    const { roots } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: `C:\\${'x'.repeat(ADMIN_PATH_MAX_LENGTH)}`, kind: 'data' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(error.detail?.['maxLength']).toBe(ADMIN_PATH_MAX_LENGTH)
  })

  it('拒绝未知的 kind（不能"没匹配上"就得到 undefined 根）', () => {
    const { roots } = makeFixture()
    // 绕过 TS 的字面量类型：模拟"客户端传了别的东西"。
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: roots.dataDir, kind: 'wherever' as 'data' }, REQUEST_ID),
    )
    expect(error.code).toBe('VALIDATION_FAILED')
    expect(reasonOf(error)).toBe('unknown_kind')
  })

  it('三种 kind 都存在，且各自的受管根是 dataDir/assets、dataDir/backups', () => {
    const { roots, dataDir, assetRoot, backupRoot } = makeFixture()
    expect([...STORAGE_PROBE_KINDS]).toEqual(['data', 'backup', 'asset'])
    expect(roots.dataDir).toBe(dataDir)
    expect(roots.assetRoot).toBe(assetRoot)
    expect(roots.backupRoot).toBe(backupRoot)
    expect(assetRoot).toBe(join(dataDir, 'assets'))
    expect(backupRoot).toBe(join(dataDir, 'backups'))
  })
})

describe('存储探针：边界与逃逸', () => {
  it('dataDir 之内、但不在该 kind 的受管根之内 → 拒绝（批准也不放行）', () => {
    const { roots, dataDir } = makeFixture()
    const databaseDir = join(dataDir, 'db')
    const error = errorOf(() =>
      resolveAdminStoragePath(
        roots,
        { targetPath: databaseDir, kind: 'asset', acknowledgeExternal: true },
        REQUEST_ID,
      ),
    )
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(reasonOf(error)).toBe('path_escape')
  })

  it('dataDir 之外未批准 → 拒绝，并告诉管理员需要 acknowledgeExternal', () => {
    const { roots, externalDir } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: externalDir, kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(reasonOf(error)).toBe('external_target_requires_acknowledge')
  })

  it('dataDir 之外 + 显式批准 → 放行（NAS/外置盘是正常用途，但必须是管理员的决定）', () => {
    const { roots, externalDir } = makeFixture()
    const resolved = resolveAdminStoragePath(
      roots,
      { targetPath: externalDir, kind: 'asset', acknowledgeExternal: true },
      REQUEST_ID,
    )
    expect(resolved.external).toBe(true)
    expect(resolved.insideDataDir).toBe(false)
    expect(resolved.warnings).toContain('external_target_acknowledged')
  })

  it('符号链接把路径带出受管根但在 dataDir 之内 → symlink_escape', () => {
    const { roots, assetRoot, dataDir } = makeFixture()
    const link = join(assetRoot, 'escape-link')
    symlinkSync(join(dataDir, 'db'), link, 'junction')
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: link, kind: 'asset' }, REQUEST_ID),
    )
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(reasonOf(error)).toBe('symlink_escape')
  })

  it('符号链接指向 dataDir 之外：未批准拒绝，批准后放行且如实上报 isSymlink/realPath', () => {
    const { roots, assetRoot, externalDir } = makeFixture()
    const link = join(assetRoot, 'outside-link')
    symlinkSync(externalDir, link, 'junction')

    const rejected = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: link, kind: 'asset' }, REQUEST_ID),
    )
    expect(rejected.code).toBe('PERMISSION_DENIED')
    expect(reasonOf(rejected)).toBe('external_target_requires_acknowledge')

    const allowed = resolveAdminStoragePath(
      roots,
      { targetPath: link, kind: 'asset', acknowledgeExternal: true },
      REQUEST_ID,
    )
    expect(allowed.warnings).toContain('symlink_outside_root')
    expect(allowed.warnings).toContain('is_symlink')
  })

  it('符号链接仍在受管根之内 → 允许，realPath 指向真实目录', () => {
    const { roots, assetRoot } = makeFixture()
    const inner = join(assetRoot, 'inner-dir')
    mkdirSync(inner, { recursive: true })
    const link = join(assetRoot, 'inner-link')
    symlinkSync(inner, link, 'junction')

    const result = probeStorageTarget(roots, { targetPath: link, kind: 'asset' }, REQUEST_ID)
    expect(result.isSymlink).toBe(true)
    expect(result.realPath).toBe(inner)
    expect(result.insideDataDir).toBe(true)
    expect(result.warnings).toContain('is_symlink')
  })
})

describe('存储探针：探测行为', () => {
  it('存在的目录：exists/isDirectory/readable/writable 全真，且不留探测垃圾', () => {
    const { roots, assetRoot } = makeFixture()
    const target = join(assetRoot, 'objects')
    mkdirSync(target, { recursive: true })
    const before = readdirSync(target).sort()

    const result = probeStorageTarget(roots, { targetPath: target, kind: 'asset' }, REQUEST_ID)

    expect(result).toMatchObject({
      resolvedPath: target,
      exists: true,
      isDirectory: true,
      readable: true,
      writable: true,
      insideDataDir: true,
      isSymlink: false,
      realPath: target,
    })
    expect(readdirSync(target).sort()).toEqual(before)
    expect(readdirSync(assetRoot)).toEqual(['objects'])
  })

  it('存在的文件：可写性探测不写入任何字节（内容与大小保持不变）', () => {
    const { roots, backupRoot } = makeFixture()
    const target = join(backupRoot, 'sample.db')
    const content = Buffer.from('not-a-real-database-but-that-does-not-matter')
    writeFileSync(target, content)

    const result = probeStorageTarget(roots, { targetPath: target, kind: 'backup' }, REQUEST_ID)

    expect(result.exists).toBe(true)
    expect(result.isDirectory).toBe(false)
    expect(result.writable).toBe(true)
    expect(readFileSync(target)).toEqual(content)
    expect(readdirSync(backupRoot)).toEqual(['sample.db'])
  })

  it('不存在的目标：exists=false、writable=false（不编造可写），warnings 说明目标缺失', () => {
    const { roots, backupRoot } = makeFixture()
    const target = join(backupRoot, 'nope.db')
    const result = probeStorageTarget(roots, { targetPath: target, kind: 'backup' }, REQUEST_ID)
    expect(result.exists).toBe(false)
    expect(result.isDirectory).toBe(false)
    expect(result.writable).toBe(false)
    expect(result.warnings).toContain('target_missing')
  })

  it('UNC 路径按"外部位置"处理：未批准先拒（不碰文件系统）', () => {
    const { roots } = makeFixture()
    const error = errorOf(() =>
      resolveAdminStoragePath(roots, { targetPath: '\\\\nas\\share\\backups', kind: 'backup' }, REQUEST_ID),
    )
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(reasonOf(error)).toBe('external_target_requires_acknowledge')
  })

  it('UNC 路径批准后：位置可达就给出 unc_path 告警，不可达就如实说"问不出来"（绝不冒成 500）', () => {
    const { roots } = makeFixture()
    let resolved: ReturnType<typeof resolveAdminStoragePath> | null = null
    let failure: ContractError | null = null
    try {
      resolved = resolveAdminStoragePath(
        roots,
        { targetPath: '\\\\nas\\share\\backups', kind: 'backup', acknowledgeExternal: true },
        REQUEST_ID,
      )
    } catch (thrown) {
      if (!(thrown instanceof ContractError)) throw thrown
      failure = thrown
    }

    if (resolved !== null) {
      // 这台机器上真能问到：必须带 unc_path 告警。
      expect(resolved.warnings).toContain('unc_path')
      expect(resolved.insideDataDir).toBe(false)
    } else {
      // 问不出来不是"参数错"，也不是 500：503 + STORAGE_UNAVAILABLE。
      expect(failure?.code).toBe('STORAGE_UNAVAILABLE')
      expect(failure?.detail?.['reason']).toBe('probe_unavailable')
    }
  })

  it('可写性探测的临时文件名不会被当成对象文件（`objects` 下不留 .tmp）', () => {
    const { roots, assetRoot } = makeFixture()
    const target = join(assetRoot, 'objects')
    mkdirSync(target, { recursive: true })
    probeStorageTarget(roots, { targetPath: target, kind: 'asset' }, REQUEST_ID)
    expect(readdirSync(target).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('磁盘空间：取不到必须是 null，而不是 0', () => {
  it('真实目录给出数值，且 freeBytes <= totalBytes', () => {
    const { dataDir } = makeFixture()
    const disk = diskSpaceOf(dataDir)
    if (disk.freeBytes !== null && disk.totalBytes !== null) {
      expect(disk.freeBytes).toBeGreaterThan(0)
      expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes)
    } else {
      // 容器/受限环境下 statfs 不可用：这时两个字段都必须是 null（"未知"）。
      expect(disk).toEqual({ freeBytes: null, totalBytes: null })
    }
  })

  it('不存在的路径 → null（编 0 会被读成"磁盘满了"）', () => {
    const { base } = makeFixture()
    expect(diskSpaceOf(join(base, 'no-such-dir'))).toEqual({ freeBytes: null, totalBytes: null })
  })
})

describe('探针不发起网络请求（源码级不变量）', () => {
  it('probe.ts 只引入文件系统/路径/契约模块，没有任何网络客户端', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/storage/probe.ts', import.meta.url)), 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
    expect(specifiers.length).toBeGreaterThan(0)
    const forbidden = specifiers.filter((specifier) =>
      /^(node:)?(net|http|https|dns|tls|dgram)$/.test(specifier) || /(axios|undici|got|node-fetch|request)/.test(specifier),
    )
    expect(forbidden).toEqual([])
    // 也不允许出现 fetch / 重定向跟随。
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\bredirect\b/i)
  })

  it('CONTENT_ADDRESS_ALGORITHM 是 sha256（探针上报的内容寻址算法与路径层一致）', () => {
    expect(CONTENT_ADDRESS_ALGORITHM).toBe('sha256')
  })
})

// 每个用例自己 makeTempDir；这里只保证失败路径也不会留下临时目录。
process.on('exit', () => cleanupTempDirs())
