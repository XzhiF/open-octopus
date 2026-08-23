import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { Task, TaskSpec, SubunitSpec } from "@octopus/shared"
import type { SelectedProject } from "@/components/scheduler/project-selector"

// ── Mocks (collaborators) ────────────────────────────────────────────

// updateTask is the [save draft] PUT — assert call + If-Match version.
vi.mock("@/lib/tasks-api", () => ({
  updateTask: vi.fn(),
}))

// subscribeSSE: capture the spec_field_update listener so the test can drive it.
let specFieldListener: ((e: { data: string }) => void) | null = null
const unsubSpy = vi.fn()
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(
    (_url: string, eventType: string, listener: (e: { data: string }) => void) => {
      if (eventType === "spec_field_update") specFieldListener = listener
      return unsubSpy
    },
  ),
}))

// listResources — return one installed resource per provisionable type.
vi.mock("@/lib/resource/api", () => ({
  listResources: vi.fn(async () => ({
    resources: [
      { name: "octo-backend", type: "skill", installed: true },
      { name: "code-reviewer", type: "agent", installed: true },
      { name: "lint-files", type: "command", installed: true },
      { name: "ts-strict", type: "rule", installed: true },
    ],
  })),
}))

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/useOrgs", () => ({ useOrgs: () => ({ orgs: [{ id: 1, name: "acme", path: "/tmp" }], loading: false, error: null }) }))
// ProjectSelector fetches a manifest — stub it; surface a checkbox per project so
// dirty-tracking is observable without coupling to manifest internals.
vi.mock("@/components/scheduler/project-selector", () => ({
  ProjectSelector: ({ value, onChange }: { value: SelectedProject[]; onChange: (v: SelectedProject[]) => void }) => (
    <div data-testid="project-selector">
      {value.map((p) => (
        <label key={p.name} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked
            onChange={() => onChange(value.filter((x) => x.name !== p.name))}
            data-project-checkbox={p.name}
          />
          {p.name}
        </label>
      ))}
      <button
        data-testid="add-project"
        onClick={() => onChange([...value, { name: "new-proj", source_path: "", group: "" }])}
      >
        + add project
      </button>
    </div>
  ),
}))

import { updateTask } from "@/lib/tasks-api"
import { SpecPanel, ResourcePicker } from "../task-modal"

const mockUpdateTask = vi.mocked(updateTask)

// ── Fixtures ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    org: "acme",
    name: "Untitled task",
    status: "draft",
    task_spec: { goal: "old goal", ac: ["first AC"], resources: [], authoring_resources: [] },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: null,
    deleted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    completed_at: null,
    ...overrides,
  } as Task
}

beforeEach(() => {
  vi.clearAllMocks()
  specFieldListener = null
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── AC2: agent spec_field_update → SpecPanel live-refresh + version bump ─

describe("SpecPanel — spec_field_update SSE", () => {
  it("applies an agent's `goal` field to the textarea live", async () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    await waitFor(() => {
      expect((screen.getByLabelText(/目标/) as HTMLTextAreaElement).value).toBe("old goal")
    })

    // Agent calls update_task_spec_field(goal=...) server-side → spec_field_update SSE.
    expect(specFieldListener).not.toBeNull()
    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "goal", value: "agent-set goal", version: 2 }),
      })
    })

    await waitFor(() => {
      expect((screen.getByLabelText(/目标/) as HTMLTextAreaElement).value).toBe("agent-set goal")
    })
  })

  it("bumps local version so a subsequent [save] sends the SSE's version, not the stale prop", async () => {
    const task = makeTask({ id: "t1", version: 1 })
    const onMutated = vi.fn()
    render(<SpecPanel task={task} onMutated={onMutated} />)

    await waitFor(() => {
      expect((screen.getByLabelText(/目标/) as HTMLTextAreaElement).value).toBe("old goal")
    })

    // Agent bumped version to 3 via spec_field_update.
    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "goal", value: "v3 goal", version: 3 }),
      })
    })

    // [save draft] — click the save button.
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "t1", version: 4 }))
    fireEvent.click(screen.getByRole("button", { name: /保存草稿/ }))

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledOnce()
    })

    // If-Match version must be the SSE-bumped version (3), not the stale prop (1).
    const [, , version] = mockUpdateTask.mock.calls[0]
    expect(version).toBe(3)
  })

  it("ignores spec_field_update events for a different task_id", async () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    await waitFor(() => {
      expect((screen.getByLabelText(/目标/) as HTMLTextAreaElement).value).toBe("old goal")
    })

    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "other-task", field: "goal", value: "wrong", version: 2 }),
      })
    })

    // Unchanged — event was for a different task.
    expect((screen.getByLabelText(/目标/) as HTMLTextAreaElement).value).toBe("old goal")
  })
})

// ── AC3: [save draft] → PUT /api/tasks with If-Match ─────────────────

