import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { Task } from "@octopus/shared"

// ── Mocks (collaborators) ────────────────────────────────────────────

// updateSpecField: capture calls (field/value/source) for direct edits + confirms.
vi.mock("@/lib/tasks-api", () => ({
  updateSpecField: vi.fn(),
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

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { updateSpecField } from "@/lib/tasks-api"
import { GoalAcCard } from "../goal-ac-card"

const mockUpdateSpecField = vi.mocked(updateSpecField)

// ── Fixtures ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    org: "E2E_TD_org",
    name: "v3 task",
    status: "draft",
    task_spec: {
      goal: "",
      ac: [],
      skill_groups: ["default"],
      task_type: "coding",
      goal_confirmed: false,
      ac_confirmed: [],
      decisions: [],
      resources: [],
      authoring_resources: [],
    },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 1,
    source_chat_session_id: "sess-1",
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
  mockUpdateSpecField.mockResolvedValue({ version: 2 })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Editing model: always-editable (no ghost lock), blur-commit ──

describe("GoalAcCard — goal/ac editing (always-editable)", () => {
  it("empty goal/ac show editable fields + an add button (not blocking ghosts)", () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // goal: an editable textarea with an instructive placeholder, even unbound.
    const goalInput = screen.getByPlaceholderText(/输入目标/) as HTMLTextAreaElement
    expect(goalInput).toBeDefined()
    expect(goalInput.value).toBe("")

    // ac: an editable list with a hint + an add button, even unbound.
    expect(screen.getByText(/暂无验收标准/)).toBeDefined()
    expect(screen.getByRole("button", { name: /添加验收标准/ })).toBeDefined()
  })

  it("SSE spec_field_update(goal) fills the goal textarea (agent binds)", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)
    expect(screen.getByPlaceholderText(/输入目标/)).toBeDefined()

    // Agent calls spec-field(goal=...) server-side → SSE arrives.
    expect(specFieldListener).not.toBeNull()
    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "goal", value: "agent-set goal", version: 2 }),
      })
    })

    await waitFor(() => {
      expect(screen.getByDisplayValue("agent-set goal")).toBeDefined()
    })
  })

  it("SSE spec_field_update(ac) emerges the ac list (agent binds)", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "ac", value: ["ac one", "ac two"], version: 2 }),
      })
    })

    await waitFor(() => {
      // ac items render as editable textareas — assert by display value.
      expect(screen.getByDisplayValue("ac one")).toBeDefined()
      expect(screen.getByDisplayValue("ac two")).toBeDefined()
    })
  })

  it("goal blur-commit → POST spec-field(goal, source=user) + ✏️ edited + resets goal_confirmed", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "old goal", ac: [], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: true, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // Directly edit the always-editable goal textarea, then blur to save.
    const goalInput = screen.getByLabelText("编辑 goal") as HTMLTextAreaElement
    fireEvent.change(goalInput, { target: { value: "user override" } })
    fireEvent.blur(goalInput)

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "goal", "user override", { source: "user" },
      )
    })

    // The ✏️ edited mark surfaces after a user-direct-edit.
    expect(screen.getByText(/已编辑/i)).toBeDefined()

    // AC4: editing the goal resets goal_confirmed (the gate must re-confirm).
    // The reset call fires after the goal edit succeeds.
    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "goal_confirmed", false, { source: "user" },
      )
    })
  })

  it("goal blur without any change is a no-op (no spec-field POST)", () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "a goal", ac: [], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    fireEvent.blur(screen.getByLabelText("编辑 goal"))

    expect(mockUpdateSpecField).not.toHaveBeenCalled()
  })

  it("ignores spec_field_update events for a different task_id", () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "other-task", field: "goal", value: "wrong", version: 2 }),
      })
    })

    // Still empty/editable — event was for a different task.
    expect((screen.getByPlaceholderText(/输入目标/) as HTMLTextAreaElement).value).toBe("")
  })
})

