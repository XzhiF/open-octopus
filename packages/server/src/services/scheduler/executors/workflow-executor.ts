import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import fs, { readFileSync } from 'fs'
import path, { join } from 'path'
import { parseExpression } from 'cron-parser'
import { getExecutionService } from '../../execution-service-registry'
import { SSEService } from '../../sse'
import { NotificationService } from '../../notification'
import { WorkspaceService } from '../../workspace'
import type { SchedulerJob, WorkflowConfig, WorkflowChainItem, ScheduleStatusListener, OriginType, TaskSpec } from "@octopus/shared"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"
import type { Executor, ExecutionResult } from './executor-interface'
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, TaskDAO } from '../../../db/dao'
import { TaskHomeService } from '../../tasks/task-home-service'
import { seedPhaseToWorkspace, collectFromWorkspace, batchRelPath, resolvePhaseSpecDir, emitPhaseAwaitingReview } from '../../tasks/task-artifact-sync'
// Ticket 08 (ADR-0009): the orchestration-strategy seam owns the composition
// workflow ref + the composite threshold as the single source of truth. The
// executor's isCompositeTask below is the POST-materialization config-shape
// detector (a different layer — it sees the materialized WorkflowConfig, not
// the original TaskSpec); it shares the seam's constant so the two never drift.
import { COMPOSITION_WF_REF } from '../orchestration-strategy'
import { taskWorkspaceName } from '../task-ws-name'

const MAX_PARALLEL_WORKSPACES = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_PARALLEL ?? '3',
  10,
)

/** task-workflow-handoff (ADR-0013, S2a): copy YAML files from the task home's
 *  `workflows/` directory into the execution workspace's `workflows/` dir. The
 *  engine's existing `{ws}/workflows/` resolver finds them on create. Empty
 *  source dir is a no-op (no YAML to copy → nothing copied). Missing source
 *  dir is also a no-op (legacy tasks may lack the dir). */
