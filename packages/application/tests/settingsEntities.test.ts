/**
 * 三个设定实体用例的行为测试（内存 fake）：`listSettingsEntities` /
 * `getSettingsEntity` / `saveSettingsEntity`。
 *
 * 29 个数据驱动旧页签（5 form / 6 card / 18 table）共用这一次数据通道，所以重点钉住
 * 四件「界面会踩、而且踩了很难查」的事：
 * - 读路径的**工作区过滤**（越权读是安全缺陷，不是风格问题）；
 * - 更新的**乐观锁**（`expectedRevision` 过期 → `REVISION_CONFLICT`，由存储层判定）；
 * - 新建的**不变量**（`expectedRevision` 必须为 null）、ID 同源且重放不消耗新 ID；
 * - `values` 是**整体替换**，不是深合并。
 */

import {
  encodeRevision,
  fixedClock,
  type IdempotencyKey,
  type ProjectId,
  type ReadContext,
  type RequestId,
  type SettingsEntityGetInput,
  type SettingsEntityListInput,
  type SettingsEntitySaveInput,
  type WorkspaceId,
  type WriteContext,
} from '@yfe/contracts'
import { describe, expect, it } from 'vitest'

import { createMemoryIdempotencyLedger } from '../src/idempotency.js'
import { getSettingsEntity } from '../src/useCases/getSettingsEntity.js'
import { listSettingsEntities } from '../src/useCases/listSettingsEntities.js'
import { saveSettingsEntity } from '../src/useCases/saveSettingsEntity.js'
import {
  createFakeHarness,
  makeSettingsEntity,
  sequentialIds,
  TEST_PROJECT,
  TEST_WORKSPACE,
} from './fakes.js'

const REQ = 'req-settings-1' as RequestId
const OTHER_WORKSPACE = 'ws-other' as WorkspaceId

function writeContext(patch: Partial<WriteContext> = {}): WriteContext {
  return {
    requestId: REQ,
    workspaceId: TEST_WORKSPACE as WorkspaceId,
    projectId: TEST_PROJECT as ProjectId,
    expectedRevision: null,
    ...patch,
  }
}

function readContext(workspaceId: string = TEST_WORKSPACE): ReadContext {
  return { requestId: REQ, workspaceId: workspaceId as WorkspaceId }
}

function listInput(
  patch: Record<string, unknown> = {},
  workspaceId: string = TEST_WORKSPACE,
): SettingsEntityListInput {
  return { context: readContext(workspaceId), ...patch } as unknown as SettingsEntityListInput
}

function getInput(entityId: unknown, workspaceId: string = TEST_WORKSPACE): SettingsEntityGetInput {
  return { context: readContext(workspaceId), entityId } as unknown as SettingsEntityGetInput
}

function saveInput(
  patch: Record<string, unknown> = {},
  workspaceId: string = TEST_WORKSPACE,
): SettingsEntitySaveInput {
  return {
    context: writeContext({ workspaceId: workspaceId as WorkspaceId }),
    projectId: TEST_PROJECT,
    schemaTemplateId: 'tpl-faction',
    name: '青云门',
    values: { 阵营: '正道' },
    ...patch,
  } as unknown as SettingsEntitySaveInput
}

/** 有 fake 端的用例统一用它装配：确定性 ID + 内存幂等台账。 */
function harnessWithLedger(seed = [makeSettingsEntity()]) {
  const ledger = createMemoryIdempotencyLedger()
  const harness = createFakeHarness({
    ids: sequentialIds(),
    clock: fixedClock('2026-10-15T04:00:00.000Z'),
    idempotency: ledger.port,
    settingsEntities: seed,
  })
  // ⚠️ 必须就地挂载而不是 `{ ledger, ...harness }`：`lastXxx` 是**值属性**，
  // 浅拷贝之后端口里的赋值就再也回不到测试手里的那个对象上了。
  return Object.assign(harness, { ledger })
}

