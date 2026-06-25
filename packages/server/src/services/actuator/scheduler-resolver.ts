import type { SchedulerService } from '../scheduler/scheduler-service'
import type { SchedulerEngine } from '../scheduler/scheduler-engine'
import type { ScheduleRunDAO } from '../../db/dao/schedule-run-dao'

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

  getScheduler(): SchedulerResponse {
    if (!this.schedulerEngine) {
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
      const rows = jobs.rows ?? []

      let active = 0
      let paused = 0
      for (const job of rows) {
        if (job.enabled === 0) paused++
        else active++
      }

      const cbSummary = this.schedulerEngine.getCircuitBreakerSummary()
      const circuitBroken = cbSummary.state === 'open' ? 1 : 0

      const todayStats = this.scheduleRunDAO.getTodayStats()

      const nextFires = rows
        .filter(j => j.next_trigger_at && j.enabled !== 0)
        .sort((a, b) => (a.next_trigger_at ?? '').localeCompare(b.next_trigger_at ?? ''))
        .slice(0, 10)
        .map(j => ({
          job_id: j.id,
          job_name: j.name,
          workflow_name: j.config ? (JSON.parse(j.config).workflow_ref ?? j.name) : j.name,
          next_fire_at: j.next_trigger_at ?? '',
          cron: j.cron_expression,
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
