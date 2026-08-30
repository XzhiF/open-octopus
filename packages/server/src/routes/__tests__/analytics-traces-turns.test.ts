import { describe, it, expect } from "vitest"
import { assignTurnsToEvents } from "../analytics"

// ②（轮次被压扁）读侧收口：traces 不再信被压平的 agent_events.turn_index，
// 改按 llm_calls 权威回合时间窗重派。数据形状取自真实 5 回合节点
// 67b228f9-tool-test：thinking_block 全存储 turn_index=1，但按 ts 窗口能精确还原 1..5。

const NE = "exec-1-tool-test"
function ev(event_order: number, event_type: string, ts: number, turn_stored = 1) {
  return { node_execution_id: NE, node_id: "tool-test", event_order, event_type, turn_index: turn_stored, timestamp: ts }
}
// 每次 llm_call 起始 ts == 该回合 thinking_block 的 ts（实测对齐）
const calls = [
  { node_execution_id: NE, turn_index: 1, timestamp: 1000 },
  { node_execution_id: NE, turn_index: 2, timestamp: 2000 },
  { node_execution_id: NE, turn_index: 3, timestamp: 3000 },
  { node_execution_id: NE, turn_index: 4, timestamp: 4000 },
  { node_execution_id: NE, turn_index: 5, timestamp: 5000 },
]
// 存储 turn_index 全 =1（压平），仅靠时间戳区分回合
const flatEvents = [
  ev(0, "start", 900),
  ev(2, "thinking_block", 1000), ev(3, "tool_call", 1100), ev(5, "tool_call", 1300),
  ev(7, "thinking_block", 2000), ev(8, "tool_call", 2100),
  ev(12, "thinking_block", 3000), ev(13, "tool_call", 3100),
  ev(17, "thinking_block", 4000), ev(18, "tool_call", 4100),
  ev(22, "thinking_block", 5000), ev(23, "text_block", 5200),
  ev(25, "end", 6000),
]

function turnsOf(events: Array<Record<string, unknown>>, cs: typeof calls) {
  const out = assignTurnsToEvents(events, cs)
  return out[0]?.turns as Array<{ turn_index: number; eventCount: number }>
}

describe("assignTurnsToEvents — llm_calls 时间窗重派回合", () => {
  it("压平的 turn_index 被还原成 5 个可展开回合（非 '1 turns'）", () => {
    const turns = turnsOf(flatEvents, calls)
    expect(turns.map(t => t.turn_index)).toEqual([1, 2, 3, 4, 5])
  })

  it("thinking_block 精确归入对应回合，工具/文本块顺延其后", () => {
    const turns = turnsOf(flatEvents, calls)
    const count = (t: number) => turns.find(x => x.turn_index === t)?.eventCount ?? 0
    expect(count(1)).toBe(4)  // start + thinking + 2 tool_call (start ts<首次call → 归回合1)
    expect(count(2)).toBe(2)  // thinking + tool_call
    expect(count(3)).toBe(2)
    expect(count(4)).toBe(2)
    expect(count(5)).toBe(3)  // thinking + text_block + end（end 顺延末回合）
  })

  it("end 事件（末回合之后）归末回合，不新增空回合", () => {
    const turns = turnsOf([...flatEvents], calls)
    const t5 = turns.find(x => x.turn_index === 5)
    expect(t5?.events.some(e => (e as any).event_type === "end")).toBe(true)
    expect(turns.map(t => t.turn_index)).not.toContain(6)
  })

  it("ISO 字符串时间戳（旧写入路径）同样能窗口对齐", () => {
    const isoCalls = calls.map(c => ({ ...c }))
    const isoEvents = [
      ev(2, "thinking_block", Date.parse("2026-01-01T00:00:01.000Z")),
      ev(7, "thinking_block", Date.parse("2026-01-01T00:00:02.000Z")),
    ]
    isoEvents.forEach((e, i) => { e.timestamp = new Date(1000 + i * 1000).toISOString() })
    const out = assignTurnsToEvents(isoEvents, isoCalls)
    expect((out[0]?.turns as Array<{ turn_index: number }>).map(t => t.turn_index)).toEqual([1, 2])
  })

  it("无 llm_calls 的节点回退用存储 turn_index（行为不变）", () => {
    const bashEvents = [
      { node_execution_id: "exec-1-build", node_id: "build", event_order: 0, event_type: "start", turn_index: 1, timestamp: 100 },
      { node_execution_id: "exec-1-build", node_id: "build", event_order: 1, event_type: "bash_log", turn_index: 2, timestamp: 200 },
    ]
    const out = assignTurnsToEvents(bashEvents, [])
    const turns = out[0]?.turns as Array<{ turn_index: number }>
    expect(turns.map(t => t.turn_index)).toEqual([1, 2])  // 原样分组
  })

  it("多节点各自按本节点 llm_calls 分窗，互不串台", () => {
    const twoNodes = [
      { node_execution_id: "exec-a", node_id: "a", event_order: 0, event_type: "thinking_block", turn_index: 1, timestamp: 1000 },
      { node_execution_id: "exec-a", node_id: "a", event_order: 1, event_type: "thinking_block", turn_index: 1, timestamp: 2000 },
      { node_execution_id: "exec-b", node_id: "b", event_order: 0, event_type: "thinking_block", turn_index: 1, timestamp: 1000 },
    ]
    const cs = [
      { node_execution_id: "exec-a", turn_index: 1, timestamp: 1000 },
      { node_execution_id: "exec-a", turn_index: 2, timestamp: 2000 },
      { node_execution_id: "exec-b", turn_index: 1, timestamp: 1000 },
    ]
    const out = assignTurnsToEvents(twoNodes, cs)
    const a = out.find(n => n.node_execution_id === "exec-a")!.turns as Array<{ turn_index: number }>
    const b = out.find(n => n.node_execution_id === "exec-b")!.turns as Array<{ turn_index: number }>
    expect(a.map(t => t.turn_index)).toEqual([1, 2])
    expect(b.map(t => t.turn_index)).toEqual([1])
  })
})
