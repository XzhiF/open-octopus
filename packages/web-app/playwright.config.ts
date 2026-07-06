import { defineConfig, devices } from "@playwright/test"
import fs from "fs"
import path from "path"
import os from "os"

/**
 * Read the allocated web port for the current worktree.
 * dev.mjs writes port info to ~/.octopus/ports/{branch-safe-name}.json
 * when it starts. Playwright reads this at config load time.
 */
function resolveWebPort(): number {
  // Walk up from config dir to find the repo root (follows worktree gitdir)
  let dir = path.resolve(__dirname, "..")
  for (let i = 0; i < 5; i++) {
    try {
      const gitPath = path.join(dir, ".git")
      const stat = fs.statSync(gitPath)
      if (stat.isFile() || stat.isDirectory()) {
        let headPath: string
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim()
          const gitdirMatch = content.match(/^gitdir:\s*(.+)$/)
          headPath = gitdirMatch ? path.join(gitdirMatch[1], "HEAD") : path.join(dir, ".git", "HEAD")
        } else {
          headPath = path.join(gitPath, "HEAD")
        }
        const headContent = fs.readFileSync(headPath, "utf8").trim()
        const branchMatch = headContent.match(/ref: refs\/heads\/(.+)/)
        const branch = branchMatch ? branchMatch[1] : path.basename(dir)
        const safe = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
        const portFile = path.join(os.homedir(), ".octopus", "ports", `${safe}.json`)
        if (fs.existsSync(portFile)) {
          const data = JSON.parse(fs.readFileSync(portFile, "utf8"))
          if (typeof data.web === "number") return data.web
        }
        break
      }
    } catch { /* not found at this level, go up */ }
    dir = path.dirname(dir)
  }
  return 3000
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
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm dev --skip-build",
    url: `http://localhost:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
})
