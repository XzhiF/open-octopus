// packages/server/src/services/scheduler/schedule-status-listener.ts
//
// TaskScheduleStatusListener — SG2 impl of the shared `ScheduleStatusListener`
// port. Injected into SchedulerEngine (+ SchedulerService + WorkflowExecutor)
// so every schedule lifecycle transition is mirrored onto the parent task's
// `status` column and broadcast as `task_status` SSE on the global 'taskpool'
// channel — the /tasks kanban reads this in real time instead of polling.
//
// Mapping (spec SG2): queued/claimed/running → 'running' (claimed is a
// schedule-level runner detail, folded into task 'running'); done → 'done';
// failed → 'failed'; aborted → 'aborted'. 'draft' is pre-dispatch and never
// mirrored (the task is already 'draft' or 'ready' at that point).
//
// The listener self-filters by origin_type='task' — cron/agent/manual/api
// schedules don't touch tasks.status. tasks has NO schedule_id (S2 polymorphic
// origin, no FK); the parent task is `schedules.origin_id`, resolved via 02's
// `findSchedulesByOrigin('task', task.id)`.
//
// The status UPDATE is a direct column write via `taskDAO.getDb()` — it does
// NOT bump `version`. `version` tracks task_spec/resources/authoring_resources
// changes for the spec-field tool's optimistic concurrency (409 → re-GET +
// retry, v2-D12); a status mirror is a system event, not a spec edit, so it
// must not force a spurious 409 on the next agent spec-field call. The write
// is idempotent (re-mirroring the same status is a no-op on the row).

import type { SSEService } from "../sse"
import type { TaskDAO, ScheduleConfigDAO } from "../../db/dao"
import {
  TASK_STATUS_EVENT,
  type ScheduleStatusListener,
  type TaskStatus,
  type ScheduleStatus,
  type OriginType,
} from "@octopus/shared"

/** Schedule status → task status. `draft` is not mirrored (pre-dispatch). */
const SCHEDULE_TO_TASK_STATUS: Partial<Record<ScheduleStatus, TaskStatus>> = {
  queued: "running",
  claimed: "running",
  running: "running",
  done: "done",
  failed: "failed",
  aborted: "aborted",
}

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "aborted",
])

export class TaskScheduleStatusListener implements ScheduleStatusListener {
  constructor(
    private taskDAO: TaskDAO,
    private scheduleDAO: ScheduleConfigDAO,
    private sse: SSEService,
  ) {}

  onScheduleTransition(args: {
    schedule_id: string
    origin_type: OriginType
    origin_id: string
    status: ScheduleStatus
    error_summary?: string | null
  }): void {
    // Self-filter: only task-origin schedules drive tasks.status. Cron /
    // agent / manual / api schedules are independent and must not touch the
    // tasks table (would corrupt unrelated rows via a null origin_id).
    if (args.origin_type !== "task") return
    if (!args.origin_id) return

    const taskStatus = SCHEDULE_TO_TASK_STATUS[args.status]
    if (!taskStatus) return // 'draft' or unknown — not mirrored

    // S2: the parent task is schedules.origin_id. A deleted/missing task is a
    // no-op (e.g. cascade-reap already cleaned up, or orphan schedule). Do NOT
    // throw — a stale schedule transition must not crash the engine tick.
    const task = this.taskDAO.getById(args.origin_id)
    if (!task) return

    // Idempotent fast-path: if the task is already in the target status, skip
    // the UPDATE + SSE emit (avoids a spurious SSE flood on re-mirrors, e.g.
    // checkStaleClaimed rolling back a schedule whose task is already running).
    if (task.status === taskStatus) return

    const now = new Date().toISOString()
    const completedAt = TERMINAL_TASK_STATUSES.has(taskStatus) ? now : null
    // Direct UPDATE — no version bump (status mirrors are system events; the
    // version column tracks spec/resource edits for the spec-field tool's
    // optimistic concurrency). completed_at is set for terminal states and
    // cleared otherwise (a task that re-enters running from a rolled-back
    // claimed schedule should clear a stale completed_at).
    this.taskDAO
      .getDb()
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(taskStatus, now, completedAt, args.origin_id)

    // Emit task_status SSE on the global 'taskpool' channel so the /tasks
    // kanban updates in real time. Mirrors the `schedule_status` emit shape
    // (scheduler-engine/service/workflow-executor) so the kanban listener
    // handles both event names uniformly.
    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: {
        task_id: args.origin_id,
        status: taskStatus,
        schedule_id: args.schedule_id,
        origin_type: args.origin_type,
      },
    })
  }
}
