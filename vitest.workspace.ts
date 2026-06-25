import { defineWorkspace } from "vitest/config"

export default defineWorkspace([
  "packages/shared",
  "packages/cli",
  "packages/engine",
  "packages/server",
  "packages/providers",
  "packages/web-app",
])