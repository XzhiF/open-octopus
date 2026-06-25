import { Hono } from "hono"
import { BuiltInWorkflowService } from "../services/builtin-workflow"

const builtInWorkflowRoutes = new Hono()
const service = new BuiltInWorkflowService()

builtInWorkflowRoutes.get("/", (c) => {
  return c.json(service.list())
})

builtInWorkflowRoutes.get("/:ref", (c) => {
  const ref = c.req.param("ref")
  const workflow = service.get(ref)
  if (!workflow) return c.json({ error: "not found" }, 404)
  return c.json(workflow)
})

export default builtInWorkflowRoutes