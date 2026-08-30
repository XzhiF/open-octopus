import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TurnSection } from "../turn-section"
import type { TurnGroup, AgentTraceEvent } from "@/lib/types"

// 工具调用行回归：merged(tool_call) 与 raw(tool_start/tool_input/tool_result)
// 两种词汇都必须渲染出工具行（旧实现只认 start/result，tool_call 整行消失）。

function e(partial: Partial<AgentTraceEvent> & { event_type: string; event_order: number }): AgentTraceEvent {
  return {
    node_execution_id: "exec-1-node", turn_index: 1, timestamp: 1700000000000 + partial.event_order * 1000,
    ...partial,
  } as AgentTraceEvent
}

function renderExpanded(events: AgentTraceEvent[]) {
  const turn: TurnGroup = { turn_index: 1, events, eventCount: events.length }
  render(<TurnSection turn={turn} isExpanded isLive={false} onToggle={vi.fn()} />)
}

describe("TurnSection — 工具行", () => {
  it("merged 词汇：tool_call 行渲染出工具名，摘要计 1 tool", () => {
    renderExpanded([
      e({ event_order: 1, event_type: "thinking_block", content: "想" }),
      e({ event_order: 2, event_type: "tool_call", tool_call_id: "t1", tool_name: "Bash", tool_input: "{\"command\":\"ls\"}", tool_result: "ok", tool_duration_ms: 2500 }),
    ])
    expect(screen.getByText("Bash")).toBeTruthy()
    expect(screen.getByText(/1 tool/)).toBeTruthy()
  })

  it("raw 词汇：start→input→result 三行合成一行，input 不丢；两次调用摘要 2 tools", () => {
    renderExpanded([
      e({ event_order: 1, event_type: "tool_start", tool_call_id: "a", tool_name: "Read" }),
      e({ event_order: 2, event_type: "tool_input", tool_call_id: "a", tool_name: "Read", tool_input: "{\"file_path\":\"/x\"}" }),
      e({ event_order: 3, event_type: "tool_result", tool_call_id: "a", tool_name: "Read", tool_result: "content", tool_duration_ms: 120 }),
      e({ event_order: 4, event_type: "tool_start", tool_call_id: "b", tool_name: "Bash" }),
      e({ event_order: 5, event_type: "tool_result", tool_call_id: "b", tool_name: "Bash", tool_result: "done" }),
    ])
    expect(screen.getByText("Read")).toBeTruthy()
    expect(screen.getByText("Bash")).toBeTruthy()
    expect(screen.getByText("2 tools")).toBeTruthy()
  })
})
