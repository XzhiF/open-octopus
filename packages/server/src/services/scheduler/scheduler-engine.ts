import Database from 'better-sqlite3'
import * as cron from 'node-cron'
import { parseExpression } from 'cron-parser'
import { randomUUID } from 'crypto'
import { WorkspaceScheduleService } from '../schedule'
import { NotificationService } from '../notification'
import { Semaphore } from './semaphore'
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker'
import { ConsecutiveFailureTracker } from './consecutive-failure-tracker'
import type { Executor, ExecutionResult } from './executors/executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

const AUXILIARY_TICK_INTERVAL = parseInt(
  process.env.OCTOPUS_SCHEDULER_TICK_MS ?? '60000',
  10,
)
const MAX_AGENT_CONCURRENCY = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_AGENT_CONCURRENT ?? '10',
  10,
)

interface ScheduleRow {
  id: string
  org: string
  name: string
  cron_expression: string
  timezone: string
  enabled: number
  timeout_seconds: number
  notify_on_failure: number
  notify_channel: string | null
  notify_target: string | null
  container_execution_id: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  next_trigger_at: string | null
  job_type: string
  config: string
  parallel_policy: string
  description: string | null
  version: number
  consecutive_failures: number
  max_retain: number
}

/**
 * SchedulerEngine — extends the V1 SchedulerEngine pattern to support
 * both workflow and agent job types.
 *
 * - Workflow jobs are dispatched via the WorkflowExecutor
 * - Agent jobs are dispatched via the AgentExecutor with Semaphore + CircuitBreaker
 * - ConsecutiveFailureTracker auto-disables flapping jobs
 * - DST-aware: skips triggers that fall in a spring-forward gap
 */
export class SchedulerEngine {
  private cronJobs = new Map<string, cron.ScheduledTask>()
  private running = false
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private notificationService = new NotificationService()
  private failureTracker: ConsecutiveFailureTracker
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO

  // Concurrency control for agent jobs
  private agentSemaphore = new Semaphore(MAX_AGENT_CONCURRENCY)
  private agentCircuitBreaker = new CircuitBreaker({
    volumeThreshold: 5,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 300_000,
  })

  constructor(
    configDAO: ScheduleConfigDAO,
    runDAO: ScheduleRunDAO,
    private scheduleService: WorkspaceScheduleService,
    private executors: Map<string, Executor>,
  ) {
    this.failureTracker = new ConsecutiveFailureTracker(configDAO)
    this.configDAO = configDAO
    this.runDAO = runDAO
  }

  isRunning(): boolean {
    return this.running
  }

  getCircuitBreakerSummary(): { state: 'open' | 'closed' | 'half-open' } {
    return { state: this.agentCircuitBreaker.getState() }
  }

  start(): void {
    if (this.running) return
    this.running = true

    const enabledSchedules = this.configDAO.findEnabledSchedules() as ScheduleRow[]

    for (const schedule of enabledSchedules) {
      this.registerCronJob(schedule)
    }

    this.tickInterval = setInterval(() => {
      this.auxiliaryTick()
    }, AUXILIARY_TICK_INTERVAL)

    this.detectMissed()
  }

  stop(): void {
    this.running = false
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    for (const [, task] of this.cronJobs) {
      task.stop()
    }
    this.cronJobs.clear()
  }

  reload(): void {
    for (const [, task] of this.cronJobs) {
      task.stop()
    }
    this.cronJobs.clear()

    const enabledSchedules = this.configDAO.findEnabledSchedules() as ScheduleRow[]

    for (const schedule of enabledSchedules) {
      this.registerCronJob(schedule)
    }
  }

  async forceAuxiliaryTick(): Promise<void> {
    await this.auxiliaryTick()
  }

  // ── Private: Cron Registration ─────────────────────────────────────

