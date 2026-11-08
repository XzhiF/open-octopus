import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import { HarnessDAO } from "../../db/dao/harness-dao"
import { IncidentStore } from "../../services/supervision/incident-store"
import harnessRoutes, { setHarnessDependencies } from "../harness"
import type { HarnessEvent } from "@octopus/shared"

let db: Database.Database
let dao: HarnessDAO
let dbPath: string
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

function seedIncident(overrides: Record<string, unknown> = {}) {
  return new IncidentStore(db).open({
    executionId: "exec-001",
    workspaceId: "ws-1",
    nodeId: "step1",
    phase: "before_retry",
    severity: "warning",
    kind: "stupid_retry",
    summary: "same error twice",
    evidence: [{ attempt: 2 }],
    contextRef: "execution:exec-001/node:step1",
    allowedActions: ["proceed", "retry", "escalate"],
    ...overrides,
  })
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

describe("Harness API Routes — events", () => {
  it("returns persisted harness_events for an execution", async () => {
    dao.insertEvent(makeEvent())
    const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001")
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.events).toHaveLength(1)
    expect(data.events[0].detector).toBe("stupid_retry")
  })

  it("filters by type", async () => {
    dao.insertEvent(makeEvent({ event_type: "diagnosis" }))
    dao.insertEvent(makeEvent({ event_type: "intervention" }))
    const res = await request("GET", "/api/workspaces/ws-1/harness/events/exec-001?type=diagnosis")
    const data = (await res.json()) as any
    expect(data.events).toHaveLength(1)
  })
})

describe("Harness API Routes — incidents", () => {
  it("lists incidents for an execution", async () => {
    seedIncident()
    const res = await request("GET", "/api/workspaces/ws-1/harness/incidents?execution_id=exec-001")
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.incidents).toHaveLength(1)
    expect(data.incidents[0].kind).toBe("stupid_retry")
  })

  it("requires execution_id", async () => {
    const res = await request("GET", "/api/workspaces/ws-1/harness/incidents")
    expect(res.status).toBe(400)
  })

  it("returns one incident by id", async () => {
    const inc = seedIncident()
    const res = await request("GET", `/api/workspaces/ws-1/harness/incidents/${inc.id}`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.incident.id).toBe(inc.id)
  })

  it("404 for unknown incident", async () => {
    const res = await request("GET", "/api/workspaces/ws-1/harness/incidents/nope")
    expect(res.status).toBe(404)
  })

  it("resolves with a whitelisted decision", async () => {
    const inc = seedIncident()
    const res = await request("POST", `/api/workspaces/ws-1/harness/incidents/${inc.id}/resolve`, {
      type: "proceed",
      source: "user",
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.ok).toBe(true)
    expect(data.status).toBe("resolved")
    expect(new IncidentStore(db).findById(inc.id)?.status).toBe("resolved")
  })

  it("rejects an action outside the whitelist", async () => {
    const inc = seedIncident({ allowedActions: ["proceed"] })
    const res = await request("POST", `/api/workspaces/ws-1/harness/incidents/${inc.id}/resolve`, {
      type: "abort",
      reason: "nope",
    })
    expect(res.status).toBe(400)
    expect(new IncidentStore(db).findById(inc.id)?.status).not.toBe("resolved")
  })

  it("rejects an invalid decision type", async () => {
    const inc = seedIncident()
    const res = await request("POST", `/api/workspaces/ws-1/harness/incidents/${inc.id}/resolve`, {
      type: "nonsense",
    })
    expect(res.status).toBe(400)
  })

  it("escalates to waiting_human", async () => {
    const inc = seedIncident()
    const res = await request("POST", `/api/workspaces/ws-1/harness/incidents/${inc.id}/escalate`, {
      reason: "需要业务判断",
      options: ["继续", "中止"],
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as any
    expect(data.status).toBe("waiting_human")
    expect(new IncidentStore(db).findById(inc.id)?.status).toBe("waiting_human")
  })
})
