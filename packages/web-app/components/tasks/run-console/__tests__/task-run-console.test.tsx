// 执行态弹窗改版（2026-09-21）—— TaskRunConsole 回归：
//   • rail = 唯一状态位（票 11 钉点迁移：phase-timeline/phase-row-*/round chip/
//     legacy/⏳ 超预算 全在 rail 上复现）
//   • 五区去重：「任务概要/执行记录/Phase 时间线」标题不再出现，一个事实一次
//   • ready 门禁/触发、awaiting 判决条、done 战报、红行 error_summary 状态门控
//   • TaskModal 接线：三模式走新壳（terminal bar + 无 ModalHeader/悬浮 X）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useEffect } from "react"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDerivedView, TaskExecutionBadge, TaskPhaseView } from "@/lib/tasks-api"

const {
  mockGetTask, mockListArtifacts, mockFetchLLMCalls, mockGetBatchTree,
  mockPostAcceptance, mockAbort, mockReopen, mockCancelTrigger, mockPause, mockResume,
  pushSpy, mockFetchAgentEvents, mockGetRoundDiff, mockGetRoundPatch, mockFetchExecutionDetail,
  mockOpenReject, mockGetChatBinding, mockGetDoerHistory,
} = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockListArtifacts: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  mockGetBatchTree: vi.fn(),
  mockPostAcceptance: vi.fn(),
  mockAbort: vi.fn(),
  mockReopen: vi.fn(),
  mockCancelTrigger: vi.fn(),
  mockPause: vi.fn(),
  mockResume: vi.fn(),
  pushSpy: vi.fn(),
  mockFetchAgentEvents: vi.fn(),
  mockGetRoundDiff: vi.fn(),
  mockGetRoundPatch: vi.fn(),
  mockFetchExecutionDetail: vi.fn(),
  mockOpenReject: vi.fn(),
  // 票07：对话页签挂载后壳会真渲染 TaskChatTab —— 它对 tasks-api 的两个读取默认桩。
  mockGetChatBinding: vi.fn(),
  mockGetDoerHistory: vi.fn(),
}))

vi.mock("@/lib/api-client", () => ({
  fetchAgentEvents: mockFetchAgentEvents,
  // 票 04：节点页签挂载后壳内会真调执行详情读取（默认空快照，个案各自覆盖）。
  fetchExecutionDetail: mockFetchExecutionDetail,
}))

vi.mock("@/lib/tasks-api", () => ({
  getTask: mockGetTask,
  listArtifacts: mockListArtifacts,
  getBatchTree: mockGetBatchTree,
  postAcceptance: mockPostAcceptance,
  abortTask: mockAbort,
  reopenTask: mockReopen,
  cancelTaskTrigger: mockCancelTrigger,
  pauseTask: mockPause,
  resumeTask: mockResume,
  // 其余导入面（task-modal / trigger-dialog 等）——测试不触发，桩即可
  deleteTask: vi.fn(), createTask: vi.fn(), updateTask: vi.fn(), updateSpecField: vi.fn(),
  listTasks: vi.fn(), readyTask: vi.fn(), triggerTask: vi.fn(), duplicateTask: vi.fn(),
  TaskApiError: class extends Error { constructor(msg: string, public status = 0) { super(msg) } },
  ArtifactContentError: class extends Error {},
  WorkflowRefViewError: class extends Error {},
  getArtifactContent: vi.fn(), getWorkflowRefView: vi.fn(),
  getHomeFile: vi.fn(), putHomeFile: vi.fn(), listHomeDir: vi.fn(),
  // 票03「≡ 变更」接线：壳的 round-diff 单源节拍 + FilesTab 懒拉 patch
  getRoundDiff: mockGetRoundDiff, getRoundPatch: mockGetRoundPatch,
  // 票07 对话页签（TaskChatTab 真实挂载）：会话绑定 + 历史回放
  getTaskChatBinding: mockGetChatBinding, getDoerChatHistory: mockGetDoerHistory,
}))
vi.mock("@/lib/observability-api", () => ({ fetchLLMCalls: mockFetchLLMCalls }))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: () => () => {},
  subscribeSSEStatus: () => () => {},
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

// 重组件桩（只测控制台盘面编排，弹窗本体各有自己的测试）
vi.mock("../../authoring/artifact-viewer-dialog", () => ({ ArtifactViewerDialog: () => null }))
vi.mock("../../authoring/workflow-viewer-dialog", () => ({ WorkflowViewerDialog: () => null }))
vi.mock("../../authoring/phase-spec-dialog", () => ({
  PhaseSpecDialog: () => null,
  normalizeRel: (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, ""),
  specFileClass: () => ({ label: "md", tone: "bg-muted" }),
  batchDirOf: (p: string) => p.split("/").slice(0, -1).join("/"),
}))
vi.mock("../../acceptance/acceptance-surface", async () => {
  const { useEffect } = await import("react")
  return {
    AcceptanceSurface: ({ onActionApi }: { onActionApi?: (api: { requestAccept: () => void; openReject: (d?: string) => void; blocked: boolean } | null) => void }) => {
      // 与真实面同纪律：句柄经 onActionApi 注册（票07 对话页签「劝退→打回预填」走这条线）。
      useEffect(() => {
        onActionApi?.({ requestAccept: () => {}, openReject: (d?: string) => mockOpenReject(d), blocked: false })
        return () => onActionApi?.(null)
      }, [onActionApi])
      return <div data-acceptance-surface-stub />
    },
  }
})
// 票07：对话页签挂**真** TaskChatTab —— 壳层接线（form 映射/徽标联动/打回草稿/
// 追加干预通道）端到端可测；S1 读写面走 tasks-api mock + fetch 桩。
vi.mock("../../trigger-dialog", () => ({
  TriggerDialog: () => null,
  TriggerActions: () => null,
}))
vi.mock("../../authoring/authoring-workspace", () => ({ AuthoringWorkspace: () => <div data-testid="authoring-stub" /> }))

import { TaskRunConsole } from "../task-run-console"
import { TaskModal } from "../../task-modal"
import type { TaskView } from "@/lib/tasks-api"

// ── fixtures ─────────────────────────────────────────────────────────

