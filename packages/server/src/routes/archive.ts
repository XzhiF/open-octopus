// packages/server/src/routes/archive.ts
// Archive Query API — 7 endpoints for execution archive analytics and experience retrieval.
// Mounted at: /api/archive

import { Hono } from "hono"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ExperienceDAO } from "../db/dao/experience-dao"

interface ArchiveDeps {
  archiveDAO: ArchiveDAO
  experienceDAO: ExperienceDAO
}

// ── Validation helpers ──────────────────────────────────────────────

function parseIntParam(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return fallback
  const val = parseInt(raw, 10)
  if (isNaN(val) || val < min || val > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return val
}

const VALID_SORT_COLUMNS = ["created_at", "total_cost_usd", "duration_ms"] as const
const VALID_ORDER_VALUES = ["asc", "desc"] as const
const VALID_LEADERBOARD_BY = ["count", "success_rate", "cost"] as const

function validateEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (raw === undefined || raw === "") return fallback
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`)
  }
  return raw as T
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// ── Route factory ───────────────────────────────────────────────────

export function createArchiveRoutes(deps: ArchiveDeps) {
  const { archiveDAO, experienceDAO } = deps
  const router = new Hono()

  // Auth: require X-Octopus-Org header on all archive routes (vars_snapshot may contain sensitive data)
  router.use("*", async (c, next) => {
    const org = c.req.header("X-Octopus-Org") || c.req.query("org")
    if (!org) {
      return c.json({ error: "X-Octopus-Org header or org query parameter required" }, 401)
    }
    c.set("org" as any, org)
    await next()
  })

  // ─── 1. GET /stats ──────────────────────────────────────────────
  // Aggregate statistics: totals, period costs, top workflows.
  router.get("/stats", (c) => {
    try {
      const org = c.get("org" as any) as string

      // Workflow aggregation (30-day window)
      const workflowStats = archiveDAO.aggregateByWorkflow(org, 30)

      // Daily cost trends (30-day window) for period breakdown
      const trends = archiveDAO.costTrends(org, 30)

      // Compute total cost from trends
      const totalCostUsd = trends.reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

      // Period-specific costs via date comparison on trend entries
      const today = new Date().toISOString().slice(0, 10)
      const now = Date.now()
      const weekAgo = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)
      const monthAgo = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10)

      const todayCostUsd = trends
        .filter((t) => t.date === today)
        .reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

      const weekCostUsd = trends
        .filter((t) => t.date >= weekAgo)
        .reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

      const monthCostUsd = trends
        .filter((t) => t.date >= monthAgo)
        .reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)

      // Total executions from workflow aggregation
      const totalExecutions = workflowStats.reduce((sum, w) => sum + (w.execution_count ?? 0), 0)

      // Top 5 workflows by execution count
      const topWorkflows = workflowStats
        .map((w) => ({
          workflow_ref: w.workflow_ref,
          workflow_name: w.workflow_name,
          execution_count: w.execution_count,
          total_cost_usd: w.total_cost_usd ?? 0,
        }))
        .sort((a, b) => b.execution_count - a.execution_count)
        .slice(0, 5)

      return c.json({
        total_executions: totalExecutions,
        total_cost_usd: totalCostUsd,
        today_cost_usd: todayCostUsd,
        week_cost_usd: weekCostUsd,
        month_cost_usd: monthCostUsd,
        top_workflows: topWorkflows,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to compute archive stats"
      return c.json({ error: message }, 500)
    }
  })

  // ─── 2. GET /executions ─────────────────────────────────────────
  // Paginated list of execution archives with filtering and sorting.
  // Query: ?page=1&pageSize=20&workflow=&status=&from=&to=&sort=created_at&order=desc
  router.get("/executions", (c) => {
    try {
      const org = c.get("org" as any) as string
      const workflow = c.req.query("workflow")
      const status = c.req.query("status")
      const from = c.req.query("from")
      const to = c.req.query("to")

      const page = parseIntParam(c.req.query("page"), 1, 1, 1_000_000, "page")
      const pageSize = parseIntParam(c.req.query("pageSize"), 20, 1, 100, "pageSize")
      const sort = validateEnum(c.req.query("sort"), VALID_SORT_COLUMNS, "created_at", "sort")
      const order = validateEnum(c.req.query("order"), VALID_ORDER_VALUES, "desc", "order")

      const result = archiveDAO.listExecutionArchives({
        org,
        page,
        pageSize,
        workflow,
        status,
        from,
        to,
        sort,
        order,
      })

      return c.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to list executions"
      if (message.includes("must be")) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: message }, 500)
    }
  })

  // ─── 3. GET /executions/:id ─────────────────────────────────────
  // Full execution archive detail with parsed JSON fields and related experiences.
  router.get("/executions/:id", (c) => {
    const id = c.req.param("id")
    if (!id) {
      return c.json({ error: "execution id is required" }, 400)
    }

    const org = c.get("org" as any) as string
    const row = archiveDAO.findExecutionArchiveById(id)
    if (!row) {
      return c.json({ error: "execution not found" }, 404)
    }

    // Org isolation: reject if the execution belongs to a different org
    if (row.org !== org) {
      return c.json({ error: "execution not found" }, 404)
    }

    // Parse JSON-encoded fields with graceful fallback
    const nodeSummary = safeJsonParse(row.node_summary)
    const failedNodes = safeJsonParse(row.failed_nodes)
    const modelBreakdown = safeJsonParse(row.model_breakdown)
    const varsSnapshot = safeJsonParse(row.vars_snapshot)

    // Fetch related experiences from experience_index
    const experiences = experienceDAO.findByArchiveId(id)

    return c.json({
      ...row,
      node_summary: nodeSummary,
      failed_nodes: failedNodes,
      model_breakdown: modelBreakdown,
      vars_snapshot: varsSnapshot,
      experiences,
    })
  })

  // ─── 4. GET /cost-trends ────────────────────────────────────────
  // Daily cost trends with summary statistics.
  // Query: ?days=7&workspace_id=
  router.get("/cost-trends", (c) => {
    try {
      const org = c.get("org" as any) as string
      const days = parseIntParam(c.req.query("days"), 7, 1, 365, "days")
      const workspaceId = c.req.query("workspace_id") || undefined

      const trends = archiveDAO.costTrends(org, days, workspaceId)

      const totalCost = trends.reduce((sum, t) => sum + (t.total_cost_usd ?? 0), 0)
      const maxDailyCost = trends.reduce((max, t) => Math.max(max, t.total_cost_usd ?? 0), 0)
      const avgDailyCost = trends.length > 0 ? totalCost / trends.length : 0

      return c.json({
        trends,
        summary: {
          total_cost_usd: totalCost,
          avg_daily_cost_usd: avgDailyCost,
          max_daily_cost_usd: maxDailyCost,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to compute cost trends"
      if (message.includes("must be")) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: message }, 500)
    }
  })

  // ─── 5. GET /workflow-stats ─────────────────────────────────────
  // Per-workflow aggregate statistics with computed success_rate and avg_cost.
  // Query: ?days=30
  router.get("/workflow-stats", (c) => {
    try {
      const org = c.get("org" as any) as string
      const days = parseIntParam(c.req.query("days"), 30, 1, 365, "days")

      const workflows = archiveDAO.aggregateByWorkflow(org, days)

      const enriched = workflows.map((w) => ({
        workflow_ref: w.workflow_ref,
        workflow_name: w.workflow_name,
        execution_count: w.execution_count,
        success_count: w.success_count,
        failed_count: w.failed_count,
        success_rate: w.execution_count > 0 ? w.success_count / w.execution_count : 0,
        total_cost_usd: w.total_cost_usd ?? 0,
        avg_cost_usd: w.execution_count > 0 ? (w.total_cost_usd ?? 0) / w.execution_count : 0,
        avg_duration_ms: w.avg_duration_ms ?? 0,
        last_executed_at: w.last_executed_at,
      }))

      return c.json({ workflows: enriched })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to compute workflow stats"
      if (message.includes("must be")) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: message }, 500)
    }
  })

  // ─── 6. GET /lessons ────────────────────────────────────────────
  // Search or list experience index entries (lessons learned).
  // Query: ?q=&project=&type=&limit=20
  router.get("/lessons", (c) => {
    try {
      const org = c.get("org" as any) as string
      const q = c.req.query("q")
      const project = c.req.query("project")
      const type = c.req.query("type")
      const limit = parseIntParam(c.req.query("limit"), 20, 1, 100, "limit")

      if (q) {
        // Full-text search path
        const lessons = experienceDAO.searchFTS(q, {
          org,
          project,
          type,
          limit,
        })
        return c.json({ lessons, total: lessons.length })
      }

      // Paginated active list path
      const result = experienceDAO.listActive(org, {
        page: 1,
        pageSize: limit,
        project,
        type,
      })
      return c.json({ lessons: result.data, total: result.total })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to query lessons"
      if (message.includes("must be")) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: message }, 500)
    }
  })

  // ─── 7. GET /leaderboard ────────────────────────────────────────
  // Ranked workflow leaderboard sorted by execution count, success rate, or cost.
  // Query: ?by=count&days=30&limit=10
  router.get("/leaderboard", (c) => {
    try {
      const org = c.get("org" as any) as string
      const by = validateEnum(c.req.query("by"), VALID_LEADERBOARD_BY, "count", "by")
      const days = parseIntParam(c.req.query("days"), 30, 1, 365, "days")
      const limit = parseIntParam(c.req.query("limit"), 10, 1, 50, "limit")

      const workflows = archiveDAO.aggregateByWorkflow(org, days)

      // Compute derived fields for sorting
      const enriched = workflows.map((w) => {
        const successRate = w.execution_count > 0 ? w.success_count / w.execution_count : 0
        return {
          workflow_ref: w.workflow_ref,
          workflow_name: w.workflow_name,
          execution_count: w.execution_count,
          success_rate: successRate,
          total_cost_usd: w.total_cost_usd ?? 0,
          avg_duration_ms: w.avg_duration_ms ?? 0,
        }
      })

      // Sort descending by the requested metric
      switch (by) {
        case "count":
          enriched.sort((a, b) => b.execution_count - a.execution_count)
          break
        case "success_rate":
          enriched.sort((a, b) => b.success_rate - a.success_rate)
          break
        case "cost":
          enriched.sort((a, b) => b.total_cost_usd - a.total_cost_usd)
          break
      }

      // Assign rank and truncate to limit
      const entries = enriched.slice(0, limit).map((entry, idx) => ({
        rank: idx + 1,
        ...entry,
      }))

      return c.json({ entries })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to compute leaderboard"
      if (message.includes("must be")) {
        return c.json({ error: message }, 400)
      }
      return c.json({ error: message }, 500)
    }
  })

  // ─── 8. POST /seed ────────────────────────────────────────────────
  // Seed test data for development/testing. Inserts execution archive
  // and experience records.
  router.post("/seed", async (c) => {
    try {
      const org = c.get("org" as any) as string
      const body = await c.req.json()
      const { executions = [], experiences = [] } = body

      const insertedExecutions: string[] = []
      for (const exec of executions) {
        const id = exec.id ?? `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        archiveDAO.insertExecutionArchive({
          id,
          org,
          workflow_ref: exec.workflow_ref ?? "test-workflow",
          workflow_name: exec.workflow_name ?? exec.workflow_ref ?? "test-workflow",
          status: exec.status ?? "completed",
          started_at: exec.started_at ?? new Date().toISOString(),
          completed_at: exec.completed_at ?? new Date().toISOString(),
          duration_ms: exec.duration_ms ?? 1000,
          node_summary: typeof exec.node_summary === "string" ? exec.node_summary : JSON.stringify(exec.node_summary ?? []),
          failed_nodes: typeof exec.failed_nodes === "string" ? exec.failed_nodes : JSON.stringify(exec.failed_nodes ?? []),
          error_message: exec.error_message ?? null,
          total_input_tokens: exec.total_input_tokens ?? 100,
          total_output_tokens: exec.total_output_tokens ?? 50,
          total_cost_usd: exec.total_cost_usd ?? 0.01,
          model_breakdown: typeof exec.model_breakdown === "string" ? exec.model_breakdown : JSON.stringify(exec.model_breakdown ?? []),
          vars_snapshot: typeof exec.vars_snapshot === "string" ? exec.vars_snapshot : JSON.stringify(exec.vars_snapshot ?? {}),
          lessons_learned: exec.lessons_learned ?? null,
          workspace_archive_id: exec.workspace_archive_id ?? null,
          workspace_id: exec.workspace_id ?? null,
          chain_position: exec.chain_position ?? 0,
          parent_execution_id: exec.parent_execution_id ?? null,
          schedule_id: exec.schedule_id ?? null,
          clone_name: exec.clone_name ?? null,
          created_at: exec.created_at,
        })
        insertedExecutions.push(id)
      }

      const insertedExperiences: string[] = []
      for (const exp of experiences) {
        const id = exp.id ?? `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        experienceDAO.insert({
          id,
          org,
          archive_id: exp.archive_id ?? null,
          workflow_name: exp.workflow_name ?? "test-workflow",
          type: exp.type ?? "bug",
          title: exp.title ?? "Test experience",
          content: exp.content ?? "Test content",
          status: exp.status ?? "active",
          resolved_at: exp.resolved_at ?? null,
          resolved_by: exp.resolved_by ?? null,
          project: exp.project ?? "test-project",
          package: exp.package ?? null,
          file_pattern: exp.file_pattern ?? null,
          keywords: exp.keywords ?? null,
          relevance_score: exp.relevance_score ?? 0.5,
          use_count: exp.use_count ?? 0,
          created_at: exp.created_at,
        })
        insertedExperiences.push(id)
      }

      return c.json({
        inserted_executions: insertedExecutions.length,
        inserted_experiences: insertedExperiences.length,
        execution_ids: insertedExecutions,
        experience_ids: insertedExperiences,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to seed data"
      return c.json({ error: message }, 500)
    }
  })

  return router
}

export default createArchiveRoutes
