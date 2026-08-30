import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnSection } from "../turn-section"
import type { TurnGroup, AgentTraceEvent } from "@/lib/types"

// 轮次标签回归：turn_index 持久化为 1-based，标签必须原样显示 T{turn_index}。
// 旧 `T{turn_index + 1}` 把第一轮标成 T2 且永不出 T1（用户实测困惑点）。
function evt(turn: number, order: number): AgentTraceEvent {
  return {
    node_execution_id: "exec-1-node-1",
    event_order: order,
    turn_index: turn,
    event_type: "thinking",
    timestamp: 1700000000000 + order * 1000,
    content: "…",
  }
}
function group(turn: number): TurnGroup {
  return { turn_index: turn, events: [evt(turn, turn * 10)], eventCount: 1 }
}

function label(turn: number): string {
  render(
    <TurnSection turn={group(turn)} isExpanded={false} isLive={false} onToggle={vi.fn()} />,
  )
  return turnLabel()
}
function turnLabel(): string {
  const el = screen.getByText(/^T\d+$/)
  return el.textContent ?? ""
}

describe("TurnSection 轮次标签（1-based，无 off-by-one）", () => {
  it("第一轮 turn_index=1 显示 T1（不是 T2）", () => {
    expect(label(1)).toBe("T1")
  })

  it("turn_index=5 显示 T5", () => {
    expect(label(5)).toBe("T5")
  })

  it("turn_index=106 显示 T106（长会话不漂移）", () => {
    expect(label(106)).toBe("T106")
  })
})
