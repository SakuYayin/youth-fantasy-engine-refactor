// @vitest-environment happy-dom
/**
 * 编辑器适配层测试。
 *
 * 这里测的是**契约**（ADR 0006 / D4），不是 CodeMirror 自己的行为：
 * 换实现时这些用例必须全绿，否则渲染层与保存语义就脱钩了。
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  createCodeMirrorAdapter,
  type CodeMirrorAdapter,
} from '../src/renderer/editor/codemirror-adapter.js'
import { isEditorCommandName } from '../src/renderer/editor/editor-adapter.js'

/** 适配器 → 它自己的宿主；同时登记所有宿主，断言失败漏掉 dispose 时也能清干净。 */
const hosts = new WeakMap<CodeMirrorAdapter, HTMLElement>()
const trackedHosts: HTMLElement[] = []

function makeAdapter(options: Parameters<typeof createCodeMirrorAdapter>[1] = {}): CodeMirrorAdapter {
  const host = document.createElement('div')
  document.body.append(host)
  const adapter = createCodeMirrorAdapter(host, options)
  hosts.set(adapter, host)
  trackedHosts.push(host)
  return adapter
}

afterEach(() => {
  for (const host of trackedHosts.splice(0)) host.remove()
})

/**
 * 取「当前这个适配器」的内容节点。
 *
 * 不能用 `document.querySelector('.cm-editor')`：只要有用例在断言失败前没走到
 * `dispose()`，遗留的编辑器节点就排在后面新视图的前面，拿到别人的 DOM 之后再
 * 断言组合态保护，测的就是空气（本次 4 个失败里就有一个是这么来的）。
 */
function contentOf(adapter: CodeMirrorAdapter): HTMLElement {
  const content = hosts.get(adapter)?.querySelector('.cm-content')
  if (!(content instanceof HTMLElement)) throw new Error('编辑器内容节点不存在')
  return content
}

describe('编辑器适配层：正文与选择', () => {
  it('切换只读状态不重建正文、选区与撤销历史，组合态可被导航层查询', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: '原稿', selection: { from: 2 } })
    adapter.applyTransaction([{ from: 2, to: 2, insert: '新增' }])
    const selection = adapter.getSelection()
    adapter.setReadOnly(true)
    expect(contentOf(adapter).getAttribute('contenteditable')).toBe('false')
    expect(adapter.getBody()).toBe('原稿新增')
    expect(adapter.getSelection()).toEqual(selection)
    adapter.setReadOnly(false)
    expect(adapter.undo()).toBe(true)
    expect(adapter.getBody()).toBe('原稿')
    contentOf(adapter).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(adapter.isComposing).toBe(true)
    contentOf(adapter).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    expect(adapter.isComposing).toBe(false)
    adapter.dispose()
  })

  it('open 写入正文，getBody 读回；换文档会清掉 undo 历史', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: 'AAAA' })
    expect(adapter.getBody()).toBe('AAAA')
    expect(adapter.documentId).toBe('doc_1')

    adapter.applyTransaction([{ from: 2, to: 2, insert: 'BB' }])
    expect(adapter.getBody()).toBe('AABBAA')
    expect(adapter.undo()).toBe(true)
    expect(adapter.getBody()).toBe('AAAA')
    // 历史在 open 时被重建过，不能一路撤销回上一个文档的内容。
    expect(adapter.undo()).toBe(false)
    expect(adapter.getBody()).toBe('AAAA')

    adapter.open({ documentId: 'doc_2', body: 'BBB' })
    expect(adapter.getBody()).toBe('BBB')
    expect(adapter.documentId).toBe('doc_2')
    adapter.dispose()
  })

  it('applyTransaction 容忍乱序区间（内部按 from 排序）', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: '0123456789' })
    adapter.applyTransaction([
      { from: 8, to: 8, insert: 'X' },
      { from: 0, to: 0, insert: 'Y' },
    ])
    expect(adapter.getBody()).toBe('Y01234567X89')
    adapter.dispose()
  })

  it('选择区随变更移动，getSelection 返回精确区间', () => {
    const adapter = makeAdapter()
    // 光标停在替换区间之后：[2,5) 的三个字符换成两个，位置 6 应映射到 5。
    adapter.open({ documentId: 'doc_1', body: '0123456789', selection: { from: 6 } })
    expect(adapter.getSelection()).toEqual({ from: 6, to: 6, text: '' })

    adapter.applyTransaction([{ from: 2, to: 5, insert: 'AB' }])
    expect(adapter.getBody()).toBe('01AB56789')
    expect(adapter.getSelection()).toEqual({ from: 5, to: 5, text: '' })

    // 越界选区收敛到文档末尾，而不是抛错或把选区留在文档外。
    adapter.open({ documentId: 'doc_2', body: '短', selection: { from: 3, to: 9 } })
    expect(adapter.getSelection()).toEqual({ from: 1, to: 1, text: '' })
    adapter.dispose()
  })

  it('每次变更只回调一次，并给出完整正文', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: '甲' })
    const seen: string[] = []
    const stop = adapter.onChange((body) => seen.push(body))
    adapter.applyTransaction([{ from: 1, to: 1, insert: '乙' }])
    adapter.applyTransaction([{ from: 2, to: 2, insert: '丙' }])
    expect(seen).toEqual(['甲乙', '甲乙丙'])

    stop()
    adapter.applyTransaction([{ from: 3, to: 3, insert: '丁' }])
    expect(seen).toHaveLength(2)
    adapter.dispose()
  })

  it('decorate 只加装饰，不改正文', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: '冲突段落在这里' })
    adapter.decorate([{ from: 0, to: 4, class: 'yfe-conflict' }])
    expect(adapter.getBody()).toBe('冲突段落在这里')
    adapter.decorate([])
    expect(adapter.getBody()).toBe('冲突段落在这里')
    adapter.dispose()
  })
})

