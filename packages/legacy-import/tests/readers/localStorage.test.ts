import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure, readableStoreData } from '../../src/inventory.js'
import type { LegacySourceDeclaration } from '../../src/inventory.js'
import { createLocalStorageDumpReader } from '../../src/readers/index.js'
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

/** 真实键名来自迁移矩阵 M-22（`theme.ts:45-48`、`netPrefs.ts:27`、`desktopCloudSync.ts:52-61` 等）。 */
const DUMP = {
  'yfe-theme': 'dark',
  'yfe-ui:sidebar': '{"open":true,"width":320}',
  'yfe-sync-webdav': '{"baseUrl":"https://dav.example.com","username":"甲","password":"p@ss"}',
  'yfe-colw::tab-main': '48,32,20',
}

function declaration(overrides: Partial<LegacySourceDeclaration> = {}): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-ls',
    kind: 'localstorage',
    label: '浏览器 localStorage 转储',
    origin: 'local',
    stores: [{ name: 'localStorage', keyField: 'key' }],
    ...overrides,
  }
}

describe('createLocalStorageDumpReader', () => {
  it('裸键值转储 → 归一成 {key,value}，按 localStorage 键排序，值原样（不预先 JSON.parse）', () => {
    const file = writeJsonFile(`${tmp('ls')}/localStorage.json`, DUMP)
    const reader = createLocalStorageDumpReader({ file })
    expect(reader.listStores?.()).toEqual(['localStorage'])

    const records = reader.readRecords('localStorage') as readonly Record<string, unknown>[]
    expect(records.map((record) => record['key'])).toEqual([
      'yfe-colw::tab-main',
      'yfe-sync-webdav',
      'yfe-theme',
      'yfe-ui:sidebar',
    ])
    // 值与未知字段一律原样：JSON 字符串仍是字符串（解析是 mapping.ts:1429-1465 的事）
    expect(records[1]).toEqual({
      key: 'yfe-sync-webdav',
      value: '{"baseUrl":"https://dav.example.com","username":"甲","password":"p@ss"}',
    })
    expect(records[2]).toEqual({ key: 'yfe-theme', value: 'dark' })
  })

  it('带 localStorage 层的两种包裹都认（键值对象 / 记录数组）', () => {
    const dir = tmp('ls')
    const bare = writeJsonFile(`${dir}/a.json`, { localStorage: { 'yfe-theme': 'light' } })
    expect(createLocalStorageDumpReader({ file: bare }).readRecords('localStorage')).toEqual([
      { key: 'yfe-theme', value: 'light' },
    ])

    const arrayShape = writeJsonFile(`${dir}/b.json`, {
      stores: { localStorage: [{ key: 'yfe-theme', value: 'light' }, { key: 'z', value: 1 }] },
    })
    expect(createLocalStorageDumpReader({ file: arrayShape }).readRecords('localStorage')).toEqual([
      { key: 'yfe-theme', value: 'light' },
      { key: 'z', value: 1 },
    ])
  })

  it('顶层就是记录数组也认', () => {
    const file = writeJsonFile(`${tmp('ls')}/array.json`, [{ key: 'yfe-theme', value: 'dark' }])
    expect(createLocalStorageDumpReader({ file }).readRecords('localStorage')).toEqual([
      { key: 'yfe-theme', value: 'dark' },
    ])
  })

  it('文件不存在 → not-found（码 NOT_FOUND，消息里不放绝对路径）', () => {
    const reader = createLocalStorageDumpReader({ file: `${tmp('ls')}/nope.json` })
    const error = catchReadError(() => reader.listStores?.())
    expect(error.kind).toBe('not-found')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')
    expect(error.message).not.toMatch(/[A-Za-z]:\\/)
  })

  it('非法 / 截断 JSON → decode-failed（不是 0 条）', () => {
    const dir = tmp('ls')
    const broken = writeJsonFile(`${dir}/broken.json`, { 'yfe-theme': 'dark' })
    writeRawFile(broken, '{"yfe-theme": "dark",')
    expect(catchReadError(() => createLocalStorageDumpReader({ file: broken }).listStores?.()).kind).toBe(
      'decode-failed',
    )
    const zero = writeRawFile(`${dir}/zero.json`, '')
    expect(catchReadError(() => createLocalStorageDumpReader({ file: zero }).listStores?.()).kind).toBe(
      'decode-failed',
    )
  })

  it('存在但为空（{} / 空 localStorage 层）→ ok + 0 条', async () => {
    const dir = tmp('ls')
    for (const [name, value] of [
      ['empty-object.json', {}],
      ['empty-layer.json', { localStorage: {} }],
    ] as const) {
      const file = writeJsonFile(`${dir}/${name}`, value)
      const collection = await scan(declaration(), createLocalStorageDumpReader({ file }))
      const store = storeScanOf(collection, 'localStorage')
      expect(store.status).toBe('ok')
      expect(store.rows).toBe(0)
      expect(store.refusal).toBeNull()
    }
  })

  it('便携整库文件里没有 localStorage → refused（不是 ok+0）', async () => {
    const file = writeJsonFile(`${tmp('ls')}/portable.json`, {
      kind: 'portable-data',
      app: 'youth-fantasy-engine',
      stores: { projects: { p1: { id: 'p1' } } },
    })
    const reader = createLocalStorageDumpReader({ file })
    expect(reader.listStores?.()).toEqual([])
    expect(catchReadError(() => reader.readRecords('localStorage')).kind).toBe('store-missing')
    const collection = await scan(declaration(), reader)
    const store = storeScanOf(collection, 'localStorage')
    expect(store.status).toBe('refused')
    expect(store.rows).toBeNull()
    expect(store.refusal?.code).toBe('NOT_FOUND')
  })

  it('顶层是标量 → decode-failed；请求别的 store → store-missing', () => {
    const dir = tmp('ls')
    const scalar = writeJsonFile(`${dir}/scalar.json`, ['nope'])
    expect(createLocalStorageDumpReader({ file: scalar }).readRecords('localStorage')).toEqual(['nope'])

    const text = writeRawFile(`${dir}/text.json`, '"just a string"')
    expect(catchReadError(() => createLocalStorageDumpReader({ file: text }).listStores?.()).kind).toBe(
      'decode-failed',
    )

    const dump = writeJsonFile(`${dir}/dump.json`, DUMP)
    expect(catchReadError(() => createLocalStorageDumpReader({ file: dump }).readRecords('settingsKV')).kind).toBe(
      'store-missing',
    )
  })

  it('确定性：两次读取逐字段相同', () => {
    const file = writeJsonFile(`${tmp('ls')}/twice.json`, DUMP)
    expect(createLocalStorageDumpReader({ file }).readRecords('localStorage')).toEqual(
      createLocalStorageDumpReader({ file }).readRecords('localStorage'),
    )
  })

  it('只读：目录快照不变', () => {
    const dir = tmp('ls')
    const file = writeJsonFile(`${dir}/dump.json`, DUMP)
    const before = snapshotTree(dir)
    const reader = createLocalStorageDumpReader({ file })
    reader.listStores?.()
    reader.readRecords('localStorage')
    expect(snapshotTree(dir)).toEqual(before)
  })

  it('扫描 + readableStoreData：database 记为 localstorage', async () => {
    const file = writeJsonFile(`${tmp('ls')}/dump.json`, DUMP)
    const collection = await scan(declaration(), createLocalStorageDumpReader({ file }))
    expect(storeScanOf(collection, 'localStorage').status).toBe('ok')
    expect(storeScanOf(collection, 'localStorage').rows).toBe(4)
    const rows = readableStoreData(collection)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.database).toBe('localstorage')
    expect(rows[0]?.origin).toBe('local')
    expect((rows[0]?.records[2] as Record<string, unknown>)['key']).toBe('yfe-theme')
  })
})
