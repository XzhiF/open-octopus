// 执行态弹窗改版（2026-09-21）—— TaskRunConsole 回归：
//   • rail = 唯一状态位（票 11 钉点迁移：phase-timeline/phase-row-*/round chip/
//     legacy/⏳ 超预算 全在 rail 上复现）
//   • 五区去重：「任务概要/执行记录/Phase 时间线」标题不再出现，一个事实一次
//   • ready 门禁/触发、awaiting 判决条、done 战报、红行 error_summary 状态门控
//   • TaskModal 接线：三模式走新壳（terminal bar + 无 ModalHeader/悬浮 X）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useEffect } from "react"
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDerivedView, TaskExecutionBadge, TaskPhaseView } from "@/lib/tasks-api"

const {
  mockGetTask, mockListArtifacts, mockFetchLLMCalls, mockGetBatchTree,
  mockPostAcceptance, mockAbort, mockReopen, mockCancelTrigger, mockPause, mockResume,
  pushSpy, mockFetchAgentEvents, mockGetRoundDiff, mockGetRoundPatch, mockFetchExecutionDetail,
  mockOpenReject, mockGetChatBinding, mockGetDoerHistory,
  mockTakeover, mockDeliverTakeover, mockFixRound,
  // 票11：中止句柄（走查面二次确认单源）+ 产物 manifest 两端 + 会话口径账本。
  mockRequestAbort, mockGetArtifactManifest, mockReadManifestFile, mockFetchSessionLLMCalls,
  // 票07(原型⓬)：ready 静态节点预览的绑定流内容读取桩。
  mockBuiltInDetail,
  // 票11 收口①：sse-manager 订阅捕获（日志流优先订既有 executions/events 实时追加）。
  sseSubs,
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
  // 票08：三分支三端点桩（takeover/deliver/fix-round）。
  mockTakeover: vi.fn(),
  mockDeliverTakeover: vi.fn(),
  mockFixRound: vi.fn(),
  // 票11 桩
  mockRequestAbort: vi.fn(),
  mockGetArtifactManifest: vi.fn(),
  mockReadManifestFile: vi.fn(),
  mockFetchSessionLLMCalls: vi.fn(),
  // 票07 ready 静态节点预览：绑定流内容读取通路（built-in 域 + task-home 回落走
  // tasks-api.getHomeFile 桩）。
  mockBuiltInDetail: vi.fn(),
  sseSubs: [] as Array<{ url: string; type: string; fn: (e: MessageEvent) => void }>,
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
  // 票08 三分支三端点
  takeoverTask: mockTakeover, deliverTakeover: mockDeliverTakeover, postFixRound: mockFixRound,
  // 票11 ▣ 产物分组清单（manifest 拉取 + 预览现读）
  getArtifactManifest: mockGetArtifactManifest, readArtifactManifestFile: mockReadManifestFile,
}))
vi.mock("@/lib/observability-api", () => ({
  fetchLLMCalls: mockFetchLLMCalls,
  // 票11 ▤ 消耗页签的 task-doer 对话账（会话口径单源）。
  fetchSessionLLMCalls: mockFetchSessionLLMCalls,
}))
// 票07 ready 静态节点预览：绑定流内容读取（复用 built-in 详情通路，测试不真发请求）。
vi.mock("@/lib/workflow-presets-api", () => ({
  getBuiltInWorkflowDetail: mockBuiltInDetail,
  listBuiltInWorkflows: vi.fn(),
  listWorkflowPresets: vi.fn(),
}))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: (url: string, type: string, fn: (e: MessageEvent) => void) => {
    sseSubs.push({ url, type, fn })
    return () => { const i = sseSubs.findIndex((s) => s.fn === fn); if (i >= 0) sseSubs.splice(i, 1) }
  },
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
    AcceptanceSurface: ({ onActionApi, railless }: { onActionApi?: (api: { requestAccept: () => void; openReject: (d?: string) => void; requestAbort: () => void; blocked: boolean } | null) => void; railless?: boolean }) => {
      // 与真实面同纪律：句柄经 onActionApi 注册（票07 对话页签「劝退→打回预填」走这条线；
      // 票11 壳右栏「■ 中止」= requestAbort 二次确认口）。
      useEffect(() => {
        onActionApi?.({ requestAccept: () => {}, openReject: (d?: string) => mockOpenReject(d), requestAbort: () => mockRequestAbort(), blocked: false })
        return () => onActionApi?.(null)
      }, [onActionApi])
      return <div data-acceptance-surface-stub data-railless={railless ? "true" : "false"} />
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
  sseSubs.length = 0
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
  // 票08 默认面：三端点桩（个案覆盖）。
  mockTakeover.mockReset()
  mockDeliverTakeover.mockReset()
  mockFixRound.mockReset()
  // 票11 默认面：中止句柄零调用；manifest 空组；doer 会话零调用（不显 doer 行）。
  mockRequestAbort.mockReset()
  mockGetArtifactManifest.mockReset()
  mockGetArtifactManifest.mockResolvedValue({ groups: [] })
  mockReadManifestFile.mockReset()
  mockReadManifestFile.mockResolvedValue({ path: "home:.scratch/x/spec.md", content: "# spec" })
  mockFetchSessionLLMCalls.mockReset()
  mockFetchSessionLLMCalls.mockResolvedValue({ data: [], aggregates: { totalCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null }, modelBreakdown: {} } })
  // 票07 默认面：绑定流内容读不到（reject）—— 静态预览落「读取失败」降级话术，
  // 不编造行；看清单的用例自行 mockResolvedValue（YAML 原文走 content）。
  mockBuiltInDetail.mockReset()
  mockBuiltInDetail.mockRejectedValue(new Error("not resolvable in console tests"))
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

  it("v3 legacy → 单节点 phase-row-legacy +「v3 单阶段」，控制台页签 = 纯事件流（战报面随用户终裁撤场）", async () => {
    const t = makeTask("running", { task_spec: { ...SPEC, format: undefined } as TaskSpec })
    mockGetTask.mockResolvedValue({ ...t, executions: [badge("exec-9", "running", { phase_index: null, round_index: null })], derived: { taskStatus: "running", isV4: false, phaseViews: [] } })
    render(<TaskRunConsole task={t} onMutated={() => {}} onClose={() => {}} />)
    expect(await screen.findByTestId("phase-row-legacy")).toBeTruthy()
    expect(screen.getByText(/v3 单阶段/)).toBeTruthy()
    // 用户终裁（票11）：Phase/Report 叠面整体撤场 —— v3 也只挂 WorkspaceEventStream。
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    expect(screen.queryByText("任务战报")).toBeNull()
    expect(document.querySelector("[data-run-deeplink=\"execution\"]")).toBeNull()
  })

  it("derived 缺失（旧 server）不崩，账本兜底", async () => {
    const t = makeTask("running")
    renderConsole(t, { ...t, executions: [badge("exec-1", "running")], derived: undefined })
    expect(await screen.findByTestId("phase-timeline")).toBeTruthy()
    expect(screen.getByText(/账目/)).toBeTruthy()
  })
})

