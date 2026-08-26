// packages/server/src/routes/workflow-presets.ts
//
// task-workflow-presets (T3): GET /api/workflow-presets?skills_group=a,b
// Returns the filtered preset catalog from the task-author clone directory.

import { Hono } from "hono"
import type { WorkflowPresetsService } from "../services/workflow-presets-service"

export function createWorkflowPresetsRoutes(
  getService: () => WorkflowPresetsService,
): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const skillsGroupParam = c.req.query("skills_group")
    const skillsGroup = skillsGroupParam
      ? skillsGroupParam.split(",").map(s => s.trim()).filter(Boolean)
      : undefined

    const result = getService().list(skillsGroup)
    return c.json(result)
  })

  return app
}
