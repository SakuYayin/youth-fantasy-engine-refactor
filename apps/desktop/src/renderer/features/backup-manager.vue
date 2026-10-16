<script setup lang="ts">
/**
 * 「备份与恢复」面板（W8-B · 差距报告 L 项 · 契约 §1.2）。
 *
 * 契约：`props: { backup: BackupPort }`、`emits: { close: [] }`。组件只做三件事：
 * 读端口、把结果换算成交给 model 渲染、把 `FeatureResult` 的失败翻成可见文案。
 *
 * 🔴 三条贯穿全文件的规矩：
 * 1. **失败绝不静默**（§0.2）：任何一次 `create/list/verify/restore` 返回
 *    `ok:false`，`message` 必须落到 `actionError` 上渲染出来 —— 局部报错条而不是
 *    toast/alert，因为用户要在同一屏里对照着列表决定下一步。端口违约（抛异常）
 *    也在这里兜住（`thrownMessage`），否则界面会永远停在忙碌态且一句话不说。
 * 2. **`readable:false` 的项照常列出**，只禁用它的校验/恢复按钮并写清理由。
 *    它是迁移器留下的迁移前快照，是磁盘上真实存在的文件；把它藏起来等于让用户
 *    永远不知道自己的数据还在不在。
 * 3. **恢复是「生成预览」而不是「覆盖」**：确认区必须逐字写 RESTORE_NOTICE，
 *    且只有勾了复选框才能点「确认恢复」。这是防误触的唯一一道人工闸门。
 *
 * 状态一律局部 `ref`（§0.5），不碰 `localStorage`、不 import `node:`/契约包。
 */
import { YfeButton, YfePanel } from '@yfe/ui'
import { computed, onMounted, shallowRef } from 'vue'

import type { BackupEntryView, BackupPort } from './types.js'
import type { BackupRow, BackupVerifyView } from './backup-manager-model.js'
import {
  BUTTON_CANCEL,
  BUTTON_CLOSE,
  BUTTON_CONFIRM_RESTORE,
  BUTTON_CREATE,
  BUTTON_RESTORE,
  BUTTON_RETRY,
  BUTTON_VERIFY,
  DEFAULT_BACKUP_LABEL,
  EMPTY_TEXT,
  LABEL_INPUT_PLACEHOLDER,
  LIST_TITLE,
  LOADING_TEXT,
  LOAD_FAILED_TEXT,
  PANEL_TITLE,
  RESTORE_CHECKBOX_LABEL,
  RESTORE_NOTICE,
  buildBackupRows,
  failureText,
  formatCreateResult,
  formatRestoreResult,
  thrownMessage,
  toBackupVerifyView,
} from './backup-manager-model.js'

const props = defineProps<{
  backup: BackupPort
}>()

const emit = defineEmits<{
  close: []
}>()

/** 端口返回的原始列表（排序与文案换算都在 `rows` 里，这里只存事实）。 */
const entries = shallowRef<readonly BackupEntryView[]>([])

/** 首次加载中：显示「加载中…」而不是先闪一下空态。 */
const loading = shallowRef<boolean>(true)
/** 列表读取失败：此时**不能**显示空态（「还没有备份」是假话）。 */
const loadFailed = shallowRef<boolean>(false)

/** 最近一次失败的可见文案；成功一次即清空。空串 = 没有错误，不占版面。 */
const actionError = shallowRef<string>('')
/** 最近一次「立即备份」的成功回执（路径 + 体积 + 耗时）。 */
const createNotice = shallowRef<string>('')

/** 标签输入框的当前值；留空时提交 `DEFAULT_BACKUP_LABEL`。 */
const labelDraft = shallowRef<string>('')

/** 进行中的单个操作（同一时刻只允许一件，避免同一路径被点两次）。 */
const busyKey = shallowRef<string>('')
const creating = shallowRef<boolean>(false)

/** 正在展开内联确认区的备份路径（`null` = 都没展开）。 */
const confirmPath = shallowRef<string | null>(null)
/** 确认复选框是否已勾选；切换确认对象时**重置**，不复用上一次的勾选。 */
const confirmed = shallowRef<boolean>(false)

/** 校验结果与恢复结果按备份路径累积（同一份可以反复校验，取最新一次）。 */
const verifyMap = shallowRef<ReadonlyMap<string, BackupVerifyView>>(new Map())
const restoreMap = shallowRef<ReadonlyMap<string, string>>(new Map())

const rows = computed<readonly BackupRow[]>(() => buildBackupRows(entries.value))