describe("TaskRunConsole — 五态皮肤与动作", () => {
  it("ready：发射门禁/GOAL/大触发钮/盘上文件全部绝迹（用户终裁）；触发只剩 rail ⚡ 单源，点击不旁路落端点", async () => {
    const t = makeTask("ready")
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending"), pv(2, "票11阶段2", "pending")], true, "ready") })
    // 票07（原型 ⓬）：ready 装配 = 三签，默认落「◆ 节点」静态预览 —— 控制台页签
    // 不再进 ready 装配（旧「默认事件流」断言随装配表迁移；门制动线在 rail/顶栏，未回退）。
    const nodesTab = await screen.findByTestId("console-tab-nodes")
    expect(nodesTab.getAttribute("aria-selected")).toBe("true")
    expect(screen.queryByTestId("console-tab-console")).toBeNull()
    // 绑定流内容读不到（默认桩 reject）→ 静态预览落降级话术，不编造节点行。
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement
    expect(await within(host).findByTestId("static-nodes-error")).toBeTruthy()
    expect(host.querySelector("[data-static-node-row]")).toBeNull()
    for (const gone of [/发射门禁/, /每个 Phase 已绑定工作流/, /spec\.md 落盘/, /⚡ 触发执行/, /盘上文件/, /GOAL/]) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    // 流程必需动作等价性：ready 的触发口 = rail「⚡ 触发」（同一 TriggerDialog 单实例；
    // 对话框本体在壳测试桩为 null —— 这里钉「存在 + 点击不打端点」）。
    const trigger = document.querySelector("[data-rail-acts] [data-task-trigger]") as HTMLElement
    expect(trigger).toBeTruthy()
    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector("[data-rail-acts] [data-task-trigger]")).toBeTruthy())
  })

  it("awaiting_review：交付报告面随用户终裁撤场 —— 控制台页签纯事件流，验收唯一入口 = 「✓ 走查」页签，不打 postAcceptance", async () => {
    const t = makeTask("awaiting_review")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "awaiting_review"), pv(3, "票11阶段3", "pending")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1, workflow_ref: "built-in/wf" })], derived: derivedOf(views, true, "awaiting_review") })
    // 票 02/07：待验收默认落「💬 对话」。用户终裁（票11）：控制台页签只剩事件流，
    // 原「R1 交付报告」卡/「去验货台」CTA 撤场 —— 验收动线 = 走查页签本身。
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-console"))
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
    expect(screen.queryByTestId("console-open-acceptance")).toBeNull()
    expect(screen.queryByTestId("console-acceptance-card")).toBeNull()
    // 决策入口仍绝迹于控制台（ADR-0022），验收 = 走查页签（keep-mounted，hidden 挡着）。
    expect(screen.queryByTestId("acceptance-approve")).toBeNull()
    expect(acceptanceSurfaceVisible()).toBe(false)
    fireEvent.click(screen.getByTestId("console-tab-review"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(true))
    expect(mockPostAcceptance).not.toHaveBeenCalled()
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
    // 切回控制台（surface 仍在场，只是 hidden —— 复检会话不再因切换而失忆）；
    // 用户终裁（票11）：控制台页签 = 纯事件流，交付报告面绝迹。
    fireEvent.click(screen.getByTestId("console-tab-console"))
    await waitFor(() => expect(acceptanceSurfaceVisible()).toBe(false))
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
  })

  it("startOnAcceptance（看板「验收」按钮）：挂载即落走查页签", async () => {
    const t = makeTask("awaiting_review")
    mockGetTask.mockResolvedValue({ ...t, derived: derivedOf([pv(1, "票11阶段1", "awaiting_review"), pv(2, "票11阶段2", "pending")], true, "awaiting_review") } as never)
    render(<TaskRunConsole task={t} onMutated={() => {}} onClose={() => {}} startOnAcceptance />)
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
  })

  it("用户终裁（票11）：大事报/轮次账本/盘上文件随叠面绝迹 —— 待验收控制台页签只剩事件流，异常史由流内 ✗ 行自证", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-2", source: "sqlite", _degraded: false, _message: null,
      events: [
        { nodeId: "e2e-verify", event: "start", timestamp: "2026-09-21T09:00:02Z" },
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
    // 旧叠面词汇绝迹（大事报框 / ROUNDS 账本 / 盘上文件分桶 / 交付报告卡）。
    expect(screen.queryByText("大事报 / SIGNAL")).toBeNull()
    expect(screen.queryByText("轮次 / ROUNDS")).toBeNull()
    expect(screen.queryByTestId("file-bucket-issues")).toBeNull()
    expect(screen.queryByText(/R1 交付报告/)).toBeNull()
    // 同一事实的新落点：流内 ✗/⚙ 分类行（挂过+自愈史仍可读，来自 agent_events 单源）。
    const stream = await screen.findByTestId("workspace-event-stream")
    await waitFor(() => expect(stream.textContent).toContain("Bash"))
    // 取的是 awaiting 轮（exec-2）的执行，不是别的轮（replayTarget 纪律不破）。
    await waitFor(() => expect(mockFetchAgentEvents).toHaveBeenCalledWith("ws-1", "exec-2"))
  })

  it("done：控制台页签 = 纯事件流（战报瓦片/轮次账本/产物卡随用户终裁绝迹），rail phase 行仍可选", async () => {
    mockListArtifacts.mockResolvedValue([
      { path: "artifacts/report.md", by: "agent-1", title: "综合报告", external: false, updated_at: "2026-09-21T10:00:00Z" },
    ])
    const t = makeTask("done")
    const views = [pv(1, "票11阶段1", "accepted"), pv(2, "票11阶段2", "accepted")]
    renderConsole(t, { ...t, executions: [badge("exec-1", "completed"), badge("exec-2", "completed", { phase_index: 2, round_index: 1 })], derived: derivedOf(views, true, "done") })
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    for (const gone of ["任务战报", "实际用时", "AI 总成本", "综合报告", "轮次账本（全部）", "模型分布"]) {
      expect(screen.queryByText(gone)).toBeNull()
    }
    expect(screen.queryByTestId("rail-report-chip")).toBeNull()
    // rail 仍是唯一状态位：phase 行可点，终态流照常（不崩、不空引用）。
    fireEvent.click(screen.getByTestId("phase-row-2"))
    expect(screen.getByTestId("workspace-event-stream")).toBeTruthy()
  })

  it("failed：pill ■ 失败如实；error_summary 红行随叠面撤场（终态弹窗不再复刻执行详情）", async () => {
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
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    expect(document.querySelector('[data-task-modal-status="failed"]')).toBeTruthy()
    expect(screen.queryByText("对账回收：引擎进程已丢失")).toBeNull()
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
    // 票11 收口②：digest 叠块撤场，intervention-log/intervention-line 钉点**转钉到
    // 流内 ⚑ 高亮行**（同一事实源 —— 断言语义不变：留痕行含 节点名 + 原文 + pink）。
    const log = await screen.findByTestId("intervention-log")
    const line = within(log).getAllByTestId("intervention-line")[0]
    expect(line.textContent).toContain("⚑")
    expect(line.textContent).toContain("人工干预 → 节点「开发/修复」")
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

  it("US16（票10 review-7）：执行推进到零干预的新节点 → ⚑ chip 消失（不再黏旧节点累计）", async () => {
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-1", source: "sqlite", _degraded: false, _message: null,
      events: [
        { ...ivEvent, timestamp: "2026-10-08T01:50:00.000Z" },
        { ...ivEvent, timestamp: "2026-10-08T02:00:00.000Z" },
        // 恢复后引擎推进到下一节点 —— 事件流尾部换了节点（当前节点 = verify）。
        { nodeId: "verify", event: "start", timestamp: "2026-10-08T02:05:00.000Z" },
      ],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "paused", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "paused")], true, "paused"),
    })
    // 日志区照旧看得见两条历史 ⚑（留痕不删）……
    const log = await screen.findByTestId("intervention-log")
    expect(within(log).getAllByTestId("intervention-line")).toHaveLength(2)
    // ……但 LIVE 卡的当前节点计数归 0 → chip 整枚不渲染。
    expect(screen.queryByTestId("rail-intervention-chip")).toBeNull()
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
    await screen.findByTestId("workspace-event-stream") // 终裁后控制台页签 = 纯事件流
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

  it("done/failed → 同壳（纯事件流 + 状态 pill），战报面与「任务完成/任务失败」独立横幅都不再渲染", async () => {
    const t = makeTask("done")
    mockGetTask.mockResolvedValue({ ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "accepted")], true, "done") })
    renderModal(t)
    expect(await screen.findByTestId("workspace-event-stream")).toBeTruthy()
    expect(screen.queryByText("任务战报")).toBeNull()
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

  it("awaiting_review：右栏底部装配 通过/打回/工作空间↗（走查 tab 保持挂载供接线）", async () => {
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
    expect(acts!.querySelector("[data-rail-ws]")).toBeTruthy()
    expect(acts!.querySelector("[data-task-pause]")).toBeNull()
    // 验货台 surface keep-mounted（hidden 壳内，挂载闸随 awaiting 轮亮起）；走查页签在场
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
    expect(screen.getByTestId("console-tab-review")).toBeTruthy()
  })
})

