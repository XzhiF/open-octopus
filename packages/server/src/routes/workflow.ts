import { Hono } from "hono"
import os from "os"
import { WorkflowService } from "../services/workflow"
import { WorkspaceDAO } from "../db/dao"

const service = new WorkflowService()

export function createWorkflowRoutes(workspaceDAO: WorkspaceDAO): Hono {
  const router = new Hono()

  function getWorkspacePath(id: string): string | undefined {
    const ws = workspaceDAO.findById(id)
    if (!ws) return undefined
    return ws.path.replace(/^~/, os.homedir())
  }

  router.get("/", (c) => {
    const workspaceId = c.req.param("id")
    const wsPath = getWorkspacePath(workspaceId)
    if (wsPath === undefined) return c.json({ error: "workspace not found" }, 404)
    return c.json(service.list(wsPath))
  })

  router.post("/", async (c) => {
    const workspaceId = c.req.param("id")
    const wsPath = getWorkspacePath(workspaceId)
    if (wsPath === undefined) return c.json({ error: "workspace not found" }, 404)

    const body = await c.req.json<{ ref: string; content: string }>()
    if (!body.ref || !body.content) {
      return c.json({ error: "ref and content are required" }, 400)
    }
    const workflow = service.create(wsPath, body.ref, body.content)
    return c.json(workflow, 201)
  })

  router.get("/:ref", (c) => {
    const workspaceId = c.req.param("id")
    const wsPath = getWorkspacePath(workspaceId)
    if (wsPath === undefined) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const workflow = service.get(wsPath, ref)
    if (!workflow) return c.json({ error: "not found" }, 404)
    return c.json(workflow)
  })

  router.put("/:ref", async (c) => {
    const workspaceId = c.req.param("id")
    const wsPath = getWorkspacePath(workspaceId)
    if (wsPath === undefined) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const body = await c.req.json<{ content: string }>()
    if (!body.content) return c.json({ error: "content is required" }, 400)

    const workflow = service.update(wsPath, ref, body.content)
    if (!workflow) return c.json({ error: "not found" }, 404)
    return c.json(workflow)
  })

  router.delete("/:ref", (c) => {
    const workspaceId = c.req.param("id")
    const wsPath = getWorkspacePath(workspaceId)
    if (wsPath === undefined) return c.json({ error: "workspace not found" }, 404)

    const ref = c.req.param("ref")
    const deleted = service.delete(wsPath, ref)
    if (!deleted) return c.json({ error: "not found" }, 404)
    return c.json({ ok: true })
  })

  return router
}

export default createWorkflowRoutes
