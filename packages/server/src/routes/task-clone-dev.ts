// packages/server/src/routes/task-clone-dev.ts
//
// REST surface for clone-dev tasks (2026-11-25).
// Mounted at /api/tasks alongside the task routes; paths are /:id/clone-dev/*.

import { Hono } from "hono"
import { CloneDevError, getCloneDevService, type CloneDevMode } from "../services/tasks/clone-dev-service"

type ErrorStatus = 400 | 404 | 409 | 500 | 503

function toError(err: unknown): { status: ErrorStatus; body: { error: string } } {
  if (err instanceof CloneDevError) return { status: err.status as ErrorStatus, body: { error: err.message } }
  return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } }
}

export function createTaskCloneDevRoutes(): Hono {
  const router = new Hono()

  const service = () => {
    const svc = getCloneDevService()
    if (!svc) throw new CloneDevError(503, "clone-dev service not ready")
    return svc
  }

  // GET /:id/clone-dev — 当前状态 + 分身目录
  router.get("/:id/clone-dev", (c) => {
    try {
      return c.json(service().getState(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // PUT /:id/clone-dev/meta — Agent 声明代号 / 模式 / 工具清单
  router.put("/:id/clone-dev/meta", async (c) => {
    try {
      const body = await c.req
        .json<{
          clone_name?: string
          mode?: CloneDevMode
          clone_type?: "built-in" | "user"
          display_name?: string
          kit_enabled?: boolean
          tools?: string[]
        }>()
        .catch(() => ({}))
      if (!body.clone_name) return c.json({ error: "clone_name is required" }, 400)
      return c.json(service().setMeta(c.req.param("id"), { ...body, clone_name: body.clone_name }))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/clone-dev/verify — 三条硬判据
  router.post("/:id/clone-dev/verify", async (c) => {
    try {
      return c.json(await service().verify(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/clone-dev/complete — 三绿才放行，draft→ready + awaiting_archive
  router.post("/:id/clone-dev/complete", (c) => {
    try {
      return c.json(service().completeTask(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  // POST /:id/clone-dev/install — 合入时把 kit 装进用户分身目录
  router.post("/:id/clone-dev/install", (c) => {
    try {
      return c.json(service().installKit(c.req.param("id")))
    } catch (err: unknown) {
      const e = toError(err)
      return c.json(e.body, e.status)
    }
  })

  return router
}
