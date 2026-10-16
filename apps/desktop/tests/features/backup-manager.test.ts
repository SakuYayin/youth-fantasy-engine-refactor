/**
 * 「备份与恢复」纯逻辑测试（`features/backup-manager-model.ts`）—— W8-B。
 *
 * 这一层不挂载 DOM，钉的是三类**最容易被顺手写错**的换算：
 * 体积（0 字节 / 不足 1KB / MB 级）、时间（`createdAt:null` 的「时间未知」分支）、
 * 以及 `readable:false` 的禁用理由与「不许隐藏该项」的排序口径。
 *
 * 为什么时间断言不写死本地时刻：`formatCreatedAt` 刻意用 `Date` 的本地分量拼字符串
 * （不用随 ICU 漂移的 `toLocaleString`），所以具体小时数取决于跑测试的时区。
 * 这里断言**形状**（`YYYY-MM-DD HH:mm`）与**分支**（null / 解析失败原样回显），
 * 那才是出 bug 的地方；写死 `2026-01-01 08:00` 只会让测试在 CI 换时区时假红。
 */
import { describe, expect, it } from 'vitest'

import type { BackupCreateReport, BackupEntryView, BackupVerifyReport } from '../../src/renderer/features/types.js'
import {
  INTEGRITY_LABEL,
  NEEDS_MIGRATION_TEXT,
  NO_MIGRATION_TEXT,
  READABLE_TEXT,
  SCHEMA_VERSION_LABEL,
  UNKNOWN_FAILURE_TEXT,
  UNKNOWN_TIME_TEXT,
  UNNAMED_BACKUP_TEXT,
  UNREADABLE_REASON,
  UNREADABLE_TEXT,
  backupDisplayLabel,
  backupFileName,
  backupStatusText,
  buildBackupRows,
  failureText,
  formatByteSize,
  formatCreateResult,
  formatCreatedAt,
  formatRestoreResult,
  restoreDisabledReason,
  sortBackups,
  thrownMessage,
  toBackupVerifyView,
} from '../../src/renderer/features/backup-manager-model.js'

// ==================== 夹具 ====================

/**
 * 一份备份条目。默认值取「最常见的那一份」：有清单、有标签、有创建时间。
 * 每个用例只覆盖它真正关心的那个字段，避免"测试里塞满了与断言无关的噪声"。
 */
function entry(overrides: Partial<BackupEntryView> = {}): BackupEntryView {
  return {
    backupPath: 'C:\\data\\backups\\2026-01-01T00-00-00-000Z-手动备份.db',
    label: '手动备份',
    createdAt: '2026-01-01T00:00:00.000Z',
    byteSize: 2048,
    readable: true,
    ...overrides,
  }
}

/** 排序后的路径序列（比对比整对象更好读，失败信息也更短）。 */
function pathsOf(entries: readonly BackupEntryView[]): string[] {
  return sortBackups(entries).map((item) => item.backupPath)
}

// ==================== 体积 ====================

