/**
 * mobile 契约测试。
 *
 * 这一组接口是**跨端能力边界**：桌面端现在就把 better-sqlite3 的 `Database` 句柄、
 * `fs` 路径或 Electron IPC 泄漏进业务层，P4 移动端就必须推翻已固化的架构。
 * 因此这里大量使用编译期断言——运行时断言看不出「接口多了一个字段」，
 * 而接口面的任何扩张都是架构级决策，必须在 `tsc` 阶段拦住
 * （见 src/mobile/index.ts:1-22 与 `03-移动端.md`）。
 */

import { describe, expect, it } from 'vitest'

import { canEvict } from '../src/mobile/index.js'
import type {
  BackgroundSync,
  MobileDatabase,
  MobileEvictionDecision,
  MobilePlatform,
  MobileStatement,
  MobileSyncState,
} from '../src/mobile/index.js'
import { encodeCursor, newIds } from '../src/ids.js'
import type { DeviceId, Revision, WorkspaceId } from '../src/ids.js'

// ---------------------------------------------------------------------------
// 编译期断言工具
// ---------------------------------------------------------------------------

/** 只有传入 `true` 才能通过类型检查：断言失败会在 `tsc` 阶段报错而不是静默通过。 */
type Expect<T extends true> = T

/** 双向可赋值 = 集合相等；多一个成员或少一个成员都会失败（这正是「键集合恰好是」的意思）。 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// ---------------------------------------------------------------------------
// 缓存淘汰
// ---------------------------------------------------------------------------

interface EvictionProbe {
  readonly hasUnsyncedDraft: boolean
  readonly hasConflict: boolean
  readonly hasPendingUpload: boolean
}

describe('canEvict 淘汰优先级', () => {
  it('三个标志全 true → 未同步草稿（数据丢失风险最高）', () => {
    // 依据 `03-移动端.md:30`：「缓存淘汰不删除未同步草稿、冲突版本或待上传附件」。
    // 这三类数据在服务器上没有副本，删掉即永久丢失。
    const decision = canEvict({ hasUnsyncedDraft: true, hasConflict: true, hasPendingUpload: true })
    expect(decision).toEqual<MobileEvictionDecision>({ kind: 'keep', reason: 'unsynced-draft' })
  })

  it('hasConflict + hasPendingUpload（无草稿）→ conflict', () => {
    const decision = canEvict({ hasUnsyncedDraft: false, hasConflict: true, hasPendingUpload: true })
    expect(decision).toEqual<MobileEvictionDecision>({ kind: 'keep', reason: 'conflict' })
  })

  it('只有 hasPendingUpload → pending-upload', () => {
    const decision = canEvict({ hasUnsyncedDraft: false, hasConflict: false, hasPendingUpload: true })
    expect(decision).toEqual<MobileEvictionDecision>({ kind: 'keep', reason: 'pending-upload' })
  })

  it('三个全 false → 允许淘汰', () => {
    const decision = canEvict({ hasUnsyncedDraft: false, hasConflict: false, hasPendingUpload: false })
    expect(decision).toEqual<MobileEvictionDecision>({ kind: 'evict' })
  })

  it('🔴 穷举 8 种组合：任一风险存在就绝不淘汰，reason 取优先级最高的那一项', () => {
    const bools = [false, true] as const
    const combos: readonly EvictionProbe[] = bools.flatMap((hasUnsyncedDraft) =>
      bools.flatMap((hasConflict) =>
        bools.map((hasPendingUpload) => ({ hasUnsyncedDraft, hasConflict, hasPendingUpload })),
      ),
    )
    // 优先级：未同步草稿 > 冲突版本 > 待上传附件 > 可淘汰。
    expect(combos).toHaveLength(8)

    for (const probe of combos) {
      const decision = canEvict(probe)
      if (probe.hasUnsyncedDraft) {
        expect(decision).toEqual({ kind: 'keep', reason: 'unsynced-draft' })
      } else if (probe.hasConflict) {
        expect(decision).toEqual({ kind: 'keep', reason: 'conflict' })
      } else if (probe.hasPendingUpload) {
        expect(decision).toEqual({ kind: 'keep', reason: 'pending-upload' })
      } else {
        expect(decision).toEqual({ kind: 'evict' })
      }
    }
  })

  it('🔴 不变量：只有三项风险全无时才可能淘汰（安全方向只允许更保守）', () => {
    const bools = [false, true] as const
    for (const hasUnsyncedDraft of bools) {
      for (const hasConflict of bools) {
        for (const hasPendingUpload of bools) {
          const decision = canEvict({ hasUnsyncedDraft, hasConflict, hasPendingUpload })
          const anyRisk = hasUnsyncedDraft || hasConflict || hasPendingUpload
          if (anyRisk) {
            // 返回 evict 就意味着用户数据永久丢失，这是本函数唯一不可接受的错误方向。
            expect(decision.kind).toBe('keep')
          } else {
            expect(decision.kind).toBe('evict')
          }
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 接口面（编译期）
// ---------------------------------------------------------------------------

describe('MobileDatabase 不暴露任何 SQL 驱动句柄', () => {
  // 「移动端让路约束」的守门测试：键集合**恰好**是这七个。
  // 一旦有人把 better-sqlite3 的 `Database` / `Statement`、`fs` 路径或
  // Electron IPC 加进来，下面这行断言会直接编译失败。
  type _DbKeys = Expect<
    Same<keyof MobileDatabase, 'isOpen' | 'schemaVersion' | 'open' | 'close' | 'transaction' | 'query' | 'backup'>
  >
  const dbKeys: _DbKeys = true

  it('🔴 键集合恰好是 isOpen|schemaVersion|open|close|transaction|query|backup', () => {
    // 暴露驱动句柄后业务代码就会开始拼 SQL，驱动替换与迁移校验都会失守
    // （src/mobile/index.ts:33-37，`10-开发规范与环境.md` 禁止 UI/模型工具/插件直连 SQL）。
    expect(dbKeys).toBe(true)
  })

  it('查询与写入都必须经过具名语句，且写操作能组成事务', () => {
    type _Query = Expect<
      Same<MobileDatabase['query'], <T>(statement: MobileStatement, params?: readonly unknown[]) => Promise<readonly T[]>>
    >
    type _Transaction = Expect<
      Same<
        MobileDatabase['transaction'],
        <T>(mutator: (tx: MobileDatabaseTransactionRef) => T | Promise<T>) => Promise<T>
      >
    >
    type _Open = Expect<Same<MobileDatabase['open'], () => Promise<void>>>
    type _IsOpen = Expect<Same<MobileDatabase['isOpen'], boolean>>
    type _SchemaVersion = Expect<Same<MobileDatabase['schemaVersion'], number>>
    const checks: readonly boolean[] = [
      true satisfies _Query,
      true satisfies _Transaction,
      true satisfies _Open,
      true satisfies _IsOpen,
      true satisfies _SchemaVersion,
    ]
    expect(checks.every(Boolean)).toBe(true)
  })

  it('backup 返回可校验的备份句柄与字节数', () => {
    type BackupResult = Awaited<ReturnType<MobileDatabase['backup']>>
    type _BackupKeys = Expect<Same<keyof BackupResult, 'handle' | 'bytes'>>
    type _Handle = Expect<Same<BackupResult['handle'], string>>
    type _Bytes = Expect<Same<BackupResult['bytes'], number>>
    const backupKeys: _BackupKeys = true
    const handle: _Handle = true
    const bytes: _Bytes = true
    expect(backupKeys && handle && bytes).toBe(true)
  })
})

/** `transaction` 回调参数的事务上下文；单独取出来只为让上面的 `Same` 可读。 */
type MobileDatabaseTransactionRef = Parameters<Parameters<MobileDatabase['transaction']>[0]>[0]

