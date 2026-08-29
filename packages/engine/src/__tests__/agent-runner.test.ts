import { describe, it, expect, vi } from "vitest"
import { AgentNodeRunner } from "../executors/agent-runner"
import type { IAgentProvider, MessageChunk } from "@octopus/providers"
import type { AgentEvent } from "../executors/agent-types"

function makeMockProvider(chunks: MessageChunk[]): IAgentProvider {
  return {
    getType: () => "claude",
    sendQuery: async function* () {
      for (const c of chunks) yield c
    },
  }
}

describe("AgentNodeRunner", () => {
  it("collects text_delta chunks into finalText", async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "text_delta", content: "Hello ", messageId: "msg1" },
      { type: "text_delta", content: "World", messageId: "msg1" },
      { type: "text_done", messageId: "msg1" },
      { type: "message_stop", messageId: "msg1" },
      { type: "result", content: "Hello World", sessionId: "sess1" },
    ])

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    const result = await runner.run({ prompt: "say hello", context: "new" })

    expect(result.finalText).toBe("Hello World")
    expect(result.sessionId).toBe("sess1")
  })

  it("emits thinking events", async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "thinking_start", messageId: "msg1" },
      { type: "thinking", content: "Let me think...", messageId: "msg1" },
      { type: "thinking_done", messageId: "msg1", thinkingDuration: "2s" },
      { type: "message_stop", messageId: "msg1" },
      { type: "result" },
    ])

    const events: AgentEvent[] = []
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({ prompt: "think", context: "new" })

    expect(events).toHaveLength(3)
    expect(events[0].type).toBe("thinking_start")
    expect(events[1].type).toBe("thinking")
    expect(events[2].type).toBe("thinking_done")
  })

  it("emits tool events in correct order", async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "tool_call_start", toolCallId: "tc1", toolName: "Read", messageId: "msg1" },
      { type: "tool_call", toolCallId: "tc1", toolName: "Read", toolInput: { file_path: "/f.txt" }, messageId: "msg1" },
      { type: "tool_result", toolCallId: "tc1", content: "file content" },
      { type: "message_stop", messageId: "msg1" },
      { type: "result" },
    ])

    const events: AgentEvent[] = []
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({ prompt: "read file", context: "new" })

    expect(events).toHaveLength(3)
    expect(events[0].type).toBe("tool_start")
    expect(events[1].type).toBe("tool_input")
    expect(events[2].type).toBe("tool_result")
  })

  it("throws on error chunk", async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "error", code: "timeout", message: "request timed out" },
    ])

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await expect(runner.run({ prompt: "fail", context: "new" })).rejects.toThrow("request timed out")
  })

  it('passes resumeSessionId when context is "continue"', async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "text_delta", content: "continued", messageId: "msg1" },
      { type: "text_done", messageId: "msg1" },
      { type: "message_stop", messageId: "msg1" },
      { type: "result", sessionId: "sess2" },
    ])
    const sendQuerySpy = vi.spyOn(provider, "sendQuery")

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await runner.run({ prompt: "continue", context: "continue", previousSessionId: "sess1" })

    expect(sendQuerySpy).toHaveBeenCalledWith(
      "continue", "/tmp/test", "sess1", expect.any(Object)
    )
  })

  it("collects token usage from result chunk", async () => {
    const provider = makeMockProvider([
      { type: "message_start", messageId: "msg1" },
      { type: "text_delta", content: "ok", messageId: "msg1" },
      { type: "text_done", messageId: "msg1" },
      { type: "message_stop", messageId: "msg1" },
      { type: "result", tokens: { input: 100, output: 50, total: 150 }, costUsd: 0.01 },
    ])

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    const result = await runner.run({ prompt: "test", context: "new" })

    expect(result.tokens).toEqual({ input: 100, output: 50, total: 150 })
    expect(result.costUsd).toBe(0.01)
  })

  it("emits resuming_after_crash status event on stream fracture with resume", async () => {
    let callCount = 0
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* () {
        callCount++
        if (callCount === 1) {
          // First call: stream ends without result (fracture)
          yield { type: "text_delta", content: "partial", messageId: "msg1" }
          return
        }
        // Second call: successful resume
        yield { type: "text_delta", content: " resumed", messageId: "msg2" }
        yield { type: "result", sessionId: "sess-resumed" }
      },
    }

    const events: AgentEvent[] = []
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({
      prompt: "do task",
      context: "continue",
      previousSessionId: "sess-orig",
    })

    const statusEvents = events.filter(e => e.type === "status")
    expect(statusEvents.some(e => e.type === "status" && e.status === "resuming_after_crash")).toBe(true)
  })

  it("resumes on stream fracture when context=continue with previousSessionId", async () => {
    let callCount = 0
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: "text_delta", content: "partial work", messageId: "msg1" }
          return // stream fracture: no result event
        }
        // resume call
        yield { type: "text_delta", content: " + completed", messageId: "msg2" }
        yield { type: "result", sessionId: "sess-final", tokens: { input: 50, output: 20, total: 70 } }
      },
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    const result = await runner.run({
      prompt: "do task",
      context: "continue",
      previousSessionId: "sess-orig",
    })

    expect(callCount).toBe(2)
    expect(result.finalText).toBe("partial work + completed")
    expect(result.sessionId).toBe("sess-final")
    expect(result.tokens).toEqual({ input: 50, output: 20, total: 70 })
  })

  it("throws without resume when context=new and stream fractures", async () => {
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* () {
        yield { type: "text_delta", content: "started", messageId: "msg1" }
        return // fracture, no result
      },
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await expect(
      runner.run({ prompt: "do task", context: "new" })
    ).rejects.toThrow("stream fracture")
  })

  it("does not retry when maxRetries is 0", async () => {
    let callCount = 0
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* () {
        callCount++
        yield { type: "text_delta", content: "x", messageId: "msg1" }
        return // fracture
      },
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await expect(
      runner.run({ prompt: "do task", context: "continue", previousSessionId: "s1", maxRetries: 0 })
    ).rejects.toThrow("stream fracture")
    expect(callCount).toBe(1)
  })

  it("throws when resume also fractures", async () => {
    let callCount = 0
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: async function* () {
        callCount++
        yield { type: "text_delta", content: `attempt-${callCount}`, messageId: "msg1" }
        return // fracture both times
      },
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await expect(
      runner.run({ prompt: "do task", context: "continue", previousSessionId: "s1" })
    ).rejects.toThrow("stream fracture")
    expect(callCount).toBe(2) // original + 1 retry
  })

  it("passes effort from run options to provider sendQuery", async () => {
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: vi.fn(async function* () {
        yield { type: "result", sessionId: "s1" }
      }),
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await runner.run({ prompt: "test", context: "new", effort: "high" })

    expect(provider.sendQuery).toHaveBeenCalledWith(
      "test", "/tmp/test", undefined,
      expect.objectContaining({ effort: "high" }),
    )
  })

  it("does not pass effort when not provided", async () => {
    const provider: IAgentProvider = {
      getType: () => "claude",
      sendQuery: vi.fn(async function* () {
        yield { type: "result", sessionId: "s1" }
      }),
    }

    const runner = new AgentNodeRunner(provider, "/tmp/test")
    await runner.run({ prompt: "test", context: "new" })

    const optionsArg = vi.mocked(provider.sendQuery).mock.calls[0][3]
    expect(optionsArg.effort).toBeUndefined()
  })
})
describe("AgentNodeRunner turn_usage 事件", () => {
  it("每个 message_delta(带 usage) 发出 turn_usage，total 为跨轮累计", async () => {
    const events: AgentEvent[] = []
    const provider = makeMockProvider([
      { type: "message_start", messageId: "m1" },
      { type: "message_delta", stopReason: "tool_use", messageId: "m1", usage: { inputTokens: 6, outputTokens: 111, cacheReadTokens: 0, cacheCreationTokens: 36451 } },
      { type: "message_stop", messageId: "m1" },
      { type: "message_start", messageId: "m2" },
      { type: "message_delta", stopReason: "end_turn", messageId: "m2", usage: { inputTokens: 6, outputTokens: 51, cacheReadTokens: 36451, cacheCreationTokens: 152 } },
      { type: "message_stop", messageId: "m2" },
      { type: "result", content: "done", sessionId: "s1" },
    ])
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({ prompt: "x", context: "new" })

    const usageEvents = events.filter(e => e.type === "turn_usage")
    expect(usageEvents).toHaveLength(2)
    expect(usageEvents[0]).toMatchObject({
      turn: 1,
      delta: { outputTokens: 111 },
      total: { inputTokens: 6, outputTokens: 111, cacheReadTokens: 0, cacheCreationTokens: 36451 },
    })
    expect(usageEvents[1]).toMatchObject({
      turn: 2,
      total: { inputTokens: 12, outputTokens: 162, cacheReadTokens: 36451, cacheCreationTokens: 36603 },
    })
  })

  it("message_delta 无 usage（旧数据/直连缺字段）→ 不发 turn_usage", async () => {
    const events: AgentEvent[] = []
    const provider = makeMockProvider([
      { type: "message_start", messageId: "m1" },
      { type: "message_delta", stopReason: "end_turn", messageId: "m1" },
      { type: "message_stop", messageId: "m1" },
      { type: "result", sessionId: "s1" },
    ])
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({ prompt: "x", context: "new" })
    expect(events.filter(e => e.type === "turn_usage")).toHaveLength(0)
  })

  it("只有 outputTokens 的 delta（直连 Anthropic 口径）也能累计", async () => {
    const events: AgentEvent[] = []
    const provider = makeMockProvider([
      { type: "message_start", messageId: "m1" },
      { type: "message_delta", stopReason: "end_turn", messageId: "m1", outputTokens: 42 },
      { type: "message_stop", messageId: "m1" },
      { type: "result", sessionId: "s1" },
    ])
    const runner = new AgentNodeRunner(provider, "/tmp/test", (e) => events.push(e))
    await runner.run({ prompt: "x", context: "new" })
    const usageEvents = events.filter(e => e.type === "turn_usage")
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({ turn: 1, total: { outputTokens: 42 } })
  })
})
