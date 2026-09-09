import Database from 'better-sqlite3'
import * as cron from 'node-cron'
import { parseExpression } from 'cron-parser'
import { randomUUID } from 'crypto'
import { WorkspaceScheduleService } from '../schedule'
import { NotificationService } from '../notification'
import { getConfigManager } from '../agent/config-manager'
import { Semaphore } from './semaphore'
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker'
import { ConsecutiveFailureTracker } from './consecutive-failure-tracker'
import type { Executor, ExecutionResult } from './executors/executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'
import { SSEService } from '../sse'
import type { ScheduleStatus } from '@octopus/shared'

const AUXILIARY_TICK_INTERVAL = parseInt(
  process.env.OCTOPUS_SCHEDULER_TICK_MS ?? '60000',
  10,
)
// ADR-0021: cap + agent gate + stale threshold are single-sourced in ./concurrency —
// MAX_PARALLEL_WORKSPACES used to be parsed here AND in workflow-executor AND in
// task-dispatch-service, held together by a comment claiming they stayed in sync.
import { MAX_AGENT_CONCURRENCY, MAX_PARALLEL_WORKSPACES, STALE_CLAIMED_THRESHOLD_MS } from './concurrency'

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
  status: string | null
  claimed_at: string | null
  // v42 (ADR-0021 票03): origin_type / origin_id / origin_role / assoc_meta /
  // scheduled_at are gone from the table, so this projection stops carrying them. The
  // engine no longer needs to know who created a definition — only when to fire it.
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
    // 07: optional so existing 4-arg call sites (incl. other tickets' tests)
    // keep compiling; production (index.ts) always passes the real SSEService.
    // Emits are guarded with this.sse?.emit so absent-sse is a no-op, not a crash.
    private sse?: SSEService,
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

    // Safe mode: skip dispatch and log
    const configManager = getConfigManager()
    const config = configManager.getConfig(schedule.org)
    if (config.safe_mode.enabled) {
      console.log(
        `[SchedulerEngine] Skipping trigger for schedule ${schedule.id}: safe_mode enabled`,
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

    // The definition's own run-state, written by the ONLY two places that know a fire
    // started and stopped (票03 audit). `status` + `claimed_at` are what make abortJob's
    // 「只有 in-flight 可中止」 guard and checkStaleClaimed's 10-minute sweep able to match
    // anything at all: the sweep reads claimed_at, and both were unreachable for cron jobs
    // once the queued-claim loop (their last writer) went away with the task envelopes.
    this.configDAO.updateSchedule(schedule.id, {
      status: 'running',
      claimed_at: new Date().toISOString(),
    })

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
    // Settle the run-state (the counterpart of the write in dispatchExecution). Terminal
    // statuses are what keep checkStaleClaimed from rolling a finished fire back to
    // 'queued' — the invariant the G2 comments in this file have always described.
    this.configDAO.updateSchedule(schedule.id, {
      status: result.success || result.status === 'skipped' ? 'done' : 'failed',
      claimed_at: null,
    })

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

      // G2 retry cap: auto-disable above is the whole story now. The second, terminal
      // 'failed' promotion existed because a task envelope could be re-claimed from the
      // queue regardless of `enabled` (findQueuedSchedules ignored it), so a
      // persistently failing task looped claimed→stale-rollback→queued→redispatch. There
      // is no queue and no envelopes, so enabled=0 stops everything that can happen.
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

    this.checkStaleClaimed().catch((err: unknown) =>
      console.error(
        '[SchedulerEngine] checkStaleClaimed error:',
        err instanceof Error ? err.message : String(err),
      ),
    )

    // 票03 (ADR-0021): the queued-task claim loop and the orphan reaper are gone from the
    // tick. Nothing queues work as a schedule row any more (the only producer of 'queued'
    // task rows was readyTask's envelope), and there is no task-owned definition row left
    // to orphan — the question the reaper asked (「origin_id 还指向活着的任务吗」) has no
    // meaning. Task pickup is the built-in task-lifecycle job, fired by this pump like any
    // other job; that job's own reconcile pass is the equivalent backstop over executions.

  }


  // T-5 AC11: stale claimed (claimed_at older than threshold) → rollback to queued
  // + mark any incomplete schedule_workspaces as cleaned.
  // ponytail: 10min default is a calibration knob — real-world task duration may need tuning.
  // G2 (ticket 05): the findStaleClaimed query filters status IN ('claimed','running'),
  // so terminal 'failed'/'aborted' are NEVER rolled back — this is what breaks the
  // failed→stale→rollback→redispatch infinite loop. See workflow-executor.ts
  // handleChainComplete (failed writer) + onExecutionComplete (retry cap) above.
  private async checkStaleClaimed(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_CLAIMED_THRESHOLD_MS).toISOString()
    const stale = this.configDAO.findStaleClaimed(cutoff) as ScheduleRow[]

    const now = new Date().toISOString()
    for (const schedule of stale) {
      this.configDAO.updateSchedule(schedule.id, {
        status: 'queued',
        claimed_at: null,
      })
      // 07 (G5): emit the stale-claimed→queued rollback so the kanban reflects
      // crash recovery in real time. Terminal failed/aborted never reach here
      // (findStaleClaimed filters status IN claimed/running).
      this.emitScheduleStatus(schedule.id, 'queued')
      // Issue 3: release the partial unique index on schedule_executions
      // (status IN triggered/running). Without this the orphaned execution row
      // blocks the next dispatch's insertTriggeredExecution and the task can
      // never be re-dispatched after a worker crash.
      this.runDAO.markStaleExecutionsFailed(
        schedule.id,
        `Stale claimed rolled back to queued at ${now}`,
      )
      this.configDAO.markScheduleWorkspacesCleanedBySchedule(schedule.id, now)
    }
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
      // G6 (ticket 05): widen the cast to the full ScheduleStatus union. The old
      // `as 'draft' | 'queued' | 'claimed'` lied to TypeScript (runtime values
      // like 'running'/'done'/'failed'/'aborted' still flowed through) — callers
      // comparing job.status to those literals got false "impossible" feedback.
      status: (schedule.status ?? 'queued') as import('@octopus/shared').ScheduleStatus,
      claimed_at: schedule.claimed_at ?? null,
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

  // ── Private: SSE ───────────────────────────────────────────────────

  /**
   * 07 (G5): broadcast a schedule lifecycle transition on the global 'taskpool'
   * SSE channel. Mirrors WorkflowExecutor's emit shape
   * (workflow-executor.ts:257/360/397) so the /tasks kanban receives every
   * queued/claimed/rollback/failed transition in real time instead of polling.
   * No-op when no SSEService was injected (test contexts that don't assert SSE).
   */
  private emitScheduleStatus(scheduleId: string, status: string): void {
    this.sse?.emit('taskpool', {
      event: 'schedule_status',
      data: { schedule_id: scheduleId, status },
    })
    // 票03 (ADR-0021): no tasks.status mirror here. The listener this used to feed
    // existed only to reflect a task's envelope state onto its own row; a job's status is
    // a job's business now, and the board reads task state from the task's own runs.
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
