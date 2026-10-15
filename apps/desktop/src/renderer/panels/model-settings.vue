<script setup lang="ts">
/**
 * 模型设置面板（tab.id = `model-settings`，分组 = 工作面板）。
 *
 * 模型配置表单：挂载时 `await props.state.ai.reload()`，然后 `getConfig()` 灌进表单
 * （null = 尚未配置，用 DEFAULT_AI_MODEL_CONFIG 起底）。保存走
 * `assembleConfig → props.state.ai.saveConfig`（model-settings-model.ts 纯函数）：
 * 校验失败显示中文错误、不发保存；保存失败且没有当前作品时引导新建作品
 * （可一键「新建作品并保存」，成功后自动重跑保存路径）。
 *
 * apiKey 纪律：输入框 password 型、**不回显明文**，加载后恒为空串，
 * 留空保存 = 保持已保存的 Key（装配层回退，见 model-settings-model.ts）；
 * 顶部状态区对外展示一律走 `redactAiConfig`（apiKey 只显「已配置/未配置」）。
 * 本组件只渲染与调用，全部读写经由 `props.state.ai` 的 AiPort，不自己碰存储。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { YfeButton } from '@yfe/ui'

import type { AiModelConfig } from '../ai/types.js'
import type { PanelProps } from './types.js'
import {
  MODEL_SETTINGS_PANEL_TEXT,
  applyConfigToForm,
  assembleConfig,
  redactedSummary,
  saveOutcome,
  type ModelSettingsFormRaw,
} from './model-settings-model.js'

const props = defineProps<PanelProps>()

// 页签名为空时回退到 id（与 `_placeholder.vue` 同一口径）。
const title = props.tab.name.length > 0 ? props.tab.name : props.tab.id

const TEXT = MODEL_SETTINGS_PANEL_TEXT

/** 表单缓冲区（v-model 就地赋值；装配成配置走 model-settings-model.ts）。 */
const form = ref<ModelSettingsFormRaw>({ ...applyConfigToForm(null) })
/** 最近一次加载到的配置：apiKey 兜底（留空保持不变）+ 状态区摘要。 */
const loadedConfig = ref<AiModelConfig | null>(null)
const configured = ref(false)
/** 重载在途（挂载与「重载配置」按钮共用）。 */
const loading = ref(false)
/** 保存/新建作品在途。 */
const saving = ref(false)
/** 新建作品在途（引导块按钮）。 */
const creating = ref(false)
const validationError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)
const saveOk = ref(false)
/** 保存失败且没有当前作品：显示引导块。 */
const needProject = ref(false)
const projectName = ref('')

let disposed = false

/** 状态区摘要条目（readonly 修饰符只能直接贴在数组类型上，不能套 ReturnType）。 */
type SummaryItems = ReturnType<typeof redactedSummary>
const summary = computed<SummaryItems>(() =>
  loadedConfig.value === null ? [] : redactedSummary(loadedConfig.value),
)
const statusText = computed<string>(() => (configured.value ? TEXT.statusConfigured : TEXT.statusNotConfigured))
const reloadLabel = computed<string>(() => (loading.value ? TEXT.reloading : TEXT.reload))
const saveLabel = computed<string>(() => (saving.value ? TEXT.saving : TEXT.save))
const canCreateProject = computed<boolean>(() => projectName.value.trim().length > 0)

/** reload + 灌表单（挂载与「重载配置」按钮共用）。 */
async function loadIntoForm(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    await props.state.ai.reload()
  } finally {
    loading.value = false
  }
  if (disposed) return
  const config = props.state.ai.getConfig()
  loadedConfig.value = config
  configured.value = props.state.ai.configured()
  form.value = applyConfigToForm(config)
}

/** 保存：归一化 + 校验（中文错误就显示、不发保存）→ saveConfig → 结果文案。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const { config, error } = assembleConfig(form.value, loadedConfig.value)
  if (error !== null) {
    validationError.value = error
    saveMessage.value = null
    return
  }
  validationError.value = null
  saving.value = true
  try {
    const ok = await props.state.ai.saveConfig(config)
    if (disposed) return
    const outcome = saveOutcome(ok, props.state.getSnapshot().projectId !== null)
    needProject.value = outcome.kind === 'needProject'
    if (outcome.kind === 'saved') {
      saveMessage.value = outcome.message
      saveOk.value = true
      // 保存成功：重读配置刷新状态区与 apiKey 兜底（不回显明文，输入框回到空 + 占位）。
      await loadIntoForm()
      return
    }
    if (outcome.kind !== 'needProject') saveMessage.value = outcome.message
    saveOk.value = false
  } finally {
    saving.value = false
  }
}

/** 引导流程：新建作品成功后自动重跑保存（校验 + saveConfig）。 */
async function onCreateAndSave(): Promise<void> {
  const name = projectName.value.trim()
  if (creating.value || name.length === 0) return
  creating.value = true
  try {
    const ok = await props.state.createProject(name)
    if (disposed) return
    if (!ok) {
      saveMessage.value = TEXT.createProjectFailed
      saveOk.value = false
      return
    }
    projectName.value = ''
    saveMessage.value = null
  } finally {
    creating.value = false
  }
  await onSave()
}

onMounted(() => {
  void loadIntoForm()
})

onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <section class="model-settings" data-testid="model-settings-panel" :data-tab-id="props.tab.id">
    <header class="model-settings__header">
      <h1 class="model-settings__title">{{ title }}</h1>
      <p class="model-settings__desc">{{ props.tab.description }}</p>
      <p class="model-settings__intro" data-testid="model-settings-intro">{{ TEXT.intro }}</p>
    </header>

    <div class="model-settings__status" data-testid="model-settings-status" role="status" aria-live="polite">
      <span
        class="model-settings__dot"
        :class="configured ? 'model-settings__dot--ok' : 'model-settings__dot--off'"
        data-testid="model-settings-status-dot"
        aria-hidden="true"
      />
      <span class="model-settings__status-label">{{ TEXT.statusLabel }}</span>
      <span class="model-settings__status-text" data-testid="model-settings-status-text">{{ statusText }}</span>
      <span v-if="summary.length > 0" class="model-settings__summary" data-testid="model-settings-summary">
        <span v-for="item in summary" :key="item.label" class="model-settings__summary-item">
          {{ item.label }}：{{ item.value }}
        </span>
      </span>
    </div>

    <form class="model-settings__form" data-testid="model-settings-form" @submit.prevent="onSave">
      <div class="model-settings__form-title">{{ TEXT.formTitle }}</div>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldBaseUrl }}</span>
        <input
          v-model="form.baseUrl"
          class="model-settings__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="TEXT.fieldBaseUrlPlaceholder"
          data-testid="model-settings-base-url"
        />
      </label>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldModel }}</span>
        <input
          v-model="form.model"
          class="model-settings__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="TEXT.fieldModelPlaceholder"
          data-testid="model-settings-model"
        />
      </label>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldApiKey }}</span>
        <input
          v-model="form.apiKey"
          class="model-settings__input"
          type="password"
          autocomplete="new-password"
          :placeholder="configured ? TEXT.fieldApiKeyPlaceholderConfigured : TEXT.fieldApiKeyPlaceholderEmpty"
          data-testid="model-settings-api-key"
        />
      </label>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldTemperature }}</span>
        <input
          v-model="form.temperature"
          class="model-settings__input"
          type="text"
          inputmode="decimal"
          data-testid="model-settings-temperature"
        />
      </label>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldMaxTokens }}</span>
        <input
          v-model="form.maxTokens"
          class="model-settings__input"
          type="text"
          inputmode="numeric"
          data-testid="model-settings-max-tokens"
        />
      </label>

      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.fieldTimeoutMs }}</span>
        <input
          v-model="form.timeoutMs"
          class="model-settings__input"
          type="text"
          inputmode="numeric"
          data-testid="model-settings-timeout-ms"
        />
      </label>

      <p
        v-if="validationError !== null"
        class="model-settings__feedback model-settings__feedback--error"
        data-testid="model-settings-validation-error"
      >
        {{ validationError }}
      </p>
      <p
        v-else-if="saveMessage !== null"
        class="model-settings__feedback"
        :class="{ 'model-settings__feedback--ok': saveOk }"
        data-testid="model-settings-save-message"
      >
        {{ saveMessage }}
      </p>

      <div class="model-settings__actions">
        <YfeButton
          :label="saveLabel"
          variant="primary"
          :loading="saving"
          data-testid="model-settings-save"
          @click="onSave"
        />
        <YfeButton
          :label="reloadLabel"
          variant="ghost"
          :loading="loading"
          data-testid="model-settings-reload"
          @click="loadIntoForm"
        />
      </div>
    </form>

    <div v-if="needProject" class="model-settings__project" data-testid="model-settings-project-guide">
      <p class="model-settings__project-text" data-testid="model-settings-need-project">{{ TEXT.needProject }}</p>
      <label class="model-settings__field">
        <span class="model-settings__field-label">{{ TEXT.projectNameLabel }}</span>
        <input
          v-model="projectName"
          class="model-settings__input"
          type="text"
          autocomplete="off"
          :placeholder="TEXT.projectNamePlaceholder"
          data-testid="model-settings-project-name"
        />
      </label>
      <div class="model-settings__actions">
        <YfeButton
          :label="TEXT.createAndRetry"
          variant="ghost"
          :disabled="!canCreateProject || saving"
          :loading="creating"
          data-testid="model-settings-create-and-save"
          @click="onCreateAndSave"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.model-settings {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
}

.model-settings__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
}

.model-settings__title {
  margin: 0;
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.model-settings__desc {
  margin: 0;
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__intro {
  margin: 0;
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__status {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.model-settings__dot {
  width: var(--yfe-size-status-dot, 8px);
  height: var(--yfe-size-status-dot, 8px);
  border-radius: var(--yfe-radius-pill, 999px);
  align-self: center;
}

.model-settings__dot--ok {
  background: var(--yfe-color-success, #3fb950);
}

.model-settings__dot--off {
  background: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__status-label {
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__status-text {
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.model-settings__summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  margin-left: var(--yfe-space-md, 12px);
}

.model-settings__summary-item {
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.model-settings__form-title {
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.model-settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
}

.model-settings__field-label {
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.model-settings__input {
  box-sizing: border-box;
  height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #3a3a3e);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.model-settings__input:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #58a6ff);
  outline-offset: 1px;
}

.model-settings__feedback {
  margin: 0;
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-warning, #d29922);
}

.model-settings__feedback--error {
  color: var(--yfe-color-danger, #f85149);
}

.model-settings__feedback--ok {
  color: var(--yfe-color-success, #3fb950);
}

.model-settings__actions {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.model-settings__project {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #d29922);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1e1e21);
}

.model-settings__project-text {
  margin: 0;
  font-family: var(--yfe-font-family, system-ui, sans-serif);
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-warning, #d29922);
}
</style>
