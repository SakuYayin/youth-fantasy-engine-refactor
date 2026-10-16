/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 首启欢迎向导的纯逻辑层测试（`welcome-wizard-model.ts`）。
 *
 * 这里只吃纯函数与常量表 —— 不挂载组件、不碰 DOM：
 * 「走哪条路要不要 markSeen」是规则，六条路径本该是六行断言，而不是六次挂载。
 * 可见文本与调用次数归 `welcome-wizard.view.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import {
  CHOICE_DEMO_DESC,
  CHOICE_DEMO_LABEL,
  CHOICE_NEW_DESC,
  CHOICE_NEW_LABEL,
  CHOICE_START_DESC,
  CHOICE_START_LABEL,
  DEMO_BUSY_LABEL,
  DEMO_CANCEL_LABEL,
  DEMO_CODE_PREFIX,
  DEMO_CONFIRM_LABEL,
  DEMO_CONFIRM_TITLE,
  DEMO_FAILED_PREFIX,
  DEMO_THROWN_TEXT,
  HIDE_CHECKBOX_LABEL,
  SKIP_BUTTON_LABEL,
  WELCOME_CHOICES,
  WELCOME_PANEL_TITLE,
  WELCOME_SECTION_NOTE,
  WELCOME_SECTION_TITLE,
  WELCOME_SUBTITLE,
  WELCOME_TITLE,
  demoFailureCode,
  demoFailureText,
  isDemoChoice,
  shouldMarkSeen,
} from '../../src/renderer/features/welcome-wizard-model.js'
import type { WelcomeChoiceId, WelcomeOutcome } from '../../src/renderer/features/welcome-wizard-model.js'

/** 取一张卡片；缺了就抛错，免得后面的断言对着 `undefined` 炸出难懂的信息。 */
function choice(id: WelcomeChoiceId) {
  const found = WELCOME_CHOICES.find((option) => option.id === id)
  if (found === undefined) throw new Error(`WELCOME_CHOICES 缺少 ${id} 入口`)
  return found
}

describe('WELCOME_CHOICES 三选一入口', () => {
  it('按契约给出 ①新建作品 ②创建示范项目 ③直接开始，顺序固定', () => {
    expect(WELCOME_CHOICES.map((option) => option.id)).toEqual(['new', 'demo', 'start'])
  })

  it('每张卡片的 label / desc / testId 都非空，且 testId 互不相同', () => {
    expect(WELCOME_CHOICES.length).toBeGreaterThan(0)
    for (const option of WELCOME_CHOICES) {
      expect(option.label.trim().length).toBeGreaterThan(0)
      expect(option.desc.trim().length).toBeGreaterThan(0)
      expect(option.testId.trim().length).toBeGreaterThan(0)
    }
    const testIds = WELCOME_CHOICES.map((option) => option.testId)
    expect(new Set(testIds).size).toBe(testIds.length)
  })

  it('三张卡片的文案与契约 §1.4 逐字一致', () => {
    expect(choice('new')).toMatchObject({ label: CHOICE_NEW_LABEL, desc: CHOICE_NEW_DESC })
    expect(choice('demo')).toMatchObject({ label: CHOICE_DEMO_LABEL, desc: CHOICE_DEMO_DESC })
    expect(choice('start')).toMatchObject({ label: CHOICE_START_LABEL, desc: CHOICE_START_DESC })
    expect(CHOICE_NEW_LABEL).toBe('新建作品')
    expect(CHOICE_DEMO_LABEL).toBe('创建示范项目')
    expect(CHOICE_START_LABEL).toBe('直接开始')
  })

  it('只有 demo 卡片走确认框 + 异步端口', () => {
    expect(isDemoChoice('demo')).toBe(true)
    expect(isDemoChoice('new')).toBe(false)
    expect(isDemoChoice('start')).toBe(false)
  })

  it('示范项目确认文案逐字照抄契约（含「吞天神脉」与九万字说明）', () => {
    expect(DEMO_CONFIRM_TITLE).toBe(
      '创建示范项目「吞天神脉」？包含两卷二十章正文（约九万字）与全套设定。',
    )
  })

  it('界面常量非空且都是中文（不出现空串导致的空白版面）', () => {
    const texts = [
      WELCOME_PANEL_TITLE,
      WELCOME_TITLE,
      WELCOME_SUBTITLE,
      WELCOME_SECTION_TITLE,
      WELCOME_SECTION_NOTE,
      HIDE_CHECKBOX_LABEL,
      SKIP_BUTTON_LABEL,
      DEMO_CONFIRM_LABEL,
      DEMO_CANCEL_LABEL,
      DEMO_BUSY_LABEL,
      DEMO_FAILED_PREFIX,
      DEMO_CODE_PREFIX,
      DEMO_THROWN_TEXT,
    ]
    for (const text of texts) {
      expect(text.trim().length).toBeGreaterThan(0)
      expect(text).toMatch(/[\u4e00-\u9fff]/)
    }
  })
})

describe('shouldMarkSeen：这次收尾要不要写「欢迎已看过」', () => {
  const cases: readonly { readonly name: string; readonly outcome: WelcomeOutcome; readonly expected: boolean }[] =
    [
      { name: '① 新建作品 → 走完了，要记', outcome: { kind: 'new' }, expected: true },
      { name: '② 创建示范项目成功 → 要记', outcome: { kind: 'demo', ok: true }, expected: true },
      {
        name: '② 创建示范项目失败 → 不记（失败不清除 seen，用户要能重试）',
        outcome: { kind: 'demo', ok: false },
        expected: false,
      },
      { name: '③ 直接开始 → 走完了，要记', outcome: { kind: 'start' }, expected: true },
      {
        name: '跳过但没勾「不再显示」→ 不记（下次启动还该看到向导）',
        outcome: { kind: 'skip', hideChecked: false },
        expected: false,
      },
      {
        name: '跳过且勾了「不再显示」→ 要记',
        outcome: { kind: 'skip', hideChecked: true },
        expected: true,
      },
    ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(shouldMarkSeen(testCase.outcome)).toBe(testCase.expected)
    })
  }

  it('六条路径里只有「示范失败」与「跳过未勾选」为 false', () => {
    const outcomes: readonly WelcomeOutcome[] = [
      { kind: 'new' },
      { kind: 'demo', ok: true },
      { kind: 'demo', ok: false },
      { kind: 'start' },
      { kind: 'skip', hideChecked: false },
      { kind: 'skip', hideChecked: true },
    ]
    const notMarked = outcomes.filter((outcome) => !shouldMarkSeen(outcome))
    expect(notMarked).toHaveLength(2)
    expect(notMarked).toEqual([
      { kind: 'demo', ok: false },
      { kind: 'skip', hideChecked: false },
    ])
  })

  it('同一 outcome 反复问结果稳定（纯函数，无隐式状态）', () => {
    const outcome: WelcomeOutcome = { kind: 'skip', hideChecked: false }
    expect(shouldMarkSeen(outcome)).toBe(false)
    expect(shouldMarkSeen(outcome)).toBe(false)
  })
})

describe('失败文案：message 必须给用户，code 只做小字补充', () => {
  const failure = { code: 'DEMO_CREATE_FAILED', message: '磁盘空间不足' }

  it('主文案带上端口给的 message', () => {
    expect(demoFailureText(failure)).toBe(`${DEMO_FAILED_PREFIX}磁盘空间不足`)
    expect(demoFailureText(failure)).toContain(failure.message)
  })

  it('错误码单独成行且带前缀，不与主文案混在一起', () => {
    expect(demoFailureCode(failure)).toBe(`${DEMO_CODE_PREFIX}DEMO_CREATE_FAILED`)
    expect(demoFailureCode(failure)).not.toBe(demoFailureText(failure))
  })

  it('message 为空串时主文案仍有前缀，不会白屏（§0.3）', () => {
    expect(demoFailureText({ code: 'X', message: '' })).toBe(DEMO_FAILED_PREFIX)
  })
})
