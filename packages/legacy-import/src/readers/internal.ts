/**
 * 真实读取器的公共底座（**Node 专用**，本包唯一碰 `node:fs` 的地方）。
 *
 * 三条纪律，与 `errors.ts` 的地基一脉相承：
 *
 * 1. **失败必抛**：文件不存在 / 权限不足 / 目录读不了 / JSON 非法，一律抛
 *    {@link LegacyReadError}（`R-01` / `R-11`：读不出来**绝不允许**折算成「0 条记录」）。
 * 2. **只读**：这里只 import `readFileSync` / `readdirSync` / `statSync`——整个 `readers/**`
 *    没有任何写通道（不建临时文件、不改 mtime）。
 * 3. **位置不放绝对路径**（`R-03`）：`location` 缺省只取 basename，调用方可传一个
 *    相对位置前缀（如 `legacy-main`）覆盖。
 *
 * 「文件存在但为空」与「文件不存在」**必须分开**：
 * · 不存在 → `not-found`（refused）；
 * · 存在且是**合法空容器**（`{}` / `{"projects":[]}` / `null` 占位）→ `ok` + 0 条；
 * · 存在但**0 字节或纯空白** → `decode-failed`（refused）。依据 `errors.ts:243-250`
 *   （`parseJsonStrict` 的既有语义）与 `upstream/src/lib/app/desktop.ts:459-462`
 *   （数据文件为空 ⇒ 锁写盘，绝不当作「首次使用的空库」）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { LegacyReadError, parseJsonStrict } from '../errors.js'
import type { LegacyReadFailureKind } from '../errors.js'

/** 记录容器的最外层形状判定：普通对象（不是数组、不是 null）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `location` 缺省值：只取 basename（`R-03`：绝不把绝对路径写进报告）。 */
export function defaultLocation(pathOrDir: string): string {
  const base = basename(pathOrDir)
  if (base !== '') return base
  const parts = pathOrDir.split(/[\\/]/u).filter((part) => part !== '')
  return parts[parts.length - 1] ?? pathOrDir
}

/**
 * store 名 / 记录键的确定性排序。
 *
 * `localeCompare` 而不是 `<`：同一份输入在任何机器上都要得到同一个顺序，
 * 且中文 store 名不会落进「按 UTF-16 码元」的意外次序。
 */
export function sortNames(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * 「主键 → 记录」对象容器 → 记录数组。
 *
 * 🔴 为什么要排序而不是直接用 `Object.keys` 的插入序：JS 对象的**整数型键**会被引擎
 *    重排（`{"10":…,"2":…}` 永远是先 2 后 10），插入序根本不可保；而旧库的主键是 uid
 *    或 `"<pid>::<key>"`，其中就可能出现纯数字键。⇒ 统一按主键 `localeCompare` 稳定排序，
 *    同一份文件读两次逐条相同（确定性优先于「恰好等于磁盘上的行序」）。
 */
export function rowsOfRecordMap(map: Record<string, unknown>): unknown[] {
  return sortNames(Object.keys(map)).map((key) => map[key])
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Node 的 `errno` → 本包的失败形态（`errors.ts` 的闭集，不自造码）。 */
export function kindOfFsError(error: unknown): LegacyReadFailureKind {
  switch (errorCodeOf(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'not-found'
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied'
    case 'EISDIR':
      return 'decode-failed'
    default:
      return 'unknown'
  }
}

/** 抛一个带契约错误码的读取失败（`never` 让调用点能被 TS 收窄）。 */
export function failRead(
  kind: LegacyReadFailureKind,
  message: string,
  location: string,
  cause?: unknown,
): never {
  throw new LegacyReadError({
    kind,
    message,
    location,
    ...(cause === undefined ? {} : { cause: errorTextOf(cause) }),
  })
}

/** 读取文件文本。失败 → 抛（`location` 由调用方给，缺省见 {@link defaultLocation}）。 */
export function readTextFileStrict(path: string, location: string): string {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    failRead(
      kindOfFsError(error),
      `旧数据文件读取失败（位置：${location}）。读不出来不等于「里面没有数据」。`,
      location,
      error,
    )
  }
  // UTF-8 BOM：Windows 记事本另存会加上，`JSON.parse` 见到它会整份失败。
  return text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text
}

/** 读 + 严格解析 JSON。空内容 / 非法 JSON 都会抛 `decode-failed`。 */
export function readJsonFileStrict(path: string, location: string): unknown {
  return parseJsonStrict(readTextFileStrict(path, location), location)
}

/** 文件大小与 mtime（给来源声明用）。读不到 → 抛。 */
export function fileStamp(path: string, location: string): { readonly bytes: number; readonly modifiedAt: string } {
  try {
    const stat = statSync(path)
    return { bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
  } catch (error) {
    failRead(
      kindOfFsError(error),
      `旧数据文件状态读取失败（位置：${location}）。读不出来不等于「里面没有数据」。`,
      location,
      error,
    )
  }
}

/** 该路径是否是**已存在的文件**（不存在 / 目录 / 读不到都返回 false——存在性是证据，不是失败）。 */
export function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 该路径是否是**已存在的目录**。 */
export function existsAsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 列目录。目录不存在 / 读不了 → 抛（来源级 refused，绝不能当成「没有 store」）。 */
export function listDirectoryStrict(dir: string, location: string): string[] {
  try {
    return readdirSync(dir)
  } catch (error) {
    failRead(
      kindOfFsError(error),
      `旧数据目录读取失败（位置：${location}）。读不出来不等于「里面没有数据」。`,
      location,
      error,
    )
  }
}

/** 该 store 在源里不存在（`store-missing`，refused；只有声明 `created:false` 才可折算 0 条）。 */
export function failMissingStore(store: string, location: string): never {
  failRead(
    'store-missing',
    `旧数据里没有 store「${store}」（位置：${location}）。「它不在」与「它在但没有记录」是两件事。`,
    `${location}/${store}`,
  )
}

/**
 * 记录容器 → 记录数组（**原样返回，不裁剪字段**）。
 *
 * · `null` / `undefined`（旧版导出脚本的空占位）→ `[]`（= 存在且 0 条）；
 * · 数组 → 原样（顺序即源文件顺序）；
 * · 「主键 → 记录」对象 → {@link rowsOfRecordMap} 的稳定排序；
 * · 其它（字符串 / 数字 / 布尔）→ `decode-failed`（这种容器不可能是「空 store」）。
 */
export function recordsOfContainer(value: unknown, location: string): readonly unknown[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) return rowsOfRecordMap(value)
  failRead(
    'decode-failed',
    `store 的记录容器既不是数组也不是「主键 → 记录」对象（位置：${location}）。这不等于「没有记录」。`,
    location,
  )
}
