// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 检查工具面板挂载测试（`check-tools.vue`，tab.id = `check-tools`，分组 = 灵感工具）。
 *
 * 验证运行时接线：
 * - 页签元数据（标题=页签名、副标题=页签描述）与能力/持久化边界说明正确渲染；
 * - 初始态显式中文引导；输入正文点击「开始检查」后，汇总/分组/条目渲染的是
 *   `check-tools-model` 对同一份输入的输出（接线正确，不重复断言模型内部）；
 * - 结果为空（空白输入）显「未发现问题」；清空回到初始态；再次检查替换旧结果；
 * - warn/info 分组与 data-severity、严重度色点；
 * - 可见文本 ⊆ 页签文案 ∪ 常量 ∪ 模型输出经派生的字符串（接口冻结 §6 验收 2）。
 *
 * 本面板为预览版纯本地检查：不订阅 state（state 仅以最小桩传入以满足 PanelProps），
 * 检查输入不持久化。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { getTab } from '@yfe/schema-tabs'
import type { TabDef } from '@yfe/schema-tabs'

import type { AppState } from '../../src/renderer/app-state.js'
import {
  BUTTON_CLEAR,
  BUTTON_RUN,
  DISCLAIMER,
  EMPTY_RESULT_LABEL,
  INITIAL_HINT,
  NO_PERSIST_NOTE,
  PANEL_INPUT_TITLE,
  PANEL_RESULT_TITLE,
  TEXTAREA_PLACEHOLDER,
  buildCheckSummary,
  checkText,
  formatIssueSummary,
  formatSeverityHeader,
} from '../../src/renderer/panels/check-tools-model.js'
import CheckTools from '../../src/renderer/panels/check-tools.vue'

interface ViewProps {
  /** `@vue/test-utils` 的 `props` 入参要求索引签名，否则 `mount` 报 TS2322。 */
  readonly [key: string]: unknown
  state: AppState
  tab: TabDef
}

/** 侧栏 TABS 里真实的 check-tools 页签（单一来源），缺失即抛错。 */
function checkToolsTab(): TabDef {
  const tab = getTab('check-tools')
  if (tab === undefined) {
    throw new Error('侧栏 TABS 里没有 check-tools 页签（schema-tabs 缺口）')
  }
  return tab
}

const TAB: TabDef = checkToolsTab()

/** state 桩：本面板不读取任何 state 字段，仅满足 PanelProps 结构。 */
function stateStub(): AppState {
  return {
    getSnapshot(): Record<string, unknown> {
      return {}
    },
    subscribe(): () => void {
      return () => {}
    },
  } as unknown as AppState
}

function mountView() {
  const props: ViewProps = { state: stateStub(), tab: TAB }
  return mount(CheckTools, { props })
}

/**
 * 综合样本（与 check-tools.test.ts 的组装样本一致）：
 * 行1尾空格 / 行2 我我 / 行4 句号混用（的确非重复词）/ 行5-7 三连空行 / 行8 ！！！。
 */
const SAMPLE = '第一章 觉醒 \n他说我我不知道。\n\n这的确很好，world，ok. no。\n\n\n\n太好了！！！'

/** 期望视图：与组件对同一份输入的模型输出（接线断言的基准）。 */
function expectedGroups(text: string) {
  const issues = checkText(text)
  return {
    issues,
    warn: issues.filter((issue) => issue.severity === 'warn'),
    info: issues.filter((issue) => issue.severity === 'info'),
    summary: buildCheckSummary(issues),
  }
}

async function runCheck(wrapper: ReturnType<typeof mountView>, text: string): Promise<void> {
  await wrapper.get('[data-testid="check-tools-input"]').setValue(text)
  await wrapper.get('[data-testid="check-tools-run"]').trigger('click')
}

