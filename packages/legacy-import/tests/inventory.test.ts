/**
 * 清单与只读扫描：**「读不出来」与「0 条」必须是两件事**。
 *
 * 任务语义 2 的正面证据：文件/store 缺失、解析失败、包损坏、权限失败、超时
 * 一律记 `refused` 且 `rows === null`；只有**显式证据**（清单声明从未创建）才允许判 0。
 */

import { describe, expect, it } from 'vitest'

import { LegacyReadError } from '../src/errors.js'
import type { LegacySourceReader } from '../src/inventory.js'
import { readableStoreData, scanLegacySource, scanLegacySources } from '../src/inventory.js'
import {
  ABSENT,
  MAIN_STORES,
  mainDeclaration,
  makeReader,
  records,
  requestId,
  storeScanOf,
  throws,
} from './helpers.js'
import { SYNTHETIC_MAIN, syntheticReader, syncFileDeclaration } from './fixtures.js'

describe('只读扫描的三种结局', () => {
  it('store 读取出错（JSON 解析失败）→ refused，rows 为 null，绝不是 0', async () => {
    const reader = makeReader({
      projects: throws(
        new LegacyReadError({
          kind: 'decode-failed',
          message: '合成夹具：projects 解析失败',
          location: 'legacy-main/main/projects',
        }),
      ),
    })
    const scan = await scanLegacySource(mainDeclaration({ stores: [{ name: 'projects', keyField: 'id' }] }), reader, requestId(1))

    expect(scan.status).toBe('refused')
    const store = scan.stores[0]
    expect(store?.status).toBe('refused')
    expect(store?.rows).toBeNull()
    expect(store?.rows).not.toBe(0)
    expect(store?.refusal?.kind).toBe('decode-failed')
    expect(store?.refusal?.location).toBe('legacy-main/main/projects')
    expect(scan.notes.join('\n')).toContain('未读到的部分绝不算作空')
  })

  it('三种损坏形态（解析失败 / 非数组 / 未知抛出）都落 refused，没有一种变成 0 条', async () => {
    const cases: readonly { readonly name: string; readonly error: unknown }[] = [
      { name: 'decode-failed', error: new LegacyReadError({ kind: 'decode-failed', message: '坏 JSON', location: 'x' }) },
      { name: 'package-corrupt', error: new LegacyReadError({ kind: 'package-corrupt', message: '包损坏', location: 'x' }) },
      { name: 'permission-denied', error: new LegacyReadError({ kind: 'permission-denied', message: '权限不足', location: 'x' }) },
      { name: 'timeout', error: new LegacyReadError({ kind: 'timeout', message: '读取超时', location: 'x' }) },
      { name: 'unknown', error: new TypeError('读到了意料之外的东西') },
    ]

    for (const entry of cases) {
      const scan = await scanLegacySource(
        mainDeclaration({ stores: [{ name: 'chapters', keyField: 'id' }] }),
        makeReader({ chapters: throws(entry.error) }),
        requestId(2),
      )
      const store = scan.stores[0]
      expect(store?.status, entry.name).toBe('refused')
      expect(store?.rows, entry.name).toBeNull()
    }
  })

  it('读到的内容不是数组 → refused(decode-failed)，仍然不是 0 条', async () => {
    const reader: LegacySourceReader = {
      listStores: () => ['chapters'],
      // 合成「读到了一个对象而不是记录数组」：无法判定条数。
      // 这里故意越过类型——真实读取器来自 JS 侧的 IndexedDB 封装，返回值不受 TS 保证，
      // 扫描器必须在运行期自己检查，而不是相信类型。
      readRecords: (() => ({ not: 'an array' })) as unknown as LegacySourceReader['readRecords'],
    }
    const scan = await scanLegacySource(mainDeclaration({ stores: [{ name: 'chapters', keyField: 'id' }] }), reader, requestId(3))
    const store = scan.stores[0]
    expect(store?.status).toBe('refused')
    expect(store?.rows).toBeNull()
    expect(store?.refusal?.code).toBe('STORAGE_CORRUPT')
  })

  it('清单里若显式声明该 store 从未创建，才允许是 absent(0)', async () => {
    const scan = await scanLegacySource(
      mainDeclaration({ stores: [{ name: 'worlds', keyField: 'id', created: false, note: 'v13 之前没有这个 store' }] }),
      makeReader({ worlds: ABSENT }),
      requestId(4),
    )
    const store = scan.stores[0]
    expect(store?.status).toBe('absent')
    expect(store?.rows).toBe(0)
    expect(store?.refusal).toBeNull()
    expect(scan.status).toBe('readable')
  })

  it('声明存在但列不出来 → refused(store-missing)，rows 为 null', async () => {
    // 读取器「列表里没有它」——这不是「它没有数据」，是「我们没读到」。
    const reader = { listStores: () => [], readRecords: () => [] as readonly unknown[] }
    const scan = await scanLegacySource(
      mainDeclaration({ stores: [{ name: 'chapters', keyField: 'id' }] }),
      reader,
      requestId(5),
    )
    const store = scan.stores[0]
    expect(store?.status).toBe('refused')
    expect(store?.rows).toBeNull()
    expect(store?.refusal?.kind).toBe('store-missing')
    expect(store?.refusal?.code).toBe('NOT_FOUND')
  })

  it('声明为可读却没给读取器 → 整个来源 refused，不是空库', async () => {
    const scan = await scanLegacySource(mainDeclaration({ stores: [{ name: 'projects', keyField: 'id' }] }), undefined, requestId(6))
    expect(scan.status).toBe('refused')
    expect(scan.stores[0]?.status).toBe('refused')
    expect(scan.stores[0]?.rows).toBeNull()
  })

  it('listStores 抛错 → 来源级 refused，所有声明过的 store 都记拒绝', async () => {
    const reader = {
      listStores: () => {
        throw new LegacyReadError({ kind: 'permission-denied', message: '无法列出 store', location: 'legacy-main/*' })
      },
      readRecords: () => [] as readonly unknown[],
    }
    const scan = await scanLegacySource(
      mainDeclaration({ stores: [{ name: 'projects', keyField: 'id' }, { name: 'chapters', keyField: 'id' }] }),
      reader,
      requestId(7),
    )
    expect(scan.status).toBe('refused')
    expect(scan.stores.map((store) => store.status)).toEqual(['refused', 'refused'])
    expect(scan.stores.every((store) => store.rows === null)).toBe(true)
  })

  it('完整可读的来源是 readable，部分拒绝的是 partial（不完整必须说出来）', async () => {
    const ok = await scanLegacySource(
      mainDeclaration({ stores: [{ name: 'projects', keyField: 'id' }] }),
      makeReader({ projects: records(SYNTHETIC_MAIN['projects'] ?? []) }),
      requestId(8),
    )
    expect(ok.status).toBe('readable')

    const partial = await scanLegacySource(
      mainDeclaration({ stores: [{ name: 'projects', keyField: 'id' }, { name: 'chapters', keyField: 'id' }] }),
      makeReader({
        projects: records(SYNTHETIC_MAIN['projects'] ?? []),
        chapters: throws(new LegacyReadError({ kind: 'decode-failed', message: '坏', location: 'legacy-main/main/chapters' })),
      }),
      requestId(9),
    )
    expect(partial.status).toBe('partial')
    expect(storeScanOf({ sources: [partial], refusals: [], notes: [] }, 'chapters').status).toBe('refused')
  })
})

