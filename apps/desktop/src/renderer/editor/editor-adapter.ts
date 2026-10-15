/**
 * 编辑器适配层（ADR 0006 / D4）。
 *
 * 为什么要有这一层：正文编辑器将来一定会换（性能、移动端、插件需求），
 * 但**保存语义与版本语义绝不能跟着换**。渲染层只认这个接口，
 * 不认 CodeMirror、不认任何具体编辑器的 API。
 *
 * 三条不变量（评审必查）：
 * 1. `onChange` **每次键入只产生一个完整字符串**，不做大字符串双向绑定、
 *    不整段重建编辑器（全量重建会吃掉输入法组合态）。
 * 2. 编辑器**自己不保存**：`flush()` 只把待派发的变更交给上层，保存由
 *    `DraftSession` 负责（防抖 800ms / 最长 5s / 迟到结果丢弃）。
 * 3. `open()` 换文档时必须重置 undo 历史，否则跨文档撤销会把甲章正文插进乙章；
 *    但**输入法组合期间**不得被 `open()` 重置（见 `pendingOpen` 语义）。
 */

/** 单条文本变更（与 CodeMirror 的 change 形状一致，但不暴露 CodeMirror 类型）。 */
export interface EditorChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/** 装饰区间（用于冲突高亮、检索命中标记等；不改变正文）。 */
export interface EditorDecoration {
  readonly from: number
  readonly to: number
  readonly class?: string
}

export interface EditorSelection {
  readonly from: number
  readonly to: number
  readonly text: string
}

export interface EditorOpenOptions {
  readonly documentId: string
  readonly body: string
  readonly readOnly?: boolean
  /**
   * 打开后把光标/选区放到哪里（省略则落在文首）。
   *
   * 重开文档要能恢复上次的写作位置；冲突裁决也要能直接选中争议区间。
   * 越界或非有限的 from/to 会被夹进文档范围而不是抛错——"恢复位置"这类输入
   * 不该让编辑器崩，也不该把渲染层带进异常路径。
   */
  readonly selection?: { readonly from: number; readonly to?: number }
}

export interface EditorAdapter {
  /** 打开/切换文档。组合态期间会被延后到组合结束（见文件头第 3 条）。 */
  open(options: EditorOpenOptions): void
  /** 当前正文（唯一真相源是编辑器自身的 state，不是调用方缓存的字符串）。 */
  getBody(): string
  getSelection(): EditorSelection
  /** 应用一组变更（用于插件命令、建议稿替换）。 */
  applyTransaction(changes: readonly EditorChange[]): void
  undo(): boolean
  redo(): boolean
  /** 把待派发的变更交给上层（保存前调用）。编辑器内部不做防抖。 */
  flush(): Promise<void>
  decorate(ranges: readonly EditorDecoration[]): void
  /** 注册具名命令（插件命令走命令面板，不自动加常驻按钮）。返回取消注册函数。 */
  registerCommand(name: string, run: () => boolean): () => void
  focus(): void
  /** 订阅正文变化，返回取消订阅函数。 */
  onChange(handler: (body: string) => void): () => void
  dispose(): void
}

/** 命令名允许的字符集：`域.动作`，例如 `yfe.draft.flush`。 */
export const EDITOR_COMMAND_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/

export function isEditorCommandName(value: string): boolean {
  return EDITOR_COMMAND_PATTERN.test(value)
}
