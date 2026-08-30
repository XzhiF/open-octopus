// execution-summary + 五态弹窗信息填充 回归测试 (2026-08-29 空白弹窗优化)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"

const { mockGetTask, mockListArtifacts, mockGetExecution, mockFetchLLMCalls, pushSpy } = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockGetExecution: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  pushSpy: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => ({
  getTask: mockGetTask,
  listArtifacts: mockListArtifacts,
  // task-modal.tsx 的其余导入（Abort/Ready/Delete/Create…）——测试不触发，桩即可
  abortTask: vi.fn(), readyTask: vi.fn(), deleteTask: vi.fn(), createTask: vi.fn(),
  updateTask: vi.fn(), updateSpecField: vi.fn(), listTasks: vi.fn(),
  triggerTask: vi.fn(), cancelTaskTrigger: vi.fn(),
  TaskReadyGateError: class extends Error {},
  ArtifactContentError: class extends Error {},
  WorkflowRefViewError: class extends Error {},
  getArtifactContent: vi.fn(), getWorkflowRefView: vi.fn(),
}))
vi.mock("@/lib/scheduler-api", () => ({ getExecution: mockGetExecution }))
vi.mock("@/lib/observability-api", () => ({ fetchLLMCalls: mockFetchLLMCalls }))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: () => () => {} }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 重组件桩（弹窗本体只测信息渲染）
vi.mock("../authoring/artifact-viewer-dialog", () => ({ ArtifactViewerDialog: () => null }))
vi.mock("../authoring/workflow-viewer-dialog", () => ({ WorkflowViewerDialog: () => null }))
vi.mock("../authoring/template-picker", () => ({ TemplatePicker: () => null }))
vi.mock("../authoring/authoring-workspace", () => ({ AuthoringWorkspace: () => null }))
vi.mock("../composite-dag", () => ({ CompositeDag: () => null }))

import { TaskRunDetailView } from "../execution-summary"
import { TaskModal } from "../task-modal"

const SPEC: TaskSpec = {
  goal: "把看板弹窗填满真实信息",
  ac: ["显示执行记录", "显示产物"],
  resources: [], authoring_resources: [],
  skill_groups: [], decisions: [], ac_confirmed: [],
} as unknown as TaskSpec

function makeTask(status: Task["status"]): Task {
  return {
    id: "task-1", org: "default", name: "弹窗优化任务", status,
    task_spec: SPEC, authoring_resources: [], resources: [],
    skills: ["octo-dev-copilot"], project_ids: ["octopus"],
    workflow_ref: "wf-flow", version: 3, source_chat_session_id: null,
    deleted_at: null, created_at: "2026-08-29T00:00:00Z", updated_at: "2026-08-29T01:00:00Z",
    completed_at: status === "done" ? "2026-08-29T02:00:00Z" : null,
  }
}

const CHILD_RUNNING = {
  schedule_id: "sch-1", name: "task-task-1-primary", status: "running",
  origin_role: "primary", workflow_ref: "wf-flow", scheduled_at: null,
  workspace_id: "ws-1",
  execution_ref: {
    id: "run-1", status: "running", execution_id: "exec-9", workspace_id: "ws-1",
    triggered_at: "2026-08-29T01:00:00Z", completed_at: null, duration_ms: null,
    error_summary: null,
  },
}

const CHILD_FAILED = {
  ...CHILD_RUNNING,
  status: "failed",
  execution_ref: {
    ...CHILD_RUNNING.execution_ref, status: "failed",
    completed_at: "2026-08-29T01:10:00Z", duration_ms: 600000,
    error_summary: "node agent-1 failed: boom",
  },
}

beforeEach(() => {
  mockGetTask.mockReset()
  mockListArtifacts.mockReset()
  mockGetExecution.mockReset()
  mockFetchLLMCalls.mockReset()
  pushSpy.mockReset()
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: null })
  mockListArtifacts.mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks() })

