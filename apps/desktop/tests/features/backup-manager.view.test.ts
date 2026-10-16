// @vitest-environment happy-dom
/**
 * 「备份与恢复」视图测试（真实挂载 + `@vue/test-utils`）—— W8-B。
 *
 * 覆盖的是**接线**：`onMounted` 是否真的去拉列表、点击是否真调了端口的四个方法且参数
 * 正确、`FeatureResult.ok === false` 的 `message` 是否真的渲染出来、`readable:false`
 * 的项是否「列表里还在、按钮是灰的、理由写着」，以及恢复前的复选框闸门是否真的挡住了
 * `restore` 调用。纯逻辑的口径（体积段位、时间分支、排序）在 `backup-manager.test.ts` 里，这里不重复。
 *
 * 环境差异处理（VTU 2.5.1）：
 * - `get(...)` 的返回值**没有** `.exists()`：存在性靠 `.element` 佐证，缺失性一律走 `find(...).exists()`；
 * - 原生属性统一 `.element as HTMLButtonElement` / `wrapper.get<HTMLInputElement>(...)`；
 * - checkbox 用 `.setValue(true)`（它先改 `checked` 再派发 `change`）；
 * - `YfeButton` 把 `data-testid` 透传到内部原生 `<button>`，于是禁用断言就落在 `.disabled` 上。
 *
 * `createBackupStub()` 用可变字段模拟四个端口方法：`*Error` 一旦置上，对应方法就返回
 * `{ ok:false, code, message }` —— 这正是组件**必须**把 `message` 显示出来的那条路径。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import BackupManager from '../../src/renderer/features/backup-manager.vue'
import type {
  BackupCreateReport,
  BackupEntryView,
  BackupPort,
  BackupVerifyReport,
  FeatureResult,
} from '../../src/renderer/features/types.js'
import {
  DEFAULT_BACKUP_LABEL,
  EMPTY_TEXT,
  LOAD_FAILED_TEXT,
  NEEDS_MIGRATION_TEXT,
  READABLE_TEXT,
  RESTORE_CHECKBOX_LABEL,
  RESTORE_NOTICE,
  UNKNOWN_TIME_TEXT,
  UNREADABLE_REASON,
  UNREADABLE_TEXT,
} from '../../src/renderer/features/backup-manager-model.js'

// ==================== 夹具 ====================

/** 一份正常备份：有清单、有标签、1.0 MB。 */
const READABLE_ENTRY: BackupEntryView = Object.freeze({
  backupPath: 'C:\\data\\backups\\2026-06-01T00-00-00-000Z-手动备份.db',
  label: '手动备份',
  createdAt: '2026-06-01T00:00:00.000Z',
  byteSize: 1024 * 1024,
  readable: true,
})

/**
 * 迁移器留下的迁移前快照：合法 SQLite 库，但没有配套清单。
 *
 * `label` 故意留空、`createdAt` 故意为 null —— 它同时覆盖「标签回退文件名」与
 * 「时间未知」两条分支，也正是界面上**最不能隐藏**的那一项。
 */
const UNREADABLE_ENTRY: BackupEntryView = Object.freeze({
  backupPath: 'C:\\data\\backups\\migrated-before-migration.db',
  label: '',
  createdAt: null,
  byteSize: 2048,
  readable: false,
})

/** 端口失败结果（`FeatureResult` 的失败分支）。 */
interface Failure {
  readonly code: string
  readonly message: string
}

interface BackupStub {
  readonly port: BackupPort
  /** 调用记录：`create`/`verify`/`restore` 记入参，`list` 只记次数。 */
  readonly calls: { list: number; readonly create: string[]; readonly verify: string[]; readonly restore: string[] }
  /** 下一次 `list()` 返回的列表（可直接改，用于构造"备份完列表变长"的场景）。 */
  entries: readonly BackupEntryView[]
  listError: Failure | null
  createError: Failure | null
  verifyError: Failure | null
  restoreError: Failure | null
  /** `create` 返回的回执；默认值与 `READABLE_ENTRY` 对齐（1.0 MB / 42 毫秒）。 */
  readonly createReport: BackupCreateReport
  /** `verify` 返回的报告；默认 `needsMigration: true` 以便断言迁移提示。 */
  readonly verifyReport: BackupVerifyReport
}

