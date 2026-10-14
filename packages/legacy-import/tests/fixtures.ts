/**
 * 自造的**最小合成夹具**。
 *
 * 🔴 这些数据是为了测试映射规则而手工构造的，**不是真实用户数据**，也不复制任何
 *    真实作品内容。字段名的选择依据是迁移矩阵 `docs/旧功能迁移矩阵.md` §2.1/§2.2
 *    与 `upstream/src/lib/types.ts` 的接口形状。
 */

import { LegacyReadError } from '../src/errors.js'
import type { LegacyCollection, LegacySourceDeclaration, LegacySourceReader } from '../src/inventory.js'
import { scanLegacySources } from '../src/inventory.js'
import type { StoreBehavior } from './helpers.js'
import { MAIN_STORES, mainDeclaration, makeReader, records, requestId, throws } from './helpers.js'

export const SYNTHETIC_PROJECT_ID = 'p-synth-1'
export const SYNTHETIC_CHAPTER_ID = 'c-synth-1'
export const SYNTHETIC_CRLF_CONTENT = '第一行\r\n第二行\r\n'
export const SYNTHETIC_NORMALIZED = '第一行\n第二行\n'

/** 一个「形状齐全」的旧主库：每一类关键记录都至少有一条。 */
export const SYNTHETIC_MAIN: Readonly<Record<string, readonly unknown[]>> = {
  projects: [
    {
      id: SYNTHETIC_PROJECT_ID,
      name: '合成作品甲',
      genre: '奇幻',
      intro: '合成简介',
      cover: 'data:image/png;base64,COVER',
      projectType: 'full',
      features: { aiAssist: true },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-03-01T00:00:00.000Z',
    },
  ],
  volumes: [
    {
      id: 'v-synth-1',
      projectId: SYNTHETIC_PROJECT_ID,
      order: 1,
      title: '合成第一卷',
      description: '卷简介甲',
      isFree: false,
      createdAt: '2024-01-02T00:00:00.000Z',
    },
    {
      id: 'v-synth-2',
      projectId: SYNTHETIC_PROJECT_ID,
      order: 2,
      title: '合成第二卷',
      description: '卷简介乙',
      createdAt: '2024-01-03T00:00:00.000Z',
    },
  ],
  chapters: [
    {
      id: SYNTHETIC_CHAPTER_ID,
      projectId: SYNTHETIC_PROJECT_ID,
      volumeId: 'v-synth-1',
      order: 1,
      title: '合成第 1 章',
      content: SYNTHETIC_CRLF_CONTENT,
      wordCount: 8,
      status: '草稿',
      excludeFromNumbering: false,
      aiAssist: { tone: 'plain' },
      createdAt: '2024-01-04T00:00:00.000Z',
      updatedAt: '2024-01-05T00:00:00.000Z',
    },
    {
      id: 'c-synth-2',
      projectId: SYNTHETIC_PROJECT_ID,
      volumeId: 'v-synth-1',
      order: 2,
      title: '合成第 2 章',
      content: '第三章正文',
      wordCount: 5,
      status: '已发布',
      createdAt: '2024-01-06T00:00:00.000Z',
      updatedAt: '2024-01-07T00:00:00.000Z',
    },
    {
      id: 'c-synth-3',
      projectId: SYNTHETIC_PROJECT_ID,
      volumeId: 'v-synth-2',
      order: 1,
      title: '合成第 3 章',
      content: '第四章正文',
      wordCount: 5,
      status: '构思',
      createdAt: '2024-01-08T00:00:00.000Z',
      updatedAt: '2024-01-09T00:00:00.000Z',
    },
  ],
  formData: [
    {
      id: `${SYNTHETIC_PROJECT_ID}::worldbase`,
      projectId: SYNTHETIC_PROJECT_ID,
      tabId: 'worldbase',
      data: { 名称: '世界基底', 地理: '合成大陆', 未知列: '保留我' },
    },
  ],
  tableRows: [
    {
      id: 'row-synth-1',
      projectId: SYNTHETIC_PROJECT_ID,
      tabId: 'power',
      order: 1,
      data: { 名称: '合成火系', 等级: 3, 引用: 'row-synth-2' },
    },
    {
      id: 'row-synth-2',
      projectId: SYNTHETIC_PROJECT_ID,
      tabId: 'power',
      order: 2,
      data: { 名称: '合成水系', 等级: 2 },
    },
  ],
  cardRecords: [
    {
      id: 'card-synth-main',
      projectId: SYNTHETIC_PROJECT_ID,
      tabId: 'char-main',
      order: 1,
      name: '合成主角',
      data: { 名称: '合成主角', 身份: '测试角色', 简介: '合成人物' },
      portrait: 'data:image/png;base64,PORTRAIT',
      createdAt: '2024-01-10T00:00:00.000Z',
    },
    {
      id: 'card-synth-sub',
      projectId: SYNTHETIC_PROJECT_ID,
      tabId: 'char-main-sub',
      order: 1,
      name: '合成主角·别名',
      data: { 名称: '合成主角·别名', parentId: 'card-synth-main' },
    },
  ],
  settingsKV: [
    {
      key: `${SYNTHETIC_PROJECT_ID}::checkLog`,
      value: { lastCheckedAt: '2024-02-01T00:00:00.000Z' },
      updatedAt: '2024-02-01T00:00:00.000Z',
    },
  ],
  snapshots: [
    {
      id: 'snap-synth-1',
      chapterId: SYNTHETIC_CHAPTER_ID,
      content: '第一版\r\n草稿',
      createdAt: '2024-01-04T12:00:00.000Z',
    },
    {
      id: 'snap-synth-2',
      chapterId: SYNTHETIC_CHAPTER_ID,
      content: '第二版草稿',
      createdAt: '2024-01-05T12:00:00.000Z',
    },
  ],
  trash: [
    {
      // 旧版把整章内容连同 `deletedAt` 一起搬进回收站，因此 `id` 就是原章节 id。
      // 这里指向 `c-synth-3`：它同时在 `chapters` 里，导入后应变成 deleted = 1。
      id: 'c-synth-3',
      kind: 'chapter',
      projectId: SYNTHETIC_PROJECT_ID,
      volumeId: 'v-synth-1',
      order: 99,
      title: '合成已删章',
      content: '已删正文',
      wordCount: 4,
      deletedAt: '2024-02-02T00:00:00.000Z',
      createdAt: '2024-01-11T00:00:00.000Z',
    },
  ],
  meta: [
    { key: 'welcomeDone', value: true },
    { key: 'theme', value: 'dark' },
    {
      key: 'aiProviders',
      value: { providers: [{ id: 'p', apiKey: 'sk-synthetic-must-not-be-written' }] },
    },
  ],
  worlds: [
    { id: 'world-synth-1', name: '合成世界包', payload: { rules: ['a'] }, createdAt: '2024-01-12T00:00:00.000Z' },
  ],
  tavernReports: [{ id: 'tavern-synth-1', projectId: SYNTHETIC_PROJECT_ID, title: '合成酒馆报告', body: '内容' }],
  dailyStats: [{ key: '2024-01-04', value: { words: 120 } }],
  aiRuns: [
    { id: 'run-synth-1', projectId: SYNTHETIC_PROJECT_ID, status: 'aborted', kind: 'polish', createdAt: '2024-01-13T00:00:00.000Z' },
  ],
  backups: [{ id: 'backup-synth-1', createdAt: '2024-01-14T00:00:00.000Z', byteSize: 100 }],
  backupPayloads: [{ id: 'backup-synth-1', payload: 'frozen' }],
}

