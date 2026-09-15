// task-phase-redesign 票 12 — AcceptanceModal 三栏证据面 + 打回链 + D13①/D14
// 接缝组件测试。数据权威 = GET /:id.derived（票 03 唯一真相），本套用固定
// fixture（独立于组件的派生实现 — 反天：期望值来自票 07 契约的字面量）。
//
// 中列（task-exec-tree 验收证据面）：登记语义已退役 — 组件改直读批次目录
// （listHomeDir all=1 + getHomeFile + getBatchTree 回退定位），本套 mock 面对应。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDetail, TaskDerivedView } from "@/lib/tasks-api"

const {
  mockGetTask, mockPostAcceptance, mockAbortTask,
  mockFetchLLMCalls, mockUpdateSpecField,
  mockListHomeDir, mockGetHomeFile, mockGetBatchTree,
} = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockPostAcceptance: vi.fn(),
  mockAbortTask: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  mockUpdateSpecField: vi.fn(),
  mockListHomeDir: vi.fn(),
  mockGetHomeFile: vi.fn(),
  mockGetBatchTree: vi.fn(),
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
    postAcceptance: mockPostAcceptance,
    abortTask: mockAbortTask,
    updateSpecField: mockUpdateSpecField,
    getArtifactContent: vi.fn(),
    ArtifactContentError: class extends Error {},
    TaskApiError,
    // 中列证据面（批次直读）+ ArtifactViewerDialog home 模式所需出口。
    // putHomeFile：phase-spec-dialog 模块图会 import 它（batchDirOf 复用其导出），
    // vitest 对 mock 缺失出口直接 throw —— 一并给上。
    listHomeDir: mockListHomeDir,
    getHomeFile: mockGetHomeFile,
    getBatchTree: mockGetBatchTree,
    putHomeFile: vi.fn(),
    MAX_HOME_FILE_READ_BYTES: 512_000,
  }
})
// react-markdown 全家桶对单测是纯负担 — 桩到内容透传（渲染质量归 MarkdownPreview 自己）。
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))
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

/** specPath 绝对（agent 旁路直写）→ 中列定位走 getBatchTree slug 回退。 */
const V4_SPEC_ABS = {
  ...(V4_SPEC as object),
  phases: [
    { index: 1, name: "脚手架", slug: "scaffold-1", specPath: "/tmp/ws/scaffold/spec.md", workflowRef: "task-dev", inputValues: {} },
  ],
} as unknown as TaskSpec

function makeDetail(derived: TaskDerivedView, spec: TaskSpec = V4_SPEC): TaskDetail {
  return {
    id: "t1", org: "acme", name: "票12任务", status: "awaiting_review",
    task_spec: spec, authoring_resources: [], resources: [], skills: [], project_ids: [],
    version: 4, source_chat_session_id: null, deleted_at: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", completed_at: null,
    derived,
    // 票03: 运行历史徽章取代 children[].execution_ref —— 用时由本行的
    // started_at/completed_at 现算（2026-09-03 00:00 → 00:42 = 42m）。
    executions: [{
      id: "exec-1", status: "completed", workflow_ref: "task-dev",
      phase_index: 1, round_index: 1, workspace_id: "ws-1",
      started_at: "2026-09-03T00:00:00Z", completed_at: "2026-09-03T00:42:00Z",
      created_at: "2026-09-03T00:00:00Z",
    }],
  } as unknown as TaskDetail
}

// phase-handoff-chaining 票 04 — p2 待验收、p1 已 accepted 的三 phase 派生视图
// （提示行 N=2 场景）+ 末 phase 待验收（无下一站，不显示）场景。
const round = (execId: string, phaseIndex: number, roundIndex: number, decision: "accepted" | null) => ({
  roundIndex,
  exec: { id: execId, status: "completed", phase_index: phaseIndex, round_index: roundIndex, created_at: "2026-09-03T00:00:00Z" },
  state: "succeeded" as const,
  decision,
})

const P2_AWAITING_P1_ACCEPTED: TaskDerivedView = {
  taskStatus: "awaiting_review",
  isV4: true,
  phaseViews: [
    {
      index: 1, name: "脚手架", slug: "scaffold-1", workflowRef: "task-dev",
      status: "accepted",
      rounds: [round("exec-1", 1, 1, "accepted")],
      currentRound: 1, acceptedRound: 1, awaitingRound: null,
    },
    {
      index: 2, name: "观测", slug: "metering-2", workflowRef: "task-dev",
      status: "awaiting_review",
      rounds: [round("exec-2", 2, 1, null)],
      currentRound: 1, acceptedRound: null, awaitingRound: 1,
    },
    {
      index: 3, name: "收尾", slug: "wrap-3", workflowRef: "task-dev",
      status: "pending", rounds: [], currentRound: null, acceptedRound: null, awaitingRound: null,
    },
  ],
}

