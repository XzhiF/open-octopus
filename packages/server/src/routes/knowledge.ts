import { Hono } from "hono"
import path from "path"
import type { KnowledgeRuleDAO, KnowledgeEffectivenessDAO, PendingReviewDAO } from "../db/dao"
import {
  getKnowledgeDir,
  readKnowledgeFile,
  writeKnowledgeFile,
  listKnowledgeFiles,
  parseKnowledgeFile,
  getKnowledgeFileInfo,
  readUserPreference,
  writeUserPreference,
} from "../services/knowledge/file-ops"

export function createKnowledgeRoutes(
  knowledgeRuleDAO: KnowledgeRuleDAO,
  effectivenessDAO: KnowledgeEffectivenessDAO,
  pendingReviewDAO: PendingReviewDAO,
  org: string,
): Hono {
  const routes = new Hono()

  // GET /api/knowledge/files — list knowledge files
  routes.get("/files", (c) => {
    try {
      const scopeFilter = c.req.query("scope")
      const knowledgeDir = getKnowledgeDir(org)
      const files = listKnowledgeFiles(knowledgeDir)

      const result = files.map(f => {
        const filePath = path.join(knowledgeDir, f)
        const info = getKnowledgeFileInfo(filePath)
        const type = f.startsWith("workflow-") ? "workflow" : "project"
        return {
          name: info.name,
          type,
          scope: "org",
          ruleCount: info.ruleCount,
          retiredCount: info.retiredCount,
          lineCount: info.lineCount,
          compactNeeded: info.lineCount >= 100,
        }
      }).filter(f => !scopeFilter || f.type === scopeFilter)

      return c.json({ files: result })
    } catch (err) {
      return c.json({ error: { code: "INTERNAL_ERROR", message: String(err) } }, 500)
    }
  })

  // GET /api/knowledge/file/:path — read single file + parsed rules
  routes.get("/file/:path", (c) => {
    const fileName = c.req.param("path")
    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, fileName)

    // Security: prevent path traversal
    if (fileName.includes("..") || fileName.includes("/")) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid file name" } }, 400)
    }

    const content = readKnowledgeFile(filePath)
    if (!content) return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404)

    const rules = parseKnowledgeFile(filePath)
    return c.json({
      content,
      rules: rules.map(r => ({ ...r, status: "active" })),
      filePath,
    })
  })

  // PUT /api/knowledge/file/:path — write file
  routes.put("/file/:path", async (c) => {
    const fileName = c.req.param("path")
    const body = await c.req.json()
    const { content } = body

    if (!content) return c.json({ error: { code: "INVALID_PARAM", message: "content required" } }, 400)
    if (fileName.includes("..") || fileName.includes("/")) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid file name" } }, 400)
    }

    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, fileName)

    try {
      writeKnowledgeFile(filePath, content)
      const rules = parseKnowledgeFile(filePath)
      return c.json({ ok: true, ruleCount: rules.length })
    } catch (err) {
      return c.json({ error: { code: "INTERNAL_ERROR", message: String(err) } }, 500)
    }
  })

  // GET /api/knowledge/preference — read user preference
  routes.get("/preference", (c) => {
    const scope = c.req.query("scope") ?? "org"
    if (!["global", "org"].includes(scope)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "scope must be global|org" } }, 400)
    }

    const prefOrg = scope === "global" ? undefined : org
    const content = readUserPreference(prefOrg)
    const knowledgeDir = getKnowledgeDir(prefOrg)

    return c.json({
      content,
      scope,
      filePath: path.join(knowledgeDir, "user_preference.md"),
    })
  })

  // PUT /api/knowledge/preference — write user preference
  routes.put("/preference", async (c) => {
    const body = await c.req.json()
    const { content, scope } = body

    if (!content && content !== "") return c.json({ error: { code: "INVALID_PARAM", message: "content required" } }, 400)
    if (!scope || !["global", "org"].includes(scope)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "scope must be global|org" } }, 400)
    }

    try {
      const prefOrg = scope === "global" ? undefined : org
      writeUserPreference(prefOrg, content)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: { code: "INTERNAL_ERROR", message: String(err) } }, 500)
    }
  })

  // GET /api/knowledge/effectiveness — effect tracking data
  routes.get("/effectiveness", (c) => {
    try {
      const ruleId = c.req.query("ruleId")
      if (ruleId) {
        const row = effectivenessDAO.getByRuleId(ruleId)
        const rule = knowledgeRuleDAO.getById(ruleId)
        return c.json({
          items: row ? [{
            ruleId: row.rule_id,
            injectedCount: row.injected_count,
            helpfulCount: row.helpful_count,
            notHelpfulCount: row.not_helpful_count,
            lastInjected: row.last_injected,
            confidence: row.confidence,
            ruleText: rule?.text ?? "",
          }] : [],
        })
      }

      const all = effectivenessDAO.listAll()
      const items = all.map(row => {
        const rule = knowledgeRuleDAO.getById(row.rule_id)
        return {
          ruleId: row.rule_id,
          injectedCount: row.injected_count,
          helpfulCount: row.helpful_count,
          notHelpfulCount: row.not_helpful_count,
          lastInjected: row.last_injected,
          confidence: row.confidence,
          ruleText: rule?.text ?? "",
        }
      })
      return c.json({ items })
    } catch (err) {
      return c.json({ error: { code: "INTERNAL_ERROR", message: String(err) } }, 500)
    }
  })

  // POST /api/knowledge/compact — trigger LLM compact
  routes.post("/compact", async (c) => {
    const body = await c.req.json()
    const { org: reqOrg, filePath } = body

    if (!filePath) return c.json({ error: { code: "INVALID_PARAM", message: "filePath required" } }, 400)

    // Security: prevent path traversal
    if (filePath.includes("..") || filePath.includes("/") || filePath.includes("\\")) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid file path" } }, 400)
    }

    try {
      const { compactKnowledgeFile } = await import("../services/knowledge/maintenance")
      const result = await compactKnowledgeFile(reqOrg ?? org, filePath, pendingReviewDAO)
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === "NOT_FOUND") return c.json({ error: { code: "NOT_FOUND", message: "File not found" } }, 404)
      return c.json({ error: { code: "INTERNAL_ERROR", message: msg } }, 500)
    }
  })

  // POST /api/knowledge/rule/:id/restore — restore retired rule
  routes.post("/rule/:id/restore", async (c) => {
    const ruleId = c.req.param("id")
    try {
      const { restoreRule } = await import("../services/knowledge/effectiveness")
      const result = restoreRule(ruleId, knowledgeRuleDAO)
      return c.json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === "NOT_FOUND") return c.json({ error: { code: "NOT_FOUND", message: "Rule not found or not retired" } }, 404)
      return c.json({ error: { code: "INTERNAL_ERROR", message: msg } }, 500)
    }
  })

  return routes
}
