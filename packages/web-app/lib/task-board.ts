// packages/web-app/lib/task-board.ts
//
// /tasks kanban columns + grouping for the first-class `tasks` domain (v2-D1,
// SG14 — read `Task`, NOT `SchedulerJob`). The 6 columns mirror the `TaskStatus`
// enum: draft → ready → running → (done | failed | aborted). `claimed` is a
// schedule-level detail folded into `running` (v2-D14) — there is no `queued`
// /`claimed` column here because the kanban reads `tasks.status` directly, no
// schedule join (AC1: "不 join schedules 即可显 running/failed/aborted").
//
// Replaces lib/task-pool.ts for the /tasks page. The old task-pool (7 columns
// against SchedulerJob) is retained for any legacy consumers but the /tasks
// domain now uses this Task-typed board.

import type { Task, TaskStatus } from "@octopus/shared"

/** The 6 first-class task lifecycle columns (v2-D14). `claimed` is folded into
 *  `running` — claim is a schedule-level detail, not a task state. Terminal:
 *  done | failed | aborted (G2: failed does NOT roll back; G4: aborted cleans
 *  workspace). Soft-deleted drafts carry `deleted_at`, not a status value. */
export type TaskBoardStatus = TaskStatus

export interface TaskBoardColumn {
  id: TaskBoardStatus
  label: string
}

/** Order matches the spec lifecycle: draft → ready → running → done, with the
 *  two terminal non-success states appended at the end (failed before aborted
 *  — failed is the "stopped with error" terminal, aborted is the
 *  "user-stopped" terminal). */
export const TASK_COLUMNS: readonly TaskBoardColumn[] = [
  { id: "draft", label: "草稿" },
  { id: "ready", label: "待执行" },
  { id: "running", label: "执行中" },
  { id: "done", label: "已完成" },
  { id: "failed", label: "失败" },
  { id: "aborted", label: "已中止" },
] as const

export type TasksByStatus = Record<TaskBoardStatus, Task[]>

/** Group tasks into the 6 lifecycle buckets. Tasks whose status is not a known
 *  column (defensive against future enum additions / legacy rows) are dropped
 *  rather than crashing the kanban — same defensive-narrowing boundary as the
 *  v1 groupJobsByStatus. Does NOT mutate the input array. */
export function groupTasksByStatus(tasks: Task[]): TasksByStatus {
  const grouped: TasksByStatus = {
    draft: [],
    ready: [],
    running: [],
    done: [],
    failed: [],
    aborted: [],
  }
  for (const task of tasks) {
    const status = task.status as string
    if (status in grouped) {
      ;(grouped as Record<string, Task[]>)[status].push(task)
    }
  }
  return grouped
}
