import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure, readableStoreData } from '../../src/inventory.js'
import type { LegacySourceDeclaration } from '../../src/inventory.js'
import {
  createKnowledgeBaseReader,
  createStoreFilesReader,
  createVectorIndexReader,
} from '../../src/readers/index.js'
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

function declaration(
  stores: readonly { readonly name: string; readonly keyField?: string; readonly created?: boolean }[],
  overrides: Partial<LegacySourceDeclaration> = {},
): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-kb',
    kind: 'json-file',
    label: '知识库导出',
    origin: 'local',
    stores,
    ...overrides,
  }
}

const KB_DOCS = [
  {
    id: 'd1',
    projectId: 'p1',
    title: '世界观设定 · 卷一 🌟',
    sourceType: 'md',
    chars: 128,
    chunkCount: 3,
    importedAt: 1_760_000_000_000,
    enabled: true,
    unknownField: { keep: '原样' },
  },
]
const KB_BODIES = [{ id: 'd1', text: '正文第一段。\n\n正文第二段 🎴' }]

const VEC_ROWS = [
  {
    id: 'p1::chapter::c1::0',
    projectId: 'p1',
    refKey: 'p1::c1',
    kind: 'chapter',
    refId: 'c1',
    chunkIdx: 0,
    text: '向量文本',
    title: '第一章',
    hash: 'abc',
    vecB64: 'AAECAwQF',
    dim: 1024,
    model: 'bge-m3',
    secret: false,
    updatedAt: 1_760_000_000_000,
  },
]

