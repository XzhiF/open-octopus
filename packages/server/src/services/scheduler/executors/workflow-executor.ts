import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseExpression } from 'cron-parser'
import { getExecutionService } from '../../execution-service-registry'
import { SSEService } from '../../sse'
import { NotificationService } from '../../notification'
import { WorkspaceService } from '../../workspace'
import type { SchedulerJob, WorkflowConfig, WorkflowChainItem, ScheduleStatusListener, OriginType } from "@octopus/shared"
import type { Executor, ExecutionResult } from './executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from '../../../db/dao'

const MAX_PARALLEL_WORKSPACES = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_PARALLEL ?? '3',
  10,
)

/**
 * Ticket 04 (composite dispatch): the workflow_ref of the composition-task template
 * (core-pack/workflows/composition-task.yaml, name: composition-task). A composite
 * task's config carries workflow_chain[0].workflow_ref === this AND task_spec.subunits
 * — when dispatched, the coordinator-ws runs this workflow, whose Loop + task_dispatch
 * nodes (03's bridge) fan out N child schedules and a trailing moa aggregates them.
 */
const COMPOSITION_WF_REF = 'composition-task'

interface ScheduleRow {
  id: string
  org: string
  name: string
  cron_expression: string | null
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
  // 03 (SG2): origin cols present on every schedule row (schema v38). Used by
  // the ScheduleStatusListener injection to mirror transitions onto tasks.
  // Null on legacy cron rows; set by the tasks dispatch seam for task-origin.
  origin_type?: string | null
  origin_id?: string | null
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
    // 03 (SG2): optional ScheduleStatusListener. When injected, the 3
    // schedule_status emit sites (running, done/failed-finalStatus, failed)
    // also mirror onto tasks.status + emit task_status SSE. The listener
    // self-filters by origin_type='task'. Optional so existing 5-arg call
    // sites keep compiling.
    private scheduleStatusListener?: ScheduleStatusListener,
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

    // Ticket 04 (composite dispatch): task_spec.subunits present, OR the first chain
    // step's workflow_ref is the composition-task template → coordinator-ws path. The
    // coordinator runs the composition wf (Loop over subunits + task_dispatch fan-out
    // via 03's bridge + moa aggregation); it has NO projects of its own (orchestration
    // only — spec D4). Subunits feed the composition wf's Loop as input_values (G9/G10).
    // Simple tasks (no subunits) take the existing single-workflow_chain path unchanged.
    const isComposite = this.isCompositeTask(config)

    // 5. Generate branch suffix (timestamp + random to avoid collisions)
    const branchSuffix = formatBranchSuffix(new Date())

    // ponytail: requirement-type schedules use a deterministic taskpool-{schedule_id}-{ts}
    // name so failed drafts can be traced back to their schedule; cron jobs keep the
    // AI-supplied branch_prefix from workspace_spec.
    const isRequirement = job.trigger_source === 'requirement'
    const branchPrefix = isRequirement ? `taskpool-${schedule.id}` : config.workspace_spec.branch_prefix
    const workspaceName = isRequirement ? `${branchPrefix}-${branchSuffix}` : `${config.workspace_spec.branch_prefix}-${branchSuffix}`

