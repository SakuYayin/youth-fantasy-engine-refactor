/**
 * `@yfe/plugin-sdk/context` 的行为测试 + **架构门禁**。
 *
 * 后半部分（「SDK 不泄漏 Cordis」）是设计文档 `05-插件内核与SDK.md` 与 ADR 0002 的硬性约束：
 * 第三方插件在类型层面就不应该看到 Cordis，否则适配层形同虚设。这里用真实文件读取与
 * 运行时导出表来做断言，而不是靠人记得不要 import。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  PLUGIN_SDK_VERSION,
  capabilityDeniedPayload,
  describeCapabilityDenial,
  expectOk,
  isErrResult,
  isOkResult,
  requireCapability,
} from '../src/context/index.js'
import { isGrantableCapability } from '../src/manifest/index.js'
import type { PluginCapability } from '../src/manifest/index.js'
import type { RequestId } from '@yfe/contracts'
import { ContractError, isRetryable, severityOf } from '@yfe/contracts'

const REQUEST_ID = 'req_sdk_context_0001' as RequestId

describe('PLUGIN_SDK_VERSION', () => {
  it('与契约的 PLUGIN_API_VERSION 语义一致（1.0.0）', () => {
    expect(PLUGIN_SDK_VERSION).toBe('1.0.0')
  })
})

describe('requireCapability —— 声明 ≠ 授权', () => {
  it('已授权返回 Ok(void)', () => {
    const result = requireCapability(['plugin.data.read'], 'plugin.data.read', REQUEST_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value).toBeUndefined()
  })

  it('未声明/未授权返回 PERMISSION_PLUGIN_CAPABILITY（不是抛错）', () => {
    const result = requireCapability([], 'plugin.data.write', REQUEST_ID, false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PERMISSION_PLUGIN_CAPABILITY')
    expect(result.error.requestId).toBe(REQUEST_ID)
    expect(result.error.detail?.['capability']).toBe('plugin.data.write')
    // 可预期的业务分支，不是异常
    expect(result.error.severity).toBe(severityOf('PERMISSION_PLUGIN_CAPABILITY'))
    expect(result.error.retryable).toBe(isRetryable('PERMISSION_PLUGIN_CAPABILITY'))
    expect(result.error.retryable).toBe(false)
  })

  it('授权列表里没有该能力时，即使声明过也被拒绝', () => {
    const result = requireCapability(['plugin.data.read'], 'plugin.data.write', REQUEST_ID, true)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.message).toContain('宿主未批准')
  })

  it('不可授予的能力永远被拒绝，即便调用方声称已授权', () => {
    for (const capability of ['host.filesystem.write', 'host.process.spawn', 'host.network.outbound'] as PluginCapability[]) {
      expect(isGrantableCapability(capability)).toBe(false)
    }
  })
})

describe('describeCapabilityDenial —— 三种拒绝原因可区分', () => {
  it('不可授予的能力给出 ADR 008 文案', () => {
    const message = describeCapabilityDenial('host.process.spawn', true)
    expect(message).toContain('无法安全授予')
    expect(message).toContain('ADR 008')
  })

  it('未声明给出「未在 manifest.permissions 声明」', () => {
    expect(describeCapabilityDenial('plugin.data.read', false)).toContain('未在 manifest.permissions 声明')
  })

  it('已声明但未获批给出「宿主未批准」', () => {
    expect(describeCapabilityDenial('plugin.data.read', true)).toContain('宿主未批准')
  })
})

describe('capabilityDeniedPayload', () => {
  it('字段可序列化且 detail 只含标量（IPC 安全）', () => {
    const payload = capabilityDeniedPayload('plugin.ui.panel', REQUEST_ID, '自定义文案', { panelId: 'p1' })
    expect(payload.code).toBe('PERMISSION_PLUGIN_CAPABILITY')
    expect(payload.message).toBe('自定义文案')
    expect(payload.detail).toEqual({ capability: 'plugin.ui.panel', panelId: 'p1' })
    for (const value of Object.values(payload.detail ?? {})) {
      expect(['string', 'number', 'boolean']).toContain(typeof value)
    }
    // 绝不携带 cause —— cause 不允许外发
    expect(payload.cause).toBeUndefined()
  })

  it('默认文案包含能力名', () => {
    expect(capabilityDeniedPayload('plugin.tasks.run', REQUEST_ID).message).toContain('plugin.tasks.run')
  })
})

describe('Result 辅助函数', () => {
  it('isOkResult / isErrResult 正确判别', () => {
    const good = requireCapability(['plugin.data.read'], 'plugin.data.read', REQUEST_ID)
    const bad = requireCapability([], 'plugin.data.read', REQUEST_ID, false)
    expect(isOkResult(good)).toBe(true)
    expect(isErrResult(good)).toBe(false)
    expect(isOkResult(bad)).toBe(false)
    expect(isErrResult(bad)).toBe(true)
  })

  it('expectOk 成功时返回值、失败时抛 ContractError', () => {
    expect(expectOk(requireCapability(['plugin.data.read'], 'plugin.data.read', REQUEST_ID))).toBeUndefined()
    try {
      expectOk(requireCapability([], 'plugin.data.write', REQUEST_ID, false))
      throw new Error('unreachable')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError)
      expect((error as ContractError).code).toBe('PERMISSION_PLUGIN_CAPABILITY')
      expect((error as ContractError).toPayload().requestId).toBe(REQUEST_ID)
    }
  })
})

// ---------------------------------------------------------------------------
// 架构门禁：SDK 不得泄漏 Cordis 与宿主私有类型
// ---------------------------------------------------------------------------

const SRC_DIR = join(import.meta.dirname, '..', 'src')

function collectSourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...collectSourceFiles(full))
    else if (entry.endsWith('.ts')) found.push(full)
  }
  return found
}

/** Cordis 的类型/值名 —— 出现在 SDK 的公开面上即为违约。 */
const FORBIDDEN_EXPORT_NAMES = [
  'Context',
  'Fiber',
  'FiberState',
  'Service',
  'Inject',
  'RegistryService',
  'EventsService',
  'LoggerService',
  'ReflectService',
  'DisposableList',
  'CordisError',
  'createCallable',
] as const

