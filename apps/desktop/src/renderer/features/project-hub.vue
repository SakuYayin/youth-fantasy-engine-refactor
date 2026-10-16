<script setup lang="ts">
/**
 * 作品中心（旧版 `ProjectHub.tsx` 的 Vue 还原）—— W8-A。
 *
 * 契约：`docs/接口冻结-W8外壳.md` §1.1（props/emits 逐字）。
 * 铁律：只依赖 `props.hub` 端口；不 import `node:` / `@yfe/contracts` / `window.yfe`；
 * 不读写 localStorage；文案全中文；样式只走 `--yfe-*`（每个都带字面量兜底）。
 *
 * 状态机（为什么不是一堆 `v-if` 散在模板里）：
 *   loading > list > error > empty
 * 「加载中」和「空态」互斥 —— 首屏若先闪一下「还没有作品」，用户会以为书全丢了。
 * 判定写在 `project-hub-model.ts` 的 `resolveProjectHubViewState()`，单测钉住。
 *
 * 失败处理：端口的每个异步结果都判 `result.ok`。快照上的 `lastError`（端口给的）与
 * 本组件的 `actionError`（端口返回值兜底）合成一块通知条，**message 一定露出来**，
 * 永远不静默吞掉；`code` 挂在 `title` 上，不替代 message。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { YfeButton, YfeDialog } from '@yfe/ui'
import type { ProjectCreateRequest, ProjectHubSnapshot, ProjectHubStore, ProjectSummaryView } from './types.js'
import {
  PROJECT_HUB_TEXT,
  PROJECT_TYPE_OPTIONS,
  buildProjectCreateRequest,
  deleteConfirmMessage,
  groupProjectsByType,
  projectCountLine,
  projectMetaLine,
  projectSummaryText,
  resolveProjectHubViewState,
  validateProjectName,
  type ProjectType,
} from './project-hub-model.js'

const props = defineProps<{ hub: ProjectHubStore }>()
const emit = defineEmits<{ open: []; backups: []; close: [] }>()

/** 取初值：整块里只调一次 `hub.getSnapshot()`（挂载前的首帧也要有数据，不能白屏）。 */
const snapshot = ref<ProjectHubSnapshot>(props.hub.getSnapshot())

/** 端口返回值里的失败文案（`lastError` 之外的第二道兜底）。 */
const actionError = ref<{ readonly code: string; readonly message: string } | null>(null)

/** 正在跑写操作（新建/改名/删除）；同一时刻只允许一笔。 */
const busy = ref(false)

// —— 新建表单 ——
const formOpen = ref(false)
const formName = ref('')
const formSummary = ref('')
const formType = ref<ProjectType>('full')
const nameError = ref<string | null>(null)

// —— 行内改名 ——
const editingId = ref<string | null>(null)
const editName = ref('')
const editError = ref<string | null>(null)

// —— 删除确认 ——
const pendingDelete = ref<ProjectSummaryView | null>(null)

let unsubscribe: (() => void) | null = null

const viewState = computed(() => resolveProjectHubViewState(snapshot.value))
const groups = computed(() => groupProjectsByType(snapshot.value.projects))
const countLine = computed(() => projectCountLine(snapshot.value.projects.length))

/** 错误通知条：端口快照的 `lastError` + 本组件的 `actionError`，同一条文案只显示一次。 */
const notices = computed<readonly { readonly code: string; readonly message: string }[]>(() => {
  const list: { readonly code: string; readonly message: string }[] = []
  const lastError = snapshot.value.lastError
  if (lastError !== null && lastError.message.trim() !== '') list.push(lastError)
  const action = actionError.value
  if (action !== null && action.message.trim() !== '' && !list.some((item) => item.message === action.message)) {
    list.push(action)
  }
  return list
})

const deleteMessage = computed(() =>
  pendingDelete.value === null ? '' : deleteConfirmMessage(pendingDelete.value.name),
)

const createTypeOptions = computed(() =>
  PROJECT_TYPE_OPTIONS.map((option) => ({
    ...option,
    inputId: `project-hub-type-${option.value}`,
  })),
)

function fail(result: { readonly ok: false; readonly code: string; readonly message: string }): void {
  actionError.value = { code: result.code, message: result.message }
}

/** 端口写操作成功后立刻复读列表：界面上的事实来自端口，不自己拼一条乐观数据。 */
async function refresh(): Promise<void> {
  const result = await props.hub.refresh()
  if (!result.ok) fail(result)
}

// —— 新建 ——
function toggleCreateForm(): void {
  if (formOpen.value) {
    cancelCreate()
    return
  }
  formOpen.value = true
  nameError.value = null
}

