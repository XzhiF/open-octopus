import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock global fetch before importing the command
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  })
}

import { resourceCmd } from "../commands/resource"

describe("resource CLI commands", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mockFetch.mockReset()
    process.env.OCTOPUS_SERVER_URL = "http://localhost:3001"
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.clearAllMocks()
  })

  // ── install ──────────────────────────────────────────────────────
  describe("install", () => {
    it("calls POST /api/resources/install with ref", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: { name: "octo-creator", type: "skill", version: "2.0.0" },
      }))

      const installCmd = resourceCmd.commands.find(c => c.name() === "install")!
      await installCmd.parseAsync(["builtin:octo-creator"], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/install",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ ref: "builtin:octo-creator" }),
        }),
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Installed"))
    })

    it("prints error on API failure", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(
        { error: { code: "ALREADY_INSTALLED", message: "Already installed" } },
        409,
      ))

      const installCmd = resourceCmd.commands.find(c => c.name() === "install")!
      await installCmd.parseAsync(["builtin:foo"], { from: "user" })

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed"))
    })
  })

  // ── uninstall ────────────────────────────────────────────────────
  describe("uninstall", () => {
    it("calls POST /api/resources/uninstall with name and type", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ data: { name: "foo", type: "skill", uninstalled: true } }))

      const uninstallCmd = resourceCmd.commands.find(c => c.name() === "uninstall")!
      await uninstallCmd.parseAsync(["foo", "--type", "skill"], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/uninstall",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "foo", type: "skill" }),
        }),
      )
    })
  })

  // ── list ─────────────────────────────────────────────────────────
  describe("list", () => {
    it("calls GET /api/resources", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: [{ name: "s1", type: "skill", version: "1.0.0", installed: true }],
        meta: { total: 1, returned: 1 },
      }))

      const listCmd = resourceCmd.commands.find(c => c.name() === "list")!
      await listCmd.parseAsync([], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources",
        undefined,
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Resources"))
    })

    it("passes type filter as query param", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ data: [], meta: { total: 0, returned: 0 } }))

      const listCmd = resourceCmd.commands.find(c => c.name() === "list")!
      await listCmd.parseAsync(["--type", "agent"], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources?type=agent",
        undefined,
      )
    })

    it("shows yellow message when empty", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ data: [], meta: { total: 0, returned: 0 } }))

      const listCmd = resourceCmd.commands.find(c => c.name() === "list")!
      await listCmd.parseAsync([], { from: "user" })

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("No resources"))
    })
  })

  // ── info ─────────────────────────────────────────────────────────
  describe("info", () => {
    it("calls GET /api/resources/:type/:name", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: {
          name: "foo", type: "skill", version: "1.0.0", installed: true,
          dependencies: [], source: { type: "builtin" },
          createdAt: "2025-01-01", updatedAt: "2025-01-02",
        },
      }))

      const infoCmd = resourceCmd.commands.find(c => c.name() === "info")!
      await infoCmd.parseAsync(["foo", "--type", "skill"], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/skill/foo",
        undefined,
      )
    })
  })

  // ── gc ───────────────────────────────────────────────────────────
  describe("gc", () => {
    it("calls POST /api/resources/gc", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: { removed: [], freedBytes: 0, freedHuman: "0 B" },
      }))

      const gcCmd = resourceCmd.commands.find(c => c.name() === "gc")!
      await gcCmd.parseAsync([], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/gc",
        expect.objectContaining({ method: "POST" }),
      )
    })

    it("passes dryRun flag", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: { removed: ["item1"], freedBytes: 1024, freedHuman: "1.0 KB" },
      }))

      const gcCmd = resourceCmd.commands.find(c => c.name() === "gc")!
      await gcCmd.parseAsync(["--dry-run"], { from: "user" })

      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.dryRun).toBe(true)
    })
  })

  // ── sync ─────────────────────────────────────────────────────────
  describe("sync", () => {
    it("calls POST /api/resources/sync", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: { drifts: [], totalDrifts: 0 },
      }))

      const syncCmd = resourceCmd.commands.find(c => c.name() === "sync")!
      await syncCmd.parseAsync([], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/sync",
        expect.objectContaining({ method: "POST" }),
      )
    })
  })

  // ── audit ────────────────────────────────────────────────────────
  describe("audit", () => {
    it("calls GET /api/resources/audit", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ data: [], meta: { total: 0, returned: 0 } }))

      const auditCmd = resourceCmd.commands.find(c => c.name() === "audit")!
      await auditCmd.parseAsync([], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/audit",
        undefined,
      )
    })

    it("passes filter params", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ data: [], meta: { total: 0, returned: 0 } }))

      const auditCmd = resourceCmd.commands.find(c => c.name() === "audit")!
      await auditCmd.parseAsync(["--last", "10", "--action", "install"], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("last=10"),
        undefined,
      )
    })
  })

  // ── doctor ───────────────────────────────────────────────────────
  describe("doctor", () => {
    it("calls GET /api/resources/doctor", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: { checks: [{ name: "registry", healthy: true }], healthy: true },
      }))

      const doctorCmd = resourceCmd.commands.find(c => c.name() === "doctor")!
      await doctorCmd.parseAsync([], { from: "user" })

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/resources/doctor",
        undefined,
      )
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("checks passed"))
    })

    it("reports failed checks", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({
        data: {
          checks: [
            { name: "registry", healthy: true },
            { name: "lock", healthy: false, detail: "stale lock detected" },
          ],
          healthy: false,
        },
      }))

      const doctorCmd = resourceCmd.commands.find(c => c.name() === "doctor")!
      await doctorCmd.parseAsync([], { from: "user" })

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("failed"))
    })
  })
})
