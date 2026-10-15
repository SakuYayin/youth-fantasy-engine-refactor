/**
 * 运维存储探针（task-16 / P3-C5）。
 *
 * ## 这个模块解决什么问题
 *
 * 管理页要让管理员看清"数据目录 / 备份目录 / 附件根"到底指向哪里、能不能读写。
 * 但**运维入口本身就是最危险的入口**：一个"帮我看看这个路径"的接口，如果实现成
 * "把管理员给的字符串丢给 fs 读一下"，就等于把整个文件系统变成可探测的 API，
 * 还能借符号链接把服务进程的权限边界接进攻击者选的目录（设计文档 04：
 * 路径规范化 + 符号链接边界）。
 *
 * ## 硬约束
 *
 * 1. **只做文件系统探测，绝不发起任何网络请求。** 不跟随重定向、不做 DNS 解析、
 *    不访问云元数据地址（`169.254.169.254` 这类地址连"探测"都不做，因为那本身
 *    就是 SSRF 的第一步）。本模块只 import `node:fs` / `node:path`，没有
 *    `http` / `net` / `dns`——这一条靠 import 面就能审出来。
 * 2. **规范化 + 符号链接解析之后仍必须在目标根之内。** `..` 与符号链接（Windows
 *    上还包括 NTFS junction）都不能把路径带出根。
 * 3. **越出 `dataDir` 是管理员的显式决定。** NAS / 私有网盘 / 外置盘是**正常**用途，
 *    不因为"在 dataDir 之外"就一律禁止；但必须带 `acknowledgeExternal: true`，
 *    没有批准就 fail closed 返回 `PERMISSION_DENIED`。
 * 4. **探测不产生副作用。** 除了"确认可写"那一次尝试创建的探测临时文件
 *    （随后立刻删除），不创建、不删除任何东西——尤其**不 `mkdir`**。
 *
 * 存储键 → 绝对路径的通道仍然只有 `./paths.ts`；本模块只接受**绝对路径**输入
 * （那正是这个界面存在的意义），因此不复用 `normalizeRelativeKey`（它按设计拒绝
 * 绝对路径），只用它导出的边界判定 `isWithinRoot` / `assertStorageRoot`。
 */

import { randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { ErrorCode, RequestId } from '@yfe/contracts'
import { errOf, unwrap } from '@yfe/contracts'

import { fsErrnoOf, pathExists, storageFailureKindOf } from './localFs.js'
import { assertStorageRoot, isWithinRoot, storageRootFromDataDir, StoragePathError } from './paths.js'

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 契约错误的 `detail` 只允许标量（数组/对象放不进去）。 */
export type StorageErrorDetail = Readonly<Record<string, string | number | boolean | null>>

/**
 * 抛一个契约错误。
 *
 * 用 `errOf` 而不是 `new ContractError(...)`：错误码 → 严重级 / 是否可重试
 * 的映射只写在契约里一份，这里不重复也不猜。HTTP 状态码由 `src/http/errors.ts`
 * 统一映射，本模块不知道 HTTP 的存在。
 */
export function fail(
  code: ErrorCode,
  message: string,
  requestId: RequestId,
  detail?: StorageErrorDetail,
): never {
  throw unwrap(errOf(code, message, requestId, detail))
}

/** errno → 契约错误码。磁盘满/只读要与"路径不存在"分开，否则排障时看不出根因。 */
export function errorCodeForFsFailure(thrown: unknown): ErrorCode {
  const kind = storageFailureKindOf(thrown)
  switch (kind) {
    case 'disk_full':
      return 'STORAGE_DISK_FULL'
    case 'read_only':
      return 'STORAGE_READ_ONLY'
    case 'not_found':
      return 'NOT_FOUND'
    default:
      return 'STORAGE_UNAVAILABLE'
  }
}

/** 把 `StoragePathError`（消息不含原文与绝对路径）折叠成契约错误。 */
export function pathViolationError(thrown: StoragePathError, requestId: RequestId, field: string): never {
  // 逃逸类原因属于"边界被拒"（403），其余属于入参不合法（400）。
  const escape = thrown.reason === 'escape'
  fail(
    escape ? 'PERMISSION_DENIED' : 'VALIDATION_FAILED',
    escape ? '路径逃出了允许的存储根。' : '路径不合法。',
    requestId,
    { field, reason: thrown.reason },
  )
}

// ---------------------------------------------------------------------------
// 根
// ---------------------------------------------------------------------------

export const BACKUP_DIR_NAME = 'backups'

/** 可探测的存储面。`data` 是数据目录本身，其余是两个受管子根。 */
export const STORAGE_PROBE_KINDS = ['data', 'backup', 'asset'] as const
export type StorageProbeKind = (typeof STORAGE_PROBE_KINDS)[number]

export interface StorageProbeRoots {
  /** `config.dataDir`：探测的"内部"边界。 */
  readonly dataDir: string
  /** 附件存储根（`<dataDir>/assets`）。 */
  readonly assetRoot: string
  /** 备份根（`<dataDir>/backups`）。 */
  readonly backupRoot: string
}

export function backupRootFromDataDir(dataDir: string): string {
  return resolve(assertStorageRoot(dataDir), BACKUP_DIR_NAME)
}

/** 构造探测根。入参来自配置，仍要过一遍唯一通道的校验（NUL / 相对路径）。 */
export function storageProbeRoots(
  dataDir: string,
  overrides: { readonly storageRoot?: string; readonly backupRoot?: string } = {},
): StorageProbeRoots {
  const absData = assertStorageRoot(dataDir)
  return {
    dataDir: absData,
    assetRoot:
      overrides.storageRoot === undefined
        ? storageRootFromDataDir(absData)
        : assertStorageRoot(overrides.storageRoot),
    backupRoot:
      overrides.backupRoot === undefined ? backupRootFromDataDir(absData) : assertStorageRoot(overrides.backupRoot),
  }
}

/** `storageProbeRoots` 的契约错误版本：配置不合法时给管理员一个可行动的 400。 */
export function probeRootsFromDataDir(
  dataDir: string,
  requestId: RequestId,
  overrides: { readonly storageRoot?: string; readonly backupRoot?: string } = {},
): StorageProbeRoots {
  try {
    return storageProbeRoots(dataDir, overrides)
  } catch (thrown) {
    if (thrown instanceof StoragePathError) pathViolationError(thrown, requestId, thrown.field)
    throw thrown
  }
}

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

/** 路径长度上限：只为挡住"用超长字符串撑爆日志/路径"的输入。 */
export const ADMIN_PATH_MAX_LENGTH = 4096

/** 与 `./paths.ts` 同源的 Windows 保留设备名判定（那边是模块私有，这里重写一份）。 */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
const DRIVE_PREFIX = /^[A-Za-z]:$/

/** 探测结果的告警词表（客户端按词表判断，不要按自然语言匹配）。 */
export const STORAGE_PROBE_WARNINGS = [
  'target_missing',
  'is_symlink',
  'symlink_outside_root',
  'unc_path',
  'external_target_acknowledged',
  'disk_full',
  'read_only',
  'write_probe_failed',
] as const
export type StorageProbeWarning = (typeof STORAGE_PROBE_WARNINGS)[number]

export interface ResolveAdminPathOptions {
  readonly targetPath: string
  readonly kind: StorageProbeKind
  /** NAS / 外置盘等 `dataDir` 之外的位置需要管理员显式批准。 */
  readonly acknowledgeExternal?: boolean
}

export interface ResolvedAdminPath {
  readonly targetPath: string
  readonly absolutePath: string
  /** 解析符号链接之后的真实路径；目标不存在时为 `null`。 */
  readonly realPath: string | null
  readonly kind: StorageProbeKind
  readonly kindRoot: string
  readonly insideKindRoot: boolean
  readonly insideDataDir: boolean
  readonly exists: boolean
  readonly isSymlink: boolean
  /** 解析后落在 `dataDir` 之外（必须是管理员批准过的）。 */
  readonly external: boolean
  readonly warnings: readonly string[]
}

function assertSafeSegments(absolutePath: string, requestId: RequestId, field: string): void {
  for (const segment of absolutePath.split(/[\\/]+/)) {
    if (segment.length === 0 || DRIVE_PREFIX.test(segment)) continue
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) {
      fail('VALIDATION_FAILED', `路径包含 Windows 保留设备名，不能作为存储位置：${segment}`, requestId, {
        field,
        reason: 'windows_reserved_name',
      })
    }
    // Windows 会把尾随点/空格悄悄吃掉，导致"校验的路径"与"实际用的路径"不是同一个。
    if (segment !== '.' && segment !== '..' && (segment.endsWith('.') || segment.endsWith(' '))) {
      fail('VALIDATION_FAILED', '路径段不能以点或空格结尾（Windows 会静默改写它）。', requestId, {
        field,
        reason: 'trailing_dot_or_space',
      })
    }
  }
}