describe('listSettingsEntities：读入口与授权边界', () => {
  it('projectId 缺省时归一成 null（工作区级），不再由用例替调用方猜作品', async () => {
    const harness = harnessWithLedger()
    expect(await listSettingsEntities(harness.deps, listInput())).toEqual({
      ok: true,
      value: { entities: [expect.objectContaining({ id: 'wld-1' })] },
    })
    expect(harness.lastListSettings?.projectId).toBeNull()
    expect(harness.lastListSettings?.schemaTemplateId).toBeNull()
    expect(harness.lastListSettings?.includeDeleted).toBe(false)
  })

  it('projectId 一旦给出就必须合法：非法 ID 不能降级成跨作品查询', async () => {
    const harness = harnessWithLedger()
    const bad = await listSettingsEntities(harness.deps, listInput({ projectId: 'not a valid id' }))
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION_MALFORMED_ID')
    // 关键断言：报错而不是「当作没传」，端口根本没被调用。
    expect(harness.counts.listSettingsEntities).toBe(0)
  })

  it('includeDeleted / schemaTemplateId 透传，values 逐字段原样返回', async () => {
    const harness = harnessWithLedger([
      makeSettingsEntity({ id: 'wld-1', orderKey: 'a1', values: { 阵营: '正道', 人数: 120 } }),
      makeSettingsEntity({ id: 'wld-2', orderKey: 'a2', schemaTemplateId: 'tpl-place' }),
    ])
    const listed = await listSettingsEntities(
      harness.deps,
      listInput({ schemaTemplateId: 'tpl-faction', includeDeleted: true }),
    )
    expect(harness.lastListSettings?.schemaTemplateId).toBe('tpl-faction')
    expect(harness.lastListSettings?.includeDeleted).toBe(true)
    expect(listed.ok && listed.value.entities.map((entity) => entity.id)).toEqual(['wld-1'])
    expect(listed.ok && listed.value.entities[0]?.values).toEqual({ 阵营: '正道', 人数: 120 })
  })

  it('工作区隔离：属于别的工作区的设定不出现在结果里', async () => {
    const harness = harnessWithLedger([
      makeSettingsEntity({ id: 'wld-1' }),
      makeSettingsEntity({ id: 'wld-9', workspaceId: OTHER_WORKSPACE }),
    ])
    const listed = await listSettingsEntities(harness.deps, listInput({}, OTHER_WORKSPACE))
    expect(listed.ok && listed.value.entities.map((entity) => entity.id)).toEqual(['wld-9'])
  })

  it('端口返回非数组 → 兜底错误而不是把坏形状漏给界面', async () => {
    const harness = harnessWithLedger()
    harness.throwOn.listSettingsEntities = undefined
    const broken = {
      ...harness.ports,
      settingsEntities: {
        ...harness.ports.settingsEntities,
        listSettingsEntities: async () => ({ ok: true as const, value: 'nope' as never }),
      },
    }
    const listed = await listSettingsEntities({ ...harness.deps, persistence: broken }, listInput())
    expect(listed.ok).toBe(false)
    expect(listed.ok === false && listed.error.message).toBe('读取到的设定实体列表形状非法')
  })
})

describe('getSettingsEntity：读回与跨工作区拒绝', () => {
  it('读回既有实体（含软删过滤）', async () => {
    const harness = harnessWithLedger([
      makeSettingsEntity({ id: 'wld-1', name: '青云门', revisionSeq: 3 }),
    ])
    const read = await getSettingsEntity(harness.deps, getInput('wld-1'))
    expect(read.ok && read.value.entity.name).toBe('青云门')
    expect(read.ok && read.value.entity.revision).toBe('r00000003')
    expect(harness.counts.getSettingsEntity).toBe(1)
  })

  it('已软删实体默认读不到（NOT_FOUND），而不是返回幽灵数据', async () => {
    const harness = harnessWithLedger([makeSettingsEntity({ id: 'wld-1', deleted: 1 })])
    const read = await getSettingsEntity(harness.deps, getInput('wld-1'))
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error.code).toBe('NOT_FOUND')
  })

  it('跨工作区访问必须是 PERMISSION_WORKSPACE_MISMATCH，不能伪装成 NOT_FOUND', async () => {
    const harness = harnessWithLedger([makeSettingsEntity({ id: 'wld-1' })])
    const read = await getSettingsEntity(harness.deps, getInput('wld-1', OTHER_WORKSPACE))
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
  })

  it('entityId 非法 → 明确的校验错误且端口零调用', async () => {
    const harness = harnessWithLedger()
    const empty = await getSettingsEntity(harness.deps, getInput(''))
    expect(empty.ok).toBe(false)
    expect(empty.ok === false && empty.error.code).toBe('VALIDATION_MISSING_FIELD')
    expect(harness.counts.getSettingsEntity).toBe(0)

    const malformed = await getSettingsEntity(harness.deps, getInput('not a valid id'))
    expect(malformed.ok).toBe(false)
    expect(malformed.ok === false && malformed.error.code).toBe('VALIDATION_MALFORMED_ID')
    expect(harness.counts.getSettingsEntity).toBe(0)
  })
})

