/// <reference path="../../src/renderer/vue-shims.d.ts" />

/**
 * `features/demo-project-port.ts` 的行为测试。
 *
 * 本文件只做纯编排逻辑的验证：手写一个记录调用的假 `invoke`（不 mock 模块），
 * 断言调用顺序、父级挂载、乐观锁版本、幂等键、以及失败回滚。
 * 不碰 DOM，所以用 vitest 缺省的 node 环境（不要加 happy-dom 指令）。
 */

import { describe, expect, it } from 'vitest'

import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  ErrorPayload,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectDeleteInput,
  ProjectDeleteOutput,
  Result,
  SaveDraftInput,
  SaveDraftOutput,
} from '@yfe/contracts'

import {
  buildDemoProjectSeed,
  type DemoProjectSeed,
} from '../../src/renderer/features/demo-project.js'
import {
  createDemoProject,
  createDemoProjectWith,
  type DemoProjectDeps,
  type DemoProjectInvoke,
} from '../../src/renderer/features/demo-project-port.js'

/** 与 `packages/contracts/src/ids.ts:56` 的 `ID_PATTERN` 一致（这里独立写一份，避免复用实现）。 */
const ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/

type StepName = 'createProject' | 'createDocument' | 'saveDraft' | 'deleteProject'

interface RecordedCall {
  readonly step: StepName
  /** `createDocument` 的 kind；其它步骤为 null。 */
  readonly kind: string | null
  readonly input: unknown
  readonly output: unknown
  readonly ok: boolean
}

interface FakeOptions {
  /** 第 n 次 `saveDraft`（从 1 开始）返回 `REVISION_CONFLICT`。 */
  readonly failSaveDraftOrdinal?: number
  readonly failCreateProject?: boolean
  readonly failDeleteProject?: boolean
  /** `createProject` 直接抛异常。 */
  readonly throwOnCreateProject?: Error
}

interface FakeInvoke {
  readonly invoke: DemoProjectInvoke
  readonly calls: RecordedCall[]
  /** documentId → 该次 `createDocument` 返回的 revision。 */
  readonly revisions: Map<string, string>
}

function brand<T>(value: string): T {
  return value as unknown as T
}

function errorPayload(code: ErrorPayload['code'], message: string): ErrorPayload {
  return {
    code,
    message,
    requestId: brand<ErrorPayload['requestId']>('req_fake'),
    severity: 'error',
    retryable: false,
  }
}

