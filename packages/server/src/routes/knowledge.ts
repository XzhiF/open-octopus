import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import path from "path"
import fs from "fs"
import os from "os"
import type { KnowledgeEffectivenessDAO, PendingReviewDAO } from "../db/dao"
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
  unmarkRuleRetired,
  findRuleById,
} from "../services/knowledge/file-ops"
import { isValidRuleId, validateKnowledgeFileName, errorResponse } from "../services/knowledge/validators"

export function createKnowledgeRoutes(
  effectivenessDAO: KnowledgeEffectivenessDAO,
  pendingReviewDAO: PendingReviewDAO,
): Hono {
  const routes = new Hono()

  // GET /api/knowledge/files — list knowledge files (org + global)
  routes.get("/files", (c) => {
    try {
      const org = c.req.query("org") || undefined
      const scopeFilter = c.req.query("scope")
      const orgDir = getKnowledgeDir(org)
      const globalDir = getKnowledgeDir() // global knowledge dir

      const readSubDir = (
        baseDir: string,
        subDir: string,
        type: "project" | "workflow",
        fileScope: "org" | "global",
      ) => {
        const dir = path.join(baseDir, subDir)
        try {
          return fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => ({
              name: `${subDir}/${f}`,
              fullPath: path.join(dir, f),
              type,
              scope: fileScope as "org" | "global",
            }))
        } catch {
          return []
        }
      }

      const allFiles = [
        ...readSubDir(orgDir, "projects", "project", "org"),
        ...readSubDir(orgDir, "workflows", "workflow", "org"),
        ...readSubDir(globalDir, "projects", "project", "global"),
        ...readSubDir(globalDir, "workflows", "workflow", "global"),
      ]

      const result = allFiles
        .map(({ name, fullPath, type, scope: fileScope }) => {
          const info = getKnowledgeFileInfo(fullPath)
          return {
            name,
            type,
            scope: fileScope,
            ruleCount: info.ruleCount,
            retiredCount: info.retiredCount,
            lineCount: info.lineCount,
            compactNeeded: info.lineCount >= 100,
          }
        })
        .filter((f) => !scopeFilter || f.type === scopeFilter)

      return c.json({ files: result })
    } catch (err) {
      const { body, status } = errorResponse(err, "files")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/file — read single file + parsed rules
  routes.get("/file", (c) => {
    const org = c.req.query("org") || undefined
    const fileName = c.req.query("path") || ""
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

  // PUT /api/knowledge/file — write file
  routes.put("/file", async (c) => {
    const org = c.req.query("org") || undefined
    const fileName = c.req.query("path") || ""
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

  // DELETE /api/knowledge/file — delete a knowledge file
  routes.delete("/file", (c) => {
    const org = c.req.query("org") || undefined
    const fileName = c.req.query("path") || ""
    const fileNameCheck = validateKnowledgeFileName(fileName)
    if (!fileNameCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: fileNameCheck.error } }, 400)
    }

    const knowledgeDir = getKnowledgeDir(org)
    const filePath = path.join(knowledgeDir, fileName)

    try {
      // Remove file from disk
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      return c.json({ ok: true })
    } catch (err) {
      const { body, status } = errorResponse(err, "file.delete")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/preference — read user preference
  routes.get("/preference", (c) => {
    const scope = c.req.query("scope") ?? "org"
    if (!["global", "org"].includes(scope)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "scope must be global|org" } }, 400)
    }

    // Per-request org resolution. Undefined org → global scope.
    const org = scope === "global" ? undefined : (c.req.query("org") || undefined)
    const content = readUserPreference(org)
    const knowledgeDir = getKnowledgeDir(org)

    return c.json({
      content,
      scope,
      filePath: path.join(knowledgeDir, "user_preference.md"),
    })
  })

  // PUT /api/knowledge/preference — write user preference
  routes.put("/preference", async (c) => {
    const body = await c.req.json()
    const { content, scope, org: bodyOrg } = body

    if (!content && content !== "") return c.json({ error: { code: "INVALID_PARAM", message: "content required" } }, 400)
    if (!scope || !["global", "org"].includes(scope)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "scope must be global|org" } }, 400)
    }

    // Per-request org resolution. Body `org` takes precedence, then query,
    // then undefined (→ global scope).
    const org = scope === "global" ? undefined : (bodyOrg || c.req.query("org") || undefined)

    try {
      writeUserPreference(org, content)
      return c.json({ ok: true })
    } catch (err) {
      const { body: respBody, status } = errorResponse(err, "preference.put")
      return c.json(respBody, status)
    }
  })

  // GET /api/knowledge/effectiveness — effect tracking data
  routes.get("/effectiveness", (c) => {
    try {
      const ruleId = c.req.query("ruleId")
      if (ruleId) {
        const row = effectivenessDAO.getByRuleId(ruleId)
        const org = c.req.query("org") || undefined
        const rule = org ? findRuleById(org, ruleId) : undefined
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
      const org = c.req.query("org") || undefined
      const items = all.map(row => {
        const rule = org ? findRuleById(org, row.rule_id) : undefined
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

  // POST /api/knowledge/compact-preview — streaming preview compact via SSE
  routes.post("/compact-preview", async (c) => {
    const body = await c.req.json()
    const { org: reqOrg, filePath } = body
    const org = reqOrg || c.req.query("org") || undefined

    if (!filePath) return c.json({ error: { code: "INVALID_PARAM", message: "filePath required" } }, 400)

    const pathCheck = validateKnowledgeFileName(filePath)
    if (!pathCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: pathCheck.error } }, 400)
    }

    const { buildCompactPrompt } = await import("../services/knowledge/maintenance")
    const result = buildCompactPrompt(org ?? "", filePath)

    if (!result) {
      const { readKnowledgeFile } = await import("../services/knowledge/file-ops")
      const knowledgeDir = getKnowledgeDir(org ?? "")
      const originalContent = readKnowledgeFile(path.join(knowledgeDir, filePath))
      return c.json({ originalContent, compactedContent: originalContent, llmAvailable: false })
    }

    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({
          event: "original",
          data: JSON.stringify({ originalContent: result.originalContent }),
        })

        const { callHaikuStream } = await import("../services/knowledge/llm")
        let hasContent = false
        for await (const delta of callHaikuStream(result.prompt)) {
          hasContent = true
          await stream.writeSSE({
            event: "text_delta",
            data: JSON.stringify({ content: delta }),
          })
        }

        if (!hasContent) {
          await stream.writeSSE({
            event: "fallback",
            data: JSON.stringify({ content: result.originalContent }),
          })
        }

        await stream.writeSSE({ event: "done", data: "{}" })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: reason }),
        })
      }
    })
  })

  // POST /api/knowledge/compact — trigger LLM compact
  routes.post("/compact", async (c) => {
    const body = await c.req.json()
    const { org: reqOrg, filePath } = body
    const org = reqOrg || c.req.query("org") || undefined

    if (!filePath) return c.json({ error: { code: "INVALID_PARAM", message: "filePath required" } }, 400)

    // Security: same policy as GET/PUT /file/:path — shared validator.
    const pathCheck = validateKnowledgeFileName(filePath)
    if (!pathCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: pathCheck.error } }, 400)
    }

    try {
      const { compactKnowledgeFile } = await import("../services/knowledge/maintenance")
      const result = await compactKnowledgeFile(org, filePath, pendingReviewDAO)
      return c.json(result)
    } catch (err) {
      const { body, status } = errorResponse(err, "compact")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/rebuild-index — rebuild index.md
  routes.post("/rebuild-index", (c) => {
    const org = c.req.query("org") || undefined
    try {
      const result = rebuildIndex(org)
      return c.json({ ok: true, ...result })
    } catch (err) {
      const { body, status } = errorResponse(err, "rebuild-index")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/rule/:id/restore — restore retired rule
  routes.post("/rule/:id/restore", async (c) => {
    const org = c.req.query("org") || undefined
    const ruleId = c.req.param("id")

    // Security: validate rule ID format. This also
    // prevents path traversal: the file_name returned by
    // findRuleById() is later joined with the knowledge dir,
    // so a malicious id must be rejected up front.
    if (!isValidRuleId(ruleId)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "Invalid rule ID format" } }, 400)
    }

    try {
      const { restoreRule } = await import("../services/knowledge/effectiveness")
      const result = restoreRule(ruleId, org ?? "")
      return c.json(result)
    } catch (err) {
      const { body, status } = errorResponse(err, "rule.restore")
      return c.json(body, status)
    }
  })

  // GET /api/knowledge/workflows — list available workflow YAML files
  routes.get("/workflows", (c) => {
    try {
      const workflowsDir = path.join(os.homedir(), ".octopus", "workflows")
      if (!fs.existsSync(workflowsDir)) {
        return c.json({ workflows: [] })
      }
      const files = fs.readdirSync(workflowsDir)
        .filter((f: string) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f: string) => f.replace(/\.ya?ml$/, ""))
      return c.json({ workflows: files })
    } catch (err) {
      const { body, status } = errorResponse(err, "workflows")
      return c.json(body, status)
    }
  })

  // POST /api/knowledge/generate — AI-generate initial knowledge content
  routes.post("/generate", async (c) => {
    const body = await c.req.json()
    const { org, type, name } = body

    if (!org || !type || !name) {
      return c.json({ error: { code: "INVALID_PARAM", message: "org, type, and name are required" } }, 400)
    }
    if (!["project", "workflow"].includes(type)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "type must be project or workflow" } }, 400)
    }

    const nameCheck = validateKnowledgeFileName(`${type === "project" ? "projects" : "workflows"}/${name}.md`)
    if (!nameCheck.ok) {
      return c.json({ error: { code: "INVALID_PARAM", message: nameCheck.error } }, 400)
    }

    try {
      const { generateInitialKnowledge } = await import("../services/knowledge/generate")
      const result = generateInitialKnowledge(org, type, name)
      return c.json(result)
    } catch (err) {
      const { body: respBody, status } = errorResponse(err, "generate")
      return c.json(respBody, status)
    }
  })

  return routes
}
