import { describe, it, expect } from "vitest"
import { groupJobsByStatus, TASK_POOL_COLUMNS, type TaskPoolStatus } from "../task-pool"
import type { SchedulerJob } from "../scheduler-api"

function makeJob(partial: Partial<SchedulerJob> & { id: string }): SchedulerJob {
  return {
    name: partial.name ?? partial.id,
    job_type: 'workflow',
    cron_expression: null,
    timezone: 'UTC',
    enabled: false,
    config: { schema_version: '2.0', type: 'workflow', workspace_spec: { org: 'x', branch_prefix: 'b', projects: [{ name: 'p', source_path: '', group: '' }] }, workflow_chain: [], max_retain: 1 },
    parallel_policy: 'allow',
    timeout_seconds: 0,
    notify_on_failure: false,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: '2026-08-15T00:00:00Z',
    updated_at: '2026-08-15T00:00:00Z',
    trigger_source: 'requirement',
    source_chat_session_id: null,
    claimed_at: null,
    ...partial,
  } as SchedulerJob
}

describe("TASK_POOL_COLUMNS", () => {
  it("exposes 7 columns including failed + aborted (ticket 12, G2)", () => {
    const ids = TASK_POOL_COLUMNS.map(c => c.id)
    expect(ids).toEqual([
      'draft', 'queued', 'claimed', 'running', 'done', 'failed', 'aborted',
    ])
  })
})

describe("groupJobsByStatus", () => {
  it("returns all 7 buckets even when input is empty (AC5 反假跑)", () => {
    const grouped = groupJobsByStatus([])
    const bucketKeys = Object.keys(grouped).sort()
    const expected = TASK_POOL_COLUMNS.map(c => c.id).sort()
    expect(bucketKeys).toEqual(expected)
    for (const key of expected as TaskPoolStatus[]) {
      expect(grouped[key]).toEqual([])
    }
  })

  it("places jobs into matching status bucket", () => {
    const jobs = [
      makeJob({ id: 'a', status: 'draft' as never, name: '草稿A' }),
      makeJob({ id: 'b', status: 'queued' as never, name: '排队B' }),
      makeJob({ id: 'c', status: 'claimed' as never, name: '已认领C' }),
    ]
    const grouped = groupJobsByStatus(jobs)
    expect(grouped.draft.map(j => j.id)).toEqual(['a'])
    expect(grouped.queued.map(j => j.id)).toEqual(['b'])
    expect(grouped.claimed.map(j => j.id)).toEqual(['c'])
    expect(grouped.running).toEqual([])
    expect(grouped.done).toEqual([])
    expect(grouped.failed).toEqual([])
    expect(grouped.aborted).toEqual([])
  })

  it("buckets failed and aborted jobs into their own columns (G2)", () => {
    const jobs = [
      makeJob({ id: 'f', status: 'failed' as never, name: '失败任务' }),
      makeJob({ id: 'ab', status: 'aborted' as never, name: '中止任务' }),
    ]
    const grouped = groupJobsByStatus(jobs)
    expect(grouped.failed.map(j => j.id)).toEqual(['f'])
    expect(grouped.aborted.map(j => j.id)).toEqual(['ab'])
    // must NOT leak into running/done (the stale-loop regression G2 fixes)
    expect(grouped.running).toEqual([])
    expect(grouped.done).toEqual([])
  })

  it("drops jobs with unknown status values (defensive)", () => {
    const jobs = [
      makeJob({ id: 'a', status: 'draft' as never }),
      makeJob({ id: 'b', status: 'enabled' as never }), // cron legacy status, not in kanban
    ]
    const grouped = groupJobsByStatus(jobs)
    expect(grouped.draft.map(j => j.id)).toEqual(['a'])
    expect(Object.keys(grouped).sort()).toEqual(TASK_POOL_COLUMNS.map(c => c.id).sort())
  })

  it("buckets running and done jobs when those statuses appear", () => {
    const jobs = [
      makeJob({ id: 'r', status: 'running' as never }),
      makeJob({ id: 'd', status: 'done' as never }),
    ]
    const grouped = groupJobsByStatus(jobs)
    expect(grouped.running.map(j => j.id)).toEqual(['r'])
    expect(grouped.done.map(j => j.id)).toEqual(['d'])
  })

  it("does not mutate input jobs array", () => {
    const jobs = [makeJob({ id: 'a', status: 'draft' as never })]
    const snapshot = [...jobs]
    groupJobsByStatus(jobs)
    expect(jobs).toEqual(snapshot)
  })
})