describe('「检查工具」面板', () => {
  it('渲染页签元数据：标题=页签名、副标题=页签描述、data-tab-id=页签 id', () => {
    const wrapper = mountView()
    const root = wrapper.get('[data-testid="check-tools-panel"]')
    expect(root.element).toBeDefined()
    expect(root.attributes('data-tab-id')).toBe('check-tools')
    expect(wrapper.get('.check-tools__title').text()).toBe(TAB.name)
    expect(wrapper.get('.check-tools__description').text()).toBe(TAB.description)
    const notes = wrapper.findAll('.check-tools__note').map((note) => note.text())
    expect(notes).toEqual([DISCLAIMER, NO_PERSIST_NOTE])
  })

  it('初始态：中文引导 + 正文输入区 + 按钮文案，不渲染结果区', () => {
    const wrapper = mountView()
    expect(wrapper.get('[data-testid="check-tools-initial"]').text()).toBe(INITIAL_HINT)
    const textarea = wrapper.get('[data-testid="check-tools-input"]')
    expect(textarea.element).toBeDefined()
    expect(textarea.attributes('placeholder')).toBe(TEXTAREA_PLACEHOLDER)
    expect(wrapper.get('[data-testid="check-tools-run"]').text()).toBe(BUTTON_RUN)
    expect(wrapper.get('[data-testid="check-tools-clear"]').text()).toBe(BUTTON_CLEAR)
    expect(wrapper.findAll('[data-testid="check-tools-summary"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-empty"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-warn-group"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-info-group"]')).toHaveLength(0)
  })

  it('输入样本并检查：汇总/分组/条目与模型对同一输入的输出一致', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, SAMPLE)
    const expected = expectedGroups(SAMPLE)
    expect(wrapper.findAll('[data-testid="check-tools-initial"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="check-tools-summary"]').text()).toBe(
      formatIssueSummary(expected.summary.total, expected.summary.warn, expected.summary.info),
    )
    const warnGroup = wrapper.get('[data-testid="check-tools-warn-group"]')
    const infoGroup = wrapper.get('[data-testid="check-tools-info-group"]')
    expect(warnGroup.get('.check-tools__group-title').text()).toBe(
      formatSeverityHeader('warn', expected.warn.length),
    )
    expect(infoGroup.get('.check-tools__group-title').text()).toBe(
      formatSeverityHeader('info', expected.info.length),
    )
    expect(
      warnGroup.findAll('[data-testid="check-tools-issue-title"]').map((title) => title.text()),
    ).toEqual(expected.warn.map((issue) => issue.title))
    expect(
      warnGroup.findAll('[data-testid="check-tools-issue-detail"]').map((detail) => detail.text()),
    ).toEqual(expected.warn.map((issue) => issue.detail))
    expect(
      infoGroup.findAll('[data-testid="check-tools-issue-title"]').map((title) => title.text()),
    ).toEqual(expected.info.map((issue) => issue.title))
    expect(
      infoGroup.findAll('[data-testid="check-tools-issue-detail"]').map((detail) => detail.text()),
    ).toEqual(expected.info.map((issue) => issue.detail))
  })

  it('warn/info 分组标记：data-severity 与严重度色点（warn 黄 / info 灰）', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, SAMPLE)
    const expected = expectedGroups(SAMPLE)
    const warnGroup = wrapper.get('[data-testid="check-tools-warn-group"]')
    const infoGroup = wrapper.get('[data-testid="check-tools-info-group"]')
    const warnItems = warnGroup.findAll('.check-tools__item')
    const infoItems = infoGroup.findAll('.check-tools__item')
    expect(warnItems).toHaveLength(expected.warn.length)
    expect(infoItems).toHaveLength(expected.info.length)
    for (const item of warnItems) {
      expect(item.attributes('data-severity')).toBe('warn')
    }
    for (const item of infoItems) {
      expect(item.attributes('data-severity')).toBe('info')
    }
    expect(warnGroup.findAll('.check-tools__dot--warn')).toHaveLength(expected.warn.length)
    expect(warnGroup.findAll('.check-tools__dot--info')).toHaveLength(0)
    expect(infoGroup.findAll('.check-tools__dot--info')).toHaveLength(expected.info.length)
    expect(infoGroup.findAll('.check-tools__dot--warn')).toHaveLength(0)
  })

  it('干净文本：只报字数统计提示，无警告组', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, '你好。世界，很好！')
    const expected = expectedGroups('你好。世界，很好！')
    expect(wrapper.findAll('[data-testid="check-tools-empty"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="check-tools-summary"]').text()).toBe(
      formatIssueSummary(expected.summary.total, expected.summary.warn, expected.summary.info),
    )
    expect(wrapper.findAll('[data-testid="check-tools-warn-group"]')).toHaveLength(0)
    const infoGroup = wrapper.get('[data-testid="check-tools-info-group"]')
    expect(infoGroup.findAll('[data-testid="check-tools-issue-title"]').map((t) => t.text())).toEqual(
      expected.info.map((issue) => issue.title),
    )
  })

  it('空白输入：结果为空显「未发现问题」', async () => {
    const wrapper = mountView()
    for (const blank of ['', '   \n  ']) {
      await runCheck(wrapper, blank)
      expect(wrapper.get('[data-testid="check-tools-empty"]').text()).toBe(EMPTY_RESULT_LABEL)
      expect(wrapper.findAll('[data-testid="check-tools-summary"]')).toHaveLength(0)
      expect(wrapper.findAll('[data-testid="check-tools-warn-group"]')).toHaveLength(0)
      expect(wrapper.findAll('[data-testid="check-tools-info-group"]')).toHaveLength(0)
    }
  })

  it('清空：回到初始态，输入与结果都被清掉', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, SAMPLE)
    await wrapper.get('[data-testid="check-tools-clear"]').trigger('click')
    expect(wrapper.get('[data-testid="check-tools-initial"]').text()).toBe(INITIAL_HINT)
    const textarea = wrapper.get('[data-testid="check-tools-input"]')
      .element as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    expect(wrapper.findAll('[data-testid="check-tools-summary"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-warn-group"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-info-group"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="check-tools-empty"]')).toHaveLength(0)
  })

  it('再次检查替换旧结果：只显示最新一次的输出', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, SAMPLE)
    await runCheck(wrapper, '你好。世界')
    const expected = expectedGroups('你好。世界')
    expect(wrapper.get('[data-testid="check-tools-summary"]').text()).toBe(
      formatIssueSummary(expected.summary.total, expected.summary.warn, expected.summary.info),
    )
    expect(wrapper.findAll('[data-testid="check-tools-warn-group"]')).toHaveLength(0)
    const titles = wrapper
      .get('[data-testid="check-tools-info-group"]')
      .findAll('[data-testid="check-tools-issue-title"]')
      .map((title) => title.text())
    expect(titles).toEqual(expected.info.map((issue) => issue.title))
  })

  it('可见文本 ⊆ 页签文案 ∪ 常量 ∪ 模型输出（验收 2）', async () => {
    const wrapper = mountView()
    await runCheck(wrapper, SAMPLE)
    const expected = expectedGroups(SAMPLE)
    const rendered = [
      wrapper.get('.check-tools__title').text(),
      wrapper.get('.check-tools__description').text(),
      ...wrapper.findAll('.check-tools__note').map((note) => note.text()),
      ...wrapper.findAll('.yfe-panel__title').map((title) => title.text()),
      ...wrapper.findAll('.yfe-button__label').map((label) => label.text()),
      wrapper.get('[data-testid="check-tools-summary"]').text(),
      ...wrapper.findAll('.check-tools__group-title').map((title) => title.text()),
      ...wrapper.findAll('[data-testid="check-tools-issue-title"]').map((title) => title.text()),
      ...wrapper.findAll('[data-testid="check-tools-issue-detail"]').map((detail) => detail.text()),
    ]
    const allowed = new Set<string>([
      TAB.name,
      TAB.description,
      DISCLAIMER,
      NO_PERSIST_NOTE,
      INITIAL_HINT,
      EMPTY_RESULT_LABEL,
      TEXTAREA_PLACEHOLDER,
      PANEL_INPUT_TITLE,
      PANEL_RESULT_TITLE,
      BUTTON_RUN,
      BUTTON_CLEAR,
      formatIssueSummary(expected.summary.total, expected.summary.warn, expected.summary.info),
      formatSeverityHeader('warn', expected.warn.length),
      formatSeverityHeader('info', expected.info.length),
      ...expected.issues.map((issue) => issue.title),
      ...expected.issues.map((issue) => issue.detail),
    ])
    for (const text of rendered) {
      expect(allowed.has(text), `渲染了未知文本：${text}`).toBe(true)
    }
    // 输入区占位文案同样来自常量
    const placeholder = wrapper.get('[data-testid="check-tools-input"]').attributes('placeholder')
    expect(placeholder === undefined ? false : allowed.has(placeholder)).toBe(true)
  })
})
