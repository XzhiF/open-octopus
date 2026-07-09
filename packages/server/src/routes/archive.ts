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

  // POST /api/archive/workspaces/:id/archive-preview — Archive V2
  routes.post("/workspaces/:id/archive-preview", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    try {
      // Import OrchestratorService dynamically
      const { getOrchestratorService } = await import("../services/agent/orchestrator-service")
      const org = c.req.query("org") || "default"
      const orchestratorService = getOrchestratorService(org)

      const preview = await orchestratorService.analyzeWorkspaceForArchive(id)
      return c.json(preview)
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.preview")
      return c.json(body, status)
    }
  })

  // POST /api/archive/workspaces/:id/archive — Archive V2 (execute)
  routes.post("/workspaces/:id/archive", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    try {
      const body = await c.req.json<{
        extractExperiences?: string[]
        installSkills?: string[]
      }>()

      const { getArchiveService } = await import("../services/archive/archive-service")
      const archiveService = getArchiveService()

      if (!archiveService) {
        return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive service not available" } }, 503)
      }

      const org = c.req.query("org") || "default"
      const result = await archiveService.archiveWorkspace(id, org, {
        extractExperiences: body.extractExperiences || [],
        installSkills: body.installSkills || [],
      })

      if (!result.success) {
        return c.json({ error: { code: "ARCHIVE_FAILED", message: result.error } }, 500)
      }

      return c.json(result)
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.execute")
      return c.json(body, status)
    }
  })

  // GET /api/archive/workspaces/:id — Get single archived workspace
  routes.get("/workspaces/:id", (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    if (!archiveDAO) {
      return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive DAO not available" } }, 503)
    }

    try {
      const archive = archiveDAO.findByWorkspaceId(id)
      if (!archive) {
        return c.json({ error: { code: "NOT_FOUND", message: "Archived workspace not found" } }, 404)
      }
      return c.json(archive)
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.get")
      return c.json(body, status)
    }
  })

  return routes
}
