import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { TaskSpec } from "@octopus/shared"

// Mock tasks-api: getTask returns a composite TaskDetail (Task + executions).
vi.mock("@/lib/tasks-api", () => ({
  getTask: vi.fn(),
  abortTask: vi.fn(),
  listTasks: vi.fn(),
  readyTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  createTask: vi.fn(),
  updateSpecField: vi.fn(),
}))

// Mock sse-manager: capture listeners per event type so the test can drive both
// `task_status` (the task row) and `task_execution` (each run) SSE.
// 票03 (ADR-0021): the per-child `schedule_status` events left with the envelope
// rows — a task's runs now announce themselves as task_execution.
const sseListeners = new Map<string, (e: { data: string }) => void>()
const unsubSpies: Array<ReturnType<typeof vi.fn>> = []
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(
    (_url: string, eventType: string, listener: (e: { data: string }) => void) => {
      sseListeners.set(eventType, listener)
      const spy = vi.fn()
      unsubSpies.push(spy)
      return spy
    },
  ),
}))

/** Dispatch a captured SSE listener for the given event type. */
function dispatchSSE(eventType: string, data: unknown): void {
  const listener = sseListeners.get(eventType)
  if (!listener) throw new Error(`no SSE listener registered for "${eventType}"`)
  listener({ data: JSON.stringify(data) })
}

// Mock next/navigation router to assert the workspace deep-link (票03 drill-down).
const pushSpy = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn(), refresh: vi.fn() }),
}))

// Mock the DAG component to avoid rendering ReactFlow in jsdom.
vi.mock("@/components/tasks/composite-dag", () => ({
  CompositeDag: ({ dag }: { dag: unknown }) => (
    <div data-testid="composite-dag" data-dag={JSON.stringify(dag)} />
  ),
}))

// Mock sonner toast.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}))

// Mock server-config.
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import { getTask } from "@/lib/tasks-api"
import { CompositeMode } from "../task-modal"
import type { TaskExecutionBadge, TaskView } from "@/lib/tasks-api"

const mockGetTask = vi.mocked(getTask)

// ── Fixtures ─────────────────────────────────────────────────────────

