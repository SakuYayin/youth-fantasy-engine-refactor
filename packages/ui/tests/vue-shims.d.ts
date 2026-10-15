/**
 * 测试程序里的 `.vue` 声明。
 *
 * `tsconfig.tests.json` 只 include `packages/*/tests/**\/*.ts`，不会带上
 * `packages/ui/src/vue-shims.d.ts`（那是 `packages/ui/tsconfig.json` 的 include），
 * 所以测试侧需要自己的一份；两份分属不同程序，不会撞 `declare module`。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
