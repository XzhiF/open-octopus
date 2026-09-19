// task-phase-redesign 票 12（AC1/AC2）+ 验货台 v2（实物 diff / 当场复检 / 票对账）
// — AcceptanceSurface 组件测试（2026-09-16：三栏弹窗 AcceptanceModal 收编为执行
// 控制台的「验货台」tab，本测试随内容组件迁移）。数据权威 = GET /:id.derived
// （票 03 唯一真相），fixture 独立于组件实现。中列三 tab：默认「实物」；「叙述」
// 承接 v1 批次文件断言（点击 tab 后可见）；复检 SSE 用 subscribeSSE 捕获表手动注入事件。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec } from "@octopus/shared"
import type { TaskDetail, TaskDerivedView } from "@/lib/tasks-api"

const {
  mockGetTask, mockPostAcceptance, mockAbortTask,
  mockFetchLLMCalls, mockUpdateSpecField,
  mockListHomeDir, mockGetHomeFile, mockGetBatchTree,
  mockGetRoundDiff, mockGetRoundPatch, mockStartVerify, mockGetVerifyStatus, mockAbortVerify,
  mockGetPlaybook, mockStartPreview, mockGetPreview, mockStopPreview, mockSaveChecks, mockPutHomeFile, mockReadChecks,
  mockRunProbe,
  sseHandlers,
} = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockPostAcceptance: vi.fn(),
  mockAbortTask: vi.fn(),
  mockFetchLLMCalls: vi.fn(),
  mockUpdateSpecField: vi.fn(),
  mockListHomeDir: vi.fn(),
  mockGetHomeFile: vi.fn(),
  mockGetBatchTree: vi.fn(),
  mockGetRoundDiff: vi.fn(),
  mockGetRoundPatch: vi.fn(),
  mockStartVerify: vi.fn(),
  mockGetVerifyStatus: vi.fn(),
  mockAbortVerify: vi.fn(),
  mockGetPlaybook: vi.fn(),
  mockStartPreview: vi.fn(),
  mockGetPreview: vi.fn(),
  mockStopPreview: vi.fn(),
  mockSaveChecks: vi.fn(),
  mockReadChecks: vi.fn(),
  mockPutHomeFile: vi.fn(),
  mockRunProbe: vi.fn(),
  sseHandlers: new Map<string, (e: MessageEvent) => void>(),
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
    // 叙述 tab（v1 证据面）+ 验货台 v2 出口。
    listHomeDir: mockListHomeDir,
    getHomeFile: mockGetHomeFile,
    getBatchTree: mockGetBatchTree,
    MAX_HOME_FILE_READ_BYTES: 512_000,
    getRoundDiff: mockGetRoundDiff,
    getRoundPatch: mockGetRoundPatch,
    startVerify: mockStartVerify,
    getVerifyStatus: mockGetVerifyStatus,
    abortVerify: mockAbortVerify,
    // 验收面 v2.1：剧本 + 预览 + checks（默认返回「无剧本 / 无预览」，具体用例覆写）。
    getPlaybook: mockGetPlaybook,
    startPreview: mockStartPreview,
    getPreview: mockGetPreview,
    stopPreview: mockStopPreview,
    putHomeFile: mockPutHomeFile,
    readChecks: mockReadChecks,
    saveChecks: mockSaveChecks,
    runProbe: mockRunProbe,
    checksFileName: (n: number) => `acceptance-checks-r${n}.md`,
    checksRelPath: (d: string, n: number) => `${d}/acceptance-checks-r${n}.md`,
    parseChecksMd: () => null,
    renderChecksMd: () => "",
  }
})
// react-markdown 全家桶对单测是纯负担 — 桩到内容透传（渲染质量归 MarkdownPreview 自己）。
vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div data-md-preview>{content}</div>,
}))
vi.mock("@/lib/observability-api", () => ({ fetchLLMCalls: mockFetchLLMCalls }))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: (_url: string, event: string, cb: (e: MessageEvent) => void) => {
    sseHandlers.set(event, cb)
    return () => { sseHandlers.delete(event) }
  },
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AcceptanceSurface } from "../acceptance-surface"
import { ImpactApprovalList } from "../impact-approval-list"
import { TaskApiError } from "@/lib/tasks-api"
import { TASK_VERIFY_EVENT, TASK_VERIFY_LOG_EVENT } from "@octopus/shared"

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

/** 验收面 v2.1：带 acceptance_preview 配置 → 预览条显示 ▶启动（非配置态）。 */
const V4_SPEC_WITH_PREVIEW = {
  ...(V4_SPEC as object),
  acceptance_preview: { command: "mvn -q spring-boot:run", url: "http://localhost:8080/" },
} as unknown as TaskSpec

/** specPath 绝对（gateV4 旁路直写）→ 中列定位走 getBatchTree slug 回退。 */
const V4_SPEC_ABS = {
  ...(V4_SPEC as object),
  phases: [
    { index: 1, name: "脚手架", slug: "scaffold-1", specPath: "/tmp/ws/scaffold/spec.md", workflowRef: "task-dev", inputValues: {} },
  ],
} as unknown as TaskSpec

