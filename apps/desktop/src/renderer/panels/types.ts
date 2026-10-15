/**
 * 面板层契约（W7）。
 *
 * 权威文档：`docs/接口冻结-面板层.md`。
 *
 * 21 个「专属面板」共享同一份 props：`{ state, tab }`。
 * `state` 是**唯一**的数据与持久化入口（渲染层禁止直连 IPC/SQLite/网络）；
 * `tab` 是 `@yfe/schema-tabs` 的页签元数据（name/description/tips/type）。
 *
 * 本文件由 Lead 独占，面板智能体只读。
 */

import type { TabDef } from '@yfe/schema-tabs'

import type { AppState } from '../app-state.js'

/** 所有专属面板的 props（逐字遵守，不要各自加必填 props）。 */
export interface PanelProps {
  readonly state: AppState
  readonly tab: TabDef
}

/**
 * 面板注册表的键 = `TabDef.id`。
 *
 * 未登记 id 由外壳渲染 `_placeholder.vue`（明确写「未实现」），
 * **不允许**静默空白页——用户统一验收时要能一眼看出哪些还没做。
 */
export type PanelComponent = unknown
