import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import fs from "fs"
import os from "os"
import path from "path"
import type { PendingReviewDAO } from "../db/dao"
import type { ArchiveDAO } from "../db/dao/archive-dao"
import type { ArchiveDraftDAO } from "../db/dao/archive-draft-dao"
import { isValidUUID, errorResponse } from "../services/knowledge/validators"
import { createStepEmitter } from "../services/archive/step-emitter"

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
  archiveDraftDAO?: ArchiveDraftDAO,
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

  // POST /api/archive/workspaces/:id/archive-preview — Archive V2 (SSE progress)
  routes.post("/workspaces/:id/archive-preview", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    return streamSSE(c, async (stream) => {
      const emitter = createStepEmitter(stream)

      try {
        const { getOrchestratorService } = await import("../services/agent/orchestrator-service")
        const org = c.req.query("org") || "default"
        const orchestratorService = getOrchestratorService(org)

        const preview = await orchestratorService.analyzeWorkspaceForArchive(id, emitter)

        await stream.writeSSE({
          event: "preview",
          data: JSON.stringify(preview),
        })
      } catch (err) {
        const { body } = errorResponse(err, "archive.preview")
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(body.error || { message: "Preview analysis failed" }),
        })
      }
    })
  })

  // POST /api/archive/workspaces/:id/archive — Archive V2 (execute) with SSE
  routes.post("/workspaces/:id/archive", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    const body = await c.req.json<{
      extractExperiences?: string[]
      installSkills?: Array<{ name: string; group: string; path?: string; content?: string }>
      installWorkflows?: Array<{ name: string; group: string; path?: string; content?: string }>
      installAgents?: Array<{ name: string; group: string; path?: string; content?: string }>
      analysisReport?: unknown
      stats?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }>()

    return streamSSE(c, async (stream) => {
      const emitter = createStepEmitter(stream)

      try {
        const { getArchiveService } = await import("../services/archive/archive-service")
        const archiveService = getArchiveService()

        if (!archiveService) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ code: "SUBSYSTEM_UNAVAILABLE", message: "Archive service not available" }),
          })
          return
        }

        const org = c.req.query("org") || "default"
        const result = await archiveService.archiveWorkspace(
          id,
          org,
          {
            extractExperiences: body.extractExperiences || [],
            installSkills: body.installSkills || [],
            installWorkflows: body.installWorkflows || [],
            installAgents: body.installAgents || [],
            analysisReport: body.analysisReport,
            stats: body.stats as any,
            metadata: body.metadata,
          },
          emitter,
        )

        if (!result.success) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ code: "ARCHIVE_FAILED", message: result.error || "Archive failed" }),
          })
        }
      } catch (err) {
        const { body: errBody } = errorResponse(err, "archive.execute")
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(errBody.error || { message: "Archive failed" }),
        })
      }
    })
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

  // GET /api/archive/skill-groups — list available resource groups (separated by type)
  routes.get("/skill-groups", (c) => {
    const base = path.join(os.homedir(), ".octopus", "resources", "installed")
    const readGroups = (subdir: string): string[] => {
      const dir = path.join(base, subdir)
      try {
        if (fs.existsSync(dir)) {
          return fs.readdirSync(dir).filter((f: string) => {
            try { return fs.statSync(path.join(dir, f)).isDirectory() } catch { return false }
          })
        }
      } catch {}
      return []
    }
    const skillGroups = readGroups("skills").sort()
    const workflowGroups = readGroups("workflows").sort()
    const agentGroups = readGroups("agents").sort()
    if (!skillGroups.includes("archive-extracted")) skillGroups.push("archive-extracted")
    if (!workflowGroups.includes("archive-extracted")) workflowGroups.push("archive-extracted")
    if (!agentGroups.includes("archive-extracted")) agentGroups.push("archive-extracted")
    return c.json({ skillGroups, workflowGroups, agentGroups })
  })

  // ── Draft routes ──────────────────────────────────────────

  // GET /api/archive/workspaces/:id/archive-draft — load cached analysis draft
  routes.get("/workspaces/:id/archive-draft", (c) => {
    const workspaceId = c.req.param("id")

    if (!isValidUUID(workspaceId)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    if (!archiveDraftDAO) {
      return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive Draft DAO not available" } }, 503)
    }

    try {
      const draft = archiveDraftDAO.findByWorkspaceId(workspaceId)
      if (!draft) {
        return c.json({ draft: null })
      }
      return c.json({
        draft: {
        workspace_id: draft.workspace_id,
        org: draft.org,
        analysis_report: JSON.parse(draft.analysis_report),
        experiences: JSON.parse(draft.experiences),
        skills: JSON.parse(draft.skills),
        stats: JSON.parse(draft.stats),
        workflows: JSON.parse(draft.workflows || '[]'),
        tokenStats: JSON.parse(draft.token_stats || '{}'),
        created_at: (draft as any).created_at,
        updated_at: (draft as any).updated_at,
      },
      })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.draft.get")
      return c.json(body, status)
    }
  })

  // DELETE /api/archive/workspaces/:id/archive-draft — clear draft
  routes.delete("/workspaces/:id/archive-draft", (c) => {
    const workspaceId = c.req.param("id")

    if (!isValidUUID(workspaceId)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    if (!archiveDraftDAO) {
      return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive Draft DAO not available" } }, 503)
    }

    try {
      archiveDraftDAO.delete(workspaceId)
      return c.json({ success: true })
    } catch (err) {
      const { body, status } = errorResponse(err, "archive.draft.delete")
      return c.json(body, status)
    }
  })

  return routes
}
