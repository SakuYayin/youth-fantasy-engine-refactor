import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 组件是 .vue 单文件组件，测试与渲染层共用同一个 Vue 插件。
  plugins: [vue()],
  test: {
    name: 'ui',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 组件挂载需要 DOM；用 happy-dom 而不是 jsdom（更快，够用）。
    environment: 'happy-dom',
  },
})
