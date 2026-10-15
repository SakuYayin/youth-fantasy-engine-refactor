<script setup lang="ts">
/**
 * 写作页外壳（预览版）：章节树 + 正文编辑器 + 保存状态。
 *
 * 三条纪律：
 * 1. 组件**不 import `node:`、不直连 SQLite、不自己拼 IPC 方法名**（ADR 0006 / D6）；
 *    一切数据经 `AppState.state`（以 prop 注入，方便测试塞假实现）。
 * 2. 正文只有一条通路：编辑器 `onChange` → `state.edit()`；反向只有两条：
 *    切章（documentId 变化）与"采用外部版本"。**不双向绑定 body**，
 *    否则每次键入都会重设编辑器、吃掉输入法组合态。
 * 3. 保存状态由 `state` 推导，组件不做任何"保存成功/失败"的本地判断。
 */

import type { VisCtx } from '@yfe/schema-tabs'
import { YfeButton, YfeDialog, YfePanel, YfeStatusPill, YfeToolbar, YfeTree } from '@yfe/ui'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import type { AppSnapshot, AppState } from './app-state.js'
import { createCodeMirrorAdapter, type CodeMirrorAdapter } from './editor/codemirror-adapter.js'
import type { EntityRow } from './schema/entity-row.js'
import {
  TabCardView,
  TabFormView,
  TabSidebar,
  TabTableView,
  defaultTabId,
  findTab,
  nextRowName,
  sidebarGroups,
} from './schema/index.js'

const props = defineProps<{ state: AppState }>()

const snapshot = shallowRef<AppSnapshot>(props.state.getSnapshot())
const editorHost = ref<HTMLElement | null>(null)
const newProjectName = ref('')

/**
 * 可见性上下文：预览版先按**完整模板**渲染（`type:'full'` 时 `tabVisible` 恒 true，
 * 与旧版默认的全功能侧栏一致）。M2 的「自定义功能开关」只需把这里换成项目里的 features。
 */
const visCtx: VisCtx = { type: 'full', features: [] }
const tabGroups = sidebarGroups(visCtx)
const activeTabId = ref<string | null>(defaultTabId(visCtx))

const activeTab = computed(() => (activeTabId.value === null ? null : findTab(activeTabId.value) ?? null))
const isEditorTab = computed(() => activeTab.value === null || activeTab.value.type === 'editor')

/** 设定实体行：`app-state` 的 `SettingsEntityView` 是渲染器 `EntityRow` 的超集（见 `schema/entity-row.ts`）。 */
const entityRows = computed<readonly EntityRow[]>(() => snapshot.value.settingsEntities)
const settingsBusy = computed(() => snapshot.value.settingsLoading)

/** 组件层还没有的能力（删除 / 重排）在这里给作者一句明确回执，而不是让按钮静默失效。 */
const notice = ref('')

/**
 * 新建表单会话键：同一次「新建」重复点保存时复用同一个幂等键
 * （幂等键按请求去重，所以双击不会建出两条设定）；成功后再换一个。
 */
let createKey: string | null = null
function currentCreateKey(tabId: string): string {
  if (createKey === null) createKey = `entity:${tabId}:${Date.now().toString(36)}`
  return createKey
}

let adapter: CodeMirrorAdapter | null = null
let stopState: (() => void) | null = null
let stopEditor: (() => void) | null = null
let appliedDocumentId: string | null = null
let appliedReadOnly = true

const conflictOpen = computed(() => snapshot.value.conflict !== null)

/** 只在"切换了章节"时把正文灌进编辑器；同章节的键入回流一律忽略。 */
function applySnapshotToEditor(): void {
  if (adapter === null) return
  const current = snapshot.value
  const readOnly = current.readOnly || current.loading
  if (current.selectedDocumentId === null) {
    adapter.open({ documentId: '', body: '', readOnly: true })
    appliedDocumentId = null
    appliedReadOnly = true
    return
  }
  if (current.selectedDocumentId === appliedDocumentId && adapter.getBody() === current.body) {
    if (appliedReadOnly !== readOnly) adapter.setReadOnly(readOnly)
    appliedReadOnly = readOnly
    return
  }
  adapter.open({
    documentId: current.selectedDocumentId,
    body: current.body,
    readOnly,
  })
  appliedDocumentId = current.selectedDocumentId
  appliedReadOnly = readOnly
}

