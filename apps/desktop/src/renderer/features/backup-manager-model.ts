/**
 * 「备份与恢复」（`features/backup-manager.vue`）的**纯逻辑层**。
 *
 * 为什么单独一层：体积/时间/可恢复性这些换算是最容易被界面代码顺手写错的地方
 * （上游 `BackupManager.tsx:286` 的 `sizeOf` 就把 0 字节显示成「0 KB」、
 * 把 `bytes` 缺失当成 0 静默吞掉）。它们没有一行需要 Vue，所以放在这里用普通
 * 单测钉死，而不是靠挂载测试顺带覆盖。
 *
 * 三条口径（都对应一处真实风险）：
 * 1. **`readable:false` 不是「隐藏项」**：迁移器留下的迁移前快照是合法 SQLite 库、
 *    只是没有配套清单。界面必须把它列出来并标成不可恢复 —— 用户有权知道磁盘上有什么。
 * 2. **`createdAt:null` 不是 0、不是空串**：显示「时间未知」，排序排末尾，
 *    绝不能拿 `new Date(null)` 显示成 1970 年（那是看起来像真的假数据）。
 * 3. **失败文案只认 `FeatureResult.message`**：端口已经脱敏过了，界面原样显示；
 *    `message` 为空时才退回 `code`，永不返回空串（空错误提示等于静默失败）。
 */
import type {
  BackupCreateReport,
  BackupEntryView,
  BackupVerifyReport,
} from './types.js'

// ============ 文案常量（唯一来源，界面只做插值） ============

export const PANEL_TITLE = '备份与恢复'
export const LIST_TITLE = '备份列表'
export const BUTTON_CLOSE = '关闭'
export const BUTTON_CREATE = '立即备份'
export const BUTTON_VERIFY = '校验'
export const BUTTON_RESTORE = '恢复'
export const BUTTON_CONFIRM_RESTORE = '确认恢复'
export const BUTTON_CANCEL = '取消'
export const BUTTON_RETRY = '重试'

export const LOADING_TEXT = '加载中…'
export const EMPTY_TEXT = '还没有备份，点击「立即备份」创建第一份'
export const LOAD_FAILED_TEXT = '备份列表读取失败'

export const UNKNOWN_TIME_TEXT = '时间未知'
export const UNNAMED_BACKUP_TEXT = '未命名备份'

/** 可恢复性状态文案（`readable:false` 的固定说法，测试与界面共用一份）。 */
export const READABLE_TEXT = '可恢复'
export const UNREADABLE_TEXT = '不可恢复（缺清单）'

/** 禁用理由：说明「为什么不能点」，而不只是把按钮变灰。 */
export const UNREADABLE_REASON =
  '这份备份没有配套清单（可能是迁移器留下的迁移前快照），无法校验、也无法恢复，只能保留在磁盘上。'

export const DEFAULT_BACKUP_LABEL = '手动备份'
export const LABEL_INPUT_PLACEHOLDER = '备份标签（留空则用「手动备份」）'

/**
 * 恢复确认文案 —— **逐字固定**（接口冻结 §1.2）。
 *
 * 上游是「覆盖式恢复」，这里改成写「恢复预览目录」，用户最容易误判的正是这一点，
 * 所以这句话必须写在复选框正上方，不能塞进 title / tooltip 里。
 */
export const RESTORE_NOTICE =
  '恢复不会覆盖当前正在使用的数据库，会写入恢复预览目录，之后由你决定是否替换。'
export const RESTORE_CHECKBOX_LABEL = '我已了解，恢复只生成预览'

export const NEEDS_MIGRATION_TEXT = '恢复后需要迁移'
export const NO_MIGRATION_TEXT = '无需迁移'
export const INTEGRITY_LABEL = '完整性'
export const SCHEMA_VERSION_LABEL = '数据库结构版本'

/** 端口违约（抛异常）或 message/code 双空时的兜底文案。 */
export const UNKNOWN_FAILURE_TEXT = '操作失败，请稍后重试'

// ============ 体积与时间 ============

const BYTE_STEP = 1024

/**
 * 人类可读体积。
 *
 * 0 与非法值都显示「0 B」而不是「0.0 MB」：体积读不出来的那份备份本来就不该
 * 假装有一个精确大小。负数（清单被改坏）同样按 0 处理。
 */
