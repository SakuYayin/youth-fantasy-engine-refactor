/**
 * 启动失败兜底页的纯逻辑层（A-04 · 还原旧版 `src/App.tsx` 的 `bootError` 分支）。
 *
 * 上游真源（`_upstream_tmp/youth-fantasy-engine-main/src/App.tsx`）：
 * - `:84`  `const [bootError, setBootError] = useState('')`
 * - `:281` `setBootError(e instanceof Error ? e.message : String(e))` —— 上游**只**存 message 字符串，
 *   连 `name` 都不带；这里把 `name` / `message` / `stack` 三分开取，是为了界面上能显示
 *   「TypeError：xxx」这种一眼能定位的标题，同时保留上游「有 message 就显示 message」的语义。
 * - `:461-476` 整屏兜底：`启动失败` / `bootError` / `重新加载`（`location.reload()`）/
 *   `若反复失败，请先备份数据文件（左下角「数据坞」），再重新加载。`
 *
 * 为什么把「未知异常 → 视图模型」抽成纯函数而不是写进组件（和 `welcome-wizard-model.ts`
 * 同一条理由）：输入的形态有 Error / 字符串 / `null` / 任意对象六种，规则留在组件里就只能靠
 * 挂载整棵树来验证，六种输入要六个挂载用例；写成纯函数后一条 `expect` 一行，而且以后外壳
 * 换渲染方式（整屏 → 弹窗）时规则不会跟着漂。
 *
 * 🔴 本文件不 import 任何 Vue / DOM / `node:` / `@yfe/contracts` 模块：
 *    纯函数才能在 node 环境的 `boot-error.test.ts` 里直接吃下，也才能独立回归。
 * 🔴 本文件**不写日志**：上游在 `catch` 里 `console.error`（`:280`），那是启动流程的职责；
 *    兜底页只负责「显示」，把 stack 摊在 `<details>` 里就是给用户的日志。
 */

// ============================================================================
// 文案常量（组件只负责摆位置，一个字都不自己写）
// ============================================================================

/** 主标题。**逐字**来自上游 `App.tsx:467`。 */
export const BOOT_ERROR_TITLE = '启动失败'

/** 「重新加载」按钮文案。**逐字**来自上游 `App.tsx:469`。 */
export const BOOT_RELOAD_LABEL = '重新加载'

/**
 * 备份提醒。**逐字**来自上游 `App.tsx:471`，一个标点都不许改：
 * 「数据坞」是外壳左下角那个入口的名字，改字会让提示指向不存在的东西。
 */
export const BOOT_BACKUP_HINT = '若反复失败，请先备份数据文件（左下角「数据坞」），再重新加载。'

/**
 * 技术详情折叠块的小标题。
 *
 * ⚠️ 这不是上游文案（上游只显示一行 message，没有 `<details>`）；验收要求
 * 「有 stack 时折叠显示」，所以这一句是本项目新写的界面文案。
 */
export const BOOT_TECHNICAL_SUMMARY = '错误详情（技术信息）'

/**
 * 拿不到任何错误信息时的兜底正文。
 *
 * 上游 `bootError` 为空串时**根本不会**进兜底分支（`:461` 是 `if (bootError)`），
 * 所以这句没有可逐字还原的原文；但它必须存在 —— 验收要求「`error === null` 时给可读的
 * 兜底文案，不显示空白页」。措辞刻意对齐上游那条备份提示的句式。
 */
export const BOOT_UNKNOWN_DETAIL =
  '启动过程中发生了未知错误，没有拿到可读的错误信息。请点击「重新加载」重试；若反复失败，请先备份数据文件。'

/** 只有 name 没有 message 时，单独显示 name 就够了，不加空的「：」。 */
export const BOOT_DETAIL_SEPARATOR = '：'

// ============================================================================
// 截断上限
// ============================================================================

/** message 的显示上限（字符数）。超过就截断 —— 异常消息可能是一整页 SQL/HTML。 */
export const MAX_MESSAGE_LENGTH = 600

/** message 截断后追加的说明。截断必须**说出来**，静默砍掉会让用户以为错误就长这样。 */
export const MESSAGE_TRUNCATED_SUFFIX = '……（错误信息过长，已截断）'

