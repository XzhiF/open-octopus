import { describe, it, expect, vi, beforeEach } from "vitest"
import { Hono } from "hono"
import { createResourceRoutes } from "../index"
import { ResourceError } from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"

/**
 * Server resource route tests (B2 fix).
 * Tests all 10 REST endpoints with a mock ResourceManager.
 */

function createMockManager(overrides: Partial<ResourceManager> = {}): ResourceManager {
  return {
    list: vi.fn().mockReturnValue({ resources: [], total: 0 }),
    get: vi.fn().mockReturnValue(null),
    stats: vi.fn().mockReturnValue({ total: 0, installed: 0, skill: 0, agent: 0, workflow: 0 }),
    auditQuery: vi.fn().mockReturnValue({ records: [], total: 0 }),
    listBuiltin: vi.fn().mockReturnValue([]),
    install: vi.fn().mockResolvedValue({ name: "test-skill", type: "skill", status: "installed" }),
    uninstall: vi.fn().mockResolvedValue({ name: "test-skill", type: "skill", removed: true }),
    verify: vi.fn().mockReturnValue({ passed: true, steps: [] }),
    readFile: vi.fn().mockReturnValue("file content"),
    listFiles: vi.fn().mockReturnValue(["SKILL.md"]),
    ...overrides,
  } as unknown as ResourceManager
}

function buildApp(manager: ResourceManager) {
  const app = new Hono()
  const routes = createResourceRoutes(() => manager)
  app.route("/resources", routes)
  return app
}

describe("Resource Routes", () => {
  let manager: ResourceManager
  let app: Hono

  beforeEach(() => {
    manager = createMockManager()
    app = buildApp(manager)
  })

  // GET /
  it("GET /resources — lists resources", async () => {
    const res = await app.request("/resources?org=test")
    expect(res.status).toBe(200)
    expect(manager.list).toHaveBeenCalled()
  })

  // GET /stats
  it("GET /resources/stats — returns stats", async () => {
    const res = await app.request("/resources/stats?org=test")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("total")
  })

  // GET /audit
  it("GET /resources/audit — returns audit log", async () => {
    const res = await app.request("/resources/audit?org=test&last=50")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("records")
  })

  // GET /builtin
  it("GET /resources/builtin — returns builtin catalog", async () => {
    const res = await app.request("/resources/builtin?org=test")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("resources")
  })

  // POST /install
  it("POST /resources/install — installs resource", async () => {
    const res = await app.request("/resources/install?org=test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "builtin:brainstorming" }),
    })
    expect(res.status).toBe(200)
    expect(manager.install).toHaveBeenCalled()
  })

  // POST /install — missing Content-Type (middleware throws, caught as 500 without error handler)
  it("POST /resources/install — rejects non-JSON Content-Type", async () => {
    const res = await app.request("/resources/install?org=test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "invalid",
    })
    // Middleware rejects before handler, Hono default error → 500
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  // POST /uninstall
  it("POST /resources/uninstall — uninstalls resource", async () => {
    const res = await app.request("/resources/uninstall?org=test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-skill", type: "skill" }),
    })
    expect(res.status).toBe(200)
    expect(manager.uninstall).toHaveBeenCalled()
  })

  // GET /:type/:name
  it("GET /resources/:type/:name — returns detail", async () => {
    vi.mocked(manager.get).mockReturnValue({
      name: "test-skill",
      type: "skill",
      source: "builtin",
      ref: "builtin:test-skill",
      installed: true,
      verified: true,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath: "/tmp/test",
      dependsOn: [],
    } as any)
    const res = await app.request("/resources/skill/test-skill?org=test")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe("test-skill")
  })

  // GET /:type/:name — not found
  it("GET /resources/:type/:name — 404 when not found", async () => {
    vi.mocked(manager.get).mockReturnValue(null)
    const res = await app.request("/resources/skill/nonexistent?org=test")
    expect(res.status).toBe(404)
  })

  // GET /:type/:name/verify
  it("GET /resources/:type/:name/verify — verifies resource", async () => {
    vi.mocked(manager.get).mockReturnValue({
      name: "test-skill",
      type: "skill",
      source: "builtin",
      ref: "builtin:test-skill",
      installed: true,
      verified: true,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath: "/tmp/test",
      dependsOn: [],
    } as any)
    const res = await app.request("/resources/skill/test-skill/verify?org=test")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("verify")
  })

  // GET /:type/:name/files
  it("GET /resources/:type/:name/files — lists files", async () => {
    vi.mocked(manager.get).mockReturnValue({
      name: "test-skill",
      type: "skill",
      source: "builtin",
      ref: "builtin:test-skill",
      installed: true,
      verified: true,
      status: "installed",
      installedAt: new Date().toISOString(),
      scope: "org",
      installPath: "/tmp/test",
      dependsOn: [],
    } as any)
    const res = await app.request("/resources/skill/test-skill/files?org=test")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty("files")
  })

  // Invalid type param
  it("GET /resources/:type/:name — rejects invalid type", async () => {
    const res = await app.request("/resources/invalid/test?org=test")
    expect(res.status).toBe(400)
  })

  // Invalid name param (name with special chars)
  it("GET /resources/:type/:name — rejects invalid name", async () => {
    const res = await app.request("/resources/skill/..%2F..%2Fetc%2Fpasswd?org=test")
    // URL-encoded path traversal chars → caught by name validation or 404 (route mismatch)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