export function copyTaskWorkflowsToWs(taskWorkflowsDir: string, wsPath: string): void {
  if (!fs.existsSync(taskWorkflowsDir)) return
  const wsWorkflowsDir = path.join(wsPath, "workflows")
  // Ensure ws workflows/ exists (createFromSpec already creates it, but this
  // is defensive — a test or a non-standard scaffold may skip it).
  fs.mkdirSync(wsWorkflowsDir, { recursive: true })
  const entries = fs.readdirSync(taskWorkflowsDir)
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue
    const src = path.join(taskWorkflowsDir, entry)
    // Defensive: skip non-files (subdirs, symlinks to dirs) — we only copy YAML files.
    try {
      const stat = fs.statSync(src)
      if (!stat.isFile()) continue
    } catch {
      continue
    }
    const dst = path.join(wsWorkflowsDir, entry)
    fs.copyFileSync(src, dst)
  }
}

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
  private taskDAO: TaskDAO | null

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
    // task-ws-name (2026-08-29): optional TaskDAO — when present, task-origin
    // schedules create their workspace as `task:{任务标题}` instead of the raw
    // taskpool-{scheduleId} name. Optional (trailing) so existing call sites
    // keep compiling; without it the old naming stands.
    taskDAO?: TaskDAO,
  ) {
    this.workspaceService = workspaceService
    this.configDAO = configDAO
    this.runDAO = runDAO
    this.execDAO = execDAO
    this.taskDAO = taskDAO ?? null
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

    // Ticket 04 (composite dispatch) + Ticket 08 (ADR-0009): the isComposite
    // decision bifurcates execute() into two dispatch paths:
    //
    //   simple (isComposite=false, subunits.length<2) → SIMPLE-DIRECT-DISPATCH:
    //     1 real workspace (projects=config.workspace_spec.projects) runs the
    //     task's own workflow_ref directly. NO coordinator-ws. This is the
    //     ADR-0009 N+1→1 win — simple tasks no longer pay for an orchestration-
    //     only workspace they don't need.
    //
    //   composite (isComposite=true, subunits.length>=2) → COORDINATOR-DISPATCH:
    //     1 coordinator-ws (projects=[], orchestration only — spec D4) runs
    //     composition-task.yaml, whose Loop× task_dispatch nodes fan out N
    //     child schedules + workspaces (TaskDispatchService, ADR-0008). The
    //     parent-aggregation check at completion propagates 'failed' if any
    //     child failed.
    //
    // The PRE-materialization decision (DefaultOrchestrationStrategy.planDispatch
    // in orchestration-strategy.ts) is the single source of truth for the
    // threshold + composition ref. This POST-materialization detector
    // (isCompositeTask) reconstructs the decision from the config shape —
    // necessary because the executor sees the materialized WorkflowConfig, not
    // the original TaskSpec. The two share COMPOSITION_WF_REF so they never drift.
    const isComposite = this.isCompositeTask(config)

    // 5. Generate branch suffix (timestamp + random to avoid collisions)
    const branchSuffix = formatBranchSuffix(new Date())

    // ponytail: requirement-type schedules use a deterministic taskpool-{schedule_id}-{ts}
    // name so failed drafts can be traced back to their schedule; cron jobs keep the
    // AI-supplied branch_prefix from workspace_spec.
    // task-ws-name (2026-08-29): task-origin schedules display `task:{任务标题}`
    // (用户改过的 name，或默认名时从 goal 生成的 chatbot 同款智能标题)；查不到
    // 任务/取不到标题时回退旧 taskpool 命名。branch_prefix 不变（git 分支追溯）。
    const isRequirement = job.trigger_source === 'requirement'
    const branchPrefix = isRequirement ? `taskpool-${schedule.id}` : config.workspace_spec.branch_prefix
    const taskRow = schedule.origin_type === 'task' && schedule.origin_id && this.taskDAO
      ? this.taskDAO.getById(schedule.origin_id)
      : null
    const taskWsName = taskRow ? taskWorkspaceName({ name: taskRow.name, task_spec: taskRow.task_spec }) : null
    const workspaceName = taskWsName
      ?? (isRequirement ? `${branchPrefix}-${branchSuffix}` : `${config.workspace_spec.branch_prefix}-${branchSuffix}`)

    // 6. Create a new workspace from spec — or REUSE the task's bound one.
    //
    // task-phase-redesign (ticket 05, K4/K5/K12, 票03清单#1): the v4 envelope
    // (config.format === 'v4', written by ticket 04's materialize) runs ALL
    // phases/rounds in the ONE workspace bound at tasks.workspace_id (schema
    // v40). Binding exists + ws row alive → skip createFromSpec entirely (the
    // worktrees, the taskpool-{scheduleId} branch and the round evidence on
    // disk survive — ④ "phase/round 不换支" falls out for free). No binding
    // (or the ws was deleted out of band) → first build, then write the binding
    // back as a version-free system UPDATE (abortTask precedent — a dispatch
    // event must not 409 the spec-field tool's optimistic concurrency).
    // v3 / generic / composite envelopes never set workspace_id ⇒ every branch
    // below is inert for them (byte-identical pre-v4 behavior, regression floor).
    const v4Envelope = config as WorkflowConfig & {
      format?: string
      phases?: Array<{ index: number; workflowRef: string; specDir?: string }>
    }
    const isV4 = v4Envelope.format === 'v4' && !isComposite
    const boundWorkspaceId = isV4 && taskRow ? (taskRow.workspace_id ?? null) : null
    const reusedWorkspace = boundWorkspaceId
      ? this.workspaceService.getById(boundWorkspaceId)
      : undefined

    let workspace
    if (reusedWorkspace) {
      workspace = reusedWorkspace
    } else {
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
      // First-build write-back (v4 only). Re-binding over a stale/dangling
      // workspace_id is intended: the old ws row is gone (getById missed it),
      // the task must point at the live one.
      if (isV4 && taskRow && taskRow.workspace_id !== workspace.id && this.taskDAO) {
        try {
          this.taskDAO
            .getDb()
            .prepare("UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
            .run(workspace.id, new Date().toISOString(), taskRow.id)
        } catch (err: unknown) {
          // Non-fatal: the run proceeds unbound (next dispatch first-builds
          // again). Logged loudly — a silent binding failure would re-introduce
          // the multi-ws-per-task drift this ticket exists to kill.
          console.error(
            `[WorkflowExecutor] task workspace binding write-back failed for task ${taskRow.id} (non-fatal):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }

    // 7. Record schedule_workspace association
    // (reuse path records the ws's ESTABLISHED branch suffix — the last one
    // written for this envelope, per-task constant by K5 — not the freshly
    // generated one, which no git operation ever used).
    let assocBranchSuffix = branchSuffix
    if (reusedWorkspace) {
      const last = this.configDAO
        .getDb()
        .prepare(
          "SELECT branch_suffix FROM schedule_workspaces WHERE schedule_id = ? AND branch_suffix IS NOT NULL AND branch_suffix != '' ORDER BY started_at DESC LIMIT 1",
        )
        .get(schedule.id) as { branch_suffix: string } | undefined
      if (last?.branch_suffix) assocBranchSuffix = last.branch_suffix
    }
    const schedWsId = randomUUID()
    this.configDAO.insertScheduleWorkspace({
      id: schedWsId,
      schedule_id: schedule.id,
      workspace_id: workspace.id,
      status: 'running',
      branch_suffix: assocBranchSuffix,
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

    // task-phase-redesign (ticket 06, K9/K16): v4 seed 下行 — copy the phase's
    // batch dir {home}/.scratch/<date>/<slug>/ into the execution workspace at
    // the SAME relative position before the root execution starts (the
    // copyTaskWorkflowsToWs precedent — same-ws reuse re-seeds every round, so
    // home edits made between rounds take effect on the next seed, K16).
    // home OVERWRITES ws same-names (spec 权威在 home). Non-fatal: a transient
    // fs error must not burn the dispatch slot — the wf surfaces missing inputs
    // itself. resolvePhaseRound is computed HERE (not at step 11b) so the seed
    // knows which batch dir to mirror; the same values are reused for tagging.
    const v4PhaseRound = isV4
      ? this.resolvePhaseRound(v4Envelope, firstStep, workspace.id)
      : null
    if (v4PhaseRound?.phase?.specDir && taskRow) {
      try {
        const homeDir = new TaskHomeService().homePath(taskRow.id)
        const rel = batchRelPath(homeDir, v4PhaseRound.phase.specDir)
        if (rel) {
          const seeded = seedPhaseToWorkspace(v4PhaseRound.phase.specDir, registry.wsPath, rel)
          if (seeded > 0) {
            console.log(
              `[WorkflowExecutor] seeded ${seeded} artifact file(s) into ws ${registry.wsPath}/${rel} (phase ${v4PhaseRound.phaseIndex} round ${v4PhaseRound.roundIndex})`,
            )
          }
        }
      } catch (err: unknown) {
        console.error(
          `[WorkflowExecutor] v4 artifact seed failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

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
        // task-phase-redesign (K4/K5): v4 crash-recovery re-claim runs on the
        // BOUND ws which already holds the first round's root execution; a v4
        // round is an independent root, so the v1 "one root per ws" invariant
        // must be opted out. v3/composite (isV4 false) is byte-identical.
        allow_existing_root: isV4,
        // Ticket 04: composite tasks feed subunits/subunit_count/goal/integration_prompt
        // to the composition wf as input_values (G9/G10). ExecutionService.create accepts
        // Record<string, unknown> (not string-only at runtime), so the subunits array is
        // passed as a real object — the composition Loop consumes $iteration.subunit from
        // it downstream. Simple tasks pass the chain step's string input_values unchanged.
        input_values: isComposite ? this.buildCompositeInputValues(config, schedule.id) : firstStep.input_values,
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

    // 11b. task-phase-redesign (ticket 05, K4): Round = this executions row +
    // phase_index/round_index columns. deriveTaskView (票 03) and the acceptance
    // ledger (票 07) consume the tagged rows verbatim. First execution of a fresh
    // v4 envelope is (1,1) by construction; a re-claimed envelope whose chain[0]
    // was rewritten by dispatchPhaseRound carries the authoritative
    // `_phase_index`/`_round_index` management keys (same precedent as
    // task_artifacts_dir — underscore-prefixed internal keys survive into the
    // var pool harmlessly and make crash recovery re-tag identically).
    if (isV4) {
      try {
        const { phaseIndex, roundIndex } = v4PhaseRound!
        this.execDAO.updateExecution(execution.id, {
          phase_index: phaseIndex,
          round_index: roundIndex,
        })
      } catch (err: unknown) {
        console.error(
          `[WorkflowExecutor] phase/round tagging failed for execution ${execution.id} (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

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
          isRequirement,
          engineFinalStatus,
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

    // task-phase-redesign (ticket 06, K9): v4 collect 上行 — BEFORE retention
    // (which may reclaim the ws once the task hits 'done'), recover whatever the
    // execution side changed in the batch dir back into the task home and emit
    // task_artifacts_update. Gated on the phase/round TAG (④/K4), so v3,
    // generic and composite chains (never tagged) byte-for-byte skip this.
    this.maybeCollectV4Artifacts(opts.schedule, opts.executionId)

    // Enforce retention policy
    this.enforceRetention(opts.scheduleId, opts.maxRetain)
  }

  /**
   * ticket 06 collect 上行 (execute-path terminal — the dispatchPhaseRound path
   * has its own mirror in TasksService.finalizePhaseRoundExecution). Reads the
   * phase/round tag off the terminal executions row (non-tagged ⇒ v3/generic/
   * composite ⇒ no-op, the 底线), locates the phase's home batch dir via the
   * envelope's materialized specDir (票04), mirrors it back from
   * `{ws}/{relBatchPath}` and emits TASK_ARTIFACTS_UPDATE_EVENT(taskId) when
   * anything actually flowed (the OutputViewer re-GETs home artifacts).
   * Non-fatal by contract: an fs/registry hiccup must never break finalization
   * — the next round's terminal transition retries (mtime rule is idempotent).
   */
  private maybeCollectV4Artifacts(schedule: ScheduleRow, executionId: string): void {
    try {
      if (schedule.origin_type !== 'task' || !schedule.origin_id) return
      const exec = this.execDAO.findById(executionId)
      if (!exec || exec.phase_index == null) return
      // P3 (review): terminal = the round awaits its human decision — emit
      // regardless of whether collect moves any file (K3: the board's 待验收
      // column is driven by human-decision state, not file flow).
      emitPhaseAwaitingReview(
        (c, p) => this.sse.emit(c, p),
        schedule.origin_id,
        exec.phase_index,
        exec.round_index ?? 1,
      )
      const specDir = resolvePhaseSpecDir(schedule.config, exec.phase_index)
      if (!specDir) return
      const homeDir = new TaskHomeService().homePath(schedule.origin_id)
      const rel = batchRelPath(homeDir, specDir)
      if (!rel) return
      const registry = getExecutionService(exec.workspace_id)
      if (!registry) return
      const collected = collectFromWorkspace(path.join(registry.wsPath, rel), specDir)
      if (collected.length === 0) return
      console.log(
        `[WorkflowExecutor] collected ${collected.length} artifact file(s) from ws back to home (task ${schedule.origin_id}, phase ${exec.phase_index} round ${exec.round_index})`,
      )
      this.sse.emit('taskpool', {
        event: TASK_ARTIFACTS_UPDATE_EVENT,
        data: { task_id: schedule.origin_id },
      })
    } catch (err: unknown) {
      console.error(
        `[WorkflowExecutor] v4 artifact collect failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Ticket 04: composite dispatch helpers ────────────────────────────

  /** True if `config` describes a composite task: task_spec.subunits present
   *  with length >= 2, OR the first chain step's workflow_ref is the
   *  composition-task template (G9). Drives the coordinator-ws dispatch path
   *  (no projects + composition wf + subunits as input_values) and the parent-
   *  aggregation failed-child check at completion.
   *
   *  SG9 (ticket 06): the threshold is now subunits.length >= 2 (was
   *  `!!subunits?.length` / N>=1). A 1-subunit task is NOT composite — it takes
   *  the simple workflow_chain path (skips coordinator-ws, ADR-0009 N+1→1
   *  optimization). The composition-task template detection (workflow_ref ===
   *  COMPOSITION_WF_REF) still treats an explicitly-composition config as
   *  composite regardless of subunit count (defensive — a config that literally
   *  asks for the composition wf is composite by construction).
   *
   *  Ticket 08 (ADR-0009): this is the POST-materialization detector (sees
   *  the materialized WorkflowConfig). The PRE-materialization decision lives
   *  in {@link DefaultOrchestrationStrategy.planDispatch} (orchestration-strategy.ts),
   *  which is the single source of truth for the threshold + composition ref.
   *  This detector shares {@link COMPOSITION_WF_REF} with the seam so the two
   *  layers never drift. A future variant (subunit-level retry / conditional
   *  DAG) swaps the strategy at the dispatch seam WITHOUT touching this executor. */
  private isCompositeTask(config: WorkflowConfig): boolean {
    if ((config.task_spec?.subunits?.length ?? 0) >= 2) return true
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
   *  `variables` block, overridden by the actual task_spec at materialization.
   *
   *  Ticket 08 (AC2): PRESERVES task_artifacts_dir from
   *  config.workflow_chain[0].input_values (injected by materializeTaskSpecToConfig).
   *  Without this, the key would be DROPPED — buildCompositeInputValues completely
   *  replaces firstStep.input_values at execute() time (the "chain input_values
   *  replacement drops injected keys" hazard SW-BP7 warns about). When absent
   *  (legacy configs without the key), it's omitted — backward compat (AC4).
   *
   *  SG5 (ticket 06): materializeTaskSpecToConfig now DROPS task_spec from the
   *  config (it lives in the tasks table, v2-D1). So config.task_spec is absent on
   *  the new dispatch-seam path. Fall back to reading task_spec from the tasks
   *  table via S2 origin lookup (origin_type='task', origin_id=task.id). The
   *  legacy/test path that seeds config WITH task_spec still works (first branch). */
  private buildCompositeInputValues(config: WorkflowConfig, scheduleId?: string): Record<string, unknown> {
    // Ticket 08 (AC2): read task_artifacts_dir from the config's workflow_chain[0]
    // (injected by materializeTaskSpecToConfig). Preserved in both branches below.
    const chainInputValues = config.workflow_chain[0]?.input_values as Record<string, unknown> | undefined
    const taskArtifactsDir = chainInputValues?.task_artifacts_dir
    const artifactsEntry = taskArtifactsDir ? { task_artifacts_dir: taskArtifactsDir } : {}

    // Legacy/test path: config carries task_spec (composite-dispatch.test.ts seeds this).
    if (config.task_spec) {
      const subunits = config.task_spec.subunits ?? []
      return {
        subunits,
        subunit_count: subunits.length,
        goal: config.task_spec.goal ?? '',
        integration_prompt: config.task_spec.integration_goal?.prompt ?? '',
        ...artifactsEntry,
      }
    }
    // SG5 new path: task_spec dropped from config — read from the tasks table via
    // origin lookup. The schedule's origin_id IS the parent task id (S2).
    const taskSpec = this.resolveTaskSpecFromOrigin(scheduleId)
    const subunits = taskSpec?.subunits ?? []
    return {
      subunits,
      subunit_count: subunits.length,
      goal: taskSpec?.goal ?? '',
      integration_prompt: taskSpec?.integration_goal?.prompt ?? '',
      ...artifactsEntry,
    }
  }

  /** SG5: resolve the parent task's task_spec from the tasks table via S2 origin
   *  lookup. The schedule's origin_id points at the parent task id. Returns null
   *  if the lookup fails (defensive — buildCompositeInputValues falls back to
   *  empty subunits, which the composition wf handles as a no-op Loop). */
  private resolveTaskSpecFromOrigin(scheduleId?: string): TaskSpec | null {
    if (!scheduleId) return null
    try {
      const row = this.configDAO
        .getDb()
        .prepare(
          `SELECT t.task_spec AS task_spec
           FROM schedules s
           JOIN tasks t ON t.id = s.origin_id AND t.deleted_at IS NULL
           WHERE s.id = ? AND s.origin_type = 'task'`,
        )
        .get(scheduleId) as { task_spec: string | null } | undefined
      if (!row?.task_spec) return null
      return JSON.parse(row.task_spec) as TaskSpec
    } catch (err: unknown) {
      console.error(
        `[WorkflowExecutor] resolveTaskSpecFromOrigin failed for ${scheduleId} (non-fatal — composition wf gets empty subunits):`,
        err instanceof Error ? err.message : String(err),
      )
      return null
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
   * task-phase-redesign (ticket 05): resolve (phase_index, round_index) for a
   * v4 root execution. Precedence:
   *   1. `_phase_index`/`_round_index` management keys on chain[0].input_values
   *      (stamped by dispatchPhaseRound — authoritative across crash recovery);
   *   2. phase matched by workflow_ref against the envelope's resolved phases;
   *   3. phase 1 (fresh envelope — ticket 04 pre-loads chain[0] = phase 1).
   * Round without a stamp = 1 + count of this ws's executions already tagged to
   * that phase (the freshly created row is still untagged → never self-counts).
   *
   * task-phase-redesign (ticket 06): also returns the matched phase object (its
   * specDir feeds the seed hook — one lookup, seed + tagging can never drift).
   */
  private resolvePhaseRound(
    envelope: { phases?: Array<{ index: number; workflowRef: string; specDir?: string }> },
    firstStep: WorkflowChainItem,
    workspaceId: string,
  ): {
    phaseIndex: number
    roundIndex: number
    phase?: { index: number; workflowRef: string; specDir?: string }
  } {
    const iv = (firstStep.input_values ?? {}) as Record<string, unknown>
    const toInt = (v: unknown): number => {
      const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
      return Number.isInteger(n) && n >= 1 ? n : 0
    }
    const phaseIndex = toInt(iv._phase_index)
      || envelope.phases?.find((p) => p.workflowRef === firstStep.workflow_ref)?.index
      || 1
    const roundIndex = toInt(iv._round_index)
      || (this.execDAO.listByWorkspace(workspaceId).filter((e) => e.phase_index === phaseIndex).length + 1)
    return { phaseIndex, roundIndex, phase: envelope.phases?.find((p) => p.index === phaseIndex) }
  }

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
        // task-phase-redesign (ticket 05, K12 / 票03清单#5): a workspace bound
        // to a task that has not reached 'done' is EXEMPT — it is the task's
        // single permanent home (live worktrees + un-collected round evidence),
        // and max_retain eviction of it would be data destruction, not hygiene.
        // Once the task is done (archived) the exemption lifts and normal
        // retention reclaims the disk.
        if (this.isTaskWorkspaceUnarchived(row.workspace_id)) continue
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

  /** True when `workspaceId` is bound (tasks.workspace_id, schema v40) to a
   *  live task that has NOT reached 'done'. Raw query on the shared handle
   *  (same precedent as resolveTaskSpecFromOrigin — no TaskDAO injection
   *  needed). A lookup failure returns true (treat as protected): silently
   *  deleting live round evidence is the worse error, and the next retention
   *  sweep retries. */
  private isTaskWorkspaceUnarchived(workspaceId: string): boolean {
    try {
      const row = this.configDAO
        .getDb()
        .prepare(
          "SELECT status FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL LIMIT 1",
        )
        .get(workspaceId) as { status: string } | undefined
      return !!row && row.status !== 'done'
    } catch {
      return true
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
