<script setup lang="ts">
/**
 * 面板：灵感启发（inspire-tools）—— 视图层。
 *
 * 三张工具卡 + 历史区（全部文案来自 inspire-tools-model.ts 常量或 tab 元数据）：
 * 1. 随机灵感：题材 × 主题 × 冲突 × 反差 本地抽取成一句灵感，「换一个」刷新并记入抽中历史；
 * 2. 名字生成：人物名 / 门派名 / 功法名 / 地名 四类本地随机，「生成名字」记入抽中历史；
 * 3. 点子组合：输入 2–3 个关键词，「AI 发散」（可选）走 props.state.ai.complete；
 *    未配置模型时显式给出引导（按钮不禁用），随机类本地工具不受影响。
 * 4. 抽中历史：面板内存保留最近 10 条（pushHistory 负责截断），不持久化。
 *
 * 纪律：本面板无配置项，不接 panel-store；AI 请求只走
 * `props.state.ai.complete(request)`，绝不 fetch、绝不 import 'node:*'。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { YfeButton, YfePanel } from '@yfe/ui'
import type { AiResult } from '../ai/types.js'
import type { PanelProps } from './types'
import {
  BUTTON_ANOTHER,
  BUTTON_CLEAR_HISTORY,
  BUTTON_IDEA_GO,
  BUTTON_IDEA_RUNNING,
  BUTTON_ROLL_NAMES,
  CARD_HISTORY_TITLE,
  CARD_IDEA_TITLE,
  CARD_INSPIRE_TITLE,
  CARD_NAME_TITLE,
  HISTORY_EMPTY_HINT,
  IDEA_EMPTY_RESULT,
  IDEA_FAILED,
  IDEA_INPUT_HINT,
  IDEA_INPUT_LABEL,
  IDEA_INPUT_PLACEHOLDER,
  IDEA_KEYWORD_HINTS,
  NAME_KIND_LABEL,
  NAME_KIND_OPTIONS,
  NO_MODEL_HINT,
  NO_PERSIST_NOTE,
  INSPIRATION_EMPTY_HINT,
  NAMES_EMPTY_HINT,
  buildIdeaRequest,
  failureNotice,
  formatIdeaKeywords,
  parseIdeaList,
  pushHistory,
  rollInspiration,
  rollNames,
} from './inspire-tools-model'
import type { HistoryEntry, IdeaStatus, InspirationDraw, NameKind } from './inspire-tools-model'

const props = defineProps<PanelProps>()

const panelTitle = computed(() => (props.tab.name.length > 0 ? props.tab.name : props.tab.id))

/* --- 随机灵感 --- */
const inspiration = ref<InspirationDraw | null>(null)

/* --- 名字生成 --- */
const nameKind = ref<NameKind>('person')
const names = ref<readonly string[]>([])

/* --- 点子组合（AI 工具：idle / running / done / failed） --- */
const ideaInput = ref('')
const ideaStatus = ref<IdeaStatus>('idle')
const ideaKeywords = ref<readonly string[]>([])
const ideas = ref<readonly string[]>([])
const ideaMessage = ref<string | null>(null)
const aiConfigured = ref(true)

/* --- 抽中历史（面板内存，不持久化；只记录本地随机抽取） --- */
const history = ref<readonly HistoryEntry[]>([])

/** AiPort 没有 abort：用序号守卫丢弃解绑 / 重开后的迟到结果。 */
let runSeq = 0
let disposed = false

onMounted(() => {
  aiConfigured.value = props.state.ai.configured()
  ideaMessage.value = aiConfigured.value ? IDEA_INPUT_HINT : NO_MODEL_HINT
  // 挂载即给一次可用内容（空数据显式兜底：抽不出时显示各自空态提示）。
  inspiration.value = rollInspiration()
  names.value = rollNames(nameKind.value)
})

onUnmounted(() => {
  disposed = true
})

function onAnother(): void {
  const draw = rollInspiration()
  inspiration.value = draw
  history.value = pushHistory(history.value, { source: CARD_INSPIRE_TITLE, text: draw.text })
}

function onKindChange(): void {
  // v-model 已在 change 时更新 nameKind；清掉旧类型的名字，避免新旧混排。
  names.value = []
}

function onRollNames(): void {
  const rolled = rollNames(nameKind.value)
  names.value = rolled
  history.value = pushHistory(history.value, { source: CARD_NAME_TITLE, text: rolled.join('、') })
}

function onClearHistory(): void {
  history.value = []
}

