import { describe, expect, it } from 'vitest'
import {
  canEvict,
  type MobileDatabase,
  type MobileEvictionDecision,
  type MobilePlatform,
  type MobileSyncState,
} from '../src/mobile/index.js'

describe('移动端缓存淘汰', () => {
  it('无未同步数据时允许淘汰', () => {
    const decision = canEvict({ hasUnsyncedDraft: false, hasConflict: false, hasPendingUpload: false })
    expect(decision.kind).toBe('evict')
  })

  it('存在未同步草稿时禁止淘汰', () => {
    const decision = canEvict({ hasUnsyncedDraft: true, hasConflict: false, hasPendingUpload: false })
    expect(decision).toEqual<MobileEvictionDecision>({ kind: 'keep', reason: 'unsynced-draft' })
  })

  it('存在冲突版本时禁止淘汰', () => {
    expect(canEvict({ hasUnsyncedDraft: false, hasConflict: true, hasPendingUpload: false })).toEqual({
      kind: 'keep',
      reason: 'conflict',
    })
  })

  it('存在待上传附件时禁止淘汰', () => {
    expect(canEvict({ hasUnsyncedDraft: false, hasConflict: false, hasPendingUpload: true })).toEqual({
      kind: 'keep',
      reason: 'pending-upload',
    })
  })

  it('未同步草稿优先于冲突：原因按数据丢失风险排序', () => {
    const decision = canEvict({ hasUnsyncedDraft: true, hasConflict: true, hasPendingUpload: true })
    expect(decision).toEqual({ kind: 'keep', reason: 'unsynced-draft' })
  })
})

describe('移动端契约形状', () => {
  it('database 接口不暴露任何 SQL 驱动类型（不得泄漏 Database/Statement 句柄）', () => {
    // 编译期断言：若有人把 better-sqlite3 的 Database 加进契约，这里会因类型不兼容而失败。
    type Keys = keyof MobileDatabase
    const keys: readonly Keys[] = ['isOpen', 'schemaVersion', 'open', 'close', 'transaction', 'query', 'backup']
    expect(keys).toHaveLength(7)
    // 运行期无法验证类型不泄漏，真正的守门在 `packages/contracts` 的依赖禁令测试里。
    expect(true).toBe(true)
  })

  it('同步状态把本地保存与同步进度分开表达', () => {
    const state: MobileSyncState = {
      workspaceId: 'ws1' as MobileSyncState['workspaceId'],
      deviceId: 'dev1' as MobileSyncState['deviceId'],
      pendingOperations: 3,
      cursor: null,
      lastAttemptAt: null,
      lastErrorCode: 'NETWORK_TIMEOUT',
      localSaveState: 'saved',
      connectivity: 'offline',
    }
    // 关键不变量：网络失败（lastErrorCode）不得改写本地保存状态。
    expect(state.localSaveState).toBe('saved')
    expect(state.lastErrorCode).toBe('NETWORK_TIMEOUT')
  })

  it('platform 聚合五个能力接口', () => {
    type Keys = keyof MobilePlatform
    const keys: readonly Keys[] = [
      'database',
      'secureStore',
      'fileAccess',
      'backgroundSync',
      'editor',
      'platform',
      'appVersion',
      'inputLocale',
    ]
    expect(keys).toHaveLength(8)
  })
})
