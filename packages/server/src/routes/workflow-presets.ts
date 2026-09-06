// packages/server/src/routes/workflow-presets.ts
//
// task-workflow-presets (T3) → binding-catalog redesign (2026-09-06):
// GET /api/workflow-presets — the binding catalog verbatim (no filters).

import { Hono } from "hono"
import type { WorkflowPresetsService } from "../services/workflow-presets-service"

export function createWorkflowPresetsRoutes(
  getService: () => WorkflowPresetsService,
): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    return c.json(getService().list())
  })

  return app
}
