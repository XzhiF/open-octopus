import { Hono } from "hono"
import { BuiltInWorkflowService } from "../services/builtin-workflow"
import type { ResourceManager } from "@octopus/shared"

export function createBuiltInWorkflowRoutes(getManager: () => ResourceManager): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const manager = getManager()
    const service = new BuiltInWorkflowService(manager)
    return c.json(service.list())
  })

  app.get("/:ref", (c) => {
    const manager = getManager()
    const service = new BuiltInWorkflowService(manager)
    const ref = c.req.param("ref")
    const workflow = service.get(ref)
    if (!workflow) return c.json({ error: "not found" }, 404)
    return c.json(workflow)
  })

  return app
}
