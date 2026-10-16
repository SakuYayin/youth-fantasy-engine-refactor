<script setup lang="ts">
/**
 * 「使用指南」面板（`tab.id = 'guide'`，分组 = 工作面板）。
 *
 * 上游依据（只读参考）：`_upstream_tmp/youth-fantasy-engine-main/src/components/app/GuidePage.tsx`（154 行）。
 * 三节结构逐节对齐：①推荐填写顺序（可点击按钮链）②全部功能页签（按分组一览、可跳转、未启用灰显）
 * ③核心创作方法论（12 条卡片）；四段帮助正文与上游 4 处 `HelpPopover` 逐字一致。
 *
 * 数据来源与纪律：
 * - 页签清单**全部**从 `@yfe/schema-tabs` 的 `TABS` / `GROUPS` / `EDITOR_TAB` 派生，本页不手抄页签名；
 * - 纯逻辑在 `./guide-model.js`（常量 + 模型装配），本文件只做渲染与交互；
 * - 只读 `props.state`（`getSnapshot` + `subscribe`）与 `props.tab`，不发请求、不写 localStorage、
 *   不碰 `window.yfe`；不新增 `AppState` / `AppSnapshot` 成员。
 *
 * 跳转通道（`docs/剩余还原工作量清单.md:179` 契约 8 `yfe:navigate{tabId,rowId?}`，即 A-19）：
 * - 一级通道＝本组件 `emit('navigate', tabId)`，由外壳 `@navigate` 接线（一行，见交付报告）；
 * - 兜底通道＝外壳没接线时，再派发一次冒泡的 `yfe:navigate`（detail `{ tabId }`），
 *   保证 A-19 落地前点击同样生效；两者**二选一**（已接线就不再派发，不会重复跳转）。
 */
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef } from 'vue'

import type { AppSnapshot } from '../app-state.js'
import {
  DISABLED_BADGE,
  FILL_ORDER_NOTE,
  GUIDE_DISABLED_NOTE,
  GUIDE_EMPTY_NOTE,
  GUIDE_HELP,
  TIPS,
  buildGuideModel,
  helpLines,
  resolveVisCtx,
  type GuideHelpKey,
} from './guide-model.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

/** 面板级跳转契约：载荷就是页签 id（与 `TabDef.id` 同源，绝不拼字符串）。 */
const emit = defineEmits<{ (event: 'navigate', tabId: string): void }>()

/** setup 期取实例：事件回调里 `getCurrentInstance()` 恒为 null，取不到外部监听者的接线状态。 */
const instance = getCurrentInstance()

const snapshot = shallowRef<AppSnapshot>(props.state.getSnapshot())
const unsubscribe = props.state.subscribe((next) => {
  snapshot.value = next
})
onBeforeUnmount(() => {
  unsubscribe()
})

const model = computed(() => buildGuideModel(resolveVisCtx(snapshot.value)))

// 页签名为空时回退到 id（与 `_placeholder.vue` 同一口径），保证标题永远有字。
const title = computed(() => (props.tab.name.length > 0 ? props.tab.name : props.tab.id))

// ==================== 帮助气泡（复刻上游 HelpPopover 的语义） ====================

const openHelp = ref<GuideHelpKey | null>(null)

function toggleHelp(key: GuideHelpKey): void {
  openHelp.value = openHelp.value === key ? null : key
}

function closeHelp(): void {
  openHelp.value = null
}

// ==================== 分组折叠（默认全展开，点分组头收起） ====================

const collapsed = ref<ReadonlySet<string>>(new Set<string>())

function isExpanded(group: string): boolean {
  return !collapsed.value.has(group)
}

function toggleGroup(group: string): void {
  const next = new Set(collapsed.value)
  if (next.has(group)) next.delete(group)
  else next.add(group)
  collapsed.value = next
}

// ==================== 跳转 ====================

/**
 * 外壳是否绑定了 `@navigate`：已声明事件的监听器留在 setup 期的 `vnode.props` 上
 * （不会进 `attrs`），故用 `hasOwnProperty` 探测一次——`vnode` 之后可能被替换，只取一次。
 */
function hasOnNavigate(vnodeProps: object | null | undefined): boolean {
  return vnodeProps !== null && vnodeProps !== undefined && Object.prototype.hasOwnProperty.call(vnodeProps, 'onNavigate')
}