function cancelCreate(): void {
  formOpen.value = false
  formName.value = ''
  formSummary.value = ''
  formType.value = 'full'
  nameError.value = null
}

async function submitCreate(): Promise<void> {
  if (busy.value) return
  const problem = validateProjectName(formName.value)
  nameError.value = problem
  // 空名在**发请求之前**拦下：一次注定失败的写操作不该在界面上留下一条错误。
  if (problem !== null) return
  busy.value = true
  actionError.value = null
  try {
    const request: ProjectCreateRequest = buildProjectCreateRequest({
      name: formName.value,
      summary: formSummary.value,
      projectType: formType.value,
    })
    const result = await props.hub.create(request)
    if (!result.ok) {
      fail(result)
      return
    }
    cancelCreate()
    await refresh()
  } finally {
    busy.value = false
  }
}

// —— 打开 / 备份 ——
async function openProject(project: ProjectSummaryView): Promise<void> {
  actionError.value = null
  const result = await props.hub.open(project.id)
  if (!result.ok) {
    fail(result)
    return
  }
  // 打开由本组件负责；切到编辑器是外壳的事（契约 §1.1：事件只做通知）。
  emit('open')
}

function requestBackups(): void {
  emit('backups')
}

// —— 行内改名 ——
function beginEdit(project: ProjectSummaryView): void {
  editingId.value = project.id
  editName.value = project.name
  editError.value = null
  actionError.value = null
}

function cancelEdit(): void {
  editingId.value = null
  editName.value = ''
  editError.value = null
}

async function submitEdit(): Promise<void> {
  const id = editingId.value
  if (id === null || busy.value) return
  const problem = validateProjectName(editName.value)
  editError.value = problem
  if (problem !== null) return
  busy.value = true
  actionError.value = null
  try {
    const result = await props.hub.rename(id, editName.value.trim())
    if (!result.ok) {
      editError.value = result.message
      return
    }
    cancelEdit()
    await refresh()
  } finally {
    busy.value = false
  }
}

// —— 删除（先确认，再落库）——
function requestDelete(project: ProjectSummaryView): void {
  pendingDelete.value = project
}

function cancelDelete(): void {
  pendingDelete.value = null
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (target === null || busy.value) return
  pendingDelete.value = null
  busy.value = true
  actionError.value = null
  try {
    const result = await props.hub.remove(target.id)
    if (!result.ok) {
      fail(result)
      return
    }
    await refresh()
  } finally {
    busy.value = false
  }
}

// —— 重试 ——
async function retry(): Promise<void> {
  actionError.value = null
  await refresh()
}

function dispose(): void {
  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }
}

onMounted(() => {
  unsubscribe = props.hub.subscribe((next) => {
    snapshot.value = next
  })
  void refresh()
})

onUnmounted(dispose)
</script>

