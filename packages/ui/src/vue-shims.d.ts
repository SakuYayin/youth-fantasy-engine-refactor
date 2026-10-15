/**
 * `.vue` 对 tsc 的声明（ADR 0006 D1）。
 *
 * `packages/ui/tsconfig.json` 只收 src 下的 `.ts`（含本文件），`.vue` 不进
 * tsc 门禁，模板正确性靠 `@vue/test-utils` 挂载测试兜底；但没有这份声明，
 * `index.ts` 里那几个 `export { default as YfeXxx } from './components/*.vue'`
 * 会直接红掉。
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