/** 用合成数据造一个读取器；未在 `SYNTHETIC_MAIN` 里的 store 一律空数组。 */
export function syntheticReader(overrides: Readonly<Record<string, readonly unknown[]>> = {}): LegacySourceReader {
  const behaviors: Record<string, StoreBehavior> = {}
  for (const store of MAIN_STORES) {
    behaviors[store.name] = records(overrides[store.name] ?? SYNTHETIC_MAIN[store.name] ?? [])
  }
  return makeReader(behaviors)
}

export function syntheticDeclaration(overrides: Partial<LegacySourceDeclaration> = {}): LegacySourceDeclaration {
  return mainDeclaration(overrides)
}

/** 完整扫描一次合成主库。 */
export async function syntheticCollection(
  overrides: Readonly<Record<string, readonly unknown[]>> = {},
): Promise<LegacyCollection> {
  return scanLegacySources([{ declaration: syntheticDeclaration(), reader: syntheticReader(overrides) }], requestId(7))
}

/** 主库 + 一个额外 localStorage 来源（`yfe-sync-tombstones` 是关键：丢掉它已删作品会「复活」）。 */
export async function syntheticCollectionWithLocalStorage(): Promise<LegacyCollection> {
  const behaviors: Record<string, StoreBehavior> = {}
  for (const store of MAIN_STORES) {
    behaviors[store.name] = records(SYNTHETIC_MAIN[store.name] ?? [])
  }
  return scanLegacySources(
    [
      { declaration: mainDeclaration(), reader: makeReader(behaviors) },
      {
        declaration: {
          sourceId: 'legacy-local-storage',
          kind: 'localstorage',
          label: '合成 localStorage（自造）',
          stores: [{ name: 'localStorage', keyField: 'key' }],
        },
        reader: makeReader({
          localStorage: records([
            { key: 'yfe-theme', value: '"dark"' },
            { key: 'yfe-sync-tombstones', value: '{"deletedProjects":["p-gone"]}' },
          ]),
        }),
      },
    ],
    requestId(21),
  )
}

