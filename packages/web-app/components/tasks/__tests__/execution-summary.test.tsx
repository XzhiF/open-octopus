// execution-summary + 五态弹窗信息填充 回归测试 (2026-08-29 空白弹窗优化)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { TaskSpec } from "@octopus/shared"
import type { TaskView } from "@/lib/tasks-api"

const { mockGetTask, mockListArtifacts, mockFetchLLMCalls, pushSpy } = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  pushSpy: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => ({
  getTask: mockGetTask,
  listArtifacts: mockListArtifacts,
  // task-modal.tsx 的其余导入（Abort/Ready/Delete/Create…）——测试不触发，桩即可
  abortTask: vi.fn(), readyTask: vi.fn(), deleteTask: vi.fn(), createTask: vi.fn(),
  updateTask: vi.fn(), updateSpecField: vi.fn(), listTasks: vi.fn(),
  triggerTask: vi.fn(), cancelTaskTrigger: vi.fn(), scheduleTaskTrigger: vi.fn(), unscheduleTaskTrigger: vi.fn(),
  TaskReadyGateError: class extends Error {},
  ArtifactContentError: class extends Error {},
  WorkflowRefViewError: class extends Error {},
  getArtifactContent: vi.fn(), getWorkflowRefView: vi.fn(),
}))
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

/** GET /api/tasks/:id 的 TaskDTO（票03: trigger_* 列 + 当前实例，取代
 *  schedule_status/scheduled_at）。缺省 = 手动任务、无到期游标、从未跑过。 */
function makeTask(status: TaskView["status"]): TaskView {
  return {
    id: "task-1", org: "default", name: "弹窗优化任务", status,
    task_spec: SPEC, authoring_resources: [], resources: [],
    skills: ["octo-dev-copilot"], project_ids: ["octopus"],
    workflow_ref: "wf-flow", version: 3, source_chat_session_id: null,
    deleted_at: null, created_at: "2026-08-29T00:00:00Z", updated_at: "2026-08-29T01:00:00Z",
    completed_at: status === "done" ? "2026-08-29T02:00:00Z" : null,
    trigger_mode: "manual", trigger_at: null, cron_expression: null,
    cron_timezone: "Asia/Shanghai", trigger_enabled: 1,
    next_fire_at: null, last_fired_at: null, execution: null,
  }
}

// 票03: 一次运行 = executions 一行（不再有信封行 + execution_ref 的两跳）。徽章自带
// workspace_id + id，所以深链与耗时都由本行算；它不带 error_summary 与 agent 输出。
const RUN_RUNNING = {
  id: "exec-9", status: "running", workflow_ref: "wf-flow",
  phase_index: 1, round_index: 1, workspace_id: "ws-1",
  started_at: "2026-08-29T01:00:00Z", completed_at: null,
  created_at: "2026-08-29T00:59:00Z",
}

const RUN_FAILED = {
  ...RUN_RUNNING,
  status: "failed",
  completed_at: "2026-08-29T01:10:00Z",
}

beforeEach(() => {
  mockGetTask.mockReset()
  mockListArtifacts.mockReset()
  mockFetchLLMCalls.mockReset()
  pushSpy.mockReset()
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: null })
  mockListArtifacts.mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks() })

describe("TaskRunDetailView", () => {
  it("渲染 spec 概要 + 执行记录 + 深链按钮", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), executions: [RUN_RUNNING] })
    render(<TaskRunDetailView task={makeTask("running")} />)
    // 概要区
    expect(await screen.findByText("把看板弹窗填满真实信息")).toBeTruthy()
    expect(screen.getByText("显示执行记录")).toBeTruthy()
    expect(screen.getByText("octopus")).toBeTruthy()
    // 执行记录区：运行行没有信封名，v4 的 phase/round 就落在行上 → 行标题即轮次
    expect(await screen.findByText("Phase 1 · Round 1")).toBeTruthy()
    expect(screen.getByText("执行中")).toBeTruthy()
    expect(screen.getByText("wf-flow")).toBeTruthy()
    // 深链 → workspace 执行详情（两半都在同一行：workspace_id + 执行 id）
    const link = screen.getByText("查看执行详情")
    fireEvent.click(link)
    expect(pushSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-9")
  })

  it("无 children 时给出明确的未派发提示", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("ready"), executions: [] })
    render(<TaskRunDetailView task={makeTask("ready")} />)
    expect(await screen.findByText(/任务尚未派发执行/)).toBeTruthy()
    expect(await screen.findByText("执行记录")).toBeTruthy()
  })

  // 换的是真相来源，不是削弱断言：TaskExecutionBadge 只有
  // {id,status,workflow_ref,phase_index,round_index,workspace_id,started_at,
  // completed_at,created_at} —— 没有 error_summary，也没有可展开的 agent 输出
  // （旧的 GET /api/scheduler/jobs/:sid/executions/:eid 读的是信封行的
  // schedule_executions，任务运行不再在那张表里）。所以这里断言终态 + 由
  // started_at/completed_at 现算的 10m 耗时 + 深链；失败原因与输出核对在深链页面。
  // → 票05 follow-up：执行摘要需要 error/output（见报告）。
  it("失败运行显示终态与自算耗时，深链到该次执行", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("failed"), executions: [RUN_FAILED] })
    render(<TaskRunDetailView task={makeTask("failed")} />)
    expect(await screen.findByText("失败")).toBeTruthy()
    expect(screen.getByText(/耗时 10m/)).toBeTruthy()
    const link = screen.getByText("查看执行详情")
    fireEvent.click(link)
    expect(pushSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-9")
  })

  it("AI 用量统计条：调用次数/tokens/成本/模型分布聚合", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), executions: [RUN_RUNNING] })
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
    mockGetTask.mockResolvedValue({ ...makeTask("done"), executions: [] })
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
  function renderModal(task: TaskView) {
    return render(
      <TaskModal open onOpenChange={() => {}} task={task} onMutated={() => {}} />,
    )
  }

  it("running → 简单执行模式渲染完整信息体 + 保留中止", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("running"), executions: [RUN_RUNNING] })
    renderModal(makeTask("running"))
    expect(await screen.findByText("执行记录")).toBeTruthy()
    expect(screen.getByText("任务概要")).toBeTruthy()
    expect(screen.getByText("中止")).toBeTruthy()
    expect(screen.getByText("Phase 1 · Round 1")).toBeTruthy()
  })

  it("done → 完成模式横幅 + 信息体（不再是空占位文案）", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("done"), executions: [RUN_RUNNING] })
    renderModal(makeTask("done"))
    expect(await screen.findByText(/^任务完成/)).toBeTruthy()
    expect(screen.getByText("执行记录")).toBeTruthy()
  })

  it("failed/aborted → 终态横幅 + 信息体", async () => {
    mockGetTask.mockResolvedValue({ ...makeTask("failed"), executions: [RUN_FAILED] })
    renderModal(makeTask("failed"))
    expect(await screen.findByText("任务失败")).toBeTruthy()
    expect(screen.getByText("执行记录")).toBeTruthy()
    expect(screen.getByText(/耗时 10m/)).toBeTruthy()
  })
})
