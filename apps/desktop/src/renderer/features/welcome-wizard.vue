<script setup lang="ts">
/**
 * 首启欢迎向导（W8-D · 差距报告 A 项，还原旧版 `WelcomeWizard.tsx`）。
 *
 * 契约见 `docs/接口冻结-W8外壳.md` §1.4。组件只做三件事：把三选一入口渲染出来、
 * 把点击翻成端口调用、把收尾翻译成 `emit('done')`。
 *
 * 🔴 铁律 1：只依赖 props 传进来的 `WelcomePort`（§0.1）。不 import `node:`、
 *    不 import `@yfe/contracts`、不碰 `window.yfe`、不自己 new client。
 * 🔴 铁律 2：端口返回 `ok:false` 时**必须**把 `message` 显示给用户（§0.2），
 *    并且**不** `markSeen()` —— 端口注释写死了「失败不清除 seen，让用户能重试」，
 *    这里要是顺手 mark 了，用户就被永久跳过了。
 * 🔴 铁律 3：`shouldMarkSeen()` 是唯一决定要不要 markSeen 的地方，六条路径都走它
 *    （规则在 `welcome-wizard-model.ts` 的纯函数里，不在模板里）。
 * 🔴 铁律 4：状态一律局部 `ref`，不读写 `localStorage`（§0.5）。
 *
 * ⚠️ 与上游的一处刻意偏差：三张入口卡片用**原生 `<button>`**，不是 `YfeButton`。
 *    上游每张卡片是两行（标题 + 说明），而 `YfeButton` 只渲染单行 `label`、
 *    **没有默认插槽**，两层文字塞不进去；退一步用 `YfeButton` + 外部说明又会丢掉
 *    「整卡可点」的命中区。`YfePanel`（区块）/ `YfeDialog`（二次确认）/ `YfeButton`
 *    （底部「跳过」）三件套都照常使用。
 *
 * ⚠️ `emits` 里的 `close` 按契约声明，但**本向导没有触发它的路径**：契约没给关闭
 *    入口，擅自加「×」会让用户误以为退出等于跳过（下次还弹）。声明保留给外壳未来接线。
 */

import { YfeButton, YfeDialog, YfePanel } from '@yfe/ui'
import { computed, ref } from 'vue'

import type { WelcomePort } from './types.js'
import {
  DEMO_BUSY_LABEL,
  DEMO_CANCEL_LABEL,
  DEMO_CONFIRM_LABEL,
  DEMO_CONFIRM_TITLE,
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
} from './welcome-wizard-model.js'
import type {
  DemoProjectResult,
  WelcomeChoiceOption,
  WelcomeOutcome,
} from './welcome-wizard-model.js'

const props = defineProps<{
  welcome: WelcomePort
}>()

const emit = defineEmits<{
  done: [payload: { projectId: string | null }]
  close: []
}>()

/** 「不再显示」复选框。默认不勾（契约 §1.4：未勾选也应允许继续）。 */
const hideChecked = ref(false)

/** 示范项目的二次确认框是否打开。 */
const dialogOpen = ref(false)

/** 创建示范项目进行中：三张卡片与「跳过」一起禁用，防止重复点击/半路改主意。 */
const demoBusy = ref(false)

/** 失败主文案（前缀 + 端口 message）。空串 = 没有失败，不占版面。 */
const errorText = ref('')
/** 失败错误码小字。 */
const errorCode = ref('')

const demoCard = computed<WelcomeChoiceOption>(() => {
  const card = WELCOME_CHOICES.find((choice) => isDemoChoice(choice.id))
  if (card === undefined) {
    // 常量表里没有 demo 卡片属于编程错误（不是用户输入），早炸比静默少一张卡好。
    throw new Error('WELCOME_CHOICES 缺少 demo 入口（welcome-wizard-model 缺口）')
  }
  return card
})

/** 卡片标题：创建中换成进行时文案，用户才知道「点到了」。 */
function choiceLabel(choice: WelcomeChoiceOption): string {
  if (isDemoChoice(choice.id) && demoBusy.value) return DEMO_BUSY_LABEL
  return choice.label
}

/**
 * 记「欢迎已看过」。
 *
 * 端口签名是同步 `void`，理论上不抛；真抛了也不能拦住开工 —— 照上游那条
 * 「记不上也不该拦住开工」，吞掉异常继续 `emit('done')`。
 */
function markSeenSafely(): void {
  try {
    props.welcome.markSeen()
  } catch {
    /* 记不上也不该拦住开工（上游 WelcomeWizard.finish 同款处理）。 */
  }
}

/** 统一收尾：先按规则决定要不要 markSeen，再通知外壳（`done` 永远只发一次）。 */
function complete(projectId: string | null): void {
  emit('done', { projectId })
}

async function runDemo(): Promise<void> {
  if (demoBusy.value) return
  demoBusy.value = true
  errorText.value = ''
  errorCode.value = ''

  let result: DemoProjectResult | null = null
  try {
    result = await props.welcome.createDemoProject()
  } catch {
    // 端口契约是「不抛异常，返回 FeatureResult」，真抛了也不能白屏（§0.3）。
    result = null
  }

  demoBusy.value = false

  if (result === null) {
    errorText.value = DEMO_THROWN_TEXT
    return
  }
  if (!result.ok) {
    errorText.value = demoFailureText(result)
    errorCode.value = demoFailureCode(result)
    return
  }

  // 只有走到这里才算「走完了」：失败路径刻意不 markSeen，用户要能重试。
  if (shouldMarkSeen({ kind: 'demo', ok: true })) markSeenSafely()
  complete(result.value.projectId)
}

