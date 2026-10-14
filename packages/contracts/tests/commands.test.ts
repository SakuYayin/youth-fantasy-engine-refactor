/**
 * commands 契约测试（桌面 IPC 与后端 HTTP **共用**的命令语义）。
 *
 * 为什么主力是"编译期断言"而不是运行时值：`src/commands/index.ts` 里
 * 一个运行时值都没有——它全是接口与类型。字段被删、被改成可选、两个分支被
 * 合并成一个"什么都可以塞"的接口——这些回归在运行时一个字都看不出来，
 * 只会在半年后表现为"某个客户端编译不过"或者"悄悄接受了矛盾输入"。
 * 因此本文件的断言分三层：
 *
 * 1. `Assert<...>` / `ExpectFalse<...>`：类型层必须成立（含"键恰好是这几个"）；
 * 2. `@ts-expect-error`：类型层必须**拒绝**的写法（负向测试）；
 * 3. `Object.keys`：样本对象在运行时确实只有契约列出的键。
 *
 * 🔴 第 1 层故意写得很紧（`KeysExactly`）：契约包已冻结，任何新增字段都必须走评审，
 * 本文件就是那个触发器。若某天它红了，先去确认是不是有人绕过评审改了契约形状。
 */

import { describe, expect, it } from 'vitest'

import { encodeCursor, encodeRevision, fixedClock, newIds } from '../src/ids.js'
import type { Cursor, IdempotencyKey } from '../src/ids.js'
import type {
  DocumentCreateInput,
  DocumentGetOutput,
  DocumentTreeInput,
  DocumentTreeOutput,
  JobCancelOutput,
  PageRequest,
  PageResult,
  ReadContext,
  SaveDraftInput,
  SaveDraftOutput,
  SystemStatusOutput,
  WriteContext,
} from '../src/commands/index.js'

// ---------------------------------------------------------------------------
// 编译期断言工具
// ---------------------------------------------------------------------------

/** 条件必须为 `true`，否则这一行编译不过。 */
type Assert<T extends true> = T
/** 条件必须为 `false`（用于"某字段不存在"这类断言）。 */
type ExpectFalse<T extends false> = T
/** `A` 与 `B` 必须是同一个类型（双向 extends，避免只检查一边）。 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** `T` 的键必须**恰好**是 `K`：多一个或少一个都编译失败。 */
type KeysExactly<T, K extends PropertyKey> = [keyof T] extends [K] ? ([K] extends [keyof T] ? true : false) : false
/** `K` 是 `T` 的键吗（存在性）。 */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false
/** `T` 的**必填**键（可选字段会被 `undefined` 检出并剔除）。 */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]
/** `K` 在 `T` 里是必填的吗。 */
type IsRequired<T, K extends keyof T> = K extends RequiredKeys<T> ? true : false

// ---------------------------------------------------------------------------
// 样本数据
// ---------------------------------------------------------------------------

const workspaceId = newIds.workspace()
const projectId = newIds.project()
const documentId = newIds.document()
const siblingId = newIds.document()
const requestId = newIds.request()
const now = fixedClock('2026-10-15T02:00:00.000Z').now()
const revision1 = encodeRevision(1)
const revision2 = encodeRevision(2)

/** 修改既有实体时的写入上下文：必须带上"我以为的当前版本"。 */
const writeContext: WriteContext = {
  requestId,
  workspaceId,
  projectId,
  expectedRevision: revision1,
}

// ---------------------------------------------------------------------------
// WriteContext / ReadContext
// ---------------------------------------------------------------------------

