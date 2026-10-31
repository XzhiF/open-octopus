import { Hono } from "hono"
import { getActivityBus } from "../services/activity/activity-bus"

/** GET /api/activity?workspace_id=&limit= — recent cross-domain activity. */
export function createActivityRoutes(): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const workspaceId = c.req.query("workspace_id") || undefined
    const rawLimit = Number(c.req.query("limit") ?? "50")
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50
    return c.json({ events: getActivityBus().list({ workspaceId, limit }) })
  })

  return app
}
