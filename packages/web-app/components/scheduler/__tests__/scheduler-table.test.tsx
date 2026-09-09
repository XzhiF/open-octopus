// Scheduler table — the row-type column after ADR-0021 票03.
// The 来源 (origin_type/origin_id) column this file used to pin is gone with the
// schedules.origin_* columns: after schema v42 every row of this table IS a job
// definition, so the axis the table declares is job_type — workflow | agent | job.
// The 'job' member is the new one (a registered TypeScript handler; the system's
// built-in 系统 · 任务生命周期 is one), and it must render, not be filtered out.
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { SchedulerTable } from "../scheduler-table"
import type { SchedulerJob } from "@/lib/scheduler-api"

// StatusBadge mounts a Radix Tooltip (needs the provider only on trigger, not
// render); ActionMenu/ToggleSwitch hit scheduler-api on interaction only.
const noop = () => {}

function makeJob(overrides: Partial<SchedulerJob> & { id: string }): SchedulerJob {
  return {
    name: `job-${overrides.id}`,
    job_type: "workflow",
    cron_expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    config: {} as SchedulerJob["config"],
    parallel_policy: "skip",
    timeout_seconds: 3600,
    notify_on_failure: false,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: "2026-08-29T00:00:00Z",
    updated_at: "2026-08-29T00:00:00Z",
    status: "queued",
    claimed_at: null,
    ...overrides,
  } as SchedulerJob
}

function renderTable(jobs: SchedulerJob[]) {
  return render(
    <SchedulerTable
      jobs={jobs}
      onToggle={noop}
      onEdit={noop}
      onDelete={noop}
      onTrigger={noop}
    />,
  )
}

describe("SchedulerTable job_type column", () => {
  it("renders a Workflow badge + the enable/disable switch for a cron workflow job", () => {
    renderTable([makeJob({ id: "cron-1", job_type: "workflow" })])
    expect(screen.getByText("Workflow")).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  it("renders an Agent badge for a job_type='agent' row", () => {
    renderTable([makeJob({ id: "agent-1", job_type: "agent" })])
    expect(screen.getByText("Agent")).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  // 票03 (ADR-0021): the built-in task-lifecycle pump is a 'job' row in the same
  // table. Before this it had no badge of its own and would have read as "Agent".
  it("renders the new 'job' type (built-in 系统 · 任务生命周期) instead of hiding it", () => {
    renderTable([
      makeJob({
        id: "builtin-task-lifecycle",
        name: "系统 · 任务生命周期",
        job_type: "job",
        cron_expression: "* * * * *",
      }),
    ])
    const badge = screen.getByText("Job")
    expect(badge).toBeTruthy()
    // The row is a normal job: named, deep-linkable, and switchable (toggleJob has
    // no origin to reject on any more).
    expect(screen.getByText("系统 · 任务生命周期")).toBeTruthy()
    expect(screen.getByRole("link", { name: "查看任务 系统 · 任务生命周期" })).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  it("a cron-less job renders '-' in the cron cell, not the string 'null'", () => {
    renderTable([makeJob({ id: "once-1", cron_expression: null })])
    const cronCell = document.querySelector("code")
    expect(cronCell?.textContent).toBe("-")
    expect(screen.queryByText("null")).toBeNull()
  })
})
