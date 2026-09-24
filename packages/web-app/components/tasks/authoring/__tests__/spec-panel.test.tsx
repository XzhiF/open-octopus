// spec-panel.test.tsx — 右栏原型面板（phases 卡 / 入队清单 / 输出区磁盘树 / 缩放弹窗）
// 自 workflow-box.test.tsx 移植核心契约用例（add/edit PUT 纪律、ready 只读、
// 清单钉点），并覆盖原型改版新增行为。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SpecPanel } from "../spec-panel"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { updateTask, getTask, getHomeContent } from "@/lib/tasks-api"
import {
  listBuiltInWorkflows,
  listWorkflowPresets,
  getBuiltInWorkflowDetail,
  type BuiltInWorkflowSummary,
  type WorkflowPreset,
} from "@/lib/workflow-presets-api"
import type { BatchTreeState } from "../use-batch-tree"
import type { HomeTreeState } from "../use-home-tree"

// jsdom 无 EventSource（「▸ 更多」弹窗里的 OutputViewer 订阅 SSE 用）
if (!globalThis.EventSource) {
  globalThis.EventSource = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return false }
    onmessage = null
    onerror = null
    onopen = null
    readyState = 0
    withCredentials = false
    url = ""
  } as unknown as typeof EventSource
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

vi.mock("@/lib/tasks-api", () => {
  class TaskApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "TaskApiError"
      this.status = status
    }
  }
  class ArtifactContentError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "ArtifactContentError"
      this.status = status
    }
  }
  return {
    updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 10 }),
    getTask: vi.fn(),
    getHomeFile: vi.fn().mockImplementation(() => Promise.reject(new TaskApiError("not found", 404))),
    putHomeFile: vi.fn().mockResolvedValue({ path: "", bytes: 0 }),
    listHomeDir: vi.fn().mockResolvedValue([]),
    getBatchTree: vi.fn().mockResolvedValue([]),
    getTaskContext: vi.fn().mockResolvedValue({ context: "", manifest: null }),
    listArtifacts: vi.fn().mockResolvedValue([]),
    getArtifactContent: vi.fn().mockResolvedValue({ path: "reports/a.md", content: "# A\n正文" }),
    getHomeContent: vi.fn().mockResolvedValue({ path: "artifacts/a.md", content: "# A\n磁盘正文" }),
    ArtifactContentError,
    getAssistWorkflowRun: vi.fn().mockResolvedValue({ id: "r1", status: "completed", output: null }),
    updateSpecField: vi.fn().mockResolvedValue({ ok: true }),
    MAX_HOME_FILE_READ_BYTES: 1024 * 1024,
    TaskApiError,
  }
})

vi.mock("@/lib/workflow-presets-api", () => ({
  listWorkflowPresets: vi.fn().mockResolvedValue({ presets: [] }),
  listBuiltInWorkflows: vi.fn().mockResolvedValue([]),
  getBuiltInWorkflowDetail: vi.fn().mockResolvedValue({ ref: "x", content: "", parsed: { name: "x", inputs: {} } }),
}))

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const SPEC_DEV: WorkflowPreset = {
  name: "spec-dev",
  desc: "v4 主打",
  workflow: "built-in/matt-spec-dev",
  inputs: { batch_dir: "${phase.batch_rel}" },
}
const FIXER: WorkflowPreset = { name: "fixer", workflow: "built-in/task-fix", inputs: { feedback_path: "f.md" } }
const SPEC_DEV_DEF: BuiltInWorkflowSummary = {
  ref: "built-in/matt-spec-dev", name: "Matt Spec Dev", group: "built-in",
  inputs: { batch_dir: { description: "批次目录", required: true } },
}