onMounted(async () => {
  stopState = props.state.subscribe((next) => {
    snapshot.value = next
    applySnapshotToEditor()
  })

  if (editorHost.value !== null) {
    adapter = createCodeMirrorAdapter(editorHost.value, {
      lineNumbers: true,
      commandKeys: { 'yfe.draft.flush': 'Mod-s' },
    })
    // 命令面板将来从命令注册表取；现在先把"保存"这条接到同一刷新语义上。
    adapter.registerCommand('yfe.draft.flush', () => {
      void props.state.flush()
      return true
    })
    stopEditor = adapter.onChange((body) => {
      props.state.edit(body)
    })
    props.state.setNavigationGuard(() => adapter?.isComposing !== true)
  }

  await props.state.start()
  applySnapshotToEditor()
  await loadActiveTab()
})

onBeforeUnmount(() => {
  props.state.setNavigationGuard(null)
  stopEditor?.()
  stopState?.()
  adapter?.dispose()
  adapter = null
})

async function onCreateProject(): Promise<void> {
  const name = newProjectName.value.trim()
  if (name === '') return
  const created = await props.state.createProject(name)
  if (created) newProjectName.value = ''
}

async function onCreateChapter(): Promise<void> {
  const chapters = snapshot.value.tree.filter((node) => node.kind === 'chapter').length
  await props.state.createChapter(`第 ${chapters + 1} 章`)
}

async function onSelect(documentId: string): Promise<void> {
  await props.state.selectDocument(documentId)
}

function onToggle(documentId: string): void {
  props.state.toggleExpanded(documentId)
}

/** 载入当前页签的数据（编辑器页签不碰设定实体：写正文与读设定互不阻塞）。 */
async function loadActiveTab(): Promise<void> {
  const tab = activeTab.value
  notice.value = ''
  if (tab === null || tab.type === 'editor') return
  await props.state.loadSettingsEntities({ schemaTemplateId: tab.id })
  const first = snapshot.value.settingsEntities[0]
  if (snapshot.value.selectedSettingsEntityId === null && first !== undefined) {
    await props.state.selectSettingsEntity(first.id)
  }
}

async function onSelectTab(tabId: string): Promise<void> {
  if (tabId === activeTabId.value) return
  activeTabId.value = tabId
  await loadActiveTab()
}

async function onSelectEntity(entityId: string): Promise<void> {
  await props.state.selectSettingsEntity(entityId)
}

/**
 * 三种渲染器共用的提交路径。
 *
 * `values` 一律是**整份**：契约把 `values` 定成必填并整体替换，组件也把未展示的
 * `hidden` 列一起带回来（只发单键补丁会把作者其它字段抹掉）。
 */
async function submitValues(values: Record<string, unknown>, entityId?: string): Promise<void> {
  const tab = activeTab.value
  if (tab === null || tab.type === 'editor') return
  const current =
    entityId === undefined
      ? snapshot.value.selectedSettingsEntity
      : (snapshot.value.settingsEntities.find((row) => row.id === entityId) ?? null)
  if (entityId !== undefined && current === null) {
    notice.value = '这一行已经不在列表里了，请切换页签刷新后重试。'
    return
  }
  const creating = current === null
  const result = await props.state.submitSettingsEntity({
    entityId: creating ? null : current.id,
    schemaTemplateId: tab.id,
    name: creating ? nextRowName(tab, entityRows.value) : current.name,
    values,
    expectedRevision: creating ? null : current.revision,
    idempotencyKey: creating ? currentCreateKey(tab.id) : undefined,
  })
  if (!result.ok) {
    notice.value = `${result.code}：${result.message}`
    return
  }
  createKey = null
  await loadActiveTab()
  await props.state.selectSettingsEntity(result.entityId)
}

