import { Hono } from "hono"
import type { DemandDAO } from "../db/dao/demand-dao"
import type { DemandService } from "../services/task-board/demand-service"
import {
  InvalidTransitionError,
  DemandNotFoundError,
} from "../services/task-board/demand-service"
import {
  createDemandInputSchema,
  updateDemandInputSchema,
  type DemandStatus,
} from "@octopus/shared"
import { z } from "zod"

/**
 * Factory function to create task-board routes.
 * Delegates to DemandService for business logic and DemandDAO for direct data access.
 */
export function createTaskBoardRoutes(
  service: DemandService,
  dao: DemandDAO,
): Hono {
  const routes = new Hono()

  // ─────────────────────────────────────────────────────────────
  // Pool endpoints (must be before :id routes to avoid conflicts)
  // ─────────────────────────────────────────────────────────────

  // #11 GET /pool/status — count demands by status
  routes.get("/pool/status", (c) => {
    try {
      const counts = dao.countByStatus()
      return c.json(counts, 200)
    } catch (err) {
      return handleError(c, err, "pool.status")
    }
  })

  // #12 GET /pool/queue — list ready demands (priority-ordered)
  routes.get("/pool/queue", (c) => {
    try {
      const limit = parseInt(c.req.query("limit") ?? "100", 10)
      const demands = dao.listReady(limit)
      return c.json({ demands }, 200)
    } catch (err) {
      return handleError(c, err, "pool.queue")
    }
  })

  // ─────────────────────────────────────────────────────────────
  // CRUD endpoints
  // ─────────────────────────────────────────────────────────────

  // #1 GET /demands — list with filters and pagination
  routes.get("/demands", (c) => {
    try {
      const status = c.req.query("status") as string | undefined
      const priority = c.req.query("priority") as string | undefined
      const createdAtFrom = c.req.query("createdAtFrom") as string | undefined
      const createdAtTo = c.req.query("createdAtTo") as string | undefined
      const page = parseInt(c.req.query("page") ?? "1", 10)
      const pageSize = Math.min(100, parseInt(c.req.query("pageSize") ?? "20", 10))

      const result = service.list(
        { status, priority, createdAtFrom, createdAtTo },
        page,
        pageSize,
      )

      return c.json({ demands: result.data, total: result.total }, 200)
    } catch (err) {
      return handleError(c, err, "demands.list")
    }
  })

  // #2 POST /demands — create new demand (returns 201)
  routes.post("/demands", async (c) => {
    try {
      const body = await c.req.json()
      const input = createDemandInputSchema.parse(body)
      const demand = service.create(input)
      return c.json({ demand }, 201)
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: err.message, issues: err.issues } },
          400,
        )
      }
      return handleError(c, err, "demands.create")
    }
  })

  // #3 GET /demands/:id — get by ID (200 or 404)
  routes.get("/demands/:id", (c) => {
    try {
      const id = c.req.param("id")
      const demand = service.getById(id)
      if (!demand) {
        return c.json({ error: { code: "NOT_FOUND", message: `Demand not found: ${id}` } }, 404)
      }
      return c.json({ demand }, 200)
    } catch (err) {
      return handleError(c, err, "demands.getById")
    }
  })

  // #4 PATCH /demands/:id — update (allowlist-protected fields)
  routes.patch("/demands/:id", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json()

      // Check if demand exists
      const existing = service.getById(id)
      if (!existing) {
        return c.json({ error: { code: "NOT_FOUND", message: `Demand not found: ${id}` } }, 404)
      }

      // Validate input via Zod (only title, description, priority allowed)
      const validated = updateDemandInputSchema.parse(body)

      // DAO update uses its own allowlist internally
      dao.update(id, validated as any)

      // Read back the updated demand
      const updated = service.getById(id)
      return c.json({ demand: updated }, 200)
    } catch (err) {
      if (err instanceof z.ZodError) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: err.message, issues: err.issues } },
          400,
        )
      }
      return handleError(c, err, "demands.update")
    }
  })

  // #5 DELETE /demands/:id — delete demand
  routes.delete("/demands/:id", (c) => {
    try {
      const id = c.req.param("id")
      dao.delete(id)
      return c.json({ success: true }, 200)
    } catch (err) {
      return handleError(c, err, "demands.delete")
    }
  })

  // ─────────────────────────────────────────────────────────────
  // Lifecycle action endpoints
  // ─────────────────────────────────────────────────────────────

  // #6 POST /demands/:id/ready — mark as ready (incubated → ready)
  routes.post("/demands/:id/ready", (c) => {
    try {
      const id = c.req.param("id")
      const demand = service.markReady(id)
      return c.json({ demand }, 200)
    } catch (err) {
      return handleError(c, err, "demands.ready")
    }
  })

  // #7 POST /demands/:id/retry — retry failed demand (failed → ready)
  routes.post("/demands/:id/retry", (c) => {
    try {
      const id = c.req.param("id")
      const demand = service.retry(id)
      return c.json({ demand }, 200)
    } catch (err) {
      return handleError(c, err, "demands.retry")
    }
  })

  // ─────────────────────────────────────────────────────────────
  // Stub endpoints (future: chat integration)
  // ─────────────────────────────────────────────────────────────

  // #8 GET /demands/:id/chat — stub: return empty messages
  routes.get("/demands/:id/chat", (c) => {
    const id = c.req.param("id")
    return c.json({ messages: [] }, 200)
  })

  // #9 POST /demands/:id/chat — stub: echo message back
  routes.post("/demands/:id/chat", async (c) => {
    try {
      const id = c.req.param("id")
      const body = await c.req.json()
      const message = {
        id: `msg-${Date.now()}`,
        demand_id: id,
        content: body.content ?? body.message ?? "",
        role: body.role ?? "user",
        created_at: new Date().toISOString(),
      }
      return c.json({ message }, 201)
    } catch (err) {
      return handleError(c, err, "demands.chat.post")
    }
  })

  // #10 GET /demands/:id/execution — stub: return execution status
  routes.get("/demands/:id/execution", (c) => {
    try {
      const id = c.req.param("id")
      const demand = service.getById(id)
      const status = demand?.status ?? "unknown"
      return c.json({ status, logs: [] }, 200)
    } catch (err) {
      return handleError(c, err, "demands.execution")
    }
  })

  return routes
}

/**
 * Centralized error handler for consistent error responses.
 */
function handleError(c: any, err: unknown, context: string): Response {
  if (err instanceof DemandNotFoundError) {
    return c.json(
      { error: { code: "NOT_FOUND", message: err.message } },
      404,
    )
  }

  if (err instanceof InvalidTransitionError) {
    return c.json(
      { error: { code: "INVALID_TRANSITION", message: err.message } },
      422,
    )
  }

  if (err instanceof z.ZodError) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: err.message, issues: err.issues } },
      400,
    )
  }

  // Unexpected error
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[${context}] Unexpected error:`, err)
  return c.json(
    { error: { code: "INTERNAL_ERROR", message } },
    500,
  )
}
