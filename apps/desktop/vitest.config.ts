import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    // 必须显式声明 name：否则 vitest 会回退到 package.json 的 name，
    // 过滤器就变成 `--project @yfe/desktop`，与其它包的短名风格不一致。
    name: 'desktop',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 默认 node 环境（宿主/worker 测试都要真实子进程）；
    // 需要 DOM 的测试文件在文件头写 `// @vitest-environment happy-dom`。
    environment: 'node',
    // 桌面宿主测试会 spawn 子进程（db-worker），放宽单测超时
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
