<script setup lang="ts">
/**
 * 卡片渲染器（W4 · 6 个 card 页签）：**左侧卡片列表 + 右侧详情表单**。
 *
 * 契约见 `docs/接口冻结-渲染层.md` §3 的 W4 小节。本组件是**纯展示 + 事件**：
 * 不调 IPC、不 import `@yfe/client-sdk`、不 import `node:*`；数据由 props 进、
 * 用户意图由 emits 出，落库由外壳（W5）调 `app-state`。所有规则（展示名优先级、
 * 字段列表、控件文本、栅格列数）都在 `schema-card.ts` 里，本组件只负责铺 DOM。
 *
 * ## 文案纪律
 *
 * 中文文案只来自 `TabDef`：页签名 / 页签描述 / `tips` / `codeRule` / 列选项 / 字段名与
 * 字段说明都直接读 `tab`。组件里**只**保留动作词「新建」「删除」与状态词「只读」、
 * 提示前缀「示例：」—— 这四处与 `App.vue`、旧版 `SchemaFieldGrid` 的既有叫法一致，
 * 都不是「另写一份」页签文案。真实 card 页签没有字段名词（角色卡 / 分卷），
 * 所以不拼「新建角色卡」这种旧版专属名词。
 *
 * ## 关于 computed
 *
 * 凡是**从 `tab` 派生**的东西（字段列表、列数、标题）一律在模板里现调 `schema-card.ts` 的
 * 纯函数，不用 `computed` 缓存 —— `tab.modules` 等属性是 getter（切题材包即变），
 * 缓存住就会渲染出一份过期快照（§2 硬约定 ①）。`computed` 只用于 props 之间的组合。
 */
import { YfeButton, YfeToolbar } from '@yfe/ui'
import type { TabDef } from '@yfe/schema-tabs'
import { computed } from 'vue'

import type { EntityRow } from './entity-row.js'
import { cardFieldText, cardFields, cardSubtitle, cardTitle, gridColumns } from './schema-card.js'
import type { CardField } from './schema-card.js'

/**
 * 设定实体 id。
 *
 * §3 的 emits 签名写的就是 `SettingsEntityId`，但 `@yfe/contracts` 没有这个别名
 * （`ids.ts` 只有 `ProjectId` / `DocumentId` 等），结构上就是 `EntityRow['id']`（= `string`），
 * 与外壳（W5）传进来的裸 id 完全一致。刻意**不导出**：`schema-table.ts`（W3）已经导出了
 * 同名类型，本文件再导出一次会让 W5 的 `schema/index.ts` 撞名（TS2308）。
 */
type SettingsEntityId = EntityRow['id']

const props = defineProps<{
  tab: TabDef
  cards: readonly EntityRow[]
  selectedId?: string | null
  readonly?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  select: [SettingsEntityId]
  create: []
  update: [SettingsEntityId, Record<string, unknown>]
  delete: [SettingsEntityId]
}>()

/** 选中的卡片；`selectedId` 为空或指向已删的卡时是 `null`。 */
const selected = computed<EntityRow | null>(
  () => props.cards.find((card) => card.id === props.selectedId) ?? null,
)

/**
 * 编辑是否被冻结：`readonly`（外壳判定只读）或 `busy`（有 IPC 在飞）。
 * 冻结只挡**写**：新建 / 删除 / 字段输入；卡片之间的切换不禁（切一下不落库）。
 */
const locked = computed(() => props.readonly === true || props.busy === true)

/** 详情标题；未选中卡片时返回空串，省得模板里写非空断言。 */
function titleOf(card: EntityRow | null): string {
  return card === null ? '' : cardTitle(props.tab, card)
}

function subtitleOf(card: EntityRow): string | null {
  return cardSubtitle(props.tab, card)
}

/** 详情表单的列数（2–4 列，规则见 `gridColumns`）。 */
function gridStyle(): Record<string, string> {
  return { gridTemplateColumns: `repeat(${gridColumns(props.tab)}, minmax(0, 1fr))` }
}

/** 字段控件的输入 id：`label[for]` 要指到它，用下标避免中文键进 HTML id。 */
function fieldId(index: number): string {
  return `${props.tab.id}-field-${index}`
}

/**
 * 字段 → 控件。
 *
 * `select` 只有真的带 `options` 才用下拉 —— 没有选项的下拉等于空壳，旧版 `TableSheet`
 * 同样回退成文本输入。`date` / `calendar` 用日期控件（值是 ISO 时间戳时截到日，见 `cardFieldText`）。
 */
type CardControl = 'select' | 'textarea' | 'date' | 'number' | 'text'

function controlOf(field: CardField): CardControl {
  switch (field.type) {
    case 'select':
      return (field.options?.length ?? 0) > 0 ? 'select' : 'text'
    case 'textarea':
      return 'textarea'
    case 'date':
    case 'calendar':
      return 'date'
    case 'number':
      return 'number'
    default:
      return 'text'
  }
}

