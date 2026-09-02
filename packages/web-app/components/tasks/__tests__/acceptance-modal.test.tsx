// task-phase-redesign 票 12 — AcceptanceModal 三栏证据面 + 打回链 + D13①/D14
// 接缝组件测试。数据权威 = GET /:id.derived（票 03 唯一真相），本套用固定
// fixture（独立于组件的派生实现 — 反天：期望值来自票 07 契约的字面量）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDetail, TaskDerivedView } from "@/lib/tasks-api"

const {
  mockGetTask, mockListArtifacts, mockPostAcceptance, mockAbortTask,
  mockFetchLLMCalls, mockUpdateSpecField, mockGetArtifactContent,
} = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockPostAcceptance: vi.fn(),
  mockAbortTask: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  mockUpdateSpecField: vi.fn(),
  mockGetArtifactContent: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => {
  class TaskApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "TaskApiError"
      this.status = status
    }
  }
  return {
    getTask: mockGetTask,
    listArtifacts: mockListArtifacts,
    postAcceptance: mockPostAcceptance,
    abortTask: mockAbortTask,
    updateSpecField: mockUpdateSpecField,
    getArtifactContent: mockGetArtifactContent,
    ArtifactContentError: class extends Error {},
    TaskApiError,
  }
})
vi.mock("@/lib/observability-api", () => ({ fetchLLMCalls: mockFetchLLMCalls }))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: vi.fn(() => () => {}) }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AcceptanceModal, ImpactApprovalList } from "../acceptance-modal"
import { TaskApiError } from "@/lib/tasks-api"

// ── fixtures（票 07 GET /:id 契约形状） ──────────────────────────────

const PHASE1_AWAITING: TaskDerivedView = {
  taskStatus: "awaiting_review",
  isV4: true,
  phaseViews: [
    {
      index: 1, name: "脚手架", slug: "scaffold-1", workflowRef: "task-dev",
      status: "awaiting_review",
      rounds: [{
        roundIndex: 1,
        exec: { id: "exec-1", status: "completed", phase_index: 1, round_index: 1, created_at: "2026-09-03T00:00:00Z" },
        state: "succeeded",
        decision: null,
      }],
      currentRound: 1, acceptedRound: null, awaitingRound: 1,
    },
    {
      index: 2, name: "观测", slug: "metering-2", workflowRef: "task-dev",
      status: "pending", rounds: [], currentRound: null, acceptedRound: null, awaitingRound: null,
    },
  ],
}

const V4_SPEC = {
  format: "v4",
  goal: "g",
  ac: [],
  resources: [],
  authoring_resources: [],
  skill_groups: [],
  decisions: [],
  ac_confirmed: [],
  phases: [
    { index: 1, name: "脚手架", slug: "scaffold-1", specPath: "./.scratch/20260903/scaffold-1/spec.md", workflowRef: "task-dev", inputValues: {} },
    { index: 2, name: "观测", slug: "metering-2", specPath: "./.scratch/20260903/metering-2/spec.md", workflowRef: "task-dev", inputValues: {} },
  ],
} as unknown as TaskSpec

function makeDetail(derived: TaskDerivedView): TaskDetail {
  return {
    id: "t1", org: "acme", name: "票12任务", status: "awaiting_review",
    task_spec: V4_SPEC, authoring_resources: [], resources: [], skills: [], project_ids: [],
    version: 4, source_chat_session_id: null, deleted_at: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", completed_at: null,
    derived,
    children: [{
      schedule_id: "sch-1", name: "env", status: "done", origin_role: "primary",
      workflow_ref: "task-dev",
      execution_ref: {
        id: "se-1", status: "done", execution_id: "exec-1", workspace_id: "ws-1",
        triggered_at: "2026-09-03T00:00:00Z", completed_at: "2026-09-03T00:42:00Z",
        duration_ms: 2_520_000, error_summary: null,
      },
    }],
  } as unknown as TaskDetail
}

