/**
 * 第一步：**可追踪清单** + 只读解析（`docs/旧功能迁移矩阵.md` §2.4 第 ① ② 步）。
 *
 * 本模块只做两件事：
 *
 * 1. 把「旧版有哪些持久化位置、每个位置有哪些 store」描述成一棵**可追踪**的声明树
 *    （{@link LegacySourceDeclaration}），每一步都能定位到 `<来源>/<库>/<store>`。
 * 2. 按声明去读，并把**每一次读取的结局**记成一个三态之一：
 *    `ok`（读到了 N 条）/ `absent`（有证据说明它从未存在）/ `refused`（读不出来）。
 *
 * 🔴 三态里没有任何一态是「默认空」：
 *    - `absent` 需要**显式证据**：旧库清单声明该 store `created: false`
 *      （IndexedDB 上一版数据库升级时创建的 store 清单是权威的，
 *      `upstream/src/lib/sync/syncCore.ts` 的 `SYNC_STORES` 之外从未建过的 store 就是这种）；
 *    - `refused` 的行数是 `null`（**不是 0**），报告里和「0 条」永远区分得开；
 *    - "读到空数组" 与 "读不出来" 只有在**读成功**时才能区分，这就是为什么
 *      `readRecords` 必须抛而不是返回 `[]`（见 `errors.ts` 的 `LegacyReadError`）。
 *
 * 本模块**没有任何写操作**：不打开可写句柄、不 `mkdir`、不 `writeFile`。
 * 只读源是本任务的第一条语义，靠「这个文件里压根没有写 API 的引用」来保证，
 * 而不是靠调用方自觉。
 */

import type { ErrorCode, RequestId } from '@yfe/contracts'

import {
  classifyReadFailure,
  classifyThrown,
  errorCodeOfReadFailure,
  legacyReadFailure,
  readFailureLocation,
  readFailureOrigin,
  type LegacyReadFailureKind,
  type LegacyReadOrigin,
} from './errors.js'

// ---------------------------------------------------------------------------
// 声明（输入侧，由调用方给出，本模块不猜测）
// ---------------------------------------------------------------------------

/**
 * 旧版持久化位置的种类。
 *
 * 与迁移矩阵 §2.1 一一对应：4 个 IndexedDB 库 + 桌面 JSON + sidecar +
 * localStorage + `.yfe` 同步文件。旧品牌库（`novel-studio*`）也是 `indexeddb`，
 * 靠 `sourceId` 区分，不额外开一种 kind。
 */
export type LegacySourceKind =
  | 'indexeddb'
  | 'json-file'
  | 'sidecar'
  | 'localstorage'
  | 'sync-file'

/**
 * 一个 store 的声明。
 *
 * 🔴 `created` 是「显式证据」的唯一载体：`false` 表示**旧版从未创建过这个 store**
 *    （迁移矩阵 §2.3 `R-11` 允许折算成 0 条的那一种情形）。缺省 `true`——
 *    「没说」不等于「没建过」，缺省必须是更保守的那一边。
 */
export interface LegacyStoreDeclaration {
  readonly name: string
  readonly created?: boolean
  /** 旧版该 store 的主键字段名。迁移矩阵里 `formData` 是 `tabId`、`meta` 是 `key`。 */
  readonly keyField?: string | null
  /** 迁移矩阵 §2.3 `R-08`：不完整扫描必须说出来。 */
  readonly note?: string
}

/** 一个旧版持久化位置的声明。 */
export interface LegacySourceDeclaration {
  readonly sourceId: string
  readonly kind: LegacySourceKind
  readonly label: string
  /** 旧库版本号（IndexedDB `version`）。`null` = 未知。 */
  readonly version?: number | null
  readonly bytes?: number | null
  readonly modifiedAt?: string | null
  readonly origin?: LegacyReadOrigin
  /**
   * `false` = 该来源按迁移矩阵**只登记不导入**（`.yfe` 同步文件 `M-21`、
   * 向量库 `M-17`、备份库 `M-11`）。这类来源仍然进清单与报告，
   * 但不会被读、也永远不会被当成"空"。
   */
  readonly readable?: boolean
  readonly stores?: readonly LegacyStoreDeclaration[]
  readonly note?: string
}

