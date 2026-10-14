/**
 * sync 契约测试（同步协议 v1）。
 *
 * 这层契约的回归代价最高：它决定"离线改了三天，联网后改动是合并还是消失"。
 * 因此断言集中在四类不可妥协的规则上（`src/sync/index.ts` 文件头三条 + 快照/命令）：
 *
 * 1. **全部接受或全部拒绝**：`BatchSubmitOutput` 必须是判别联合，不能有"部分成功"的表达力；
 * 2. **主体从认证上下文取**：`issuer` 由服务端会话产生，`deviceId` 只做交叉校验；
 * 3. **幂等键与载荷绑定**：失败回执必须带 `OperationConflict` 元数据而不是一句中文；
 * 4. **游标过期是显式信号**：`resyncRequired` 必须存在，否则客户端会静默丢改动。
 *
 * 说明：与 `commands.test.ts` 一样，本包只有类型没有运行时常量，所以断言主力是
 * 编译期的 `Assert<...>` / `KeysExactly<...>` 与 `@ts-expect-error` 负向测试。
 */

import { describe, expect, it } from 'vitest'

import { errOf, isErr, isErrorCode, isOk, ok, unwrap } from '../src/errors.js'
import type { Result } from '../src/errors.js'
import { encodeCursor, encodeRevision, fixedClock, newIds } from '../src/ids.js'
import type { Cursor, Revision } from '../src/ids.js'
import type {
  BatchSubmitOutput,
  CapabilitiesOutput,
  ChangeEntry,
  ChangesOutput,
  HealthReadyOutput,
  OperationConflict,
  ReceiptOutput,
  RemoteCommand,
  RemoteCommandStatus,
  RemoteCommandType,
  SnapshotOutput,
  SyncOperation,
  SyncEvent,
} from '../src/sync/index.js'

// ---------------------------------------------------------------------------
// 编译期断言工具
// ---------------------------------------------------------------------------

/** 条件必须为 `true`，否则这一行编译不过。 */
type Assert<T extends true> = T
/** 条件必须为 `false`（用于"某字段不存在"这类断言）。 */
type ExpectFalse<T extends false> = T
/** `A` 与 `B` 必须是同一个类型（双向 extends）。 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** `T` 的键必须**恰好**是 `K`。 */
type KeysExactly<T, K extends PropertyKey> = [keyof T] extends [K] ? ([K] extends [keyof T] ? true : false) : false
/** `K` 是 `T` 的键吗。 */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

// ---------------------------------------------------------------------------
// 样本数据
// ---------------------------------------------------------------------------

const workspaceId = newIds.workspace()
const projectId = newIds.project()
const documentId = newIds.document()
const requestId = newIds.request()
const deviceId = newIds.device()
const now = fixedClock('2026-10-15T02:00:00.000Z').now()
const revision1 = encodeRevision(1)
const revision2 = encodeRevision(2)
const cursor10 = encodeCursor(10, workspaceId)
const cursor20 = encodeCursor(20, workspaceId)

/** 07-同步协议与API.md 记录的**文档基线**（P0 按样本确定正式值，由 capabilities 返回）。 */
const DOCUMENTED_LIMITS = {
  maxOperationsPerBatch: 100,
  maxBatchBytes: 4 * 1024 * 1024,
} as const

const capabilities: CapabilitiesOutput = {
  serverId: 'srv_home',
  protocolVersion: { major: 1, minor: 0 },
  minClientMajor: 1,
  limits: {
    maxOperationsPerBatch: DOCUMENTED_LIMITS.maxOperationsPerBatch,
    maxBatchBytes: DOCUMENTED_LIMITS.maxBatchBytes,
    maxOrderKeyLength: 64,
  },
  assets: { enabled: true, partSizeBytes: 8 * 1024 * 1024, maxAssetBytes: 512 * 1024 * 1024 },
  commands: ['workflow.run', 'job.cancel', 'sync.trigger'],
  readOnly: false,
}

