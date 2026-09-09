// packages/server/src/services/tasks/task-child-run.ts
//
// ADR-0021 票03/票04 — a composite task's CHILD RUN, end to end.
//
// A `task_dispatch` node inside a workflow fans out one subunit. Until now the child was
// a private `schedules` row (origin_type='task', origin_role='subunit') plus a
// `schedule_executions` link row, and its parent correlation was smuggled into the child's
// config JSON. That made the scheduler a participant in task execution: an over-cap child
// could only be picked up by the pump's queue claim, and the parent's resume was wired
// through a callback the engine lifecycle had to remember to bind.
//
// Now the child is what every other run is — an `executions` row with `parent_id` set to
// the dispatching run and `task_id` set to the parent task. Two consequences, both the
// point:
//   * the child queues in the SAME place a root does (status 'pending', claimed by the
//     built-in job), so composite fan-out inherits the concurrency cap without the
//     scheduler knowing anything about it;
//   * parent correlation is DERIVED, not stored: `parent_id` says who to resume and the
//     parent's still-running node says WHICH node. That survives a restart (both are
//     persisted rows) and removes the config-marker plumbing entirely.
//
// `resumeParentFromChild` is called from two places — the immediate completion callback
// and the task-lifecycle job's finalize — which is why it is a module function rather
// than a private method of either one. There is exactly one resume path now.

import type Database from "better-sqlite3"
import type { SubunitSpec, ChildHandle } from "@octopus/shared"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import { ScheduleRunDAO } from "../../db/dao/schedule-run-dao"
import { TaskDAO } from "../../db/dao/task-dao"
import { WorkspaceDAO } from "../../db/dao/workspace-dao"
import type { WorkspaceService } from "../workspace"
import type { SSEService } from "../sse"
import { getExecutionService } from "../execution-service-registry"
import { MAX_PARALLEL_WORKSPACES } from "../scheduler/concurrency"
import { taskWorkspaceName } from "../scheduler/task-ws-name"
import { formatBranchSuffix } from "../scheduler/ws-launch"