describe('WriteContext / ReadContext', () => {
  it('🔴 ReadContext 里根本没有 projectId / expectedRevision / idempotencyKey', () => {
    // 只读命令不该要求客户端声明"期望版本"：读取永远不该产生版本冲突，
    // 也不该被幂等键去重（读两次必须真的读两次）。
    type _noProjectId = ExpectFalse<HasKey<ReadContext, 'projectId'>>
    type _noExpectedRevision = ExpectFalse<HasKey<ReadContext, 'expectedRevision'>>
    type _noIdempotencyKey = ExpectFalse<HasKey<ReadContext, 'idempotencyKey'>>
    type _exact = Assert<KeysExactly<ReadContext, 'requestId' | 'workspaceId'>>
    type _allRequired = Assert<Exactly<RequiredKeys<ReadContext>, 'requestId' | 'workspaceId'>>

    const ctx: ReadContext = { requestId, workspaceId }
    expect(Object.keys(ctx).sort()).toEqual(['requestId', 'workspaceId'])
    expect(Object.keys(ctx)).not.toContain('expectedRevision')
    expect(Object.keys(ctx)).not.toContain('projectId')
  })

  it('WriteContext 四项必填，幂等键可选', () => {
    type _required = Assert<
      Exactly<RequiredKeys<WriteContext>, 'requestId' | 'workspaceId' | 'projectId' | 'expectedRevision'>
    >
    type _idempotencyOptional = ExpectFalse<IsRequired<WriteContext, 'idempotencyKey'>>
    type _expectedRevisionNeedsNull = Assert<Exactly<WriteContext['expectedRevision'], typeof revision1 | null>>
    type _projectIdNeedsNull = Assert<Exactly<WriteContext['projectId'], typeof projectId | null>>

    expect(Object.keys(writeContext).sort()).toEqual(['expectedRevision', 'projectId', 'requestId', 'workspaceId'])

    const withKey: WriteContext = { ...writeContext, idempotencyKey: 'idem_0001' as IdempotencyKey }
    expect(Object.keys(withKey)).toContain('idempotencyKey')

    // 新建实体没有"当前版本"：传 null 而不是省略字段（省略会让"忘了传"和"确实没有"无法区分）。
    const creating: WriteContext = { requestId, workspaceId, projectId: null, expectedRevision: null }
    expect(creating.expectedRevision).toBeNull()
    expect(creating.projectId).toBeNull()
  })

  it('只读上下文多传一个写入字段就必须编译失败（负向测试）', () => {
    // @ts-expect-error projectId 不属于 ReadContext：对象字面量多余属性检查必须拦下它
    const readWithProject: ReadContext = { requestId, workspaceId, projectId }
    // 运行时没有任何东西拦住它——守门只在类型层，所以服务端仍必须拒绝未知字段
    // （VALIDATION_UNKNOWN_FIELD），不能因为"多一个字段"就当成写入命令处理。
    expect(Object.keys(readWithProject)).toContain('projectId')
  })
})

// ---------------------------------------------------------------------------
// 草稿保存（本项目最关键的一条命令）
// ---------------------------------------------------------------------------

describe('SaveDraft', () => {
  it('SaveDraftInput / SaveDraftOutput 的键恰好是契约列出的那几个', () => {
    type _in = Assert<KeysExactly<SaveDraftInput, 'context' | 'documentId' | 'draftSequence' | 'body' | 'sessionId'>>
    type _out = Assert<KeysExactly<SaveDraftOutput, 'revision' | 'draftSequence' | 'charCount' | 'savedAt'>>
    type _inAllRequired = Assert<
      Exactly<RequiredKeys<SaveDraftInput>, 'context' | 'documentId' | 'draftSequence' | 'body' | 'sessionId'>
    >

    const input: SaveDraftInput = {
      context: writeContext,
      documentId,
      draftSequence: 42,
      body: '第一章 正文',
      sessionId: 'sess_a',
    }
    // 注意 sort() 按 UTF-16 码元排序：'documentId' 排在 'draftSequence' 之前（do < dr）。
    expect(Object.keys(input).sort()).toEqual(['body', 'context', 'documentId', 'draftSequence', 'sessionId'])

    const output: SaveDraftOutput = { revision: revision2, draftSequence: 42, charCount: 6, savedAt: now }
    expect(Object.keys(output).sort()).toEqual(['charCount', 'draftSequence', 'revision', 'savedAt'])
    expect(output.charCount).toBe(input.body.length)
  })

  it('draftSequence 必填，且它是"迟到回包不覆盖新稿"的唯一依据（负向测试）', () => {
    // @ts-expect-error draftSequence 必填：缺了它，客户端只能靠回包到达顺序判新旧
    const withoutSequence: SaveDraftInput = { context: writeContext, documentId, body: '正文', sessionId: 'sess_a' }
    // 运行时它照样构造成功，但 draftSequence 是 undefined：
    expect(Object.keys(withoutSequence)).not.toContain('draftSequence')
    // @ts-expect-error 缺字段的样本再赋给完整类型必须被拒绝
    const broken: SaveDraftOutput = { revision: revision2, charCount: 6, savedAt: now }
    expect(broken).toBeDefined()
  })

  it('迟到回包按 draftSequence 判新旧，绝不按到达顺序或时间戳', () => {
    // 场景：先发的 41 后到，后发的 42 先到（网络乱序）。
    const lateArrival: SaveDraftOutput = { revision: revision1, draftSequence: 41, charCount: 3, savedAt: now }
    const alreadyConfirmed: SaveDraftOutput = { revision: revision2, draftSequence: 42, charCount: 6, savedAt: now }

    // 两个回包的 savedAt 完全相同：用时间戳判新旧在这里直接失效（设备时钟本来就不可信）。
    expect(lateArrival.savedAt).toBe(alreadyConfirmed.savedAt)

    // 正确做法：水位线只取更大的 draftSequence，更旧的回包整包丢弃。
    const watermark = (a: SaveDraftOutput, b: SaveDraftOutput): SaveDraftOutput =>
      a.draftSequence >= b.draftSequence ? a : b
    expect(watermark(alreadyConfirmed, lateArrival)).toBe(alreadyConfirmed)
    expect(watermark(alreadyConfirmed, lateArrival).revision).toBe(revision2)
  })
})