const AGG = {
  totalCalls: 30,
  toolCalls: 5,
  usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 3000, cost: { usd: 0.03, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
}

const ARTIFACTS = [
  { path: ".scratch/20260903/scaffold-1/spec.md", by: "agent", title: "spec", external: false, updated_at: "2026-09-03T00:10:00Z" },
  { path: ".scratch/20260903/scaffold-1/issues/01-done.md", by: "agent", title: "01", external: false, updated_at: "2026-09-03T00:30:00Z" },
  { path: ".scratch/20260903/metering-2/spec.md", by: "agent", title: "spec2", external: false, updated_at: "2026-09-03T00:31:00Z" },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING))
  mockListArtifacts.mockResolvedValue(ARTIFACTS)
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: AGG })
  mockGetArtifactContent.mockResolvedValue({ path: "x", content: "# spec body" })
})

function renderModal() {
  const task = makeDetail(PHASE1_AWAITING) as unknown as Task
  return render(<AcceptanceModal task={task} open onOpenChange={() => {}} onMutated={() => {}} />)
}

describe("AcceptanceModal — AC1 三栏证据面", () => {
  it("三栏齐现；左列=round 状态/用时/token/cost（round 口径），角标=Phase 1/2 · Round 1", async () => {
    renderModal()
    expect(await screen.findByTestId("acceptance-modal")).toBeTruthy()
    expect(screen.getByTestId("acceptance-col-summary")).toBeTruthy()
    expect(screen.getByTestId("acceptance-col-artifacts"))
    expect(screen.getByTestId("acceptance-col-actions"))
    expect(screen.getByTestId("acceptance-phase-label").textContent).toBe("Phase 1/2 · Round 1")
    expect(screen.getByTestId("acceptance-round-state").textContent).toBe("执行成功")
    // 用时 = children.execution_ref.duration_ms 联查（2,520,000ms = 42m）
    expect(screen.getByTestId("acceptance-duration").textContent).toBe("42m 0s")
    // token/cost = fetchLLMCalls(exec-1)（round 口径，一次）
    await waitFor(() => expect(mockFetchLLMCalls).toHaveBeenCalledWith("exec-1"))
    expect(screen.getByText(/30 次调用|↑/)).toBeTruthy()
    expect(screen.getByText(/\$0\.03/)).toBeTruthy()
  })

  it("中列按 phase slug 过滤产物并点开 ArtifactViewerDialog 全文", async () => {
    renderModal()
    // phase1 slug=scaffold-1 → 只显 scaffold 两个文件，metering 不混入
    expect(await screen.findByTestId("acceptance-artifact-rows")).toBeTruthy()
    expect(document.querySelector('[data-acceptance-artifact-row=".scratch/20260903/scaffold-1/spec.md"]')).toBeTruthy()
    expect(document.querySelector('[data-acceptance-artifact-row=".scratch/20260903/metering-2/spec.md"]')).toBeNull()
    fireEvent.click(document.querySelector('[data-acceptance-artifact-row=".scratch/20260903/scaffold-1/spec.md"]')!)
    await waitFor(() => expect(mockGetArtifactContent).toHaveBeenCalledWith("t1", ".scratch/20260903/scaffold-1/spec.md"))
    await waitFor(() => expect(document.querySelector("[data-artifact-content]")).toBeTruthy())
    expect(document.querySelector("[data-artifact-content]")!.textContent).toContain("# spec body")
  })

  it("右列动作区：通过/打回/中止 齐备 + autoAdvance 只读态", async () => {
    renderModal()
    expect(await screen.findByTestId("acceptance-approve")).toBeTruthy()
    expect(screen.getByTestId("acceptance-reject")).toBeTruthy()
    expect(screen.getByTestId("acceptance-abort")).toBeTruthy()
    expect(screen.getByTestId("autoadvance-readonly").textContent).toContain("开")
  })
})