/** 带 acceptance_verify 配置的 spec（复检面板显示命令 + ▶ 可点）。 */
const V4_SPEC_VERIFY = {
  ...(V4_SPEC as object),
  acceptance_verify: { command: "pnpm test", timeoutS: 600 },
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

// 叙述 tab 证据 fixture — home-relative posix（listHomeDir all=1 的真实形状）。
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

// 实物 tab fixture — server RoundDiffPayload 形状（SHA 不出服务端，web 只见统计）。
const ROUND_DIFF = {
  available: true,
  aggregate: { commits: 2, additions: 2271, dels: 95, files: 39 },
  interventions: 3,
  repos: [
    {
      name: "open-octopus",
      commits: 2, additions: 2271, dels: 95, files: 2, truncated: false,
      groups: [
        { dir: "packages", additions: 2271, dels: 95, files: [
          { path: "packages/cli/src/utils/usage-writer.ts", status: "A", adds: 2200, dels: 0 },
          { path: "packages/server/src/db/schema.ts", status: "M", adds: 71, dels: 95 },
        ] },
      ],
    },
  ],
}

const SPEC_MATRIX_MD = `# scaffold-1
## User Stories
- **US1** 脚手架可用
## Ticket DAG
| 票 | 标题 | blockedBy |
|----|------|-----------|
| 01 | 初始化 | — |
| 02 | 挂点 | 01 |
`
const REPORT_MATRIX_MD = `# Round Report · scaffold-1 · r1
## 票执行摘要
| 票 | 标题 | 状态 | 备注 |
|----|------|------|------|
| 01 | 初始化 | ✅ done | packages/cli/src/utils/usage-writer.ts 新建 |
| 02 | 挂点 | ✅ done | 改了些不存在的路径/ghost-file.ts |
`

function fireSse(event: string, payload: Record<string, unknown>): void {
  const cb = sseHandlers.get(event)
  if (!cb) throw new Error(`no SSE handler subscribed for ${event}`)
  cb(new MessageEvent("message", { data: JSON.stringify(payload) }))
}

function rowByPath(p: string): HTMLElement | null {
  return document.querySelector(`[data-acceptance-artifact-row="${p}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
  sseHandlers.clear()
  mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING))
  mockFetchLLMCalls.mockResolvedValue({ data: [], aggregates: AGG })
  mockListHomeDir.mockResolvedValue(HOME_FILES)
  mockGetHomeFile.mockImplementation(async (_id: string, p: string) => {
    if (p.endsWith("spec.md")) return { path: p, content: SPEC_MATRIX_MD }
    if (p.endsWith("round-report.md")) return { path: p, content: REPORT_MATRIX_MD }
    return { path: p, content: "# spec body" }
  })
  mockGetBatchTree.mockResolvedValue([])
  mockGetRoundDiff.mockResolvedValue(ROUND_DIFF)
  mockGetRoundPatch.mockResolvedValue({ patch: "@@ -1 +1,2 @@\n-l2\n+l2-edited\n", truncated: false })
  mockStartVerify.mockResolvedValue({
    task_id: "t1", execution_id: "exec-1", phase_index: 1, round_index: 1,
    command: "pnpm test", cwd: ".", state: "running", started_at: "2026-09-03T01:00:00Z",
  })
  mockGetVerifyStatus.mockResolvedValue(null)
  mockAbortVerify.mockResolvedValue({ state: "running" })
  // 验收面 v2.1 默认：无剧本（面板显降级空态，不打扰既有断言）+ 无预览会话。
  mockGetPlaybook.mockResolvedValue({
    available: false, goal: "", specRevised: false,
    budget: { steps: 0, estMin: 0, over: false, degraded: false },
    sections: [], finePrint: [], carryover: [], coverage: { found: [], missing: [] },
  })
  mockGetPreview.mockResolvedValue(null)
  mockStartPreview.mockResolvedValue({ task_id: "t1", url: "http://localhost:8080/", state: "starting" })
  mockStopPreview.mockResolvedValue({ task_id: "t1", url: "http://localhost:8080/", state: "stopped" })
  mockSaveChecks.mockResolvedValue(undefined)
  mockReadChecks.mockResolvedValue({ version: "1", checks: {} })
  mockRunProbe.mockResolvedValue({ state: "passed", exit_code: 0, duration_ms: 900, tail: ["ok"] })
})

function renderModal(spec: TaskSpec = V4_SPEC) {
  mockGetTask.mockResolvedValue(makeDetail(PHASE1_AWAITING, spec))
  const task = makeDetail(PHASE1_AWAITING, spec) as unknown as Task
  return render(<AcceptanceSurface task={task} onMutated={() => {}} />)
}

/** 票 04：指定派生视图开窗（覆盖 beforeEach 的默认 mockGetTask 返回值）。 */
function renderModalWith(derived: TaskDerivedView, spec: TaskSpec = V4_SPEC) {
  mockGetTask.mockResolvedValue(makeDetail(derived, spec))
  const task = makeDetail(derived, spec) as unknown as Task
  return render(<AcceptanceSurface task={task} onMutated={() => {}} />)
}

/** tab 条在 awaitingPhase 到手（detail 落地）后才渲染 — 必须异步等。 */
async function openStoryTab() {
  const tab = await screen.findByTestId("acceptance-tab-story")
  fireEvent.click(tab)
}

describe("AcceptanceSurface — AC1 证据面（A′：进度+决策，token/cost 已迁出）", () => {
  it("三栏齐现；右栏=round 状态/用时/复检态；AC6：验货台不再拉 fetchLLMCalls、无 token/cost", async () => {
    renderModal()
    expect(await screen.findByTestId("acceptance-modal")).toBeTruthy()
    expect(screen.getByTestId("acceptance-col-summary")).toBeTruthy()
    expect(screen.getByTestId("acceptance-col-artifacts"))
    expect(screen.getByTestId("acceptance-col-actions"))
    expect(screen.getByTestId("acceptance-phase-label").textContent).toBe("Phase 1/2 · Round 1")
    expect(screen.getByTestId("acceptance-round-state").textContent).toBe("执行成功")
    expect(screen.getByTestId("acceptance-duration").textContent).toBe("42m 0s")
    // ADR-0022：token/cost 撤出验货台（迁执行控制台 AI 卡）——绝不再拉，DOM 无成本串。
    expect(mockFetchLLMCalls).not.toHaveBeenCalled()
    expect(screen.queryByText(/\$\d/)).toBeNull()
    expect(screen.queryByText(/次调用|↑/)).toBeNull()
    // 复检态行进右栏进度卡
    expect(screen.getByText("未跑")).toBeTruthy()
  })

  it("T06 剧本渲染：available:true → 主角卡 + 步 + ✓✗⊘ 三钮", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "走通剧本", specRevised: false,
      budget: { steps: 1, estMin: 2, over: false, degraded: false },
      sections: [{ kind: "walk", title: "E2E 测试计划", source: "e2e-test-plan.md",
        items: [{ id: "walk:plan:1", op: "打开验收台", expect: "剧本 ≥3 步", evidence: "有预期句" }] }],
      finePrint: [], carryover: [], coverage: { found: ["e2e-test-plan.md"], missing: [] },
    })
    renderModal()
    const panel = await screen.findByTestId("playbook-panel")
    expect(panel.textContent).toContain("打开验收台")
    expect(panel.textContent).toContain("剧本 ≥3 步")
    expect(screen.getByTestId("step-walk:plan:1")).toBeTruthy()
    expect(screen.getAllByTestId("decide-pass").length).toBeGreaterThan(0)
    expect(screen.getByTestId("preview-bar")).toBeTruthy()
  })

  it("T09 决策闭环：标 ✗ → 验收通过 disabled + 拦截提示；台账弹层出现", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "g", specRevised: false,
      budget: { steps: 1, estMin: 2, over: false, degraded: false },
      sections: [{ kind: "walk", title: "T", source: "e2e-test-plan.md", items: [{ id: "walk:plan:1", op: "op", expect: "exp" }] }],
      finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    renderModal()
    await screen.findByTestId("playbook-panel")
    fireEvent.click(screen.getByTestId("decide-fail"))
    // fail → gate.fail>0 → approve disabled + 提示
    await waitFor(() => expect((screen.getByTestId("acceptance-approve") as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByTestId("acceptance-approve-blocked")).toBeTruthy()
  })

  it("T07 预览启动：点 ▶启动 → startPreview(t1) + 状态条切 starting", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: false, goal: "", specRevised: false, budget: { steps: 0, estMin: 0, over: false, degraded: false },
      sections: [], finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    renderModal(V4_SPEC_WITH_PREVIEW)
    await screen.findByTestId("preview-bar")
    fireEvent.click(screen.getByTestId("preview-start"))
    await waitFor(() => expect(mockStartPreview).toHaveBeenCalledWith("t1"))
  })

  it("T06 AC2 勾选合批写回：300ms 内连点两步 → saveChecks 仅一次（payload 含两步）", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "g", specRevised: false,
      budget: { steps: 2, estMin: 4, over: false, degraded: false },
      sections: [{ kind: "walk", title: "T", source: "e2e-test-plan.md", items: [
        { id: "walk:plan:1", op: "op1", expect: "e1" }, { id: "walk:02-e2e-status:0", op: "op2", expect: "e2" }] }],
      finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    renderModal()
    await screen.findByTestId("playbook-panel")
    // 排空：前序用例（标 ✗）遗留的 debounce 定时器可能在本窗口落地
    await new Promise((r) => setTimeout(r, 400))
    mockSaveChecks.mockClear()
    // 两次点击都落在 300ms debounce 窗口内 → 合批一次写回
    fireEvent.click(screen.getAllByTestId("decide-pass")[0])
    fireEvent.click(screen.getAllByTestId("decide-pass")[1])
    await new Promise((r) => setTimeout(r, 450))
    expect(mockSaveChecks).toHaveBeenCalledTimes(1)
    const [taskId, dir, round, payload] = mockSaveChecks.mock.calls[0] as [string, string, number, Record<string, { decision: string }>]
    expect(taskId).toBe("t1")
    expect(round).toBe(1)
    expect(Object.keys(payload).sort()).toEqual(["walk:02-e2e-status:0", "walk:plan:1"])
    expect(Object.values(payload).every((c) => c.decision === "pass")).toBe(true)
    void dir
  })

  it("T06 AC2 刷新回填：readChecks 命中 pass → 右栏走查计数回填 1/1", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "g", specRevised: false,
      budget: { steps: 1, estMin: 2, over: false, degraded: false },
      sections: [{ kind: "walk", title: "T", source: "e2e-test-plan.md", items: [{ id: "walk:plan:1", op: "op", expect: "e" }] }],
      finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    mockReadChecks.mockResolvedValue({ version: "1", checks: { "walk:plan:1": { decision: "pass", note: "", at: "t" } } })
    renderModal()
    const rail = await screen.findByTestId("rail-walk-count")
    // 默认 readChecks={} → 0/1；此处命中盘上 pass → gate.pass=1（未决归零，DOM 无「未决 N>0」）
    await waitFor(() => expect(rail.textContent).toContain("1/1"))
    expect(rail.textContent).not.toMatch(/未决 [1-9]/)
  })

  it("T07 AC2 预览配置：保存走 spec-field(user)；400 → 原因冒泡且抽屉不收起", async () => {
    mockUpdateSpecField.mockRejectedValue(new TaskApiError("url must be http(s)", 400))
    renderModal()
    await screen.findByTestId("preview-bar")
    fireEvent.click(screen.getByTestId("preview-configure"))
    fireEvent.change(screen.getByTestId("preview-command"), { target: { value: "mvn -q spring-boot:run" } })
    fireEvent.change(screen.getByTestId("preview-url-input"), { target: { value: "http://localhost:8080/api/status" } })
    fireEvent.click(screen.getByTestId("preview-save"))
    await waitFor(() =>
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "acceptance_preview",
        { command: "mvn -q spring-boot:run", url: "http://localhost:8080/api/status" },
        { source: "user" },
      ),
    )
    // 保存失败 → 抽屉留在位（配置不丢），原因经 toast 通道冒给玩家
    expect(screen.getByTestId("preview-editor")).toBeTruthy()
  })

  it("T06 AC3 降级：available:false → 降级卡点名缺源 + 「配置命令」指引，不白屏", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: false, goal: "", specRevised: false,
      budget: { steps: 0, estMin: 0, over: false, degraded: false },
      sections: [], finePrint: [], carryover: [],
      coverage: { found: [], missing: ["e2e-test-plan.md", "tickets"] },
    })
    renderModal()
    const card = await screen.findByTestId("playbook-empty")
    expect(card.textContent).toContain("e2e-test-plan.md") // 点名缺哪份契约源（诚实降级）
    expect(card.textContent).toContain("配置命令") // 给出路，不是死路
    // 不白屏：模态与决策面照常在场
    expect(screen.getByTestId("acceptance-modal")).toBeTruthy()
    expect(screen.getByTestId("acceptance-approve")).toBeTruthy()
  })

  it("T07 AC1 ready 态：↗ href=预览 URL；停止钮 → stopPreview(t1)", async () => {
    mockGetPreview.mockResolvedValue({
      task_id: "t1", url: "http://localhost:8080/api/status", state: "ready",
      command: "mvn -q spring-boot:run", started_at: "x", external: false,
    })
    renderModal(V4_SPEC_WITH_PREVIEW)
    const link = await screen.findByTestId("preview-url")
    await waitFor(() => expect(link.getAttribute("href")).toBe("http://localhost:8080/api/status"))
    fireEvent.click(screen.getByTestId("preview-stop"))
    await waitFor(() => expect(mockStopPreview).toHaveBeenCalledWith("t1"))
  })

  // ── runbook（acceptance v2.2 多服务运行手册 — 与 server resolveRunbook 同优先级）──

  const V4_SPEC_RUNBOOK = {
    ...(V4_SPEC as object),
    acceptance_runbook: {
      up: { command: "mvn -B -DskipTests package && java -jar target/x.jar --server.port=18081", cwd: "projects/api" },
      ready: { command: "curl -sf http://localhost:18081/demo" },
      views: [{ label: "admin", url: "http://localhost:18081/demo" }, { label: "docs", url: "http://localhost:18081/docs" }],
      down: { command: "pkill -f x.jar || true" },
      timeoutS: 300,
    },
  } as unknown as TaskSpec

  it("RB1: 任务只有 acceptance_runbook → 预览条识别为 runbook 态，▶启动可点（不再「未配置」）", async () => {
    mockGetPreview.mockResolvedValue(null)
    renderModal(V4_SPEC_RUNBOOK)
    await screen.findByTestId("preview-mode-runbook")
    expect(screen.getByTestId("preview-mode-runbook").textContent).toContain("runbook")
    fireEvent.click(screen.getByTestId("preview-start"))
    await waitFor(() => expect(mockStartPreview).toHaveBeenCalledWith("t1"))
  })

  it("RB2: ready + views[] → 多入口链接全渲染（href/label 各一），不再只见首 url", async () => {
    mockGetPreview.mockResolvedValue({
      task_id: "t1", url: "http://localhost:18081/demo", state: "ready",
      views: [{ label: "admin", url: "http://localhost:18081/demo" }, { label: "docs", url: "http://localhost:18081/docs" }],
    })
    renderModal(V4_SPEC_RUNBOOK)
    const links = await screen.findAllByTestId("preview-url")
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute("href")).toBe("http://localhost:18081/demo")
    expect(links[1].getAttribute("href")).toBe("http://localhost:18081/docs")
    expect(links[1].textContent).toContain("docs")
  })

  it("RB3: runbook 编辑抽屉 — up/ready/views/down 可改，保存写 acceptance_runbook（spec-field user）", async () => {
    renderModal(V4_SPEC_RUNBOOK)
    await screen.findByTestId("preview-mode-runbook")
    fireEvent.click(screen.getByTestId("preview-edit"))
    fireEvent.change(screen.getByTestId("rb-ready-command"), { target: { value: "curl -sf http://localhost:18082/actuator/health" } })
    fireEvent.change(screen.getByTestId("rb-views"), { target: { value: "admin|http://localhost:18082/\nhttp://localhost:18082/docs" } })
    fireEvent.click(screen.getByTestId("rb-save"))
    await waitFor(() =>
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "acceptance_runbook",
        {
          up: { command: "mvn -B -DskipTests package && java -jar target/x.jar --server.port=18081", cwd: "projects/api" },
          ready: { command: "curl -sf http://localhost:18082/actuator/health" },
          views: [{ label: "admin", url: "http://localhost:18082/" }, { url: "http://localhost:18082/docs" }],
          down: { command: "pkill -f x.jar || true" },
          timeoutS: 300,
        },
        { source: "user" },
      ),
    )
  })

  it("RB4: 简写配置可一键升级 runbook（预填 up/ready/views），保存写 runbook 不碰简写", async () => {
    renderModal(V4_SPEC_WITH_PREVIEW)
    await screen.findByTestId("preview-bar")
    fireEvent.click(screen.getByTestId("preview-edit"))
    fireEvent.click(screen.getByTestId("preview-to-rb"))
    expect(screen.getByTestId("rb-up-command").getAttribute("value")).toBe("mvn -q spring-boot:run")
    expect(screen.getByTestId("rb-ready-command").getAttribute("value")).toContain("curl -sf")
    fireEvent.click(screen.getByTestId("rb-save"))
    await waitFor(() => expect(mockUpdateSpecField).toHaveBeenCalledWith("t1", "acceptance_runbook", expect.anything(), { source: "user" }))
    expect(mockUpdateSpecField.mock.calls.some((c) => c[1] === "acceptance_preview")).toBe(false)
  })

  it("RB5: 未配置态给两条路（配置预览 / runbook 方式）；runbook 路径起多服务表单", async () => {
    renderModal()
    await screen.findByTestId("preview-bar")
    fireEvent.click(screen.getByTestId("preview-configure-rb"))
    expect(screen.getByTestId("preview-editor").getAttribute("data-rb")).toBe("true")
    fireEvent.change(screen.getByTestId("rb-up-command"), { target: { value: "docker compose up -d" } })
    fireEvent.change(screen.getByTestId("rb-ready-command"), { target: { value: "docker compose ps web | grep healthy" } })
    fireEvent.click(screen.getByTestId("rb-save"))
    await waitFor(() =>
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "acceptance_runbook",
        { up: { command: "docker compose up -d" }, ready: { command: "docker compose ps web | grep healthy" }, timeoutS: 120 },
        { source: "user" },
      ),
    )
  })

  it("T09 AC2 ✗ 闭环：打回提交 body 携带 reopen_tickets（票名基去兜底）", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "g", specRevised: false,
      budget: { steps: 2, estMin: 4, over: false, degraded: false },
      sections: [{ kind: "walk", title: "T", source: "s.md", items: [
        { id: "walk:plan:1", op: "plan 兜底步", expect: "e" }, { id: "walk:02-e2e-status:0", op: "票步", expect: "e" }] }],
      finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    mockPostAcceptance.mockResolvedValue({ task: {}, dispatch: null })
    renderModal()
    await screen.findByTestId("playbook-panel")
    // 只标 ✗ 票步（plan 兜底不算真票，不该进 reopen）
    const ticketStep = await screen.findByTestId("step-walk:02-e2e-status:0")
    fireEvent.click(ticketStep.querySelector('[data-testid="decide-fail"]')!)
    await waitFor(() => expect((screen.getByTestId("acceptance-approve") as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(screen.getByTestId("acceptance-reject"))
    fireEvent.change(screen.getByTestId("reject-feedback"), { target: { value: "端点缺字段" } })
    fireEvent.click(screen.getByTestId("reject-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalled())
    const input = mockPostAcceptance.mock.calls[0][1] as { decision: string; reopen_tickets?: string[] }
    expect(input.decision).toBe("rejected")
    expect(input.reopen_tickets).toEqual(["02-e2e-status"])
  })

  it("右列动作区：通过/打回/中止 齐备 + autoAdvance 只读态", async () => {
    renderModal()
    expect(await screen.findByTestId("acceptance-approve")).toBeTruthy()
    expect(screen.getByTestId("acceptance-reject")).toBeTruthy()
    expect(screen.getByTestId("acceptance-abort")).toBeTruthy()
    expect(screen.getByTestId("autoadvance-readonly").textContent).toContain("开")
  })
})

describe("验货台 v2 — 实物 tab（默认 C 位）", () => {
  it("开窗即拉 round-diff；stat strip + repo 分组 + 文件行渲染（web 不见 SHA）", async () => {
    renderModal()
    await waitFor(() => expect(mockGetRoundDiff).toHaveBeenCalledWith("t1"))
    const strip = await screen.findByTestId("round-diff-strip")
    expect(strip.textContent).toContain("2271") // +新增行
    expect(strip.textContent).toContain("95")
    expect(screen.getByTestId("round-diff-repo-open-octopus")).toBeTruthy()
    expect(document.querySelector('[data-acceptance-diff-row="open-octopus:packages/cli/src/utils/usage-writer.ts"]')).toBeTruthy()
    // 实物 tab 里没有叙述文件列表（tab 隔离）
    expect(screen.queryByTestId("acceptance-artifact-rows")).toBeNull()
  })

  it("文件点开 → 懒拉 patch（getRoundPatch repo+path）行着色渲染；不重复拉", async () => {
    renderModal()
    expect(await screen.findByTestId(`acceptance-tab-diff`)).toBeTruthy()
    // 查询必须在 waitFor 里做 — diff 行随 getRoundDiff 的 promise 落地，
    // 同步 querySelector 拿到的是加载前的 null（旧弹窗版靠微任务时序侥幸绿）。
    let fileBtn: HTMLButtonElement | null = null
    await waitFor(() => {
      fileBtn = document.querySelector('[data-acceptance-diff-row="open-octopus:packages/server/src/db/schema.ts"]')
      expect(fileBtn).toBeTruthy()
    })
    fireEvent.click(fileBtn!)
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "open-octopus", "packages/server/src/db/schema.ts"))
    const patch = await screen.findByTestId("round-diff-patch")
    expect(patch.textContent).toContain("l2-edited")
    fireEvent.click(fileBtn!) // 收起
    fireEvent.click(fileBtn!) // 再展开 → 缓存，不再拉
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledTimes(1))
  })

  it("diff 不可得 → 诚实过期卡（不是 500，不是空表）", async () => {
    mockGetRoundDiff.mockResolvedValue({ available: false, reason: "no_commits", aggregate: { commits: 0, additions: 0, dels: 0, files: 0 }, interventions: null, repos: [{ name: "open-octopus", expired: true, reason: "no_commits", commits: 0, additions: 0, dels: 0, files: 0, truncated: false, groups: [] }] })
    renderModal()
    expect(await screen.findByTestId("round-diff-expired")).toBeTruthy()
  })
})

describe("验货台 v2 — 当场复检", () => {
  it("未配置命令 → 编辑器入口存在、▶ 不可见；保存走 spec-field(user)", async () => {
    renderModal() // V4_SPEC 无 acceptance_verify
    expect(await screen.findByText("未预设复检命令")).toBeTruthy()
    fireEvent.click(screen.getByTestId("verify-edit"))
    fireEvent.change(screen.getByTestId("verify-command-input"), { target: { value: "pnpm build && pnpm test" } })
    mockUpdateSpecField.mockResolvedValue({ version: 5 })
    fireEvent.click(screen.getByTestId("verify-save"))
    await waitFor(() => expect(mockUpdateSpecField).toHaveBeenCalledWith(
      "t1", "acceptance_verify",
      { command: "pnpm build && pnpm test", timeoutS: 600 },
      { source: "user" },
    ))
    expect(screen.queryByTestId("verify-editor")).toBeNull() // 成功即收
  })

  it("VP1 多仓：per_repo 配置 → 「逐仓」徽章 + 命令注记；编辑预勾且 cwd 禁用（被忽略）", async () => {
    renderModal({ ...(V4_SPEC as object), acceptance_verify: { command: "mvn -B test", per_repo: true, timeoutS: 900 } } as unknown as TaskSpec)
    expect(await screen.findByTestId("verify-per-repo")).toBeTruthy()
    expect(screen.getByTestId("verify-panel").textContent).toContain("逐仓各跑一次")
    fireEvent.click(screen.getByTestId("verify-edit"))
    const cb = screen.getByTestId("verify-per-repo-input") as HTMLInputElement
    expect(cb.checked).toBe(true)
    expect((screen.getByTestId("verify-cwd-input") as HTMLInputElement).disabled).toBe(true)
  })

  it("VP2 勾「逐仓」保存 → spec-field 载荷带 per_repo:true 且不带 cwd；回显不再抹掉", async () => {
    renderModal() // 无 verify 起步
    await screen.findByText("未预设复检命令")
    fireEvent.click(screen.getByTestId("verify-edit"))
    fireEvent.change(screen.getByTestId("verify-command-input"), { target: { value: "mvn -B test" } })
    fireEvent.click(screen.getByTestId("verify-per-repo-input"))
    mockUpdateSpecField.mockResolvedValue({ version: 6 })
    fireEvent.click(screen.getByTestId("verify-save"))
    await waitFor(() => expect(mockUpdateSpecField).toHaveBeenCalledWith(
      "t1", "acceptance_verify",
      { command: "mvn -B test", per_repo: true, timeoutS: 600 },
      { source: "user" },
    ))
  })

  it("已配置 → ▶复检 startVerify + SSE log 进控制台 + 终态事件盖章 PASSED", async () => {
    renderModal(V4_SPEC_VERIFY)
    const runBtn = await screen.findByTestId("verify-run")
    fireEvent.click(runBtn)
    await waitFor(() => expect(mockStartVerify).toHaveBeenCalledWith("t1"))
    // 逐行事件（stderr 带前缀）→ 控制台
    await waitFor(() => expect(sseHandlers.has(TASK_VERIFY_LOG_EVENT)).toBe(true))
    fireSse(TASK_VERIFY_LOG_EVENT, { task_id: "t1", line: "building…", stream: "stdout" })
    fireSse(TASK_VERIFY_LOG_EVENT, { task_id: "t1", line: "nope", stream: "stderr" })
    // （原写法 expect(await …).textContent 把属性访问落在 Chai Assertion 上 → Invalid Chai property）
    const vConsole = await screen.findByTestId("verify-console")
    await waitFor(() => expect(vConsole.textContent).toContain("[stderr] nope"))
    // 终态 → 盖章
    fireSse(TASK_VERIFY_EVENT, { task_id: "t1", state: "passed", exit_code: 0, duration_ms: 1500, verdict_path: `${BATCH_DIR}/verify-r1-x.md` })
    const stamp = await screen.findByTestId("verify-stamp")
    expect(stamp.textContent).toContain("PASSED")
    expect(stamp.getAttribute("data-state")).toBe("passed")
  })

  it("启动被拒（409 复检进行中）→ toast，不崩", async () => {
    mockStartVerify.mockRejectedValue(new TaskApiError("复检进行中 — 中止或等它跑完", 409))
    renderModal(V4_SPEC_VERIFY)
    fireEvent.click(await screen.findByTestId("verify-run"))
    await waitFor(() => expect(mockStartVerify).toHaveBeenCalled())
    const { toast } = await import("sonner")
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("复检进行中"))
  })
})

describe("验货台 v2 — 核对 tab（票×声称×实物 三方对账）", () => {
  it("懒拉 spec.md；矩阵行锚定/无锚定按 diff 真实路径判定", async () => {
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-tab-matrix"))
    await waitFor(() => expect(mockGetHomeFile).toHaveBeenCalledWith("t1", `${BATCH_DIR}/spec.md`))
    const matrix = await screen.findByTestId("ac-matrix")
    expect(matrix.textContent).toContain("1/2") // 票01 锚定 usage-writer.ts；票02 ghost-file.ts 无实物
    expect(document.querySelector('[data-acceptance-matrix-row="01"]')?.textContent).toContain("有实物")
    expect(document.querySelector('[data-acceptance-matrix-row="02"]')?.textContent).toContain("说了没锚")
  })

  it("diff 不可得 → 判定列全「存疑」+ 警示行", async () => {
    mockGetRoundDiff.mockResolvedValue({ available: false, reason: "no_commits", aggregate: { commits: 0, additions: 0, dels: 0, files: 0 }, interventions: null, repos: [] })
    renderModal()
    fireEvent.click(await screen.findByTestId("acceptance-tab-matrix"))
    expect(await screen.findByTestId("ac-matrix-diff-missing")).toBeTruthy()
  })
})

describe("AcceptanceSurface — 叙述 tab（v1 批次直读整体降级收容）", () => {
  it("specPath 定位批次目录 all=1 直读；行渲染 + 内嵌 round-report + 本轮徽章 + 不可预览门", async () => {
    renderModal()
    // 列表拉取不依赖 tab（matrix/叙述共用 files state）
    await waitFor(() => expect(mockListHomeDir).toHaveBeenCalledWith("t1", BATCH_DIR, { all: true }))
    await openStoryTab()
    // 定位 = dirname(specPath)（posix 归一后），all=1 收全文件
    expect(await screen.findByTestId("acceptance-artifact-rows")).toBeTruthy()
    expect(rowByPath(`${BATCH_DIR}/spec.md`)).toBeTruthy()
    expect(rowByPath(`${BATCH_DIR}/e2e-data/state.db`)).toBeTruthy() // .db 可见（证据存在性）
    expect(screen.queryByTestId("acceptance-batch-empty")).toBeNull()

    // 内嵌轮次报告：round-report.md 存在 → 卡片渲染 markdown（MarkdownPreview 桩）
    const report = await screen.findByTestId("acceptance-round-report")
    expect(report.textContent).toContain("票执行摘要")
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
    fireEvent.click(rowByPath(`${BATCH_DIR}/e2e-data/run.txt`)!)
    await waitFor(() => expect(mockGetHomeFile).toHaveBeenCalledWith("t1", `${BATCH_DIR}/e2e-data/run.txt`))
    await waitFor(() => expect(document.querySelector("[data-artifact-content]")).toBeTruthy())
    expect(document.querySelector("[data-artifact-content]")!.textContent).toContain("# spec body")
  })
})

describe("AcceptanceSurface — 中列状态面（404 空态 / 错误行 / 回退定位 / idle）", () => {
  it("批次目录 404（collect 前未落盘）→ 叙述 tab 空态卡，不显错误", async () => {
    mockListHomeDir.mockRejectedValue(new TaskApiError("batch dir not found", 404))
    renderModal()
    await openStoryTab()
    expect(await screen.findByTestId("acceptance-batch-empty")).toBeTruthy()
    expect(screen.queryByTestId("acceptance-batch-error")).toBeNull()
  })

  it("列表非 404 失败（server 未更新的 403 / 网络）→ 一行显式错误", async () => {
    mockListHomeDir.mockRejectedValue(new TaskApiError("path not whitelisted", 403))
    renderModal()
    await openStoryTab()
    const err = await screen.findByTestId("acceptance-batch-error")
    expect(err.textContent).toContain("path not whitelisted")
  })

  it("绝对 specPath（gateV4 旁路直写）→ getBatchTree 按 slug 回退取最新 dir", async () => {
    mockGetBatchTree.mockResolvedValue([
      { dir: ".scratch/20260901/scaffold-1", slug: "scaffold-1", files: [], latest_mtime: "2026-09-01T00:00:00Z" },
      { dir: ".scratch/20260903/scaffold-1", slug: "scaffold-1", files: [], latest_mtime: "2026-09-03T00:00:00Z" },
      { dir: ".scratch/20260903/other-9", slug: "other-9", files: [], latest_mtime: "2026-09-04T00:00:00Z" },
    ])
    renderModalWith(PHASE1_AWAITING, V4_SPEC_ABS)
    await waitFor(() => expect(mockGetBatchTree).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(mockListHomeDir).toHaveBeenCalledWith("t1", ".scratch/20260903/scaffold-1", { all: true }))
  })

  it("回退扫描无命中 → 仍落空态（绝不无限转圈）", async () => {
    renderModalWith(PHASE1_AWAITING, V4_SPEC_ABS)
    mockGetBatchTree.mockResolvedValue([])
    await openStoryTab()
    expect(await screen.findByTestId("acceptance-batch-empty")).toBeTruthy()
  })

  it("无待验收 round → idle 提示，不拉批次列表", async () => {
    renderModalWith(NO_AWAITING)
    expect(await screen.findByTestId("acceptance-batch-idle")).toBeTruthy()
    expect(mockListHomeDir).not.toHaveBeenCalled()
  })
})

describe("AcceptanceSurface — AC2 打回反馈必填 + 提交链（ADR-0018 二分路由）", () => {
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

  it("accepted 提交：先开台账确认弹层，ledger-confirm 才 postAcceptance；409 → 刷新盘面", async () => {
    renderModal()
    mockPostAcceptance
      .mockRejectedValueOnce(new TaskApiError("phase 1 当前派生态 running（无待验收轮），与请求 round 1 不匹配", 409))
      .mockResolvedValueOnce({
        task: makeDetail(PHASE1_AWAITING), acceptance_id: "a-2", next_action: "awaiting_manual_trigger",
      })
    // 第一步：点通过 = 只开台账弹层，还没提交
    fireEvent.click(await screen.findByTestId("acceptance-approve"))
    const ledger = await screen.findByTestId("ledger-dialog")
    expect(ledger).toBeTruthy()
    expect(mockPostAcceptance).not.toHaveBeenCalled()
    // 第二步：确认 → 才 postAcceptance(accepted)
    fireEvent.click(screen.getByTestId("ledger-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledWith("t1", {
      phase_index: 1, round_index: 1, decision: "accepted",
    }))
    // 409 分支：重拉 GET /:id（初次开窗 1 次 + 409 刷新 1 次）
    await waitFor(() => expect(mockGetTask.mock.calls.length).toBeGreaterThanOrEqual(2))
    // 第二次：通过 → 台账 → 确认 → awaiting_manual_trigger 成功
    fireEvent.click(screen.getByTestId("acceptance-approve"))
    fireEvent.click(await screen.findByTestId("ledger-confirm"))
    await waitFor(() => expect(mockPostAcceptance).toHaveBeenCalledTimes(2))
  })
})

describe("AcceptanceSurface — 票 04 前序交接提示行（phase-handoff-chaining K6）", () => {
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

// ── PB: 剧本探针就地执行 + 全展开/收起 (v2.2, 用户反馈 2026-09-19) ──────
const PB_PLAYBOOK = {
  available: true, goal: "g", specRevised: false,
  budget: { steps: 2, estMin: 3, over: false, degraded: false },
  sections: [{ kind: "probe" as const, title: "03-e2e", source: "issues/03-e2e.md", items: [
    { id: "probe:03-e2e:1", op: "执行真值探针", expect: "data == true", probe: { command: "curl -sf localhost:18082/demo/luhn?no=x" } },
    { id: "probe:03-e2e:2", op: "执行假值探针", expect: "data == false", probe: { command: "curl -sf localhost:18082/demo/luhn?no=y" } },
  ] }],
  finePrint: [], carryover: [], coverage: { found: ["issues/03-e2e.md"], missing: [] },
}

describe("PB — 剧本探针执行与展开", () => {
  it("PB1: probe 步有 [▶执行]；exit 0 → 自动✓ + 🔬note + EXIT 章 + probe 持久化", async () => {
    mockGetPlaybook.mockResolvedValue(PB_PLAYBOOK)
    renderModal()
    await screen.findByTestId("playbook-panel")
    expect(screen.getByTestId("probe-run-probe:03-e2e:1")).toBeTruthy()
    fireEvent.click(screen.getByTestId("probe-run-probe:03-e2e:1"))
    await waitFor(() => expect(mockRunProbe).toHaveBeenCalledWith("t1", "curl -sf localhost:18082/demo/luhn?no=x"))
    expect(screen.getByTestId("probe-stamp-probe:03-e2e:1").textContent).toContain("EXIT 0")
    await new Promise((r) => setTimeout(r, 450))
    const payload = mockSaveChecks.mock.calls.at(-1)?.[3] as Record<string, { decision: string; note: string; probe?: unknown }>
    expect(payload["probe:03-e2e:1"].decision).toBe("pass")
    expect(payload["probe:03-e2e:1"].note).toContain("🔬 探针 exit 0")
    expect(payload["probe:03-e2e:1"].probe).toMatchObject({ state: "passed", exit_code: 0 })
  })

  it("PB2: exit≠0 → 自动✗（硬闸拦通过）+ 现象行进备注；人工改判 ✓ 可放行", async () => {
    mockGetPlaybook.mockResolvedValue(PB_PLAYBOOK)
    mockRunProbe.mockResolvedValueOnce({ state: "failed", exit_code: 22, duration_ms: 300, tail: ["[stderr] curl: (22) The requested URL returned error: 500"] })
    renderModal()
    await screen.findByTestId("playbook-panel")
    fireEvent.click(screen.getByTestId("probe-run-probe:03-e2e:2"))
    await new Promise((r) => setTimeout(r, 450))
    const payload = mockSaveChecks.mock.calls.at(-1)?.[3] as Record<string, { decision: string; note: string }>
    expect(payload["probe:03-e2e:2"].decision).toBe("fail")
    expect(payload["probe:03-e2e:2"].note).toContain("exit 22")
    expect(payload["probe:03-e2e:2"].note).toContain("curl: (22)")
    await waitFor(() => expect((screen.getByTestId("acceptance-approve") as HTMLButtonElement).disabled).toBe(true))
    // 人工改判：✗→✓ 解除硬闸（机器章可被人的最终判断覆盖）
    fireEvent.click(screen.getAllByTestId("step-probe:03-e2e:2").at(-1)!.querySelector("[data-testid=decide-pass]")!)
    await waitFor(() => expect((screen.getByTestId("acceptance-approve") as HTMLButtonElement).disabled).toBe(false))
  })

  it("PB3: 收起全部 → 预期明细隐藏但勾选可用；再展开回原样", async () => {
    mockGetPlaybook.mockResolvedValue({
      available: true, goal: "g", specRevised: false,
      budget: { steps: 1, estMin: 2, over: false, degraded: false },
      sections: [{ kind: "probe" as const, title: "T", source: "s", items: [
        { id: "probe:01:1", op: "打开页面", expect: "剧本明细只在展开时可见", probe: { command: "true" } }] }],
      finePrint: [], carryover: [], coverage: { found: [], missing: [] },
    })
    renderModal()
    const panel = await screen.findByTestId("playbook-panel")
    expect(panel.textContent).toContain("剧本明细只在展开时可见")
    fireEvent.click(screen.getByTestId("playbook-toggle-all"))
    await waitFor(() => expect(screen.getByTestId("playbook-toggle-all").textContent).toBe("展开全部"))
    expect(panel.textContent).not.toContain("剧本明细只在展开时可见")
    expect(panel.textContent).toContain("打开页面") // 标题仍在
    expect(screen.getByTestId("decide-pass")).toBeTruthy() // 收起态照样能勾
    fireEvent.click(screen.getByTestId("playbook-toggle-all"))
    await waitFor(() => expect(panel.textContent).toContain("剧本明细只在展开时可见"))
  })
})
