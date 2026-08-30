// packages/server/src/services/scheduler/task-dispatch-service.ts
//
// TaskDispatchPort implementation (G1 pause-resume bridge, ticket 03).
//
// The engine package depends only on @octopus/shared + @octopus/providers, so the
// TaskDispatchPort INTERFACE lives in shared (committed in stage 1). This file is
// the concrete server impl, injected into ExecutorFactoryContext via
// engine.setTaskDispatchPort() at EngineFactory.createEngine/reconstructEngine time
// (createSessionFn precedent).
//
// Contract:
//   dispatchChildSchedule(subunit) → create a DISTINCT child schedule (its own
//     schedule_id, so the idx_sched_execs_unique_active partial index never
//     conflicts) + createFromSpec independent workspace + start the sub-workflow_ref.
//     Resolves once the child is CREATED/STARTED — does NOT block on child
//     completion (no in-memory Promise; the parent pauses persistently).
//   resumeOnCompletion(handle, output) → look up the parent composition-wf
//     execution + task_dispatch node (recorded on the child schedule's config at
//     dispatch time, so the correlation survives process restart) and call
//     ExecutionLifecycle.resumeTaskDispatch → engine.retryFrom({ taskDispatchChildOutput }).
//
// Concurrency cap (MAX_PARALLEL_WORKSPACES) is enforced at the port layer: over
// cap → the child schedule is created in 'queued' status and NOT started (not
// fatal — the parent pauses waiting; pickup of queued children is the scheduler-
// engine's domain, owned by tickets 06/07).

import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import type { SubunitSpec, TaskDispatchPort, ScheduleHandle, WorkflowConfig, OriginRole } from "@octopus/shared"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO, TaskDAO } from "../../db/dao"
import type { WorkspaceService } from "../workspace"
import type { SSEService } from "../sse"
import { getExecutionService } from "../execution-service-registry"
import { taskWorkspaceName } from "./task-ws-name"

const MAX_PARALLEL_WORKSPACES = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_PARALLEL ?? "3",
  10,
)

/** Parent correlation written onto the child schedule's config so resume can find
 *  the parent composition-wf execution + task_dispatch node after a process
 *  restart (no in-memory Promise or closure holding the link). */
interface ParentTaskDispatchMarker {
  execution_id: string
  node_id: string
}

interface ChildConfig extends WorkflowConfig {
  parent_task_dispatch?: ParentTaskDispatchMarker
}

export interface TaskDispatchServiceDeps {
  db: Database.Database
  workspaceId: string
  workspacePath: string
  org: string
  workspaceService: WorkspaceService
  sse: SSEService
}

/** Lazy resume hook — ExecutionLifecycle binds `this.resumeTaskDispatch` after
 *  constructing the service (breaks the construction-order cycle: the port is
 *  injected into EngineFactory, which ExecutionLifecycle constructs, so the port
 *  cannot take the lifecycle in its constructor). */
type ResumeParentFn = (
  parentExecutionId: string,
  nodeId: string,
  childOutput: Record<string, unknown>,
) => Promise<unknown>

export class TaskDispatchService implements TaskDispatchPort {
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO
  private execDAO: ExecutionDAO
  /** task-ws-name: parent task lookup for `task:{标题}·{子单元}` naming. */
  private taskDAO: TaskDAO
  private resumeParent: ResumeParentFn | undefined

  constructor(private deps: TaskDispatchServiceDeps) {
    this.configDAO = new ScheduleConfigDAO(deps.db)
    this.runDAO = new ScheduleRunDAO(deps.db)
    this.execDAO = new ExecutionDAO(deps.db)
    this.taskDAO = new TaskDAO(deps.db)
  }

  /** Wire the parent-resume hook (ExecutionLifecycle.resumeTaskDispatch). */
  setResumeParentCallback(fn: ResumeParentFn): void {
    this.resumeParent = fn
  }

  // ── TaskDispatchPort ───────────────────────────────────────────────