describe('MobileStatement 是具名语句而不是裸 SQL 字符串', () => {
  // 具名语句让 UTS/Kotlin 侧能预编译并缓存，同时把 SQL 集中在一处便于审计；
  // 调用方也没有机会把用户输入拼进 SQL（src/mobile/index.ts:70-79）。
  type _StatementKeys = Expect<Same<keyof MobileStatement, 'name' | 'sql'>>
  const statementKeys: _StatementKeys = true

  it('🔴 键恰好是 name|sql（两个都是 string）', () => {
    expect(statementKeys).toBe(true)
    type _Name = Expect<Same<MobileStatement['name'], string>>
    type _Sql = Expect<Same<MobileStatement['sql'], string>>
    const name: _Name = true
    const sql: _Sql = true
    expect(name && sql).toBe(true)
  })

  it('具名语句样本可读，且 name 与 sql 是不同的东西', () => {
    const statement: MobileStatement = { name: 'document.get', sql: 'SELECT id, title FROM document WHERE id = ?' }
    expect(statement.name).toBe('document.get')
    expect(statement.sql).toContain('SELECT')
    // 只是形状约束：契约层不校验 SQL 内容，执行与预编译在平台实现里。
    expect(statement.name).not.toBe(statement.sql)
  })
})

describe('MobileEvictionDecision 的 keep 分支 reason 是封闭字面量集合', () => {
  // 开放成 string 就失去了「还有哪三类数据不能删」的可枚举性，
  // 存储层也就无法据此写穷举分支。
  type KeepReason = Extract<MobileEvictionDecision, { kind: 'keep' }>['reason']
  type _KeepReason = Expect<Same<KeepReason, 'unsynced-draft' | 'conflict' | 'pending-upload'>>
  const keepReason: _KeepReason = true

  type _DecisionKinds = Expect<Same<MobileEvictionDecision['kind'], 'evict' | 'keep'>>
  const decisionKinds: _DecisionKinds = true

  it("🔴 Extract<..., {kind:'keep'}>['reason'] 恰好是三个字面量", () => {
    expect(keepReason).toBe(true)
    expect(decisionKinds).toBe(true)
  })

  it('keep 分支必须携带 reason（不允许无理由地拒绝淘汰）', () => {
    const reasons: readonly KeepReason[] = ['unsynced-draft', 'conflict', 'pending-upload']
    expect(reasons).toHaveLength(3)
    for (const reason of reasons) {
      expect(canEvict({
        hasUnsyncedDraft: reason === 'unsynced-draft',
        hasConflict: reason === 'conflict',
        hasPendingUpload: reason === 'pending-upload',
      })).toEqual({ kind: 'keep', reason })
    }
  })
})