describe("票 02 — 页签装配 + 键盘", () => {
  it("running v4：变更·节点·消耗·产物·控制台，默认落「变更」且出真实内容（票 03 已落地）", async () => {
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
    // 票11 终表：消耗/产物进 running 装配
    expect(screen.getByTestId("console-tab-usage")).toBeTruthy()
    expect(screen.getByTestId("console-tab-artifacts")).toBeTruthy()
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

  it("awaiting_review：对话·变更·走查·消耗·产物·日志，默认落「对话」（票 07 已挂载 —— 占位话术绝迹）", async () => {
    const t = makeTask("awaiting_review")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review")], true, "awaiting_review"),
    })
    const chatTab = await screen.findByTestId("console-tab-chat")
    expect(chatTab.getAttribute("aria-selected")).toBe("true")
    for (const key of ["files", "review", "usage", "artifacts", "console"]) expect(screen.getByTestId(`console-tab-${key}`)).toBeTruthy()
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

  it("→ 顺序切页并回卷；← 反向；输入框聚焦时忽略（票11 装配终表含消耗/产物）", async () => {
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
    expect(selected()).toBe("usage")
    fireEvent.keyDown(window.document, { key: "ArrowRight" })
    expect(selected()).toBe("artifacts")
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

  it("ready 未触发（executions 空）：不再打「无节点」空态 —— 走票07 静态预览降级（读不到绑定流也如实，不编造清单，不打执行详情）", async () => {
    const t = makeTask("ready")
    renderConsole(t, { ...t, executions: [], derived: derivedOf([pv(1, "票11阶段1", "pending")], true, "ready") })
    await screen.findByTestId("phase-timeline")
    fireEvent.click(screen.getByTestId("console-tab-nodes"))
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement | null
    expect(await within(host!).findByTestId("static-nodes-error")).toBeTruthy()
    expect(host!.querySelector("[data-static-node-row]")).toBeNull()
    expect(mockFetchExecutionDetail).not.toHaveBeenCalled()
  })
})

// ═════════════════ 票 07 · 待执行三签骨架（对话·规格·节点 + 绑定流 ○ 静态预览）═════════════════
// 真相源 = 原型 taskboard-v2.html renderModal 的 ready 分支（rd=t.col==='ready'）：
//   tabs rd ? [chat 对话, spec 规格, nodes 节点]，openTask 默认 tab='nodes'；
//   readyNodesHtml：⚙ 流名 + 「P<ph> 绑定流 … 触发后开跑 — 点行看占位」+ 0/N 完成 · 等待触发；
//   展开行（nodeEvents ready 分支）逐字 =「— 未执行 · 等待触发 —」。
// 对话/规格两签本票只钉占位壳（08/09 各替换内容，不动装配 —— 装配先行防三票互相等）。
describe("票 07 — ready 三签骨架：默认节点静态预览 + 占位壳可点可切", () => {
  const STATIC7_YAML = `
name: matt-spec-dev
nodes:
  - id: spec-resolve
    type: bash
  - id: fail-fast
    type: bash
  - id: spec-review
    type: agent
  - id: ticket-dag
    type: dynamic_sub_workflow
  - id: code-review
    type: agent
  - id: e2e-verify
    type: agent
  - id: ship-pr
    type: agent
`

  const readyV4 = () => {
    const t = makeTask("ready")
    renderConsole(t, {
      ...t,
      executions: [],
      derived: derivedOf([pv(1, "票11阶段1", "pending", { workflowRef: "built-in/matt-spec-dev" })], true, "ready"),
    })
    return t
  }

  it("三签装配上屏：对话·规格·节点在册，变更/消耗/产物/控制台绝迹；默认落节点", async () => {
    mockBuiltInDetail.mockResolvedValue({ ref: "built-in/matt-spec-dev", content: STATIC7_YAML, parsed: { name: "matt-spec-dev" } })
    readyV4()
    const nodesTab = await screen.findByTestId("console-tab-nodes")
    expect(screen.getByTestId("console-tab-chat")).toBeTruthy()
    expect(screen.getByTestId("console-tab-spec")).toBeTruthy()
    expect(nodesTab.getAttribute("aria-selected")).toBe("true")
    for (const gone of ["files", "usage", "artifacts", "console", "review"]) {
      expect(screen.queryByTestId(`console-tab-${gone}`)).toBeNull()
    }
    // 页签标签词表（原型逐字）
    expect(screen.getByTestId("console-tab-chat").textContent).toContain("💬 对话")
    expect(screen.getByTestId("console-tab-spec").textContent).toContain("▤ 规格")
  })

  it("节点静态预览：绑定流 YAML 声明序全 ○，用时/成本 `—`，汇总 0/7 等待触发；展开行=「未执行 · 等待触发」（原型 readyNodesHtml + nodeEvents）", async () => {
    mockBuiltInDetail.mockResolvedValue({ ref: "built-in/matt-spec-dev", content: STATIC7_YAML, parsed: { name: "matt-spec-dev" } })
    readyV4()
    // detail 异步就位前 derived 缺席（v4 闸不亮，装配只剩控制台）—— 先等三签上屏。
    await screen.findByTestId("console-tab-nodes")
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement
    const tab = await within(host).findByTestId("static-nodes-tab")
    // 声明序 = 清单序（独立真相：core-pack matt-spec-dev.yaml 实取）
    expect([...tab.querySelectorAll("[data-static-node-row]")].map((el) => el.getAttribute("data-static-node-row")))
      .toEqual(["spec-resolve", "fail-fast", "spec-review", "ticket-dag", "code-review", "e2e-verify", "ship-pr"])
    for (const id of ["spec-resolve", "ship-pr"]) {
      const row = within(tab).getByTestId(`static-node-row-${id}`)
      expect(row.textContent).toContain("○")
      expect(row.textContent).toContain("—")
    }
    // 页签头：绑定流名 + 等待触发口径（原型 f-toolbar）
    expect(within(tab).getByTestId("static-nodes-wf-pill").textContent).toContain("matt-spec-dev")
    expect(within(tab).getByTestId("static-nodes-summary").textContent).toContain("0/7")
    // 展开一行 → 占位话术（触发后才有事件）
    fireEvent.click(within(tab).getByTestId("static-node-row-spec-resolve"))
    expect((await within(tab).findByTestId("static-node-events-spec-resolve")).textContent).toContain("未执行 · 等待触发")
  })

  it("对话/规格两签可点可切：规格占位壳 testid 原位（票09 接入位）；对话壳已由票08 换为只读回放（fixture 无草稿期会话 → 空态文案，面内零输入框）", async () => {
    mockBuiltInDetail.mockResolvedValue({ ref: "built-in/matt-spec-dev", content: STATIC7_YAML, parsed: { name: "matt-spec-dev" } })
    readyV4()
    await screen.findByTestId("console-tab-nodes")
    fireEvent.click(screen.getByTestId("console-tab-spec"))
    expect(await screen.findByTestId("ready-spec-placeholder")).toBeTruthy()
    fireEvent.click(screen.getByTestId("console-tab-chat"))
    // 票07 的 ready-chat-placeholder 已退役 —— 换票08 回放面（makeTask 默认
    // source_chat_session_id=null → 「草稿期会话不存在」空态，不白屏）。
    expect(screen.queryByTestId("ready-chat-placeholder")).toBeNull()
    const replay = await screen.findByTestId("ready-chat-replay")
    expect(within(replay).getByText("草稿期会话不存在")).toBeTruthy()
    expect(within(replay).queryAllByRole("textbox")).toHaveLength(0)
    // 切回节点：静态预览仍在场（宿主切换不残留别的页签内容）
    fireEvent.click(screen.getByTestId("console-tab-nodes"))
    expect(await screen.findByTestId("static-nodes-tab")).toBeTruthy()
  })

  it("phase 未绑定流（workflowRef 空）：静态预览给「未绑定」如实空态，不发内容读取", async () => {
    const t = makeTask("ready")
    renderConsole(t, {
      ...t,
      executions: [],
      derived: derivedOf([pv(1, "票11阶段1", "pending", { workflowRef: "" })], true, "ready"),
    })
    await screen.findByTestId("console-tab-nodes")
    const host = document.querySelector('[data-tab-host="nodes"]') as HTMLElement
    expect(await within(host).findByTestId("static-nodes-unbound")).toBeTruthy()
    expect(mockBuiltInDetail).not.toHaveBeenCalled()
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

// ═════════════════ 票 08 · 人工接管（三分支框 + takeover 壳 + 交付）═════════════════
// 期望文案逐字 = 原型 taskboard-v2.html（openBranch/pickBr/rail-acts tk 分支）；
// 形态判据 = 派生 phase 'takeover'（服务端单源）；端点面 = tasks-api 三桩。

describe("票 08 — 「✋ 有问题」三分支框（running flow 现场）", () => {
  const runningView = () => {
    const t = makeTask("running")
    return { t, detail: { ...t, executions: [badge("exec-1", "running", { completed_at: null })], derived: derivedOf([pv(1, "票11阶段1", "running")]) } }
  }
  const takeoverDetailOf = (t: Task) => ({
    ...t,
    executions: [badge("exec-1", "cancelled", { takeover_at: "2026-09-21T09:30:00Z", takeover_delivered_at: null })],
    derived: derivedOf([pv(1, "票11阶段1", "takeover", {
      rounds: [{ roundIndex: 1, state: "cancelled" as const, decision: null, exec: { id: "exec-1", status: "cancelled", workflow_ref: "built-in/matt-spec-dev", phase_index: 1, round_index: 1, created_at: "2026-09-21T08:59:00Z" } }],
    })], true, "running"),
  })

  it("running 右栏有 ✋ 钮；关框时盘面 textarea 仍为 0（06 零输入铁律不撞）", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    const ask = await waitFor(() => {
      const el = document.querySelector("[data-rail-acts] [data-task-ask-takeover]")
      if (!el) throw new Error("ask button missing")
      return el
    })
    expect(ask.textContent).toContain("✋ 有问题？接管本 Round…")
    expect(document.querySelectorAll("textarea")).toHaveLength(0)
  })

  it("开框：三分支选项齐（原型逐字）；go 文案随选；取消关窗零调用", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    fireEvent.click(await screen.findByText(/✋ 有问题？接管本 Round/))
    const dlg = await screen.findByTestId("takeover-branch-dialog")
    expect(within(dlg).getByTestId("branch-option-inject").textContent).toContain("① ⚑ 注入干预 · 原工作流继续")
    expect(within(dlg).getByTestId("branch-option-takeover").textContent).toContain("② ✋ 停流 · 我接管（对话开发）")
    expect(within(dlg).getByTestId("branch-option-fix").textContent).toContain("③ ⚙ 改派通用修复流 task-fix")
    expect(within(dlg).getByTestId("branch-go").textContent).toContain("① 注入干预并继续")
    fireEvent.click(within(dlg).getByTestId("branch-option-takeover"))
    expect(within(dlg).getByTestId("branch-go").textContent).toContain("② 停止工作流 · 进入接管")
    fireEvent.click(within(dlg).getByTestId("branch-cancel"))
    await waitFor(() => expect(document.querySelector('[data-testid="takeover-branch-dialog"]')).toBeNull())
    expect(mockTakeover).not.toHaveBeenCalled()
    expect(mockFixRound).not.toHaveBeenCalled()
  })

  it("③ 指令必填：空指令点派发 → 就地拦下（原型 toast 文案）不打端点；补字后派发走 postFixRound", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    fireEvent.click(await screen.findByText(/✋ 有问题？接管本 Round/))
    const dlg = await screen.findByTestId("takeover-branch-dialog")
    fireEvent.click(within(dlg).getByTestId("branch-option-fix"))
    fireEvent.click(within(dlg).getByTestId("branch-go"))
    expect((await within(dlg).findByTestId("branch-blocked-hint")).textContent)
      .toBe("指令必填 — task-fix 通用流按你的输入开发")
    expect(mockFixRound).not.toHaveBeenCalled()
    // 三分支框 ③ → 转派发改令框（prefill 随带）；改令框自己再钉一次必填。
    fireEvent.change(within(dlg).getByTestId("branch-note"), { target: { value: "只补齐行号对齐" } })
    fireEvent.click(within(dlg).getByTestId("branch-go"))
    const fix = await screen.findByTestId("fix-dispatch-dialog")
    expect((within(fix).getByTestId("fix-instruction") as HTMLTextAreaElement).value).toBe("只补齐行号对齐")
    fireEvent.change(within(fix).getByTestId("fix-instruction"), { target: { value: "" } })
    fireEvent.click(within(fix).getByTestId("fix-dispatch-go"))
    expect((await within(fix).findByTestId("fix-blocked-hint")).textContent).toContain("指令必填")
    fireEvent.change(within(fix).getByTestId("fix-instruction"), { target: { value: "只补齐行号对齐和 hover 描边，产物报告照旧" } })
    mockFixRound.mockResolvedValue({ task: {}, dispatch: { execution_id: "x", workspace_id: "ws-1", phase_index: 1, round_index: 2 } })
    fireEvent.click(within(fix).getByTestId("fix-dispatch-go"))
    await waitFor(() => expect(mockFixRound).toHaveBeenCalledWith("task-1", "只补齐行号对齐和 hover 描边，产物报告照旧"))
  })

  it("① = pauseTask 成功才开 06 注入框；pause 失败不开框（无 paused 轮可注入）", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    mockPause.mockResolvedValue(makeTask("running"))
    fireEvent.click(await screen.findByText(/✋ 有问题？接管本 Round/))
    const dlg = await screen.findByTestId("takeover-branch-dialog")
    fireEvent.click(within(dlg).getByTestId("branch-go")) // 默认 ①
    await waitFor(() => expect(mockPause).toHaveBeenCalledWith("task-1"))
    expect(await screen.findByTestId("resume-intervene-dialog")).toBeTruthy()
    expect(document.querySelector('[data-testid="takeover-branch-dialog"]')).toBeNull()
  })

  it("① pause 被服务端拒（如停在审批）→ 不开注入框（透传真错误）", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    mockPause.mockRejectedValue(new Error("本轮停在审批/交互节点，请先在处理框中完成它"))
    fireEvent.click(await screen.findByText(/✋ 有问题？接管本 Round/))
    const dlg = await screen.findByTestId("takeover-branch-dialog")
    fireEvent.click(within(dlg).getByTestId("branch-go"))
    await waitFor(() => expect(mockPause).toHaveBeenCalled())
    await waitFor(() => expect(document.querySelector('[data-testid="takeover-branch-dialog"]')).toBeNull())
    expect(document.querySelector('[data-testid="resume-intervene-dialog"]')).toBeNull()
  })

  it("② 接管成功：takeoverTask 一发 → 盘面翻 takeover（粉 pill/对话接管页签/交付+改派钮/一步一交形态）", async () => {
    const { t, detail } = runningView()
    renderConsole(t, detail)
    const tkDetail = takeoverDetailOf(t)
    mockTakeover.mockImplementation(async () => {
      mockGetTask.mockResolvedValue(tkDetail)
      return { task: tkDetail, takeover: { execution_id: "exec-1", phase_index: 1, round_index: 1, taken_over_at: "x" }, session: { session_id: "s-doer", workspace_id: "ws-1", created: false } }
    })
    fireEvent.click(await screen.findByText(/✋ 有问题？接管本 Round/))
    const dlg = await screen.findByTestId("takeover-branch-dialog")
    fireEvent.click(within(dlg).getByTestId("branch-option-takeover"))
    fireEvent.change(within(dlg).getByTestId("branch-note"), { target: { value: "先把 hover 描边改了，别动统计条" } })
    fireEvent.click(within(dlg).getByTestId("branch-go"))
    await waitFor(() => expect(mockTakeover).toHaveBeenCalledWith("task-1"))

    // pill 翻粉 + 文案（原型 sp-tk）；data-task-modal-status 如实 takeover。
    expect(await screen.findByText("✋ 已接管 · chat 驱动")).toBeTruthy()
    expect(document.querySelector('[data-task-modal-status="takeover"]')).toBeTruthy()
    // 对话页签 = 接管口吻（07 组件全通，判据即此行）；默认页 chat。
    expect((await screen.findByTestId("console-tab-chat")).textContent).toContain("对话接管")
    const chat = await screen.findByTestId("task-chat-tab")
    expect(chat.getAttribute("data-chat-form")).toBe("takeover")
    // ② 的指令 = 开场草稿预填（一步一交：预填不代发）。
    await waitFor(() => expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).value).toBe("先把 hover 描边改了，别动统计条"))
    // 右栏 = 确认交付/改派/■；暂停与 ✋ 退场（流已停）。
    const acts = document.querySelector("[data-rail-acts]")!
    expect(acts.querySelector("[data-rail-deliver]")).toBeTruthy()
    expect(acts.querySelector("[data-rail-reassign]")).toBeTruthy()
    expect(acts.querySelector("[data-task-pause]")).toBeNull()
    expect(acts.querySelector("[data-task-ask-takeover]")).toBeNull()
    expect(acts.textContent).toContain("✓ 确认本 Round 交付 · 转待验收")
    // LIVE 卡翻接管语。
    expect((await screen.findByTestId("rail-live-card")).textContent).toContain("TAKEOVER")
  })

  it("确认交付 → deliverTakeover 端点；改派钮 → 指令框（空指令仍被拦）", async () => {
    const t = makeTask("running")
    renderConsole(t, takeoverDetailOf(t))
    mockDeliverTakeover.mockResolvedValue({ task: takeoverDetailOf(t), delivered: {} })
    fireEvent.click(await screen.findByText(/✓ 确认本 Round 交付/))
    await waitFor(() => expect(mockDeliverTakeover).toHaveBeenCalledWith("task-1"))

    fireEvent.click(document.querySelector("[data-rail-reassign]")!)
    const fix = await screen.findByTestId("fix-dispatch-dialog")
    fireEvent.click(within(fix).getByTestId("fix-dispatch-go"))
    expect((await within(fix).findByTestId("fix-blocked-hint")).textContent).toContain("指令必填")
    expect(mockFixRound).not.toHaveBeenCalled()
  })

  it("接管件已交付（badge 双标记 + awaiting）→ 对话 hint 换「接管件已交付」句", async () => {
    const t = makeTask("awaiting_review")
    const detail = {
      ...t,
      executions: [badge("exec-1", "cancelled", { phase_index: 1, round_index: 1, takeover_at: "2026-09-21T09:30:00Z", takeover_delivered_at: "2026-09-21T11:00:00Z" })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review", { awaitingRound: 1 })], true, "awaiting_review"),
    }
    mockGetRoundDiff.mockResolvedValue({ available: false, reason: "no_commits", aggregate: { commits: 0, additions: 0, dels: 0, files: 0 }, interventions: null, repos: [] })
    renderConsole(t, detail)
    await screen.findByTestId("task-chat-tab")
    expect(await screen.findByText("接管件已交付 — 验收前还能继续说改")).toBeTruthy()
  })
})

// ═════════════════ 票 11 · ⑩真机走查回补（消耗/产物页签 · 日志归位 · 中止归栏）═════════════
// 期望逐条取自票面 AC + 原型 renderModal/railWait（v4 定稿 = 真相源）：
//   · 待验收：走查页签渲染路径 railless（自带「摘要+动作」内列撤场）；
//     右栏 通过→打回→■中止，中止复用走查面二次确认句柄（requestAbort），
//     不再由壳直落 abortTask（确认流单源）。
//   · 日志：控制台/日志页签不再有「任务 AI 消耗」卡；agent_events 渲事件流，
//     ⚑ 干预行 = pink 高亮。
//   · 消耗：▤ 页签挂卡三段 + 按会话/节点明细；task-doer 单独行按 doer_session_id
//     归属（无对话历史不显）；徽标 = 成本。
//   · 产物：▣ 页签分组清单 + 徽标件数（manifest 端点，壳层单拉）。
describe("票 11 — 待验收：走查去内列 + 中止归栏", () => {
  const awaitingRunning = () => {
    // 生产形状：待验收期**持久态仍 running**（K3 派生不落库）—— canAbort 由此为真。
    const t = makeTask("running")
    return {
      t,
      detail: {
        ...t,
        executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
        derived: derivedOf([pv(1, "票11阶段1", "awaiting_review", { awaitingRound: 1 })], true, "awaiting_review"),
      },
    }
  }

  it("右栏四钮定版（⑪逐字）：✓ 验收通过 → ↩ 反馈打回 · task-fix 修复轮（大改） → 🗂 工作空间 · P1 执行视图 ↗ → ■ 中止任务；走查 host 净黑同底", async () => {
    const { t, detail } = awaitingRunning()
    renderConsole(t, detail)
    await screen.findByTestId("phase-timeline")
    const acts = document.querySelector("[data-rail-acts]")!
    // DOM 序 = 装配序（accept → reject → ws-deeplink → abort；终裁：不收 duplicate）
    const seq = Array.from(acts.querySelectorAll("button")).map((b) =>
      b.hasAttribute("data-rail-accept") ? "accept"
        : b.hasAttribute("data-rail-reject") ? "reject"
          : b.hasAttribute("data-rail-ws") ? "ws"
            : b.hasAttribute("data-task-abort") ? "abort" : "other",
    )
    expect(seq.slice(0, 4)).toEqual(["accept", "reject", "ws", "abort"])
    expect(acts.querySelector("[data-task-duplicate]")).toBeNull() // ⑪终裁：待验收决断面只有四钮
    expect(acts.textContent).toContain("✓ 验收通过")
    expect(acts.textContent).toContain("↩ 反馈打回 · task-fix 修复轮（大改）")
    expect(acts.textContent).toContain("🗂 工作空间 · P1 执行视图 ↗")
    expect(acts.textContent).toContain("■ 中止任务")
    // 走查页签 host 与壳同底（bg-pop-bg），「bg-pop-paper 亮卡衬底」绝迹
    //（wrapper 在 detail→awaitingPv 生效的下一 commit 挂载，waitFor 与之同拍）。
    const reviewHost = await waitFor(() => {
      const el = document.querySelector('[data-tab-host="review"]') as HTMLElement | null
      if (!el) throw new Error("review host not mounted yet")
      return el
    })
    expect(reviewHost.className).toContain("bg-pop-bg")
    expect(reviewHost.className).not.toContain("bg-pop-paper")
    // 走查面 keep-mounted 且壳内渲染路径剔除内列（AC1 的壳侧半；DOM 级断言在
    // acceptance-surface.test 真组件侧钉）。
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
    expect(document.querySelector("[data-acceptance-surface-stub]")!.getAttribute("data-railless")).toBe("true")
  })

  it("🗂 工作空间钮 = deepLinkTarget 同源 URL，window.open 新标签（noopener），不顶走弹窗", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    const { t, detail } = awaitingRunning()
    renderConsole(t, detail)
    const wsBtn = await waitFor(() => {
      const el = document.querySelector("[data-rail-acts] [data-rail-ws]") as HTMLElement | null
      if (!el) throw new Error("ws button missing")
      return el
    })
    expect((wsBtn as HTMLButtonElement).disabled).toBe(false) // awaitingRun 在场（exec-1/ws-1）→ 可点
    fireEvent.click(wsBtn)
    expect(openSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-1", "_blank", "noopener")
    openSpy.mockRestore()
  })

  it("无绑定执行可读（awaiting 轮缺 run）→ 工作空间钮 disabled 不撒谎", async () => {
    const t = makeTask("awaiting_review")
    // executions 空 → awaitingRun=null → deepLinkTarget 无从解析 → 按钮禁而不藏（装配稳定）。
    renderConsole(t, {
      ...t,
      executions: [],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review", { awaitingRound: 1, rounds: [] })], true, "awaiting_review"),
    })
    const wsBtn = (await waitFor(() => document.querySelector("[data-rail-acts] [data-rail-ws]"))) as HTMLButtonElement
    expect(wsBtn.disabled).toBe(true)
  })

  it("点「■ 中止」= 走查面既有二次确认口（requestAbort 句柄），壳不旁路直落 abortTask", async () => {
    const { t, detail } = awaitingRunning()
    renderConsole(t, detail)
    // 句柄注册到齐才点（surface keep-mounted → onActionApi 注册是同轮 effect）。
    await waitFor(() => expect(document.querySelector("[data-acceptance-surface-stub]")).toBeTruthy())
    const abortBtn = await waitFor(() => document.querySelector("[data-task-abort]") as HTMLElement)
    fireEvent.click(abortBtn)
    await waitFor(() => expect(mockRequestAbort).toHaveBeenCalled())
    expect(mockAbort).not.toHaveBeenCalled()
  })
})

describe("票 11 — 日志归位：事件流进页签，AI 消耗卡迁出", () => {
  const logEvents = [
    { nodeId: "dev", event: "start", timestamp: "2026-10-08T01:59:00.000Z" },
    { nodeId: "dev", event: "tool_call", toolName: "Edit", input: { file_path: "x.tsx" }, timestamp: "2026-10-08T01:59:30.000Z" },
    { nodeId: "dev", event: "intervention", timestamp: "2026-10-08T02:00:00.000Z", data: { nodeId: "dev", nodeName: "开发/修复", prompt: "别动 Dialog 尺寸逻辑，直接换固定壳" } },
  ]

  it("待验收「▶ 日志」：无「任务 AI 消耗」字样；agent_events 分类行 + ⚑ pink 高亮行在场", async () => {
    mockFetchAgentEvents.mockResolvedValue({ executionId: "exec-1", source: "sqlite", _degraded: false, _message: null, events: logEvents })
    const t = makeTask("awaiting_review")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "completed", { phase_index: 1, round_index: 1 })],
      derived: derivedOf([pv(1, "票11阶段1", "awaiting_review", { awaitingRound: 1 })], true, "awaiting_review"),
    })
    fireEvent.click(await screen.findByTestId("console-tab-console"))
    const stream = await screen.findByTestId("workspace-event-stream")
    expect(stream.textContent).toContain("工作区事件流")
    expect(stream.textContent).toContain("Edit")
    const iv = document.querySelector('[data-log-intervention="true"]') as HTMLElement
    expect(iv).toBeTruthy()
    expect(iv.textContent).toContain("⚑")
    expect(iv.textContent).toContain("别动 Dialog 尺寸逻辑，直接换固定壳")
    expect(iv.className).toContain("pop-pink") // 高亮=pink 行（spec 语义色）
    // AC2 反面半：整个壳里「任务 AI 消耗」字样绝迹（日志不再挂卡；卡去 ▤ 页签）。
    expect(screen.queryByText("任务 AI 消耗")).toBeNull()
    // 票06 testid 契约（收口②转钉版）：流内 ⚑ 行 = intervention-log/intervention-line。
    await screen.findByTestId("intervention-log")
    expect(await screen.findByTestId("intervention-line")).toBeTruthy()
  })

  it("running「▶ 控制台」：事件流带 live 标注（5s 轮询追加 ≤10s），无 AI 消耗卡", async () => {
    mockFetchAgentEvents.mockResolvedValue({ executionId: "exec-1", source: "sqlite", _degraded: false, _message: null, events: logEvents.slice(0, 2) })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-console"))
    const stream = await screen.findByTestId("workspace-event-stream")
    expect(stream.getAttribute("data-stream-live")).toBe("true")
    expect(screen.queryByText("任务 AI 消耗")).toBeNull()
  })
})

