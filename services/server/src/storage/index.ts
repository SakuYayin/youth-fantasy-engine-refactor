/**
 * 资产存储门面：把"相对键"翻译成绝对路径并执行落盘。
 *
 * 这一层是路由与 `node:fs` 之间唯一的接缝，输入永远是
 * （workspaceId, uploadId, partNumber）或 `storage_key` 这类**结构化**参数，
 * 路径拼接全部走 `paths.ts`，所以路由里不会出现任何 `path.join(storageRoot, x)`。
 *
 * 目录布局：
 *
 * ```
 * <storageRoot>/
 *   staging/<workspaceId>/<uploadId>/part-0000000000 …
 *   staging/<workspaceId>/<uploadId>/object.assembled   （整对象校验用的临时文件）
 *   objects/<sha[0:2]>/<sha[2:4]>/<sha>                 （内容寻址，不可变）
 * ```
 *
 * 内容寻址带来一个免费的好处：同一个文件被重复上传时，`objects/**` 里只会有
 * 一份字节；`commitObject` 因此按"目标已存在则丢弃源文件"处理。
 */

import type { ReadStream } from 'node:fs'
import { dirname, join } from 'node:path'

import { ContractError } from '@yfe/contracts'
import type { RequestId } from '@yfe/contracts'

import { StorageFsError } from './localFs.js'
import type { StorageFailureKind } from './localFs.js'

import {
  concatFilesToFile,
  createFileReadStream,
  ensureDir,
  fileSizeOrNull,
  listFilesRecursive,
  moveFile,
  removeFileIfExists,
  removeTreeIfExists,
  sha256OfBytes,
  sha256OfFile,
  writeFileBytes,
} from './localFs.js'
import {
  OBJECTS_PREFIX,
  STAGING_PREFIX,
  StoragePathError,
  assertStorageRoot,
  contentAddressedKey,
  joinKey,
  objectRelativeKey,
  partFileName,
  resolveUnderRoot,
  stagingDirKey,
} from './paths.js'

/** 拼接后整对象临时文件名（只存在于 staging 内）。 */
export const ASSEMBLED_FILE_NAME = 'object.assembled'

/** 存储根内的一个位置。 */
export interface StorageLocation {
  /** 相对键（`/` 分隔，可入库）。 */
  readonly key: string
  /** 存储根内的绝对路径（绝不入库）。 */
  readonly absolutePath: string
}

/** 已落盘的分片。 */
export interface StoredPartFile extends StorageLocation {
  readonly partNumber: number
  readonly byteSize: number
  readonly sha256: string
}

/** 拼接好的整对象（仍在 staging）。 */
export interface AssembledObject extends StorageLocation {
  readonly byteSize: number
}

/** 已进入对象库的资产文件。 */
export interface CommittedObject {
  readonly storageKey: string
  /** `objects/<storageKey>`。 */
  readonly relativeKey: string
  readonly absolutePath: string
  /** `true` = 命中已有对象（同一内容此前已存在），本次只丢弃了暂存副本。 */
  readonly deduplicated: boolean
}

export interface AssetStorage {
  /** 存储根（绝对路径，由配置注入）。 */
  readonly root: string
  /** `staging/<ws>/<upload>` 的位置。 */
  stagingDir(workspaceId: string, uploadId: string): StorageLocation
  /** 分片文件位置。 */
  partFile(workspaceId: string, uploadId: string, partNumber: number): StorageLocation
  /** 写入分片（覆盖），返回字节数与摘要。 */
  writePart(
    workspaceId: string,
    uploadId: string,
    partNumber: number,
    bytes: Buffer,
  ): StoredPartFile
  /** 把分片按编号顺序拼成整对象（不落对象库，交由整对象 sha256 校验）。 */
  assembleObject(
    workspaceId: string,
    uploadId: string,
    partNumbers: readonly number[],
  ): Promise<AssembledObject>
  /** 删除某次上传的整个暂存目录（成功、失败、放弃都用它）。 */
  removeStaging(workspaceId: string, uploadId: string): void
  /** 整对象 sha256（流式）。 */
  sha256OfFile(absolutePath: string): Promise<string>
  /** 把拼接文件搬进对象库（内容寻址，幂等）。 */
  commitObject(sha256Hex: string, sourcePath: string, byteSize: number): CommittedObject
  /** `storage_key` → 对象位置（**会拒绝逃逸键**）。 */
  objectLocation(storageKey: string): StorageLocation
  /** 对象字节数；不存在返回 `null`。 */
  objectSizeOrNull(storageKey: string): number | null
  /** 对象只读流。 */
  openObjectStream(storageKey: string): ReadStream
  /** `staging/**` 下所有文件（绝对路径，测试用来断言"无残留"）。 */
  listStagingFiles(): readonly string[]
  /** `objects/**` 下所有文件（绝对路径，测试用来断言"无残留"）。 */
  listObjectFiles(): readonly string[]
}

/**
 * 存储内容自相矛盾（例如拼接结果长度与记账不符、分片文件缺失）。
 * 路由层把它折成 `STORAGE_CORRUPT`。
 */
export class StorageIntegrityError extends Error {
  override readonly name = 'StorageIntegrityError'
}