/** 取对象的字段（入参形状断言用，避免到处写类型转换）。 */
function fields(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

/** 手写假 invoke：记录每次调用与返回值，可按序号注入失败。 */
function createFakeInvoke(options: FakeOptions = {}): FakeInvoke {
  const calls: RecordedCall[] = []
  const revisions = new Map<string, string>()
  let projectSeq = 0
  let documentSeq = 0
  let saveDraftSeq = 0

  const record = (call: RecordedCall): void => {
    calls.push(call)
  }

  const invoke: DemoProjectInvoke = {
    async createProject(input: ProjectCreateInput): Promise<Result<ProjectCreateOutput>> {
      if (options.throwOnCreateProject !== undefined) {
        record({ step: 'createProject', kind: null, input, output: null, ok: false })
        throw options.throwOnCreateProject
      }
      if (options.failCreateProject === true) {
        record({ step: 'createProject', kind: null, input, output: null, ok: false })
        return { ok: false, error: errorPayload('VALIDATION_FAILED', '作品名太长') }
      }
      projectSeq += 1
      const projectId = `prj_fake${projectSeq}`
      const output = {
        projectId: brand<ProjectCreateOutput['projectId']>(projectId),
        revision: brand<ProjectCreateOutput['revision']>(`rev_prj${projectSeq}`),
      }
      record({ step: 'createProject', kind: null, input, output, ok: true })
      return { ok: true, value: output }
    },

    async createDocument(input: DocumentCreateInput): Promise<Result<DocumentCreateOutput>> {
      documentSeq += 1
      const documentId = `doc_fake${documentSeq}`
      const revision = `rev_doc${documentSeq}`
      const output = {
        documentId: brand<DocumentCreateOutput['documentId']>(documentId),
        revision: brand<DocumentCreateOutput['revision']>(revision),
        orderKey: `ord_fake${documentSeq}`,
      }
      revisions.set(documentId, revision)
      record({ step: 'createDocument', kind: input.kind, input, output, ok: true })
      return { ok: true, value: output }
    },

    async saveDraft(input: SaveDraftInput): Promise<Result<SaveDraftOutput>> {
      saveDraftSeq += 1
      if (options.failSaveDraftOrdinal === saveDraftSeq) {
        record({ step: 'saveDraft', kind: null, input, output: null, ok: false })
        return { ok: false, error: errorPayload('REVISION_CONFLICT', '文档已被其它会话修改') }
      }
      const output = {
        revision: brand<SaveDraftOutput['revision']>(`rev_draft${saveDraftSeq}`),
        draftSequence: input.draftSequence,
        charCount: input.body.length,
        savedAt: brand<SaveDraftOutput['savedAt']>('2026-01-01T00:00:00.000Z'),
      }
      record({ step: 'saveDraft', kind: null, input, output, ok: true })
      return { ok: true, value: output }
    },

    async deleteProject(input: ProjectDeleteInput): Promise<Result<ProjectDeleteOutput>> {
      if (options.failDeleteProject === true) {
        record({ step: 'deleteProject', kind: null, input, output: null, ok: false })
        return { ok: false, error: errorPayload('NOT_FOUND_PROJECT', '作品不存在') }
      }
      const output = {
        projectId: input.projectId,
        revision: brand<ProjectDeleteOutput['revision']>('rev_deleted'),
      }
      record({ step: 'deleteProject', kind: null, input, output, ok: true })
      return { ok: true, value: output }
    },
  }

  return { invoke, calls, revisions }
}

function createDeps(invoke: DemoProjectInvoke): DemoProjectDeps {
  let requestSeq = 0
  return {
    invoke,
    workspaceId: 'ws_local',
    newRequestId: () => {
      requestSeq += 1
      return `req_fake${requestSeq}`
    },
    newSessionId: () => 'demo_session_fake',
  }
}

/** 规模压到 3 章，断言好读；规模从种子算出来，不写死数字。 */
function smallSeed(): DemoProjectSeed {
  return buildDemoProjectSeed({ maxChapters: 3 })
}

function chaptersOf(seed: DemoProjectSeed): number {
  return seed.volumes.reduce((total, volume) => total + volume.chapters.length, 0)
}

function callsOf(fake: FakeInvoke, step: StepName): RecordedCall[] {
  return fake.calls.filter((call) => call.step === step)
}

describe('createDemoProjectWith 成功路径', () => {
  it('调用顺序是 1 次建作品 → 每卷 1 次卷 → 每章 1 次章 → 每章 1 次正文，且没有多余调用', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    const result = await createDemoProjectWith(seed, createDeps(fake.invoke))

    const expected: string[] = ['createProject']
    for (let index = 0; index < seed.volumes.length; index += 1) {
      expected.push('createDocument:volume')
    }
    for (let index = 0; index < chaptersOf(seed); index += 1) {
      expected.push('createDocument:chapter', 'saveDraft')
    }

    expect(result.ok).toBe(true)
    expect(
      fake.calls.map((call) =>
        call.step === 'createDocument' ? `createDocument:${call.kind ?? ''}` : call.step,
      ),
    ).toEqual(expected)
  })

  it('每个章节的 parentId 都等于它所属那一卷的 documentId', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const volumeCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'volume')
    const chapterCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'chapter')
    const expected = seed.volumes.flatMap((volume, volumeIndex) =>
      volume.chapters.map(() => fields(volumeCalls[volumeIndex]?.output)['documentId']),
    )

    expect(chapterCalls.map((call) => fields(call.input)['parentId'])).toEqual(expected)
  })

  it('多卷时章节挂到各自那一卷，且幂等键跨卷仍不重复', async () => {
    // 单卷种子测不出「卷间串台」，这里手写两卷把父子映射与键唯一性一起压住。
    const seed: DemoProjectSeed = {
      name: '两卷测试',
      summary: '摘要',
      volumes: [
        {
          title: '第一卷',
          chapters: [
            { title: '第1章', body: '正文一' },
            { title: '第2章', body: '正文二' },
          ],
        },
        {
          title: '第二卷',
          chapters: [{ title: '第3章', body: '正文三' }],
        },
      ],
    }
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const volumeCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'volume')
    const chapterCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'chapter')
    const volumeIds = volumeCalls.map((call) => fields(call.output)['documentId'])
    const keys = fake.calls
      .filter((call) => call.step === 'createDocument' || call.step === 'saveDraft')
      .map((call) => fields(fields(call.input)['context'])['idempotencyKey'])

    expect({
      parents: chapterCalls.map((call) => fields(call.input)['parentId']),
      volumeIds,
      uniqueKeys: new Set(keys).size === keys.length,
      // 先把所有卷建出来，再逐章「建一章 → 立刻写正文」。
      order: fake.calls.map((call) =>
        call.step === 'createDocument' ? `createDocument:${call.kind ?? ''}` : call.step,
      ),
    }).toEqual({
      parents: [volumeIds[0], volumeIds[0], volumeIds[1]],
      volumeIds,
      uniqueKeys: true,
      order: [
        'createProject',
        'createDocument:volume',
        'createDocument:volume',
        'createDocument:chapter',
        'saveDraft',
        'createDocument:chapter',
        'saveDraft',
        'createDocument:chapter',
        'saveDraft',
      ],
    })
  })

  it('写操作的 context.projectId 与 projectId 参数一致（否则应用层报权限不匹配）', async () => {
    const fake = createFakeInvoke()

    await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    const projectId = fields(callsOf(fake, 'createProject')[0]?.output)['projectId']
    const writes = fake.calls.filter(
      (call) => call.step === 'createDocument' || call.step === 'saveDraft',
    )

    expect({
      count: writes.length,
      mismatches: writes.filter(
        (call) =>
          fields(call.input)['projectId'] !== undefined &&
          fields(fields(call.input)['context'])['projectId'] !== projectId,
      ).length,
    }).toEqual({ count: writes.length, mismatches: 0 })
  })

  it('卷章标题与章节正文都逐字来自种子', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const volumeCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'volume')
    const chapterCalls = callsOf(fake, 'createDocument').filter((call) => call.kind === 'chapter')
    const draftCalls = callsOf(fake, 'saveDraft')

    expect(volumeCalls.map((call) => fields(call.input)['title'])).toEqual(
      seed.volumes.map((volume) => volume.title),
    )
    expect(chapterCalls.map((call) => fields(call.input)['title'])).toEqual(
      seed.volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.title)),
    )
    expect(draftCalls.map((call) => fields(call.input)['body'])).toEqual(
      seed.volumes.flatMap((volume) => volume.chapters.map((chapter) => chapter.body)),
    )
  })

  it('createProject 用种子的名字与简介、templateId full，并且 seedFirstChapter 为 false', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const input = fields(callsOf(fake, 'createProject')[0]?.input)

    expect(input).toMatchObject({
      name: seed.name,
      summary: seed.summary,
      templateId: 'full',
      seedFirstChapter: false,
    })
    expect(fields(input['context'])).toMatchObject({
      workspaceId: 'ws_local',
      projectId: null,
      expectedRevision: null,
    })
  })

  it('saveDraft 的 expectedRevision 等于该章 createDocument 返回的 revision（不是 null）', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const drafts = callsOf(fake, 'saveDraft').map((call) => ({
      documentId: fields(call.input)['documentId'],
      expectedRevision: fields(fields(call.input)['context'])['expectedRevision'],
    }))

    // 假 invoke 只给「确实建过的文档」记录 revision（新建时是 null 的话就取不到），
    // 所以 mismatches 为空同时证明了：expectedRevision 非 null、且等于该文档的建出结果。
    expect({
      count: drafts.length,
      mismatches: drafts.filter(
        (draft) => draft.expectedRevision !== fake.revisions.get(String(draft.documentId)),
      ),
    }).toEqual({ count: chaptersOf(seed), mismatches: [] })
  })

  it('saveDraft 用注入的会话 id，且每章都是首次草稿（draftSequence 1）', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const draftInputs = callsOf(fake, 'saveDraft').map((call) => fields(call.input))

    expect(draftInputs.map((input) => input['sessionId'])).toEqual(
      draftInputs.map(() => 'demo_session_fake'),
    )
    expect(draftInputs.map((input) => input['draftSequence'])).toEqual(
      draftInputs.map(() => 1),
    )
  })

  it('每个写操作都带幂等键，键符合 ID_PATTERN、不含 ..、且互不重复', async () => {
    const seed = smallSeed()
    const fake = createFakeInvoke()

    await createDemoProjectWith(seed, createDeps(fake.invoke))

    const writes = fake.calls.filter(
      (call) => call.step === 'createDocument' || call.step === 'saveDraft',
    )
    const keys = writes
      .map((call) => fields(fields(call.input)['context'])['idempotencyKey'])
      .filter((key): key is string => typeof key === 'string')

    expect(keys).toHaveLength(writes.length)
    expect(keys.every((key) => ID_PATTERN.test(key) && !key.includes('..'))).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('createDemoProjectWith 失败与回滚', () => {
  it('第 2 章 saveDraft 失败时，返回原始错误码 REVISION_CONFLICT', async () => {
    const fake = createFakeInvoke({ failSaveDraftOrdinal: 2 })

    const result = await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
  })

  it('第 2 章 saveDraft 失败时，回滚一次 deleteProject，删除的正是这次建出的作品', async () => {
    const fake = createFakeInvoke({ failSaveDraftOrdinal: 2 })

    await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    const createdProjectId = fields(callsOf(fake, 'createProject')[0]?.output)['projectId']

    expect(callsOf(fake, 'deleteProject').map((call) => fields(call.input)['projectId'])).toEqual([
      createdProjectId,
    ])
  })

  it('回滚发生在失败之后（deleteProject 是最后一次调用）', async () => {
    const fake = createFakeInvoke({ failSaveDraftOrdinal: 2 })

    await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    expect(fake.calls[fake.calls.length - 1]?.step).toBe('deleteProject')
  })

  it('回滚也失败时，文案仍保留原始错误，并提示清理未完成', async () => {
    const fake = createFakeInvoke({ failSaveDraftOrdinal: 1, failDeleteProject: true })

    const result = await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))
    const message = result.ok ? '' : result.message

    expect(result).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' })
    expect(message).toContain('REVISION_CONFLICT')
    expect(message).toContain('清理未完成')
  })

  it('createProject 失败时直接返回失败，且不去删任何作品', async () => {
    const fake = createFakeInvoke({ failCreateProject: true })

    const result = await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(callsOf(fake, 'deleteProject')).toHaveLength(0)
  })

  it('建卷失败时也回滚（任何一步失败都不能留下半成品）', async () => {
    const fake = createFakeInvoke()
    // 让第 1 次建卷失败：包一层，只对 volume 返回错误。
    const failing: DemoProjectInvoke = {
      ...fake.invoke,
      createDocument: async (input) =>
        input.kind === 'volume'
          ? { ok: false, error: errorPayload('VALIDATION_FAILED', '标题太长') }
          : fake.invoke.createDocument(input),
    }

    const result = await createDemoProjectWith(smallSeed(), createDeps(failing))

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(callsOf(fake, 'deleteProject')).toHaveLength(1)
  })

  it('invoke.createProject 抛异常时折算成 INTERNAL_ERROR，编排本身不抛', async () => {
    const fake = createFakeInvoke({ throwOnCreateProject: new Error('ipc 断了') })

    const result = await createDemoProjectWith(smallSeed(), createDeps(fake.invoke))

    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' })
    expect(result.ok ? '' : result.message).toContain('ipc 断了')
  })
})

