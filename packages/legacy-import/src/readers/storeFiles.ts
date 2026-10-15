/**
 * 「store 名 → 单个 JSON 文件」读取器，以及知识库（`-kb`）/ 向量索引（`-vec`）两个便捷工厂。
 *
 * 真实格式出处：
 *
 * · **知识库**：库名 `youth-fantasy-engine-kb` v1，两个 store `docs` + `bodies`，keyPath 均为 `id`
 *   （`upstream/src/lib/search/knowledgeBase.ts:62-65`、`:86-88`；旧品牌库 `novel-studio-kb`
 *   迁移时也只搬这两个 store，`:589-616`）。
 *   - `docs` 行 = `KbDoc`：`{ id, projectId, title, sourceType:'txt'|'md'|'docx'|'paste', chars,
 *     chunkCount, importedAt, enabled }`（`:33-47`，另有 `projectId` 索引）；
 *   - `bodies` 行 = `{ id, text }`（`upstream/src/lib/storage/portableVecKb.ts:157`），
 *     上层 `mapping.ts:1340-1351` 还会认 `docId` / `content` / `body`，这里一律原样透出。
 * · **向量索引**：库名 `youth-fantasy-engine-vec` v1，store `embeddings`，keyPath `id`
 *   （`upstream/src/lib/semantic/store.ts:97`、`:105-112`）。行 = `VecRow`：`{ id, projectId,
 *   refKey, kind:'chapter'|'summary'|'setting'|'kb'|'tavern', refId, chunkIdx, text, title,
 *   hash, vec: ArrayBuffer, dim, model, secret, updatedAt }`（`:30-55`）。
 *   ⚠️ `vec` 是 **ArrayBuffer**，JSON 表达不了；便携落盘时被换成 base64 字符串字段 `vecB64`
 *   （`portableVecKb.ts:103-113`）。读取器**不换算、不裁剪**，原样返回（向量按迁移矩阵
 *   M-17 本来就不迁移，`mapping.ts:1494-1501` 只按条数报 deferred）。
 *
 * 三种容器的归一：数组原样；「主键 → 记录」对象按主键 `localeCompare` 稳定排序；
 * `null` 占位 → 0 条。文件不存在 ⇒ `not-found`（refused）；文件存在且是**合法空容器**
 * （`[]` / `{}` / `null`）⇒ `ok` + 0 条；文件存在但 **0 字节或纯空白** ⇒ `decode-failed`
 * （refused——「读不出来」不等于「没有记录」，见 `errors.ts:243-250`）。
 */

import { LegacyReadError } from '../errors.js'
import type { LegacySourceReader } from '../inventory.js'
import { LEGACY_KB_STORE, LEGACY_VEC_STORE } from '../mapping.js'
import {
  defaultLocation,
  existsAsFile,
  readJsonFileStrict,
  recordsOfContainer,
  sortNames,
} from './internal.js'

export interface StoreFilesReaderOptions {
  /** store 名 → 该 store 的 JSON 文件路径（一个 store 一个文件）。 */
  readonly files: Readonly<Record<string, string>>
  /** 报告里的位置前缀（缺省 = 各文件自己的 basename）。`R-03`：不要塞绝对路径。 */
  readonly location?: string
}

export interface KnowledgeBaseReaderOptions {
  /** `docs` store 的 JSON 文件（`KbDoc` 数组）。 */
  readonly docsFile: string
  /** `bodies` store 的 JSON 文件（`{ id, text }` 数组）。缺省 = 该 store 不存在。 */
  readonly bodiesFile?: string
  /** 报告里的位置前缀（缺省 = 各文件自己的 basename）。 */
  readonly location?: string
}

export interface VectorIndexReaderOptions {
  /** `embeddings` store 的 JSON 文件（`VecRow` 数组，`vec` 已换成 `vecB64`）。 */
  readonly embeddingsFile: string
  /** 报告里的位置前缀（缺省 = 文件自己的 basename）。 */
  readonly location?: string
}

/**
 * 建一个「store 名 → 文件」读取器。
 *
 * · `listStores()`：**文件确实存在**的 store 名（`localeCompare` 排序）——声明了但文件不在的
 *   store 不会出现在这里，于是 `readRecords` 会抛 `store-missing`，由扫描器报 refused；
 * · `readRecords(store)`：该文件的全部原始记录。
 */
export function createStoreFilesReader(options: StoreFilesReaderOptions): LegacySourceReader {
  const fileOf = (store: string): string | undefined => {
    const path = options.files[store]
    return typeof path === 'string' && path !== '' ? path : undefined
  }
  const locationOf = (store: string, path: string): string =>
    options.location === undefined ? defaultLocation(path) : `${options.location}/${store}`

  return {
    listStores: () =>
      sortNames(
        Object.keys(options.files).filter((store) => {
          const path = fileOf(store)
          return path !== undefined && existsAsFile(path)
        }),
      ),
    readRecords: (store: string) => {
      const path = fileOf(store)
      if (path === undefined) {
        throw new LegacyReadError({
          kind: 'store-missing',
          message: `这份旧数据清单里没有 store「${store}」。「它不在」与「它在但没有记录」是两件事。`,
          location: options.location === undefined ? store : `${options.location}/${store}`,
        })
      }
      const location = locationOf(store, path)
      return recordsOfContainer(readJsonFileStrict(path, location), location)
    },
  }
}

/** 建一个知识库（`-kb`）读取器：`docs` + 可选 `bodies`。 */
export function createKnowledgeBaseReader(
  options: KnowledgeBaseReaderOptions,
): LegacySourceReader {
  const files: Record<string, string> = { [LEGACY_KB_STORE.docs]: options.docsFile }
  if (options.bodiesFile !== undefined) files[LEGACY_KB_STORE.bodies] = options.bodiesFile
  return createStoreFilesReader(
    options.location === undefined ? { files } : { files, location: options.location },
  )
}

/** 建一个向量索引（`-vec`）读取器：只认 `embeddings`。 */
export function createVectorIndexReader(
  options: VectorIndexReaderOptions,
): LegacySourceReader {
  const files: Record<string, string> = { [LEGACY_VEC_STORE.embeddings]: options.embeddingsFile }
  return createStoreFilesReader(
    options.location === undefined ? { files } : { files, location: options.location },
  )
}
