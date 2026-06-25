import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { parseExpression } from 'cron-parser'
import { getExecutionService } from '../../execution-service-registry'
import { SSEService } from '../../sse'
import { NotificationService } from '../../notification'
import { WorkspaceService } from '../../workspace'
import type { SchedulerJob, WorkflowConfig, WorkflowChainItem } from '@octopus/shared'
import type { Executor, ExecutionResult } from './executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from '../../../db/dao'

const MAX_PARALLEL_WORKSPACES = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_PARALLEL ?? '3',
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
  job_type: string
  config: string
}

/**
 * Executes workflow-type scheduled jobs.
 *
 * Each trigger creates a new workspace from the schedule's workspace_spec,
 * triggers the first workflow in the chain, and monitors completion.
 * The chain (root → child → child) is managed by ExecutionService.
 */
export class WorkflowExecutor implements Executor {
  private notificationService = new NotificationService()
  private workspaceService: WorkspaceService
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO
  private execDAO: ExecutionDAO

  constructor(
    private sse: SSEService,
    configDAO: ScheduleConfigDAO,
    runDAO: ScheduleRunDAO,
    execDAO: ExecutionDAO,
    workspaceService: WorkspaceService,
  ) {
    this.workspaceService = workspaceService
    this.configDAO = configDAO
    this.runDAO = runDAO
    this.execDAO = execDAO
  }

  getType(): string {
    return 'workflow'
  }