const PHASES = [
  { index: 1, name: "票11阶段1", slug: "p1", specPath: "./.scratch/20260912/p1/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {} },
  { index: 2, name: "票11阶段2", slug: "p2", specPath: "./.scratch/20260912/p2/spec.md", workflowRef: "built-in/matt-dev-pipeline", inputValues: {} },
  { index: 3, name: "票11阶段3", slug: "p3", specPath: "./.scratch/20260912/p3/spec.md", workflowRef: "built-in/matt-e2e", inputValues: {} },
]

const SPEC = {
  format: "v4", goal: "把执行弹窗做成控制台", ac: ["一条一次"],
  phases: PHASES, autoAdvance: true,
  resources: [], authoring_resources: [], skill_groups: [], decisions: [], ac_confirmed: [],
} as unknown as TaskSpec

function makeTask(status: TaskView["status"], over: Partial<Task> = {}): TaskView {
  return {
    id: "task-1", org: "default", name: "控制台任务", status,
    task_spec: SPEC, authoring_resources: [], resources: [],
    skills: [], project_ids: ["octopus"],
    version: 5, source_chat_session_id: null,
    deleted_at: null, created_at: "2026-09-21T08:00:00Z", updated_at: "2026-09-21T09:00:00Z",
    completed_at: status === "done" || status === "failed" || status === "aborted" ? "2026-09-21T10:00:00Z" : null,
    trigger_mode: "manual", trigger_at: null, cron_expression: null,
    cron_timezone: "Asia/Shanghai", trigger_enabled: true,
    next_fire_at: null, last_fired_at: null, execution: null,
    ...over,
  }
}

function badge(id: string, status: string, over: Partial<TaskExecutionBadge> = {}): TaskExecutionBadge {
  return {
    id, status, workflow_ref: "built-in/matt-spec-dev", name: null,
    phase_index: 1, round_index: 1, workspace_id: "ws-1",
    started_at: "2026-09-21T09:00:00Z",
    completed_at: ["completed", "failed", "aborted", "cancelled"].includes(status) ? "2026-09-21T09:10:00Z" : null,
    created_at: "2026-09-21T08:59:00Z", error_summary: null,
    ...over,
  }
}

function pv(index: number, name: string, status: TaskPhaseView["status"], over: Partial<TaskPhaseView> = {}): TaskPhaseView {
  const rounds: TaskPhaseView["rounds"] = status === "pending" ? [] : [
    {
      roundIndex: 1,
      state: status === "running" ? "running" : "succeeded",
      decision: status === "accepted" ? "accepted" : null,
      exec: { id: `exec-${index}`, status: "completed", workflow_ref: "built-in/wf", phase_index: index, round_index: 1, created_at: "2026-09-21T08:59:00Z" },
    },
  ]
  return {
    index, name, slug: `p${index}`, workflowRef: "built-in/wf", status,
    rounds, currentRound: rounds.length || null,
    acceptedRound: status === "accepted" ? 1 : null,
    awaitingRound: status === "awaiting_review" ? 1 : null,
    ...over,
  }
}

/** `taskStatus` defaults to 在跑，which is what most fixtures want; a case whose task
 *  row is TERMINAL must pass the matching value. The server's derive cannot contradict a
 *  terminal row (task.status 'done'/'aborted'短路上优先，见 derive-task-view.ts 的分支链),
 *  so a fixture pairing a 'done' row with a 'running' derived view is not a state the
 *  product can be in — and since the console chrome now reads the derived status (as the
 *  board already does), such a fixture would assert against a fiction. */
function derivedOf(
  phaseViews: TaskPhaseView[],
  isV4 = true,
  taskStatus: TaskDerivedView["taskStatus"] = "running",
): TaskDerivedView {
  return { taskStatus, isV4, phaseViews }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
  mockGetTask.mockReset(); mockListArtifacts.mockReset(); mockFetchLLMCalls.mockReset()
  mockGetBatchTree.mockReset(); mockPostAcceptance.mockReset()
  mockAbort.mockReset(); mockReopen.mockReset(); mockCancelTrigger.mockReset()
  mockPause.mockReset(); mockResume.mockReset()
  pushSpy.mockReset()
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: null })
  mockListArtifacts.mockResolvedValue([])
  mockGetBatchTree.mockResolvedValue([])
  mockFetchAgentEvents.mockReset()
  mockFetchAgentEvents.mockResolvedValue({ executionId: "exec-x", events: [], source: "sqlite", _degraded: false, _message: null })
  // 票03 默认面：无轮可供（running/awaiting fixture 会撞 409 → FilesTab 错误面，
  // 不与任何既有断言争 DOM；需要看变更内容的用例自行覆盖 mock）。
  mockGetRoundDiff.mockReset()
  mockGetRoundDiff.mockRejectedValue(Object.assign(new Error("当前无待验收 round — 验货台只对 awaiting_review 的轮次供货"), { status: 409 }))
  mockGetRoundPatch.mockReset()
  mockGetRoundPatch.mockRejectedValue(new Error("patch n/a in console tests"))
  // 票04 默认面：节点页签读取执行详情（空快照；个案各自覆盖）。
  mockFetchExecutionDetail.mockReset()
  mockFetchExecutionDetail.mockResolvedValue({})
  // 票07 默认面：doer 会话就绪、历史空（对话组件各用例自行覆盖）。
  mockOpenReject.mockReset()
  mockGetChatBinding.mockReset()
  mockGetDoerHistory.mockReset()
  mockGetChatBinding.mockResolvedValue({ task_id: "task-1", session_id: "s-doer", workspace_id: "ws-1", created: false })
  mockGetDoerHistory.mockResolvedValue([])
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

/** 验货台 surface 是否**在场**（keep-mounted 2026-09-20：tab 切换不再卸载，改 hidden
 *  切显隐）。返回 false = 未挂载或被 hidden 挡住，两者对用户等价于「看不见」。 */
const acceptanceSurfaceVisible = (): boolean => {
  const stub = document.querySelector("[data-acceptance-surface-stub]")
  if (!stub) return false
  const wrap = stub.parentElement
  return !!wrap && !wrap.classList.contains("hidden")
}

const renderConsole = (task: Task, detail: Record<string, unknown>) => {
  mockGetTask.mockResolvedValue(detail)
  return render(<TaskRunConsole task={task} onMutated={() => {}} onClose={() => {}} />)
}

describe("TaskRunConsole — rail（唯一状态位，票 11 钉点迁移）", () => {
  it("ready + 3 pending phase → 3 个 phase-row 节点，「未开始」恰出现 3 次（全 UI 唯一状态位）", async () => {
    const t = makeTask("ready")
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending"), pv(2, "票11阶段2", "pending"), pv(3, "票11阶段3", "pending")], true, "ready") })
    expect(await screen.findByTestId("phase-timeline")).toBeTruthy()
    expect(screen.getByTestId("phase-row-1")).toBeTruthy()
    expect(screen.getByTestId("phase-row-2")).toBeTruthy()
    expect(screen.getByTestId("phase-row-3")).toBeTruthy()
    expect(screen.getAllByText("未开始")).toHaveLength(3)
    // 未选中的 phase 名只出现在 rail 一处（选中面的头部回声是语境标题，不算表格重复）
    expect(screen.getAllByText(/票11阶段2/)).toHaveLength(1)
    // 去重总账：三个旧区标题绝迹
    expect(screen.queryByText("任务概要")).toBeNull()
    expect(screen.queryByText("执行记录")).toBeNull()
    expect(screen.queryByText("Phase 时间线")).toBeNull()
    expect(screen.queryByText("草稿批次")).toBeNull()
  })

  it("running → 轮次 chip 带 ✓/▶ + ⏳ 超预算（env 小阈值），LIVE 卡与活动流在位", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHASE_BUDGET_MS", "1000")
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const t = makeTask("running")
    const views = [
      pv(1, "票11阶段1", "accepted"),
      { ...pv(2, "票11阶段2", "running"), rounds: [{ roundIndex: 1, state: "running" as const, decision: null, exec: { id: "exec-2", status: "running", workflow_ref: "built-in/wf", phase_index: 2, round_index: 1, created_at: old } }] },
    ]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "running", { workflow_ref: "built-in/wf", phase_index: 2, completed_at: null })], derived: derivedOf(views) })
    const chip = await screen.findByTestId("phase-round-2-1")
    expect(chip.getAttribute("data-overbudget")).toBe("true")
    expect(chip.textContent).toContain("⏳")
    expect(screen.getByTestId("phase-round-1-1").textContent).toContain("✓")
    expect(await screen.findByText(/LIVE ROUND/)).toBeTruthy()
    // 全绿 + 无在跑长命令 → 大事报整块不存在（「没事不显示」主用例）
    expect(screen.queryByText("大事报 / SIGNAL")).toBeNull()
    // 1 轮 + LIVE 卡在位 → ROUNDS 账本框不再把同一枚轮说第二遍（降噪定稿）
    expect(screen.queryByText("轮次 / ROUNDS")).toBeNull()
    // 自动选中在跑的 P2（选中 = outline 高亮）
    expect(screen.getByTestId("phase-row-2").getAttribute("class")).toContain("outline")
  })

  it("v3 legacy → 单节点 phase-row-legacy +「v3 单阶段」，运行行走战报账本", async () => {
    const t = makeTask("running", { task_spec: { ...SPEC, format: undefined } as TaskSpec })
    mockGetTask.mockResolvedValue({ ...t, executions: [badge("exec-9", "running", { phase_index: null, round_index: null })], derived: { taskStatus: "running", isV4: false, phaseViews: [] } })
    render(<TaskRunConsole task={t} onMutated={() => {}} onClose={() => {}} />)
    expect(await screen.findByTestId("phase-row-legacy")).toBeTruthy()
    expect(screen.getByText(/v3 单阶段/)).toBeTruthy()
    // 深链（V2 定稿后）：行内「流程图 ↗」章 → 新标签页，不再 router.push
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    const jump = await waitFor(() => {
      const el = document.querySelector("[data-run-deeplink=\"execution\"]") as HTMLElement
      if (!el) throw new Error("deeplink chip not mounted")
      return el
    })
    fireEvent.click(jump)
    expect(openSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-9", "_blank", expect.any(String))
    openSpy.mockRestore()
  })

  it("derived 缺失（旧 server）不崩，账本兜底", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, executions: [badge("exec-1", "running")], derived: undefined })
    expect(await screen.findByTestId("phase-timeline")).toBeTruthy()
    expect(screen.getByText("执行中", { selector: "[data-run-child] *" })).toBeTruthy()
  })
})

