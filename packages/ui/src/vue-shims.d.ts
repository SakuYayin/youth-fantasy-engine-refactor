/**
 * `.vue` 对 tsc 的声明（ADR 0006 D1）。
 *
 * 普通 tsc 测试入口用此声明解析 .vue；UI 和桌面包另外用 vue-tsc 检查真实模板，
 * 并用挂载测试验证运行时行为。
 *
 * 注意：本注释里不能写 `src` 后跟 `/**` 那种 glob 字面量——里面的 `*` 加 `/`
 * 会提前把块注释关掉，整个文件被当成代码解析（这是真踩过的坑）。
 *
 * 泛型用 `Record<string, unknown>` 而不是 `any`：props 在调用侧必须显式收窄，
 * 不能靠 `any` 蒙过去（真实 props 类型以各组件的 `defineProps<{...}>()` 为准）。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
