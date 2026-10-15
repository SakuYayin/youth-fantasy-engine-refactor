/**
 * 存储路径派生与校验：**所有**落到文件系统的路径都必须经过这里。
 *
 * ## 为什么要有这一层
 *
 * 附件链路上有两条"外来字符串"最终会变成文件路径：
 *
 * 1. `upload_sessions.staging_dir`（服务端自己写的相对键，但仍要防库被改/回放）；
 * 2. `assets.storage_key`（内容寻址键，理论上由 sha256 派生，但下载时是**从库里读回来的**）。
 *
 * 只要有一条链路上出现了 `..`、绝对路径、盘符或 UNC，就会变成任意文件读写
 * （读：拿 `C:\Users\...\.ssh\id_rsa`；写：覆盖仓库里的源码）。所以这里做的是
 * "**白名单式**派生"：先按段校验，再用 `path.resolve` 求绝对路径，最后用
 * `path.relative` 复核结果仍在存储根之内——三道都要过。
 *
 * 反过来说：**没有任何地方**允许把外来路径直接 `join` 到存储根上。
 *
 * ## 平台约定
 *
 * 相对键**一律用 `/` 分隔**（跨平台稳定，写进 SQLite 也是这个形式）。
 * 段校验同时也拒绝 Windows 形态的绝对路径（`C:\`、`\\?\`、`\\server\share`）
 * 以及 Windows 保留设备名（`nul`、`con`、`com1`…），因为存储根在 Windows 上
 * 被 `resolve` 之后这些名字有特殊语义。即使当前跑在 Linux 上也照样拒绝——
 * 数据库是跟着仓库/备份走的，今天在 Linux 通过、明天在 Windows 上打开就是漏洞。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isWellFormedId } from '@yfe/contracts'

/** 内容寻址对象在存储根下的相对前缀。 */
export const OBJECTS_PREFIX = 'objects'
/** `storage_key` 的算法前缀：与 `assets.hash_algorithm` 的取值一致。 */
export const CONTENT_ADDRESS_ALGORITHM = 'sha256'
/** 上传暂存目录在存储根下的相对前缀。 */
export const STAGING_PREFIX = 'staging'
/** 单个相对键（含分隔符）的最大长度。 */
export const MAX_RELATIVE_KEY_LENGTH = 1024
/** 单个路径段的最大长度（Windows 单个文件名上限 255，留出余量）。 */
export const MAX_SEGMENT_LENGTH = 200
/** 分片编号上限：只为挡住"用巨大编号撑爆路径"的输入，不是业务上限。 */
export const MAX_PART_NUMBER = 1_000_000

/** 相对键被拒的原因。路由层据此决定回哪个错误码，不把原文回给客户端。 */
export type StoragePathViolation =
  | 'not_string'
  | 'empty'
  | 'null_byte'
  | 'control_char'
  | 'absolute'
  | 'drive_letter'
  | 'unc'
  | 'parent_segment'
  | 'invalid_segment'
  | 'too_long'
  | 'escape'

const VIOLATION_MESSAGES: Readonly<Record<StoragePathViolation, string>> = {
  not_string: '路径必须是字符串。',
  empty: '路径不能为空。',
  null_byte: '路径不能包含 NUL 字节。',
  control_char: '路径不能包含控制字符。',
  absolute: '路径必须是相对路径，不能以分隔符开头。',
  drive_letter: '路径不能包含盘符。',
  unc: '路径不能是 UNC 路径。',
  parent_segment: '路径不能包含 `..` 段。',
  invalid_segment: '路径包含非法段（`.`、保留设备名或尾随点/空格）。',
  too_long: '路径超出长度上限。',
  escape: '路径逃出了存储根目录。',
}

/**
 * 路径校验失败。
 *
 * 🔴 这个错误对象的 `message` **不含**任何绝对路径或原始输入，可以直接被
 * 路由层折叠成契约错误；原始键只出现在 `field` 的字段名里（如 `storage_key`）。
 */
export class StoragePathError extends Error {
  override readonly name = 'StoragePathError'

