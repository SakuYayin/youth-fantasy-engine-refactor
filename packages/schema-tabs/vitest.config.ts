import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'schema-tabs',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
})
