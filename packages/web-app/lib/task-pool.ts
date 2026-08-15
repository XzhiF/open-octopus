import type { SchedulerJob } from "@/lib/scheduler-api"

export type TaskPoolStatus = 'draft' | 'queued' | 'claimed' | 'running' | 'done'

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
] as const

export type JobsByStatus = Record<TaskPoolStatus, SchedulerJob[]>

export function groupJobsByStatus(jobs: SchedulerJob[]): JobsByStatus {
  const empty: JobsByStatus = {
    draft: [],
    queued: [],
    claimed: [],
    running: [],
    done: [],
  }
  const grouped: JobsByStatus = { ...empty }
  for (const job of jobs) {
    // ponytail: cast through string — ScheduleStatus type currently narrower (3 values)
    // than the 5 kanban columns spec'd in brief D5; T-1/T-3 may extend later.
    const status = job.status as string as TaskPoolStatus
    if (status in grouped) grouped[status].push(job)
  }
  return grouped
}