describe("TaskRunDetailView", () => {
  it("渲染 spec 概要 + 执行记录 + 深链按钮", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), children: [CHILD_RUNNING] })
    render(<TaskRunDetailView task={makeTask("running")} />)
    // 概要区
    expect(await screen.findByText("把看板弹窗填满真实信息")).toBeTruthy()
    expect(screen.getByText("显示执行记录")).toBeTruthy()
    expect(screen.getByText("octopus")).toBeTruthy()
    // 执行记录区
    expect(screen.getByText("task-task-1-primary")).toBeTruthy()
    expect(screen.getByText("执行中")).toBeTruthy()
    expect(screen.getByText("主执行")).toBeTruthy()
    // 深链 → workspace 执行详情
    const link = screen.getByText("查看执行详情")
    fireEvent.click(link)
    expect(pushSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-9")
  })

  it("无 children 时给出明确的未派发提示", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("ready"), children: [] })
    render(<TaskRunDetailView task={makeTask("ready")} />)
    expect(await screen.findByText(/任务尚未派发执行/)).toBeTruthy()
    expect(await screen.findByText("执行记录")).toBeTruthy()
  })

  it("失败子运行显示错误摘要，展开输出走 scheduler-api", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("failed"), children: [CHILD_FAILED] })
    mockGetExecution.mockResolvedValue({
      agent_output: "final report here", model_used: "sonnet",
      token_usage: { input: 10, output: 20 },
    })
    render(<TaskRunDetailView task={makeTask("failed")} />)
    expect(await screen.findByText("node agent-1 failed: boom")).toBeTruthy()
    expect(screen.getByText(/耗时/)).toBeTruthy()
    fireEvent.click(screen.getByText("运行输出"))
    await waitFor(() => expect(mockGetExecution).toHaveBeenCalledWith("sch-1", "run-1"))
    expect(await screen.findByText(/final report here/)).toBeTruthy()
    expect(screen.getByText(/模型: sonnet/)).toBeTruthy()
  })

  it("AI 用量统计条：调用次数/tokens/成本/模型分布聚合", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), children: [CHILD_RUNNING] })
    mockFetchLLMCalls.mockResolvedValue({
      data: [],
      aggregates: {
        totalCalls: 12,
        usage: { inputTokens: 24000, outputTokens: 413000, cacheReadTokens: 1458600, cacheCreationTokens: 513900 },
        totals: { tokens: 2409700, cost: { usd: 1.234, complete: true }, cacheHitRate: 1458600 / (24000 + 1458600) },
        modelBreakdown: { "sonnet": { calls: 10, inputTokens: 20000, outputTokens: 400000, costUsd: 1.0 }, "haiku": { calls: 2, inputTokens: 4000, outputTokens: 13000, costUsd: 0.234 } },
      },
    })
    render(<TaskRunDetailView task={makeTask("running")} />)
    // 任务级卡（标题 + 全部执行合计口径备注）
    expect(await screen.findByText("任务 AI 消耗")).toBeTruthy()
    expect(screen.getByText(/全部 1 次执行合计 · 不含编写期对话/)).toBeTruthy()
    // 卡内 + 行内各一份成本（≥1 美元两位小数）
    // C3: 定价完整 → 无 ≈ 前缀（≈ 只属于部分定价/未定价态）
    expect(screen.getAllByText(/\$1\.23/)).toHaveLength(2)
    expect(screen.getByText(/12 次调用/)).toBeTruthy()
    expect(screen.getByText("sonnet×10")).toBeTruthy()
    expect(screen.getByText("haiku×2")).toBeTruthy()
    expect(mockFetchLLMCalls).toHaveBeenCalledWith("exec-9")
  })

  it("产物列表渲染并可点开查看", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("done"), children: [] })
    mockListArtifacts.mockResolvedValue([
      { path: "artifacts/report.md", by: "agent-1", title: "综合报告", external: false, updated_at: "2026-08-29T02:00:00Z" },
      { path: "/abs/pr-link.txt", by: "user", title: "", external: true, updated_at: "2026-08-29T02:10:00Z" },
    ])
    render(<TaskRunDetailView task={makeTask("done")} />)
    expect(await screen.findByText("综合报告")).toBeTruthy()
    expect(screen.getByText("/abs/pr-link.txt")).toBeTruthy() // 无 title → path 兜底
    expect(screen.getByText("外部")).toBeTruthy()
    expect(screen.getByText(/^任务已完成/)).toBeTruthy()
  })
})

describe("TaskModal 五态填充", () => {
  function renderModal(task: Task) {
    return render(
      <TaskModal open onOpenChange={() => {}} task={task} onMutated={() => {}} />,
    )
  }

  it("running → 简单执行模式渲染完整信息体 + 保留中止", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), children: [CHILD_RUNNING] })
    renderModal(makeTask("running"))
    expect(await screen.findByText("执行记录")).toBeTruthy()
    expect(screen.getByText("任务概要")).toBeTruthy()
    expect(screen.getByText("中止")).toBeTruthy()
    expect(screen.getByText("task-task-1-primary")).toBeTruthy()
  })

  it("done → 完成模式横幅 + 信息体（不再是空占位文案）", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("done"), children: [CHILD_RUNNING] })
    renderModal(makeTask("done"))
    expect(await screen.findByText(/^任务完成/)).toBeTruthy()
    expect(screen.getByText("执行记录")).toBeTruthy()
  })

  it("failed/aborted → 终态横幅 + 信息体", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("failed"), children: [CHILD_FAILED] })
    renderModal(makeTask("failed"))
    expect(await screen.findByText("任务失败")).toBeTruthy()
    expect(screen.getByText("执行记录")).toBeTruthy()
    expect(screen.getByText("node agent-1 failed: boom")).toBeTruthy()
  })
})
