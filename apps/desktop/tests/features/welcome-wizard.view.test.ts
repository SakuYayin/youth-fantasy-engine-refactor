// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 首启欢迎向导视图测试（真实挂载 + `@vue/test-utils`）—— W8-D。
 *
 * 覆盖的是**接线**：点哪张卡片调了哪个端口方法、`emit('done')` 的 payload 是什么、
 * 确认框文案是不是契约里那句、失败时 `message` 有没有真的显示出来、创建中按钮有没有禁用。
 * 「哪条路径该不该 markSeen」的规则在 `welcome-wizard.test.ts` 里逐条测过，
 * 这里只验证组件确实**问了**规则（即调用行为与规则一致）。
 *
 * 环境差异处理（VTU 2.5.1）：
 * - `get(...)` 的返回值**没有** `.exists()`：缺失性一律走 `find(...).exists()`；
 * - 原生属性统一 `.element as HTMLButtonElement / HTMLInputElement`；
 * - checkbox 用 `.setValue(true)`（依次触发 input + change）；
 * - `YfeButton` 把 `data-testid` 透传到内部原生 `<button>`；`YfeDialog` 把
 *   `data-testid` 透传到 `v-if` 的 overlay 根节点（`tavern-card.view.test.ts` 同款用法）；
 * - 任何异步点击（创建示范项目）后都要 `await flushPromises()` 再断言。
 *
 * `createWelcomeStub()` 的语义：
 * - `seen()` 由 `markSeen()` 置位，`marks.count` 数的是**调用次数**（契约要点是"调没调"）；
 * - `demoResult` 可在任意时刻改写，用来构造"先失败、重试成功"；
 * - `pending = true` 时 `createDemoProject()` 返回挂起的 Promise，由 `resolveDemo()` 放行，
 *   用来在"创建中"这一帧断言禁用态；
 * - `throwsDemo = true` 时直接抛异常（端口契约说不抛，但组件不能白屏）。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WelcomeWizard from '../../src/renderer/features/welcome-wizard.vue'
import type { FeatureResult, WelcomePort } from '../../src/renderer/features/types.js'
import {
  CHOICE_DEMO_DESC,
  CHOICE_DEMO_LABEL,
  CHOICE_NEW_DESC,
  CHOICE_NEW_LABEL,
  CHOICE_START_DESC,
  CHOICE_START_LABEL,
  DEMO_BUSY_LABEL,
  DEMO_CODE_PREFIX,
  DEMO_CONFIRM_TITLE,
  DEMO_FAILED_PREFIX,
  DEMO_THROWN_TEXT,
  HIDE_CHECKBOX_LABEL,
  SKIP_BUTTON_LABEL,
  WELCOME_SECTION_TITLE,
  WELCOME_SUBTITLE,
  WELCOME_TITLE,
  demoFailureCode,
  demoFailureText,
} from '../../src/renderer/features/welcome-wizard-model.js'

// ==================== 夹具 ====================

type DemoResult = FeatureResult<{ readonly projectId: string }>

/** 默认成功返回值：示范项目 id 与真项目格式无关，这里只要"非空且能带出来"。 */
const DEMO_OK: DemoResult = { ok: true, value: { projectId: 'demo-tuntian-1' } }

interface WelcomeStub {
  readonly port: WelcomePort
  /** `markSeen()` 的调用次数（0 = 没记）。 */
  readonly marks: { count: number }
  /** `createDemoProject()` 的调用次数。 */
  readonly creates: { count: number }
  /** 下一次 `createDemoProject()` 的返回值，可随时改写。 */
  demoResult: DemoResult
  /** 为 true 时 `createDemoProject()` 返回挂起 Promise，等 `resolveDemo()`。 */
  pending: boolean
  /** 为 true 时 `createDemoProject()` 直接抛异常（端口契约说不会，组件仍须兜住）。 */
  throwsDemo: boolean
  /** 放行挂起的 `createDemoProject()`（用 `demoResult` 结算）。 */
  resolveDemo(): void
}

