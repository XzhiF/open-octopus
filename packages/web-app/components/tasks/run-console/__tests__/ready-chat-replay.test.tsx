// 票08 — ReadyChatReplay（ready「💬 对话」只读回放）组件回归。
// seam = <ReadyChatReplay sessionId> 的盘面三态 + 只读硬闸：
//   ① 有史：水印逐字（原型 ⓬ readyChatHtml「— 只读回放 · 草稿期对话（task-author
//      全记录）—」）+ 用户/agent 气泡按到达序 + TuiMessage 折叠 meta 白拿
//      （thinking/工具 input/result 展开与草稿工作台同形制）；
//   ② 无缝：source_chat_session_id 缺失 → 空态「草稿期会话不存在」不白屏；
//   ③ 清理态：取数 404 → 同一空态文案；其余失败 → 读取失败话术（不伪装空态）；
//   只读硬闸：面内零输入（role textbox = 0，input/textarea/contenteditable 皆无）。
// 取数层 getAuthorSessionReplay（全量翻页/上限截断）在 lib/agent/__tests__/
// agent-api-session-replay.test.ts 独立钉死；本文件 mock 之，只测盘面语义。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { AgentMessage } from "@/lib/agent/types"

const { mockGetReplay } = vi.hoisted(() => ({ mockGetReplay: vi.fn() }))
vi.mock("@/lib/agent/api", () => ({
  getAuthorSessionReplay: mockGetReplay,
  SESSION_REPLAY_MAX: 1000,
}))

import { ReadyChatReplay } from "../ready-chat-replay"

function msg(id: string, role: "user" | "assistant", content: string, over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id, session_id: "sess-1", role, content,
    created_at: `2026-10-01T00:0${id.slice(-1)}:00Z`,
    is_summary: false, is_compressed: false, is_edited: false,
    ...over,
  }
}

/** 一条带完整过程 meta 的 agent 消息（timeline 3 步：thinking → tool → text 碎片）。 */
const ASSISTANT_WITH_META = msg("a1", "assistant", "改好了 —— 圆角已提到 18px。", {
  thinking: "先看票面的形制要求",
  tool_calls: [{ id: "tc-1", name: "Edit", input: { file_path: "ui/a.tsx", new_string: "rounded-xl" }, status: "success", result: "ok" }],
  timeline: [
    { kind: "thinking", text: "先看票面的形制要求" },
    { kind: "tool", id: "tc-1" },
    { kind: "text", text: "改好了 —— 圆角已提到 18px。" },
  ],
})

beforeEach(() => { mockGetReplay.mockReset() })

