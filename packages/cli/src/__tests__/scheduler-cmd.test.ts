import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"

// ── Valid scheduler.yaml fixture ────────────────────────────────────

const VALID_YAML = `
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
  - name: workflow-retire
    description: "Quarterly retire check"
    cron: "0 5 1 1,4,7,10 *"
    workflow: workflow-retire
    enabled: false
    priority: medium
retire_protected:
  - prd-forge
  - prd-impl
evolution_scope:
  - "自动化测试"
`

// ── Tests ───────────────────────────────────────────────────────────

describe("scheduler CLI", () => {
  let testDir: string
  let configPath: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "scheduler-test-"))
    configPath = join(testDir, "scheduler.yaml")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("validate", () => {
    it("accepts valid scheduler.yaml", async () => {
      writeFileSync(configPath, VALID_YAML)
      const { schedulerCmd } = await import("../commands/scheduler")
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

    it("reports YAML syntax errors", async () => {
      writeFileSync(configPath, "tasks:\n  - name: [invalid yaml\n")
      const { schedulerCmd } = await import("../commands/scheduler")
      const validateCmd = schedulerCmd.commands.find((c) => c.name() === "validate")!

      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await validateCmd.parseAsync(["--config", configPath], { from: "user" })

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Error"))

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })

    it("reports schema validation errors", async () => {
      writeFileSync(configPath, "tasks:\n  - name: ''\n    cron: '0 2 * * 1'\n    workflow: x\n")
      const { schedulerCmd } = await import("../commands/scheduler")
      const validateCmd = schedulerCmd.commands.find((c) => c.name() === "validate")!

      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await validateCmd.parseAsync(["--config", configPath], { from: "user" })

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Validation errors"))

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })

    it("exits 1 when config file not found", async () => {
      const { schedulerCmd } = await import("../commands/scheduler")
      const validateCmd = schedulerCmd.commands.find((c) => c.name() === "validate")!

      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await validateCmd.parseAsync(["--config", join(testDir, "nonexistent.yaml")], { from: "user" })

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("No scheduler.yaml found"))

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })
  })

  describe("list", () => {
    it("outputs table with all tasks", async () => {
      writeFileSync(configPath, VALID_YAML)
      const { schedulerCmd } = await import("../commands/scheduler")
      const listCmd = schedulerCmd.commands.find((c) => c.name() === "list")!

      const output: string[] = []
      const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
        output.push(String(args[0]))
      })
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await listCmd.parseAsync(["--config", configPath], { from: "user" })

      // Header + 2 task rows
      expect(output.length).toBe(3)
      expect(output[0]).toContain("NAME")
      expect(output[0]).toContain("CRON")
      expect(output[0]).toContain("NEXT RUN")
      expect(output[1]).toContain("knowledge-update")
      expect(output[2]).toContain("workflow-retire")

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })

    it("exits 1 when no config found", async () => {
      const { schedulerCmd } = await import("../commands/scheduler")
      const listCmd = schedulerCmd.commands.find((c) => c.name() === "list")!

      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await listCmd.parseAsync(["--config", join(testDir, "missing.yaml")], { from: "user" })

      expect(mockExit).toHaveBeenCalledWith(1)

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })
  })

  describe("next", () => {
    it("shows next run for existing task", async () => {
      writeFileSync(configPath, VALID_YAML)
      const { schedulerCmd } = await import("../commands/scheduler")
      const nextCmd = schedulerCmd.commands.find((c) => c.name() === "next")!

      const output: string[] = []
      const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
        output.push(String(args[0]))
      })
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await nextCmd.parseAsync(["knowledge-update", "--config", configPath], { from: "user" })

      expect(output[0]).toContain("knowledge-update")
      expect(output[1]).toContain("cron: 0 2 * * 1")

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })

    it("exits 1 for unknown task", async () => {
      writeFileSync(configPath, VALID_YAML)
      const { schedulerCmd } = await import("../commands/scheduler")
      const nextCmd = schedulerCmd.commands.find((c) => c.name() === "next")!

      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

      await nextCmd.parseAsync(["nonexistent-task", "--config", configPath], { from: "user" })

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining("Task not found: nonexistent-task"))

      mockLog.mockRestore()
      mockError.mockRestore()
      mockExit.mockRestore()
    })
  })
})

// ── Cron calculator unit tests ──────────────────────────────────────

describe("cron next-run calculator", () => {
  // Import the internal function via re-export test through validate
  // Instead, test via the shared schema validate + manual cron logic
  it("validateSchedulerConfig accepts valid config", async () => {
    const { validateSchedulerConfig } = await import("@octopus/shared")
    const config = validateSchedulerConfig({
      version: "1.0",
      global: { timezone: "UTC", max_concurrent_tasks: 2, task_queue_size: 5 },
      tasks: [
        { name: "test", cron: "0 2 * * 1", workflow: "test-wf", enabled: true, priority: "high" },
      ],
      retire_protected: ["prd-forge"],
      evolution_scope: ["testing"],
    })
    expect(config.tasks).toHaveLength(1)
    expect(config.tasks[0].name).toBe("test")
    expect(config.retire_protected).toEqual(["prd-forge"])
  })

  it("validateSchedulerConfig applies defaults", async () => {
    const { validateSchedulerConfig } = await import("@octopus/shared")
    const config = validateSchedulerConfig({})
    expect(config.version).toBe("1.0")
    expect(config.global.timezone).toBe("Asia/Shanghai")
    expect(config.global.max_concurrent_tasks).toBe(3)
    expect(config.tasks).toEqual([])
  })

  it("validateSchedulerConfig rejects invalid priority", async () => {
    const { validateSchedulerConfig } = await import("@octopus/shared")
    expect(() => validateSchedulerConfig({
      tasks: [{ name: "x", cron: "0 0 * * *", workflow: "w", priority: "ultra" }],
    })).toThrow()
  })

  it("validateSchedulerConfig rejects empty task name", async () => {
    const { validateSchedulerConfig } = await import("@octopus/shared")
    expect(() => validateSchedulerConfig({
      tasks: [{ name: "", cron: "0 0 * * *", workflow: "w" }],
    })).toThrow()
  })
})
