import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.*.*.*', '*.*.*', '*.*'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // ponytail: @octopus/shared bundles Node-only code (fs, child_process) via skill-search.
  // Client components that import schema-only exports (workflowConfigSchema) still pull the
  // whole bundle. Stub Node builtins for browser — those code paths never execute client-side.
  turbopack: {
    // ponytail: pin root to monorepo. A stray ~/pnpm-lock.yaml made Turbopack infer
    // root=$HOME, embedding the full (possibly non-ASCII) abs path in asset idents and
    // tripping a char-boundary panic in output_name. Relative idents = ASCII + short.
    root: fileURLToPath(new URL('../..', import.meta.url)),
    resolveAlias: {
      fs: './empty-browser-module.js',
      'fs/promises': './empty-browser-module.js',
      path: './empty-browser-module.js',
      os: './empty-browser-module.js',
      child_process: './empty-browser-module.js',
      crypto: './empty-browser-module.js',
      events: './empty-browser-module.js',
      net: './empty-browser-module.js',
      http: './empty-browser-module.js',
    },
  },
}

export default nextConfig