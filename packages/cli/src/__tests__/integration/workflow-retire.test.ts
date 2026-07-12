/**
 * P5.3 — Integration tests for workflow-retire CLI commands.
 * Tests retire report generation, archive flow, and protected list filtering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"

function setupFetchMock(data: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => data,
  } as Response)
}

describe("workflow-retire integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "retire-int-"))
    vi.stubEnv("OCTOPUS_SERVER_URL", "http://localhost:9999")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("report command fetches retire candidates", async () => {
    const candidates = [
      {
        workflowId: "wf-old",
        usageRate: 0.01,
        failureRate: 0.6,
        lastExecution: "2025-01-01T00:00:00Z",
        reason: ["Low usage", "High failure rate"],
        impact: "low",
      },
    ]
    const fetchSpy = setupFetchMock(candidates)

    const { workflowRetireCmd } = await import("../../commands/workflow-retire")
    const reportCmd = workflowRetireCmd.commands.find((c) => c.name() === "report")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reportCmd.parseAsync(["--days", "90", "--usage-threshold", "0.05"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/analysis/retire-candidates"),
    )
    expect(output.some((o) => o.includes("wf-old"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("report shows empty message when no candidates", async () => {
    setupFetchMock([])

    const { workflowRetireCmd } = await import("../../commands/workflow-retire")
    const reportCmd = workflowRetireCmd.commands.find((c) => c.name() === "report")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reportCmd.parseAsync([], { from: "user" })

    expect(output.some((o) => o.includes("No retirement candidates"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("archive command sends POST with workflow ID", async () => {
    const fetchSpy = setupFetchMock({ message: "Workflow archived." })

    const { workflowRetireCmd } = await import("../../commands/workflow-retire")
    const archiveCmd = workflowRetireCmd.commands.find((c) => c.name() === "archive")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await archiveCmd.parseAsync(["wf-old"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/analysis/retire-archive"),
      expect.objectContaining({ method: "POST" }),
    )

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("protected command fetches protected list", async () => {
    const fetchSpy = setupFetchMock(["prd-forge", "prd-impl"])

    const { workflowRetireCmd } = await import("../../commands/workflow-retire")
    const protectedCmd = workflowRetireCmd.commands.find((c) => c.name() === "protected")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await protectedCmd.parseAsync(["--org", "xzf"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/analysis/retire-protected?org=xzf"),
    )
    expect(output.some((o) => o.includes("prd-forge"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("protected command shows 'no protected' message for empty list", async () => {
    setupFetchMock([])

    const { workflowRetireCmd } = await import("../../commands/workflow-retire")
    const protectedCmd = workflowRetireCmd.commands.find((c) => c.name() === "protected")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await protectedCmd.parseAsync([], { from: "user" })

    expect(output.some((o) => o.includes("No protected"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })
})