async function onIdeaGo(): Promise<void> {
  if (ideaStatus.value === 'running') {
    return
  }
  const plan = buildIdeaRequest(ideaInput.value)
  if (!plan.ok) {
    ideaStatus.value = 'idle'
    ideaMessage.value = IDEA_KEYWORD_HINTS[plan.problem]
    return
  }
  if (!props.state.ai.configured()) {
    aiConfigured.value = false
    ideaStatus.value = 'idle'
    ideaMessage.value = NO_MODEL_HINT
    return
  }
  aiConfigured.value = true
  const seq = ++runSeq
  ideaStatus.value = 'running'
  ideaMessage.value = null
  let result: AiResult
  try {
    result = await props.state.ai.complete(plan.request)
  } catch (thrown) {
    if (seq !== runSeq || disposed) {
      return
    }
    ideaStatus.value = 'failed'
    ideaMessage.value = `${IDEA_FAILED}：${thrown instanceof Error ? thrown.message : String(thrown)}`
    return
  }
  if (seq !== runSeq || disposed) {
    return
  }
  if (result.ok) {
    const parsed = parseIdeaList(result.text)
    ideaKeywords.value = plan.keywords
    ideas.value = parsed
    ideaStatus.value = 'done'
    ideaMessage.value = null
  } else {
    ideaStatus.value = 'failed'
    if (result.code === 'AI_NOT_CONFIGURED') {
      aiConfigured.value = false
    }
    ideaMessage.value = failureNotice(result.code, result.message)
  }
}

const ideaKeywordsText = computed(() => formatIdeaKeywords(ideaKeywords.value))
</script>

<template>
  <section class="inspire-tools" data-testid="inspire-tools-panel" :data-tab-id="props.tab.id">
    <header class="inspire-tools__header">
      <h1 class="inspire-tools__title">{{ panelTitle }}</h1>
      <p class="inspire-tools__description">{{ props.tab.description }}</p>
      <p class="inspire-tools__note">{{ NO_PERSIST_NOTE }}</p>
    </header>

    <YfePanel class="inspire-tools__card" :title="CARD_INSPIRE_TITLE" dense>
      <p
        v-if="inspiration === null"
        class="inspire-tools__hint"
        role="status"
        data-testid="inspire-inspiration-empty"
      >{{ INSPIRATION_EMPTY_HINT }}</p>
      <p v-else class="inspire-tools__inspiration" data-testid="inspire-inspiration-text">{{ inspiration.text }}</p>
      <div class="inspire-tools__actions">
        <YfeButton
          :label="BUTTON_ANOTHER"
          variant="primary"
          data-testid="inspire-another"
          @click="onAnother"
        />
      </div>
    </YfePanel>

    <YfePanel class="inspire-tools__card" :title="CARD_NAME_TITLE" dense>
      <div class="inspire-tools__kind-row">
        <label class="inspire-tools__kind-label" for="inspire-kind-select">{{ NAME_KIND_LABEL }}</label>
        <select
          id="inspire-kind-select"
          v-model="nameKind"
          class="inspire-tools__kind"
          :aria-label="NAME_KIND_LABEL"
          data-testid="inspire-kind"
          @change="onKindChange"
        >
          <option v-for="option in NAME_KIND_OPTIONS" :key="option.kind" :value="option.kind">{{ option.label }}</option>
        </select>
      </div>
      <ul v-if="names.length > 0" class="inspire-tools__names" data-testid="inspire-names-list">
        <li
          v-for="(name, index) in names"
          :key="`${name}-${index}`"
          class="inspire-tools__name"
          data-testid="inspire-name-item"
        >{{ name }}</li>
      </ul>
      <p v-else class="inspire-tools__hint" role="status" data-testid="inspire-names-empty">{{ NAMES_EMPTY_HINT }}</p>
      <div class="inspire-tools__actions">
        <YfeButton
          :label="BUTTON_ROLL_NAMES"
          variant="primary"
          data-testid="inspire-roll-names"
          @click="onRollNames"
        />
      </div>
    </YfePanel>

    <YfePanel class="inspire-tools__card" :title="CARD_IDEA_TITLE" dense>
      <input
        v-model="ideaInput"
        class="inspire-tools__idea-input"
        type="text"
        :placeholder="IDEA_INPUT_PLACEHOLDER"
        :aria-label="IDEA_INPUT_LABEL"
        data-testid="inspire-idea-input"
      />
      <div class="inspire-tools__actions">
        <YfeButton
          class="inspire-tools__idea-go"
          :label="ideaStatus === 'running' ? BUTTON_IDEA_RUNNING : BUTTON_IDEA_GO"
          variant="primary"
          :loading="ideaStatus === 'running'"
          data-testid="inspire-idea-go"
          @click="onIdeaGo"
        />
      </div>
      <p
        v-if="ideaMessage !== null"
        class="inspire-tools__idea-message"
        :class="{ 'inspire-tools__idea-message--error': ideaStatus === 'failed' }"
        role="status"
        data-testid="inspire-idea-message"
      >{{ ideaMessage }}</p>
      <p
        v-else-if="ideaStatus === 'done' && ideas.length === 0"
        class="inspire-tools__hint"
        role="status"
        data-testid="inspire-ideas-empty"
      >{{ IDEA_EMPTY_RESULT }}</p>
      <template v-else-if="ideaStatus === 'done'">
        <p class="inspire-tools__idea-keywords" data-testid="inspire-idea-keywords">{{ ideaKeywordsText }}</p>
        <ul class="inspire-tools__ideas" data-testid="inspire-ideas-list">
          <li
            v-for="(idea, index) in ideas"
            :key="`${idea}-${index}`"
            class="inspire-tools__idea"
            data-testid="inspire-idea-item"
          >{{ idea }}</li>
        </ul>
      </template>
    </YfePanel>

    <YfePanel class="inspire-tools__card" :title="CARD_HISTORY_TITLE" dense>
      <ul v-if="history.length > 0" class="inspire-tools__history" data-testid="inspire-history-list">
        <li
          v-for="(entry, index) in history"
          :key="`${entry.text}-${index}`"
          class="inspire-tools__history-item"
          data-testid="inspire-history-item"
        >
          <span class="inspire-tools__history-source" data-testid="inspire-history-source">{{ entry.source }}</span>
          <span class="inspire-tools__history-text" data-testid="inspire-history-text">{{ entry.text }}</span>
        </li>
      </ul>
      <p v-else class="inspire-tools__hint" role="status" data-testid="inspire-history-empty">{{ HISTORY_EMPTY_HINT }}</p>
      <div v-if="history.length > 0" class="inspire-tools__actions">
        <YfeButton
          :label="BUTTON_CLEAR_HISTORY"
          variant="ghost"
          data-testid="inspire-history-clear"
          @click="onClearHistory"
        />
      </div>
    </YfePanel>
  </section>