const COMPOSITE_SPEC: TaskSpec = {
  goal: "g",
  ac: ["a"],
  resources: [],
  authoring_resources: [],
  skill_groups: [],
  decisions: [],
  ac_confirmed: [],
  subunits: [
    { name: "子1", workflow_ref: "wf-a", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
    { name: "子2", workflow_ref: "wf-b", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
    { name: "子3", workflow_ref: "wf-c", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
  ],
  integration_goal: { strategy: "synthesis" },
}

/** GET /:id 的 TaskDTO：票05 起 = shared `Task`（trigger_* 全在共享契约上）。缺省 = 手动、无游标。 */
function makeParentTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "parent-1",
    org: "test",
    name: "E2E_TD_复合任务",
    status: "running",
    task_spec: COMPOSITE_SPEC,
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    trigger_mode: "manual",
    trigger_at: null,
    cron_expression: null,
    cron_timezone: "Asia/Shanghai",
    trigger_enabled: true,
    next_fire_at: null,
    last_fired_at: null,
    execution: null,
    ...overrides,
  } as TaskView
}

/** One run row — the SHARED TaskExecutionBadge (票05: single source, no mirror).
 *  Composite fan-out arms arrive as `children` of their root and label themselves
 *  via `name` (dispatchChildRun wrote subunit.name onto the row). */
function makeRun(overrides: Partial<TaskExecutionBadge> & { id: string }): TaskExecutionBadge {
  return {
    status: "running",
    workflow_ref: "wf-a",
    name: null,
    phase_index: null,
    round_index: null,
    workspace_id: `ws-${overrides.id}`,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    error_summary: null,
    ...overrides,
  }
}

// 票05 读模型：composite detail 的 executions = [协调器根行]，三条子单元臂挂在它的
// children 上，臂名在行上（子1/子2/子3 = spec 里的 subunit 名，派发时写进行）。
const ARMS: TaskExecutionBadge[] = [
  makeRun({ id: "arm-1", workflow_ref: "wf-a", name: "子1", status: "running" }),
  makeRun({ id: "arm-2", workflow_ref: "wf-b", name: "子2", status: "pending" }),
  makeRun({ id: "arm-3", workflow_ref: "wf-c", name: "子3", status: "completed" }),
]
const DEFAULT_ROOT = makeRun({
  id: "run-1", workflow_ref: "task-composite", status: "running", children: ARMS,
})

const DEFAULT_RUNS = [DEFAULT_ROOT]

function makeDetail(overrides: Partial<TaskView> & { executions?: TaskExecutionBadge[] } = {}): TaskView & { executions: TaskExecutionBadge[] } {
  const { executions, ...taskOverrides } = overrides
  return {
    ...makeParentTask(taskOverrides),
    executions: executions ?? DEFAULT_RUNS,
  }
}

describe("CompositeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sseListeners.clear()
    unsubSpies.length = 0
  })

  it("renders DAG, root card + named fan-out arms, and integration node from TaskDetail", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // 协调器根行 + 其 children 里的三条子单元臂（票05：臂名在行上 = badge.name）。
    expect(screen.getByTestId("composite-child-run-1")).toBeDefined()
    expect(screen.getByTestId("composite-arm-arm-1").textContent).toContain("子1")
    expect(screen.getByTestId("composite-arm-arm-2").textContent).toContain("子2")
    expect(screen.getByTestId("composite-arm-arm-3").textContent).toContain("子3")

    // Integration node surfaced.
    expect(screen.getByTestId("composite-integration")).toBeDefined()

    // Aggregate status: an arm is in flight (running / pending) → aggregate running.
    expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/running|执行中/)
  })

  // 票05 契约 §新事实-4：臂的标签来自行上的 name —— 取代 schedules.origin_role 与
  // 「workflow_ref 反查 spec」的旧命名链。name 优先，且不必命中 spec。
  it("arm labels come from the badge's own name, not a spec match", async () => {
    mockGetTask.mockResolvedValue(makeDetail({
      executions: [makeRun({
        id: "run-1", workflow_ref: "task-composite",
        children: [makeRun({ id: "arm-x", workflow_ref: "wf-unbound", name: "独立臂" })],
      })],
    }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    const arm = await screen.findByTestId("composite-arm-arm-x")
    expect(arm.textContent).toContain("独立臂")
  })

  // children === undefined = 读模型没载 fan-out（如旧服务端），[] = 载了且没有 ——
  // 两者都只能「不渲染臂」，不得出现「无子单元」式的空态断言。
  it("children undefined / empty → no arm rows and no 「无子单元」 claim", async () => {
    mockGetTask.mockResolvedValue(makeDetail({
      executions: [makeRun({ id: "run-1", workflow_ref: "task-composite", children: [] })],
    }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-child-run-1")).toBeDefined()
    })
    expect(screen.queryByText(/无子单元/)).toBeNull()
    expect(screen.queryByTestId("composite-arms-run-1")).toBeNull()
  })

  it("red arm shows its error_summary; a green arm hides a residual one", async () => {
    mockGetTask.mockResolvedValue(makeDetail({
      executions: [makeRun({
        id: "run-1", workflow_ref: "task-composite",
        children: [
          makeRun({ id: "arm-r", workflow_ref: "wf-a", name: "子1", status: "failed", error_summary: "子单元 1 崩了" }),
          makeRun({ id: "arm-g", workflow_ref: "wf-b", name: "子2", status: "completed", error_summary: "遗留键" }),
        ],
      })],
    }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    expect((await screen.findByTestId("composite-arm-arm-r")).textContent).toContain("子单元 1 崩了")
    expect(screen.getByTestId("composite-arm-arm-g").textContent).not.toContain("遗留键")
  })

  it("clicking an arm deep-links the arm's OWN workspace (票05 children)", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    const arm = await screen.findByTestId("composite-arm-arm-2")
    fireEvent.click(arm)

    expect(pushSpy).toHaveBeenCalledWith("/workspaces/ws-arm-2?tab=detail&execId=arm-2")
  })

  it("aggregate status becomes done when all arms completed + parent done", async () => {
    mockGetTask.mockResolvedValue(makeDetail({
      status: "done",
      executions: [makeRun({
        id: "run-1", workflow_ref: "task-composite", status: "completed",
        children: [
          makeRun({ id: "arm-1", workflow_ref: "wf-a", name: "子1", status: "completed" }),
          makeRun({ id: "arm-2", workflow_ref: "wf-b", name: "子2", status: "completed" }),
          makeRun({ id: "arm-3", workflow_ref: "wf-c", name: "子3", status: "completed" }),
        ],
      })],
    }) as never)

    render(<CompositeMode task={makeParentTask({ status: "done" })} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/done|完成/)
    })
  })

  it("aggregate status is failed if any arm failed", async () => {
    mockGetTask.mockResolvedValue(makeDetail({
      status: "running",
      executions: [makeRun({
        id: "run-1", workflow_ref: "task-composite",
        children: [
          makeRun({ id: "arm-1", workflow_ref: "wf-a", name: "子1", status: "failed", error_summary: "3 个子单元执行失败" }),
          makeRun({ id: "arm-2", workflow_ref: "wf-b", name: "子2", status: "completed" }),
        ],
      })],
    }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/failed|失败/)
    })
  })

  it("subscribes to SSE task_status and re-fetches on parent event", async () => {
    mockGetTask
      .mockResolvedValueOnce(makeDetail() as never)
      .mockResolvedValueOnce(makeDetail({
        status: "done",
        executions: [
          makeRun({ id: "run-1", workflow_ref: "wf-a", status: "completed" }),
          makeRun({ id: "run-2", workflow_ref: "wf-b", status: "completed" }),
          makeRun({ id: "run-3", workflow_ref: "wf-c", status: "completed" }),
        ],
      }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // The modal listens to BOTH the task row and its runs (票03 event pair).
    expect(sseListeners.has("task_status")).toBe(true)
    expect(sseListeners.has("task_execution")).toBe(true)
    // task_status now carries no schedule handle at all — just the task.
    await act(async () => {
      dispatchSSE("task_status", { task_id: "parent-1", status: "done" })
    })

    // getTask called a second time (re-fetch).
    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledTimes(2)
    })

    // Aggregate now done.
    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/done|完成/)
    })
  })

  // ── task_execution SSE for run transitions (票03 replacement of schedule_status) ──

  it("task_execution for this task re-fetches + refreshes the run card", async () => {
    mockGetTask
      .mockResolvedValueOnce(makeDetail() as never)
      .mockResolvedValueOnce(makeDetail({
        executions: [
          makeRun({ id: "run-1", workflow_ref: "wf-a", status: "completed" }),
          makeRun({ id: "run-2", workflow_ref: "wf-b", status: "running" }),
          makeRun({ id: "run-3", workflow_ref: "wf-c", status: "completed" }),
        ],
      }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-child-run-1")).toBeDefined()
    })

    // Before: run-1 is "running" (from the default fixture).
    expect(screen.getByTestId("composite-child-run-1").textContent).toMatch(/执行中|running/)

    // The built-in task-lifecycle job announces a run reaching its terminal state
    // with {task_id, execution_id, status} — the modal must catch it + refetch.
    await act(async () => {
      dispatchSSE("task_execution", { task_id: "parent-1", execution_id: "run-1", status: "completed" })
    })

    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledTimes(2)
    })

    // After refetch, run-1's card reflects the new state.
    await waitFor(() => {
      expect(screen.getByTestId("composite-child-run-1").textContent).toMatch(/成功|completed/)
    })
  })

  it("task_execution for another task is ignored (no refetch)", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    const callsBefore = mockGetTask.mock.calls.length

    // A run belonging to a different task — must not trigger work.
    await act(async () => {
      dispatchSSE("task_execution", { task_id: "someone-else", execution_id: "run-x", status: "running" })
    })

    expect(mockGetTask.mock.calls.length).toBe(callsBefore)
  })

  it("task_execution naming a subunit surfaces in the events panel with that label", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })

    await act(async () => {
      dispatchSSE("task_execution", {
        task_id: "parent-1", execution_id: "run-child-9", subunit: "子2", status: "running",
      })
    })

    // The panel shows the label the event carries (a fan-out child is not in the
    // root-only executions[] list, so its name comes from the payload) — not a raw id.
    await waitFor(() => {
      const panel = screen.getByTestId("composite-events-panel")
      expect(panel.textContent).toContain("子2")
    })
  })

  // 票05 §新事实-2：task_execution 的 `reason` 是失败/回收路径专属的一行原因 ——
  // 事件面板要显示它；绿状态的遗留 reason 绝不显示（pushEvent 按状态门控）。
  it("task_execution carries the failure reason into the events panel; green rows drop it", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })

    await act(async () => {
      dispatchSSE("task_execution", {
        task_id: "parent-1", execution_id: "arm-2", status: "aborted", reason: "用户中止",
      })
    })
    await waitFor(() => {
      const panel = screen.getByTestId("composite-events-panel")
      expect(panel.textContent).toContain("用户中止")
    })

    await act(async () => {
      dispatchSSE("task_execution", {
        task_id: "parent-1", execution_id: "arm-3", status: "completed", reason: "遗留键不应露出",
      })
    })
    await waitFor(() => {
      const panel = screen.getByTestId("composite-events-panel")
      expect(panel.textContent).toContain("成功") // completed 行进来了…
      expect(panel.textContent).not.toContain("遗留键不应露出") // …但绿行没有原因
    })
  })

  it("does not re-subscribe to SSE when detail refetches (stable subscription)", async () => {
    // detail must NOT be in the SSE effect deps — refetching should not tear down +
    // re-create the subscription (risks missing events in the gap). The handler reads
    // fresh runs from a ref instead.
    const { subscribeSSE } = await import("@/lib/sse-manager")
    const subscribeSpy = vi.mocked(subscribeSSE)

    mockGetTask
      .mockResolvedValueOnce(makeDetail() as never)
      .mockResolvedValueOnce(makeDetail({
        status: "done",
        executions: [
          makeRun({ id: "run-1", workflow_ref: "wf-a", status: "completed" }),
          makeRun({ id: "run-2", workflow_ref: "wf-b", status: "completed" }),
          makeRun({ id: "run-3", workflow_ref: "wf-c", status: "completed" }),
        ],
      }) as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Snapshot the subscription count after initial mount (3: task_status +
    // task_execution + project_sync).
    const subsAfterMount = subscribeSpy.mock.calls.length

    // Trigger a refetch via a parent task_status event.
    await act(async () => {
      dispatchSSE("task_status", { task_id: "parent-1", status: "done" })
    })
    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledTimes(2)
    })

    // No new subscribe calls — the subscription survived the refetch.
    expect(subscribeSpy.mock.calls.length).toBe(subsAfterMount)
    // And no unsubscribe happened either.
    expect(unsubSpies.every((s) => s.mock.calls.length === 0)).toBe(true)
  })

  it("project_sync SSE → task-filtered toast chain (loading → success / error)", async () => {
    // repo-sync (2026-09-08, 特性A)：syncing 挂 loading、ok 原地替换 success、
    // failed error（代码可能过期）；非本任务事件不弹。
    const { toast } = await import("sonner")
    mockGetTask.mockResolvedValue(makeDetail() as never)
    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByTestId("composite-dag")).toBeDefined() })

    await act(async () => {
      dispatchSSE("project_sync", { task_id: "parent-1", project: "demo", status: "syncing" })
    })
    expect(toast.loading).toHaveBeenCalledWith(expect.stringContaining("demo"), { id: "repo-sync-parent-1" })

    await act(async () => {
      dispatchSSE("project_sync", { task_id: "parent-1", project: "demo", status: "ok", branch: "main", commit: "c0ffee00" })
    })
    expect(toast.success).toHaveBeenCalledWith("仓库已同步：demo main@c0ffee00", { id: "repo-sync-parent-1" })

    await act(async () => {
      dispatchSSE("project_sync", { task_id: "parent-1", project: "demo", status: "failed", error: "network down" })
    })
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("代码可能过期"), { id: "repo-sync-parent-1" })

    // 别的任务 → 不再追加调用
    const n = (toast.error as ReturnType<typeof vi.fn>).mock.calls.length
    await act(async () => {
      dispatchSSE("project_sync", { task_id: "someone-else", project: "x", status: "ok" })
    })
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n)
    expect((toast.success as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("clicking a run card deep-links that execution in its workspace (票03)", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Click the first run card. The badge carries (workspace_id, id) itself, so the
    // 404-route fallback (/tasks/:id/children/:sid) is gone.
    const runCard = screen.getByTestId("composite-child-run-1")
    fireEvent.click(runCard)

    expect(pushSpy).toHaveBeenCalledWith("/workspaces/ws-run-1?tab=detail&execId=run-1")
  })

  it("renders the real-time SSE events panel", async () => {
    mockGetTask.mockResolvedValue(makeDetail() as never)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })
  })
})
