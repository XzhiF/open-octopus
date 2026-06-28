// packages/server/src/routes/agent/schedule-register.ts
// POST /schedules/register — register a new scheduled job via the Agent API.

import { Hono } from "hono"
import crypto from "crypto"
import type { ScheduleConfigDAO } from "../../db/dao/schedule-config-dao"
import type { SchedulerService } from "../../services/scheduler/scheduler-service"

interface ScheduleRegisterDeps {
  scheduleConfigDAO: ScheduleConfigDAO
  schedulerService: SchedulerService
}

export function createScheduleRegisterRoutes(deps: ScheduleRegisterDeps) {
  const router = new Hono()

  router.post("/schedules/register", async (c) => {
    try {
      const body = await c.req.json()
      const { name, cron, timezone, job_type, workflow_ref, input_values, notify_strategy } = body

      if (!name || typeof name !== "string" || name.length > 100) {
        return c.json({ error: { code: "INVALID_PARAM", message: "name is required (1-100 chars)" } }, 400)
      }

      if (!cron || typeof cron !== "string") {
        return c.json({ error: { code: "INVALID_CRON", message: "cron expression is required" } }, 400)
      }

      // Validate cron format (basic check: 5 fields)
      const cronParts = cron.trim().split(/\s+/)
      if (cronParts.length !== 5) {
        return c.json({ error: { code: "INVALID_CRON", message: "cron must have 5 fields" } }, 400)
      }

      const org = (c.get("org" as any) as string) || c.req.header("X-Octopus-Org") || "default"

      // Check name uniqueness using the existing checkNameConflict method
      const hasConflict = deps.scheduleConfigDAO.checkNameConflict(org, name)
      if (hasConflict) {
        return c.json({ error: { code: "CONFLICT", message: `name '${name}' already exists` } }, 409)
      }

      const id = crypto.randomUUID()
      const now = new Date().toISOString()

      deps.scheduleConfigDAO.insertSchedule({
        id,
        org,
        name,
        cron_expression: cron,
        timezone: timezone || "Asia/Shanghai",
        workspace_id: null,
        workflow_ref: workflow_ref || null,
        input_values: JSON.stringify(input_values || {}),
        enabled: 1,
        timeout_seconds: 3600,
        notify_on_failure: notify_strategy?.on_failure ? 1 : 0,
        notify_channel: notify_strategy?.channel || null,
        notify_target: null,
        container_execution_id: null,
        next_trigger_at: null,
        job_type: job_type || "workflow",
        config: "{}",
        parallel_policy: "sequential",
        description: null,
        version: 1,
        consecutive_failures: 0,
        max_retain: 10,
      })

      // Calculate next_run (simple approximation: 1 hour from now)
      const nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString()

      return c.json({
        id,
        name,
        cron,
        timezone: timezone || "Asia/Shanghai",
        next_run: nextRun,
        workflow_ref,
        created_at: now,
      }, 201)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[schedule-register] Failed:", err)
      return c.json({ error: { code: "INTERNAL_ERROR", message: msg } }, 500)
    }
  })

  return router
}
