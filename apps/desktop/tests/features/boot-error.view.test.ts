// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 启动失败兜底页的视图测试（真实挂载 + `@vue/test-utils`）—— A-04。
 *
 * 覆盖的是**接线**：标题/正文/提醒渲染成什么、按钮在有回调时才出现、点击调回调一次、
 * 没有错误信息时不白屏、有堆栈时折叠块默认收起。「任意抛出物 → 视图模型」的规则在
 * `boot-error.test.ts` 里逐条测过，这里只喂**造好的** `BootErrorView`。
 *
 * 环境差异处理（VTU 2.5.1，与 `welcome-wizard.view.test.ts` 一致）：
 * - `get(...)` 的返回值**没有** `.exists()`：缺失性一律走 `find(...).exists()`；
 * - `YfeButton` 把 `data-testid` 透传到内部原生 `<button>`，文案在内层 `span` 上，
 *   所以按钮用 `.text()` 断言、元素类型断言走 `.element as HTMLButtonElement`；
 * - `<details>` 的展开态是**原生属性**，断言 `element.open` 而不是查 class。
 *
 * 这里**不** spy `window.location.reload`：组件根本没引用 `location`（回调缺省时连按钮都
 * 不渲染），为一条「它没做的事」去改写 happy-dom 的 `Location` 反而会让测试变脆。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import BootError from '../../src/renderer/features/boot-error.vue'
import {
  BOOT_BACKUP_HINT,
  BOOT_ERROR_TITLE,
  BOOT_RECOVERY_STEPS,
  BOOT_RELOAD_LABEL,
  BOOT_TECHNICAL_SUMMARY,
  BOOT_UNKNOWN_DETAIL,
  toBootErrorView,
} from '../../src/renderer/features/boot-error-model.js'
import type { BootErrorView } from '../../src/renderer/features/boot-error-model.js'

// ==================== 夹具 ====================

const RELOAD = '[data-testid="boot-error-reload"]'

/** 一个带 name / message / stack 的失败视图（等价于外壳 `toBootErrorView(真错误)` 的产物）。 */
function failureView(): BootErrorView {
  const error = new Error('数据库文件被占用，无法打开')
  error.name = 'TypeError'
  error.stack = 'TypeError: 数据库文件被占用，无法打开\n    at boot (App.tsx:281:7)'
  return toBootErrorView(error)
}

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  error: BootErrorView | null
  onReload?: () => void
}

function mountView(error: BootErrorView | null, onReload?: () => void) {
  const props: ViewProps = onReload === undefined ? { error } : { error, onReload }
  return mount(BootError, { props })
}

type View = ReturnType<typeof mountView>

function button(wrapper: View, testid: string): HTMLButtonElement {
  return wrapper.get(`[data-testid="${testid}"]`).element as HTMLButtonElement
}

// ==================== 渲染 ====================

describe('启动失败兜底页：渲染', () => {
  it('整屏容器与标题渲染出来，标题逐字是「启动失败」', () => {
    const wrapper = mountView(failureView())

    expect(wrapper.find('[data-testid="boot-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="boot-error-title"]').text()).toBe(BOOT_ERROR_TITLE)
  })

  it('主错误正文显示「名称：消息」，不是干巴巴一个 message', () => {
    const wrapper = mountView(failureView())

    const message = wrapper.get('[data-testid="boot-error-message"]')
    expect(message.text()).toContain('TypeError')
    expect(message.text()).toContain('数据库文件被占用，无法打开')
    expect(message.text()).toBe('TypeError：数据库文件被占用，无法打开')
  })

  it('「先备份数据坞」提醒逐字来自上游（数据坞在左下角这句不许改）', () => {
    const wrapper = mountView(failureView())

    expect(wrapper.get('[data-testid="boot-error-hint"]').text()).toBe(BOOT_BACKUP_HINT)
    expect(wrapper.get('[data-testid="boot-error-hint"]').text()).toContain('数据坞')
  })

  it('恢复步骤按顺序渲染，条目数与文案与模型一致', () => {
    const wrapper = mountView(failureView())

    const steps = wrapper.get('[data-testid="boot-error-steps"]').findAll('[data-testid="boot-error-step"]')
    expect(steps).toHaveLength(BOOT_RECOVERY_STEPS.length)
    expect(steps.map((step) => step.text())).toEqual([...BOOT_RECOVERY_STEPS])
  })
})

