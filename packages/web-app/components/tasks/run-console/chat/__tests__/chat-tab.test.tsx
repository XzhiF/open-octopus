// packages/web-app/components/tasks/run-console/chat/__tests__/chat-tab.test.tsx
//
// 票 07 AC 对号（组件 seam；浏览器 E2E 归票 10）：
//   AC1 待验收默认页：历史回放（ws-chat GET 既有端点，会话=doer 不碰谈面）
//   AC2 发小改 → 流式回复 + 工具卡（文件 +/−）→ 查看 diff 跳变更 + 快改视图上抛
//   AC3 劝退回复 → 「↩ 打回 · 派 task-fix（已带指令草稿）」→ openReject 预填回调
//   AC4 fixing 形态 = task-fix 明示 + 发消息走追加干预通道（不读 doer 会话）
//   AC5 两会话互不串台：只打 /api/tasks/:id/chat 与 ws-chat 历史 GET，
//       永不触碰 clones/task-author 面。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { ChatMessage } from "@/lib/types"
import type { InterventionRow } from "../../intervention"

const { mockGetBinding, mockGetHistory, FakeApiError } = vi.hoisted(() => {
  class FakeApiErrorImpl extends Error {
    constructor(msg: string, public status = 0) { super(msg) }
  }
  return {
    mockGetBinding: vi.fn(),
    mockGetHistory: vi.fn(),
    FakeApiError: FakeApiErrorImpl,
  }
})

