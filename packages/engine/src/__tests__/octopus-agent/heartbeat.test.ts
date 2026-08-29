// packages/engine/src/__tests__/octopus-agent/heartbeat.test.ts
//
// Unit tests for HeartbeatHandler class.
// Verifies step counting, interval emission, budget checking, and stall detection.
//

import { describe, it, expect, vi } from "vitest"
import { HeartbeatHandler } from "../../executors/octopus-agent/heartbeat"
import type { AgentEvent } from "../../executors/agent-types"
import type { HarnessConfig, AgentHeartbeat } from "@octopus/shared"

describe("HeartbeatHandler", () => {
  it("counts tool_result events as steps", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 3,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // Emit 3 tool_result events
    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "file content", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_result", toolCallId: "2", toolName: "Write", content: "success", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_result", toolCallId: "3", toolName: "Edit", content: "updated", timestamp: Date.now() })

    expect(handler.getStepCount()).toBe(3)
    // No heartbeat should fire at step 3 with interval 3 (fires ON the 3rd step)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "heartbeat" }),
    )
  })

  it("emits heartbeat every N steps (heartbeat_interval)", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 2,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // Step 1 - no heartbeat yet
    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })
    expect(onEvent).not.toHaveBeenCalled()

    // Step 2 - heartbeat emitted
    handler.onAgentEvent({ type: "tool_result", toolCallId: "2", toolName: "Write", content: "", timestamp: Date.now() })
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          step: 2,
        }),
      }),
    )

    // Step 3 - no heartbeat (not a multiple of 2)
    handler.onAgentEvent({ type: "tool_result", toolCallId: "3", toolName: "Edit", content: "", timestamp: Date.now() })
    expect(onEvent).toHaveBeenCalledTimes(1)

    // Step 4 - heartbeat emitted
    handler.onAgentEvent({ type: "tool_result", toolCallId: "4", toolName: "Bash", content: "", timestamp: Date.now() })
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          step: 4,
          tokens_used: 0,
          confidence: -1,
          issues: [],
        }),
      }),
    )
  })

  it("uses default heartbeat_interval of 3 when not specified", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {}
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_result", toolCallId: "2", toolName: "Read", content: "", timestamp: Date.now() })
    expect(onEvent).not.toHaveBeenCalled()

    handler.onAgentEvent({ type: "tool_result", toolCallId: "3", toolName: "Read", content: "", timestamp: Date.now() })
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          step: 3,
          tokens_used: 0,
          confidence: -1,
        }),
      }),
    )
    expect(handler.getStepCount()).toBe(3)
  })

  it("includes tokens_used in heartbeat", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // Simulate token tracking
    handler.updateTokens({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          tokens_used: 1500,
          step: 1,
        }),
      }),
    )
    // Verify exact token breakdown is reflected
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it("includes tokens_budget in heartbeat when budget specified", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const budget = { max_tokens: 50000 }
    const handler = new HeartbeatHandler("test-node", config, budget, onEvent)

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          tokens_budget: 50000,
          step: 1,
          tokens_used: 0,
        }),
      }),
    )
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it("sets confidence to -1 (v1 placeholder)", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          confidence: -1,
          step: 1,
        }),
      }),
    )
    // Confidence must be exactly -1, not any other negative number
    const callData = onEvent.mock.calls[0][0]
    expect(callData.data.confidence).toBe(-1)
  })

  it("sets issues to empty array (v1 placeholder)", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          issues: [],
          step: 1,
        }),
      }),
    )
    // Issues must be an empty array, not undefined or non-empty
    const callData = onEvent.mock.calls[0][0]
    expect(callData.data.issues).toEqual([])
    expect(callData.data.issues).toHaveLength(0)
  })

  it("emits harness_directive abort when auto_abort_on_budget and tokens exceeded", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: true,
    }
    const budget = { max_tokens: 1000 }
    const handler = new HeartbeatHandler("test-node", config, budget, onEvent)

    // Simulate token usage exceeding budget
    handler.updateTokens({ inputTokens: 800, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    // Should emit both heartbeat and harness_directive
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          tokens_used: 1300,
          tokens_budget: 1000,
        }),
      }),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "harness_directive",
        data: expect.objectContaining({
          type: "abort",
          reason: expect.stringContaining("Token budget exceeded"),
          issued_by: "harness",
        }),
      }),
    )
    // Verify directive has a timestamp
    const directiveCall = onEvent.mock.calls.find((c: any[]) => c[0].type === "harness_directive")
    expect(directiveCall[0].data.timestamp).toBeGreaterThan(0)
  })

  it("does not emit abort when auto_abort_on_budget is false", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const budget = { max_tokens: 1000 }
    const handler = new HeartbeatHandler("test-node", config, budget, onEvent)

    // Simulate token usage exceeding budget
    handler.updateTokens({ inputTokens: 800, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    // Should emit heartbeat but not harness_directive
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          tokens_used: 1300,
          tokens_budget: 1000,
        }),
      }),
    )
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "harness_directive",
      }),
    )
  })

  it("tracks artifacts from output", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    handler.addArtifact("src/api.ts")
    handler.addArtifact("src/tests.ts")

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          artifacts: ["src/api.ts", "src/tests.ts"],
          step: 1,
        }),
      }),
    )
    // Verify artifacts array length and exact contents
    const callData = onEvent.mock.calls[0][0]
    expect(callData.data.artifacts).toHaveLength(2)
    expect(callData.data.artifacts[0]).toBe("src/api.ts")
    expect(callData.data.artifacts[1]).toBe("src/tests.ts")
  })

  it("updates current_activity on text_delta events", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    handler.onAgentEvent({ type: "text_delta", content: "Analyzing the requirements", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          current_activity: expect.stringContaining("Analyzing"),
          step: 1,
        }),
      }),
    )
    // Verify current_activity captures the text delta content
    const callData = onEvent.mock.calls[0][0]
    expect(callData.data.current_activity).toBe("Analyzing the requirements")
  })

  it("ignores non-tool_result events for step counting", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // These events should not increment step counter
    handler.onAgentEvent({ type: "text_delta", content: "Thinking...", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_start", toolCallId: "1", toolName: "Read", timestamp: Date.now() })
    handler.onAgentEvent({ type: "tool_input", toolCallId: "1", toolName: "Read", input: {}, timestamp: Date.now() })
    handler.onAgentEvent({ type: "thinking", content: "Let me analyze", timestamp: Date.now() })

    expect(handler.getStepCount()).toBe(0)
    expect(onEvent).not.toHaveBeenCalled()
    // Verify none of the non-step events triggered any callback
    expect(onEvent).toHaveBeenCalledTimes(0)
  })

  it("updates lastActivityAt on any event", () => {
    const config: HarnessConfig = {
      heartbeat_interval: 3,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, vi.fn())

    const before = handler.getLastActivityAt()
    expect(before).toBeGreaterThan(0)
    expect(typeof before).toBe("number")

    // Wait a bit and emit an event
    handler.onAgentEvent({ type: "text_delta", content: "test", timestamp: Date.now() })

    const after = handler.getLastActivityAt()
    expect(after).toBeGreaterThanOrEqual(before)
    expect(typeof after).toBe("number")
  })

  it("detects stall when no events within heartbeat_timeout", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 1, // 1 second for fast test
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // Emit one event to set lastActivityAt
    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    // Wait for timeout
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const isStalled = handler.checkStall()
        expect(isStalled).toBe(true)
        // Step count should still be 1 from the initial event
        expect(handler.getStepCount()).toBe(1)
        resolve()
      }, 1100) // 1.1 seconds
    })
  })

  it("does not detect stall when events are recent", () => {
    const onEvent = vi.fn()
    const config: HarnessConfig = {
      heartbeat_interval: 1,
      heartbeat_timeout: 300,
      auto_abort_on_budget: false,
    }
    const handler = new HeartbeatHandler("test-node", config, {}, onEvent)

    // Emit recent event
    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    const isStalled = handler.checkStall()
    expect(isStalled).toBe(false)
    // Verify the handler still tracks the step
    expect(handler.getStepCount()).toBe(1)
    expect(handler.getLastActivityAt()).toBeGreaterThan(0)
  })
})
