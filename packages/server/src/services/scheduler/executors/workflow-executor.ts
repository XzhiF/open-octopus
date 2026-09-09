import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import fs, { readFileSync } from 'fs'
import path, { join } from 'path'
import { parseExpression } from 'cron-parser'
import { getExecutionService } from '../../execution-service-registry'
import { SSEService } from '../../sse'
import { NotificationService } from '../../notification'
import { WorkspaceService } from '../../workspace'
import type { SchedulerJob, WorkflowConfig, WorkflowChainItem } from "@octopus/shared"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import type { Executor, ExecutionResult } from './executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from '../../../db/dao'
import { TaskHomeService } from '../../tasks/task-home-service'
import { seedPhaseToWorkspace, collectFromWorkspace, batchRelPath, resolvePhaseSpecDir, emitPhaseAwaitingReview } from '../../tasks/task-artifact-sync'
// Ticket 08 (ADR-0009): the orchestration-strategy seam owns the composition
// workflow ref + the composite threshold as the single source of truth (via
// ws-launch's isCompositeWorkflowConfig). The executor's isCompositeTask below
// is the POST-materialization config-shape detector (a different layer — it
// sees the materialized WorkflowConfig, not the original TaskSpec).
// trigger-prebuild (2026-09-08): 命名块与 composite 判定收敛到 ws-launch —
// triggerTask 预建与 executor 首建共用，同名同支是复用命中的前提。
import { computeTaskWsLaunchParams, isCompositeWorkflowConfig } from '../ws-launch'
// ADR-0013 S2a: the home→ws workflow copy helper now lives in the task domain (票03) —
// one implementation, shared with the task-lifecycle job that replaced this path.
import { copyTaskWorkflowsToWs } from '../../tasks/task-artifact-sync'
// ADR-0021: the cap number and its meter are single-source (this file used to parse
// OCTOPUS_SCHEDULER_MAX_PARALLEL into a local copy of the constant).
import { MAX_PARALLEL_WORKSPACES } from '../concurrency'