/** name 的显示上限。正常错误名只有十几个字符，这里是防御性上限。 */
export const MAX_NAME_LENGTH = 120

/** name 截断后追加的省略号。 */
export const NAME_TRUNCATED_SUFFIX = '…'

/** stack 的显示上限。折叠块里放几千行堆栈会把页面撑成滚动地狱。 */
export const MAX_STACK_LENGTH = 4000

/** stack 截断后追加的说明。 */
export const STACK_TRUNCATED_SUFFIX = '……（堆栈过长，已截断）'

// ============================================================================
// 恢复步骤（新增，不是上游原文）
// ============================================================================

/**
 * 给用户的可操作步骤，顺序即「先做哪一步」。
 *
 * ⚠️ 上游那四行里只有「重新加载」一个动作 + 一句备份提醒，没有分步指引；这一组是本项目
 * 新增的（清单 A-04 的缺口描述只点名文案与按钮，而「步骤数组非空且每条非空」是本次验收
 * 要求）。三条都必须是**用户能做的事**，不许写日志路径这类只有开发者看得懂的东西。
 */
export const BOOT_RECOVERY_STEPS: readonly string[] = [
  '先确认数据目录可写：磁盘还有剩余空间，且没有被其他程序占用。',
  '从左下角「数据坞」导出一份数据备份，再继续下一步。',
  '点击「重新加载」重试；若仍然失败，请把下面的错误详情一并反馈。',
]

// ============================================================================
// 视图模型
// ============================================================================

/** 兜底页要显示的全部内容。组件只渲染它，不做任何判断。 */
export interface BootErrorView {
  /** 主标题（= `BOOT_ERROR_TITLE`）。 */
  readonly title: string
  /** 备份提醒（= `BOOT_BACKUP_HINT`）。`canOpenBackupDir` 为假时组件不显示它。 */
  readonly hint: string
  /** 主错误正文：`名称：消息`；两者都拿不到时是兜底文案。**永远不会是空串。** */
  readonly detail: string
  /** `error.name`；非 Error 输入（字符串 / 数字 / 无 name 的对象）为 `''`。 */
  readonly name: string
  /** `error.message`（已截断）；拿不到为 `''`。 */
  readonly message: string
  /** 原始堆栈（已截断）；缺失为 `''`。组件把它放进 `<details>`，**不写日志**。 */
  readonly stack: string
  /** 有没有拿到可读的错误信息（`name`/`message`/`stack` 任一非空）。 */
  readonly hasError: boolean
  /** 有没有可折叠的技术详情（= `stack !== ''`）。 */
  readonly hasStack: boolean
  /**
   * 本页是否允许「重新加载」。
   *
   * 模型只能说「这个动作可用」；**到底渲不渲染按钮**由组件把它与「回调有没有传进来」
   * 取与（验收要求：回调缺省时不渲染按钮 —— 组件直接调 `location.reload()` 是不可测的）。
   */
  readonly canReload: boolean
  /** 是否显示「先备份数据坞」提示（外壳没有备份入口时应关掉，免得提示指向不存在的按钮）。 */
  readonly canOpenBackupDir: boolean
  /** 可操作的恢复步骤，非空且每条非空。 */
  readonly steps: readonly string[]
}

/** `toBootErrorView` 的可选开关。缺省值即上游行为（两条都开）。 */
export interface BootErrorOptions {
  /** 外壳是否提供「数据坞」备份入口；默认 `true`。 */
  readonly backupEntryAvailable?: boolean
  /** 是否允许重新加载；默认 `true`（`location.reload()` 在任何情况下都能调）。 */
  readonly reloadAvailable?: boolean
}

// ============================================================================
// 提取：不可信输入 → 三个字符串
// ============================================================================

