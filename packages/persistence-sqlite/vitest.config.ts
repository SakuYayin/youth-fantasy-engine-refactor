import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'persistence-sqlite',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
})