function createBackupStub(entries: readonly BackupEntryView[] = []): BackupStub {
  const calls: BackupStub['calls'] = { list: 0, create: [], verify: [], restore: [] }
  const createReport: BackupCreateReport = Object.freeze({
    backupPath: 'C:\\data\\backups\\new.db',
    byteSize: 1024 * 1024,
    createdAt: '2026-06-02T00:00:00.000Z',
    durationMs: 42,
  })
  const verifyReport: BackupVerifyReport = Object.freeze({
    backupPath: READABLE_ENTRY.backupPath,
    integrity: 'ok',
    databaseSchemaVersion: 7,
    needsMigration: true,
    byteSize: 1024 * 1024,
    createdAt: '2026-06-01T00:00:00.000Z',
  })

  const stub: BackupStub = {
    calls,
    entries,
    listError: null,
    createError: null,
    verifyError: null,
    restoreError: null,
    createReport,
    verifyReport,
    port: {
      async list(): Promise<FeatureResult<readonly BackupEntryView[]>> {
        calls.list += 1
        if (stub.listError !== null) {
          return { ok: false, code: stub.listError.code, message: stub.listError.message }
        }
        return { ok: true, value: stub.entries }
      },
      async create(label?: string): Promise<FeatureResult<BackupCreateReport>> {
        calls.create.push(label ?? '')
        if (stub.createError !== null) {
          return { ok: false, code: stub.createError.code, message: stub.createError.message }
        }
        return { ok: true, value: createReport }
      },
      async verify(backupPath: string): Promise<FeatureResult<BackupVerifyReport>> {
        calls.verify.push(backupPath)
        if (stub.verifyError !== null) {
          return { ok: false, code: stub.verifyError.code, message: stub.verifyError.message }
        }
        return { ok: true, value: { ...verifyReport, backupPath } }
      },
      async restore(
        backupPath: string,
      ): Promise<FeatureResult<{ readonly targetPath: string; readonly byteSize: number }>> {
        calls.restore.push(backupPath)
        if (stub.restoreError !== null) {
          return { ok: false, code: stub.restoreError.code, message: stub.restoreError.message }
        }
        return {
          ok: true,
          value: { targetPath: 'C:\\data\\restore-preview\\restored.db', byteSize: 1024 * 1024 },
        }
      },
    },
  }
  return stub
}

/** 挂载并等 `onMounted` 里的首次 `list()` 结算完（否则断言到的是「加载中…」）。 */
async function mountPanel(stub: BackupStub) {
  const wrapper = mount(BackupManager, { props: { backup: stub.port } })
  await settle()
  return wrapper
}

/** 等微任务链 + Vue 的重渲染都落地。 */
async function settle(): Promise<void> {
  await flushPromises()
  await nextTick()
}

/** 挂载结果（`mountPanel` 是 async，这里把 Promise 拆掉，省得每处写 Awaited）。 */
type Panel = Awaited<ReturnType<typeof mountPanel>>

/**
 * 取某一项里的文本节点。
 *
 * 一律**先定位到那一项**再取字段：`backup-field-*` 这类 testid 在每一项里都有，
 * 跨项直接 `wrapper.get(...)` 只会命中第一项，第二项的真实文本就永远断言不到了。
 * 列表项容器用独立命名空间 `backup-entry-N`（前缀与字段不重叠），
 * 这样 `[data-testid^="backup-entry-"]` 才是干净的「有几项」计数。
 */
function itemText(wrapper: Panel, index: number, field: string): string {
  return wrapper.get(`[data-testid="backup-entry-${index}"]`).get(`[data-testid="backup-field-${field}"]`).text()
}

/** 某一项内部某个字段是否渲染出来（VTU 2.5.1 的 `get` 没有 `.exists()`，用 `find`）。 */
function itemHas(wrapper: Panel, index: number, field: string): boolean {
  return wrapper.find(`[data-testid="backup-entry-${index}"]`).find(`[data-testid="backup-field-${field}"]`).exists()
}

/** 列表项数量。 */
function itemCount(wrapper: Panel): number {
  return wrapper.findAll('[data-testid^="backup-entry-"]').length
}

/** 取原生 `<button>`（`YfeButton` 把 `data-testid` 透传到了它上面，禁用态就落在它身上）。 */
function button(wrapper: Panel, testid: string): HTMLButtonElement {
  return wrapper.get(`[data-testid="${testid}"]`).element as HTMLButtonElement
}

// ==================== 渲染 ====================