function onCreateEntity(values: Record<string, unknown> = {}): void {
  void submitValues(values)
}

function onUpdateEntity(entityId: string, values: Record<string, unknown>): void {
  void submitValues(values, entityId)
}

/** 删除 / 重排：应用层还没有对应用例（`P1-B6` 仓储删除通道、显式 orderKey 生成策略），先明确回执。 */
function onDeleteEntity(entityId: string): void {
  notice.value = `删除设定实体还没接入（P1-B6）：${entityId} 保持原样。`
}

function onReorderEntity(entityId: string, beforeId: string | null): void {
  notice.value = `重排还没接入：${entityId} → ${beforeId ?? '末尾'}（需要应用层生成 orderKey）。`
}

function onKeepLocal(): void {
  props.state.resolveConflict('keep-local')
}

function onTakeExternal(): void {
  props.state.resolveConflict('take-external')
  // 只有这条路径会换掉正文（外部版本胜出），所以显式重灌一次编辑器。
  appliedDocumentId = null
  applySnapshotToEditor()
}
</script>

<template>
  <div class="app">
    <header class="app__bar">
      <h1 class="app__title">{{ snapshot.title === '' ? '青春幻想引擎 · 预览版' : snapshot.title }}</h1>
      <YfeStatusPill :status="snapshot.saveStatus" :detail="snapshot.saveDetail ?? undefined" />
      <span v-if="snapshot.pendingOutboxCount > 0" class="app__badge">待同步 {{ snapshot.pendingOutboxCount }}</span>
      <span class="app__spacer" />
      <span class="app__meta">{{ snapshot.appVersion ?? '' }}</span>
      <span v-if="snapshot.readOnly" class="app__meta">只读</span>
    </header>

    <div class="app__body">
      <aside class="app__side">
        <TabSidebar
          :groups="tabGroups"
          :active-id="activeTabId"
          :disabled="snapshot.loading"
          @select="onSelectTab"
        />
        <YfePanel title="章节" dense>
          <template v-if="snapshot.projectId === null">
            <p class="app__hint">还没有作品。新建一个就能开始写作。</p>
            <input
              v-model="newProjectName"
              class="app__input"
              type="text"
              placeholder="作品名"
              @keyup.enter="onCreateProject"
            />
            <YfeButton label="新建作品" :disabled="snapshot.loading" @click="onCreateProject" />
          </template>
          <template v-else>
            <YfeToolbar>
              <YfeButton label="新建章节" variant="ghost" :disabled="snapshot.loading || snapshot.readOnly" @click="onCreateChapter" />
            </YfeToolbar>
            <YfeTree
              :nodes="snapshot.tree"
              :selected-id="snapshot.selectedDocumentId"
              :expanded-ids="snapshot.expandedIds"
              @select="onSelect"
              @toggle="onToggle"
            />
            <p v-if="snapshot.tree.length === 0" class="app__hint">这部作品还没有章节。</p>
          </template>
        </YfePanel>
      </aside>

      <main class="app__main">
        <!-- 编辑器宿主必须常驻（`v-show` 不卸载）：切到设定页签再切回来时 CodeMirror 实例还在。 -->
        <div v-show="isEditorTab" ref="editorHost" class="app__editor" />

        <template v-if="!isEditorTab">
          <div class="app__tabhead">
            <h2 class="app__tabtitle">{{ activeTab?.name ?? '' }}</h2>
            <span v-if="activeTab?.description" class="app__meta">{{ activeTab.description }}</span>
            <span class="app__spacer" />
            <YfeButton label="刷新" variant="ghost" :disabled="settingsBusy" @click="loadActiveTab" />
          </div>
          <div class="app__tabbody">
            <TabFormView
              v-if="activeTab !== null && activeTab.type === 'form'"
              :tab="activeTab"
              :value="snapshot.selectedSettingsEntity?.values ?? {}"
              :readonly="snapshot.readOnly"
              :busy="settingsBusy"
              @save="onCreateEntity"
            />
            <TabTableView
              v-else-if="activeTab !== null && activeTab.type === 'table'"
              :tab="activeTab"
              :rows="entityRows"
              :readonly="snapshot.readOnly"
              :busy="settingsBusy"
              @create="onCreateEntity"
              @update="onUpdateEntity"
              @delete="onDeleteEntity"
              @reorder="onReorderEntity"
            />
            <TabCardView
              v-else-if="activeTab !== null && activeTab.type === 'card'"
              :tab="activeTab"
              :cards="entityRows"
              :selected-id="snapshot.selectedSettingsEntityId"
              :readonly="snapshot.readOnly"
              :busy="settingsBusy"
              @select="onSelectEntity"
              @create="onCreateEntity"
              @update="onUpdateEntity"
              @delete="onDeleteEntity"
            />
            <p v-else class="app__hint">
              「{{ activeTab?.name ?? '' }}」是专属面板，还没有实现（W7 逐个落地）。
            </p>
          </div>
        </template>

        <footer class="app__footer">
          <span v-if="notice !== ''" class="app__error">{{ notice }}</span>
          <span class="app__meta">{{ snapshot.charCount }} 字</span>
          <span v-if="snapshot.selectedDocumentId === null" class="app__hint">左侧选择一章开始写作。</span>
          <span v-if="snapshot.databasePath !== null" class="app__meta app__path">{{ snapshot.databasePath }}</span>
          <span v-if="snapshot.lastError !== null" class="app__error">
            {{ snapshot.lastError.code }}：{{ snapshot.lastError.message }}
          </span>
        </footer>
      </main>
    </div>

    <YfeDialog
      :open="conflictOpen"
      title="发现外部修改"
      confirm-label="保留我的版本"
      cancel-label="采用外部版本"
      tone="normal"
      @confirm="onKeepLocal"
      @cancel="onTakeExternal"
    >
      <p>
        这一章在别处被改过（外部版本 {{ snapshot.conflict?.externalRevision ?? '未知' }}）。
        两份都保留，请选择以哪一份为准；另一份会记录在冲突视图里。
      </p>
    </YfeDialog>
  </div>