const LAST_PHASE_AWAITING: TaskDerivedView = {
  taskStatus: "awaiting_review",
  isV4: true,
  phaseViews: [
    {
      index: 1, name: "脚手架", slug: "scaffold-1", workflowRef: "task-dev",
      status: "accepted",
      rounds: [round("exec-1", 1, 1, "accepted")],
      currentRound: 1, acceptedRound: 1, awaitingRound: null,
    },
    {
      index: 2, name: "观测", slug: "metering-2", workflowRef: "task-dev",
      status: "awaiting_review",
      rounds: [round("exec-2", 2, 1, null)],
      currentRound: 1, acceptedRound: null, awaitingRound: 1,
    },
  ],
}

// 无待验收轮（p1 已 accepted、p2 pending）→ 中列 idle 提示。
const NO_AWAITING: TaskDerivedView = {
  taskStatus: "running",
  isV4: true,
  phaseViews: [
    {
      index: 1, name: "脚手架", slug: "scaffold-1", workflowRef: "task-dev",
      status: "accepted",
      rounds: [round("exec-1", 1, 1, "accepted")],
      currentRound: 1, acceptedRound: 1, awaitingRound: null,
    },
    {
      index: 2, name: "观测", slug: "metering-2", workflowRef: "task-dev",
      status: "pending", rounds: [], currentRound: null, acceptedRound: null, awaitingRound: null,
    },
  ],
}

