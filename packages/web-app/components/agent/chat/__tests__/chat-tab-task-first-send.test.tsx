// 新建开发任务的首条消息必须真的发出去（bug 2026-10-29）。
//
// 现场：从没有 activeSessionId 的界面点「新建开发任务」→ 输入第一句话 → 界面
// 跳到 chat 后完全静止，没有运行中、没有回复；刷新后才看到任务。
// 根因：createNewSession 之后直接调用闭包里捕获的 sendMessage —— 那次 render 的
// sessionId 还是 null，useAgentChat 在 `if (!sessionId) return` 处静默返回，
// 请求从未离开浏览器（server 日志里只有 POST /sessions + POST /tasks，没有 chat）。
//
// 本测试不 mock useAgentChat：走真实 hook + 假网络层，断言 chat 流真的带着新建
// 会话 id 发出。mock 掉 hook 的话，旧代码也会「通过」。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import type { AgentSSEConnection } from "@/lib/agent/api"

const { chatStream, getSession } = vi.hoisted(() => ({
  chatStream: vi.fn(),
  getSession: vi.fn(),
}))

vi.mock("@/lib/agent/api", () => ({
  listClones: vi.fn().mockResolvedValue({ clones: [], total: 0 }),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
  setSessionRole: vi.fn().mockResolvedValue({ active_expert: null }),
  getSessionRole: vi.fn().mockResolvedValue({ active_expert: null }),
  listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession,
  getSessionRunning: vi.fn().mockResolvedValue({ running: false }),
  chatStream,
  stopChat: vi.fn().mockResolvedValue({ success: true }),
  createCloneSession: vi.fn(),
  cloneChatStream: vi.fn(),
  stopCloneChat: vi.fn(),
  getCloneSession: vi.fn(),
  getCloneSessionRunning: vi.fn().mockResolvedValue({ running: false }),
}))

// 有状态的会话 provider：createNewSession 真的把 activeSessionId 推到 s-new。
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
            id: "s-new", title: "新会话", org: "xzf", clone_name: null,
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
vi.mock("@/hooks/useSessionLedger", () => ({ useSessionLedger: () => ({ aggregates: null, calls: [] }) }))
vi.mock("@/hooks/useTaskUsage", () => ({ useTaskUsage: () => null }))
vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))

import { ChatTab } from "../ChatTab"

function sseWithDone(sessionId: string): AgentSSEConnection {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ session_id: sessionId, message_id: "a-1" })}\n\n`))
      c.close()
    },
  })
  return { reader: stream.getReader(), abort: vi.fn() } as unknown as AgentSSEConnection
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
  } as unknown as Response
}

beforeEach(() => {
  localStorage.clear()
  chatStream.mockReset().mockImplementation((sid: string) => sseWithDone(sid))
  getSession.mockReset().mockResolvedValue({
    session: { id: "s-new", title: "新会话", session_type: "main" },
    messages: { items: [], total: 0, has_more: false, next_cursor: null },
  })
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/tasks") && init?.method === "POST") {
      return jsonResponse({
        id: "task-1",
        repo_group: "xzf",
        name: "开发手机号注册功能",
        status: "draft",
        task_spec: { format: "v4" },
        authoring_resources: [],
        resources: [],
        skills: [],
        project_ids: [],
        version: 1,
        source_chat_session_id: "s-new",
        created_at: "2026-10-29T02:00:00Z",
        updated_at: "2026-10-29T02:00:00Z",
        deleted_at: null,
        trigger_mode: "manual",
        trigger_at: null,
        cron_expression: null,
        cron_timezone: "Asia/Shanghai",
        trigger_enabled: true,
        next_fire_at: null,
        last_fired_at: null,
        execution: null,
        executions: [],
        derived: { taskStatus: "draft", isV4: true, phaseViews: [] },
      })
    }
    return jsonResponse({ items: [], groups: [], tasks: [], orgs: [], total: 0 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatTab — 新建开发任务的首条消息", () => {
  it("会话是新建的：第一句话在任务落盘后带着新会话 id 发出（不再静默丢弃）", async () => {
    render(<ChatTab />)
    await screen.findByText("开始新的对话")

    // 任务板入口：此时没有 activeSessionId（本次 bug 的触发条件）。
    act(() => { window.dispatchEvent(new Event("octopus:new-task")) })
    await screen.findByText("描述要开发的任务")

    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "开发手机号注册功能" } })
    fireEvent.keyDown(textarea, { key: "Enter" })

    // 真实 hook 只有在 sessionId 就位时才发请求 —— 旧代码这里永远为 0 次。
    await waitFor(() => expect(chatStream).toHaveBeenCalledTimes(1))
    expect(chatStream.mock.calls[0][0]).toBe("s-new")
    expect(chatStream.mock.calls[0][1]).toBe("开发手机号注册功能")

    // 用户消息立刻可见（乐观追加），不是空白停在 hero 文案上（侧栏任务名
    // 也含同一句话，故用 findAll）。
    expect((await screen.findAllByText(/开发手机号注册功能/)).length).toBeGreaterThan(0)
  })
})
