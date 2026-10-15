/**
 * `@yfe/ui` 入口（ADR 0006 D3）。
 *
 * 只导出基础组件与设计令牌：没有业务逻辑、没有请求、没有 `@yfe/contracts` 依赖。
 * 令牌同时从 `@yfe/ui/tokens` 子路径导出（`package.json` 的 exports），
 * 这里再导一次是为了「一个 import 拿全」的便利。
 */

export { default as YfeButton } from './components/YfeButton.vue'
export { default as YfeDialog } from './components/YfeDialog.vue'
export { default as YfePanel } from './components/YfePanel.vue'
export { default as YfeStatusPill } from './components/YfeStatusPill.vue'
export { default as YfeToolbar } from './components/YfeToolbar.vue'
export { default as YfeTree } from './components/YfeTree.vue'

export {
  DESIGN_TOKEN_VARIABLE_PREFIX,
  designTokenVariables,
  designTokens,
  parsePx,
  tokensToCssVariables,
} from './tokens.js'
export type {
  DesignTokenVariables,
  DesignTokens,
  YfeColorTokens,
  YfeFontTokens,
  YfeLayerTokens,
  YfeRadiusTokens,
  YfeSizeTokens,
  YfeSpaceTokens,
} from './tokens.js'
export type { YfeSaveStatus, YfeTreeNode } from './types.js'