function kindRootOf(
  roots: StorageProbeRoots,
  kind: StorageProbeKind,
  requestId: RequestId,
  field: string,
): string {
  switch (kind) {
    case 'data':
      return roots.dataDir
    case 'asset':
      return roots.assetRoot
    case 'backup':
      return roots.backupRoot
    default:
      // 传输层有 schema 挡着，但"未知 kind"不能只是"没匹配上"：那会得到
      // `undefined` 并让 `isWithinRoot` 抛一个内部 TypeError（= 500）。
      fail('VALIDATION_FAILED', 'kind 必须是 data / backup / asset 之一。', requestId, {
        field: 'kind',
        reason: 'unknown_kind',
      })
  }
}

/**
 * `lstat`，但把"这个路径不存在"和"这个路径的状态问不出来"分开。
 *
 * Windows 上失联的 UNC 主机 / 未挂载的卷会给 `UNKNOWN`；这种时候**存在性未知**，
 * 既不能当"不存在"（管理员会以为可以放心新建），也不能让内部异常冒成 500。
 * 统一转成 `STORAGE_UNAVAILABLE`（503）：服务端没坏，是那个位置现在问不出来。
 */
function lstatOrNull(target: string, requestId: RequestId, field: string): { isSymbolicLink(): boolean } | null {
  try {
    return lstatSync(target)
  } catch (thrown) {
    const errno = fsErrnoOf(thrown)
    if (errno === 'ENOENT' || errno === 'ENOTDIR' || errno === 'EINVAL') {
      return null
    }
    fail(errorCodeForFsFailure(thrown), '无法确定目标路径的状态（位置可能失联或不可访问）。', requestId, {
      field,
      reason: 'probe_unavailable',
      errno,
    })
  }
}

/**
 * 规范化并校验一个管理员给的绝对路径。
 *
 * 校验顺序（**先便宜后昂贵**，且全部失败都 fail closed）：
 * 非空 → 长度 → NUL/控制字符 → 必须绝对 → 保留设备名/尾随点 → 规范化 →
 * 目标根包含性 → 符号链接解析 → 解析后包含性 → 外部批准。
 */