describe('createKnowledgeBaseReader / createVectorIndexReader / createStoreFilesReader', () => {
  it('知识库 docs + bodies：两个 store 都在，记录原样', () => {
    const dir = tmp('kb')
    const docsFile = writeJsonFile(`${dir}/docs.json`, KB_DOCS)
    const bodiesFile = writeJsonFile(`${dir}/bodies.json`, KB_BODIES)
    const reader = createKnowledgeBaseReader({ docsFile, bodiesFile })
    expect(reader.listStores?.()).toEqual(['bodies', 'docs'])
    expect(reader.readRecords('docs')).toEqual(KB_DOCS)
    expect(reader.readRecords('bodies')).toEqual(KB_BODIES)
  })

  it('只给 docs（bodies 文件缺失 = 该 store 不存在）→ bodies 走 store-missing/refused', async () => {
    const dir = tmp('kb')
    const docsFile = writeJsonFile(`${dir}/docs.json`, KB_DOCS)
    const reader = createKnowledgeBaseReader({ docsFile })
    expect(reader.listStores?.()).toEqual(['docs'])
    expect(catchReadError(() => reader.readRecords('bodies')).kind).toBe('store-missing')

    // 声明了 bodies 但文件根本没提供：created 缺省（= 应该存在）⇒ refused
    const collection = await scan(
      declaration([
        { name: 'docs', keyField: 'id' },
        { name: 'bodies', keyField: 'id' },
      ]),
      reader,
    )
    expect(storeScanOf(collection, 'docs').status).toBe('ok')
    expect(storeScanOf(collection, 'bodies').status).toBe('refused')
    expect(storeScanOf(collection, 'bodies').rows).toBeNull()
  })

  it('知识库 docs 文件不存在 → not-found（refused，不是 0 条）', async () => {
    const dir = tmp('kb')
    const docsFile = `${dir}/nope.json`
    const bodiesFile = writeJsonFile(`${dir}/bodies.json`, KB_BODIES)
    const reader = createKnowledgeBaseReader({ docsFile, bodiesFile })
    expect(reader.listStores?.()).toEqual(['bodies'])
    const error = catchReadError(() => reader.readRecords('docs'))
    expect(error.kind).toBe('not-found')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')

    const collection = await scan(
      declaration([
        { name: 'docs', keyField: 'id' },
        { name: 'bodies', keyField: 'id' },
      ]),
      reader,
    )
    expect(storeScanOf(collection, 'docs').status).toBe('refused')
    expect(storeScanOf(collection, 'bodies').status).toBe('ok')
    const rows = readableStoreData(collection)
    expect(rows.map((entry) => entry.store)).toEqual(['bodies'])
    expect(rows[0]?.database).toBe('json-file')
  })

  it('空数组 = 存在但 0 条；0 字节 / 截断文件 = refused', async () => {
    const dir = tmp('kb')
    const emptyDocs = writeJsonFile(`${dir}/empty-docs.json`, [])
    const emptyBodies = writeJsonFile(`${dir}/empty-bodies.json`, [])
    const collection = await scan(
      declaration([
        { name: 'docs', keyField: 'id' },
        { name: 'bodies', keyField: 'id' },
      ]),
      createKnowledgeBaseReader({ docsFile: emptyDocs, bodiesFile: emptyBodies }),
    )
    expect(storeScanOf(collection, 'docs').status).toBe('ok')
    expect(storeScanOf(collection, 'docs').rows).toBe(0)
    expect(storeScanOf(collection, 'bodies').status).toBe('ok')
    expect(storeScanOf(collection, 'bodies').rows).toBe(0)

    const zero = writeRawFile(`${dir}/zero.json`, '')
    // 存在性归 listStores 管（文件确实在）；「里面是不是能解析的内容」归 readRecords 管：
    expect(createKnowledgeBaseReader({ docsFile: zero }).listStores?.()).toEqual(['docs'])
    expect(catchReadError(() => createKnowledgeBaseReader({ docsFile: zero }).readRecords('docs')).kind).toBe(
      'decode-failed',
    )
    const truncated = writeRawFile(`${dir}/truncated.json`, '[{"id": "d1", "text": "未完')
    expect(
      catchReadError(() => createKnowledgeBaseReader({ docsFile: truncated }).readRecords('docs')).kind,
    ).toBe('decode-failed')
  })

  it('向量索引 embeddings：vecB64 原样透出（不换算、不裁剪）', () => {
    const dir = tmp('vec')
    const embeddingsFile = writeJsonFile(`${dir}/embeddings.json`, VEC_ROWS)
    const reader = createVectorIndexReader({ embeddingsFile })
    expect(reader.listStores?.()).toEqual(['embeddings'])
    expect(reader.readRecords('embeddings')).toEqual(VEC_ROWS)
    const row = (reader.readRecords('embeddings') as readonly Record<string, unknown>[])[0]
    expect(row?.['vecB64']).toBe('AAECAwQF')
    expect(row?.['dim']).toBe(1024)
  })

  it('「主键 → 记录」对象容器按主键排序；标量容器 → decode-failed', () => {
    const dir = tmp('kb')
    const mapFile = writeJsonFile(`${dir}/map.json`, { b: { id: 'b' }, a: { id: 'a' } })
    expect(createStoreFilesReader({ files: { docs: mapFile } }).readRecords('docs')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
    const scalar = writeRawFile(`${dir}/scalar.json`, '7')
    expect(catchReadError(() => createStoreFilesReader({ files: { docs: scalar } }).readRecords('docs')).kind).toBe(
      'decode-failed',
    )
  })

  it('未登记 / 未提供文件的 store → store-missing；listStores 只列实际存在的文件', () => {
    const dir = tmp('kb')
    const docsFile = writeJsonFile(`${dir}/docs.json`, KB_DOCS)
    const missing = `${dir}/ghost.json`
    const reader = createStoreFilesReader({ files: { docs: docsFile, bodies: missing } })
    expect(reader.listStores?.()).toEqual(['docs'])
    expect(catchReadError(() => reader.readRecords('bodies')).kind).toBe('not-found')
    expect(catchReadError(() => reader.readRecords('worlds')).kind).toBe('store-missing')
  })

  it('确定性 + 只读', () => {
    const dir = tmp('kb')
    const docsFile = writeJsonFile(`${dir}/docs.json`, KB_DOCS)
    const bodiesFile = writeJsonFile(`${dir}/bodies.json`, KB_BODIES)
    const before = snapshotTree(dir)
    const first = createKnowledgeBaseReader({ docsFile, bodiesFile })
    const second = createKnowledgeBaseReader({ docsFile, bodiesFile })
    expect(first.listStores?.()).toEqual(second.listStores?.())
    expect(first.readRecords('docs')).toEqual(second.readRecords('docs'))
    expect(first.readRecords('bodies')).toEqual(second.readRecords('bodies'))
    expect(snapshotTree(dir)).toEqual(before)
  })
})