describe('编辑器适配层：输入法组合态', () => {
  it('组合期间到达的 open 会被挂起，组合结束后才应用（避免吃字）', () => {
    const adapter = makeAdapter()
    adapter.open({ documentId: 'doc_1', body: '甲' })

    contentOf(adapter).dispatchEvent(new Event('compositionstart'))
    adapter.open({ documentId: 'doc_2', body: '乙' })
    expect(adapter.getBody()).toBe('甲')
    expect(adapter.documentId).toBe('doc_1')

    contentOf(adapter).dispatchEvent(new Event('compositionend'))
    expect(adapter.getBody()).toBe('乙')
    expect(adapter.documentId).toBe('doc_2')
    adapter.dispose()
  })
})

describe('编辑器适配层：命令与只读', () => {
  it('registerCommand 支持运行、取消注册与恢复上一次实现', () => {
    const adapter = makeAdapter()
    let first = 0
    let second = 0
    const disposeFirst = adapter.registerCommand('yfe.draft.flush', () => {
      first += 1
      return true
    })
    expect(adapter.commandNames()).toEqual(['yfe.draft.flush'])
    expect(adapter.runCommand('yfe.draft.flush')).toBe(true)
    expect(first).toBe(1)

    const disposeSecond = adapter.registerCommand('yfe.draft.flush', () => {
      second += 1
      return true
    })
    disposeSecond()
    adapter.runCommand('yfe.draft.flush')
    expect(first).toBe(2)
    expect(second).toBe(0)

    disposeFirst()
    expect(adapter.runCommand('yfe.draft.flush')).toBe(false)
    expect(adapter.commandNames()).toEqual([])
    adapter.dispose()
  })

  it('非法命令名直接抛错（早失败，别等命令面板点不动才发现）', () => {
    const adapter = makeAdapter()
    expect(() => adapter.registerCommand('flush', () => true)).toThrow(/命令名不合法/)
    adapter.dispose()
  })

  it('命令名规则只接受「域.动作」形式', () => {
    expect(isEditorCommandName('yfe.draft.flush')).toBe(true)
    expect(isEditorCommandName('yfe.flush')).toBe(true)
    expect(isEditorCommandName('flush')).toBe(false)
    expect(isEditorCommandName('.flush')).toBe(false)
    expect(isEditorCommandName('yfe..flush')).toBe(false)
  })

  it('只读模式仍可程序化应用变更，但 open 不会抛错', () => {
    const adapter = makeAdapter({ readOnly: true })
    adapter.open({ documentId: 'doc_1', body: '只读正文' })
    expect(adapter.getBody()).toBe('只读正文')

    adapter.open({ documentId: 'doc_1', body: '只读正文', readOnly: true })
    adapter.applyTransaction([{ from: 0, to: 0, insert: 'X' }])
    expect(adapter.getBody()).toBe('X只读正文')
    adapter.dispose()
  })
})