export function createAssetStorage(root: string): AssetStorage {
  const absoluteRoot = assertStorageRoot(root)

  const stagingPrefix = resolveUnderRoot(absoluteRoot, STAGING_PREFIX, 'storageRoot')
  const objectsPrefix = resolveUnderRoot(absoluteRoot, OBJECTS_PREFIX, 'storageRoot')

  const partsPrefixOf = (workspaceId: string, uploadId: string): string =>
    resolveUnderRoot(absoluteRoot, stagingDirKey(workspaceId, uploadId), 'staging_dir')

  const stagingDir = (workspaceId: string, uploadId: string): StorageLocation => {
    const key = stagingDirKey(workspaceId, uploadId)
    return { key, absolutePath: resolveUnderRoot(absoluteRoot, key, 'staging_dir') }
  }

  const partFile = (
    workspaceId: string,
    uploadId: string,
    partNumber: number,
  ): StorageLocation => {
    const key = joinKey(stagingDirKey(workspaceId, uploadId), partFileName(partNumber))
    return { key, absolutePath: resolveUnderRoot(absoluteRoot, key, 'part') }
  }

  const objectLocation = (storageKey: string): StorageLocation => {
    const key = objectRelativeKey(storageKey)
    return { key, absolutePath: resolveUnderRoot(absoluteRoot, key, 'storage_key') }
  }

  return {
    root: absoluteRoot,
    stagingDir,
    partFile,

    writePart(workspaceId, uploadId, partNumber, bytes): StoredPartFile {
      const location = partFile(workspaceId, uploadId, partNumber)
      ensureDir(dirname(location.absolutePath))
      writeFileBytes(location.absolutePath, bytes)
      return {
        ...location,
        partNumber,
        byteSize: bytes.byteLength,
        sha256: sha256OfBytes(bytes),
      }
    },

    async assembleObject(workspaceId, uploadId, partNumbers): Promise<AssembledObject> {
      const key = joinKey(stagingDirKey(workspaceId, uploadId), ASSEMBLED_FILE_NAME)
      const absolutePath = resolveUnderRoot(absoluteRoot, key, 'assembled')
      const sources = partNumbers.map(
        (partNumber) => partFile(workspaceId, uploadId, partNumber).absolutePath,
      )
      const byteSize = await concatFilesToFile(sources, absolutePath)
      return { key, absolutePath, byteSize }
    },

    removeStaging(workspaceId, uploadId): void {
      removeTreeIfExists(partsPrefixOf(workspaceId, uploadId))
    },

    sha256OfFile(absolutePath: string): Promise<string> {
      return sha256OfFile(absolutePath)
    },

    commitObject(sha256Hex: string, sourcePath: string, byteSize: number): CommittedObject {
      const storageKey = contentAddressedKey(sha256Hex)
      const location = objectLocation(storageKey)
      const actual = fileSizeOrNull(sourcePath)
      if (actual === null || actual !== byteSize) {
        // 拼接结果与记账不符：宁可不入库，也不写一条对不上的资产记录。
        throw new StorageIntegrityError('拼接后的对象长度与记账不一致。')
      }
      const moved = moveFile(sourcePath, location.absolutePath)
      return {
        storageKey,
        relativeKey: objectRelativeKey(storageKey),
        absolutePath: location.absolutePath,
        deduplicated: !moved,
      }
    },

    objectLocation,

    objectSizeOrNull(storageKey: string): number | null {
      return fileSizeOrNull(objectLocation(storageKey).absolutePath)
    },

    openObjectStream(storageKey: string): ReadStream {
      return createFileReadStream(objectLocation(storageKey).absolutePath)
    },

    listStagingFiles(): readonly string[] {
      return listFilesRecursive(stagingPrefix).map((key) => join(stagingPrefix, key))
    },

    listObjectFiles(): readonly string[] {
      return listFilesRecursive(objectsPrefix).map((key) => join(objectsPrefix, key))
    },
  }
}

/** 确保存储根存在（幂等）。装配/首次上传时调用。 */
export function ensureStorageRoot(storage: AssetStorage): void {
  ensureDir(storage.root)
}

/** 删除一个对象文件（仅测试与运维清理使用；软删不动物理文件）。 */
export function removeObjectFile(storage: AssetStorage, storageKey: string): boolean {
  return removeFileIfExists(storage.objectLocation(storageKey).absolutePath)
}

const FAILURE_MESSAGES: Readonly<Record<StorageFailureKind, string>> = {
  not_found: '存储里的文件不存在。',
  disk_full: '存储空间不足，请清理后重试。',
  read_only: '存储目录当前不可写。',
  unavailable: '存储暂时不可用，请稍后重试。',
}

/**
 * 把存储层异常翻译成契约错误；不是存储异常时返回 `null`（调用方继续往外抛）。
 *
 * 🔴 返回的 `detail` 只有**字段名**，绝不含绝对路径、errno 原文或 SQLite 原文：
 * 客户端拿到的是"哪个字段的操作失败了"，定位细节留在服务端日志。
 * `STORAGE_*` 都不是 4xx——回 5xx 才会触发客户端重试。
 */
export function toStorageContractError(
  thrown: unknown,
  requestId: RequestId,
  field: string,
): ContractError | null {
  if (thrown instanceof StorageFsError) {
    const code =
      thrown.kind === 'disk_full'
        ? 'STORAGE_DISK_FULL'
        : thrown.kind === 'read_only'
          ? 'STORAGE_READ_ONLY'
          : thrown.kind === 'not_found'
            ? 'STORAGE_CORRUPT'
            : 'STORAGE_UNAVAILABLE'
    return new ContractError({
      code,
      message: FAILURE_MESSAGES[thrown.kind],
      requestId,
      detail: { field },
    })
  }
  if (thrown instanceof StoragePathError) {
    // 路径非法只可能来自被篡改的库字段（生成侧已经全部校验过）。
    return new ContractError({
      code: 'STORAGE_CORRUPT',
      message: '存储键非法，拒绝访问。',
      requestId,
      detail: { field },
    })
  }
  if (thrown instanceof StorageIntegrityError) {
    return new ContractError({
      code: 'STORAGE_CORRUPT',
      message: '存储内容与记账不一致。',
      requestId,
      detail: { field },
    })
  }
  return null
}
