// packages/server/src/routes/task-workflow-dev.ts
//
// REST surface for workflow-dev tasks (2026-11-06).
// Mounted at /api/tasks alongside the task routes; paths are /:id/workflow-dev/*.

import { Hono } from "hono"
import { getWorkflowDevService, WorkflowDevError } from "../services/tasks/workflow-dev-service"

type ErrorStatus = 400 | 404 | 409 | 500 | 503

function toError(err: unknown): { status: ErrorStatus; body: { error: string } } {
  if (err instanceof WorkflowDevError) {
    return { status: err.status as ErrorStatus, body: { error: err.message } }
  }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
}

export function createTaskWorkflowDevRoutes(): Hono {
  const router = new Hono()

  const service = () => {
    const svc = getWorkflowDevService()
    if (!svc) throw new WorkflowDevError(503, "workflow-dev service not ready")
    return svc
  }

  // GET /:id/workflow-dev — current definition + verification state.
  router.get("/:id/workflow-dev", (c) => {
    try {
      return c.json(service().getState(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // PUT /:id/workflow-dev — save YAML (optimistic lock via originalContent).
  router.put("/:id/workflow-dev", async (c) => {
    try {
      const body = await c.req.json<{ content?: string; originalContent?: string }>().catch(() => ({}))
      if (typeof body.content !== "string" || body.content.trim() === "") {
        return c.json({ error: "content is required" }, 400)
      }
      const snapshot = service().save(c.req.param("id"), body.content, body.originalContent)
      return c.json(snapshot)
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/validate — parse + semantic validation.
  router.post("/:id/workflow-dev/validate", async (c) => {
    try {
      const body = await c.req.json<{ yaml?: string }>().catch(() => ({}))
      return c.json(service().validate(c.req.param("id"), body.yaml))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/simulate — run the fixture through the engine simulator.
  router.post("/:id/workflow-dev/simulate", async (c) => {
    try {
      const body = await c.req
        .json<{ scenario?: string; strict?: boolean; realExecution?: string[] }>()
        .catch(() => ({}))
      return c.json(await service().simulate(c.req.param("id"), body))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/complete-workflow — one workflow done + release choice.
  router.post("/:id/workflow-dev/complete-workflow", async (c) => {
    try {
      const body = await c.req.json<{ ref?: string; stage?: "release" | "snapshot" }>().catch(() => ({}))
      if (!body.ref) return c.json({ error: "ref is required" }, 400)
      if (body.stage !== "release" && body.stage !== "snapshot") {
        return c.json({ error: 'stage must be "release" or "snapshot"' }, 400)
      }
      return c.json(service().markWorkflowComplete(c.req.param("id"), body.ref, body.stage))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/release — copy a released YAML into the main-agent workspace.
  router.post("/:id/workflow-dev/release", async (c) => {
    try {
      const body = await c.req.json<{ ref?: string }>().catch(() => ({}))
      if (!body.ref) return c.json({ error: "ref is required" }, 400)
      return c.json(service().release(c.req.param("id"), body.ref))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/complete-task — development finished → awaiting_archive.
  router.post("/:id/workflow-dev/complete-task", (c) => {
    try {
      return c.json(service().completeTask(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/workflow-dev/projects — bring repos into the task workspace.
  router.post("/:id/workflow-dev/projects", async (c) => {
    try {
      const body = await c.req.json<{ projects?: string[] }>().catch(() => ({}))
      if (!Array.isArray(body.projects)) {
        return c.json({ error: "projects must be an array of project names" }, 400)
      }
      return c.json(service().addProjects(c.req.param("id"), body.projects))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  return router
}

export default createTaskWorkflowDevRoutes
