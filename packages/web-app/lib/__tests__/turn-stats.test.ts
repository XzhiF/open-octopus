// 逐 turn 统计的纯函数口径（2026-10-29）：账本行按用户消息窗口归属
// （message_id 优先），后台压缩行不计入。时长 / token 的显示格式化统一走
// lib/format.ts（C4/ADR-0017 单源），本文件不测格式。

import { describe, it, expect } from "vitest"
import { buildTurnStats } from "../turn-stats"
import type { AgentMessage } from "@/lib/agent/types"
import type { LLMCallData } from "@/lib/types"

function msg(partial: Partial<AgentMessage> & Pick<AgentMessage, "id" | "role" | "created_at">): AgentMessage {
  return {
    session_id: "s1",
    content: "",
    is_summary: false,
    is_compressed: false,
    is_edited: false,
    ...partial,
  }
}

function call(partial: Partial<LLMCallData> & Pick<LLMCallData, "id" | "timestamp">): LLMCallData {
  return {
    node_execution_id: "",
    execution_id: "",
    turn_index: 1,
    call_index: 0,
    duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    ...partial,
  }
}

const T0 = Date.parse("2026-10-29T02:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function assistantWithProcess(at: number): AgentMessage {
  return msg({
    id: "a-1",
    role: "assistant",
    created_at: iso(at),
    content: "done",
    thinking: "plan",
    timeline: [
      { kind: "thinking", text: "plan" },
      { kind: "tool", id: "t1" },
      { kind: "tool", id: "t2" },
    ],
    tool_calls: [
      { id: "t1", name: "Bash", input: {}, status: "success" },
      { id: "t2", name: "Read", input: {}, status: "fail" },
    ],
  })
}

describe("buildTurnStats — 账本归属", () => {
  it("无 message_id 时按用户消息窗口归属；assistant 中途 flush 的 created_at 不能截断账本行", () => {
    // 真机形态：assistant 行在开流几秒后 partial flush 插入（T0+5s），
    // 账本行在结果 chunk 到达时落（T0+90s / T0+94s）—— 后于 assistant.created_at。
    const messages = [
      msg({ id: "u-1", role: "user", created_at: iso(T0), content: "go" }),
      assistantWithProcess(T0 + 5_000),
    ]
    const calls = [
      call({
        id: "c1", timestamp: T0 + 90_000, duration_ms: 90_000,
        model: "claude-opus-5",
        input_tokens: 1000, output_tokens: 200, cache_read_tokens: 800, cache_creation_tokens: 100,
      }),
      call({
        id: "c2", timestamp: T0 + 94_000, duration_ms: 4_000,
        model: "claude-haiku-5-5",
        input_tokens: 100, output_tokens: 50, cache_read_tokens: 950,
      }),
    ]
    const stats = buildTurnStats(messages, calls).get("a-1")!
    expect(stats.durationMs).toBe(94_000)
    expect(stats.calls).toBe(2)
    expect(stats.inputTokens).toBe(1100)
    expect(stats.outputTokens).toBe(250)
    expect(stats.cacheReadTokens).toBe(1750)
    expect(stats.cacheCreationTokens).toBe(100)
    expect(stats.tokens).toBe(3200)
    expect(stats.cacheHitRate).toBeCloseTo(1750 / 2950, 5)
    expect(stats.models).toEqual(["claude-opus-5", "claude-haiku-5-5"])
  })

  it("下一条用户消息切轮：上一轮的账本行不会被下一轮吞掉", () => {
    const messages = [
      msg({ id: "u-1", role: "user", created_at: iso(T0) }),
      assistantWithProcess(T0 + 5_000),
      msg({ id: "u-2", role: "user", created_at: iso(T0 + 100_000) }),
      { ...assistantWithProcess(T0 + 105_000), id: "a-2" },
    ]
    const calls = [
      call({ id: "c1", timestamp: T0 + 90_000, duration_ms: 90_000, input_tokens: 1000 }),
      call({ id: "c2", timestamp: T0 + 120_000, duration_ms: 20_000, input_tokens: 500 }),
    ]
    const stats = buildTurnStats(messages, calls)
    expect(stats.get("a-1")!.inputTokens).toBe(1000)
    expect(stats.get("a-2")!.inputTokens).toBe(500)
  })

  it("有 message_id 的行精确归属，优先于时间窗", () => {
    const messages = [
      msg({ id: "u-1", role: "user", created_at: iso(T0) }),
      assistantWithProcess(T0 + 10_000),
    ]
    const calls = [
      // 时间窗外，但 message_id 命中 → 必须计入
      call({ id: "c1", timestamp: T0 + 999_000, duration_ms: 5_000, message_id: "a-1", input_tokens: 500 }),
      // 时间窗内，但属于另一条消息 → 不计入
      call({ id: "c2", timestamp: T0 + 9_000, duration_ms: 5_000, message_id: "a-other", input_tokens: 999 }),
    ]
    const stats = buildTurnStats(messages, calls).get("a-1")!
    expect(stats.calls).toBe(1)
    expect(stats.inputTokens).toBe(500)
  })

  it("后台压缩行（session_compress）不属于任何 turn；无账本行 → 不挂统计", () => {
    const messages = [
      msg({ id: "u-1", role: "user", created_at: iso(T0) }),
      assistantWithProcess(T0 + 10_000),
    ]
    const stats = buildTurnStats(messages, [
      call({ id: "c1", timestamp: T0 + 9_000, duration_ms: 1_000, source_path: "session_compress", input_tokens: 8000 }),
    ])
    // 没有可归的账本行时不造时长（不拿首字延迟冒充整轮耗时）。
    expect(stats.has("a-1")).toBe(false)
  })

  it("无过程条目的消息不挂统计（事件卡 / 纯文本行不出现 turn 行）", () => {
    const messages = [
      msg({ id: "u-1", role: "user", created_at: iso(T0) }),
      msg({ id: "a-plain", role: "assistant", created_at: iso(T0 + 5_000), content: "hi" }),
      msg({ id: "a-event", role: "assistant", created_at: iso(T0 + 6_000), content: "evt", displayType: "event" }),
    ]
    const stats = buildTurnStats(messages, [])
    expect(stats.has("a-plain")).toBe(false)
    expect(stats.has("a-event")).toBe(false)
    expect(stats.has("u-1")).toBe(false)
  })
})