/**
 * 注入式只读读取器。
 *
 * 真实实现（IndexedDB / `fs` / sidecar）在测试里不出现，测试注入合成读取器；
 * 生产侧由上层把真实 IO 接进来。**本包不自己开文件**，这是「只读源」可被测试断言的前提。
 */
export interface LegacySourceReader {
  /** 该来源**实际存在**的 store 名。缺省 = 与声明一致。 */
  listStores?: () => Promise<readonly string[]> | readonly string[]
  /** 读一个 store 的全部记录。失败必须**抛**（见 `errors.ts`）。 */
  readRecords: (store: string) => Promise<readonly unknown[]> | readonly unknown[]
}

// ---------------------------------------------------------------------------
// 扫描结果
// ---------------------------------------------------------------------------

/** 一个 store 的读取结局。`rows === null` 是 `refused` 的判别式。 */
export type LegacyStoreStatus = 'ok' | 'absent' | 'refused' | 'listed-only'

export interface LegacyStoreScan {
  readonly name: string
  readonly status: LegacyStoreStatus
  /** `ok` 时是记录数；`absent` 时是 **0**（有证据）；`refused` 时是 **null**。 */
  readonly rows: number | null
  readonly keyField: string | null
  /** `absent` 的证据；`refused` 的原因。 */
  readonly reason: string | null
  readonly refusal: LegacyRefusal | null
  readonly note: string | null
  /** 仅 `status === 'ok'` 时非空。**不进报告**（报告只留统计，不留用户正文）。 */
  readonly records: readonly unknown[]
}

/** 一条读取失败的可排期描述。 */
export interface LegacyRefusal {
  /** `<sourceId>/<database>/<store>`；文件来源是相对路径。 */
  readonly location: string
  readonly kind: LegacyReadFailureKind
  readonly code: ErrorCode
  readonly message: string
  readonly origin: LegacyReadOrigin
}

export type LegacySourceStatus = 'readable' | 'partial' | 'refused' | 'listed-only'

export interface LegacySourceScan {
  readonly sourceId: string
  readonly kind: LegacySourceKind
  readonly label: string
  readonly origin: LegacyReadOrigin
  readonly version: number | null
  readonly bytes: number | null
  readonly modifiedAt: string | null
  readonly status: LegacySourceStatus
  readonly stores: readonly LegacyStoreScan[]
  /** 来源级备注（含 `R-08` 的「扫描不完整」自我披露）。 */
  readonly notes: readonly string[]
}

