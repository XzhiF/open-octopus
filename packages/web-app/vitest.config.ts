import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**'],
  },
  resolve: {
    alias: [
      {
        find: /^@\/lib\/monaco-setup$/,
        replacement: path.resolve(__dirname, 'test/monaco-setup-stub.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname) },
    ],
  },
})
