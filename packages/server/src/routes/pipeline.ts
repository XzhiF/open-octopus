// packages/server/src/routes/pipeline.ts
import { Hono } from "hono"
import { WorkspaceDAO } from "../db/dao"
import { PipelineConfigLoader } from "../services/pipeline-config"
import os from "os"

export function createPipelineRoutes(workspaceDAO: WorkspaceDAO): Hono {
  const pipelineRoutes = new Hono()

  function resolveWorkspacePath(workspaceId: string): string | null {
    const wsPath = workspaceDAO.findPathById(workspaceId)
    if (!wsPath) return null
    return wsPath.replace(/^~/, os.homedir())
  }

  pipelineRoutes.get("/:workspaceId/pipeline", (c) => {
    const workspaceId = c.req.param("workspaceId")
    const workspacePath = resolveWorkspacePath(workspaceId)
    if (!workspacePath) {
      return c.json({ error: "Workspace not found" }, 404)
    }

    const loader = new PipelineConfigLoader(workspacePath)
    const config = loader.getConfig()
    return c.json({ config })
  })

  pipelineRoutes.put("/:workspaceId/pipeline", async (c) => {
    const workspaceId = c.req.param("workspaceId")
    const workspacePath = resolveWorkspacePath(workspaceId)
    if (!workspacePath) {
      return c.json({ error: "Workspace not found" }, 404)
    }

    try {
      const body = await c.req.json()
      const loader = new PipelineConfigLoader(workspacePath)
      loader.save(body)
      return c.json({ success: true })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error"
      return c.json({ error: message }, 400)
    }
  })

  pipelineRoutes.get("/:workspaceId/pipeline/validate", (c) => {
    const workspaceId = c.req.param("workspaceId")
    const workspacePath = resolveWorkspacePath(workspaceId)
    if (!workspacePath) {
      return c.json({ error: "Workspace not found" }, 404)
    }

    const loader = new PipelineConfigLoader(workspacePath)
    const config = loader.getConfig()
    const hash = loader.getConfigHash()
    return c.json({ valid: config !== null, config, hash })
  })

  return pipelineRoutes
}

export default createPipelineRoutes
