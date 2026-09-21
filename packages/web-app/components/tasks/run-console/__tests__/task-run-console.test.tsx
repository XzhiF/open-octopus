// 执行态弹窗改版（2026-09-21）—— TaskRunConsole 回归：
//   • rail = 唯一状态位（票 11 钉点迁移：phase-timeline/phase-row-*/round chip/
//     legacy/⏳ 超预算 全在 rail 上复现）
//   • 五区去重：「任务概要/执行记录/Phase 时间线」标题不再出现，一个事实一次
//   • ready 门禁/触发、awaiting 判决条、done 战报、红行 error_summary 状态门控
//   • TaskModal 接线：三模式走新壳（terminal bar + 无 ModalHeader/悬浮 X）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDerivedView, TaskExecutionBadge, TaskPhaseView } from "@/lib/tasks-api"

const {
  mockGetTask, mockListArtifacts, mockFetchLLMCalls, mockGetBatchTree,
  mockPostAcceptance, mockAbort, mockReopen, mockCancelTrigger, mockPause, mockResume,
  pushSpy, mockFetchAgentEvents,
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
}))

vi.mock("@/lib/api-client", () => ({ fetchAgentEvents: mockFetchAgentEvents }))

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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// 重组件桩（只测控制台盘面编排，弹窗本体各有自己的测试）
vi.mock("../../authoring/artifact-viewer-dialog", () => ({ ArtifactViewerDialog: () => null }))
vi.mock("../../authoring/workflow-viewer-dialog", () => ({ WorkflowViewerDialog: () => null }))
vi.mock("../../authoring/phase-spec-dialog", () => ({
  PhaseSpecDialog: () => null,
  normalizeRel: (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, ""),
  specFileClass: () => ({ label: "md", tone: "bg-muted" }),
  batchDirOf: (p: string) => p.split("/").slice(0, -1).join("/"),
}))
vi.mock("../../acceptance/acceptance-surface", () => ({ AcceptanceSurface: () => <div data-acceptance-surface-stub /> }))
vi.mock("../../trigger-dialog", () => ({
  TriggerDialog: () => null,
  TriggerActions: () => null,
}))

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
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending"), pv(2, "票11阶段2", "pending"), pv(3, "票11阶段3", "pending")]) })
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
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending"), pv(2, "票11阶段2", "pending")]) })
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1, workflow_ref: "built-in/wf" })], derived: derivedOf(views) })
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1, workspace_id: "ws-e1" })], derived: derivedOf(views) })
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    await screen.findByTestId("console-acceptance-card")
    fireEvent.click(screen.getByTestId("console-open-acceptance"))
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views) })
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

  it("验货台 = 控制台 tab（2026-09-16 收编）：证据链接/条内钮切 tab 内嵌 surface，可切回；startOnAcceptance 直达", async () => {
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views) })
    // 有待验收轮 → tab 条亮出两档；surface 预挂但藏着（keep-mounted）
    const acceptTab = await screen.findByTestId("console-tab-accept")
    expect(acceptTab.textContent).toContain("P1·R1")
    expect(acceptanceSurfaceVisible()).toBe(false)
    // 单入口定稿：旧「验货台核对实物 →」链与卡外绿横幅已删；点整卡 = 切 tab
    expect(screen.queryByText(/验货台核对实物/)).toBeNull()
    expect(screen.queryByText(/去验货台验收（实物/)).toBeNull()
    fireEvent.click(screen.getByTestId("console-acceptance-card"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
    // 切回执行控制台（surface 仍在场，只是 hidden —— 复检会话不再因切换而失忆）
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(false))
    expect(screen.getByText(/R1 交付报告/)).toBeTruthy()
    // 导航条「🔍 验货台」也走切 tab（chip 直接文本同为 🔍 验货台，取条内钮的锚点）
    fireEvent.click(document.querySelector("[data-acceptance-open-bar]") as HTMLElement)
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
  })

  it("startOnAcceptance（看板「验收」按钮）：挂载即落验货台 tab", async () => {
    const t = makeTask("awaiting_review")
    mockGetTask.mockResolvedValue({ ...t, derived: derivedOf([pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")]) } as never)
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views) })
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views) })
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
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })], derived: derivedOf(views) })
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
      ]),
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

  it("运行中：点「暂停」打 pauseTask；点「恢复」打 resumeTask（不带 body，与工作流页一致）", async () => {
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
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith("task-1"))
  })

  it("ready+已定时：条内 ⏰ 已定时 token + 取消触发（打 cancelTaskTrigger），大触发钮让位", async () => {
    mockCancelTrigger.mockResolvedValue({})
    const future = new Date(Date.now() + 3600_000).toISOString()
    const t = makeTask("ready", { next_fire_at: future, trigger_mode: "once" } as Partial<Task>)
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending")]) })
    expect(await screen.findByText(/⏰ 已定时/)).toBeTruthy()
    expect(screen.queryByText(/⚡ 触发执行/)).toBeNull()
    fireEvent.click(screen.getByText(/✕ 取消触发/))
    await waitFor(() => expect(mockCancelTrigger).toHaveBeenCalledWith("task-1"))
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
