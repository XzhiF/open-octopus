import { Hono } from "hono"
import type { PendingReviewDAO } from "../db/dao"
import type { ReviewService } from "../services/knowledge/review"

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

    // Parse conflicts JSON for each item
    const data = result.data.map(item => ({
      id: item.id,
      type: item.type,
      source: item.source,
      sourceRef: item.source_ref,
      sourceLabel: item.source_label,
      content: item.content,
      targetFile: item.target_file,
      scope: item.scope,
      conflicts: item.conflicts ? JSON.parse(item.conflicts) : null,
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
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === "NOT_FOUND") return c.json({ error: "NOT_FOUND" }, 404)
      if (msg.includes("CONFLICT")) return c.json({ error: { code: "MEMORY_CONFLICT", message: msg } }, 409)
      return c.json({ error: msg }, 500)
    }
  })

  // POST /api/review/batch — batch approve/reject
  routes.post("/batch", async (c) => {
    const body = await c.req.json()
    const { ids, action } = body

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: "INVALID_PARAM: ids must be non-empty array" }, 400)
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
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // GET /api/review/summary — pending counts for Agent system prompt
  routes.get("/summary", (c) => {
    try {
      const summary = reviewService.getPendingSummary()
      return c.json(summary)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
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

    return c.body("") // ponytail: SSE stub — full implementation requires LLM streaming
  })

  return routes
}
