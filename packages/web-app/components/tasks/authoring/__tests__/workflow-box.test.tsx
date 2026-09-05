import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowBox } from "../workflow-box"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { updateTask, getTask } from "@/lib/tasks-api"
import {
  listBuiltInWorkflows,
  getBuiltInWorkflowDetail,
  type BuiltInWorkflowSummary,
} from "@/lib/workflow-presets-api"

// jsdom lacks ResizeObserver; user.click focuses elements which mounts the
// Radix ScrollArea observer inside the binding dialog.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// Mock the API modules
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
    updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 2 }),
    getTask: vi.fn(),
    // PhaseSpecDialog（home-file 审阅/编辑面）依赖 — 本文件只测列表，弹窗
    // 自身的用例在 phase-spec-dialog.test.tsx。
    getHomeFile: vi.fn().mockRejectedValue(new TaskApiError("not found", 404)),
    putHomeFile: vi.fn().mockResolvedValue({ path: "", bytes: 0 }),
    TaskApiError,
  }
})

vi.mock("@/lib/workflow-presets-api", () => ({
  listBuiltInWorkflows: vi.fn().mockResolvedValue([]),
  getBuiltInWorkflowDetail: vi.fn().mockResolvedValue({
    ref: "built-in/test-flow",
    content: "",
    parsed: { name: "Test Flow", inputs: {} },
  }),
}))

vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Omit 掉 task_spec 再单独收 Partial —— 否则 Partial<Task> 的 task_spec?:
// TaskSpec 与交集里的 Partial<TaskSpec> 互斥（完整 TaskSpec 才可赋值）。
function makeTask(overrides: Omit<Partial<Task>, "task_spec"> & { task_spec?: Partial<TaskSpec> } = {}): Task {
  const spec: TaskSpec = {
    goal: "Test goal",
    ac: ["ac1"],
    resources: [],
    authoring_resources: [],
    skill_groups: [],
    decisions: [],
    ac_confirmed: [],
    ...(overrides.task_spec ?? {}),
  } as TaskSpec
  return {
    id: "test-task",
    org: "test",
    name: "Test Task",
    status: "draft",
    task_spec: spec,
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    version: 1,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task
}

function makePhase(i: number, overrides: Partial<TaskPhase> = {}): TaskPhase {
  return {
    index: i,
    name: `阶段${i}`,
    slug: `slug-${i}`,
    specPath: `./.scratch/20260903/slug-${i}/spec.md`,
    workflowRef: "built-in/task-dev",
    inputValues: {},
    ...overrides,
  } as TaskPhase
}

function v4Task(phases: TaskPhase[], status: Task["status"] = "draft"): Task {
  return makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec, status })
}

const TASK_DEV: BuiltInWorkflowSummary = {
  ref: "built-in/task-dev",
  name: "Task Dev",
  group: "built-in",
  inputs: {
    idea: { description: "想法", required: true },
    max_turns: { description: "模型往返步数上限", required: false, default: "200" },
  },
}
const TASK_FIX: BuiltInWorkflowSummary = {
  ref: "built-in/task-fix",
  name: "Task Fix",
  group: "built-in",
  inputs: { feedback_path: { description: "反馈文件", required: true } },
}

function mockCatalog() {
  vi.mocked(listBuiltInWorkflows).mockResolvedValue([TASK_DEV, TASK_FIX])
  vi.mocked(getBuiltInWorkflowDetail).mockResolvedValue({
    ref: "any", content: "name: x\nnodes: []\n", parsed: { name: "x", inputs: {} },
  })
  vi.mocked(getTask).mockResolvedValue(makeTask({ version: 9 }) as never)
  vi.mocked(updateTask).mockResolvedValue({ id: "test-task", version: 10 } as never)
}

