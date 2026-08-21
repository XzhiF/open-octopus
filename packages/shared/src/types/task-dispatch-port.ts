import type { SubunitSpec } from "./scheduler-job"

/**
 * Opaque handle to a dispatched child schedule.
 *
 * Returned by {@link TaskDispatchPort.dispatchChildSchedule} and consumed by
 * {@link TaskDispatchPort.resumeOnCompletion} to bridge a completed child's
 * output back into the paused parent composition workflow (G1 pause-resume).
 */
export interface ScheduleHandle {
  /** The child schedule's id — used to correlate the completion callback. */
  schedule_id: string
  /** The materialized workspace id (set once createFromSpec runs). */
  workspace_id?: string
}

/**
 * Role a dispatched child schedule plays in the task's orchestration (v2-D9 /
 * ADR-0009 dispatch seam, S2 polymorphic origin).
 *  - 'primary' = simple task's single direct schedule (skip coordinator-ws).
 *  - 'coordinator' = composite task's composition-workflow schedule (runs
 *    composition-task.yaml + Loop× task_dispatch fan-out).
 *  - 'subunit' = a fan-out child of the coordinator (one per SubunitSpec).
 */
export type OriginRole = "primary" | "coordinator" | "subunit"

/**
 * Engine → scheduler boundary for composite task dispatch (G1).
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
   * Dispatch a child schedule for one {@link SubunitSpec} (its own workspace +
   * workflow_ref via createFromSpec). Returns a handle the parent task_dispatch
   * node awaits. Must not block on child completion — the child runs async and
   * calls back via {@link resumeOnCompletion}.
   *
   * @param origin_role v2 (SG1) — the role the created schedule plays in the
   *   task's orchestration. The impl sets `origin_type='task'`,
   *   `origin_role=<origin_role>`, and `origin_id=<parent task id>` on the
   *   created schedule (S2 polymorphic origin, no FK).
   */
  dispatchChildSchedule(subunit: SubunitSpec, origin_role: OriginRole): Promise<ScheduleHandle>

  /**
   * Resume the paused parent task_dispatch node with the completed child's
   * output (already run through the node's `output_mapping`). Triggered by the
   * server's child-complete callback, not by human SSE.
   */
  resumeOnCompletion(handle: ScheduleHandle, output: Record<string, unknown>): Promise<void>
}
