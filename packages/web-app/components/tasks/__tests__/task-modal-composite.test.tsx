import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"

// Mock tasks-api: getTask returns a composite TaskDetail (Task + children).
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

// Mock sse-manager: capture listeners per event type so the test can drive
// both `task_status` (parent mirror) and `schedule_status` (per-child) SSE.
// ticket 11: CompositeMode subscribes to BOTH event types on the same URL.
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

// Mock next/navigation router to assert drill-down navigation (SG15 retarget).
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
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Mock server-config.
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import { getTask } from "@/lib/tasks-api"
import { CompositeMode } from "../task-modal"
import type { TaskDetail } from "@/lib/tasks-api"

const mockGetTask = vi.mocked(getTask)

// ── Fixtures ─────────────────────────────────────────────────────────

const COMPOSITE_SPEC: TaskSpec = {
  goal: "g",
  ac: ["a"],
  resources: [],
  authoring_resources: [],
  subunits: [
    { name: "子1", workflow_ref: "wf-a", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
    { name: "子2", workflow_ref: "wf-b", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
    { name: "子3", workflow_ref: "wf-c", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [], resources: [] },
  ],
  integration_goal: { strategy: "synthesis" },
}

function makeParentTask(overrides: Partial<Task> = {}): Task {
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
    ...overrides,
  } as Task
}

function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const { children, ...taskOverrides } = overrides
  return {
    ...makeParentTask(taskOverrides),
    children: children ?? [
      { schedule_id: "child-1", name: "子1", status: "running", origin_role: "subunit", workflow_ref: "wf-a" },
      { schedule_id: "child-2", name: "子2", status: "queued", origin_role: "subunit", workflow_ref: "wf-b" },
      { schedule_id: "child-3", name: "子3", status: "done", origin_role: "subunit", workflow_ref: "wf-c" },
    ],
  } as TaskDetail
}