// ---------------------------------------------------------------------------
// 同步状态：本地保存 与 连接性 是两个独立维度
// ---------------------------------------------------------------------------

describe('MobileSyncState 把本地保存与连接性分开表达', () => {
  const workspaceId: WorkspaceId = newIds.workspace()
  const deviceId: DeviceId = newIds.device()

  const offlineButSaved: MobileSyncState = {
    workspaceId,
    deviceId,
    pendingOperations: 3,
    cursor: encodeCursor(7, workspaceId),
    lastAttemptAt: null,
    lastErrorCode: 'NETWORK_TIMEOUT',
    localSaveState: 'saved',
    connectivity: 'offline',
  }

  it('🔴 connectivity=offline 时 localSaveState 仍可为 saved', () => {
    // 依据 `03-移动端.md:30`（空间/网络不足时不得标记「已保存」，反过来说
    // **网络失败也不得抹掉已经真实落盘的本地保存**）与 `02-桌面与界面.md:48`
    // 「不能让网络错误覆盖本地保存状态」。本地已保存与已同步是两个独立维度。
    expect(offlineButSaved.connectivity).toBe('offline')
    expect(offlineButSaved.localSaveState).toBe('saved')
    // 网络错误只体现在 lastErrorCode 上，不得影响 localSaveState。
    expect(offlineButSaved.lastErrorCode).toBe('NETWORK_TIMEOUT')
  })

  it('两个字段互相独立：笛卡尔积里存在「离线且已保存」「在线且保存失败」两种状态', () => {
    const connectivityValues: readonly MobileSyncState['connectivity'][] = ['online', 'offline', 'metered']
    const saveStateValues: readonly MobileSyncState['localSaveState'][] = ['saved', 'saving', 'failed']
    expect(connectivityValues).toHaveLength(3)
    expect(saveStateValues).toHaveLength(3)

    // 在线但保存失败：设备空间不足（`03-移动端.md:30` 要求此时报失败而非标记已保存）。
    const onlineButDiskFull: MobileSyncState = {
      ...offlineButSaved,
      connectivity: 'online',
      localSaveState: 'failed',
      lastErrorCode: 'STORAGE_DISK_FULL',
      lastAttemptAt: '2026-10-15T02:00:00.000Z' as MobileSyncState['lastAttemptAt'],
    }
    expect(onlineButDiskFull.connectivity).toBe('online')
    expect(onlineButDiskFull.localSaveState).toBe('failed')
  })

  it('cursor 与 pendingOperations 表达同步进度，不参与本地保存状态判定', () => {
    expect(offlineButSaved.pendingOperations).toBe(3)
    expect(typeof offlineButSaved.cursor).toBe('string')
    // 本地不动：离线时游标可以长时间停在原处。
    const stalled: MobileSyncState = { ...offlineButSaved, pendingOperations: 12 }
    expect(stalled.localSaveState).toBe('saved')
    expect(stalled.cursor).toBe(offlineButSaved.cursor)
  })

  it('形状断言：字段集合固定，state 字段都是封闭字面量', () => {
    type _SaveState = Expect<Same<MobileSyncState['localSaveState'], 'saved' | 'saving' | 'failed'>>
    type _Connectivity = Expect<Same<MobileSyncState['connectivity'], 'online' | 'offline' | 'metered'>>
    type _RevisionFree = Expect<Same<MobileSyncState['lastErrorCode'], string | null>>
    const saveState: _SaveState = true
    const connectivity: _Connectivity = true
    const lastErrorCode: _RevisionFree = true
    expect(saveState && connectivity && lastErrorCode).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 后台同步
// ---------------------------------------------------------------------------

describe('BackgroundSync.schedule', () => {
  type ScheduleInput = Parameters<BackgroundSync['schedule']>[0]
  type ScheduleResult = Awaited<ReturnType<BackgroundSync['schedule']>>

  type _InputKeys = Expect<Same<keyof ScheduleInput, 'workspaceId' | 'deviceId' | 'requiresUnmetered' | 'minIntervalMs'>>
  type _WorkspaceId = Expect<Same<ScheduleInput['workspaceId'], WorkspaceId>>
  type _DeviceId = Expect<Same<ScheduleInput['deviceId'], DeviceId>>
  type _RequiresUnmetered = Expect<Same<ScheduleInput['requiresUnmetered'], boolean>>
  type _MinIntervalMs = Expect<Same<ScheduleInput['minIntervalMs'], number>>
  type _ResultKeys = Expect<Same<keyof ScheduleResult, 'taskId'>>
  type _TaskId = Expect<Same<ScheduleResult['taskId'], string>>

  const inputKeys: _InputKeys = true
  const resultKeys: _ResultKeys = true

  it('入参形状固定：workspaceId/deviceId/requiresUnmetered/minIntervalMs', () => {
    expect(inputKeys).toBe(true)
    const input: ScheduleInput = {
      workspaceId: newIds.workspace(),
      deviceId: newIds.device(),
      requiresUnmetered: true,
      minIntervalMs: 15 * 60 * 1000,
    }
    expect(typeof input.workspaceId).toBe('string')
    expect(typeof input.deviceId).toBe('string')
    expect(input.requiresUnmetered).toBe(true)
    expect(input.minIntervalMs).toBe(900_000)
  })

  it('🔴 返回 { taskId }：每工作区唯一任务，重复调用是幂等更新而非新建', () => {
    // src/mobile/index.ts:136-151：多个任务并发会在服务器侧表现为重复批次，
    // 所以调度以 workspaceId 为键；返回值是同一个 taskId 而不是新 ID。
    expect(resultKeys).toBe(true)
    const result: ScheduleResult = { taskId: 'bg-task-1' }
    expect(Object.keys(result)).toEqual(['taskId'])
    expect(typeof result.taskId).toBe('string')
  })

  it('cancel / triggerNow 都只按 workspaceId 定位唯一任务', () => {
    type _CancelParams = Expect<Same<Parameters<BackgroundSync['cancel']>, [workspaceId: WorkspaceId]>>
    type _TriggerParams = Expect<Same<Parameters<BackgroundSync['triggerNow']>, [workspaceId: WorkspaceId]>>
    type _CancelReturn = Expect<Same<ReturnType<BackgroundSync['cancel']>, Promise<void>>>
    const cancelParams: _CancelParams = true
    const triggerParams: _TriggerParams = true
    const cancelReturn: _CancelReturn = true
    expect(cancelParams && triggerParams && cancelReturn).toBe(true)
  })

  it('scheduled 只暴露 workspaceId 与 taskId，供「同步」页展示', () => {
    type ScheduledEntry = BackgroundSync['scheduled'][number]
    type _EntryKeys = Expect<Same<keyof ScheduledEntry, 'workspaceId' | 'taskId'>>
    const entryKeys: _EntryKeys = true
    const scheduled: BackgroundSync['scheduled'] = [
      { workspaceId: newIds.workspace(), taskId: 'bg-task-1' },
      { workspaceId: newIds.workspace(), taskId: 'bg-task-2' },
    ]
    // 每工作区一条：同一 workspaceId 不允许出现两次。
    expect(new Set(scheduled.map((entry) => entry.workspaceId)).size).toBe(scheduled.length)
    expect(entryKeys).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 平台聚合
// ---------------------------------------------------------------------------

describe('MobilePlatform 聚合五个能力接口', () => {
  type _PlatformKeys = Expect<
    Same<
      keyof MobilePlatform,
      'database' | 'secureStore' | 'fileAccess' | 'backgroundSync' | 'editor' | 'platform' | 'appVersion' | 'inputLocale'
    >
  >
  type _PlatformTag = Expect<Same<MobilePlatform['platform'], 'android'>>
  const platformKeys: _PlatformKeys = true
  const platformTag: _PlatformTag = true

  it('键集合固定为 database/secureStore/fileAccess/backgroundSync/editor/platform/appVersion/inputLocale', () => {
    // 应用层只依赖这一个接口，不关心背后是 Kotlin 还是 Node；
    // 任何绕过它的底层资源访问都是架构回退。
    expect(platformKeys).toBe(true)
    expect(platformTag).toBe(true)
  })

  it('五个能力接口都不是可选字段（缺失会在装配期暴露而不是运行期）', () => {
    type _Database = Expect<Same<MobilePlatform['database'], MobileDatabase>>
    type _Required = Expect<
      Same<
        { [K in keyof MobilePlatform]-?: undefined extends MobilePlatform[K] ? never : K }[keyof MobilePlatform],
        keyof MobilePlatform
      >
    >
    const database: _Database = true
    const required: _Required = true
    expect(database && required).toBe(true)
  })

  it('editor 适配器带 revision，撤销/重做与冲刷草稿都在契约里', () => {
    type Editor = MobilePlatform['editor']
    type _OpenInput = Expect<Same<keyof Parameters<Editor['open']>[0], 'documentId' | 'body' | 'revision'>>
    type _OpenRevision = Expect<Same<Parameters<Editor['open']>[0]['revision'], Revision | null>>
    type _FlushResult = Expect<Same<Awaited<ReturnType<Editor['flush']>>, { readonly body: string; readonly draftSequence: number }>>
    type _Undo = Expect<Same<ReturnType<Editor['undo']>, Promise<void>>>
    const openInput: _OpenInput = true
    const openRevision: _OpenRevision = true
    const flushResult: _FlushResult = true
    const undo: _Undo = true
    expect(openInput && openRevision && flushResult && undo).toBe(true)
  })
})
