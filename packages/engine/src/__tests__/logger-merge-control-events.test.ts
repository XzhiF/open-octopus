import { describe, it, expect } from "vitest"
import { coalesceToolCallEvents, mergeAgentEvents, normalizeMergedEvents } from "../logger"

const agent = (type: string, extra: Record<string, unknown> = {}) => ({
  timestamp: "2026-10-30T03:00:00.000Z",
  nodeId: "node",
  event: "agent_event",
  event_data: { type, ...extra },
})

describe("mergeAgentEvents —— 控制事件透明", () => {
  it("status / turn_usage 不关闭工具块：一次调用只产出一条 tool_call", () => {
    const merged = mergeAgentEvents([
      { timestamp: "t0", nodeId: "n", event: "start" },
      agent("tool_start", { toolCallId: "call-1", toolName: "Read" }),
      agent("tool_input", { toolCallId: "call-1", tool: "Read", input: { file_path: "a.ts" } }),
      agent("status", { status: "requesting" }),
      agent("turn_usage", { turn: 2 }),
      agent("tool_result", { toolCallId: "call-1", tool: "Read", content: "contents" }),
      { timestamp: "t9", nodeId: "n", event: "end", status: "completed" },
    ])

    const tools = merged.filter((e) => e.event === "tool_call")
    expect(tools).toHaveLength(1)
    expect(tools[0].toolCallId).toBe("call-1")
    expect(tools[0].input).toBe(JSON.stringify({ file_path: "a.ts" }))
    expect(tools[0].result).toBe("contents")
    expect(merged.some((e) => e.event === "agent_event")).toBe(false)
  })

  it("status / turn_usage 不把一段正文切成两段", () => {
    const merged = mergeAgentEvents([
      agent("text_delta", { content: "第一段" }),
      agent("status", { status: "requesting" }),
      agent("turn_usage", { turn: 1 }),
      agent("text_delta", { content: "第二段" }),
      agent("thinking_done"),
    ])

    const texts = merged.filter((e) => e.event === "text_block")
    expect(texts).toHaveLength(1)
    expect(texts[0].content).toBe("第一段第二段")
  })

  it("空 agent_event 外壳直接丢弃", () => {
    const merged = mergeAgentEvents([
      { timestamp: "t0", nodeId: "n", event: "agent_event", event_data: { type: "agent_event" } },
      agent("status", { status: "requesting" }),
    ])
    expect(merged).toEqual([])
  })

  it("active_goal 仍保留，但不会打断进行中的文本块", () => {
    const merged = mergeAgentEvents([
      agent("text_delta", { content: "3" }),
      agent("active_goal", { condition: "说出 7", iterations: 2 }),
      { timestamp: "t9", nodeId: "n", event: "end", status: "completed" },
    ])
    expect(merged.map((e) => e.event)).toEqual(["text_block", "agent_event", "end"])
    expect(merged[1].event_data.type).toBe("active_goal")
  })
})

describe("normalizeMergedEvents —— 旧数据兜底", () => {
  it("同 toolCallId 的入参行 + 结果行合成一条", () => {
    const merged = normalizeMergedEvents([
      { event: "tool_call", toolCallId: "c1", toolName: "Read", input: "{}", result: null, startedAt: "2026-10-30T00:00:00.000Z" },
      { event: "tool_call", toolCallId: "c1", toolName: "Read", input: "", result: "done", startedAt: "2026-10-30T00:00:01.000Z" },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].input).toBe("{}")
    expect(merged[0].result).toBe("done")
  })

  it("无正文 agent_event 在最终结果里被过滤", () => {
    const merged = normalizeMergedEvents([
      { event: "agent_event", event_data: { type: "agent_event" } },
      { event: "agent_event", event_data: { type: "status", status: "running" } },
      { event: "agent_event", event_data: { type: "error", message: "boom" } },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].event_data.type).toBe("error")
  })

  it("coalesceToolCallEvents 保留最早开始 / 最晚结束", () => {
    const merged = coalesceToolCallEvents([
      { event: "tool_call", toolCallId: "c1", input: "{}", startedAt: "2026-10-30T00:00:02.000Z", completedAt: "2026-10-30T00:00:02.000Z" },
      { event: "tool_call", toolCallId: "c1", result: "x", startedAt: "2026-10-30T00:00:01.000Z", completedAt: "2026-10-30T00:00:03.000Z" },
    ])
    expect(merged[0].startedAt).toBe("2026-10-30T00:00:01.000Z")
    expect(merged[0].completedAt).toBe("2026-10-30T00:00:03.000Z")
  })
})
