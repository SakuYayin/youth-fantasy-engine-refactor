import { afterEach, describe, expect, it } from 'vitest'

import { readableStoreData, scanLegacySources } from '../../src/inventory.js'
import type {
  LegacyCollection,
  LegacySourceDeclaration,
  LegacyStoreDeclaration,
} from '../../src/inventory.js'
import {
  createJsonDatabaseReader,
  createKnowledgeBaseReader,
  createLocalStorageDumpReader,
  createSidecarDirectoryReader,
  createSyncFileReader,
  DEFAULT_CLOUD_KEY,
  LEGACY_MAIN_STORE_KEY_FIELDS,
  SIDECAR_WHOLE_KEY,
} from '../../src/readers/index.js'
import { requestId } from '../helpers.js'
import {
  makeTmpDir,
  removeTmpDir,
  sealAesPayload,
  snapshotTree,
  writeJsonFile,
  writeRawFile,
  writeSyncFile,
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

/** 用真实主键表拼一份主库 store 声明（顺带验证 `LEGACY_MAIN_STORE_KEY_FIELDS` 的键名是真的）。 */
function mainStores(names: readonly string[]): readonly LegacyStoreDeclaration[] {
  return names.map((name) => ({ name, keyField: LEGACY_MAIN_STORE_KEY_FIELDS[name] ?? 'id' }))
}

/** 按 (sourceId, store) 精确取扫描结果（有的 store 名在多个来源里都有，不能按名字碰运气）。 */
function storeOf(collection: LegacyCollection, sourceId: string, name: string) {
  const store = collection.sources
    .find((source) => source.sourceId === sourceId)
    ?.stores.find((candidate) => candidate.name === name)
  if (store === undefined) throw new Error(`扫描结果里没有 ${sourceId}/${name}`)
  return store
}

describe('真实读取器 + scanLegacySources + readableStoreData 端到端', () => {
  it('六种真实来源一起扫：状态、条数、错误码、refused 绝不产出可读数据', async () => {
    const dir = tmp('e2e')
    // ① 便携整库 JSON（PortableData v2：stores 是「store → {主键 → 记录}」）
    const portable = writeJsonFile(`${dir}/youth-fantasy-engine-data.json`, {
      app: 'youth-fantasy-engine',
      kind: 'portable-data',
      fileVersion: 2,
      savedAt: 1_760_000_000_000,
      stores: {
        projects: { p1: { id: 'p1', title: '星海 🌟', unknown: { keep: true } } },
        formData: { 'p1::tab-main': { tabId: 'tab-main', data: { rows: [], 中文: '中文正文' } } },
        worlds: [{ id: 'w1', name: '雾海 🌊', tables: [] }],
      },
    })
    // ② localStorage 转储
    const lsDump = writeJsonFile(`${dir}/localStorage.json`, {
      'yfe-theme': 'dark',
      'yfe-sync-tombstones': '{"chapters":{"c9":1760000000000}}',
    })
    // ③ 桌面/便携 blobs 外置存储
    const blobs = `${dir}/blobs`
    writeJsonFile(`${blobs}/backupPayloads/u1.json`, { id: 'u1', payload: { 中文: '备份 🎴' } })
    writeJsonFile(`${blobs}/vecRows/${SIDECAR_WHOLE_KEY}.json`, [
      { id: 'p1::chapter::c1::0', projectId: 'p1', kind: 'chapter', text: '向量', vecB64: 'AAECAw==' },
    ])
    // ④ 知识库导出（docs + bodies）
    const kbDocs = writeJsonFile(`${dir}/kb-docs.json`, [
      { id: 'd1', projectId: 'p1', title: '设定集 🌟', sourceType: 'md', enabled: true },
    ])
    const kbBodies = writeJsonFile(`${dir}/kb-bodies.json`, [{ id: 'd1', text: '正文 🎴' }])
    // ⑤ .yfe 同步文件（M-21：只识别不导入）
    const yfe = writeSyncFile(
      `${dir}/青春幻想引擎-同步数据.yfe`,
      7,
      sealAesPayload({ projects: [{ id: 'p1' }] }, DEFAULT_CLOUD_KEY),
    )
    // ⑥ 坏源：截断的 JSON
    const broken = writeRawFile(`${dir}/broken.json`, '{"projects": [{"id": "p1"}')

    const declarations: readonly { declaration: LegacySourceDeclaration; reader: ReturnType<typeof createJsonDatabaseReader> }[] = [
      {
        declaration: {
          sourceId: 'portable',
          kind: 'json-file',
          label: '便携整库',
          origin: 'local',
          stores: mainStores(['projects', 'formData', 'worlds', 'chapters']),
        },
        reader: createJsonDatabaseReader({ file: portable }),
      },
      {
        declaration: {
          sourceId: 'ls',
          kind: 'localstorage',
          label: 'localStorage 转储',
          origin: 'local',
          stores: [{ name: 'localStorage', keyField: 'key' }],
        },
        reader: createLocalStorageDumpReader({ file: lsDump }),
      },
      {
        declaration: {
          sourceId: 'blobs',
          kind: 'sidecar',
          label: 'blobs 外置存储',
          origin: 'local',
          stores: [
            { name: 'backupPayloads', keyField: 'id' },
            { name: 'vecRows', keyField: 'id' },
            { name: 'kbDocs', keyField: 'id', created: false },
          ],
        },
        reader: createSidecarDirectoryReader({ dir: blobs }),
      },
      {
        declaration: {
          sourceId: 'kb',
          kind: 'json-file',
          label: '知识库导出',
          origin: 'local',
          stores: [
            { name: 'docs', keyField: 'id' },
            { name: 'bodies', keyField: 'id' },
          ],
        },
        reader: createKnowledgeBaseReader({ docsFile: kbDocs, bodiesFile: kbBodies }),
      },
      {
        declaration: {
          sourceId: 'sync',
          kind: 'sync-file',
          label: '同步文件',
          origin: 'local',
          readable: false,
          stores: [{ name: 'projects', keyField: 'id' }],
        },
        reader: createSyncFileReader({ file: yfe }),
      },
      {
        declaration: {
          sourceId: 'broken',
          kind: 'json-file',
          label: '截断的导出',
          origin: 'local',
          stores: mainStores(['projects']),
        },
        reader: createJsonDatabaseReader({ file: broken }),
      },
    ]

    const before = snapshotTree(dir)
    const collection = await scanLegacySources(declarations, requestId(1))

    // —— 来源级状态 ——
    const statusById = new Map(collection.sources.map((source) => [source.sourceId, source.status]))
    expect(statusById.get('portable')).toBe('partial') // projects/formData/worlds ok，chapters refused
    expect(statusById.get('ls')).toBe('readable')
    expect(statusById.get('blobs')).toBe('readable') // kbDocs 声明 created:false ⇒ absent（不是 refused）
    expect(statusById.get('kb')).toBe('readable')
    expect(statusById.get('sync')).toBe('listed-only')
    expect(statusById.get('broken')).toBe('refused')

    // —— store 级：ok / absent / refused 三态齐活 ——
    expect(storeOf(collection, 'portable', 'projects').status).toBe('ok')
    expect(storeOf(collection, 'portable', 'projects').rows).toBe(1)
    expect(storeOf(collection, 'portable', 'formData').rows).toBe(1)
    expect(storeOf(collection, 'portable', 'worlds').rows).toBe(1)
    const chapters = storeOf(collection, 'portable', 'chapters')
    expect(chapters.status).toBe('refused')
    expect(chapters.rows).toBeNull() // 🔴 refused 的条数是 null，不是 0
    expect(chapters.refusal?.code).toBe('NOT_FOUND')

    const kbDocsStore = storeOf(collection, 'blobs', 'kbDocs')
    expect(kbDocsStore.status).toBe('absent')
    expect(kbDocsStore.rows).toBe(0)

    // —— 端到端产物：readableStoreData 只给 ok/absent，refused 一条都不给 ——
    const rows = readableStoreData(collection)
    expect(rows.map((entry) => `${entry.sourceId}/${entry.database}/${entry.store}`)).toEqual([
      'portable/json-file/projects',
      'portable/json-file/formData',
      'portable/json-file/worlds',
      'ls/localstorage/localStorage',
      'blobs/sidecar/backupPayloads',
      'blobs/sidecar/vecRows',
      'blobs/sidecar/kbDocs',
      'kb/json-file/docs',
      'kb/json-file/bodies',
    ])
    // 记录真的原样带出来了（中文 / emoji / 未知字段 / vecB64 都在）
    const byStore = new Map(rows.map((entry) => [`${entry.sourceId}/${entry.store}`, entry.records]))
    expect(byStore.get('portable/projects')).toEqual([
      { id: 'p1', title: '星海 🌟', unknown: { keep: true } },
    ])
    expect(byStore.get('portable/worlds')).toEqual([{ id: 'w1', name: '雾海 🌊', tables: [] }])
    expect(byStore.get('blobs/vecRows')).toEqual([
      { id: 'p1::chapter::c1::0', projectId: 'p1', kind: 'chapter', text: '向量', vecB64: 'AAECAw==' },
    ])
    expect(byStore.get('blobs/kbDocs')).toEqual([]) // absent ⇒ 0 条（有证据），不是「读不出来」
    expect(byStore.get('ls/localStorage')).toContainEqual({
      key: 'yfe-sync-tombstones',
      value: '{"chapters":{"c9":1760000000000}}',
    })
    // 同步文件与坏源都不产出任何条目
    expect(rows.some((entry) => entry.sourceId === 'sync')).toBe(false)
    expect(rows.some((entry) => entry.sourceId === 'broken')).toBe(false)
    expect(collection.refusals.map((refusal) => refusal.code)).toContain('STORAGE_CORRUPT')

    // —— 只读：扫完一遍，目录快照（清单 + 大小 + mtime）完全没变 ——
    expect(snapshotTree(dir)).toEqual(before)

    // —— 确定性：同一份输入再扫一遍，逐条记录完全相同 ——
    const again = await scanLegacySources(declarations, requestId(1))
    expect(readableStoreData(again)).toEqual(rows)
    expect(again.refusals.map((refusal) => refusal.location)).toEqual(
      collection.refusals.map((refusal) => refusal.location),
    )
  })

  it('一个来源整个目录都不存在 → 来源级 refused，其它来源照常读出', async () => {
    const dir = tmp('e2e')
    const portable = writeJsonFile(`${dir}/data.json`, {
      kind: 'portable-data',
      app: 'youth-fantasy-engine',
      stores: { projects: { p1: { id: 'p1', title: '活着的数据 ✅' } } },
    })
    const collection = await scanLegacySources(
      [
        {
          declaration: {
            sourceId: 'gone',
            kind: 'sidecar',
            label: '已被删掉的数据目录',
            origin: 'local',
            stores: [{ name: 'backupPayloads', keyField: 'id' }],
          },
          reader: createSidecarDirectoryReader({ dir: `${dir}/nowhere` }),
        },
        {
          declaration: {
            sourceId: 'alive',
            kind: 'json-file',
            label: '还能读的整库',
            origin: 'local',
            stores: mainStores(['projects']),
          },
          reader: createJsonDatabaseReader({ file: portable }),
        },
      ],
      requestId(2),
    )
    const gone = collection.sources.find((source) => source.sourceId === 'gone')
    expect(gone?.status).toBe('refused')
    const alive = collection.sources.find((source) => source.sourceId === 'alive')
    expect(alive?.status).toBe('readable')
    const rows = readableStoreData(collection)
    expect(rows.map((entry) => entry.sourceId)).toEqual(['alive'])
    expect(rows[0]?.records).toEqual([{ id: 'p1', title: '活着的数据 ✅' }])
  })
})
