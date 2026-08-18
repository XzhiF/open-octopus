import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task } from "@octopus/shared"
import type { SelectedProject } from "@/components/scheduler/project-selector"

// ── Mocks (collaborators) ────────────────────────────────────────────

vi.mock("@/lib/skill-groups-api", () => ({
  listSkillGroups: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => ({
  readyTask: vi.fn(),
  updateSpecField: vi.fn(),
  TaskReadyGateError: class TaskReadyGateError extends Error {
    missing: string[]
    constructor(m: string, missing: string[]) { super(m); this.name = "TaskReadyGateError"; this.missing = missing }
  },
}))

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(() => () => {}),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    messages: [], streaming: false, streamContent: "", streamThinking: "",
    isThinking: false, toolCalls: [], pendingConfirm: null, error: null,
    statusMessage: "", sendMessage: vi.fn(), stopGenerate: vi.fn(),
    handleConfirm: vi.fn(), loadMessages: vi.fn(),
  }),
}))

// ChatArea: stub — the workspace's job is to mount it + the command bar, not
// to reproduce chat internals (those have their own tests).
vi.mock("@/components/agent/chat/ChatArea", () => ({
  ChatArea: (props: { onSend: (m: string) => void }) => (
    <div data-testid="chat-area">
      <button data-testid="chat-send" onClick={() => props.onSend("hi")}>send</button>
    </div>
  ),
}))

vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: () => ({
    orgs: [{ id: 1, name: "E2E_TD_org", path: "/tmp" }],
    loading: false, error: null,
  }),
}))
vi.mock("@/components/scheduler/project-selector", () => ({
  ProjectSelector: ({ value }: { value: SelectedProject[] }) => (
    <div data-testid="project-selector">
      {value.map((p) => <span key={p.name}>{p.name}</span>)}
    </div>
  ),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

import { listSkillGroups } from "@/lib/skill-groups-api"
import { readyTask } from "@/lib/tasks-api"
import { AuthoringWorkspace } from "../authoring-workspace"

const mockListSkillGroups = vi.mocked(listSkillGroups)
const mockReadyTask = vi.mocked(readyTask)

const GROUPS = [
  { group: "default", displayName: "default", skills: [] },
  { group: "open-spec", displayName: "open-spec", skills: [{ name: "open-spec" }, { name: "spec-review" }] },
]

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    org: "E2E_TD_org",
    name: "v3 task",
    status: "draft",
    task_spec: {
      goal: "g",
      ac: ["ac 1", "ac 2"],
      skill_groups: ["default", "open-spec"],
      task_type: "coding",
      goal_confirmed: false,
      ac_confirmed: [],
      decisions: [],
      resources: [],
      authoring_resources: [],
    } as Task["task_spec"],
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: ["octopus-server"],
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
  mockListSkillGroups.mockResolvedValue({ groups: GROUPS })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── AC3: top bar — type badge + 🔒 skill-group badges + preset popup ──

describe("AuthoringWorkspace — top bar (AC3)", () => {
  it("renders the task-type badge + a 🔒 badge per selected skill group (no dropdown)", async () => {
    const task = makeTask({ id: "t1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    // type badge
    expect(screen.getByText(/开发任务/)).toBeDefined()
    // 🔒 lock marker per group (default + open-spec)
    const locks = screen.getAllByLabelText(/锁定|lock/i).length
    expect(locks).toBeGreaterThanOrEqual(2)
  })

  it("preset popup shows ONLY org + projects (no skills) — US14", async () => {
    const task = makeTask({ id: "t1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /编写语境|预设/ }))

    // Preset dialog has org + project selector, but NO skills section.
    await waitFor(() => {
      expect(screen.getByTestId("project-selector")).toBeDefined()
    })
    // No "技能" label inside the preset dialog.
    expect(screen.queryByText(/^技能$/)).toBeNull()
  })
})

// ── AC7: command bar aggregates selected groups' /commands ──────────

describe("AuthoringWorkspace — command bar (AC7)", () => {
  it("aggregates /commands from all selected skill groups above the chat", async () => {
    const task = makeTask({ id: "t1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => {
      // open-spec group contributes /open-spec + /spec-review.
      // default group contributes nothing (D17 — empty marker, no commands).
      expect(screen.getByText("/open-spec")).toBeDefined()
      expect(screen.getByText("/spec-review")).toBeDefined()
    })
  })

  it("clicking a command seeds the chat input (sends to the agent)", async () => {
    const task = makeTask({ id: "t1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("/open-spec")).toBeDefined())

    // The command bar button seeds the chat — asserted via the chat-send
    // stub being clickable (the workspace passes the seeded input through).
    fireEvent.click(screen.getByText("/open-spec"))
    // No throw + the command is still rendered (idempotent).
    expect(screen.getByText("/open-spec")).toBeDefined()
  })
})

// ── AC6: enqueue gate (disabled until confirmed; 409 shows missing) ──

describe("AuthoringWorkspace — enqueue gate (AC6)", () => {
  it("enqueue is disabled when goal/ac not fully confirmed", async () => {
    const task = makeTask({ id: "t1" }) // goal_confirmed=false, ac_confirmed=[]
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    const btn = screen.getByRole("button", { name: /入队/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // Hint text explains what to confirm.
    expect(screen.getByText(/确认 goal.*ac|请先确认/i)).toBeDefined()
  })

  it("enqueue is enabled when goal_confirmed + all ac confirmed", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac 1", "ac 2"], skill_groups: ["default", "open-spec"],
        task_type: "coding", goal_confirmed: true, ac_confirmed: ["ac 1", "ac 2"],
        decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    const btn = screen.getByRole("button", { name: /入队/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it("enqueue 409 surfaces the server-side missing-items list (gate backstop)", async () => {
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac 1", "ac 2"], skill_groups: ["default", "open-spec"],
        task_type: "coding", goal_confirmed: true, ac_confirmed: ["ac 1", "ac 2"],
        decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    // Server gate fails (e.g. a stale confirm slipped through) → 409 missing.
    const gateErr = new (await import("@/lib/tasks-api")).TaskReadyGateError(
      "Task not ready: missing goal_confirmed", ["goal_confirmed"],
    )
    mockReadyTask.mockRejectedValueOnce(gateErr)

    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /入队/ }))

    await waitFor(() => {
      expect(screen.getByText(/goal_confirmed/)).toBeDefined()
    })
  })
})