  private registerCronJob(schedule: ScheduleRow): void {
    try {
      const task = cron.schedule(
        schedule.cron_expression,
        () => {
          this.triggerSchedule(schedule.id)
        },
        { timezone: schedule.timezone },
      )
      this.cronJobs.set(schedule.id, task)
    } catch (err: unknown) {
      console.error(
        `[SchedulerEngine] Failed to register cron job for schedule ${schedule.id}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Private: Trigger Dispatch ──────────────────────────────────────

  private triggerSchedule(scheduleId: string): void {
    if (!this.running) return

    const schedule = this.configDAO.findByIdRaw(scheduleId) as ScheduleRow | undefined

    if (!schedule || schedule.enabled === 0) return

    // DST gap detection: if the scheduled fire time doesn't actually exist
    // in the schedule's timezone (spring-forward), skip this trigger
    if (this.isDstGap(schedule.cron_expression, schedule.timezone)) {
      console.log(
        `[SchedulerEngine] Skipping DST gap trigger for schedule ${schedule.id}`,
      )
      return
    }

    // Create schedule_execution record
    const now = new Date()
    const schedExecId = randomUUID()
    const tzOffset = this.getTimezoneOffset(schedule.timezone)

    this.runDAO.insertTriggeredExecution(
      schedExecId, scheduleId, 'scheduled',
      now.toISOString(), tzOffset, schedule.timezone, 'scheduler',
    )

    this.dispatchExecution(schedule, schedExecId)

    // Update next_trigger_at
    this.updateNextTrigger(schedule)
  }

  /**
   * Dispatch a manual trigger. The schedule_execution row has already been
   * INSERTed by SchedulerService.triggerJob (with trigger_type='manual');
   * we only run the executor here.
   */
  triggerManual(scheduleId: string, executionId: string): void {
    const schedule = this.configDAO.findByIdRaw(scheduleId) as ScheduleRow | undefined

    if (!schedule) {
      this.runDAO.markExecutionFailed(executionId, 'Schedule not found')
      return
    }

    this.dispatchExecution(schedule, executionId)
  }

  private dispatchExecution(schedule: ScheduleRow, schedExecId: string): void {
    const jobType = schedule.job_type ?? 'workflow'
    const executor = this.executors.get(jobType)

    if (!executor) {
      console.error(
        `[SchedulerEngine] No executor registered for job_type: ${jobType}`,
      )
      this.runDAO.markExecutionFailed(schedExecId, `No executor for job_type: ${jobType}`)
      return
    }

    const job = this.buildSchedulerJob(schedule)

    if (jobType === 'agent') {
      this.executeAgent(executor, job, schedExecId, schedule)
    } else {
      this.executeWorkflow(executor, job, schedExecId, schedule)
    }
  }

  private executeAgent(
    executor: Executor,
    job: ReturnType<typeof this.buildSchedulerJob>,
    schedExecId: string,
    schedule: ScheduleRow,
  ): void {
    // Use semaphore + circuit breaker for agent jobs.
    // Wrap in async IIFE with try/finally to guarantee exactly one release.
    (async () => {
      await this.agentSemaphore.acquire()
      try {
        const result = await this.agentCircuitBreaker.execute(() =>
          executor.execute(job, schedExecId),
        )
        this.onExecutionComplete(schedule, schedExecId, result)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const isCircuitOpen = err instanceof CircuitBreakerOpenError

        if (isCircuitOpen) {
          this.runDAO.updateExecutionStatusSimple(
            schedExecId, 'failed',
            'Agent circuit breaker open — requests temporarily rejected',
          )
        } else {
          this.runDAO.markExecutionFailed(schedExecId, message, ['triggered', 'running'])
        }

        const trackerResult = this.failureTracker.recordFailure(schedule.id)
        if (trackerResult.autoDisabled) {
          console.warn(
            `[SchedulerEngine] Auto-disabled schedule ${schedule.id} after consecutive failures`,
          )
          // Remove from cron jobs since it's now disabled
          const task = this.cronJobs.get(schedule.id)
          if (task) {
            task.stop()
            this.cronJobs.delete(schedule.id)
          }
        }

        if (schedule.notify_on_failure) {
          this.notificationService
            .sendFailureNotification(
              schedule,
              { id: schedExecId, status: 'failed' },
              message,
            )
            .catch((notifErr: unknown) =>
              console.error(
                '[SchedulerEngine] Notification failed:',
                notifErr instanceof Error ? notifErr.message : String(notifErr),
              ),
            )
        }
      } finally {
        // Guaranteed exactly one release — B4 fix for double-release bug.
        this.agentSemaphore.release()
      }
    })()
  }

  private executeWorkflow(
    executor: Executor,
    job: ReturnType<typeof this.buildSchedulerJob>,
    schedExecId: string,
    schedule: ScheduleRow,
  ): void {
    executor
      .execute(job, schedExecId)
      .then((result: ExecutionResult) => {
        this.onExecutionComplete(schedule, schedExecId, result)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.runDAO.markExecutionFailed(schedExecId, message, ['triggered', 'running'])

        const trackerResult = this.failureTracker.recordFailure(schedule.id)
        if (trackerResult.autoDisabled) {
          console.warn(
            `[SchedulerEngine] Auto-disabled schedule ${schedule.id} after consecutive failures`,
          )
          const task = this.cronJobs.get(schedule.id)
          if (task) {
            task.stop()
            this.cronJobs.delete(schedule.id)
          }
        }
      })
  }

  private onExecutionComplete(
    schedule: ScheduleRow,
    schedExecId: string,
    result: ExecutionResult,
  ): void {
    if (result.success || result.status === 'skipped') {
      this.failureTracker.recordSuccess(schedule.id)
    } else {
      const trackerResult = this.failureTracker.recordFailure(schedule.id)
      if (trackerResult.autoDisabled) {
        console.warn(
          `[SchedulerEngine] Auto-disabled schedule ${schedule.id} after consecutive failures`,
        )
        const task = this.cronJobs.get(schedule.id)
        if (task) {
          task.stop()
          this.cronJobs.delete(schedule.id)
        }
      }

      if (schedule.notify_on_failure) {
        const errorSummary = result.errorMessage ?? 'Execution failed'
        this.notificationService
          .sendFailureNotification(
            schedule,
            { id: schedExecId, status: 'failed' },
            errorSummary,
          )
          .catch((err: unknown) =>
            console.error(
              '[SchedulerEngine] Notification failed:',
              err instanceof Error ? err.message : String(err),
            ),
          )
      }
    }
  }

  // ── Private: Auxiliary Tick ────────────────────────────────────────

  private auxiliaryTick(): void {
    if (!this.running) return
    this.configDAO.updateSchedulerHeartbeat()

    this.checkTimeouts().catch((err: unknown) =>
      console.error(
        '[SchedulerEngine] checkTimeouts error:',
        err instanceof Error ? err.message : String(err),
      ),
    )
  }

  private async checkTimeouts(): Promise<void> {
    const runningExecs = this.configDAO.findRunningExecutionsWithScheduleInfo()

    const now = Date.now()

    for (const exec of runningExecs) {
      const triggeredAt = new Date(exec.triggered_at).getTime()
      const timeoutMs = (exec.timeout_seconds ?? 3600) * 1000

      if (now - triggeredAt > timeoutMs) {
        const summary = `执行超时（${exec.timeout_seconds ?? 3600}s）`

        this.runDAO.markExecutionTimedOut(exec.id, summary, exec.job_type)

        if (exec.job_type !== 'agent' && exec.execution_id) {
          try {
            const { getExecutionService } = await import('../execution-service-registry')
            const registry = getExecutionService(exec.workspace_id ?? undefined)
            if (registry) {
              await registry.service.cancel(exec.execution_id)
              console.log(
                `[SchedulerEngine] cancelled timed-out execution ${exec.execution_id}`,
              )
            }
          } catch (cancelErr: unknown) {
            console.error(
              '[SchedulerEngine] Failed to cancel timed-out execution:',
              cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
            )
          }
        }

        if (exec.notify_on_failure) {
          this.notificationService
            .sendFailureNotification(
              {
                id: exec.schedule_id,
                name: exec.schedule_name,
                notify_channel: exec.notify_channel,
                notify_target: exec.notify_target,
              },
              { id: exec.id, status: 'failed' },
              summary,
            )
            .catch((err: unknown) =>
              console.error(
                '[SchedulerEngine] Notification failed:',
                err instanceof Error ? err.message : String(err),
              ),
            )
        }

        this.failureTracker.recordFailure(exec.schedule_id)
      }
    }
  }

  // ── Private: Missed Detection ──────────────────────────────────────

  private detectMissed(): void {
    const enabledSchedules = this.configDAO.findEnabledSchedulesForMissed() as ScheduleRow[]

    let totalMissed = 0
    const MAX_MISSED = 100
    const startTime = Date.now()
    const TIMEOUT_MS = 30_000

    for (const schedule of enabledSchedules) {
      if (totalMissed >= MAX_MISSED || Date.now() - startTime > TIMEOUT_MS) break

      const lastExec = this.configDAO.findLastNonMissedExecution(schedule.id)

      const fromDate = lastExec
        ? new Date(lastExec.triggered_at)
        : new Date(Date.now() - 24 * 60 * 60 * 1000)

      try {
        const interval = parseExpression(schedule.cron_expression, {
          tz: schedule.timezone,
          currentDate: fromDate,
          endDate: new Date(),
        })

        const expectedTimes: Date[] = []
        while (true) {
          try {
            const next = interval.next()
            if (next.getTime() >= Date.now()) break
            expectedTimes.push(next.toDate())
          } catch {
            break
          }
        }

        for (const expectedTime of expectedTimes) {
          if (totalMissed >= MAX_MISSED) break

          const exists = this.configDAO.findExecutionNearTime(schedule.id, expectedTime.toISOString())

          if (!exists) {
            this.runDAO.insertMissedExecution(
              randomUUID(), schedule.id,
              expectedTime.toISOString(), schedule.timezone,
            )
            totalMissed++
          }
        }
      } catch {
        // Skip schedules with invalid cron
      }
    }

    if (totalMissed > 0) {
      this.configDAO.setMissedAlertPending()
    }
  }

  // ── Private: DST Gap Detection ─────────────────────────────────────

  private isDstGap(cronExpression: string, timezone: string): boolean {
    try {
      const now = new Date()
      const interval = parseExpression(cronExpression, {
        tz: timezone,
        currentDate: new Date(now.getTime() - 30_000), // 30s ago
      })

      const nextFire = interval.next().toDate()
      const diffMs = Math.abs(nextFire.getTime() - now.getTime())

      return diffMs > 30_000 && diffMs < 3_600_000 // between 30s and 1 hour
    } catch {
      return false
    }
  }

  // ── Private: Utilities ─────────────────────────────────────────────

  private buildSchedulerJob(schedule: ScheduleRow): import('@octopus/shared').SchedulerJob {
    let config: import('@octopus/shared').JobConfig
    try {
      config = JSON.parse(schedule.config) as import('@octopus/shared').JobConfig
    } catch {
      config = {
        schema_version: '2.0',
        type: 'workflow',
        workspace_spec: { org: schedule.org, projects: [] },
        workflow_chain: [],
        max_retain: schedule.max_retain,
      } as import('@octopus/shared').JobConfig
    }

    return {
      id: schedule.id,
      name: schedule.name,
      job_type: schedule.job_type as 'workflow' | 'agent',
      cron_expression: schedule.cron_expression,
      timezone: schedule.timezone,
      enabled: schedule.enabled === 1,
      org: schedule.org || undefined,
      config,
      parallel_policy: schedule.parallel_policy as 'allow' | 'wait' | 'skip',
      timeout_seconds: schedule.timeout_seconds,
      notify_on_failure: schedule.notify_on_failure === 1,
      description: schedule.description ?? undefined,
      max_retain: schedule.max_retain,
      version: schedule.version,
      consecutive_failures: schedule.consecutive_failures,
      next_trigger_at: schedule.next_trigger_at,
      deleted_at: schedule.deleted_at,
      created_at: schedule.created_at,
      updated_at: schedule.updated_at,
    }
  }

  private updateNextTrigger(schedule: ScheduleRow): void {
    try {
      const interval = parseExpression(schedule.cron_expression, {
        tz: schedule.timezone,
        currentDate: new Date(),
      })
      const next = interval.next()
      this.configDAO.updateNextTriggerAt(schedule.id, next.toISOString())
    } catch {
      // Ignore invalid cron
    }
  }

  private getTimezoneOffset(tz: string): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      })
      const parts = formatter.formatToParts(new Date())
      const tzPart = parts.find((p) => p.type === 'timeZoneName')
      return tzPart?.value ?? '+00:00'
    } catch {
      return '+00:00'
    }
  }
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