describe("AcceptanceModal — AC2 打回反馈必填 + 提交链", () => {
  it("反馈为空时打回确认 disabled；提交走票 07 契约 body", async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-reject"))
    const confirm = screen.getByTestId("reject-confirm") as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "   " } })
    expect((screen.getByTestId("reject-confirm") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "路由没接上" } })
    expect((screen.getByTestId("reject-confirm") as HTMLButtonElement).disabled).toBe(false)

    mockPostAcceptance.mockResolvedValueOnce({
      task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-1", next_action: "dispatched",
      dispatch: { schedule_id: "sch-1", execution_id: "exec-2", workspace_id: "ws-1", phase_index: 1, round_index: 2 },
    })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledWith("t1", {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "路由没接上",
    }))
  })

  it("提交成功后显示 D13① agent 形态推荐占位卡（disabled）+ D14 影响清单空态", async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-reject"))
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "重做" } })
    mockPostAcceptance.mockResolvedValueOnce({
      task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-1", next_action: "dispatched",
      dispatch: { schedule_id: "sch-1", execution_id: "exec-2", workspace_id: "ws-1", phase_index: 1, round_index: 2 },
    })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    expect(await screen.findByTestId("agent-recommend-card")).toBeTruthy()
    expect(document.querySelector('[data-recommend-option="fix-flow"] input')).toBeDisabled()
    expect(document.querySelector('[data-recommend-option="spec-r2"] input')).toBeDisabled()
    expect(screen.getByTestId("impact-list-empty")).toBeTruthy()
  })

  it("accepted 提交：phase_index/round_index 取 derived 的 awaitingRound；409 → 刷新盘面", async () => {
    renderModal()
    mockPostAcceptance
      .mockRejectedValueOnce(new TaskApiError("phase 1 当前派生态 running（无待验收轮），与请求 round 1 不匹配", 409))
      .mockResolvedValueOnce({
        task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-2", next_action: "awaiting_manual_trigger",
      })
    fireEvent.click(await screen.findByTestId("acceptance-approve"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledWith("t1", {
      phase_index: 1, round_index: 1, decision: "accepted",
    }))
    // 409 分支：重拉 GET /:id（初次开窗 1 次 + 409 刷新 1 次）
    await waitFor(() => expect(mockGetTask.mock.calls.length).toBeGreaterThanOrEqual(2))
    // 第二次点通过 → 成功走 awaiting_manual_trigger（autoAdvance=false 语义提示）
    fireEvent.click(screen.getByTestId("acceptance-approve"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledTimes(2))
  })
})

describe("ImpactApprovalList — D14 批准→spec-field phases 写回（渲染逻辑就绪）", () => {
  it("空数据源 → v4.1 接缝空态；有数据 → 勾选批准写 phases 并 bump（updateSpecField）", async () => {
    const { rerender } = render(
      <ImpactApprovalList taskId="t1" phases={V4_SPEC.phases as never} items={[]} onDone={() => {}} />,
    )
    expect(screen.getByTestId("impact-list-empty")).toBeTruthy()

    const items = [{
      key: "KD-3", phaseIndex: 2, change: "Key Decisions #3 新增 NEW-r2：改用 OTLP 导出",
      workflowReassess: "round-1 绑的 task-dev 不再覆盖 → 建议 task-fix", nextWorkflowRef: "task-fix",
    }]
    rerender(<ImpactApprovalList taskId="t1" phases={V4_SPEC.phases as never} items={items} onDone={() => {}} />)
    fireEvent.click(screen.getByTestId("impact-item-KD-3").querySelector("input")!)
    fireEvent.click(screen.getByTestId("impact-approve"))
    await waitFor(() => expect(mockUpdateSpecField).toHaveBeenCalledTimes(1))
    const [taskId, field, value, opts] = mockUpdateSpecField.mock.calls[0]
    expect(taskId).toBe("t1")
    expect(field).toBe("phases")
    expect(opts).toEqual({ source: "user" })
    const phases = value as Array<{ index: number; workflowRef: string }>
    expect(phases.find((p) => p.index === 2)?.workflowRef).toBe("task-fix") // 受影响 phase 改写
    expect(phases.find((p) => p.index === 1)?.workflowRef).toBe("task-dev") // 未勾选保持
  })
})
