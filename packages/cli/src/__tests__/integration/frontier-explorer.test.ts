/**
 * P5.4 — Integration tests for frontier-explorer CLI commands.
 * Tests frontier report generation and propose flow.
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

describe("frontier-explorer integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "frontier-int-"))
    vi.stubEnv("OCTOPUS_SERVER_URL", "http://localhost:9999")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("history command fetches exploration history", async () => {
    const history = [
      { id: "f-1", topic: "ai-agents", itemCount: 10, createdAt: "2026-06-01" },
      { id: "f-2", topic: "workflow-engine", itemCount: 5, createdAt: "2026-06-15" },
    ]
    const fetchSpy = setupFetchMock(history)

    const { frontierCmd } = await import("../../commands/frontier")
    const historyCmd = frontierCmd.commands.find((c) => c.name() === "history")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await historyCmd.parseAsync(["--limit", "10"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/frontier/history?limit=10"),
    )
    expect(output.some((o) => o.includes("ai-agents"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("history shows empty message when no history", async () => {
    setupFetchMock([])

    const { frontierCmd } = await import("../../commands/frontier")
    const historyCmd = frontierCmd.commands.find((c) => c.name() === "history")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await historyCmd.parseAsync([], { from: "user" })

    expect(output.some((o) => o.includes("No frontier"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("propose command sends POST with domain and source", async () => {
    const proposeResult = {
      items: [
        { name: "langchain", url: "https://github.com/langchain", score: 95, summary: "LLM framework" },
      ],
      count: 1,
    }
    const fetchSpy = setupFetchMock(proposeResult)

    const { frontierCmd } = await import("../../commands/frontier")
    const proposeCmd = frontierCmd.commands.find((c) => c.name() === "propose")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await proposeCmd.parseAsync(["ai-agents", "--source", "github"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/frontier/propose"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"domains":["ai-agents"]'),
      }),
    )
    expect(output.some((o) => o.includes("langchain"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("propose exits 1 on server error", async () => {
    setupFetchMock(null, false, 500)

    const { frontierCmd } = await import("../../commands/frontier")
    const proposeCmd = frontierCmd.commands.find((c) => c.name() === "propose")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await proposeCmd.parseAsync(["test-domain"], { from: "user" })

    expect(mockExit).toHaveBeenCalledWith(1)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })
})