</template>

<style scoped>
/* 颜色全部走 @yfe/ui 的设计令牌，并给字面量兜底：令牌改名不会让界面变成白底黑字。 */
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  margin: 0;
  background: var(--yfe-color-bg, #111318);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-ui, system-ui, 'Microsoft YaHei', sans-serif);
}

.app__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--yfe-color-border, #262a33);
}

.app__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.app__badge {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--yfe-color-warning-bg, #3a2f14);
  color: var(--yfe-color-warning, #e8c468);
  font-size: 12px;
}

.app__spacer {
  flex: 1;
}

.app__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app__side {
  width: 260px;
  min-width: 200px;
  overflow: auto;
  border-right: 1px solid var(--yfe-color-border, #262a33);
  padding: 8px;
}

.app__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

/* 设定页签的页头：页签名 + 说明 + 刷新。 */
.app__tabhead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--yfe-color-border, #262a33);
}

.app__tabtitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.app__tabbody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px;
}

.app__editor {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 12px;
}

.app__footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-top: 1px solid var(--yfe-color-border, #262a33);
  font-size: 12px;
}

.app__path {
  overflow: hidden;
  max-width: 45ch;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}

.app__error {
  color: var(--yfe-color-danger, #f08a8a);
}

.app__hint {
  margin: 8px 0;
  color: var(--yfe-color-text-dim, #9aa0ad);
  font-size: 12px;
}

.app__input {
  width: 100%;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--yfe-color-border, #262a33);
  border-radius: 6px;
  background: var(--yfe-color-surface, #16181d);
  color: inherit;
  font: inherit;
}
</style>
