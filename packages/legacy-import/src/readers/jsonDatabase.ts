/**
 * IndexedDB 导出 JSON 读取器（桌面/便携「整库 JSON」）。
 *
 * 真实格式（`upstream/src/lib/storage/storeOps.ts:32-42`）：
 *
 * ```jsonc
 * {
 *   "app": "youth-fantasy-engine",
 *   "kind": "portable-data",
 *   "fileVersion": 2,
 *   "savedAt": 1750000000000,
 *   "stores": { "<store>": { "<主键>": { …记录… } } }   // ← 对象，不是数组
 * }
 * ```
 *
 * 🔴 `stores` 是「store 名 → { 主键 → 记录 }」，这一点与直觉相反：上游 `PortableData`
 *    就是把每个 store 的 Map 直接 `JSON.stringify` 出去（`storeOps.ts:35-42`）。
 *    同时兼容两种更松的形态，免得旧脚本导出被整份拒绝：
 *    · `{ "<store>": [record, …] }`（任务书给的形状，值可以是**数组**）；
 *    · 老版本 sidecar / 早期导出脚本的「数组或主键→记录」两种行形态
 *      （`upstream/src/lib/storage/sidecar.ts:300-312` 的 `extractSidecarRows` 也同时认这两种）。
 *
 * `requirePortableData: true` 时按上游 `isPortableDataFile`（`storeOps.ts:71-75`）验身份：
 * `kind === 'portable-data'`，`app` 缺省或等于 `youth-fantasy-engine`。缺这层校验时，把
 * 随便一个 JSON（比如 `package.json`）喂进来会「成功」读出一堆假 store。
 *
 * 记录**原样返回**：不裁剪字段、不换算 `vecB64`、不补默认值——未知字段的去留由上层
 * `mapping.ts` 负责保留与报告。
 */

import { LegacyReadError } from '../errors.js'
import type { LegacySourceReader } from '../inventory.js'
import {
  defaultLocation,
  isPlainObject,
  readJsonFileStrict,
  recordsOfContainer,
  sortNames,
} from './internal.js'

export interface JsonDatabaseReaderOptions {
  /** 数据文件路径（上游默认 `youth-fantasy-engine-data.json`，`desktop.ts:3`）。 */
  readonly file: string
  /** 报告里的位置（缺省 = basename）。`R-03`：不要塞绝对路径。 */
  readonly location?: string
  /** 要求文件带 PortableData 头（`kind:'portable-data'`）。缺省 false（宽容）。 */
  readonly requirePortableData?: boolean
}

/** PortableData 的头部字段：它们不是 store（`storeOps.ts:35-42`）。 */
const PORTABLE_HEADER_KEYS: readonly string[] = ['app', 'kind', 'fileVersion', 'savedAt']

/** 上游写出的应用标识（`storeOps.ts:33-36`）。 */
const PORTABLE_APP_ID = 'youth-fantasy-engine'

function decodeFailure(message: string, location: string): never {
  throw new LegacyReadError({ kind: 'decode-failed', message, location })
}

/**
 * 顶层 JSON → 「store 名 → 记录容器」。
 *
 * · 有 `stores` 对象 → 用它（便携/桌面整库导出的正式形态）；
 * · 否则把除 PortableData 头部以外的**自有键**当作 store（`{"projects": [...]}` 形态）；
 * · 顶层不是对象 → `decode-failed`（数组 / 字符串 / 数字都不可能是「空库」）。
 */
function storesOfFile(
  parsed: unknown,
  location: string,
  requirePortableData: boolean,
): Record<string, unknown> {
  if (!isPlainObject(parsed)) {
    decodeFailure(
      `旧数据文件的顶层不是对象（位置：${location}）。这不等于「里面没有 store」。`,
      location,
    )
  }
  if (requirePortableData) {
    if (parsed['kind'] !== 'portable-data') {
      decodeFailure(
        `这不是本软件写出的整库数据文件：缺少 kind='portable-data' 标识（位置：${location}）。`,
        location,
      )
    }
    const app = parsed['app']
    if (app !== undefined && app !== PORTABLE_APP_ID) {
      decodeFailure(
        `这不是本软件写出的整库数据文件：app='${String(app)}'（位置：${location}）。`,
        location,
      )
    }
  }
  const nested = parsed['stores']
  if (isPlainObject(nested)) return { ...nested }
  const stores: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (PORTABLE_HEADER_KEYS.includes(key)) continue
    stores[key] = value
  }
  return stores
}

/**
 * 建一个「整库 JSON」读取器。
 *
 * · `listStores()`：文件里**实际存在**的 store 名（`localeCompare` 排序）。读不了文件 → 抛
 *   （由 `scanLegacySource` 折算成**来源级** refused，`inventory.ts:284-301`）；
 * · `readRecords(store)`：该 store 的全部原始记录。store 不在文件里 → 抛 `store-missing`
 *   （**不是**空数组：只有来源声明写了 `created:false` 才允许由扫描器折算成 `absent`）。
 */
export function createJsonDatabaseReader(
  options: JsonDatabaseReaderOptions,
): LegacySourceReader {
  const location = options.location ?? defaultLocation(options.file)
  const requirePortableData = options.requirePortableData === true
  let cached: Record<string, unknown> | null = null

  function stores(): Record<string, unknown> {
    if (cached === null) {
      cached = storesOfFile(
        readJsonFileStrict(options.file, location),
        location,
        requirePortableData,
      )
    }
    return cached
  }

  return {
    listStores: () => sortNames(Object.keys(stores())),
    readRecords: (store: string) => {
      const container = stores()
      if (!Object.hasOwn(container, store)) {
        throw new LegacyReadError({
          kind: 'store-missing',
          message: `旧数据里没有 store「${store}」（位置：${location}）。「它不在」与「它在但没有记录」是两件事。`,
          location: `${location}/${store}`,
        })
      }
      return recordsOfContainer(container[store], `${location}/${store}`)
    },
  }
}
