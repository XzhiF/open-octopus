/**
 * P5.2 — Integration tests for workflow-optimize CLI commands.
 * Tests optimize report generation and apply-optimization flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"

// ── Helpers ─────────────────────────────────────────────────────────

function setupFetchMock(data: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => data,
  } as Response)
}

// ── Tests ───────────────────────────────────────────────────────────

describe("workflow-optimize integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "optimize-int-"))
    vi.stubEnv("OCTOPUS_SERVER_URL", "http://localhost:9999")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("report command fetches inefficient workflows from server", async () => {
    const mockData = [
      {
        workflowId: "wf-slow",
        avgDurationMs: 120000,
        failureRate: 0.35,
        totalRuns: 20,
        suggestions: ["Add retry policy", "Reduce node count"],
      },
    ]
    const fetchSpy = setupFetchMock(mockData)

    const { workflowOptimizeCmd } = await import("../../commands/workflow-optimize")
    const reportCmd = workflowOptimizeCmd.commands.find((c) => c.name() === "report")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reportCmd.parseAsync(["--days", "30", "--top", "5"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/analysis/workflow-inefficient?days=30&topN=5"),
    )
    expect(output.some((o) => o.includes("wf-slow"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("report command shows 'no inefficient workflows' for empty result", async () => {
    setupFetchMock([])

    const { workflowOptimizeCmd } = await import("../../commands/workflow-optimize")
    const reportCmd = workflowOptimizeCmd.commands.find((c) => c.name() === "report")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reportCmd.parseAsync([], { from: "user" })

    expect(output.some((o) => o.includes("No inefficient"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("apply-optimization sends POST with workflow ID", async () => {
    const fetchSpy = setupFetchMock({ message: "No changes to apply." })

    const { workflowOptimizeCmd } = await import("../../commands/workflow-optimize")
    const applyCmd = workflowOptimizeCmd.commands.find((c) => c.name() === "apply-optimization")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await applyCmd.parseAsync(["wf-slow", "--base-branch", "main"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/analysis/workflow-apply"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"workflowId":"wf-slow"'),
      }),
    )

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("report command exits 1 on server error", async () => {
    setupFetchMock(null, false, 500)

    const { workflowOptimizeCmd } = await import("../../commands/workflow-optimize")
    const reportCmd = workflowOptimizeCmd.commands.find((c) => c.name() === "report")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reportCmd.parseAsync([], { from: "user" })

    expect(mockExit).toHaveBeenCalledWith(1)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })
})