export interface ChildRunDeps {
  db: Database.Database
  /** The coordinator's workspace — where the dispatching execution lives. */
  workspaceId: string
  org: string
  workspaceService: WorkspaceService
  sse: SSEService
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Dispatch one subunit: build its workspace, arm it as a child execution, and start it if
 * the shared gate has room. Resolves once the child EXISTS — never on its completion (the
 * parent pauses persistently, so there is no in-memory Promise to lose across a restart).
 */
export function dispatchChildRun(deps: ChildRunDeps, subunit: SubunitSpec): ChildHandle {
  const execDAO = new ExecutionDAO(deps.db)
  const parent = resolveParentRun(execDAO, deps.workspaceId)
  if (!parent) {
    throw new Error(
      "task_dispatch: 找不到本工作区内正在运行的父执行,无法关联子单元(父执行可能已结束)",
    )
  }
  const node = execDAO.findFirstRunningNode(parent.id)
  if (!node) {
    throw new Error(
      `task_dispatch: 父执行 ${parent.id} 没有进行中的节点,无法回填子单元结果`,
    )
  }

  const parentTaskId = parent.task_id ?? resolveParentTaskId(deps.db, deps.workspaceId)
  const branchSuffix = formatBranchSuffix(new Date())
  const taskRow = parentTaskId ? new TaskDAO(deps.db).getById(parentTaskId) : null
  const workspaceName = taskRow
    ? taskWorkspaceName({ name: taskRow.name, task_spec: taskRow.task_spec }, { subName: subunit.name })
    : null

  // Each subunit gets an INDEPENDENT workspace (its own projects, its own branch). This
  // is the one part of the old shape that was already right, so it carries over verbatim.
  let workspaceId: string
  try {
    const created = deps.workspaceService.createFromSpec({
      org: subunit.workspace_spec.org || deps.org,
      name: workspaceName ?? `taskpool-${parent.id}-${branchSuffix}`,
      projects: subunit.workspace_spec.projects,
      branch_prefix: `taskpool-${parent.id}`,
      branch_suffix: branchSuffix,
      // 票03: a child workspace belongs to the TASK (workspaces.task_id) — the old
      // source_schedule_id was the only way back to the parent task, and it died with
      // the child schedule row.
      source: "task",
      task_id: parentTaskId,
      workflow_chain: [{ workflow_ref: subunit.workflow_ref, input_values: subunit.input_values }],
    })
    workspaceId = created.id
  } catch (err: unknown) {
    throw new Error(`task_dispatch: 子单元工作区创建失败: ${errMessage(err)}`)
  }

  const registry = getExecutionService(workspaceId)
  if (!registry) {
    throw new Error(`task_dispatch: 子单元工作区 ${workspaceId} 的 ExecutionService 不可用`)
  }

  const child = registry.service.create(workspaceId, {
    workflow_ref: subunit.workflow_ref,
    triggered_by: "task_dispatch",
    input_values: subunit.input_values,
    // The correlation that replaced origin_role + the config marker: this row is a CHILD
    // of the dispatching run and belongs to the same task. child_index keeps the fan-out
    // order stable for the parent's aggregation.
    parent_id: parent.id,
    child_index: execDAO.findChildren(parent.id).length,
    task_id: parentTaskId,
  })

  deps.sse.emit("taskpool", {
    event: "task_execution",
    data: {
      task_id: parentTaskId,
      execution_id: child.id,
      parent_id: parent.id,
      subunit: subunit.name,
      status: child.status,
    },
  })

  // Cap gate. Over cap, the child stays 'pending' and the built-in job claims it when a
  // slot frees — the SAME queue a root task launch uses. Previously it was a 'queued'
  // schedule row that only the pump's task-claim loop could pick up.
  if (new ScheduleRunDAO(deps.db).countActiveWork() >= MAX_PARALLEL_WORKSPACES) {
    return { child_id: child.id, workspace_id: workspaceId }
  }
  startChildRun(deps.db, child.id, workspaceId, subunit.input_values as Record<string, string>)
  return { child_id: child.id, workspace_id: workspaceId }
}

/** Claim + start an armed child and wire its completion back to the parent. Shared by the
 *  immediate path and the job's claim loop, so a child that waited behind the cap behaves
 *  exactly like one that did not. */
export function startChildRun(
  db: Database.Database,
  childId: string,
  workspaceId: string,
  inputValues: Record<string, string>,
  /** True when the caller already moved the row out of 'pending' — the built-in job's
   *  claim loop does that (under the guarded claim that keeps two owners from both
   *  starting it) before delegating here. Without the flag the inner claim would see
   *  changes===0 and bail, leaving a row that says 'running' with no engine and a parent
   *  that is never resumed (票03 复核抓到的形状). */
  alreadyClaimed = false,
): boolean {
  const execDAO = new ExecutionDAO(db)
  if (!alreadyClaimed && execDAO.claimLaunch(childId).changes === 0) return false
  const registry = getExecutionService(workspaceId)
  if (!registry) {
    execDAO.setLaunchStatus(childId, "failed", { completedAt: new Date().toISOString() })
    resumeParentFromChild(db, childId).catch((err: unknown) =>
      console.error(`[task-child-run] resume parent after unavailable ws failed:`, errMessage(err)))
    return false
  }
  // `as never`: the engine's onComplete arity (Partial<EngineCallbacks>) vs the child
  // runner's zero-arg needs — same narrow cast as the lifecycle service's finalize hook.
  registry.service.registerExternalCallbacks(
    {
      onComplete: (() => {
        resumeParentFromChild(db, childId).catch((err: unknown) => {
          console.error(`[task-child-run] child-complete resume failed for ${childId}:`, errMessage(err))
        })
      }) as never,
    } as never,
    childId,
  )
  registry.service.start(childId, inputValues).catch((err: unknown) => {
    const message = errMessage(err)
    console.error(`[task-child-run] child start failed for ${childId}:`, message)
    execDAO.setLaunchStatus(childId, "failed", { completedAt: new Date().toISOString() })
    registry.service.clearExternalCallbacks(childId)
    resumeParentFromChild(db, childId).catch((e: unknown) =>
      console.error(`[task-child-run] resume after start failure failed:`, errMessage(e)))
  })
  return true
}

/**
 * A child run ended → hand its output back to the parent's waiting task_dispatch node.
 *
 * Correlation is derived, not stored: `parent_id` names the run to resume and that run's
 * currently-running node is by construction the task_dispatch node that paused (the
 * executor pauses the instant it dispatches, and nothing else can advance while it is
 * paused). A failed or vanished child resumes with an EMPTY output rather than stalling
 * the parent forever — the composition workflow's own aggregation decides what a missing
 * subunit means, and its Loop can still finish.
 *
 * Idempotent by nature: `resumeTaskDispatch` re-enters the parent's node, so a callback
 * and the job's reconcile both firing resume the parent once (the second sees a node that
 * is no longer waiting and is a no-op).
 */
export async function resumeParentFromChild(
  db: Database.Database,
  childExecId: string,
  /** The engine's own view of the child output, when the caller has one (the port's
   *  resumeOnCompletion path passes the value the node already mapped). Reading the
   *  child's var_pool is the fallback, used by the completion callback and the job. */
  outputOverride?: Record<string, unknown>,
): Promise<void> {
  const execDAO = new ExecutionDAO(db)
  const child = execDAO.findById(childExecId)
  if (!child || !child.parent_id || child.parent_id === "0") return

  const parent = execDAO.findById(child.parent_id)
  if (!parent) {
    console.warn(`[task-child-run] child ${childExecId} points at a missing parent ${child.parent_id}`)
    return
  }
  const node = execDAO.findFirstRunningNode(parent.id)
  if (!node) {
    // The parent already moved on (its own recovery resumed it, or it was aborted). Not
    // an error worth a stack trace — the child's result is on disk either way.
    console.log(`[task-child-run] parent ${parent.id} has no waiting node; child ${childExecId} result not forwarded`)
    return
  }

  let output: Record<string, unknown> = outputOverride ?? {}
  if (!outputOverride) {
    try {
      output = JSON.parse(child.var_pool ?? "{}") as Record<string, unknown>
    } catch {
      output = {}
    }
  }

  const registry = getExecutionService(parent.workspace_id)
  if (!registry) {
    console.warn(
      `[task-child-run] parent ${parent.id} workspace unavailable — it stays paused until its own recovery picks it up`,
    )
    return
  }
  await registry.service.resumeTaskDispatch(parent.id, node.node_id, output)
}

/** The dispatching run: the deepest still-running execution in this workspace (a child
 *  dispatching a grandchild must find ITSELF, not the root). */
function resolveParentRun(execDAO: ExecutionDAO, workspaceId: string) {
  const leaves = execDAO.findRunningLeaves(workspaceId)
  return leaves[0] ?? null
}

/** Fallback parent-task lookup for a row that did not carry task_id: the workspace's own
 *  task binding (v41 `workspaces.task_id`), which is the direct column that replaced the
 *  `source_schedule_id → schedules.origin_id` join bridge. */
function resolveParentTaskId(db: Database.Database, workspaceId: string): string | null {
  const row = new WorkspaceDAO(db).findById(workspaceId)
  return row?.task_id ?? null
}
