/**
 * 同步文件（`.yfe`）读取器——**只识别、不导入**（迁移矩阵 M-21）。
 *
 * 真实格式（全部实测自 upstream）：
 *
 * ```jsonc
 * // 文件本身是明文 JSON（upstream/src/lib/sync/syncTransport.ts:377 writeRaw）：
 * { "rev": 12, "enc": "a1:base64(iv[12] || AES-GCM ciphertext+tag)" }
 * ```
 *
 * · `parseRev`（`syncTransport.ts:313-327`）：空 / 缺 `enc` ⇒ `{rev:0,enc:null}`；JSON 非法 ⇒
 *   **corrupt**（上游自己不把它退化成 rev=0，读取器同样不）；
 * · 载荷加密（`syncCore.ts:528-568`）：`a1:` = AES-GCM-256，IV 是 base64 明文的前 12 字节，
 *   其余是密文 + 16 字节认证标签；`x1:` = XOR 混淆（无 WebCrypto 的公网降级，`syncCore.ts:209-219`
 *   的 keystream）；其它前缀 = 明文 JSON（`decryptObj` 兜底）；
 * · 密钥：`PBKDF2(SHA-256, salt 'yfe-cloud-sync-v1', 100000 次) → AES-GCM 256`
 *   （`syncCore.ts:196-207`），桌面/便携用内置口令 `DEFAULT_CLOUD_KEY =
 *   'YFE-CLOUD-FILE-SYNC-V1'`（`syncTransport.ts:50`）；
 * · 解密后的明文就是 `SyncPayload = Record<store, row[]> & { __cloudBackup? }`
 *   （`syncCore.ts:83-87`）——**「store 名 → 行数组」**；
 * · 文件名 `青春幻想引擎-同步数据.yfe`（`syncTransport.ts:53`）。
 *
 * 🔴 为什么 `listStores()` 恒返回空数组：`scanLegacySource` 会用 `listStores()` 的成败判定
 *    来源级状态、用 `readRecords` 判定每个 store。若这里假装能读，`.yfe` 就会被当成普通数据源
 *    走一遍导入流水线——而 M-21 的结论是**不导入**（`mapping.ts:1502-1508` 只按 `kind==='sync-file'`
 *    报 deferred）。所以本读取器：`listStores()` 恒 `[]`、`readRecords()` 恒抛 `store-missing`——
 *    它**不可能**被误当成「空库」，解密结果只经 {@link SyncFileReader.inspect} 供人看。
 */

import { createDecipheriv, pbkdf2Sync } from 'node:crypto'

import { LegacyReadError } from '../errors.js'
import type { LegacySourceReader } from '../inventory.js'
import {
  defaultLocation,
  fileStamp,
  isPlainObject,
  readJsonFileStrict,
  sortNames,
} from './internal.js'

/** 上游桌面/便携的内置同步口令（`upstream/src/lib/sync/syncTransport.ts:50`）。 */
export const DEFAULT_CLOUD_KEY = 'YFE-CLOUD-FILE-SYNC-V1'

/** 上游 PBKDF2 盐（`upstream/src/lib/sync/syncCore.ts:178`）。 */
const SYNC_SALT = 'yfe-cloud-sync-v1'

/** 上游派生迭代次数（`syncCore.ts:201`）。 */
const PBKDF2_ITERATIONS = 100_000

const AES_IV_BYTES = 12
const AES_TAG_BYTES = 16

/** 载荷的封装形态（`syncCore.ts:564-568` 的 `decryptObj` 分派）。 */
export type SyncPayloadFormat = 'aes-gcm' | 'xor-obfuscated' | 'plaintext-json' | 'absent'

/** 「只识别不导入」的取证结果；**不参与导入流水线**。 */
export interface SyncFileInspection {
  /** 报告用位置（不是绝对路径）。 */
  readonly location: string
  readonly bytes: number
  readonly modifiedAt: string
  /** 明文 `rev`（缺失或非法 = 0）。 */
  readonly rev: number
  readonly payloadFormat: SyncPayloadFormat
  /** 是否成功解出可解析的载荷（false 时看 `reason`）。 */
  readonly decoded: boolean
  /** 载荷里的 store 名（值必须是数组），`localeCompare` 排序。 */
  readonly storeNames: readonly string[]
  /** store 名 → 行数。 */
  readonly storeCounts: Readonly<Record<string, number>>
  /** 载荷里不是「行数组」的顶层键（例如 `__cloudBackup`）。 */
  readonly nonStoreKeys: readonly string[]
  /** `decoded === false` 的原因；成功时为 `null`。 */
  readonly reason: string | null
}

export interface SyncFileReaderOptions {
  /** `.yfe` 文件路径。 */
  readonly file: string
  /** 报告里的位置（缺省 = basename）。`R-03`：不要塞绝对路径。 */
  readonly location?: string
  /** 解密口令；缺省 = 上游内置的 {@link DEFAULT_CLOUD_KEY}。 */
  readonly key?: string
}

/** `.yfe` 读取器：只能 `inspect()`（识别 + 取证），不能导入。 */
export interface SyncFileReader extends LegacySourceReader {
  inspect: () => SyncFileInspection
}

/** 上游 XOR 混淆的 keystream（`syncCore.ts:210-219`，逐字节照抄，勿改）。 */
function xorKeystream(code: string): Uint8Array {
  const seed = Buffer.from(`${code}::yfe-sync`, 'utf8')
  const key = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    const byte = seed[i % seed.length] ?? 0
    key[i] = (byte ^ ((i * 167) & 0xff) ^ ((i >>> 3) & 0xff)) & 0xff
  }
  return key
}

