import type { SchedulerJob } from "@/lib/scheduler-api"

/** Lifecycle columns rendered on the /tasks kanban (G2: failed + aborted are terminal
 *  columns — checkStaleClaimed must NOT roll them back to queued). Order matches the
 *  spec lifecycle: draft → queued → claimed → running → done, with the two terminal
 *  non-success states appended at the end. */
export type TaskPoolStatus = 'draft' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'aborted'

export interface TaskPoolColumn {
  id: TaskPoolStatus
  label: string
}

export const TASK_POOL_COLUMNS: readonly TaskPoolColumn[] = [
  { id: 'draft', label: '草稿' },
  { id: 'queued', label: '待执行' },
  { id: 'claimed', label: '已认领' },
  { id: 'running', label: '执行中' },
  { id: 'done', label: '已完成' },
  { id: 'failed', label: '失败' },
  { id: 'aborted', label: '已中止' },
] as const

export type JobsByStatus = Record<TaskPoolStatus, SchedulerJob[]>

export function groupJobsByStatus(jobs: SchedulerJob[]): JobsByStatus {
  const empty: JobsByStatus = {
    draft: [],
    queued: [],
    claimed: [],
    running: [],
    done: [],
    failed: [],
    aborted: [],
  }
  const grouped: JobsByStatus = { ...empty }
  for (const job of jobs) {
    // ScheduleStatus is the full 7-value lifecycle union (shared, G6). The cast is
    // retained only as a defensive narrowing boundary against legacy cron rows
    // whose status ('enabled'/'disabled') is not a kanban column — they're dropped.
    const status = job.status as string as TaskPoolStatus
    if (status in grouped) grouped[status].push(job)
  }
  return grouped
}
