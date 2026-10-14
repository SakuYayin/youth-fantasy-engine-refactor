/**
 * entities 契约测试。
 *
 * 这里测的不是构造函数的 happy path，而是**判定语义**：
 * `deleted` 的比较方式决定墓碑能否挡住已删数据，`DocumentSummary` 的字段形状
 * 决定列表接口会不会把整本正文传一遍，角色矩阵决定谁能改别人的作品、谁能下发
 * 远程命令。类型层面的断言与运行时断言同等重要——形状一旦漂移，光靠运行时
 * 断言是拦不住的（见 `docs/契约速查.md` 第 9 节「类型安全清单」）。
 */

import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_KINDS,
  TERMINAL_JOB_STATUSES,
  WORKSPACE_ROLES,
  canManageMembers,
  canRunRemoteCommand,
  canWrite,
  isDocumentKind,
  isTerminalJobStatus,
} from '../src/entities/index.js'
import type {
  DeletedFlag,
  Document,
  DocumentKind,
  DocumentSummary,
  JobStatus,
  Project,
  WorkspaceRole,
} from '../src/entities/index.js'
import { encodeRevision, fixedClock, isUtcTimestamp, newIds } from '../src/ids.js'

// ---------------------------------------------------------------------------
// 编译期断言工具
// ---------------------------------------------------------------------------

/** 只有传入 `true` 才能通过类型检查：断言失败会在 `tsc` 阶段直接报错而不是静默通过。 */
type Expect<T extends true> = T

/** 两个类型互相可赋值，即集合相等；多一个成员或少一个成员都会失败。 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// ---------------------------------------------------------------------------
// 文档种类
// ---------------------------------------------------------------------------

describe('DOCUMENT_KINDS / isDocumentKind', () => {
  // 类型层面：字面量联合必须与运行时常量一一对应，否则 isDocumentKind 收窄出的
  // 类型会与存储层能落的值不一致。
  type _KindUnion = Expect<Same<DocumentKind, 'volume' | 'chapter' | 'outline' | 'note'>>
  const kindUnion: _KindUnion = true

  it('完整包含四种文档种类，不多不少', () => {
    // 卷与章统一到同一张表、用 kind 区分，理由见 src/entities/index.ts:92-99：
    // 章节树是任意深度的，两表模型会退化成多态外键。
    expect([...DOCUMENT_KINDS].sort()).toEqual(['chapter', 'note', 'outline', 'volume'])
    expect(DOCUMENT_KINDS).toHaveLength(4)
    expect(kindUnion).toBe(true)
  })

  it('四个合法值全部识别', () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(isDocumentKind(kind)).toBe(true)
    }
  })

  it('🔴 大小写敏感：Volume / CHAPTER 都不是合法种类', () => {
    // 存储层是精确字符串比较；容忍大小写会让同一实体出现两种 kind，
    // 树查询与级联软删会漏掉一半节点。
    expect(isDocumentKind('Volume')).toBe(false)
    expect(isDocumentKind('VOLUME')).toBe(false)
    expect(isDocumentKind('Chapter')).toBe(false)
  })

  it('拒绝空串、空白与近似拼写', () => {
    expect(isDocumentKind('')).toBe(false)
    expect(isDocumentKind(' volume')).toBe(false)
    expect(isDocumentKind('volume ')).toBe(false)
    expect(isDocumentKind('volumes')).toBe(false)
    expect(isDocumentKind('note_')).toBe(false)
  })

  it('非字符串一律拒绝（IPC/HTTP 边界上收到的是 unknown）', () => {
    expect(isDocumentKind(null)).toBe(false)
    expect(isDocumentKind(undefined)).toBe(false)
    expect(isDocumentKind(0)).toBe(false)
    expect(isDocumentKind(123)).toBe(false)
    expect(isDocumentKind(true)).toBe(false)
    expect(isDocumentKind({})).toBe(false)
    expect(isDocumentKind([])).toBe(false)
    expect(isDocumentKind(new String('volume'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 角色权限矩阵
// ---------------------------------------------------------------------------

/** 期望值写死成表，而不是从函数反推：否则实现错了测试会跟着一起错。 */
interface PermissionRow {
  readonly role: WorkspaceRole
  readonly canWrite: boolean
  readonly canManageMembers: boolean
  readonly canRunRemoteCommand: boolean
}

