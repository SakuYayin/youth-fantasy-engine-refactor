/**
 * 插件宿主的生命周期测试。
 *
 * 这些用例对应设计文档 `05-插件内核与SDK.md` 的「发布门禁必测项」与 task-4 的验收清单：
 * 非法 manifest、依赖缺失/循环拒绝、**激活失败后宿主继续服务其它插件**、反复启停无资源泄漏、
 * **运行任务中禁用**、降级拒写。
 *
 * 宿主是真实实现（真的通过 Cordis 适配层加载插件 fiber），不是 mock —— 否则测不到
 * ADR 0002 记录的那些上游语义（await 对依赖缺失插件同样 resolve、永久挂起 disposer 等）。
 */

import { describe, expect, it } from 'vitest'

import type { RequestId, WorkspaceId } from '@yfe/contracts'
import { PLUGIN_API_VERSION } from '@yfe/contracts'
import { isGrantableCapability } from '@yfe/plugin-sdk'
import type { PluginContext, ProductPlugin } from '@yfe/plugin-sdk'

import { PluginHost, defineCandidate } from '../src/host/index.js'
import type { PluginStatus } from '../src/host/index.js'

const WORKSPACE = 'ws_host_test_0001' as WorkspaceId
const REQUEST = 'req_host_test_0001' as RequestId
const TRUSTED = ['yfe.alpha', 'yfe.beta', 'yfe.gamma', 'yfe.delta', 'yfe.epsilon'] as const

/** 基线 manifest 工厂：只覆盖本测试需要的字段，其余走 validator 的必填项。 */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'yfe.alpha',
    name: 'Alpha',
    version: '1.0.0',
    manifestVersion: 1,
    hostApiRange: `^${PLUGIN_API_VERSION}`,
    kind: 'trusted-builtin',
    platforms: ['win32'],
    entries: { service: 'index.js' },
    permissions: [],
    contributes: {},
    dataSchemaVersion: 1,
    ...overrides,
  }
}

function host(options: { trusted?: readonly string[]; cleanupTimeoutMs?: number } = {}): PluginHost {
  return new PluginHost({
    workspaceId: WORKSPACE,
    trustedPluginIds: options.trusted ?? TRUSTED,
    ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
  })
}

/** 无副作用的插件。 */
function noopPlugin(): ProductPlugin {
  return { activate: async () => {} }
}