describe('只登记不导入的来源', () => {
  it('readable:false 的来源是 listed-only，且读取器一次都不会被调用', async () => {
    let calls = 0
    const reader = {
      listStores: () => {
        calls += 1
        return []
      },
      readRecords: () => {
        calls += 1
        return []
      },
    }
    const scan = await scanLegacySource(syncFileDeclaration(), reader, requestId(10))
    expect(scan.status).toBe('listed-only')
    expect(calls).toBe(0)
    expect(scan.notes.join('')).toContain('同步不是备份')
  })
})

describe('readableStoreData 的结构性保证', () => {
  it('拒绝的 store 根本不产出条目，下游拿不到「看起来是空」的东西', async () => {
    const collection = await scanLegacySources(
      [
        {
          declaration: mainDeclaration({
            stores: [
              { name: 'projects', keyField: 'id' },
              { name: 'chapters', keyField: 'id' },
              { name: 'worlds', keyField: 'id', created: false },
            ],
          }),
          reader: makeReader({
            projects: records(SYNTHETIC_MAIN['projects'] ?? []),
            chapters: throws(new LegacyReadError({ kind: 'store-missing', message: '没有这个 store', location: 'x' })),
            worlds: ABSENT,
          }),
        },
      ],
      requestId(11),
    )

    const data = readableStoreData(collection)
    const names = data.map((entry) => entry.store)
    expect(names).toContain('projects')
    expect(names).toContain('worlds')
    // 🔴 关键：chapters 读不出来，于是**根本没有** chapters 条目。
    expect(names).not.toContain('chapters')
    expect(collection.refusals.map((refusal) => refusal.location)).toEqual(['legacy-main/main/chapters'])
  })

  it('对照组：16 个 store 全都读得出来时，一条拒绝都不该凭空产生', async () => {
    const collection = await scanLegacySources(
      [
        {
          declaration: mainDeclaration({ stores: MAIN_STORES }),
          reader: syntheticReader(),
        },
      ],
      requestId(12),
    )
    // 合成读取器把所有 store 都读成数组，因此这里没有拒绝——这是对照组的基线。
    // 有了这条，「读不出来 → refused」的断言才有意义：那不是我见谁都报错。
    expect(collection.refusals).toEqual([])
    expect(collection.sources[0]?.status).toBe('readable')
    expect(collection.sources[0]?.stores.every((store) => store.status === 'ok')).toBe(true)
  })
})