<template>
  <section class="project-hub" data-testid="project-hub">
    <header class="project-hub__head">
      <div class="project-hub__heading">
        <h1 class="project-hub__title">{{ PROJECT_HUB_TEXT.panelTitle }}</h1>
        <p class="project-hub__intro">{{ PROJECT_HUB_TEXT.panelIntro }}</p>
        <p class="project-hub__count" data-testid="project-hub-count">{{ countLine }}</p>
      </div>
      <div class="project-hub__actions">
        <YfeButton
          variant="ghost"
          :label="PROJECT_HUB_TEXT.backToEditor"
          data-testid="project-hub-close"
          @click="emit('close')"
        />
        <YfeButton
          variant="primary"
          :label="PROJECT_HUB_TEXT.newProject"
          data-testid="project-hub-new"
          @click="toggleCreateForm"
        />
      </div>
    </header>

    <!-- 新建表单 -->
    <form
      v-if="formOpen"
      class="project-hub__form"
      data-testid="project-hub-create-form"
      @submit.prevent="submitCreate"
    >
      <h2 class="project-hub__form-title">{{ PROJECT_HUB_TEXT.createTitle }}</h2>

      <div class="project-hub__field">
        <label class="project-hub__label" for="project-hub-name">{{ PROJECT_HUB_TEXT.nameLabel }}</label>
        <input
          id="project-hub-name"
          v-model="formName"
          class="project-hub__input"
          type="text"
          autocomplete="off"
          :placeholder="PROJECT_HUB_TEXT.namePlaceholder"
          data-testid="project-hub-name-input"
        />
        <p
          v-if="nameError !== null"
          class="project-hub__field-error"
          data-testid="project-hub-name-error"
        >
          {{ nameError }}
        </p>
      </div>

      <fieldset class="project-hub__field project-hub__fieldset">
        <legend class="project-hub__label">{{ PROJECT_HUB_TEXT.typeLabel }}</legend>
        <label
          v-for="option in createTypeOptions"
          :key="option.value"
          class="project-hub__option"
          :for="option.inputId"
        >
          <input
            :id="option.inputId"
            v-model="formType"
            type="radio"
            name="project-hub-type"
            :value="option.value"
            :data-testid="`project-hub-type-${option.value}`"
          />
          <span class="project-hub__option-body">
            <span class="project-hub__option-label">{{ option.label }}</span>
            <span class="project-hub__option-desc">{{ option.desc }}</span>
          </span>
        </label>
      </fieldset>

      <div class="project-hub__field">
        <label class="project-hub__label" for="project-hub-summary">
          {{ PROJECT_HUB_TEXT.summaryLabel }}
        </label>
        <textarea
          id="project-hub-summary"
          v-model="formSummary"
          class="project-hub__input project-hub__textarea"
          rows="2"
          :placeholder="PROJECT_HUB_TEXT.summaryPlaceholder"
          data-testid="project-hub-summary-input"
        />
      </div>

      <div class="project-hub__form-actions">
        <YfeButton
          variant="primary"
          :label="PROJECT_HUB_TEXT.createSubmit"
          :disabled="busy"
          data-testid="project-hub-create-submit"
          @click="submitCreate"
        />
        <YfeButton
          variant="ghost"
          :label="PROJECT_HUB_TEXT.cancel"
          :disabled="busy"
          data-testid="project-hub-create-cancel"
          @click="cancelCreate"
        />
      </div>
    </form>

    <!-- 失败通知条：端口的 lastError 与动作失败都在这里露出 message + 重试 -->
    <div v-if="notices.length > 0" class="project-hub__notice" data-testid="project-hub-error">
      <p
        v-for="notice in notices"
        :key="notice.code + notice.message"
        class="project-hub__notice-message"
        :title="notice.code"
        data-testid="project-hub-error-message"
      >
        {{ notice.message }}
      </p>
      <YfeButton
        variant="ghost"
        :label="PROJECT_HUB_TEXT.retry"
        :disabled="snapshot.loading"
        data-testid="project-hub-retry"
        @click="retry"
      />
    </div>

    <!-- 主体：loading 与 empty 互斥 -->
    <div v-if="viewState === 'loading'" class="project-hub__loading" data-testid="project-hub-loading">
      {{ PROJECT_HUB_TEXT.loading }}
    </div>

    <div v-else-if="viewState === 'empty'" class="project-hub__empty" data-testid="project-hub-empty">
      <p class="project-hub__empty-title">{{ PROJECT_HUB_TEXT.emptyTitle }}</p>
      <p class="project-hub__empty-hint">{{ PROJECT_HUB_TEXT.emptyHint }}</p>
    </div>

    <div v-else-if="viewState === 'list'" class="project-hub__groups" data-testid="project-hub-groups">
      <section
        v-for="group in groups"
        :key="group.key"
        class="project-hub__group"
        :data-testid="`project-hub-group-${group.key}`"
      >
        <h3 class="project-hub__group-title">
          <span>{{ group.label }}</span>
          <span class="project-hub__pill" :data-testid="`project-hub-group-count-${group.key}`">
            {{ group.count }}
          </span>
        </h3>

        <ul class="project-hub__cards">
          <li
            v-for="project in group.projects"
            :key="project.id"
            class="project-hub__card"
            :data-testid="`project-hub-card-${project.id}`"
          >
            <template v-if="editingId === project.id">
              <div class="project-hub__field">
                <label class="project-hub__label" :for="`project-hub-edit-${project.id}`">
                  {{ PROJECT_HUB_TEXT.nameLabel }}
                </label>
                <input
                  :id="`project-hub-edit-${project.id}`"
                  v-model="editName"
                  class="project-hub__input"
                  type="text"
                  autocomplete="off"
                  data-testid="project-hub-edit-input"
                />
                <p
                  v-if="editError !== null"
                  class="project-hub__field-error"
                  data-testid="project-hub-edit-error"
                >
                  {{ editError }}
                </p>
              </div>
              <div class="project-hub__card-actions">
                <YfeButton
                  variant="primary"
                  :label="PROJECT_HUB_TEXT.save"
                  :disabled="busy"
                  data-testid="project-hub-edit-save"
                  @click="submitEdit"
                />
                <YfeButton
                  variant="ghost"
                  :label="PROJECT_HUB_TEXT.cancel"
                  :disabled="busy"
                  data-testid="project-hub-edit-cancel"
                  @click="cancelEdit"
                />
              </div>
            </template>

            <template v-else>
              <div class="project-hub__card-head">
                <h4 class="project-hub__card-name">{{ project.name }}</h4>
                <span
                  v-if="snapshot.currentProjectId === project.id"
                  class="project-hub__badge"
                  data-testid="project-hub-current"
                >
                  {{ PROJECT_HUB_TEXT.editingBadge }}
                </span>
              </div>
              <p class="project-hub__card-summary">{{ projectSummaryText(project) }}</p>
              <p class="project-hub__card-meta">{{ projectMetaLine(project) }}</p>
              <div class="project-hub__card-actions">
                <YfeButton
                  variant="primary"
                  :label="PROJECT_HUB_TEXT.open"
                  data-testid="project-hub-open"
                  @click="openProject(project)"
                />
                <YfeButton
                  variant="ghost"
                  :label="PROJECT_HUB_TEXT.backups"
                  data-testid="project-hub-backups"
                  @click="requestBackups"
                />
                <YfeButton
                  variant="ghost"
                  :label="PROJECT_HUB_TEXT.edit"
                  data-testid="project-hub-edit"
                  @click="beginEdit(project)"
                />
                <YfeButton
                  variant="danger"
                  :label="PROJECT_HUB_TEXT.remove"
                  data-testid="project-hub-remove"
                  @click="requestDelete(project)"
                />
              </div>
            </template>
          </li>
        </ul>
      </section>
    </div>

    <!-- 删除确认：YfeDialog 只渲染 title + 两个按钮，正文只能走 title -->
    <YfeDialog
      :open="pendingDelete !== null"
      :title="deleteMessage"
      :confirm-label="PROJECT_HUB_TEXT.deleteConfirm"
      :cancel-label="PROJECT_HUB_TEXT.deleteCancel"
      tone="danger"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