describe("TaskRunConsole — 五态皮肤与动作", () => {
  it("ready：门禁 + 大触发钮 + 条内（触发/退回草稿/中止）", async () => {
    mockGetBatchTree.mockResolvedValue([
      { dir: ".scratch/20260912/p1", slug: "p1", latest_mtime: "2026-09-21T09:00:00Z", files: [{ path: ".scratch/20260912/p1/spec.md", mtime: "2026-09-21T09:00:00Z", bytes: 2048 }] },
    ])
    const t = makeTask("ready")
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending"), pv(2, "票11阶段2", "pending")], true, "ready") })
    expect(await screen.findByText(/发射门禁/)).toBeTruthy()
    expect(screen.getByText(/每个 Phase 已绑定工作流（3\/3）/)).toBeTruthy()
    expect(screen.getByText(/spec\.md 落盘（1\/3）/)).toBeTruthy()
    const big = screen.getByText(/⚡ 触发执行/)
    fireEvent.click(big)
    expect(screen.getByText(/GOAL/)).toBeTruthy()
    // 盘上文件 chips（原草稿批次区的替身）：选中的 P1 已落盘（formatBytes 单源口径）
    expect(screen.getByText(/📄 spec\.md 2\.0 KB/)).toBeTruthy()
    // 切到 P2 → 未落盘警示（磁盘真相按选中面呈现）
    fireEvent.click(screen.getByTestId("phase-row-2"))
    expect(await screen.findByText(/📄 spec\.md 未落盘/)).toBeTruthy()
  })

  it("awaiting_review：交付报告在位，但决策入口撤出控制台（ADR-0022）→「去验货台」CTA 切 tab，不打 postAcceptance", async () => {
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "awaiting_review"), pv(3, "票11阶段3", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1, workflow_ref: "built-in/wf" })], derived: derivedOf(views, true, "awaiting_review") })
    // 票 02/07：待验收默认落「💬 对话」（真组件在场）—— 交付报告在「▶ 控制台」页签内
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    expect(await screen.findByText(/R1 交付报告/)).toBeTruthy()
    // 旧的 ✓通过/✕打回 判决条已撤 → 控制台不再直通 postAcceptance
    expect(screen.queryByTestId("acceptance-approve")).toBeNull()
    const cta = await screen.findByTestId("console-open-acceptance")
    expect(cta.textContent).toContain("去验货台")
    // keep-mounted 预挂：有 awaiting 轮时 surface 已挂载但被 hidden 挡着
    expect(acceptanceSurfaceVisible()).toBe(false)
    fireEvent.click(cta)
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
    expect(mockPostAcceptance).not.toHaveBeenCalled()
  })

  it("流程图入口（V2 定稿）：卡头/行内章均 window.open 新 tab，不再 router.push 顶走弹窗", async () => {
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1, workspace_id: "ws-e1" })], derived: derivedOf(views, true, "awaiting_review") })
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await screen.findByTestId("console-acceptance-card")
    fireEvent.click(screen.getByTestId("console-open-acceptance"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await screen.findByTestId("console-acceptance-card")
    const flow = document.querySelector("[data-run-deeplink=\"awaiting\"]") as HTMLElement
    expect(flow).toBeTruthy()
    fireEvent.click(flow)
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining("/workspaces/ws-e1?tab=detail&execId=exec-1"), "_blank", expect.any(String))
    // 点击流程图章不得误触整卡热区（stopPropagation）—— surface 在场但仍是藏着的
    expect(acceptanceSurfaceVisible()).toBe(false)
    openSpy.mockRestore()
  })

  it("全框折叠：点标题折/开（折上显一行结论徽章）+ 一键盘三态 + 按任务记忆", async () => {
    mockGetBatchTree.mockResolvedValue([{
      dir: ".scratch/20260912/p1", slug: "p1", latest_mtime: "2026-09-21T09:00:00Z",
      files: [
        { path: ".scratch/20260912/p1/spec.md", mtime: "2026-09-21T09:00:00Z", bytes: 2048 },
        { path: ".scratch/20260912/p1/issues/01-a.md", mtime: "2026-09-21T09:01:00Z", bytes: 100 },
      ],
    }])
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views, true, "awaiting_review") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await screen.findByText(/R1 交付报告/)
    const filesBox = () => document.querySelector('[data-fold-box="files"]') as HTMLElement
    const card = () => document.querySelector('[data-fold-box="deliver"]') as HTMLElement

    // ① 单框：点标题 → 折上，header 变一行结论（徽章= 件数·票数），内容不再占面
    fireEvent.click(screen.getByText("盘上文件"))
    expect(filesBox().getAttribute("data-fold-closed")).toBe("true")
    expect(filesBox().querySelector('[data-fold-badge="files"]')?.textContent).toContain("2 件 · 票×1")
    expect(screen.queryByTestId("file-bucket-all")).toBeNull()
    fireEvent.click(filesBox().querySelector("header")!) // 再点回开
    expect(filesBox().getAttribute("data-fold-closed")).toBeNull()

    // ② 交付卡用把手折（整卡 onClick=进验货台，点标题会误触 —— 专用小靶）
    fireEvent.click(document.querySelector('[data-fold-toggle="deliver"]') as HTMLElement)
    expect(card().getAttribute("data-fold-closed")).toBe("true")
    expect(card().querySelector('[data-fold-badge="deliver"]')?.textContent).toContain("✓ 执行成功")
    fireEvent.click(document.querySelector('[data-fold-toggle="deliver"]') as HTMLElement)

    // ③ 一键盘三态：收信息框（主卡留）→ 连主卡收 → 全展开
    const master = () => screen.getByTestId("fold-master")
    fireEvent.click(master())
    expect(filesBox().getAttribute("data-fold-closed")).toBe("true")
    expect(card().getAttribute("data-fold-closed")).toBeNull() // 主卡不伤验收动线
    fireEvent.click(master())
    expect(card().getAttribute("data-fold-closed")).toBe("true")
    fireEvent.click(master())
    expect(filesBox().getAttribute("data-fold-closed")).toBeNull()
    expect(card().getAttribute("data-fold-closed")).toBeNull()
    // ④ 按任务记忆落盘
    expect(localStorage.getItem("octopus-fold:task-1")).toContain('"mode":0')
  })

  it("走查 = 统一壳页签（票 02 装配 + 2026-09-16 keep-mounted 收编）：CTA/页签条切页内嵌 surface，可切回；startOnAcceptance 直达", async () => {
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views, true, "awaiting_review") })
    // 有待验收轮 → 装配出 对话·变更·走查·日志；surface 预挂但藏着（keep-mounted）
    const reviewTab = await screen.findByTestId("console-tab-review")
    expect(reviewTab.textContent).toContain("P1·R1")
    expect(acceptanceSurfaceVisible()).toBe(false)
    // 单入口定稿：旧「验货台核对实物 →」链与卡外绿横幅已删
    expect(screen.queryByText(/验货台核对实物/)).toBeNull()
    // 点页签进走查
    fireEvent.click(reviewTab)
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
    // 切回控制台（surface 仍在场，只是 hidden —— 复检会话不再因切换而失忆）
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(false))
    expect(screen.getByText(/R1 交付报告/)).toBeTruthy()
  })

  it("startOnAcceptance（看板「验收」按钮）：挂载即落走查页签", async () => {
    const t = makeTask("awaiting_review")
    mockGetTask.mockResolvedValue({ ...t, derived: derivedOf([pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")], true, "awaiting_review") } as never)
    render(<TaskRunConsole task={t} onMutated={() => {}} onClose={() => {}} startOnAcceptance />)
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
  })

  it("大事报（取代起收回放/动线）：挂过+自愈真信号上屏，全绿履历一个字不占；1 轮无 ROUNDS 框", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-2", source: "sqlite", _degraded: false, _message: null,
      events: [
        { nodeId: "__engine_init__", event: "start", timestamp: "2026-09-21T09:00:00Z" },
        // 全绿的节点（真数据里有 6 段 —— 一件不提）
        { nodeId: "spec-resolve", event: "start", timestamp: "2026-09-21T09:00:01Z" },
        { nodeId: "spec-resolve", event: "end", timestamp: "2026-09-21T09:00:01Z", durationMs: 48, status: "completed" },
        { nodeId: "e2e-verify", event: "start", timestamp: "2026-09-21T09:00:02Z" },
        // C 真形状：老行 input 空串，result 带 Exit code；后有同工具成功 = 自愈
        { nodeId: "e2e-verify", event: "tool_call", timestamp: "2026-09-21T09:01:00Z", toolName: "Bash", input: "", isError: true, result: "Exit code 1\nmvn -B -pl util install failed" },
        { nodeId: "e2e-verify", event: "tool_call", timestamp: "2026-09-21T09:03:00Z", toolName: "Bash", input: { command: "mvn -B -pl util install -am" }, result: "BUILD SUCCESS" },
        { nodeId: "e2e-verify", event: "end", timestamp: "2026-09-21T09:10:00Z", durationMs: 579337, status: "completed" },
      ],
    })
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "awaiting_review"), pv(3, "票11阶段3", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views, true, "awaiting_review") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    // ✗ 行：聚合计数 + 自愈判定 + result 首行详情（glyph 与文本同节，textContent 整取）
    await waitFor(() => expect(document.querySelector('[data-signal="bad"]')?.textContent).toMatch(/挂过 1 次 Bash（均已自愈）/))
    // 全绿履历一个字不占：没有节点清单、没有起收、没有 spec-resolve
    expect(screen.queryByText(/回放 ·/)).toBeNull()
    expect(screen.queryByText("spec-resolve")).toBeNull()
    expect(screen.queryByText("e2e-verify", { selector: "[data-flow-node]" })).toBeNull()
    // 1 轮 + 交付卡 → ROUNDS 框撤（卡即轮）
    expect(screen.queryByText("轮次 / ROUNDS")).toBeNull()
    // 取的是 awaiting 轮（exec-2）的执行，不是别的轮
    await waitFor(() => expect(mockFetchAgentEvents).toHaveBeenCalledWith("ws-1", "exec-2"))
  })

  it("大事报全绿即消失：待验收但本轮零异常 → 框整行不存在", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-2", source: "sqlite", _degraded: false, _message: null,
      events: [
        { nodeId: "spec-resolve", event: "start", timestamp: "2026-09-21T09:00:01Z" },
        { nodeId: "spec-resolve", event: "end", timestamp: "2026-09-21T09:00:02Z", durationMs: 1000, status: "completed" },
      ],
    })
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "awaiting_review")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views, true, "awaiting_review") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await screen.findByText(/R1 交付报告/) // 交付卡在位（说明盘面渲染完整）
    await waitFor(() => expect(mockFetchAgentEvents).toHaveBeenCalled())
    expect(screen.queryByText("大事报 / SIGNAL")).toBeNull()
  })

  it("轮次分档：≥2 轮账本框回来（打回史全留痕）", async () => {
    const t = makeTask("done")
    const two = {
      ...pv(1, "票11阶段1", "accepted"),
      rounds: [
        { roundIndex: 1, state: "failed" as const, decision: null, exec: { id: "exec-1a", status: "failed", workflow_ref: "built-in/wf", phase_index: 1, round_index: 1, created_at: "2026-09-21T08:00:00Z" } },
        { roundIndex: 2, state: "succeeded" as const, decision: "accepted" as const, exec: { id: "exec-1", status: "completed", workflow_ref: "built-in/wf", phase_index: 1, round_index: 2, created_at: "2026-09-21T08:59:00Z" } },
      ],
    }
    renderConsole(t, { ...t, executions: [badge("exec-1a", "failed", { round_index: 1 }), badge("exec-1", "completed", { round_index: 2 })], derived: derivedOf([two], true, "done") })
    await screen.findByText("任务战报")
    fireEvent.click(screen.getByTestId("phase-row-1"))
    expect(await screen.findByText("轮次 / ROUNDS")).toBeTruthy()
    expect(screen.getByText("2 轮")).toBeTruthy()
  })

  it("轮次分档：1 轮已判（无卡）→ 细条一行，不立框", async () => {
    const t = makeTask("done")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "accepted")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views, true, "done") })
    await screen.findByText("任务战报")
    fireEvent.click(screen.getByTestId("phase-row-2"))
    expect(await screen.findByTestId("round-strip-2")).toBeTruthy()
    expect(screen.queryByText("轮次 / ROUNDS")).toBeNull()
  })

  it("盘上文件分桶：19 件只铺 ≤5 枚章，散文件名绝迹", async () => {
    const dir = ".scratch/20260912/p1"
    const f = (p: string, bytes = 100, mtime = "2026-09-21T09:00:00Z") => ({ path: `${dir}/${p}`, mtime, bytes })
    mockGetBatchTree.mockResolvedValue([{
      dir, slug: "p1", latest_mtime: "2026-09-21T09:00:00Z",
      files: [
        f("spec.md", 2048),
        f("issues/01-a.md"), f("issues/02-b.md"), f("issues/03-e2e-luhn.md", 300, "2026-09-21T09:05:00Z"),
        f("round-report.md", 300, "2026-09-21T09:06:00Z"), f("code-review.md"),
        f("e2e-data/00-run.log"), f("e2e-data/e2e-report.md"), f("e2e-data/walkthrough-true.json"),
        ...Array.from({ length: 10 }, (_, i) => f(`e2e-data/junk-${i}.log`)),
      ],
    }])
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views, true, "awaiting_review") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    expect(await screen.findByTestId("file-bucket-issues")).toBeTruthy()
    expect(screen.getByTestId("file-bucket-issues").textContent).toContain("×3")
    expect(screen.getByTestId("file-bucket-reports").textContent).toContain("×2")
    expect(screen.getByTestId("file-bucket-evidence").textContent).toContain("证据 e2e-data")
    expect(screen.getByTestId("file-bucket-all").textContent).toContain("全部 19")
    // 散章绝迹：单文件不再各占一枚
    expect(screen.queryByText(/junk-0\.log/)).toBeNull()
    expect(screen.queryByText(/walkthrough-true\.json/)).toBeNull()
  })

  it("done：默认战报（4 数字瓦片 + 轮次账本 + 产物），rail「任务战报」可切回 phase 面", async () => {
    mockListArtifacts.mockResolvedValue([
      { path: "artifacts/report.md", by: "agent-1", title: "综合报告", external: false, updated_at: "2026-09-21T10:00:00Z" },
    ])
    const t = makeTask("done")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "accepted")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views, true, "done") })
    expect(await screen.findByText("任务战报")).toBeTruthy()
    expect(screen.getByText("实际用时")).toBeTruthy()
    expect(screen.getByText("AI 总成本")).toBeTruthy()
    expect(screen.getByText("综合报告")).toBeTruthy()
    // 点 rail P2 → phase 面（轮次账本在位）
    fireEvent.click(screen.getByTestId("phase-row-2"))
    expect(await screen.findByText(/P2 · 票11阶段2/)).toBeTruthy()
  })

  it("failed：红行显示 error_summary；绿行遗留键绝不显示（票05 状态门控迁移）", async () => {
    const t = makeTask("failed")
    renderConsole(t, {
      ...t,
      executions: [
        badge("exec-1", "failed", { error_summary: "对账回收：引擎进程已丢失" }),
        badge("exec-2", "completed", { phase_index: 2, round_index: 1, error_summary: "上一轮遗留键" }),
      ],
      derived: derivedOf([
        { ...pv(1, "票11阶段1", "accepted"), rounds: [{ roundIndex: 1, state: "failed" as const, decision: null, exec: { id: "exec-1", status: "failed", workflow_ref: "wf", phase_index: 1, round_index: 1, created_at: "2026-09-21T08:59:00Z" } }] },
      ], true, "failed"),
    })
    expect(await screen.findByText("对账回收：引擎进程已丢失")).toBeTruthy()
    expect(screen.queryByText("上一轮遗留键")).toBeNull()
  })

  it("暂停中：chrome 读派生态 —— pill 显「已暂停」、给「恢复」而非「暂停」、秒表让位", async () => {
    // 持久 task.status 仍是 'running'（暂停不写 task 行），所以这条同时钉住「整套
    // chrome 必须读 effectiveStatusOf 派生态」这件事：若退回读 task.status，pill 会
    // 自称「执行中」并继续渲染秒表，而卡片那边显示「已暂停」—— 两个面自相矛盾。
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    expect(await screen.findByText(/⏸ 已暂停/)).toBeTruthy()
    expect(document.querySelector('[data-task-modal-status="paused"]')).toBeTruthy()
    // 暂停不是「在跑」：给恢复，不给暂停。
    expect(document.querySelector("[data-task-resume]")).toBeTruthy()
    expect(document.querySelector("[data-task-pause]")).toBeNull()
    // 中止必须仍然在 —— 暂停的退出只有恢复与中止。
    expect(document.querySelector("[data-task-abort]")).toBeTruthy()
  })

  it("暂停中：没有 running 轮就不给「暂停」钮（停在审批等人的运行不在其列）", async () => {
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "pending_approval", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    // 有活轮但没在 running → 不给暂停；也没 paused 轮 → 不给恢复。
    expect(await screen.findByTestId("phase-timeline")).toBeTruthy()
    expect(document.querySelector("[data-task-pause]")).toBeNull()
    expect(document.querySelector("[data-task-resume]")).toBeNull()
  })

  it("运行中：点「暂停」打 pauseTask；暂停盘面「▶ 恢复」经注入弹框落 resumeTask（票 06 接线）", async () => {
    mockPause.mockResolvedValue({})
    mockResume.mockResolvedValue({})
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByText(/⏸ 暂停/))
    await waitFor(() => expect(mockPause).toHaveBeenCalledWith("task-1"))

    // 恢复钮只在有 paused 轮时出现 —— 换一份盘面重渲染。
    const t2 = makeTask("running")
    renderConsole(t2, {
      ...t2,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    fireEvent.click(await screen.findByText(/▶ 恢复/))
    expect(mockResume).not.toHaveBeenCalled() // 先弹框，不直接放行（票 06）
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.click(within(dlg).getByTestId("inject-plain"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"))
  })

  it("ready+已定时：条内 ⏰ 已定时 token + 取消触发（打 cancelTaskTrigger），大触发钮让位", async () => {
    mockCancelTrigger.mockResolvedValue({})
    const future = new Date(Date.now() + 3600_000).toISOString()
    const t = makeTask("ready", { next_fire_at: future, trigger_mode: "once" } as Partial<Task>)
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending")], true, "ready") })
    expect(await screen.findByText(/⏰ 已定时/)).toBeTruthy()
    expect(screen.queryByText(/⚡ 触发执行/)).toBeNull()
    fireEvent.click(screen.getByText(/✕ 取消触发/))
    await waitFor(() => expect(mockCancelTrigger).toHaveBeenCalledWith("task-1"))
  })
})

// ═════════════════ 票 06 · 干预接线（⏸ → 注入 → 恢复）════════════════
// 交互真相源 = 原型 taskboard-v2.html openInject/resume(withInj)：
// 暂停后 rail 钮变「▶ 恢复 · 可注入干预」→ 弹「恢复执行 — 注入干预」三分支框
// （取消（保持暂停）/ 直接继续 ▶ / ⚑ 注入干预并继续）；注入行 = 原文逐字走
// resumeTask(id, intervention)；⚑ 高亮行与 LIVE 卡 ⚑ 干预×N 从既有 agent-events
// 读取面渲染；执行盘面除弹框内外接输入口为零（不打扰模式）。
describe("票 06 — 恢复弹框三分支（⏸→注入→恢复）", () => {
  const pausedView = {
    executions: [badge("exec-1", "paused", { completed_at: null })],
    derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
  }

  it("暂停后 rail 钮 =「▶ 恢复 · 可注入干预」；点击只弹框，一次 API 都不打", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    const btn = await screen.findByText(/▶ 恢复 · 可注入干预/)
    expect(document.querySelector("[data-task-resume]")).toBeTruthy()
    fireEvent.click(btn)
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    expect(dlg.textContent).toContain("恢复执行 — 注入干预")
    // 三键逐字（原型）：
    expect(within(dlg).getByTestId("inject-cancel").textContent).toContain("取消（保持暂停）")
    expect(within(dlg).getByTestId("inject-plain").textContent).toContain("直接继续")
    expect(within(dlg).getByTestId("inject-confirm").textContent).toContain("⚑ 注入干预并继续")
    expect(mockResume).not.toHaveBeenCalled()
    // 不打扰铁律的另一面：盘面本身此刻唯一的 textarea 就是这个弹框里的。
    expect(document.querySelectorAll("textarea")).toHaveLength(1)
  })

  it("取消（保持暂停）= 关窗零调用，暂停盘面原样还在", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.click(within(dlg).getByTestId("inject-cancel"))
    await waitFor(() => expect(document.querySelector('[data-testid="resume-intervene-dialog"]')).toBeNull())
    expect(mockResume).not.toHaveBeenCalled()
    // 状态没被动过：暂停盘面（派生 paused + 恢复钮）依旧。
    expect(document.querySelector('[data-task-modal-status="paused"]')).toBeTruthy()
    expect(document.querySelector("[data-task-resume]")).toBeTruthy()
  })

  it("直接继续 ▶ = resumeTask(id) 不带干预（textarea 写了字也不带）", async () => {
    mockResume.mockResolvedValue({})
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    const ta = within(dlg).getByTestId("inject-textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "其实想注入但按了直接继续" } })
    fireEvent.click(within(dlg).getByTestId("inject-plain"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"))
    expect(mockResume.mock.calls[0].length).toBe(1)
  })

  it("⚑ 注入干预并继续 = resumeTask(id, 原文逐字)", async () => {
    mockResume.mockResolvedValue({})
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.change(within(dlg).getByTestId("inject-textarea"), { target: { value: "  不要动 Dialog 尺寸逻辑，直接换固定壳  " } })
    fireEvent.click(within(dlg).getByTestId("inject-confirm"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1", "不要动 Dialog 尺寸逻辑，直接换固定壳"))
  })

  it("空文本点注入 = 按原样继续 + 提示，不硬拦", async () => {
    mockResume.mockResolvedValue({})
    const { toast } = await import("sonner")
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.click(within(dlg).getByTestId("inject-confirm"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"))
    expect(mockResume.mock.calls[0].length).toBe(1)
    expect(toast.warning).toHaveBeenCalledWith("没写干预内容 — 按原样继续")
  })

  it("超 4000 字符：注入键禁用 + 计数提示（上限与服务端 400 同额）", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.change(within(dlg).getByTestId("inject-textarea"), { target: { value: "x".repeat(4001) } })
    const injectBtn = within(dlg).getByTestId("inject-confirm") as HTMLButtonElement
    expect(injectBtn.disabled).toBe(true)
    expect(dlg.textContent).toContain("4000")
  })

  it("注入失败：恢复失败原样透出，弹框关闭不误报成功", async () => {
    mockResume.mockRejectedValue(new Error("执行未处于暂停状态"))
    const { toast } = await import("sonner")
    const t = makeTask("running")
    renderConsole(t, { ...t, ...pausedView })
    fireEvent.click(await screen.findByText(/▶ 恢复 · 可注入干预/))
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.change(within(dlg).getByTestId("inject-textarea"), { target: { value: "纠偏" } })
    fireEvent.click(within(dlg).getByTestId("inject-confirm"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("执行未处于暂停状态"))
  })

  it("⏸ 拒绝透传：引擎「没有运行中的节点」原话进 toast（状态不变的友好错误）", async () => {
    mockPause.mockRejectedValue(new Error("执行当前没有运行中的节点，无法暂停"))
    const { toast } = await import("sonner")
    const t = makeTask("running")
    renderConsole(t, { ...t, executions: [badge("exec-1", "running", { completed_at: null })], derived: derivedOf([pv(1, "票11阶段1", "running")]) })
    fireEvent.click(await screen.findByText(/⏸ 暂停/))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("执行当前没有运行中的节点，无法暂停"))
    // 按钮态不骗人：没暂停成功就还是暂停钮，不出现恢复钮。
    expect(document.querySelector("[data-task-pause]")).toBeTruthy()
    expect(document.querySelector("[data-task-resume]")).toBeNull()
  })
})

describe("票 06 — ⚑ 行进日志 + LIVE 卡计数 + 无游离输入", () => {
  const ivEvent = {
    nodeId: "dev", event: "intervention", timestamp: "2026-10-08T02:00:00.000Z",
    data: { nodeId: "dev", nodeName: "开发/修复", prompt: "别动 Dialog 尺寸逻辑，直接换固定壳" },
  }

  it("agent-events 里的 ⚑ 行渲染进控制台页签：节点名 + 原文 + 高亮", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-1", source: "sqlite", _degraded: false, _message: null,
      events: [
        { nodeId: "dev", event: "start", timestamp: "2026-10-08T01:59:00.000Z" },
        ivEvent,
      ],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    // paused 默认落「▶ 控制台」；⚑ 行来自 replayTarget 的事件拉取
    const log = await screen.findByTestId("intervention-log")
    const line = within(log).getAllByTestId("intervention-line")[0]
    expect(line.textContent).toContain("⚑ 人工干预")
    expect(line.textContent).toContain("节点「开发/修复」")
    expect(line.textContent).toContain("别动 Dialog 尺寸逻辑，直接换固定壳")
    // 高亮 = 粉色语义（spec：干预高亮=pink 行）
    expect(line.className).toContain("pop-pink")
  })

  it("LIVE 卡 ⚑ 干预×N：当前节点每次注入 +1（同节点累计）", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-1", source: "sqlite", _degraded: false, _message: null,
      events: [
        { ...ivEvent, timestamp: "2026-10-08T01:50:00.000Z" },
        { ...ivEvent, timestamp: "2026-10-08T02:00:00.000Z" },
      ],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    const chip = await screen.findByTestId("rail-intervention-chip")
    expect(chip.textContent).toContain("⚑ 干预×2")
  })

  it("无干预的盘面：⚑ 区整块不存在，且整个执行壳零游离 textarea/input（不打扰模式）", async () => {
    mockFetchAgentEvents.mockResolvedValue({ executionId: "exec-1", events: [], source: "sqlite", _degraded: false, _message: null })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    await screen.findByTestId("phase-timeline")
    expect(screen.queryByTestId("intervention-log")).toBeNull()
    expect(screen.queryByTestId("rail-intervention-chip")).toBeNull()
    // running 默认「变更」页 + 切到控制台页：两处都摸不着一枚输入框
    expect(document.querySelectorAll("textarea")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await screen.findByText(/P1 · 票11阶段1/)
    expect(document.querySelectorAll("textarea")).toHaveLength(0)
    // rail 恢复钮也不在场（只有 ⏸ 暂停）—— 注入口只在「▶ 恢复 · 可注入干预」之后
    expect(document.querySelector("[data-task-resume]")).toBeNull()
  })
})

describe("TaskModal 接线（新壳）", () => {
  function renderModal(task: TaskView) {
    return render(<TaskModal open onOpenChange={() => {}} task={task} onMutated={() => {}} />)
  }

  it("running → 控制台 + terminal 导航条，旧 ModalHeader/footer 双横幅消失", async () => {
    const t = makeTask("running")
    mockGetTask.mockResolvedValue({ ...t, executions: [badge("exec-1", "running")], derived: derivedOf([pv(1, "票11阶段1", "running")]) })
    renderModal(t)
    expect(await screen.findByTestId("phase-timeline")).toBeTruthy()
    expect(document.querySelector("[data-terminal-bar]")).toBeTruthy()
    expect(document.querySelector('[data-task-modal-status="running"]')).toBeTruthy()
    // 旧 header 副标题与旧 footer 横幅绝迹
    expect(screen.queryByText("执行")).toBeNull()
    // 悬浮关闭 X 让位条内关闭方糖
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull()
    expect(document.querySelector('[data-terminal-bar] button[aria-label="关闭"]')).toBeTruthy()
    expect(screen.getByText(/■ 中止/)).toBeTruthy()
  })

  it("done/failed → 同壳（战报 + 状态 pill），不再渲染「任务完成/任务失败」独立横幅", async () => {
    const t = makeTask("done")
    mockGetTask.mockResolvedValue({ ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "accepted")], true, "done") })
    renderModal(t)
    expect(await screen.findByText("任务战报")).toBeTruthy()
    expect(document.querySelector('[data-task-modal-status="done"]')).toBeTruthy()
    expect(screen.queryByText(/^任务完成 ·/)).toBeNull()
  })
})

// ═════════════════ 票 02 · 统一弹窗壳 ═════════════════
// 断言的期望逐条来自 spec.md 统一壳条目 + 原型 taskboard-v2.html 壳结构：
// 顶栏只剩 标题+pill+元信息+⛶/✕（无动作、无红绿灯）；动作区 = 右栏底部
// [data-rail-acts]；页签按装配表；←/→ 切页；Esc 关 console 壳（草稿不关）。
describe("票 02 — 顶栏瘦身（无动作按钮、无红绿灯）", () => {
  const runningView = {
    executions: [badge("exec-1", "running", { completed_at: null })],
    derived: derivedOf([pv(1, "票11阶段1", "running")]),
  }

  it("顶栏导航条内不再有任何动作锚点（pause/abort/trigger/duplicate），红绿灯 <i> 圆点绝迹", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, ...runningView })
    const bar = await waitFor(() => {
      const el = document.querySelector("[data-terminal-bar]")
      if (!el) throw new Error("header not mounted")
      return el
    })
    for (const anchor of ["data-task-pause", "data-task-resume", "data-task-abort", "data-task-trigger", "data-task-trigger-cancel", "data-task-reopen", "data-task-duplicate", "data-acceptance-open-bar"]) {
      expect(bar.querySelector(`[${anchor}]`)).toBeNull()
    }
    expect(bar.querySelector("i[style], i.bg-pop-pink, i")).toBeNull() // 红绿灯装饰圆点已删
    // 保留：状态 pill + 关闭
    expect(bar.querySelector('[data-task-modal-status="running"]')).toBeTruthy()
    expect(bar.querySelector('button[aria-label="关闭"]')).toBeTruthy()
  })

  it("running：动作锚点全部在右栏底部 [data-rail-acts] 内（暂停/中止/复制）", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, ...runningView })
    await screen.findByTestId("phase-timeline")
    const acts = document.querySelector("[data-rail-acts]")
    expect(acts).toBeTruthy()
    expect(acts!.querySelector("[data-task-pause]")).toBeTruthy()
    expect(acts!.querySelector("[data-task-abort]")).toBeTruthy()
    expect(acts!.querySelector("[data-task-duplicate]")).toBeTruthy()
    expect(acts!.querySelector("[data-task-resume]")).toBeNull() // paused 才给恢复
  })

  it("paused：右栏底部给「▶ 恢复 · ■ 中止」（既有 handler 不回退）", async () => {
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    await screen.findByTestId("phase-timeline")
    const acts = document.querySelector("[data-rail-acts]")!
    expect(acts.querySelector("[data-task-resume]")).toBeTruthy()
    expect(acts.querySelector("[data-task-abort]")).toBeTruthy()
    // 点恢复 = 弹「注入干预」三分支框（票 06），确认「直接继续」才打 resumeTask —— 行为单源不旁路。
    mockResume.mockResolvedValue({})
    fireEvent.click(acts.querySelector("[data-task-resume]")!)
    const dlg = await screen.findByTestId("resume-intervene-dialog")
    fireEvent.click(within(dlg).getByTestId("inject-plain"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"))
  })

  it("awaiting_review：右栏底部装配 通过/打回（走查 tab 保持挂载供接线）", async () => {
    const t = makeTask("awaiting_review")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review"),
    })
    await screen.findByTestId("phase-timeline")
    const acts = document.querySelector("[data-rail-acts]")
    expect(acts).toBeTruthy()
    expect(acts!.querySelector("[data-rail-accept]")).toBeTruthy()
    expect(acts!.querySelector("[data-rail-reject]")).toBeTruthy()
    expect(acts!.querySelector("[data-task-pause]")).toBeNull()
    // 验货台 surface keep-mounted（hidden 壳内，挂载闸随 awaiting 轮亮起）；走查页签在场
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
    expect(screen.getByTestId("console-tab-review")).toBeTruthy()
  })
})

