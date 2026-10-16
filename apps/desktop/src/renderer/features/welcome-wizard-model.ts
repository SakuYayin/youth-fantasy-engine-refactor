/**
 * 首启欢迎向导的纯逻辑层（W8-D · 差距报告 A 项，还原旧版 `WelcomeWizard.tsx`）。
 *
 * 为什么把逻辑抽出来（和 `settings-panel-model.ts` / `backup-manager-model.ts` 同一条理由）：
 * 「走哪条路要不要 `markSeen()`」是**规则**，不是渲染细节。规则留在组件里就只能靠
 * 「挂载整棵树 + 点按钮 + 数调用次数」验证，六条路径要六个挂载用例；写成纯函数则
 * 一条 `expect` 一行，而且以后外壳换渲染方式（例如把向导改成弹窗）时规则不会跟着漂。
 *
 * 🔴 本文件不 import 任何 Vue / DOM / `node:` 模块：纯函数才能被 node 环境的
 *    `welcome-wizard.test.ts` 直接吃下，也才能在挂载之外独立回归。
 *
 * 🔴 契约 `docs/接口冻结-W8外壳.md` §1.4 的三选一语义：
 *    ① 新建作品 → 外壳切到作品中心的新建表单（`projectId: null`）；
 *    ② 创建示范项目 → `welcome.createDemoProject()`，成功才 `projectId`；
 *    ③ 直接开始 → 直接进外壳（`projectId: null`）。
 *    ②的失败**不清除** `seen`（端口注释），所以失败时不能 `markSeen()`，用户要能重试。
 */

import type { FeatureResult } from './types.js'

/** 三选一入口的稳定 id。顺序即界面顺序。 */
export type WelcomeChoiceId = 'new' | 'demo' | 'start'

/** 一张入口卡片。`label` / `desc` 是**两行**文案：YfeButton 只有一个 label，装不下。 */
export interface WelcomeChoiceOption {
  readonly id: WelcomeChoiceId
  readonly label: string
  readonly desc: string
  /** 挂载测试的选择器锚点，写在数据里避免组件与测试各拼一遍字符串。 */
  readonly testId: string
}

// ============================================================================
// 文案常量（组件只负责摆位置，一个字都不自己写）
// ============================================================================

/** 面板标题（`YfePanel` 的 header）。 */
export const WELCOME_PANEL_TITLE = '欢迎'

/** 首屏大标题：跟品牌名走，和旧版 `WelcomeWizard` 的 h1 一致。 */
export const WELCOME_TITLE = '青春幻想引擎'

/** 首屏副标题。 */
export const WELCOME_SUBTITLE = '在你的世界中讲述你的故事'

/** 小节标题。 */
export const WELCOME_SECTION_TITLE = '你想怎么开始？'

/** 小节说明：强调「可改」与「入口不止这里」。 */
export const WELCOME_SECTION_NOTE = '选一个，随时可以改 —— 三个入口在项目管理页也都找得到。'

/** ① 新建作品。 */
export const CHOICE_NEW_LABEL = '新建作品'
export const CHOICE_NEW_DESC = '从零开始，自己搭设定与大纲'

/** ② 创建示范项目。 */
export const CHOICE_DEMO_LABEL = '创建示范项目'
export const CHOICE_DEMO_DESC = '一键体验全部功能：两卷二十章正文（约九万字）+ 全套设定'

/** ③ 直接开始。 */
export const CHOICE_START_LABEL = '直接开始'
export const CHOICE_START_DESC = '先随便看看，稍后再设置'

/**
 * 示范项目的二次确认文案 —— **逐字**来自契约 §1.4，不许改写。
 * `YfeDialog` 没有 body 插槽（只有 `title` + 两个按钮），所以整句必须塞进 `title`。
 */
export const DEMO_CONFIRM_TITLE =
  '创建示范项目「吞天神脉」？包含两卷二十章正文（约九万字）与全套设定。'

/** 确认框按钮文案。用「创建」而不是「确定」：按钮本身就是最后一道风险提示。 */
export const DEMO_CONFIRM_LABEL = '创建'
export const DEMO_CANCEL_LABEL = '取消'

