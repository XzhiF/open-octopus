// TUI 过程 meta（2026-10-29 用户两轮反馈后定稿）：
//   收起 = TURN · N 步 · 时长 · 工具 · 思考 · token · 缓存（纯文字，无图形）；
//   展开 = 纯文本统计行（输入/输出、缓存读/写、请求次数）+ 原步骤列表。

import { describe, it, expect } from "vitest"
import { render, fireEvent } from "@testing-library/react"
import { TuiMessage } from "../TuiTranscript"
import type { AgentMessage, MessageTimelineEntry, ToolCallRecord } from "@/lib/agent/types"
import type { TurnStats } from "@/lib/turn-stats"

const STATS: TurnStats = {
  durationMs: 94_000,
  calls: 2,
  tokens: 12_300,
  inputTokens: 12_100,
  outputTokens: 200,
  cacheReadTokens: 9_800,
  cacheCreationTokens: 1_100,
  cacheHitRate: 0.82,
  models: ["claude-opus-5", "claude-haiku-5-5"],
}

function assistant(timeline: MessageTimelineEntry[], toolCalls: ToolCallRecord[], stats?: TurnStats): AgentMessage {
  return {
    id: "a-1",
    session_id: "s1",
    role: "assistant",
    content: "done",
    timeline,
    tool_calls: toolCalls,
    created_at: "2026-10-29T02:01:34.000Z",
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...(stats ? { turnStats: stats } : {}),
  }
}

const TWELEVE: MessageTimelineEntry[] = [
  { kind: "thinking", text: "plan" },
  { kind: "tool", id: "t1" },
  { kind: "thinking", text: "again" },
  { kind: "tool", id: "t2" },
  { kind: "tool", id: "t3" },
  { kind: "text", text: "note" },
  { kind: "tool", id: "t4" },
  { kind: "tool", id: "t5" },
  { kind: "tool", id: "t6" },
  { kind: "thinking", text: "x" },
  { kind: "tool", id: "t7" },
  { kind: "thinking", text: "y" },
]
const TOOLS: ToolCallRecord[] = Array.from({ length: 7 }, (_, i) => ({
  id: `t${i + 1}`,
  name: "Bash",
  input: {},
  status: i === 2 ? "fail" : "success",
}))

describe("TuiMessage 过程 meta — 收起态", () => {
  it("TURN · N 步 + 时长两单位 + 工具/思考/token/缓存（纯文字）", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, STATS)} />)
    const text = container.textContent ?? ""
    expect(text).toContain("TURN")
    expect(text).toContain("12 步")
    expect(text).toContain("1m 34s")
    expect(text).toContain("工具 7")
    expect(text).toContain("思考 4")
    expect(text).toContain("12.3K tok")
    expect(text).toContain("缓存 82%")
    // 2026-10-29 用户反馈：不要任何看不懂的图形（点阵 / 构成条一律不渲染）
    expect(container.querySelector("[data-tui-bar]")).toBeNull()
    expect(container.querySelector("[data-tui-dots]")).toBeNull()
  })

  it("无统计（旧轮 / 账本未落）→ 仍显示步数、工具、思考，不显示 0s / 0 tok", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS)} />)
    const text = container.textContent ?? ""
    expect(text).toContain("12 步")
    expect(text).not.toContain("0s")
    expect(text).not.toContain("0 tok")
    expect(container.querySelector("[data-tui-duration]")).toBeNull()
  })

  it("步数再多也只占一行文字（不再渲染点阵/构成条）", () => {
    const many = Array.from({ length: 45 }, (_, i): MessageTimelineEntry => ({ kind: "tool", id: `t${i}` }))
    const tools = Array.from({ length: 45 }, (_, i): ToolCallRecord => ({
      id: `t${i}`, name: "Bash", input: {}, status: "success",
    }))
    const { container } = render(<TuiMessage message={assistant(many, tools)} />)
    expect(container.textContent).toContain("45 步")
    expect(container.textContent).toContain("工具 45")
    expect(container.querySelector("[data-tui-bar]")).toBeNull()
  })
})

describe("TuiMessage 过程 meta — 展开态", () => {
  it("展开 → 纯文本统计行（输入/输出、缓存读/写、请求次数）+ 步骤列表", () => {
    const { container } = render(<TuiMessage message={assistant(TWELEVE, TOOLS, STATS)} />)
    fireEvent.click(container.querySelector('[data-tui-meta="closed"]') as HTMLElement)
    const header = container.querySelector('[data-tui-meta="open"]') as HTMLElement
    expect(header).toBeTruthy()
    // 展开后标题只留 TURN · N 步，数字全部下移，避免与收起态重复。
    expect(header.textContent).not.toContain("1m 34s")
    expect(header.textContent).not.toContain("工具 7")
    expect(header.textContent).not.toContain("12.3K")
    expect(header.textContent).toContain("12 步")
    const body = container.querySelector("[data-tui-meta-body]")!
    expect(body.textContent).toContain("输入 12.1K · 输出 200 · 合计 12.3K tok")
    expect(body.textContent).toContain("12.3K tok")
    expect(body.textContent).toContain("缓存命中 82%")
    expect(body.textContent).toContain("读 9.8K / 写 1.1K")
    expect(body.textContent).toContain("2 次请求")
    expect(body.textContent).toContain("（失败 1）")
    expect(body.textContent).toContain("1m 34s")
    expect(body.textContent).toContain("claude-opus-5 +1")
    // 原步骤列表仍在：工具简报
    expect(body.textContent).toContain("Bash")
    // 展开态同样不出现任何图形化元素
    expect(body.querySelectorAll("[data-tui-bar]").length).toBe(0)
  })
})
