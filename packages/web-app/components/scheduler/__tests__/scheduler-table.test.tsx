// Scheduler table — origin column + conditional toggle (approach A, 2026-08-29).
// The scheduler list now spans all origins; each row declares its origin and
// one-shot (non-cron) rows must not render the enable/disable switch (server
// toggleJob 400s on them).
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
    trigger_source: "cron",
    source_chat_session_id: null,
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

describe("SchedulerTable origin column", () => {
  it("renders 定时 badge + toggle for cron-origin rows", () => {
    renderTable([makeJob({ id: "cron-1", origin_type: "cron" })])
    expect(screen.getByText("定时")).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  it("legacy rows without origin_type default to 定时 + toggle", () => {
    renderTable([makeJob({ id: "legacy-1" })])
    expect(screen.getByText("定时")).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
  })

  it("task-origin row renders 任务 badge deep-linking to the task board, and NO toggle", () => {
    renderTable([
      makeJob({
        id: "task-1",
        origin_type: "task",
        origin_id: "parent-task-abc",
        trigger_source: "requirement",
        cron_expression: null,
      }),
    ])
    const badge = screen.getByText("任务")
    expect(badge).toBeTruthy()
    const link = badge.closest("a")
    expect(link?.getAttribute("href")).toBe("/tasks?task=parent-task-abc")
    // 反假跑: one-shot row must not expose enable/disable (server would 400)
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
    // null cron_expression renders "-" inside the <code>, not the string "null"
    const cronCell = document.querySelector("code")
    expect(cronCell?.textContent).toBe("-")
    expect(screen.queryByText("null")).toBeNull()
  })

  it("origin filter column shows agent rows without toggle", () => {
    renderTable([makeJob({ id: "agent-1", origin_type: "agent", job_type: "agent" })])
    // "Agent" text exists twice (job-type badge + origin badge) — query by marker.
    expect(document.querySelector('[data-origin-badge="agent"]')).toBeTruthy()
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0)
  })
})
