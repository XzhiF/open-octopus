// packages/server/src/routes/agent/schedule-routes.ts
//
// Agent schedule routes — cron job registration and manual execution
// of scheduled agent jobs.
//
import { Hono } from 'hono'
import crypto from 'crypto'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getSchedulerAdapter } from '../../services/agent/scheduler-adapter'
import type { ScheduleConfigDAO } from '../../db/dao'

export interface ScheduleRouteDeps {
  scheduleConfigDAO: ScheduleConfigDAO
}

export function createScheduleRoutes(deps: ScheduleRouteDeps): Hono {
  const { scheduleConfigDAO } = deps
  const app = new Hono()

  // M3: Cron job registration
  app.post('/schedules/register', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{
        name?: string; cron?: string; prompt?: string; description?: string
        memory_strategy?: { read_recent_days?: number; read_last_report?: boolean; write_report_path?: string }
        notify_strategy?: { on_success?: boolean; on_failure?: boolean; channels?: string[] }
      }>().catch(() => ({}))

      if (!body.name || !body.cron || !body.prompt) {
        return c.json(createAgentError('INVALID_PARAM', 'name, cron, and prompt are required'), 400)
      }

      const adapter = getSchedulerAdapter(org)
      const jobConfig = adapter.designJob(body.description ?? body.prompt)
      jobConfig.name = body.name
      jobConfig.cron = body.cron
      jobConfig.prompt = body.prompt
      if (body.memory_strategy) {
        jobConfig.memory_strategy = {
          read_recent_days: body.memory_strategy.read_recent_days ?? 3,
          read_last_report: body.memory_strategy.read_last_report ?? true,
          write_report_path: body.memory_strategy.write_report_path ?? `${body.name}/{date}.md`,
        }
      }


      const scheduleId = crypto.randomUUID()
      const now = new Date().toISOString()
      try {
        scheduleConfigDAO.insertAgentSchedule(scheduleId, org, body.name, body.cron, 'agent', JSON.stringify(jobConfig), now)
      } catch { /* fallback */ }

      return c.json({ ok: true, schedule_id: scheduleId, job_config: jobConfig, cron: body.cron }, 201)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  // M3: Cron job manual execution
  app.post('/schedules/:id/execute', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')


      let schedule: { name: string; config: string } | undefined
      try {
        schedule = scheduleConfigDAO.findScheduleConfigByIdAndOrg(id, org) ?? undefined
      } catch { /* fallback */ }

      const adapter = getSchedulerAdapter(org)
      let jobConfig
      if (schedule?.config) {
        try { jobConfig = JSON.parse(schedule.config) } catch { jobConfig = adapter.designJob(schedule.name) }
      } else {
        jobConfig = adapter.designJob('manual-execution')
      }

      const result = await adapter.executeJob(jobConfig)
      return c.json({ ok: true, result })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  return app
}