  constructor(
    readonly reason: StoragePathViolation,
    readonly field: string,
    message?: string,
  ) {
    super(`${field}: ${VIOLATION_MESSAGES[reason]}${message === undefined ? '' : `（${message}）`}`)
  }
}

/** Windows 保留设备名（含带扩展名的形式）。 */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** 控制字符：C0 范围 + DEL。 */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
/** 盘符前缀，如 `C:` / `c:`（含 `C:relative` 这种盘符相对形式）。 */
const DRIVE_LETTER = /^[A-Za-z]:/

/** 是否 64 位小写十六进制 sha256。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * 校验并规范化一个相对键。
 *
 * 返回值是**规范形式**（`/` 分隔、无空段），可直接存库或拼路径。
 * 校验通过不代表"在存储根之内"——那只由 {@link resolveUnderRoot} 保证。
 */
export function normalizeRelativeKey(raw: string, field = 'path'): string {
  if (typeof raw !== 'string') {
    throw new StoragePathError('not_string', field)
  }
  if (raw.length === 0) {
    throw new StoragePathError('empty', field)
  }
  if (raw.length > MAX_RELATIVE_KEY_LENGTH) {
    throw new StoragePathError('too_long', field, `上限 ${MAX_RELATIVE_KEY_LENGTH}`)
  }
  if (raw.includes('\u0000')) {
    throw new StoragePathError('null_byte', field)
  }
  if (CONTROL_CHAR.test(raw)) {
    throw new StoragePathError('control_char', field)
  }
  // UNC（`\\server\share`、`//server/share`）先于"绝对路径"判定，因为它的第一段是空的。
  if (raw.startsWith('\\') || raw.startsWith('/')) {
    if (raw.startsWith('\\\\') || raw.startsWith('//')) {
      throw new StoragePathError('unc', field)
    }
    throw new StoragePathError('absolute', field)
  }
  if (DRIVE_LETTER.test(raw)) {
    throw new StoragePathError('drive_letter', field)
  }

  const segments = raw.split(/[\\/]/)
  for (const segment of segments) {
    if (segment.length === 0) {
      // `a//b`、`a/`、`a\` 这类：不猜作者意图，直接拒绝（调用方本该用 joinKey）。
      throw new StoragePathError('invalid_segment', field, '存在空段')
    }
    if (segment === '..') {
      throw new StoragePathError('parent_segment', field)
    }
    if (segment === '.' || segment.endsWith('.') || segment.endsWith(' ')) {
      // Windows 会把尾随点/空格悄悄吃掉，导致"校验的文件"与"写入的文件"不是同一个。
      throw new StoragePathError('invalid_segment', field)
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new StoragePathError('too_long', field, `单段上限 ${MAX_SEGMENT_LENGTH}`)
    }
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) {
      throw new StoragePathError('invalid_segment', field, 'Windows 保留设备名')
    }
  }
  return segments.join('/')
}

/** 存储根本身必须是绝对路径、非空、无 NUL。 */
export function assertStorageRoot(root: string): string {
  if (typeof root !== 'string' || root.length === 0) {
    throw new StoragePathError('empty', 'storageRoot')
  }
  if (root.includes('\u0000')) {
    throw new StoragePathError('null_byte', 'storageRoot')
  }
  if (!isAbsolute(root)) {
    // 相对根会随 `process.cwd()` 漂移，"在根之内"的判断随之失效。
    throw new StoragePathError('absolute', 'storageRoot', '存储根必须是绝对路径')
  }
  return resolve(root)
}

/** 存储根 = `<dataDir>/assets`。路由装配时由配置注入。 */
export function storageRootFromDataDir(dataDir: string): string {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new StoragePathError('empty', 'dataDir')
  }
  return resolve(dataDir, 'assets')
}

