<script setup lang="ts">
/**
 * 情节画布面板（tab.id = `plot-canvas`）。
 *
 * 只做渲染与调用：节点 id 工厂、章节分组、摘要请求拼装、失败提示在
 * `plot-canvas-model.ts` 纯函数里；节点状态持久化走 `createPanelStore`
 * （模板 `panel:plot-canvas`，按作品存，自动保存默认 1500ms，卸载时 dispose）。
 * AI 只走 `props.state.ai.complete(request)`（渲染层 CSP 禁网，模型请求由
 * main 进程代理发出），不 import 'node:*'、不 fetch。
 *
 * 结构：章节分组剧情节点卡片（标题 + 剧情要点 + 状态：未写/草稿/完成）
 * + 简化画布视图（按章节分组的色块条，显式标注预览版简化视图）
 * + 可选「AI 情节摘要」（把选中章节的节点要点拼一段，走 AI 生成摘要展示）。
 * 未配置模型不禁用按钮，点击显示引导；无当前作品显示提示，节点编辑仍可用。
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'

import { YfeButton, YfePanel, YfeStatusPill } from '@yfe/ui'

import type { AiResult } from '../ai/types.js'
import type { PanelProps } from './types.js'
import {
  NODE_STATUS_LABELS,
  NODE_STATUS_ORDER,
  PLOT_PANEL_TEXT,
  buildSummaryRequest,
  collectChapters,
  createDefaultPanelData,
  createNode,
  failureNotice,
  formatNodeCount,
  groupNodesByChapter,
  isPlotNodeStatus,
  nodesForSummary,
  normalizeNodes,
  plotSaveStatus,
  type PlotChapterOption,
  type PlotNode,
  type PlotPanelData,
} from './plot-canvas-model.js'
import { createPanelStore } from './panel-store.js'

const props = defineProps<PanelProps>()

const TEXT = PLOT_PANEL_TEXT

/** 页签标题：页签名为空时回落页签 id。 */
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

// ---- 作品快照（只读订阅章节树；面板不写 state）----
const snapshot = shallowRef(props.state.getSnapshot())
const unsubscribe = props.state.subscribe((next) => {
  snapshot.value = next
})
const chapters = computed<readonly PlotChapterOption[]>(() => collectChapters(snapshot.value.tree))
const hasProject = computed(() => snapshot.value.projectId !== null)

// ---- 面板状态（按作品存，模板 panel:plot-canvas，自动保存默认 1500ms）----
const store = createPanelStore<PlotPanelData>(props.state, props.tab.id, createDefaultPanelData())
const storeSaving = store.saving
const storeDirty = store.dirty
const storeError = store.error

// ---- 本地节点镜像（编辑在此，改后整体同步进 store）----
const nodes = ref<PlotNode[]>([])
const newNodeChapterId = ref<string>('')
const summaryChapterId = ref<string>('')
const aiPhase = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const summaryText = ref('')
const message = ref<string | null>(TEXT.idleHint)

/** 序号守卫：卸载后，在飞摘要结果按序号丢弃（AiPort 没有 abort）。 */
let runSeq = 0
let disposed = false

const running = computed(() => aiPhase.value === 'running')
const groups = computed(() => groupNodesByChapter(nodes.value, chapters.value))
const nodeCount = computed(() => nodes.value.length)
const saveStatus = computed(() =>
  plotSaveStatus(storeSaving.value, storeDirty.value, storeError.value !== null),
)
const summaryScopeLabel = computed(() => {
  const id = summaryChapterId.value
  if (id === '') return TEXT.allChapters
  const found = chapters.value.find((chapter) => chapter.id === id)
  return found === undefined ? TEXT.unassigned : found.label
})
const summaryTargets = computed(() =>
  nodesForSummary(nodes.value, summaryChapterId.value === '' ? null : summaryChapterId.value, chapters.value),
)

onMounted(() => {
  void loadStore()
})

onUnmounted(() => {
  disposed = true
  runSeq += 1
  unsubscribe()
  store.dispose()
})

/** 挂载时 load()：载入当前作品保存的剧情节点（无则保持默认空状态）。 */
async function loadStore(): Promise<void> {
  await store.load()
  if (disposed) return
  nodes.value = [...normalizeNodes(store.data.value.nodes)]
  if (nodes.value.length > 0) {
    message.value = TEXT.loadedFromStore
  }
}

