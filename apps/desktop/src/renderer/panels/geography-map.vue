<script setup lang="ts">
/**
 * 地图编辑面板（geography-map，世界构建组）。
 *
 * 本期两层（完整画布编辑器/绘制/标记/底图留待后续批次）：
 * ① 数据层 —— 《地图》（`GEO_MAPS_TAB`，id `geomaps`）的地图清单表：挂载时
 *    `loadSettingsEntities`，新建/更新走 `submitSettingsEntity`；删除/重排
 *    应用层还没有对应用例，只显回执不假装成功（接口冻结 §2/§3）。
 * ② 可视化层 —— 每张地图一条「名称 + 每格公里」色块条示意（预览版简化视图）。
 *
 * 纯逻辑（映射、文案、常量）在 `./geography-map-model.js`，这里只做渲染与调用。
 */

import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'

import { GEO_MAPS_TAB } from '@yfe/schema-tabs'
import { designTokenVariables } from '@yfe/ui'

import type { SettingsEntityView } from '../app-state.js'
import { nextRowName, TabTableView } from '../schema/index.js'
import type { SettingsEntityId } from '../schema/index.js'

import {
  LOAD_FAILED_NOTICE,
  SKETCH_EMPTY_NOTICE,
  SKETCH_PREVIEW_NOTICE,
  SKETCH_TITLE,
  deletePendingNotice,
  initialValuesForCreate,
  mapRowsOf,
  newCreateKey,
  reorderPendingNotice,
  rowsToSketches,
  submitFailureNotice,
  updateMissingRowNotice,
} from './geography-map-model.js'
import type { MapSketch } from './geography-map-model.js'
import type { PanelProps } from './types.js'

const props = defineProps<PanelProps>()

/** 外壳快照（唯一数据源；面板只读 + 订阅，不绕过 state）。 */
const snapshot = shallowRef(props.state.getSnapshot())

let unsubscribe: (() => void) | null = null

/** 一次性回执（新建/更新失败、删除/重排未接入）。 */
const notice = ref<string | null>(null)

/** 地图清单载入失败（持续状态，直到面板重挂载重试）。 */
const loadFailed = ref(false)

/** 面板行：只取《地图》模板的未删行（快照里的 settingsEntities 是外壳全局的，防御性过滤）。 */
const rows = computed<readonly SettingsEntityView[]>(() => mapRowsOf(snapshot.value.settingsEntities))

/** 行 → 简化示意（顺序与清单表一致：orderKey 升序）。 */
const sketches = computed<readonly MapSketch[]>(() => rowsToSketches(rows.value))

/** 设定通道读/写在途（载入期间表格进 busy 态，丢编辑事件）。 */
const busy = computed<boolean>(() => snapshot.value.settingsLoading)

// ---------- ① 数据层：载入 / 新建 / 更新 / 删除 / 重排 ----------

async function loadRows(): Promise<void> {
  const ok = await props.state.loadSettingsEntities({ schemaTemplateId: GEO_MAPS_TAB.id })
  loadFailed.value = !ok
}

