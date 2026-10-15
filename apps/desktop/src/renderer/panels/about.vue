<script setup lang="ts">
/**
 * 「关于打赏」面板（`tab.id = 'about'`，分组「运营维护」）。
 *
 * 纯静态展示 + 一次复制动作，四块内容：
 * 1. 应用名与版本号：版本读 `state.getSnapshot().appVersion`，null/空显「开发版」；
 * 2. 项目一句话简介；
 * 3. 重构说明（本地 SQLite + Vue 3 + 预览版范围）；
 * 4. 打赏/支持区块：「复制支持链接」按钮用 `navigator.clipboard.writeText` 包
 *    try/catch，失败显「请手动选择复制」；剪贴板不可用时按钮**不禁用**
 *    （点击仍会尝试并给出失败提示），先给一条前置提示。
 *
 * 本面板没有持久化数据，因此不接 `panel-store`（接口冻结 §3 只约束「面板自己的数据」）。
 * 可见文案全部来自 `about-content.ts` 常量（接口冻结 §2）；样式只用 `--yfe-*` 令牌带字面量兜底。
 */
import { onBeforeUnmount, ref } from 'vue'

import { YfeButton, YfePanel } from '@yfe/ui'

import {
  APP_INTRO,
  APP_NAME,
  APP_NAME_EN,
  APP_SECTION_TITLE,
  CLIPBOARD_HINT,
  COPY_BUTTON_LABEL,
  COPY_FAILURE,
  COPY_SUCCESS,
  REBUILD_NOTES,
  REBUILD_TITLE,
  SUPPORT_DESC,
  SUPPORT_LINK,
  SUPPORT_LINK_NOTE,
  SUPPORT_TITLE,
  VERSION_LABEL,
  canUseClipboard,
  displayVersion,
} from './about-content.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

// 版本号跟随应用快照变化：subscribe 回调里重算，卸载时退订（快照不是响应式对象，computed 缓存一次就不更新了）。
const version = ref(displayVersion(props.state.getSnapshot().appVersion))
const stopSubscribe: () => void = props.state.subscribe((snapshot) => {
  version.value = displayVersion(snapshot.appVersion)
})
onBeforeUnmount(() => {
  stopSubscribe()
})

// 剪贴板不可用时按钮不禁用：点击仍会走到 writeText 并以失败提示收场，只先给一条前置说明。
const clipboardAvailable = canUseClipboard(navigator.clipboard)

const copyMessage = ref<string | null>(null)

/** 复制支持链接：`writeText` 包 try/catch，剪贴板缺失 / 权限拒绝 / 其它异常都显「请手动选择复制」。 */
async function copySupportLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(SUPPORT_LINK)
    copyMessage.value = COPY_SUCCESS
  } catch {
    copyMessage.value = COPY_FAILURE
  }
}
</script>

<template>
  <section class="panel-about" data-testid="panel-about">
    <header class="panel-about__header">
      <h1 class="panel-about__title">{{ props.tab.name }}</h1>
    </header>

    <YfePanel class="panel-about__section" :title="APP_SECTION_TITLE">
      <p class="panel-about__name">{{ APP_NAME }}</p>
      <p class="panel-about__name-en">{{ APP_NAME_EN }}</p>
      <p class="panel-about__version-row">
        <span class="panel-about__version-label">{{ VERSION_LABEL }}</span>
        <span class="panel-about__version" data-testid="about-version">{{ version }}</span>
      </p>
      <p class="panel-about__intro">{{ APP_INTRO }}</p>
    </YfePanel>

    <YfePanel class="panel-about__section" :title="REBUILD_TITLE">
      <ul class="panel-about__notes">
        <li v-for="note in REBUILD_NOTES" :key="note" class="panel-about__note">{{ note }}</li>
      </ul>
    </YfePanel>

    <YfePanel class="panel-about__section" :title="SUPPORT_TITLE">
      <p class="panel-about__support-desc">{{ SUPPORT_DESC }}</p>
      <p class="panel-about__link-note">{{ SUPPORT_LINK_NOTE }}</p>
      <p class="panel-about__link">
        <code class="panel-about__link-text" data-testid="support-link">{{ SUPPORT_LINK }}</code>
      </p>
      <p
        v-if="clipboardAvailable === false"
        class="panel-about__hint"
        data-testid="clipboard-hint"
      >{{ CLIPBOARD_HINT }}</p>
      <div class="panel-about__actions">
        <YfeButton :label="COPY_BUTTON_LABEL" variant="primary" @click="copySupportLink" />
      </div>
      <p
        v-if="copyMessage !== null"
        class="panel-about__copy-result"
        :class="{ 'panel-about__copy-result--failure': copyMessage === COPY_FAILURE }"
        data-testid="copy-result"
      >{{ copyMessage }}</p>
    </YfePanel>
  </section>
</template>

<style scoped>
.panel-about {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.panel-about__header {
  margin: 0;
}

.panel-about__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
}

.panel-about__section {
  flex: none;
}

.panel-about__name {
  margin: 0 0 var(--yfe-space-xs, 4px);
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.panel-about__name-en {
  margin: 0 0 var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__version-row {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  margin: 0 0 var(--yfe-space-sm, 8px);
}

.panel-about__version-label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__version {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family-mono, Consolas, 'Cascadia Mono', monospace);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.panel-about__notes {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
  padding: 0 0 0 var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text-muted, #8b93a7);
  line-height: var(--yfe-font-line-height, 1.7);
}

.panel-about__note {
  margin: 0;
}

.panel-about__support-desc {
  margin: 0 0 var(--yfe-space-sm, 8px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.panel-about__link-note {
  margin: 0 0 var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__link {
  margin: 0 0 var(--yfe-space-md, 12px);
}

.panel-about__link-text {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-background, #111318);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family-mono, Consolas, 'Cascadia Mono', monospace);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__hint {
  margin: 0 0 var(--yfe-space-md, 12px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #e8b96b);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-warning, #e8b96b);
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.panel-about__actions {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
  margin: 0 0 var(--yfe-space-sm, 8px);
}

.panel-about__copy-result {
  margin: 0;
  color: var(--yfe-color-success, #5ddc9a);
  font-size: var(--yfe-font-size-sm, 12px);
}

.panel-about__copy-result--failure {
  color: var(--yfe-color-danger, #ff7b72);
}
</style>
