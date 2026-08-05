import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { AgentEventsResponse, AgentHeartbeat } from "@/lib/types"

// Mock the api-client module
vi.mock("@/lib/api-client", () => ({
  fetchAgentEvents: vi.fn(),
}))

import { fetchAgentEvents } from "@/lib/api-client"
import { useExecutionEvents } from "../use-execution-events"

const mockedFetch = vi.mocked(fetchAgentEvents)

/** Flush all pending microtasks (promises) so state updates settle. */
async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("useExecutionEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns heartbeat when API response contains it", async () => {
    const heartbeat: AgentHeartbeat = {
      step: 4,
      total_steps: 10,
      tokens_used: 2000,
      tokens_budget: 8000,
      artifacts: ["output.md"],
      issues: [],
      confidence: 0.8,
      current_activity: "Running analysis",
    }

    mockedFetch.mockResolvedValue({
      executionId: "exec-1",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
      heartbeat,
    } as AgentEventsResponse)

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-1", "completed")
    )

    // Wait for initial fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.heartbeat).toBeDefined()
    expect(result.current.heartbeat!.step).toBe(4)
    expect(result.current.heartbeat!.tokens_used).toBe(2000)
    expect(result.current.heartbeat!.current_activity).toBe("Running analysis")
  })

  it("returns undefined heartbeat when API response lacks it", async () => {
    mockedFetch.mockResolvedValue({
      executionId: "exec-1",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
    } as AgentEventsResponse)

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-1", "completed")
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.heartbeat).toBeUndefined()
  })

  it("updates heartbeat on polling when running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    // First response: step 1
    mockedFetch.mockResolvedValueOnce({
      executionId: "exec-1",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
      heartbeat: {
        step: 1,
        tokens_used: 500,
        artifacts: [],
        issues: [],
        confidence: 0.5,
      },
    } as AgentEventsResponse)

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-1", "running")
    )

    await flushPromises()

    expect(result.current.heartbeat?.step).toBe(1)

    // Second response: step 3 (simulating progress)
    mockedFetch.mockResolvedValueOnce({
      executionId: "exec-1",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
      heartbeat: {
        step: 3,
        tokens_used: 1500,
        artifacts: [],
        issues: [],
        confidence: 0.7,
      },
    } as AgentEventsResponse)

    // Advance timer by POLL_INTERVAL (2000ms) to trigger poll
    await act(async () => {
      vi.advanceTimersByTime(2100)
    })

    await flushPromises()

    expect(result.current.heartbeat?.step).toBe(3)
    expect(result.current.heartbeat?.tokens_used).toBe(1500)
  })

  // ── Error path tests ────────────────────────────────────────────

  it("sets error state when API call fails", async () => {
    mockedFetch.mockRejectedValue(new Error("Network error"))

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-fail", "completed")
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe("Network error")
    expect(result.current.events).toEqual([])
    expect(result.current.groups).toEqual([])
    expect(result.current.heartbeat).toBeUndefined()
    expect(result.current.loopIterations).toEqual({})
  })

  it("handles empty events array without error", async () => {
    mockedFetch.mockResolvedValue({
      executionId: "exec-empty",
      events: [],
      source: "sqlite",
      _degraded: false,
      _message: null,
    } as AgentEventsResponse)

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-empty", "completed")
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBeNull()
    expect(result.current.events).toEqual([])
    expect(result.current.groups).toEqual([])
    expect(result.current.heartbeat).toBeUndefined()
    expect(result.current.loopIterations).toEqual({})
  })

  it("sets error as string when API throws non-Error value", async () => {
    mockedFetch.mockRejectedValue("string error")

    const { result } = renderHook(() =>
      useExecutionEvents("ws-1", "exec-str", "completed")
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.error).toBe("string error")
    expect(result.current.events).toEqual([])
    expect(result.current.groups).toEqual([])
    expect(result.current.heartbeat).toBeUndefined()
  })
})
