import { Hono } from "hono"
import { getService } from "../services/execution-service-registry"
import type { WorkspaceDAO } from "../db/dao/workspace-dao"

export function createWorkflowOpsRoutes(_workspaceDao: WorkspaceDAO): Hono {
  const router = new Hono()

  // GET /executions — List executions with optional status filter
  router.get("/executions", (c) => {
    const workspaceId = c.req.param("id")
    const status = c.req.query("status")

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    let executions = svc.service.list(workspaceId)
    if (status) {
      executions = executions.filter((e) => e.status === status)
    }

    return c.json({ executions })
  })

  // GET /executions/:execId/status — Execution status overview
  router.get("/executions/:execId/status", (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    const execution = svc.service.getById(execId)
    if (!execution) return c.json({ error: "Execution not found" }, 404)

    const withSteps = svc.service.getByIdWithSteps(execId)

    return c.json({
      status: execution.status,
      progress: execution.progress,
      gateStatus: execution.gate_status,
      startedAt: execution.started_at,
      completedAt: execution.completed_at,
      duration: execution.duration,
      nodeCount: withSteps?.steps?.length ?? 0,
      workflowName: execution.workflow_name,
    })
  })

  // POST /executions/:execId/abort — Abort execution
  router.post("/executions/:execId/abort", async (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    try {
      await svc.service.cancel(execId)
      return c.json({ ok: true })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, 500)
    }
  })

  // GET /executions/:execId/nodes/:nodeId/events — Node events
  router.get("/executions/:execId/nodes/:nodeId/events", (c) => {
    const workspaceId = c.req.param("id")
    const execId = c.req.param("execId")
    const nodeId = c.req.param("nodeId")
    if (!execId) return c.json({ error: "Execution id required" }, 400)
    if (!nodeId) return c.json({ error: "Node id required" }, 400)

    const svc = getService(workspaceId)
    if (!svc) return c.json({ error: "Workspace not found" }, 404)

    const events = svc.service.getAgentEvents(execId, nodeId)

    return c.json({ events })
  })

  return router
}
