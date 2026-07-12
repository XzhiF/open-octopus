/**
 * P5.6 — Integration tests for meta-evolution CLI commands.
 * Tests proposal generation with scope configuration.
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

describe("meta-evolution integration", () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "evolution-int-"))
    vi.stubEnv("OCTOPUS_SERVER_URL", "http://localhost:9999")
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("scope command fetches current scopes", async () => {
    const fetchSpy = setupFetchMock({ scopes: ["自动化测试", "性能优化"] })

    const { evolutionCmd } = await import("../../commands/evolution")
    const scopeCmd = evolutionCmd.commands.find((c) => c.name() === "scope")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await scopeCmd.parseAsync(["--org", "xzf"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/evolution/scope?org=xzf"),
    )
    expect(output.some((o) => o.includes("自动化测试"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("scope --add sends PUT with new direction", async () => {
    const fetchSpy = setupFetchMock({ scopes: ["自动化测试", "安全审计"] })

    const { evolutionCmd } = await import("../../commands/evolution")
    const scopeCmd = evolutionCmd.commands.find((c) => c.name() === "scope")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await scopeCmd.parseAsync(["--org", "xzf", "--add", "安全审计"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/evolution/scope"),
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"add":"安全审计"'),
      }),
    )

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("propose command generates proposals for org", async () => {
    const proposals = {
      proposals: [
        {
          id: "p-1",
          title: "Add retry logic",
          problem: "Workflows fail on transient errors",
          solution: "Implement exponential backoff",
          feasibilityScore: 85,
          verificationMethod: "Run 100 workflows with injected failures",
        },
      ],
    }
    const fetchSpy = setupFetchMock(proposals)

    const { evolutionCmd } = await import("../../commands/evolution")
    const proposeCmd = evolutionCmd.commands.find((c) => c.name() === "propose")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await proposeCmd.parseAsync(["xzf", "--count", "3"], { from: "user" })

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/evolution/propose"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"org":"xzf"'),
      }),
    )
    expect(output.some((o) => o.includes("Add retry logic"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("propose handles 400 error for missing scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "No evolution scope configured for org" }),
    } as Response)

    const { evolutionCmd } = await import("../../commands/evolution")
    const proposeCmd = evolutionCmd.commands.find((c) => c.name() === "propose")!

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await proposeCmd.parseAsync(["empty-org"], { from: "user" })

    expect(mockExit).toHaveBeenCalledWith(1)
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("No evolution scope"),
    )

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })

  it("scope shows 'no scope configured' for empty list", async () => {
    setupFetchMock({ scopes: [] })

    const { evolutionCmd } = await import("../../commands/evolution")
    const scopeCmd = evolutionCmd.commands.find((c) => c.name() === "scope")!

    const output: string[] = []
    const mockLog = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      output.push(String(args[0]))
    })
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {})
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)

    await scopeCmd.parseAsync([], { from: "user" })

    expect(output.some((o) => o.includes("No evolution scope"))).toBe(true)

    mockLog.mockRestore()
    mockError.mockRestore()
    mockExit.mockRestore()
  })
})
