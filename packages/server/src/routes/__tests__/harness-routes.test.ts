import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../db/schema"
import { HarnessDAO } from "../../db/dao/harness-dao"
import harnessRoutes, { setHarnessDependencies } from "../harness"
import type { HarnessEvent } from "@octopus/shared"

let db: Database.Database
let dao: HarnessDAO
let dbPath: string

// Create a Hono app to test routes
import { Hono } from "hono"
let app: Hono

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-harness-routes-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new HarnessDAO(db)
  setHarnessDependencies(dao)

  app = new Hono()
  app.route("/api/workspaces/:id/harness", harnessRoutes)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    execution_id: "exec-001",
    node_id: "step1",
    timestamp: Date.now(),
    event_type: "diagnosis",
    detector: "stupid_retry",
    severity: "warning",
    report_json: JSON.stringify({ detector: "stupid_retry" }),
    action_json: null,
    result_json: null,
    token_usage_json: null,
    created_at: Date.now(),
    ...overrides,
  }
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const url = `http://localhost${path}`
  const init: RequestInit = { method }
  if (body) {
    init.body = JSON.stringify(body)
    init.headers = { "Content-Type": "application/json" }
  }
  return app.fetch(new Request(url, init))
}

describe("Harness API Routes", () => {
  describe("GET /api/workspaces/:id/harness/config", () => {
    it("returns default config when no DB config exists", async () => {
      const res = await request("GET", "/api/workspaces/ws-1/harness/config")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.source).toBe("defaults")
      expect(data.version).toBe(0)
      expect(data.config).toContain("detectors")
    })

    it("returns saved config after PUT", async () => {
      const yaml = "detectors:\n  stupid_retry:\n    enabled: true\n"
      await request("PUT", "/api/workspaces/ws-1/harness/config", { config: yaml })

      const res = await request("GET", "/api/workspaces/ws-1/harness/config")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.source).toBe("db")
      expect(data.version).toBe(1)
    })
  })

  describe("PUT /api/workspaces/:id/harness/config", () => {
    it("saves valid config and returns version", async () => {
      const yaml = `
detectors:
  stupid_retry:
    enabled: true
    threshold: 3
strategies: []
`
      const res = await request("PUT", "/api/workspaces/ws-1/harness/config", { config: yaml })
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.success).toBe(true)
      expect(data.version).toBe(1)
    })

    it("rejects invalid YAML", async () => {
      const res = await request("PUT", "/api/workspaces/ws-1/harness/config", { config: "just a string" })
      expect(res.status).toBe(400)
    })

    it("rejects missing config field", async () => {
      const res = await request("PUT", "/api/workspaces/ws-1/harness/config", { wrong: "field" })
      expect(res.status).toBe(400)
    })

    it("bumps version on subsequent saves", async () => {
      const yaml1 = "detectors:\n  stupid_retry:\n    enabled: true\n"
      const yaml2 = "detectors:\n  stupid_retry:\n    enabled: false\n"

      const r1 = await request("PUT", "/api/workspaces/ws-1/harness/config", { config: yaml1 })
      const d1 = await r1.json() as any
      expect(d1.version).toBe(1)

      const r2 = await request("PUT", "/api/workspaces/ws-1/harness/config", { config: yaml2 })
      const d2 = await r2.json() as any
      expect(d2.version).toBe(2)
    })
  })

  describe("GET /api/workspaces/:id/harness/events/:execId", () => {
    it("returns empty events list when no events exist", async () => {
      const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001")
      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.events).toEqual([])
    })

    it("returns events for a specific execution", async () => {
      dao.insertEvent(makeEvent({ id: "e1", execution_id: "exec-001" }))
      dao.insertEvent(makeEvent({ id: "e2", execution_id: "exec-001" }))
      dao.insertEvent(makeEvent({ id: "e3", execution_id: "exec-002" }))

      const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001")
      const data = await res.json() as any
      expect(data.events).toHaveLength(2)
    })

    it("filters events by type query param", async () => {
      dao.insertEvent(makeEvent({ id: "e1", event_type: "diagnosis" }))
      dao.insertEvent(makeEvent({ id: "e2", event_type: "intervention" }))

      const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001?type=intervention")
      const data = await res.json() as any
      expect(data.events).toHaveLength(1)
      expect(data.events[0].event_type).toBe("intervention")
    })

    it("filters events by severity query param", async () => {
      dao.insertEvent(makeEvent({ id: "e1", severity: "warning" }))
      dao.insertEvent(makeEvent({ id: "e2", severity: "critical" }))

      const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001?severity=critical")
      const data = await res.json() as any
      expect(data.events).toHaveLength(1)
      expect(data.events[0].severity).toBe("critical")
    })
  })
})
