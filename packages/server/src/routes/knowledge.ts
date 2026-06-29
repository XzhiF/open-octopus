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
  rebuildIndex,
  markRuleRetired,
  unmarkRuleRetired,
} from "../services/knowledge/file-ops"
import { isValidRuleId, validateKnowledgeFileName, errorResponse } from "../services/knowledge/validators"

export function createKnowledgeRoutes(
  knowledgeRuleDAO: KnowledgeRuleDAO,
  effectivenessDAO: KnowledgeEffectivenessDAO,
  pendingReviewDAO: PendingReviewDAO,
  org: string,
): Hono {
  const routes = new Hono()

  // GET /api/knowledge/files — list knowledge files (org + global)
  routes.get("/files", (c) => {
    try {
      const scopeFilter = c.req.query("scope")
      const orgDir = getKnowledgeDir(org)
      const globalDir = getKnowledgeDir() // global knowledge dir

      // Merge org-level and global-level files
      const orgFiles = listKnowledgeFiles(orgDir).map(f => ({ file: f, dir: orgDir, scope: "org" as const }))
      const globalFiles = listKnowledgeFiles(globalDir).map(f => ({ file: f, dir: globalDir, scope: "global" as const }))
      const allFiles = [...orgFiles, ...globalFiles]

      const result = allFiles.map(({ file: f, dir, scope: fileScope }) => {
        const filePath = path.join(dir, f)
        const info = getKnowledgeFileInfo(filePath)
        const type = f.startsWith("workflow-") ? "workflow" : "project"
        return {
          name: info.name,
          type,
          scope: fileScope,
          ruleCount: info.ruleCount,
          retiredCount: info.retiredCount,
          lineCount: info.lineCount,
          compactNeeded: info.lineCount >= 100,
        }
      }).filter(f => !scopeFilter || f.type === scopeFilter)

      return c.json({ files: result })
    } catch (err) {
      const { body, status } = errorResponse(err, "files")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/file/:path — read single file + parsed rules
  routes.get("/file/:path", (c) => {
    const fileName = c.req.param("path")
    const fileNameCheck = validateKnowledgeFileName(fileName)
    if (!fileNameCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: fileNameCheck.error } }, 400)
    }

    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, fileName)

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
    const fileNameCheck = validateKnowledgeFileName(fileName)
    if (!fileNameCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: fileNameCheck.error } }, 400)
    }

    const body = await c.req.json()
    const { content } = body

    if (!content) return c.json({ error: { code: "INVALID_PARAM", message: "content required" } }, 400)

    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, fileName)

    try {
      writeKnowledgeFile(filePath, content)
      const rules = parseKnowledgeFile(filePath)
      return c.json({ ok: true, ruleCount: rules.length })
    } catch (err) {
      const { body, status } = errorResponse(err, "file.put")
      return c.json(body, status)
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
      const { body, status } = errorResponse(err, "preference.put")
      return c.json(body, status)
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
      const { body, status } = errorResponse(err, "effectiveness")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/compact — trigger LLM compact
  routes.post("/compact", async (c) => {
    const body = await c.req.json()
    const { org: reqOrg, filePath } = body

    if (!filePath) return c.json({ error: { code: "INVALID_PARAM", message: "filePath required" } }, 400)

    // Security: same policy as GET/PUT /file/:path — shared validator.
    const pathCheck = validateKnowledgeFileName(filePath)
    if (!pathCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: pathCheck.error } }, 400)
    }

    try {
      const { compactKnowledgeFile } = await import("../services/knowledge/maintenance")
      const result = await compactKnowledgeFile(reqOrg ?? org, filePath, pendingReviewDAO)
      return c.json(result)
    } catch (err) {
      const { body, status } = errorResponse(err, "compact")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/rebuild-index — rebuild index.md
  routes.post("/rebuild-index", (c) => {
    try {
      const result = rebuildIndex(org, knowledgeRuleDAO)
      return c.json({ ok: true, ...result })
    } catch (err) {
      const { body, status } = errorResponse(err, "rebuild-index")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/rule/:id/restore — restore retired rule
  routes.post("/rule/:id/restore", async (c) => {
    const ruleId = c.req.param("id")

    // Security: validate rule ID format before hitting the DAO. This also
    // prevents DB-driven path traversal: the file_name returned by
    // knowledgeRuleDAO.getById() is later joined with the knowledge dir,
    // so a malicious id must be rejected up front.
    if (!isValidRuleId(ruleId)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid rule ID format" } }, 400)
    }

    try {
      const { restoreRule } = await import("../services/knowledge/effectiveness")
      const result = restoreRule(ruleId, knowledgeRuleDAO)
      // Remove retired annotation from knowledge file
      const rule = knowledgeRuleDAO.getById(ruleId)
      if (rule) {
        const fileNameCheck = validateKnowledgeFileName(rule.file_name)
        if (!fileNameCheck.ok) {
          return c.json({ error: { code: "INTERNAL_ERROR", message: "stored file_name invalid" } }, 500)
        }
        const knowledgeDir = getKnowledgeDir(org)
        const filePath = path.join(knowledgeDir, rule.file_name)
        unmarkRuleRetired(filePath, ruleId)
      }
      return c.json(result)
    } catch (err) {
      const { body, status } = errorResponse(err, "rule.restore")
      return c.json(body, status)
    }
  })

  return routes
}