  async execute(job: SchedulerJob, executionId: string): Promise<ExecutionResult> {
    const startTime = Date.now()

    // 1. Look up the full schedule row from DB
    const schedule = this.configDAO.findById(job.id)

    if (!schedule) {
      return {
        success: false,
        exitCode: 1,
        errorMessage: `Schedule not found: ${job.id}`,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 2. Same-schedule concurrency check (skip policy)
    if (job.parallel_policy === 'skip') {
      const runningCount = this.runDAO.countRunningByScheduleExcluding(job.id, executionId)

      if (runningCount > 0) {
        this.createSkippedExecution(schedule, '已有执行正在运行')
        return {
          success: true,
          exitCode: 0,
          durationMs: Date.now() - startTime,
          status: 'skipped',
          errorMessage: '已有执行正在运行',
        }
      }
    }

    // 3. Cross-schedule concurrency check
    if (this.runDAO.countDistinctActiveSchedules(executionId) >= MAX_PARALLEL_WORKSPACES) {
      this.createSkippedExecution(schedule, '全局并发上限已达')
      return {
        success: true,
        exitCode: 0,
        durationMs: Date.now() - startTime,
        status: 'skipped',
        errorMessage: '全局并发上限已达',
      }
    }

    // 4. Parse config
    const config = (typeof job.config === 'object' ? job.config : JSON.parse(schedule.config)) as WorkflowConfig

    if (config.type !== 'workflow' || !config.workspace_spec || !config.workflow_chain?.length) {
      const errMsg = 'Invalid workflow config: missing workspace_spec or workflow_chain'
      this.runDAO.updateExecutionStatusSimple(executionId, 'failed', errMsg)

      return {
        success: false,
        exitCode: 1,
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 5. Generate branch suffix (timestamp + random to avoid collisions)
    const branchSuffix = formatBranchSuffix(new Date())

    // 6. Create a new workspace from spec
    let workspace
    try {
      workspace = this.workspaceService.createFromSpec({
        org: config.workspace_spec.org,
        name: `${config.workspace_spec.branch_prefix}-${branchSuffix}`,
        projects: config.workspace_spec.projects,
        branch_prefix: config.workspace_spec.branch_prefix,
        branch_suffix: branchSuffix,
        source: 'scheduler',
        source_schedule_id: schedule.id,
        workflow_chain: config.workflow_chain,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[WorkflowExecutor] workspace creation failed`, { scheduleId: schedule.id, error: message })

      this.runDAO.updateExecutionStatusSimple(executionId, 'failed', `Workspace creation failed: ${message}`)

      return {
        success: false,
        exitCode: 1,
        errorMessage: message,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 7. Record schedule_workspace association
    const schedWsId = randomUUID()
    this.configDAO.insertScheduleWorkspace({
      id: schedWsId,
      schedule_id: schedule.id,
      workspace_id: workspace.id,
      status: 'running',
      branch_suffix: branchSuffix,
      started_at: new Date().toISOString(),
    })

    // 8. Link schedule_execution to workspace
    this.runDAO.updateExecutionWorkspace(executionId, workspace.id)

    // 9. Get ExecutionService for the new workspace
    const registry = getExecutionService(workspace.id)
    if (!registry) {
      const errMsg = 'ExecutionService unavailable for new workspace'
      this.runDAO.updateExecutionStatusSimple(executionId, 'failed', errMsg)

      return {
        success: false,
        exitCode: 1,
        errorMessage: errMsg,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 10. Trigger the first workflow in chain (root execution only)
    const firstStep = config.workflow_chain[0]
    const now = new Date()

    const scheduleVars: Record<string, string> = {
      'schedule.id': schedule.id,
      'schedule.name': schedule.name,
      'schedule.triggered_at': now.toISOString(),
      'schedule.cron_expression': schedule.cron_expression,
      'schedule.timezone': schedule.timezone,
      'execution.trigger_type': 'scheduled',
    }

    let execution
    try {
      execution = registry.service.create(workspace.id, {
        workflow_ref: firstStep.workflow_ref,
        triggered_by: 'scheduler',
        input_values: firstStep.input_values,
        initial_var_pool: scheduleVars,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.runDAO.updateExecutionStatusSimple(executionId, 'failed', `Execution creation failed: ${message}`)

      return {
        success: false,
        exitCode: 1,
        errorMessage: message,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 11. Link schedule_execution to root execution
    this.runDAO.updateExecutionLinkId(executionId, execution.id)

    // 12. Register chain completion callback
    const triggeredAt = now.getTime()
    registry.service.registerExternalCallbacks({
      onComplete: (() => {
        this.handleChainComplete({
          executionId: execution.id,
          schedExecId: executionId,
          schedWsId,
          scheduleId: schedule.id,
          triggeredAt,
          notifyOnFailure: schedule.notify_on_failure === 1,
          schedule,
          maxRetain: config.max_retain,
        })
      }) as any,
    }, execution.id)

    // 13. Set status to 'running'
    this.runDAO.markExecutionRunning(executionId)

    // 14. Start root execution (chain will auto-execute via ExecutionService)
    try {
      // Fire and forget — don't await, let the chain run in background
      registry.service.start(execution.id, firstStep.input_values).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[WorkflowExecutor] root execution start failed`, {
          executionId: execution.id,
          scheduleId: schedule.id,
          error: message,
        })

        this.runDAO.markExecutionFailed(executionId, message, ['triggered', 'running'])

        registry.service.clearExternalCallbacks(execution.id)
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.runDAO.markExecutionFailed(executionId, message, ['triggered', 'running'])

      registry.service.clearExternalCallbacks(execution.id)

      return {
        success: false,
        exitCode: 1,
        errorMessage: message,
        durationMs: Date.now() - startTime,
        status: 'failure',
      }
    }

    // 15. Update next_trigger_at
    this.updateNextTrigger(schedule)

    // Broadcast SSE
    this.sse.emit(`schedule:${schedule.id}`, {
      event: 'schedule_triggered',
      data: {
        schedule_id: schedule.id,
        execution_id: executionId,
        workspace_id: workspace.id,
        trigger_type: 'scheduled',
      },
    })

    return {
      success: true,
      exitCode: 0,
      durationMs: Date.now() - startTime,
      status: 'running',
    }
  }

  // ── Chain completion handler ─────────────────────────────────────

  private handleChainComplete(opts: {
    executionId: string
    schedExecId: string
    schedWsId: string
    scheduleId: string
    triggeredAt: number
    notifyOnFailure: boolean
    schedule: ScheduleRow
    maxRetain: number
  }): void {
    const durationMs = Date.now() - opts.triggeredAt

    // Check the root execution's final status
    const status = this.execDAO.findExecutionStatusSimple(opts.executionId) ?? 'completed'

    // Find the last execution in the chain (deepest child)
    const lastExec = this.execDAO.findLastChildExecution(opts.executionId)
    const lastExecutionId = lastExec?.id ?? opts.executionId

    if (status === 'completed') {
      // Update schedule_execution
      this.runDAO.markExecutionCompleteWithDuration(opts.schedExecId, 'completed', durationMs)

      // Update schedule_workspace
      this.configDAO.updateScheduleWorkspaceStatus(opts.schedWsId, {
        status: 'completed',
        execution_id: lastExecutionId,
        completed_at: new Date().toISOString(),
      })
    } else {
      const errorSummary = this.execDAO.findChainNodeErrors(opts.executionId)?.error ?? 'Execution chain failed'

      // Update schedule_execution
      this.runDAO.markExecutionCompleteWithDuration(opts.schedExecId, 'failed', durationMs, errorSummary)

      // Update schedule_workspace
      this.configDAO.updateScheduleWorkspaceStatus(opts.schedWsId, {
        status: 'failed',
        execution_id: lastExecutionId,
        completed_at: new Date().toISOString(),
        error: errorSummary,
      })

      if (opts.notifyOnFailure) {
        this.notificationService
          .sendFailureNotification(
            opts.schedule,
            { id: opts.schedExecId, status: 'failed' },
            errorSummary,
          )
          .catch((err: unknown) =>
            console.error(
              '[WorkflowExecutor] Notification failed:',
              err instanceof Error ? err.message : String(err),
            ),
          )
      }
    }

    // Clean up callback
    const wsRow = this.configDAO.findScheduleWorkspaceById(opts.schedWsId)
    if (wsRow) {
      const registry = getExecutionService(wsRow.workspace_id)
      if (registry) {
        registry.service.clearExternalCallbacks(opts.executionId)
      }
    }

    // Enforce retention policy
    this.enforceRetention(opts.scheduleId, opts.maxRetain)
  }

  // ── Retention enforcement ────────────────────────────────────────

  private enforceRetention(scheduleId: string, maxRetain: number): void {
    try {
      const completed = this.configDAO.findRetainedWorkspaces(scheduleId, maxRetain)

      for (const row of completed) {
        try {
          this.workspaceService.delete(row.workspace_id)
        } catch (err: unknown) {
          console.error(
            `[WorkflowExecutor] Failed to delete workspace ${row.workspace_id}:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    } catch (err: unknown) {
      console.error(
        '[WorkflowExecutor] Retention enforcement failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private createSkippedExecution(schedule: ScheduleRow, reason: string): void {
    const now = new Date()
    this.runDAO.insertSkippedExecution(randomUUID(), schedule.id, now.toISOString(), schedule.timezone, reason)
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
}

function formatBranchSuffix(date: Date): string {
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  const rand = Math.random().toString(36).substring(2, 6)
  return `${y}${mo}${d}${h}${mi}${s}-${rand}`
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
