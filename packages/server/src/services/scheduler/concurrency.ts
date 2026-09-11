/**
 * The scheduler's single concurrency knob (ADR-0021).
 *
 * Before this module, three files each read `OCTOPUS_SCHEDULER_MAX_PARALLEL` into their
 * own local constant and a comment swore they stayed in sync ("kept in sync via env
 * var", scheduler-engine.ts:25). A cap that is enforced by three independently-parsed
 * copies is a cap that silently diverges the moment someone edits one of them, so the
 * number — and the meter it is compared against — live here.
 *
 * Callers pair this with `ScheduleRunDAO.countActiveWork()`, which is the ONE meter that
 * spans both kinds of in-flight work (job fires in `schedule_executions`, task launches in
 * `executions`). Counting only one table lets a burst of the other type walk past the cap.
 */

/** Env-tunable global cap on simultaneous real runs (workflow / agent / task launches). */
export const MAX_PARALLEL_WORKSPACES = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_PARALLEL ?? '3',
  10,
)

/** Agent jobs have their own in-process gate on top of the shared one. */
export const MAX_AGENT_CONCURRENCY = parseInt(
  process.env.OCTOPUS_SCHEDULER_MAX_AGENT_CONCURRENT ?? '10',
  10,
)

/** Claimed/running rows older than this are assumed ownerless and rolled back. */
export const STALE_CLAIMED_THRESHOLD_MS = parseInt(
  process.env.OCTOPUS_SCHEDULER_STALE_CLAIMED_MS ?? '600000',
  10,
)