/** 只认字符串字段：`{ message: 123 }` 这种不可信输入不猜语义，宁可当空。 */
function pickString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `String(x)` 对 Symbol 会抛（模板字符串更会），外面包一层兜底。 */
function stringifySafely(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** `error.name`；非 Error 输入回落 `''`（不许编一个假名字）。 */
function extractName(thrown: unknown): string {
  if (thrown instanceof Error) return pickString(thrown.name)
  if (thrown === null || thrown === undefined) return ''
  if (typeof thrown === 'object') return pickString((thrown as { name?: unknown }).name)
  return ''
}

/**
 * `error.message`。
 *
 * 分支顺序即上游 `:281` 的语义（`e instanceof Error ? e.message : String(e)`）：
 * Error 取 `message`；其余非空非对象（字符串 / 数字 / 布尔 / bigint / symbol）整体
 * `String()`；普通对象只认自己的 `message` 字符串字段 —— `String({})` 会得到
 * `[object Object]`，那比空串更没用。
 */
function extractMessage(thrown: unknown): string {
  if (thrown instanceof Error) return pickString(thrown.message)
  if (thrown === null || thrown === undefined) return ''
  if (typeof thrown === 'object') return pickString((thrown as { message?: unknown }).message)
  return stringifySafely(thrown)
}

/** `error.stack`；缺失为 `''`（浏览器差异很大，不许自己拼）。 */
function extractStack(thrown: unknown): string {
  if (thrown instanceof Error) return pickString(thrown.stack)
  if (thrown === null || thrown === undefined) return ''
  if (typeof thrown === 'object') return pickString((thrown as { stack?: unknown }).stack)
  return ''
}

/**
 * 兜底读：字段可能是 getter（`Object.defineProperty` / Proxy），读一下就可能抛。
 * 兜底页自己抛异常 = 真的只剩黑屏，所以每一次字段读取都从这里过。
 */
function readSafely(read: () => string): string {
  try {
    return read()
  } catch {
    return ''
  }
}

/** 通用截断：超限才动刀，并在末尾**说明**被截断。 */
export function truncateText(text: string, limit: number, suffix: string): string {
  if (limit <= 0) return text === '' ? '' : suffix
  if (text.length <= limit) return text
  return text.slice(0, limit) + suffix
}

/** message 截断（上限 `MAX_MESSAGE_LENGTH`）。 */
export function truncateMessage(text: string): string {
  return truncateText(text, MAX_MESSAGE_LENGTH, MESSAGE_TRUNCATED_SUFFIX)
}

/**
 * 主错误正文。
 *
 * 三种可用素材的优先级：`名称：消息` → 只有名称 → 只有消息 → 兜底文案。
 * **永远不返回空串**（验收：不许空白提示）。
 */
export function bootErrorDetail(name: string, message: string): string {
  if (name !== '' && message !== '') return `${name}${BOOT_DETAIL_SEPARATOR}${message}`
  if (name !== '') return name
  if (message !== '') return message
  return BOOT_UNKNOWN_DETAIL
}

// ============================================================================
// 入口：任意抛错 → 视图模型
// ============================================================================

/**
 * 把「启动流程抛出来的任何东西」翻成兜底页的视图模型。
 *
 * 输入可能是：`Error` 实例（正常路径）、字符串（`throw 'boom'`）、`null`（外壳没拿到错误
 * 却要显示兜底页）、`{ message: 'x' }` 这种不可信对象（跨进程反序列化后 `instanceof Error`
 * 会失效，Electron 里很常见）、数字、Symbol。**任何输入都不许抛异常** —— 兜底页自己抛异常
 * 就真的只剩黑屏了，那正是这个页面要防的事。
 */
export function toBootErrorView(thrown: unknown, options: BootErrorOptions = {}): BootErrorView {
  const name = truncateText(
    readSafely(() => extractName(thrown)),
    MAX_NAME_LENGTH,
    NAME_TRUNCATED_SUFFIX,
  )
  const message = truncateMessage(readSafely(() => extractMessage(thrown)))
  const stack = truncateText(
    readSafely(() => extractStack(thrown)),
    MAX_STACK_LENGTH,
    STACK_TRUNCATED_SUFFIX,
  )

  return {
    title: BOOT_ERROR_TITLE,
    hint: BOOT_BACKUP_HINT,
    detail: bootErrorDetail(name, message),
    name,
    message,
    stack,
    hasError: name !== '' || message !== '' || stack !== '',
    hasStack: stack !== '',
    canReload: options.reloadAvailable !== false,
    canOpenBackupDir: options.backupEntryAvailable !== false,
    steps: BOOT_RECOVERY_STEPS,
  }
}