describe('体积格式化', () => {
  it('0 字节显示「0 B」，不冒充「0 KB」', () => {
    // 上游 `sizeOf` 的 `kb.toFixed(0) + ' KB'` 会把空文件写成「0 KB」——
    // 那看起来像一个真实的小文件，而不是"读不出来"。
    expect(formatByteSize(0)).toBe('0 B')
  })

  it('不足 1KB 按字节显示（含边界 1023）', () => {
    expect(formatByteSize(1)).toBe('1 B')
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1023)).toBe('1023 B')
  })

  it('KB 段保留一位小数，1024 正好进 1.0 KB', () => {
    expect(formatByteSize(1024)).toBe('1.0 KB')
    expect(formatByteSize(1536)).toBe('1.5 KB')
    expect(formatByteSize(1024 * 1024 - 1)).toBe('1024.0 KB')
  })

  it('MB 级保留一位小数（契约示例 1.2 MB）', () => {
    expect(formatByteSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatByteSize(Math.round(1.2 * 1024 * 1024))).toBe('1.2 MB')
    expect(formatByteSize(20 * 1024 * 1024)).toBe('20.0 MB')
  })

  it('GB 级也要有单位，不能无限往 MB 上堆', () => {
    expect(formatByteSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('负数 / NaN / Infinity 一律退成「0 B」，不产出「NaN B」', () => {
    // 清单被改坏时 byteSize 可能是负的；直接插值会渲染出「-3 B」「NaN B」。
    expect(formatByteSize(-1)).toBe('0 B')
    expect(formatByteSize(Number.NaN)).toBe('0 B')
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

// ==================== 时间 ====================

describe('创建时间文案', () => {
  it('createdAt 为 null 显示「时间未知」（不显示 1970 年）', () => {
    // readable:false 的迁移前快照就是这一支：`new Date(null)` 会得到 1970-01-01，
    // 那是一个**看起来像真的**假数据，比「时间未知」危险得多。
    expect(formatCreatedAt(null)).toBe(UNKNOWN_TIME_TEXT)
  })

  it('空串同样算「时间未知」', () => {
    expect(formatCreatedAt('')).toBe(UNKNOWN_TIME_TEXT)
    expect(formatCreatedAt('   ')).toBe(UNKNOWN_TIME_TEXT)
  })

  it('合法 ISO 串输出稳定的 YYYY-MM-DD HH:mm 形状', () => {
    const text = formatCreatedAt('2026-03-05T14:07:00.000Z')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(text).not.toBe(UNKNOWN_TIME_TEXT)
  })

  it('解析不了的字符串原样回显，不显示 Invalid Date', () => {
    expect(formatCreatedAt('上次备份')).toBe('上次备份')
    expect(formatCreatedAt('not-a-date')).toBe('not-a-date')
  })
})

// ==================== 标签回退 ====================

describe('标签回退文件名', () => {
  it('label 为空（含纯空白）时用文件名', () => {
    expect(backupDisplayLabel(entry({ label: '', backupPath: '/data/backups/a.db' }))).toBe('a.db')
    expect(backupDisplayLabel(entry({ label: '   ', backupPath: '/data/backups/b.db' }))).toBe('b.db')
  })

  it('同时认 Windows 反斜杠与 POSIX 正斜杠', () => {
    // 渲染层拿到的是主进程给的 Windows 路径，单测里是 POSIX 路径；
    // 只认一种就会把整条路径当标签显示出来。
    expect(backupFileName('C:\\data\\backups\\x.db')).toBe('x.db')
    expect(backupFileName('/data/backups/y.db')).toBe('y.db')
    expect(backupFileName('z.db')).toBe('z.db')
  })

  it('路径为空时给「未命名备份」，不留空标签', () => {
    expect(backupFileName('')).toBe(UNNAMED_BACKUP_TEXT)
    expect(backupFileName('C:\\data\\backups\\')).toBe(UNNAMED_BACKUP_TEXT)
  })

  it('非空 label 原样保留（含前后空白裁剪）', () => {
    expect(backupDisplayLabel(entry({ label: '  验收前  ' }))).toBe('验收前')
  })
})

// ==================== 可恢复性 ====================

describe('可恢复性与禁用理由', () => {
  it('readable:true 时可恢复、无禁用理由', () => {
    const item = entry({ readable: true })
    expect(backupStatusText(item)).toBe(READABLE_TEXT)
    expect(restoreDisabledReason(item)).toBeNull()
  })

  it('readable:false 时状态文案是「不可恢复（缺清单）」并给出理由', () => {
    const item = entry({ readable: false })
    expect(backupStatusText(item)).toBe(UNREADABLE_TEXT)
    expect(restoreDisabledReason(item)).toBe(UNREADABLE_REASON)
    // 理由必须说明"为什么不能点"，否则灰按钮旁边什么都没有
    expect(UNREADABLE_REASON).toContain('清单')
  })

  it('readable:false 的项照常生成行视图（不许被过滤掉）', () => {
    const rows = buildBackupRows([
      entry({ backupPath: 'C:\\b\\migrated.db', label: '迁移前快照', readable: false, createdAt: null }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.restorable).toBe(false)
    expect(rows[0]?.label).toBe('迁移前快照')
    expect(rows[0]?.createdAtText).toBe(UNKNOWN_TIME_TEXT)
  })
})

// ==================== 排序 ====================

describe('列表排序', () => {
  it('按创建时间倒序：新的在最上面', () => {
    const older = entry({ backupPath: 'C:\\b\\old.db', createdAt: '2026-01-01T00:00:00.000Z' })
    const newer = entry({ backupPath: 'C:\\b\\new.db', createdAt: '2026-06-01T00:00:00.000Z' })
    const middle = entry({ backupPath: 'C:\\b\\mid.db', createdAt: '2026-03-01T00:00:00.000Z' })
    expect(pathsOf([older, newer, middle])).toEqual(['C:\\b\\new.db', 'C:\\b\\mid.db', 'C:\\b\\old.db'])
  })

  it('createdAt 为 null 的排在末尾（不是开头、也不是按 0 当 1970）', () => {
    const known = entry({ backupPath: 'C:\\b\\known.db', createdAt: '2026-01-01T00:00:00.000Z' })
    const unknown = entry({ backupPath: 'C:\\b\\unknown.db', createdAt: null })
    expect(pathsOf([unknown, known])).toEqual(['C:\\b\\known.db', 'C:\\b\\unknown.db'])
  })

  it('解析失败的 createdAt 也当「未知」处理，排末尾', () => {
    const known = entry({ backupPath: 'C:\\b\\known.db', createdAt: '2026-01-01T00:00:00.000Z' })
    const broken = entry({ backupPath: 'C:\\b\\broken.db', createdAt: '???' })
    expect(pathsOf([broken, known])).toEqual(['C:\\b\\known.db', 'C:\\b\\broken.db'])
  })

  it('不原地改入参数组（端口返回的是只读列表）', () => {
    const input: readonly BackupEntryView[] = [
      entry({ backupPath: 'C:\\b\\old.db', createdAt: '2026-01-01T00:00:00.000Z' }),
      entry({ backupPath: 'C:\\b\\new.db', createdAt: '2026-06-01T00:00:00.000Z' }),
    ]
    sortBackups(input)
    expect(input.map((item) => item.backupPath)).toEqual(['C:\\b\\old.db', 'C:\\b\\new.db'])
  })

  it('同刻并列时按标签稳定排序，保证每次渲染顺序一致', () => {
    // 同一秒内连按两次「立即备份」就会撞上这一刻：顺序必须确定，
    // 否则列表每次重渲染都可能换个样子（用户会以为备份丢了）。
    const same = '2026-01-01T00:00:00.000Z'
    const beta = entry({ backupPath: 'C:\\b\\1.db', label: 'beta', createdAt: same })
    const alpha = entry({ backupPath: 'C:\\b\\2.db', label: 'alpha', createdAt: same })
    expect(pathsOf([beta, alpha])).toEqual(['C:\\b\\2.db', 'C:\\b\\1.db'])
  })

  it('buildBackupRows 同时完成排序与文案换算', () => {
    const rows = buildBackupRows([
      entry({ backupPath: 'C:\\b\\old.db', createdAt: '2026-01-01T00:00:00.000Z', byteSize: 0 }),
      entry({ backupPath: 'C:\\b\\new.db', createdAt: '2026-06-01T00:00:00.000Z', byteSize: 1024 }),
    ])
    expect(rows[0]?.backupPath).toBe('C:\\b\\new.db')
    expect(rows[0]?.sizeText).toBe('1.0 KB')
    expect(rows[1]?.sizeText).toBe('0 B')
  })
})

// ==================== 操作结果文案 ====================

describe('操作结果与失败文案', () => {
  it('备份成功文案包含路径、体积与耗时三项', () => {
    const report: BackupCreateReport = {
      backupPath: 'C:\\data\\backups\\x.db',
      byteSize: 1024 * 1024,
      createdAt: '2026-01-01T00:00:00.000Z',
      durationMs: 42,
    }
    const text = formatCreateResult(report)
    expect(text).toContain('C:\\data\\backups\\x.db')
    expect(text).toContain('1.0 MB')
    expect(text).toContain('42 毫秒')
  })

  it('校验结果含完整性 / 结构版本 / 迁移提示三项', () => {
    const report: BackupVerifyReport = {
      backupPath: 'C:\\data\\backups\\x.db',
      integrity: 'ok',
      databaseSchemaVersion: 7,
      needsMigration: true,
      byteSize: 2048,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const view = toBackupVerifyView(report)
    expect(view.integrityText).toBe(`${INTEGRITY_LABEL}：ok`)
    expect(view.schemaVersionText).toBe(`${SCHEMA_VERSION_LABEL}：7`)
    expect(view.needsMigration).toBe(true)
    expect(view.migrationText).toBe(NEEDS_MIGRATION_TEXT)
    expect(view.sizeText).toBe('2.0 KB')
  })

  it('不需要迁移时给出明确的否定文案，而不是留空', () => {
    const view = toBackupVerifyView({
      backupPath: 'C:\\data\\backups\\x.db',
      integrity: 'ok',
      databaseSchemaVersion: 7,
      needsMigration: false,
      byteSize: 2048,
      createdAt: null,
    })
    expect(view.migrationText).toBe(NO_MIGRATION_TEXT)
    expect(view.createdAtText).toBe(UNKNOWN_TIME_TEXT)
  })

  it('恢复成功文案指向预览目录并带体积', () => {
    const text = formatRestoreResult({ targetPath: 'C:\\data\\restore-preview\\x-restored.db', byteSize: 2048 })
    expect(text).toContain('C:\\data\\restore-preview\\x-restored.db')
    expect(text).toContain('2.0 KB')
  })

  it('失败文案优先用 message，绝不返回空串', () => {
    expect(failureText({ code: 'DB_BUSY', message: '数据库忙，请稍后重试。' })).toBe('数据库忙，请稍后重试。')
  })

  it('message 为空时退回 code；两者都空才用兜底文案', () => {
    expect(failureText({ code: 'PERMISSION_DENIED', message: '' })).toContain('PERMISSION_DENIED')
    expect(failureText({ code: '', message: '  ' })).toBe(UNKNOWN_FAILURE_TEXT)
  })

  it('端口违约抛异常时也要产出非空文案', () => {
    expect(thrownMessage(new Error('桥断了'))).toContain('桥断了')
    expect(thrownMessage('炸了')).toContain('炸了')
    expect(thrownMessage(undefined)).toBe(UNKNOWN_FAILURE_TEXT)
  })
})
