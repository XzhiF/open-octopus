import { Hono } from "hono"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"

export function createArchiveRoutes(deps: {
  archiveDAO: ArchiveDAO
  experienceDAO: ExperienceDAO
}) {
  const app = new Hono()

  // GET /api/archive/stats
  app.get("/stats", (c) => {
    try {
      const stats = deps.archiveDAO.getStats()
      const topWorkflows = deps.archiveDAO.getTopWorkflows(5)
      return c.json({ ...stats, top_workflows: topWorkflows })
    } catch (err) {
      console.error("[archive] stats failed:", err)
      return c.json({ error: "Failed to compute stats" }, 500)
    }
  })

  // GET /api/archive/executions
  app.get("/executions", (c) => {
    try {
      const page = Math.max(1, Number(c.req.query("page") || "1"))
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || "20")))
      const filters = {
        workflow_ref: c.req.query("workflow_ref") || undefined,
        status: c.req.query("status") || undefined,
        workspace_id: c.req.query("workspace_id") || undefined,
        date_from: c.req.query("date_from") || undefined,
        date_to: c.req.query("date_to") || undefined,
      }
      const sort = c.req.query("sort") || "created_at"
      const order = c.req.query("order") || "desc"

      // Validate sort field
      const validSorts = ["created_at", "total_cost_usd", "duration_ms"]
      if (!validSorts.includes(sort)) {
        return c.json({ error: "Invalid parameter: sort" }, 400)
      }
      if (!["asc", "desc"].includes(order)) {
        return c.json({ error: "Invalid parameter: order" }, 400)
      }
      // Validate date format if provided
      if (filters.date_from && !/^\d{4}-\d{2}-\d{2}$/.test(filters.date_from)) {
        return c.json({ error: "Invalid parameter: date_from" }, 400)
      }
      if (filters.date_to && !/^\d{4}-\d{2}-\d{2}$/.test(filters.date_to)) {
        return c.json({ error: "Invalid parameter: date_to" }, 400)
      }

      const result = deps.archiveDAO.listArchives(filters, page, limit)
      return c.json({ items: result.items, total: result.total, page: result.page, limit: result.pageSize })
    } catch (err) {
      console.error("[archive] list failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  // GET /api/archive/executions/:id
  app.get("/executions/:id", (c) => {
    try {
      const id = c.req.param("id")
      const archive = deps.archiveDAO.getArchive(id)
      if (!archive) {
        return c.json({ error: "Archive not found" }, 404)
      }

      // Parse JSON fields
      const nodeSummary = JSON.parse(archive.node_summary || "[]")
      const failedNodes = archive.failed_nodes ? JSON.parse(archive.failed_nodes) : null
      const modelBreakdown = archive.model_breakdown ? JSON.parse(archive.model_breakdown) : null
      const varsSnapshot = JSON.parse(archive.vars_snapshot || "{}")

      // Find related experiences
      const experiences = deps.experienceDAO.findByArchiveId(archive.execution_id).map(exp => ({
        id: String(exp.id),
        type: exp.type,
        title: exp.title,
        content: exp.content,
        status: exp.status,
        created_at: exp.created_at,
      }))

      return c.json({
        id: archive.execution_id,
        workflow_ref: archive.workflow_ref,
        workflow_name: archive.workflow_name,
        status: archive.status,
        started_at: archive.started_at,
        completed_at: archive.completed_at,
        duration_ms: archive.duration_ms,
        node_summary: nodeSummary,
        failed_nodes: failedNodes,
        error_message: archive.error_message,
        total_input_tokens: archive.total_input_tokens,
        total_output_tokens: archive.total_output_tokens,
        total_cost_usd: archive.total_cost_usd,
        model_breakdown: modelBreakdown,
        vars_snapshot: varsSnapshot,
        lessons_learned: archive.lessons_learned,
        experiences,
        workspace_id: archive.workspace_id,
        workspace_archive_id: archive.workspace_archive_id,
        parent_execution_id: archive.parent_execution_id,
        chain_position: archive.chain_position,
        created_at: archive.created_at,
      })
    } catch (err) {
      console.error("[archive] detail failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  // GET /api/archive/cost-trends
  app.get("/cost-trends", (c) => {
    try {
      const daysQuery = c.req.query("days")
      if (daysQuery && (Number(daysQuery) < 1 || Number(daysQuery) > 365)) {
        return c.json({ error: "days must be between 1 and 365" }, 400)
      }
      const days = Math.min(365, Math.max(1, Number(daysQuery || "30")))
      const trends = deps.archiveDAO.getCostTrends(days)

      // Calculate summary
      const totalCost = trends.reduce((sum, t) => sum + t.total_cost_usd, 0)
      const avgDaily = trends.length > 0 ? totalCost / trends.length : 0

      // Calculate trend direction (compare first half vs second half)
      const midpoint = Math.floor(trends.length / 2)
      const firstHalf = trends.slice(0, midpoint).reduce((s, t) => s + t.total_cost_usd, 0)
      const secondHalf = trends.slice(midpoint).reduce((s, t) => s + t.total_cost_usd, 0)
      let trend: "up" | "down" | "stable" = "stable"
      if (secondHalf > firstHalf * 1.1) trend = "up"
      else if (secondHalf < firstHalf * 0.9) trend = "down"

      return c.json({
        trends,
        summary: {
          total_cost_usd: totalCost,
          avg_daily_cost_usd: avgDaily,
          trend,
        },
      })
    } catch (err) {
      console.error("[archive] cost-trends failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  // GET /api/archive/workflow-stats
  app.get("/workflow-stats", (c) => {
    try {
      const days = Math.min(365, Math.max(1, Number(c.req.query("days") || "30")))
      const sort = c.req.query("sort") || "execution_count"
      const order = c.req.query("order") || "desc"
      const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") || "10")))

      const items = deps.archiveDAO.getWorkflowStats(days, sort, order, limit)
      return c.json({ items })
    } catch (err) {
      console.error("[archive] workflow-stats failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  // GET /api/archive/lessons
  app.get("/lessons", (c) => {
    const q = c.req.query("q")
    if (!q) {
      return c.json({ error: "Query parameter 'q' is required" }, 400)
    }
    try {
      const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") || "20")))
      const filters = {
        project: c.req.query("project") || undefined,
        type: c.req.query("type") || undefined,
        status: c.req.query("status") || undefined,
        limit,
      }
      const results = deps.experienceDAO.search(q, filters)
      const items = results.map(r => ({
        id: String(r.id),
        type: r.type,
        title: r.title,
        content: r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content,
        status: r.status,
        project: r.project,
        package: r.package,
        file_pattern: r.file_pattern,
        workflow_name: r.workflow_name,
        relevance_score: r.relevance_score,
        use_count: r.use_count,
        created_at: r.created_at,
      }))
      return c.json({ items, total: items.length })
    } catch (err) {
      console.error("[archive] lessons failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  // GET /api/archive/leaderboard
  app.get("/leaderboard", (c) => {
    try {
      const dimension = (c.req.query("dimension") || "cost") as string
      const days = Math.min(365, Math.max(1, Number(c.req.query("days") || "30")))
      const limit = Math.min(20, Math.max(1, Number(c.req.query("limit") || "10")))

      if (!["cost", "speed", "success_rate"].includes(dimension)) {
        return c.json({ error: "Invalid parameter: dimension" }, 400)
      }

      const entries = deps.archiveDAO.getLeaderboard(dimension as "cost" | "speed" | "success_rate", days, limit)
      return c.json({ dimension, entries })
    } catch (err) {
      console.error("[archive] leaderboard failed:", err)
      return c.json({ error: "Internal server error" }, 500)
    }
  })

  return app
}
