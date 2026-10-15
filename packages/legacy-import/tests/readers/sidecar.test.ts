import { mkdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure, readableStoreData } from '../../src/inventory.js'
import type { LegacySourceDeclaration } from '../../src/inventory.js'
import { createSidecarDirectoryReader, SIDECAR_WHOLE_KEY } from '../../src/readers/index.js'
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
  stores: readonly { readonly name: string; readonly keyField?: string }[],
  overrides: Partial<LegacySourceDeclaration> = {},
): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-sidecar',
    kind: 'sidecar',
    label: '桌面 blobs 外置存储',
    origin: 'local',
    stores,
    ...overrides,
  }
}

describe('createSidecarDirectoryReader', () => {
  it('per-id 布局：一文件一记录，按文件名稳定排序，中文/emoji/未知字段原样', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/backupPayloads/u2.json`, { id: 'u2', payload: '第二份 🎴' })
    writeJsonFile(`${blobs}/backupPayloads/u1.json`, { id: 'u1', payload: { deep: [1, 2], cn: '中文' } })
    writeJsonFile(`${blobs}/backupPayloads/u10.json`, { id: 'u10', payload: null })
    mkdirSync(`${blobs}/vecRows`, { recursive: true })

    const reader = createSidecarDirectoryReader({ dir: blobs })
    // 只列**实际存在**的 store 目录；`vecRows` 空目录也算存在
    expect(reader.listStores?.()).toEqual(['backupPayloads', 'vecRows'])

    const records = reader.readRecords('backupPayloads') as readonly Record<string, unknown>[]
    expect(records.map((record) => record['id'])).toEqual(['u1', 'u10', 'u2'])
    expect(records[0]).toEqual({ id: 'u1', payload: { deep: [1, 2], cn: '中文' } })
    expect(records[2]).toEqual({ id: 'u2', payload: '第二份 🎴' })

    // 目录存在但没有 .json → 存在但空（ok + 0 条）
    expect(reader.readRecords('vecRows')).toEqual([])
  })

  it('whole 布局：__all__.json 是整表（数组原样 / 主键对象排序）', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/kbDocs/${SIDECAR_WHOLE_KEY}.json`, [
      { id: 'd1', title: '设定集 · 一', text: '正文 🌟' },
      { id: 'd2', title: '设定集 · 二' },
    ])
    expect(SIDECAR_WHOLE_KEY).toBe('__all__')
    const reader = createSidecarDirectoryReader({ dir: blobs })
    expect(reader.listStores?.()).toEqual(['kbDocs'])
    expect(reader.readRecords('kbDocs')).toEqual([
      { id: 'd1', title: '设定集 · 一', text: '正文 🌟' },
      { id: 'd2', title: '设定集 · 二' },
    ])

    writeJsonFile(`${blobs}/kbBodies/__all__.json`, {
      b2: { id: 'b2', text: '第二段' },
      b1: { id: 'b1', text: '第一段' },
    })
    expect(reader.readRecords('kbBodies')).toEqual([
      { id: 'b1', text: '第一段' },
      { id: 'b2', text: '第二段' },
    ])
  })

  it('整表文件与逐条文件同时存在 → package-corrupt（拒绝静默只认一半）', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/backupPayloads/__all__.json`, [{ id: 'a' }])
    writeJsonFile(`${blobs}/backupPayloads/a.json`, { id: 'a' })
    const reader = createSidecarDirectoryReader({ dir: blobs })
    const error = catchReadError(() => reader.readRecords('backupPayloads'))
    expect(error.kind).toBe('package-corrupt')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('STORAGE_CORRUPT')
  })

  it('不符合上游 id 规则的 .json 文件 → package-corrupt（不被静默跳过）', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/backupPayloads/good.json`, { id: 'good' })
    writeJsonFile(`${blobs}/backupPayloads/has space.json`, { id: 'x' })
    const reader = createSidecarDirectoryReader({ dir: blobs })
    expect(catchReadError(() => reader.readRecords('backupPayloads')).kind).toBe('package-corrupt')
  })

  it('非 .json 文件被忽略（上游 list 也是按 .json 过滤）', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/projects/p1.json`, { id: 'p1' })
    writeRawFile(`${blobs}/projects/README.txt`, 'not a record')
    writeRawFile(`${blobs}/projects/notes.md`, '# nope')
    expect(createSidecarDirectoryReader({ dir: blobs }).readRecords('projects')).toEqual([{ id: 'p1' }])
  })

  it('store 目录不存在 → store-missing；blobs 目录不存在 → 来源级 refused', async () => {
    const root = tmp('sidecar')
    const blobs = `${root}/blobs`
    writeJsonFile(`${blobs}/projects/p1.json`, { id: 'p1' })
    const reader = createSidecarDirectoryReader({ dir: blobs })
    const error = catchReadError(() => reader.readRecords('worlds'))
    expect(error.kind).toBe('store-missing')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')

    const collection = await scan(declaration([{ name: 'projects', keyField: 'id' }, { name: 'worlds', keyField: 'id' }]), reader)
    expect(storeScanOf(collection, 'projects').status).toBe('ok')
    expect(storeScanOf(collection, 'projects').rows).toBe(1)
    expect(storeScanOf(collection, 'worlds').status).toBe('refused')
    expect(storeScanOf(collection, 'worlds').rows).toBeNull()

    const gone = createSidecarDirectoryReader({ dir: `${root}/nowhere` })
    const sourceError = catchReadError(() => gone.listStores?.())
    expect(sourceError.kind).toBe('not-found')
    const refused = await scan(declaration([{ name: 'projects', keyField: 'id' }]), gone)
    expect(storeScanOf(refused, 'projects').status).toBe('refused')
    expect(readableStoreData(refused)).toEqual([])
  })

  it('某个 store 里有读不了的文件 → 该 store refused，别的 store 不受影响', async () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/projects/p1.json`, { id: 'p1', title: '星海 🌟' })
    // 在 chapters 目录里放一个**同名目录**：readFileSync 会报 EISDIR → decode-failed
    mkdirSync(`${blobs}/chapters/broken.json`, { recursive: true })
    writeJsonFile(`${blobs}/chapters/c1.json`, { id: 'c1' })

    const reader = createSidecarDirectoryReader({ dir: blobs })
    expect(catchReadError(() => reader.readRecords('chapters')).kind).toBe('decode-failed')

    const collection = await scan(
      declaration([
        { name: 'projects', keyField: 'id' },
        { name: 'chapters', keyField: 'id' },
      ]),
      reader,
    )
    expect(storeScanOf(collection, 'chapters').status).toBe('refused')
    expect(storeScanOf(collection, 'chapters').refusal?.code).toBe('STORAGE_CORRUPT')
    const projects = storeScanOf(collection, 'projects')
    expect(projects.status).toBe('ok')
    expect(projects.records).toEqual([{ id: 'p1', title: '星海 🌟' }])

    const rows = readableStoreData(collection)
    expect(rows.map((entry) => entry.store)).toEqual(['projects'])
    expect(rows[0]?.database).toBe('sidecar')
  })

  it('截断的逐条 JSON → decode-failed（不是 0 条）', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeRawFile(`${blobs}/backupPayloads/u1.json`, '{"id": "u1", "payload":')
    expect(catchReadError(() => createSidecarDirectoryReader({ dir: blobs }).readRecords('backupPayloads')).kind).toBe(
      'decode-failed',
    )
  })

  it('确定性 + 只读：两次读取相同，目录快照不变', () => {
    const blobs = `${tmp('sidecar')}/blobs`
    writeJsonFile(`${blobs}/backupPayloads/b.json`, { id: 'b' })
    writeJsonFile(`${blobs}/backupPayloads/a.json`, { id: 'a' })
    const before = snapshotTree(blobs)
    const first = createSidecarDirectoryReader({ dir: blobs })
    const second = createSidecarDirectoryReader({ dir: blobs })
    expect(first.listStores?.()).toEqual(second.listStores?.())
    expect(first.readRecords('backupPayloads')).toEqual(second.readRecords('backupPayloads'))
    expect(snapshotTree(blobs)).toEqual(before)
  })
})