</template>

<style scoped>
.inspire-tools {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
}

.inspire-tools__header {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
}

.inspire-tools__title {
  margin: 0;
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-bold, 600);
  color: var(--yfe-color-text, #e6e8ee);
}

.inspire-tools__description {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__note {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__inspiration {
  margin: 0;
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}

.inspire-tools__hint {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__actions {
  display: flex;
  gap: var(--yfe-space-sm, 8px);
  margin-top: var(--yfe-space-md, 12px);
}

.inspire-tools__kind-row {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.inspire-tools__kind-label {
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__kind,
.inspire-tools__idea-input {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  font-size: var(--yfe-font-size-md, 14px);
  color: var(--yfe-color-text, #e6e8ee);
  background: var(--yfe-color-surface, #1a1d25);
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  outline: none;
}

.inspire-tools__kind:focus,
.inspire-tools__idea-input:focus {
  border-color: var(--yfe-color-accent, #5b8cff);
}

.inspire-tools__idea-input {
  width: 100%;
  box-sizing: border-box;
}

.inspire-tools__names {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  margin: var(--yfe-space-md, 12px) 0 0;
  padding: 0;
  list-style: none;
}

.inspire-tools__name {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-md, 12px);
  font-size: var(--yfe-font-size-md, 14px);
  color: var(--yfe-color-text, #e6e8ee);
  background: var(--yfe-color-surface, #1a1d25);
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-pill, 999px);
}

.inspire-tools__idea-message {
  margin: var(--yfe-space-md, 12px) 0 0;
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__idea-message--error {
  color: var(--yfe-color-danger, #ff7b72);
}

.inspire-tools__idea-keywords {
  margin: var(--yfe-space-md, 12px) 0 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__ideas {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: var(--yfe-space-sm, 8px) 0 0;
  padding: 0;
  list-style: none;
}

.inspire-tools__idea {
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
  background: var(--yfe-color-surface, #1a1d25);
  border: 1px solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
}

.inspire-tools__history {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.inspire-tools__history-item {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-xs, 4px) 0;
  border-bottom: 1px solid var(--yfe-color-border, #2a2f3a);
}

.inspire-tools__history-source {
  flex-shrink: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.inspire-tools__history-text {
  font-size: var(--yfe-font-size-sm, 12px);
  line-height: var(--yfe-font-line-height, 1.7);
  color: var(--yfe-color-text, #e6e8ee);
}
</style>
