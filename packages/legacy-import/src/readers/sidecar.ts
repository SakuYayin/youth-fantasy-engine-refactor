/**
 * sidecar（外置存储）目录读取器。
 *
 * 真实布局（上游两处实现完全一致，只是白名单不同）：
 *
 * ```
 * <数据目录>/blobs/<store>/<id>.json      ← per-id：一文件一记录
 * <数据目录>/blobs/<store>/__all__.json   ← whole：一文件整表（一个 JSON 数组）
 * ```
 *
 * · 桌面：`upstream/electron/main.cjs:170-184` 白名单**只有** `backupPayloads`；
 * · 便携：`upstream/scripts/portable-server.mjs:97` 白名单 = `backupPayloads` / `vecRows` /
 *   `kbDocs` / `kbBodies`（后三个是 whole 布局，见 `upstream/src/lib/storage/portableVecKb.ts`）。
 * · 文件内容 = 单条记录的 `JSON.stringify`（per-id，`main.cjs:198-208`）或整表数组（whole）；
 * · id 规则 `^[A-Za-z0-9_-]{1,64}$`（`main.cjs:171`、`portable-server.mjs:99`）——uid 或
 *   whole 的固定键 `__all__`；列出时按 `.json` 去后缀（`main.cjs:225-238`）。
 * · `SIDECAR_WHOLE_KEY = '__all__'`（`upstream/src/lib/storage/sidecar.ts:32`）；
 *   `extractSidecarRows`（同文件 `:300-312`）除了数组还兼容老版本的「主键 → 记录」对象。
 *
 * 三条不妥协：
 * 1. store 目录不存在 ⇒ `store-missing`（refused），**不是** 0 条（除非来源声明 `created:false`）；
 * 2. 目录存在但没有任何 `.json` ⇒ `ok` + 0 条（「存在但为空」是真的空）；
 * 3. `__all__.json` 与 per-id 文件**同时存在** ⇒ `package-corrupt`（布局不自洽）。两种布局
 *    混在一起说明这份目录不是上游写出来的，静默只认一半会**悄悄丢记录**。
 *
 * `dir` 传的是 `blobs` 那一层（`…/blobs`），不是它的父目录。
 */

import { join } from 'node:path'

import { LegacyReadError } from '../errors.js'
import type { LegacySourceReader } from '../inventory.js'
import {
  defaultLocation,
  existsAsDirectory,
  failMissingStore,
  listDirectoryStrict,
  readJsonFileStrict,
  recordsOfContainer,
  sortNames,
} from './internal.js'

/** 上游整表布局的固定键（`upstream/src/lib/storage/sidecar.ts:32`）。 */
export const SIDECAR_WHOLE_KEY = '__all__'

/** 上游写出来的 id 只可能是这些字符（`main.cjs:171`、`portable-server.mjs:99`）。 */
const BLOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u

const JSON_SUFFIX = '.json'

export interface SidecarDirectoryReaderOptions {
  /** `blobs` 目录的路径（`…/blobs`）。 */
  readonly dir: string
  /** 报告里的位置（缺省 = 目录 basename）。`R-03`：不要塞绝对路径。 */
  readonly location?: string
}

function storeNameOf(fileName: string): string {
  return fileName.slice(0, -JSON_SUFFIX.length)
}

/**
 * 建一个 sidecar 目录读取器。
 *
 * · `listStores()`：`blobs` 下**实际存在**的子目录名（`localeCompare` 排序）；
 *   目录本身读不了 → 抛（来源级 refused，`inventory.ts:284-301`）；
 * · `readRecords(store)`：per-id 布局按文件名的 `localeCompare` 稳定排序后逐条读
 *   （上游是按文件系统顺序列的，这里换成可复现的顺序；whole 布局即该数组的原顺序）。
 */
export function createSidecarDirectoryReader(
  options: SidecarDirectoryReaderOptions,
): LegacySourceReader {
  const location = options.location ?? defaultLocation(options.dir)

  return {
    listStores: () => {
      const entries = listDirectoryStrict(options.dir, location)
      return sortNames(entries.filter((name) => existsAsDirectory(join(options.dir, name))))
    },
    readRecords: (store: string) => {
      const storeDir = join(options.dir, store)
      if (!existsAsDirectory(storeDir)) failMissingStore(store, location)
      const storeLocation = `${location}/${store}`
      const jsonFiles = listDirectoryStrict(storeDir, storeLocation).filter((name) =>
        name.endsWith(JSON_SUFFIX),
      )
      const wholeKeyFile = `${SIDECAR_WHOLE_KEY}${JSON_SUFFIX}`
      const hasWhole = jsonFiles.includes(wholeKeyFile)
      const singles = jsonFiles.filter((name) => name !== wholeKeyFile)
      if (hasWhole && singles.length > 0) {
        throw new LegacyReadError({
          kind: 'package-corrupt',
          message: `sidecar 的 store「${store}」同时存在整表文件 ${wholeKeyFile} 和 ${singles.length} 个逐条文件（位置：${storeLocation}）。两种布局混在一起，无法确定哪一份是权威——拒绝静默只认一半。`,
          location: storeLocation,
        })
      }
      if (hasWhole) {
        return recordsOfContainer(
          readJsonFileStrict(join(storeDir, wholeKeyFile), `${storeLocation}/${wholeKeyFile}`),
          storeLocation,
        )
      }
      const foreign = singles.filter((name) => !BLOB_ID_RE.test(storeNameOf(name)))
      if (foreign.length > 0) {
        throw new LegacyReadError({
          kind: 'package-corrupt',
          message: `sidecar 的 store「${store}」里有不符合上游 id 规则的 .json 文件：${foreign.slice(0, 3).join('、')}${foreign.length > 3 ? ' 等' : ''}（位置：${storeLocation}）。这些文件不是本软件写出的，不能被静默跳过。`,
          location: storeLocation,
        })
      }
      return sortNames(singles).map((name) =>
        readJsonFileStrict(join(storeDir, name), `${storeLocation}/${name}`),
      )
    },
  }
}