describe('register —— manifest 校验与可信来源', () => {
  it('合法 manifest 注册成功，状态为 registered 且尚未激活', () => {
    const h = host()
    const result = h.register(defineCandidate(manifest(), noopPlugin()), REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.pluginId).toBe('yfe.alpha')
    expect(result.value.state).toBe('registered')
    expect(result.value.version).toBe('1.0.0')
    expect(h.isActive('yfe.alpha')).toBe(false)
  })

  it('非对象 manifest → PLUGIN_MANIFEST_INVALID', () => {
    const h = host()
    for (const bad of [null, undefined, 42, 'x', []]) {
      const result = h.register(defineCandidate(bad, noopPlugin()), REQUEST)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.error.code).toBe('PLUGIN_MANIFEST_INVALID')
      expect(result.error.detail?.['reason']).toBe('manifest-invalid')
    }
  })

  it('缺字段 manifest → PLUGIN_MANIFEST_INVALID，detail 只含标量', () => {
    const h = host()
    const result = h.register(defineCandidate({ id: 'yfe.alpha' }, noopPlugin()), REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(result.error.detail?.['reason']).toBe('manifest-invalid')
    expect(typeof result.error.detail?.['issueCount']).toBe('number')
    expect(typeof result.error.detail?.['issueCodes']).toBe('string')
    // detail 不允许出现对象/数组（IPC 面）
    for (const value of Object.values(result.error.detail ?? {})) {
      expect(['string', 'number', 'boolean']).toContain(typeof value)
    }
  })

  it('插件 id 形态非法（大写 / 单段 / 路径）→ 拒绝', () => {
    const h = host()
    for (const id of ['YFE.Alpha', 'alpha', 'yfe/../etc', 'yfe.Alpha']) {
      const result = h.register(defineCandidate(manifest({ id }), noopPlugin()), REQUEST)
      expect(result.ok).toBe(false)
    }
  })

  it('🔴 kind=trusted-builtin 但不在发行清单 → 拒绝（kind 是格式声明不是信任授予）', () => {
    const h = host({ trusted: ['yfe.something-else'] })
    const result = h.register(defineCandidate(manifest(), noopPlugin()), REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(result.error.detail?.['reason']).toBe('not-trusted-builtin')
  })

  it('重复注册同一 id → ALREADY_EXISTS', () => {
    const h = host()
    expect(h.register(defineCandidate(manifest(), noopPlugin()), REQUEST).ok).toBe(true)
    const again = h.register(defineCandidate(manifest(), noopPlugin()), REQUEST)
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('unreachable')
    expect(again.error.code).toBe('ALREADY_EXISTS')
  })

  it('缺少 activate() 实现 → PLUGIN_MANIFEST_INVALID', () => {
    const h = host()
    const result = h.register(
      defineCandidate(manifest(), {} as unknown as ProductPlugin),
      REQUEST,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.detail?.['reason']).toBe('missing-activate')
  })

  it('未注册的插件 load/enable/disable/statusOf 都按 NOT_FOUND 处理', async () => {
    const h = host()
    const loaded = await h.load('yfe.ghost', REQUEST)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('unreachable')
    expect(loaded.error.code).toBe('PLUGIN_NOT_FOUND')

    const disabled = await h.disable('yfe.ghost', { requestId: REQUEST })
    expect(disabled.ok).toBe(false)
    if (disabled.ok) throw new Error('unreachable')
    expect(disabled.error.code).toBe('PLUGIN_NOT_FOUND')
    expect(h.statusOf('yfe.ghost')).toBeUndefined()
  })
})

describe('load —— 依赖图（缺失 / 循环 / 版本）', () => {
  it('依赖缺失 → PLUGIN_MANIFEST_INVALID（reason=dependency-missing）', async () => {
    const h = host()
    h.register(
      defineCandidate(manifest({ dependencies: [{ id: 'yfe.missing', range: '^1.0.0' }] }), noopPlugin()),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // 契约无 PLUGIN_DEPENDENCY_MISSING 码：映射到 MANIFEST_INVALID，用 reason 区分。
    expect(result.error.code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(result.error.detail?.['reason']).toBe('dependency-missing')
    expect(result.error.detail?.['missing']).toBe('yfe.missing')
    expect(h.isActive('yfe.alpha')).toBe(false)
  })

  it('依赖循环 → PLUGIN_MANIFEST_INVALID（reason=dependency-cycle），且给出环路径', async () => {
    const h = host()
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.alpha', dependencies: [{ id: 'yfe.beta', range: '^1.0.0' }] }),
        noopPlugin(),
      ),
      REQUEST,
    )
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.beta', dependencies: [{ id: 'yfe.alpha', range: '^1.0.0' }] }),
        noopPlugin(),
      ),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(result.error.detail?.['reason']).toBe('dependency-cycle')
    expect(String(result.error.detail?.['cycle'])).toContain('yfe.alpha')
    expect(h.isActive('yfe.alpha')).toBe(false)
    expect(h.isActive('yfe.beta')).toBe(false)
  })

  it('自依赖被 manifest 校验直接拒绝', () => {
    const h = host()
    const result = h.register(
      defineCandidate(manifest({ dependencies: [{ id: 'yfe.alpha', range: '^1.0.0' }] }), noopPlugin()),
      REQUEST,
    )
    expect(result.ok).toBe(false)
  })

  it('依赖版本不满足 → PLUGIN_API_INCOMPATIBLE', async () => {
    const h = host()
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.beta', version: '1.0.0' }),
        noopPlugin(),
      ),
      REQUEST,
    )
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.alpha', dependencies: [{ id: 'yfe.beta', range: '^2.0.0' }] }),
        noopPlugin(),
      ),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_API_INCOMPATIBLE')
    expect(result.error.detail?.['dependencyId']).toBe('yfe.beta')
  })

  it('依赖合法时按拓扑序激活（依赖先于被依赖者）', async () => {
    const h = host()
    const order: string[] = []
    const mark = (id: string): ProductPlugin => ({
      activate: async () => {
        order.push(id)
      },
    })
    h.register(defineCandidate(manifest({ id: 'yfe.beta' }), mark('yfe.beta')), REQUEST)
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.alpha', dependencies: [{ id: 'yfe.beta', range: '^1.0.0' }] }),
        mark('yfe.alpha'),
      ),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.activated).toEqual(['yfe.beta', 'yfe.alpha'])
    expect(order).toEqual(['yfe.beta', 'yfe.alpha'])
    expect(h.isActive('yfe.alpha')).toBe(true)
    expect(h.isActive('yfe.beta')).toBe(true)
  })

  it('hostApiRange 与宿主不兼容 → PLUGIN_API_INCOMPATIBLE', async () => {
    const h = host()
    h.register(defineCandidate(manifest({ hostApiRange: '^9.0.0' }), noopPlugin()), REQUEST)
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_API_INCOMPATIBLE')
    expect(result.error.detail?.['reason']).toBe('host-api-incompatible')
  })

  it('requiredServices 未提供 → PLUGIN_ACTIVATION_FAILED', async () => {
    const h = host()
    h.register(
      defineCandidate(manifest({ requiredServices: ['missingService'] }), noopPlugin()),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_ACTIVATION_FAILED')
    expect(result.error.detail?.['reason']).toBe('required-service-missing')
  })

  it('requiredServices 已提供时成功激活', async () => {
    const h = host()
    const service = { ping: () => 'pong' }
    h.provideService('outlineService', service)
    let seen: unknown = null
    h.register(
      defineCandidate(manifest({ requiredServices: ['outlineService'] }), {
        activate: async (context) => {
          const resolved = context.services.get('outlineService')
          expect(resolved.ok).toBe(true)
          if (resolved.ok) seen = resolved.value
        },
      }),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(true)
    expect(seen).not.toBeNull()
    expect((seen as { ping: () => string }).ping()).toBe('pong')
  })

  it('未注册的服务 get() 返回 NOT_FOUND（不是 undefined、不抛错）', async () => {
    const h = host()
    let captured: unknown
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          captured = context.services.get('nope')
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const result = captured as { ok: boolean; error?: { code: string; message: string; detail?: Record<string, unknown> } }
    expect(result.ok).toBe(false)
    // 缺服务必须是 NOT_FOUND 而不是 PLUGIN_NOT_FOUND（后者语义是「插件未注册」）
    expect(result.error?.code).toBe('NOT_FOUND')
    expect(result.error?.detail?.['service']).toBe('nope')
    expect(result.error?.message).toContain('nope')
  })

  it('重复 load 同一插件是幂等的（alreadyActive）', async () => {
    const h = host()
    let activations = 0
    h.register(
      defineCandidate(manifest(), {
        activate: async () => {
          activations += 1
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const second = await h.load('yfe.alpha', REQUEST)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.value.alreadyActive).toEqual(['yfe.alpha'])
    expect(activations).toBe(1)
  })
})

describe('🔴 激活失败后宿主仍可继续加载其它插件', () => {
  it('一个插件 activate 抛错，其它插件照常加载', async () => {
    const h = host()
    const activated: string[] = []
    h.register(
      defineCandidate(manifest({ id: 'yfe.beta' }), {
        activate: async () => {
          throw new Error('beta-boom')
        },
      }),
      REQUEST,
    )
    h.register(
      defineCandidate(manifest({ id: 'yfe.gamma' }), {
        activate: async () => {
          activated.push('yfe.gamma')
        },
      }),
      REQUEST,
    )

    const failed = await h.load('yfe.beta', REQUEST)
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('unreachable')
    expect(failed.error.code).toBe('PLUGIN_ACTIVATION_FAILED')
    expect(failed.error.detail?.['reason']).toBe('activation-threw')
    expect(failed.error.message).toContain('beta-boom')
    expect(h.statusOf('yfe.beta')?.state).toBe('failed')

    // 🔴 关键断言：宿主未被拖垮。
    const okResult = await h.load('yfe.gamma', REQUEST)
    expect(okResult.ok).toBe(true)
    expect(activated).toEqual(['yfe.gamma'])
    expect(h.isActive('yfe.gamma')).toBe(true)
  })

  it('异步 activate 抛错同样被判定为 PLUGIN_ACTIVATION_FAILED', async () => {
    const h = host()
    h.register(
      defineCandidate(manifest(), {
        activate: async () => {
          await Promise.resolve()
          throw new Error('async-boom')
        },
      }),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('PLUGIN_ACTIVATION_FAILED')
    expect(result.error.message).toContain('async-boom')
  })

  it('激活抛错后已注册的副作用被回滚（贡献点不残留）', async () => {
    const h = host()
    h.register(
      defineCandidate(
        manifest({ contributes: { panels: ['brokenPanel'] }, permissions: ['plugin.ui.panel'] }),
        {
          activate: async (context) => {
            const registered = context.contributions.register({
              kind: 'panel',
              id: 'brokenPanel',
              title: 'Broken',
            })
            expect(registered.ok).toBe(true)
            throw new Error('rollback-me')
          },
        },
      ),
      REQUEST,
    )
    const result = await h.load('yfe.alpha', REQUEST)
    expect(result.ok).toBe(false)
    // 激活失败必须回滚，否则重试会撞 ALREADY_EXISTS
    expect(h.resources().contributions).toBe(0)
    expect(h.resources().liveFibers).toBe(0)
  })

  it('失败插件可以重新 enable（反复重试不会累积泄漏）', async () => {
    const h = host()
    let attempts = 0
    h.register(
      defineCandidate(manifest(), {
        activate: async () => {
          attempts += 1
          if (attempts < 3) throw new Error(`boom-${attempts}`)
        },
      }),
      REQUEST,
    )
    expect((await h.load('yfe.alpha', REQUEST)).ok).toBe(false)
    expect((await h.enable('yfe.alpha', REQUEST)).ok).toBe(false)
    const third = await h.enable('yfe.alpha', REQUEST)
    expect(third.ok).toBe(true)
    expect(attempts).toBe(3)
    expect(h.resources().liveFibers).toBe(1)
  })

  it('激活失败被记入宿主日志（不静默）', async () => {
    const h = host()
    h.register(
      defineCandidate(manifest(), {
        activate: async () => {
          throw new Error('logged-boom')
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const messages = h.logs.map((entry) => `${entry.level}:${entry.message}`)
    expect(messages.some((message) => message.includes('plugin activation failed'))).toBe(true)
  })
})

describe('disable —— 释放顺序与运行任务', () => {
  it('正常停用：状态变为 disabled，资源归零', async () => {
    const h = host()
    h.register(defineCandidate(manifest(), noopPlugin()), REQUEST)
    await h.load('yfe.alpha', REQUEST)
    expect(h.resources().liveFibers).toBe(1)

    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.state).toBe('disabled')
    expect(result.value.cleanupTimedOut).toBe(false)
    expect(h.statusOf('yfe.alpha')?.state).toBe('disabled')
    expect(h.resources().liveFibers).toBe(0)
    expect(h.resources().activePlugins).toBe(0)
    expect(h.resources().liveEffects).toBe(0)
  })

  it('停用后 enable 可以重新激活（反复启停 10 轮资源不增长）', async () => {
    const h = host()
    h.register(
      defineCandidate(manifest({ contributes: { commands: ['toggle'] } }), {
        activate: async (context) => {
          context.contributions.register({ kind: 'command', id: 'toggle', title: 'Toggle' })
          context.effects.add(() => {})
          context.effects.add(() => {})
        },
      }),
      REQUEST,
    )
    for (let round = 0; round < 10; round += 1) {
      const enabled = await h.enable('yfe.alpha', REQUEST)
      expect(enabled.ok).toBe(true)
      const disabled = await h.disable('yfe.alpha', { requestId: REQUEST })
      expect(disabled.ok).toBe(true)
    }
    const snapshot = h.resources()
    // 🔴 发布门禁：「连续启停后资源计数回到可解释范围」。
    expect(snapshot.registeredPlugins).toBe(1)
    expect(snapshot.activePlugins).toBe(0)
    expect(snapshot.liveFibers).toBe(0)
    expect(snapshot.liveEffects).toBe(0)
    expect(snapshot.pendingTasks).toBe(0)
    expect(snapshot.contributions).toBe(0)
    expect(snapshot.quarantined).toBe(0)
  })

  it('effects 按 LIFO 逆序释放', async () => {
    const h = host()
    const order: string[] = []
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(() => {
            order.push('first')
          })
          context.effects.add(() => {
            order.push('second')
          })
          context.effects.add(() => {
            order.push('third')
          })
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('一个 effect 抛错不影响其它 effect（宿主自管 LIFO + 逐个 try/catch）', async () => {
    const h = host()
    const order: string[] = []
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(() => {
            order.push('a')
          })
          context.effects.add(() => {
            order.push('b-throw')
            throw new Error('effect-boom')
          })
          context.effects.add(() => {
            order.push('c')
          })
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // c 先跑并抛错，a 仍必须执行（上游同一 effect 内会中断，宿主已规避）
    expect(order).toEqual(['c', 'b-throw', 'a'])
    expect(result.value.effectsFailed).toBe(1)
    expect(result.value.cleanupTimedOut).toBe(false)
    expect(result.value.state).toBe('disabled')
    expect(h.resources().liveEffects).toBe(0)
  })

  it('🔴 运行任务时禁用：先关闸拒绝新任务，再取消在途任务', async () => {
    const h = host({ cleanupTimeoutMs: 500 })
    let contextRef: PluginContext | undefined
    let sawAbort = false
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          contextRef = context
          const started = context.tasks.start('long-task', async (signal) => {
            // 模拟「检查 abort 的良性任务」
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                sawAbort = true
                resolve()
                return
              }
              signal.addEventListener('abort', () => {
                sawAbort = true
                resolve()
              })
            })
          })
          expect(started.ok).toBe(true)
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    expect(h.resources().pendingTasks).toBe(1)

    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.drain).toBe('drained')
    expect(sawAbort).toBe(true)
    expect(h.resources().pendingTasks).toBe(0)

    // 关闸后新任务被拒（PLUGIN_DISABLED）
    const denied = contextRef?.tasks.start('late-task', async () => {})
    expect(denied?.ok).toBe(false)
    if (denied && !denied.ok) expect(denied.error.code).toBe('PLUGIN_DISABLED')
  })

  it('不检查 abort 的任务会走到 timeout → 插件进入 quarantined', async () => {
    const h = host({ cleanupTimeoutMs: 60 })
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          // 故意忽略 signal：宿主无法强杀（ADR 008 边界）
          context.tasks.start('stuck-task', async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5000))
          })
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.drain).toBe('timeout')
    expect(result.value.cleanupTimedOut).toBe(true)
    expect(result.value.state).toBe('quarantined')
    expect(h.statusOf('yfe.alpha')?.state).toBe('quarantined')
    expect(h.statusOf('yfe.alpha')?.lastFailure).toBe('cleanup-timeout')
  })

  it('quarantined 插件拒绝重新 enable（必须重启宿主）', async () => {
    const h = host({ cleanupTimeoutMs: 50 })
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(() => new Promise<void>(() => {}))
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const disabled = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(disabled.ok).toBe(true)
    if (!disabled.ok) throw new Error('unreachable')
    expect(disabled.value.state).toBe('quarantined')

    const enabled = await h.enable('yfe.alpha', REQUEST)
    expect(enabled.ok).toBe(false)
    if (enabled.ok) throw new Error('unreachable')
    expect(enabled.error.code).toBe('PLUGIN_ACTIVATION_FAILED')
    expect(enabled.error.detail?.['reason']).toBe('cleanup-timeout')
  })

  it('永久挂起的 disposer → cleanup 超时 → quarantined', async () => {
    const h = host({ cleanupTimeoutMs: 50 })
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(async () => {
            await new Promise<void>(() => {})
          })
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.cleanupTimedOut).toBe(true)
    expect(result.value.state).toBe('quarantined')
  })

  it('deactivate 抛错不阻断清理，插件仍是 disabled', async () => {
    const h = host()
    let effectsRan = 0
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(() => {
            effectsRan += 1
          })
        },
        deactivate: async () => {
          throw new Error('deactivate-boom')
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.state).toBe('disabled')
    expect(effectsRan).toBe(1)
    expect(h.logs.some((entry) => entry.message.includes('deactivate threw'))).toBe(true)
  })

  it('重复 disable 幂等（不产生额外清理，也不报错）', async () => {
    const h = host()
    let effectsRan = 0
    h.register(
      defineCandidate(manifest(), {
        activate: async (context) => {
          context.effects.add(() => {
            effectsRan += 1
          })
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    const first = await h.disable('yfe.alpha', { requestId: REQUEST })
    const second = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(first.ok && second.ok).toBe(true)
    expect(effectsRan).toBe(1)
    if (second.ok) {
      expect(second.value.state).toBe('disabled')
      expect(second.value.effectsAttempted).toBe(0)
    }
  })

  it('被已激活插件依赖时 disable 被拒（STATE_INVALID_TRANSITION），force 可绕过', async () => {
    const h = host()
    h.register(defineCandidate(manifest({ id: 'yfe.beta' }), noopPlugin()), REQUEST)
    h.register(
      defineCandidate(
        manifest({ id: 'yfe.alpha', dependencies: [{ id: 'yfe.beta', range: '^1.0.0' }] }),
        noopPlugin(),
      ),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)

    const refused = await h.disable('yfe.beta', { requestId: REQUEST })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error.code).toBe('STATE_INVALID_TRANSITION')
    expect(refused.error.detail?.['dependents']).toBe('yfe.alpha')

    const forced = await h.disable('yfe.beta', { force: true, requestId: REQUEST })
    expect(forced.ok).toBe(true)
    expect(h.isActive('yfe.beta')).toBe(false)
  })

  it('停用后 contributions 被宿主兜底释放（插件忘记注销也不泄漏）', async () => {
    const h = host()
    h.register(
      defineCandidate(
        manifest({ contributes: { panels: ['leftPanel'] }, permissions: ['plugin.ui.panel'] }),
        {
          activate: async (context) => {
            context.contributions.register({ kind: 'panel', id: 'leftPanel', title: 'Left' })
            // 刻意不保存 disposer：测试宿主兜底
          },
        },
      ),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    expect(h.resources().contributions).toBe(1)
    const result = await h.disable('yfe.alpha', { requestId: REQUEST })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.contributionsReleased).toBe(1)
    expect(h.resources().contributions).toBe(0)
  })
})

describe('🔴 降级拒写与能力拒绝', () => {
  it('未声明 plugin.data.write 时 set/delete/clear 全部被拒，读仍然可用', async () => {
    const h = host()
    const outcomes: { op: string; code: string | undefined }[] = []
    h.register(
      defineCandidate(manifest({ permissions: ['plugin.data.read'] }), {
        activate: async (context) => {
          const set = await context.data.set('k', 'v')
          outcomes.push({ op: 'set', code: set.ok ? undefined : set.error.code })
          const del = await context.data.delete('k')
          outcomes.push({ op: 'delete', code: del.ok ? undefined : del.error.code })
          const clear = await context.data.clear()
          outcomes.push({ op: 'clear', code: clear.ok ? undefined : clear.error.code })
          const read = await context.data.get('k')
          expect(read.ok).toBe(true)
        },
      }),
      REQUEST,
    )
    const loaded = await h.load('yfe.alpha', REQUEST)
    expect(loaded.ok).toBe(true)
    expect(outcomes).toEqual([
      { op: 'set', code: 'PERMISSION_PLUGIN_CAPABILITY' },
      { op: 'delete', code: 'PERMISSION_PLUGIN_CAPABILITY' },
      { op: 'clear', code: 'PERMISSION_PLUGIN_CAPABILITY' },
    ])
  })

  it('声明了 plugin.data.write 时写入成功并可读回', async () => {
    const h = host()
    let readBack: unknown
    let buckets = 0
    h.register(
      defineCandidate(manifest({ permissions: ['plugin.data.read', 'plugin.data.write'] }), {
        activate: async (context) => {
          const written = await context.data.set('greeting', 'hi')
          expect(written.ok).toBe(true)
          const read = await context.data.get('greeting')
          if (read.ok) readBack = read.value
          const keys = await context.data.keys()
          expect(keys.ok).toBe(true)
          if (keys.ok) buckets = keys.value.length
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    expect(readBack).toBe('hi')
    expect(buckets).toBe(1)
    expect(h.resources().dataBuckets).toBe(1)
  })

  it('不可授予的能力（host.*）即使声明也不获批', () => {
    const h = host()
    h.register(
      defineCandidate(
        manifest({ permissions: ['host.process.spawn', 'host.filesystem.write'] }),
        noopPlugin(),
      ),
      REQUEST,
    )
    const status = h.statusOf('yfe.alpha') as PluginStatus
    expect(status.declaredCapabilities).toContain('host.process.spawn')
    // 声明 ≠ 授权：不可安全授予的能力不进入 granted
    expect(status.grantedCapabilities).toEqual([])
    for (const capability of status.grantedCapabilities) {
      expect(isGrantableCapability(capability)).toBe(true)
    }
  })

  it('未声明 plugin.ui.panel 时注册面板被拒（PERMISSION_PLUGIN_CAPABILITY）', async () => {
    const h = host()
    let code: string | undefined
    h.register(
      defineCandidate(manifest({ contributes: { panels: ['p1'] } }), {
        activate: async (context) => {
          const result = context.contributions.register({ kind: 'panel', id: 'p1', title: 'P1' })
          if (!result.ok) code = result.error.code
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    expect(code).toBe('PERMISSION_PLUGIN_CAPABILITY')
  })

  it('有面板能力但未在 contributes 声明 id → PLUGIN_MANIFEST_INVALID', async () => {
    const h = host()
    let code: string | undefined
    let reason: unknown
    h.register(
      defineCandidate(manifest({ permissions: ['plugin.ui.panel'], contributes: { panels: ['other'] } }), {
        activate: async (context) => {
          const result = context.contributions.register({ kind: 'panel', id: 'p1', title: 'P1' })
          if (!result.ok) {
            code = result.error.code
            reason = result.error.detail?.['reason']
          }
        },
      }),
      REQUEST,
    )
    await h.load('yfe.alpha', REQUEST)
    expect(code).toBe('PLUGIN_MANIFEST_INVALID')
    expect(reason).toBe('contribution-not-declared')
  })

  it('两个插件抢同一贡献点 id → 第二个被拒 ALREADY_EXISTS', async () => {
    const h = host()
    const codes: (string | undefined)[] = []
    const plugin = (slot: number): ProductPlugin => ({
      activate: async (context) => {
        const result = context.contributions.register({ kind: 'panel', id: 'shared', title: 'Shared' })
        codes[slot] = result.ok ? undefined : result.error.code
      },
    })
    const panelManifest = (id: string): Record<string, unknown> =>
      manifest({ id, permissions: ['plugin.ui.panel'], contributes: { panels: ['shared'] } })
    h.register(defineCandidate(panelManifest('yfe.alpha'), plugin(0)), REQUEST)
    h.register(defineCandidate(panelManifest('yfe.beta'), plugin(1)), REQUEST)
    expect((await h.load('yfe.alpha', REQUEST)).ok).toBe(true)
    expect((await h.load('yfe.beta', REQUEST)).ok).toBe(true)
    expect(codes[0]).toBeUndefined()
    expect(codes[1]).toBe('ALREADY_EXISTS')
    expect(h.resources().contributions).toBe(1)
  })
})

describe('destroy —— 关闭宿主', () => {
  it('deactivate 永久挂起仍完成其它清理并隔离插件，destroy 能完成', async () => {
    const h = host({ cleanupTimeoutMs: 10 })
    let cleaned = false
    h.register(defineCandidate(manifest(), {
      activate: async (context) => { context.effects.add(() => { cleaned = true }) },
      deactivate: () => new Promise<void>(() => {}),
    }), REQUEST)
    await h.load('yfe.alpha', REQUEST)
    const report = await h.disable('yfe.alpha')
    expect(report.ok && report.value.state).toBe('quarantined')
    expect(cleaned).toBe(true)
    expect(await h.destroy()).toEqual(['yfe.alpha'])
  })

  it('重复 disable 和 destroy 不得解除 quarantined 或允许重新激活', async () => {
    const h = host({ cleanupTimeoutMs: 10 })
    let activations = 0
    h.register(defineCandidate(manifest(), {
      activate: async (context) => {
        activations += 1
        context.tasks.start('stuck', () => new Promise<void>(() => {}))
      },
    }), REQUEST)
    await h.load('yfe.alpha', REQUEST)
    await h.disable('yfe.alpha')
    expect(h.resources().pendingTasks).toBe(1)
    const again = await h.disable('yfe.alpha')
    expect(again.ok && again.value.state).toBe('quarantined')
    expect((await h.enable('yfe.alpha')).ok).toBe(false)
    expect(await h.destroy()).toEqual(['yfe.alpha'])
    expect(h.statusOf('yfe.alpha')?.state).toBe('quarantined')
    expect(activations).toBe(1)
  })

  it('激活失败的任务未排空时隔离，并关闭原上下文的任务闸门', async () => {
    const h = host({ cleanupTimeoutMs: 10 })
    let captured: PluginContext | undefined
    h.register(defineCandidate(manifest(), {
      activate: async (context) => {
        captured = context
        context.tasks.start('stuck', () => new Promise<void>(() => {}))
        throw new Error('activation-failed')
      },
    }), REQUEST)
    expect((await h.load('yfe.alpha')).ok).toBe(false)
    expect(h.statusOf('yfe.alpha')?.state).toBe('quarantined')
    expect(h.resources().pendingTasks).toBe(1)
    const late = captured?.tasks.start('late', async () => {})
    expect(late?.ok).toBe(false)
    expect((await h.enable('yfe.alpha')).ok).toBe(false)
    await h.destroy()
  })

  it('激活回滚的 effect 永久挂起时不能重试激活', async () => {
    const h = host({ cleanupTimeoutMs: 10 })
    h.register(defineCandidate(manifest(), {
      activate: async (context) => {
        context.effects.add(() => new Promise<void>(() => {}))
        throw new Error('activation-failed')
      },
    }), REQUEST)
    expect((await h.load('yfe.alpha')).ok).toBe(false)
    expect(h.statusOf('yfe.alpha')?.state).toBe('quarantined')
    expect((await h.enable('yfe.alpha')).ok).toBe(false)
    await h.destroy()
  })

  it('destroy 停用全部插件，返回 quarantined 列表为空', async () => {
    const h = host()
    h.register(defineCandidate(manifest({ id: 'yfe.beta' }), noopPlugin()), REQUEST)
    h.register(defineCandidate(manifest({ id: 'yfe.gamma' }), noopPlugin()), REQUEST)
    await h.load('yfe.beta', REQUEST)
    await h.load('yfe.gamma', REQUEST)
    expect(h.resources().liveFibers).toBe(2)

    const quarantined = await h.destroy()
    expect(quarantined).toEqual([])
    expect(h.resources().liveFibers).toBe(0)
    expect(h.resources().contributions).toBe(0)
    // 幂等
    expect(await h.destroy()).toEqual([])
  })
})

describe('🔴 架构门禁：宿主公开签名不出现 Cordis 类型', () => {
  it('宿主 src 里只有 adapter/** 允许 import cordis', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const srcDir = join(import.meta.dirname, '..', 'src')
    const collect = (dir: string): string[] => {
      const found: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) found.push(...collect(full))
        else if (entry.endsWith('.ts')) found.push(full)
      }
      return found
    }
    const offenders = collect(srcDir).filter((file) => {
      if (file.includes(`${join('src', 'adapter')}`)) return false
      const text = readFileSync(file, 'utf8')
      return /from\s+['"]cordis['"]/.test(text)
    })
    expect(offenders).toEqual([])
  })

  it('适配层导出的公开 API 不含 Context / Fiber 类型名', async () => {
    const adapter = (await import('../src/adapter/cordis.js')) as Record<string, unknown>
    expect(Object.keys(adapter)).not.toContain('Context')
    expect(Object.keys(adapter)).not.toContain('Fiber')
    expect(Object.keys(adapter)).not.toContain('FiberState')
    expect(typeof adapter['cordisEventIsolationSupported']).toBe('function')
    expect((adapter['cordisEventIsolationSupported'] as () => boolean)()).toBe(false)
  })

  it('宿主门面导出的都是产品语义符号', async () => {
    const facade = (await import('../src/index.js')) as Record<string, unknown>
    for (const required of [
      'PluginHost',
      'defineCandidate',
      'DEFAULT_CLEANUP_TIMEOUT_MS',
      'resolveLoadOrder',
      'dependentsOf',
    ]) {
      expect(Object.keys(facade)).toContain(required)
    }
    expect(Object.keys(facade)).not.toContain('Context')
    expect(Object.keys(facade)).not.toContain('Fiber')
    expect(Object.keys(facade)).not.toContain('CordisRuntime')
  })
})
