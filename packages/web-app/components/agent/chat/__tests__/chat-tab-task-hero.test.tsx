// 新建开发任务向新建对话看齐（2026-10-28）：点「新建开发任务」后不再走底部
// 停靠工作台，而是同一套 hero —— composer 居中、标题换文案、cwd/项目控件
// 挪到输入框下方第二行（hero footer），ctrlbar 内不再重复挂小 chip。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act } from "@testing-library/react"

const { sendMessage } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}))

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

vi.mock("@/components/providers/chat-sessions", async () => {
  const React = await import("react")
  return {
    useChatSessions: () => {
      const [activeSessionId] = React.useState<string | null>(null)
      return {
        sessions: [],
        activeSessionId,
        setActiveSessionId: vi.fn(),
        loading: false,
        createNewSession: async () => null,
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
vi.mock("@/hooks/use-chat-tasks", () => ({
  useChatTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}))

import { ChatTab } from "../ChatTab"

beforeEach(() => {
  localStorage.clear()
  sendMessage.mockReset()
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], groups: [], tasks: [], orgs: [] }),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatTab — 新建开发任务的 hero 几何（对齐新建对话）", () => {
  it("点「新建开发任务」→ hero 居中 + 第二行 cwd/项目 chip，停靠行不再重复挂控件", async () => {
    const { container } = render(<ChatTab />)
    // 初始是新建对话 hero（对照组：同款几何）。
    await screen.findByText("开始新的对话")

    // 任务板入口事件 = handleCreateTask（侧栏菜单同款）。
    act(() => { window.dispatchEvent(new Event("octopus:new-task")) })

    // hero 仍然成立：居中 dock + 任务标题/文案。
    await screen.findByText("描述要开发的任务")
    expect(container.querySelector('[data-tui-hero="true"]')).toBeTruthy()
    expect(screen.getByText("第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。")).toBeInTheDocument()

    // 第二行（hero footer）挂项目绑定控件；cwd chip 不出现（任务默认首条消息
    // 时新建工作空间，2026-10-28 用户定稿「没意义」→ 移除）。
    const footer = container.querySelector("[data-tui-hero-footer]")
    expect(footer).toBeTruthy()
    expect(footer?.querySelector('[data-testid="task-project-chip"]')?.textContent).toContain("绑定项目")
    expect(footer?.querySelector('[data-testid="cwd-chip"]')).toBeNull()

    // ctrlbar 里不再出现 composer-leading 小 chip（避免双份控件）。
    expect(container.querySelector("[data-composer-leading]")).toBeNull()
  })

  it("hero footer 的身份选择器不出现（任务身份由服务端按状态解析）", async () => {
    const { container } = render(<ChatTab />)
    await screen.findByText("开始新的对话")
    expect(container.querySelector('[data-testid="tui-hero-identity"]')).toBeTruthy()

    act(() => { window.dispatchEvent(new Event("octopus:new-task")) })
    await screen.findByText("描述要开发的任务")
    expect(container.querySelector('[data-testid="tui-hero-identity"]')).toBeNull()
  })
})