describe("ReadyChatReplay — 有史态", () => {
  it("水印逐字在顶；气泡按到达序（user→assistant→user）；TuiMessage 折叠 meta 在场且可展开（thinking/工具全继承）", async () => {
    mockGetReplay.mockResolvedValue({
      items: [msg("u1", "user", "帮我把圆角调大"), ASSISTANT_WITH_META, msg("u2", "user", "再收 2px")],
      truncated: false,
    })
    const { container } = render(<ReadyChatReplay sessionId="sess-1" />)
    const root = await screen.findByTestId("ready-chat-replay")
    expect(mockGetReplay).toHaveBeenCalledWith("sess-1")
    // 水印 = 原型逐字
    expect(screen.getByTestId("ready-chat-watermark").textContent)
      .toBe("— 只读回放 · 草稿期对话（task-author 全记录）—")
    // 到达序：data-tui-msg 序列 user, assistant, user
    const seq = [...root.querySelectorAll("[data-tui-msg]")].map((el) => el.getAttribute("data-tui-msg"))
    expect(seq).toEqual(["user", "assistant", "user"])
    expect(container.textContent).toContain("帮我把圆角调大")
    expect(container.textContent).toContain("改好了 —— 圆角已提到 18px。")
    // 折叠 meta 白拿（TuiTranscript 的「◌ 过程（时间序）· N 步」）
    const toggle = root.querySelector("[data-tui-meta]") as HTMLElement
    expect(toggle).toBeTruthy()
    expect(toggle.textContent).toContain("3 步")
    fireEvent.click(toggle)
    expect(root.textContent).toContain("先看票面的形制要求")
    // 工具行可展开 input/result（本会话刚做的交互 —— 同形制继承）。
    // data-tui-tool 是 ToolLine 外层 div，切换钮在其内（点击须落 button）。
    fireEvent.click(root.querySelector("[data-tui-tool] button") as HTMLElement)
    expect(root.textContent).toContain("rounded-xl")
  })

  it("只读硬闸：面内零输入 —— role textbox 计数 0，input/textarea/contenteditable 皆绝迹", async () => {
    mockGetReplay.mockResolvedValue({ items: [msg("u1", "user", "字"), ASSISTANT_WITH_META], truncated: false })
    const { container } = render(<ReadyChatReplay sessionId="sess-1" />)
    const root = await screen.findByTestId("ready-chat-replay")
    expect(within(root).queryAllByRole("textbox")).toHaveLength(0)
    expect(container.querySelectorAll("input, textarea, [contenteditable='true']")).toHaveLength(0)
  })

  it("截断标注如实：truncated=true → 上限说明行挂出（含 SESSION_REPLAY_MAX 数字）", async () => {
    mockGetReplay.mockResolvedValue({ items: [msg("u1", "user", "早")], truncated: true })
    render(<ReadyChatReplay sessionId="sess-1" />)
    const note = await screen.findByTestId("ready-chat-truncated")
    expect(note.textContent).toContain("1000")
  })
})

describe("ReadyChatReplay — 无缝态与清理态", () => {
  it("sessionId 缺失（无缝）：空态「草稿期会话不存在」，不发取数，不白屏", () => {
    const { container } = render(<ReadyChatReplay sessionId={null} />)
    expect(screen.getByTestId("ready-chat-replay")).toBeTruthy()
    expect(screen.getByTestId("ready-chat-empty").textContent).toContain("草稿期会话不存在")
    expect(container.textContent).not.toBe("")
    expect(mockGetReplay).not.toHaveBeenCalled()
    expect(within(screen.getByTestId("ready-chat-replay")).queryAllByRole("textbox")).toHaveLength(0)
  })

  it("会话已清理（取数 404）：同一空态文案，不崩不白屏", async () => {
    mockGetReplay.mockRejectedValue(Object.assign(new Error("Session sess-1 not found"), { status: 404, code: "NOT_FOUND" }))
    render(<ReadyChatReplay sessionId="sess-1" />)
    const root = await screen.findByTestId("ready-chat-replay")
    expect(await within(root).findByTestId("ready-chat-empty")).toBeTruthy()
    expect(root.textContent).toContain("草稿期会话不存在")
  })

  it("其它读取失败（断网/5xx）：如实「读取失败」话术，不伪装成空态", async () => {
    mockGetReplay.mockRejectedValue(new Error("fetch failed"))
    render(<ReadyChatReplay sessionId="sess-1" />)
    const err = await screen.findByTestId("ready-chat-error")
    expect(err.textContent).toContain("读取失败")
    expect(screen.queryByTestId("ready-chat-empty")).toBeNull()
  })

  it("会话存在但零消息：水印在顶 + 「暂无消息」如实行（不喊「不存在」）", async () => {
    mockGetReplay.mockResolvedValue({ items: [], truncated: false })
    render(<ReadyChatReplay sessionId="sess-1" />)
    const root = await screen.findByTestId("ready-chat-replay")
    expect(await within(root).findByTestId("ready-chat-nomsg")).toBeTruthy()
    expect(within(root).getByTestId("ready-chat-watermark")).toBeTruthy()
    expect(within(root).queryByTestId("ready-chat-empty")).toBeNull()
  })
})
