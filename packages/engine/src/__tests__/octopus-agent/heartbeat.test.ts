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
        }),
      }),
    )
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
    handler.updateTokens({ input: 1000, output: 500, total: 1500 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          tokens_used: 1500,
        }),
      }),
    )
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
        }),
      }),
    )
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
        }),
      }),
    )
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
        }),
      }),
    )
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
    handler.updateTokens({ input: 800, output: 500, total: 1300 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    // Should emit both heartbeat and harness_directive
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
    handler.updateTokens({ input: 800, output: 500, total: 1300 })

    handler.onAgentEvent({ type: "tool_result", toolCallId: "1", toolName: "Read", content: "", timestamp: Date.now() })

    // Should emit heartbeat but not harness_directive
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
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

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          artifacts: ["src/api.ts", "src/tests.ts"],
        }),
      }),
    )
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

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        data: expect.objectContaining({
          current_activity: expect.stringContaining("Analyzing"),
        }),
      }),
    )
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

    // Wait a bit and emit an event
    handler.onAgentEvent({ type: "text_delta", content: "test", timestamp: Date.now() })

    const after = handler.getLastActivityAt()
    expect(after).toBeGreaterThanOrEqual(before)
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
  })
})
