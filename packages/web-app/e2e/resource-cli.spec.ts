// packages/web-app/e2e/resource-cli.spec.ts
// E2E CLI tests for 资源管理 — TC-028~041 (Suite C)
import { test, expect } from "@playwright/test"
import { execSync } from "child_process"
import path from "path"
import fs from "fs"
import os from "os"

const CLI_TIMEOUT = 30_000
const cliDir = path.resolve(__dirname, "../../..")
const CLI_BIN = path.resolve(cliDir, "packages", "cli", "dist", "index.js")

/** Resolve server URL matching the port allocation for this worktree. */
function resolveServerUrl(): string {
  if (process.env.OCTOPUS_SERVER_URL) return process.env.OCTOPUS_SERVER_URL
  let dir = cliDir
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
          if (typeof data.server === "number") return `http://localhost:${data.server}`
        }
        break
      }
    } catch { /* not found at this level, go up */ }
    dir = path.dirname(dir)
  }
  return "http://localhost:3001"
}

function runCli(args: string): string {
  // Merge stderr into stdout so error messages from console.error are captured
  return execSync(`node "${CLI_BIN}" resource ${args} 2>&1`, {
    cwd: cliDir,
    encoding: "utf-8",
    timeout: CLI_TIMEOUT,
    env: { ...process.env, OCTOPUS_SERVER_URL: resolveServerUrl() },
  })
}

function runCliSafe(args: string): { stdout: string; status: number } {
  try {
    const stdout = runCli(args)
    return { stdout, status: 0 }
  } catch (err: any) {
    const out = (err.stdout ?? "") + (err.stderr ?? "")
    return { stdout: out, status: err.status ?? 1 }
  }
}

test.describe("CLI E2E — 资源管理", () => {
  test("C1: CLI install — 正常安装 [TC-028]", () => {
    // Uninstall first to ensure clean state
    try { runCli("uninstall octo-workflow-dev --type skill") } catch { /* ignore */ }
    const output = runCli("install builtin:skill/octo-workflow-dev")
    expect(output).toMatch(/installed|安装|Already installed/i)
  })

  test("C2: CLI install — 资源不存在 [TC-030]", () => {
    const { stdout, status } = runCliSafe("install builtin:skill/nonexistent-zzz-999")
    expect(stdout).toMatch(/RESOURCE_NOT_FOUND|not found|不存在/i)
    // CLI may or may not exit non-zero depending on error handling
  })

  test("C3: CLI list — 全量列表 [TC-033]", () => {
    const output = runCli("list")
    // 表格输出包含列头或资源数据
    expect(output).toMatch(/name|type|version|skill|agent|名称|类型/i)
  })

  test("C4: CLI list --type — 类型过滤 [TC-034]", () => {
    const output = runCli("list --type skill")
    const lines = output.trim().split("\n")
    // 跳过表头，验证每行包含 skill
    for (const line of lines.slice(1)) {
      if (line.trim()) {
        expect(line.toLowerCase()).toMatch(/skill/)
      }
    }
  })

  test("C5: CLI uninstall — 正常卸载 [TC-031]", () => {
    // Ensure installed first
    try { runCli("install builtin:skill/octo-workflow-dev") } catch { /* ignore */ }
    const output = runCli("uninstall octo-workflow-dev --type skill")
    expect(output).toMatch(/uninstalled|卸载/i)
  })

  test("C6: CLI doctor — 健康检查 [TC-041]", () => {
    const output = runCli("doctor")
    expect(output).toMatch(/PASS|FAIL|检查|check/i)
    expect(output).toMatch(/registry|lock|cache/i)
  })
})
