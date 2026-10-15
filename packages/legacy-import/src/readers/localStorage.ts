/**
 * localStorage 导出 JSON 读取器。
 *
 * ⚠️ 前提说明：**上游从不把 localStorage 落盘**——主题、字体、网盘/WebDAV/S3 配置、
 * 墓碑等只活在浏览器 `localStorage` 里（见 `docs/旧功能迁移矩阵.md` M-22）。所以这个格式
 * 是「旧桌面版/浏览器导出脚本导出的键值转储」，不是上游原生文件；读取器只认**能确认的
 * 三种包裹层**，记录一律归一成 `{ key, value }`，因为上层 `mapping.ts:1429-1465` 正是
 * 按 `key` / `value` 两个字段取值的（值若是字符串会先 `JSON.parse`，解析失败保留原串）。
 *
 * 认这三种形态（多余的包裹层只是宽容，不做字段猜测）：
 *
 * ```jsonc
 * { "yfe-theme": "dark", "yfe-sync-webdav": "{\"baseUrl\":…}" }   // ① 裸键值转储
 * { "localStorage": { "<key>": <value> } }                        // ② 带 localStorage 层
 * { "localStorage": [ { "key": "yfe-theme", "value": "dark" } ] } // ③ 已是记录数组
 * { "stores": { "localStorage": … } }                             // ②/③ 再套一层 stores
 * ```
 *
 * 「store 不存在」与「store 是空的」严格分开：
 * · 便携整库文件（顶层带 `stores`）里**没有** `localStorage` → 该 store 不存在
 *   ⇒ `readRecords` 抛 `store-missing`（refused），`listStores()` 返回 `[]`；
 * · 裸键值转储是空对象 `{}` / `{"localStorage":{}}` → store 存在且 0 条 ⇒ `ok` + 0 条。
 */

import { LegacyReadError } from '../errors.js'
import type { LegacySourceReader } from '../inventory.js'
import { LEGACY_LOCAL_STORAGE_STORE } from '../mapping.js'
import {
  defaultLocation,
  isPlainObject,
  readJsonFileStrict,
  sortNames,
} from './internal.js'

export interface LocalStorageDumpReaderOptions {
  /** 转储文件路径（`.json`）。 */
  readonly file: string
  /** 报告里的位置（缺省 = basename）。`R-03`：不要塞绝对路径。 */
  readonly location?: string
}

function decodeFailure(message: string, location: string): never {
  throw new LegacyReadError({ kind: 'decode-failed', message, location })
}

interface Located {
  /** store 本身在文件里存在吗（`false` ⇒ refused，不是「0 条」）。 */
  readonly exists: boolean
  /** 记录容器（键值对象 / 记录数组 / `null` 占位）。 */
  readonly value: unknown
}

/** 剥掉包裹层，定位到 localStorage 的键值容器。 */
function locate(parsed: unknown, location: string): Located {
  if (Array.isArray(parsed)) return { exists: true, value: parsed }
  if (!isPlainObject(parsed)) {
    decodeFailure(
      `localStorage 转储的顶层既不是对象也不是数组（位置：${location}）。这不等于「没有数据」。`,
      location,
    )
  }
  const stores = parsed['stores']
  if (isPlainObject(stores)) {
    // 便携整库导出：localStorage 不在其中就是**不在**，不能折算成 0 条。
    const nested = stores[LEGACY_LOCAL_STORAGE_STORE]
    return nested === undefined ? { exists: false, value: undefined } : { exists: true, value: nested }
  }
  const direct = parsed[LEGACY_LOCAL_STORAGE_STORE]
  if (direct !== undefined) return { exists: true, value: direct }
  return { exists: true, value: parsed }
}

/**
 * 容器 → 记录数组。**原样返回，不裁剪字段**。
 *
 * · 记录数组 → 原样（顺序 = 源文件顺序，已经是 km 需要的形状）；
 * · 键值对象 → 按 localStorage 键 `localeCompare` 排序后合成为 `{ key, value }`；
 * · `null` / `undefined` → 空（存在但 0 条）；
 * · 其它 → `decode-failed`。
 */
function recordsOf(value: unknown, location: string): readonly unknown[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) {
    return sortNames(Object.keys(value)).map((key) => ({ key, value: value[key] }))
  }
  decodeFailure(
    `localStorage 的记录容器既不是键值对象也不是记录数组（位置：${location}）。这不等于「没有数据」。`,
    location,
  )
}

/**
 * 建一个 localStorage 转储读取器。store 名恒为 `LEGACY_LOCAL_STORAGE_STORE`（`'localStorage'`）。
 */
export function createLocalStorageDumpReader(
  options: LocalStorageDumpReaderOptions,
): LegacySourceReader {
  const location = options.location ?? defaultLocation(options.file)
  let cached: Located | null = null

  function located(): Located {
    if (cached === null) cached = locate(readJsonFileStrict(options.file, location), location)
    return cached
  }

  return {
    listStores: () => (located().exists ? [LEGACY_LOCAL_STORAGE_STORE] : []),
    readRecords: (store: string) => {
      if (store !== LEGACY_LOCAL_STORAGE_STORE) {
        throw new LegacyReadError({
          kind: 'store-missing',
          message: `localStorage 转储里没有 store「${store}」（位置：${location}）。「它不在」与「它在但没有记录」是两件事。`,
          location: `${location}/${store}`,
        })
      }
      const found = located()
      if (!found.exists) {
        throw new LegacyReadError({
          kind: 'store-missing',
          message: `这份文件里没有 localStorage store（位置：${location}）。「它不在」与「它在但没有记录」是两件事。`,
          location: `${location}/${LEGACY_LOCAL_STORAGE_STORE}`,
        })
      }
      return recordsOf(found.value, `${location}/${LEGACY_LOCAL_STORAGE_STORE}`)
    },
  }
}