/** 列表行视图：把行 + 该行的校验/恢复结果 + 展开态一次算好，模板只做插值。 */
interface BackupItemView {
  readonly index: number
  readonly row: BackupRow
  readonly verify: BackupVerifyView | null
  readonly restoreText: string | null
  readonly confirming: boolean
  readonly verifying: boolean
  readonly restoring: boolean
}

const items = computed<readonly BackupItemView[]>(() =>
  rows.value.map((row, index) => ({
    index,
    row,
    verify: verifyMap.value.get(row.backupPath) ?? null,
    restoreText: restoreMap.value.get(row.backupPath) ?? null,
    confirming: confirmPath.value === row.backupPath,
    verifying: busyKey.value === `verify:${row.backupPath}`,
    restoring: busyKey.value === `restore:${row.backupPath}`,
  })),
)

function setVerifyResult(backupPath: string, view: BackupVerifyView): void {
  const next = new Map(verifyMap.value)
  next.set(backupPath, view)
  verifyMap.value = next
}

function setRestoreResult(backupPath: string, text: string): void {
  const next = new Map(restoreMap.value)
  next.set(backupPath, text)
  restoreMap.value = next
}

/** 读列表。失败时**保留**错误文案并让列表区显示重试，而不是装作空目录。 */
async function load(): Promise<void> {
  loading.value = true
  try {
    const result = await props.backup.list()
    if (result.ok) {
      entries.value = result.value
      loadFailed.value = false
    } else {
      loadFailed.value = true
      actionError.value = failureText(result)
    }
  } catch (error) {
    // 契约说端口不抛；真抛了也必须说话，否则界面永远停在「加载中…」。
    loadFailed.value = true
    actionError.value = thrownMessage(error)
  } finally {
    loading.value = false
  }
}

function onLabelInput(event: Event): void {
  labelDraft.value = (event.target as HTMLInputElement).value
}

/** 「立即备份」：提交标签（留空用默认标签），成功显示路径/体积/耗时后刷新列表。 */
async function onCreate(): Promise<void> {
  if (creating.value) return
  creating.value = true
  actionError.value = ''
  try {
    const typed = labelDraft.value.trim()
    const result = await props.backup.create(typed === '' ? DEFAULT_BACKUP_LABEL : typed)
    if (result.ok) {
      createNotice.value = formatCreateResult(result.value)
      // 新备份要立刻出现在列表里，否则用户会以为没建成。
      await load()
    } else {
      createNotice.value = ''
      actionError.value = failureText(result)
    }
  } catch (error) {
    createNotice.value = ''
    actionError.value = thrownMessage(error)
  } finally {
    creating.value = false
  }
}

async function onVerify(row: BackupRow): Promise<void> {
  if (!row.restorable) return
  if (busyKey.value !== '') return
  busyKey.value = `verify:${row.backupPath}`
  actionError.value = ''
  try {
    const result = await props.backup.verify(row.backupPath)
    if (result.ok) {
      setVerifyResult(row.backupPath, toBackupVerifyView(result.value))
    } else {
      actionError.value = failureText(result)
    }
  } catch (error) {
    actionError.value = thrownMessage(error)
  } finally {
    busyKey.value = ''
  }
}

/** 「恢复」：只展开/收起内联确认区，**不**直接调端口（防误触）。 */
function onRestoreClick(row: BackupRow): void {
  if (!row.restorable) return
  if (confirmPath.value === row.backupPath) {
    confirmPath.value = null
    confirmed.value = false
    return
  }
  confirmPath.value = row.backupPath
  confirmed.value = false
  actionError.value = ''
}

function onConfirmChange(event: Event): void {
  confirmed.value = (event.target as HTMLInputElement).checked
}