function makeTask(overrides: Omit<Partial<Task>, "task_spec"> & { task_spec?: Partial<TaskSpec> } = {}): Task {
  const spec = {
    goal: "Test goal", ac: ["ac1"], resources: [], authoring_resources: [],
    skill_groups: [], decisions: [], ac_confirmed: [],
    ...(overrides.task_spec ?? {}),
  } as TaskSpec
  return {
    id: "test-task", org: "test", name: "Test Task", status: "draft", task_spec: spec,
    authoring_resources: [], resources: [], skills: [], project_ids: [], version: 1,
    deleted_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task
}

function makePhase(i: number, overrides: Partial<TaskPhase> = {}): TaskPhase {
  return {
    index: i, name: `阶段${i}`, slug: `slug-${i}`,
    specPath: `./.scratch/20260903/slug-${i}/spec.md`,
    workflowRef: "built-in/task-dev", inputValues: {},
    ...overrides,
  } as TaskPhase
}

const emptyTree: BatchTreeState = { batches: [], loading: false, error: null, refresh: () => {} } as BatchTreeState

const emptyHome: HomeTreeState = { dir: "/home/.octopus/tasks/test-task", entries: [], loading: false, error: null, refresh: () => {} }

const allOk = {
  rowPhases: true, rowSpec: true, rowBind: true, rowInputs: true, rowRepos: true,
  rowConfirm: true, rowRunbook: true, specUnknown: false, specMissingIdx: [] as number[],
  absSpecCount: 0, unconfirmedIdx: [] as number[],
  inputsUnknown: false, specTreeReady: false,
}
const noHits: Record<"phases" | "confirm" | "runbook" | "spec" | "bind" | "inputs" | "repos", string[]> = { phases: [], spec: [], bind: [], inputs: [], repos: [], confirm: [], runbook: [] }

function renderPanel(task: Task, rows = allOk, gateHits = noHits, home = emptyHome) {
  return render(
    <SpecPanel task={task} onMutated={() => {}} batchTree={emptyTree} rows={rows} gateHits={gateHits} home={home} />,
  )
}

function mockCatalog() {
  vi.mocked(listWorkflowPresets).mockResolvedValue({ presets: [SPEC_DEV, FIXER] })
  vi.mocked(listBuiltInWorkflows).mockResolvedValue([SPEC_DEV_DEF])
  vi.mocked(getBuiltInWorkflowDetail).mockResolvedValue({ ref: "any", content: "", parsed: { name: "x", inputs: {} } })
  vi.mocked(getTask).mockResolvedValue(makeTask({ version: 9 }) as never)
  vi.mocked(updateTask).mockResolvedValue({ id: "test-task", version: 10 } as never)
}

const q = (sel: string) => document.querySelector(sel)
const fireEventChange = (el: Element | null, value: string) => {
  if (!el) throw new Error("missing element")
  fireEvent.change(el, { target: { value } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SpecPanel — 原型 phases 卡", () => {
  it("每 phase 一张卡：名称 + spec 目录 bullet + 绑定 bullet", () => {
    renderPanel(makeTask({ task_spec: { format: "v4", phases: [makePhase(1), makePhase(2, { workflowRef: "" as TaskPhase["workflowRef"] })] } as unknown as TaskSpec }))
    expect(q('[data-phase-bind-card="1"]')).toBeTruthy()
    expect(q('[data-phase-bind-card="2"]')!.textContent).toContain("未绑定工作流")
    expect(q('[data-phase-bind-card="1"]')!.textContent).toContain("built-in/task-dev")
  })

  it("ready 任务：无「＋ 添加」（结构编辑窗关闭），卡片点击 = 打开 spec 查看", async () => {
    const user = userEvent.setup()
    mockCatalog()
    const t = makeTask({ task_spec: { format: "v4", phases: [makePhase(1)] } as unknown as TaskSpec, status: "ready" })
    renderPanel(t)
    expect(q("[data-phase-add-open]")).toBeNull()
    await user.click(q('[data-phase-bind-card="1"]')!)
    await waitFor(() => expect(q("[data-spec-skeleton-button]")).toBeTruthy())
  })
})

describe("SpecPanel — 添加/编辑（缩放弹窗 + S5 整数组 PUT）", () => {
  it("add: name+auto-slug+目录默认 workflow+骨架预填 → PUT 追加并位次重排", async () => {
    const user = userEvent.setup()
    mockCatalog()
    const phases = [makePhase(1)]
    vi.mocked(getTask).mockResolvedValue(makeTask({ version: 5, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never)
    renderPanel(makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }))
    fireEventClick(q("[data-phase-add-open]")!)
    await waitFor(() => expect(q("[data-phase-add-form]")).toBeTruthy())
    await user.type(q("[data-phase-add-name]")!, "验收收尾")
    fireEventChange(q("[data-phase-add-slug]")!, "wrap-up")
    fireEventClick(q("[data-phase-add-submit]")!)

    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [id, input, version] = vi.mocked(updateTask).mock.calls[0]
    expect(id).toBe("test-task")
    expect(version).toBe(5) // S5 重取
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent).toHaveLength(2)
    expect(sent[1].name).toBe("验收收尾")
    expect(sent[1].slug).toBe("wrap-up")
    expect(sent[1].workflowRef).toBe("built-in/matt-spec-dev")
    expect(sent[1].inputValues).toEqual({ batch_dir: "${phase.batch_rel}" })
    expect(sent[1].specPath).toMatch(/^\.\/\.scratch\/\d{8}\/wrap-up\/spec\.md$/)
    expect(sent.map((p) => p.index)).toEqual([1, 2])
  })

  it("add: slug 重名 → 不写回", async () => {
    const user = userEvent.setup()
    mockCatalog()
    const phases = [makePhase(1)]
    renderPanel(makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }))
    fireEventClick(q("[data-phase-add-open]")!)
    await user.type(q("[data-phase-add-name]")!, "dup")
    fireEventChange(q("[data-phase-add-slug]")!, "slug-1")
    fireEventClick(q("[data-phase-add-submit]")!)
    await waitFor(() => expect(q('[data-phase-bind-card="1"]')).toBeTruthy())
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })

  it("edit: 点卡片开窗 → 改 name/slug/specPath → 目标行替换、其余 verbatim", async () => {
    const user = userEvent.setup()
    mockCatalog()
    const phases = [makePhase(1), makePhase(2)]
    vi.mocked(getTask).mockResolvedValue(makeTask({ version: 8, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never)
    renderPanel(makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }))
    fireEventClick(q('[data-phase-bind-card="1"]')!)
    await waitFor(() => expect(q('[data-phase-name-input="1"]')).toBeTruthy())
    fireEventChange(q('[data-phase-name-input="1"]')!, "改名后的 Phase1")
    fireEventChange(q('[data-phase-slug-input="1"]')!, "renamed-1")
    fireEventChange(q('[data-phase-specpath-input="1"]')!, "./.scratch/20260904/renamed-1/spec.md")
    fireEventClick(q('[data-phase-edit-save="1"]')!)

    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [, input, version] = vi.mocked(updateTask).mock.calls[0]
    expect(version).toBe(8)
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent[0]).toMatchObject({
      index: 1, name: "改名后的 Phase1", slug: "renamed-1",
      specPath: "./.scratch/20260904/renamed-1/spec.md",
    })
    expect(sent[1]).toEqual(phases[1])
    void user
  })

  it("edit: 换绑工作流 → 新目录骨架换上（不跨条目泄漏）", async () => {
    mockCatalog()
    const phases = [makePhase(1, { inputValues: { idea: "旧值" } })]
    vi.mocked(getTask).mockResolvedValue(makeTask({ version: 7, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never)
    renderPanel(makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }))
    fireEventClick(q('[data-phase-bind-card="1"]')!)
    await waitFor(() => expect(q("[data-phase-add-workflow]")).toBeTruthy())
    fireEventChange(q("[data-phase-add-workflow]")!, "built-in/task-fix")
    fireEventClick(q('[data-phase-edit-save="1"]')!)
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const sent = (vi.mocked(updateTask).mock.calls[0][1].task_spec as TaskSpec).phases!
    expect(sent[0].workflowRef).toBe("built-in/task-fix")
    expect(sent[0].inputValues).toEqual({ feedback_path: "f.md" })
  })
})

