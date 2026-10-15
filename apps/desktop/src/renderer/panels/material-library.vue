<script setup lang="ts">
/**
 * 「素材资料」面板（tab.id = `material-library`，分组 = 灵感工具）。
 *
 * 素材资料库：五大分类（人物设计 / 故事结构 / 世界框架 / 情绪爽点 / 描写笔法）
 * 的只读素材条目，数据全部来自 `./material-data.js` 常量（接口冻结 §2：组件内
 * 不写死大段静态文案）。功能：分类筛选 + 关键词搜索（本地过滤，过滤逻辑只在
 * `filterMaterial` 纯函数里）+ 条目列表（标题 / 摘要 / 正文可展开）+ 每条「复制」。
 *
 * 本页没有数据依赖：不发请求、不读 `props.state`（仅按契约保留）、不落库；
 * 筛选状态用本地 ref（任务约定：素材库是只读参考，筛选不必跨会话记忆）。
 * `navigator.clipboard` 不可用或写入失败时按钮显「请手动选择复制」。
 */
import { computed, ref } from 'vue'

import { YfeButton } from '@yfe/ui'

import {
  filterMaterial,
  MATERIAL_CATEGORIES,
  MATERIAL_ITEMS,
  MATERIAL_UI_COPY,
} from './material-data.js'
import type { MaterialCategoryId, MaterialItem } from './material-data.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 `_placeholder.vue` 同一口径），保证标题永远有字。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

/** 筛选状态：本地 ref，不持久化（只读参考页，无需跨会话记忆）。 */
const activeCategory = ref<MaterialCategoryId | 'all'>('all')
const keyword = ref('')
/** 已展开正文的条目 id 集合（整体替换以触发响应式）。 */
const expandedIds = ref<ReadonlySet<string>>(new Set<string>())
/** 复制反馈：最近一次成功 / 失败的条目 id（互斥）。 */
const copiedId = ref<string | null>(null)
const copyFailedId = ref<string | null>(null)

/** 分类筛选选项：「全部」+ 五大分类。 */
interface CategoryOption {
  readonly id: MaterialCategoryId | 'all'
  readonly name: string
}
const categoryOptions: readonly CategoryOption[] = [
  { id: 'all', name: MATERIAL_UI_COPY.categoryAllLabel },
  ...MATERIAL_CATEGORIES.map(
    (category): CategoryOption => ({ id: category.id, name: category.name }),
  ),
]

/** 过滤只走 `filterMaterial` 纯函数（单一实现，测试与视图共用）。 */
const visibleItems = computed<readonly MaterialItem[]>(() =>
  filterMaterial(MATERIAL_ITEMS, {
    category: activeCategory.value,
    keyword: keyword.value,
  }),
)

const countLine = computed<string>(() =>
  MATERIAL_UI_COPY.countLineText(MATERIAL_ITEMS.length, visibleItems.value.length),
)

function selectCategory(id: MaterialCategoryId | 'all'): void {
  activeCategory.value = id
}

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id)
}

function toggleExpand(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  expandedIds.value = next
}

function expandLabelFor(id: string): string {
  return isExpanded(id) ? MATERIAL_UI_COPY.collapseLabel : MATERIAL_UI_COPY.expandLabel
}

function copyLabelFor(id: string): string {
  if (copyFailedId.value === id) {
    return MATERIAL_UI_COPY.copyFailLabel
  }
  if (copiedId.value === id) {
    return MATERIAL_UI_COPY.copiedLabel
  }
  return MATERIAL_UI_COPY.copyLabel
}

function copyVariantFor(id: string): 'ghost' | 'primary' | 'danger' {
  if (copyFailedId.value === id) {
    return 'danger'
  }
  if (copiedId.value === id) {
    return 'primary'
  }
  return 'ghost'
}

/**
 * 复制条目全文（标题 + 摘要 + 正文）；剪贴板不可用或写入失败时不抛错，
 * 只标记失败（按钮显「请手动选择复制」并转警示色）。
 */
async function copyItem(item: MaterialItem): Promise<void> {
  copiedId.value = null
  copyFailedId.value = null
  try {
    await navigator.clipboard.writeText(`${item.title}\n${item.summary}\n${item.content}`)
    copiedId.value = item.id
  } catch {
    copyFailedId.value = item.id
  }
}
</script>

<template>
  <section class="material" data-testid="material-panel" :data-tab-id="props.tab.id">
    <header class="material__header">
      <h1 class="material__title">{{ title }}</h1>
      <p class="material__desc">{{ props.tab.description }}</p>
    </header>

    <div class="material__toolbar" data-testid="material-toolbar">
      <div
        class="material__categories"
        role="group"
        :aria-label="MATERIAL_UI_COPY.categoryGroupLabel"
      >
        <YfeButton
          v-for="option in categoryOptions"
          :key="option.id"
          :label="option.name"
          :variant="activeCategory === option.id ? 'primary' : 'ghost'"
          :data-testid="`material-category-${option.id}`"
          @click="selectCategory(option.id)"
        />
      </div>
      <input
        v-model="keyword"
        class="material__search"
        type="search"
        :placeholder="MATERIAL_UI_COPY.searchPlaceholder"
        :aria-label="MATERIAL_UI_COPY.searchPlaceholder"
        data-testid="material-search"
      />
    </div>

    <p class="material__count" data-testid="material-count">{{ countLine }}</p>

    <p
      v-if="MATERIAL_ITEMS.length === 0"
      class="material__empty"
      data-testid="material-empty-library"
    >
      {{ MATERIAL_UI_COPY.emptyLibraryText }}
    </p>
    <p
      v-else-if="visibleItems.length === 0"
      class="material__empty"
      data-testid="material-empty-result"
    >
      {{ MATERIAL_UI_COPY.emptyResultText }}
    </p>
    <ul v-else class="material__list" data-testid="material-list">
      <li
        v-for="item in visibleItems"
        :key="item.id"
        class="material__item"
        :data-testid="`material-item-${item.id}`"
      >
        <div class="material__item-head">
          <div class="material__item-text">
            <h3 class="material__item-title" data-testid="material-entry-title">
              {{ item.title }}
            </h3>
            <p class="material__item-summary">{{ item.summary }}</p>
          </div>
          <div class="material__item-actions">
            <YfeButton
              :label="expandLabelFor(item.id)"
              variant="ghost"
              :data-testid="`material-expand-${item.id}`"
              @click="toggleExpand(item.id)"
            />
            <YfeButton
              :label="copyLabelFor(item.id)"
              :variant="copyVariantFor(item.id)"
              :data-testid="`material-copy-${item.id}`"
              @click="copyItem(item)"
            />
          </div>
        </div>
        <p
          v-if="isExpanded(item.id)"
          class="material__item-content"
          data-testid="material-entry-content"
        >
          {{ item.content }}
        </p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 令牌名与 `@yfe/ui` 的 tokens.ts 一致，每个变量都带字面量兜底（深色默认值）。 */
.material {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.material__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.material__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.material__desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.material__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.material__categories {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--yfe-space-xs, 4px);
}

.material__search {
  flex: 1 1 200px;
  min-width: 180px;
  padding: 0 var(--yfe-space-sm, 8px);
  height: var(--yfe-size-control-height, 32px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
}

.material__search:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.material__count {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.material__empty {
  margin: 0;
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.material__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
}

.material__item {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
}

.material__item-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--yfe-space-md, 12px);
}

.material__item-text {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  min-width: 0;
}

.material__item-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.material__item-summary {
  margin: 0;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.material__item-actions {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  flex-shrink: 0;
}

.material__item-content {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border-top: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  white-space: pre-wrap;
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}
</style>
