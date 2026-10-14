import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'contracts',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    // 契约包是纯逻辑：不注入任何 Node/浏览器全局，强制测试显式 import。
    globals: false,
    environment: 'node',
  },
})