describe("票 02 — 页签装配 + 键盘", () => {
  it("running v4：变更·节点·控制台，默认落「变更」且出真实内容（票 03 已落地）", async () => {
    mockGetRoundDiff.mockResolvedValue({
      available: true,
      aggregate: { commits: 3, additions: 40, dels: 6, files: 2 },
      interventions: null,
      repos: [{
        name: "octopus", commits: 3, additions: 40, dels: 6, files: 1, truncated: false,
        groups: [{ dir: "packages", additions: 40, dels: 6, files: [{ path: "packages/x.ts", status: "M", adds: 40, dels: 6 }] }],
      }],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    const filesTab = await screen.findByTestId("console-tab-files")
    expect(screen.getByTestId("console-tab-nodes")).toBeTruthy()
    expect(screen.getByTestId("console-tab-console")).toBeTruthy()
    expect(screen.queryByTestId("console-tab-chat")).toBeNull() // 对话页签不进 running 装配
    expect(screen.queryByTestId("console-tab-review")).toBeNull()
    expect(filesTab.getAttribute("aria-selected")).toBe("true")
    // 票 03：占位纸退位，GitHub 式实物面板在场（统计条 + 文件行 + 数据源标注）。
    const host = document.querySelector('[data-tab-host="files"]')
    expect(host).toBeTruthy()
    expect(host!.textContent).not.toContain("票 03")
    expect(await screen.findByTestId("round-diff-strip")).toBeTruthy()
    expect(await waitFor(() => {
      const row = host!.querySelector('[data-acceptance-diff-row="octopus:packages/x.ts"]')
      if (!row) throw new Error("file row not fed yet")
      return true
    })).toBe(true)
    expect(host!.textContent).toContain("与走查面同源")
  })

  it("票03→02 契约：顶栏 [data-head-commits] 由变更页签的 round-diff aggregate 喂数", async () => {
    mockGetRoundDiff.mockResolvedValue({
      available: true,
      aggregate: { commits: 3, additions: 40, dels: 6, files: 2 },
      interventions: null,
      repos: [{ name: "octopus", commits: 3, additions: 40, dels: 6, files: 2, truncated: false, groups: [] }],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    await waitFor(() => expect(document.querySelector("[data-head-commits]")?.textContent).toContain("3 commits"))
    expect(document.querySelector("[data-head-commits]")?.getAttribute("data-head-commits")).toBe("3")
  })

  it("awaiting_review：对话·变更·走查·日志，默认落「对话」（票 07 已挂载 —— 占位话术绝迹）", async () => {
    const t = makeTask("awaiting_review")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review"),
    })
    const chatTab = await screen.findByTestId("console-tab-chat")
    expect(chatTab.getAttribute("aria-selected")).toBe("true")
    for (const key of ["files", "review", "console"]) expect(screen.getByTestId(`console-tab-${key}`)).toBeTruthy()
    const host = document.querySelector('[data-tab-host="chat"]')
    expect(host?.textContent).not.toContain("票 07")
    expect(within(host as HTMLElement).getByTestId("task-chat-tab").getAttribute("data-chat-form")).toBe("quick-edit")
  })

  it("startOnAcceptance：默认落「✓ 走查」且 surface 可见", async () => {
    const t = makeTask("awaiting_review")
    mockGetTask.mockResolvedValue({
      ...t,
      executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review"),
    } as never)
    render(<TaskRunConsole task={t} onMutated={() => {}} onClose={() => {}} startOnAcceptance />)
    expect((await screen.findByTestId("console-tab-review")).getAttribute("aria-selected")).toBe("true")
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
  })

  it("→ 顺序切页并回卷；← 反向；输入框聚焦时忽略", async () => {
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    await screen.findByTestId("console-tab-files")
    const selected = () => document.querySelector('[data-console-tab][aria-selected="true"]')?.getAttribute("data-console-tab")
    expect(selected()).toBe("files")
    fireEvent.keyDown(window.document, { key: "ArrowRight" })
    expect(selected()).toBe("nodes")
    fireEvent.keyDown(window.document, { key: "ArrowRight" })
    expect(selected()).toBe("console")
    fireEvent.keyDown(window.document, { key: "ArrowRight" }) // 末位回卷
    expect(selected()).toBe("files")
    fireEvent.keyDown(window.document, { key: "ArrowLeft" })
    expect(selected()).toBe("console")
    // 输入聚焦 → 吞掉方向键（不劫持光标）
    const ta = document.createElement("textarea")
    document.body.appendChild(ta)
    fireEvent.keyDown(ta, { key: "ArrowRight", bubbles: true })
    expect(selected()).toBe("console")
    ta.remove()
  })

  it("v3 legacy：derived.isV4=false → 只剩「▶ 控制台」一页（占位页签不压旧任务）", async () => {
    const t = makeTask("running", { task_spec: { ...SPEC, format: undefined } as TaskSpec })
    renderConsole(t, { ...t, executions: [badge("exec-9", "running", { phase_index: null, round_index: null })], derived: { taskStatus: "running", isV4: false, phaseViews: [] } })
    await screen.findByTestId("console-tab-console")
    expect(screen.queryByTestId("console-tab-files")).toBeNull()
    expect(screen.queryByTestId("console-tab-nodes")).toBeNull()
  })
})

describe("票 02 — TaskModal 三态同壳 + Esc", () => {
  it("running / awaiting_review / done 三卡打开同一 [data-run-console] 壳", async () => {
    for (const [status, dv] of [
      ["running", derivedOf([pv(1, "票11阶段1", "running")])],
      ["awaiting_review", derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review")],
      ["done", derivedOf([pv(1, "票11阶段1", "accepted")], true, "done")],
    ] as const) {
      const t = makeTask(status)
      mockGetTask.mockResolvedValue({ ...t, executions: [badge(`exec-${status}`, status === "running" ? "running" : "completed", { completed_at: status === "running" ? null : "2026-09-21T09:10:00Z" })], derived: dv })
      const { unmount } = render(<TaskModal open onOpenChange={() => {}} task={t} onMutated={() => {}} />)
      await waitFor(() => expect(document.querySelector("[data-run-console]")).toBeTruthy())
      // 同一壳：标题在顶栏（sr-only DialogTitle 之外只有条内一处可及文本）
      const bar = document.querySelector("[data-terminal-bar]")!
      expect(bar.textContent).toContain("控制台任务")
      expect(document.querySelector('[data-task-modal-status]')).toBeTruthy()
      unmount()
    }
  })

  it("Esc：console 壳关窗（onOpenChange(false)）；草稿窗不关（2026-09-24 旧裁决保留在 authoring）", async () => {
    const onClose = vi.fn()
    const t = makeTask("running")
    mockGetTask.mockResolvedValue({ ...t, executions: [badge("exec-1", "running", { completed_at: null })], derived: derivedOf([pv(1, "票11阶段1", "running")]) })
    render(<TaskModal open onOpenChange={onClose} task={t} onMutated={() => {}} />)
    await screen.findByTestId("phase-timeline")
    fireEvent.keyDown(window.document, { key: "Escape" })
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false))

    const onCloseDraft = vi.fn()
    const d = makeTask("draft")
    mockGetTask.mockResolvedValue({ ...d, executions: [], derived: undefined })
    render(<TaskModal open onOpenChange={onCloseDraft} task={d} onMutated={() => {}} />)
    await screen.findByTestId("authoring-stub")
    fireEvent.keyDown(window.document, { key: "Escape" })
    expect(onCloseDraft).not.toHaveBeenCalled()
  })
})

// ═════════════════ 票 04 · ◆ 节点页签挂载 ═════════════════
// 壳侧只钉接线两件事：占位被真组件替换 + 绑定执行取当前面轮次（含深链上下文）。
// 清单/事件/符号的丰富断言在 nodes-tab.test.tsx / nodes-model.test.ts（组件自有 seam）。
describe("票 04 — NodesTab 挂进 [data-tab-host=\"nodes\"]", () => {
  it("running 切到 ◆ 节点：绑定 exec-1 的节点清单出现在宿主内，占位话术绝迹，深链带 P/R 语境", async () => {
    mockFetchExecutionDetail.mockResolvedValue({
      id: "exec-1", status: "running", workflow_ref: "built-in/matt-spec-dev",
      workflow_content: "nodes:\n  - id: resolve\n    name: 需求解析\n    type: agent\n  - id: dev\n    name: 开发流水线\n    type: agent\n",
      steps: [
        { stepId: "resolve", stepName: "resolve", status: "completed", duration: 40 },
        { stepId: "dev", stepName: "dev", status: "running", startedAt: "2026-09-21T09:01:00Z" },
      ],
    })
    const t = makeTask("running")
    renderConsole(t, { ...t, executions: [badge("exec-1", "running", { completed_at: null })], derived: derivedOf([pv(1, "票11阶段1", "running")]) })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-nodes"))
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement | null
    expect(host).toBeTruthy()
    expect(await within(host!).findByTestId("node-row-dev")).toBeTruthy()
    expect(host!.textContent).toContain("需求解析")
    expect(host!.textContent).toContain("1/2") // 汇总条：resolve ✓ 计入，dev 在跑不计
    expect(host!.querySelector('[data-testid="nodes-deeplink"]')).toBeTruthy()
    expect(host!.textContent).toContain("P1·R1")
    // 票 02 占位话术已被真组件替换
    expect(host!.textContent).not.toContain("票 04")
  })

  it("ready 未触发（executions 空）：宿主内如实空态，不编造清单", async () => {
    const t = makeTask("ready")
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending")], true, "ready") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-nodes"))
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement | null
    expect(await within(host!).findByTestId("nodes-empty")).toBeTruthy()
    expect(host!.textContent).toContain("尚无绑定执行")
    expect(mockFetchExecutionDetail).not.toHaveBeenCalled()
  })
})