// ---------------------------------------------------------------------------
// 文档创建：placement 是判别联合
// ---------------------------------------------------------------------------

describe('DocumentCreateInput.placement', () => {
  it('"末位"与"某节点之后"是两个互斥分支', () => {
    type EndVariant = Extract<DocumentCreateInput['placement'], { readonly mode: 'end' }>
    type AfterVariant = Extract<DocumentCreateInput['placement'], { readonly mode: 'after' }>
    type _end = Assert<KeysExactly<EndVariant, 'mode'>>
    type _after = Assert<KeysExactly<AfterVariant, 'mode' | 'afterId'>>
    type _onlyTwo = Assert<Exactly<DocumentCreateInput['placement'], EndVariant | AfterVariant>>

    const atEnd: DocumentCreateInput['placement'] = { mode: 'end' }
    const afterSibling: DocumentCreateInput['placement'] = { mode: 'after', afterId: siblingId }

    expect(atEnd.mode).toBe('end')
    expect(afterSibling.mode).toBe('after')

    // 收窄：只有 mode === 'after' 时才存在 afterId（可读性由此保证）。
    if (afterSibling.mode === 'after') expect(afterSibling.afterId).toBe(siblingId)

    // 反证：'end' 分支里根本没有 afterId 这个键，因此不可能出现"末位 + afterId"的矛盾输入。
    expect('afterId' in atEnd).toBe(false)
    expect(Object.keys(atEnd)).toEqual(['mode'])
  })

  it('矛盾输入 { mode: "end", afterId } 必须编译失败（负向测试）', () => {
    // 这就是为什么用判别联合而不是 `{ mode: 'end' | 'after'; afterId?: DocumentId }`：
    // 可选字段会让下面这种自相矛盾的输入通过编译，服务端只能靠运行期校验兜底。
    // @ts-expect-error 'end' 分支没有 afterId：多余属性检查必须拦下它
    const contradictory: DocumentCreateInput['placement'] = { mode: 'end', afterId: documentId }
    // 运行时它完全合法（mode 为 'end'），所以这个矛盾只可能被类型层挡住：
    expect(contradictory.mode).toBe('end')
  })
})

// ---------------------------------------------------------------------------
// 任务取消：cancelling 不是终态
// ---------------------------------------------------------------------------

describe('JobCancelOutput', () => {
  it('status 恰好三态，cancelling 与 cancelled 必须分开', () => {
    type _exact = Assert<Exactly<JobCancelOutput['status'], 'cancelling' | 'cancelled' | 'already-terminal'>>
    type _onlyStatus = Assert<KeysExactly<JobCancelOutput, 'status'>>

    const requested: JobCancelOutput = { status: 'cancelling' }
    const confirmed: JobCancelOutput = { status: 'cancelled' }
    const tooLate: JobCancelOutput = { status: 'already-terminal' }

    // 取消是**请求**不是事实（08-任务与AI.md）：收到 cancelling 时任务还在跑，
    // 不得清理执行器、不得删检查点、不得把 outbox 里的结果当已废弃。
    // 只有执行器确认或租约失效处理后才是终态。
    expect(requested.status).not.toBe(confirmed.status)
    expect(tooLate.status).not.toBe(confirmed.status)

    const allStatuses: readonly JobCancelOutput['status'][] = ['cancelling', 'cancelled', 'already-terminal']
    expect(allStatuses).toHaveLength(3)
    expect(new Set(allStatuses).size).toBe(3)
    expect(allStatuses).toContain(requested.status)
  })
})