onMounted(() => {
  // 先订阅再 await 载入：载入完成的 emit 一定被捕获（接口冻结 §3 持久化契约）。
  unsubscribe = props.state.subscribe((next) => {
    snapshot.value = next
  })
  void loadRows()
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

/** 新建会话的幂等键：一次「+」一个稳定键（失败重试不会建出两张图）。 */
let createKey: string | null = null

async function onCreate(): Promise<void> {
  const suggested = nextRowName(GEO_MAPS_TAB, rows.value)
  createKey ??= newCreateKey(GEO_MAPS_TAB.id)
  const result = await props.state.submitSettingsEntity({
    entityId: null,
    schemaTemplateId: GEO_MAPS_TAB.id,
    name: suggested,
    values: initialValuesForCreate(suggested),
    expectedRevision: null,
    idempotencyKey: createKey,
  })
  if (result.ok) {
    // submitSettingsEntity 成功时已自行合并进快照并选中，这里不重复 reload/select。
    createKey = null
    return
  }
  notice.value = submitFailureNotice(result.code, result.message)
}

/**
 * 更新串行链：设定通道不串行写入，连打两键并发提交会拿同一个旧 revision 互撞乐观锁；
 * 串行 + 执行时重读 revision 消除该竞态（busy 期间 TabTableView 本就丢事件，链是兜底）。
 */
let updateChain: Promise<void> = Promise.resolve()

function onUpdate(id: SettingsEntityId, values: Record<string, unknown>): void {
  updateChain = updateChain
    .then(() => {
      return submitUpdate(id, values)
    })
    .catch(() => {
      // 契约上 submitSettingsEntity 不抛；这里只保证串行链不断。
    })
}

async function submitUpdate(id: SettingsEntityId, values: Record<string, unknown>): Promise<void> {
  const current = snapshot.value.settingsEntities.find((row) => row.id === id)
  if (current === undefined) {
    notice.value = updateMissingRowNotice(id)
    return
  }
  const result = await props.state.submitSettingsEntity({
    entityId: id,
    schemaTemplateId: GEO_MAPS_TAB.id,
    name: current.name,
    values,
    expectedRevision: current.revision,
  })
  if (result.ok) return
  notice.value = submitFailureNotice(result.code, result.message)
}

/** 删除只显回执：应用层的删除用例还没接入，不许假装成功。 */
function onDelete(id: SettingsEntityId): void {
  notice.value = deletePendingNotice(id)
}

/** 重排只显回执：orderKey 是 BINARY 逐字符比较，由应用层生成，面板不自己拼。 */
function onReorder(id: SettingsEntityId, beforeId: SettingsEntityId | null): void {
  notice.value = reorderPendingNotice(id, beforeId)
}
</script>

<template>
  <section class="geography-map" :style="designTokenVariables">
    <p v-if="notice !== null" class="geography-map__notice" data-testid="geography-map-notice">
      {{ notice }}
    </p>

    <!-- ② 可视化层：简化示意（预览版） -->
    <div class="geography-map__sketch" data-testid="geography-map-sketch">
      <div class="geography-map__sketch-head">
        <h2 class="geography-map__sketch-title" data-testid="geography-map-sketch-title">
          {{ SKETCH_TITLE }}
        </h2>
        <span class="geography-map__sketch-preview" data-testid="geography-map-sketch-preview">
          {{ SKETCH_PREVIEW_NOTICE }}
        </span>
      </div>
      <p v-if="loadFailed" class="geography-map__load-notice" data-testid="geography-map-load-notice">
        {{ LOAD_FAILED_NOTICE }}
      </p>
      <p
        v-else-if="sketches.length === 0"
        class="geography-map__sketch-empty"
        data-testid="geography-map-sketch-empty"
      >
        {{ SKETCH_EMPTY_NOTICE }}
      </p>
      <ul v-else class="geography-map__sketch-list" data-testid="geography-map-sketch-list">
        <li
          v-for="sketch in sketches"
          :key="sketch.id"
          class="geography-map__sketch-item"
          :data-testid="`geography-map-sketch-item-${sketch.id}`"
        >
          <span class="geography-map__sketch-name" data-testid="geography-map-sketch-name">
            {{ sketch.name }}
          </span>
          <span class="geography-map__sketch-scale" data-testid="geography-map-sketch-scale">
            {{ sketch.kmLabel }}
          </span>
          <span class="geography-map__sketch-bar" aria-hidden="true">
            <!-- 色块色是数据可视化用色（由地图名稳定散列），不是界面 chrome -->
            <span
              v-for="cell in sketch.cells"
              :key="cell"
              class="geography-map__sketch-cell"
              :style="{ background: sketch.color }"
            />
          </span>
        </li>
      </ul>
    </div>

    <!-- ① 数据层：地图清单表（GEO_MAPS_TAB） -->
    <TabTableView
      :tab="GEO_MAPS_TAB"
      :rows="rows"
      :busy="busy"
      @create="onCreate"
      @update="onUpdate"
      @delete="onDelete"
      @reorder="onReorder"
    />
  </section>
</template>

<style scoped>
.geography-map {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif);
  font-size: var(--yfe-font-size-md, 14px);
  line-height: var(--yfe-font-line-height, 1.7);
}

.geography-map__notice {
  margin: 0;
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-warning, #e8b96b);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-warning, #e8b96b);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__sketch {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-md, 12px);
  padding: var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-lg, 10px);
  background: var(--yfe-color-surface, #1a1d25);
}

.geography-map__sketch-head {
  display: flex;
  align-items: baseline;
  gap: var(--yfe-space-sm, 8px);
  flex-wrap: wrap;
}

.geography-map__sketch-title {
  margin: 0;
  color: var(--yfe-color-text, #e6e8ee);
  font-size: var(--yfe-font-size-lg, 16px);
  font-weight: var(--yfe-font-weight-medium, 500);
}

.geography-map__sketch-preview {
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-accent, #5b8cff);
  border-radius: var(--yfe-radius-pill, 999px);
  color: var(--yfe-color-accent, #5b8cff);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__load-notice,
.geography-map__sketch-empty {
  margin: 0;
  padding: var(--yfe-space-xl, 24px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__sketch-list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.geography-map__sketch-item {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-md, 12px);
}

.geography-map__sketch-name {
  min-width: 6em;
  color: var(--yfe-color-text, #e6e8ee);
  overflow-wrap: anywhere;
}

.geography-map__sketch-scale {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.geography-map__sketch-bar {
  display: inline-flex;
  flex: 1;
  gap: var(--yfe-space-xs, 4px);
}

.geography-map__sketch-cell {
  flex: 1;
  max-width: 28px;
  height: var(--yfe-size-control-height-sm, 24px);
  border-radius: var(--yfe-radius-sm, 4px);
}
</style>
