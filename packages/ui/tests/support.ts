/**
 * 测试侧共用的最小工具。
 *
 * 为什么需要它：`tsconfig.tests.json` 的 `lib` 只有 ES2023，测试程序里**没有**
 * `document` / `HTMLElement` / `KeyboardEvent` 这些 DOM 全局名（vitest 运行时是
 * happy-dom，类型层没有）。所以这里一律从「挂载点」往外拿对象，用 `unknown`
 * 收窄成最小结构——既不写 `any`，也不用为了几条断言往 tsconfig 里塞 DOM lib。
 */
import { afterEach } from 'vitest'

interface Unmountable {
  unmount: () => void
}

const mounted: Unmountable[] = []

// 挂在文件级：对话框会监听 document，忘了卸载会污染同文件后续用例。
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

/** 登记一个 wrapper，测试结束自动 `unmount`。 */
export function track<T extends Unmountable>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

/** 只需要 `focus()` 的最小接口。 */
export interface Focusable {
  focus: () => void
}

/** 从挂载点能拿到的 document 子集。 */
export interface DocumentLike {
  readonly activeElement: unknown
  readonly defaultView: {
    KeyboardEvent: new (type: string, init?: { key?: string; shiftKey?: boolean }) => unknown
  }
  dispatchEvent: (event: unknown) => boolean
}

/** 取挂载点所属的 document（happy-dom 里就是全局那一个）。 */
export function documentOf(wrapper: { element: unknown }): DocumentLike {
  return (wrapper.element as { ownerDocument: DocumentLike }).ownerDocument
}

/** 取选择器命中的元素本身（比较 `activeElement` 时用）。 */
export function elementOf(
  wrapper: { get: (selector: string) => { element: unknown } },
  selector: string,
): unknown {
  return wrapper.get(selector).element
}

/** 取元素的标签名，用来断言「真的是原生按钮而不是 div 装按钮」。 */
export function tagNameOf(
  wrapper: { get: (selector: string) => { element: unknown } },
  selector: string,
): string {
  return (wrapper.get(selector).element as { tagName: string }).tagName
}

/** 主动把焦点放到某个元素上（焦点陷阱用例的前置条件）。 */
export function focusOf(
  wrapper: { get: (selector: string) => { element: unknown } },
  selector: string,
): void {
  ;(elementOf(wrapper, selector) as Focusable).focus()
}