describe('createDemoProject 工厂', () => {
  it('连续调用两次都真的新建作品（不做「已存在就跳过」的优化），两次拿到不同作品 id', async () => {
    const fake = createFakeInvoke()
    const create = createDemoProject(createDeps(fake.invoke))

    const first = await create()
    const second = await create()
    const ids = [first, second].map((result) => (result.ok ? result.value.projectId : ''))

    expect(callsOf(fake, 'createProject')).toHaveLength(2)
    expect(ids.every((id) => id.startsWith('prj_'))).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('缺省种子下把每一章正文都写进去（章数从种子算，不写死 21）', async () => {
    const fake = createFakeInvoke()
    const create = createDemoProject(createDeps(fake.invoke))

    await create()

    const seed = buildDemoProjectSeed()

    expect(callsOf(fake, 'saveDraft')).toHaveLength(chaptersOf(seed))
  })

  it('两次编排的幂等键集合完全不相交（否则第二次会静默复用第一次的卷章）', async () => {
    const fake = createFakeInvoke()
    const create = createDemoProject(createDeps(fake.invoke))
    const keysBetween = (from: number, to: number): string[] =>
      fake.calls
        .slice(from, to)
        .filter((call) => call.step === 'createDocument' || call.step === 'saveDraft')
        .map((call) => String(fields(fields(call.input)['context'])['idempotencyKey']))

    await create()
    const boundary = fake.calls.length
    await create()
    const first = keysBetween(0, boundary)
    const second = keysBetween(boundary, fake.calls.length)

    expect({
      firstCount: first.length,
      secondCount: second.length,
      shared: first.filter((key) => second.includes(key)),
    }).toEqual({ firstCount: second.length, secondCount: second.length, shared: [] })
  })
})
