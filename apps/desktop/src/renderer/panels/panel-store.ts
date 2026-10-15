/**
 * 面板状态存储：把「一个专属面板的持久化数据」收敛成一个小状态机。
 *
 * ## 为什么复用 `settings_entities` 而不是新开一张表
 *
 * 面板数据是**每作品一份的可变 JSON**，`settings_entities` 已经具备全部所需语义：
 * `(workspace, project, schema_template_id)` 定位、`values_json` 存 JSON、
 * `revision` + `revision_seq` 做乐观锁、软删、以及 W6 打通的 `loadSettingsEntities` /
 * `submitSettingsEntity` 两个用例。用 `schemaTemplateId = 'panel:<tabId>'` 作命名空间后，
 * **零后端改动**即可让 21 个面板并发开发（不必为每个面板新增 IPC 方法）。
 *
 * 代价（已记台账）：面板状态行与用户可见的设定实体同表。数据驱动页签按自己的
 * `schemaTemplateId` 过滤，看不到它们；只有「跨作品列出整个工作区」时会看到，
 * 因此这里用 `panel:` 前缀作为可识别标记。
 *
 * ## 三条纪律
 *
 * 1. **保存失败不丢本地数据**：`error` 置位、`data` 保持用户改过的内容，`dirty` 仍为 true。
 * 2. **同一 store 内串行**：`save()` 在飞时再次调用只登记「待保存」，不并发发两个请求。
 * 3. **迟到结果不覆盖新数据**：每次保存带自增 `sequence`，只有当前在飞序号的结果会被采纳。
 */

import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'

import type { AppState, SettingsEntityView } from '../app-state.js'

/** 面板状态的模板命名空间前缀。 */
export const PANEL_TEMPLATE_PREFIX = 'panel:'
/** 面板状态行的显示名（用户在设定实体列表里若看到会见到它）。 */
export const PANEL_STATE_NAME = '面板状态'

export function panelTemplateId(tabId: string): string {
  return `${PANEL_TEMPLATE_PREFIX}${tabId}`
}

/** 判断某个设定实体是否是面板状态行（供「跨作品列表」过滤用）。 */
export function isPanelTemplateId(templateId: string): boolean {
  return templateId.startsWith(PANEL_TEMPLATE_PREFIX)
}

export interface PanelStoreOptions {
  /** 自动保存防抖（毫秒）。`0` = 只手动 `save()`。默认 1500。 */
  readonly autoSaveMs?: number
}

export interface PanelStore<T> {
  readonly data: ShallowRef<T>
  readonly loading: Ref<boolean>
  readonly saving: Ref<boolean>
  readonly dirty: Ref<boolean>
  readonly error: Ref<string | null>
  /** 已落库版本（新建前为 null）。 */
  readonly revision: Ref<string | null>
  load(): Promise<void>
  /** 浅合并并标脏（对象类型的 data 才有意义）。 */
  patch(partial: Partial<T>): void
  /** 整体替换并标脏。 */
  set(next: T): void
  save(): Promise<boolean>
  dispose(): void
}

/**
 * 把库里的 `values` 合并到默认值上。
 *
 * 旧版数据里可能缺字段（版本升级后新增的默认值），因此**默认值优先补齐、库值覆盖**；
 * 库里多出来的未知键保留（用户数据不丢）。
 */
export function mergePanelValues<T extends Record<string, unknown>>(
  defaults: T,
  stored: Readonly<Record<string, unknown>>,
): T {
  return { ...defaults, ...stored } as T
}

export function createPanelStore<T extends Record<string, unknown>>(
  state: AppState,
  tabId: string,
  defaults: T,
  options: PanelStoreOptions = {},
): PanelStore<T> {
  const autoSaveMs = options.autoSaveMs ?? 1500
  const templateId = panelTemplateId(tabId)

  const data = shallowRef<T>({ ...defaults }) as ShallowRef<T>
  const loading = ref(false)
  const saving = ref(false)
  const dirty = ref(false)
  const error = ref<string | null>(null)
  const revision = ref<string | null>(null)

  let entityId: string | null = null
  /** 已发出但还没结算的保存序号。 */
  let inFlightSequence: number | null = null
  /** 在飞期间又变了 → 结算后补一次。 */
  let pendingAgain = false
  let nextSequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule(): void {
    if (disposed || autoSaveMs <= 0) return
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      void save()
    }, autoSaveMs)
  }

  function markDirty(): void {
    dirty.value = true
    schedule()
  }

  async function load(): Promise<void> {
    if (disposed) return
    loading.value = true
    error.value = null
    try {
      await state.loadSettingsEntities({ schemaTemplateId: templateId })
      const rows: readonly SettingsEntityView[] = state.getSnapshot().settingsEntities
      const mine = rows.filter((row) => row.schemaTemplateId === templateId && !row.deleted)
      const first = mine[0]
      if (first === undefined) {
        entityId = null
        revision.value = null
        data.value = { ...defaults } as T
      } else {
        entityId = first.id
        revision.value = first.revision
        data.value = mergePanelValues(defaults, first.values)
      }
      dirty.value = false
    } catch (thrown) {
      error.value = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      loading.value = false
    }
  }

  function patch(partial: Partial<T>): void {
    if (disposed) return
    data.value = { ...data.value, ...partial }
    markDirty()
  }

  function set(next: T): void {
    if (disposed) return
    data.value = next
    markDirty()
  }

  async function save(): Promise<boolean> {
    if (disposed) return false
    cancelTimer()
    if (inFlightSequence !== null) {
      // 已有保存在飞：只登记「结算后补一次」，不并发发第二个请求。
      pendingAgain = true
      return false
    }
    const sequence = ++nextSequence
    inFlightSequence = sequence
    saving.value = true
    error.value = null
    const payload = data.value
    try {
      const result = await state.submitSettingsEntity({
        entityId,
        schemaTemplateId: templateId,
        name: PANEL_STATE_NAME,
        values: payload,
        expectedRevision: entityId === null ? null : revision.value,
        idempotencyKey: `panel:${tabId}:${sequence}`,
      })
      if (sequence !== inFlightSequence) return false // 迟到结果：丢弃
      if (result.ok) {
        entityId = result.entityId
        revision.value = result.revision
        // 只有「这次请求提交的内容」与当前数据一致时才清脏。
        dirty.value = data.value !== payload
        return true
      }
      error.value = `${result.code}：${result.message}`
      dirty.value = true
      return false
    } catch (thrown) {
      if (sequence !== inFlightSequence) return false
      error.value = thrown instanceof Error ? thrown.message : String(thrown)
      dirty.value = true
      return false
    } finally {
      if (sequence === inFlightSequence) {
        inFlightSequence = null
        saving.value = false
        if (pendingAgain && !disposed) {
          pendingAgain = false
          void save()
        }
      }
    }
  }

  function dispose(): void {
    disposed = true
    cancelTimer()
  }

  return { data, loading, saving, dirty, error, revision, load, patch, set, save, dispose }
}
