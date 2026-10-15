import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure, readableStoreData } from '../../src/inventory.js'
import type { LegacySourceDeclaration } from '../../src/inventory.js'
import { createSyncFileReader, DEFAULT_CLOUD_KEY } from '../../src/readers/index.js'
import { scan, storeScanOf } from '../helpers.js'
import {
  catchReadError,
  makeTmpDir,
  removeTmpDir,
  sealAesPayload,
  sealXorPayload,
  snapshotTree,
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

/** 解出来的载荷就是 `SyncPayload`（`syncCore.ts:83-87`：store → 行数组）。 */
const PAYLOAD = {
  projects: [{ id: 'p1', title: '星海 🌟' }],
  formData: [{ tabId: 'tab-main' }],
  meta: [],
  __cloudBackup: { at: 1_760_000_000_000, stores: ['projects'] },
}

function declaration(overrides: Partial<LegacySourceDeclaration> = {}): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-sync',
    kind: 'sync-file',
    label: '青春幻想引擎-同步数据.yfe',
    origin: 'local',
    readable: false,
    stores: [{ name: 'projects', keyField: 'id' }],
    ...overrides,
  }
}

describe('createSyncFileReader', () => {
  it('listStores 恒空、readRecords 恒 store-missing（M-21 只识别不导入）', async () => {
    const file = writeSyncFile(`${tmp('yfe')}/青春幻想引擎-同步数据.yfe`, 3, sealAesPayload(PAYLOAD, DEFAULT_CLOUD_KEY))
    const reader = createSyncFileReader({ file })
    expect(reader.listStores?.()).toEqual([])
    const error = catchReadError(() => reader.readRecords('projects'))
    expect(error.kind).toBe('store-missing')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')

    // readable:false ⇒ listed-only：一个字节都不读，更不会变成「空库」
    const listed = await scan(declaration(), reader)
    expect(listed.sources[0]?.status).toBe('listed-only')
    expect(storeScanOf(listed, 'projects').status).toBe('listed-only')
    expect(readableStoreData(listed)).toEqual([])
  })

  it('readable:true 时也只是 refused（绝不是 ok/absent）', async () => {
    const file = writeSyncFile(`${tmp('yfe')}/sync.yfe`, 1, sealAesPayload(PAYLOAD, DEFAULT_CLOUD_KEY))
    const collection = await scan(declaration({ readable: true }), createSyncFileReader({ file }))
    const store = storeScanOf(collection, 'projects')
    expect(store.status).toBe('refused')
    expect(store.rows).toBeNull()
    expect(store.refusal?.kind).toBe('store-missing')
    expect(readableStoreData(collection)).toEqual([])
  })

  it('inspect：a1 AES-GCM 载荷（桌面内置口令）→ 解密成功并给出 store 名单与行数', () => {
    const file = writeSyncFile(
      `${tmp('yfe')}/sync.yfe`,
      12,
      sealAesPayload(PAYLOAD, DEFAULT_CLOUD_KEY),
    )
    const inspection = createSyncFileReader({ file }).inspect()
    expect(inspection.rev).toBe(12)
    expect(inspection.payloadFormat).toBe('aes-gcm')
    expect(inspection.decoded).toBe(true)
    expect(inspection.reason).toBeNull()
    expect(inspection.storeNames).toEqual(['formData', 'meta', 'projects'])
    expect(inspection.storeCounts).toEqual({ formData: 1, meta: 0, projects: 1 })
    expect(inspection.nonStoreKeys).toEqual(['__cloudBackup'])
    expect(inspection.bytes).toBeGreaterThan(0)
    expect(inspection.modifiedAt).not.toBe('')
  })

  it('inspect：x1 XOR 混淆载荷也能解（无 WebCrypto 的降级路径）', () => {
    const file = writeSyncFile(`${tmp('yfe')}/sync.yfe`, 5, sealXorPayload(PAYLOAD, DEFAULT_CLOUD_KEY))
    const inspection = createSyncFileReader({ file }).inspect()
    expect(inspection.payloadFormat).toBe('xor-obfuscated')
    expect(inspection.decoded).toBe(true)
    expect(inspection.storeNames).toEqual(['formData', 'meta', 'projects'])
  })

  it('inspect：无前缀的明文 JSON 载荷', () => {
    const file = writeSyncFile(`${tmp('yfe')}/sync.yfe`, 1, JSON.stringify(PAYLOAD))
    const inspection = createSyncFileReader({ file }).inspect()
    expect(inspection.payloadFormat).toBe('plaintext-json')
    expect(inspection.decoded).toBe(true)
    expect(inspection.storeCounts['projects']).toBe(1)
  })

  it('inspect：自定义口令（多套数据各自 slot）', () => {
    const file = writeSyncFile(`${tmp('yfe')}/sync.yfe`, 2, sealAesPayload(PAYLOAD, '我的口令-2026'))
    expect(createSyncFileReader({ file, key: '我的口令-2026' }).inspect().decoded).toBe(true)
    const wrong = createSyncFileReader({ file, key: 'YFE-CLOUD-FILE-SYNC-V1' }).inspect()
    expect(wrong.decoded).toBe(false)
    expect(wrong.reason).toBeTruthy()
    expect(wrong.storeNames).toEqual([])
  })

  it('inspect：enc 缺失 / 损坏 / 长度不足都不抛，只报 decoded:false + reason', () => {
    const dir = tmp('yfe')
    const empty = createSyncFileReader({ file: writeSyncFile(`${dir}/a.yfe`, 0, null) }).inspect()
    expect(empty.payloadFormat).toBe('absent')
    expect(empty.decoded).toBe(false)
    expect(empty.rev).toBe(0)
    expect(empty.reason).toBeTruthy()

    const broken = createSyncFileReader({ file: writeSyncFile(`${dir}/b.yfe`, 4, 'a1:%%%不是base64%%%') }).inspect()
    expect(broken.payloadFormat).toBe('aes-gcm')
    expect(broken.decoded).toBe(false)
    expect(broken.reason).toBeTruthy()
    expect(broken.rev).toBe(4)

    const short = createSyncFileReader({ file: writeSyncFile(`${dir}/c.yfe`, 4, 'a1:AAAA') }).inspect()
    expect(short.decoded).toBe(false)

    const notPayload = createSyncFileReader({
      file: writeSyncFile(`${dir}/d.yfe`, 4, JSON.stringify([1, 2, 3])),
    }).inspect()
    expect(notPayload.payloadFormat).toBe('plaintext-json')
    expect(notPayload.decoded).toBe(false)
  })

  it('文件不存在 → not-found；非法 JSON / 0 字节 → decode-failed（都不当空）', () => {
    const dir = tmp('yfe')
    const missing = createSyncFileReader({ file: `${dir}/nope.yfe` })
    const notFound = catchReadError(() => missing.inspect())
    expect(notFound.kind).toBe('not-found')
    expect(errorCodeOfReadFailure(notFound.kind, notFound.origin)).toBe('NOT_FOUND')

    expect(catchReadError(() => createSyncFileReader({ file: writeRawFile(`${dir}/bad.yfe`, '{"rev": 1,') }).inspect()).kind).toBe(
      'decode-failed',
    )
    expect(catchReadError(() => createSyncFileReader({ file: writeRawFile(`${dir}/zero.yfe`, '') }).inspect()).kind).toBe(
      'decode-failed',
    )
  })

  it('确定性 + 只读：两次 inspect 相同，目录快照不变', () => {
    const dir = tmp('yfe')
    const file = writeSyncFile(`${dir}/sync.yfe`, 9, sealAesPayload(PAYLOAD, DEFAULT_CLOUD_KEY))
    const before = snapshotTree(dir)
    const first = createSyncFileReader({ file }).inspect()
    const second = createSyncFileReader({ file }).inspect()
    expect(second).toEqual(first)
    expect(snapshotTree(dir)).toEqual(before)
  })
})
