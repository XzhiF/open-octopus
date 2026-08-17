// packages/server/src/services/tasks/spec-notice-store.ts
//
// 05 — reverse context msg notice store (SPIKE S1, v2-D7).
//
// Transient, in-memory bridge for the spec↔agent reverse direction:
//   - tasks-service.updateTask ([保存草稿], PUT /api/tasks/:id) calls
//     `setSpecNotice(taskId, '@@spec_updated: <fields>')` after persisting.
//   - the task-author clone chat send path (clone/index.ts) reads
//     `getSpecNotice(taskId)` and passes it to `CloneRuntime.chat` as
//     `specUpdateNotice` → `sendWithProvider` appends it to the system
//     prompt (SPIKE S1: system-prompt append, re-delivered per turn because
//     assembleContext is fresh each turn, clone-runtime.ts:261). The send
//     path clears the notice AFTER the stream so a mid-stream error
//     re-delivers it next turn (at-least-once).
//
// Intentionally NOT persisted to the DB: 06 owns db/schema.ts, and the
// notice is acceptable to lose on server restart (transient UX nudge). The
// agent only needs to see the user's spec override on the NEXT chat turn;
// once delivered it is cleared. Keeping it in-process avoids DB/SDK history
// pollution (the rejected prepend-to-user-msg alternative) and schema
// conflicts with concurrent tickets.
//
// Concurrency: the store is a module-level Map singleton. The clone route
// serializes per-session chat turns (one in-flight stream per session via
// registerActiveStream), so the get→pass→clear sequence is effectively
// single-threaded per task-author session. A concurrent second session
// re-reading the same notice would at-most double-deliver — acceptable for a
// transient, idempotent nudge.

/** task_id → notice string (e.g. "@@spec_updated: goal, skills"). */
const store = new Map<string, string>()

/**
 * Set the transient spec-update notice for a task. Called by
 * TasksService.updateTask after a successful [保存草稿] persist. Overwrites
 * any prior unread notice (the latest save wins).
 */
export function setSpecNotice(taskId: string, notice: string): void {
  store.set(taskId, notice)
}

/**
 * Read the notice WITHOUT clearing it. The clone send path reads here, then
 * clears via {@link clearSpecNotice} AFTER the stream completes (so a
 * mid-stream error re-delivers the notice next turn). Returns undefined
 * when no notice is pending.
 */
export function getSpecNotice(taskId: string): string | undefined {
  return store.get(taskId)
}

/**
 * Clear the notice for a task. Called by the clone send path after the
 * chat stream has delivered the notice to the provider (the system-prompt
 * append was assembled and sent). Idempotent — clearing a non-existent
 * notice is a no-op.
 */
export function clearSpecNotice(taskId: string): void {
  store.delete(taskId)
}

/**
 * Clear every pending notice. Used by tests for isolation between cases
 * and by any future org-level reset path. Not on the hot path.
 */
export function clearAllSpecNotices(): void {
  store.clear()
}