/** 主库 + 一个 `-vec` 向量库来源（迁移矩阵 M-17：不迁移，只在报告里说明「将在新版重建」）。 */
export async function syntheticCollectionWithVectorIndex(): Promise<LegacyCollection> {
  const behaviors: Record<string, StoreBehavior> = {}
  for (const store of MAIN_STORES) {
    behaviors[store.name] = records(SYNTHETIC_MAIN[store.name] ?? [])
  }
  return scanLegacySources(
    [
      { declaration: mainDeclaration(), reader: makeReader(behaviors) },
      {
        declaration: {
          sourceId: 'legacy-vec',
          kind: 'indexeddb',
          label: '合成向量索引库（自造）',
          version: 1,
          stores: [{ name: 'embeddings', keyField: 'id' }],
        },
        reader: makeReader({ embeddings: records([{ id: 'emb-synth-1', projectId: SYNTHETIC_PROJECT_ID, vector: [0.1] }]) }),
      },
    ],
    requestId(22),
  )
}

/**
 * 「读不出来」的合成来源：`chapters` 抛解码失败，其余正常。
 *
 * 用途是断言**拒绝不被折算成 0 条**——报告与计划都必须看得见这条失败。
 */
export function readerWithCorruptChapters(): LegacySourceReader {
  const behaviors: Record<string, StoreBehavior> = {}
  for (const store of MAIN_STORES) {
    behaviors[store.name] = records(SYNTHETIC_MAIN[store.name] ?? [])
  }
  behaviors['chapters'] = throws(
    new LegacyReadError({
      kind: 'decode-failed',
      message: '合成夹具：chapters 的 JSON 解析失败',
      location: 'legacy-main/main/chapters',
    }),
  )
  return makeReader(behaviors)
}

/** 一份 `.yfe` 同步文件声明：按迁移矩阵 M-21 只登记不导入。 */
export function syncFileDeclaration(): LegacySourceDeclaration {
  return {
    sourceId: 'legacy-sync-file',
    kind: 'sync-file',
    label: '合成同步文件（不导入）',
    readable: false,
    note: '迁移矩阵 M-21：同步不是备份，本包只识别与登记。',
  }
}
