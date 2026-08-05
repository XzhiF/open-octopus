import { describe, it, expect } from "vitest"
import { SILENT_EVENTS } from "../services/sse"

describe("SSE SILENT_EVENTS", () => {
  it("includes agent_heartbeat so high-frequency events skip console logging", () => {
    expect(SILENT_EVENTS.has("agent_heartbeat")).toBe(true)
  })

  it("includes heartbeat_stall so high-frequency events skip console logging", () => {
    expect(SILENT_EVENTS.has("heartbeat_stall")).toBe(true)
  })

  it("does NOT include harness_directive (rare event, should be logged)", () => {
    expect(SILENT_EVENTS.has("harness_directive")).toBe(false)
  })
})