// ═════════════════ 票 07 · 💬 对话页签挂载与三形态接线 ═════════════════
// 壳层端到端钉四根线：形态映射（quick-edit/fixing）、快改徽标 + ×N chip（03 钩子）、
// 「查看 diff」跳变更闪行（reveal）、劝退→打回草稿（05 句柄）、修复轮发消息 =
// 06 的暂停→注入通道。对话内部行为（流解析/工具卡行差）在 chat/__tests__ 各自钉死。
describe("票 07 — 💬 对话页签挂进 [data-tab-host=chat] 与快改联动", () => {
  /** SSE 文本 → fetch Response（parseSSEStream 吃 reader）。 */
  function sseResponse(text: string): Response {
    const bytes = new TextEncoder().encode(text)
    let fired = false
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (fired ? { done: true, value: undefined } : ((fired = true), { done: false, value: bytes })) }) },
    } as unknown as Response
  }
  const frame = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ sessionId: "s-doer", ...payload })}\n\n`

  const EDIT_FILE = "C:\\ws\\projects\\octopus\\packages\\web-app\\a.tsx"
  const CHAT_ROUND_DIFF = {
    available: true,
    aggregate: { commits: 1, additions: 2, dels: 2, files: 1 },
    interventions: null,
    repos: [{
      name: "octopus", commits: 1, additions: 2, dels: 2, files: 1, truncated: false,
      groups: [{ dir: "packages/web-app", additions: 2, dels: 2, files: [{ path: "packages/web-app/a.tsx", status: "M", adds: 2, dels: 2 }] }],
    }],
  }

  const turnEdit = [
    frame("tool_call_start", { type: "tool_call_start", messageId: "m1", toolCallId: "tc1", toolName: "Edit" }),
    frame("tool_call", {
      type: "tool_call", messageId: "m1", toolCallId: "tc1", toolName: "Edit",
      toolInput: { file_path: EDIT_FILE, old_string: "x1\nx2", new_string: "y1\ny2" },
    }),
    frame("tool_result", { type: "tool_result", toolCallId: "tc1", content: "ok", isError: false }),
    frame("text_delta", { type: "text_delta", messageId: "m1", content: "改好了 —— 圆角已提到 18px。" }),
    frame("result", { type: "result", content: "" }),
    frame("quick_edit_commit", { type: "quick_edit_commit", taskId: "task-1", repo: "octopus", branch: "feat-x", commit: "abc123", message: "[quick-edit] 圆角再大一点" }),
  ].join("")

  const awaitingDetail = (t: TaskView) => ({
    ...t,
    executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
    derived: derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review"),
  })

  it("待验收默认对话形态；发小改→commit 尾帧：变更行出 💬chat 徽标 + ×N chip；「查看 diff」跳变更并闪行", async () => {
    mockGetRoundDiff.mockResolvedValue(CHAT_ROUND_DIFF)
    mockGetRoundPatch.mockResolvedValue({ patch: "@@ -1,2 +1,2 @@\n-x1\n-x2\n+y1\n+y2", truncated: false })
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      String(url).includes("/api/tasks/task-1/chat")
        ? Promise.resolve(sseResponse(turnEdit))
        : Promise.reject(new Error(`unexpected fetch: ${String(url)}`)))
    const t = makeTask("awaiting_review")
    renderConsole(t, awaitingDetail(t))
    const chatHost = await screen.findByTestId("task-chat-tab")
    expect(chatHost.getAttribute("data-chat-form")).toBe("quick-edit")
    // 只说「做」面：GET 绑定 + POST 任务级对话，谈面（clones/source_chat）绝迹
    await waitFor(() => expect(mockGetChatBinding).toHaveBeenCalledWith("task-1"))

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "圆角再大一点" } })
    fireEvent.click(screen.getByTestId("chat-send"))
    const card = await screen.findByTestId("chat-tool-card")
    expect(card.textContent).toContain("a.tsx")

    fireEvent.click(within(card).getByTestId("chat-tool-diff"))
    await waitFor(() => expect(screen.getByTestId("console-tab-files").getAttribute("aria-selected")).toBe("true"))
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/web-app/a.tsx"]')
      if (!el) throw new Error("row not mounted")
      return el as HTMLElement
    })
    expect(row.querySelector('[data-testid="quick-edit-badge"]')?.textContent).toContain("💬 chat")
    const chip = screen.getByTestId("quick-edit-chip")
    expect(chip.textContent).toContain("×1")
    // reveal：跳链命中行展开 + 闪
    expect(document.querySelector('[data-diff-flash="true"]')).toBeTruthy()
    // chip 点击回对话页签
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByTestId("console-tab-chat").getAttribute("aria-selected")).toBe("true"))
  })

  it("劝退回复 → 「↩ 打回 · 派 task-fix（已带指令草稿）」→ openReject(草稿)（05 单 textarea 句柄）", async () => {
    const reply = "这个改动面比较大，建议打回 → 修复轮（task-fix）：先统一圆角令牌，再回归样式。"
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      String(url).includes("/api/tasks/task-1/chat")
        ? Promise.resolve(sseResponse([
            frame("text_delta", { type: "text_delta", messageId: "m9", content: reply }),
            frame("result", { type: "result", content: "" }),
          ].join("")))
        : Promise.reject(new Error(`unexpected fetch: ${String(url)}`)))
    const t = makeTask("awaiting_review")
    renderConsole(t, awaitingDetail(t))
    fireEvent.change(await screen.findByTestId("chat-input"), { target: { value: "把整个设计令牌重构一遍" } })
    fireEvent.click(screen.getByTestId("chat-send"))
    const btn = await screen.findByTestId("chat-reject-draft")
    expect(btn.textContent).toContain("↩ 打回 · 派 task-fix（已带指令草稿）")
    fireEvent.click(btn)
    await waitFor(() => expect(mockOpenReject).toHaveBeenCalledWith(reply))
  })

  it("task-fix 在跑 → shellMode=fixing：页签「💬 追加指令」（默认节点）+ 明示横幅 + ⚑ 历史行 + 发消息=暂停→注入(intervention)", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-1", source: "sqlite", _degraded: false, _message: null,
      events: [{
        nodeId: "dev", event: "intervention", timestamp: "2026-10-08T02:00:00.000Z",
        data: { nodeId: "dev", nodeName: "开发/修复", prompt: "先把行号对齐做了" },
      }],
    })
    mockPause.mockResolvedValue(makeTask("running"))
    mockResume.mockResolvedValue(makeTask("running"))
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null, workflow_ref: "built-in/task-fix" })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    const chatTab = await screen.findByTestId("console-tab-chat")
    expect(chatTab.textContent).toContain("追加指令")
    // spec 表：修复轮默认落节点（自动推进直播）
    expect(screen.getByTestId("console-tab-nodes").getAttribute("aria-selected")).toBe("true")
    fireEvent.click(chatTab)
    expect(await screen.findByTestId("task-chat-tab")).toBeTruthy()
    expect((await screen.findByTestId("fixing-banner")).textContent).toContain("task-fix 执行中")
    const line = await screen.findByTestId("fixing-intervention-line")
    expect(line.textContent).toContain("先把行号对齐做了")
    // fixing 不读 doer 会话（两本账）：绑定 GET 一次都没打
    expect(mockGetChatBinding).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId("fixing-input"), { target: { value: "回归别跑 e2e，只跑单测" } })
    fireEvent.click(screen.getByTestId("fixing-send"))
    await waitFor(() => expect(mockPause).toHaveBeenCalledWith("task-1"))
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1", "回归别跑 e2e，只跑单测"))
  })

  it("切页往返口吻不丢：走查页签切回对话仍是 quick-edit 形态（chatFormFor 单源判据）", async () => {
    const t = makeTask("awaiting_review")
    renderConsole(t, awaitingDetail(t))
    fireEvent.click(await screen.findByTestId("console-tab-review"))
    fireEvent.click(screen.getByTestId("console-tab-chat"))
    expect((await screen.findByTestId("task-chat-tab")).getAttribute("data-chat-form")).toBe("quick-edit")
  })
})