describe("票 11 — ▤ 消耗：卡三段 + 按会话/节点明细 + doer 行归属", () => {
  const execAgg = () => ({
    data: [],
    aggregates: {
      totalCalls: 3,
      toolCalls: 0,
      usage: { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totals: { tokens: 3600, cost: { usd: 0.02, complete: true }, cacheHitRate: null },
      modelBreakdown: {},
      byNode: [
        { nodeId: "dev", totalCalls: 2, usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0 }, totals: { tokens: 2400, cost: { usd: 0.012, complete: true }, cacheHitRate: null }, modelBreakdown: {} },
        { nodeId: "verify", totalCalls: 1, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 }, totals: { tokens: 1200, cost: { usd: 0.008, complete: true }, cacheHitRate: null }, modelBreakdown: {} },
      ],
    },
  })

  it("有 doer 会话且账上有调用 → 明细含逐节点行 + task-doer 单独行；徽标=成本", async () => {
    mockFetchLLMCalls.mockResolvedValue(execAgg())
    mockFetchSessionLLMCalls.mockResolvedValue({
      data: [],
      aggregates: { totalCalls: 4, usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 2000, cacheCreationTokens: 0 }, totals: { tokens: 2600, cost: { usd: 0.003, complete: true }, cacheHitRate: null }, modelBreakdown: {} },
    })
    const t = makeTask("running", { doer_session_id: "s-doer" } as never)
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-usage"))
    const usage = await screen.findByTestId("usage-tab")
    expect(usage.textContent).toContain("任务 AI 消耗") // 卡三段升格进页签
    const nodeRows = within(usage).getAllByTestId("usage-node-row")
    expect(nodeRows).toHaveLength(2)
    expect(nodeRows[0]!.textContent).toContain("dev")
    expect(nodeRows[1]!.textContent).toContain("verify")
    const doerRow = within(usage).getByTestId("usage-doer-row")
    expect(doerRow.textContent).toContain("task-doer")
    // 两账不混：doer 行独立成行，不并入任何节点行
    expect(nodeRows.every((r) => !r.textContent!.includes("task-doer"))).toBe(true)
    // 徽标 = 任务成本
    expect((await screen.findByTestId("tab-badge-usage")).textContent).toContain("$")
  })

  it("无对话历史（doer_session_id 缺）→ 不显 doer 行，会话账根本不拉", async () => {
    mockFetchLLMCalls.mockResolvedValue(execAgg())
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-usage"))
    await screen.findByTestId("usage-tab")
    expect(screen.queryByTestId("usage-doer-row")).toBeNull()
    expect(mockFetchSessionLLMCalls).not.toHaveBeenCalled()
  })
})

