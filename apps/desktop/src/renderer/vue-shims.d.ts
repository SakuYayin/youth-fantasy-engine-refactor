/**
 * `.vue` 单文件组件的类型声明。
 *
 * 供普通 tsc 测试入口解析 .vue 导入；桌面和 UI 包使用 vue-tsc 检查模板，
 * 挂载测试进一步验证运行时接线。
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
