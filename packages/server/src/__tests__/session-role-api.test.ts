// Agent-session identity API (role switch).
// The card is delivered by the chat route; this route only owns the state.
// v59: identity targets the clone roster (built-in + user) — agency ids are
// rejected here now (legacy rows still resolve for reading).

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
    id: "s-role-api", repo_group: ORG, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

describe("agent session role API", () => {
  it("starts with no active identity", async () => {
    const res = await request("/api/agent/sessions/s-role-api/role")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      active_expert: null,
      active_kind: "expert",
      expert: null,
      clone: null,
      revision: 0,
      delivered_revision: 0,
    })
  })

  it("switches to a clone and bumps revision only on a real change", async () => {
    const first = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "workspace" }),
    })
    expect(first.status).toBe(200)
    const body = await first.json() as {
      active_expert: string
      active_kind: string
      clone: { id: string; display_name: string; memory_scope: string }
      revision: number
    }
    expect(body).toMatchObject({ active_expert: "workspace", active_kind: "clone", revision: 1 })
    expect(body.clone.id).toBe("workspace")
    expect(body.clone.display_name).toBeTruthy()
    expect(["shared", "isolated"]).toContain(body.clone.memory_scope)

    const same = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "workspace" }),
    })
    expect((await same.json() as { revision: number }).revision).toBe(1)

    const cleared = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: null }),
    })
    expect(await cleared.json()).toMatchObject({ active_expert: null, revision: 2 })
  })

  it("rejects unknown ids and legacy agency expert ids", async () => {
    const unknown = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "not-a-real-clone" }),
    })
    expect(unknown.status).toBe(400)

    // agency roster left the identity surface (v59) — clones only now.
    const agency = await request("/api/agent/sessions/s-role-api/role", {
      method: "PUT",
      body: JSON.stringify({ expert: "engineering-sre" }),
    })
    expect(agency.status).toBe(400)
  })
})