describe('备份与恢复：渲染', () => {
  it('列表为空时显示空态文案，并给出创建入口', async () => {
    const wrapper = await mountPanel(createBackupStub([]))
    expect(wrapper.get('[data-testid="backup-empty"]').text()).toBe(EMPTY_TEXT)
    expect(itemCount(wrapper)).toBe(0)
    // 空态下「立即备份」必须还在（文案里正是让用户点它）
    expect(wrapper.get('[data-testid="backup-create"]').text()).toBe('立即备份')
    expect(wrapper.find('[data-testid="backup-loading"]').exists()).toBe(false)
  })

  it('渲染出每项的标签、创建时间与人类可读体积（新的在前）', async () => {
    const wrapper = await mountPanel(createBackupStub([UNREADABLE_ENTRY, READABLE_ENTRY]))
    expect(itemCount(wrapper)).toBe(2)
    // 倒序：有创建时间的在前，null 的排末尾
    expect(itemText(wrapper, 0, 'label')).toBe('手动备份')
    expect(itemText(wrapper, 0, 'size')).toBe('1.0 MB')
    expect(itemText(wrapper, 0, 'status')).toBe(READABLE_TEXT)
    // label 为空 → 回退文件名；createdAt:null → 「时间未知」
    expect(itemText(wrapper, 1, 'label')).toBe('migrated-before-migration.db')
    expect(itemText(wrapper, 1, 'created')).toBe(UNKNOWN_TIME_TEXT)
    expect(itemText(wrapper, 1, 'size')).toBe('2.0 KB')
  })

  it('readable:false 的项仍然列出，显示「不可恢复（缺清单）」并禁用校验/恢复', async () => {
    const wrapper = await mountPanel(createBackupStub([READABLE_ENTRY, UNREADABLE_ENTRY]))
    // 🔴 不许隐藏：它是磁盘上真实存在的文件，用户有权知道
    expect(wrapper.find('[data-testid="backup-entry-1"]').exists()).toBe(true)
    expect(itemText(wrapper, 1, 'status')).toBe(UNREADABLE_TEXT)
    // 灰按钮旁边必须有「为什么」，否则用户只会反复点
    expect(itemText(wrapper, 1, 'reason')).toBe(UNREADABLE_REASON)
    expect(button(wrapper, 'backup-verify-1').disabled).toBe(true)
    expect(button(wrapper, 'backup-restore-1').disabled).toBe(true)
    // 可恢复的那一项不受影响
    expect(button(wrapper, 'backup-verify-0').disabled).toBe(false)
    expect(button(wrapper, 'backup-restore-0').disabled).toBe(false)
    expect(itemHas(wrapper, 0, 'reason')).toBe(false)
  })

  it('列表读取失败时显示失败原因与重试按钮，而不是假装空目录', async () => {
    const stub = createBackupStub([])
    stub.listError = { code: 'DB_BUSY', message: '数据库忙，请稍后重试。' }
    const wrapper = await mountPanel(stub)

    expect(wrapper.get('[data-testid="backup-error"]').text()).toBe('数据库忙，请稍后重试。')
    expect(wrapper.get('[data-testid="backup-load-failed"]').text()).toContain(LOAD_FAILED_TEXT)
    expect(wrapper.find('[data-testid="backup-empty"]').exists()).toBe(false)

    stub.listError = null
    stub.entries = [READABLE_ENTRY]
    await wrapper.get('[data-testid="backup-retry"]').trigger('click')
    await settle()
    expect(stub.calls.list).toBe(2)
    expect(itemText(wrapper, 0, 'label')).toBe('手动备份')
  })
})

// ==================== 立即备份 ====================

describe('备份与恢复：立即备份', () => {
  it('点「立即备份」调 backup.create，显示路径 / 体积 / 耗时并刷新列表', async () => {
    const stub = createBackupStub([])
    const wrapper = await mountPanel(stub)
    expect(stub.calls.list).toBe(1)

    stub.entries = [READABLE_ENTRY]
    await wrapper.get('[data-testid="backup-create"]').trigger('click')
    await settle()

    // 标签留空 → 用默认标签「手动备份」
    expect(stub.calls.create).toEqual([DEFAULT_BACKUP_LABEL])
    const notice = wrapper.get('[data-testid="backup-create-result"]').text()
    expect(notice).toContain('C:\\data\\backups\\new.db')
    expect(notice).toContain('1.0 MB')
    expect(notice).toContain('42 毫秒')
    // 建完必须重新拉列表，否则用户以为没建成
    expect(stub.calls.list).toBe(2)
    expect(itemText(wrapper, 0, 'label')).toBe('手动备份')
  })

  it('填了标签就提交标签本身（不去用默认值）', async () => {
    const stub = createBackupStub([])
    const wrapper = await mountPanel(stub)

    await wrapper.get<HTMLInputElement>('[data-testid="backup-label"]').setValue('  验收前  ')
    await wrapper.get('[data-testid="backup-create"]').trigger('click')
    await settle()

    expect(stub.calls.create).toEqual(['验收前'])
  })

  it('创建失败时把 message 显示出来，不吞掉', async () => {
    const stub = createBackupStub([])
    stub.createError = { code: 'ENOSPC', message: '磁盘空间不足，备份未写出。' }
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-create"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="backup-error"]').text()).toBe('磁盘空间不足，备份未写出。')
    expect(wrapper.find('[data-testid="backup-create-result"]').exists()).toBe(false)
  })
})

// ==================== 校验 ====================

