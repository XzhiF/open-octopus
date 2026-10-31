import type { SchedulerService } from '../scheduler/scheduler-service'
import type { SchedulerEngine } from '../scheduler/scheduler-engine'
import type { ScheduleRunDAO } from '../../db/dao/schedule-run-dao'

/** Display ref of a job's workflow. enrichJobRow hands `config` over as an
 *  object: v1.0 carries `workflow_ref` at top level, v2/v3 inside
 *  `workflow_chain[0]`; agent/job configs have neither. */
function configWorkflowRef(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const c = config as { workflow_ref?: unknown; workflow_chain?: Array<{ workflow_ref?: unknown }> }
  if (typeof c.workflow_ref === 'string') return c.workflow_ref
  const first = Array.isArray(c.workflow_chain) ? c.workflow_chain[0] : undefined
  return typeof first?.workflow_ref === 'string' ? first.workflow_ref : null
}

export interface SchedulerResponse {
  status: 'ok' | 'degraded' | 'disabled' | 'error'
  active_jobs: number
  paused_jobs: number
  circuit_broken_jobs: number
  total_executions_today: number
  failed_today: number
  next_fires: {
    job_id: string
    job_name: string
    workflow_name: string
    next_fire_at: string
    cron: string
  }[]
}

export class SchedulerResolver {
  constructor(
    private schedulerService: SchedulerService,
    private schedulerEngine: SchedulerEngine | null,
    private scheduleRunDAO: ScheduleRunDAO,
  ) {}

  /**
   * The engine is assembled AFTER the actuator service captures its reference
   * (index.ts binds it on the global later in the boot), so the injected value
   * can be a permanent null snapshot. Read the global lazily as the fallback —
   * otherwise this endpoint reports `disabled` while the cron is actually
   * firing (observed live: job executions every minute, endpoint "disabled").
   */
  private resolveEngine(): SchedulerEngine | null {
    if (this.schedulerEngine) return this.schedulerEngine
    return ((global as { __octopus_scheduler?: SchedulerEngine }).__octopus_scheduler) ?? null
  }

  getScheduler(): SchedulerResponse {
    const engine = this.resolveEngine()
    if (!engine) {
      return {
        status: 'disabled',
        active_jobs: 0,
        paused_jobs: 0,
        circuit_broken_jobs: 0,
        total_executions_today: 0,
        failed_today: 0,
        next_fires: [],
      }
    }

    try {
      const jobs = this.schedulerService.listJobs({ limit: 100 })
      const rows = jobs.items ?? []

      let active = 0
      let paused = 0
      for (const job of rows) {
        if (!job.enabled) paused++
        else active++
      }

      const cbSummary = engine.getCircuitBreakerSummary()
      const circuitBroken = cbSummary.state === 'open' ? 1 : 0

      const todayStats = this.scheduleRunDAO.getTodayStats()

      const nextFires = rows
        .filter(j => j.next_trigger_at && j.enabled)
        .sort((a, b) => (a.next_trigger_at ?? '').localeCompare(b.next_trigger_at ?? ''))
        .slice(0, 10)
        .map(j => ({
          job_id: j.id,
          job_name: j.name,
          workflow_name: configWorkflowRef(j.config) ?? j.name,
          next_fire_at: j.next_trigger_at ?? '',
          cron: j.cron_expression ?? '',
        }))

      return {
        status: circuitBroken > 0 ? 'degraded' : 'ok',
        active_jobs: active,
        paused_jobs: paused,
        circuit_broken_jobs: circuitBroken,
        total_executions_today: todayStats?.total ?? 0,
        failed_today: todayStats?.failed ?? 0,
        next_fires: nextFires,
      }
    } catch (err) {
      return {
        status: 'error',
        active_jobs: 0,
        paused_jobs: 0,
        circuit_broken_jobs: 0,
        total_executions_today: 0,
        failed_today: 0,
        next_fires: [],
      }
    }
  }
}
