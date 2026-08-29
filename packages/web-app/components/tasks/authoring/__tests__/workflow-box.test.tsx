import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowBox } from "../workflow-box"
import type { Task, TaskSpec } from "@octopus/shared"
import { updateTask } from "@/lib/tasks-api"

// jsdom lacks ResizeObserver; user.click focuses elements which mounts the
// Radix ScrollArea observer inside the binding dialog.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
import {
  listWorkflowPresets,
  listBuiltInWorkflows,
  getBuiltInWorkflowDetail,
  type WorkflowPreset,
  type BuiltInWorkflowDetail,
} from "@/lib/workflow-presets-api"

// Mock the API modules
vi.mock("@/lib/tasks-api", () => ({
  updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 2 }),
}))

vi.mock("@/lib/workflow-presets-api", () => ({
  listWorkflowPresets: vi.fn().mockResolvedValue({ presets: [] }),
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

function makeTask(overrides: Partial<Task> & { task_spec?: Partial<TaskSpec> } = {}): Task {
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

describe("WorkflowBox", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders '未绑定' when no workflow_ref", () => {
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(screen.getByText("未绑定")).toBeTruthy()
    expect(screen.getByText("绑定工作流")).toBeTruthy()
  })

  it("renders workflow_ref badge when bound", () => {
    render(
      <WorkflowBox
        task={makeTask({ workflow_ref: "built-in/test-flow" })}
        onMutated={() => {}}
      />,
    )
    expect(screen.getByText("built-in/test-flow")).toBeTruthy()
    expect(screen.getByText("更换工作流")).toBeTruthy()
  })

  it("renders input value chips when input_values present", () => {
    render(
      <WorkflowBox
        task={makeTask({
          workflow_ref: "built-in/test-flow",
          task_spec: {
            goal: "test",
            ac: ["ac1"],
            resources: [],
            authoring_resources: [],
            skill_groups: [],
            decisions: [],
            ac_confirmed: [],
            input_values: { idea: "hello world" },
          },
        })}
        onMutated={() => {}}
      />,
    )
    // The chip shows "idea: hello world" (truncated if > 20 chars)
    expect(screen.getByText(/idea:/)).toBeTruthy()
  })

  it("has data-workflow-box attribute", () => {
    const { container } = render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(container.querySelector("[data-workflow-box]")).toBeTruthy()
  })

  // ── Binding dialog: inputs defaults + select-reset (goal-task-dev T06) ──

  function detail(
    ref: string,
    inputs: Record<string, { description?: string; required?: boolean; default?: string }>,
  ): BuiltInWorkflowDetail {
    return { ref, content: `name: ${ref}\n`, parsed: { name: ref, inputs } }
  }

  function mockCatalog(opts: {
    presets?: WorkflowPreset[]
    workflows?: { ref: string; name: string; group: string }[]
    details?: Record<string, BuiltInWorkflowDetail>
  }) {
    vi.mocked(listWorkflowPresets).mockResolvedValue({ presets: opts.presets ?? [] })
    vi.mocked(listBuiltInWorkflows).mockResolvedValue(opts.workflows ?? [])
    vi.mocked(getBuiltInWorkflowDetail).mockImplementation(async (ref) => {
      const d = opts.details?.[ref]
      if (!d) throw new Error(`no detail for ${ref}`)
      return d
    })
  }

  // Radix Dialog portals content to document.body — query the document, not the render container
  function inputEl(name: string): HTMLInputElement | null {
    return document.querySelector(`[data-input-field="${name}"]`)
  }

  function q(sel: string): HTMLElement | null {
    return document.querySelector(sel)
  }

  async function clickEl(user: ReturnType<typeof userEvent.setup>, sel: string) {
    await waitFor(() => expect(q(sel)).toBeTruthy())
    await user.click(q(sel)!)
  }

  const TASK_DEV_INPUTS = {
    goal: { description: "目标", required: true },
    ac: { description: "验收标准", required: true },
    max_turns: { description: "模型往返步数上限", required: false, default: "200" },
  }

  it("renders workflow input default: max_turns shows \"200\" on manual pick from 全部内置", async () => {
    const user = userEvent.setup()
    mockCatalog({
      workflows: [{ ref: "built-in/task-dev", name: "Task Dev", group: "built-in" }],
      details: { "built-in/task-dev": detail("built-in/task-dev", TASK_DEV_INPUTS) },
    })
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await clickEl(user, '[data-workflow-item="built-in/task-dev"]')

    const maxTurns = await waitFor(() => {
      const el = inputEl("max_turns")
      expect(el).toBeTruthy()
      return el
    })
    expect(maxTurns!.value).toBe("200")
    // Required fields without a default still render empty
    expect(inputEl("goal")!.value).toBe("")
  })

  it("resets form inputs when manually switching from a preset to another workflow", async () => {
    const user = userEvent.setup()
    mockCatalog({
      presets: [
        {
          name: "general-dev",
          skills_group: [],
          workflow: "built-in/a",
          inputs: { goal: "${goal}", ac: "${ac}" },
        },
      ],
      workflows: [
        { ref: "built-in/a", name: "A", group: "built-in" },
        { ref: "built-in/b", name: "B", group: "built-in" },
      ],
      details: {
        "built-in/a": detail("built-in/a", { goal: { required: true }, ac: { required: true } }),
        "built-in/b": detail("built-in/b", { goal: { required: true } }),
      },
    })
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))

    // Preset click prefills skeleton values
    await clickEl(user, '[data-preset-item="general-dev"]')
    await waitFor(() => expect(inputEl("ac")).toBeTruthy())
    expect(inputEl("goal")!.value).toBe("${goal}")
    await user.clear(inputEl("ac")!)
    await user.type(inputEl("ac")!, "typed-ac")

    // Manual pick from 全部内置 must clear previously filled values
    await clickEl(user, '[data-workflow-item="built-in/b"]')
    await waitFor(() => {
      const goal = inputEl("goal")
      expect(goal).toBeTruthy()
      expect(goal!.value).toBe("")
      expect(inputEl("ac")).toBeNull()
    })

    // Saved payload carries no leaked preset values either
    await clickEl(user, "[data-bind-save-button]")
    // Wait until the save promise fully settles (dialog closes) to keep updates in act scope
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())
    const patch = vi.mocked(updateTask).mock.calls[0][1] as unknown as {
      task_spec?: { input_values?: unknown }
    }
    expect(patch.task_spec?.input_values).toBeUndefined()
  })

  it("save drops untouched-default and cleared fields from input_values", async () => {
    const user = userEvent.setup()
    mockCatalog({
      presets: [
        {
          name: "general-dev",
          skills_group: [],
          workflow: "built-in/task-dev",
          inputs: { goal: "${goal}", ac: "${ac}" },
        },
      ],
      workflows: [{ ref: "built-in/task-dev", name: "Task Dev", group: "built-in" }],
      details: { "built-in/task-dev": detail("built-in/task-dev", TASK_DEV_INPUTS) },
    })
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    await user.click(screen.getByRole("button", { name: "绑定工作流" }))
    await clickEl(user, '[data-preset-item="general-dev"]')
    await waitFor(() => expect(inputEl("max_turns")).toBeTruthy())

    // Clear ac; leave max_turns untouched (renders default "200")
    await user.clear(inputEl("ac")!)
    expect(inputEl("max_turns")!.value).toBe("200")

    await clickEl(user, "[data-bind-save-button]")
    await waitFor(() => expect(q("[data-bind-save-button]")).toBeNull())
    const [, patch] = vi.mocked(updateTask).mock.calls[0] as unknown as [
      string,
      { workflow_ref?: string; task_spec?: { input_values?: Record<string, string> } },
    ]
    expect(patch.workflow_ref).toBe("built-in/task-dev")
    // Empty ac dropped, rendered-but-untouched max_turns NOT persisted (YAML default wins)
    expect(patch.task_spec?.input_values).toEqual({ goal: "${goal}" })
  })
})
