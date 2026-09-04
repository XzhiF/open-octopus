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
  updateTask: vi.fn(),
  getTask: vi.fn(),
  getTaskContext: vi.fn().mockResolvedValue({ artifactsDir: "", path: "", content: null }),
  TaskReadyGateError: class TaskReadyGateError extends Error {
    missing: string[]
    constructor(m: string, missing: string[]) { super(m); this.name = "TaskReadyGateError"; this.missing = missing }
  },
}))

// 票 12: v4 预检/绑定卡数据源 = built-in 目录（缓存端点）
vi.mock("@/lib/workflow-presets-api", () => ({
  listBuiltInWorkflows: vi.fn().mockResolvedValue([
    { ref: "built-in/task-dev", name: "Task Dev", group: "built-in",
      inputs: { idea: { description: "想法", required: true } } },
  ]),
  getBuiltInWorkflowDetail: vi.fn().mockResolvedValue({ ref: "x", content: "", parsed: { name: "x" } }),
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

// ── 票 12: v4 入队清单四行 / canEnqueue 同源预检 / gate 反解 / autoAdvance ──

import { updateTask, getTask } from "@/lib/tasks-api"
import { listBuiltInWorkflows } from "@/lib/workflow-presets-api"

const mockUpdateTask = vi.mocked(updateTask)
const mockGetTask = vi.mocked(getTask)

function makeV4Task(
  id: string,
  phases: Array<Record<string, unknown>>,
  specOverrides: Record<string, unknown> = {},
): Task {
  return makeTask({
    id,
    task_spec: {
      format: "v4",
      task_type: "coding",
      skill_groups: ["default", "open-spec"],
      goal: "g", ac: [], goal_confirmed: false, ac_confirmed: [],
      decisions: [], resources: [], authoring_resources: [],
      phases,
      ...specOverrides,
    } as unknown as Task["task_spec"],
  })
}

const COMPLETE_PHASE_1 = {
  index: 1, name: "P1", slug: "p1-1",
  specPath: "./.scratch/20260903/p1-1/spec.md",
  workflowRef: "built-in/task-dev",
  inputValues: { idea: "hello" },
}
const COMPLETE_PHASE_2 = {
  index: 2, name: "P2", slug: "p2-2",
  specPath: "./.scratch/20260903/p2-2/spec.md",
  workflowRef: "built-in/task-dev",
  inputValues: { idea: "world" },
}

describe("AuthoringWorkspace — v4 入队清单 (票 12 C)", () => {
  it("v4: renders the four-row checklist; GoalAcCard is NOT rendered (K13)", async () => {
    render(
      <AuthoringWorkspace
        task={makeV4Task("v4-1", [COMPLETE_PHASE_1, COMPLETE_PHASE_2])}
        onMutated={() => {}}
        onClose={() => {}}
      />,
    )
    const list = await waitFor(() => screen.getByTestId("enqueue-checklist-v4"))
    for (const row of ["phases", "spec", "bind", "inputs"]) {
      expect(list.querySelector(`[data-checklist-v4="${row}"]`)).toBeTruthy()
    }
    // goal/ac 卡退役（v3 保留 — 见上组用例）
    expect(screen.queryByTestId("goal-ac-card")).toBeNull()
    // per-phase 绑定卡（WorkflowBox v4 分支）
    expect(document.querySelector("[data-phase-binding-list]")).toBeTruthy()
  })

  it("canEnqueue v4: empty phases → disabled; four rows pass → enabled (server 同源预检)", async () => {
    const { rerender } = render(
      <AuthoringWorkspace task={makeV4Task("v4-empty", [])} onMutated={() => {}} onClose={() => {}} />,
    )
    await waitFor(() => expect(screen.getByTestId("enqueue-checklist-v4")).toBeTruthy())
    expect((screen.getByTestId("task-enqueue") as HTMLButtonElement).disabled).toBe(true)

    rerender(
      <AuthoringWorkspace
        task={makeV4Task("v4-full", [COMPLETE_PHASE_1, COMPLETE_PHASE_2])}
        onMutated={() => {}}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("task-enqueue")).toBeTruthy())
    // inputs 行吃 built-in 目录（required idea 已填）→ 四行齐
    await waitFor(() => expect(listBuiltInWorkflows).toHaveBeenCalled())
    expect((screen.getByTestId("task-enqueue") as HTMLButtonElement).disabled).toBe(false)
  })

  it("canEnqueue v4: required input missing → inputs 行 ⏳ → disabled", async () => {
    render(
      <AuthoringWorkspace
        task={makeV4Task("v4-noinput", [{ ...COMPLETE_PHASE_1, inputValues: {} }, COMPLETE_PHASE_2])}
        onMutated={() => {}}
        onClose={() => {}}
      />,
    )
    const list = await waitFor(() => screen.getByTestId("enqueue-checklist-v4"))
    await waitFor(() => expect(listBuiltInWorkflows).toHaveBeenCalled())
    expect(list.querySelector('[data-checklist-v4="inputs"]')!.textContent).toContain("⏳")
    expect((screen.getByTestId("task-enqueue") as HTMLButtonElement).disabled).toBe(true)
  })

  it("gate 409 `phase:<i>:<why>` 反解 → 对应行标 ✗ + 人话（消灭点了才 409 的断链展示）", async () => {
    // 本地四行全过（idea 用占位符 ${goal}，server 端 goal 为空 → 门禁打回），
    // readyTask 抛 TaskReadyGateError → gateHits 反解回填逐行 ✗。
    mockReadyTask.mockRejectedValueOnce(
      new (await import("@/lib/tasks-api")).TaskReadyGateError(
        "Task not ready: missing phase:2:spec-missing, phase:2:input:idea",
        ["phase:2:spec-missing", "phase:2:input:idea"],
      ),
    )
    render(
      <AuthoringWorkspace
        task={makeV4Task("v4-gate", [COMPLETE_PHASE_1, { ...COMPLETE_PHASE_2, inputValues: { idea: "${goal}" } }])}
        onMutated={() => {}}
        onClose={() => {}}
      />,
    )
    await waitFor(() => expect(screen.getByTestId("enqueue-checklist-v4")).toBeTruthy())
    const btn = screen.getByTestId("task-enqueue") as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => {
      const list = screen.getByTestId("enqueue-checklist-v4")
      expect(list.querySelector('[data-checklist-v4="spec"]')!.textContent).toContain("✗")
      expect(list.querySelector('[data-checklist-v4="spec"]')!.textContent).toContain("Phase 2：批次目录中 spec 文件缺失")
      expect(list.querySelector('[data-checklist-v4="inputs"]')!.textContent).toContain("必填输入 idea")
    })
  })

  it("AC5: autoAdvance 开关可见可切 — 切换走重取 version 的 PUT", async () => {
    const task = makeV4Task("v4-auto", [COMPLETE_PHASE_1])
    mockGetTask.mockResolvedValue({ ...task, version: 7 } as never)
    mockUpdateTask.mockResolvedValue(task as never)
    render(<AuthoringWorkspace task={task} onMutated={() => {}} onClose={() => {}} />)
    const sw = (await waitFor(() => screen.getByTestId("autoadvance-switch"))) as HTMLInputElement
    expect(sw.checked).toBe(true) // 默认开（K6）
    fireEvent.click(sw)
    await waitFor(() => expect(mockGetTask).toHaveBeenCalledWith("v4-auto"))
    await waitFor(() => expect(mockUpdateTask).toHaveBeenCalledOnce())
    const [id, input, version] = mockUpdateTask.mock.calls[0]
    expect(id).toBe("v4-auto")
    expect(version).toBe(7) // S5：重取的 version，非 prop 快照
    expect(input.task_spec?.autoAdvance).toBe(false)
  })
})
