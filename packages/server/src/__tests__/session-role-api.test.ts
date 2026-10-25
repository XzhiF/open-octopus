// Agent-session expert identity API (role switch).
// The card is delivered by the chat route; this route only owns the state.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { createSessionRoutes } from "../routes/agent/sessions"

const ORG = "e2e-role-api"
let db: Database.Database
let sessionDAO: AgentSessionDAO
let app: Hono

function request(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Octopus-Org": ORG,
      ...init?.headers,
    },
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
  app = new Hono()
  app.route("/api/agent", createSessionRoutes(sessionDAO))
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM session_role_states").run()
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: "s-role-api", org: ORG, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

describe("agent session role API", () => {
  it("starts with no active expert", async () => {
    const res = await request("/api/agent/sessions/s-role-api/role")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      active_expert: null,
      expert: null,
      revision: 0,
      delivered_revision: 0,
    })
  })

  it("switches identity and bumps revision only on a real change", async () => {
    const first = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "engineering-sre" }),
    })
    expect(first.status).toBe(200)
    const body = await first.json() as { active_expert: string; expert: { name: string }; revision: number }
    expect(body).toMatchObject({ active_expert: "engineering-sre", revision: 1 })
    expect(body.expert.name).toBe("SRE")

    const same = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "engineering-sre" }),
    })
    expect((await same.json() as { revision: number }).revision).toBe(1)

    const cleared = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: null }),
    })
    expect(await cleared.json()).toMatchObject({ active_expert: null, revision: 2 })
  })

  it("rejects an unknown expert id", async () => {
    const res = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "not-a-real-expert" }),
    })
    expect(res.status).toBe(400)
  })
})
