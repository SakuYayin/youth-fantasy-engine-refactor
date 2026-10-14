/**
 * 测试基础设施。
 *
 * 两条纪律（与 `packages/persistence-sqlite/tests/repositories/helpers.ts` 一致）：
 *
 * 1. **不用 `os.tmpdir()`**：本机 `tmpdir` 不可写（EPERM）。数据库一律用**内存库**，
 *    每个测试自己开关——这样连临时目录都不需要。
 * 2. **内存库串行开关**：`openDatabase` 按路径去重独占写连接，所以同一个测试文件里
 *    绝不能同时开两个库。{@link withDb} / {@link withDbAsync} 负责成对开关。
 *
 * 夹具全部是**自造的合成数据**（见 `fixtures.ts`），不含任何真实用户数据。
 */

import { newIds, type RequestId } from '@yfe/contracts'
import { closeDatabase, migrate, openMemoryDatabase, type SqliteDatabase } from '@yfe/persistence-sqlite'

import type {
  LegacyCollection,
  LegacySourceDeclaration,
  LegacySourceReader,
  LegacyStoreDeclaration,
} from '../src/inventory.js'
import { scanLegacySources } from '../src/inventory.js'

/** 打开一个已迁移到最新结构的内存库。 */
export function openMigratedDb(): SqliteDatabase {
  const db = openMemoryDatabase()
  migrate(db, { backupDir: null })
  return db
}

export function withDb<T>(body: (db: SqliteDatabase) => T): T {
  const db = openMigratedDb()
  try {
    return body(db)
  } finally {
    closeDatabase(db)
  }
}

export async function withDbAsync<T>(body: (db: SqliteDatabase) => Promise<T>): Promise<T> {
  const db = openMigratedDb()
  try {
    return await body(db)
  } finally {
    closeDatabase(db)
  }
}

/** 每个测试一个请求 ID，但格式确定，便于断言。 */
export function requestId(n: number): RequestId {
  return `req_legacy_test_${String(n).padStart(6, '0')}` as RequestId
}

export const TEST_NOW = '2026-02-01T00:00:00.000Z'

export function nextRequestId(): RequestId {
  return newIds.request()
}

export function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown } | undefined
  return typeof row?.n === 'number' ? row.n : 0
}

/** 表名 → 行数快照，用于「dry-run 一行都不写」的断言。 */
export function rowCounts(db: SqliteDatabase, tables: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const table of tables) out[table] = countRows(db, table)
  return out
}

// ---------------------------------------------------------------------------
// 合成读取器
// ---------------------------------------------------------------------------

export type StoreBehavior =
  | { readonly kind: 'records'; readonly records: readonly unknown[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'throw'; readonly error: unknown }

export function records(value: readonly unknown[]): StoreBehavior {
  return { kind: 'records', records: value }
}

export const ABSENT: StoreBehavior = { kind: 'absent' }

export function throws(error: unknown): StoreBehavior {
  return { kind: 'throw', error }
}

/**
 * 合成读取器。
 *
 * `listStores` 返回**确实存在**的 store 名（`absent` 行为的不在其中）；
 * `readRecords` 按行为返回、抛错、或用 `LegacyReadError` 表示「读不出来」。
 */
export function makeReader(behaviors: Readonly<Record<string, StoreBehavior>>): LegacySourceReader {
  return {
    listStores: () => Object.entries(behaviors)
      .filter(([, behavior]) => behavior.kind !== 'absent')
      .map(([name]) => name),
    readRecords: (store: string) => {
      const behavior = behaviors[store]
      if (behavior === undefined) {
        throw new Error(`合成读取器没有为 store「${store}」定义行为`)
      }
      switch (behavior.kind) {
        case 'records':
          return behavior.records
        case 'absent':
          throw Object.assign(new Error(`store「${store}」不存在`), { name: 'NotFoundError' })
        case 'throw':
          throw behavior.error
      }
    },
  }
}

/** 只读契约：任何写入源目录的尝试都会在这里留下痕迹。 */
export interface WriteProbe {
  readonly writes: string[]
}

export function assertNoWrites(probe: WriteProbe): void {
  if (probe.writes.length > 0) {
    throw new Error(`只读源被违反：发生了写入 ${probe.writes.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// 声明
// ---------------------------------------------------------------------------

export const MAIN_STORES: readonly LegacyStoreDeclaration[] = [
  { name: 'projects', keyField: 'id' },
  { name: 'volumes', keyField: 'id' },
  { name: 'chapters', keyField: 'id' },
  { name: 'formData', keyField: 'tabId' },
  { name: 'tableRows', keyField: 'id' },
  { name: 'cardRecords', keyField: 'id' },
  { name: 'meta', keyField: 'key' },
  { name: 'snapshots', keyField: 'id' },
  { name: 'dailyStats', keyField: 'key' },
  { name: 'settingsKV', keyField: 'key' },
  { name: 'trash', keyField: 'id' },
  { name: 'backups', keyField: 'id' },
  { name: 'backupPayloads', keyField: 'id' },
  { name: 'tavernReports', keyField: 'id' },
  { name: 'aiRuns', keyField: 'id' },
  { name: 'worlds', keyField: 'id' },
]

export function mainDeclaration(overrides: Partial<LegacySourceDeclaration> = {}): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-main',
    kind: 'indexeddb',
    label: '合成旧版主库',
    version: 13,
    origin: 'local',
    stores: MAIN_STORES,
    ...overrides,
  }
}

export async function scan(
  declaration: LegacySourceDeclaration,
  reader: LegacySourceReader | undefined,
  id = requestId(1),
): Promise<LegacyCollection> {
  return scanLegacySources([{ declaration, ...(reader === undefined ? {} : { reader }) }], id)
}

/** 取某个 store 的扫描结果；不存在就抛（而不是返回 undefined 让断言静默失败）。 */
export function storeScanOf(collection: LegacyCollection, name: string) {
  for (const source of collection.sources) {
    for (const store of source.stores) {
      if (store.name === name) return store
    }
  }
  throw new Error(`合成夹具里没有 store「${name}」`)
}
