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
  getTaskContext: vi.fn().mockResolvedValue({ artifactsDir: "", path: "", content: null }),
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

const chatMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stopGenerate: vi.fn(),
  handleConfirm: vi.fn(),
  loadMessages: vi.fn(),
}))

vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    messages: [], streaming: false, streamContent: "", streamThinking: "",
    isThinking: false, toolCalls: [], pendingConfirm: null, error: null,
    statusMessage: "", sendMessage: chatMock.sendMessage, stopGenerate: chatMock.stopGenerate,
    handleConfirm: chatMock.handleConfirm, loadMessages: chatMock.loadMessages,
  }),
}))

// ChatArea: stub — the workspace's job is to mount it + the command bar, not
// to reproduce chat internals (those have their own tests). It surfaces the
// aggregated slash-commands it receives (AC7: the /-autocomplete lives inside
// ChatArea since the command-bar chips were removed).
vi.mock("@/components/agent/chat/ChatArea", () => ({
  ChatArea: (props: { onSend: (m: string) => void; commands?: Array<{ name: string; description?: string }> }) => (
    <div data-testid="chat-area">
      <button data-testid="chat-send" onClick={() => props.onSend("hi")}>send</button>
      {(props.commands ?? []).map((c) => (
        <span key={c.name} data-testid={`slash-cmd-${c.name}`}>/{c.name}</span>
      ))}
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

    fireEvent.click(screen.getByRole("button", { name: /codebase|预设/ }))

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
  it("aggregates /commands from all selected skill groups for the chat autocomplete", async () => {
    const task = makeTask({ id: "t1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => {
      // Command bar shows the aggregated count (open-spec group → 2 commands;
      // default group contributes nothing — D17 empty marker, no commands).
      expect(screen.getByText("输入 / 调用技能（2 个可用）")).toBeDefined()
    })
    // The aggregated slash-commands are handed to the chat's /-autocomplete.
    expect(screen.getByTestId("slash-cmd-open-spec")).toBeDefined()
    expect(screen.getByTestId("slash-cmd-spec-review")).toBeDefined()
  })

  it("scopes the /-autocomplete to the task's locked groups (no cross-group /superpowers)", async () => {
    // Regression (2026-08-26): the autocomplete previously aggregated EVERY
    // installed skill from /api/skill-groups — a task locking only open-spec
    // still advertised unselected groups' commands (e.g. superpowers' /brainstorming).
    mockListSkillGroups.mockResolvedValue({
      groups: [
        ...GROUPS,
        { group: "superpowers-zh", displayName: "superpowers-zh", skills: [{ name: "brainstorming" }] },
      ],
    })
    // Lock ONLY open-spec (drop "default" too, to prove the set is the gate).
    const task = makeTask({
      id: "t1",
      task_spec: {
        goal: "g", ac: ["ac 1", "ac 2"], skill_groups: ["open-spec"],
        task_type: "coding", goal_confirmed: false, ac_confirmed: [],
        decisions: [], resources: [], authoring_resources: [],
      } as Task["task_spec"],
    })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("输入 / 调用技能（2 个可用）")).toBeDefined())
    // Locked group's commands are present; the unselected group's is not.
    expect(screen.getByTestId("slash-cmd-open-spec")).toBeDefined()
    expect(screen.getByTestId("slash-cmd-spec-review")).toBeDefined()
    expect(screen.queryByTestId("slash-cmd-brainstorming")).toBeNull()
  })

  it("shows the empty-commands hint when no locked group contributes commands", async () => {
    const task = makeTask({ id: "t1" })
    mockListSkillGroups.mockResolvedValueOnce({
      groups: [{ group: "default", displayName: "default", skills: [] }],
    })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => {
      expect(screen.getByText("无额外命令（仅内置 spec-field 流程）")).toBeDefined()
    })
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

// ── Single-expert consultation: dialog → composed prompt sent to the
// task-author session with the expert registered as a per-turn subagent ──

describe("AuthoringWorkspace — single-expert consultation", () => {
  it("sends the composed consult message with the expert subagent to the session chat", async () => {
    const task = makeTask({ id: "t-consult", source_chat_session_id: "sess-1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    // Open the MoA dialog
    const moaBtn = screen.getByRole("button", { name: /专家咨询/ })
    fireEvent.click(moaBtn)

    // Switch to single-expert mode
    const singleRadio = await screen.findByRole("radio", { name: /单专家咨询/ })
    fireEvent.click(singleRadio)

    // Type the consultation question
    const question = screen.getByLabelText("咨询问题")
    fireEvent.change(question, { target: { value: "请评估验收标准是否完备" } })

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /开始咨询/ }))

    // The composed prompt is sent as a user message; the expert subagent is
    // registered for that turn (default role = AVAILABLE_ROLES[0]).
    expect(chatMock.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("请调用子代理「product-manager」"),
      { subagents: [{ id: "product-manager", label: "📦 产品经理" }] },
    )
    expect(chatMock.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("请评估验收标准是否完备"),
      expect.any(Object),
    )

    // Bugfix 2026-08-21: the dialog closes once the message is enqueued — the
    // user watches the consultation work in the chat instead of an open window.
    await waitFor(() => {
      expect(screen.queryByText("专家分析")).toBeNull()
    })
  })

  it("does not run the workflow engine for single-expert mode", async () => {
    const task = makeTask({ id: "t-consult-2", source_chat_session_id: "sess-1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /专家咨询/ }))
    fireEvent.click(await screen.findByRole("radio", { name: /单专家咨询/ }))
    fireEvent.change(screen.getByLabelText("咨询问题"), { target: { value: "hi" } })
    fireEvent.click(screen.getByRole("button", { name: /开始咨询/ }))

    // Only a chat message was sent — no workflow run triggered.
    expect(chatMock.sendMessage).toHaveBeenCalledTimes(1)
  })

  it("closes the consult dialog after 开始咨询 so the chat is unobstructed", async () => {
    const task = makeTask({ id: "t-consult-3", source_chat_session_id: "sess-1" })
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    fireEvent.click(screen.getByRole("button", { name: /专家咨询/ }))
    // The dialog is open — the title is visible.
    expect(screen.getByText("专家分析")).toBeDefined()

    fireEvent.click(await screen.findByRole("radio", { name: /单专家咨询/ }))
    fireEvent.change(screen.getByLabelText("咨询问题"), { target: { value: "请评审目标" } })
    fireEvent.click(screen.getByRole("button", { name: /开始咨询/ }))

    // Message enqueued AND the dialog dismissed (bugfix 2026-08-21).
    expect(chatMock.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("请评审目标"),
      expect.any(Object),
    )
    await waitFor(() => {
      expect(screen.queryByText("专家分析")).toBeNull()
    })
  })
})
