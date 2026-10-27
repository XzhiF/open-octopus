// 新会话里选的身份要跟着第一条消息生效（bug/需求 2026-10-27）：
// hero 阶段还没有 session，身份先存本地；createNewSession 后必须先写角色卡，
// 再发首条消息 —— 否则第一轮会用基础身份，用户会觉得「选了没用」。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const { sendMessage, listClones, listSkills, setSessionRole, getSessionRole } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  listClones: vi.fn(),
  listSkills: vi.fn(),
  setSessionRole: vi.fn(),
  getSessionRole: vi.fn(),
}))

vi.mock("@/lib/agent/api", () => ({
  listClones,
  listSkills,
  setSessionRole,
  getSessionRole,
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

vi.mock("@/hooks/useAgentChat", () => ({
  useAgentChat: () => ({
    messages: [],
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
    sendMessage,
    stopGenerate: vi.fn(),
    handleConfirm: vi.fn(),
    loadMessages: vi.fn(),
    steer: vi.fn(),
    steeringRef: { current: false },
    resumeStreaming: false,
    checkAndResume: vi.fn(),
  }),
}))

// 有状态的会话 provider：createNewSession 必须真的把 activeSessionId 改掉，
// 否则 ChatTab 的「建会话 → 发首条消息」effect 不会触发。
vi.mock("@/components/providers/chat-sessions", async () => {
  const React = await import("react")
  return {
    useChatSessions: () => {
      const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null)
      const [sessions, setSessions] = React.useState<unknown[]>([])
      return {
        sessions,
        activeSessionId,
        setActiveSessionId,
        loading: false,
        createNewSession: async () => {
          const session = {
            id: "s-new", title: "新对话", org: "xzf", clone_name: null,
            session_type: "main", created_at: "", updated_at: "",
            last_message_at: null, is_active: true,
          }
          setSessions([session])
          setActiveSessionId("s-new")
          return session
        },
        renameSession: async () => {},
        removeSession: async () => {},
        updateSessionTitle: () => {},
        refetch: async () => {},
      }
    },
  }
})

vi.mock("@/hooks/useSessionUsage", () => ({ useSessionUsage: () => null }))
vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))

import { ChatTab } from "../ChatTab"

beforeEach(() => {
  localStorage.clear()
  sendMessage.mockReset()
  setSessionRole.mockReset().mockResolvedValue({ active_expert: null })
  getSessionRole.mockReset().mockResolvedValue({ active_expert: null, active_kind: "expert", expert: null, clone: null })
  listSkills.mockReset().mockResolvedValue({ skills: [] })
  listClones.mockReset().mockResolvedValue({
    clones: [{
      name: "dev-clone", display_name: "开发分身", type: "user", persona: "",
      skills: [], memory_scope: "shared", status: "active",
    }],
    total: 1,
  })
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], groups: [], tasks: [] }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatTab — 新会话身份先选后生效", () => {
  it("hero 里选分身 → 首条消息前先写角色卡，再发送", async () => {
    render(<ChatTab />)
    await screen.findByText("开始新的对话")

    // 第二行身份 chip 打开 ＋ 面板，选一个分身
    fireEvent.click(screen.getByTestId("tui-hero-identity"))
    await waitFor(() => expect(listClones).toHaveBeenCalled())
    // hero 选择器只做单选：不出现「委派」与 SKILL 搜索。
    expect(screen.queryByTestId("delegate-clone-dev-clone")).toBeNull()
    expect(screen.queryByTestId("attach-search")).toBeNull()
    fireEvent.click(await screen.findByTestId("hero-identity-dev-clone"))

    // chip 立刻反映选择（乐观展示）
    expect(screen.getByTestId("tui-hero-identity").textContent).toContain("开发分身")

    // 选中后选择器自己收起。
    await waitFor(() => expect(screen.queryByTestId("hero-identity-panel")).toBeNull())
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "hi" } })
    fireEvent.keyDown(textarea, { key: "Enter" })

    await waitFor(() => expect(setSessionRole).toHaveBeenCalledWith("s-new", "dev-clone"))
    await waitFor(() => expect(sendMessage).toHaveBeenCalled())

    // 顺序契约：角色卡先落，消息后发
    expect(setSessionRole.mock.invocationCallOrder[0])
      .toBeLessThan(sendMessage.mock.invocationCallOrder[0])
  })
})
