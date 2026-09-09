import type { SubunitSpec } from "./scheduler-job"

/**
 * Opaque handle to a dispatched CHILD RUN.
 *
 * Returned by {@link TaskDispatchPort.dispatchChild} and consumed by
 * {@link TaskDispatchPort.resumeOnCompletion} to bridge a completed child's output back
 * into the paused parent's task_dispatch node (G1 pause-resume).
 *
 * 票04 (ADR-0021) renamed this from `ScheduleHandle`/`schedule_id`: the child used to be
 * a private `schedules` row (origin_type='task', origin_role='subunit'), which meant a
 * composite fan-out put task-owned rows into the scheduler's table and could only be
 * picked up again by the scheduler's own claim loop. A child is now an `executions` row
 * with parent_id + task_id — the same shape every other run has — so the handle carries
 * a run id and the word "schedule" leaves the vocabulary with the rest of the coupling.
 */
export interface ChildHandle {
  /** The child execution's id — the correlation key for the completion callback. */
  child_id: string
  /** The materialized workspace id (set once the child workspace is built). */
  workspace_id?: string
}

/**
 * Role a dispatched child plays in a composite task's orchestration (v2-D9 / ADR-0009).
 * Kept for the audit trail (`subunit` children vs. a `coordinator` root), but it is no
 * longer a parameter of the port: the engine never passed it, and after 票03 there is no
 * `schedules.origin_role` column for an implementation to write.
 */
export type OriginRole = "primary" | "coordinator" | "subunit"

/**
 * Engine → server boundary for composite task dispatch (G1).
 *
 * The engine package only depends on `@octopus/shared` + `@octopus/providers`,
 * so this interface lives in shared. The concrete implementation is provided by
 * the server and injected via `ExecutorFactoryContext` (same precedent as
 * `createSessionFn` in executor-config.ts). The `TaskDispatchExecutor`
 * (a later engine ticket) consumes this port to fan out child schedules and
 * pause-resume across the process boundary — reusing the interaction/approval
 * pause-resume infrastructure rather than an in-memory Promise.
 */
export interface TaskDispatchPort {
  /**
   * Dispatch a child run for one {@link SubunitSpec}: its own workspace + its own
   * `executions` row (parent_id = the dispatching run, task_id = the parent task).
   * Returns a handle the parent's task_dispatch node awaits. Must NOT block on child
   * completion — the child runs async and calls back via {@link resumeOnCompletion}.
   *
   * Over the concurrency cap the implementation arms the child as a 'pending' row and
   * returns; the built-in task-lifecycle job claims it when a slot frees. Before 票03 an
   * over-cap child was a 'queued' schedule row, which only the scheduler's claim loop
   * could pick up — one of the reasons task work had to stay welded to the pump.
   */
  dispatchChild(subunit: SubunitSpec): Promise<ChildHandle>

  /**
   * Resume the paused parent task_dispatch node with the completed child's
   * output (already run through the node's `output_mapping`). Triggered by the
   * server's child-complete callback, not by human SSE.
   */
  resumeOnCompletion(handle: ChildHandle, output: Record<string, unknown>): Promise<void>
}
