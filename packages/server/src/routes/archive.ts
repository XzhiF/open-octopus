// packages/server/src/routes/archive.ts
// Archive API routes — Execution Memory Dashboard (7 GET endpoints).

import { Hono } from "hono"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"
import { errorHandler } from "../middleware/error"

const VALID_STATUSES = new Set(["completed", "completed_with_failures", "failed", "cancelled"])
const VALID_PERIODS = new Set(["7d", "30d"])

function safeJsonParse(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function createArchiveRoutes(archiveDAO: ArchiveDAO, experienceDAO: ExperienceDAO): Hono {
  const routes = new Hono()

  // ── 1. GET /stats ───────────────────────────────────────────────────
  routes.get("/stats", (c) => {
    try {
      const org = c.req.query("org") ?? ""
      const currency = c.req.query("currency") === "USD" ? "USD" : "CNY"

      const stats = archiveDAO.getStats(org || undefined)
      const topWorkflows = archiveDAO.getTopWorkflows(org || undefined, 5)

      const total = stats.total_executions
      const completed = stats.completed_executions
      const successRate = total > 0 ? completed / total : 0

      let totalCostDisplay: string
      if (currency === "CNY") {
        const cny = stats.total_cost_usd * 7.2
        totalCostDisplay = `¥${cny.toFixed(1)} (≈$${stats.total_cost_usd.toFixed(2)})`
      } else {
        totalCostDisplay = `$${stats.total_cost_usd.toFixed(2)}`
      }

      return c.json({
        ...stats,
        success_rate: successRate,
        total_cost_display: totalCostDisplay,
        top_workflows: topWorkflows,
      })
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 2. GET /executions ──────────────────────────────────────────────
  routes.get("/executions", (c) => {
    try {
      const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1)
      const rawPageSize = parseInt(c.req.query("pageSize") ?? "20", 10) || 20
      const pageSize = Math.min(100, Math.max(1, rawPageSize))

      const workflow = c.req.query("workflow") || undefined
      const statusRaw = c.req.query("status") || undefined
      const from = c.req.query("from") || undefined
      const to = c.req.query("to") || undefined
      const org = c.req.query("org") || undefined

      // Validate status values
      if (statusRaw) {
        const statuses = statusRaw.split(",").map(s => s.trim()).filter(Boolean)
        for (const s of statuses) {
          if (!VALID_STATUSES.has(s)) {
            const err = new Error("Invalid status value. Allowed: completed,completed_with_failures,failed,cancelled") as any
            err.status = 400
            throw err
          }
        }
      }

      const filters = { workflow, status: statusRaw, from, to, org }
      const result = archiveDAO.listExecutions(filters, page, pageSize)

      return c.json(result)
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 3. GET /executions/:id ──────────────────────────────────────────
  routes.get("/executions/:id", (c) => {
    try {
      const id = c.req.param("id")
      const row = archiveDAO.getExecutionDetail(id)
      if (!row) {
        const err = new Error(`Execution archive not found: ${id}`) as any
        err.status = 404
        throw err
      }

      const children = archiveDAO.getChildren(id)
      const lessons = experienceDAO.getByExecution(id).map(l => ({
        id: l.id,
        type: l.type,
        title: l.title,
        content: l.content,
        status: l.status,
      }))

      return c.json({
        id: row.id,
        org: row.org,
        workspace_id: row.workspace_id,
        workspace_name: row.workspace_name,
        workflow_ref: row.workflow_ref,
        workflow_name: row.workflow_name,
        status: row.status,
        started_at: row.started_at,
        completed_at: row.completed_at,
        duration_ms: row.duration_ms,
        total_input_tokens: row.total_input_tokens,
        total_output_tokens: row.total_output_tokens,
        total_cost_usd: row.total_cost_usd,
        node_summary: safeJsonParse(row.node_summary, []),
        model_breakdown: safeJsonParse(row.model_breakdown, null),
        failed_nodes: safeJsonParse(row.failed_nodes, null),
        error_message: row.error_message,
        vars_snapshot: safeJsonParse(row.vars_snapshot, {}),
        lessons_learned: row.lessons_learned,
        parent_execution_id: row.parent_execution_id,
        workspace_archive_id: row.workspace_archive_id,
        created_at: row.created_at,
        children,
        lessons,
      })
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 4. GET /cost-trends ─────────────────────────────────────────────
  routes.get("/cost-trends", (c) => {
    try {
      const periodRaw = c.req.query("period") ?? "7d"
      if (!VALID_PERIODS.has(periodRaw)) {
        const err = new Error("Invalid period. Allowed: 7d, 30d") as any
        err.status = 400
        throw err
      }
      const period = periodRaw as "7d" | "30d"
      const org = c.req.query("org") || undefined

      const result = archiveDAO.getCostTrends(period, org)
      return c.json(result)
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 5. GET /workflow-stats ──────────────────────────────────────────
  routes.get("/workflow-stats", (c) => {
    try {
      const org = c.req.query("org") || undefined
      const limit = Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20)

      const result = archiveDAO.getWorkflowStats(org, limit)
      return c.json(result)
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 6. GET /lessons ─────────────────────────────────────────────────
  routes.get("/lessons", (c) => {
    try {
      const q = c.req.query("q") ?? ""
      const type = c.req.query("type") || undefined
      const status = c.req.query("status") || "active"
      const org = c.req.query("org") || undefined
      const rawLimit = parseInt(c.req.query("limit") ?? "20", 10) || 20
      const limit = Math.min(50, Math.max(1, rawLimit))

      const rows = experienceDAO.searchExperiences(q, type, status, org, limit)

      const mapped = rows.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        project: r.project,
        package: r.package,
        file_pattern: r.file_pattern,
        keywords: safeJsonParse(r.keywords, []) as string[],
        status: r.status,
        relevance_score: r.relevance_score,
        use_count: r.use_count,
        workflow_name: r.workflow_name,
        execution_id: r.execution_id,
        org: r.org,
        created_at: r.created_at,
        updated_at: r.updated_at,
        rank: r.rank,
      }))

      return c.json(mapped)
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  // ── 7. GET /leaderboard ─────────────────────────────────────────────
  routes.get("/leaderboard", (c) => {
    try {
      const org = c.req.query("org") || undefined
      const limit = Math.max(1, parseInt(c.req.query("limit") ?? "5", 10) || 5)

      const cheapest = archiveDAO.getLeaderboard("cheapest", org, limit)
      const fastest = archiveDAO.getLeaderboard("fastest", org, limit)
      const mostReliable = archiveDAO.getLeaderboard("most_reliable", org, limit)

      return c.json({
        cheapest,
        fastest,
        most_reliable: mostReliable,
      })
    } catch (err) {
      return errorHandler(err as Error, c)
    }
  })

  return routes
}
