import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'client-sdk',
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
})
