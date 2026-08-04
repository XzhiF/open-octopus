import { Hono } from "hono"
import os from "os"
import fs from "fs"
import { WorkflowService } from "../services/workflow"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import { WorkspaceDAO } from "../db/dao"
import type { ResourceManager } from "@octopus/shared"

const service = new WorkflowService()

export function createWorkflowRoutes(
  workspaceDAO: WorkspaceDAO,
  getManager: () => ResourceManager,
): Hono {
  const router = new Hono()

  function getWorkspace(id: string) {
    const ws = workspaceDAO.findById(id)
    if (!ws) return undefined
    return { path: ws.path.replace(/^~/, os.homedir()) }
  }

  router.get("/", (c) => {
    const workspaceId = c.req.param("id")
    const ws = getWorkspace(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)

    const local = service.list(ws.path)
    const builtIn = new BuiltInWorkflowService(getManager()).list()
    return c.json([...local, ...builtIn])
  })

  router.post("/", async (c) => {
    const workspaceId = c.req.param("id")
    const ws = getWorkspace(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)

    const body = await c.req.json<{ ref: string; content: string }>()
    if (!body.ref || !body.content) {
      return c.json({ error: "ref and content are required" }, 400)
    }
    const workflow = service.create(ws.path, body.ref, body.content)
    return c.json(workflow, 201)
  })

  router.get("/:ref", (c) => {
    const workspaceId = c.req.param("id")
    const ws = getWorkspace(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const executionId = c.req.query("executionId")
    const isDynamic = c.req.query("isDynamic") === "true"

    const local = service.get(ws.path, ref, executionId)

    // For dynamic_sub_workflow: only use execution-scoped snapshot
    // If snapshot doesn't exist, return 404 (don't fall back to workflows/)
    if (local) {
      if (isDynamic && !executionId) {
        // Dynamic workflow without execution context - shouldn't happen
        return c.json({ error: "not found" }, 404)
      }
      // Check if this came from snapshot or workflows/
      // If isDynamic and we have executionId, verify it's from snapshot
      if (isDynamic && executionId) {
        const snapshotPath = `${ws.path}/state/dynamic-workflows/${executionId}/${ref}.yaml`
        if (!fs.existsSync(snapshotPath)) {
          // Snapshot doesn't exist yet (node hasn't run) - return empty
          return c.json({ error: "not found" }, 404)
        }
      }
      return c.json(local)
    }

    const builtIn = new BuiltInWorkflowService(getManager()).get(ref)
    if (builtIn) return c.json(builtIn)

    return c.json({ error: "not found" }, 404)
  })

  router.put("/:ref", async (c) => {
    const workspaceId = c.req.param("id")
    const ws = getWorkspace(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const body = await c.req.json<{ content: string }>()
    if (!body.content) return c.json({ error: "content is required" }, 400)

    const workflow = service.update(ws.path, ref, body.content)
    if (!workflow) return c.json({ error: "not found" }, 404)
    return c.json(workflow)
  })

  router.delete("/:ref", (c) => {
    const workspaceId = c.req.param("id")
    const ws = getWorkspace(workspaceId)
    if (!ws) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const deleted = service.delete(ws.path, ref)
    if (!deleted) return c.json({ error: "not found" }, 404)
    return c.json({ ok: true })
  })

  return router
}

export default createWorkflowRoutes