describe('saveSettingsEntity：新建 / 更新 / 乐观锁 / 幂等', () => {
  it('新建：ID 由注入工厂产生、端口收到 isCreate 与 expectedRevision=null', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(harness.deps, saveInput())
    expect(saved).toEqual({
      ok: true,
      value: { entityId: 'wld-0001', revision: 'r00000001', orderKey: 'a1' },
    })
    expect(harness.lastSaveSettings?.isCreate).toBe(true)
    expect(harness.lastSaveSettings?.entityId).toBe('wld-0001')
    expect(harness.lastSaveSettings?.context.expectedRevision).toBeNull()
    expect(harness.lastSaveSettings?.occurredAt).toBe('2026-10-15T04:00:00.000Z')
  })

  it('新建带 expectedRevision → VALIDATION_FAILED，且不写库', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(
      harness.deps,
      saveInput({ context: writeContext({ expectedRevision: encodeRevision(9) }) }),
    )
    expect(saved.ok).toBe(false)
    expect(saved.ok === false && saved.error.code).toBe('VALIDATION_FAILED')
    expect(harness.counts.saveSettingsEntity).toBe(0)
  })

  it('新建时显式 orderKey（新建在末位之外的位置）被原样采用', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(harness.deps, saveInput({ orderKey: 'a5' }))
    expect(saved.ok && saved.value.orderKey).toBe('a5')
    expect(harness.lastSaveSettings?.orderKey).toBe('a5')
  })

  it('更新：revision 递增，values 整体替换（不是深合并）', async () => {
    const harness = harnessWithLedger([
      makeSettingsEntity({ id: 'wld-1', values: { 阵营: '正道', 掌门: '李长生' } }),
    ])
    const saved = await saveSettingsEntity(
      harness.deps,
      saveInput({
        entityId: 'wld-1',
        context: writeContext({ expectedRevision: encodeRevision(1) }),
        values: { 阵营: '正道' },
      }),
    )
    expect(saved.ok && saved.value.revision).toBe('r00000002')
    expect(harness.lastSaveSettings?.isCreate).toBe(false)
    // 掌门 字段被整体替换掉，而不是保留：这是契约语义，界面必须回传完整字段集。
    expect(harness.settingsEntities.get('wld-1')?.values).toEqual({ 阵营: '正道' })
  })

  it('更新时 expectedRevision 过期 → REVISION_CONFLICT（存储层判定，用例只透传）', async () => {
    const harness = harnessWithLedger([makeSettingsEntity({ id: 'wld-1', revisionSeq: 4 })])
    const saved = await saveSettingsEntity(
      harness.deps,
      saveInput({ entityId: 'wld-1', context: writeContext({ expectedRevision: encodeRevision(1) }) }),
    )
    expect(saved.ok).toBe(false)
    expect(saved.ok === false && saved.error.code).toBe('REVISION_CONFLICT')
    // 冲突不改数据：revision 停在 4。
    expect(harness.settingsEntities.get('wld-1')?.revision).toBe('r00000004')
  })

  it('幂等键重放：同键同参只写一次、回同一个 entityId，不消耗第二个 ID', async () => {
    const harness = harnessWithLedger([])
    const key = 'form-save-1' as IdempotencyKey
    const first = await saveSettingsEntity(
      harness.deps,
      saveInput({ context: writeContext({ idempotencyKey: key }) }),
    )
    const replay = await saveSettingsEntity(
      harness.deps,
      saveInput({ context: writeContext({ idempotencyKey: key }) }),
    )
    expect(harness.counts.saveSettingsEntity).toBe(1)
    expect(replay).toEqual(first)
    expect(harness.settingsEntities.size).toBe(1)
  })

  it('同键换参 → IDEMPOTENCY_KEY_REUSED（不静默返回上一次的结果）', async () => {
    const harness = harnessWithLedger([])
    const key = 'form-save-2' as IdempotencyKey
    await saveSettingsEntity(
      harness.deps,
      saveInput({ context: writeContext({ idempotencyKey: key }), name: '青云门' }),
    )
    const reused = await saveSettingsEntity(
      harness.deps,
      saveInput({ context: writeContext({ idempotencyKey: key }), name: '魔教' }),
    )
    expect(reused.ok).toBe(false)
    expect(reused.ok === false && reused.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(harness.counts.saveSettingsEntity).toBe(1)
  })

  it('payload 自报的作品与 context 不一致 → 拒绝（不信任 payload 的归属声明）', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(harness.deps, saveInput({ projectId: 'prj-b' }))
    expect(saved.ok).toBe(false)
    expect(saved.ok === false && saved.error.code).toBe('PERMISSION_WORKSPACE_MISMATCH')
    expect(harness.counts.saveSettingsEntity).toBe(0)
  })

  it('values 不是 JSON 对象 / 名字为空 → 校验失败，不进端口', async () => {
    const harness = harnessWithLedger([])
    const badValues = await saveSettingsEntity(harness.deps, saveInput({ values: [] }))
    expect(badValues.ok).toBe(false)
    expect(badValues.ok === false && badValues.error.code).toBe('VALIDATION_FAILED')

    const missingName = await saveSettingsEntity(harness.deps, saveInput({ name: '' }))
    expect(missingName.ok).toBe(false)
    expect(missingName.ok === false && missingName.error.code).toBe('VALIDATION_MISSING_FIELD')

    const longName = await saveSettingsEntity(harness.deps, saveInput({ name: '门'.repeat(201) }))
    expect(longName.ok).toBe(false)
    expect(longName.ok === false && longName.error.code).toBe('VALIDATION_OUT_OF_RANGE')
    expect(harness.counts.saveSettingsEntity).toBe(0)
  })

  it('名字只有空白字符 → 按作者输入接受（应用层刻意不 trim）', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(harness.deps, saveInput({ name: '   ' }))
    expect(saved.ok).toBe(true)
    expect(harness.lastSaveSettings?.name).toBe('   ')
  })

  it('入参不是对象 → 明确的 VALIDATION_FAILED（而不是 TypeError 冒泡成 INTERNAL_ERROR）', async () => {
    const harness = harnessWithLedger([])
    const saved = await saveSettingsEntity(harness.deps, undefined as never)
    expect(saved.ok).toBe(false)
    expect(saved.ok === false && saved.error.code).toBe('VALIDATION_FAILED')
  })

  it('端口漏回 orderKey → 兜底为 INTERNAL_ERROR，不把 undefined 交给界面', async () => {
    const harness = harnessWithLedger([])
    const broken = {
      ...harness.ports,
      settingsEntities: {
        ...harness.ports.settingsEntities,
        saveSettingsEntity: async () => ({
          ok: true as const,
          value: { entityId: 'wld-1', revision: 'r00000001' } as never,
        }),
      },
    }
    const saved = await saveSettingsEntity(
      { ...harness.deps, persistence: broken },
      saveInput(),
    )
    expect(saved.ok).toBe(false)
    expect(saved.ok === false && saved.error.message).toBe('保存设定实体结果缺少必要字段')
  })
})
