/**
 * `.vue` 单文件组件的类型声明。
 *
 * 供普通 tsc 测试入口解析 .vue 导入；桌面和 UI 包使用 vue-tsc 检查模板，
 * 挂载测试进一步验证运行时接线。
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  /**
   * 普通 tsc 看到的 `.vue` 组件（vue-tsc 会读到真实 props，本声明只服务
   * `tsconfig.tests.json` 这类纯 tsc 入口）。
   *
   * 🔴 为什么是 `DefineComponent<{}, {}, unknown>`：props 写成 `Record<string, unknown>`
   *    会让组件**不接受**具名 props（`Component<PanelProps>` 这类断言全部 TS2322），
   *    因为具名 props 类型并不带索引签名。写成空对象表示「props 未知」，
   *    需要精确 props 的地方一律由 vue-tsc 把关。
   */
  const component: DefineComponent<{}, {}, unknown>
  export default component
}
