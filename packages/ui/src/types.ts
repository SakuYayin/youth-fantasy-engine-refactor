/**
 * `@yfe/ui` 的公开类型面（ADR 0006 D3）。
 *
 * 这里**只有渲染层需要的基础类型**：`@yfe/ui` 不 import `@yfe/contracts`，
 * 业务契约（文档、项目、保存请求…）由调用方自己转换后传进来。
 */

/**
 * 章节树节点。
 *
 * 层级用扁平的 `depth` 表达（不是嵌套 children）：调用方通常已经有一份排序好的
 * 扁平列表，再让它递归嵌套只是多一次无意义的转换；展开态由 `YfeTree` 的
 * `expandedIds` 决定，节点本身不持有 UI 状态。
 */
export interface YfeTreeNode {
  readonly id: string
  readonly label: string
  /** 层级，根为 0。`YfeTree` 按它乘缩进步长。 */
  readonly depth: number
  /** 是否有子节点：决定是否渲染展开箭头、是否响应左右方向键。 */
  readonly hasChildren: boolean
  /** 已删除：仍占位（撤销删除前不消失），加删除线。 */
  readonly deleted?: boolean
  /** 当前打开的节点：加标记，与 `selectedId` 高亮是两件事。 */
  readonly current?: boolean
}

/**
 * 保存状态（ADR 0006 D5 的六态）。
 *
 * 中文文案只在 `YfeStatusPill` 内部映射一次，别处不得再自造一套说法——
 * 否则「保存失败」和「同步失败」会同时出现在界面上。
 */
export type YfeSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'offline'