    // 6. Create a new workspace from spec
    let workspace
    try {
      workspace = this.workspaceService.createFromSpec({
        org: config.workspace_spec.org,
        name: workspaceName,
        // Ticket 04: coordinator-ws has NO projects (orchestration only — spec D4).
        // initWorktreesFromSpec iterates `for (const proj of projects)` so an empty
        // array is a no-op (no worktrees, no throw) — the coordinator only runs the
        // composition wf and never touches git. Simple tasks pass the real projects.
        projects: isComposite ? [] : config.workspace_spec.projects,
        branch_prefix: branchPrefix,
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
      'schedule.cron_expression': schedule.cron_expression ?? '',
      'schedule.timezone': schedule.timezone,
      'execution.trigger_type': 'scheduled',
    }

    let execution
    try {
      execution = registry.service.create(workspace.id, {
        workflow_ref: firstStep.workflow_ref,
        triggered_by: 'scheduler',
        // Ticket 04: composite tasks feed subunits/subunit_count/goal/integration_prompt
        // to the composition wf as input_values (G9/G10). ExecutionService.create accepts
        // Record<string, unknown> (not string-only at runtime), so the subunits array is
        // passed as a real object — the composition Loop consumes $iteration.subunit from
        // it downstream. Simple tasks pass the chain step's string input_values unchanged.
        input_values: isComposite ? this.buildCompositeInputValues(config) : firstStep.input_values,
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
          isRequirement,
        })
      }) as any,
    }, execution.id)

    // 13. Set status to 'running' — schedule_executions row + schedules row.
    // schedules.status='running' feeds the kanban "running" column. Previously this
    // was never written, so a task sat in "claimed" the whole time it executed and
    // the "running" column stayed empty (type also lacked 'running'/'done').
    // Cron schedules keep using enabled/disabled, so only requirement-type advances.
    this.runDAO.markExecutionRunning(executionId)
    if (isRequirement) {
      this.configDAO.updateSchedule(schedule.id, { status: 'running' })
      this.sse.emit('taskpool', {
        event: 'schedule_status',
        data: { schedule_id: schedule.id, status: 'running' },
      })
      // 03 (SG2): mirror onto tasks.status. Ungated by isRequirement for the
      // listener call — the listener self-filters by origin_type='task', so
      // cron schedules are a no-op. Fires for task-origin schedules once 06
      // migrates the isRequirement gate to origin_type (the SSE emit above
      // stays gated until then).
      this.scheduleStatusListener?.onScheduleTransition({
        schedule_id: schedule.id,
        origin_type: (schedule.origin_type ?? "cron") as OriginType,
        origin_id: schedule.origin_id ?? "",
        status: "running",
      })
    }

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
    isRequirement: boolean
  }): void {
    const durationMs = Date.now() - opts.triggeredAt

    // Check the root execution's final status
    const status = this.execDAO.findExecutionStatusSimple(opts.executionId) ?? 'completed'

    // Find the last execution in the chain (deepest child)
    const lastExec = this.execDAO.findLastChildExecution(opts.executionId)
    const lastExecutionId = lastExec?.id ?? opts.executionId

    if (status === 'completed') {
      // ── Chain continuation (#4 story-walker): PR #50 promised "root → child →
      // child managed by ExecutionService" but the child-trigger was missing —
      // only the root step ever ran. config.json.workflow_chain holds the
      // remaining chain (createFromSpec stores slice(1)); the completed
      // execution's child_index selects the next step. Single-step chains
      // (length 1) have an empty remaining chain → nextStep null → finalize.
      const nextStep = this.resolveNextChainStep(opts.schedWsId, opts.executionId)
      if (nextStep) {
        this.triggerChildStep(opts, nextStep)
        return // child's onComplete re-enters handleChainComplete; don't finalize yet
      }

      // Chain fully complete → finalize schedule_execution + schedule + workspace
      this.runDAO.markExecutionCompleteWithDuration(opts.schedExecId, 'completed', durationMs)

      // Issue 2 fix: requirement schedules track lifecycle in the `status` column
      // (draft/queued/claimed/running/done). Cron uses enabled/disabled.
      if (opts.isRequirement) {
        // Ticket 04 (composite parent aggregation): when a composite task's
        // composition wf completes, propagate 'failed' if any child schedule
        // dispatched by its task_dispatch nodes failed. The composition wf itself
        // completes successfully even on partial results (TaskDispatchExecutor
        // resumes with empty output on child failure), so without this check a
        // composite parent would wrongly show 'done' while a subunit failed.
        // Child schedules carry the parent_task_dispatch marker (03) pointing at
        // this composition wf execution; findFailedChildSchedules reads it via
        // json_extract. Simple tasks have no children → stays 'done'.
        let finalStatus: 'done' | 'failed' = 'done'
        if (this.isCompositeSchedule(opts.schedule)) {
          const failedChildren = this.configDAO.findFailedChildSchedules(opts.executionId)
          if (failedChildren.length > 0) {
            finalStatus = 'failed'
          }
        }
        this.configDAO.updateSchedule(opts.scheduleId, {
          status: finalStatus,
          claimed_at: null,
        })
        this.sse.emit('taskpool', {
          event: 'schedule_status',
          data: { schedule_id: opts.scheduleId, status: finalStatus },
        })
        // 03 (SG2): mirror done/failed onto tasks.status. Listener self-filters
        // by origin_type='task'; opts.schedule carries the origin cols (added
        // schema v38 — present on every row, null on legacy cron rows).
        this.scheduleStatusListener?.onScheduleTransition({
          schedule_id: opts.scheduleId,
          origin_type: (opts.schedule.origin_type ?? "cron") as OriginType,
          origin_id: opts.schedule.origin_id ?? "",
          status: finalStatus,
        })
      }

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

      // G2 (ticket 05): mirror the done path's schedule-level writer. Without
      // this, a failed requirement task stays stuck in 'running' → checkStaleClaimed
      // rolls it back to 'queued' → re-dispatch → fail again (infinite loop at
      // scheduler-engine.ts:413). 'failed' is terminal: findStaleClaimed filters
      // status IN ('claimed','running'), so it skips failed/aborted. Cron keeps
      // using enabled/disabled + consecutive_failures, so this is requirement-only.
      if (opts.isRequirement) {
        this.configDAO.updateSchedule(opts.scheduleId, {
          status: 'failed',
          claimed_at: null,
        })
        this.sse.emit('taskpool', {
          event: 'schedule_status',
          data: { schedule_id: opts.scheduleId, status: 'failed' },
        })
        // 03 (SG2): mirror failed onto tasks.status.
        this.scheduleStatusListener?.onScheduleTransition({
          schedule_id: opts.scheduleId,
          origin_type: (opts.schedule.origin_type ?? "cron") as OriginType,
          origin_id: opts.schedule.origin_id ?? "",
          status: "failed",
          error_summary: errorSummary,
        })
      }

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

    // G1: if this schedule was dispatched by a task_dispatch node (composite task),
    // resume the PARENT composition-wf's task_dispatch node with the child's output.
    // Distinct concern from the same-ws chain above — handled by a separate method
    // so the chain logic stays untouched (05's failure writer above is unaffected).
    // This path fires when the child was claimed+run by the scheduler-engine (e.g.
    // a child queued at the concurrency cap, later claimed). The under-cap path
    // runs the child directly via TaskDispatchService, which registers its own
    // onComplete and resumes the parent without going through WorkflowExecutor.
    this.maybeResumeParentTaskDispatch(opts, lastExecutionId)

    // Enforce retention policy
    this.enforceRetention(opts.scheduleId, opts.maxRetain)
  }

  // ── Ticket 04: composite dispatch helpers ────────────────────────────

  /** True if `config` describes a composite task: task_spec.subunits present, OR the
   *  first chain step's workflow_ref is the composition-task template (G9). Drives the
   *  coordinator-ws dispatch path (no projects + composition wf + subunits as
   *  input_values) and the parent-aggregation failed-child check at completion. */
  private isCompositeTask(config: WorkflowConfig): boolean {
    if (config.task_spec?.subunits?.length) return true
    const ref = config.workflow_chain[0]?.workflow_ref
    if (typeof ref === 'string') {
      return ref === COMPOSITION_WF_REF || ref.endsWith(`/${COMPOSITION_WF_REF}`)
    }
    return false
  }

  /** Parse a schedule row's config and test for composite shape. Used in
   *  handleChainComplete where we only have the ScheduleRow, not the parsed
   *  WorkflowConfig. A parse failure is treated as non-composite (defensive — the
   *  dispatch path already validated the config at execute() time). */
  private isCompositeSchedule(schedule: ScheduleRow): boolean {
    try {
      const config = JSON.parse(schedule.config) as WorkflowConfig
      return this.isCompositeTask(config)
    } catch {
      return false
    }
  }

  /** Build the input_values the composition wf receives (G9/G10): the subunits array
   *  (real objects — the composition Loop exposes $iteration.subunit from it),
   *  subunit_count (drives the Loop break_when), goal (moa topic), and
   *  integration_prompt (moa aggregator prompt). These mirror composition-task.yaml's
   *  `variables` block, overridden by the actual task_spec at materialization. */
  private buildCompositeInputValues(config: WorkflowConfig): Record<string, unknown> {
    const subunits = config.task_spec?.subunits ?? []
    return {
      subunits,
      subunit_count: subunits.length,
      goal: config.task_spec?.goal ?? '',
      integration_prompt: config.task_spec?.integration_goal?.prompt ?? '',
    }
  }

  // ── G1 task_dispatch parent-resume ─────────────────────────────────

  /** True if this schedule was dispatched by a task_dispatch node (carries the
   *  parent_task_dispatch marker in its config — written by TaskDispatchService). */
  private hasParentTaskDispatchMarker(schedule: ScheduleRow): boolean {
    try {
      const config = JSON.parse(schedule.config) as { parent_task_dispatch?: unknown }
      return config?.parent_task_dispatch != null
    } catch {
      return false
    }
  }

  /**
   * Resume the parent composition-wf's task_dispatch node when a child schedule
   * dispatched by task_dispatch completes. Reads the child's var_pool snapshot
   * (sub-workflow precedent: output_mapping reads child pool vars) and calls the
   * parent workspace's ExecutionService.resumeTaskDispatch → engine.retryFrom
   * with taskDispatchChildOutput. The parent correlation (execution_id + node_id)
   * is read from the child schedule's persisted config marker (restart-safe).
   */
  private maybeResumeParentTaskDispatch(
    opts: { schedule: ScheduleRow; scheduleId: string },
    lastExecutionId: string,
  ): void {
    if (!this.hasParentTaskDispatchMarker(opts.schedule)) return

    let marker: { execution_id: string; node_id: string } | undefined
    try {
      const config = JSON.parse(opts.schedule.config) as {
        parent_task_dispatch?: { execution_id: string; node_id: string }
      }
      marker = config?.parent_task_dispatch
    } catch {
      // config parse error already handled by hasParentTaskDispatchMarker
    }
    if (!marker) return

    // Read the child's var_pool snapshot (the deepest execution in the chain).
    const childExec = this.execDAO.findById(lastExecutionId)
    const varPoolRaw = childExec?.var_pool ?? "{}"
    let childOutput: Record<string, unknown>
    try {
      childOutput = JSON.parse(varPoolRaw) as Record<string, unknown>
    } catch {
      childOutput = {}
    }

    // Locate the PARENT composition-wf execution + its workspace's ExecutionService.
    // The parent lives in the coordinator workspace (distinct from this child's ws).
    const parentExec = this.execDAO.findById(marker.execution_id)
    if (!parentExec) {
      console.error(
        `[WorkflowExecutor] task_dispatch resume: parent execution ${marker.execution_id} not found`,
      )
      return
    }
    const parentRegistry = getExecutionService(parentExec.workspace_id)
    if (!parentRegistry) {
      console.error(
        `[WorkflowExecutor] task_dispatch resume: ExecutionService unavailable for parent workspace ${parentExec.workspace_id}`,
      )
      return
    }

    // A failed child still resumes the parent with an empty/partial output so the
    // composition-wf's failure strategy can decide (mirror TaskDispatchService).
    parentRegistry.service
      .resumeTaskDispatch(marker.execution_id, marker.node_id, childOutput)
      .catch((err: unknown) => {
        console.error(
          `[WorkflowExecutor] task_dispatch resume failed for parent ${marker!.execution_id}:`,
          err instanceof Error ? err.message : String(err),
        )
      })
  }

  // ── Chain continuation helpers (#4 story-walker) ──────────────────

  /**
   * Resolve the next workflow_chain step (if any) for the completed execution.
   * config.json.workflow_chain holds the remaining chain (slice(1) of the full
   * chain; the root was triggered immediately). remaining[child_index] is the
   * next step: remaining[0] == chain[1], and the root's child_index is 0.
   */
  private resolveNextChainStep(schedWsId: string, executionId: string): WorkflowChainItem | null {
    const wsRow = this.configDAO.findScheduleWorkspaceById(schedWsId)
    if (!wsRow) return null
    const registry = getExecutionService(wsRow.workspace_id)
    if (!registry) return null
    try {
      const config = JSON.parse(readFileSync(join(registry.wsPath, 'config.json'), 'utf-8')) as {
        workflow_chain?: WorkflowChainItem[]
      }
      const remaining = config.workflow_chain ?? []
      const completed = this.execDAO.findById(executionId)
      const childIndex = completed?.child_index ?? 0
      return remaining[childIndex] ?? null
    } catch {
      return null
    }
  }

  /**
   * Trigger the next chain step as a child execution of the completed one.
   * The child's completion re-enters handleChainComplete (recursive) until the
   * chain is exhausted, at which point the schedule finalizes to 'done'.
   */
  private triggerChildStep(
    opts: {
      executionId: string
      schedExecId: string
      schedWsId: string
      scheduleId: string
      triggeredAt: number
      notifyOnFailure: boolean
      schedule: ScheduleRow
      maxRetain: number
      isRequirement: boolean
    },
    nextStep: WorkflowChainItem,
  ): void {
    const wsRow = this.configDAO.findScheduleWorkspaceById(opts.schedWsId)
    if (!wsRow) return
    const registry = getExecutionService(wsRow.workspace_id)
    if (!registry) return

    const completed = this.execDAO.findById(opts.executionId)
    const nextChildIndex = (completed?.child_index ?? 0) + 1

    let child
    try {
      child = registry.service.create(wsRow.workspace_id, {
        workflow_ref: nextStep.workflow_ref,
        parent_id: opts.executionId,
        child_index: nextChildIndex,
        input_values: nextStep.input_values,
        triggered_by: 'scheduler',
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[WorkflowExecutor] child execution creation failed', {
        parentExec: opts.executionId, error: msg,
      })
      // Child creation failed → finalize the chain as failed so it doesn't hang.
      this.runDAO.markExecutionCompleteWithDuration(
        opts.schedExecId, 'failed', Date.now() - opts.triggeredAt,
        `Child creation failed: ${msg}`,
      )
      this.configDAO.updateScheduleWorkspaceStatus(opts.schedWsId, {
        status: 'failed', execution_id: opts.executionId,
        completed_at: new Date().toISOString(), error: msg,
      })
      return
    }

    // Child's completion re-enters handleChainComplete with the child's id.
    registry.service.registerExternalCallbacks({
      onComplete: (() => {
        this.handleChainComplete({ ...opts, executionId: child.id })
      }) as any,
    }, child.id)

    // Fire and forget — explicit error capture (Issue 1 lesson: no silent failures).
    registry.service.start(child.id, nextStep.input_values).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[WorkflowExecutor] child execution start failed', {
        executionId: child.id, error: msg,
      })
      this.runDAO.markExecutionFailed(opts.schedExecId, msg, ['triggered', 'running'])
      registry.service.clearExternalCallbacks(child.id)
    })
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
    // Drafts (trigger_source='requirement') have no cron_expression — skip next-trigger update.
    if (!schedule.cron_expression) return
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
