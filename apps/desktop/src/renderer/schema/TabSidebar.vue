<script setup lang="ts">
/**
 * 侧栏导航（W5，Lead 独占）。
 *
 * 纯展示：数据由 `sidebarGroups(ctx)` 算好传进来，点击只 emit `select`，
 * 不碰 IPC、不碰 app-state —— 这样它能在 happy-dom 里挂载测试，也能被真窗口 `--gui-check` 驱动。
 */
import type { TabGroupView } from './tab-registry.js'

const props = defineProps<{
  readonly groups: readonly TabGroupView[]
  readonly activeId: string | null
  readonly disabled?: boolean
}>()

const emit = defineEmits<{ readonly select: [string] }>()

function onSelect(tabId: string): void {
  if (props.disabled === true || tabId === props.activeId) return
  emit('select', tabId)
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
      <h2 class="sidebar__title">{{ view.group }}</h2>
      <ul class="sidebar__list">
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
