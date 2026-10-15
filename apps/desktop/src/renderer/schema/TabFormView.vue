<script setup lang="ts">
/**
 * W2 · 通用表单页签渲染器（5 个 `type: 'form'` 页签 + 后续题材包新增 form 页签共用）。
 *
 * ## 契约（`docs/接口冻结-渲染层.md` §3 W2）
 *
 * - props：`{ tab: TabDef; value: Record<string, unknown>; readonly?: boolean; busy?: boolean }`
 * - emits：`{ 'update:value': [Record<string, unknown>]; save: [Record<string, unknown>] }`
 * - 本组件是**纯展示组件**：不调 IPC、不 import `app-state`，值从 props 进、用户意图从 emits 出。
 *
 * ## 渲染规则
 *
 * 1. 按 `tab.modules` 分组，组标题＝`module.name`；字段顺序＝`modules[].fields[]` 顺序。
 * 2. 每个字段渲染 `name`（标签）、`desc`（说明）、`example`（输入框 placeholder）；
 *    `kind: 'numeric'` 走数字输入（`type="number"`），其余走多行文本。
 * 3. 所有交互元素带 `data-testid`（`field-<字段名>` / `form-save`），便于 GUI 断言与外壳联调。
 * 4. 空态（无 `modules`）与只读态都有显式标记：`data-testid="form-empty"` / `"form-readonly"`。
 *
 * ## 中文文案来源
 *
 * 🔴 模块名 / 字段名 / 说明 / 示例 / 底部提示**一律只从 `TabDef` 读**，本组件不另写一份
 * （改一个字的说明必须走 `@yfe/schema-tabs` 的元数据）。组件自带的中文只有下面 `CHROME`
 * 里那几个**控件自身的字样**（保存 / 保存中 / 只读 / 空态），它们不对应任何 schema 文案。
 *
 * ## 题材包纪律
 *
 * `worldbase` / `power` / 制度四页签的 `modules` 是 getter，切包即变 ⇒ 模板里永远经
 * `modulesOf()` **当次现读** `tab.modules`（**不用 `computed` 缓存**），
 * **不缓存、不序列化** `TabDef`。切包后要由外壳触发一次重渲染（换 tab 对象 / 换 key），
 * 因为 getter 读的题材包不在 Vue 的响应式图里。
 */
import type { FormField, FormModule, TabDef } from '@yfe/schema-tabs'
import { designTokenVariables, YfeButton } from '@yfe/ui'
import { computed } from 'vue'

import { applyFieldInput, readFormValues } from './schema-form.js'

const props = defineProps<{
  tab: TabDef
  value: Readonly<Record<string, unknown>>
  /** 只读态：控件禁用 + 不出现保存按钮（历史快照 / 演示模式） */
  readonly?: boolean
  /** 忙态：保存进行中，控件禁用，避免重复提交 */
  busy?: boolean
}>()

const emit = defineEmits<{
  'update:value': [Record<string, unknown>]
  save: [Record<string, unknown>]
}>()

/** 控件自身字样（**不是** schema 文案；字段级文案全部来自 `TabDef`）。 */
const CHROME = {
  save: '保存',
  saving: '保存中…',
  readonly: '只读',
  empty: '本页暂无可填写的字段',
} as const

/** 只读或忙：任何输入都不允许（只读态连 emits 都不该有）。 */
const locked = computed(() => props.readonly === true || props.busy === true)

/**
 * 🔴 **每次渲染都现读** `tab.modules`（不用 `computed` 缓存）。
 *
 * 受题材驱动的六个页签这里是 getter，读的是**当前**题材包；`computed` 只会按 `props.tab`
 * 的引用缓存，切包后若外壳沿用同一个 tab 对象就会渲染出上一包的分组/字段。用普通函数读，
 * 任何一次重渲染（切包后外壳必然要重渲染）拿到的都是当次的值。
 * ⚠️ 代价与边界：`modules` 的 getter 不在 Vue 的响应式图里，渲染器**无法自己**感知切包，
 * 外壳切包后必须触发一次渲染（换 tab 对象 / 换 `key` / 更新其它 prop）。
 */
function modulesOf(): FormModule[] {
  return props.tab.modules ?? []
}

/** 当前值（声明字段补默认值 + 未声明键原样保留）：渲染与写回共用同一份归一逻辑，同样不缓存。 */
function valuesOf(): Record<string, unknown> {
  return readFormValues(props.tab, props.value)
}

function hasFields(): boolean {
  return modulesOf().some((module) => module.fields.length > 0)
}

function tipLines(): string[] {
  return props.tab.tips ?? []
}

function textOf(fieldName: string): string {
  const raw = valuesOf()[fieldName]
  return raw === null || raw === undefined ? '' : String(raw)
}

/** 唯一 DOM id（字段名可重复，故用「模块序号 + 字段序号」而不是字段名）。 */
function fieldDomId(moduleIndex: number, fieldIndex: number): string {
  return `yfe-form-${props.tab.id}-${moduleIndex}-${fieldIndex}`
}

/**
 * 输入 → `update:value`：在**当前归一值**之上做单字段不可变更新，所以
 * 未声明的遗留键会被一起带出去（外壳直接落库不会丢数据）。
 * 只读 / 忙态直接丢弃输入（原生 disabled 在脚本派发事件时挡不住）。
 */
function onFieldInput(field: FormField, event: Event): void {
  if (locked.value) return
  const target = event.target
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return
  emit('update:value', applyFieldInput(valuesOf(), field, target.value))
}

