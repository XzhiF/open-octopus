import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import type { ResourceManager, RegistryEntry, AuditEntry } from "@octopus/shared"
import { ResourceError } from "@octopus/shared"

// Mock agent auth middleware to bypass authentication in tests
vi.mock("../routes/agent/middleware", () => ({
  agentAuthMiddleware: async (_c: any, next: any) => { await next() },
}))

import { createResourceRoutes } from "../routes/resource"

function mockManager(overrides: Partial<ResourceManager> = {}): ResourceManager {
  return {
    list: vi.fn().mockReturnValue([]),
    info: vi.fn().mockReturnValue(null),
    install: vi.fn().mockResolvedValue({ name: "test-skill", type: "skill", version: "1.0.0" }),
    uninstall: vi.fn().mockResolvedValue(undefined),
    gc: vi.fn().mockResolvedValue({ removed: [], freedBytes: 0, freedHuman: "0 B" }),
    sync: vi.fn().mockResolvedValue({ drifts: [], totalDrifts: 0 }),
    doctor: vi.fn().mockReturnValue({ checks: [], healthy: true }),
    audit: {
      read: vi.fn().mockReturnValue([]),
      export: vi.fn().mockReturnValue([]),
    },
    resolver: {
      resolveTree: vi.fn().mockReturnValue([]),
      getReverseDeps: vi.fn().mockReturnValue([]),
    },
    ...overrides,
  } as unknown as ResourceManager
}

function buildApp(mgr: ResourceManager) {
  const app = new Hono()
  app.route("/", createResourceRoutes(() => mgr))
  return app
}