/** 把本地镜像整体同步进面板状态（触发标脏与自动保存）。 */
function syncStore(): void {
  store.set({ nodes: nodes.value.map((node) => ({ ...node })) })
}

function onAddNode(): void {
  const chapterId = newNodeChapterId.value === '' ? null : newNodeChapterId.value
  nodes.value = [...nodes.value, createNode('', '', 'todo', chapterId)]
  syncStore()
  message.value = null
}

/** 受控输入：先同步本地镜像，再整体写回 store（保存失败不丢本地数据）。 */
function onNodeTitleInput(node: PlotNode, event: Event): void {
  node.title = (event.target as HTMLInputElement).value
  syncStore()
}

function onNodeSummaryInput(node: PlotNode, event: Event): void {
  node.summary = (event.target as HTMLTextAreaElement).value
  syncStore()
}

function onNodeStatusChange(node: PlotNode, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  node.status = isPlotNodeStatus(value) ? value : 'todo'
  syncStore()
}

function onNodeChapterChange(node: PlotNode, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  node.chapterId = value === '' ? null : value
  syncStore()
}

function onRemoveNode(id: string): void {
  nodes.value = nodes.value.filter((node) => node.id !== id)
  syncStore()
}

/** AI 情节摘要：未配置模型给引导（按钮不禁用）；失败显错误信息。 */
async function onSummarize(): Promise<void> {
  if (running.value) return
  if (summaryTargets.value.length === 0) {
    message.value = TEXT.aiEmpty
    return
  }
  if (!props.state.ai.configured()) {
    message.value = TEXT.notConfigured
    return
  }
  const request = buildSummaryRequest(summaryTargets.value, summaryScopeLabel.value)
  const seq = ++runSeq
  aiPhase.value = 'running'
  message.value = null
  let result: AiResult
  try {
    result = await props.state.ai.complete(request)
  } catch (thrown) {
    if (seq !== runSeq || disposed) return
    aiPhase.value = 'failed'
    message.value = `${TEXT.summaryFailed}：${thrown instanceof Error ? thrown.message : String(thrown)}`
    return
  }
  if (seq !== runSeq || disposed) return // 已卸载：在飞结果直接丢弃
  if (result.ok) {
    summaryText.value = result.text
    aiPhase.value = 'done'
    message.value = result.text.replace(/\s/g, '').length === 0 ? TEXT.aiEmptyResult : null
  } else {
    aiPhase.value = 'failed'
    message.value = failureNotice(result.code, result.message)
  }
}
</script>

