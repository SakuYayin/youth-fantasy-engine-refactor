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

import type { AppSettingsView, FeaturePorts } from './features/types.js'
import { clampSidebarWidth, SIDEBAR_WIDTH } from './features/settings-store.js'
import { CUSTOM_THEME_ID, type ThemeOption } from './features/settings-panel-model.js'
import BackupManager from './features/backup-manager.vue'
import ProjectHub from './features/project-hub.vue'
import SettingsPanel from './features/settings-panel.vue'
import WelcomeWizard from './features/welcome-wizard.vue'
import { applyThemeAttribute, applyThemeVariables, isConcreteThemeId, themeCssVariablesById, type ThemeHost } from './theme/variables.js'
import { DEFAULT_THEME_ID, THEME_PALETTES } from './theme/palettes.js'
import { applyZoom, type ZoomHost } from './theme/zoom.js'
import type { AppSnapshot, AppState } from './app-state.js'
import { createCodeMirrorAdapter, type CodeMirrorAdapter } from './editor/codemirror-adapter.js'
import type { EntityRow } from './schema/entity-row.js'
import { resolvePanelComponent } from './panels/registry.js'
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

/**
 * `ports` 可选：缺省时不渲染作品中心/备份/设置/向导四个外壳功能，
 * 只保留写作页 —— 既有的组件测试夹具（15 个面板 + app-view）全部不用改。
 */
const props = defineProps<{ state: AppState; ports?: FeaturePorts }>()

const snapshot = shallowRef<AppSnapshot>(props.state.getSnapshot())
const editorHost = ref<HTMLElement | null>(null)
const newProjectName = ref('')

/**
 * 外壳当前显示哪一屏。
 *
 * - `editor`：章节树 + 正文/设定页签（主界面）
 * - `hub`/`backups`/`settings`：从顶栏进入的全屏功能屏
 * - `welcome`：仅首启显示的三选一向导
 */
type ShellView = 'editor' | 'hub' | 'backups' | 'settings' | 'welcome'
const view = ref<ShellView>('editor')

/** 设置视图：主题/缩放/字体/侧栏宽度的唯一真相源（由 `settings` 端口读写）。 */
const settings = shallowRef<AppSettingsView | null>(null)

/** 主题单选选项：从主题表生成，末尾追加禁用的「自定义」（旧版有、本版未实现，见 R-80）。 */
const themeOptions = computed<readonly ThemeOption[]>(() => [
  ...THEME_PALETTES.map((palette) => ({
    id: palette.id,
    name: palette.name,
    desc: palette.desc,
    swatch: palette.swatch,
  })),
  { id: CUSTOM_THEME_ID, name: '自定义', desc: '母版派生 · 可调色', swatch: 'conic-gradient(#e88, #8c8)' },
])

/** 侧栏宽度由设置驱动；未加载设置时用设计缺省值。 */
const sidebarWidth = computed(() => clampSidebarWidth(settings.value?.sidebarWidth ?? SIDEBAR_WIDTH.initial))

/**
 * 已写到根节点的主题变量名。
 *
 * `applyThemeVariables` 需要"上一次写了哪些变量"才能在换肤时清掉不再存在的键
 * （否则上一套主题的 `--yfe-ink-*` 会残留，浅色主题会读出深色描边）。
 */
let appliedThemeVariables: readonly string[] = []

/**
 * 把一套设置落到根节点上。
 *
 * 三件事必须一起做，缺一样界面就会"看起来没生效"：
 * 1. 写 `--yfe-*` 变量（含 19 条旧别名 —— 本文件 126 行 scoped 样式仍在用旧名）；
 * 2. 写 `dataset.theme`（给将来按主题分支的样式留钩子，也是旧版的既有约定）；
 * 3. 写 `style.zoom` + `--ui-zoom`（缩放不能用 `font-size` 代替，中文字号会跳级）。
 */
function applySettings(next: AppSettingsView): void {
  settings.value = next
  const root = document.documentElement as unknown as ThemeHost & ZoomHost
  appliedThemeVariables = applyThemeVariables(
    root,
    themeCssVariablesById(next.themeId),
    appliedThemeVariables,
  )
  if (isConcreteThemeId(next.themeId)) applyThemeAttribute(root, next.themeId)
  applyZoom(root, next.zoomPercent)
}

/**
 * 正文/界面字体：**没有独立 CSS 文件可改**（渲染层只有 `index.html` 里那行内联样式，
 * CSP 是 `style-src 'self' 'unsafe-inline'`，不允许外链样式表），所以字体只能
 * 靠根节点变量 + 编辑器容器内联样式驱动。
 */
const editorStyle = computed(() => {
  const current = settings.value
  if (current === null) return {}
  const family = current.fontFamily
  return {
    fontFamily: family === null ? undefined : family,
    fontSize: current.fontSize,
  }
})

/** 向导是否显示：只在「端口可用 + 用户没说过不再显示」时进 welcome 屏。 */
function decideInitialView(): ShellView {
  if (props.ports === undefined) return 'editor'
  try {
    return props.ports.welcome.seen() ? 'editor' : 'welcome'
  } catch {
    // 端口理论上不抛（§0.2），真抛了不能白屏：直接进主界面。
    return 'editor'
  }
}

