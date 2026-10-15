/**
 * 面板状态存储的单测（apps/desktop/src/renderer/panels/panel-store.ts）。
 *
 * 用假 AppState 桩验证三条纪律：
 * 1. 保存失败不丢本地数据（error 置位、data 保持、dirty 仍 true）；
 * 2. 同一 store 内串行（在飞时再次 save 只登记待保存）；
 * 3. patch/set 后自动保存按 autoSaveMs 防抖，dispose 后全部停。
 */

import { describe, expect, it, vi } from 'vitest'

import type {
  AppSnapshot,
  AppState,
  SettingsEntityQuery,
  SettingsEntitySubmit,
  SettingsEntitySubmitResult,
  SettingsEntityView,
} from '../src/renderer/app-state.js'
import {
  PANEL_STATE_NAME,
  PANEL_TEMPLATE_PREFIX,
  createPanelStore,
  isPanelTemplateId,
  mergePanelValues,
  panelTemplateId,
} from '../src/renderer/panels/panel-store.js'

interface FakeStateOptions {
  readonly rows?: readonly SettingsEntityView[]
  readonly listError?: Error
  readonly submitImpl?: (submit: SettingsEntitySubmit) => SettingsEntitySubmitResult | Promise<SettingsEntitySubmitResult>
}

function makeRow(overrides: Partial<SettingsEntityView> = {}): SettingsEntityView {
  return {
    id: 'ent_1',
    projectId: 'proj_1',
    schemaTemplateId: 'panel:dashboard',
    name: PANEL_STATE_NAME,
    values: {},
    orderKey: 'A01',
    revision: 'r00000001',
    deleted: false,
    ...overrides,
  }
}

function makeFakeState(options: FakeStateOptions = {}): AppState {
  let entities: readonly SettingsEntityView[] = options.rows ?? []
  const state = {
    loadSettingsEntities: async (_query?: SettingsEntityQuery): Promise<boolean> => {
      if (options.listError !== undefined) throw options.listError
      return true
    },
    getSnapshot: () => ({ settingsEntities: entities }) as unknown as AppSnapshot,
    submitSettingsEntity: async (submit: SettingsEntitySubmit): Promise<SettingsEntitySubmitResult> => {
      const impl = options.submitImpl
      if (impl !== undefined) return await impl(submit)
      const revision = `r${String(entities.length + 1).padStart(8, '0')}`
      if (submit.entityId === null || submit.entityId === undefined) {
        const created: SettingsEntityView = {
          id: `ent_${entities.length + 1}`,
          projectId: 'proj_1',
          schemaTemplateId: submit.schemaTemplateId,
          name: submit.name,
          values: submit.values,
          orderKey: submit.orderKey ?? 'A01',
          revision,
          deleted: false,
        }
        entities = [...entities, created]
        return { ok: true, entityId: created.id, revision, orderKey: created.orderKey }
      }
      const existing = entities.find((row) => row.id === submit.entityId)
      if (existing === undefined) {
        return { ok: false, code: 'NOT_FOUND_SETTINGS_ENTITY', message: '条目不存在' }
      }
      const updated: SettingsEntityView = { ...existing, values: submit.values, revision }
      entities = entities.map((row) => (row.id === submit.entityId ? updated : row))
      return { ok: true, entityId: updated.id, revision, orderKey: updated.orderKey }
    },
  }
  return state as unknown as AppState
}

describe('命名空间与合并', () => {
  it('panelTemplateId / isPanelTemplateId', () => {
    expect(panelTemplateId('dashboard')).toBe('panel:dashboard')
    expect(PANEL_TEMPLATE_PREFIX).toBe('panel:')
    expect(isPanelTemplateId('panel:dashboard')).toBe(true)
    expect(isPanelTemplateId('char-main')).toBe(false)
  })

  it('mergePanelValues：默认补齐 + 库值覆盖 + 未知键保留', () => {
    const merged = mergePanelValues({ dailyGoal: 2000, tone: 'warm' }, { dailyGoal: 3000, extra: 'keep' })
    expect(merged).toEqual({ dailyGoal: 3000, tone: 'warm', extra: 'keep' })
  })
})

describe('createPanelStore.load', () => {
  it('库里没有行：回到默认值、revision 为 null（下次保存是新建）', async () => {
    const state = makeFakeState({ rows: [] })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 })
    await store.load()
    expect(store.loading.value).toBe(false)
    expect(store.data.value).toEqual({ dailyGoal: 2000 })
    expect(store.revision.value).toBeNull()
    expect(store.dirty.value).toBe(false)
    expect(store.error.value).toBeNull()
  })

  it('库里有行：合并进 data、记住 revision 与 entityId，更新带乐观锁', async () => {
    const state = makeFakeState({ rows: [makeRow({ values: { dailyGoal: 1500 }, revision: 'r00000007' })] })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 })
    await store.load()
    expect(store.data.value).toEqual({ dailyGoal: 1500 })
    expect(store.revision.value).toBe('r00000007')

    store.patch({ dailyGoal: 1800 })
    const ok = await store.save()
    expect(ok).toBe(true)
    expect(store.revision.value).toBe('r00000002')
    expect(store.dirty.value).toBe(false)
  })

  it('加载失败：error 置位、loading 复位、data 不丢', async () => {
    const state = makeFakeState({ listError: new Error('存储不可用') })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 })
    await store.load()
    expect(store.error.value).toBe('存储不可用')
    expect(store.loading.value).toBe(false)
    expect(store.data.value).toEqual({ dailyGoal: 2000 })
  })
})

