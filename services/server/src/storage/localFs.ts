/**
 * 文件系统原语：本模块是附件链路里**唯一**直接调用 `node:fs` 的地方。
 *
 * ## 为什么要包一层
 *
 * 1. **错误分类**。`ENOSPC` / `EROFS` / `EACCES` 这些 errno 必须翻译成契约里的
 *    `STORAGE_DISK_FULL` / `STORAGE_READ_ONLY` / `STORAGE_UNAVAILABLE`，而不是
 *    冒泡成 500 `INTERNAL_ERROR`——磁盘满和"服务出 bug"对客户端的处置完全不同
 *    （前者要等/清理，后者要重试或报障）。errno 原文只留在服务端日志里，
 *    绝不回给客户端。
 * 2. **可测**。路由层注入的是拼接好的绝对路径，路径合法性在
 *    `src/storage/paths.ts` 已经判定；这一层只管 I/O。
 *
 * 所有同步 I/O 是有意的：写入的是分片级的块（`partSizeBytes` 量级），
 * 而 better-sqlite3 本身就是同步驱动，混用异步只会把事务边界搞乱。
 * 只有"读整个对象算 sha256"和"拼接对象"这两件天然流式的事用异步流。
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent, ReadStream } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Writable } from 'node:stream'

/** 存储失败的粗分类，路由层据此选错误码。 */
export type StorageFailureKind = 'not_found' | 'disk_full' | 'read_only' | 'unavailable'

/** 落盘失败。`errno` 只用于服务端日志与测试断言，不进入响应体。 */
export class StorageFsError extends Error {
  override readonly name = 'StorageFsError'

  constructor(
    readonly kind: StorageFailureKind,
    readonly errno: string | null,
    message: string,
  ) {
    super(message)
  }
}

/** 从异常里取 errno 字符串（`error.code`）。 */
export function fsErrnoOf(thrown: unknown): string | null {
  if (typeof thrown !== 'object' || thrown === null) {
    return null
  }
  const code = (thrown as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** errno → 粗分类。未识别的 errno 归为 `unavailable`（503，可重试）。 */
export function storageFailureKindOf(thrown: unknown): StorageFailureKind {
  const errno = fsErrnoOf(thrown)
  switch (errno) {
    case 'ENOENT':
      return 'not_found'
    case 'ENOSPC':
    case 'EDQUOT':
    case 'EFBIG':
      return 'disk_full'
    case 'EROFS':
    case 'EACCES':
    case 'EPERM':
      return 'read_only'
    default:
      return 'unavailable'
  }
}

function wrap(thrown: unknown, message: string): StorageFsError {
  if (thrown instanceof StorageFsError) {
    return thrown
  }
  return new StorageFsError(storageFailureKindOf(thrown), fsErrnoOf(thrown), message)
}

/** 递归建目录（幂等）。 */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw wrap(error, '无法创建存储目录。')
  }
}

/** 路径是否存在（任何类型）。 */
export function pathExists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch (error) {
    if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
      return false
    }
    throw wrap(error, '无法访问存储路径。')
  }
}

/** 是否为普通文件；目录/不存在/符号链接都返回 `false`。 */
export function isRegularFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch (error) {
    if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
      return false
    }
    throw wrap(error, '无法访问存储文件。')
  }
}

/** 文件字节数；不存在返回 `null`。 */
export function fileSizeOrNull(target: string): number | null {
  try {
    const info = statSync(target)
    return info.isFile() ? info.size : null
  } catch (error) {
    if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
      return null
    }
    throw wrap(error, '无法读取存储文件长度。')
  }
}

/** 删除文件；不存在是成功（幂等）。 */
export function removeFileIfExists(target: string): boolean {
  try {
    unlinkSync(target)
    return true
  } catch (error) {
    if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
      return false
    }
    throw wrap(error, '无法删除存储文件。')
  }
}

/** 递归删除目录；不存在是成功。用于清理 staging 残留。 */
export function removeTreeIfExists(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    throw wrap(error, '无法清理暂存目录。')
  }
}