/** 「确认恢复」：勾选是唯一放行条件（不依赖 DOM 的 disabled）。 */
async function onConfirmRestore(row: BackupRow): Promise<void> {
  if (!confirmed.value) return
  if (busyKey.value !== '') return
  busyKey.value = `restore:${row.backupPath}`
  actionError.value = ''
  try {
    const result = await props.backup.restore(row.backupPath)
    if (result.ok) {
      setRestoreResult(row.backupPath, formatRestoreResult(result.value))
      confirmPath.value = null
      confirmed.value = false
    } else {
      actionError.value = failureText(result)
    }
  } catch (error) {
    actionError.value = thrownMessage(error)
  } finally {
    busyKey.value = ''
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <YfePanel class="backup-manager" data-testid="backup-manager" :title="PANEL_TITLE">
    <div class="backup-manager__body">
      <!-- ==================== 顶部操作 ==================== -->
      <div class="backup-manager__toolbar">
        <label class="backup-manager__field">
          <span class="backup-manager__label">备份标签</span>
          <input
            class="backup-manager__input"
            type="text"
            data-testid="backup-label"
            :placeholder="LABEL_INPUT_PLACEHOLDER"
            :value="labelDraft"
            @input="onLabelInput"
          />
        </label>
        <YfeButton
          data-testid="backup-create"
          :label="BUTTON_CREATE"
          variant="primary"
          :loading="creating"
          @click="onCreate"
        />
        <YfeButton data-testid="backup-close" :label="BUTTON_CLOSE" @click="emit('close')" />
      </div>

      <!-- ==================== 回执 ==================== -->
      <p
        v-if="createNotice !== ''"
        class="backup-manager__notice"
        data-testid="backup-create-result"
        role="status"
      >
        {{ createNotice }}
      </p>
      <p
        v-if="actionError !== ''"
        class="backup-manager__notice backup-manager__notice--failed"
        data-testid="backup-error"
        role="alert"
      >
        {{ actionError }}
      </p>

      <!-- ==================== 列表 ==================== -->
      <section class="backup-manager__section">
        <h3 class="backup-manager__heading">{{ LIST_TITLE }}</h3>

        <p v-if="loading" class="backup-manager__hint" data-testid="backup-loading">
          {{ LOADING_TEXT }}
        </p>

        <div v-else-if="loadFailed" class="backup-manager__empty" data-testid="backup-load-failed">
          <span>{{ LOAD_FAILED_TEXT }}</span>
          <YfeButton data-testid="backup-retry" :label="BUTTON_RETRY" @click="load" />
        </div>

        <p v-else-if="items.length === 0" class="backup-manager__empty" data-testid="backup-empty">
          {{ EMPTY_TEXT }}
        </p>

        <ul v-else class="backup-manager__list">
          <li
            v-for="item in items"
            :key="item.row.backupPath"
            class="backup-manager__item"
            :data-testid="`backup-entry-${item.index}`"
          >
            <div class="backup-manager__item-head">
              <span class="backup-manager__item-label" data-testid="backup-field-label">
                {{ item.row.label }}
              </span>
              <span class="backup-manager__meta" data-testid="backup-field-created">
                {{ item.row.createdAtText }}
              </span>
              <span class="backup-manager__meta" data-testid="backup-field-size">
                {{ item.row.sizeText }}
              </span>
              <span
                class="backup-manager__status"
                :class="{ 'backup-manager__status--unreadable': !item.row.restorable }"
                data-testid="backup-field-status"
              >
                {{ item.row.statusText }}
              </span>
            </div>

            <p class="backup-manager__path" data-testid="backup-field-path">
              {{ item.row.backupPath }}
            </p>

            <!-- 禁用理由：灰按钮旁边必须有一句「为什么」 -->
            <p
              v-if="item.row.disabledReason !== null"
              class="backup-manager__reason"
              data-testid="backup-field-reason"
            >
              {{ item.row.disabledReason }}
            </p>

            <div class="backup-manager__actions">
              <YfeButton
                :data-testid="`backup-verify-${item.index}`"
                :label="BUTTON_VERIFY"
                :disabled="!item.row.restorable"
                :loading="item.verifying"
                @click="onVerify(item.row)"
              />
              <YfeButton
                :data-testid="`backup-restore-${item.index}`"
                :label="BUTTON_RESTORE"
                variant="danger"
                :disabled="!item.row.restorable"
                @click="onRestoreClick(item.row)"
              />
            </div>

            <!-- 校验结果：完整性 / 结构版本 / 是否需要迁移 -->
            <div
              v-if="item.verify !== null"
              class="backup-manager__result"
              data-testid="backup-verify-result"
            >
              <span data-testid="backup-verify-integrity">{{ item.verify.integrityText }}</span>
              <span data-testid="backup-verify-schema">{{ item.verify.schemaVersionText }}</span>
              <span
                class="backup-manager__migration"
                :class="{ 'backup-manager__migration--needed': item.verify.needsMigration }"
                data-testid="backup-verify-migration"
              >
                {{ item.verify.migrationText }}
              </span>
            </div>

            <!-- 内联确认区：只有勾选后「确认恢复」才可用 -->
            <div
              v-if="item.confirming"
              class="backup-manager__confirm"
              data-testid="backup-confirm"
            >
              <p class="backup-manager__confirm-text" data-testid="backup-confirm-text">
                {{ RESTORE_NOTICE }}
              </p>
              <label class="backup-manager__checkbox">
                <input
                  type="checkbox"
                  :data-testid="`backup-confirm-check-${item.index}`"
                  :checked="confirmed"
                  @change="onConfirmChange"
                />
                <span>{{ RESTORE_CHECKBOX_LABEL }}</span>
              </label>
              <div class="backup-manager__actions">
                <YfeButton
                  :data-testid="`backup-confirm-ok-${item.index}`"
                  :label="BUTTON_CONFIRM_RESTORE"
                  variant="primary"
                  :disabled="!confirmed"
                  :loading="item.restoring"
                  @click="onConfirmRestore(item.row)"
                />
                <YfeButton
                  :data-testid="`backup-confirm-cancel-${item.index}`"
                  :label="BUTTON_CANCEL"
                  @click="onRestoreClick(item.row)"
                />
              </div>
            </div>

            <!-- 恢复结果：只显示预览目标路径（在用的库没被动过） -->
            <p
              v-if="item.restoreText !== null"
              class="backup-manager__restored"
              data-testid="backup-restore-result"
              role="status"
            >
              {{ item.restoreText }}
            </p>
          </li>
        </ul>
      </section>
    </div>
  </YfePanel>
</template>

<style scoped>
.backup-manager__body {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-lg, 16px);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: var(--yfe-font-family);
  font-size: var(--yfe-font-size-md, 14px);
}

.backup-manager__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
}

