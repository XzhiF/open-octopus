/**
 * P5.1 — Integration tests for knowledge-update workflow.
 * Tests YAML validation and scheduler config scanning integration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "fs"
import { tmpdir } from "os"
import * as yaml from "js-yaml"
import { validateSchedulerConfig, SchedulerConfigSchema } from "@octopus/shared"

// ── Fixtures ────────────────────────────────────────────────────────

const VALID_SCHEDULER_YAML = `
version: "1.0"
global:
  timezone: "Asia/Shanghai"
  max_concurrent_tasks: 3
  task_queue_size: 10
tasks:
  - name: knowledge-update
    description: "Weekly knowledge refresh"
    cron: "0 2 * * 1"
    workflow: knowledge-update
    enabled: true
    priority: high
    retry:
      max_attempts: 3
      backoff: exponential
retire_protected:
  - prd-forge
evolution_scope:
  - "自动化测试"
`

const KNOWLEDGE_UPDATE_WORKFLOW = `
version: "1.0"
name: knowledge-update
description: "Refresh knowledge base"
nodes:
  - id: scan
    type: bash
    command: echo "Scanning repositories..."
  - id: extract
    type: bash
    command: echo "Extracting insights..."
    depends_on:
      - scan
`

// ── Tests ───────────────────────────────────────────────────────────

describe("knowledge-update integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "knowledge-int-"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("validates scheduler.yaml containing knowledge-update task", () => {
    const configPath = join(testDir, "scheduler.yaml")
    writeFileSync(configPath, VALID_SCHEDULER_YAML)

    const raw = yaml.load(readFileSync(configPath, "utf-8"))
    const config = validateSchedulerConfig(raw)

    expect(config.tasks).toHaveLength(1)
    expect(config.tasks[0].name).toBe("knowledge-update")
    expect(config.tasks[0].workflow).toBe("knowledge-update")
    expect(config.tasks[0].enabled).toBe(true)
  })

  it("parses knowledge-update workflow YAML with correct node chain", () => {
    const workflowPath = join(testDir, "knowledge-update.yaml")
    writeFileSync(workflowPath, KNOWLEDGE_UPDATE_WORKFLOW)

    const wf = yaml.load(readFileSync(workflowPath, "utf-8")) as Record<string, any>

    expect(wf.name).toBe("knowledge-update")
    expect(wf.nodes).toHaveLength(2)
    expect(wf.nodes[0].id).toBe("scan")
    expect(wf.nodes[1].depends_on).toEqual(["scan"])
  })

  it("scheduler CLI validate command succeeds with valid config", async () => {
    const configPath = join(testDir, "scheduler.yaml")
    writeFileSync(configPath, VALID_SCHEDULER_YAML)

    const { schedulerCmd } = await import("../../commands/scheduler")
    const validateCmd = schedulerCmd.commands.find((c) => c.name() === "validate")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await validateCmd.parseAsync(["--config", configPath], { from: "user" })

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("valid"))
    expect(mockExit).not.toHaveBeenCalled()

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("scans workspace for knowledge workflow files", () => {
    const wsDir = join(testDir, "workspace")
    const workflowsDir = join(wsDir, "workflows")
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(join(workflowsDir, "knowledge-update.yaml"), KNOWLEDGE_UPDATE_WORKFLOW)
    writeFileSync(join(workflowsDir, "other-wf.yaml"), "name: other\nnodes: []\n")

    const files = readdirSync(workflowsDir).filter(
      (f: string) => f.endsWith(".yaml") || f.endsWith(".yml"),
    )

    expect(files).toHaveLength(2)
    expect(files).toContain("knowledge-update.yaml")
  })

  it("rejects scheduler config with invalid task fields", () => {
    const result = SchedulerConfigSchema.safeParse({
      tasks: [{ name: "", cron: "0 2 * * 1", workflow: "knowledge-update", priority: "ultra" }],
    })
    expect(result.success).toBe(false)
  })
})