/**
 * `candidate` 是否位于 `root` 之内（含等于 root）。
 *
 * 用 `path.relative` 而不是字符串前缀：前缀比较会把 `/data/assets-evil` 当成
 * `/data/assets` 的子路径。同时 `relative` 在跨盘符时返回绝对路径，也要挡掉。
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const absRoot = resolve(root)
  const absCandidate = resolve(candidate)
  if (absRoot === absCandidate) {
    return true
  }
  const rel = relative(absRoot, absCandidate)
  if (rel.length === 0) {
    return true
  }
  if (isAbsolute(rel)) {
    return false
  }
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * 把相对键解析成存储根内的绝对路径（**唯一**的"键 → 绝对路径"通道）。
 *
 * 同时拒绝"解析结果就是存储根本身"：这个函数用于**文件/目录**，不是根。
 */
export function resolveUnderRoot(root: string, rawKey: string, field = 'path'): string {
  const absRoot = assertStorageRoot(root)
  const key = normalizeRelativeKey(rawKey, field)
  const candidate = resolve(absRoot, key)
  if (candidate === absRoot) {
    throw new StoragePathError('escape', field, '解析结果就是存储根')
  }
  if (!isWithinRoot(absRoot, candidate)) {
    throw new StoragePathError('escape', field)
  }
  return candidate
}

/**
 * 生成侧：把若干**已可信**的片段拼成一个相对键。
 *
 * 和 {@link normalizeRelativeKey} 一样严格，所以"我拼出来的键"和
 * "我从库里读回来的键"走的是同一套校验。
 */
export function joinKey(...parts: readonly string[]): string {
  const keys: string[] = []
  for (const part of parts) {
    keys.push(normalizeRelativeKey(part, 'key'))
  }
  if (keys.length === 0) {
    throw new StoragePathError('empty', 'key')
  }
  return normalizeRelativeKey(keys.join('/'), 'key')
}

/**
 * 内容寻址键：`sha256/<hex[0:2]>/<hex[2:4]>/<hex>`。
 *
 * 十六进制**必须**是小写 64 位：否则大写/带前缀/带分隔符的输入会把
 * `..` 或 `/` 混进键里（这正是本函数不做字符串拼接信任的原因）。
 */
export function contentAddressedKey(sha256Hex: string): string {
  if (!isSha256Hex(sha256Hex)) {
    throw new StoragePathError('invalid_segment', 'sha256', '内容寻址键要求 64 位小写十六进制')
  }
  return `${CONTENT_ADDRESS_ALGORITHM}/${sha256Hex.slice(0, 2)}/${sha256Hex.slice(2, 4)}/${sha256Hex}`
}

/** 资产的物理相对键：`objects/<storage_key>`（storage_key 本身是内容寻址键）。 */
export function objectRelativeKey(storageKey: string): string {
  return joinKey(OBJECTS_PREFIX, storageKey)
}

/** 暂存目录的相对键：`staging/<workspaceId>/<uploadId>`。 */
export function stagingDirKey(workspaceId: string, uploadId: string): string {
  return joinKey(
    STAGING_PREFIX,
    requireIdSegment(workspaceId, 'workspaceId'),
    requireIdSegment(uploadId, 'uploadId'),
  )
}

/** 分片文件的相对键。 */
export function stagingPartKey(stagingDir: string, partNumber: number): string {
  return joinKey(stagingDir, partFileName(partNumber))
}

/** 分片落盘文件名：定宽十进制，保证目录内字典序 == 编号顺序。 */
export function partFileName(partNumber: number): string {
  if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber > MAX_PART_NUMBER) {
    throw new StoragePathError('invalid_segment', 'partNumber', `允许范围 0..${MAX_PART_NUMBER}`)
  }
  return `part-${String(partNumber).padStart(10, '0')}`
}

/** id 段：先按契约 id 形状判，再按路径段判（两道都过才返回）。 */
export function requireIdSegment(value: string, field: string): string {
  if (!isWellFormedId(value)) {
    throw new StoragePathError('invalid_segment', field, '不是合法 id')
  }
  return normalizeRelativeKey(value, field)
}

/**
 * 解析分片编号。
 *
 * 只接受十进制数字（不允许 `+`、`0x`、空格、小数），且必须是安全整数。
 * 越界/非法由调用方按契约回 `VALIDATION_OUT_OF_RANGE`，这里不做业务范围判断。
 */
export function parsePartNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[0-9]{1,10}$/.test(raw)) {
    return null
  }
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) ? value : null
}
