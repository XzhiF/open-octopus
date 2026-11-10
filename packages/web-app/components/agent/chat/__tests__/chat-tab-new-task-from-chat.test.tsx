// 从「已有内容的自由会话」点「新建开发任务」必须进入新任务界面（bug 2026-11-09）。
//
// 现场：chat 当前是一个普通会话（已有对话内容）时，侧栏「新建开发任务」没有
// 进入任务 hero，界面停留在旧对话里；而 chat 当前是任务时一切正常。
// 根因：handleCreateTask 会复用当前自由会话（2026-10-28 的「绑定当前会话」），
// 复用时 sessionId 不清空、旧 transcript 仍在，hero 的空态条件不成立。
// 修复：「新建」一律开新线程（先清 sessionId → hero），首句落盘时才创建会话。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/agent/api", () => ({
  listClones: vi.fn().mockResolvedValue({ clones: [], total: 0 }),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  setSessionRole: vi.fn(),
  getSessionRole: vi.fn().mockResolvedValue({ active_expert: null }),
  listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSessionRunning: vi.fn().mockResolvedValue({ running: false }),
  createCloneSession: vi.fn(),
  cloneChatStream: vi.fn(),
  stopCloneChat: vi.fn(),
  getCloneSession: vi.fn(),
  getCloneSessionRunning: vi.fn().mockResolvedValue({ running: false }),
}))

const { ACTIVE_SESSION } = vi.hoisted(() => ({
  ACTIVE_SESSION: {
    id: "s-chat",
    title: "普通会话",
    clone_name: null,
    perspective_clone_name: null,
    session_type: "main",
    created_at: "2026-11-09T00:00:00Z",
    updated_at: "2026-11-09T00:00:00Z",
    last_message_at: "2026-11-09T00:00:00Z",
    is_active: true,
  },
}))

vi.mock("@/components/providers/chat-sessions", () => ({
  useChatSessions: () => ({
    sessions: [ACTIVE_SESSION],
    // 已经在聊一个普通会话 —— 本次 bug 的触发条件。
    activeSessionId: ACTIVE_SESSION.id,
    setActiveSessionId: vi.fn(),
    loading: false,
    createNewSession: async () => null,
    renameSession: async () => {},
    removeSession: async () => {},
    updateSessionTitle: () => {},
    refetch: async () => {},
  }),
}))

vi.mock("@/hooks/useAgentChat", () => ({
  // 和真 hook 一样按 sessionId 取 transcript：会话清空 → 消息清空（hero 空态）。
  useAgentChat: (sid: string | null) => ({
    messages: sid === ACTIVE_SESSION.id
      ? [
          {
            id: "m1",
            session_id: ACTIVE_SESSION.id,
            role: "user",
            content: "旧对话的内容",
            created_at: "2026-11-09T00:00:00Z",
            is_summary: false,
            is_compressed: false,
            is_edited: false,
          },
        ]
      : [],
    streaming: false,
    streamContent: "",
    streamThinking: "",
    streamTimeline: [],
    isThinking: false,
    toolCalls: [],
    pendingConfirm: null,
    error: null,
    statusMessage: "",
    contextUsage: null,
    sendMessage: vi.fn(),
    stopGenerate: vi.fn(),
    handleConfirm: vi.fn(),
    loadMessages: vi.fn(),
    steer: vi.fn(),
    steeringRef: { current: false },
    resumeStreaming: false,
    checkAndResume: vi.fn(),
  }),
}))

vi.mock("@/hooks/useSessionUsage", () => ({ useSessionUsage: () => null }))
vi.mock("@/hooks/useSessionLedger", () => ({ useSessionLedger: () => ({ aggregates: null, calls: [] }) }))
vi.mock("@/hooks/useTaskUsage", () => ({ useTaskUsage: () => null }))
vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))

import { ChatTab } from "../ChatTab"

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], groups: [], tasks: [], orgs: [] }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatTab — 自由会话里新建开发任务", () => {
  it("已有内容的普通会话 → 点「新建开发任务」进入任务 hero，而不是留在旧对话", async () => {
    const { container } = render(<ChatTab />)

    // 启动恢复把普通会话挂到左栏；有内容 → 不是 hero 空态。
    await waitFor(() => {
      expect(screen.queryByText("开始新的对话")).toBeNull()
    })
    expect(container.querySelector('[data-tui-hero="true"]')).toBeNull()

    act(() => { window.dispatchEvent(new Event("octopus:new-task")) })

    // 新任务界面：hero 居中 + 任务空态文案。
    await screen.findByText("描述要开发的任务")
    expect(container.querySelector('[data-tui-hero="true"]')).toBeTruthy()
    expect(
      screen.getByText("第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。"),
    ).toBeInTheDocument()
    // 旧对话不再占据界面（sessionId 已清空）。
    expect(screen.queryByText("旧对话的内容")).toBeNull()
  })
})
