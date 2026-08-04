import { describe, it, expect } from "vitest"
import type {
  StatusOverlay,
  AgentEventsResponse,
  AgentEvent,
} from "../types"
import type { AgentHeartbeat, HarnessDirective } from "@octopus/shared"

describe("StatusOverlay", () => {
  it("accepts an optional heartbeat field", () => {
    const heartbeat: AgentHeartbeat = {
      step: 3,
      total_steps: 10,
      tokens_used: 1500,
      tokens_budget: 10000,
      artifacts: [],
      issues: [],
      confidence: 0.85,
      current_activity: "Analyzing code",
    }

    const overlay: StatusOverlay = {
      stepStatus: "running",
      heartbeat,
    }

    expect(overlay.heartbeat).toBeDefined()
    expect(overlay.heartbeat!.step).toBe(3)
    expect(overlay.heartbeat!.tokens_used).toBe(1500)
    expect(overlay.heartbeat!.confidence).toBe(0.85)
  })

  it("works without heartbeat (backward compatible)", () => {
    const overlay: StatusOverlay = {
      stepStatus: "completed",
      duration: 42,
    }

    expect(overlay.heartbeat).toBeUndefined()
  })
})

describe("AgentEventsResponse", () => {
  it("includes heartbeat snapshot from API response", () => {
    const response: AgentEventsResponse = {
      executionId: "exec-123",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
      heartbeat: {
        step: 5,
        total_steps: 10,
        tokens_used: 3000,
        artifacts: ["result.md"],
        issues: [],
        confidence: 0.9,
        current_activity: "Writing output",
      },
    }

    expect(response.heartbeat).toBeDefined()
    expect(response.heartbeat!.step).toBe(5)
    expect(response.heartbeat!.current_activity).toBe("Writing output")
  })

  it("heartbeat is optional (backward compatible)", () => {
    const response: AgentEventsResponse = {
      executionId: "exec-123",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
    }

    expect(response.heartbeat).toBeUndefined()
  })
})

describe("AgentEvent typed variants", () => {
  it("supports heartbeat payload", () => {
    const event: AgentEvent = {
      nodeId: "node-1",
      event: "heartbeat",
      timestamp: "2026-08-04T10:00:00Z",
      heartbeatPayload: {
        step: 2,
        total_steps: 5,
        tokens_used: 800,
        artifacts: [],
        issues: [],
        confidence: 0.7,
        current_activity: "Reading files",
      },
    }

    expect(event.event).toBe("heartbeat")
    expect(event.heartbeatPayload?.step).toBe(2)
  })

  it("supports harness_directive payload", () => {
    const directive: HarnessDirective = {
      type: "abort",
      reason: "Budget exceeded",
      issued_by: "harness",
      timestamp: Date.now(),
    }

    const event: AgentEvent = {
      nodeId: "node-1",
      event: "harness_directive",
      directivePayload: directive,
    }

    expect(event.event).toBe("harness_directive")
    expect(event.directivePayload?.type).toBe("abort")
    expect(event.directivePayload?.reason).toBe("Budget exceeded")
  })

  it("supports heartbeat_stall payload", () => {
    const event: AgentEvent = {
      nodeId: "node-1",
      event: "heartbeat_stall",
      stallPayload: {
        timeout_seconds: 30,
        last_heartbeat_at: "2026-08-04T09:59:30Z",
      },
    }

    expect(event.event).toBe("heartbeat_stall")
    expect(event.stallPayload?.timeout_seconds).toBe(30)
  })

  it("maintains backward compatibility with existing events", () => {
    const event: AgentEvent = {
      nodeId: "node-1",
      event: "tool_call",
      toolName: "Read",
      toolCallId: "call-abc",
    }

    expect(event.event).toBe("tool_call")
    expect(event.heartbeatPayload).toBeUndefined()
    expect(event.directivePayload).toBeUndefined()
    expect(event.stallPayload).toBeUndefined()
  })

  // ── Edge case tests ───────────────────────────────────────────

  it("StatusOverlay is valid with heartbeat explicitly undefined", () => {
    const overlay: StatusOverlay = {
      stepStatus: "pending",
      heartbeat: undefined,
      duration: undefined,
      startedAt: undefined,
      error: undefined,
    }

    expect(overlay.stepStatus).toBe("pending")
    expect(overlay.heartbeat).toBeUndefined()
    expect(overlay.duration).toBeUndefined()
    expect(overlay.error).toBeUndefined()
  })

  it("AgentEventsResponse handles empty events array gracefully", () => {
    const response: AgentEventsResponse = {
      executionId: "exec-empty",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
      heartbeat: undefined,
      loopIterations: {},
    }

    expect(response.events).toHaveLength(0)
    expect(response.loopIterations).toEqual({})
    expect(response.heartbeat).toBeUndefined()
    expect(response._degraded).toBe(false)
  })

  it("AgentEvent supports all typed payloads simultaneously undefined", () => {
    const event: AgentEvent = {
      nodeId: "node-minimal",
      event: "unknown_event",
    }

    expect(event.nodeId).toBe("node-minimal")
    expect(event.event).toBe("unknown_event")
    expect(event.timestamp).toBeUndefined()
    expect(event.iteration).toBeUndefined()
    expect(event.heartbeatPayload).toBeUndefined()
    expect(event.directivePayload).toBeUndefined()
    expect(event.stallPayload).toBeUndefined()
    expect(event.content).toBeUndefined()
    expect(event.toolCallId).toBeUndefined()
  })

  it("AgentHeartbeat accepts zero values and empty arrays", () => {
    const heartbeat: AgentHeartbeat = {
      step: 0,
      total_steps: 0,
      tokens_used: 0,
      tokens_budget: 0,
      artifacts: [],
      issues: [],
      confidence: 0,
      current_activity: "",
    }

    expect(heartbeat.step).toBe(0)
    expect(heartbeat.total_steps).toBe(0)
    expect(heartbeat.tokens_used).toBe(0)
    expect(heartbeat.artifacts).toHaveLength(0)
    expect(heartbeat.issues).toHaveLength(0)
    expect(heartbeat.confidence).toBe(0)
    expect(heartbeat.current_activity).toBe("")
  })

  it("AgentEvent heartbeat payload with missing optional fields", () => {
    // AgentHeartbeat requires certain fields; test with minimal required shape
    const event: AgentEvent = {
      nodeId: "node-1",
      event: "heartbeat",
      heartbeatPayload: {
        step: 1,
        total_steps: 1,
        tokens_used: 100,
        artifacts: [],
        issues: [],
        confidence: 1,
        current_activity: "Done",
      },
    }

    expect(event.heartbeatPayload).toBeDefined()
    expect(event.heartbeatPayload!.step).toBe(1)
    // Optional field tokens_budget should be undefined when not provided
    expect((event.heartbeatPayload as any).tokens_budget).toBeUndefined()
  })
})