export function formatByteSize(byteSize: number): string {
  const bytes = Number.isFinite(byteSize) && byteSize > 0 ? Math.floor(byteSize) : 0
  if (bytes < BYTE_STEP) return `${bytes} B`
  const kb = bytes / BYTE_STEP
  if (kb < BYTE_STEP) return `${kb.toFixed(1)} KB`
  const mb = kb / BYTE_STEP
  if (mb < BYTE_STEP) return `${mb.toFixed(1)} MB`
  return `${(mb / BYTE_STEP).toFixed(1)} GB`
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 创建时间文案（本地时区 `YYYY-MM-DD HH:mm`）。
 *
 * 刻意不用 `toLocaleString()`：它的输出随 ICU / 语言环境变化，同一份备份在
 * 不同机器上会长得不一样；本函数只用 `Date` 的本地分量，跨平台稳定。
 * 解析不了的字符串**原样显示**——宁可给用户看原始时间戳，也不要「Invalid Date」。
 */
export function formatCreatedAt(createdAt: string | null): string {
  if (createdAt === null) return UNKNOWN_TIME_TEXT
  const raw = createdAt.trim()
  if (raw === '') return UNKNOWN_TIME_TEXT
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/** 排序用时间戳；`null` 与解析不了的串一律当「未知」，排在末尾。 */
function createdAtMillis(entry: BackupEntryView): number | null {
  if (entry.createdAt === null) return null
  const ms = Date.parse(entry.createdAt)
  return Number.isNaN(ms) ? null : ms
}

// ============ 标签与可恢复性 ============

/**
 * 从备份路径取文件名。
 *
 * 同时按 `/` 与 `\` 切：渲染层拿到的路径来自主进程（Windows 上是反斜杠），
 * 而单测 / POSIX 上是正斜杠，只认一种就会把整条路径当文件名显示出来。
 *
 * 末尾带分隔符的串（`C:\data\backups\`）指的是**目录**而不是某个文件：直接取末段
 * 会把目录名当成备份名显示出来 —— 于是用户看到一个叫「backups」的备份，
 * 而真正的文件名根本不存在。这种路径一律按「取不到文件名」处理。
 */
export function backupFileName(backupPath: string): string {
  const raw = backupPath.trim()
  if (raw === '' || /[\\/]$/.test(raw)) return UNNAMED_BACKUP_TEXT
  const parts = raw.split(/[\\/]+/)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? UNNAMED_BACKUP_TEXT : last
}

/** 列表里显示的标签：`label` 为空（含纯空白）时回退文件名。 */
export function backupDisplayLabel(entry: BackupEntryView): string {
  const label = entry.label.trim()
  return label === '' ? backupFileName(entry.backupPath) : label
}

/** 可恢复性状态文案。 */
export function backupStatusText(entry: BackupEntryView): string {
  return entry.readable ? READABLE_TEXT : UNREADABLE_TEXT
}

/**
 * 恢复/校验按钮的禁用理由；`null` = 可用。
 *
 * 返回文案而不是布尔，是为了让界面**必须**把理由渲染出来 —— 一个灰按钮配上
 * 一句解释，用户才知道该去看别的那份备份，而不是反复点。
 */
export function restoreDisabledReason(entry: BackupEntryView): string | null {
  return entry.readable ? null : UNREADABLE_REASON
}

/** 列表行视图：界面只做插值，不再二次换算。 */
export interface BackupRow {
  readonly backupPath: string
  readonly label: string
  readonly createdAtText: string
  readonly sizeText: string
  readonly restorable: boolean
  readonly statusText: string
  readonly disabledReason: string | null
}

export function toBackupRow(entry: BackupEntryView): BackupRow {
  return {
    backupPath: entry.backupPath,
    label: backupDisplayLabel(entry),
    createdAtText: formatCreatedAt(entry.createdAt),
    sizeText: formatByteSize(entry.byteSize),
    restorable: entry.readable,
    statusText: backupStatusText(entry),
    disabledReason: restoreDisabledReason(entry),
  }
}

/** 同刻并列时的稳定次序：先按标签、再按路径，保证同一份列表每次渲染顺序一致。 */
function compareTie(a: BackupEntryView, b: BackupEntryView): number {
  const labelA = backupDisplayLabel(a)
  const labelB = backupDisplayLabel(b)
  if (labelA !== labelB) return labelA < labelB ? -1 : 1
  if (a.backupPath === b.backupPath) return 0
  return a.backupPath < b.backupPath ? -1 : 1
}

/**
 * 按创建时间**倒序**（新的在最上面），`createdAt:null` 排末尾。
 *
 * 不原地排序：入参是端口返回的只读数组，改它等于改调用方的数据。
 */
export function sortBackups(entries: readonly BackupEntryView[]): readonly BackupEntryView[] {
  return [...entries].sort((a, b) => {
    const aMs = createdAtMillis(a)
    const bMs = createdAtMillis(b)
    if (aMs === null && bMs === null) return compareTie(a, b)
    if (aMs === null) return 1
    if (bMs === null) return -1
    if (aMs !== bMs) return bMs - aMs
    return compareTie(a, b)
  })
}

/** 端口列表 → 行视图（排序 + 全部文案换算），界面直接用。 */
export function buildBackupRows(entries: readonly BackupEntryView[]): readonly BackupRow[] {
  return sortBackups(entries).map((entry) => toBackupRow(entry))
}

// ============ 操作结果文案 ============

/** 耗时毫秒；负值 / NaN 都按 0 处理（时钟回拨不该显示「-3 毫秒」）。 */
function durationText(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0
}

/** 立即备份成功：路径 + 体积 + 耗时（接口冻结 §1.2 要求三项都可见）。 */
export function formatCreateResult(report: BackupCreateReport): string {
  return (
    `已创建备份：${report.backupPath}（${formatByteSize(report.byteSize)}，` +
    `耗时 ${durationText(report.durationMs)} 毫秒）`
  )
}

/** 校验结果视图：`integrity` / 结构版本 / 是否需要迁移 三项分开渲染。 */
export interface BackupVerifyView {
  readonly backupPath: string
  readonly integrityText: string
  readonly schemaVersionText: string
  readonly needsMigration: boolean
  readonly migrationText: string
  readonly sizeText: string
  readonly createdAtText: string
}

export function toBackupVerifyView(report: BackupVerifyReport): BackupVerifyView {
  return {
    backupPath: report.backupPath,
    integrityText: `${INTEGRITY_LABEL}：${report.integrity}`,
    schemaVersionText: `${SCHEMA_VERSION_LABEL}：${report.databaseSchemaVersion}`,
    needsMigration: report.needsMigration,
    migrationText: report.needsMigration ? NEEDS_MIGRATION_TEXT : NO_MIGRATION_TEXT,
    sizeText: formatByteSize(report.byteSize),
    createdAtText: formatCreatedAt(report.createdAt),
  }
}

/** 恢复成功：只显示**预览目标路径**（在用的库没被动过，这句话必须说清楚）。 */
export function formatRestoreResult(result: {
  readonly targetPath: string
  readonly byteSize: number
}): string {
  return `恢复预览已生成：${result.targetPath}（${formatByteSize(result.byteSize)}）`
}

/**
 * 失败结果的用户可见文案：优先 `message`（已脱敏的中文），空则退回 `code`。
 *
 * 读取失败时**绝不返回空串**：一个空的 `role="alert"` 就是静默失败，
 * 用户只会看到列表空了却不知道原因。
 */
export function failureText(result: { readonly code: string; readonly message: string }): string {
  const message = result.message.trim()
  if (message !== '') return message
  const code = result.code.trim()
  return code === '' ? UNKNOWN_FAILURE_TEXT : `操作失败（${code}）`
}

/**
 * 端口**违约**（抛异常）时的文案。
 *
 * 契约写明端口不抛异常，但真抛了的时候若不在组件边界兜住，界面会永远停在
 * 忙碌态且一句话都不说 —— 那是比报错更糟的失败方式。
 */
export function thrownMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return `操作失败：${error.message.trim()}`
  }
  const text = typeof error === 'string' ? error.trim() : ''
  return text === '' ? UNKNOWN_FAILURE_TEXT : `操作失败：${text}`
}
