import { Hono } from "hono"
import fs from "fs"
import path from "path"
import type { PendingReviewDAO } from "../db/dao"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import { isValidUUID, errorResponse } from "../services/knowledge/validators"

// ponytail: redact keys matching secret patterns before exposing poolSnapshot
const SECRET_KEY_RE = /secret|password|token|api[_-]?key|private[_-]?key|credential|auth[_-]?key/i

function sanitizePoolSnapshot(snapshot: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== "object") return null
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    sanitized[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : value
  }
  return sanitized
}

export function createArchiveRoutes(
  pendingReviewDAO: PendingReviewDAO,
  stateDir: string,
  archiveDAO?: ArchiveDAO,
): Hono {
  const routes = new Hono()

  // GET /api/archive/stats
  routes.get("/stats", (c) => {
    if (!archiveDAO) return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive DAO not available" } }, 503)
    const org = c.req.query("org") || undefined
    const workspaceId = c.req.query("workspace_id") || undefined
    try {
      const stats = archiveDAO.getStats(org, workspaceId)
      return c.json(stats)
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.stats")
      return c.json(body, status)
    }
  })

  // GET /api/archive/cost-trends
  routes.get("/cost-trends", (c) => {
    if (!archiveDAO) return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive DAO not available" } }, 503)
    const org = c.req.query("org") || ""
    const period = (c.req.query("period") || "30d") as '7d' | '30d' | '90d'
    const workflowName = c.req.query("workflow_name") || undefined
    if (!['7d', '30d', '90d'].includes(period)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "period must be 7d, 30d, or 90d" } }, 400)
    }
    try {
      const data = archiveDAO.getCostTrends(org, period, workflowName)
      return c.json({ period, data })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.costTrends")
      return c.json(body, status)
    }
  })

  // GET /api/archive/workflow-stats
  routes.get("/workflow-stats", (c) => {
    if (!archiveDAO) return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive DAO not available" } }, 503)
    const org = c.req.query("org") || undefined
    try {
      const data = archiveDAO.getWorkflowStats(org)
      return c.json({ data })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.workflowStats")
      return c.json(body, status)
    }
  })

  // GET /api/archive/leaderboard
  routes.get("/leaderboard", (c) => {
    if (!archiveDAO) return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive DAO not available" } }, 503)
    const org = c.req.query("org") || ""
    const metric = (c.req.query("metric") || "cost") as 'cost' | 'duration' | 'frequency'
    const parsed = parseInt(c.req.query("limit") || "10", 10)
    const limit = Number.isNaN(parsed) ? 10 : Math.min(50, Math.max(1, parsed))
    if (!['cost', 'duration', 'frequency'].includes(metric)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "metric must be cost, duration, or frequency" } }, 400)
    }
    try {
      const data = archiveDAO.getLeaderboard(org, metric, limit)
      return c.json({ metric, limit, data })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.leaderboard")
      return c.json(body, status)
    }
  })

  // GET /api/archive/:id/summary — read execution result from state file
  routes.get("/:id/summary", (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format to prevent path traversal
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid execution ID format" } }, 400)
    }

    const statePath = path.join(stateDir, `${id}.json`)

    if (!fs.existsSync(statePath)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Execution not found" } }, 404)
    }

    try {
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"))
      const nodes = Object.entries(data.nodes ?? {}).map(([nodeId, node]: [string, any]) => ({
        id: nodeId,
        status: node.status ?? "unknown",
        durationMs: node.durationMs ?? 0,
        exitCode: node.exitCode ?? null,
        lastOutput: node.lastOutput ?? null,
      }))

      // Extract review blockers from poolSnapshot or node outputs
      const reviewBlockers: string[] = []
      const poolSnapshot = data.poolSnapshot ?? {}
      if (poolSnapshot.review_blockers) {
        try {
          const blockers = JSON.parse(poolSnapshot.review_blockers)
          if (Array.isArray(blockers)) reviewBlockers.push(...blockers)
        } catch { /* ignore */ }
      }

      // E2E results summary
      const e2eNodes = nodes.filter(n => n.id.includes("e2e") || n.id.includes("test"))
      const e2eResults = e2eNodes.map(n => `${n.id}: ${n.status}`).join(", ") || "No E2E tests"

      return c.json({
        executionId: id,
        nodes,
        reviewBlockers,
        e2eResults,
        poolSnapshot: sanitizePoolSnapshot(data.poolSnapshot),
      })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.summary")
      return c.json(body, status)
    }
  })

  // POST /api/archive/:id/propose — trigger rule extraction + skill proposal
  routes.post("/:id/propose", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format to prevent path traversal
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid execution ID format" } }, 400)
    }

    const body = await c.req.json()
    const { org: reqOrg } = body
    // Per-request org resolution: body `org` > query `org` > undefined.
    const org = reqOrg || c.req.query("org") || undefined

    const statePath = path.join(stateDir, `${id}.json`)
    if (!fs.existsSync(statePath)) {
      return c.json({ error: { code: "NOT_FOUND", message: "Execution not found" } }, 404)
    }

    try {
      const execResult = JSON.parse(fs.readFileSync(statePath, "utf-8"))
      const logDir = path.join(stateDir, "..", "logs", id)

      // Import proposeRulesForReview dynamically to avoid circular deps
      const { proposeRulesForReview } = await import("../services/knowledge/extract")
      const pendingCount = await proposeRulesForReview(
        execResult,
        logDir,
        org,
        stateDir,
        pendingReviewDAO,
      )

      // Get proposed rules from pending_review
      const pendingRules = pendingReviewDAO.listBySource("workspace_archive")
        .filter(item => item.source_ref === id && item.status === "pending")
        .map(item => ({
          text: item.content,
          scope: item.scope,
          target: item.target_file,
          conflicts: item.conflicts ? JSON.parse(item.conflicts) : null,
        }))

      return c.json({
        rules: pendingRules,
        pendingCount,
      })
    } catch (err) {
      // PROVIDER_TIMEOUT is a stable client-actionable code; preserve it
      // while still sanitizing the message (clients don't need the raw
      // provider response body).
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("timeout")) {
        process.stderr.write(`[knowledge/archive.propose] provider timeout: ${msg}\n`)
        return c.json(
          { error: { code: "PROVIDER_TIMEOUT", message: "LLM provider timed out; please retry" } },
          504,
        )
      }
      const { body, status } = errorResponse(err, "archive.propose")
      return c.json(body, status)
    }
  })

  return routes
}
