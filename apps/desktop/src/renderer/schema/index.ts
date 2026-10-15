/**
 * 页签外壳（W5）的公共出口 —— 侧栏 + 三种通用渲染器 + 三个纯函数层。
 *
 * 用法（外壳/面板都从这里 import，不要各自去点具体文件）：
 * ```ts
 * import { TabSidebar, TabFormView, TabTableView, TabCardView, sidebarGroups } from './schema/index.js'
 * ```
 *
 * ## 纪律
 *
 * - 本目录下的组件都是**纯展示**：吃 props、发事件，不 import `@yfe/client-sdk`、
 *   不碰 `node:`、不直连 SQLite、不自己拼 IPC 方法名（ADR 0006 / D6）。业务接线在外壳（`App.vue`）
 *   与 `app-state.ts` 里做。
 * - `SettingsEntityId` 只从 `schema-table.js` 转出一次：`schema-card.ts` 刻意没有导出同名类型
 *   （两处都导出会让 `export *` 撞 TS2308）。
 * - 《地图》（`GEO_MAPS_TAB`）不进侧栏；编辑器页签要用 `EDITOR_TAB`/`findTab('editor')`，
 *   **`getTab('editor')` 恒为 `undefined`**（与旧版语义一致，见 `@yfe/schema-tabs` 的测试）。
 */

export {
  DATA_DRIVEN_TYPES,
  SIDEBAR_TABS,
  countByType,
  defaultTabId,
  findTab,
  groupTabs,
  isDataDrivenTab,
  panelTabs,
  sidebarGroups,
  visibleTabs,
} from './tab-registry.js'
export type { TabGroupView } from './tab-registry.js'

export { default as TabSidebar } from './TabSidebar.vue'
export { default as TabFormView } from './TabFormView.vue'
export { default as TabTableView } from './TabTableView.vue'
export { default as TabCardView } from './TabCardView.vue'

export { applyFieldInput, formDirtyState, orderedFields, readFormValues } from './schema-form.js'

export {
  cellText,
  cellValue,
  editableCell,
  nextRowName,
  sortRows,
  visibleColumns,
} from './schema-table.js'
export type { SettingsEntityId } from './schema-table.js'

export { cardFieldText, cardFields, cardSubtitle, cardTitle, gridColumns } from './schema-card.js'
export type { CardField } from './schema-card.js'