function onSelect(card: EntityRow): void {
  if (card.id === props.selectedId) return
  emit('select', card.id)
}

function onCreate(): void {
  if (locked.value) return
  emit('create')
}

function onDelete(): void {
  const card = selected.value
  if (card === null || locked.value) return
  emit('delete', card.id)
}

/**
 * 输入 → `update`。
 *
 * emit 的是**整份 `values` 的合并结果**，不是单键补丁：`saveSettingsEntity` 的入参就是完整
 * `values`，外壳拿补丁去存会把作者填过的其它字段一起抹掉。未知键（旧版遗留字段 / 未来字段）
 * 原样带过去 —— 开发计划 §4 硬规则 3「旧 ID 与未知字段必须保留」。
 * 值一律按控件里的**字符串**写回，不做 `Number()` 归一化（保留 `''` / `'007'` 这类中间态）。
 */
function onFieldInput(field: CardField, event: Event): void {
  const card = selected.value
  if (card === null || locked.value) return
  const target = event.target
  if (
    !(target instanceof HTMLInputElement) &&
    !(target instanceof HTMLTextAreaElement) &&
    !(target instanceof HTMLSelectElement)
  ) {
    return
  }
  emit('update', card.id, { ...card.values, [field.name]: target.value })
}
</script>

<template>
  <div
    class="card-view"
    data-testid="card-view"
    :data-tab-id="props.tab.id"
    :aria-busy="props.busy === true ? 'true' : 'false'"
  >
    <YfeToolbar>
      <span class="card-view__tab-name" data-testid="card-tab-name">{{ props.tab.name }}</span>
      <span v-if="props.readonly === true" class="card-view__hint" data-testid="card-readonly">只读</span>
      <span class="card-view__spacer" />
      <YfeButton
        data-testid="card-create"
        label="新建"
        variant="primary"
        :disabled="locked"
        @click="onCreate"
      />
      <YfeButton
        data-testid="card-delete"
        label="删除"
        variant="danger"
        :disabled="locked || selected === null"
        @click="onDelete"
      />
    </YfeToolbar>

    <div class="card-view__panes">
      <!-- 左：卡片列表（可选中） -->
      <section class="card-view__pane card-view__pane--list" :aria-label="props.tab.name">
        <ul
          v-if="props.cards.length > 0"
          class="card-view__list"
          role="listbox"
          data-testid="card-list"
          :aria-label="props.tab.name"
        >
          <li v-for="card in props.cards" :key="card.id" class="card-view__row">
            <button
              type="button"
              class="card-view__item"
              :class="{ 'card-view__item--selected': card.id === props.selectedId }"
              role="option"
              :aria-selected="card.id === props.selectedId ? 'true' : 'false'"
              :data-card-id="card.id"
              data-testid="card-item"
              @click="onSelect(card)"
            >
              <span
                class="card-view__item-title"
                data-testid="card-item-title"
                :title="titleOf(card)"
              >{{ titleOf(card) }}</span>
              <span v-if="subtitleOf(card) !== null" class="card-view__item-subtitle" data-testid="card-item-subtitle">
                {{ subtitleOf(card) }}
              </span>
            </button>
          </li>
        </ul>

        <!-- 空态：没有卡片时给引导语（文案全部来自 TabDef） -->
        <div v-else class="card-view__guide" data-testid="card-empty">
          <p class="card-view__guide-line" data-testid="card-empty-description">{{ props.tab.description }}</p>
          <ul v-if="(props.tab.tips ?? []).length > 0" class="card-view__tips">
            <li v-for="tip in props.tab.tips ?? []" :key="tip" class="card-view__tip" data-testid="card-tip">
              {{ tip }}
            </li>
          </ul>
        </div>
      </section>

      <!-- 右：详情表单 -->
      <section class="card-view__pane card-view__pane--detail">
        <template v-if="selected !== null">
          <h3 class="card-view__detail-title" data-testid="card-detail-title" :title="titleOf(selected)">
            {{ titleOf(selected) }}
          </h3>
          <p v-if="props.tab.description !== ''" class="card-view__detail-desc" data-testid="card-detail-description">
            {{ props.tab.description }}
          </p>

          <div class="card-view__grid" data-testid="card-detail-grid" :style="gridStyle()">
            <div
              v-for="(field, index) in cardFields(props.tab)"
              :key="field.name"
              class="card-view__field"
              :class="{ 'card-view__field--wide': controlOf(field) === 'textarea' }"
              data-testid="card-field"
              :data-field-name="field.name"
              :data-field-control="controlOf(field)"
            >
              <label class="card-view__label" data-testid="card-field-label" :for="fieldId(index)">
                {{ field.name }}
              </label>

              <select
                v-if="controlOf(field) === 'select'"
                :id="fieldId(index)"
                class="card-view__control"
                data-testid="card-field-select"
                :disabled="locked"
                :value="cardFieldText(selected, field)"
                @change="onFieldInput(field, $event)"
              >
                <option value=""></option>
                <option v-for="option in field.options ?? []" :key="option" :value="option">{{ option }}</option>
              </select>

              <textarea
                v-else-if="controlOf(field) === 'textarea'"
                :id="fieldId(index)"
                class="card-view__control card-view__control--area"
                data-testid="card-field-textarea"
                :disabled="locked"
                :value="cardFieldText(selected, field)"
                @input="onFieldInput(field, $event)"
              ></textarea>

              <input
                v-else-if="controlOf(field) === 'number'"
                :id="fieldId(index)"
                type="number"
                class="card-view__control"
                data-testid="card-field-number"
                :disabled="locked"
                :value="cardFieldText(selected, field)"
                @input="onFieldInput(field, $event)"
              />

              <input
                v-else-if="controlOf(field) === 'date'"
                :id="fieldId(index)"
                type="date"
                class="card-view__control"
                data-testid="card-field-date"
                :disabled="locked"
                :value="cardFieldText(selected, field)"
                @input="onFieldInput(field, $event)"
              />

              <input
                v-else
                :id="fieldId(index)"
                type="text"
                class="card-view__control"
                data-testid="card-field-input"
                :disabled="locked"
                :value="cardFieldText(selected, field)"
                @input="onFieldInput(field, $event)"
              />

              <p v-if="field.desc" class="card-view__field-hint" data-testid="card-field-desc">{{ field.desc }}</p>
              <p v-if="field.example" class="card-view__field-hint" data-testid="card-field-example">
                示例：{{ field.example }}
              </p>
              <p v-if="field.tip" class="card-view__field-hint" data-testid="card-field-tip">{{ field.tip }}</p>
            </div>
          </div>

          <p v-if="props.tab.codeRule" class="card-view__code-rule" data-testid="card-code-rule">
            {{ props.tab.codeRule }}
          </p>
        </template>

        <!-- 未选中态 -->
        <div v-else class="card-view__guide" data-testid="card-unselected">
          <p class="card-view__guide-line" data-testid="card-unselected-description">{{ props.tab.description }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.card-view {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
}

.card-view__tab-name {
  font-weight: var(--yfe-font-weight-medium, 500);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-view__hint {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.card-view__spacer {
  flex: 1 1 auto;
}

.card-view__panes {
  display: flex;
  flex: 1 1 auto;
  gap: var(--yfe-space-sm, 8px);
  min-height: 0;
  padding: var(--yfe-space-sm, 8px);
}

.card-view__pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface, #1a1d25);
}

/* 列表固定宽度：卡片名长短不一，跟着内容抖动会让人找不到刚才那张卡。 */
.card-view__pane--list {
  flex: 0 0 220px;
  overflow: auto;
}

.card-view__pane--detail {
  flex: 1 1 auto;
  gap: var(--yfe-space-sm, 8px);
  overflow: auto;
  padding: var(--yfe-space-md, 12px);
}

.card-view__list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  margin: 0;
  padding: var(--yfe-space-xs, 4px);
  list-style: none;
}

.card-view__row {
  min-width: 0;
}

.card-view__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid transparent;
  border-radius: var(--yfe-radius-sm, 4px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.card-view__item:hover {
  border-color: var(--yfe-color-border-strong, #3a4152);
}

.card-view__item:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

/* 选中态：底色 + 左侧强调条，不靠单一颜色（色弱也要看得出来）。 */
.card-view__item--selected {
  border-color: var(--yfe-color-accent, #5b8cff);
  background: var(--yfe-color-surface-raised, #20242e);
  box-shadow: inset 2px 0 0 0 var(--yfe-color-accent, #5b8cff);
}

.card-view__item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-view__item-subtitle {
  overflow: hidden;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-view__guide {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-md, 12px);
  color: var(--yfe-color-text-muted, #8b93a7);
}

.card-view__guide-line {
  margin: 0;
}

.card-view__tips {
  margin: 0;
  padding-left: var(--yfe-space-lg, 16px);
}

.card-view__tip {
  font-size: var(--yfe-font-size-sm, 12px);
}

.card-view__detail-title {
  margin: 0;
  overflow: hidden;
  font-size: var(--yfe-font-size-lg, 16px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-view__detail-desc {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.card-view__grid {
  display: grid;
  gap: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
}

.card-view__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  min-width: 0;
}

/* 多行字段独占一行：挤在栅格一格里只能看到三行字，作者会本能地去改别的字段。 */
.card-view__field--wide {
  grid-column: 1 / -1;
}

.card-view__label {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.card-view__control {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-background, #111318);
  color: inherit;
  font: inherit;
}

.card-view__control:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5b8cff);
  outline-offset: 1px;
}

.card-view__control:disabled {
  color: var(--yfe-color-text-muted, #8b93a7);
  cursor: not-allowed;
}

.card-view__control--area {
  height: auto;
  min-height: calc(var(--yfe-size-control-height, 32px) * 3);
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  line-height: var(--yfe-font-line-height, 1.7);
  resize: vertical;
}

.card-view__field-hint {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.card-view__code-rule {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}
</style>