describe("CompositeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sseListeners.clear()
    unsubSpies.length = 0
  })

  it("renders DAG, child cards, and integration node from TaskDetail", async () => {
    mockGetTask.mockResolvedValue(makeDetail())

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Three child cards with workflow_ref + status.
    expect(screen.getByText("wf-a")).toBeDefined()
    expect(screen.getByText("wf-b")).toBeDefined()
    expect(screen.getByText("wf-c")).toBeDefined()

    // Integration node surfaced.
    expect(screen.getByTestId("composite-integration")).toBeDefined()

    // Aggregate status: child running → aggregate running.
    expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/running|执行中/)
  })

  it("aggregate status becomes done when all children done + parent done", async () => {
    const detail = makeDetail({
      status: "done",
      children: [
        { schedule_id: "child-1", name: "子1", status: "done", origin_role: "subunit", workflow_ref: "wf-a" },
        { schedule_id: "child-2", name: "子2", status: "done", origin_role: "subunit", workflow_ref: "wf-b" },
        { schedule_id: "child-3", name: "子3", status: "done", origin_role: "subunit", workflow_ref: "wf-c" },
      ],
    })
    mockGetTask.mockResolvedValue(detail)

    render(<CompositeMode task={makeParentTask({ status: "done" })} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/done|完成/)
    })
  })

  it("aggregate status is failed if any child failed", async () => {
    const detail = makeDetail({
      status: "running",
      children: [
        { schedule_id: "child-1", name: "子1", status: "failed", origin_role: "subunit", workflow_ref: "wf-a" },
        { schedule_id: "child-2", name: "子2", status: "done", origin_role: "subunit", workflow_ref: "wf-b" },
      ],
    })
    mockGetTask.mockResolvedValue(detail)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/failed|失败/)
    })
  })

  it("subscribes to SSE task_status and re-fetches on parent event", async () => {
    const first = makeDetail()
    const second = makeDetail({
      status: "done",
      children: [
        { schedule_id: "child-1", name: "子1", status: "done", origin_role: "subunit", workflow_ref: "wf-a" },
        { schedule_id: "child-2", name: "子2", status: "done", origin_role: "subunit", workflow_ref: "wf-b" },
        { schedule_id: "child-3", name: "子3", status: "done", origin_role: "subunit", workflow_ref: "wf-c" },
      ],
    })
    mockGetTask.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // ticket 11: CompositeMode subscribes to BOTH task_status + schedule_status.
    expect(sseListeners.has("task_status")).toBe(true)
    expect(sseListeners.has("schedule_status")).toBe(true)
    // Dispatch a task_status event for the parent task (ScheduleStatusListener
    // emits with task_id = parent; schedule_id = the child that transitioned).
    await act(async () => {
      dispatchSSE("task_status", { task_id: "parent-1", status: "running", schedule_id: "child-1" })
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

  // ── ticket 11: schedule_status SSE for child transitions (AC2) ───────

  it("schedule_status for a child schedule re-fetches + refreshes the child card", async () => {
    const first = makeDetail()
    const second = makeDetail({
      children: [
        { schedule_id: "child-1", name: "子1", status: "done", origin_role: "subunit", workflow_ref: "wf-a" },
        { schedule_id: "child-2", name: "子2", status: "running", origin_role: "subunit", workflow_ref: "wf-b" },
        { schedule_id: "child-3", name: "子3", status: "done", origin_role: "subunit", workflow_ref: "wf-c" },
      ],
    })
    mockGetTask.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-child-child-1")).toBeDefined()
    })

    // Before: child-1 is "running" (from makeDetail default).
    expect(screen.getByTestId("composite-child-child-1").textContent).toMatch(/执行中|running/)

    // A child schedule transition (queued→running→done) emits schedule_status
    // {schedule_id, status} on the taskpool channel (task-dispatch-service /
    // workflow-executor). CompositeMode must catch it + refetch.
    await act(async () => {
      dispatchSSE("schedule_status", { schedule_id: "child-1", status: "done" })
    })

    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledTimes(2)
    })

    // After refetch, child-1 card reflects "done".
    await waitFor(() => {
      expect(screen.getByTestId("composite-child-child-1").textContent).toMatch(/完成|done/)
    })
  })

  it("schedule_status for an unrelated schedule is ignored (no refetch)", async () => {
    mockGetTask.mockResolvedValue(makeDetail())

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    const callsBefore = mockGetTask.mock.calls.length

    // A schedule that isn't one of this task's children — must not trigger work.
    await act(async () => {
      dispatchSSE("schedule_status", { schedule_id: "unrelated-schedule", status: "running" })
    })

    // No refetch (give the scheduler a beat to prove it).
    expect(mockGetTask.mock.calls.length).toBe(callsBefore)
  })

  it("schedule_status for a child surfaces in the events panel labelled with the child name", async () => {
    mockGetTask.mockResolvedValue(makeDetail())

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })

    await act(async () => {
      dispatchSSE("schedule_status", { schedule_id: "child-2", status: "running" })
    })

    // The events panel shows the child's name (子2) — not a raw schedule id.
    await waitFor(() => {
      const panel = screen.getByTestId("composite-events-panel")
      expect(panel.textContent).toContain("子2")
    })
  })

  it("does not re-subscribe to SSE when detail refetches (stable subscription)", async () => {
    // ticket 11: detail must NOT be in the SSE effect deps — refetching should
    // not tear down + re-create the subscription (risks missing events in the
    // gap). The handler reads fresh children from a ref instead.
    const { subscribeSSE } = await import("@/lib/sse-manager")
    const subscribeSpy = vi.mocked(subscribeSSE)

    mockGetTask.mockResolvedValueOnce(makeDetail()).mockResolvedValueOnce(
      makeDetail({
        status: "done",
        children: [
          { schedule_id: "child-1", name: "子1", status: "done", origin_role: "subunit", workflow_ref: "wf-a" },
          { schedule_id: "child-2", name: "子2", status: "done", origin_role: "subunit", workflow_ref: "wf-b" },
          { schedule_id: "child-3", name: "子3", status: "done", origin_role: "subunit", workflow_ref: "wf-c" },
        ],
      }),
    )

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Snapshot the subscription count after initial mount (2: task_status +
    // schedule_status).
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

  it("clicking a child card navigates to /tasks/:taskId/children/:scheduleId (SG15)", async () => {
    mockGetTask.mockResolvedValue(makeDetail())

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Click the first child card.
    const childCard = screen.getByTestId("composite-child-child-1")
    fireEvent.click(childCard)

    // SG15: retargeted from /scheduler/jobs/:id → /tasks/:taskId/children/:scheduleId
    expect(pushSpy).toHaveBeenCalledWith("/tasks/parent-1/children/child-1")
  })

  it("renders the real-time SSE events panel", async () => {
    mockGetTask.mockResolvedValue(makeDetail())

    render(<CompositeMode task={makeParentTask()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })
  })
})
