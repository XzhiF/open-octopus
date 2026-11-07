// packages/server/src/routes/harness.ts
//
// Runtime supervision API — incident history + resolve/escalate.
// Mounted at /api/workspaces/:id/harness
//
// The global harness.yaml config endpoints were retired (2026-11-07): policy
// lives in the `octo-workflow-supervisor` Skill, safety lives in code guards.

import { Hono } from "hono"
import type { HarnessDAO } from "../db/dao/harness-dao"
import { normalizeHarnessTokenJson } from "../db/dao/usage-mapping"
import {
  escalateIncident,
  getIncident,
  listIncidents,
  parseDecision,
  resolveIncident,
} from "../services/supervision/supervision-service"

let _harnessDAO: HarnessDAO | null = null

export function setHarnessDependencies(dao: HarnessDAO): void {
  _harnessDAO = dao
}

export function getHarnessDAO(): HarnessDAO | null {
  return _harnessDAO
}

function requireDb() {
  if (!_harnessDAO) throw Object.assign(new Error("harness service not initialized"), { status: 503 })
  return _harnessDAO.getDb()
}

function handleError(err: unknown): Response {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string }
    return new Response(JSON.stringify({ error: e.message ?? "error" }), {
      status: e.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  throw err
}

const harnessRoutes = new Hono()

// ── GET /events/:execId — harness_events audit log (kept) ───────────────────

harnessRoutes.get("/events/:execId", (c) => {
  try {
    if (!_harnessDAO) {
      return c.json({ error: "harness service not initialized" }, 503)
    }
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "execId required" }, 400)
    const typeFilter = c.req.query("type") || undefined
    const severityFilter = c.req.query("severity") || undefined
    const events = _harnessDAO
      .findEvents(execId, { type: typeFilter, severity: severityFilter })
      .map((e) => ({ ...e, token_usage_json: normalizeHarnessTokenJson(e) }))
    return c.json({ events })
  } catch (err: unknown) {
    return handleError(err)
  }
})

// ── GET /incidents?execution_id=… — incident list for an execution ──────────

harnessRoutes.get("/incidents", (c) => {
  try {
    const db = requireDb()
    const executionId = c.req.query("execution_id")
    if (!executionId) return c.json({ error: "execution_id required" }, 400)
    return c.json({ incidents: listIncidents({ db }, executionId) })
  } catch (err: unknown) {
    return handleError(err)
  }
})

// ── GET /incidents/:incidentId — one incident (the chat card polls this) ────

harnessRoutes.get("/incidents/:incidentId", (c) => {
  try {
    const db = requireDb()
    const incident = getIncident({ db }, c.req.param("incidentId"))
    if (!incident) return c.json({ error: "incident not found" }, 404)
    return c.json({ incident })
  } catch (err: unknown) {
    return handleError(err)
  }
})

// ── POST /incidents/:incidentId/resolve — apply a Decision ──────────────────

harnessRoutes.post("/incidents/:incidentId/resolve", async (c) => {
  try {
    const db = requireDb()
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.type !== "string") {
      return c.json({ error: "body must include decision 'type'" }, 400)
    }
    const decision = parseDecision(body)
    if (!decision) return c.json({ error: `invalid decision for type ${body.type}` }, 400)
    const source = body.source === "user" ? "user" : body.source === "policy" ? "policy" : "agent"
    const result = await resolveIncident({
      db,
      incidentId: c.req.param("incidentId"),
      decision,
      source,
    })
    return c.json(result, result.ok ? 200 : 400)
  } catch (err: unknown) {
    return handleError(err)
  }
})

// ── POST /incidents/:incidentId/escalate — human confirmation card ─────────

harnessRoutes.post("/incidents/:incidentId/escalate", async (c) => {
  try {
    const db = requireDb()
    const body = await c.req.json().catch(() => ({}))
    const reason = typeof body?.reason === "string" ? body.reason : "需要人判断"
    const options = Array.isArray(body?.options)
      ? body.options.filter((o: unknown): o is string => typeof o === "string")
      : []
    const result = await escalateIncident({
      db,
      incidentId: c.req.param("incidentId"),
      reason,
      options,
    })
    return c.json(result, result.ok ? 200 : 400)
  } catch (err: unknown) {
    return handleError(err)
  }
})

export default harnessRoutes
