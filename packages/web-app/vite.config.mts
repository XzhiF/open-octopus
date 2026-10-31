import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const emptyModule = path.resolve(rootDir, 'empty-browser-module.js')

function runtimeConfigPlugin(): Plugin {
  return {
    name: 'octopus-runtime-config',
    apply: 'serve',
    transformIndexHtml(html) {
      const serverUrl = process.env.SERVER_URL
      if (!serverUrl) return html
      return html.replace(
        '</head>',
        `    <meta name="octopus-server-url" content="${serverUrl}" />\n  </head>`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), runtimeConfigPlugin()],
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      { find: /^fs$/, replacement: emptyModule },
      { find: /^fs\/promises$/, replacement: emptyModule },
      { find: /^path$/, replacement: emptyModule },
      { find: /^os$/, replacement: emptyModule },
      { find: /^child_process$/, replacement: emptyModule },
      { find: /^crypto$/, replacement: emptyModule },
      { find: /^events$/, replacement: emptyModule },
      { find: /^net$/, replacement: emptyModule },
      { find: /^http$/, replacement: emptyModule },
      { find: /^node:fs$/, replacement: emptyModule },
      { find: /^node:fs\/promises$/, replacement: emptyModule },
      { find: /^node:path$/, replacement: emptyModule },
      { find: /^node:os$/, replacement: emptyModule },
      { find: /^node:child_process$/, replacement: emptyModule },
      { find: /^node:crypto$/, replacement: emptyModule },
      { find: /^node:events$/, replacement: emptyModule },
      { find: /^node:net$/, replacement: emptyModule },
      { find: /^node:http$/, replacement: emptyModule },
    ],
  },
  define: {
    global: 'globalThis',
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
})