// Radix Dialog portals content to document.body — query the document.
function q(sel: string): HTMLElement | null {
  return document.querySelector(sel)
}
function inputEl(name: string): HTMLInputElement | null {
  return document.querySelector(`[data-input-field="${name}"]`)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("WorkflowBox — v4 PhaseListEditor 渲染（票 12 D + 契约修复改版）", () => {
  it("renders one card per phase with its workflow_ref / 未绑定 marker", () => {
    render(
      <WorkflowBox
        task={v4Task([
          makePhase(1),
          makePhase(2, { workflowRef: "" as TaskPhase["workflowRef"] }),
        ])}
        onMutated={() => {}}
      />,
    )
    expect(q("[data-phase-binding-list]")).toBeTruthy()
    expect(q('[data-phase-bind-card="1"]')).toBeTruthy()
    expect(q('[data-phase-bind-card="2"]')).toBeTruthy()
    expect(q('[data-phase-workflow-ref="1"]')!.textContent).toBe("built-in/task-dev")
    expect(q('[data-phase-unbound="2"]')).toBeTruthy()
  })

  it("empty phases → empty state + 仅 draft 的添加表单在场", async () => {
    mockCatalog()
    render(<WorkflowBox task={v4Task([])} onMutated={() => {}} />)
    expect(q("[data-phase-bind-empty]")).toBeTruthy()
    await waitFor(() => expect(q("[data-phase-add-form]")).toBeTruthy())
  })

  it("ready 任务：只读 + 换绑定仍在，但无添加表单/删除/移动（结构编辑窗关闭）", async () => {
    mockCatalog()
    render(<WorkflowBox task={v4Task([makePhase(1), makePhase(2)], "ready")} onMutated={() => {}} />)
    await waitFor(() => expect(q('[data-phase-bind-button="1"]')).toBeTruthy())
    expect(q("[data-phase-add-form]")).toBeNull()
    expect(q('[data-phase-delete-button="1"]')).toBeNull()
    expect(q('[data-phase-move-up="2"]')).toBeNull()
    // 换绑定仍可用
    expect(q('[data-phase-bind-button="1"]')).toBeTruthy()
  })
})

describe("WorkflowBox — 绑定弹窗（v4-phase，S2/S5/AC-20 纪律保持）", () => {
  it("S2/AC4: dialog open fetches the built-in list EXACTLY once; selections + search do not refetch", async () => {
    const user = userEvent.setup()
    mockCatalog()
    // AddPhaseRow（draft 常驻）挂载时自取一次目录做 workflow 下拉 — AC-20 的
    // 「开窗恰一次」以开窗时刻为基线计增量。
    const baseCount = vi.mocked(listBuiltInWorkflows).mock.calls.length
    const { rerender } = render(<WorkflowBox task={v4Task([makePhase(1, { workflowRef: "" as TaskPhase["workflowRef"] })])} onMutated={() => {}} />)
    await waitFor(() => expect(vi.mocked(listBuiltInWorkflows).mock.calls.length).toBe(baseCount + 1))
    await user.click(q('[data-phase-bind-button="1"]')!)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    const opened = vi.mocked(listBuiltInWorkflows).mock.calls.length
    expect(opened - baseCount).toBe(2) // 一次=AddPhaseRow 挂载取下拉数据，一次=开窗目录

    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.click(q('[data-workflow-item="built-in/task-fix"]')!)
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy()
    expect(vi.mocked(listBuiltInWorkflows).mock.calls.length).toBe(opened)

    await user.type(q("[data-binding-search]")!, "fix")
    expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy()
    expect(q('[data-workflow-item="built-in/task-dev"]')).toBeNull()
    expect(vi.mocked(listBuiltInWorkflows).mock.calls.length).toBe(opened)

    rerender(<WorkflowBox task={v4Task([makePhase(1)], "draft")} onMutated={() => {}} />)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy())
    expect(vi.mocked(listBuiltInWorkflows).mock.calls.length).toBe(opened)
  })

  it("inputs form renders from the catalog summary (default shown, untouched default not persisted)", async () => {
    const user = userEvent.setup()
    mockCatalog()
    render(<WorkflowBox task={v4Task([makePhase(1)])} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="1"]')!)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)

    await waitFor(() => expect(inputEl("max_turns")).toBeTruthy())
    expect(inputEl("max_turns")!.value).toBe("200") // YAML default shown
    expect(inputEl("idea")!.value).toBe("")

    await user.type(inputEl("idea")!, "hello")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())

    const [, input] = vi.mocked(updateTask).mock.calls[0]
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent[0].inputValues).toEqual({ idea: "hello" }) // 未触碰 default 不落库
    expect(input.workflow_ref).toBeUndefined() // v4 不碰任务级 workflow_ref
  })

  it("phase binding writes the WHOLE phases array via PUT (target replaced, others verbatim)", async () => {
    const user = userEvent.setup()
    const phases = [makePhase(1), makePhase(2, { workflowRef: "" as TaskPhase["workflowRef"], inputValues: {} })]
    const task = v4Task(phases)
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never)

    render(<WorkflowBox task={task} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="2"]')!)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-fix"]')!)
    await user.type(inputEl("feedback_path")!, "./.scratch/20260903/slug-1/fix-feedback-r1.md")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())

    const [, input] = vi.mocked(updateTask).mock.calls[0]
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(phases[0]) // 未动的 phase1 verbatim
    expect(sent[1].index).toBe(2)
    expect(sent[1].workflowRef).toBe("built-in/task-fix")
    expect(sent[1].inputValues).toEqual({
      feedback_path: "./.scratch/20260903/slug-1/fix-feedback-r1.md",
    })
    expect(input.workflow_ref).toBeUndefined()
  })

  it("re-opens with the phase's current binding prefilled (更换工作流 keeps values)", async () => {
    const user = userEvent.setup()
    const phases = [makePhase(1, { inputValues: { idea: "keep me" } })]
    mockCatalog()
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="1"]')!)
    await waitFor(() => expect(inputEl("idea")).toBeTruthy())
    expect(inputEl("idea")!.value).toBe("keep me")
  })

  it("S5 (v4): save uses the re-fetched version even when task_spec gained a phase meanwhile", async () => {
    const user = userEvent.setup()
    const stale = [makePhase(1)]
    const freshPhases = [makePhase(1), makePhase(2, { workflowRef: "" as TaskPhase["workflowRef"] })]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ version: 7, task_spec: { format: "v4", phases: freshPhases } }) as never,
    )
    render(<WorkflowBox task={v4Task(stale)} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="1"]')!)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.type(inputEl("idea")!, "x")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())

    const [, input, version] = vi.mocked(updateTask).mock.calls[0]
    expect(version).toBe(7)
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent).toHaveLength(2) // fresh array wins — 新 phase2 不被旧快照覆盖
    expect(sent[1].index).toBe(2)
  })

  it("save failure surfaces a toast (no silent swallow)", async () => {
    const { toast } = await import("sonner")
    const user = userEvent.setup()
    mockCatalog()
    vi.mocked(updateTask).mockRejectedValueOnce(new Error("Task version conflict (stale write)"))
    render(<WorkflowBox task={v4Task([makePhase(1)])} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="1"]')!)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.type(inputEl("idea")!, "x")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("绑定失败: Task version conflict (stale write)"),
    )
  })
})

