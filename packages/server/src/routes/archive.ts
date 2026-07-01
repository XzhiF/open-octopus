import { Hono } from "hono"
import fs from "fs"
import path from "path"
import type { KnowledgeRuleDAO, PendingReviewDAO } from "../db/dao"
import { isValidUUID, errorResponse } from "../services/knowledge/validators"

export function createArchiveRoutes(
  knowledgeRuleDAO: KnowledgeRuleDAO,
  pendingReviewDAO: PendingReviewDAO,
  stateDir: string,
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
        poolSnapshot: data.poolSnapshot ?? null,
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
    const { org: reqOrg, skipSkillProposal } = body
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
        knowledgeRuleDAO,
        pendingReviewDAO,
      )

      // Skill proposal (if not skipped)
      let skills: any[] | null = null
      if (!skipSkillProposal) {
        try {
          const { proposeSkillFromWorkspace } = await import("../services/knowledge/skill")
          const skill = await proposeSkillFromWorkspace(
            id, org, pendingReviewDAO,
            `Execution ${id} completed with status ${execResult.status}`,
          )
          if (skill) skills = [skill]
        } catch { /* skill proposal is best-effort */ }
      }

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
        skills,
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
