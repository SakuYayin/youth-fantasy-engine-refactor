/**
 * 文件系统错误 → 契约错误码。
 *
 * 🔴 与 `schema/open.ts` 的 `sqliteErrorPayload` 同一取向：**只做翻译，不新增错误码**，
 *    且 `detail` 里**绝不放路径**——路径会把用户名、NAS 地址、目录结构带进错误载荷，
 *    而错误载荷会被写进日志、上报、甚至展示给用户。
 *
 * 🔴 磁盘满与只读必须区分开：前者重试无意义（要用户清理磁盘），
 *    后者要用户改权限/换目录。都映射成"存储不可用"会让运维手册无法给出可执行指引。
 */

import { errOf, type ErrorCode, type RequestId, type Result } from '@yfe/contracts'

/** Node 的 `errno` 字符串 → 契约错误码。未知 errno 走 `fallback`。 */
const CODE_BY_ERRNO: Readonly<Record<string, ErrorCode>> = {
  ENOSPC: 'STORAGE_DISK_FULL',
  EROFS: 'STORAGE_READ_ONLY',
  EACCES: 'STORAGE_READ_ONLY',
  EPERM: 'STORAGE_READ_ONLY',
  EEXIST: 'ALREADY_EXISTS',
  EBUSY: 'RESOURCE_LOCKED',
  ENOTDIR: 'STORAGE_UNAVAILABLE',
  EISDIR: 'STORAGE_UNAVAILABLE',
  EMFILE: 'STORAGE_UNAVAILABLE',
  ENFILE: 'STORAGE_UNAVAILABLE',
  ENAMETOOLONG: 'STORAGE_UNAVAILABLE',
  EIO: 'STORAGE_CORRUPT',
}
// 🔴 刻意**不映射** `ENOENT`：同一个 errno 在"读快照"时是 NOT_FOUND_SNAPSHOT、
//    在"写清单时目录不存在"时是 STORAGE_UNAVAILABLE。映射表统一成一个码会让
//    "备份目标目录不存在"被报成"快照不存在"，把运维指引带偏。读取路径自己判存在性。

/** 取出 Node 错误的 `errno` 字符串（形如 `ENOSPC`），非 fs 错误返回 `null`。 */
export function errnoOf(thrown: unknown): string | null {
  if (typeof thrown !== 'object' || thrown === null) return null
  const code = (thrown as { code?: unknown }).code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : null
}

/** 映射错误码。 */
export function fsErrorCode(thrown: unknown, fallback: ErrorCode = 'STORAGE_UNAVAILABLE'): ErrorCode {
  const errno = errnoOf(thrown)
  if (errno === null) return fallback
  return CODE_BY_ERRNO[errno] ?? fallback
}

/**
 * 构造错误结果。
 *
 * `detail.errno` 只放错误码本身；`detail.reason` 只放**已剔除路径**的短描述。
 */
export function fsError<T = never>(
  thrown: unknown,
  requestId: RequestId,
  message: string,
  fallback: ErrorCode = 'STORAGE_UNAVAILABLE',
): Result<T> {
  const errno = errnoOf(thrown)
  return errOf(fsErrorCode(thrown, fallback), message, requestId, errno === null ? undefined : { errno })
}

/** 剔除路径后的可读原因（用于 `detail.reason`，不用于面向用户的 message）。 */
export function reasonOf(thrown: unknown): string {
  if (thrown instanceof Error) return stripPaths(thrown.message)
  return stripPaths(String(thrown))
}

/** 把绝对路径折成 `<path>`，避免路径进入错误载荷。 */
function stripPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')
    .replace(/(^|\s)\/(?:[^\s'"]+)/g, '$1<path>')
    .slice(0, 300)
}
