import { describe, it, expect } from "vitest"
import { normalizeTraceEvents, assignTurnsToEvents } from "../analytics"

// traces 读侧词汇归一：merged 的 tool_call（同 toolCallId 两行）折叠为一行，
// thinking_block/text_block 的 content JSON 信封解包为正文；raw 词汇原样透传。
// 形状取自真实数据（67b228f9 / agent-port-test）。

function mergedToolRow(order: number, env: Record<string, unknown>, cols: Record<string, unknown> = {}) {
  return {
    node_execution_id: "ne", event_order: order, turn_index: 1, event_type: "tool_call",
    timestamp: "2026-08-30T01:00:00.000Z", content: JSON.stringify(env), tool_call_id: env.toolCallId,
    tool_name: env.toolName, ...cols,
  }
}

describe("normalizeTraceEvents", () => {
  it("merged tool_call 两行（input 行 + result 行）→ 折叠为一行，input/result 齐", () => {
    const start = mergedToolRow(1, { event: "tool_call", toolCallId: "t1", toolName: "Bash", input: "{\"command\":\"ls\"}", startedAt: "2026-08-30T01:00:00.000Z", completedAt: "2026-08-30T01:00:02.500Z" })
    const end = mergedToolRow(2, { event: "tool_call", toolCallId: "t1", toolName: "Bash", input: "", result: "{\"stdout\":\"a b\"}", isError: false, startedAt: "2026-08-30T01:00:00.000Z", completedAt: "2026-08-30T01:00:02.500Z" }, { tool_result: "{\"stdout\":\"a b\"}" })
    const out = normalizeTraceEvents([start, end])
    expect(out).toHaveLength(1)
    const r = out[0]
    expect(r.tool_input).toBe("{\"command\":\"ls\"}")
    expect(r.tool_result).toBe("{\"stdout\":\"a b\"}")
    expect(r.tool_is_error).toBe(0)
    expect(r.tool_duration_ms).toBe(2500)
  })

  it("isError 任一行为真 → 折叠后 =1；对象 result 序列化为字符串", () => {
    const a = mergedToolRow(1, { event: "tool_call", toolCallId: "t9", toolName: "Read", result: { error: "boom" }, isError: true })
    const out = normalizeTraceEvents([a])
    expect(out[0].tool_is_error).toBe(1)
    expect(out[0].tool_result).toContain("boom")
  })

  it("thinking_block / text_block：信封解包为正文；非 JSON 原样", () => {
    const th = { node_execution_id: "ne", event_order: 1, event_type: "thinking_block", timestamp: 1000, content: JSON.stringify({ event: "thinking_block", nodeId: "n", content: "想点什么", startedAt: "x", completedAt: "y" }) }
    const txt = { node_execution_id: "ne", event_order: 2, event_type: "text_block", timestamp: 2000, content: "纯文本没有信封" }
    const out = normalizeTraceEvents([th, txt])
    expect(out[0].content).toBe("想点什么")
    expect(out[0].content_length).toBe(4)
    expect(out[1].content).toBe("纯文本没有信封")
  })

  it("raw 词汇原样透传（tool_start/tool_input/tool_result 不折叠）", () => {
    const raw = ["tool_start", "tool_input", "tool_result"].map((t, i) => ({ node_execution_id: "ne", event_order: i, event_type: t, timestamp: i }))
    expect(normalizeTraceEvents(raw)).toHaveLength(3)
  })

  it("normalize 后再派生回合：折叠行仍落正确 turn", () => {
    const e1 = mergedToolRow(1, { event: "tool_call", toolCallId: "a", toolName: "Bash", input: "x", startedAt: 2000, completedAt: 2100 })
    const e2 = mergedToolRow(2, { event: "tool_call", toolCallId: "a", toolName: "Bash", result: "y", startedAt: 2000, completedAt: 2100 })
    // timestamp 覆盖为数值 ms，与 llm_call 窗口对齐
    ;(e1 as any).timestamp = 2050; (e2 as any).timestamp = 2150
    const calls = [{ node_execution_id: "ne", turn_index: 1, timestamp: 1000 }, { node_execution_id: "ne", turn_index: 2, timestamp: 2000 }]
    const turns = assignTurnsToEvents(normalizeTraceEvents([e1, e2]), calls)
    const turnList = (turns[0] as any).turns
    const t2 = turnList.find((t: any) => t.turn_index === 2)
    expect(t2.events).toHaveLength(1) // 折叠后只剩一行，归第 2 回合
    expect(t2.events[0].tool_result).toBe("y")
  })
})