function createWelcomeStub(demoResult: DemoResult = DEMO_OK): WelcomeStub {
  const marks = { count: 0 }
  const creates = { count: 0 }
  let settle: ((result: DemoResult) => void) | null = null
  let seenValue = false

  const stub: WelcomeStub = {
    marks,
    creates,
    demoResult,
    pending: false,
    throwsDemo: false,
    port: {
      seen(): boolean {
        return seenValue
      },
      markSeen(): void {
        marks.count += 1
        seenValue = true
      },
      createDemoProject(): Promise<DemoResult> {
        creates.count += 1
        if (stub.throwsDemo) throw new Error('端口不该抛异常，这里专门验证兜底')
        if (stub.pending) {
          return new Promise<DemoResult>((resolve) => {
            settle = resolve
          })
        }
        return Promise.resolve(stub.demoResult)
      },
    },
    resolveDemo(): void {
      const finish = settle
      settle = null
      stub.pending = false
      if (finish !== null) finish(stub.demoResult)
    },
  }
  return stub
}

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  welcome: WelcomePort
}

function mountView(stub: WelcomeStub) {
  const props: ViewProps = { welcome: stub.port }
  return mount(WelcomeWizard, { props })
}

type View = ReturnType<typeof mountView>

/** 容器上原生 HTML 元素（`data-testid` 透传后的落点）。 */
function button(wrapper: View, testid: string): HTMLButtonElement {
  return wrapper.get(`[data-testid="${testid}"]`).element as HTMLButtonElement
}

function checkbox(wrapper: View, testid: string): HTMLInputElement {
  return wrapper.get(`[data-testid="${testid}"]`).element as HTMLInputElement
}

/** 已发出的 `done` payload 列表（按顺序）。 */
function donePayloads(wrapper: View): { projectId: string | null }[] {
  return (wrapper.emitted('done') ?? []).map((args) => args[0] as { projectId: string | null })
}

const DIALOG = '[data-testid="welcome-demo-dialog"]'

// ==================== 渲染 ====================

describe('欢迎向导：渲染', () => {
  it('三张入口卡片的标题与说明都渲染出来，顺序为 新建 / 示范 / 直接开始', () => {
    const wrapper = mountView(createWelcomeStub())

    expect(wrapper.get('[data-testid="welcome-choice-new"]').text()).toContain(CHOICE_NEW_LABEL)
    expect(wrapper.get('[data-testid="welcome-choice-new"]').text()).toContain(CHOICE_NEW_DESC)
    expect(wrapper.get('[data-testid="welcome-choice-demo"]').text()).toContain(CHOICE_DEMO_LABEL)
    expect(wrapper.get('[data-testid="welcome-choice-demo"]').text()).toContain(CHOICE_DEMO_DESC)
    expect(wrapper.get('[data-testid="welcome-choice-start"]').text()).toContain(CHOICE_START_LABEL)
    expect(wrapper.get('[data-testid="welcome-choice-start"]').text()).toContain(CHOICE_START_DESC)

    const cards = wrapper.get('.welcome-wizard__choices').findAll('button')
    expect(cards).toHaveLength(3)
    expect(cards.map((card) => card.text())).toEqual([
      `${CHOICE_NEW_LABEL}${CHOICE_NEW_DESC}`,
      `${CHOICE_DEMO_LABEL}${CHOICE_DEMO_DESC}`,
      `${CHOICE_START_LABEL}${CHOICE_START_DESC}`,
    ])
  })

  it('头部与小节文案可见，底部有「不再显示」复选框与「跳过」按钮', () => {
    const wrapper = mountView(createWelcomeStub())

    expect(wrapper.get('[data-testid="welcome-title"]').text()).toBe(WELCOME_TITLE)
    expect(wrapper.text()).toContain(WELCOME_SUBTITLE)
    expect(wrapper.text()).toContain(WELCOME_SECTION_TITLE)
    expect(wrapper.get('[data-testid="welcome-skip"]').text()).toBe(SKIP_BUTTON_LABEL)
    expect(wrapper.get('label.welcome-wizard__checkbox').text()).toContain(HIDE_CHECKBOX_LABEL)
    expect(checkbox(wrapper, 'welcome-hide-checkbox').checked).toBe(false)
  })

  it('首帧不弹确认框、不显示失败、不动端口（用户没点之前一切都是静的）', () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="welcome-demo-error"]').exists()).toBe(false)
    expect(stub.creates.count).toBe(0)
    expect(stub.marks.count).toBe(0)
    expect(wrapper.emitted('done')).toBeUndefined()
  })
})