describe("Resource Routes", () => {
  // ── GET / (list) ─────────────────────────────────────────────────
  describe("GET /", () => {
    it("returns empty list with meta", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toEqual([])
      expect(body.meta.total).toBe(0)
    })

    it("passes type filter to manager", async () => {
      const entry = { name: "s1", type: "skill", version: "1.0.0" } as RegistryEntry
      const mgr = mockManager({ list: vi.fn().mockReturnValue([entry]) })
      const app = buildApp(mgr)
      const res = await app.request("/?type=skill")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toHaveLength(1)
      expect(mgr.list).toHaveBeenCalledWith(expect.objectContaining({ type: "skill" }))
    })

    it("passes query filter to manager", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/?query=deploy")
      expect(mgr.list).toHaveBeenCalledWith(expect.objectContaining({ query: "deploy" }))
    })
  })

  // ── GET /:type/:name (detail) ────────────────────────────────────
  describe("GET /:type/:name", () => {
    it("returns entry when found", async () => {
      const entry = { name: "octo-creator", type: "skill", version: "2.0.0" } as RegistryEntry
      const mgr = mockManager({ info: vi.fn().mockReturnValue(entry) })
      const app = buildApp(mgr)
      const res = await app.request("/skill/octo-creator")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.name).toBe("octo-creator")
    })

    it("returns 404 when not found", async () => {
      const mgr = mockManager({ info: vi.fn().mockReturnValue(null) })
      const app = buildApp(mgr)
      const res = await app.request("/skill/nonexistent")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error.code).toBe("RESOURCE_NOT_FOUND")
    })

    it("returns 400 for invalid type", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/invalid/foo")
      expect(res.status).toBe(400)
    })

    it("returns 400 for invalid name format", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/skill/../../etc/passwd")
      expect(res.status).toBe(400)
    })
  })

  // ── GET /:type/:name/deps ────────────────────────────────────────
  describe("GET /:type/:name/deps", () => {
    it("returns forward and reverse deps", async () => {
      const entry = { name: "s1", type: "skill", version: "1.0.0" } as RegistryEntry
      const mgr = mockManager({
        info: vi.fn().mockReturnValue(entry),
        resolver: {
          resolveTree: vi.fn().mockReturnValue(["dep1"]),
          getReverseDeps: vi.fn().mockReturnValue([]),
        } as any,
      })
      const app = buildApp(mgr)
      const res = await app.request("/skill/s1/deps")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toHaveProperty("forward")
      expect(body.data).toHaveProperty("reverse")
      expect(Array.isArray(body.data.forward)).toBe(true)
    })

    it("returns 404 for missing resource", async () => {
      const mgr = mockManager({ info: vi.fn().mockReturnValue(null) })
      const app = buildApp(mgr)
      const res = await app.request("/skill/missing/deps")
      expect(res.status).toBe(404)
    })
  })

  // ── POST /install ────────────────────────────────────────────────
  describe("POST /install", () => {
    it("installs resource and returns 200", async () => {
      const entry = { name: "test-skill", type: "skill", version: "1.0.0" } as RegistryEntry
      const mgr = mockManager({ install: vi.fn().mockResolvedValue(entry) })
      const app = buildApp(mgr)
      const res = await app.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "builtin:test-skill" }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.name).toBe("test-skill")
    })

    it("returns 400 when ref is missing", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it("maps ResourceError to HTTP status", async () => {
      const mgr = mockManager({
        install: vi.fn().mockRejectedValue(new ResourceError("ALREADY_INSTALLED", "Already installed")),
      })
      const app = buildApp(mgr)
      const res = await app.request("/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "builtin:foo" }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error.code).toBe("ALREADY_INSTALLED")
    })
  })

  // ── POST /uninstall ──────────────────────────────────────────────
  describe("POST /uninstall", () => {
    it("uninstalls resource", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "foo", type: "skill" }),
      })
      expect(res.status).toBe(200)
      expect(mgr.uninstall).toHaveBeenCalledWith("foo", "skill")
    })

    it("returns 400 when name is missing", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "skill" }),
      })
      expect(res.status).toBe(400)
    })

    it("returns 409 when resource has dependents", async () => {
      const mgr = mockManager({
        uninstall: vi.fn().mockRejectedValue(new ResourceError("HAS_DEPENDENTS", "Has dependents")),
      })
      const app = buildApp(mgr)
      const res = await app.request("/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "base", type: "skill" }),
      })
      expect(res.status).toBe(409)
    })
  })

  // ── POST /gc ─────────────────────────────────────────────────────
  describe("POST /gc", () => {
    it("runs garbage collection", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/gc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toHaveProperty("removed")
      expect(body.data).toHaveProperty("freedBytes")
    })

    it("supports dry run", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/gc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      })
      expect(mgr.gc).toHaveBeenCalledWith({ dryRun: true })
    })
  })

  // ── POST /sync ───────────────────────────────────────────────────
  describe("POST /sync", () => {
    it("runs drift detection", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fix: false }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toHaveProperty("drifts")
      expect(body.data).toHaveProperty("totalDrifts")
    })

    it("supports targets filter", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fix: true, targets: ["skill-a"] }),
      })
      expect(mgr.sync).toHaveBeenCalledWith(expect.objectContaining({
        fix: true,
        targets: ["skill-a"],
      }))
    })
  })

  // ── GET /audit ───────────────────────────────────────────────────
  describe("GET /audit", () => {
    it("returns audit entries", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/audit")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toEqual([])
    })

    it("passes filter params", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/audit?last=10&action=install&resource=foo")
      expect(mgr.audit.read).toHaveBeenCalledWith(expect.objectContaining({
        last: 10,
        action: "install",
        resource: "foo",
      }))
    })

    it("caps last at 1000", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/audit?last=5000")
      expect(mgr.audit.read).toHaveBeenCalledWith(expect.objectContaining({ last: 1000 }))
    })
  })

  // ── GET /audit/export ────────────────────────────────────────────
  describe("GET /audit/export", () => {
    it("exports audit entries", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/audit/export")
      expect(res.status).toBe(200)
    })

    it("passes since param", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      await app.request("/audit/export?since=2025-01-01T00:00:00Z")
      expect(mgr.audit.export).toHaveBeenCalledWith("2025-01-01T00:00:00Z")
    })
  })

  // ── GET /doctor ──────────────────────────────────────────────────
  describe("GET /doctor", () => {
    it("returns health check result", async () => {
      const mgr = mockManager()
      const app = buildApp(mgr)
      const res = await app.request("/doctor")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data).toHaveProperty("checks")
      expect(body.data).toHaveProperty("healthy")
    })
  })
})
