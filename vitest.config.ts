import { defineConfig } from 'vitest/config'

// 每个包一个 project：便于按包独立运行，避免全员争抢同一个 vitest 进程与缓存。
// 纪律：同一时刻只允许一个成员运行全量 `npm test`；包级测试必须用
//   npx vitest run --project <name>
// 且缓存目录由 VITEST_CACHE_DIR 隔离（见 tools/test-run.sh）。
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'services/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
    ],
    reporters: ['default'],
  },
})