function onChoiceClick(choice: WelcomeChoiceOption): void {
  // 第二道闸：原生 disabled 挡得住鼠标，挡不住脚本 `dispatchEvent`。
  if (demoBusy.value) return
  if (isDemoChoice(choice.id)) {
    dialogOpen.value = true
    return
  }
  // 「新建作品」与「直接开始」都算走完了向导；具体哪条要 markSeen 由模型的规则说了算。
  const outcome: WelcomeOutcome = choice.id === 'new' ? { kind: 'new' } : { kind: 'start' }
  if (shouldMarkSeen(outcome)) markSeenSafely()
  complete(null)
}

function onDemoConfirm(): void {
  dialogOpen.value = false
  void runDemo()
}

function onDemoCancel(): void {
  dialogOpen.value = false
}

function onHideToggle(event: Event): void {
  hideChecked.value = (event.target as HTMLInputElement).checked
}

/** 「跳过」是 ③ 直接开始的等价体，差别只在「不再显示」有没有勾（§1.4）。 */
function onSkip(): void {
  if (demoBusy.value) return
  if (shouldMarkSeen({ kind: 'skip', hideChecked: hideChecked.value })) markSeenSafely()
  complete(null)
}
</script>

<template>
  <YfePanel class="welcome-wizard" data-testid="welcome-wizard" :title="WELCOME_PANEL_TITLE">
    <div class="welcome-wizard__body">
      <header class="welcome-wizard__hero">
        <h1 class="welcome-wizard__title" data-testid="welcome-title">{{ WELCOME_TITLE }}</h1>
        <p class="welcome-wizard__subtitle">{{ WELCOME_SUBTITLE }}</p>
      </header>

      <section class="welcome-wizard__section">
        <h2 class="welcome-wizard__heading">{{ WELCOME_SECTION_TITLE }}</h2>
        <p class="welcome-wizard__note">{{ WELCOME_SECTION_NOTE }}</p>

        <div class="welcome-wizard__choices" role="group" :aria-label="WELCOME_SECTION_TITLE">
          <button
            v-for="choice in WELCOME_CHOICES"
            :key="choice.id"
            type="button"
            class="welcome-wizard__choice"
            :data-testid="choice.testId"
            :disabled="demoBusy"
            :aria-busy="isDemoChoice(choice.id) && demoBusy ? 'true' : undefined"
            @click="onChoiceClick(choice)"
          >
            <span
              v-if="isDemoChoice(choice.id) && demoBusy"
              class="welcome-wizard__spinner"
              aria-hidden="true"
            />
            <span class="welcome-wizard__choice-label">{{ choiceLabel(choice) }}</span>
            <span class="welcome-wizard__choice-desc">{{ choice.desc }}</span>
          </button>
        </div>

        <p
          v-if="errorText !== ''"
          class="welcome-wizard__error"
          data-testid="welcome-demo-error"
          role="alert"
        >
          <span class="welcome-wizard__error-main">{{ errorText }}</span>
          <span
            v-if="errorCode !== ''"
            class="welcome-wizard__error-code"
            data-testid="welcome-demo-error-code"
          >
            {{ errorCode }}
          </span>
        </p>
      </section>

      <footer class="welcome-wizard__footer">
        <label class="welcome-wizard__checkbox">
          <input
            type="checkbox"
            data-testid="welcome-hide-checkbox"
            :checked="hideChecked"
            @change="onHideToggle"
          />
          <span>{{ HIDE_CHECKBOX_LABEL }}</span>
        </label>
        <YfeButton
          data-testid="welcome-skip"
          :label="SKIP_BUTTON_LABEL"
          :disabled="demoBusy"
          @click="onSkip"
        />
      </footer>

      <YfeDialog
        data-testid="welcome-demo-dialog"
        :open="dialogOpen"
        :title="DEMO_CONFIRM_TITLE"
        :confirm-label="DEMO_CONFIRM_LABEL"
        :cancel-label="DEMO_CANCEL_LABEL"
        @confirm="onDemoConfirm"
        @cancel="onDemoCancel"
      />
    </div>
  </YfePanel>
</template>

<style scoped>
.welcome-wizard__body {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md, 14px);
}

.welcome-wizard__hero {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.welcome-wizard__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.welcome-wizard__subtitle,
.welcome-wizard__note {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.welcome-wizard__section {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.welcome-wizard__heading {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  font-weight: var(--yfe-font-weight-bold, 600);
  letter-spacing: 0.04em;
}

/* 整卡可点：命中区是整块，而不是那行小字（上游 WelcomeWizard 的卡片同款处理）。 */
.welcome-wizard__choices {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.welcome-wizard__choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  text-align: left;
  cursor: pointer;
}

.welcome-wizard__choice:hover:not(:disabled) {
  border-color: var(--yfe-color-accent, #5b8cff);
}

.welcome-wizard__choice:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.welcome-wizard__choice:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.welcome-wizard__choice-label {
  font-weight: var(--yfe-font-weight-medium, 500);
}

.welcome-wizard__choice-desc {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.welcome-wizard__spinner {
  width: var(--yfe-size-status-dot, 8px);
  height: var(--yfe-size-status-dot, 8px);
  border: var(--yfe-size-focus-width, 2px) solid currentColor;
  border-top-color: transparent;
  border-radius: var(--yfe-radius-pill, 999px);
  animation: welcome-wizard-spin 0.8s linear infinite;
}

@keyframes welcome-wizard-spin {
  to {
    transform: rotate(360deg);
  }
}

.welcome-wizard__error {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface-raised, #20242e);
}

.welcome-wizard__error-main {
  color: var(--yfe-color-danger, #ff7b72);
  font-size: var(--yfe-font-size-sm, 12px);
}

.welcome-wizard__error-code {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.welcome-wizard__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
  padding-top: var(--yfe-space-sm, 8px);
  border-top: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
}

.welcome-wizard__checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}
</style>