// ---------------------------------------------------------------------------
// 系统状态：版本号分别管理
// ---------------------------------------------------------------------------

describe('SystemStatusOutput', () => {
  it('五个版本号同时存在且彼此独立（应用 / 库 Schema / 同步协议 / 插件 API / 资源模板）', () => {
    type _app = Assert<Exactly<SystemStatusOutput['appVersion'], string>>
    type _schema = Assert<Exactly<SystemStatusOutput['databaseSchemaVersion'], number>>
    type _sync = Assert<Exactly<SystemStatusOutput['syncProtocolVersion'], { readonly major: number; readonly minor: number }>>
    type _plugin = Assert<Exactly<SystemStatusOutput['pluginApiVersion'], string>>
    type _template = Assert<Exactly<SystemStatusOutput['resourceTemplateVersion'], string | null>>
    // 必填键恰好这 9 个：新增**必填**字段会打破它（可选字段不受影响，符合"只能新增可选字段"的兼容规则）。
    type _required = Assert<
      Exactly<
        RequiredKeys<SystemStatusOutput>,
        | 'appVersion'
        | 'databaseSchemaVersion'
        | 'syncProtocolVersion'
        | 'pluginApiVersion'
        | 'resourceTemplateVersion'
        | 'databasePath'
        | 'readOnly'
        | 'lastSavedAt'
        | 'pendingOutboxCount'
      >
    >

    const status: SystemStatusOutput = {
      appVersion: '4.0.0-dev.0',
      databaseSchemaVersion: 1,
      syncProtocolVersion: { major: 1, minor: 0 },
      pluginApiVersion: '1.0.0',
      resourceTemplateVersion: null,
      databasePath: 'D:\\data\\yfe',
      readOnly: false,
      lastSavedAt: now,
      pendingOutboxCount: 3,
    }

    // 01-总体架构.md：这些版本必须"分别管理"。用一个字段糊住全部版本，
    // 表现就是"程序版本变了却去动数据库迁移判断"。类型各不相同是刻意的防线。
    //
    // 资源模板版本与插件 API 版本是**两件事**：pluginApiVersion 是插件宿主 API 的
    // 兼容契约，resourceTemplateVersion 是内容包（主题/模板/工作流包）的修订号，
    // 二者独立演进。未装载任何模板包时为 null，而不是空字符串——
    // 空字符串会被误读成"装载了一个版本号为空的包"。
    expect(typeof status.appVersion).toBe('string')
    expect(Number.isInteger(status.databaseSchemaVersion)).toBe(true)
    expect(typeof status.pluginApiVersion).toBe('string')
    expect(status.resourceTemplateVersion).toBeNull()
    expect(status.syncProtocolVersion.major).toBeGreaterThanOrEqual(1)

    const versionKeys = Object.keys(status).filter((k) => k.toLowerCase().includes('version'))
    expect(versionKeys.sort()).toEqual([
      'appVersion',
      'databaseSchemaVersion',
      'pluginApiVersion',
      'resourceTemplateVersion',
      'syncProtocolVersion',
    ])
  })

  it('readOnly 与 pendingOutboxCount 是"待同步角标 / 只读提示"的唯一数据源', () => {
    type _readOnly = Assert<Exactly<SystemStatusOutput['readOnly'], boolean>>
    type _pending = Assert<Exactly<SystemStatusOutput['pendingOutboxCount'], number>>
    type _lastSavedNullable = Assert<Exactly<SystemStatusOutput['lastSavedAt'], typeof now | null>>

    const empty: SystemStatusOutput = {
      appVersion: '4.0.0-dev.0',
      databaseSchemaVersion: 1,
      syncProtocolVersion: { major: 1, minor: 0 },
      pluginApiVersion: '1.0.0',
      resourceTemplateVersion: null,
      databasePath: 'D:\\data\\yfe',
      readOnly: true,
      lastSavedAt: null,
      pendingOutboxCount: 0,
    }
    // 从未保存过 + 只读：角标必须是 0 而不是被省略成 undefined。
    expect(empty.lastSavedAt).toBeNull()
    expect(empty.pendingOutboxCount).toBe(0)
    expect(empty.readOnly).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

describe('PageResult<T>', () => {
  it('items + nextCursor，最后一页的 nextCursor 为 null', () => {
    type _items = Assert<Exactly<PageResult<string>['items'], readonly string[]>>
    type _cursor = Assert<Exactly<PageResult<string>['nextCursor'], Cursor | null>>
    type _exact = Assert<KeysExactly<PageResult<string>, 'items' | 'nextCursor'>>

    const lastPage: PageResult<string> = { items: ['第一章', '第二章'], nextCursor: null }
    const nextPage: PageResult<string> = { items: [], nextCursor: encodeCursor(20, 'ws_main') }

    // noUncheckedIndexedAccess 已开启：items[0] 的类型是 string | undefined，必须先证明存在。
    const first = lastPage.items[0]
    if (first === undefined) throw new Error('样本不该为空页')
    expect(first).toBe('第一章')
    expect(lastPage.items).toHaveLength(2)

    // null 是"已到末尾"的唯一表示：不得用空串、-1 或"没有该字段"来表达。
    expect(lastPage.nextCursor).toBeNull()
    expect(nextPage.nextCursor).not.toBeNull()
    // 游标是不透明字符串，禁止数值化（可能超出安全整数范围）。
    expect(typeof nextPage.nextCursor).toBe('string')
    expect(nextPage.nextCursor).toBe(encodeCursor(20, 'ws_main'))
  })

  it('PageRequest 的 cursor/limit 都是可选的，且 limit 只是"期望值"', () => {
    type _optional = ExpectFalse<IsRequired<PageRequest, 'cursor'>>
    type _optionalLimit = ExpectFalse<IsRequired<PageRequest, 'limit'>>

    const first: PageRequest = {}
    // 上限最终由服务端 capabilities 决定；客户端请求 1000 不代表能拿到 1000。
    const greedy: PageRequest = { cursor: encodeCursor(20, 'ws_main'), limit: 1000 }
    expect(Object.keys(first)).toHaveLength(0)
    expect(greedy.limit).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// 文档树：绝不带正文
// ---------------------------------------------------------------------------

describe('DocumentTreeOutput', () => {
  it('🔴 树里没有 body，也没有 workspaceId（1000 章的正文不能随树接口返回）', () => {
    type Summary = DocumentTreeOutput['documents'][number]
    type _noBody = ExpectFalse<HasKey<Summary, 'body'>>
    type _noWorkspaceId = ExpectFalse<HasKey<Summary, 'workspaceId'>>
    type _hasCharCount = Assert<HasKey<Summary, 'charCount'>>
    type _hasChildrenFlag = Assert<HasKey<Summary, 'hasChildren'>>
    type _exactOutput = Assert<KeysExactly<DocumentTreeOutput, 'documents'>>

    const summary: Summary = {
      id: documentId,
      projectId,
      kind: 'chapter',
      parentId: null,
      orderKey: 'a0',
      title: '第一章 落雪',
      revision: revision1,
      deleted: 0,
      createdAt: now,
      updatedAt: now,
      // 字数与"有没有子节点"由服务端算好：列表要能显示字数但不能带正文。
      charCount: 3210,
      hasChildren: false,
    }

    // 运行时同样证明：正文字段不是"可选"，而是根本不存在。
    expect('body' in summary).toBe(false)
    expect(Object.keys(summary)).not.toContain('body')
    expect(Object.keys(summary)).not.toContain('workspaceId')
    expect(summary.charCount).toBe(3210)

    // 对照：单篇读取接口**才**带正文——正文只走"点开某一章"这条路。
    type _getHasBody = Assert<HasKey<DocumentGetOutput, 'body'>>
    type _getKeys = Assert<KeysExactly<DocumentGetOutput, 'document' | 'body'>>

    const tree: DocumentTreeOutput = { documents: [summary] }
    expect(tree.documents).toHaveLength(1)
    expect(tree.documents).not.toHaveProperty('body')
  })

  it('includeDeleted 可选：回收站视图不是默认行为', () => {
    type _optional = ExpectFalse<IsRequired<DocumentTreeInput, 'includeDeleted'>>
    const normal: DocumentTreeInput = { context: { requestId, workspaceId }, projectId }
    const recycleBin: DocumentTreeInput = { context: { requestId, workspaceId }, projectId, includeDeleted: true }
    // 默认只返回未删除节点：墓碑（deleted !== 0）绝不能混进正常列表。
    expect(Object.keys(normal)).toEqual(['context', 'projectId'])
    expect(recycleBin.includeDeleted).toBe(true)
  })
})
