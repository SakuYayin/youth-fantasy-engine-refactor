/**
 * 用例 `systemStatus` 的行为测试（内存 fake）。
 *
 * 覆盖任务要求的第 4 条：**输出字段齐全**（键集合断言）。
 * 版本号来自 `@yfe/contracts` 而不是宿主，本测试把这条分工钉死。
 */

import {
  PLUGIN_API_VERSION,
  SYNC_PROTOCOL_VERSION,
  type ReadContext,
  type RequestId,
  type WorkspaceId,
} from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { systemStatus } from '../src/useCases/systemStatus.js'
import { createFakeHarness, TEST_WORKSPACE } from './fakes.js'

/** 契约 `SystemStatusOutput` 的完整键集合（少一个 `resourceTemplateVersion` 都算破坏契约）。 */
const EXPECTED_KEYS = [
  'appVersion',
  'databaseSchemaVersion',
  'syncProtocolVersion',
  'pluginApiVersion',
  'resourceTemplateVersion',
  'databasePath',
  'readOnly',
  'lastSavedAt',
  'pendingOutboxCount',
] as const

const CONTEXT: ReadContext = {
  requestId: 'req-1' as RequestId,
  workspaceId: TEST_WORKSPACE as WorkspaceId,
}

describe('systemStatus', () => {
  it('输出字段齐全：键集合与契约逐字一致', async () => {
    const harness = createFakeHarness()
    const result = await systemStatus(harness.deps)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.value).sort()).toEqual([...EXPECTED_KEYS].sort())
    expect('resourceTemplateVersion' in result.value).toBe(true)
    expect(harness.counts.readSystemStatus).toBe(1)
  })

  it('版本号来自 contracts（宿主不重复硬编码）', async () => {
    const harness = createFakeHarness()
    const result = await systemStatus(harness.deps, CONTEXT)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.syncProtocolVersion).toEqual({
      major: SYNC_PROTOCOL_VERSION.major,
      minor: SYNC_PROTOCOL_VERSION.minor,
    })
    expect(result.value.pluginApiVersion).toBe(PLUGIN_API_VERSION)
  })

  it('运行时事实原样透传：null 就是 null，0 就是 0', async () => {
    const harness = createFakeHarness({
      facts: {
        appVersion: '4.0.0-dev.0',
        databaseSchemaVersion: 1,
        databasePath: ':memory:',
        readOnly: true,
        lastSavedAt: null,
        pendingOutboxCount: 0,
        resourceTemplateVersion: null,
      },
    })
    const result = await systemStatus(harness.deps, CONTEXT)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.resourceTemplateVersion).toBeNull()
    expect(result.value.lastSavedAt).toBeNull()
    expect(result.value.pendingOutboxCount).toBe(0)
    expect(result.value.readOnly).toBe(true)
    expect(result.value.databasePath).toBe(':memory:')
  })

  it('已装载资源模板包时透传版本号', async () => {
    const harness = createFakeHarness({ facts: { resourceTemplateVersion: '2026.10.1' } })
    const result = await systemStatus(harness.deps, CONTEXT)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.resourceTemplateVersion).toBe('2026.10.1')
  })

  it('可以不传 context（CLI 探活），传了则必须合法', async () => {
    const harness = createFakeHarness()
    const anonymous = await systemStatus(harness.deps)
    expect(anonymous.ok).toBe(true)

    const malformed = await systemStatus(harness.deps, {
      requestId: '' as RequestId,
      workspaceId: TEST_WORKSPACE as WorkspaceId,
    })
    expect(malformed.ok).toBe(false)
    if (malformed.ok) return
    expect(malformed.error.code).toBe('VALIDATION_MISSING_FIELD')
    expect(malformed.error.requestId).toBe('req-unknown')
  })

  it('端口失败原样上抛，不伪造一份空状态', async () => {
    const harness = createFakeHarness()
    harness.throwOn.readSystemStatus = new Error('SQLITE_CANTOPEN: C:\\Users\\alice\\yfe.db')

    const result = await systemStatus(harness.deps, CONTEXT)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
    expect(result.error.message).toBe('读取系统状态失败')
    expect(JSON.stringify(result.error)).not.toContain('alice')
  })

  it('宿主事实缺字段/类型不符：INTERNAL_ERROR（不猜默认值）', async () => {
    const harness = createFakeHarness()
    ;(harness.facts as { pendingOutboxCount: unknown }).pendingOutboxCount = '3'

    const result = await systemStatus(harness.deps, CONTEXT)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('INTERNAL_ERROR')
  })
})