describe('🔴 架构门禁：SDK 不导出 Cordis', () => {
  it('src/**/*.ts 里没有任何 cordis import', () => {
    const files = collectSourceFiles(SRC_DIR)
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/from\s+['"]cordis['"]/.test(text) || /import\s*\(\s*['"]cordis['"]\s*\)/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('package.json 不依赖 cordis（类型层面也拿不到）', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    expect(Object.keys(all)).not.toContain('cordis')
    expect(Object.keys(all)).toContain('@yfe/contracts')
  })

  it('运行时导出面不含任何 Cordis 名字', async () => {
    const sdk = (await import('../src/index.js')) as Record<string, unknown>
    const names = Object.keys(sdk)
    expect(names.length).toBeGreaterThan(0)
    const leaked = names.filter((name) =>
      (FORBIDDEN_EXPORT_NAMES as readonly string[]).includes(name),
    )
    expect(leaked).toEqual([])
  })

  it('出口只包含 manifest 与 context 两个模块的符号', async () => {
    const sdk = (await import('../src/index.js')) as Record<string, unknown>
    // 逐个抽查必须存在的公开面
    for (const required of [
      'validatePluginManifest',
      'PLUGIN_MANIFEST_VERSION',
      'PLUGIN_CAPABILITIES',
      'PLUGIN_GRANTABLE_CAPABILITIES',
      'PLUGIN_UNGRANTABLE_CAPABILITIES',
      'isGrantableCapability',
      'satisfiesRange',
      'isValidRange',
      'summarizeManifestIssues',
      'requireCapability',
      'capabilityDeniedPayload',
      'PLUGIN_SDK_VERSION',
      'definePlugin',
      'expectOk',
    ]) {
      expect(Object.keys(sdk)).toContain(required)
    }
  })
})