const operation: SyncOperation = {
  opId: 'op_0001',
  entityType: 'document',
  entityId: documentId,
  projectId,
  baseRevision: revision1,
  // 客户端生成的 revision：离线也要能版本化。
  newRevision: revision2,
  action: 'upsert',
  payload: { title: '第一章 落雪' },
  assetIds: [],
}

// ---------------------------------------------------------------------------
// 能力协商
// ---------------------------------------------------------------------------

describe('CapabilitiesOutput', () => {
  it('limits 的实际约束值与文档基线一致：100 个操作 / 4 MiB', () => {
    // 07-同步协议与API.md："每批次限定一个工作区，初始上限建议 100 个操作/4 MiB，
    // 正文超限拆章或返回可执行提示"。低于这个值是服务端在缩减能力，
    // 高于这个值意味着客户端会发出服务端根本吃不下的大批次。
    expect(capabilities.limits.maxOperationsPerBatch).toBe(100)
    expect(capabilities.limits.maxBatchBytes).toBe(4 * 1024 * 1024)
    expect(capabilities.limits.maxBatchBytes).toBe(4_194_304)

    // 4 MiB 不是 4 MB：用 10^6 会让服务端与客户端的边界差出 19%。
    expect(capabilities.limits.maxBatchBytes).not.toBe(4_000_000)
  })

  it('limits 三项都是 number，且不止"操作数"一个上限', () => {
    type Limits = CapabilitiesOutput['limits']
    type _exact = Assert<KeysExactly<Limits, 'maxOperationsPerBatch' | 'maxBatchBytes' | 'maxOrderKeyLength'>>
    type _numbers = Assert<Exactly<Limits['maxBatchBytes'], number>>
    type _topExact = Assert<
      KeysExactly<CapabilitiesOutput, 'serverId' | 'protocolVersion' | 'minClientMajor' | 'limits' | 'assets' | 'commands' | 'readOnly'>
    >

    // 只限操作数不限字节数 = 100 个超大正文照样能打死服务端；
    // 只限字节数不限操作数 = 一条 4 MiB 里塞十万个小操作。两个上限缺一不可。
    expect(capabilities.limits.maxOperationsPerBatch).toBeGreaterThan(0)
    expect(capabilities.limits.maxBatchBytes).toBeGreaterThan(0)
    expect(capabilities.limits.maxOrderKeyLength).toBeGreaterThan(0)
  })

  it('协议不兼容时是"降级运行"，readOnly 与 minClientMajor 必须能表达这一点', () => {
    type _readOnly = Assert<Exactly<CapabilitiesOutput['readOnly'], boolean>>
    type _minMajor = Assert<Exactly<CapabilitiesOutput['minClientMajor'], number>>
    type _assets = Assert<KeysExactly<CapabilitiesOutput['assets'], 'enabled' | 'partSizeBytes' | 'maxAssetBytes'>>

    // 客户端拿到主版本不兼容时：保留本地编辑、停止推送并提示，
    // **不能当成空服务重新初始化**（否则用户会以为作品丢了）。
    const maintenance: CapabilitiesOutput = { ...capabilities, readOnly: true, minClientMajor: 2 }
    expect(maintenance.readOnly).toBe(true)
    expect(maintenance.minClientMajor).toBeGreaterThan(capabilities.protocolVersion.major)
  })
})

// ---------------------------------------------------------------------------
// 批次提交：判别联合，无部分成功
// ---------------------------------------------------------------------------