describe("票 11 — ▣ 产物：分组清单挂载 + 徽标件数", () => {
  const manifestBody = {
    groups: [
      { key: "spec", label: "📄 需求与票面", items: [
        { name: "spec.md", path: "home:.scratch/demo/spec.md", bytes: 2048, mtime: "2026-10-08T01:00:00.000Z" },
        { name: "01-shell.md", path: "home:.scratch/demo/issues/01-shell.md", bytes: 512, mtime: "2026-10-08T01:00:00.000Z" },
      ] },
      { key: "report", label: "🧾 轮次报告", items: [
        { name: "round-report-r1.md", path: "home:.scratch/demo/round-report-r1.md", bytes: 1024, mtime: "2026-10-08T01:00:00.000Z" },
      ] },
      { key: "evidence", label: "🔍 证据", items: [] },
      { key: "ledger", label: "📒 验收台账", items: [] },
      { key: "prototype", label: "💡 原型", items: [] },
    ],
  }

  it("manifest 两组三件 → 徽标 3、组分列行带 预览/路径 按钮；空组不占列", async () => {
    mockGetArtifactManifest.mockResolvedValue(manifestBody)
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    const artTab = await waitFor(() => {
      const el = document.querySelector("[data-console-tab=artifacts]") as HTMLElement | null
      if (!el || !el.textContent?.includes("3")) throw new Error("badge not fed")
      return el
    })
    expect(artTab.getAttribute("data-testid")).toBe("console-tab-artifacts")
    fireEvent.click(artTab)
    const host = await screen.findByTestId("artifacts-tab")
    expect(within(host).getAllByTestId("artifact-row")).toHaveLength(3)
    expect(within(host).getAllByTestId("artifact-preview-btn")).toHaveLength(3)
    expect(within(host).getAllByTestId("artifact-copy-btn")).toHaveLength(3)
    // 空组不占列（缺文件降级为无形，不是空标题刷屏）
    expect(within(host).queryByTestId("artifacts-group-evidence")).toBeNull()
  })

  it("manifest 读取失败 → 空组壳照常（不白屏，空态如实）", async () => {
    mockGetArtifactManifest.mockRejectedValue(new Error("boom"))
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-artifacts"))
    const host = await screen.findByTestId("artifacts-tab")
    expect(within(host).getByTestId("artifacts-empty")).toBeTruthy()
  })

  it("票11 刀A：首拉成功后 refetch 失败 → 保留已加载清单（失败≠假空覆盖）", async () => {
    // 默认全败（模拟浏览器层 net::ERR_FAILED 常态化抖动），只许首拉成功 ——
    // 挂载期若有额外重拉也走失败路，正好一并验证「失败不覆盖」。
    mockGetArtifactManifest.mockReset()
    mockGetArtifactManifest.mockRejectedValue(new Error("net::ERR_FAILED"))
    mockGetArtifactManifest.mockResolvedValueOnce(manifestBody)
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    // 首拉落盘：徽标 3 + 页签内三行在场。
    const artTab = await waitFor(() => {
      const el = document.querySelector("[data-console-tab=artifacts]") as HTMLElement | null
      if (!el || !el.textContent?.includes("3")) throw new Error("badge not fed")
      return el
    })
    fireEvent.click(artTab)
    const host = await screen.findByTestId("artifacts-tab")
    expect(within(host).getAllByTestId("artifact-row")).toHaveLength(3)
    // diffSignal 翻转（既有 task_artifacts_update SSE 一发）→ 追加 refetch，必败。
    const sub = await waitFor(() => {
      const s = sseSubs.find((x) => x.url.includes("/api/tasks/events") && x.type === "task_artifacts_update")
      if (!s) throw new Error("no task_artifacts_update subscription")
      return s
    })
    act(() => { sub.fn({ data: JSON.stringify({ task_id: t.id }) } as unknown as MessageEvent) })
    await waitFor(() => expect(mockGetArtifactManifest.mock.calls.length).toBeGreaterThanOrEqual(2))
    // 失败不得写空覆盖：行仍 3、空态不挂、徽标件数不塌。
    expect(within(screen.getByTestId("artifacts-tab")).getAllByTestId("artifact-row")).toHaveLength(3)
    expect(screen.queryByTestId("artifacts-empty")).toBeNull()
    expect(document.querySelector("[data-testid='tab-badge-artifacts']")?.textContent).toContain("3")
  })

  it("零产物不挂徽标（收口⑥：server 空降级恒返五组，groups.length 判据会谎挂「0」）", async () => {
    // 生产形 = tasks-artifact-manifest.test 钉住的空降级：五组齐、items 全空。
    mockGetArtifactManifest.mockResolvedValue({
      groups: [
        { key: "spec", label: "📄 需求与票面", items: [] },
        { key: "report", label: "🧾 轮次报告", items: [] },
        { key: "evidence", label: "🔍 证据", items: [] },
        { key: "ledger", label: "📒 验收台账", items: [] },
        { key: "prototype", label: "💡 原型", items: [] },
      ],
    })
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    // 等 manifest 真的落了盘（页签内空态出现 = body 已进壳层 state），再判徽标。
    fireEvent.click(await screen.findByTestId("console-tab-artifacts"))
    await screen.findByTestId("artifacts-empty")
    expect(screen.queryByTestId("tab-badge-artifacts")).toBeNull()
  })
})