function loadSettings(): void {
  if (props.ports === undefined) return
  try {
    applySettings(props.ports.settings.load())
  } catch {
    // 读设置失败不拦开工：界面用样式里的字面量兜底色。
  }
}

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
// 专属面板分派：registry 未登记的 id 回落占位组件（W7 逐个接入）。
const activePanel = computed(() =>
  activeTab.value === null || isEditorTab.value ? null : resolvePanelComponent(activeTab.value.id),
)

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
  loadSettings()
  view.value = decideInitialView()

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

/* ------------------------------------------------------------------ *
 * 外壳导航：作品中心 / 备份恢复 / 设置 / 欢迎向导
 *
 * 四个功能屏都是"整屏替换"，不做路由库 —— 预览版只有一屏主界面，
 * 引 vue-router 换来的只是多一份依赖与一个需要同步的 URL 状态。
 * ------------------------------------------------------------------ */

function openHub(): void {
  view.value = 'hub'
}

function openBackups(): void {
  view.value = 'backups'
}

function openSettings(): void {
  loadSettings()
  view.value = 'settings'
}

function backToEditor(): void {
  view.value = 'editor'
}

/**
 * 设置面板每次改动都会 `emit('change', view)`（失败路径也发，见该组件注释），
 * 所以这里必须**无条件按返回值重放**：面板显示的是它自己那份视图，
 * 外壳的主题/缩放/字体要跟着走，否则改了字号只有面板知道。
 */
function onSettingsChange(next: AppSettingsView): void {
  applySettings(next)
}

/**
 * 向导收尾。
 *
 * - `projectId === null`：用户选了「新建作品」或「直接开始」，回写作页空态；
 *   `WelcomePort.done` 只带回 `projectId`，**没有**「走的是哪条路」字段，端子区分不了
 *   ① 与 ③，故与上游 `WelcomeWizard.finish(null)` 同款处理，不擅自代用户打开作品中心。
 * - 有 `projectId`：示范项目已建好，直接打开它（`state.openProject`）。
 */
async function onWelcomeDone(payload: { projectId: string | null }): Promise<void> {
  if (payload.projectId === null) {
    view.value = 'editor'
    return
  }
  const opened = await props.state.openProject(payload.projectId)
  view.value = 'editor'
  if (!opened) notice.value = '示范项目已创建，但打开失败；请到作品中心手动打开。'
}

/** 作品中心「打开」成功后的收尾：回主界面并重载当前页签数据。 */
async function onHubOpened(): Promise<void> {
  view.value = 'editor'
  await loadActiveTab()
  applySnapshotToEditor()
}

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
      <!-- 外壳导航：只在注入了 ports 时出现（组件测试不传 ports，顶栏保持原样）。 -->
      <YfeToolbar v-if="ports !== undefined">
        <YfeButton
          v-if="view !== 'editor'"
          label="返回写作"
          variant="ghost"
          @click="backToEditor"
        />
        <YfeButton label="作品中心" variant="ghost" @click="openHub" />
        <YfeButton label="备份与恢复" variant="ghost" @click="openBackups" />
        <YfeButton label="设置" variant="ghost" @click="openSettings" />
      </YfeToolbar>
      <span class="app__meta">{{ snapshot.appVersion ?? '' }}</span>
      <span v-if="snapshot.readOnly" class="app__meta">只读</span>
    </header>

    <!--
      写作页用 `v-show` 而不是 `v-if`：编辑器宿主一旦卸载，CodeMirror 实例就没了，
      从设置/作品中心切回来会得到一个空白的正文区（`adapter` 变量还指着旧 DOM）。
    -->
    <div v-show="view === 'editor'" class="app__body">
      <aside class="app__side" :style="{ width: `${sidebarWidth}px` }">
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
        <div v-show="isEditorTab" ref="editorHost" class="app__editor" :style="editorStyle" />

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
            <component
              :is="activePanel"
              v-else-if="activeTab !== null"
              :state="state"
              :tab="activeTab"
            />
            <p v-else class="app__hint">
              尚未选择任何页签。
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

    <!--
      四个外壳功能屏用 `v-if`：它们没有需要保住的原生实例（不像 CodeMirror），
      每次进入都重新挂载反而更干净 —— 备份列表/作品列表是磁盘状态，
      留着上一次的 DOM 只会显示过期数据。
    -->
    <main v-if="ports !== undefined && view === 'hub'" class="app__screen">
      <ProjectHub
        :hub="ports.hub"
        @open="onHubOpened"
        @backups="openBackups"
        @close="backToEditor"
      />
    </main>

    <main v-else-if="ports !== undefined && view === 'backups'" class="app__screen">
      <BackupManager :backup="ports.backup" @close="backToEditor" />
    </main>

    <main v-else-if="ports !== undefined && view === 'settings'" class="app__screen">
      <SettingsPanel
        :settings="ports.settings"
        :themes="themeOptions"
        @change="onSettingsChange"
        @close="backToEditor"
      />
    </main>

    <main v-else-if="ports !== undefined && view === 'welcome'" class="app__screen">
      <WelcomeWizard :welcome="ports.welcome" @done="onWelcomeDone" @close="backToEditor" />
    </main>

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

/**
 * 全屏功能屏（作品中心 / 备份 / 设置 / 向导）的宿主。
 *
 * 四个屏都自带标题栏与滚动容器，这里只负责"占满写作区剩下的高度"，
 * 不再加 padding —— 否则它们自带的内边距会变成双层。
 */
.app__screen {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--yfe-color-bg, #111318);
  color: var(--yfe-color-text, #e6e8ee);
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