// ==================== 重新加载按钮 ====================

describe('启动失败兜底页：重新加载', () => {
  it('传入回调时才渲染按钮，且标签是「重新加载」', () => {
    const wrapper = mountView(failureView(), () => {})

    expect(wrapper.find(RELOAD).exists()).toBe(true)
    expect(wrapper.get(RELOAD).text()).toBe(BOOT_RELOAD_LABEL)
    expect(button(wrapper, 'boot-error-reload').type).toBe('button')
  })

  it('没传回调时不渲染按钮（没有动作的按钮比没有按钮更糟）', () => {
    const wrapper = mountView(failureView())

    expect(wrapper.find(RELOAD).exists()).toBe(false)
  })

  it('模型说不能重载时，即使传了回调也不渲染按钮', () => {
    const wrapper = mountView(toBootErrorView(new Error('炸了'), { reloadAvailable: false }), () => {})

    expect(wrapper.find(RELOAD).exists()).toBe(false)
  })

  it('点击按钮只调回调一次，组件不自己吞也不自己重载', async () => {
    const calls = { count: 0 }
    const wrapper = mountView(failureView(), () => {
      calls.count += 1
    })

    await wrapper.get(RELOAD).trigger('click')

    expect(calls.count).toBe(1)
  })
})

// ==================== 无错误信息 ====================

describe('启动失败兜底页：没拿到错误信息', () => {
  it('error 为 null 时显示兜底文案而不是空白页，标题与提醒照旧', () => {
    const wrapper = mountView(null)

    expect(wrapper.get('[data-testid="boot-error-title"]').text()).toBe(BOOT_ERROR_TITLE)
    expect(wrapper.get('[data-testid="boot-error-message"]').text()).toBe(BOOT_UNKNOWN_DETAIL)
    expect(wrapper.get('[data-testid="boot-error-message"]').text().trim().length).toBeGreaterThan(0)
    expect(wrapper.get('[data-testid="boot-error-hint"]').text()).toBe(BOOT_BACKUP_HINT)
    // 没有错误信息 → 没有可折叠的技术详情。
    expect(wrapper.find('[data-testid="boot-error-detail"]').exists()).toBe(false)
  })

  it('error 为 null 但外壳给了回调：按钮照样可用（重试入口与错误信息无关）', async () => {
    const calls = { count: 0 }
    const wrapper = mountView(null, () => {
      calls.count += 1
    })

    await wrapper.get(RELOAD).trigger('click')

    expect(calls.count).toBe(1)
  })
})

// ==================== 技术详情 ====================

describe('启动失败兜底页：技术详情折叠块', () => {
  it('有 stack 时折叠块默认收起，展开里是逐字堆栈而不是改写过的', () => {
    const view = failureView()
    const wrapper = mountView(view)

    const details = wrapper.get('[data-testid="boot-error-detail"]')
    expect((details.element as HTMLDetailsElement).open).toBe(false)
    expect(details.get('summary').text()).toBe(BOOT_TECHNICAL_SUMMARY)
    expect(wrapper.get('[data-testid="boot-error-stack"]').text()).toBe(view.stack)
  })

  it('没有 stack（例如只抛了个字符串）时连折叠块都不渲染，不给用户一个空壳', () => {
    const wrapper = mountView(toBootErrorView('数据库连接失败'))

    expect(wrapper.find('[data-testid="boot-error-detail"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="boot-error-message"]').text()).toBe('数据库连接失败')
  })
})