describe('备份与恢复：校验', () => {
  it('点「校验」调 backup.verify 并显示完整性 / 结构版本 / 迁移提示', async () => {
    const wrapper = await mountPanel(createBackupStub([READABLE_ENTRY]))

    await wrapper.get('[data-testid="backup-verify-0"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="backup-verify-schema"]').text()).toContain('7')
    expect(wrapper.get('[data-testid="backup-verify-integrity"]').text()).toContain('ok')
    expect(wrapper.get('[data-testid="backup-verify-migration"]').text()).toBe(NEEDS_MIGRATION_TEXT)
  })

  it('校验失败时显示 message，且不伪造校验结果', async () => {
    const stub = createBackupStub([READABLE_ENTRY])
    stub.verifyError = { code: 'CHECKSUM_MISMATCH', message: '校验失败：文件校验和不匹配。' }
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-verify-0"]').trigger('click')
    await settle()

    expect(stub.calls.verify).toEqual([READABLE_ENTRY.backupPath])
    expect(wrapper.get('[data-testid="backup-error"]').text()).toBe('校验失败：文件校验和不匹配。')
    expect(wrapper.find('[data-testid="backup-verify-result"]').exists()).toBe(false)
  })
})

// ==================== 恢复 ====================

describe('备份与恢复：恢复闸门', () => {
  it('点「恢复」先展开内联确认区，写明"只写预览目录"且未勾选时点不动', async () => {
    const stub = createBackupStub([READABLE_ENTRY])
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-restore-0"]').trigger('click')
    await settle()

    // 展开确认区本身**不**调端口 —— 防误触的第一道闸门
    expect(stub.calls.restore).toEqual([])
    expect(wrapper.get('[data-testid="backup-confirm-text"]').text()).toBe(RESTORE_NOTICE)
    expect(wrapper.get('[data-testid="backup-confirm"]').text()).toContain(RESTORE_CHECKBOX_LABEL)
    expect(button(wrapper, 'backup-confirm-ok-0').disabled).toBe(true)

    // 未勾选 → 按钮禁用，即使被点到也不许调 restore
    await wrapper.get('[data-testid="backup-confirm-ok-0"]').trigger('click')
    await settle()
    expect(stub.calls.restore).toEqual([])
  })

  it('勾选复选框后按钮可用，点「确认恢复」调 restore 并显示预览目标路径', async () => {
    const stub = createBackupStub([READABLE_ENTRY])
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-restore-0"]').trigger('click')
    await settle()
    await wrapper.get<HTMLInputElement>('[data-testid="backup-confirm-check-0"]').setValue(true)
    await nextTick()

    expect(button(wrapper, 'backup-confirm-ok-0').disabled).toBe(false)
    await wrapper.get('[data-testid="backup-confirm-ok-0"]').trigger('click')
    await settle()

    expect(stub.calls.restore).toEqual([READABLE_ENTRY.backupPath])
    const result = wrapper.get('[data-testid="backup-restore-result"]').text()
    expect(result).toContain('C:\\data\\restore-preview\\restored.db')
    expect(result).toContain('1.0 MB')
    // 成功后确认区收起，避免误再点一次
    expect(wrapper.find('[data-testid="backup-confirm"]').exists()).toBe(false)
  })

  it('「取消」收起确认区且不调端口', async () => {
    const stub = createBackupStub([READABLE_ENTRY])
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-restore-0"]').trigger('click')
    await settle()
    await wrapper.get('[data-testid="backup-confirm-cancel-0"]').trigger('click')
    await settle()

    expect(stub.calls.restore).toEqual([])
    expect(wrapper.find('[data-testid="backup-confirm"]').exists()).toBe(false)
  })

  it('恢复失败时显示 message，且确认区保留让用户能重试', async () => {
    const stub = createBackupStub([READABLE_ENTRY])
    stub.restoreError = { code: 'DISK_FULL', message: '恢复失败：预览目录写入失败。' }
    const wrapper = await mountPanel(stub)

    await wrapper.get('[data-testid="backup-restore-0"]').trigger('click')
    await settle()
    await wrapper.get<HTMLInputElement>('[data-testid="backup-confirm-check-0"]').setValue(true)
    await nextTick()
    await wrapper.get('[data-testid="backup-confirm-ok-0"]').trigger('click')
    await settle()

    expect(wrapper.get('[data-testid="backup-error"]').text()).toBe('恢复失败：预览目录写入失败。')
    expect(wrapper.find('[data-testid="backup-restore-result"]').exists()).toBe(false)
  })
})

// ==================== 关闭 ====================

describe('备份与恢复：关闭', () => {
  it('点「关闭」emit close', async () => {
    const wrapper = await mountPanel(createBackupStub([]))

    await wrapper.get('[data-testid="backup-close"]').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
