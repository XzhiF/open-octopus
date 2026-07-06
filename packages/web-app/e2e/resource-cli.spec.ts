// packages/web-app/e2e/resource-cli.spec.ts
// E2E CLI tests for 资源管理 — TC-028~041 (Suite C)
import { test, expect } from "@playwright/test"
import { execSync } from "child_process"
import path from "path"

const CLI_TIMEOUT = 30_000
const cliDir = path.resolve(__dirname, "../../../..")

function runCli(args: string): string {
  return execSync(`npx octopus resource ${args}`, {
    cwd: cliDir,
    encoding: "utf-8",
    timeout: CLI_TIMEOUT,
    env: { ...process.env, OCTOPUS_SERVER_URL: process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001" },
  })
}

function runCliSafe(args: string): { stdout: string; status: number } {
  try {
    const stdout = runCli(args)
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout ?? "") + (err.stderr ?? ""), status: err.status ?? 1 }
  }
}

test.describe("CLI E2E — 资源管理", () => {
  test("C1: CLI install — 正常安装 [TC-028]", () => {
    const output = runCli("install builtin:skill/octo-workflow-dev")
    expect(output).toMatch(/✓|installed|安装/i)
  })

  test("C2: CLI install — 资源不存在 [TC-030]", () => {
    const { stdout, status } = runCliSafe("install builtin:skill/nonexistent-zzz-999")
    expect(stdout).toMatch(/RESOURCE_NOT_FOUND|not found|不存在/i)
    expect(status).not.toBe(0)
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
    // 先安装确保存在
    try { runCli("install builtin:skill/octo-workflow-dev") } catch { /* ignore */ }
    const output = runCli("uninstall octo-workflow-dev")
    expect(output).toMatch(/✓|uninstalled|卸载/i)
  })

  test("C6: CLI doctor — 健康检查 [TC-041]", () => {
    const output = runCli("doctor")
    expect(output).toMatch(/[✓!✗✘]/)
    expect(output).toMatch(/registry|lock|cache|健康|检查/i)
  })
})
