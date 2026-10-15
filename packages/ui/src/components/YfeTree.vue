<script setup lang="ts">
/**
 * 章节树（ADR 0006 D3 + `02-桌面与界面.md` 的写作页结构）。
 *
 * 关键取舍：
 * 1. `nodes` 是**扁平带 depth 的列表**，组件自己按 `expandedIds` 隐藏被折叠祖先的
 *    后代（`hiddenUntilDepth` 栈）；这样调用方不必为折叠再算一份可见列表。
 * 2. 箭头与节点标题是**两个 sibling 按钮**：点箭头不可能触发 select，
 *    不靠 `stopPropagation` 猜事件流向。
 * 3. 箭头按钮 `aria-hidden` + `tabindex="-1"`：它是鼠标侧的便利入口，
 *    键盘用户走标题按钮上的 ←/→（`aria-expanded` 语义挂在 `treeitem` 上），
 *    这样不必为箭头自造「展开/折叠」文案（文案归属见 ADR D3）。
 * 4. 状态全是受控的：组件不持有展开/选中，只 emit `select` / `toggle`。
 */
import { computed, ref } from 'vue'

import { designTokenVariables, designTokens, parsePx } from '../tokens.js'
import type { YfeTreeNode } from '../types.js'

const props = defineProps<{
  nodes: readonly YfeTreeNode[]
  selectedId: string | null
  expandedIds: readonly string[]
}>()

const emit = defineEmits<{ select: [id: string]; toggle: [id: string] }>()

/** 缩进步长来自令牌（`size.treeIndent`），不是写死的 18。 */
const INDENT_PX = parsePx(designTokens.size.treeIndent)

const expandedSet = computed<ReadonlySet<string>>(() => new Set(props.expandedIds))

interface TreeRow {
  readonly node: YfeTreeNode
  /** 该行的左缩进，`depth * 步长`。 */
  readonly indent: string
}

const rows = computed<readonly TreeRow[]>(() => {
  const expanded = expandedSet.value
  const visible: TreeRow[] = []
  // 最近的「已折叠祖先」的 depth：比它深的节点都在它的子树里，不渲染。
  let hiddenUntilDepth: number | null = null

  for (const node of props.nodes) {
    if (hiddenUntilDepth !== null && node.depth <= hiddenUntilDepth) hiddenUntilDepth = null
    if (hiddenUntilDepth !== null) continue // 折叠子树内部的节点：连处理都不必
    visible.push({ node, indent: `${INDENT_PX * node.depth}px` })
    if (node.hasChildren && !expanded.has(node.id)) hiddenUntilDepth = node.depth
  }

  return visible
})

const activeToggleId = ref<string | null>(null)

function isExpanded(id: string): boolean {
  return expandedSet.value.has(id)
}

function onSelect(id: string): void {
  emit('select', id)
}

function onToggle(id: string): void {
  activeToggleId.value = id
  emit('toggle', id)
}

/** ←/→ 等价于点箭头：键盘用户没有「鼠标点小三角」这个动作。 */
function onArrow(node: YfeTreeNode, event: KeyboardEvent, expand: boolean): void {
  if (!node.hasChildren) return
  if (isExpanded(node.id) === expand) return
  event.preventDefault()
  onToggle(node.id)
}
</script>

<template>
  <ul class="yfe-tree" role="tree" :style="designTokenVariables">
    <li
      v-for="row in rows"
      :key="row.node.id"
      class="yfe-tree__row"
      role="treeitem"
      :aria-level="row.node.depth + 1"
      :aria-selected="row.node.id === selectedId ? 'true' : 'false'"
      :aria-expanded="row.node.hasChildren ? (isExpanded(row.node.id) ? 'true' : 'false') : undefined"
      :data-node-id="row.node.id"
      :data-depth="row.node.depth"
      :style="{ paddingLeft: row.indent }"
    >
      <button
        v-if="row.node.hasChildren"
        type="button"
        class="yfe-tree__toggle"
        tabindex="-1"
        aria-hidden="true"
        :data-toggle-id="row.node.id"
        @click.stop="onToggle(row.node.id)"
      >
        <span class="yfe-tree__arrow" :class="{ 'yfe-tree__arrow--expanded': isExpanded(row.node.id) }" />
      </button>
      <span v-else class="yfe-tree__toggle yfe-tree__toggle--leaf" aria-hidden="true" />

      <button
        type="button"
        class="yfe-tree__label"
        :class="{
          'yfe-tree__label--selected': row.node.id === selectedId,
          'yfe-tree__label--deleted': row.node.deleted === true,
          'yfe-tree__label--current': row.node.current === true,
        }"
        :data-label-id="row.node.id"
        @click="onSelect(row.node.id)"
        @keydown.right.prevent="onArrow(row.node, $event, true)"
        @keydown.left.prevent="onArrow(row.node, $event, false)"
      >
        <span class="yfe-tree__text">{{ row.node.label }}</span>
        <span
          v-if="row.node.current === true"
          class="yfe-tree__current"
          data-current-marker="true"
          aria-hidden="true"
        />
      </button>
    </li>
  </ul>
</template>

<style scoped>
.yfe-tree {
  margin: 0;
  padding: var(--yfe-space-xs) 0;
  list-style: none;
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
}

.yfe-tree__row {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-xs);
  min-height: var(--yfe-size-control-height);
}

.yfe-tree__toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--yfe-space-lg);
  height: var(--yfe-space-lg);
  padding: 0;
  border: none;
  background: none;
  color: var(--yfe-color-text-muted);
  cursor: pointer;
}

.yfe-tree__toggle--leaf {
  cursor: default;
}

/* 箭头用 CSS 画：不加任何文案，也不用图标字体（外部主题不该依赖图标包）。 */
.yfe-tree__arrow {
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  transition: transform 0.12s ease-out;
}

.yfe-tree__arrow--expanded {
  transform: rotate(90deg);
}

.yfe-tree__label {
  display: inline-flex;
  flex: 1;
  align-items: center;
  gap: var(--yfe-space-sm);
  min-width: 0;
  padding: 0 var(--yfe-space-xs);
  border: none;
  border-radius: var(--yfe-radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.yfe-tree__label:focus-visible {
  outline: var(--yfe-size-focus-width) solid var(--yfe-color-focus-ring);
  outline-offset: -1px;
}

.yfe-tree__label:hover {
  background: var(--yfe-color-surface-raised);
}

.yfe-tree__label--selected {
  background: var(--yfe-color-surface-raised);
  color: var(--yfe-color-text);
}

.yfe-tree__label--deleted .yfe-tree__text {
  text-decoration: line-through;
  color: var(--yfe-color-text-muted);
}

.yfe-tree__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.yfe-tree__current {
  flex: none;
  width: var(--yfe-size-status-dot);
  height: var(--yfe-size-status-dot);
  border-radius: var(--yfe-radius-pill);
  background: var(--yfe-color-accent);
}
</style>
