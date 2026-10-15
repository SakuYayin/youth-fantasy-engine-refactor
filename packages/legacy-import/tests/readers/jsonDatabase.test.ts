import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure, readableStoreData } from '../../src/inventory.js'
import type { LegacySourceDeclaration, LegacyStoreDeclaration } from '../../src/inventory.js'
import { createJsonDatabaseReader } from '../../src/readers/index.js'
import { scan, storeScanOf } from '../helpers.js'
import {
  catchReadError,
  makeTmpDir,
  removeTmpDir,
  snapshotTree,
  writeJsonFile,
  writeRawFile,
} from './_support.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix)
  dirs.push(dir)
  return dir
}
afterEach(() => {
  let dir = dirs.pop()
  while (dir !== undefined) {
    removeTmpDir(dir)
    dir = dirs.pop()
  }
})

/** 上游 `storeOps.ts:35-42` 的真实便携形态：`stores` 是「store → {主键 → 记录}」。 */
const PORTABLE = {
  app: 'youth-fantasy-engine',
  kind: 'portable-data',
  fileVersion: 2,
  savedAt: 1_760_000_000_000,
  stores: {
    chapters: {
      c2: { id: 'c2', title: '第二章 🌙', body: '中文正文\n第二行\t制表符' },
      c1: { id: 'c1', title: '第一章', unknownField: { deep: [1, 2, 3], emoji: '🎴' } },
    },
    formData: { 'p1::tab-main': { tabId: 'tab-main', data: { rows: [], note: '未裁剪字段' } } },
  },
}

function declaration(
  stores: readonly LegacyStoreDeclaration[],
  overrides: Partial<LegacySourceDeclaration> = {},
): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-main',
    kind: 'json-file',
    label: '便携整库导出',
    origin: 'local',
    stores,
    ...overrides,
  }
}

