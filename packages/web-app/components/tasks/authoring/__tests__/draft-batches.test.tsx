// #53 票 02 — 「草稿批次」直扫区：渲染/对位/展开/弹窗复用/建骨架/三态。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DraftBatches } from "../draft-batches"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import type { BatchTreeEntry } from "@/lib/tasks-api"
import { getHomeFile, updateTask, getTask, listHomeDir, TaskApiError } from "@/lib/tasks-api"
import type { BatchTreeState } from "../use-batch-tree"

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
    getBatchTree: vi.fn().mockResolvedValue([]),
    getHomeFile: vi.fn().mockRejectedValue(new TaskApiError("not found", 404)),
    putHomeFile: vi.fn().mockResolvedValue({ path: "", bytes: 0 }),
    listHomeDir: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 2 }),
    TaskApiError,
  }
})
vi.mock("@/lib/workflow-presets-api", () => ({
  listWorkflowPresets: vi.fn().mockResolvedValue({ presets: [] }),
  listBuiltInWorkflows: vi.fn().mockResolvedValue([]),
  getBuiltInWorkflowDetail: vi.fn().mockResolvedValue({ ref: "", content: "", parsed: { name: "", inputs: {} } }),
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function makePhase(i: number, overrides: Partial<TaskPhase> = {}): TaskPhase {
  return {
    index: i, name: `阶段${i}`, slug: `slug-${i}`,
    specPath: `./.scratch/20260101/slug-${i}/spec.md`,
    workflowRef: "built-in/matt-spec-dev", inputValues: {},
    ...overrides,
  } as TaskPhase
}
function makeTask(phases: TaskPhase[], status: Task["status"] = "draft"): Task {
  return {
    id: "test-task", org: "t", name: "T", status, version: 1,
    task_spec: { format: "v4", phases, resources: [], authoring_resources: [], skill_groups: [], decisions: [], ac_confirmed: [] } as unknown as TaskSpec,
    resources: [], authoring_resources: [], skills: [], project_ids: [],
    deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  } as Task
}
const f = (p: string, mtime = "2026-01-01T00:00:00.000Z") => ({ path: p, mtime, bytes: 100 })
function batch(slug: string, files: BatchTreeEntry["files"], date = "20260101"): BatchTreeEntry {
  const latest = files.reduce((m, x) => (x.mtime > m ? x.mtime : m), "")
  return { dir: `.scratch/${date}/${slug}`, slug, files, latest_mtime: latest }
}
function state(batches: BatchTreeEntry[], over: Partial<BatchTreeState> = {}): BatchTreeState {
  return { batches, loading: false, error: null, refresh: vi.fn(), ...over }
}

function renderDB(tree: BatchTreeState, phases: TaskPhase[], status: Task["status"] = "draft") {
  const onMutated = vi.fn()
  render(
    <DraftBatches task={makeTask(phases, status)} phases={phases} isDraft={status === "draft"} tree={tree} onMutated={onMutated} />,
  )
  return { onMutated }
}

const q = (s: string) => document.querySelector(s)

beforeEach(() => {
  vi.clearAllMocks()
  // 逐用例显式铺实现，杜绝 mockResolvedValue 跨用例泄漏
  vi.mocked(getHomeFile).mockRejectedValue(new TaskApiError("not found", 404))
  vi.mocked(listHomeDir).mockResolvedValue([])
  vi.mocked(getTask).mockResolvedValue(makeTask([]) as never)
  vi.mocked(updateTask).mockResolvedValue({ id: "test-task", version: 2 } as never)
})

describe("DraftBatches — 渲染与对位 (AC1)", () => {
  it("批次行：spec✓/✗ · 票×N · ● 对位 / ○ 未对位 + 未落盘警示行", () => {
    const tree = state([
      batch("slug-1", [f(".scratch/20260101/slug-1/spec.md"), f(".scratch/20260101/slug-1/issues/01-a.md"), f(".scratch/20260101/slug-1/issues/02-e2e.md")]),
      batch("orphan", [f(".scratch/20260101/orphan/issues/01-x.md")]),
    ])
    // phase2 的 spec.md 不在 tree → 未落盘警示；phase1 命中 → slug-1 ● P1
    const phases = [makePhase(1), makePhase(2, { slug: "slug-2", specPath: "./.scratch/20260101/slug-2/spec.md" })]
    renderDB(tree, phases)
    expect(q('[data-batch-row="slug-1"]')).toBeTruthy()
    expect(q('[data-batch-matched="slug-1"]')!.textContent).toBe("● P1")
    expect(q('[data-batch-row="orphan"]')).toBeTruthy()
    expect(q('[data-batch-adopt="orphan"]')).toBeTruthy() // draft 态给建骨架钮
    expect(q('[data-batch-orphans]')!.textContent).toContain("P2")
  })

  it("ready 态：未对位只显 ○ 标签，不给建骨架钮", () => {
    const tree = state([batch("x", [f(".scratch/20260101/x/spec.md")])])
    renderDB(tree, [makePhase(1)], "ready")
    expect(q('[data-batch-adopt="x"]')).toBeNull()
    expect(q('[data-batch-unmatched="x"]')).toBeTruthy()
  })
})

describe("DraftBatches — 展开与弹窗复用 (AC2)", () => {
  it("▾ 展开出文件 chips（spec 族在前）；点文件开 PhaseSpecDialog 且打到该文件", async () => {
    const user = userEvent.setup()
    const tree = state([batch("slug-1", [f(".scratch/20260101/slug-1/spec.md"), f(".scratch/20260101/slug-1/issues/01-a.md")])])
    renderDB(tree, [makePhase(1)])
    await user.click(q('[data-batch-toggle="slug-1"]')!)
    await waitFor(() => expect(q('[data-batch-file=".scratch/20260101/slug-1/issues/01-a.md"]')).toBeTruthy())
    vi.mocked(listHomeDir).mockResolvedValue([])
    await user.click(q('[data-batch-file=".scratch/20260101/slug-1/spec.md"]')!)
    // 弹窗（K4 复用）以被点文件为 activeRel 开窗：列目录 + 读文件都打到正确路径
    await waitFor(() =>
      expect(listHomeDir).toHaveBeenCalledWith("test-task", ".scratch/20260101/slug-1"),
    )
    expect(getHomeFile).toHaveBeenCalledWith("test-task", ".scratch/20260101/slug-1/spec.md")
  })
})

describe("DraftBatches — 建骨架并对位 (AC3)", () => {
  it("○ → 读 spec.md 首标题作 name → PUT phases 追加（S5 基底 + 约定字段）", async () => {
    const user = userEvent.setup()
    const tree = state([batch("billing-new", [f(".scratch/20260101/billing-new/spec.md")])])
    const phases = [makePhase(1)]
    vi.mocked(getHomeFile).mockResolvedValueOnce({ path: "x", content: "# 计费报表 MVP\n\n正文\n" } as never)
    vi.mocked(getTask).mockResolvedValue(makeTask(phases) as never)
    renderDB(tree, phases)
    await user.click(q('[data-batch-adopt="billing-new"]')!)
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [, input] = vi.mocked(updateTask).mock.calls[0]
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      name: "计费报表 MVP",
      slug: "billing-new",
      specPath: "./.scratch/20260101/billing-new/spec.md",
      workflowRef: "built-in/matt-spec-dev",
      inputValues: { batch_dir: "${phase.batch_rel}" },
    })
    expect(sent.map((p) => p.index)).toEqual([1, 2])
  })

  it("spec.md 读不到（404）→ slug 兜底仍建行", async () => {
    const user = userEvent.setup()
    // getHomeFile 工厂默认 404 reject（TaskApiError）→ name 回退 slug
    const tree = state([batch("no-spec-yet", [f(".scratch/20260101/no-spec-yet/spec.md")])])
    vi.mocked(getTask).mockResolvedValue(makeTask([makePhase(1)]) as never)
    renderDB(tree, [makePhase(1)])
    await user.click(q('[data-batch-adopt="no-spec-yet"]')!)
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [, input] = vi.mocked(updateTask).mock.calls[0]
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent[1].name).toBe("no-spec-yet")
    expect(sent[1].specPath).toBe("./.scratch/20260101/no-spec-yet/spec.md")
  })

  it("slug 撞车（不同目录同 slug）→ 拒绝不写回 + toast.error", async () => {
    const user = userEvent.setup()
    // 目录 20260102/slug-1 ≠ phase1 的 20260101/slug-1 → 未对位出钮；slug 同名 → 撞车拒写
    const tree = state([batch("slug-1", [f(".scratch/20260102/slug-1/spec.md")], "20260102")])
    renderDB(tree, [makePhase(1)])
    const btn = q('[data-batch-adopt="slug-1"]')
    expect(btn).toBeTruthy() // 前置：未对位按钮在场
    await user.click(btn!)
    await waitFor(async () => {
      const { toast } = await import("sonner")
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining("已存在"))
    })
    expect(updateTask).not.toHaveBeenCalled()
  })
})

describe("DraftBatches — 三态 (AC4)", () => {
  it("loading → spinner；error → 错误行；空且无错 → 「落盘即现」空态", () => {
    const { unmount } = render(<DraftBatches task={makeTask([])} phases={[]} isDraft tree={state([], { loading: true, batches: [] })} onMutated={vi.fn()} />)
    expect(screen.getByText(/扫描批次目录/)).toBeTruthy()
    unmount()
    render(<DraftBatches task={makeTask([])} phases={[]} isDraft tree={state([], { error: "boom", batches: [] })} onMutated={vi.fn()} />)
    expect(screen.getByText("boom")).toBeTruthy()
    expect(q('[data-batch-empty]')).toBeNull() // error 态不叠空态文案
    unmount()
    render(<DraftBatches task={makeTask([])} phases={[]} isDraft tree={state([])} onMutated={vi.fn()} />)
    expect(q('[data-batch-empty]')).toBeTruthy()
  })
})
