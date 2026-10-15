/**
 * CodeMirror 6 实现的编辑器适配层。
 *
 * 只依赖 `@codemirror/state` / `@codemirror/view` / `@codemirror/commands`，
 * 不引入 `codemirror` 元包（它会带进搜索/补全/ lint，首版用不上，白名单打包时是纯负担）。
 *
 * 实现要点（对应 ADR 0006 / D4）：
 * - `docChanged` → `onChange(body)`：每次键入只产出一个字符串，不做双向绑定。
 * - `open()` 用 `view.setState(...)` 重建 state ⇒ **undo 历史随之重置**，不会跨文档撤销。
 * - 输入法组合期间（`compositionstart`…`compositionend`）收到的 `open()` 会被
 *   挂起（`pendingOpen`），组合结束后才应用——否则会把正在组合的字符吃掉。
 * - 编辑器不做防抖、不做保存；`flush()` 是给上层保存前调用的空操作（语义占位）。
 */

import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import {
  EditorSelection as CmSelection,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view'

import {
  isEditorCommandName,
  type EditorAdapter,
  type EditorChange,
  type EditorDecoration,
  type EditorOpenOptions,
  type EditorSelection,
} from './editor-adapter.js'

export interface CreateCodeMirrorAdapterOptions {
  readonly documentId?: string
  readonly body?: string
  readonly readOnly?: boolean
  /** 是否显示行号（首版默认显示；写作页可关）。 */
  readonly lineNumbers?: boolean
  /**
   * 命令名 → 快捷键（例如 `{ 'yfe.draft.flush': 'Mod-s' }`）。
   * 没配快捷键的命令仍会注册，可由命令面板通过 `runCommand()` 调用。
   */
  readonly commandKeys?: Readonly<Record<string, string>>
  /** 追加扩展（主题、语言等由调用方决定）。 */
  readonly extensions?: readonly Extension[]
}

/** 扩展接口：适配层内部命令面板需要的两个查询方法。 */
export interface CodeMirrorAdapter extends EditorAdapter {
  readonly documentId: string | null
  readonly isComposing: boolean
  setReadOnly(value: boolean): void
  commandNames(): readonly string[]
  runCommand(name: string): boolean
}

const setDecorations = StateEffect.define<readonly EditorDecoration[]>()

/** 把外部给的光标位置夹进 `[0, length]`（NaN / 小数 / 越界一律收敛，不抛错）。 */
function clampPosition(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), length)
}

const decorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setDecorations)) continue
      const marks = effect.value
        .filter((range) => range.to > range.from && range.from >= 0)
        .map((range) =>
          Decoration.mark(range.class === undefined ? {} : { class: range.class }).range(
            range.from,
            range.to,
          ),
        )
      next = Decoration.set(marks, true)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