// ═════════════════ 票 11 双轴 review 收口 — 日志接既有 SSE + 中止兜底带确认 ═════════════════

describe("票 11 收口① — 日志流优先订既有 executions/events（轮询只作兜底/首屏）", () => {
  it("live 轮：agent_event wire 实时追加 ⚙ 行（不等 5s 轮询）；executionId 不匹配不进流", async () => {
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-console"))
    await screen.findByTestId("workspace-event-stream")
    // 既有通道 = GET /api/workspaces/:ws/executions/events（engine 在 EngineCallbacks
    // 以 "agent_event" emit；sse-manager 按 url 共享一条连接，不另开第二份）。
    const sub = await waitFor(() => {
      const s = sseSubs.find((x) => x.type === "agent_event" && x.url.includes("/api/workspaces/ws-1/executions/events"))
      if (!s) throw new Error("no agent_event subscription yet")
      return s
    })
    // 首屏 = 轮询兜底（既有 fetchAgentEvents 通道照打）。
    await waitFor(() => expect(mockFetchAgentEvents).toHaveBeenCalledWith("ws-1", "exec-1"))

    // wire 形 = { executionId, nodeId, event }（EngineCallbacks.onAgentEvent 定形）。
    const toolDone = {
      executionId: "exec-1", nodeId: "dev",
      event: { type: "tool_result", toolCallId: "t9", toolName: "Write", content: "created x.tsx", timestamp: Date.parse("2026-10-08T03:00:00.000Z") },
    }
    act(() => { sub.fn({ data: JSON.stringify(toolDone) } as unknown as MessageEvent) })
    const stream = await screen.findByTestId("workspace-event-stream")
    expect(await within(stream).findByText(/Write/)).toBeTruthy()

    // 别的执行的事件不进本壳（executionId 闸）。
    act(() => {
      sub.fn({ data: JSON.stringify({ ...toolDone, executionId: "exec-OTHER", event: { ...toolDone.event, toolName: "Bash-other-exec" } }) } as unknown as MessageEvent)
    })
    expect(stream.textContent).not.toContain("Bash-other-exec")
  })

  it("错误 wire 实时成 ✗ 行；噪声 wire（turn_usage/status/heartbeat）不落行", async () => {
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    fireEvent.click(await screen.findByTestId("console-tab-console"))
    const sub = await waitFor(() => {
      const s = sseSubs.find((x) => x.type === "agent_event" && x.url.includes("executions/events"))
      if (!s) throw new Error("no agent_event subscription yet")
      return s
    })
    act(() => {
      sub.fn({ data: JSON.stringify({ executionId: "exec-1", nodeId: "dev", event: { type: "error", code: "E", message: "SDK 连接断裂", timestamp: Date.parse("2026-10-08T03:01:00.000Z") } }) } as unknown as MessageEvent)
      sub.fn({ data: JSON.stringify({ executionId: "exec-1", nodeId: "dev", event: { type: "turn_usage", turn: 2, delta: {}, cumulative: {}, timestamp: Date.parse("2026-10-08T03:01:01.000Z") } }) } as unknown as MessageEvent)
      sub.fn({ data: JSON.stringify({ executionId: "exec-1", nodeId: "dev", event: { type: "status", status: "requesting" } }) } as unknown as MessageEvent)
    })
    const stream = await screen.findByTestId("workspace-event-stream")
    expect(stream.textContent).toContain("SDK 连接断裂")
    expect(stream.textContent).not.toContain("requesting")
    expect(within(stream).getAllByTestId("workspace-log-line")).toHaveLength(1)
  })
})

