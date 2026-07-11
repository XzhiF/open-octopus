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
  const repoRoot = path.resolve(__dirname, "../..")
  const gitPath = path.join(repoRoot, ".git")

  let isWorktree = false
  try { isWorktree = fs.statSync(gitPath).isFile() } catch { /* ignore */ }

  if (!isWorktree) return 3000

  // Read branch from worktree HEAD
  let branch = ""
  try {
    const gitContent = fs.readFileSync(gitPath, "utf8").trim()
    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/)
    if (gitdirMatch) {
      const headPath = path.join(gitdirMatch[1], "HEAD")
      const headContent = fs.readFileSync(headPath, "utf8").trim()
      const refMatch = headContent.match(/ref: refs\/heads\/(.+)/)
      branch = refMatch ? refMatch[1] : path.basename(repoRoot)
    } else {
      branch = path.basename(repoRoot)
    }
  } catch { branch = path.basename(repoRoot) }

  const safe = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
  const portFile = path.join(os.homedir(), ".octopus", "ports", `${safe}.json`)

  if (fs.existsSync(portFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(portFile, "utf8"))
      if (typeof data.web === "number") return data.web
    } catch { /* fall through */ }
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
})