describe('createPanelStore.save', () => {
  it('新建：expectedRevision 为 null、幂等键带自增序号、成功后清脏', async () => {
    const calls: SettingsEntitySubmit[] = []
    const state = makeFakeState({
      submitImpl: async (submit) => {
        calls.push(submit)
        return { ok: true, entityId: 'ent_new', revision: 'r00000001', orderKey: 'A01' }
      },
    })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 0 })
    const ok = await store.save()
    expect(ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]?.entityId).toBeNull()
    expect(calls[0]?.schemaTemplateId).toBe('panel:dashboard')
    expect(calls[0]?.name).toBe(PANEL_STATE_NAME)
    expect(calls[0]?.expectedRevision).toBeNull()
    expect(calls[0]?.idempotencyKey).toBe('panel:dashboard:1')
    expect(store.revision.value).toBe('r00000001')
    expect(store.dirty.value).toBe(false)
  })

  it('保存失败不丢本地数据：error 置位、data 保持、dirty 仍 true', async () => {
    const state = makeFakeState({
      rows: [makeRow({ values: { dailyGoal: 1500 } })],
      submitImpl: async () => ({ ok: false, code: 'REVISION_CONFLICT', message: '已被其它修改更新' }),
    })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 0 })
    await store.load()
    store.patch({ dailyGoal: 1800 })
    const ok = await store.save()
    expect(ok).toBe(false)
    expect(store.error.value).toBe('REVISION_CONFLICT：已被其它修改更新')
    expect(store.data.value).toEqual({ dailyGoal: 1800 })
    expect(store.dirty.value).toBe(true)
  })

  it('同 store 串行：在飞时再次 save 只登记，结算后自动补一次', async () => {
    let resolveFirst: ((result: SettingsEntitySubmitResult) => void) | undefined
    const gate = new Promise<SettingsEntitySubmitResult>((resolve) => {
      resolveFirst = resolve
    })
    const calls: SettingsEntitySubmit[] = []
    const state = makeFakeState({
      submitImpl: async (submit) => {
        calls.push(submit)
        if (calls.length === 1) return await gate
        return { ok: true, entityId: 'ent_x', revision: 'r00000002', orderKey: 'A01' }
      },
    })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 0 })

    const first = store.save()
    const second = await store.save()
    expect(second).toBe(false)
    expect(store.saving.value).toBe(true)
    resolveFirst?.({ ok: true, entityId: 'ent_1', revision: 'r00000001', orderKey: 'A01' })
    expect(await first).toBe(true)
    await vi.waitFor(() => expect(calls.length).toBe(2))
    expect(store.saving.value).toBe(false)
    expect(store.revision.value).toBe('r00000002')
  })

  it('在飞期间又改过：结算后 dirty 保持 true（引用比较）', async () => {
    let resolveFirst: ((result: SettingsEntitySubmitResult) => void) | undefined
    const gate = new Promise<SettingsEntitySubmitResult>((resolve) => {
      resolveFirst = resolve
    })
    const calls: SettingsEntitySubmit[] = []
    const state = makeFakeState({
      submitImpl: async (submit) => {
        calls.push(submit)
        if (calls.length === 1) return await gate
        return { ok: true, entityId: 'ent_x', revision: 'r00000002', orderKey: 'A01' }
      },
    })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 0 })

    const first = store.save()
    store.patch({ dailyGoal: 900 })
    resolveFirst?.({ ok: true, entityId: 'ent_1', revision: 'r00000001', orderKey: 'A01' })
    expect(await first).toBe(true)
    expect(store.dirty.value).toBe(true)
  })
})

describe('自动保存与 dispose', () => {
  it('autoSaveMs 到点自动保存', async () => {
    vi.useFakeTimers()
    try {
      const calls: SettingsEntitySubmit[] = []
      const state = makeFakeState({
        submitImpl: async (submit) => {
          calls.push(submit)
          return { ok: true, entityId: 'ent_1', revision: 'r00000001', orderKey: 'A01' }
        },
      })
      const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 20 })
      store.patch({ dailyGoal: 2100 })
      await vi.advanceTimersByTimeAsync(50)
      expect(calls.length).toBe(1)
      expect(store.dirty.value).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('autoSaveMs 为 0 时不自动保存，只手动 save()', async () => {
    vi.useFakeTimers()
    try {
      const calls: SettingsEntitySubmit[] = []
      const state = makeFakeState({
        submitImpl: async (submit) => {
          calls.push(submit)
          return { ok: true, entityId: 'ent_1', revision: 'r00000001', orderKey: 'A01' }
        },
      })
      const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 }, { autoSaveMs: 0 })
      store.patch({ dailyGoal: 2100 })
      await vi.advanceTimersByTimeAsync(100)
      expect(calls.length).toBe(0)
      expect(await store.save()).toBe(true)
      expect(calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 后 patch/save 全部停', async () => {
    const calls: SettingsEntitySubmit[] = []
    const state = makeFakeState({
      submitImpl: async (submit) => {
        calls.push(submit)
        return { ok: true, entityId: 'ent_1', revision: 'r00000001', orderKey: 'A01' }
      },
    })
    const store = createPanelStore(state, 'dashboard', { dailyGoal: 2000 })
    store.dispose()
    store.patch({ dailyGoal: 1 })
    expect(await store.save()).toBe(false)
    expect(calls.length).toBe(0)
    expect(store.data.value).toEqual({ dailyGoal: 2000 })
  })
})