<template>
  <section class="plot-canvas" data-testid="plot-canvas-panel" :data-tab-id="props.tab.id">
    <header class="plot-canvas__header">
      <h1 class="plot-canvas__title">{{ title }}</h1>
      <p class="plot-canvas__intro">{{ TEXT.intro }}</p>
      <div class="plot-canvas__meta">
        <YfeStatusPill :status="saveStatus" data-testid="plot-canvas-save-status" />
        <span class="plot-canvas__count" data-testid="plot-canvas-node-count">{{ formatNodeCount(nodeCount) }}</span>
      </div>
    </header>

    <p v-if="!hasProject" class="plot-canvas__banner" data-testid="plot-canvas-no-project" role="status">
      {{ TEXT.noProject }}
    </p>
    <p
      v-if="storeError !== null"
      class="plot-canvas__banner plot-canvas__banner--error"
      data-testid="plot-canvas-store-error"
      role="alert"
    >
      {{ storeError }}
    </p>
    <p v-if="message !== null" class="plot-canvas__message" data-testid="plot-canvas-message" role="status">
      {{ message }}
    </p>

    <YfePanel :title="TEXT.listTitle" dense class="plot-canvas__section">
      <div class="plot-canvas__toolbar">
        <label class="plot-canvas__field">
          <span class="plot-canvas__field-label">{{ TEXT.chapterLabel }}</span>
          <select
            v-model="newNodeChapterId"
            class="plot-canvas__select"
            :aria-label="TEXT.chapterLabel"
            data-testid="plot-canvas-new-chapter"
          >
            <option value="">{{ TEXT.unassigned }}</option>
            <option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.label }}</option>
          </select>
        </label>
        <YfeButton
          :label="TEXT.addNode"
          variant="primary"
          data-testid="plot-canvas-add-node"
          @click="onAddNode"
        />
      </div>

      <p v-if="nodes.length === 0" class="plot-canvas__empty" data-testid="plot-canvas-empty" role="status">
        {{ TEXT.emptyNodes }}
      </p>

      <div
        v-for="group in groups"
        :key="group.chapterId ?? '__unassigned__'"
        class="plot-canvas__group"
        data-testid="plot-canvas-group"
      >
        <div class="plot-canvas__group-head">
          <span class="plot-canvas__group-label">{{ group.label }}</span>
          <span class="plot-canvas__group-count">{{ formatNodeCount(group.nodes.length) }}</span>
        </div>
        <article
          v-for="node in group.nodes"
          :key="node.id"
          class="plot-canvas__node"
          :data-node-id="node.id"
          data-testid="plot-canvas-node"
        >
          <div class="plot-canvas__node-row">
            <input
              class="plot-canvas__node-title"
              :value="node.title"
              :placeholder="TEXT.titlePlaceholder"
              :aria-label="TEXT.titleLabel"
              data-testid="plot-canvas-node-title"
              @input="onNodeTitleInput(node, $event)"
            />
            <select
              class="plot-canvas__select"
              :value="node.status"
              :aria-label="TEXT.statusLabel"
              data-testid="plot-canvas-node-status"
              @change="onNodeStatusChange(node, $event)"
            >
              <option v-for="status in NODE_STATUS_ORDER" :key="status" :value="status">
                {{ NODE_STATUS_LABELS[status] }}
              </option>
            </select>
          </div>
          <textarea
            class="plot-canvas__node-summary"
            :value="node.summary"
            :placeholder="TEXT.summaryPlaceholder"
            :aria-label="TEXT.summaryLabel"
            rows="2"
            data-testid="plot-canvas-node-summary"
            @input="onNodeSummaryInput(node, $event)"
          />
          <div class="plot-canvas__node-foot">
            <select
              class="plot-canvas__select"
              :value="node.chapterId ?? ''"
              :aria-label="TEXT.chapterLabel"
              data-testid="plot-canvas-node-chapter"
              @change="onNodeChapterChange(node, $event)"
            >
              <option value="">{{ TEXT.unassigned }}</option>
              <option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.label }}</option>
            </select>
            <YfeButton
              :label="TEXT.removeNode"
              variant="danger"
              data-testid="plot-canvas-remove-node"
              @click="onRemoveNode(node.id)"
            />
          </div>
        </article>
      </div>
    </YfePanel>

    <YfePanel :title="TEXT.canvasTitle" dense class="plot-canvas__section">
      <p class="plot-canvas__preview-note" data-testid="plot-canvas-preview-note">{{ TEXT.previewNote }}</p>
      <p
        v-if="groups.length === 0"
        class="plot-canvas__empty"
        data-testid="plot-canvas-canvas-empty"
        role="status"
      >
        {{ TEXT.emptyNodes }}
      </p>
      <div
        v-for="group in groups"
        :key="group.chapterId ?? '__unassigned__'"
        class="plot-canvas__lane"
        data-testid="plot-canvas-lane"
      >
        <span class="plot-canvas__lane-label">{{ group.label }}</span>
        <div class="plot-canvas__lane-track">
          <span
            v-for="node in group.nodes"
            :key="node.id"
            class="plot-canvas__segment"
            :class="`plot-canvas__fill--${node.status}`"
            :title="node.title === '' ? TEXT.unnamedNode : node.title"
            data-testid="plot-canvas-segment"
          />
        </div>
      </div>
      <div class="plot-canvas__legend" data-testid="plot-canvas-legend">
        <span v-for="status in NODE_STATUS_ORDER" :key="status" class="plot-canvas__legend-item">
          <span class="plot-canvas__legend-dot" :class="`plot-canvas__fill--${status}`" aria-hidden="true" />
          {{ NODE_STATUS_LABELS[status] }}
        </span>
      </div>
    </YfePanel>

    <YfePanel :title="TEXT.aiSectionTitle" dense class="plot-canvas__section">
      <div class="plot-canvas__toolbar">
        <label class="plot-canvas__field">
          <span class="plot-canvas__field-label">{{ TEXT.summaryScopeLabel }}</span>
          <select
            v-model="summaryChapterId"
            class="plot-canvas__select"
            :aria-label="TEXT.summaryScopeLabel"
            data-testid="plot-canvas-summary-chapter"
          >
            <option value="">{{ TEXT.allChapters }}</option>
            <option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">{{ chapter.label }}</option>
          </select>
        </label>
        <YfeButton
          :label="running ? TEXT.aiRunning : TEXT.aiButton"
          variant="primary"
          :loading="running"
          data-testid="plot-canvas-ai-summary"
          @click="onSummarize"
        />
      </div>
      <div v-if="summaryText !== ''" class="plot-canvas__ai-result" data-testid="plot-canvas-ai-result">
        <span class="plot-canvas__ai-result-title">{{ TEXT.aiResultTitle }}</span>
        <p class="plot-canvas__ai-result-body">{{ summaryText }}</p>
      </div>
    </YfePanel>
  </section>
