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
   */
  dispatchChildSchedule(subunit: SubunitSpec): Promise<ScheduleHandle>

  /**
   * Resume the paused parent task_dispatch node with the completed child's
   * output (already run through the node's `output_mapping`). Triggered by the
   * server's child-complete callback, not by human SSE.
   */
  resumeOnCompletion(handle: ScheduleHandle, output: Record<string, unknown>): Promise<void>
}
