/**
 * P5.5 — Integration tests for swarm-discuss CLI commands.
 * Tests multi-expert discussion flow.
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

describe("swarm-discuss integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "swarm-int-"))
    vi.stubEnv("OCTOPUS_SERVER_URL", "http://localhost:9999")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("discuss command sends topic and experts to server", async () => {
    const discussion = {
      id: "disc-1",
      expertOpinions: [
        { expert: "architect", opinion: "Use microservices", confidence: 0.8 },
        { expert: "tester", opinion: "Add integration tests", confidence: 0.9 },
      ],
      finalProposal: "Adopt microservices with comprehensive test suite",
    }
    const fetchSpy = setupFetchMock(discussion)

    const { swarmCmd } = await import("../../commands/swarm")
    const discussCmd = swarmCmd.commands.find((c) => c.name() === "discuss")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await discussCmd.parseAsync(
      ["architecture decision", "--experts", "architect,tester"],
      { from: "user" },
    )

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/swarm/discuss"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"topic":"architecture decision"'),
      }),
    )
    expect(output.some((o) => o.includes("disc-1"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("discuss command rejects more than 5 experts", async () => {
    const { swarmCmd } = await import("../../commands/swarm")
    const discussCmd = swarmCmd.commands.find((c) => c.name() === "discuss")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await discussCmd.parseAsync(
      ["topic", "--experts", "a,b,c,d,e,f"],
      { from: "user" },
    )

    expect(mockExit).toHaveBeenCalledWith(1)
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining("limit is 5"))

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("review command fetches discussion by ID", async () => {
    const discussion = {
      topic: "test topic",
      expertOpinions: [
        { expert: "reviewer", opinion: "Looks good", confidence: 0.95 },
      ],
      finalProposal: "Proceed with implementation",
    }
    const fetchSpy = setupFetchMock(discussion)

    const { swarmCmd } = await import("../../commands/swarm")
    const reviewCmd = swarmCmd.commands.find((c) => c.name() === "review")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await reviewCmd.parseAsync(["disc-1"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/swarm/discussion/disc-1"),
    )

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("sync-chatbot command sends discussion ID", async () => {
    const fetchSpy = setupFetchMock({
      success: true,
      syncedAt: "2026-07-12T10:00:00Z",
      chatbotUrl: "https://chatbot.example.com/d/disc-1",
    })

    const { swarmCmd } = await import("../../commands/swarm")
    const syncCmd = swarmCmd.commands.find((c) => c.name() === "sync-chatbot")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await syncCmd.parseAsync(["disc-1"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/swarm/sync-chatbot"),
      expect.objectContaining({ method: "POST" }),
    )
    expect(output.some((o) => o.includes("2026-07-12"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })
})