</template>

<style scoped>
.plot-canvas {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  min-height: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.plot-canvas__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.plot-canvas__title {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-lg, 18px);
  line-height: var(--yfe-font-line-height, 1.5);
}

.plot-canvas__intro {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.plot-canvas__meta {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.plot-canvas__count {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.plot-canvas__banner {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #e8b96b);
  border-radius: var(--yfe-radius-md, 8px);
  color: var(--yfe-color-warning, #e8b96b);
}

.plot-canvas__banner--error {
  border-color: var(--yfe-color-danger, #ff7b72);
  color: var(--yfe-color-danger, #ff7b72);
}

.plot-canvas__message {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.plot-canvas__section {
  min-height: 0;
}

.plot-canvas__toolbar {
  display: flex;
  align-items: flex-end;
  gap: var(--yfe-space-md, 12px);
  margin-bottom: var(--yfe-space-sm, 8px);
}

.plot-canvas__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.plot-canvas__field-label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.plot-canvas__select {
  min-width: 9rem;
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface, #1a1d25);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  height: var(--yfe-size-control-height, 32px);
}

.plot-canvas__select:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.plot-canvas__empty {
  margin: 0;
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.plot-canvas__group {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin-bottom: var(--yfe-space-md, 12px);
}

.plot-canvas__group-head {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-sm, 8px);
}

.plot-canvas__group-label {
  color: var(--yfe-color-text, #e6e8ee);
  font-weight: 600;
}

.plot-canvas__group-count {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.plot-canvas__node {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface, #1a1d25);
}

.plot-canvas__node-row {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.plot-canvas__node-title {
  flex: 1;
  min-width: 0;
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  height: var(--yfe-size-control-height, 32px);
}

.plot-canvas__node-title:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.plot-canvas__node-summary {
  box-sizing: border-box;
  width: 100%;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
  resize: vertical;
}

.plot-canvas__node-summary:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.plot-canvas__node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-sm, 8px);
}

.plot-canvas__preview-note {
  margin: 0 0 var(--yfe-space-sm, 8px);
  color: var(--yfe-color-warning, #e8b96b);
}

.plot-canvas__lane {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  margin-bottom: var(--yfe-space-sm, 8px);
}

.plot-canvas__lane-label {
  flex: none;
  min-width: 6rem;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.plot-canvas__lane-track {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-xs, 4px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-background, #111318);
}

.plot-canvas__segment {
  width: 28px;
  height: 14px;
  border-radius: var(--yfe-radius-sm, 4px);
}

.plot-canvas__fill--todo {
  background: var(--yfe-color-surface-raised, #20242e);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4152);
}

.plot-canvas__fill--draft {
  background: var(--yfe-color-warning, #e8b96b);
}

.plot-canvas__fill--done {
  background: var(--yfe-color-success, #5ddc9a);
}

.plot-canvas__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-md, 12px);
}

.plot-canvas__legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.plot-canvas__legend-dot {
  width: var(--yfe-size-status-dot, 8px);
  height: var(--yfe-size-status-dot, 8px);
  border-radius: var(--yfe-radius-pill, 999px);
}

.plot-canvas__ai-result {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 8px);
  background: var(--yfe-color-surface-raised, #20242e);
}

.plot-canvas__ai-result-title {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.plot-canvas__ai-result-body {
  margin: 0;
  white-space: pre-wrap;
}
</style>