/**
 * Ticket 04 (composite dispatch): the workflow_ref of the composition-task template
 * (core-pack/workflows/composition-task.yaml, name: composition-task). A composite
 * task's config carries workflow_chain[0].workflow_ref === this AND task_spec.subunits
 * — when dispatched, the coordinator-ws runs this workflow, whose Loop + task_dispatch
 * nodes (03's bridge) fan out N child schedules and a trailing moa aggregates them.
 *
 * Ticket 08 (ADR-0009): the constant now lives in the orchestration-strategy seam
 * (single source of truth, shared with DefaultOrchestrationStrategy +
 * scheduler-service). Imported above; no local duplicate.
 */

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
 * v3: Each trigger created a new workspace from the schedule's workspace_spec.
 * task-phase-redesign (ticket 05, K12): a v4 task (config.format==='v4') binds
 * its workspace on the FIRST trigger (tasks.workspace_id) and every later
 * phase/round execution REUSES that one workspace — no rebuild, no re-rename,
 * no branch switch. The chain (root → child → child) is managed by
 * ExecutionService.
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

    // 3. Cross-schedule concurrency check — the shared meter (job fires + task launches),
    // excluding this fire, which is itself active.
    if (this.runDAO.countActiveWork({ excludeFireId: executionId }) >= MAX_PARALLEL_WORKSPACES) {
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

    // Ticket 04 (composite dispatch) + Ticket 08 (ADR-0009): the isComposite
    // decision bifurcates execute() into two dispatch paths:
    //
    // 4b. ADR-0021 票03: the composite/coordinator branch lived here because a composite
    // TASK was materialized into a schedule row. Tasks are no longer schedules, so this
    // executor runs only what the job definition says: config.workflow_chain[0] on a
    // freshly built workspace. Composite fan-out is the task domain's business (and 票04
    // moves it onto child executions).
    // 5. Branch suffix + ws naming — verbatim 抽入 ws-launch 共享纯函数
    // (trigger-prebuild 2026-09-08): triggerTask 的「同步预建」与这里的首建
    // 必须产出同名同支（预建→executor 复用命中），两份命名逻辑合一防漂移。
    // 票03 (ADR-0021): the requirement/task branch of this naming is gone — a task is no
    // longer a schedule, so this executor only ever builds a cron job's workspace and the
    // name always comes from the job's own workspace_spec.branch_prefix. The deterministic
    // taskpool-{id}-{ts} form for task launches moved with them to the task-lifecycle job.
    // task-ws-name (2026-08-29): task-origin schedules display `task:{任务标题}`
    // (用户改过的 name，或默认名时从 goal 生成的 chatbot 同款智能标题)；查不到
    // 任务/取不到标题时回退旧 taskpool 命名。branch_prefix 不变（git 分支追溯）。
    const { branchPrefix, branchSuffix, workspaceName } = computeTaskWsLaunchParams({
      instanceKey: schedule.id,
      naming: 'cron',
      config,
      taskRow: null,
    })

    // 6. Create the workspace from the job's own spec. There is no reuse path any more:
    // binding a workspace to something and reusing it across runs was a task concept
    // (v4's one-ws-per-task), and it is the task-lifecycle job's to do now.
    let workspace
    try {
      workspace = this.workspaceService.createFromSpec({
        org: config.workspace_spec.org,
        name: workspaceName,
        projects: config.workspace_spec.projects,
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

    // 7. Record the association (the suffix this run established — there is no reuse
    // path left to look an older one up through).
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

    // task-workflow-handoff (ADR-0013, S2a): copy agent-authored workflow YAMLs
    // from the task home's `workflows/` directory (injected as
    // $vars.task_workflows_dir by materializeTaskSpecToConfig) into the
    // execution workspace's `workflows/` directory. The engine's existing
    // `{ws}/workflows/` resolver then finds them on create(workflow_ref).
    //
    // The copy window is synchronous + inside the dispatch segment (between
    // createFromSpec and execution.create), so race with other writers is
    // effectively zero (ADR-0013 §Consequences). Copy errors are logged + the
    // dispatch continues — if the bound ref was in the task-home set at bind
    // time (guaranteed by the fail-fast resolver), the file is already on disk;
    // a transient copy error is the only failure mode and the execution will
    // surface "Workflow not found" clearly if it matters.
    // 10. Trigger the first workflow in chain (root execution only)
    const firstStep = config.workflow_chain[0]
    try {
      const inputValues = (firstStep.input_values ?? {}) as Record<string, unknown>
      const taskWorkflowsDir = typeof inputValues.task_workflows_dir === 'string'
        ? inputValues.task_workflows_dir
        : null
      if (taskWorkflowsDir) {
        copyTaskWorkflowsToWs(taskWorkflowsDir, registry.wsPath)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // Non-fatal: log and continue. The engine resolver will surface "Workflow
      // not found" if the bound ref was not copied successfully.
      console.error(`[WorkflowExecutor] task_workflows copy failed (non-fatal): ${message}`)
    }

    // 票03: the v4 seed 下行 (mirroring a phase's batch dir into the ws) moved to the
    // task-lifecycle job with the rest of the task launch machinery — a cron job has no
    // phase and no task home to mirror.

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
        // ADR-0021: one root per workspace, the v1 invariant, holds again — the only
        // thing that used to opt out of it was a v4 task reusing one ws per task, and a
        // cron job builds a fresh ws on every fire.
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

    // 11b. removed (票03): phase/round tagging belonged to the v4 envelope path; task
    // rounds are tagged at insert by the task-lifecycle job, which is the only writer of
    // task-bound execution rows.

    // 12. Register chain completion callback
    const triggeredAt = now.getTime()
    registry.service.registerExternalCallbacks({
      onComplete: ((engineFinalStatus?: string) => {
        this.handleChainComplete({
          executionId: execution.id,
          schedExecId: executionId,
          schedWsId,
          scheduleId: schedule.id,
          triggeredAt,
          notifyOnFailure: schedule.notify_on_failure === 1,
          schedule,
          maxRetain: config.max_retain,
          engineFinalStatus,
        })
      }) as any,
    }, execution.id)

    // 13. In-flight marker. There is no schedules.status any more (票03 dropped the
    // run-state columns): a fire in flight is a live schedule_executions row, which is
    // what countActiveWork and the parallel policy already read. The kanban's per-task
    // status is now written by the task-lifecycle job, not mirrored off a schedule.
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
    /** Engine's terminal status, threaded from onComplete (engine.ts:431 fires
     *  inside run(), BEFORE ExecutionLifecycle persists the final status —
     *  a pure DB read here observes a stale 'running' and misfinalizes a
     *  SUCCEEDED chain as failed; goal-task-dev E2E T6). */
    engineFinalStatus?: string
  }): void {
    const durationMs = Date.now() - opts.triggeredAt

    // Check the root execution's final status.
    // Resolution order (goal-task-dev status-mirror fix):
    //   1. DB when it already holds a FINAL status — authoritative after
    //      persistence, includes ExecutionLifecycle's allSkipped→failed
    //      adjustment (covers resume re-entry + late/deferred finalizations);
    //   2. engine's in-flight reported status (the race case: DB still 'running');
    //   3. legacy fallback (previous behavior).
    const FINAL_STATUSES = new Set(['completed', 'completed_with_failures', 'failed', 'cancelled', 'rejected'])
    const dbStatus = this.execDAO.findExecutionStatusSimple(opts.executionId)
    let status = dbStatus && FINAL_STATUSES.has(dbStatus)
      ? dbStatus
      : (opts.engineFinalStatus ?? dbStatus ?? 'completed')
    if (status === 'completed' && !(dbStatus && FINAL_STATUSES.has(dbStatus))) {
      // Mirror ExecutionLifecycle's allSkipped→failed rule while trusting the
      // in-flight engine value (run() hasn't returned, so the adjustment hasn't
      // been persisted): completed with zero real completed nodes but some
      // skipped → the workflow achieved nothing → failed. (0 real nodes at all
      // stays completed — same as the lifecycle rule's length>0 guard.)
      const outcomes = this.execDAO.countRealNodeOutcomes(opts.executionId)
      if (outcomes.completed === 0 && outcomes.skipped > 0) status = 'failed'
    }

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

      // 票03: the requirement branch is gone — flipping a schedule's done/failed status,
      // aggregating composite child failures out of child schedules, and mirroring onto
      // tasks.status all existed because a schedule row stood in for a task run. A job
      // fire's terminal state is the schedule_executions row written just above; whose
      // task (if any) a run served is no longer this file's business.

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

      // 票03: same on the failure path. There is no schedules.status to unstick, so the
      // loop this block existed to break ('running' → stale sweep → 'queued' → re-dispatch
      // → fail again) has no states left to occur in.

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

    // task-phase-redesign (ticket 06, K9): v4 collect 上行 — BEFORE retention
    // (which may reclaim the ws once the task hits 'done'), recover whatever the
    // execution side changed in the batch dir back into the task home and emit
    // task_artifacts_update. Gated on the phase/round TAG (④/K4), so v3,
    // generic and composite chains (never tagged) byte-for-byte skip this.
    // 票03: v4 collect 上行 moved into the task-lifecycle job — it needs the task home,
    // the phase binding and the artifact index, none of which a cron job has.
    // Enforce retention policy
    this.enforceRetention(opts.scheduleId, opts.maxRetain)
  }

  // ── Composite helpers: removed with 票03 (ADR-0021) ─────────────────────
  //
  // isCompositeTask / isCompositeSchedule / buildCompositeInputValues /
  // resolveTaskSpecFromOrigin existed to run a composite TASK out of a schedule row:
  // detecting the coordinator by workflow_ref, reading subunits back out of the tasks
  // table through schedules.origin_id, and synthesizing the composition workflow's
  // inputs. None of that is a scheduler's business — the materialization now lives in
  // services/tasks/task-materialize.ts, next to the job that consumes it.
  //
  // What stays below is the generic half: a `task_dispatch` node inside ANY workflow
  // fans out child work and resumes on its completion. 票04 replaces those child
  // schedule rows with child executions.

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
  //
  // resolvePhaseRound was removed with 票03: a task round carries its phase/round as
  // columns on its own row from the moment the job arms it, so there is nothing left to
  // reconstruct out of a chain stamp.

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
        // task-phase-redesign (ticket 05, K12 / 票03清单#5): a workspace bound
        // to a task that has not reached 'done' is EXEMPT — it is the task's
        // single permanent home (live worktrees + un-collected round evidence),
        // and max_retain eviction of it would be data destruction, not hygiene.
        // Once the task is done (archived) the exemption lifts and normal
        // retention reclaims the disk.
        // 票03 (ADR-0021): a task workspace is no longer reachable from a schedule at all
        // — it is not in schedule_workspaces, it carries workspaces.task_id — so the
        // 「never reclaim a bound task ws」 exemption is structural now, not a check one
        // call site could forget. Data retention keeps its own task-aware guard.
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

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}