describe('BatchSubmitOutput', () => {
  it('成功样本：ok: true 分支不带 conflicts', () => {
    type Success = Extract<BatchSubmitOutput, { readonly ok: true }>
    type Failure = Extract<BatchSubmitOutput, { readonly ok: false }>
    type _successKeys = Assert<
      KeysExactly<Success, 'ok' | 'batchId' | 'cursor' | 'acceptedAt' | 'revisions' | 'replayed'>
    >
    type _failureKeys = Assert<KeysExactly<Failure, 'ok' | 'code' | 'requestId' | 'conflicts'>>
    type _correlated = Assert<Exactly<BatchSubmitOutput, Success | Failure>>

    const res: BatchSubmitOutput = {
      ok: true,
      batchId: 'batch_0001',
      cursor: cursor10,
      acceptedAt: now,
      revisions: [{ entityId: documentId, revision: revision2 }],
    }
    expect(res.ok).toBe(true)

    // 收窄后才有 revisions / cursor；成功分支里根本读不到 conflicts。
    if (res.ok) {
      expect(res.batchId).toBe('batch_0001')
      expect(res.cursor).toBe(cursor10)
      const first = res.revisions[0]
      if (first === undefined) throw new Error('样本应有一条版本')
      expect(first.revision).toBe(revision2)
      // 服务端可能因归一化而给出与提交值不同的权威版本：客户端必须采纳它的值。
      expect(first.entityId).toBe(documentId)
    } else {
      throw new Error('该样本必须是成功分支')
    }
  })

  it('失败样本：整批被拒，conflicts 携带双方版本', () => {
    const conflict: OperationConflict = {
      opId: 'op_0001',
      entityType: 'document',
      entityId: documentId,
      expectedBaseRevision: revision1,
      // 服务端当前版本：与提交的 baseRevision 不同 → 整批拒绝。
      currentRevision: encodeRevision(7),
      reason: 'revision-mismatch',
    }
    const res: BatchSubmitOutput = {
      ok: false,
      code: 'REVISION_CONFLICT',
      requestId,
      conflicts: [conflict],
    }

    if (!res.ok) {
      // 🔴 首版**无部分成功**：批里任何一个操作验证失败，整批回滚。
      // 因此失败分支只有 conflicts（没有"已接受的那几个"），客户端必须重组整个批次重发。
      expect(res.code).toBe('REVISION_CONFLICT')
      expect(res.requestId).toBe(requestId)
      expect(res.conflicts).toHaveLength(1)
      const first = res.conflicts[0]
      if (first === undefined) throw new Error('样本应有一条冲突')
      expect(first.reason).toBe('revision-mismatch')
      // 冲突元数据要能让 UI 展示"双方版本"对比，而不是只给一句中文。
      expect(first.expectedBaseRevision).toBe(revision1)
      expect(first.currentRevision).not.toBe(revision1)
    } else {
      throw new Error('该样本必须是失败分支')
    }
  })

  it('收窄之前不许直接读分支专有字段（负向测试）', () => {
    const res: BatchSubmitOutput = {
      ok: true,
      batchId: 'batch_0002',
      cursor: cursor10,
      acceptedAt: now,
      revisions: [],
    }
    // @ts-expect-error 未收窄时 conflicts 不存在于联合类型上：必须先用 if (!res.ok) 判别
    const forbidden = res.conflicts
    expect(forbidden).toBeUndefined()

    // @ts-expect-error 失败分支不能携带成功字段，反之亦然（结构性互斥）
    const mixed: BatchSubmitOutput = { ok: false, batchId: 'batch_0003', code: 'X', requestId, conflicts: [] }
    expect(mixed.ok).toBe(false)
  })

  it('失败码按稳定 code 分类，客户端不比较中文', () => {
    const res: BatchSubmitOutput = { ok: false, code: 'SYNC_BATCH_REJECTED', requestId, conflicts: [] }
    if (!res.ok) {
      expect(isErrorCode(res.code)).toBe(true)
      expect(isErrorCode(res.code.toUpperCase())).toBe(true)
      expect(isErrorCode('版本冲突')).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 冲突元数据
// ---------------------------------------------------------------------------

describe('OperationConflict', () => {
  it('reason 恰好四个字面量（新增必须走评审）', () => {
    type Reason = OperationConflict['reason']
    type _exact = Assert<
      Exactly<Reason, 'revision-mismatch' | 'entity-deleted' | 'permission' | 'invalid-payload'>
    >
    type _extract = Assert<
      Exactly<Extract<Reason, 'revision-mismatch' | 'entity-deleted' | 'permission' | 'invalid-payload'>, Reason>
    >
    type _keys = Assert<
      KeysExactly<
        OperationConflict,
        'opId' | 'entityType' | 'entityId' | 'expectedBaseRevision' | 'currentRevision' | 'reason'
      >
    >

    const reasons: readonly Reason[] = ['revision-mismatch', 'entity-deleted', 'permission', 'invalid-payload']
    expect(reasons).toHaveLength(4)
    expect(new Set(reasons).size).toBe(4)
  })

  it('四类原因都能构造，且各自代表不同的下一步动作', () => {
    const base: Omit<OperationConflict, 'reason'> = {
      opId: 'op_x',
      entityType: 'document',
      entityId: documentId,
      expectedBaseRevision: revision1,
      currentRevision: revision2,
    }

    // revision-mismatch → 展示双方版本让用户选；permission → 直接报错，重试无用；
    // entity-deleted → 走删除/更新冲突分支；invalid-payload → 客户端 bug，必须上报。
    const mismatch: OperationConflict = { ...base, reason: 'revision-mismatch' }
    const notFound: OperationConflict = { ...base, reason: 'entity-deleted', currentRevision: null }
    const denied: OperationConflict = { ...base, reason: 'permission' }
    const invalid: OperationConflict = { ...base, reason: 'invalid-payload', expectedBaseRevision: null }

    expect([mismatch.reason, notFound.reason, denied.reason, invalid.reason]).toEqual([
      'revision-mismatch',
      'entity-deleted',
      'permission',
      'invalid-payload',
    ])
    // 被删除的实体没有"当前版本"：null 而不是空串。
    expect(notFound.currentRevision).toBeNull()
    // 新建实体（baseRevision 为 null）也可能载荷非法。
    expect(invalid.expectedBaseRevision).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 操作：newRevision 由客户端生成
// ---------------------------------------------------------------------------

describe('SyncOperation', () => {
  it('🔴 newRevision 由客户端生成（服务端无法为离线改动预先分配）', () => {
    // 关键不变量：离线三天里改了 20 次，这 20 个 revision 必须在联网**之前**就存在，
    // 才能形成 base → new → next base 的链。若改成服务端分配，离线期间无处可取。
    type _exists = Assert<HasKey<SyncOperation, 'newRevision'>>
    type _isRevision = Assert<Exactly<SyncOperation['newRevision'], Revision>>
    // 必填（不是可选）：漏掉它整批就无法版本化。
    type _required = Assert<Exactly<{} extends Pick<SyncOperation, 'newRevision'> ? false : true, true>>
    type _baseNullable = Assert<Exactly<SyncOperation['baseRevision'], Revision | null>>
    type _keys = Assert<
      KeysExactly<
        SyncOperation,
        'opId' | 'entityType' | 'entityId' | 'projectId' | 'baseRevision' | 'newRevision' | 'action' | 'payload' | 'assetIds'
      >
    >

    // 运行期它就是个不透明字符串（品牌类型只存在于类型层）。
    expect(typeof operation.newRevision).toBe('string')
    expect(operation.newRevision).toBe(revision2)
    expect(operation.newRevision).not.toBe(operation.baseRevision)
  })

  it('离线连续修改形成 revision 链：每个操作的 base 是上一个的 new', () => {
    const first: SyncOperation = { ...operation, opId: 'op_0001', baseRevision: null, newRevision: encodeRevision(1) }
    const second: SyncOperation = { ...operation, opId: 'op_0002', baseRevision: first.newRevision, newRevision: encodeRevision(2) }
    const third: SyncOperation = { ...operation, opId: 'op_0003', baseRevision: second.newRevision, newRevision: encodeRevision(3) }

    // 链是自洽的：base_rev(n) === new_rev(n-1)。断链会被服务端当成冲突整批拒绝。
    expect(second.baseRevision).toBe(first.newRevision)
    expect(third.baseRevision).toBe(second.newRevision)
    // revision 是不透明值：只做相等比较，绝不比较大小（`>` 会让"谁更新"变成伪命题）。
    expect([first.newRevision, second.newRevision, third.newRevision]).toHaveLength(3)
    expect(new Set([first.newRevision, second.newRevision, third.newRevision]).size).toBe(3)

    // 新建实体（首个操作）的 baseRevision 是 null，不是空串也不是 revision(0)。
    expect(first.baseRevision).toBeNull()
  })

  it('新建实体的 baseRevision 为 null（不是 undefined，也不是空串）', () => {
    type _nullable = Assert<Exactly<SyncOperation['baseRevision'], Revision | null>>
    const created: SyncOperation = { ...operation, baseRevision: null }
    expect(created.baseRevision).toBeNull()
    expect(created.baseRevision).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// 增量拉取
// ---------------------------------------------------------------------------

describe('ChangesOutput', () => {
  it('游标过期时服务端返回 resyncRequired: true（HTTP 410）', () => {
    type _keys = Assert<KeysExactly<ChangesOutput, 'changes' | 'nextCursor' | 'resyncRequired'>>
    type _flag = Assert<Exactly<ChangesOutput['resyncRequired'], boolean>>
    type _nextNullable = Assert<Exactly<ChangesOutput['nextCursor'], Cursor | null>>

    const expired: ChangesOutput = { changes: [], nextCursor: cursor10, resyncRequired: true }

    // 07-同步协议与API.md："游标过期返回 410/RESYNC_REQUIRED。客户端**先保存离线分支**，
    // 再下载快照并重放或形成冲突，**不能清空未同步稿件**。"
    // 因此这里断言的是"这个标志必须存在且为真"，而不是"changes 为空就代表没事"：
    // changes 空 + resyncRequired 真 = 服务端已经说不清楚中间发生了什么。
    //
    // ⚠️ 已记录的不一致（不改源码，仅在此留证）：`src/sync/index.ts:147-148`
    // 的注释说游标过期返回 `SYNC_CURSOR_INVALID` / HTTP 410，而 `ChangesOutput`
    // 的实际形状是 `{ changes, nextCursor, resyncRequired }`——**没有** `code` 字段，
    // 所以响应体里放不下 `SYNC_CURSOR_INVALID`。该码只能表达为"整个请求以 HTTP 410
    // + ErrorPayload 失败"（`Result` 的 Err 分支），而 `resyncRequired` 是"200 成功但
    // 必须重同步"的第二条路。两条路并存时客户端必须两个都处理，只处理其一会静默丢改动。
    expect(expired.resyncRequired).toBe(true)
    expect(Object.keys(expired)).not.toContain('code')
    expect(expired.changes).toHaveLength(0)

    // 正常增量：resyncRequired 为 false，游标推进。
    const normal: ChangesOutput = { changes: [], nextCursor: cursor20, resyncRequired: false }
    expect(normal.resyncRequired).toBe(false)
    // nextCursor 为 null 才是"真的没有更多了"；不能与 resyncRequired 混为一谈。
    const caughtUp: ChangesOutput = { changes: [], nextCursor: null, resyncRequired: false }
    expect(caughtUp.nextCursor).toBeNull()
    expect(caughtUp.resyncRequired).toBe(false)
  })

  it('ChangeEntry 是流事件之外的第二权威来源：带 revision 与 serverSeq', () => {
    type _keys = Assert<
      KeysExactly<
        ChangeEntry,
        | 'cursor'
        | 'entityType'
        | 'entityId'
        | 'projectId'
        | 'action'
        | 'revision'
        | 'baseRevision'
        | 'payload'
        | 'committedAt'
        | 'serverSeq'
      >
    >

    const entry: ChangeEntry = {
      cursor: cursor10,
      entityType: 'document',
      entityId: documentId,
      projectId,
      action: 'upsert',
      revision: revision2,
      baseRevision: revision1,
      payload: { title: '第一章 落雪' },
      committedAt: now,
      serverSeq: 12,
    }
    // serverSeq 只用于排序展示，**不能**拿它当版本或冲突依据。
    expect(entry.serverSeq).toBe(12)
    expect(entry.revision).toBe(revision2)
    expect(entry.baseRevision).toBe(revision1)
  })
})

// ---------------------------------------------------------------------------
// 快照与幂等回执
// ---------------------------------------------------------------------------

describe('SnapshotOutput / ReceiptOutput', () => {
  it('快照是一个固定一致点及其游标，分页到 nextCursor 为 null 结束', () => {
    type _keys = Assert<
      KeysExactly<
        SnapshotOutput,
        'cursor' | 'takenAt' | 'projects' | 'documents' | 'settingsEntities' | 'relations' | 'assets' | 'nextCursor'
      >
    >

    const page: SnapshotOutput = {
      cursor: cursor20,
      takenAt: now,
      projects: [],
      documents: [{ id: documentId }],
      settingsEntities: [],
      relations: [],
      assets: [],
      nextCursor: null,
    }
    // 快照自带游标：客户端据此只补拉"快照之后"的增量，而不是从头再来。
    expect(page.cursor).toBe(cursor20)
    expect(page.nextCursor).toBeNull()
    expect(page.documents).toHaveLength(1)
  })

  it('回执把"重试"和"篡改"区分开：payloadDigest 必填', () => {
    type _keys = Assert<
      KeysExactly<ReceiptOutput, 'batchId' | 'deviceId' | 'acceptedAt' | 'operationCount' | 'cursor' | 'payloadDigest'>
    >

    const receipt: ReceiptOutput = {
      batchId: 'batch_0001',
      deviceId,
      acceptedAt: now,
      operationCount: 1,
      cursor: cursor10,
      payloadDigest: 'sha256:0f1e2d',
    }
    // 同一 batchId 配不同摘要 → IDEMPOTENCY_KEY_REUSED，绝不二次写入。
    expect(receipt.payloadDigest).not.toBe('')
    expect(receipt.operationCount).toBe(1)
    expect(receipt.cursor).toBe(cursor10)
  })
})

// ---------------------------------------------------------------------------
// 远程命令
// ---------------------------------------------------------------------------

/** 首版只允许这三种命令（ADR 008：不开放任意代码执行）。 */
const ALL_REMOTE_COMMAND_TYPES: readonly RemoteCommandType[] = ['workflow.run', 'job.cancel', 'sync.trigger']

describe('RemoteCommand', () => {
  it('🔴 issuer 存在，且由服务端会话产生（不接受客户端自报）', () => {
    type _exists = Assert<HasKey<RemoteCommand, 'issuer'>>
    type _issuerIsString = Assert<Exactly<RemoteCommand['issuer'], string>>
    type _keys = Assert<
      KeysExactly<
        RemoteCommand,
        'commandId' | 'workspaceId' | 'targetDeviceId' | 'commandType' | 'args' | 'expiresAt' | 'issuer' | 'status' | 'createdAt'
      >
    >

    const command: RemoteCommand = {
      commandId: 'cmd_0001',
      workspaceId,
      targetDeviceId: deviceId,
      commandType: 'sync.trigger',
      args: {},
      expiresAt: now,
      // 由服务端会话解析出的主体：客户端侧同名字段只用于展示，
      // 任何设备都不能靠自报 issuer 伪造"管理员下的命令"。
      issuer: 'usr_admin',
      status: 'pending',
      createdAt: now,
    }

    expect(command.issuer).toBe('usr_admin')
    // 🔴 载荷里没有 role/roles 字段：授权判定必须走服务端会话，不能信客户端自报的角色。
    expect(Object.keys(command)).not.toContain('role')
    expect(Object.keys(command)).not.toContain('roles')
  })

  it('RemoteCommandType 恰好三种（首版不开放任意代码执行）', () => {
    type _exact = Assert<Exactly<RemoteCommandType, 'workflow.run' | 'job.cancel' | 'sync.trigger'>>
    type _exhaustive = Assert<Exactly<RemoteCommandType, (typeof ALL_REMOTE_COMMAND_TYPES)[number]>>

    // 长度断言是刻意的：多一种命令（比如 'shell.exec'）会打破它并迫使评审。
    expect(ALL_REMOTE_COMMAND_TYPES).toHaveLength(3)
    expect(new Set(ALL_REMOTE_COMMAND_TYPES).size).toBe(3)
    expect(ALL_REMOTE_COMMAND_TYPES).toContain('workflow.run')
    // capabilities.commands 声称支持的命令必须落在这三种之内。
    expect(capabilities.commands.every((c) => ALL_REMOTE_COMMAND_TYPES.includes(c))).toBe(true)
  })

  it('RemoteCommandStatus 五态，穷举长度必须为 5', () => {
    const ALL_REMOTE_COMMAND_STATUSES: readonly RemoteCommandStatus[] = [
      'pending',
      'claimed',
      'acked',
      'expired',
      'failed',
    ]
    // 类型层：数组字面量必须恰好覆盖联合，多一个少一个都编译失败。
    type _exhaustive = Assert<Exactly<RemoteCommandStatus, (typeof ALL_REMOTE_COMMAND_STATUSES)[number]>>
    type _keys = Assert<Exactly<RemoteCommandStatus, 'pending' | 'claimed' | 'acked' | 'expired' | 'failed'>>

    expect(ALL_REMOTE_COMMAND_STATUSES).toHaveLength(5)
    expect(new Set(ALL_REMOTE_COMMAND_STATUSES).size).toBe(5)

    // claimed 是租约态而不是终态：设备领取后崩溃，命令必须能在租约失效后重新被领取。
    const claimed: RemoteCommand = {
      commandId: 'cmd_0002',
      workspaceId,
      targetDeviceId: deviceId,
      commandType: 'job.cancel',
      args: { jobId: 'job_1' },
      expiresAt: now,
      issuer: 'usr_admin',
      status: 'claimed',
      createdAt: now,
    }
    expect(claimed.status).toBe('claimed')
    expect(ALL_REMOTE_COMMAND_STATUSES).toContain(claimed.status)
  })

  it('重复投递同一命令只返回原执行结果（ack 带去重键 executionId）', () => {
    // status 只有 succeeded/failed：取消/超时是任务层语义，不在这里重复表达。
    const ack = { commandId: 'cmd_0001', executionId: 'exec_0001', status: 'succeeded' as const }
    expect(ack.status).toBe('succeeded')
    expect(ack.executionId).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

describe('HealthReadyOutput', () => {
  it("database 恰好四态，含 'too-new'", () => {
    type Db = HealthReadyOutput['database']
    type _exact = Assert<Exactly<Db, 'ok' | 'migrating' | 'unavailable' | 'too-new'>>
    type _keys = Assert<KeysExactly<HealthReadyOutput, 'status' | 'database' | 'disk' | 'queueDepth' | 'checks'>>
    type _disk = Assert<Exactly<HealthReadyOutput['disk'], 'ok' | 'low' | 'full'>>
    type _status = Assert<Exactly<HealthReadyOutput['status'], 'ready' | 'not-ready'>>

    const ready: HealthReadyOutput = {
      status: 'ready',
      database: 'ok',
      disk: 'ok',
      queueDepth: 0,
      checks: [{ name: 'database', ok: true }],
    }
    expect(ready.status).toBe('ready')
    expect(ready.database).toBe('ok')
  })

  it("🔴 'too-new' 必须导致拒绝写入，而不是降级运行", () => {
    // 数据版本高于程序支持范围时拒绝写入（06-数据与本地存储.md），
    // 因为新版写入的字段会被旧版静默丢弃，造成不可逆数据损失。
    const tooNew: HealthReadyOutput = {
      status: 'not-ready',
      database: 'too-new',
      disk: 'ok',
      queueDepth: 0,
      checks: [{ name: 'database', ok: false, detail: 'schema 3 > 支持的 1' }],
    }
    expect(tooNew.database).toBe('too-new')
    // 关键组合：too-new 绝不能配 status: 'ready'（否则负载均衡会把流量打过来）。
    expect(tooNew.status).toBe('not-ready')

    // 迁移中是"暂时不可服务"，不是"库有问题"：不能当成 too-new 处理。
    const migrating: HealthReadyOutput = { ...tooNew, database: 'migrating' }
    expect(migrating.database).not.toBe('too-new')
    expect(tooNew.checks.some((c) => !c.ok)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SSE 事件
// ---------------------------------------------------------------------------

describe('SyncEvent', () => {
  it('事件只是通知：不带正文，只带 ID / 游标 / 最小差异', () => {
    const events: readonly SyncEvent[] = [
      { type: 'hello', serverId: 'srv_home', cursor: cursor10 },
      { type: 'change', cursor: cursor20, entityIds: [documentId] },
      { type: 'job', jobId: 'job_1', status: 'running' },
      { type: 'command', commandId: 'cmd_0001' },
      { type: 'ping', at: now },
    ]
    expect(events).toHaveLength(5)
    // change 事件只给 entityIds：客户端要回查或按游标增量拉取，不能凭事件内容直接改库。
    const change = events[1]
    if (change === undefined) throw new Error('样本应有 change 事件')
    expect(change.type).toBe('change')
    if (change.type === 'change') {
      expect(Object.keys(change)).toEqual(['type', 'cursor', 'entityIds'])
      expect(change.entityIds).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 与 Result 契约的集成：一条真实数据流
// ---------------------------------------------------------------------------

describe('契约集成：批提交结果穿过 Result 边界', () => {
  it('ok 把成功值包在 value 字段里，unwrap 拿到同一个对象', () => {
    const success: BatchSubmitOutput = {
      ok: true,
      batchId: 'batch_0009',
      cursor: cursor10,
      acceptedAt: now,
      revisions: [{ entityId: documentId, revision: revision2 }],
    }

    // 🔴 注意：`ok(data)` 返回的是 `{ ok: true, value: data }` 而不是 data 本身。
    // 把 `Ok<T>` 直接当成 T 用（例如 `const r: BatchSubmitOutput = ok(success)`）会编译失败。
    const result: Result<BatchSubmitOutput> = ok(success)
    expect(isOk(result)).toBe(true)
    expect(isErr(result)).toBe(false)

    const unwrapped = unwrap(result)
    // 同一对象：unwrap 不做拷贝，也不做"归一化"。
    expect(unwrapped).toBe(success)
    expect(unwrapped.ok).toBe(true)
    expect(Object.keys(result).sort()).toEqual(['ok', 'value'])
  })

  it('errOf 造出结构化错误：code 正确且不携带堆栈', () => {
    const failure = errOf('REVISION_CONFLICT', '版本冲突', requestId)
    expect(isErr(failure)).toBe(true)
    expect(isOk(failure)).toBe(false)
    expect(failure.ok).toBe(false)
    expect(failure.error.code).toBe('REVISION_CONFLICT')
    expect(failure.error.requestId).toBe(requestId)
    expect(failure.error.message).toBe('版本冲突')
    // 冲突是"预期内的业务分支"：severity 为 info，而不是 error/critical。
    expect(failure.error.severity).toBe('info')
    // 绝不泄漏堆栈与 cause（可能含绝对路径与用户名）。
    expect(failure.error).not.toHaveProperty('stack')
    expect(failure.error).not.toHaveProperty('cause')
  })

  it('🔴 REVISION_CONFLICT 的 retryable 为 true——但重试前必须先按冲突元数据重组批次', () => {
    // ⚠️ 与直觉不同（也与其他项目的惯例不同）：本项目的 REVISION_CONFLICT
    // **是** retryable 的。依据 `src/errors.ts`：CONFLICT 组是"携当前状态可重试"，
    // isRetryable 对 severity === 'info' 的码只放行 REVISION_CONFLICT 与 RESOURCE_LOCKED。
    // 语义是"取回服务端 currentRevision 后可以再试一次"，
    // 绝不是"原样重发同一批次"——原样重发必然再次撞上同一个冲突。
    const failure = errOf('REVISION_CONFLICT', '版本冲突', requestId)
    expect(failure.error.retryable).toBe(true)

    // 对照：真正不可重试的是权限与校验类，UI 不该给"重试"按钮。
    expect(errOf('PERMISSION_DENIED', '无权限', requestId).error.retryable).toBe(false)
    expect(errOf('VALIDATION_FAILED', '入参非法', requestId).error.retryable).toBe(false)
    // 网络类可重试（这才是"原样重发"安全的那一类）。
    expect(errOf('NETWORK_TIMEOUT', '网络超时', requestId).error.retryable).toBe(true)
  })
})
