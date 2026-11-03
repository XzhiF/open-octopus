// 刷新后自动回到上次的任务（bug 2026-10-27）。
//
// 场景：任务在跑 → 刷新 → 旧行为回到「最新 main 会话」，运行中的任务要再点一次
// 侧栏才看得到。现在 ChatTab 按落盘的任务上下文恢复 activeTask，运行态直接可见。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

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

const sessionsBox: { sessions: unknown[]; activeSessionId: string | null } = {
  sessions: [],
  activeSessionId: null,
}

vi.mock("@/components/providers/chat-sessions", () => ({
  useChatSessions: () => ({
    sessions: sessionsBox.sessions,
    activeSessionId: sessionsBox.activeSessionId,
    setActiveSessionId: (id: string | null) => { sessionsBox.activeSessionId = id },
    loading: false,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    removeSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    refetch: vi.fn(),
  }),
}))

const sse = vi.hoisted(() => ({ subscribeSSE: vi.fn(() => () => {}) }))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: sse.subscribeSSE }))

vi.mock("@/hooks/useSessionUsage", () => ({
  useSessionUsage: () => null,
}))
vi.mock("@/hooks/useSessionLedger", () => ({ useSessionLedger: () => ({ aggregates: null, calls: [] }) }))
vi.mock("@/hooks/useTaskUsage", () => ({
  useTaskUsage: () => null,
}))

const RUNNING_TASK = {
  id: "task-running",
  org: "xzf",
  name: "运行中的任务",
  status: "running",
  workspace_id: "ws-task",
  task_spec: { format: "v4" },
  authoring_resources: [],
  resources: [],
  skills: [],
  project_ids: ["demo"],
  version: 1,
  source_chat_session_id: "s-source",
  created_at: "2026-10-27T09:00:00Z",
  updated_at: "2026-10-27T10:00:00Z",
  deleted_at: null,
  trigger_mode: "manual",
  trigger_at: null,
  cron_expression: null,
  cron_timezone: "Asia/Shanghai",
  trigger_enabled: false,
  next_fire_at: null,
  last_fired_at: null,
}

const tasksBox: { tasks: unknown[]; loading: boolean } = { tasks: [], loading: false }

vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: tasksBox.tasks, loading: tasksBox.loading, refresh: vi.fn() }),
}))

vi.mock("@/components/chat-workbench/task-modules-layer", () => ({
  TaskModulesLayer: () => null,
}))

import { ChatTab } from "../ChatTab"
import { writeLastChatContext } from "@/lib/last-chat-context"

beforeEach(() => {
  localStorage.clear()
  sessionsBox.sessions = []
  sessionsBox.activeSessionId = null
  sse.subscribeSSE.mockClear()
  tasksBox.tasks = [RUNNING_TASK]
  tasksBox.loading = false
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes("/api/tasks/task-gone")) {
      return { ok: false, status: 404, json: async () => ({ error: "task not found" }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [], tasks: [], groups: {} }),
    }
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatTab — 刷新恢复上次任务", () => {
  const firstTaskItem = () => screen.getAllByTestId("task-session-item")[0]

  it("落盘的任务上下文 ⇒ 直接打开该任务（运行中可见），不用再点侧栏", async () => {
    writeLastChatContext({ kind: "task", taskId: "task-running" })
    render(<ChatTab />)

    await waitFor(() => {
      const item = firstTaskItem()
      expect(item.getAttribute("aria-current")).toBe("page")
      expect(item.getAttribute("data-task-id")).toBe("task-running")
    })
  })

  it("没有落盘上下文 ⇒ 不自动打开任务", async () => {
    render(<ChatTab />)

    await waitFor(() => expect(firstTaskItem()).toBeDefined())
    expect(firstTaskItem().getAttribute("aria-current")).toBeNull()
  })

  it("落盘的任务已不存在（列表里没有 + 直查 404）⇒ 不误开别的任务", async () => {
    writeLastChatContext({ kind: "task", taskId: "task-gone" })
    render(<ChatTab />)

    await waitFor(() => expect(firstTaskItem()).toBeDefined())
    expect(firstTaskItem().getAttribute("aria-current")).toBeNull()
  })

  it("任务线程订阅 session_updated 用 activeTask.workspace_id（任务会话不在会话列表里）", async () => {
    // Task threads are excluded from the session list, so `activeSession` is
    // undefined; before the fix the chat never subscribed and server-appended
    // cards only showed after F5 (2026-11-02 user bug).
    writeLastChatContext({ kind: "task", taskId: "task-running" })
    render(<ChatTab />)

    await waitFor(() =>
      expect(sse.subscribeSSE).toHaveBeenCalledWith(
        expect.stringContaining("/api/workspaces/ws-task/events"),
        "session_updated",
        expect.any(Function),
      ),
    )
  })
})
