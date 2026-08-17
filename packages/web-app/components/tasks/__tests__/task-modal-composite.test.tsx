import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

// Mock scheduler-api: getJob returns a composite JobDetail.
vi.mock("@/lib/scheduler-api", () => ({
  getJob: vi.fn(),
  abortJob: vi.fn(),
}))

// Mock sse-manager: capture the listener so the test can dispatch events.
let sseListener: ((e: { data: string }) => void) | null = null
const unsubSpy = vi.fn()
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn((_url: string, _eventType: string, listener: (e: { data: string }) => void) => {
    sseListener = listener
    return unsubSpy
  }),
}))

// Mock next/navigation router to assert drill-down navigation.
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

import { getJob } from "@/lib/scheduler-api"
import { CompositeMode } from "../task-modal"
import type { JobDetail } from "@/lib/scheduler-api"

const mockGetJob = vi.mocked(getJob)

function makeCompositeJobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: "parent-1",
    name: "E2E_TP_复合任务",
    job_type: "workflow",
    cron_expression: null,
    timezone: "Asia/Shanghai",
    enabled: true,
    config: {
      schema_version: "3.0",
      type: "workflow",
      workspace_spec: { org: "test", branch_prefix: "taskpool-test", projects: [{ name: "p1", source_path: "", group: "" }] },
      workflow_chain: [{ workflow_ref: "composition-task", input_values: {} }],
      max_retain: 10,
      task_spec: {
        goal: "g",
        ac: ["a"],
        subunits: [
          { name: "子1", workflow_ref: "wf-a", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [] },
          { name: "子2", workflow_ref: "wf-b", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [] },
          { name: "子3", workflow_ref: "wf-c", workspace_spec: { org: "test", branch_prefix: "bp", projects: [{ name: "p1", source_path: "", group: "" }] }, input_values: {}, skills: [] },
        ],
        integration_goal: { strategy: "synthesis" },
      },
    },
    parallel_policy: "allow",
    timeout_seconds: 300,
    notify_on_failure: false,
    version: 1,
    consecutive_failures: 0,
    next_trigger_at: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    status: "running",
    trigger_source: "requirement",
    source_chat_session_id: null,
    claimed_at: null,
    children: [
      { schedule_id: "child-1", name: "子1", status: "running", workflow_ref: "wf-a", subunit_name: "子1" },
      { schedule_id: "child-2", name: "子2", status: "queued", workflow_ref: "wf-b", subunit_name: "子2" },
      { schedule_id: "child-3", name: "子3", status: "done", workflow_ref: "wf-c", subunit_name: "子3" },
    ],
    dag: {
      nodes: [
        { id: "子1", type: "subunit", label: "子1", workflow_ref: "wf-a" },
        { id: "子2", type: "subunit", label: "子2", workflow_ref: "wf-b" },
        { id: "子3", type: "subunit", label: "子3", workflow_ref: "wf-c" },
        { id: "integration", type: "integration", label: "synthesis" },
      ],
      edges: [
        { from: "子1", to: "integration" },
        { from: "子2", to: "integration" },
        { from: "子3", to: "integration" },
      ],
    },
    ...overrides,
  }
}

describe("CompositeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sseListener = null
  })

  it("renders DAG, child cards, and integration node from JobDetail", async () => {
    mockGetJob.mockResolvedValue(makeCompositeJobDetail())

    render(<CompositeMode job={makeCompositeJobDetail()} onMutated={() => {}} onClose={() => {}} />)

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
    const detail = makeCompositeJobDetail({
      status: "done",
      children: [
        { schedule_id: "child-1", name: "子1", status: "done", workflow_ref: "wf-a", subunit_name: "子1" },
        { schedule_id: "child-2", name: "子2", status: "done", workflow_ref: "wf-b", subunit_name: "子2" },
        { schedule_id: "child-3", name: "子3", status: "done", workflow_ref: "wf-c", subunit_name: "子3" },
      ],
    })
    mockGetJob.mockResolvedValue(detail)

    render(<CompositeMode job={detail} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/done|完成/)
    })
  })

  it("aggregate status is failed if any child failed", async () => {
    const detail = makeCompositeJobDetail({
      status: "running",
      children: [
        { schedule_id: "child-1", name: "子1", status: "failed", workflow_ref: "wf-a", subunit_name: "子1" },
        { schedule_id: "child-2", name: "子2", status: "done", workflow_ref: "wf-b", subunit_name: "子2" },
      ],
    })
    mockGetJob.mockResolvedValue(detail)

    render(<CompositeMode job={detail} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/failed|失败/)
    })
  })

  it("subscribes to SSE schedule_status and re-fetches on child event", async () => {
    const first = makeCompositeJobDetail()
    const second = makeCompositeJobDetail({
      children: [
        { schedule_id: "child-1", name: "子1", status: "done", workflow_ref: "wf-a", subunit_name: "子1" },
        { schedule_id: "child-2", name: "子2", status: "done", workflow_ref: "wf-b", subunit_name: "子2" },
        { schedule_id: "child-3", name: "子3", status: "done", workflow_ref: "wf-c", subunit_name: "子3" },
      ],
      status: "done",
    })
    mockGetJob.mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    render(<CompositeMode job={first} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    expect(sseListener).not.toBeNull()
    // Dispatch a schedule_status event for a child.
    await act(async () => {
      sseListener!({ data: JSON.stringify({ schedule_id: "child-1", status: "done" }) })
    })

    // getJob called a second time (re-fetch).
    await waitFor(() => {
      expect(mockGetJob).toHaveBeenCalledTimes(2)
    })

    // Aggregate now done.
    await waitFor(() => {
      expect(screen.getByTestId("composite-aggregate-status").textContent).toMatch(/done|完成/)
    })
  })

  it("clicking a child card navigates to that child execution detail", async () => {
    mockGetJob.mockResolvedValue(makeCompositeJobDetail())

    render(<CompositeMode job={makeCompositeJobDetail()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-dag")).toBeDefined()
    })

    // Click the first child card.
    const childCard = screen.getByTestId("composite-child-child-1")
    fireEvent.click(childCard)

    expect(pushSpy).toHaveBeenCalledWith("/scheduler/jobs/child-1")
  })

  it("renders the real-time SSE events panel", async () => {
    mockGetJob.mockResolvedValue(makeCompositeJobDetail())

    render(<CompositeMode job={makeCompositeJobDetail()} onMutated={() => {}} onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByTestId("composite-events-panel")).toBeDefined()
    })
  })
})