describe("SpecPanel — 入队清单（原型 .chk 行）", () => {
  it("五行 ✓；gateHits 回填 → 对应行 ✗ + 明细", () => {
    renderPanel(makeTask({ task_spec: { format: "v4", phases: [makePhase(1)] } as unknown as TaskSpec }))
    expect(q("[data-enqueue-checklist]")).toBeTruthy()
    expect(q('[data-checklist-v4="phases"]')!.textContent).toContain("✓")
    renderPanel(
      makeTask({ task_spec: { format: "v4", phases: [] } as unknown as TaskSpec }),
      { ...allOk, rowPhases: false, rowSpec: false },
      { ...noHits, spec: ["Phase 2：批次目录中 spec 文件缺失"] },
    )
    // 第二次渲染的清单：spec 行 ✗ + 明细
    const all = document.querySelectorAll('[data-checklist-v4="spec"]')
    const last = all[all.length - 1]
    expect(last.textContent).toContain("✗")
    expect(last.textContent).toContain("spec 文件缺失")
  })
})

describe("SpecPanel — 输出区任务 home 磁盘直扫树", () => {
  const dir = (p: string) => ({ path: p, type: "dir" as const, bytes: 0, mtime: "2026-09-24T10:00:00Z" })
  const file = (p: string, bytes = 12) => ({ path: p, type: "file" as const, bytes, mtime: "2026-09-24T10:00:00Z" })

  it("头部显示完整路径；空目录占位；有文件 → 树行（目录折叠 + 文件点击开只读弹窗）", async () => {
    const user = userEvent.setup()
    const t = makeTask({ task_spec: { format: "v4", phases: [makePhase(1)] } as unknown as TaskSpec })
    const { unmount } = renderPanel(t)
    expect(q("[data-home-dir]")!.textContent).toContain("/home/.octopus/tasks/test-task")
    expect(q("[data-artifacts-empty]")).toBeTruthy()
    unmount()

    const home: HomeTreeState = {
      dir: "/home/.octopus/tasks/test-task",
      entries: [dir("artifacts/"), dir("artifacts/reports/"), file("artifacts/reports/a.md"), file("context.md"), dir("empty-dir/")],
      loading: false, error: null, refresh: () => {},
    }
    renderPanel(t, allOk, noHits, home)
    expect(q("[data-artifacts-tree]")).toBeTruthy()
    expect(q('[data-artifacts-dir="artifacts/"]')).toBeTruthy()
    expect(q('[data-artifacts-dir="empty-dir/"]')).toBeTruthy() // 空目录如实显示
    expect(q('[data-artifacts-file="context.md"]')).toBeTruthy()
    // 折叠 artifacts/ → 子孙行消失
    fireEventClick(q('[data-artifacts-dir="artifacts/"]')!)
    expect(q('[data-artifacts-file="context.md"]')).toBeTruthy() // 折叠只影响子树
    fireEventClick(q('[data-artifacts-dir="artifacts/"]')!)
    // 点文件 → 只读弹窗读磁盘正文
    await user.click(q('[data-artifacts-file="context.md"]')!)
    await waitFor(() => expect(document.body.textContent).toContain("磁盘正文"))
    expect(getHomeContent).toHaveBeenCalledWith("test-task", "context.md")
  })

  it("error 态显示错误文案，[↻] 走 refresh()", () => {
    let refreshed = 0
    const home: HomeTreeState = { dir: "/x", entries: [], loading: false, error: "disk scan failed", refresh: () => { refreshed++ } }
    renderPanel(makeTask({ task_spec: { format: "v4", phases: [] } as unknown as TaskSpec }), allOk, noHits, home)
    expect(q("[data-artifacts-error]")!.textContent).toContain("disk scan failed")
    fireEventClick(q("[data-artifacts-refresh]")!)
    expect(refreshed).toBe(1)
  })

  it("phase 卡 spec.md bullet 按钮 → spec 编辑器（404 空态骨架按钮），不触发卡片编辑", async () => {
    renderPanel(makeTask({ task_spec: { format: "v4", phases: [makePhase(1)] } as unknown as TaskSpec }))
    fireEventClick(q('[data-phase-spec-button="1"]')!)
    await waitFor(() => expect(q("[data-spec-skeleton-button]")).toBeTruthy())
    expect(q('[data-phase-name-input="1"]')).toBeNull()
  })
})

function fireEventClick(el: Element | null) {
  if (!el) throw new Error("missing element for click")
  fireEvent.click(el)
}
