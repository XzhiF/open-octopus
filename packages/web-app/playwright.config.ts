import { defineConfig, devices } from "@playwright/test"
import fs from "fs"
import path from "path"
import os from "os"

/**
 * Read the allocated web port for the current worktree or workspace.
 * dev.mjs writes port info to ~/.octopus/ports/{branch-safe-name}.json
 * when it starts. Playwright reads this at config load time.
 */
function resolveWebPort(): number {
  const repoRoot = path.resolve(__dirname, "../..")
  const gitPath = path.join(repoRoot, ".git")

  let isWorktree = false
  try { isWorktree = fs.statSync(gitPath).isFile() } catch { /* ignore */ }

  // Check if inside Octopus workspace (projects/{name}/ → workspaces/{name}/)
  let workspaceName: string | null = null
  try {
    const parts = repoRoot.split(/[\\/]/)
    const projectsIdx = parts.lastIndexOf("projects")
    if (projectsIdx >= 3 && parts[projectsIdx - 2] === "workspaces") {
      workspaceName = parts[projectsIdx - 1]
    }
  } catch { /* ignore */ }

  // Main repo (not worktree, not workspace) → default 3000
  if (!isWorktree && !workspaceName) return 3000

  // Derive port file key
  let safe = ""
  if (isWorktree) {
    try {
      const gitContent = fs.readFileSync(gitPath, "utf8").trim()
      const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/)
      if (gitdirMatch) {
        const headPath = path.join(gitdirMatch[1], "HEAD")
        const headContent = fs.readFileSync(headPath, "utf8").trim()
        const refMatch = headContent.match(/ref: refs\/heads\/(.+)/)
        safe = (refMatch ? refMatch[1] : path.basename(repoRoot))
          .replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
      } else {
        safe = path.basename(repoRoot).replace(/[^a-zA-Z0-9\-_.]/g, "_")
      }
    } catch { safe = path.basename(repoRoot).replace(/[^a-zA-Z0-9\-_.]/g, "_") }
  } else if (workspaceName) {
    safe = workspaceName.replace(/[^a-zA-Z0-9\-_.]/g, "_")
  }

  // Try port file (written by dev.mjs)
  const portFile = path.join(os.homedir(), ".octopus", "ports", `${safe}.json`)
  if (fs.existsSync(portFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(portFile, "utf8"))
      if (typeof data.web === "number") return data.web
    } catch { /* fall through */ }
  }

  // Fallback: deterministic port in 3500-3598 range (avoids main 3000/3001 and dev.mjs 3100+)
  const { createHash } = require("crypto")
  const hash = createHash("sha1").update(safe).digest().readUInt16BE(0)
  return 3500 + (hash % 50) * 2
}

const webPort = resolveWebPort()

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "html" : [["list"]],
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // H7 fix: restore webServer so E2E tests auto-start the app
  // Use `npx next dev` directly to bypass pnpm predev hook (which kills port 3000)
  webServer: {
    command: "npx next dev --port " + webPort,
    url: `http://localhost:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