describe('createJsonDatabaseReader', () => {
  it('读便携整库：listStores 排序、记录原样、主键稳定排序', () => {
    const file = writeJsonFile(`${tmp('json')}/youth-fantasy-engine-data.json`, PORTABLE)
    const reader = createJsonDatabaseReader({ file })

    expect(reader.listStores?.()).toEqual(['chapters', 'formData'])

    const chapters = reader.readRecords('chapters') as readonly Record<string, unknown>[]
    expect(chapters.map((record) => record['id'])).toEqual(['c1', 'c2'])
    expect(chapters[0]).toEqual({
      id: 'c1',
      title: '第一章',
      unknownField: { deep: [1, 2, 3], emoji: '🎴' },
    })
    expect(chapters[1]).toEqual({ id: 'c2', title: '第二章 🌙', body: '中文正文\n第二行\t制表符' })

    // 复合键 `p1::tab-main` 是**容器**的键；记录本身原样返回（`tabs.ts:7-14` 的行形）
    expect(reader.readRecords('formData')).toEqual([
      { tabId: 'tab-main', data: { rows: [], note: '未裁剪字段' } },
    ])
  })

  it('记录容器是数组时按源文件顺序原样返回（不排序）', () => {
    const file = writeJsonFile(`${tmp('json')}/dump.json`, {
      projects: [
        { id: 'zzz', title: '后写的' },
        { id: 'aaa', title: '先写的' },
      ],
    })
    const reader = createJsonDatabaseReader({ file })
    expect(reader.listStores?.()).toEqual(['projects'])
    const records = reader.readRecords('projects') as readonly Record<string, unknown>[]
    expect(records.map((record) => record['id'])).toEqual(['zzz', 'aaa'])
  })

  it('接受 {stores:{…}} 包裹（值也可以是数组）', () => {
    const file = writeJsonFile(`${tmp('json')}/wrapped.json`, {
      stores: { worlds: [{ id: 'w1', name: '雾海世界' }], meta: { 'k1': { key: 'k1', value: 42 } } },
    })
    const reader = createJsonDatabaseReader({ file })
    expect(reader.listStores?.()).toEqual(['meta', 'worlds'])
    expect(reader.readRecords('worlds')).toEqual([{ id: 'w1', name: '雾海世界' }])
    expect(reader.readRecords('meta')).toEqual([{ key: 'k1', value: 42 }])
  })

  it('兼容 UTF-8 BOM（记事本另存过也不会整份失败）', () => {
    const dir = tmp('json')
    const file = writeRawFile(`${dir}/bom.json`, `\uFEFF${JSON.stringify({ stores: { meta: [] } })}`)
    const reader = createJsonDatabaseReader({ file })
    expect(reader.listStores?.()).toEqual(['meta'])
    expect(reader.readRecords('meta')).toEqual([])
  })

  it('文件不存在 → listStores 抛 not-found（来源级 refused，码 NOT_FOUND）', () => {
    const reader = createJsonDatabaseReader({ file: `${tmp('json')}/missing.json` })
    const error = catchReadError(() => reader.listStores?.())
    expect(error.kind).toBe('not-found')
    expect(error.origin).toBe('local')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')
    expect(error.message).not.toMatch(/[A-Za-z]:\\/) // R-03：不放绝对路径
  })

  it('非法 JSON → decode-failed（refused，码 STORAGE_CORRUPT），不是 0 条', () => {
    const file = writeRawFile(`${tmp('json')}/broken.json`, '{"stores": {"meta": [1, 2, ')
    const reader = createJsonDatabaseReader({ file })
    const error = catchReadError(() => reader.listStores?.())
    expect(error.kind).toBe('decode-failed')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('STORAGE_CORRUPT')
  })

  it('0 字节文件 → decode-failed（「空文件」不是「空库」）', () => {
    const file = writeRawFile(`${tmp('json')}/empty.json`, '')
    const reader = createJsonDatabaseReader({ file })
    const error = catchReadError(() => reader.listStores?.())
    expect(error.kind).toBe('decode-failed')
  })

  it('记录容器是标量 → decode-failed（不是 0 条）', () => {
    const file = writeJsonFile(`${tmp('json')}/scalar.json`, { stores: { meta: 'oops' } })
    const reader = createJsonDatabaseReader({ file })
    const error = catchReadError(() => reader.readRecords('meta'))
    expect(error.kind).toBe('decode-failed')
  })

  it('readRecords 遇到不在文件里的 store → store-missing', () => {
    const file = writeJsonFile(`${tmp('json')}/partial.json`, { stores: { meta: [] } })
    const reader = createJsonDatabaseReader({ file })
    const error = catchReadError(() => reader.readRecords('projects'))
    expect(error.kind).toBe('store-missing')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')
  })

  it('requirePortableData 会拒绝非整库文件', () => {
    const file = writeJsonFile(`${tmp('json')}/plain.json`, { projects: [] })
    const strict = createJsonDatabaseReader({ file, requirePortableData: true })
    expect(catchReadError(() => strict.listStores?.()).kind).toBe('decode-failed')

    const loose = createJsonDatabaseReader({ file })
    expect(loose.listStores?.()).toEqual(['projects'])

    const portable = writeJsonFile(`${tmp('json')}/portable.json`, PORTABLE)
    const ok = createJsonDatabaseReader({ file: portable, requirePortableData: true })
    expect(ok.listStores?.()).toEqual(['chapters', 'formData'])

    const alien = writeJsonFile(`${tmp('json')}/alien.json`, {
      kind: 'portable-data',
      app: 'someone-else',
      stores: { projects: [] },
    })
    expect(
      catchReadError(() => createJsonDatabaseReader({ file: alien, requirePortableData: true }).listStores?.()).kind,
    ).toBe('decode-failed')
  })

  it('确定性：两次读取逐字段相同', () => {
    const file = writeJsonFile(`${tmp('json')}/twice.json`, PORTABLE)
    const first = createJsonDatabaseReader({ file })
    const second = createJsonDatabaseReader({ file })
    expect(second.listStores?.()).toEqual(first.listStores?.())
    expect(second.readRecords('chapters')).toEqual(first.readRecords('chapters'))
  })

  it('只读：调用前后目录快照（清单 + 大小 + mtime）完全不变', () => {
    const dir = tmp('json')
    const file = writeJsonFile(`${dir}/readonly.json`, PORTABLE)
    writeJsonFile(`${dir}/sibling.json`, { stores: {} })
    const before = snapshotTree(dir)
    const reader = createJsonDatabaseReader({ file })
    reader.listStores?.()
    reader.readRecords('chapters')
    catchReadError(() => reader.readRecords('nope'))
    expect(snapshotTree(dir)).toEqual(before)
  })

  // -------------------------------------------------------------------------
  // 与 scanLegacySource / readableStoreData 联调
  // -------------------------------------------------------------------------

  it('扫描：存在但空 → ok + 0 条（不是 refused）', async () => {
    const file = writeJsonFile(`${tmp('json')}/empty-store.json`, { stores: { projects: [] } })
    const collection = await scan(
      declaration([{ name: 'projects', keyField: 'id' }]),
      createJsonDatabaseReader({ file }),
    )
    const store = storeScanOf(collection, 'projects')
    expect(store.status).toBe('ok')
    expect(store.rows).toBe(0)
    expect(store.refusal).toBeNull()
  })

  it('扫描：0 字节文件 → 来源 refused，且 readableStoreData 一条都不产出', async () => {
    const file = writeRawFile(`${tmp('json')}/zero.json`, ' ')
    const collection = await scan(
      declaration([{ name: 'projects', keyField: 'id' }]),
      createJsonDatabaseReader({ file }),
    )
    const store = storeScanOf(collection, 'projects')
    expect(store.status).toBe('refused')
    expect(store.rows).toBeNull()
    expect(store.refusal?.kind).toBe('decode-failed')
    expect(store.refusal?.code).toBe('STORAGE_CORRUPT')
    expect(readableStoreData(collection)).toEqual([])
  })

  it('扫描：声明 created:false 且实际缺失 → absent；没声明过 → refused', async () => {
    const file = writeJsonFile(`${tmp('json')}/missing-store.json`, { stores: { meta: [] } })
    const collection = await scan(
      declaration([
        { name: 'chapters', created: false, keyField: 'id' },
        { name: 'worlds', keyField: 'id' },
      ]),
      createJsonDatabaseReader({ file }),
    )
    const absent = storeScanOf(collection, 'chapters')
    expect(absent.status).toBe('absent')
    expect(absent.rows).toBe(0)
    const refused = storeScanOf(collection, 'worlds')
    expect(refused.status).toBe('refused')
    expect(refused.rows).toBeNull()
    expect(refused.refusal?.code).toBe('NOT_FOUND')
  })

  it('扫描 + readableStoreData：ok 的 store 原样带出记录，refused 的绝不出现', async () => {
    const dir = tmp('json')
    const good = writeJsonFile(`${dir}/good.json`, {
      stores: {
        projects: { p1: { id: 'p1', title: '星海 🌟' } },
        chapters: 'not-a-container',
      },
    })
    const collection = await scan(
      declaration(
        [
          { name: 'projects', keyField: 'id' },
          { name: 'chapters', keyField: 'id' },
        ],
        { sourceId: 'legacy-portable' },
      ),
      createJsonDatabaseReader({ file: good }),
    )
    const rows = readableStoreData(collection)
    expect(rows.map((entry) => `${entry.sourceId}/${entry.database}/${entry.store}`)).toEqual([
      'legacy-portable/json-file/projects',
    ])
    expect(rows[0]?.records).toEqual([{ id: 'p1', title: '星海 🌟' }])
    expect(storeScanOf(collection, 'chapters').status).toBe('refused')
  })
})