/** 创建过程中的按钮文案：图文一起变，用户才知道「点到了」。 */
export const DEMO_BUSY_LABEL = '正在创建…'

/** 失败前缀。契约 §0.2：端口返回的 `message` 必须显示给用户。 */
export const DEMO_FAILED_PREFIX = '创建示范项目失败：'

/** 错误码单独一行小字（§0.2：code 可以放小字，但不能**只**显示 code）。 */
export const DEMO_CODE_PREFIX = '错误码：'

/** 端口理论上不抛异常（§0.2），真抛了也得有话说，不能白屏。 */
export const DEMO_THROWN_TEXT = '创建示范项目失败：发生了未预期的错误，请稍后再试。'

/** 底部「不再显示」复选框。 */
export const HIDE_CHECKBOX_LABEL = '不再显示'

/** 底部「跳过」按钮。 */
export const SKIP_BUTTON_LABEL = '跳过'

/** 三张入口卡片（顺序 = 界面顺序，模板直接 `v-for`）。 */
export const WELCOME_CHOICES: readonly WelcomeChoiceOption[] = [
  {
    id: 'new',
    label: CHOICE_NEW_LABEL,
    desc: CHOICE_NEW_DESC,
    testId: 'welcome-choice-new',
  },
  {
    id: 'demo',
    label: CHOICE_DEMO_LABEL,
    desc: CHOICE_DEMO_DESC,
    testId: 'welcome-choice-demo',
  },
  {
    id: 'start',
    label: CHOICE_START_LABEL,
    desc: CHOICE_START_DESC,
    testId: 'welcome-choice-start',
  },
]

/** 只有「创建示范项目」要先弹确认框、要走异步端口。 */
export function isDemoChoice(id: WelcomeChoiceId): boolean {
  return id === 'demo'
}

// ============================================================================
// 规则：这次完成要不要写「欢迎已看过」
// ============================================================================

/**
 * 向导的四种收尾方式。
 *
 * `skip` 的语义特殊：它是**底部按钮**而不是三选一之一，契约 §1.4 明确「未勾选也应允许
 * 继续，只是下次仍出现」—— 也就是「跳过但没勾不再显示」是唯一一条走完了却不 `markSeen`
 * 的路径。这不是漏洞，是「让用户下次还能看到向导」的显式设计，所以单独建模。
 */
export type WelcomeOutcome =
  | { readonly kind: 'new' }
  | { readonly kind: 'demo'; readonly ok: boolean }
  | { readonly kind: 'start' }
  | { readonly kind: 'skip'; readonly hideChecked: boolean }

/**
 * 本次收尾要不要调 `welcome.markSeen()`。
 *
 * 规则汇总（契约 §1.4「向导完成（任意路径）必须调 markSeen()」+ 跳过复选框的例外）：
 * - 走完 ① 新建作品 → 是（用户做过选择了，不该每次启动都弹）；
 * - 走完 ② 创建示范项目 → **成功才**是；失败必须留着，否则用户被永久跳过（端口注释）；
 * - 走完 ③ 直接开始 → 是（同上，选过了就不再打扰）；
 * - ③ 的等价体「跳过」→ 勾了「不再显示」才是；没勾就下次再见。
 */
export function shouldMarkSeen(outcome: WelcomeOutcome): boolean {
  switch (outcome.kind) {
    case 'new':
    case 'start':
      return true
    case 'demo':
      return outcome.ok
    case 'skip':
      return outcome.hideChecked
  }
}

/** 失败时给用户看的主文案：前缀 + 端口给的 `message`。 */
export function demoFailureText(result: {
  readonly code: string
  readonly message: string
}): string {
  return `${DEMO_FAILED_PREFIX}${result.message}`
}

/** 失败时跟随的小字：错误码。方便用户截图报障，但绝不单独出现（§0.2）。 */
export function demoFailureCode(result: {
  readonly code: string
  readonly message: string
}): string {
  return `${DEMO_CODE_PREFIX}${result.code}`
}

/** 端口成功的返回值形状（与 `WelcomePort.createDemoProject` 的 `T` 对齐）。 */
export type DemoProjectResult = FeatureResult<{ readonly projectId: string }>