vi.mock("@/lib/tasks-api", () => ({
  getTaskChatBinding: mockGetBinding,
  getDoerChatHistory: mockGetHistory,
  TaskApiError: FakeApiError,
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))

import { TaskChatTab } from "../chat-tab"

// ── fixtures ─────────────────────────────────────────────────────────

const BINDING = { task_id: "t1", session_id: "s-doer", workspace_id: "ws-1", created: false }

function cm(p: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "displayType" | "content">): ChatMessage {
  return { sessionId: "s-doer", timestamp: "2026-10-08T01:00:00Z", ...p }
}

/** 把一段 SSE 文本伪装成 fetch Response（parseSSEStream 吃 reader）。 */
function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text)
  let fired = false
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => (fired ? { done: true, value: undefined } : ((fired = true), { done: false, value: bytes })),
      }),
    },
  } as unknown as Response
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ sessionId: "s-doer", ...payload })}\n\n`
}

const EDIT_FILE = "C:\\ws\\projects\\octopus\\packages\\web-app\\a.tsx"

const TURN_SMALL_EDIT = [
  frame("tool_call_start", { type: "tool_call_start", messageId: "m1", toolCallId: "tc1", toolName: "Edit" }),
  frame("tool_call", {
    type: "tool_call", messageId: "m1", toolCallId: "tc1", toolName: "Edit",
    toolInput: {
      file_path: EDIT_FILE,
      old_string: "rounded-xl\nactive:translate-y-[2px]",
      new_string: "rounded-[18px]\nactive:translate-y-[1px]",
    },
  }),
  frame("tool_result", { type: "tool_result", toolCallId: "tc1", content: "The file has been updated.", isError: false }),
  frame("text_delta", { type: "text_delta", messageId: "m1", content: "改好了 —— 圆角已提到 18px。" }),
  frame("result", { type: "result", content: "" }),
  frame("quick_edit_commit", { type: "quick_edit_commit", taskId: "t1", repo: "octopus", branch: "feat-x", commit: "abc123", message: "[quick-edit] 圆角再大一点" }),
].join("")

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn())
  mockGetBinding.mockReset()
  mockGetHistory.mockReset()
  mockGetBinding.mockResolvedValue(BINDING)
  mockGetHistory.mockResolvedValue([])
})

describe("TaskChatTab — quick-edit 形态：历史回放 + 发信流", () => {
  it("挂载即懒建 doer 会话并回放历史；只说「做」面（AC1/AC5）", async () => {
    mockGetHistory.mockResolvedValue([
      cm({ id: "u1", role: "user", displayType: "user", content: "按钮再圆一点" }),
      cm({ id: "a1", role: "assistant", displayType: "text", content: "改好了 —— 圆角提到 18px。" }),
    ])
    render(<TaskChatTab taskId="t1" form="quick-edit" />)
    await screen.findByText("按钮再圆一点")
    expect(mockGetBinding).toHaveBeenCalledWith("t1")
    expect(mockGetHistory).toHaveBeenCalledWith("ws-1", "s-doer")
    expect(screen.getByText("改好了 —— 圆角提到 18px。")).toBeTruthy()
    expect(screen.queryByText(/小改直接说 —— 按钮、文案、颜色/)).toBeNull() // 有历史不摆欢迎语
    const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls
    expect(calls.some((c) => String(c[0]).includes("/api/clones/"))).toBe(false) // 谈面绝迹
  })

  it("空历史落欢迎语（原型 dockWelcome 逐字）", async () => {
    render(<TaskChatTab taskId="t1" form="quick-edit" />)
    expect(await screen.findByText(/小改直接说 —— 按钮、文案、颜色/)).toBeTruthy()
  })

  it("发小改：POST S1 SSE → 工具卡（⚙ 编辑 a.tsx +2 −2 查看 diff）→ 快改视图上抛", async () => {
    const onEditsChange = vi.fn()
    const onJumpToDiff = vi.fn()
    const onQuickEditCommit = vi.fn()
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse(TURN_SMALL_EDIT))
    render(<TaskChatTab taskId="t1" form="quick-edit" onEditsChange={onEditsChange} onJumpToDiff={onJumpToDiff} onQuickEditCommit={onQuickEditCommit} />)
    const ta = await screen.findByTestId("chat-input")
    fireEvent.change(ta, { target: { value: "圆角再大一点" } })
    fireEvent.click(screen.getByTestId("chat-send"))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/tasks/t1/chat",
        expect.objectContaining({ method: "POST" }),
      ),
    )
    const card = await screen.findByTestId("chat-tool-card")
    expect(card.textContent).toContain("编辑")
    expect(card.textContent).toContain("a.tsx")
    expect(card.textContent).toContain("+2")
    expect(card.textContent).toContain("−2")
    expect(await screen.findByText("改好了 —— 圆角已提到 18px。")).toBeTruthy()
    fireEvent.click(within(card).getByTestId("chat-tool-diff"))
    expect(onJumpToDiff).toHaveBeenCalledWith("C:/ws/projects/octopus/packages/web-app/a.tsx")
    // commit 尾帧 → 快改视图（×N chip 与 💬chat 徽标的数据源）+ 壳的变更节拍 bump
    await waitFor(() => expect(onEditsChange).toHaveBeenCalled())
    const last = onEditsChange.mock.calls.at(-1)?.[0]
    expect(last.commits).toBe(1)
    expect(last.files).toEqual(["C:/ws/projects/octopus/packages/web-app/a.tsx"])
    expect(onQuickEditCommit).toHaveBeenCalledWith({ repo: "octopus", branch: "feat-x", commit: "abc123", message: "[quick-edit] 圆角再大一点" })
  })

  it("劝退回复带「↩ 打回 · 派 task-fix（已带指令草稿）」按钮 → 点击预填打回框（AC3）", async () => {
    const onRejectDraft = vi.fn()
    const reply = "这个改动面比较大，建议打回 → 修复轮（task-fix）：草稿：统一按钮圆角体系并回归样式令牌。"
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue(sseResponse([
      `event: text_delta`,
      `data: {"sessionId":"s-doer","type":"text_delta","messageId":"m9","content":${JSON.stringify(reply)}}`,
      ``,
      `event: result`,
      `data: {"sessionId":"s-doer","type":"result","content":""}`,
      ``,
    ].join("\n")))
    render(<TaskChatTab taskId="t1" form="quick-edit" onRejectDraft={onRejectDraft} />)
    const ta = await screen.findByTestId("chat-input")
    fireEvent.change(ta, { target: { value: "把整个设计令牌重构一遍" } })
    fireEvent.click(screen.getByTestId("chat-send"))
    const btn = await screen.findByTestId("chat-reject-draft")
    fireEvent.click(btn)
    expect(onRejectDraft).toHaveBeenCalledWith(reply)
  })

  it("会话不可用（409 状态闸）：如实落横幅，输入口关闭", async () => {
    mockGetBinding.mockRejectedValue(new FakeApiError("任务尚未绑定执行工作区，无法开启对话", 409))
    render(<TaskChatTab taskId="t1" form="quick-edit" />)
    const banner = await screen.findByTestId("chat-unavailable")
    expect(banner.textContent).toContain("尚未绑定执行工作区")
    expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).disabled).toBe(true)
  })
})

describe("TaskChatTab — takeover 形态（08 复用点：同组件换口吻）", () => {
  it("欢迎语=「已停流，从现在起一步一交。」；仍走 doer 会话（POST S1）", async () => {
    const { rerender } = render(<TaskChatTab taskId="t1" form="quick-edit" />)
    expect(await screen.findByText(/按钮、文案、颜色这类我当场改代码/)).toBeTruthy()
    rerender(<TaskChatTab taskId="t1" form="takeover" />)
    expect(await screen.findByText("已停流，从现在起一步一交。")).toBeTruthy()
    expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).placeholder).toContain("像草稿一样指挥")
  })
})

describe("TaskChatTab — fixing 形态（修复轮追加指令，AC4）", () => {
  const iv: InterventionRow[] = [
    { nodeId: "dev", nodeName: "开发/修复", text: "先把 hover 描边改了", at: "2026-10-08T02:00:00Z" },
  ]
  it("明示 task-fix 在跑 + ⚑ 历史行；发消息走 onInterventionSend（06 通道）", async () => {
    const onInterventionSend = vi.fn().mockResolvedValue(undefined)
    render(<TaskChatTab taskId="t1" form="fixing" interventions={iv} onInterventionSend={onInterventionSend} />)
    expect((await screen.findByTestId("fixing-banner")).textContent).toContain("task-fix 执行中")
    const log = await screen.findByTestId("fixing-intervention-log")
    expect(within(log).getAllByTestId("fixing-intervention-line")).toHaveLength(1)
    expect(within(log).getByText(/开发\/修复/)).toBeTruthy()
    fireEvent.change(screen.getByTestId("fixing-input"), { target: { value: "回归别跑 e2e，只跑单测" } })
    fireEvent.click(screen.getByTestId("fixing-send"))
    await waitFor(() => expect(onInterventionSend).toHaveBeenCalledWith("回归别跑 e2e，只跑单测"))
    // fixing 不读 doer 会话 —— 追加指令与快改对话两本账，互不串台
    expect(mockGetBinding).not.toHaveBeenCalled()
    expect(mockGetHistory).not.toHaveBeenCalled()
  })
  it("注入失败：错误原文透出，输入不清空", async () => {
    const { toast } = await import("sonner")
    const onInterventionSend = vi.fn().mockRejectedValue(new Error("执行未处于暂停状态"))
    render(<TaskChatTab taskId="t1" form="fixing" onInterventionSend={onInterventionSend} />)
    fireEvent.change(await screen.findByTestId("fixing-input"), { target: { value: "纠偏" } })
    fireEvent.click(screen.getByTestId("fixing-send"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("执行未处于暂停状态"))
  })
})