/** 保存：把当前（补过默认值的）整份值交给外壳落库；忙/只读态不发。 */
function onSave(): void {
  if (locked.value) return
  emit('save', valuesOf())
}
</script>

<template>
  <form
    class="tab-form"
    data-testid="form-root"
    :style="designTokenVariables"
    :data-readonly="readonly === true ? 'true' : 'false'"
    :aria-busy="busy === true ? 'true' : 'false'"
    @submit.prevent
  >
    <div v-if="readonly === true || busy === true" class="tab-form__flags">
      <span v-if="readonly === true" class="tab-form__flag tab-form__flag--readonly" data-testid="form-readonly">
        {{ CHROME.readonly }}
      </span>
      <span v-if="busy === true" class="tab-form__flag tab-form__flag--busy" data-testid="form-busy">
        {{ CHROME.saving }}
      </span>
    </div>

    <p v-if="modulesOf().length === 0" class="tab-form__empty" data-testid="form-empty">{{ CHROME.empty }}</p>

    <template v-else>
      <section
        v-for="(module, moduleIndex) in modulesOf()"
        :key="`${moduleIndex}-${module.name}`"
        class="tab-form__module"
        :data-testid="`form-module-${module.name}`"
      >
        <h3 class="tab-form__module-name">{{ module.name }}</h3>

        <div
          v-for="(field, fieldIndex) in module.fields"
          :key="`${fieldIndex}-${field.name}`"
          class="tab-form__field"
        >
          <label class="tab-form__field-name" :for="fieldDomId(moduleIndex, fieldIndex)">{{ field.name }}</label>
          <p v-if="field.desc !== ''" class="tab-form__field-desc">{{ field.desc }}</p>

          <input
            v-if="field.kind === 'numeric'"
            :id="fieldDomId(moduleIndex, fieldIndex)"
            class="tab-form__input tab-form__input--numeric"
            :data-testid="`field-${field.name}`"
            type="number"
            inputmode="numeric"
            step="any"
            :placeholder="field.example"
            :value="textOf(field.name)"
            :disabled="locked"
            :readonly="readonly === true"
            @input="onFieldInput(field, $event)"
          />
          <textarea
            v-else
            :id="fieldDomId(moduleIndex, fieldIndex)"
            class="tab-form__input tab-form__input--text"
            :data-testid="`field-${field.name}`"
            rows="2"
            :placeholder="field.example"
            :value="textOf(field.name)"
            :disabled="locked"
            :readonly="readonly === true"
            @input="onFieldInput(field, $event)"
          />
        </div>
      </section>

      <ul v-if="tipLines().length > 0" class="tab-form__tips" data-testid="form-tips">
        <li v-for="(tip, tipIndex) in tipLines()" :key="tipIndex" class="tab-form__tip">{{ tip }}</li>
      </ul>

      <div v-if="readonly !== true && hasFields()" class="tab-form__footer">
        <YfeButton
          data-testid="form-save"
          :label="busy === true ? CHROME.saving : CHROME.save"
          variant="primary"
          :loading="busy === true"
          :disabled="busy === true"
          @click="onSave"
        />
      </div>
    </template>
  </form>
</template>

<style scoped>
.tab-form {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md);
  min-width: 0;
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
}

.tab-form__flags {
  display: flex;
  gap: var(--yfe-space-sm);
  align-items: center;
}

.tab-form__flag {
  padding: 0 var(--yfe-space-sm);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-pill);
  color: var(--yfe-color-text-muted);
  font-size: var(--yfe-font-size-sm);
  line-height: var(--yfe-size-control-height-sm);
}

.tab-form__flag--busy {
  color: var(--yfe-color-accent);
}

.tab-form__empty,
.tab-form__field-desc,
.tab-form__tip {
  margin: 0;
  color: var(--yfe-color-text-muted);
  font-size: var(--yfe-font-size-sm);
}

.tab-form__empty {
  padding: var(--yfe-space-lg) 0;
  text-align: center;
}

.tab-form__module {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm);
  padding: var(--yfe-space-md);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-md);
  background: var(--yfe-color-surface);
  min-width: 0;
}

.tab-form__module-name {
  margin: 0;
  color: var(--yfe-color-text);
  font-size: var(--yfe-font-size-lg);
  font-weight: 600;
}

.tab-form__field {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs);
  min-width: 0;
}

.tab-form__field-name {
  color: var(--yfe-color-text);
  font-size: var(--yfe-font-size-md);
}

/* 说明可能很长：截断到 3 行，长内容不撑破面板（逐字保留在 DOM 里，可被检索/复制） */
.tab-form__field-desc {
  display: -webkit-box;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

.tab-form__input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: var(--yfe-space-xs) var(--yfe-space-sm);
  border: var(--yfe-size-border-width) solid var(--yfe-color-border);
  border-radius: var(--yfe-radius-sm);
  background: var(--yfe-color-background);
  color: var(--yfe-color-text);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md);
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-form__input:focus-visible {
  outline: var(--yfe-size-focus-width) solid var(--yfe-color-focus-ring);
  outline-offset: 1px;
}

.tab-form__input:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.tab-form__input--text {
  resize: vertical;
  min-height: var(--yfe-size-control-height);
}

.tab-form__tips {
  margin: 0;
  padding-left: var(--yfe-space-lg);
  color: var(--yfe-color-text-muted);
  font-size: var(--yfe-font-size-sm);
  overflow-wrap: anywhere;
}

.tab-form__footer {
  display: flex;
  justify-content: flex-end;
}
</style>