describe("票 11 收口⑦ — 中止兜底路径也过二次确认（ConfirmDialog 单源）", () => {
  it("句柄不在场（running 直落形态）：点 ■ 中止 → 出确认框，不直接打 abortTask；确认后才落端点", async () => {
    mockAbort.mockResolvedValue({})
    const t = makeTask("running")
    renderConsole(t, {
      ...t,
      executions: [badge("exec-1", "running", { completed_at: null })],
      derived: derivedOf([pv(1, "票11阶段1", "running")]),
    })
    const abortBtn = await waitFor(() => {
      const el = document.querySelector("[data-rail-acts] [data-task-abort]") as HTMLElement | null
      if (!el) throw new Error("abort button missing")
      return el
    })
    fireEvent.click(abortBtn)
    // 兜底不再旁路：确认框先亮，端点零调用。
    const title = await screen.findByText("中止任务「控制台任务」？")
    expect(title).toBeTruthy()
    expect(mockAbort).not.toHaveBeenCalled()
    expect(mockRequestAbort).not.toHaveBeenCalled() // 走查面句柄路径未被误用
    fireEvent.click(screen.getByRole("button", { name: "确认中止" }))
    await waitFor(() => expect(mockAbort).toHaveBeenCalledWith("task-1"))
  })
})
