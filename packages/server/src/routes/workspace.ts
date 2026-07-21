import { Hono } from "hono"
import { WorkspaceService } from "../services/workspace"
import { WorkspaceDAO, OrgDAO } from "../db/dao"
import { orgExists } from "../services/org"
import { parseManifest, parseManifestJson, loadModelAliasConfig } from "@octopus/shared"
import { readFileSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import os from "os"
import { getArchiveService, ArchivePartialFailure } from "../services/archive/archive-service"

export function createWorkspaceRoutes(workspaceService: WorkspaceService, orgDAO: OrgDAO, workspaceDAO: WorkspaceDAO): Hono {
  const workspaceRoutes = new Hono()

  workspaceRoutes.get("/", (c) => {
    const workspaces = workspaceService.list()
    const resolved = workspaces.map(w => ({ ...w, path: w.path.replace(/^~/, os.homedir()) }))
    return c.json(resolved)
  })

  workspaceRoutes.get("/repos", (c) => {
    const org = c.req.query("org") || "xzf"
    const reposDir = join(os.homedir(), ".octopus", "orgs", org, "repos")
    const jsonPath = join(reposDir, "manifest.json")
    const mdPath = join(reposDir, "manifest.md")

    let groups: Record<string, any[]>
    if (existsSync(jsonPath)) {
      groups = parseManifestJson(readFileSync(jsonPath, "utf-8"))
    } else if (existsSync(mdPath)) {
      groups = parseManifest(readFileSync(mdPath, "utf-8"))
    } else {
      return c.json({ groups: {}, org })
    }
    return c.json({ groups, org })
  })

  workspaceRoutes.post("/", async (c) => {
    const body = await c.req.json<{ name: string; org: string; description?: string; path?: string; repos?: string[]; branch?: string }>()
    if (!orgExists(orgDAO, body.org)) {
      return c.json({ error: `Org '${body.org}' not found` }, 400)
    }
    const workoutPath = body.path || `~/.octopus/orgs/${body.org}/workspaces/${body.name}`
    const workspace = workspaceService.create({
      name: body.name,
      org: body.org,
      description: body.description,
      path: workoutPath,
      repos: body.repos,
      branch: body.branch,
    })

    // Check worktree status - if repos were specified but all failed, return error
    if (body.repos && body.repos.length > 0 && workspace.worktreeStatus) {
      const { created, failed } = workspace.worktreeStatus
      if (created === 0 && failed.length > 0) {
        // Delete the workspace since no worktrees were created
        await workspaceService.delete(workspace.id)
        return c.json({
          error: `Failed to create any worktrees. All ${failed.length} repos failed:`,
          details: failed
        }, 500)
      }
    }

    const { worktreeStatus, ...workspaceData } = workspace
    return c.json({
      ...workspaceData,
      path: workspaceData.path.replace(/^~/, os.homedir()),
      worktreeStatus
    }, 201)
  })

  workspaceRoutes.get("/importable", (c) => {
    const org = c.req.query("org") || "xzf"
    const workspacesDir = join(os.homedir(), ".octopus", "orgs", org, "workspaces")
    if (!existsSync(workspacesDir)) return c.json({ workspaces: [] })

    const allDbWorkspaces = workspaceService.list(org)
    const dbPaths = new Set(allDbWorkspaces.map(w => w.path))

    const importable: { name: string; path: string; repoCount: number; branch: string | null }[] = []
    try {
      for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const configPath = join(workspacesDir, entry.name, "config.json")
        if (!existsSync(configPath)) continue
        const wsPath = `~/.octopus/orgs/${org}/workspaces/${entry.name}`
        if (dbPaths.has(wsPath)) continue

        try {
          const config = JSON.parse(readFileSync(configPath, "utf-8"))
          importable.push({
            name: entry.name,
            path: wsPath,
            repoCount: (config.repos || []).length,
            branch: config.branch || null,
          })
        } catch { /* skip broken config.json */ }
      }
    } catch { /* directory read error */ }

    return c.json({ workspaces: importable, org })
  })

  workspaceRoutes.post("/import", async (c) => {
    const body = await c.req.json<{ name: string; org: string }>()
    const wsPath = `~/.octopus/orgs/${body.org}/workspaces/${body.name}`
    const resolvedPath = wsPath.replace(/^~/, os.homedir())
    const configPath = join(resolvedPath, "config.json")

    if (!existsSync(configPath)) {
      return c.json({ error: "config.json not found for this workspace" }, 404)
    }

    const existing = workspaceDAO.findByPath(wsPath)
    if (existing) {
      return c.json({ error: "workspace already imported", id: existing.id }, 409)
    }

    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"))
      const workspace = workspaceService.create({
        name: body.name,
        org: body.org,
        description: config.description,
        path: wsPath,
        repos: (config.repos || []).map((r: any) => `${r.group}/${r.name}`),
      })
      return c.json(workspace, 201)
    } catch (e: any) {
      return c.json({ error: `Failed to import: ${e.message}` }, 500)
    }
  })

  // ── P1.5: Archive ops endpoints ──────────────────────────────────

  // ── MOA config endpoints ─────────────────────────────────────────
  // M7 fix: drop misleading :id — endpoint returns global config, not workspace-specific
  workspaceRoutes.get("/config/models", (c) => {
    const config = loadModelAliasConfig()
    return c.json({ providers: config.providers })
  })

  workspaceRoutes.get("/archive/status", (c) => {
    const stuck = workspaceDAO.listByArchiveStatus("archiving")
    return c.json({ data: stuck })
  })

  workspaceRoutes.post("/:id/archive/retry", async (c) => {
    const id = c.req.param("id")
    const ws = workspaceDAO.findById(id)
    if (!ws) return c.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, 404)
    if (ws.archive_status !== "archiving" && ws.archive_status !== "archive_failed") {
      return c.json({ error: { code: "INVALID_STATE", message: `Workspace not in retryable state (current: ${ws.archive_status})` } }, 409)
    }
    try {
      const archiveSvc = getArchiveService()
      if (!archiveSvc) return c.json({ error: { code: "SUBSYSTEM_UNAVAILABLE", message: "Archive service not available" } }, 503)
      await archiveSvc.archiveWorkspace(id, workspaceDAO)
      workspaceDAO.cascadeDeleteByWorkspace(id)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ArchivePartialFailure) {
        return c.json({ error: { code: "ARCHIVE_PARTIAL_FAILURE", message: "Some executions failed to archive", failureCount: err.failures.length } }, 409)
      }
      return c.json({ error: { code: "ARCHIVE_FAILED", message: "Archive operation failed" } }, 500)
    }
  })

  workspaceRoutes.get("/:id", (c) => {
    const id = c.req.param("id")
    const workspace = workspaceService.getById(id)
    if (!workspace) return c.json({ error: "not found" }, 404)
    return c.json({ ...workspace, path: workspace.path.replace(/^~/, os.homedir()) })
  })

  workspaceRoutes.put("/:id", async (c) => {
    const id = c.req.param("id")
    const body = await c.req.json<{ name?: string; org?: string }>()
    const workspace = workspaceService.update(id, body)
    if (!workspace) return c.json({ error: "not found" }, 404)
    return c.json(workspace)
  })

  workspaceRoutes.delete("/:id", async (c) => {
    const id = c.req.param("id")
    try {
      await workspaceService.delete(id)
      return c.json({ ok: true })
    } catch (err) {
      if (err instanceof ArchivePartialFailure) {
        return c.json({
          error: { code: "ARCHIVE_PARTIAL_FAILURE", message: `${err.failures.length} executions failed to archive`, details: err.failures },
        }, 409)
      }
      throw err
    }
  })

  return workspaceRoutes
}

export default createWorkspaceRoutes