/** 一次清单扫描的全部产物。`records` 里的用户正文只活在这里，不进报告。 */
export interface LegacyCollection {
  readonly sources: readonly LegacySourceScan[]
  readonly refusals: readonly LegacyRefusal[]
  readonly notes: readonly string[]
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

const emptyStoreScan = (
  name: string,
  keyField: string | null,
  status: LegacyStoreStatus,
  rows: number | null,
  reason: string | null,
  note: string | null,
  refusal: LegacyRefusal | null = null,
): LegacyStoreScan => ({ name, status, rows, keyField, reason, refusal, note, records: [] })

function refusalOf(
  code: ErrorCode,
  kind: LegacyReadFailureKind,
  location: string,
  message: string,
  origin: LegacyReadOrigin,
): LegacyRefusal {
  return { location, kind, code, message, origin }
}

function fromThrown(
  thrown: unknown,
  location: string,
  origin: LegacyReadOrigin,
  requestId: RequestId,
): LegacyRefusal {
  const failure = classifyThrown(thrown, { location, origin, requestId })
  const reported = readFailureLocation(failure.error)
  const samePlace = reported === '' || reported === location
  return {
    // 🔴 位置以**扫描器自己知道的那个 store** 为准，而不是读取方报的位置：
    //    `counterKeyForRefusal` 靠位置的第 3 段分桶，读取方报的位置可能不带 store 名
    //    （例如只报了一个文件路径或一个嵌套字段），那样这条拒绝会掉进 `unreadable_unknown`，
    //    报告里「哪一类读不出来」就说不清了。读取方报的位置不丢，写进消息里。
    location,
    kind: classifyReadFailure(failure.error),
    code: failure.error.code,
    message: samePlace ? failure.error.message : `${failure.error.message}（读取方报告的位置：${reported}）`,
    origin: readFailureOrigin(failure.error),
  }
}

/**
 * 扫描一个旧版持久化位置。
 *
 * **只读**：本函数对输入只做 `listStores()` / `readRecords()` 调用，不提供任何写通道。
 *
 * 判定顺序（每一步的注释就是「为什么不能当空」的理由）：
 *
 * 1. 来源声明本身读不出来 → 整个来源 `refused`（`R-11`：`probeLegacy()` 的 `error`
 *    绝不能被读成「没有旧数据」）。
 * 2. `readable: false` → `listed-only`，一个 store 都不读。
 * 3. 逐个 store：
 *    - 声明 `created: false` 且实际不存在 / 读报 not-found → `absent`（**有证据**，记 0 条）；
 *    - 实际不存在但声明没说过 → `refused`（`store-missing`，**`rows: null`**）；
 *    - 读抛错 → 除上一条的例外外一律 `refused`；
 *    - 读到非数组 → `refused`（`decode-failed`）；
 *    - 读到数组（含空数组）→ `ok`，`rows = length`。
 * 4. 来源状态：有 `ok` 且有 `refused` → `partial`；有 `ok` 无 `refused` → `readable`；
 *    没有 `ok` 且至少一个 `refused` → `refused`；全是 `absent` → `readable`
 *    （它确实被完整读过了：结果是"有证据地不存在"）。
 */
export async function scanLegacySource(
  declaration: LegacySourceDeclaration,
  reader: LegacySourceReader | undefined,
  requestId: RequestId,
): Promise<LegacySourceScan> {
  const origin: LegacyReadOrigin = declaration.origin ?? 'local'
  const base = {
    sourceId: declaration.sourceId,
    kind: declaration.kind,
    label: declaration.label,
    origin,
    version: declaration.version ?? null,
    bytes: declaration.bytes ?? null,
    modifiedAt: declaration.modifiedAt ?? null,
  }

  const declaredStores = declaration.stores ?? []
  const notes: string[] = []
  if (declaration.note !== undefined) notes.push(declaration.note)

  if (declaration.readable === false) {
    return {
      ...base,
      status: 'listed-only',
      stores: declaredStores.map((store) =>
        emptyStoreScan(
          store.name,
          store.keyField ?? null,
          'listed-only',
          null,
          '按迁移矩阵只登记不导入，本包不读取其内容',
          store.note ?? null,
        ),
      ),
      notes: [...notes, '该来源按迁移矩阵仅登记，不参与导入；其存在本身已被记录。'],
    }
  }

  if (reader === undefined) {
    // 声明了可读却没给读取器 = 我们读不出来。这是 refused，不是 empty。
    const location = `${declaration.sourceId}/*`
    const refusal = refusalOf(
      'STORAGE_UNAVAILABLE',
      'unknown',
      location,
      '该来源声明为可读，但未提供读取器；无法读取不等于没有数据。',
      origin,
    )
    return {
      ...base,
      status: 'refused',
      stores: declaredStores.map((store) =>
        emptyStoreScan(store.name, store.keyField ?? null, 'refused', null, refusal.message, store.note ?? null, refusal),
      ),
      notes: [...notes, refusal.message],
    }
  }

  // 1. 实际存在的 store 列表。列不出来 = 来源级 refused。
  let actualStores: readonly string[] | null = null
  if (reader.listStores !== undefined) {
    try {
      const listed = await reader.listStores()
      if (!Array.isArray(listed)) {
        throw new Error('listStores() 未返回数组')
      }
      actualStores = listed
    } catch (thrown) {
      const refusal = fromThrown(thrown, `${declaration.sourceId}/*`, origin, requestId)
      return {
        ...base,
        status: 'refused',
        stores: declaredStores.map((store) =>
          emptyStoreScan(store.name, store.keyField ?? null, 'refused', null, refusal.message, store.note ?? null, refusal),
        ),
        notes: [...notes, refusal.message],
      }
    }
  }

  const scans: LegacyStoreScan[] = []
  for (const store of declaredStores) {
    const keyField = store.keyField ?? null
    const created = store.created !== false
    const location = `${declaration.sourceId}/${declaration.kind === 'indexeddb' ? 'main' : declaration.kind}/${store.name}`

    if (actualStores !== null && !actualStores.includes(store.name)) {
      if (!created) {
        scans.push(
          emptyStoreScan(
            store.name,
            keyField,
            'absent',
            0,
            '清单显式声明该 store 从未创建，且实际不存在',
            store.note ?? null,
          ),
        )
        continue
      }
      const refusal = refusalOf(
        'NOT_FOUND',
        'store-missing',
        location,
        `旧库声明存在 store「${store.name}」，但实际未能列出它；缺少不代表为空。`,
        origin,
      )
      scans.push(emptyStoreScan(store.name, keyField, 'refused', null, refusal.message, store.note ?? null, refusal))
      continue
    }

    let records: readonly unknown[]
    try {
      records = await reader.readRecords(store.name)
    } catch (thrown) {
      const refusal = fromThrown(thrown, location, origin, requestId)
      const kind = refusal.kind
      if (!created && (kind === 'not-found' || kind === 'store-missing')) {
        scans.push(
          emptyStoreScan(store.name, keyField, 'absent', 0, '清单显式声明该 store 从未创建', store.note ?? null),
        )
        continue
      }
      scans.push(emptyStoreScan(store.name, keyField, 'refused', null, refusal.message, store.note ?? null, refusal))
      continue
    }

    if (!Array.isArray(records)) {
      const refusal = refusalOf(
        'STORAGE_CORRUPT',
        'decode-failed',
        location,
        `store「${store.name}」读到的内容不是记录数组（得到 ${typeof records}）；无法判定其条数。`,
        origin,
      )
      scans.push(emptyStoreScan(store.name, keyField, 'refused', null, refusal.message, store.note ?? null, refusal))
      continue
    }

    scans.push({
      name: store.name,
      status: 'ok',
      rows: records.length,
      keyField,
      reason: null,
      refusal: null,
      note: store.note ?? null,
      records,
    })
  }

  const anyOk = scans.some((scan) => scan.status === 'ok')
  const anyRefused = scans.some((scan) => scan.status === 'refused')
  const status: LegacySourceStatus = anyRefused ? (anyOk ? 'partial' : 'refused') : 'readable'
  if (anyRefused) {
    notes.push('该来源未能完整读取：清单与报告只反映已读到的部分，未读到的部分绝不算作空。')
  }

  return { ...base, status, stores: scans, notes }
}

/** 扫描一组来源，汇总成 {@link LegacyCollection}。 */
export async function scanLegacySources(
  inputs: readonly { readonly declaration: LegacySourceDeclaration; readonly reader?: LegacySourceReader }[],
  requestId: RequestId,
): Promise<LegacyCollection> {
  const sources: LegacySourceScan[] = []
  const refusals: LegacyRefusal[] = []
  const notes: string[] = []
  for (const input of inputs) {
    const scan = await scanLegacySource(input.declaration, input.reader, requestId)
    sources.push(scan)
    for (const store of scan.stores) {
      if (store.refusal !== null) refusals.push(store.refusal)
    }
    notes.push(...scan.notes)
  }
  return { sources, refusals, notes: dedupe(notes) }
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

/**
 * 由清单推出「可读来源的 store 数据」。**只对 `ok` 的 store 产出数据**，
 * `absent` 产出空数组（有证据），`refused` **不产出任何条目**——
 * 这样下游映射根本拿不到"看起来是空"的东西，从结构上堵死折算成 0 条。
 */
export function readableStoreData(
  collection: LegacyCollection,
): readonly {
  readonly sourceId: string
  readonly database: string
  readonly store: string
  readonly origin: LegacyReadOrigin
  readonly records: readonly unknown[]
}[] {
  const out: {
    sourceId: string
    database: string
    store: string
    origin: LegacyReadOrigin
    records: readonly unknown[]
  }[] = []
  for (const source of collection.sources) {
    for (const store of source.stores) {
      if (store.status !== 'ok' && store.status !== 'absent') continue
      out.push({
        sourceId: source.sourceId,
        database: source.kind === 'indexeddb' ? 'main' : source.kind,
        store: store.name,
        origin: source.origin,
        records: store.records,
      })
    }
  }
  return out
}

/** 一处读取失败 → 一条 `Err`。给「清单本身读不出来」的调用方用。 */
export function refusalAsErr(refusal: LegacyRefusal, requestId: RequestId) {
  return legacyReadFailure(
    { kind: refusal.kind, message: refusal.message, location: refusal.location, origin: refusal.origin },
    requestId,
  )
}

/** 暴露给报告：读取失败形态 → 契约码的纯映射（不在本模块重复定义）。 */
export { errorCodeOfReadFailure }
