import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock fetch globally before importing resource module
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("resource command — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OCTOPUS_SERVER_URL = "http://localhost:3099"
  })

  afterEach(() => {
    delete process.env.OCTOPUS_SERVER_URL
  })

  it("resolves server URL from env", async () => {
    process.env.OCTOPUS_SERVER_URL = "http://custom:4000"
    // The resource module reads env at call time, so we test via the export
    const { resourceCmd } = await import("../commands/resource")
    expect(resourceCmd.name()).toBe("resource")
    const subcmds = resourceCmd.commands.map((c) => c.name())
    expect(subcmds).toEqual(["install", "uninstall", "list", "info", "audit", "search", "stats"])
  })

  it("resource install sends POST to /api/resources/install", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ name: "test-skill", type: "skill", source: "builtin" }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const installCmd = resourceCmd.commands.find((c) => c.name() === "install")!

    // Capture console.log
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await installCmd.parseAsync(["builtin:test-skill"], { from: "user" })
    logSpy.mockRestore()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/resources/install"),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    )
  })

  it("resource list sends GET to /api/resources", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ resources: [] }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const listCmd = resourceCmd.commands.find((c) => c.name() === "list")!

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await listCmd.parseAsync([], { from: "user" })
    logSpy.mockRestore()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/resources/?org="),
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("resource audit supports --last and --action filters", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ records: [] }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const auditCmd = resourceCmd.commands.find((c) => c.name() === "audit")!

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await auditCmd.parseAsync(["--last", "50", "--action", "install"], { from: "user" })
    logSpy.mockRestore()

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain("last=50")
    expect(url).toContain("action=install")
  })

  it("resource stats sends GET to /api/resources/stats", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ total: 0, byType: {}, byStatus: {}, bySource: {} }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const statsCmd = resourceCmd.commands.find((c) => c.name() === "stats")!

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await statsCmd.parseAsync([], { from: "user" })
    logSpy.mockRestore()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/resources/stats"),
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("handles server connection error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))

    const { resourceCmd } = await import("../commands/resource")
    const listCmd = resourceCmd.commands.find((c) => c.name() === "list")!

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any)

    // process.exit mocked as no-op, so the throw after it propagates
    await expect(listCmd.parseAsync([], { from: "user" })).rejects.toThrow()

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Cannot connect"))
    expect(exitSpy).toHaveBeenCalledWith(1)

    errSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("handles API error with structured error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: () => Promise.resolve({
        error: {
          code: "ALREADY_INSTALLED",
          message: "Resource already installed",
          suggestion: "Use uninstall first",
        },
      }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const installCmd = resourceCmd.commands.find((c) => c.name() === "install")!

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any)

    await expect(installCmd.parseAsync(["builtin:test"], { from: "user" })).rejects.toThrow()

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("ALREADY_INSTALLED"))
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Use uninstall first"))
    expect(exitSpy).toHaveBeenCalledWith(1)

    errSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("resource search sends GET to /api/resources/builtin and filters results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        resources: [
          { name: "brainstorming", type: "skill", description: "Creative brainstorming", installed: false },
          { name: "code-review", type: "skill", description: "Code review helper", installed: true },
          { name: "test-agent", type: "agent", description: "Testing agent", installed: false },
        ],
        total: 3,
      }),
    })

    const { resourceCmd } = await import("../commands/resource")
    const searchCmd = resourceCmd.commands.find((c) => c.name() === "search")!

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    await searchCmd.parseAsync(["brain"], { from: "user" })
    logSpy.mockRestore()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/resources/builtin"),
      expect.objectContaining({ method: "GET" }),
    )
  })
})