/* 令牌名与 @yfe/ui 的 tokens.ts 一致；每个变量都带字面量兜底（深色默认值）。 */
.project-hub {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  padding: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, system-ui);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.project-hub__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--yfe-space-lg, 16px);
  flex-wrap: wrap;
}

.project-hub__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 700);
}

.project-hub__intro,
.project-hub__count {
  margin: var(--yfe-space-xs, 4px) 0 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__actions,
.project-hub__form-actions,
.project-hub__card-actions {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  flex-wrap: wrap;
}

.project-hub__form,
.project-hub__card {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-lg, 16px);
  background: var(--yfe-color-surface, #1a1d25);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-lg, 10px);
}

.project-hub__form-title {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.project-hub__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.project-hub__fieldset {
  margin: 0;
  padding: 0;
  border: none;
}

.project-hub__label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text, #e6e8ee);
  background: var(--yfe-color-surface-raised, #20242e);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border-strong, #3a4152);
  border-radius: var(--yfe-radius-md, 6px);
  font-family: inherit;
  font-size: var(--yfe-font-size-md, 14px);
}

.project-hub__input:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.project-hub__textarea {
  resize: vertical;
}

.project-hub__field-error {
  margin: 0;
  color: var(--yfe-color-danger, #ff7b72);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__option {
  display: flex;
  align-items: flex-start;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px);
  min-height: var(--yfe-size-control-height-sm, 24px);
  cursor: pointer;
}

.project-hub__option-body {
  display: flex;
  flex-direction: column;
}

.project-hub__option-label {
  font-weight: var(--yfe-font-weight-medium, 500);
}

.project-hub__option-desc {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
  background: var(--yfe-color-surface-raised, #20242e);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-danger, #ff7b72);
  border-radius: var(--yfe-radius-md, 6px);
}

.project-hub__notice-message {
  margin: 0;
  color: var(--yfe-color-danger, #ff7b72);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__loading {
  padding: var(--yfe-space-xxl, 32px) 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  text-align: center;
}

.project-hub__empty {
  padding: var(--yfe-space-xxl, 32px) var(--yfe-space-lg, 16px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border-strong, #3a4152);
  border-radius: var(--yfe-radius-lg, 10px);
  text-align: center;
}

.project-hub__empty-title {
  margin: 0;
  font-weight: var(--yfe-font-weight-medium, 500);
}

.project-hub__empty-hint {
  margin: var(--yfe-space-sm, 8px) 0 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__groups {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xl, 24px);
}

.project-hub__group-title {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  margin: 0 0 var(--yfe-space-md, 12px);
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.project-hub__pill {
  padding: 0 var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text, #e6e8ee);
  background: var(--yfe-color-surface-raised, #20242e);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-pill, 999px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--yfe-space-md, 12px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.project-hub__card-head {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.project-hub__card-name {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.project-hub__badge {
  padding: 0 var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-on-accent, #111318);
  background: var(--yfe-color-accent, #5b8cff);
  border-radius: var(--yfe-radius-pill, 999px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__card-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
  min-height: calc(var(--yfe-font-size-sm, 12px) * 2);
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-sm, 12px);
}

.project-hub__card-meta {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}
</style>
