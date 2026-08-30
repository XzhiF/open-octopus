import { describe, it, expect } from "vitest"
import { computeTurnIndex } from "../services/observability"

// ② 源头收口（方案 B）：agent 事件流在落库前已被合并（thinking_start → thinking_block），
// 旧 computeTurnIndex 只认 thinking_start → 合并后永不推进 → 整节点 turn_index 塌成 1。
// 修复 = 同时认 thinking_block 当回合起点。落库处再 clamp Math.max(turn,1) 把 lead-in 事件归回合1。

function runSeq(types: string[]): number[] {
  let cur = 0
  return types.map((t) => { cur = computeTurnIndex(t, cur); return Math.max(cur, 1) })
}

describe("computeTurnIndex — 合并流轮次推进", () => {
  it("thinking_block 推进回合（修复主证：合并流不再恒 1）", () => {
    const turns = runSeq([
      "start", "thinking_block", "tool_call", "thinking_block", "tool_call", "thinking_block", "text_block", "end",
    ])
    // start/tb→1, tool→1, tb→2, tool→2, tb→3, text→3, end→3
    expect(turns).toEqual([1, 1, 1, 2, 2, 3, 3, 3])
    expect(new Set(turns).size).toBe(3) // 真实 3 回合，不再塌成 1
  })

  it("thinking_start 仍推进（向后兼容未合并流）", () => {
    const turns = runSeq(["thinking_start", "thinking", "thinking_done", "tool_call", "thinking_start", "thinking"])
    expect(turns).toEqual([1, 1, 1, 1, 2, 2])
  })

  it("lead-in（首个回合起点之前的事件）clamp 归回合 1，不产生 T0", () => {
    const turns = runSeq(["start", "status", "thinking_block"])
    expect(turns).toEqual([1, 1, 1])
  })

  it("无 thinking 的单流保持回合 1（既有限制，读侧 llm_calls 兜正）", () => {
    const turns = runSeq(["tool_call", "tool_call", "text_block"])
    expect(turns).toEqual([1, 1, 1])
  })

  it("混合 thinking_block 计数 == thinking_start 计数（两表示等价）", () => {
    const merged = runSeq(["thinking_block", "thinking_block", "thinking_block"])
    const raw = runSeq(["thinking_start", "thinking_start", "thinking_start"])
    expect(merged).toEqual(raw)
  })
})