describe("SpecPanel — [save draft]", () => {
  it("calls updateTask (PUT /api/tasks/:id) with the current spec + version", async () => {
    const task = makeTask({ id: "t1", version: 5 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    // Edit the goal (make it dirty).
    const goalTextarea = screen.getByLabelText(/目标/) as HTMLTextAreaElement
    fireEvent.change(goalTextarea, { target: { value: "user override" } })

    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "t1", version: 6 }))
    fireEvent.click(screen.getByRole("button", { name: /保存草稿/ }))

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledOnce()
    })

    const [id, input, version] = mockUpdateTask.mock.calls[0]
    expect(id).toBe("t1")
    expect(version).toBe(5) // prop version (no SSE bump in this test)
    expect(input.task_spec?.goal).toBe("user override")
  })

  it("disables [save] when spec is clean (not dirty)", async () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    const saveBtn = screen.getByRole("button", { name: /保存草稿/ }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it("surfaces a toast + does not throw on 409 conflict", async () => {
    const { toast } = await import("sonner")
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    fireEvent.change(screen.getByLabelText(/目标/), { target: { value: "edit" } })
    mockUpdateTask.mockRejectedValueOnce(new Error("Task version conflict (stale write)"))

    fireEvent.click(screen.getByRole("button", { name: /保存草稿/ }))

    await waitFor(() => {
      expect(mockedToastError(toast)).toHaveBeenCalledWith("Task version conflict (stale write)")
    })
  })
})

// ── AC4: resource picker — authoring vs workspace two scope ─────────

describe("ResourcePicker", () => {
  it("lists installed resources across the 4 provisionable types", async () => {
    render(<ResourcePicker scope="authoring" value={[]} onChange={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText("octo-backend")).toBeDefined()
      expect(screen.getByText("code-reviewer")).toBeDefined()
      expect(screen.getByText("lint-files")).toBeDefined()
      expect(screen.getByText("ts-strict")).toBeDefined()
    })
  })

  it("toggles a resource into the authoring scope and propagates via onChange", async () => {
    const onChange = vi.fn()
    render(<ResourcePicker scope="authoring" value={[]} onChange={onChange} />)

    await waitFor(() => {
      expect(screen.getByText("octo-backend")).toBeDefined()
    })

    fireEvent.click(screen.getByLabelText(/octo-backend/))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0]).toEqual([{ type: "skill", name: "octo-backend" }])
  })
})

describe("SpecPanel — resource pickers (two scope)", () => {
  it("renders separate authoring (draft-scope) and workspace (workspace-scope) pickers", async () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)

    await waitFor(() => {
      // Two pickers: authoring_resources (draft-scope) + resources (workspace-scope).
      expect(screen.getByTestId("resource-picker-authoring")).toBeDefined()
      expect(screen.getByTestId("resource-picker-workspace")).toBeDefined()
    })
  })
})

// ── AC4: SubunitsEditor per-subunit resources ───────────────────────

describe("SpecPanel — subunits per-subunit resources", () => {
  it("renders a per-subunit resource picker for each subunit", async () => {
    const subunits: SubunitSpec[] = [
      {
        name: "后端",
        workflow_ref: "wf-a",
        workspace_spec: { org: "acme", branch_prefix: "bp", projects: [{ name: "p", source_path: "", group: "" }] },
        input_values: {},
        skills: [],
        resources: [],
      },
    ]
    const task = makeTask({
      id: "t1",
      version: 1,
      task_spec: { goal: "g", ac: ["a"], subunits } as TaskSpec,
    })

    render(<SpecPanel task={task} onMutated={() => {}} />)

    await waitFor(() => {
      // The subunit name surfaces in the editor.
      expect(screen.getByDisplayValue("后端")).toBeDefined()
      // Per-subunit resource picker (workspace scope).
      expect(screen.getByTestId("subunit-resource-picker-0")).toBeDefined()
    })
  })
})

// ── helper: extract the error mock fn from the sonner namespace ────

function mockedToastError(toast: { error?: unknown }): (msg: string) => unknown {
  return toast.error as (msg: string) => unknown
}

// ── task-workflow-handoff (ADR-0013, S5): workflow_ref display ─────────

describe("SpecPanel — workflow_ref display (ADR-0013)", () => {
  it("shows unbound hint when workflow_ref is empty", () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)
    // Hint about agent binding
    expect(screen.getByTestId("workflow-ref-display")).toBeDefined()
    expect(screen.getByText(/未绑定工作流/)).toBeDefined()
  })

  it("displays bound workflow_ref with 查看 button", () => {
    const task = makeTask({ id: "t1", version: 1, workflow_ref: "octo/my-flow" })
    render(<SpecPanel task={task} onMutated={() => {}} />)
    expect(screen.getByText("octo/my-flow")).toBeDefined()
    expect(screen.getByRole("button", { name: /查看/ })).toBeDefined()
  })

  it("SSE spec_field_update(workflow_ref) updates display live", () => {
    const task = makeTask({ id: "t1", version: 1 })
    render(<SpecPanel task={task} onMutated={() => {}} />)
    // Initially unbound
    expect(screen.getByText(/未绑定工作流/)).toBeDefined()
    // SSE delivers the bind
    act(() => {
      specFieldListener?.({
        data: JSON.stringify({
          task_id: "t1",
          field: "workflow_ref",
          value: "octo/new-flow",
          version: 2,
        }),
      })
    })
    // Now shows the bound value
    expect(screen.getByText("octo/new-flow")).toBeDefined()
  })
})
