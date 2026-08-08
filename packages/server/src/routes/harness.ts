// packages/server/src/routes/harness.ts
//
// Harness API routes — config management and event history.
// Mounted at /api/workspaces/:id/harness

import { Hono } from "hono"
import type { HarnessDAO } from "../db/dao/harness-dao"
import { HarnessConfigService, HarnessConfigError } from "../services/harness/config-service"

let _harnessDAO: HarnessDAO | null = null

export function setHarnessDependencies(dao: HarnessDAO): void {
  _harnessDAO = dao
}

export function getHarnessDAO(): HarnessDAO | null {
  return _harnessDAO
}

function getConfigService(): HarnessConfigService {
  if (!_harnessDAO) throw new HarnessConfigError("harness service not initialized", 503)
  return new HarnessConfigService(_harnessDAO)
}

function handleHarnessError(err: unknown): Response {
  if (err instanceof HarnessConfigError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { "Content-Type": "application/json" },
    })
  }
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string }
    return new Response(JSON.stringify({ error: e.message }), { status: e.status })
  }
  throw err
}

const harnessRoutes = new Hono()

// ── GET /config — return current harness config YAML + version ──────────────

harnessRoutes.get("/config", (c) => {
  try {
    const service = getConfigService()
    const result = service.getConfig()
    return c.json(result)
  } catch (err: unknown) {
    return handleHarnessError(err)
  }
})

// ── PUT /config — validate + save + return new version ──────────────────────

harnessRoutes.put("/config", async (c) => {
  try {
    const service = getConfigService()
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.config !== "string") {
      return c.json({ error: "body must include 'config' string" }, 400)
    }
    const result = service.saveConfig(body.config)
    return c.json(result)
  } catch (err: unknown) {
    return handleHarnessError(err)
  }
})

// ── GET /events/:execId — return harness_events list ────────────────────────

harnessRoutes.get("/events/:execId", (c) => {
  try {
    if (!_harnessDAO) throw new HarnessConfigError("harness service not initialized", 503)
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "execId required" }, 400)

    const typeFilter = c.req.query("type") || undefined
    const severityFilter = c.req.query("severity") || undefined

    const events = _harnessDAO.findEvents(execId, {
      type: typeFilter,
      severity: severityFilter,
    })
    return c.json({ events })
  } catch (err: unknown) {
    return handleHarnessError(err)
  }
})

export default harnessRoutes