export function createCodeMirrorAdapter(
  host: HTMLElement,
  options: CreateCodeMirrorAdapterOptions = {},
): CodeMirrorAdapter {
  let changeHandler: ((body: string) => void) | null = null
  let composing = false
  let pendingOpen: EditorOpenOptions | null = null
  let currentDocumentId: string | null = options.documentId ?? null
  const commands = new Map<string, () => boolean>()
  const editable = new Compartment()

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    // 组合态期间也要上报（否则丢字），受保护的只是"外部重置编辑器"。
    changeHandler?.(update.state.doc.toString())
  })

  const baseExtensions: Extension[] = [
    history(),
    drawSelection(),
    decorationField,
    updateListener,
    EditorView.lineWrapping,
    ...(options.lineNumbers === false ? [] : [lineNumbers()]),
    ...(options.extensions ?? []),
  ]

  const keyBindings = Object.entries(options.commandKeys ?? {}).map(([name, key]) => ({
    key,
    preventDefault: true,
    run: () => runCommand(name),
  }))

  const commandKeymap = keymap.of([
    ...keyBindings,
    // 命令名与快捷键都不冲突时，默认键位排在后面，避免抢掉编辑操作。
    ...defaultKeymap,
    ...historyKeymap,
  ])

  function stateExtensions(readOnly: boolean): Extension[] {
    return [
      ...baseExtensions,
      commandKeymap,
      editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    ]
  }

  let view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.body ?? '',
      extensions: stateExtensions(options.readOnly === true),
    }),
  })

  function stateFor(target: EditorOpenOptions): EditorState {
    const state = EditorState.create({
      doc: target.body,
      extensions: stateExtensions(target.readOnly === true),
    })
    if (target.selection === undefined) return state
    const from = clampPosition(target.selection.from, state.doc.length)
    const to = clampPosition(target.selection.to ?? from, state.doc.length)
    return state.update({
      selection: CmSelection.range(Math.min(from, to), Math.max(from, to)),
    }).state
  }

  function applyOpen(target: EditorOpenOptions): void {
    // 重建 state：doc 换掉的同时 undo 历史清零（跨文档撤销会串内容）。
    view.setState(stateFor(target))
    currentDocumentId = target.documentId
  }

  function runCommand(name: string): boolean {
    const run = commands.get(name)
    if (run === undefined) return false
    return run()
  }

  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    const queued = pendingOpen
    if (queued === null) return
    pendingOpen = null
    applyOpen(queued)
  }
  view.contentDOM.addEventListener('compositionstart', onCompositionStart)
  view.contentDOM.addEventListener('compositionend', onCompositionEnd)

  return {
    get documentId() {
      return currentDocumentId
    },

    get isComposing() { return composing || view.composing },

    setReadOnly(value: boolean): void {
      view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) })
    },

    open(target: EditorOpenOptions): void {
      if (composing) {
        // 组合中不重置编辑器：等 compositionend 再应用（见文件头说明）。
        pendingOpen = target
        return
      }
      applyOpen(target)
    },

    getBody(): string {
      return view.state.doc.toString()
    },

    getSelection(): EditorSelection {
      const range = view.state.selection.main
      return {
        from: range.from,
        to: range.to,
        text: view.state.sliceDoc(range.from, range.to),
      }
    },

    applyTransaction(changes: readonly EditorChange[]): void {
      if (changes.length === 0) return
      // CodeMirror 要求变更按 from 升序且互不重叠；这里替调用方排好序。
      const sorted = [...changes].sort((left, right) => left.from - right.from)
      view.dispatch({
        changes: sorted.map((change) => ({
          from: change.from,
          to: change.to,
          insert: change.insert,
        })),
      })
    },

    undo(): boolean {
      return undo(view)
    },

    redo(): boolean {
      return redo(view)
    },

    async flush(): Promise<void> {
      // 编辑器自身没有待派发缓冲：变更已经在 docChanged 时同步上报。
      // 这个方法是给"将来换成带防抖缓冲的编辑器"预留的语义位置。
    },

    decorate(ranges: readonly EditorDecoration[]): void {
      view.dispatch({ effects: setDecorations.of(ranges) })
    },

    registerCommand(name: string, run: () => boolean): () => void {
      if (!isEditorCommandName(name)) {
        throw new Error(`编辑器命令名不合法（要求 域.动作，例如 yfe.draft.flush）：${name}`)
      }
      const previous = commands.get(name)
      commands.set(name, run)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (commands.get(name) !== run) return
        if (previous === undefined) commands.delete(name)
        else commands.set(name, previous)
      }
    },

    focus(): void {
      view.focus()
    },

    onChange(handler: (body: string) => void): () => void {
      changeHandler = handler
      return () => {
        if (changeHandler === handler) changeHandler = null
      }
    },

    dispose(): void {
      view.contentDOM.removeEventListener('compositionstart', onCompositionStart)
      view.contentDOM.removeEventListener('compositionend', onCompositionEnd)
      commands.clear()
      changeHandler = null
      pendingOpen = null
      view.destroy()
    },

    commandNames(): readonly string[] {
      return [...commands.keys()].sort()
    },

    runCommand,
  }
}