.backup-manager__field {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__label {
  color: var(--yfe-color-text-muted, #8b93a7);
}

.backup-manager__input {
  box-sizing: border-box;
  height: var(--yfe-size-control-height, 32px);
  padding: 0 var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-background, #111318);
  color: var(--yfe-color-text, #e6e8ee);
  font-family: inherit;
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__input:focus-visible {
  outline: var(--yfe-size-focus-width, 2px) solid var(--yfe-color-focus-ring, #5aa9ff);
}

.backup-manager__section {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
}

.backup-manager__heading {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
  font-weight: var(--yfe-font-weight-bold, 700);
  letter-spacing: 0.04em;
  color: var(--yfe-color-text-muted, #8b93a7);
}

.backup-manager__list {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}

.backup-manager__item {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-xs, 4px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) solid var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
  background: var(--yfe-color-surface-raised, #20242e);
}

.backup-manager__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--yfe-space-sm, 8px);
}

.backup-manager__item-label {
  font-weight: var(--yfe-font-weight-medium, 500);
}

.backup-manager__meta {
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  font-variant-numeric: tabular-nums;
}

.backup-manager__status {
  padding: 0 var(--yfe-space-xs, 4px);
  border-radius: var(--yfe-radius-pill, 999px);
  background: var(--yfe-color-accent, #5aa9ff);
  color: var(--yfe-color-text-on-accent, #0b1016);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__status--unreadable {
  background: var(--yfe-color-danger, #ff7b72);
}

.backup-manager__path {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
  word-break: break-all;
}

.backup-manager__reason {
  margin: 0;
  color: var(--yfe-color-warning, #e8b96b);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
}

.backup-manager__result {
  display: flex;
  flex-wrap: wrap;
  gap: var(--yfe-space-sm, 8px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__migration--needed {
  color: var(--yfe-color-warning, #e8b96b);
}

.backup-manager__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border-strong, #47506b);
  border-radius: var(--yfe-radius-md, 6px);
}

.backup-manager__confirm-text {
  margin: 0;
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--yfe-space-xs, 4px);
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__restored {
  margin: 0;
  color: var(--yfe-color-success, #5ddc9a);
  font-size: var(--yfe-font-size-sm, 12px);
  word-break: break-all;
}

.backup-manager__hint,
.backup-manager__empty {
  margin: 0;
  color: var(--yfe-color-text-muted, #8b93a7);
  font-size: var(--yfe-font-size-sm, 12px);
}

.backup-manager__empty {
  display: flex;
  align-items: center;
  gap: var(--yfe-space-sm, 8px);
  padding: var(--yfe-space-sm, 8px) var(--yfe-space-md, 12px);
  border: var(--yfe-size-border-width, 1px) dashed var(--yfe-color-border, #2a2f3a);
  border-radius: var(--yfe-radius-md, 6px);
}

.backup-manager__notice {
  margin: 0;
  padding: var(--yfe-space-xs, 4px) var(--yfe-space-sm, 8px);
  border-radius: var(--yfe-radius-sm, 4px);
  background: var(--yfe-color-surface-raised, #20242e);
  color: var(--yfe-color-success, #5ddc9a);
  font-size: var(--yfe-font-size-sm, 12px);
  word-break: break-all;
}

.backup-manager__notice--failed {
  color: var(--yfe-color-danger, #ff7b72);
}
</style>
