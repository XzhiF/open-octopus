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

// Mock sse-manager: capture the task_status listener so the test can drive it.
let sseListener: ((e: { data: string }) => void) | null = null
const unsubSpy = vi.fn()
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn((_url: string, _eventType: string, listener: (e: { data: string }) => void) => {
    sseListener = listener
    return unsubSpy
  }),
}))

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
    sseListener = null
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

    expect(sseListener).not.toBeNull()
    // Dispatch a task_status event for the parent task (ScheduleStatusListener
    // emits with task_id = parent; schedule_id = the child that transitioned).
    await act(async () => {
      sseListener!({ data: JSON.stringify({ task_id: "parent-1", status: "running", schedule_id: "child-1" }) })
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