const PERMISSION_MATRIX: readonly PermissionRow[] = [
  { role: 'admin', canWrite: true, canManageMembers: true, canRunRemoteCommand: true },
  { role: 'owner', canWrite: true, canManageMembers: true, canRunRemoteCommand: true },
  { role: 'editor', canWrite: true, canManageMembers: false, canRunRemoteCommand: false },
  { role: 'viewer', canWrite: false, canManageMembers: false, canRunRemoteCommand: false },
]

describe('角色权限矩阵', () => {
  it('矩阵覆盖 WORKSPACE_ROLES 的每个角色且不重复', () => {
    // 契约新增角色时这里会失败，强制补一行期望值——避免「新角色默认拥有全部权限」。
    expect([...PERMISSION_MATRIX].map((row) => row.role).sort()).toEqual([...WORKSPACE_ROLES].sort())
    expect(new Set(PERMISSION_MATRIX.map((row) => row.role)).size).toBe(WORKSPACE_ROLES.length)
  })

  for (const row of PERMISSION_MATRIX) {
    it(`${row.role}: canWrite=${row.canWrite} / canManageMembers=${row.canManageMembers} / canRunRemoteCommand=${row.canRunRemoteCommand}`, () => {
      expect(canWrite(row.role)).toBe(row.canWrite)
      expect(canManageMembers(row.role)).toBe(row.canManageMembers)
      expect(canRunRemoteCommand(row.role)).toBe(row.canRunRemoteCommand)
    })
  }

  it('admin 与 owner 三个权限全为 true', () => {
    for (const role of ['admin', 'owner'] as const) {
      expect(canWrite(role)).toBe(true)
      expect(canManageMembers(role)).toBe(true)
      expect(canRunRemoteCommand(role)).toBe(true)
    }
  })

  it('只有 admin/owner 能管成员与下发远程命令（穷举全部角色）', () => {
    for (const role of WORKSPACE_ROLES) {
      const isPrivileged = role === 'admin' || role === 'owner'
      expect(canManageMembers(role)).toBe(isPrivileged)
      expect(canRunRemoteCommand(role)).toBe(isPrivileged)
    }
  })

  it('🔴 editor 能写正文，但改成员与远程命令都是 false', () => {
    // 最容易发生的提权：把「能改作品内容」与「能改权限 / 能在别人机器上执行命令」混为一谈。
    expect(canWrite('editor')).toBe(true)
    expect(canManageMembers('editor')).toBe(false)
    expect(canRunRemoteCommand('editor')).toBe(false)
  })

  it('🔴 viewer 三个权限全 false（只读角色不得有任何写入口）', () => {
    expect(canWrite('viewer')).toBe(false)
    expect(canManageMembers('viewer')).toBe(false)
    expect(canRunRemoteCommand('viewer')).toBe(false)
  })

  it('不变量：能下发远程命令 ⇒ 能管成员 ⇒ 能写', () => {
    for (const role of WORKSPACE_ROLES) {
      if (canRunRemoteCommand(role)) expect(canManageMembers(role)).toBe(true)
      if (canManageMembers(role)) expect(canWrite(role)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 任务终态
// ---------------------------------------------------------------------------

const ALL_JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'waiting_network',
  'waiting_confirmation',
  'paused',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
]

describe('TERMINAL_JOB_STATUSES / isTerminalJobStatus', () => {
  it('终态恰好是 succeeded | failed | cancelled', () => {
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(['cancelled', 'failed', 'succeeded'])
  })

  it('三个终态返回 true', () => {
    expect(isTerminalJobStatus('succeeded')).toBe(true)
    expect(isTerminalJobStatus('failed')).toBe(true)
    expect(isTerminalJobStatus('cancelled')).toBe(true)
  })

  it('🔴 六个非终态返回 false：等待态不是失败', () => {
    // waiting_network / waiting_confirmation / paused 是**持久等待态**，
    // 重启后必须能恢复执行（src/entities/index.ts:315-321）。
    // 判成终态会让任务被当成「已结束」而永远不再运行，用户看到的是「任务消失」。
    expect(isTerminalJobStatus('queued')).toBe(false)
    expect(isTerminalJobStatus('running')).toBe(false)
    expect(isTerminalJobStatus('waiting_network')).toBe(false)
    expect(isTerminalJobStatus('waiting_confirmation')).toBe(false)
    expect(isTerminalJobStatus('paused')).toBe(false)
    expect(isTerminalJobStatus('cancelling')).toBe(false)
  })

  it('终态集合与状态全集互补：没有漏判，也没有多判', () => {
    const computed = ALL_JOB_STATUSES.filter(isTerminalJobStatus)
    expect(computed.sort()).toEqual([...TERMINAL_JOB_STATUSES].sort())
    expect(ALL_JOB_STATUSES).toHaveLength(9)
    expect(ALL_JOB_STATUSES.length - computed.length).toBe(6)
  })

  it('纯判定：重复调用结果一致，不依赖调用顺序', () => {
    for (const status of ALL_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(isTerminalJobStatus(status))
    }
  })
})

// ---------------------------------------------------------------------------
// 软删除标志
// ---------------------------------------------------------------------------

describe('DeletedFlag 语义', () => {
  it('🔴 判定删除必须用 `!== 0`，不能用真值判断', () => {
    // DeletedFlag = `0 | number`（src/entities/index.ts:42）：0 是唯一表示「存活」的值，
    // 其余任意数字都表示已删除，设计文档明确要求用 `!== 0` 比较。
    const flag: DeletedFlag = 0
    expect(flag !== 0).toBe(false)

    // 真值判断在 0 上恰好也对，所以它看起来「能用」；但脏值会分道扬镳。
    expect(Boolean(flag)).toBe(flag !== 0)
  })

  it('🔴 非 0 的任意数字都表示已删除（历史脏值 2 必须被判成墓碑）', () => {
    // 真正致命的写法是 `flag === 1`：SQLite 里的历史脏值（如 2）会被误判为「未删除」，
    // 于是已删除的文档被重新当成活数据返回给用户或参与同步。
    const dirty: DeletedFlag = 2
    expect(dirty !== 0).toBe(true)
    expect(dirty === 1).toBe(false)
  })

  it('1 与任意非 0 值都是墓碑，只有 0 是存活', () => {
    for (const value of [1, 2, 99, -1]) {
      const flag: DeletedFlag = value
      expect(flag !== 0).toBe(true)
    }
    const alive: DeletedFlag = 0
    expect(alive !== 0).toBe(false)
  })

  it('🔴 记录一个事实：`0 | number` 会被 TS 归一成 `number`，类型层不设防', () => {
    // 联合类型里的字面量会被其基础类型吸收，所以 DeletedFlag 等价于 number：
    // `-1` 这种明显非法的值也能通过编译（下面两行是刻意的负向样本）。
    type _Collapses = Expect<Same<DeletedFlag, number>>
    const collapses: _Collapses = true
    expect(collapses).toBe(true)

    // 于是「0 是唯一存活值」这条不变量**只能靠 `!== 0` 的写法约定**，
    // 编译器不会替我们拦住 `flag === 1` 或把 0 当 falsy 的写法。
    // 这个测试的存在意义是把该约定钉在文档与用例里，而不是提供编译期保护。
    const negative: DeletedFlag = -1
    expect(negative !== 0).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 形状回归保护（编译期）
// ---------------------------------------------------------------------------

describe('DocumentSummary 不含正文（编译期回归保护）', () => {
  // 若有人把 body 加回 DocumentSummary（哪怕是可选字段），下一行会直接编译失败。
  type _NoBody = 'body' extends keyof DocumentSummary ? never : true
  const noBody: _NoBody = true

  // Document 必须有 body：否则正文无处可取。
  type _HasBody = 'body' extends keyof Document ? true : never
  const hasBody: _HasBody = true

  // 完整键集合：多一个字段（例如把 workspaceId 带回来）或少一个都会失败。
  type _SummaryKeys = Expect<
    Same<
      keyof DocumentSummary,
      | 'id'
      | 'projectId'
      | 'kind'
      | 'parentId'
      | 'orderKey'
      | 'title'
      | 'revision'
      | 'deleted'
      | 'createdAt'
      | 'updatedAt'
      | 'charCount'
      | 'hasChildren'
    >
  >
  const summaryKeys: _SummaryKeys = true

  it('🔴 列表视图的摘要类型里根本不存在 body 字段', () => {
    // 列表接口若返回正文，1000 章的作品每次拉取作品树都要传数十 MB 全量正文，
    // 桌面端滚动会卡、移动端会直接吃光流量。所以正文字段是**被排除**，不是可选。
    expect(noBody).toBe(true)
  })

  it('Document 保留 body，摘要字段齐全', () => {
    expect(hasBody).toBe(true)
    expect(summaryKeys).toBe(true)
  })

  it('摘要用 charCount / hasChildren 取代正文（列表要展示的信息来自计数而非文本）', () => {
    type _CharCount = Expect<Same<DocumentSummary['charCount'], number>>
    type _HasChildren = Expect<Same<DocumentSummary['hasChildren'], boolean>>
    const charCount: _CharCount = true
    const hasChildren: _HasChildren = true
    expect(charCount && hasChildren).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

/** 前缀即实体类型：日志与审计里靠它一眼看出 ID 属于谁。 */
const ID_FACTORIES: readonly { readonly entity: string; readonly prefix: string; readonly make: () => string }[] = [
  { entity: 'workspace', prefix: 'ws', make: () => newIds.workspace() },
  { entity: 'project', prefix: 'prj', make: () => newIds.project() },
  { entity: 'volume', prefix: 'vol', make: () => newIds.volume() },
  { entity: 'chapter', prefix: 'chp', make: () => newIds.chapter() },
  { entity: 'document', prefix: 'doc', make: () => newIds.document() },
  { entity: 'character', prefix: 'chr', make: () => newIds.character() },
  { entity: 'outlineNode', prefix: 'out', make: () => newIds.outlineNode() },
  { entity: 'worldSetting', prefix: 'wld', make: () => newIds.worldSetting() },
  { entity: 'material', prefix: 'mat', make: () => newIds.material() },
  { entity: 'attachment', prefix: 'att', make: () => newIds.attachment() },
  { entity: 'asset', prefix: 'ast', make: () => newIds.asset() },
  { entity: 'snapshot', prefix: 'snp', make: () => newIds.snapshot() },
  { entity: 'job', prefix: 'job', make: () => newIds.job() },
  { entity: 'user', prefix: 'usr', make: () => newIds.user() },
  { entity: 'device', prefix: 'dev', make: () => newIds.device() },
  { entity: 'plugin', prefix: 'plg', make: () => newIds.plugin() },
  { entity: 'request', prefix: 'req', make: () => newIds.request() },
]

describe('newIds 生成的实体 ID', () => {
  it('每个 ID 都是字符串，且前缀与实体类型一致', () => {
    // 前缀写错会让日志/审计把文档 ID 认成卷 ID，排查时误导方向。
    for (const { entity, prefix, make } of ID_FACTORIES) {
      const id = make()
      expect(typeof id, `${entity} 应生成字符串`).toBe('string')
      expect(id.startsWith(`${prefix}_`), `${entity} 的前缀应为 ${prefix}_，实际 ${id}`).toBe(true)
    }
  })

  it('100 次生成全部唯一（同类型不会撞 ID）', () => {
    // ID 由客户端离线生成，服务端不做唯一性分配；撞 ID 意味着两条不同内容
    // 落成同一主键，同步时会互相覆盖。
    for (const { entity, make } of ID_FACTORIES) {
      const seen = new Set<string>()
      for (let i = 0; i < 100; i += 1) seen.add(make())
      expect(seen.size, `${entity} 在 100 次生成中出现重复 ID`).toBe(100)
    }
  })

  it('不同类型的前缀互不相同', () => {
    const prefixes = ID_FACTORIES.map((factory) => factory.prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})

// ---------------------------------------------------------------------------
// 黄金样本
// ---------------------------------------------------------------------------

describe('实体黄金样本（各包构造测试数据的基准）', () => {
  // 固定时钟而非 new Date()：构造出来的样本必须逐字节可复现，
  // 否则同为「黄金样本」的两个包会构造出不同的对象，比对时出现假失败。
  const clock = fixedClock('2026-10-15T02:00:00.000Z')
  const at = clock.now()

  const project: Project = {
    id: newIds.project(),
    workspaceId: newIds.workspace(),
    name: '星轨之下',
    summary: '少年与坠落的星核',
    projectType: 'full',
    revision: encodeRevision(1),
    deleted: 0,
    createdAt: at,
    updatedAt: at,
  }

  const document: Document = {
    id: newIds.document(),
    workspaceId: project.workspaceId,
    projectId: project.id,
    kind: 'chapter',
    parentId: null,
    orderKey: 'a0',
    title: '第一章 坠落',
    body: '正文……',
    revision: encodeRevision(2),
    deleted: 0,
    createdAt: at,
    updatedAt: at,
  }

  it('Project 字段可读，新建实体 deleted 为 0', () => {
    expect(project.id.startsWith('prj_')).toBe(true)
    expect(project.workspaceId.startsWith('ws_')).toBe(true)
    expect(project.name).toBe('星轨之下')
    expect(project.summary).toBe('少年与坠落的星核')
    expect(project.projectType).toBe('full')
    expect(project.deleted).toBe(0)
    expect(project.deleted !== 0).toBe(false)
    expect(project.revision).toBe(encodeRevision(1))
    expect(isUtcTimestamp(project.createdAt)).toBe(true)
    expect(isUtcTimestamp(project.updatedAt)).toBe(true)
  })

  it('Document 字段可读，且与 Project 的外键一致', () => {
    expect(document.id.startsWith('doc_')).toBe(true)
    expect(document.workspaceId).toBe(project.workspaceId)
    expect(document.projectId).toBe(project.id)
    expect(document.kind).toBe('chapter')
    expect(document.parentId).toBeNull()
    expect(document.orderKey).toBe('a0')
    expect(document.title).toBe('第一章 坠落')
    expect(document.body).toContain('正文')
    expect(document.deleted).toBe(0)
    expect(document.revision).toBe(encodeRevision(2))
    expect(document.createdAt).toBe('2026-10-15T02:00:00.000Z')
  })

  it('🔴 从 Document 剥离出的 DocumentSummary 在运行期也没有 body 属性', () => {
    const summary: DocumentSummary = {
      id: document.id,
      projectId: document.projectId,
      kind: document.kind,
      parentId: document.parentId,
      orderKey: document.orderKey,
      title: document.title,
      revision: document.revision,
      deleted: document.deleted,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      charCount: document.body.length,
      hasChildren: false,
    }
    expect('body' in summary).toBe(false)
    expect('workspaceId' in summary).toBe(false)
    expect(summary.charCount).toBe(document.body.length)
    expect(summary.hasChildren).toBe(false)
    expect(summary.id).toBe(document.id)
  })

  it('revision 是不透明字符串，只能相等比较', () => {
    expect(typeof project.revision).toBe('string')
    expect(encodeRevision(2)).not.toBe(encodeRevision(3))
    expect(encodeRevision(2)).toBe(encodeRevision(2))
  })
})