const wiredExternally = hasOnNavigate(instance === null ? null : instance.vnode.props)

function navigateTo(tabId: string): void {
  emit('navigate', tabId)
  if (wiredExternally) return
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent('yfe:navigate', { detail: { tabId }, bubbles: true }))
}
</script>

<template>
  <section class="guide" data-testid="guide-panel" :data-tab-id="props.tab.id">
    <header class="guide__header">
      <div class="guide__titlerow">
        <h1 class="guide__title" data-testid="guide-title">{{ title }}</h1>
        <div class="guide__help">
          <button
            type="button"
            class="guide__helpbtn"
            :aria-label="`${GUIDE_HELP.page.title}（帮助）`"
            :aria-expanded="openHelp === 'page'"
            data-testid="guide-help-toggle-page"
            @click="toggleHelp('page')"
          >
            ?
          </button>
          <div
            v-if="openHelp === 'page'"
            class="guide__helppop"
            role="note"
            data-testid="guide-help-body-page"
          >
            <p class="guide__helptitle">{{ GUIDE_HELP.page.title }}</p>
            <p v-for="(line, index) in helpLines('page')" :key="index" class="guide__helpline">
              {{ line }}
            </p>
            <button
              type="button"
              class="guide__helpclose"
              data-testid="guide-help-close-page"
              @click="closeHelp()"
            >
              收起
            </button>
          </div>
        </div>
      </div>
      <p v-if="props.tab.description.length > 0" class="guide__desc" data-testid="guide-desc">
        {{ props.tab.description }}
      </p>
    </header>

    <!-- ① 推荐填写顺序（上游 GuidePage.tsx:57-83） -->
    <section class="guide__card" data-testid="guide-fill-order">
      <header class="guide__cardhead">
        <h2 class="guide__cardtitle">推荐填写顺序</h2>
        <div class="guide__help">
          <button
            type="button"
            class="guide__helpbtn"
            :aria-label="`${GUIDE_HELP['fill-order'].title}（帮助）`"
            :aria-expanded="openHelp === 'fill-order'"
            data-testid="guide-help-toggle-fill-order"
            @click="toggleHelp('fill-order')"
          >
            ?
          </button>
          <div
            v-if="openHelp === 'fill-order'"
            class="guide__helppop"
            role="note"
            data-testid="guide-help-body-fill-order"
          >
            <p class="guide__helptitle">{{ GUIDE_HELP['fill-order'].title }}</p>
            <p v-for="(line, index) in helpLines('fill-order')" :key="index" class="guide__helpline">
              {{ line }}
            </p>
            <button
              type="button"
              class="guide__helpclose"
              data-testid="guide-help-close-fill-order"
              @click="closeHelp()"
            >
              收起
            </button>
          </div>
        </div>
      </header>
      <div class="guide__body">
        <p v-if="model.fillSteps.length === 0" class="guide__notice" data-testid="guide-fill-order-empty">
          {{ GUIDE_EMPTY_NOTE }}
        </p>
        <div v-else class="guide__steps">
          <template v-for="(step, index) in model.fillSteps" :key="step.id">
            <button
              type="button"
              class="guide__step"
              :data-testid="`guide-fill-step-${step.id}`"
              @click="navigateTo(step.id)"
            >
              {{ step.order }}. {{ step.name }}
            </button>
            <span v-if="index < model.fillSteps.length - 1" class="guide__arrow" aria-hidden="true">
              →
            </span>
          </template>
        </div>
        <p class="guide__note" data-testid="guide-fill-order-note">
          {{ FILL_ORDER_NOTE }}
        </p>
      </div>
    </section>

    <!-- ② 全部功能页签（上游 GuidePage.tsx:85-132） -->
    <section class="guide__card" data-testid="guide-all-tabs">
      <header class="guide__cardhead">
        <h2 class="guide__cardtitle">全部功能页签</h2>
        <div class="guide__help">
          <button
            type="button"
            class="guide__helpbtn"
            :aria-label="`${GUIDE_HELP['all-tabs'].title}（帮助）`"
            :aria-expanded="openHelp === 'all-tabs'"
            data-testid="guide-help-toggle-all-tabs"
            @click="toggleHelp('all-tabs')"
          >
            ?
          </button>
          <div
            v-if="openHelp === 'all-tabs'"
            class="guide__helppop guide__helppop--wide"
            role="note"
            data-testid="guide-help-body-all-tabs"
          >
            <p class="guide__helptitle">{{ GUIDE_HELP['all-tabs'].title }}</p>
            <p v-for="(line, index) in helpLines('all-tabs')" :key="index" class="guide__helpline">
              {{ line }}
            </p>
            <button
              type="button"
              class="guide__helpclose"
              data-testid="guide-help-close-all-tabs"
              @click="closeHelp()"
            >
              收起
            </button>
          </div>
        </div>
      </header>
      <div class="guide__body">
        <p v-if="model.groups.length === 0" class="guide__notice" data-testid="guide-empty">
          {{ GUIDE_EMPTY_NOTE }}
        </p>
        <template v-else>
          <p
            v-if="model.hasDisabledItems"
            class="guide__note"
            data-testid="guide-disabled-note"
          >
            {{ GUIDE_DISABLED_NOTE }}
          </p>
          <div
            v-for="group in model.groups"
            :key="group.name"
            class="guide__group"
            :data-testid="`guide-group-${group.name}`"
          >
            <button
              type="button"
              class="guide__grouphead"
              :aria-expanded="isExpanded(group.name)"
              :data-testid="`guide-group-toggle-${group.name}`"
              @click="toggleGroup(group.name)"
            >
              <span class="guide__groupbar" aria-hidden="true" />
              <span class="guide__groupname">{{ group.name }}</span>
              <span class="guide__groupcount" :data-testid="`guide-group-count-${group.name}`">
                {{ group.count }} 项
              </span>
              <span class="guide__groupchev" aria-hidden="true">{{ isExpanded(group.name) ? '收起' : '展开' }}</span>
            </button>
            <div v-if="isExpanded(group.name)" class="guide__items">
              <button
                v-for="item in group.items"
                :key="item.id"
                type="button"
                class="guide__tab"
                :class="{ 'guide__tab--off': !item.enabled }"
                :disabled="!item.enabled"
                :data-testid="`guide-tab-${item.id}`"
                @click="navigateTo(item.id)"
              >
                <span class="guide__tabrow">
                  <span class="guide__tabname">{{ item.name }}</span>
                  <span
                    v-if="!item.enabled"
                    class="guide__badge"
                    :data-testid="`guide-tab-badge-${item.id}`"
                  >
                    {{ DISABLED_BADGE }}
                  </span>
                </span>
                <span class="guide__tabdesc">{{ item.description }}</span>
              </button>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- ③ 核心创作方法论（上游 GuidePage.tsx:134-151） -->
    <section class="guide__card" data-testid="guide-tips">
      <header class="guide__cardhead">
        <h2 class="guide__cardtitle">核心创作方法论</h2>
        <div class="guide__help">
          <button
            type="button"
            class="guide__helpbtn"
            :aria-label="`${GUIDE_HELP.tips.title}（帮助）`"
            :aria-expanded="openHelp === 'tips'"
            data-testid="guide-help-toggle-tips"
            @click="toggleHelp('tips')"
          >
            ?
          </button>
          <div
            v-if="openHelp === 'tips'"
            class="guide__helppop"
            role="note"
            data-testid="guide-help-body-tips"
          >
            <p class="guide__helptitle">{{ GUIDE_HELP.tips.title }}</p>
            <p v-for="(line, index) in helpLines('tips')" :key="index" class="guide__helpline">
              {{ line }}
            </p>
            <button
              type="button"
              class="guide__helpclose"
              data-testid="guide-help-close-tips"
              @click="closeHelp()"
            >
              收起
            </button>
          </div>
        </div>
      </header>
      <div class="guide__tips">
        <article
          v-for="(tip, index) in TIPS"
          :key="tip.title"
          class="guide__tip"
          :data-testid="`guide-tip-${index}`"
        >
          <h3 class="guide__tiptitle">{{ tip.title }}</h3>
          <p class="guide__tipbody">{{ tip.body }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
/* 令牌名与 `@yfe/ui` 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.guide {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.guide__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.guide__titlerow {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.guide__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 13px);
}

/* ---------- 卡片 ---------- */

.guide__card {
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-surface, #171b26);
  overflow: hidden;
}

.guide__cardhead {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  background: var(--yfe-bg-surface, #1e2330);
  border-bottom: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
}

.guide__cardtitle {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 13px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__body {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
}

/* ---------- 帮助气泡 ---------- */

.guide__help {
  position: relative;
  display: inline-flex;
}

.guide__helpbtn {
  width: var(--yfe-size-status-dot, 16px);
  height: var(--yfe-size-status-dot, 16px);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4259);
  border-radius: var(--yfe-radius-pill, 999px);
  background: transparent;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
  cursor: pointer;
}

.guide__helpbtn:hover,
.guide__helpbtn[aria-expanded='true'] {
  border-color: var(--yfe-color-accent, #e0a458);
  color: var(--yfe-color-accent, #e0a458);
}

.guide__helpbtn:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 2px;
}

.guide__helppop {
  position: absolute;
  top: calc(100% + var(--yfe-space-xs, 4px));
  left: 0;
  z-index: 10;
  width: 22rem;
  max-width: 90vw;
  padding: var(--yfe-space-md, 12px);
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4259);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #232937);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
}

.guide__helppop--wide {
  width: 30rem;
}

.guide__helptitle {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 13px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-accent, #e0a458);
}

.guide__helpline {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 13px);
  color: var(--yfe-color-text, #e6e8ee);
}

.guide__helpclose {
  align-self: flex-end;
  padding: 2px var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
  border-radius: var(--yfe-radius-sm, 4px);
  background: transparent;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
  cursor: pointer;
}

/* ---------- 推荐填写顺序 ---------- */

.guide__steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.guide__step {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-bg-muted, #1b2030);
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-sm, 13px);
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.guide__step:hover {
  border-color: var(--yfe-color-accent, #e0a458);
  color: var(--yfe-color-accent, #e0a458);
}

.guide__step:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 2px;
}

.guide__arrow {
  color: var(--yfe-text-tertiary, #6b7280);
  font-size: var(--yfe-font-size-xs, 11px);
}

/* ---------- 全部功能页签 ---------- */

.guide__group {
  display: flex;
  flex-direction: column;
}

.guide__grouphead {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-xs, 4px);
  border: 0;
  background: transparent;
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-xs, 11px);
  cursor: pointer;
}

.guide__groupbar {
  width: 3px;
  height: 12px;
  border-radius: var(--yfe-radius-pill, 999px);
  background: var(--yfe-color-accent, #e0a458);
}

.guide__groupname {
  font-size: var(--yfe-font-size-sm, 13px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.guide__groupcount {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.guide__groupchev {
  margin-left: auto;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.guide__items {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  column-gap: var(--yfe-space-lg, 16px);
  padding: 0 var(--yfe-space-xs, 4px) var(--yfe-space-xs, 4px);
}

.guide__tab {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--yfe-space-xs, 4px) 0;
  border: 0;
  border-bottom: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
  background: transparent;
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.guide__tab:hover:not(:disabled) .guide__tabname {
  color: var(--yfe-color-accent, #e0a458);
}

.guide__tab:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 2px;
}

.guide__tab--off {
  opacity: 0.4;
  cursor: not-allowed;
}

.guide__tabrow {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
}

.guide__tabname {
  flex: 1;
  min-width: 0;
  font-size: var(--yfe-font-size-sm, 13px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.guide__badge {
  padding: 0 var(--yfe-space-xs, 4px);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-bg-muted, #1b2030);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
  white-space: nowrap;
}

.guide__tabdesc {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
}

/* ---------- 创作方法论 ---------- */

.guide__tips {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
}

.guide__tip {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2c3245);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-bg-muted, #1b2030);
}

.guide__tiptitle {
  margin: 0;
  color: var(--yfe-color-accent, #e0a458);
  font-size: var(--yfe-font-size-sm, 13px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.guide__tipbody {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-xs, 11px);
}

/* ---------- 说明 / 空态 ---------- */

.guide__note,
.guide__notice {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
}

.guide__notice {
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-warning, #c9a227);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-warning-bg, rgb(201 162 39 / 10%));
  color: var(--yfe-color-warning-text, #e8d18a);
}
</style>