const AGG = {
  totalCalls: 30,
  toolCalls: 5,
  usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 3000, cost: { usd: 0.03, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
}

// 中列证据 fixture — home-relative posix（listHomeDir all=1 的真实形状）。
// round 窗口 = exec-1 [00:00, 00:42]：窗内三个带「本轮」，窗外 handoff 不带；
// state.db 属不可预览门（存在即证据，行在但点不开）。
const BATCH_DIR = ".scratch/20260903/scaffold-1"
const HOME_FILES = [
  { path: `${BATCH_DIR}/round-report.md`, mtime: "2026-09-03T00:40:00Z", bytes: 500 },
  { path: `${BATCH_DIR}/spec.md`, mtime: "2026-09-03T00:10:00Z", bytes: 300 },
  { path: `${BATCH_DIR}/e2e-data/run.txt`, mtime: "2026-09-03T00:30:00Z", bytes: 120 },
  { path: `${BATCH_DIR}/e2e-data/state.db`, mtime: "2026-09-03T00:31:00Z", bytes: 9000 },
  { path: `${BATCH_DIR}/handoff.md`, mtime: "2026-09-01T00:00:00Z", bytes: 200 },
]

function rowByPath(p: string): HTMLElement | null {
  return document.querySelector(`[data-acceptance-artifact-row="${p}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING))
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: AGG })
  mockListHomeDir.mockResolvedValue(HOME_FILES)
  mockGetHomeFile.mockImplementation(async (_id: string, p: string) => ({
    path: p,
    content: p.endsWith("round-report.md") ? "# 本轮终报\n\n- 全绿" : "# spec body",
  }))
  mockGetBatchTree.mockResolvedValue([])
})

function renderModal() {
  const task = makeDetail(PHASE1_AWAITING) as unknown as Task
  return render(<AcceptanceModal task={task} open onOpenChange={() => {}} onMutated={() => {}} />)
}

/** 票 04：指定派生视图开窗（覆盖 beforeEach 的默认 mockGetTask 返回值）。 */
function renderModalWith(derived: TaskDerivedView, spec: TaskSpec = V4_SPEC) {
  mockGetTask.mockResolvedValue(makeDetail(derived, spec))
  const task = makeDetail(derived, spec) as unknown as Task
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

  it("中列：specPath 定位批次目录 all=1 直读；行渲染 + 内嵌 round-report + 本轮徽章 + 不可预览门", async () => {
    renderModal()
    // 定位 = dirname(specPath)（posix 归一后），all=1 收全文件
    await waitFor(() => expect(mockListHomeDir).toHaveBeenCalledWith("t1", BATCH_DIR, { all: true }))
    expect(await screen.findByTestId("acceptance-artifact-rows")).toBeTruthy()
    expect(rowByPath(`${BATCH_DIR}/spec.md`)).toBeTruthy()
    expect(rowByPath(`${BATCH_DIR}/e2e-data/state.db`)).toBeTruthy() // .db 可见（证据存在性）
    expect(screen.queryByTestId("acceptance-batch-empty")).toBeNull()

    // 内嵌轮次报告：round-report.md 存在 → 卡片渲染 markdown（MarkdownPreview 桩）
    const report = await screen.findByTestId("acceptance-round-report")
    expect(report.textContent).toContain("本轮终报")
    await waitFor(() => expect(mockGetHomeFile).toHaveBeenCalledWith("t1", `${BATCH_DIR}/round-report.md`))

    // 「本轮」徽章 = mtime ∈ [started_at, completed_at]；窗外文件不带
    expect(screen.getByTestId(`acceptance-round-badge-${BATCH_DIR}/spec.md`)).toBeTruthy()
    expect(screen.getByTestId(`acceptance-round-badge-${BATCH_DIR}/e2e-data/run.txt`)).toBeTruthy()
    expect(screen.queryByTestId(`acceptance-round-badge-${BATCH_DIR}/handoff.md`)).toBeNull()

    // 不可预览行（.db）：disabled 且点击不触读
    const dbRow = rowByPath(`${BATCH_DIR}/e2e-data/state.db`) as HTMLButtonElement | null
    expect(dbRow).toBeTruthy()
    expect(dbRow!.disabled).toBe(true)
    mockGetHomeFile.mockClear()
    fireEvent.click(dbRow!)
    expect(mockGetHomeFile).not.toHaveBeenCalled()

    // 可预览行点开 → ArtifactViewerDialog home 模式经 getHomeFile 出全文
    fireEvent.click(rowByPath(`${BATCH_DIR}/spec.md`)!)
    await waitFor(() => expect(mockGetHomeFile).toHaveBeenCalledWith("t1", `${BATCH_DIR}/spec.md`))
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

describe("AcceptanceModal — 中列状态面（404 空态 / 错误行 / 回退定位 / idle）", () => {
  it("批次目录 404（collect 前未落盘）→ 空态卡，不显错误", async () => {
    mockListHomeDir.mockRejectedValue(new TaskApiError("batch dir not found", 404))
    renderModal()
    expect(await screen.findByTestId("acceptance-batch-empty")).toBeTruthy()
    expect(screen.queryByTestId("acceptance-batch-error")).toBeNull()
  })

  it("列表非 404 失败（server 未更新的 403 / 网络）→ 一行显式错误", async () => {
    mockListHomeDir.mockRejectedValue(new TaskApiError("path not whitelisted", 403))
    renderModal()
    const err = await screen.findByTestId("acceptance-batch-error")
    expect(err.textContent).toContain("path not whitelisted")
  })

  it("绝对 specPath（gateV4 旁路直写）→ getBatchTree 按 slug 回退取最新 dir", async () => {
    mockGetBatchTree.mockResolvedValue([
      { dir: ".scratch/20260901/scaffold-1", slug: "scaffold-1", files: [], latest_mtime: "2026-09-01T00:00:00Z" },
      { dir: ".scratch/20260903/scaffold-1", slug: "scaffold-1", files: [], latest_mtime: "2026-09-03T00:00:00Z" },
      { dir: ".scratch/20260903/other-9", slug: "other-9", files: [], latest_mtime: "2026-09-04T00:00:00Z" },
    ])
    mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING, V4_SPEC_ABS))
    const task = makeDetail(PHASE1_AWAITING, V4_SPEC_ABS) as unknown as Task
    render(<AcceptanceModal task={task} open onOpenChange={() => {}} onMutated={() => {}} />)
    await waitFor(() => expect(mockGetBatchTree).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(mockListHomeDir).toHaveBeenCalledWith("t1", ".scratch/20260903/scaffold-1", { all: true }))
  })

  it("回退扫描无命中 → 仍落空态（绝不无限转圈）", async () => {
    mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING, V4_SPEC_ABS))
    mockGetBatchTree.mockResolvedValue([])
    const task = makeDetail(PHASE1_AWAITING, V4_SPEC_ABS) as unknown as Task
    render(<AcceptanceModal task={task} open onOpenChange={() => {}} onMutated={() => {}} />)
    expect(await screen.findByTestId("acceptance-batch-empty")).toBeTruthy()
  })

  it("无待验收 round → idle 提示，不拉批次列表", async () => {
    renderModalWith(NO_AWAITING)
    expect(await screen.findByTestId("acceptance-batch-idle")).toBeTruthy()
    expect(mockListHomeDir).not.toHaveBeenCalled()
  })
})

describe("AcceptanceModal — AC2 打回反馈必填 + 提交链（ADR-0018 二分路由）", () => {
  it("反馈为空时打回确认 disabled；缺省路由=修订重跑；选轻量修复后 body 带 next_flow=fix", async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-reject"))
    const confirm = screen.getByTestId("reject-confirm") as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "   " } })
    expect((screen.getByTestId("reject-confirm") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "路由没接上" } })
    expect((screen.getByTestId("reject-confirm") as HTMLButtonElement).disabled).toBe(false)
    // 路由二选一默认 = 修订重跑
    expect((document.querySelector('[data-reject-flow="rerun"] input') as HTMLInputElement).checked).toBe(true)
    expect((document.querySelector('[data-reject-flow="fix"] input') as HTMLInputElement).checked).toBe(false)

    mockPostAcceptance.mockResolvedValueOnce({
      task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-1", next_action: "dispatched",
      dispatch: { execution_id: "exec-2", workspace_id: "ws-1", phase_index: 1, round_index: 2 },
    })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledWith("t1", {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "路由没接上", next_flow: "rerun",
    }))

    // 切到轻量修复再打一枪 → body 换轨
    mockPostAcceptance.mockClear()
    fireEvent.click(screen.getByTestId("acceptance-reject"))
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "错别字" } })
    fireEvent.click(document.querySelector('[data-reject-flow="fix"] input') as HTMLInputElement)
    mockPostAcceptance.mockResolvedValueOnce({
      task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-2", next_action: "dispatched",
      dispatch: { execution_id: "exec-3", workspace_id: "ws-1", phase_index: 1, round_index: 2 },
    })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledWith("t1", {
      phase_index: 1, round_index: 1, decision: "rejected", feedback: "错别字", next_flow: "fix",
    }))
  })

  it("提交成功后显示路由回显卡（活的，非 disabled 占位）+ D14 影响清单空态", async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-reject"))
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "重做" } })
    mockPostAcceptance.mockResolvedValueOnce({
      task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-1", next_action: "dispatched",
      dispatch: { execution_id: "exec-2", workspace_id: "ws-1", phase_index: 1, round_index: 2 },
    })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    const card = await screen.findByTestId("agent-recommend-card")
    expect(card.textContent).toContain("修订重跑")
    expect(card.querySelector("input[disabled]")).toBeNull() // D13① disabled 假卡已兑现为回显
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

describe("AcceptanceModal — 票 04 前序交接提示行（phase-handoff-chaining K6）", () => {
  it("AC1: 双 phase、phase1 待验收 → 确认按钮上方显示提示行 N=1；打回面板展开即隐藏、取消恢复", async () => {
    renderModal()
    const hint = await screen.findByTestId("handoff-hint")
    expect(hint.textContent).toBe(
      "本 phase 的 handoff.md 连同已 accepted 共 1 个前序交接，将自动进入下一 phase 执行会话",
    )
    // 位置 = 确认（验收通过）按钮上方、动作区之内
    const approve = screen.getByTestId("acceptance-approve")
    expect(hint.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // rejected 态（打回面板展开）→ 不显示
    fireEvent.click(screen.getByTestId("acceptance-reject"))
    expect(screen.queryByTestId("handoff-hint")).toBeNull()
    // 收起面板 → 恢复
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(screen.getByTestId("handoff-hint")).toBeTruthy()
  })

  it("AC2: phase2 待验收、phase1 已 accepted → N=2", async () => {
    renderModalWith(P2_AWAITING_P1_ACCEPTED)
    const hint = await screen.findByTestId("handoff-hint")
    expect(hint.textContent).toContain("共 2 个前序交接")
  })

  it("AC2: 末 phase 待验收（无下一站）→ 不显示提示行", async () => {
    renderModalWith(LAST_PHASE_AWAITING)
    expect(await screen.findByTestId("acceptance-approve")).toBeTruthy()
    // 末 phase 的确认按钮 = 归档语义（守卫：awaiting 确实解析到了最后一栏）
    expect(screen.getByTestId("acceptance-approve").textContent).toContain("进入归档")
    expect(screen.queryByTestId("handoff-hint")).toBeNull()
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
