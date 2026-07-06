import { Hono } from "hono"
import type { Context } from "hono"
import { ResourceManager, ResourceError } from "@octopus/shared"
import type { ResourceType, AuditEntry } from "@octopus/shared"
import { agentAuthMiddleware } from "../agent/middleware"
import { resourceCors, requireJsonBody } from "./middleware"

/**
 * Factory function that creates the resource management route group.
 *
 * `getManager` is a thunk to support per-org singleton resolution —
 * the server index.ts wraps org-specific ResourceManager lookup.
 */
export function createResourceRoutes(getManager: () => ResourceManager): Hono {
  const app = new Hono()

  // ── Global middleware for this route group ─────────────────────
  app.use("*", resourceCors)
  app.use("*", agentAuthMiddleware)
  app.use("*", requireJsonBody)

  // ── Path-param validation ──────────────────────────────────────
  const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/
  const isValidName = (name: string): boolean => SAFE_NAME_RE.test(name) && name.length <= 128
  const VALID_TYPES: ReadonlySet<string> = new Set(["skill", "agent", "workflow"])
  const isValidType = (type: string): boolean => VALID_TYPES.has(type)

  // ── Error helper ───────────────────────────────────────────────
  function handleError(c: Context, err: unknown) {
    if (err instanceof ResourceError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.suggestion ? { hint: err.suggestion } : {}),
          },
        },
        err.httpStatus as any,
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("Export limited")) {
      return c.json(
        { error: { code: "EXPORT_TOO_LARGE", message } },
        413 as any,
      )
    }
    console.error("[resource] Unexpected error:", err)
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
      500 as any,
    )
  }

  // ── 1. GET / — list resources ──────────────────────────────────
  app.get("/", (c) => {
    try {
      const mgr = getManager()
      const typeParam = c.req.query("type")
      const query = c.req.query("query")
      const installedParam = c.req.query("installed")
      const tag = c.req.query("tag")

      const filter: Record<string, unknown> = {}
      if (typeParam && isValidType(typeParam)) {
        filter.type = typeParam as ResourceType
      }
      if (query) filter.query = query
      if (installedParam !== undefined) {
        filter.installed = installedParam === "true"
      }
      if (tag) filter.tag = tag

      const data = mgr.list(filter as Parameters<typeof mgr.list>[0])
      return c.json({ data, meta: { total: data.length, returned: data.length } })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 8. GET /audit — audit log (must register before /:type/:name) ──
  app.get("/audit", (c) => {
    try {
      const mgr = getManager()
      const lastParam = c.req.query("last")
      const action = c.req.query("action")
      const resource = c.req.query("resource")

      const filter: { last?: number; action?: AuditEntry["action"]; resource?: string } = {}
      if (lastParam) {
        const n = parseInt(lastParam, 10)
        if (Number.isFinite(n) && n > 0) filter.last = n
      }
      if (action) filter.action = action as AuditEntry["action"]
      if (resource) filter.resource = resource

      const data = mgr.audit.read(filter)
      return c.json({ data, meta: { total: data.length, returned: data.length } })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 9. GET /audit/export — audit export ────────────────────────
  app.get("/audit/export", (c) => {
    try {
      const mgr = getManager()
      const since = c.req.query("since")
      const data = mgr.audit.export(since)
      return c.json({ data, meta: { total: data.length, returned: data.length } })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 10. GET /doctor — health check ─────────────────────────────
  app.get("/doctor", (c) => {
    try {
      const mgr = getManager()
      const result = mgr.doctor()
      return c.json({ data: result })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 4. POST /install — install resource ────────────────────────
  app.post("/install", async (c) => {
    try {
      const mgr = getManager()
      const body = await c.req.json<{ ref?: string }>()
      const ref = body.ref
      if (!ref || typeof ref !== "string") {
        return c.json(
          { error: { code: "INVALID_PARAM", message: "Missing or invalid 'ref' in request body" } },
          400 as any,
        )
      }
      const result = await mgr.install(ref)
      return c.json({ data: result }, 201 as any)
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 5. POST /uninstall — uninstall resource ────────────────────
  app.post("/uninstall", async (c) => {
    try {
      const mgr = getManager()
      const body = await c.req.json<{ name?: string; type?: string }>()
      const { name, type } = body

      if (!name || typeof name !== "string") {
        return c.json(
          { error: { code: "INVALID_PARAM", message: "Missing or invalid 'name' in request body" } },
          400 as any,
        )
      }
      if (!type || !isValidType(type)) {
        return c.json(
          { error: { code: "INVALID_PARAM", message: "Missing or invalid 'type' in request body. Must be: skill, agent, or workflow" } },
          400 as any,
        )
      }

      await mgr.uninstall(name, type as ResourceType)
      return c.json({ data: { name, type, uninstalled: true } })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 6. POST /gc — garbage collect ─────────────────────────────
  app.post("/gc", async (c) => {
    try {
      const mgr = getManager()
      let body: { dryRun?: boolean } = {}
      try {
        body = await c.req.json()
      } catch {
        // empty body is acceptable
      }
      const dryRun = body.dryRun === true
      const result = await mgr.gc({ dryRun })
      return c.json({ data: result })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 7. POST /sync — drift detect/fix ──────────────────────────
  app.post("/sync", async (c) => {
    try {
      const mgr = getManager()
      let body: { fix?: boolean; targets?: string[] } = {}
      try {
        body = await c.req.json()
      } catch {
        // empty body is acceptable
      }
      const fix = body.fix === true
      const targets = Array.isArray(body.targets)
        ? body.targets.filter((t: unknown): t is string => typeof t === "string")
        : undefined
      const result = await mgr.sync({ fix, targets })
      return c.json({ data: result })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 2. GET /:type/:name — resource detail ──────────────────────
  app.get("/:type/:name", (c) => {
    try {
      const mgr = getManager()
      const type = c.req.param("type")
      const name = c.req.param("name")

      if (!isValidType(type)) {
        return c.json(
          { error: { code: "INVALID_PARAM", message: `Invalid resource type: '${type}'. Must be: skill, agent, or workflow` } },
          400 as any,
        )
      }
      if (!isValidName(name)) {
        return c.json(
          { error: { code: "INVALID_PARAM", message: "Invalid resource name format" } },
          400 as any,
        )
      }

      const entry = mgr.info(name, type as ResourceType)
      if (!entry) {
        return c.json(
          { error: { code: "RESOURCE_NOT_FOUND", message: `Resource '${type}/${name}' not found` } },
          404 as any,
        )
      }

      return c.json({ data: entry })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── 3. GET /:type/:name/deps — dependency tree ─────────────────
  app.get("/:type/:name/deps", (c) => {
    try {
      const mgr = getManager()
      const type = c.req.param("type")
      const name = c.req.param("name")

      if (!isValidType(type)) {
        return c.json(
          { error: { code: "INVALID_PARAM", message: `Invalid resource type: '${type}'. Must be: skill, agent, or workflow` } },
          400 as any,
        )
      }
      if (!isValidName(name)) {
        return c.json(
          { error: { code: "INVALID_PARAM", message: "Invalid resource name format" } },
          400 as any,
        )
      }

      const entry = mgr.info(name, type as ResourceType)
      if (!entry) {
        return c.json(
          { error: { code: "RESOURCE_NOT_FOUND", message: `Resource '${type}/${name}' not found` } },
          404 as any,
        )
      }

      const order = mgr.resolver.resolveTree(name)
      return c.json({ data: { name, type, order, depth: order.length } })
    } catch (err) {
      return handleError(c, err)
    }
  })

  return app
}
