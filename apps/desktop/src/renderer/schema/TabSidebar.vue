<script setup lang="ts">
/**
 * 侧栏导航（W5 建立 · A-09 加分组折叠）。
 *
 * 纯展示：数据由 `sidebarGroups(ctx)` 算好传进来，点击只 emit，
 * 不碰 IPC、不碰 app-state —— 这样它能在 happy-dom 里挂载测试，也能被真窗口 `--gui-check` 驱动。
 *
 * ## 分组折叠（A-09，对着上游 `Sidebar.tsx:194-211` 还原）
 *
 * - **状态由父层注入**：`collapsedGroups`（缺省＝全部展开，与 A-09 之前行为一致）；
 *   组件自己不读写 `localStorage`（`docs/接口冻结-W8外壳.md` §0.5），变更经
 *   `toggle-group(group)` 上报，由父层写 `settings-store`（键 `yfe-ui:sidebar-collapsed-groups`）。
 * - **折叠＝整组内容不渲染**（`v-if`，不是 `display:none`）：组标题仍在，`<ul>` 与页签按钮整段不在 DOM 里。
 * - 组头是 `<button type="button">` ＋ `aria-expanded`（键盘可达；上游用 Button 组件，行为一致）。
 * - 组头**不因 `disabled` 而被拦住**：`disabled` 表达的是「数据没加载完，别切页签」，
 *   而折叠是纯界面状态、不改任何数据，上游组头也没有禁用概念。
 */
import { computed } from 'vue'

import { collapsedGroupSet, sidebarGroupIcon } from './sidebar-collapse-model.js'
import type { TabGroupView } from './tab-registry.js'

const props = defineProps<{
  readonly groups: readonly TabGroupView[]
  readonly activeId: string | null
  readonly disabled?: boolean
  /** 已折叠的分组名；缺省（或不传）＝ 全部展开。由父层从设置里读、改动经 `toggle-group` 上报。 */
  readonly collapsedGroups?: readonly string[]
}>()

const emit = defineEmits<{
  readonly select: [string]
  /** 请求父层把该分组在折叠/展开之间取反（组件不记状态、不落库）。 */
  readonly 'toggle-group': [string]
}>()

/** 折叠集合：每次渲染现算（props 是真相源，组件不缓存）。 */
const collapsed = computed<ReadonlySet<string>>(() => collapsedGroupSet(props.collapsedGroups))

function onSelect(tabId: string): void {
  if (props.disabled === true || tabId === props.activeId) return
  emit('select', tabId)
}

function onToggleGroup(group: string): void {
  emit('toggle-group', group)
}
</script>

<template>
  <nav class="sidebar" aria-label="功能页签" data-testid="tab-sidebar">
    <section
      v-for="view in props.groups"
      :key="view.group"
      class="sidebar__group"
      :data-testid="`sidebar-group-${view.group}`"
    >
      <h2 class="sidebar__title">
        <button
          type="button"
          class="sidebar__group-toggle"
          :aria-expanded="collapsed.has(view.group) ? 'false' : 'true'"
          :data-testid="`sidebar-group-toggle-${view.group}`"
          @click="onToggleGroup(view.group)"
        >
          <span class="sidebar__group-name">{{ view.group }}</span>
          <span class="sidebar__group-icon" aria-hidden="true">{{ sidebarGroupIcon(collapsed.has(view.group)) }}</span>
        </button>
      </h2>
      <ul
        v-if="!collapsed.has(view.group)"
        class="sidebar__list"
        :data-testid="`sidebar-group-body-${view.group}`"
      >
        <li v-for="tab in view.tabs" :key="tab.id">
          <button
            type="button"
            class="sidebar__item"
            :class="{ 'sidebar__item--active': tab.id === props.activeId }"
            :aria-current="tab.id === props.activeId ? 'page' : undefined"
            :disabled="props.disabled === true"
            :data-testid="`sidebar-tab-${tab.id}`"
            :title="tab.description === '' ? tab.name : tab.description"
            @click="onSelect(tab.id)"
          >
            {{ tab.name }}
          </button>
        </li>
      </ul>
    </section>
  </nav>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  min-width: 168px;
  max-width: 220px;
  padding: var(--yfe-space-sm, 8px);
  overflow-y: auto;
  border-right: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 13px);
}

.sidebar__group {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.sidebar__title {
  margin: 0;
  padding: 0 var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-xs, 11px);
  font-weight: var(--yfe-font-weight-bold, 600);
  letter-spacing: 0.06em;
}

/* 组头＝可点按钮：清掉按钮原生外观，字号/颜色一律从 h2 继承。 */
.sidebar__group-toggle {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--yfe-radius-sm, 4px);
  background: transparent;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-align: left;
  cursor: pointer;
}

.sidebar__group-toggle:hover {
  color: var(--yfe-color-text, #e6e8ee);
}

.sidebar__group-toggle:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
  outline-offset: 1px;
}

.sidebar__group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折叠图标：与上游 `ChevronDown` + `-rotate-90` 同一个「随状态切换」的语义。 */
.sidebar__group-icon {
  margin-left: auto;
  font-size: var(--yfe-font-size-sm, 13px);
  line-height: 1;
}

.sidebar__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sidebar__item {
  width: 100%;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid transparent;
  border-radius: var(--yfe-radius-sm, 4px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sidebar__item:hover:not(:disabled) {
  background: var(--yfe-color-surface-raised, #22262f);
  border-color: var(--yfe-color-border-strong, #3a4150);
}

.sidebar__item--active {
  background: var(--yfe-color-surface-raised, #22262f);
  border-color: var(--yfe-color-accent, #5aa9ff);
  color: var(--yfe-color-text, #e6e8ee);
}

.sidebar__item:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
  outline-offset: 1px;
}

.sidebar__item:disabled {
  color: var(--yfe-color-text-muted, #8b93a7);
  cursor: not-allowed;
}
</style>