/** `x1:` 载荷 → 明文（`syncCore.ts:552-558`）。 */
function deobfuscate(payload: string, code: string): unknown {
  const data = Buffer.from(payload.slice(3), 'base64')
  const key = xorKeystream(code)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (key[i & 0xff] ?? 0)
  return JSON.parse(out.toString('utf8')) as unknown
}

/** `a1:` 载荷 → 明文（`syncCore.ts:538-544` + `:196-207`）。 */
function decryptAesGcm(payload: string, code: string): unknown {
  const combined = Buffer.from(payload.slice(3), 'base64')
  if (combined.length < AES_IV_BYTES + AES_TAG_BYTES) {
    throw new Error('密文长度不足：连 IV 与认证标签都放不下')
  }
  const iv = combined.subarray(0, AES_IV_BYTES)
  const body = combined.subarray(AES_IV_BYTES)
  const tag = body.subarray(body.length - AES_TAG_BYTES)
  const data = body.subarray(0, body.length - AES_TAG_BYTES)
  const derived = pbkdf2Sync(code, SYNC_SALT, PBKDF2_ITERATIONS, 32, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', derived, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(data), decipher.final()])
  return JSON.parse(plain.toString('utf8')) as unknown
}

function formatOf(enc: unknown): SyncPayloadFormat {
  if (typeof enc !== 'string' || enc === '') return 'absent'
  if (enc.startsWith('a1:')) return 'aes-gcm'
  if (enc.startsWith('x1:')) return 'xor-obfuscated'
  return 'plaintext-json'
}

function errorTextOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** 载荷明文 → store 名 / 行数 / 非 store 键。 */
function summarizePayload(payload: unknown): {
  readonly storeNames: readonly string[]
  readonly storeCounts: Readonly<Record<string, number>>
  readonly nonStoreKeys: readonly string[]
} | null {
  if (!isPlainObject(payload)) return null
  const storeNames: string[] = []
  const nonStoreKeys: string[] = []
  const storeCounts: Record<string, number> = {}
  for (const key of sortNames(Object.keys(payload))) {
    const value = payload[key]
    if (Array.isArray(value)) {
      storeNames.push(key)
      storeCounts[key] = value.length
    } else {
      nonStoreKeys.push(key)
    }
  }
  return { storeNames, storeCounts, nonStoreKeys }
}

/**
 * 建一个 `.yfe` 同步文件读取器。
 *
 * **它不是导入源**：`listStores()` 恒 `[]`（M-21），`readRecords()` 恒抛 `store-missing`。
 * 想确定「这是不是一份同步文件、里面有哪些 store、多少行」就调 `inspect()`——
 * 解密失败**不抛**，而是 `decoded:false` + `reason`（文件本身读到了，且 `listStores()` 恒空
 * 保证它不可能被当成「空库」去覆盖别人的数据）；文件读不到照样抛 `not-found`。
 */
export function createSyncFileReader(options: SyncFileReaderOptions): SyncFileReader {
  const location = options.location ?? defaultLocation(options.file)
  const code = options.key ?? DEFAULT_CLOUD_KEY

  return {
    listStores: () => [],
    readRecords: (store: string) => {
      throw new LegacyReadError({
        kind: 'store-missing',
        message: `同步文件（.yfe）按迁移矩阵 M-21 只识别、不导入，因此取不到 store「${store}」（位置：${location}）。`,
        location: `${location}/${store}`,
      })
    },
    inspect: (): SyncFileInspection => {
      const stamp = fileStamp(options.file, location)
      const parsed = readJsonFileStrict(options.file, location)
      if (!isPlainObject(parsed)) {
        throw new LegacyReadError({
          kind: 'decode-failed',
          message: `同步文件的顶层不是对象（位置：${location}）。`,
          location,
        })
      }
      const rawRev = parsed['rev']
      const rev = typeof rawRev === 'number' && Number.isFinite(rawRev) ? rawRev : 0
      const enc = parsed['enc']
      const payloadFormat = formatOf(enc)
      const base = { location, bytes: stamp.bytes, modifiedAt: stamp.modifiedAt, rev, payloadFormat }
      if (payloadFormat === 'absent') {
        return {
          ...base,
          decoded: false,
          storeNames: [],
          storeCounts: {},
          nonStoreKeys: [],
          reason: '同步文件里没有载荷：enc 缺省或为空（上游 parseRev 把它当作 rev=0 的空槽位）。',
        }
      }
      let payload: unknown
      try {
        const text = enc as string
        if (payloadFormat === 'aes-gcm') payload = decryptAesGcm(text, code)
        else if (payloadFormat === 'xor-obfuscated') payload = deobfuscate(text, code)
        else payload = JSON.parse(text) as unknown
      } catch (error) {
        return {
          ...base,
          decoded: false,
          storeNames: [],
          storeCounts: {},
          nonStoreKeys: [],
          reason: `载荷解密/解析失败（${errorTextOf(error)}）。文件本身读到了，但这不等于「里面没有数据」。`,
        }
      }
      const summary = summarizePayload(payload)
      if (summary === null) {
        return {
          ...base,
          decoded: false,
          storeNames: [],
          storeCounts: {},
          nonStoreKeys: [],
          reason: '载荷解出来了，但顶层不是「store 名 → 行数组」对象。',
        }
      }
      return { ...base, decoded: true, ...summary, reason: null }
    },
  }
}