export function resolveAdminStoragePath(
  roots: StorageProbeRoots,
  options: ResolveAdminPathOptions,
  requestId: RequestId,
  field = 'targetPath',
): ResolvedAdminPath {
  const raw = options.targetPath
  if (typeof raw !== 'string' || raw.length === 0) {
    fail('VALIDATION_MISSING_FIELD', '缺少必填字段：targetPath', requestId, { field })
  }
  if (raw.length > ADMIN_PATH_MAX_LENGTH) {
    fail('VALIDATION_OUT_OF_RANGE', `路径最长 ${ADMIN_PATH_MAX_LENGTH} 个字符。`, requestId, {
      field,
      maxLength: ADMIN_PATH_MAX_LENGTH,
    })
  }
  if (raw.includes('\u0000')) {
    fail('VALIDATION_FAILED', '路径不能包含 NUL 字节。', requestId, { field, reason: 'null_byte' })
  }
  if (CONTROL_CHAR.test(raw)) {
    fail('VALIDATION_FAILED', '路径不能包含控制字符。', requestId, { field, reason: 'control_char' })
  }
  if (!isAbsolute(raw)) {
    fail('VALIDATION_FAILED', 'targetPath 必须是绝对路径。', requestId, {
      field,
      reason: 'not_absolute',
    })
  }

  // UNC（`\\server\share`）在 Windows 上是绝对路径，作为备份目标是合法用途，
  // 但它一定是"外部"位置——批准逻辑照常生效（见下面的 external 分支）。
  const unc = raw.startsWith('\\\\')
  if (!unc) assertSafeSegments(raw, requestId, field)

  const absolutePath = resolve(raw)
  const kind = options.kind
  const kindRoot = kindRootOf(roots, kind, requestId, field)
  const insideKindRoot = isWithinRoot(kindRoot, absolutePath)
  const insideDataDir = isWithinRoot(roots.dataDir, absolutePath)
  const acknowledged = options.acknowledgeExternal === true
  const warnings: string[] = []
  if (unc) warnings.push('unc_path')

  if (!insideKindRoot) {
    if (insideDataDir) {
      // 在 dataDir 之内、却不在该 kind 的受管根之内：这是逃逸（例如把附件目标指到
      // 数据库目录）。批准与否都不放行——批准只对"整个 dataDir 之外"生效。
      fail('PERMISSION_DENIED', `目标路径不在 ${kind} 存储根之内，请改用该根下的位置。`, requestId, {
        field,
        kind,
        reason: 'path_escape',
      })
    }
    if (!acknowledged) {
      fail(
        'PERMISSION_DENIED',
        '目标路径在数据目录之外，确认它是 NAS / 外置盘等可信位置后再重试，并带 acknowledgeExternal: true。',
        requestId,
        { field, kind, reason: 'external_target_requires_acknowledge' },
      )
    }
    warnings.push('external_target_acknowledged')
  }

  const stats = lstatOrNull(absolutePath, requestId, field)
  const exists = stats !== null
  const isSymlink = stats !== null && stats.isSymbolicLink()

  let realPath: string | null = null
  if (exists) {
    try {
      realPath = realpathSync(absolutePath)
    } catch (thrown) {
      void thrown
      // 解析不出来（悬挂符号链接、权限不足）不当作"逃逸"，但也不能当作安全：
      // 返回 null，让调用方在 realPath === null 时自己决定（探测端点会如实上报）。
      realPath = null
    }
  }

  if (exists && realPath !== null) {
    const realInsideKindRoot = isWithinRoot(kindRoot, realPath)
    if (!realInsideKindRoot) {
      const realInsideDataDir = isWithinRoot(roots.dataDir, realPath)
      if (realInsideDataDir) {
        // 符号链接把路径带出了受管根（但在 dataDir 之内）：教科书式逃逸。
        fail('PERMISSION_DENIED', '目标路径解析符号链接后逃出了存储根。', requestId, {
          field,
          kind,
          reason: 'symlink_escape',
        })
      }
      if (!acknowledged) {
        fail(
          'PERMISSION_DENIED',
          '目标路径解析符号链接后落在数据目录之外，需要 acknowledgeExternal: true 才能继续。',
          requestId,
          { field, kind, reason: 'external_target_requires_acknowledge' },
        )
      }
      warnings.push('symlink_outside_root')
    }
    if (isSymlink) warnings.push('is_symlink')
  }

  if (!exists) warnings.push('target_missing')

  return {
    targetPath: raw,
    absolutePath,
    realPath,
    kind,
    kindRoot,
    insideKindRoot,
    insideDataDir,
    exists,
    isSymlink,
    external: !insideDataDir,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

export interface StorageProbeResult {
  readonly resolvedPath: string
  readonly exists: boolean
  readonly isDirectory: boolean
  readonly readable: boolean
  readonly writable: boolean
  readonly insideDataDir: boolean
  readonly isSymlink: boolean
  readonly realPath: string | null
  readonly warnings: readonly string[]
}

const PROBE_TEMP_PREFIX = '.yfe-storage-probe-'

function isDirectoryOf(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch (thrown) {
    if (fsErrnoOf(thrown) === 'ENOENT' || fsErrnoOf(thrown) === 'ENOTDIR') return false
    throw thrown
  }
}

function isReadableOf(target: string): boolean {
  try {
    accessSync(target, constants.R_OK)
    return true
  } catch {
    return false
  }
}

interface WriteProbeOutcome {
  readonly writable: boolean
  readonly warnings: readonly string[]
}

/**
 * 可写性探测。
 *
 * 目录：写一个**空**探测文件再删掉（这是唯一被允许的副作用）。
 * 文件：`r+` 打开再关掉（不写一个字节）。
 * 两种失败都按 errno 给出告警词，而不是把 errno 原文抛给客户端。
 */
function probeWritable(absolutePath: string, exists: boolean, isDirectory: boolean): WriteProbeOutcome {
  if (!exists) return { writable: false, warnings: [] }
  const warnFor = (thrown: unknown): string => {
    const errno = fsErrnoOf(thrown)
    if (errno === 'ENOSPC') return 'disk_full'
    if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') return 'read_only'
    return 'write_probe_failed'
  }

  if (isDirectory) {
    const probeFile = join(absolutePath, `${PROBE_TEMP_PREFIX}${randomBytes(8).toString('hex')}.tmp`)
    try {
      writeFileSync(probeFile, Buffer.alloc(0), { flag: 'wx' })
    } catch (thrown) {
      return { writable: false, warnings: [warnFor(thrown)] }
    }
    try {
      unlinkSync(probeFile)
    } catch {
      // 删不掉只会留下一个 0 字节文件；不因此判定"不可写"，也不把探测失败抛出去。
    }
    return { writable: true, warnings: [] }
  }

  try {
    closeSync(openSync(absolutePath, 'r+'))
    return { writable: true, warnings: [] }
  } catch (thrown) {
    return { writable: false, warnings: [warnFor(thrown)] }
  }
}

/**
 * 探测一个目标路径。**只读 + 一次性探测临时文件**，不发起任何网络请求。
 */
export function probeStorageTarget(
  roots: StorageProbeRoots,
  options: ResolveAdminPathOptions,
  requestId: RequestId,
  field = 'targetPath',
): StorageProbeResult {
  const resolved = resolveAdminStoragePath(roots, options, requestId, field)
  const directory = isDirectoryOf(resolved.absolutePath)
  const write = probeWritable(resolved.absolutePath, resolved.exists, directory)

  return {
    resolvedPath: resolved.absolutePath,
    exists: resolved.exists,
    isDirectory: directory,
    readable: isReadableOf(resolved.absolutePath),
    writable: write.writable,
    insideDataDir: resolved.insideDataDir,
    isSymlink: resolved.isSymlink,
    realPath: resolved.realPath,
    warnings: [...resolved.warnings, ...write.warnings],
  }
}

// ---------------------------------------------------------------------------
// 磁盘空间
// ---------------------------------------------------------------------------

export interface DiskSpace {
  readonly freeBytes: number | null
  readonly totalBytes: number | null
}

/**
 * 可用磁盘空间（**尽力而为**）。
 *
 * 取不到就返回 `null`——绝不编 0：0 会被读成"磁盘满了"，从而触发一次假的运维事故；
 * 而"未知"至少是诚实的。
 */
export function diskSpaceOf(target: string): DiskSpace {
  try {
    const stats = statfsSync(target)
    const blockSize = Number(stats.bsize)
    return {
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    }
  } catch {
    return { freeBytes: null, totalBytes: null }
  }
}

/** 探测用不到的导出：给"路径存在但不可访问"的场景一个稳定判定。 */
export function storagePathExists(target: string): boolean {
  return pathExists(target)
}
