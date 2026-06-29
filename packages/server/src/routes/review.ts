import { Hono } from "hono"
import type { PendingReviewDAO } from "../db/dao"
import type { ReviewService } from "../services/knowledge/review"
import { isValidRuleId, errorResponse } from "../services/knowledge/validators"

/**
 * Parse a `conflicts` column (stored as JSON text, nullable). Returns null on
 * null/empty or malformed input rather than throwing — a corrupted row must
 * not take down the whole listing endpoint.
 */
function safeParseConflicts(raw: string | null | unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function createReviewRoutes(
  reviewService: ReviewService,
  pendingReviewDAO: PendingReviewDAO,
): Hono {
  const routes = new Hono()

  // GET /api/review/pending — list pending items with filtering + pagination
  routes.get("/pending", (c) => {
    const type = c.req.query("type") as string | undefined
    const status = c.req.query("status") as string | undefined
    const page = parseInt(c.req.query("page") ?? "1", 10)
    const pageSize = Math.min(100, parseInt(c.req.query("pageSize") ?? "20", 10))

    const result = pendingReviewDAO.listPending(type, status, page, pageSize)

    const data = result.data.map(item => ({
      id: item.id,
      type: item.type,
      source: item.source,
      sourceRef: item.source_ref,
      sourceLabel: item.source_label,
      content: item.content,
      targetFile: item.target_file,
      scope: item.scope,
      conflicts: safeParseConflicts(item.conflicts),
      confidence: item.confidence,
      autoApprove: item.auto_approve === 1,
      status: item.status,
      createdAt: item.created_at,
    }))

    return c.json({ data, total: result.total, page: result.page, pageSize: result.pageSize })
  })

  // POST /api/review/:id/action — approve/reject/defer/edit
  routes.post("/:id/action", async (c) => {
    const id = c.req.param("id")

    // Security: validate ID format before it reaches the DAO.
    if (!isValidRuleId(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid review item ID format" } }, 400)
    }

    const body = await c.req.json()
    const { action, content, userNotes } = body

    if (!["approve", "reject", "defer", "edit"].includes(action)) {
      return c.json({ error: "INVALID_PARAM: action must be approve|reject|defer|edit" }, 400)
    }
    if (action === "edit" && !content) {
      return c.json({ error: "INVALID_PARAM: content required for edit" }, 400)
    }

    try {
      switch (action) {
        case "approve": await reviewService.approveItem(id); break
        case "reject": await reviewService.rejectItem(id, userNotes); break
        case "defer": await reviewService.deferItem(id); break
        case "edit": await reviewService.editItem(id, content); break
      }
      return c.json({
        ok: true,
        id,
        newStatus: action === "approve" ? "approved"
          : action === "reject" ? "rejected"
          : action === "defer" ? "deferred"
          : "edited",
      })
    } catch (err) {
      const { body, status } = errorResponse(err, "review.action")
      return c.json(body, status)
    }
  })

  // POST /api/review/batch — batch approve/reject
  routes.post("/batch", async (c) => {
    const body = await c.req.json()
    const { ids, action } = body

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: "INVALID_PARAM: ids must be non-empty array" }, 400)
    }
    if (ids.length > 200) {
      return c.json({ error: "INVALID_PARAM: ids array too large (max 200)" }, 400)
    }
    // Validate every element — a single malformed id would otherwise be
    // forwarded to the DAO and produce a confusing partial failure.
    if (!ids.every((id: unknown) => typeof id === "string" && isValidRuleId(id))) {
      return c.json({ error: "INVALID_PARAM: one or more ids have invalid format" }, 400)
    }
    if (!["approve", "reject"].includes(action)) {
      return c.json({ error: "INVALID_PARAM: action must be approve|reject" }, 400)
    }

    try {
      if (action === "approve") {
        const result = reviewService.batchApprove(ids)
        return c.json({ ok: true, succeeded: result.succeeded, failed: result.failed, details: result.details })
      } else {
        reviewService.batchReject(ids)
        return c.json({ ok: true, succeeded: ids.length, failed: 0, details: ids.map((id: string) => ({ id, status: "ok" })) })
      }
    } catch (err) {
      const { body, status } = errorResponse(err, "review.batch")
      return c.json(body, status)
    }
  })

  // GET /api/review/summary — pending counts for Agent system prompt
  routes.get("/summary", (c) => {
    try {
      const summary = reviewService.getPendingSummary()
      return c.json(summary)
    } catch (err) {
      const { body, status } = errorResponse(err, "review.summary")
      return c.json(body, status)
    }
  })

  // GET /api/review/assistant/stream — SSE endpoint (skeleton)
  routes.get("/assistant/stream", (c) => {
    const mode = c.req.query("mode")
    if (!mode) return c.json({ error: "INVALID_PARAM: mode required" }, 400)

    // SSE response
    c.res.headers.set("Content-Type", "text/event-stream")
    c.res.headers.set("Cache-Control", "no-cache")
    c.res.headers.set("Connection", "keep-alive")

    return c.body("") // SSE stub — full implementation requires LLM streaming
  })

  return routes
}
