import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowBox } from "../workflow-box"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { updateTask, getTask, getWorkflowRefView, WorkflowRefViewError } from "@/lib/tasks-api"
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
  class WorkflowRefViewError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "WorkflowRefViewError"
      this.status = status
    }
  }
  return {
    updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 2 }),
    getTask: vi.fn(),
    getWorkflowRefView: vi.fn().mockResolvedValue({ ref: null, content: null, source: null }),
    WorkflowRefViewError,
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

function v4Task(phases: TaskPhase[]): Task {
  return makeTask({ task_spec: { format: "v4", phases } as unknown as TaskSpec })
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
  vi.mocked(getWorkflowRefView).mockResolvedValue({ ref: null, content: null, source: null })
})

describe("WorkflowBox — v3 单卡（票 12 重写：built-in 目录 / preset 退役）", () => {
  it("renders 未绑定 when no workflow_ref", () => {
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(screen.getByText("未绑定")).toBeTruthy()
    expect(screen.getByText("绑定工作流")).toBeTruthy()
  })

  it("renders workflow_ref badge + 更换工作流 when bound", () => {
    render(<WorkflowBox task={makeTask({ workflow_ref: "built-in/test-flow" })} onMutated={() => {}} />)
    expect(q('[data-workflow-ref-badge]')!.textContent).toBe("built-in/test-flow")
    expect(screen.getByText("更换工作流")).toBeTruthy()
  })

  it("renders input value chips when input_values present (bound)", () => {
    render(
      <WorkflowBox
        task={makeTask({
          workflow_ref: "built-in/task-dev",
          task_spec: { input_values: { idea: "hello world" } },
        })}
        onMutated={() => {}}
      />,
    )
    expect(screen.getByText(/idea:/)).toBeTruthy()
  })

  it("has data-workflow-box attribute", () => {
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(q("[data-workflow-box]")).toBeTruthy()
  })

  it("S6: preset recommendation section is retired — no data-preset-item and no listWorkflowPresets import", async () => {
    const user = userEvent.setup()
    mockCatalog()
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    expect(q("[data-preset-item]")).toBeNull()
    expect(screen.queryByText("推荐")).toBeNull()
  })

  it("S2/AC4: dialog open fetches the built-in list EXACTLY once; rapid selections + search do not refetch", async () => {
    const user = userEvent.setup()
    mockCatalog()
    const { rerender } = render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    expect(listBuiltInWorkflows).toHaveBeenCalledTimes(1)

    // 快速点选 3 个工作流 — 列表不清不闪（items 恒在），零次重取
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.click(q('[data-workflow-item="built-in/task-fix"]')!)
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy()
    expect(listBuiltInWorkflows).toHaveBeenCalledTimes(1)

    // 搜索过滤同样零重取
    await user.type(q("[data-binding-search]")!, "fix")
    expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy()
    expect(q('[data-workflow-item="built-in/task-dev"]')).toBeNull()
    expect(listBuiltInWorkflows).toHaveBeenCalledTimes(1)

    // task prop 更新（10s 轮询换引用）不触发重取 —— 旧版 skill_groups 引用不稳的病根
    rerender(<WorkflowBox task={makeTask({ version: 2 })} onMutated={() => {}} />)
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy())
    expect(listBuiltInWorkflows).toHaveBeenCalledTimes(1)
  })

  it("inputs form renders from the catalog summary (default shown, untouched default not persisted)", async () => {
    const user = userEvent.setup()
    mockCatalog()
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)

    await waitFor(() => expect(inputEl("max_turns")).toBeTruthy())
    expect(inputEl("max_turns")!.value).toBe("200") // YAML default shown
    expect(inputEl("idea")!.value).toBe("")

    await user.type(inputEl("idea")!, "hello")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())

    const [id, input] = vi.mocked(updateTask).mock.calls[0]
    expect(id).toBe("test-task")
    expect(input.workflow_ref).toBe("built-in/task-dev")
    // 未触碰的 default 不落库；编辑值落库
    expect((input.task_spec as TaskSpec).input_values).toEqual({ idea: "hello" })
  })

  it("S5: save re-fetches the task version (not the open-time snapshot) and PUTs with it", async () => {
    const user = userEvent.setup()
    mockCatalog()
    // 开窗快照 version=1；重取后 server 已是 9
    render(<WorkflowBox task={makeTask({ version: 1 })} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-fix"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-fix"]')!)
    await user.type(inputEl("feedback_path")!, "batch/fix.md")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() => expect(getTask).toHaveBeenCalledWith("test-task"))
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())
    const [, , version] = vi.mocked(updateTask).mock.calls[0]
    expect(version).toBe(9) // fresh version, NOT the snapshot 1
  })

  it("manual switch between workflows clears previously filled values", async () => {
    const user = userEvent.setup()
    mockCatalog()
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.type(inputEl("idea")!, "typed")
    await user.click(q('[data-workflow-item="built-in/task-fix"]')!)
    await waitFor(() => {
      expect(inputEl("idea")).toBeNull()
      expect(inputEl("feedback_path")!.value).toBe("")
    })
  })

  it("save failure surfaces a toast (no silent swallow)", async () => {
    const { toast } = await import("sonner")
    const user = userEvent.setup()
    mockCatalog()
    vi.mocked(updateTask).mockRejectedValueOnce(new Error("Task version conflict (stale write)"))
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await waitFor(() => expect(q('[data-workflow-item="built-in/task-dev"]')).toBeTruthy())
    await user.click(q('[data-workflow-item="built-in/task-dev"]')!)
    await user.type(inputEl("idea")!, "x")
    await user.click(q("[data-bind-save-button]")!)
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("绑定失败: Task version conflict (stale write)"),
    )
  })

  it("click-to-view still opens the YAML viewer for the bound ref", async () => {
    const user = userEvent.setup()
    vi.mocked(getWorkflowRefView).mockResolvedValue({
      ref: "built-in/task-dev", content: "name: task-dev\nnodes:\n  - id: develop\n", source: "builtin",
    })
    render(<WorkflowBox task={makeTask({ workflow_ref: "built-in/task-dev" })} onMutated={() => {}} />)
    await user.click(q("[data-workflow-view-button]")!)
    await waitFor(() => expect(q("[data-workflow-content]")).toBeTruthy())
    expect(getWorkflowRefView).toHaveBeenCalledWith("test-task")
  })

  it("viewer dialog shows degraded hint when the bound ref is no longer resolvable (400)", async () => {
    const user = userEvent.setup()
    vi.mocked(getWorkflowRefView).mockRejectedValue(
      new WorkflowRefViewError("workflow not resolvable: 'built-in/gone'", 400),
    )
    render(<WorkflowBox task={makeTask({ workflow_ref: "built-in/gone" })} onMutated={() => {}} />)
    await user.click(q("[data-workflow-view-button]")!)
    await waitFor(() => expect(q("[data-workflow-degraded]")).toBeTruthy())
    expect(q("[data-workflow-degraded]")!.textContent).toContain("绑定的工作流已不存在")
  })
})

describe("WorkflowBox — v4 per-phase 绑定卡列表（票 12 D）", () => {
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

  it("empty phases → 拆分确认 empty state", () => {
    render(<WorkflowBox task={v4Task([])} onMutated={() => {}} />)
    expect(q("[data-phase-bind-empty]")).toBeTruthy()
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
    // v4 写回不碰任务级 workflow_ref
    expect(input.workflow_ref).toBeUndefined()
  })

  it("re-opens with the phase's current binding prefilled (更换工作流 keeps values)", async () => {
    const user = userEvent.setup()
    const phases = [makePhase(1, { inputValues: { idea: "keep me" } })]
    mockCatalog()
    render(<WorkflowBox task={v4Task(phases)} onMutated={() => {}} />)
    await user.click(q('[data-phase-bind-button="1"]')!)
    // selectedRef 预填 → 输入表单直接可见，无需再点列表项
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
})
