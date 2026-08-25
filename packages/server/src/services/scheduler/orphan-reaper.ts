// packages/server/src/services/scheduler/orphan-reaper.ts
//
// SG12 — orphan schedule reaper. Scans `schedules WHERE origin_type='task' AND
// origin_id NOT IN (SELECT id FROM tasks WHERE deleted_at IS NULL)` and soft-
// deletes the orphans. This is the app-level integrity backstop for S2's
// polymorphic origin (no FK on origin_id — the tradeoff for uniform polymorphic
// association). R-INT mitigation.
//
// Two triggers:
//   1. Cascade-reap on task delete/abort — handled inline by TasksService
//      (deleteTask/abortTask call findSchedulesByOrigin + softDelete). This
//      covers the common path.
//   2. Orphan reaper — handles the gap: schedules whose origin task was HARD-
//      deleted (bypassing the service), or whose origin_id points at a task
//      that never existed (correlation bug), or whose origin task was soft-
//      deleted by a path that didn't cascade. Runs on a schedule (wired into
//      SchedulerEngine.auxiliaryTick).
//
// Idempotent + defensive: skips schedules already soft-deleted; skips schedules
// with NULL origin_id (shouldn't happen for origin_type='task', but defensive).

import type Database from "better-sqlite3"

/** Scan + soft-delete orphan task-origin schedules. Returns the count reaped.
 *  Safe to call on a fresh DB (no-op if no orphans). */
export function reapOrphanSchedules(db: Database.Database): number {
  // Find schedules whose origin_type='task' AND origin_id does NOT point at an
  // active (non-deleted) task. LEFT JOIN so a NULL origin_id also matches
  // (defensive — origin_type='task' should always carry origin_id).
  const orphans = db
    .prepare(
      `SELECT s.id AS schedule_id
       FROM schedules s
       LEFT JOIN tasks t ON t.id = s.origin_id AND t.deleted_at IS NULL
       WHERE s.origin_type = 'task'
         AND s.deleted_at IS NULL
         AND (t.id IS NULL OR s.origin_id IS NULL)`,
    )
    .all() as Array<{ schedule_id: string }>

  if (orphans.length === 0) return 0

  const now = new Date().toISOString()
  const reapStmt = db.prepare(
    "UPDATE schedules SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
  )
  let reaped = 0
  for (const { schedule_id } of orphans) {
    const result = reapStmt.run(now, now, schedule_id)
    if (result.changes > 0) reaped++
  }
  if (reaped > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[orphan-reaper] soft-deleted ${reaped} orphan task-origin schedule(s) (origin_id pointed at missing/deleted task)`,
    )
  }
  return reaped
}
