// Scheduler table — the row-type column after ADR-0021 票03.
// The 来源 (origin_type/origin_id) column this file used to pin is gone with the
// schedules.origin_* columns: after schema v42 every row of this table IS a job
// definition, so the axis the table declares is job_type — workflow | agent | job.
// The 'job' member is the new one (a registered TypeScript handler; the system's
// built-in 系统 · 任务生命周期 is one), and it must render, not be filtered out.
import { describe, it, expect } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

// ── 票05: 内置 job 行「可暂停、不可删」；job_type='job' 无编辑表单 ──────
//
// 判据不是「行藏起来了」而是菜单里没有那个动作：暂停开关照常（全系统定时启动的
// 总闸就要能拨），删除入口对 builtin- 前缀行不渲染（删掉 = 静默停摆且 seed 不复活），
// 编辑入口对 job 类型不渲染（SchedulerForm 只能表达 workflow/agent 两类 config，
// 给内置行开表单 = 提交时把 handler 指针盖成 agent 形状）。

async function openMenuForRow(jobName: string) {
  const link = screen.getByRole("link", { name: `查看任务 ${jobName}` })
  const row = link.closest("tr")!
  await userEvent.click(row.querySelector('button[aria-label="操作菜单"]')!)
}

describe("SchedulerTable 操作菜单 gating", () => {
  it("普通 workflow 行：编辑/手动触发/删除全在", async () => {
    renderTable([makeJob({ id: "cron-1", name: "夜间构建", job_type: "workflow" })])
    await openMenuForRow("夜间构建")
    await waitFor(() => expect(screen.getByText("编辑")).toBeTruthy())
    expect(screen.getByText("手动触发")).toBeTruthy()
    expect(screen.getByText("删除")).toBeTruthy()
  })

  it("内置 系统 · 任务生命周期 行：可暂停/可手动触发，菜单里既无删除也无编辑", async () => {
    renderTable([
      makeJob({
        id: "builtin-task-lifecycle",
        name: "系统 · 任务生命周期",
        job_type: "job",
        cron_expression: "* * * * *",
      }),
    ])
    // 暂停开关存在（行可见且可停 = 契约的「可暂停」）。
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(1)
    await openMenuForRow("系统 · 任务生命周期")
    await waitFor(() => expect(screen.getByText("手动触发")).toBeTruthy())
    expect(screen.queryByText("删除")).toBeNull()
    expect(screen.queryByText("编辑")).toBeNull()
  })

  it("用户创建的 job 行（非 builtin- 前缀）：可删，但仍不可编辑", async () => {
    renderTable([makeJob({ id: "job-7f3a", name: "自定义作业", job_type: "job" })])
    await openMenuForRow("自定义作业")
    await waitFor(() => expect(screen.getByText("删除")).toBeTruthy())
    expect(screen.queryByText("编辑")).toBeNull()
  })
})

// ── 票06 手测⑤：系统调度页的内置 job 一行要能看出「上次触发与耗时」 ──────
//
// server 侧那半截（schedule_executions.duration_ms → DTO）由 scheduler-routes 的用例钉，
// 这里钉的是最后一步：数字进了 wire 却没被念出来，等于没有。

describe("SchedulerTable 上次触发列的耗时", () => {
  const fired = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString()

  it("有 duration_ms 就一起念出来", () => {
    renderTable([
      makeJob({
        id: "builtin-task-lifecycle",
        name: "系统 · 任务生命周期",
        job_type: "job",
        last_execution: {
          status: "success", triggered_at: fired(1), duration_ms: 45_200, error_summary: null,
        },
      }),
    ])
    // 念法来自 lib/format.ts 的 formatDuration（45200 → "45s"）——这里钉的是「数字进了
    // 这一列」，具体档位由 format.ts 自己的用例管，抄一份档位断言就是造第二个真相源。
    expect(screen.getByText(/耗时 45s/)).toBeTruthy()
  })

  it("没有耗时的行不编一个 0（skip/miss 那一轮没有引擎可计时）", () => {
    renderTable([
      makeJob({
        id: "cron-1",
        name: "夜间构建",
        last_execution: {
          status: "skipped", triggered_at: fired(2), duration_ms: null, error_summary: null,
        },
      }),
    ])
    expect(screen.queryByText(/耗时/)).toBeNull()
    expect(screen.getByText(/分钟前/)).toBeTruthy()
  })
})
