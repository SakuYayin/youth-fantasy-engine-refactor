/**
 * `.vue` 单文件组件的类型声明。
 *
 * 首版**不接 vue-tsc**（ADR 0006 已记录）：模板类型检查不在门禁内，
 * 模板正确性靠挂载测试兜底。这里给出最小声明，让 `import App from './App.vue'`
 * 能通过 tsc；真正的 props/emits 类型在组件里用 `defineProps<...>()` 表达，
 * 由测试运行时校验。
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