/** 目录下的条目名（不递归）；目录不存在返回 `[]`。 */
export function listDirectoryNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch (error) {
    if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
      return []
    }
    throw wrap(error, '无法列出存储目录。')
  }
}

/**
 * 递归列出普通文件，返回**相对 `dir` 的 `/` 分隔**路径。
 *
 * 符号链接一律跳过：staging 目录只由本服务写入，出现符号链接只可能是篡改，
 * 顺着它读/写等于把根目录之外的路径接进链路（宁可报"分片缺失"）。
 */
export function listFilesRecursive(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (error) {
      if (fsErrnoOf(error) === 'ENOENT' || fsErrnoOf(error) === 'ENOTDIR') {
        return
      }
      throw wrap(error, '无法列出存储目录。')
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.isFile()) {
        found.push(relative(dir, full).split(sep).join('/'))
      }
    }
  }
  walk(dir)
  return found.sort()
}

/** 覆盖写入字节（父目录必须已存在或有 `ensureDir`）。 */
export function writeFileBytes(target: string, bytes: Buffer): void {
  try {
    writeFileSync(target, bytes)
  } catch (error) {
    throw wrap(error, '无法写入存储文件。')
  }
}

/** 字节的 sha256（小写 64 位十六进制）。 */
export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 文件的 sha256（流式，不整份读进内存）。 */
export async function sha256OfFile(target: string): Promise<string> {
  const hash = createHash('sha256')
  try {
    const stream = createReadStream(target)
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
    }
  } catch (error) {
    throw wrap(error, '无法读取存储文件用于校验。')
  }
  return hash.digest('hex')
}

/**
 * 原子搬运文件。
 *
 * - 目标不存在：`rename`；
 * - 目标已存在且大小相同：**丢弃源文件**（内容寻址下同名同长即同内容），返回 `false`；
 * - 目标已存在但大小不同：以源文件为准（覆盖）；
 * - `rename` 跨卷失败（`EXDEV` 等）：退化为复制 + 删除。
 *
 * @returns 目标路径是否是新搬来的（`false` = 命中了已有对象）。
 */
export function moveFile(from: string, to: string): boolean {
  const size = fileSizeOrNull(from)
  if (size === null) {
    throw new StorageFsError('not_found', null, '待搬运的暂存文件不存在。')
  }
  ensureDir(dirname(to))
  const existing = fileSizeOrNull(to)
  if (existing !== null) {
    if (existing === size) {
      removeFileIfExists(from)
      return false
    }
    removeFileIfExists(to)
  }
  try {
    renameSync(from, to)
    return true
  } catch (error) {
    const errno = fsErrnoOf(error)
    if (errno !== 'EXDEV' && errno !== 'EPERM' && errno !== 'ENOTSUP') {
      throw wrap(error, '无法搬运存储文件。')
    }
    try {
      copyFileSync(from, to)
    } catch (copyError) {
      throw wrap(copyError, '无法搬运存储文件。')
    }
    removeFileIfExists(from)
    return true
  }
}

/** 只读流（下载用）。调用方负责错误处理。 */
export function createFileReadStream(target: string): ReadStream {
  return createReadStream(target)
}

/** 把若干文件按给定顺序拼接到 `target`，返回总字节数。 */
export async function concatFilesToFile(
  sources: readonly string[],
  target: string,
): Promise<number> {
  ensureDir(dirname(target))
  const out = createWriteStream(target, { flags: 'w' })
  let total = 0
  try {
    for (const source of sources) {
      const input = createReadStream(source)
      for await (const chunk of input) {
        const buffer = chunk as Buffer
        total += buffer.byteLength
        await writeChunk(out, buffer)
      }
    }
    await finishStream(out)
  } catch (error) {
    out.destroy()
    throw wrap(error, '无法拼接暂存分片。')
  }
  return total
}

function writeChunk(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.write(chunk, (error) => {
      if (error === null || error === undefined) {
        resolve()
        return
      }
      reject(error)
    })
  })
}

function finishStream(out: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.once('finish', () => resolve())
    out.once('error', (error) => reject(error))
    out.end()
  })
}