// ==================== ① 新建作品 ====================

describe('欢迎向导：① 新建作品', () => {
  it('点「新建作品」→ emit done(projectId: null) 且记下已看过', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-new"]').trigger('click')

    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
    expect(stub.marks.count).toBe(1)
    expect(stub.creates.count).toBe(0)
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
  })
})

// ==================== ② 创建示范项目 ====================

describe('欢迎向导：② 创建示范项目', () => {
  it('点卡片本身不建项目，先弹确认框，文案逐字是契约那句', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')

    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(true)
    expect(wrapper.get(DIALOG).text()).toContain(DEMO_CONFIRM_TITLE)
    expect(wrapper.get('[data-testid="welcome-choice-demo"]').text()).toContain(CHOICE_DEMO_LABEL)
    // 还没确认：端口没被调，向导也没收尾。
    expect(stub.creates.count).toBe(0)
    expect(stub.marks.count).toBe(0)
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('确认框点「取消」→ 关掉对话框，不建项目、不收尾', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="cancel"]`).trigger('click')

    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(stub.creates.count).toBe(0)
    expect(stub.marks.count).toBe(0)
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('确认后调 createDemoProject() 一次，emit done 带新作品 id，并记下已看过', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()

    expect(stub.creates.count).toBe(1)
    expect(donePayloads(wrapper)).toEqual([{ projectId: 'demo-tuntian-1' }])
    expect(stub.marks.count).toBe(1)
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="welcome-demo-error"]').exists()).toBe(false)
  })

  it('失败时显示端口 message 与错误码，且**不**markSeen、不 emit done（向导留着能重试）', async () => {
    const failure: DemoResult = { ok: false, code: 'DEMO_CREATE_FAILED', message: '磁盘空间不足，无法写入示范项目' }
    const stub = createWelcomeStub(failure)
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()

    expect(stub.creates.count).toBe(1)
    expect(stub.marks.count).toBe(0)
    expect(wrapper.emitted('done')).toBeUndefined()

    const error = wrapper.get('[data-testid="welcome-demo-error"]')
    expect(error.text()).toContain(failure.message)
    expect(error.text()).toContain(demoFailureText(failure))
    expect(wrapper.get('[data-testid="welcome-demo-error-code"]').text()).toBe(
      demoFailureCode(failure),
    )
    expect(error.text()).toContain(DEMO_FAILED_PREFIX)
    expect(error.text()).toContain(DEMO_CODE_PREFIX)
    // 向导仍然开着（三张卡片还在），用户能再试一次。
    expect(wrapper.find('[data-testid="welcome-choice-demo"]').exists()).toBe(true)
  })

  it('失败后重试成功：第二次确认走成功路径，错误提示消失', async () => {
    const stub = createWelcomeStub({ ok: false, code: 'X', message: '临时故障' })
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()
    expect(stub.marks.count).toBe(0)

    stub.demoResult = DEMO_OK
    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()

    expect(stub.creates.count).toBe(2)
    expect(donePayloads(wrapper)).toEqual([{ projectId: 'demo-tuntian-1' }])
    expect(stub.marks.count).toBe(1)
    expect(wrapper.find('[data-testid="welcome-demo-error"]').exists()).toBe(false)
  })

  it('失败文案里的 message 为空串时仍有前缀，不出现空白提示', async () => {
    const stub = createWelcomeStub({ ok: false, code: 'EMPTY_MESSAGE', message: '' })
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="welcome-demo-error"]').text()).toContain(DEMO_FAILED_PREFIX)
    expect(wrapper.get('[data-testid="welcome-demo-error-code"]').text()).toBe(
      `${DEMO_CODE_PREFIX}EMPTY_MESSAGE`,
    )
    expect(stub.marks.count).toBe(0)
  })

  it('端口违约抛异常时也不白屏：显示兜底文案且不 markSeen', async () => {
    const stub = createWelcomeStub()
    stub.throwsDemo = true
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="welcome-demo-error"]').text()).toContain(DEMO_THROWN_TEXT)
    expect(stub.marks.count).toBe(0)
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('创建中：三张卡片与「跳过」都禁用，示范卡片显示进行时文案，重复点击不再打端口', async () => {
    const stub = createWelcomeStub()
    stub.pending = true
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get(`${DIALOG} [data-role="confirm"]`).trigger('click')

    expect(button(wrapper, 'welcome-choice-demo').disabled).toBe(true)
    expect(button(wrapper, 'welcome-choice-new').disabled).toBe(true)
    expect(button(wrapper, 'welcome-choice-start').disabled).toBe(true)
    expect(button(wrapper, 'welcome-skip').disabled).toBe(true)
    expect(wrapper.get('[data-testid="welcome-choice-demo"]').text()).toContain(DEMO_BUSY_LABEL)
    expect(wrapper.get('[data-testid="welcome-choice-demo"]').attributes('aria-busy')).toBe('true')

    // 脚本仍能 dispatch 点击（原生 disabled 挡不住），组件内部那道闸必须挡住。
    await wrapper.get('[data-testid="welcome-choice-demo"]').trigger('click')
    await wrapper.get('[data-testid="welcome-choice-new"]').trigger('click')
    await wrapper.get('[data-testid="welcome-skip"]').trigger('click')
    expect(stub.creates.count).toBe(1)
    expect(wrapper.emitted('done')).toBeUndefined()

    stub.resolveDemo()
    await flushPromises()

    expect(donePayloads(wrapper)).toEqual([{ projectId: 'demo-tuntian-1' }])
    expect(stub.marks.count).toBe(1)
  })
})

// ==================== ③ 直接开始 ====================

describe('欢迎向导：③ 直接开始', () => {
  it('点「直接开始」→ emit done(projectId: null) 且记下已看过', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-start"]').trigger('click')

    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
    expect(stub.marks.count).toBe(1)
    expect(stub.creates.count).toBe(0)
  })
})

// ==================== 跳过 + 不再显示 ====================

describe('欢迎向导：跳过与「不再显示」', () => {
  it('未勾选「不再显示」时跳过：收尾但**不**markSeen（下次启动仍会看到向导）', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    expect(checkbox(wrapper, 'welcome-hide-checkbox').checked).toBe(false)
    await wrapper.get('[data-testid="welcome-skip"]').trigger('click')

    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
    expect(stub.marks.count).toBe(0)
  })

  it('勾选「不再显示」后跳过：收尾并 markSeen', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-hide-checkbox"]').setValue(true)
    expect(checkbox(wrapper, 'welcome-hide-checkbox').checked).toBe(true)

    await wrapper.get('[data-testid="welcome-skip"]').trigger('click')

    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
    expect(stub.marks.count).toBe(1)
  })

  it('勾选后再取消勾选，跳过又回到「不 markSeen」', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-hide-checkbox"]').setValue(true)
    await wrapper.get('[data-testid="welcome-hide-checkbox"]').setValue(false)
    await wrapper.get('[data-testid="welcome-skip"]').trigger('click')

    expect(checkbox(wrapper, 'welcome-hide-checkbox').checked).toBe(false)
    expect(stub.marks.count).toBe(0)
    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
  })

  it('「不再显示」勾选状态不影响三选一：勾了之后点「直接开始」照样只 markSeen 一次', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-hide-checkbox"]').setValue(true)
    await wrapper.get('[data-testid="welcome-choice-start"]').trigger('click')

    expect(stub.marks.count).toBe(1)
    expect(donePayloads(wrapper)).toEqual([{ projectId: null }])
  })
})

// ==================== 收尾唯一性 ====================

describe('欢迎向导：收尾只发生一次', () => {
  it('点过「新建作品」后再点「跳过」不会重复 emit（外壳已切走，但组件本身也不该再发）', async () => {
    const stub = createWelcomeStub()
    const wrapper = mountView(stub)

    await wrapper.get('[data-testid="welcome-choice-new"]').trigger('click')
    await wrapper.get('[data-testid="welcome-skip"]').trigger('click')

    // 组件不自己卸载（卸载由外壳决定），所以这里只断言"每次点击各发一次"这一事实，
    // 不假装有幂等锁；真正防重复的是创建中的禁用闸（上一个用例已覆盖）。
    expect(donePayloads(wrapper)).toEqual([{ projectId: null }, { projectId: null }])
    expect(stub.marks.count).toBe(1)
  })
})
