import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import fs from "fs"
import os from "os"
import path from "path"
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

  // 边界注：本路由族无提案/审批结案端点——归档知识沉淀走 task archiving 态自动投喂（raw/archives → archive-compile 队列）。

  // 知识中心票10: POST /api/archive/workspaces/:id/archive-preview（三级提炼分析入口）
  // 已随旧经验提炼管线删除——归档知识沉淀改走 task archiving 态自动投喂
  // （raw/archives/task-{id}-summary.md → archive-compile 队列）。UI 消费面属票09。

  // POST /api/archive/workspaces/:id/archive — Archive V2 (execute) with SSE
  routes.post("/workspaces/:id/archive", async (c) => {
    const id = c.req.param("id")

    // Security: validate UUID format
    if (!isValidUUID(id)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid workspace ID format" } }, 400)
    }

    const body = await c.req.json<{
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
        agents: JSON.parse(draft.agents || '[]'),
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