// ── AC list: + / − buttons, blur-commit, auto-wrap textareas ──

describe("GoalAcCard — ac add/remove/edit (+/− buttons, auto-wrap)", () => {
  it("empty ac: 添加验收标准 adds an editable first row — locally only, no POST", () => {
    const task = makeTask({ id: "t1" }) // default task_spec.ac = []
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: /添加验收标准/ }))

    // A fresh editable row appeared — but nothing persisted (the server rejects
    // "" as a spec-field ac value, so blank rows persist only once typed).
    expect(screen.getByPlaceholderText(/输入一条验收标准/)).toBeDefined()
    expect(mockUpdateSpecField).not.toHaveBeenCalled()
  })

  it("empty ac: type into the new row + blur POSTs the first ac item", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: /添加验收标准/ }))
    const row = screen.getByPlaceholderText(/输入一条验收标准/) as HTMLTextAreaElement
    fireEvent.focus(row)
    fireEvent.change(row, { target: { value: "first ac" } })
    fireEvent.blur(row)

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "ac", ["first ac"], { source: "user" },
      )
    })
  })

  it("typing in an ac row + blur commits the trimmed value", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one", "ac two"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    const row = screen.getByDisplayValue("ac one") as HTMLTextAreaElement
    fireEvent.focus(row)
    fireEvent.change(row, { target: { value: "  ac one edited  " } })
    fireEvent.blur(row)

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "ac", ["ac one edited", "ac two"], { source: "user" },
      )
    })
  })

  it("emptying an ac row + blur removes it (POST without it — no blank rows)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one", "ac two"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    const row = screen.getByDisplayValue("ac one") as HTMLTextAreaElement
    fireEvent.focus(row) // snapshot the persisted content (ac one) at focus
    fireEvent.change(row, { target: { value: "" } })
    fireEvent.blur(row)

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "ac", ["ac two"], { source: "user" },
      )
    })
  })

  it("− removes an ac row (POST the set without it)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one", "ac two"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: /删除 ac 1/ }))

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "ac", ["ac two"], { source: "user" },
      )
    })
  })

  it("ac items render as auto-wrapping textareas (not single-line inputs)", () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    const row = screen.getByDisplayValue("ac one") as HTMLTextAreaElement
    expect(row.tagName).toBe("TEXTAREA")
  })
})

// ── AC5: confirm goal/ac → spec-field(goal_confirmed/ac_confirmed) ──

describe("GoalAcCard — confirmation (persisted via spec-field)", () => {
  it("confirming goal → POST spec-field(goal_confirmed=true, source=user)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "a goal", ac: [], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // The goal confirm toggle (a round checkbox). aria-label disambiguates from ac.
    fireEvent.click(screen.getByRole("button", { name: /确认 goal/i }))

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "goal_confirmed", true, { source: "user" },
      )
    })
  })

  it("confirming an ac item → POST spec-field(ac_confirmed=[...], source=user)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one", "ac two"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: true, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // Confirm the first ac item.
    fireEvent.click(screen.getByRole("button", { name: /确认 ac: ac one/i }))

    await waitFor(() => {
      const call = mockUpdateSpecField.mock.calls.find(
        ([, field]) => field === "ac_confirmed",
      )
      expect(call).toBeDefined()
      expect(call![3]).toEqual({ source: "user" })
      expect(call![2]).toEqual(["ac one"])
    })
  })

  it("SSE spec_field_update(goal_confirmed) reflects the persisted confirm (survives modal close, AC5)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac one"], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // The confirm toggle is not yet checked. Simulate the server persisting +
    // emitting SSE (e.g. after a modal close/reopen the task prop carries it;
    // here the SSE path carries it live).
    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "goal_confirmed", value: true, version: 2 }),
      })
    })

    await waitFor(() => {
      const toggle = screen.getByRole("button", { name: /确认 goal/i })
      expect(toggle.getAttribute("data-confirmed")).toBe("true")
    })
  })
})
