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
})