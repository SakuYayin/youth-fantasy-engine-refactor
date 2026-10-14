import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// 🔴 `root` 用 `fileURLToPath(new URL('.', import.meta.url))` 而不是 `import.meta.dirname`：
//    后者是 Node 20.11+ 的属性，但本文件要经 Vite 转换后执行，转换产物不保证该属性存在
//    （实测 `import.meta.dirname` 在 Vite 的 SSR 转换里会变成 `undefined`，导致 root 落到
//    调用者的 cwd，`--project legacy-import` 会找不到任何测试文件而静默"0 test"）。
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    // 必须显式命名：根 vitest.config.ts 以 glob 聚合 `packages/*/vitest.config.ts`，
    // 匿名 project 会让 `npx vitest run --project legacy-import` 无法选中本包。
    name: 'legacy-import',
    root,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // forks：better-sqlite3 是原生扩展，线程池里的 worker_threads 会重复加载原生绑定。
    pool: 'forks',
  },
})
