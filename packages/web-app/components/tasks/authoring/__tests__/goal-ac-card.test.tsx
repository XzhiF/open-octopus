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

// ── AC4: ghost → SSE emerge → direct edit (source=user) → ✏️ edited ──

describe("GoalAcCard — goal/ac emerge + direct edit", () => {
  it("shows ghost placeholders when goal/ac are unbound (empty)", () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)
    expect(screen.getByText(/goal — 待 agent 绑定后浮现/i)).toBeDefined()
    expect(screen.getByText(/ac — 待 agent 绑定后浮现/i)).toBeDefined()
  })

  it("SSE spec_field_update(goal) makes the goal emerge (agent binds)", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)
    expect(screen.getByText(/goal — 待 agent 绑定后浮现/i)).toBeDefined()

    // Agent calls spec-field(goal=...) server-side → SSE arrives.
    expect(specFieldListener).not.toBeNull()
    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "goal", value: "agent-set goal", version: 2 }),
      })
    })

    await waitFor(() => {
      expect(screen.getByText("agent-set goal")).toBeDefined()
    })
  })

  it("SSE spec_field_update(ac) makes the ac list emerge (agent binds)", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "t1", field: "ac", value: ["ac one", "ac two"], version: 2 }),
      })
    })

    await waitFor(() => {
      // ac items render as <input value={item}> — assert by display value.
      expect(screen.getByDisplayValue("ac one")).toBeDefined()
      expect(screen.getByDisplayValue("ac two")).toBeDefined()
    })
  })

  it("direct goal edit → POST spec-field(goal, source=user) + ✏️ edited mark + resets goal_confirmed", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "old goal", ac: [], skill_groups: ["default"], task_type: "coding",
        goal_confirmed: true, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    // Click the inline-edit affordance to reveal the textarea.
    fireEvent.click(screen.getByRole("button", { name: /直接编辑|编辑 goal/i }))

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "user override" } })
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }))

    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "goal", "user override", { source: "user" },
      )
    })

    // AC4: the ✏️ edited mark surfaces after a user-direct-edit.
    expect(screen.getByText(/已编辑/i)).toBeDefined()

    // AC4: editing the goal resets goal_confirmed (the gate must re-confirm).
    // The reset call fires after the goal edit succeeds.
    await waitFor(() => {
      expect(mockUpdateSpecField).toHaveBeenCalledWith(
        "t1", "goal_confirmed", false, { source: "user" },
      )
    })
  })

  it("ignores spec_field_update events for a different task_id", async () => {
    const task = makeTask({ id: "t1" })
    render(<GoalAcCard task={task} onMutated={() => {}} />)

    act(() => {
      specFieldListener!({
        data: JSON.stringify({ task_id: "other-task", field: "goal", value: "wrong", version: 2 }),
      })
    })

    // Still ghost — event was for a different task.
    expect(screen.getByText(/goal — 待 agent 绑定后浮现/i)).toBeDefined()
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