  async dispatchChildSchedule(subunit: SubunitSpec, origin_role: OriginRole): Promise<ScheduleHandle> {
    const parentCtx = this.resolveParentContext()
    if (!parentCtx) {
      throw new Error(
        "task_dispatch: no running composition-wf execution found in the coordinator workspace to correlate the child schedule with",
      )
    }

    // SG1 (ticket 06): resolve the parent task id for origin_id. The child
    // schedule's origin_id points at the PARENT TASK (not the coordinator
    // schedule) — so the orphan reaper + cascade-reap + GET /tasks/:id children
    // all correlate via origin_type='task' AND origin_id=task.id. The parent
    // task id is read from the coordinator schedule that created this workspace
    // (workspaces.source_schedule_id → schedules.origin_id).
    const parentTaskId = this.resolveParentTaskId()

    const scheduleId = randomUUID()

    // Concurrency cap (MAX_PARALLEL_WORKSPACES). Over cap → queue, don't start.
    // Not fatal: the parent composition-wf is already paused (pending_task_dispatch)
    // waiting on this handle; it stays paused until a slot frees and the queued
    // child is claimed/run (scheduler-engine, tickets 06/07).
    if (this.runDAO.countDistinctActiveSchedules() >= MAX_PARALLEL_WORKSPACES) {
      this.createChildScheduleRow(scheduleId, subunit, parentCtx, "queued", origin_role, parentTaskId)
      this.deps.sse.emit("taskpool", {
        event: "schedule_status",
        data: { schedule_id: scheduleId, status: "queued" },
      })
      return { schedule_id: scheduleId }
    }

    // Create the child schedule row (distinct schedule_id → never collides with
    // idx_sched_execs_unique_active which is per-schedule_id).
    this.createChildScheduleRow(scheduleId, subunit, parentCtx, "running", origin_role, parentTaskId)

    // SG10 (ticket 06): emit child 'running' SSE when the child starts. The
    // queued path above emits 'queued'; the running path emits 'running' here
    // (before workspace creation) so the kanban claims the child card in real
    // time. Mirrors WorkflowExecutor's running emit shape.
    this.deps.sse.emit("taskpool", {
      event: "schedule_status",
      data: { schedule_id: scheduleId, status: "running" },
    })

    // Materialize an independent workspace for the child sub-workflow.
    const branchSuffix = formatBranchSuffix(new Date())
    // task-ws-name (2026-08-29): 与主执行同款命名 —— `task:{父任务标题}·{子单元名}`；
    // 父任务查不到/无标题时回退旧 taskpool-{scheduleId} 命名。
    const parentTaskRow = parentTaskId ? this.taskDAO.getById(parentTaskId) : null
    const taskWsName = parentTaskRow
      ? taskWorkspaceName({ name: parentTaskRow.name, task_spec: parentTaskRow.task_spec }, { subName: subunit.name })
      : null
    const workspaceName = taskWsName ?? `taskpool-${scheduleId}-${branchSuffix}`
    let workspace
    try {
      workspace = this.deps.workspaceService.createFromSpec({
        org: subunit.workspace_spec.org,
        name: workspaceName,
        projects: subunit.workspace_spec.projects,
        branch_prefix: `taskpool-${scheduleId}`,
        branch_suffix: branchSuffix,
        source: "scheduler",
        source_schedule_id: scheduleId,
        workflow_chain: [{ workflow_ref: subunit.workflow_ref, input_values: subunit.input_values }],
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.configDAO.updateSchedule(scheduleId, { status: "failed" })
      throw new Error(`task_dispatch: child workspace creation failed: ${message}`)
    }

    // Create the schedule_execution row (links schedule_id ↔ execution).
    const schedExecId = randomUUID()
    this.runDAO.insertExecution({
      id: schedExecId,
      schedule_id: scheduleId,
      status: "running",
      trigger_type: "task_dispatch",
      triggered_by: "task_dispatch",
    })

    // Get the child workspace's ExecutionService + create + start the sub-workflow.
    const registry = getExecutionService(workspace.id)
    if (!registry) {
      this.configDAO.updateSchedule(scheduleId, { status: "failed" })
      throw new Error("task_dispatch: ExecutionService unavailable for the child workspace")
    }

    let childExec
    try {
      childExec = registry.service.create(workspace.id, {
        workflow_ref: subunit.workflow_ref,
        triggered_by: "task_dispatch",
        input_values: subunit.input_values,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.configDAO.updateSchedule(scheduleId, { status: "failed" })
      throw new Error(`task_dispatch: child execution creation failed: ${message}`)
    }

    this.runDAO.updateExecution(schedExecId, { execution_id: childExec.id })

    // Register the child-complete callback (distinct from the same-ws chain
    // handleChainComplete in workflow-executor.ts — this fires when a child
    // schedule dispatched BY a task_dispatch node completes, resuming the PARENT
    // composition-wf). The callback reads the child's var_pool snapshot and calls
    // resumeOnCompletion, which looks up the parent from the persisted config marker.
    const handle: ScheduleHandle = { schedule_id: scheduleId, workspace_id: workspace.id }
    registry.service.registerExternalCallbacks(
      {
        onComplete: (() => {
          this.handleChildComplete(childExec.id, scheduleId).catch((err: unknown) => {
            console.error(
              `[TaskDispatchService] child-complete callback failed for ${scheduleId}:`,
              err instanceof Error ? err.message : String(err),
            )
          })
        }) as any,
      },
      childExec.id,
    )

    // Fire and forget — do NOT await (no in-memory Promise; parent is paused).
    registry.service.start(childExec.id, subunit.input_values).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[TaskDispatchService] child execution start failed for ${scheduleId}:`, message)
      this.runDAO.markExecutionFailed(schedExecId, message, ["triggered", "running"])
      this.configDAO.updateSchedule(scheduleId, { status: "failed" })
      registry.service.clearExternalCallbacks(childExec.id)
    })

    return handle
  }

  async resumeOnCompletion(handle: ScheduleHandle, output: Record<string, unknown>): Promise<void> {
    if (!this.resumeParent) {
      throw new Error("task_dispatch: resumeParent callback not wired (ExecutionLifecycle not connected)")
    }
    // Look up the parent correlation from the CHILD schedule's persisted config —
    // restart-safe (no closure capturing the link).
    const childSchedule = this.configDAO.findById(handle.schedule_id)
    if (!childSchedule) {
      throw new Error(`task_dispatch: child schedule ${handle.schedule_id} not found for resume`)
    }
    let config: ChildConfig
    try {
      config = JSON.parse(childSchedule.config) as ChildConfig
    } catch {
      throw new Error(`task_dispatch: child schedule ${handle.schedule_id} config is not valid JSON`)
    }
    const marker = config.parent_task_dispatch
    if (!marker) {
      throw new Error(
        `task_dispatch: child schedule ${handle.schedule_id} has no parent_task_dispatch marker`,
      )
    }
    await this.resumeParent(marker.execution_id, marker.node_id, output)
  }

  // ── Child-complete handler ──────────────────────────────────────────

  /** Called (via the child execution's onComplete callback) when a child
   *  sub-workflow dispatched by a task_dispatch node finishes. Reads the child's
   *  var_pool snapshot (sub-workflow precedent: output_mapping reads child pool
   *  vars) and resumes the parent. Distinct from workflow-executor's
   *  handleChainComplete (same-ws chain). */
  private async handleChildComplete(
    childExecutionId: string,
    childScheduleId: string,
  ): Promise<void> {
    const childExec = this.execDAO.findById(childExecutionId)
    if (!childExec) {
      console.warn(`[TaskDispatchService] child execution ${childExecutionId} not found on completion`)
      return
    }
    // Failed child → resume parent with an empty output so the parent's downstream
    // aggregation sees a missing key (logged, not fatal — partial results). The
    // parent composition-wf can decide via its own failure strategy.
    const status = childExec.status
    const varPoolRaw = childExec.var_pool ?? "{}"
    let output: Record<string, unknown>
    try {
      output = JSON.parse(varPoolRaw) as Record<string, unknown>
    } catch {
      output = {}
    }

    // Mark the child schedule done/failed (kanban) + emit SSE.
    const finalStatus = status === "completed" ? "done" : "failed"
    this.configDAO.updateSchedule(childScheduleId, { status: finalStatus, claimed_at: null })
    this.deps.sse.emit("taskpool", {
      event: "schedule_status",
      data: { schedule_id: childScheduleId, status: finalStatus },
    })

    // Resume the parent composition-wf's task_dispatch node with the child output.
    try {
      await this.resumeOnCompletion({ schedule_id: childScheduleId }, output)
    } catch (err: unknown) {
      console.error(
        `[TaskDispatchService] resume parent failed for child ${childScheduleId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Resolve the parent composition-wf execution + the task_dispatch node that is
   *  currently running (about to pause) in the coordinator workspace. The
   *  TaskDispatchExecutor calls dispatchChildSchedule BEFORE returning
   *  pending_task_dispatch, so at this moment the parent execution is 'running' and
   *  its currently-running node is the task_dispatch node. */
  private resolveParentContext(): ParentTaskDispatchMarker | null {
    const leaves = this.execDAO.findRunningLeaves(this.deps.workspaceId)
    const parent = leaves[0]
    if (!parent) return null
    const runningNode = this.execDAO.findFirstRunningNode(parent.id)
    if (!runningNode) return null
    return { execution_id: parent.id, node_id: runningNode.node_id }
  }

  /** SG1 (ticket 06): resolve the parent TASK id for the child schedule's
   *  origin_id. The child's origin_id points at the parent TASK (S2 polymorphic
   *  origin, no FK), not the coordinator schedule. The parent task id is read
   *  from the coordinator schedule that created this coordinator workspace:
   *    workspaces.source_schedule_id → schedules.origin_id (= parent task id)
   *  Returns null if not resolvable (defensive — orphan reaper handles a NULL
   *  origin_id as an orphan, which is acceptable for a corrupted state). */
  private resolveParentTaskId(): string | null {
    try {
      const row = this.configDAO
        .getDb()
        .prepare(
          `SELECT s.origin_id AS origin_id
           FROM workspaces w
           JOIN schedules s ON s.id = w.source_schedule_id
           WHERE w.id = ? AND s.origin_type = 'task' AND s.origin_id IS NOT NULL`,
        )
        .get(this.deps.workspaceId) as { origin_id: string | null } | undefined
      return row?.origin_id ?? null
    } catch (err: unknown) {
      console.error(
        `[TaskDispatchService] resolveParentTaskId failed (non-fatal — child schedule origin_id will be NULL):`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }

  private createChildScheduleRow(
    scheduleId: string,
    subunit: SubunitSpec,
    parentCtx: ParentTaskDispatchMarker,
    status: "queued" | "running",
    originRole: OriginRole,
    parentTaskId: string | null,
  ): void {
    const config: ChildConfig = {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: subunit.workspace_spec,
      workflow_chain: [
        { workflow_ref: subunit.workflow_ref, input_values: subunit.input_values },
      ],
      max_retain: 10,
      parent_task_dispatch: parentCtx,
    }
    // SG1 (ticket 06): child schedule carries origin_type='task' + origin_role
    // (passed by the caller — 'subunit' for fan-out children) + origin_id=<parent
    // task id> (resolved via the coordinator workspace's source_schedule_id →
    // schedules.origin_id). Replaces the dropped trigger_source='requirement'.
    this.configDAO.insertSchedule({
      id: scheduleId,
      org: this.deps.org,
      name: `task-dispatch-${subunit.name}-${scheduleId.slice(0, 8)}`,
      cron_expression: null,
      timezone: "UTC",
      job_type: "workflow",
      config: JSON.stringify(config),
      status,
      origin_type: "task",
      origin_role: parentTaskId ? originRole : originRole,
      origin_id: parentTaskId,
    })
  }
}

function formatBranchSuffix(date: Date): string {
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const mi = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  const rand = Math.random().toString(36).substring(2, 6)
  return `${y}${mo}${d}${h}${mi}${s}-${rand}`
}