describe("WorkflowBox — 结构编辑（契约修复：增/删/移/改，仅 draft，整数组 PUT + 重取 version）", () => {
  it("add phase: name+auto-slug+目录首个 workflow → PUT 追加并位次重排，specPath 走 ./.scratch/<date>/<slug>/spec.md 约定", async () => {
    const user = userEvent.setup()
    const phases = [makePhase(1)]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ version: 5, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never,
    )
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
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
    expect(sent[1].workflowRef).toBe("built-in/task-dev") // 目录默认（matt-dev-pipeline 不在 mock 目录 → 首项）
    expect(sent[1].inputValues).toEqual({})
    expect(sent[1].specPath).toMatch(/^\.\/\.scratch\/\d{8}\/wrap-up\/spec\.md$/)
    expect(sent.map((p) => p.index)).toEqual([1, 2])
  })

  it("add phase: slug 重名 → 报错不写回", async () => {
    const user = userEvent.setup()
    const phases = [makePhase(1)]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never,
    )
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    await waitFor(() => expect(q("[data-phase-add-form]")).toBeTruthy())
    await user.type(q("[data-phase-add-name]")!, "dup")
    fireEventChange(q("[data-phase-add-slug]")!, "slug-1")
    fireEventClick(q("[data-phase-add-submit]")!)
    await waitFor(() => expect(q('[data-phase-bind-card="1"]')).toBeTruthy())
    // 重名检查发生在 fresh 数组上：没有 updateTask 调用（或调用失败被 toast）
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })

  it("move down: phase1↔2 位次交换 + index 重排 + fresh version PUT", async () => {
    const phases = [makePhase(1), makePhase(2)]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ version: 3, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never,
    )
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    fireEventClick(q('[data-phase-move-down="1"]')!)
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [, input, version] = vi.mocked(updateTask).mock.calls[0]
    expect(version).toBe(3)
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent.map((p) => p.slug)).toEqual(["slug-2", "slug-1"])
    expect(sent.map((p) => p.index)).toEqual([1, 2]) // renumber 按位次
  })

  it("delete: 确认弹窗 → 过滤 + 重排", async () => {
    const phases = [makePhase(1), makePhase(2)]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never,
    )
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    expect(q('[data-phase-delete-button="1"]')).toBeTruthy()

    fireEventClick(q('[data-phase-delete-button="2"]')!)
    // AlertDialog 二次确认
    const confirm = await waitFor(() => screen.getByText("确认删除"))
    fireEventClick(confirm)
    await waitFor(() => expect(updateTask).toHaveBeenCalledOnce())
    const [, input] = vi.mocked(updateTask).mock.calls[0]
    const sent = (input.task_spec as TaskSpec).phases!
    expect(sent).toHaveLength(1)
    expect(sent[0].slug).toBe("slug-1")
  })

  it("单 phase 行 delete 禁用（schema phases≥1 底线）", async () => {
    mockCatalog()
    render(<WorkflowBox task={v4Task([makePhase(1)])} onMutated={() => {}} />)
    await waitFor(() => expect(q('[data-phase-delete-button="1"]')).toBeTruthy())
    expect((q('[data-phase-delete-button="1"]') as unknown as HTMLButtonElement).disabled).toBe(true)
  })

  it("inline edit name/slug/specPath → fresh 基底上替换目标行、其余 verbatim", async () => {
    const phases = [makePhase(1), makePhase(2)]
    mockCatalog()
    vi.mocked(getTask).mockResolvedValue(
      makeTask({ version: 8, task_spec: { format: "v4", phases } as unknown as TaskSpec }) as never,
    )
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    fireEventClick(q('[data-phase-edit-button="1"]')!)
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
    expect(sent[1]).toEqual(phases[1]) // phase2 verbatim
  })

  it("每行有 spec.md 审阅入口（open PhaseSpecDialog）", async () => {
    mockCatalog()
    render(<WorkflowBox task={v4Task([makePhase(1)])} onMutated={() => {}} />)
    expect(q('[data-phase-spec-button="1"]')).toBeTruthy()
  })
})

// 轻量事件助手（避免 userEvent.type 对受控 React input 的逐字符开销）。
function fireEventChange(el: Element | null, value: string) {
  if (!el) throw new Error("missing element for change")
  fireEvent.change(el, { target: { value } })
}
function fireEventClick(el: Element | null) {
  if (!el) throw new Error("missing element for click")
  fireEvent.click(el)
}
