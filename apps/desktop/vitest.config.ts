import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 必须显式声明 name：否则 vitest 会回退到 package.json 的 name，
    // 过滤器就变成 `--project @yfe/desktop`，与其它包的短名风格不一致。
    name: 'desktop',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
    // 桌面宿主测试会 spawn 子进程（db-worker），放宽单测超时
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
